'use strict';

// OS secret stores for token profiles: macOS Keychain (`security`) and the
// Linux Secret Service (`secret-tool`). No dependencies, and the secret never
// appears in a child process's argv (where `ps` could see it):
//   - macOS: commands are fed to `security -i` on stdin
//   - Linux: `secret-tool store` reads the secret from stdin
//
// WRANGLER_ACCOUNTS_SECRET_BACKEND overrides the choice:
//   keychain | secret-service | file:<dir>   (file: is for tests only — plaintext)
// WRANGLER_ACCOUNTS_KEYCHAIN points the macOS backend at a specific keychain file
// instead of the default search list (also used by tests).

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SERVICE = 'wrangler-accounts';

class SecretStoreError extends Error {}

function commandExists(cmd, env) {
  const dirs = String((env && env.PATH) || process.env.PATH || '').split(path.delimiter);
  return dirs.some((d) => {
    if (!d) return false;
    try {
      return fs.statSync(path.join(d, cmd)).isFile();
    } catch {
      return false;
    }
  });
}

function backendName(env = process.env) {
  const forced = env.WRANGLER_ACCOUNTS_SECRET_BACKEND;
  if (forced) return forced;
  if (process.platform === 'darwin') return 'keychain';
  if (process.platform === 'linux' && commandExists('secret-tool', env)) return 'secret-service';
  return null;
}

// Keychain account for a profile. Includes a hash of the profiles dir so two
// different WRANGLER_ACCOUNTS_DIRs with the same profile name never collide.
function secretAccount(profilesDir, name) {
  const dirHash = crypto.createHash('sha256').update(path.resolve(profilesDir)).digest('hex').slice(0, 12);
  return `${name}@${dirHash}`;
}

function assertStorable(secret) {
  if (typeof secret !== 'string' || !secret.length) {
    throw new SecretStoreError('empty secret');
  }
  // `security -i` parses a command line, so keep to characters that need no
  // escaping. Cloudflare API tokens are [A-Za-z0-9_-].
  if (!/^[\x21-\x7e]+$/.test(secret) || /["'\\]/.test(secret)) {
    throw new SecretStoreError('token contains characters the keychain backend cannot store safely');
  }
}

function keychainArgs(env) {
  return env.WRANGLER_ACCOUNTS_KEYCHAIN ? [env.WRANGLER_ACCOUNTS_KEYCHAIN] : [];
}

function quote(s) {
  return `"${s}"`;
}

const backends = {
  keychain: {
    label: 'macOS Keychain',
    put(account, secret, label, env) {
      assertStorable(secret);
      if (!/^[\w.@-]+$/.test(account)) throw new SecretStoreError(`bad account name: ${account}`);
      const kc = keychainArgs(env).map(quote).join(' ');
      const line = [
        'add-generic-password', '-U',
        '-s', quote(SERVICE), '-a', quote(account), '-l', quote(label.replace(/"/g, '')),
        '-w', quote(secret),
        kc,
      ].filter(Boolean).join(' ');
      const res = spawnSync('security', ['-i'], { input: `${line}\n`, encoding: 'utf8', env });
      if (res.error) throw new SecretStoreError(`security: ${res.error.message}`);
      const err = `${res.stderr || ''}${res.stdout || ''}`.trim();
      if (res.status !== 0 || /error|fail/i.test(err)) {
        throw new SecretStoreError(`could not write to the keychain: ${err || `exit ${res.status}`}`);
      }
    },
    get(account, env, service = SERVICE) {
      const res = spawnSync(
        'security',
        ['find-generic-password', '-s', service, '-a', account, '-w', ...keychainArgs(env)],
        { encoding: 'utf8', env },
      );
      if (res.error) throw new SecretStoreError(`security: ${res.error.message}`);
      if (res.status === 44) {
        const err = new SecretStoreError('keychain item not found');
        err.notFound = true;
        throw err;
      }
      if (res.status !== 0) {
        throw new SecretStoreError(`keychain lookup failed: ${(res.stderr || '').trim() || `exit ${res.status}`}`);
      }
      return String(res.stdout).replace(/\n$/, '');
    },
    remove(account, env, service = SERVICE) {
      const res = spawnSync(
        'security',
        ['delete-generic-password', '-s', service, '-a', account, ...keychainArgs(env)],
        { encoding: 'utf8', env },
      );
      return res.status === 0;
    },
  },

  'secret-service': {
    label: 'Secret Service (libsecret)',
    put(account, secret, label, env) {
      if (!secret) throw new SecretStoreError('empty secret');
      const res = spawnSync(
        'secret-tool',
        ['store', `--label=${label}`, 'service', SERVICE, 'account', account],
        { input: secret, encoding: 'utf8', env },
      );
      if (res.error) throw new SecretStoreError(`secret-tool: ${res.error.message}`);
      if (res.status !== 0) {
        throw new SecretStoreError(`could not write to the Secret Service: ${(res.stderr || '').trim() || `exit ${res.status}`}`);
      }
    },
    get(account, env, service = SERVICE) {
      const res = spawnSync('secret-tool', ['lookup', 'service', service, 'account', account], {
        encoding: 'utf8',
        env,
      });
      if (res.error) throw new SecretStoreError(`secret-tool: ${res.error.message}`);
      if (res.status !== 0 || !res.stdout) {
        const err = new SecretStoreError(`Secret Service lookup failed: ${(res.stderr || '').trim() || 'item not found'}`);
        if (res.status === 1 || !res.stdout) err.notFound = true;
        throw err;
      }
      return String(res.stdout).replace(/\n$/, '');
    },
    remove(account, env, service = SERVICE) {
      const res = spawnSync('secret-tool', ['clear', 'service', service, 'account', account], { env });
      return res.status === 0;
    },
  },
};

function fileBackend(dir) {
  // Items of the default service keep their 1.8.0 file name; other services
  // (e.g. wrangler's own keyring key, service "wrangler") get a prefix.
  const file = (account, service = SERVICE) => {
    const base = account.replace(/[^\w.@-]/g, '_');
    return path.join(dir, service === SERVICE ? `${base}.secret` : `${service.replace(/[^\w.-]/g, '_')}--${base}.secret`);
  };
  return {
    label: `test file store (${dir})`,
    put(account, secret, label, env, service = SERVICE) {
      if (!secret) throw new SecretStoreError('empty secret');
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(file(account, service), secret, { mode: 0o600 });
    },
    get(account, env, service = SERVICE) {
      try {
        return fs.readFileSync(file(account, service), 'utf8');
      } catch {
        const err = new SecretStoreError('item not found');
        err.notFound = true;
        throw err;
      }
    },
    remove(account, env, service = SERVICE) {
      try {
        fs.unlinkSync(file(account, service));
        return true;
      } catch {
        return false;
      }
    },
  };
}

function getBackend(name, env = process.env) {
  if (!name) return null;
  if (name.startsWith('file:')) return fileBackend(name.slice(5));
  return backends[name] || null;
}

function availableBackend(env = process.env) {
  const name = backendName(env);
  const backend = getBackend(name, env);
  return backend ? { name, backend } : null;
}

module.exports = {
  SERVICE,
  SecretStoreError,
  backendName,
  getBackend,
  availableBackend,
  secretAccount,
};
