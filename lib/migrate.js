'use strict';

// Moving OAuth profiles between the shadow backend (wrangler-accounts keeps
// config.toml) and wrangler's native profile store, and encrypting native
// profiles with wrangler's keyring support. Every step that drops a copy of
// the credentials only runs after the new copy has been read back and, where
// possible, accepted by wrangler itself.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  isValidName,
  isBackupName,
  getProfileType,
  getProfileBackend,
  listProfiles,
  readMeta,
  updateMeta,
  timestampForFile,
} = require('./profile-store');
const native = require('./native');
const { buildNativeEnv } = require('./isolation');
const { getMetaIdentity } = require('./identity');

class MigrateError extends Error {
  constructor(message, code = 'MIGRATE_FAILED') {
    super(message);
    this.code = code;
  }
}

const UNSUPPORTED_HINT = [
  '需要支持原生 profile 的 wrangler（4.149 及以上）。升级：npm i -g wrangler@latest',
  'This needs a wrangler with native auth profiles (4.149+). Upgrade: npm i -g wrangler@latest',
].join('\n');

function profileDirOf(profilesDir, name) {
  return path.join(profilesDir, name);
}

function requireProfile(profilesDir, name) {
  if (!isValidName(name)) throw new MigrateError(`Invalid profile name: ${name}`, 'INVALID_NAME');
  const type = getProfileType(profileDirOf(profilesDir, name));
  if (!type) throw new MigrateError(`Profile not found: ${name}`, 'PROFILE_NOT_FOUND');
  return type;
}

function nativeNameOf(profilesDir, name) {
  const meta = readMeta(profileDirOf(profilesDir, name));
  return (meta && meta.nativeName) || null;
}

/** Native names already claimed by other wrangler-accounts profiles. */
function claimedNativeNames(profilesDir, except) {
  const claimed = new Map();
  for (const other of listProfiles(profilesDir)) {
    if (other === except) continue;
    const n = nativeNameOf(profilesDir, other);
    if (n) claimed.set(n, other);
  }
  return claimed;
}

function pickNativeName(profilesDir, name, as) {
  if (as) {
    const problem = native.nativeNameProblem(as);
    if (problem) throw new MigrateError(`--as ${as}: ${problem}`, 'INVALID_NATIVE_NAME');
    return as;
  }
  if (!native.nativeNameProblem(name)) return name;
  const suggestion = native.suggestNativeName(name);
  if (!suggestion) {
    throw new MigrateError(
      `'${name}' cannot be a wrangler profile name (${native.nativeNameProblem(name)}). Pass --as <name>.`,
      'INVALID_NATIVE_NAME',
    );
  }
  return suggestion;
}

function nativeEnvFor(profilesDir, name, { env, home, encrypted = false }) {
  const profileDir = profileDirOf(profilesDir, name);
  return buildNativeEnv({
    realHome: home,
    profile: name,
    profileDir,
    accountId: getMetaIdentity(readMeta(profileDir))?.accountId || null,
    baseEnv: env,
    encrypted,
  });
}

function storeLabel(env) {
  return native.backendName(env) || null;
}

function safeReadKey(nativeName, env) {
  try {
    return { key: native.readNativeKey(nativeName, env), error: null };
  } catch (err) {
    return { key: null, error: err.message };
  }
}

/**
 * Copy a shadow OAuth profile into wrangler's native store.
 *
 * opts: { as, force, dryRun, verify (default true), env, home, probe }
 */
function migrateProfile(profilesDir, name, opts = {}) {
  const env = opts.env || process.env;
  const home = opts.home || os.homedir();
  const type = requireProfile(profilesDir, name);
  if (isBackupName(name)) return { name, status: 'skipped', reason: 'backup profiles are not migrated' };
  if (type === 'token') {
    return { name, status: 'skipped', reason: 'token profile: it uses CLOUDFLARE_API_TOKEN, nothing to migrate' };
  }
  const profileDir = profileDirOf(profilesDir, name);
  if (getProfileBackend(profileDir) === 'native') {
    return { name, status: 'already', nativeName: nativeNameOf(profilesDir, name) };
  }

  const probe = opts.probe || native.probeNativeSupport({ profilesDir, env });
  if (!probe.supported) throw new MigrateError(`${probe.reason}\n${UNSUPPORTED_HINT}`, 'NATIVE_UNSUPPORTED');

  const nativeName = pickNativeName(profilesDir, name, opts.as);
  const claimedBy = claimedNativeNames(profilesDir, name).get(nativeName);
  if (claimedBy) {
    throw new MigrateError(
      `wrangler profile '${nativeName}' is already used by wrangler-accounts profile '${claimedBy}'. Pass --as <other-name>.`,
      'NATIVE_NAME_TAKEN',
    );
  }
  const paths = native.nativePaths(nativeName, { env, home });
  const existing = native.nativeState(nativeName, { env, home });
  if (existing !== 'missing' && !opts.force) {
    throw new MigrateError(
      [
        `wrangler already has a profile named '${nativeName}' (${existing === 'encrypted' ? paths.enc : paths.toml}).`,
        `wrangler 里已经有同名 profile '${nativeName}'，不会覆盖。`,
        `Use --as <other-name>, or --force to replace it (the existing files are moved into ${profileDir}).`,
      ].join('\n'),
      'NATIVE_EXISTS',
    );
  }

  const plan = {
    name,
    nativeName,
    source: path.join(profileDir, 'config.toml'),
    target: paths.toml,
    replaces: existing !== 'missing' ? existing : null,
    keyringPreference: native.keyringPreferenceEnabled({ env, home }),
  };
  if (opts.dryRun) return { ...plan, status: 'dry-run' };

  const source = plan.source;
  const text = fs.readFileSync(source, 'utf8');
  const moved = [];
  if (existing !== 'missing') {
    const stamp = timestampForFile();
    for (const file of [paths.toml, paths.enc]) {
      if (!fs.existsSync(file)) continue;
      const dest = path.join(profileDir, `native-overwritten-${stamp}${path.extname(file)}`);
      fs.renameSync(file, dest);
      moved.push([dest, file]);
    }
  }

  // With the user's global keyring preference on, wrangler encrypts the new
  // file during verification. Remember whether a key existed so a rollback
  // never deletes a key we did not create.
  const keyBefore = plan.keyringPreference ? safeReadKey(nativeName, env).key : null;

  const rollback = () => {
    for (const file of [paths.toml, paths.enc]) {
      try {
        fs.unlinkSync(file);
      } catch {
        /* not there */
      }
    }
    if (plan.keyringPreference && !keyBefore) {
      try {
        native.deleteNativeKey(nativeName, env);
      } catch {
        /* best effort */
      }
    }
    for (const [dest, file] of moved) {
      try {
        fs.renameSync(dest, file);
      } catch {
        /* leave the backup where it is */
      }
    }
  };

  try {
    native.writeFileAtomic(paths.toml, text);
    if (fs.readFileSync(paths.toml, 'utf8') !== text) throw new Error(`read-back of ${paths.toml} does not match`);
  } catch (err) {
    rollback();
    throw new MigrateError(`Could not write ${paths.toml}: ${err.message}. Nothing changed.`);
  }

  let verified = false;
  if (opts.verify !== false) {
    const check = native.wranglerTokenCheck(nativeName, { env: nativeEnvFor(profilesDir, name, { env, home }) });
    if (!check.ok) {
      rollback();
      throw new MigrateError(
        [
          `wrangler could not use the migrated profile '${nativeName}': ${check.error}`,
          `迁移后 wrangler 无法读取该 profile，已撤销，原 profile 保持不变。`,
          `The profile is unchanged. If the access token expired and you are offline, retry online or pass --no-verify.`,
        ].join('\n'),
        'VERIFY_FAILED',
      );
    }
    verified = true;
  }

  const state = native.nativeState(nativeName, { env, home });
  updateMeta(profileDir, {
    backend: 'native',
    nativeName,
    migratedAt: new Date().toISOString(),
    credentialStore: state === 'encrypted' ? storeLabel(env) : null,
  });
  // The shadow copy is stale as soon as wrangler refreshes the token (refresh
  // tokens rotate), and for protect it must not linger as plaintext.
  fs.unlinkSync(source);
  return {
    ...plan,
    status: 'migrated',
    verified,
    encrypted: state === 'encrypted',
    replacedBackups: moved.map(([dest]) => dest),
  };
}

/**
 * Move a native profile back to the shadow backend (config.toml in the
 * wrangler-accounts profile dir). opts: { keepNative, env, home }
 */
function unmigrateProfile(profilesDir, name, opts = {}) {
  const env = opts.env || process.env;
  const home = opts.home || os.homedir();
  const type = requireProfile(profilesDir, name);
  const profileDir = profileDirOf(profilesDir, name);
  if (type === 'token') return { name, status: 'skipped', reason: 'token profile' };
  if (getProfileBackend(profileDir) !== 'native') return { name, status: 'already' };
  const nativeName = nativeNameOf(profilesDir, name);
  const paths = native.nativePaths(nativeName, { env, home });
  const state = native.nativeState(nativeName, { env, home });
  if (state === 'missing') {
    throw new MigrateError(
      `wrangler profile '${nativeName}' has no credentials (${paths.toml} / ${paths.enc}). Re-login: wrangler-accounts login ${name} --force`,
      'NATIVE_MISSING',
    );
  }
  let text;
  try {
    text = native.readNativeCredentials(nativeName, { env, home });
  } catch (err) {
    throw new MigrateError(`Could not read wrangler profile '${nativeName}': ${err.message}. Nothing changed.`);
  }
  if (!native.looksLikeOAuthToml(text)) {
    throw new MigrateError(`wrangler profile '${nativeName}' does not contain OAuth credentials. Nothing changed.`);
  }
  const dest = path.join(profileDir, 'config.toml');
  native.writeFileAtomic(dest, text);
  if (fs.readFileSync(dest, 'utf8') !== text) {
    fs.unlinkSync(dest);
    throw new MigrateError(`read-back of ${dest} does not match. Nothing changed.`);
  }
  updateMeta(profileDir, { backend: null, nativeName: null, migratedAt: null, credentialStore: null });

  const removed = [];
  let keyRemoved = false;
  if (!opts.keepNative) {
    for (const file of [paths.toml, paths.enc]) {
      if (fs.existsSync(file)) {
        fs.unlinkSync(file);
        removed.push(file);
      }
    }
    if (state === 'encrypted') {
      try {
        keyRemoved = native.deleteNativeKey(nativeName, env);
      } catch {
        keyRemoved = false;
      }
    }
  }
  return {
    name,
    status: 'unmigrated',
    nativeName,
    wasEncrypted: state === 'encrypted',
    keptNative: Boolean(opts.keepNative),
    removed,
    keyRemoved,
    bindings: native.bindingsFor(nativeName, { env, home }),
  };
}

function keyringSupportProblem(env) {
  const name = native.backendName(env);
  if (name && (name === 'keychain' || name === 'secret-service' || name.startsWith('file:'))) return null;
  if (process.platform === 'linux') {
    return 'Linux needs `secret-tool` (libsecret-tools) for keyring storage: sudo apt-get install libsecret-tools\nLinux 需要先安装 secret-tool（libsecret-tools）。';
  }
  return `OS keyring storage is only supported on macOS and Linux here (platform: ${process.platform}).\n当前系统不支持钥匙串加密（仅支持 macOS / Linux）。`;
}

/**
 * Encrypt an OAuth profile at rest using wrangler's own keyring support.
 * Migrates a shadow profile to native first. opts: { env, home, probe, as }
 */
function protectOAuthProfile(profilesDir, name, opts = {}) {
  const env = opts.env || process.env;
  const home = opts.home || os.homedir();
  requireProfile(profilesDir, name);
  const profileDir = profileDirOf(profilesDir, name);

  const problem = keyringSupportProblem(env);
  if (problem) return { name, status: 'skipped', reason: problem };

  let migrated = null;
  if (getProfileBackend(profileDir) !== 'native') {
    const probe = opts.probe || native.probeNativeSupport({ profilesDir, env });
    if (!probe.supported) {
      return {
        name,
        status: 'skipped',
        reason: `OAuth encryption needs wrangler native profiles: ${probe.reason}. 升级 wrangler 后重试 / upgrade wrangler (npm i -g wrangler@latest) and retry`,
      };
    }
    migrated = migrateProfile(profilesDir, name, { ...opts, env, home, probe });
  }

  const nativeName = nativeNameOf(profilesDir, name);
  const paths = native.nativePaths(nativeName, { env, home });
  const before = native.nativeState(nativeName, { env, home });
  if (before === 'encrypted') {
    updateMeta(profileDir, { credentialStore: storeLabel(env) });
    return { name, status: migrated ? 'protected' : 'already', store: storeLabel(env), nativeName, migrated: Boolean(migrated) };
  }
  if (before === 'missing') {
    throw new MigrateError(`wrangler profile '${nativeName}' has no credentials. Re-login: wrangler-accounts login ${name} --force`, 'NATIVE_MISSING');
  }

  const plaintext = fs.readFileSync(paths.toml, 'utf8');
  const keyBefore = safeReadKey(nativeName, env);
  if (keyBefore.error) {
    throw new MigrateError(`Could not read the OS keyring: ${keyBefore.error}. Unlock it and retry. Nothing changed.`, 'KEYRING_UNAVAILABLE');
  }

  // wrangler itself performs the encryption: reading the profile with
  // CLOUDFLARE_AUTH_USE_KEYRING=true migrates <name>.toml -> <name>.enc.
  const check = native.wranglerTokenCheck(nativeName, {
    env: nativeEnvFor(profilesDir, name, { env, home, encrypted: true }),
  });

  let decryptedOk = false;
  if (fs.existsSync(paths.enc) && !fs.existsSync(paths.toml)) {
    try {
      decryptedOk = native.looksLikeOAuthToml(native.decryptNativeProfile(nativeName, { env, home }));
    } catch {
      decryptedOk = false;
    }
  }

  if (!decryptedOk) {
    // Restore the plaintext exactly as it was; drop anything half-written.
    let recovered = plaintext;
    if (fs.existsSync(paths.enc)) {
      try {
        const t = native.decryptNativeProfile(nativeName, { env, home });
        if (native.looksLikeOAuthToml(t)) recovered = t;
      } catch {
        /* keep the original */
      }
    }
    if (!fs.existsSync(paths.toml)) native.writeFileAtomic(paths.toml, recovered);
    try {
      fs.unlinkSync(paths.enc);
    } catch {
      /* not there */
    }
    if (!keyBefore.key) {
      try {
        native.deleteNativeKey(nativeName, env);
      } catch {
        /* best effort */
      }
    }
    throw new MigrateError(
      [
        `wrangler did not encrypt profile '${nativeName}'${check.ok ? '' : `: ${check.error}`}.`,
        `加密没有完成，凭据已恢复为明文，profile 可照常使用。`,
        `The plaintext credentials were restored; the profile still works.`,
      ].join('\n'),
      'PROTECT_FAILED',
    );
  }

  updateMeta(profileDir, { credentialStore: storeLabel(env) });
  return {
    name,
    status: 'protected',
    store: storeLabel(env),
    nativeName,
    migrated: Boolean(migrated),
    verified: check.ok,
    warning: check.ok ? null : `encrypted, but wrangler could not confirm online (${check.error})`,
    keyringPreference: native.keyringPreferenceEnabled({ env, home }),
  };
}

/** Decrypt an encrypted native profile back to <name>.toml (0600). */
function unprotectOAuthProfile(profilesDir, name, opts = {}) {
  const env = opts.env || process.env;
  const home = opts.home || os.homedir();
  requireProfile(profilesDir, name);
  const profileDir = profileDirOf(profilesDir, name);
  if (getProfileBackend(profileDir) !== 'native') {
    return { name, status: 'skipped', reason: 'oauth profiles are not protected' };
  }
  const nativeName = nativeNameOf(profilesDir, name);
  const paths = native.nativePaths(nativeName, { env, home });
  if (native.nativeState(nativeName, { env, home }) !== 'encrypted') {
    updateMeta(profileDir, { credentialStore: null });
    return { name, status: 'already', nativeName };
  }
  let text;
  try {
    text = native.decryptNativeProfile(nativeName, { env, home });
  } catch (err) {
    throw new MigrateError(`Could not decrypt wrangler profile '${nativeName}': ${err.message}. Nothing changed.`, 'DECRYPT_FAILED');
  }
  if (!native.looksLikeOAuthToml(text)) {
    throw new MigrateError(`Decrypted profile '${nativeName}' has no OAuth token. Nothing changed.`, 'DECRYPT_FAILED');
  }
  native.writeFileAtomic(paths.toml, text);
  if (fs.readFileSync(paths.toml, 'utf8') !== text) {
    fs.unlinkSync(paths.toml);
    throw new MigrateError(`read-back of ${paths.toml} does not match. Nothing changed.`);
  }
  fs.unlinkSync(paths.enc);
  let secretRemoved = false;
  try {
    secretRemoved = native.deleteNativeKey(nativeName, env);
  } catch {
    secretRemoved = false;
  }
  const store = storeLabel(env);
  updateMeta(profileDir, { credentialStore: null });
  return {
    name,
    status: 'unprotected',
    store,
    nativeName,
    secretRemoved,
    warning: native.keyringPreferenceEnabled({ env, home })
      ? "wrangler's global keyring preference is on, so wrangler will encrypt it again the next time it is used (wrangler auth keyring)"
      : null,
  };
}

module.exports = {
  MigrateError,
  UNSUPPORTED_HINT,
  migrateProfile,
  unmigrateProfile,
  protectOAuthProfile,
  unprotectOAuthProfile,
  pickNativeName,
};
