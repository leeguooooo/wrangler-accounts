'use strict';

// Native wrangler profiles (migrate / unmigrate / protect for OAuth / runs)
// against a fake wrangler 4.149 (test/fixtures/native-bin/wrangler). Every
// test uses its own temp HOME, profiles dir and key store.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const native = require('../lib/native');

const CLI = path.join(__dirname, '..', 'bin', 'wrangler-accounts.js');
const NATIVE_BIN = path.join(__dirname, 'fixtures', 'native-bin');
const OLD_BIN = path.join(__dirname, 'fixtures', 'contract-bin');

const TOML = (tok) => `oauth_token = "${tok}"\nrefresh_token = "r-${tok}"\nexpiration_time = "2099-01-01T00:00:00.000Z"\nscopes = ["account:read"]\n`;
const IDENTITY = { email: 'w@example.com', accountName: 'W', accountId: 'aaaabbbbccccddddeeeeffff00001111' };

function setup({ bin = NATIVE_BIN, legacyWranglerDir = true } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wa-native-')));
  const home = path.join(root, 'home');
  const profiles = path.join(root, 'profiles');
  const store = path.join(root, 'store');
  fs.mkdirSync(home, { recursive: true });
  if (legacyWranglerDir) fs.mkdirSync(path.join(home, '.wrangler', 'config'), { recursive: true });
  const env = {
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    HOME: home,
    WA_TEST_REAL_HOME: home,
    WRANGLER_ACCOUNTS_DIR: profiles,
    WRANGLER_ACCOUNTS_SECRET_BACKEND: `file:${store}`,
    WRANGLER_ACCOUNTS_SHIM_DIR: path.join(root, 'shims'),
    XDG_CONFIG_HOME: path.join(home, '.config'),
    SHELL: '/bin/sh',
    TMPDIR: process.env.TMPDIR || os.tmpdir(),
  };
  const ctx = { root, home, profiles, store, env };
  ctx.cfg = path.join(home, '.wrangler');
  ctx.run = (args, extra = {}, opts = {}) =>
    spawnSync(process.execPath, [CLI, ...args], {
      encoding: 'utf8',
      env: { ...env, ...extra },
      cwd: opts.cwd || root,
      input: '',
    });
  ctx.addOAuth = (name, tok = `tok-${name}`, meta = { identity: IDENTITY }) => {
    fs.mkdirSync(path.join(profiles, name), { recursive: true });
    fs.writeFileSync(path.join(profiles, name, 'config.toml'), TOML(tok));
    fs.writeFileSync(path.join(profiles, name, 'meta.json'), JSON.stringify({ name, ...meta }));
  };
  ctx.addToken = (name, token = `api-${name}`, accountId = `acct-${name}`) => {
    fs.mkdirSync(path.join(profiles, name), { recursive: true });
    fs.writeFileSync(path.join(profiles, name, 'token.json'), JSON.stringify({ apiToken: token, accountId }));
  };
  ctx.meta = (name) => JSON.parse(fs.readFileSync(path.join(profiles, name, 'meta.json'), 'utf8'));
  ctx.nativeFile = (name, ext = 'toml') => path.join(ctx.cfg, 'config', `${name}.${ext}`);
  ctx.json = (r) => {
    assert.equal(r.status, 0, `exit ${r.status}\nstdout=${r.stdout}\nstderr=${r.stderr}`);
    return JSON.parse(r.stdout);
  };
  return ctx;
}

test('native support probe: fake 4.149 yes (cached), old wrangler no, env override', () => {
  const t = setup();
  const yes = native.probeNativeSupport({ profilesDir: t.profiles, env: t.env });
  assert.equal(yes.supported, true);
  assert.equal(yes.version, '4.149.0');
  assert.ok(fs.existsSync(path.join(t.profiles, '.native-probe.json')));
  assert.equal(native.probeNativeSupport({ profilesDir: t.profiles, env: t.env }).cached, true);

  const old = setup({ bin: OLD_BIN });
  assert.equal(native.probeNativeSupport({ profilesDir: old.profiles, env: old.env }).supported, false);
  assert.equal(native.probeNativeSupport({ env: { ...t.env, WRANGLER_ACCOUNTS_NATIVE: '0' } }).supported, false);
});

test('wrangler global config dir follows wrangler: ~/.wrangler if present, else XDG', () => {
  const t = setup({ legacyWranglerDir: false });
  assert.equal(native.nativePaths('x', { env: t.env, home: t.home }).configDir, path.join(t.home, '.config', '.wrangler'));
  fs.mkdirSync(path.join(t.home, '.wrangler'));
  assert.equal(native.nativePaths('x', { env: t.env, home: t.home }).configDir, path.join(t.home, '.wrangler'));
});

test('migrate --dry-run changes nothing', () => {
  const t = setup();
  t.addOAuth('work');
  const out = t.json(t.run(['migrate', 'work', '--dry-run', '--json']));
  assert.equal(out.results[0].status, 'dry-run');
  assert.equal(out.results[0].target, t.nativeFile('work'));
  assert.ok(fs.existsSync(path.join(t.profiles, 'work', 'config.toml')));
  assert.ok(!fs.existsSync(t.nativeFile('work')));
  assert.equal(t.meta('work').backend, undefined);
});

test('migrate copies the credentials, verifies with wrangler, then switches the backend', () => {
  const t = setup();
  t.addOAuth('work', 'tok-w');
  const out = t.json(t.run(['migrate', 'work', '--json']));
  const r = out.results[0];
  assert.equal(r.status, 'migrated');
  assert.equal(r.verified, true);
  assert.equal(fs.readFileSync(t.nativeFile('work'), 'utf8'), TOML('tok-w'));
  assert.equal(fs.statSync(t.nativeFile('work')).mode & 0o777, 0o600);
  assert.ok(!fs.existsSync(path.join(t.profiles, 'work', 'config.toml')));
  const meta = t.meta('work');
  assert.equal(meta.backend, 'native');
  assert.equal(meta.nativeName, 'work');
  assert.deepEqual(meta.identity, IDENTITY);

  const list = t.json(t.run(['list', '--json']));
  assert.equal(list[0].backend, 'native');
  assert.equal(list[0].status, 'valid');
  assert.equal(list[0].type, 'oauth');
  assert.equal(t.run(['list', '--plain']).stdout.trim(), 'work');
  assert.equal(t.json(t.run(['migrate', 'work', '--json'])).results[0].status, 'already');
});

test('a migrated profile runs as `wrangler ... --profile <name>` with the real HOME and clean env', () => {
  const t = setup();
  t.addOAuth('work', 'tok-w');
  t.json(t.run(['migrate', 'work', '--json']));
  const out = t.json(
    t.run(['--profile', 'work', 'deploy', '--env', 'prod'], { CLOUDFLARE_API_TOKEN: 'leak', CLOUDFLARE_ACCOUNT_ID: 'leak' }),
  );
  assert.deepEqual(out.argv, ['deploy', '--env', 'prod', '--profile', 'work']);
  assert.equal(out.profile, 'work');
  assert.equal(out.oauthToken, 'tok-w');
  assert.equal(out.homeIsShadow, false);
  assert.equal(out.env.CLOUDFLARE_API_TOKEN, null);
  assert.equal(out.env.CLOUDFLARE_ACCOUNT_ID, IDENTITY.accountId);
  assert.equal(out.env.WRANGLER_CACHE_DIR, path.join(t.profiles, 'work', 'cache'));
  assert.equal(out.env.WA_PASSTHROUGH, '1');

  // --profile goes before a bare `--`
  const dd = t.json(t.run(['--profile', 'work', 'd1', 'execute', 'db', '--', 'x']));
  assert.deepEqual(dd.argv, ['d1', 'execute', 'db', '--profile', 'work', '--', 'x']);
  // default + positional shorthand still resolve
  t.run(['default', 'work']);
  assert.equal(t.json(t.run(['deploy'])).profile, 'work');
  assert.equal(t.json(t.run(['work', 'deploy'])).profile, 'work');
});

test('whoami / exec for a native profile go through a bound shadow (no --profile needed)', () => {
  const t = setup();
  t.addOAuth('work', 'tok-w');
  t.addOAuth('other', 'tok-o');
  t.json(t.run(['migrate', 'work', '--json']));
  // wrangler's own default login is someone else; it must not be used
  fs.writeFileSync(path.join(t.cfg, 'config', 'default.toml'), TOML('tok-default'));

  // `wrangler-accounts whoami` stays the static (meta.json) check
  assert.match(t.run(['--profile', 'work', 'whoami']).stdout, /w@example\.com/);

  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-native-cwd-'));
  const ex = t.run(['exec', 'work', '--', 'sh', '-c', 'wrangler whoami && wrangler deploy'], {}, { cwd: elsewhere });
  assert.equal(ex.status, 0, ex.stderr);
  assert.match(ex.stdout, /work@example\.com/);
  const deployed = JSON.parse(ex.stdout.trim().split('\n').pop());
  assert.equal(deployed.oauthToken, 'tok-w');
  assert.equal(deployed.homeIsShadow, true);

  const deep = t.json(t.run(['list', '--deep', '--json']));
  const w = deep.find((e) => e.name === 'work');
  assert.equal(w.verified, true);
  assert.equal(w.liveIdentity.email, 'work@example.com');
});

test('login/logout passthrough on a native profile is refused (it would hit the default login)', () => {
  const t = setup();
  t.addOAuth('work');
  t.json(t.run(['migrate', 'work', '--json']));
  for (const args of [['work', 'login'], ['--profile', 'work', 'logout']]) {
    const r = t.run(args);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /DEFAULT login/);
  }
});

test('migrate refuses to overwrite an existing native profile; --force backs it up first', () => {
  const t = setup();
  t.addOAuth('work', 'tok-new');
  fs.writeFileSync(t.nativeFile('work'), TOML('tok-existing'));
  const r = t.run(['migrate', 'work', '--json']);
  assert.equal(r.status, 1);
  assert.equal(JSON.parse(r.stdout).results[0].code, 'NATIVE_EXISTS');
  assert.equal(fs.readFileSync(t.nativeFile('work'), 'utf8'), TOML('tok-existing'));
  assert.ok(fs.existsSync(path.join(t.profiles, 'work', 'config.toml')));

  const forced = t.json(t.run(['migrate', 'work', '--force', '--json'])).results[0];
  assert.equal(forced.status, 'migrated');
  assert.equal(fs.readFileSync(t.nativeFile('work'), 'utf8'), TOML('tok-new'));
  assert.equal(forced.replacedBackups.length, 1);
  assert.equal(fs.readFileSync(forced.replacedBackups[0], 'utf8'), TOML('tok-existing'));
});

test('names wrangler does not accept get a derived native name; --as overrides; --all skips tokens', () => {
  const t = setup();
  t.addOAuth('acme.prod', 'tok-a');
  t.addOAuth('Default', 'tok-d');
  t.addOAuth('team', 'tok-t');
  t.addToken('ci');
  const all = t.json(t.run(['migrate', '--all', '--json']));
  const by = Object.fromEntries(all.results.map((r) => [r.name, r]));
  assert.equal(by['acme.prod'].nativeName, 'acme-prod');
  assert.equal(by.Default.nativeName, 'Default-wa');
  assert.equal(by.team.nativeName, 'team');
  assert.equal(by.ci, undefined);
  assert.equal(t.json(t.run(['--profile', 'acme.prod', 'deploy'])).profile, 'acme-prod');

  const u = setup();
  u.addOAuth('work', 'tok-w');
  assert.equal(u.json(u.run(['migrate', 'work', '--as', 'w2', '--json'])).results[0].nativeName, 'w2');
  assert.ok(fs.existsSync(u.nativeFile('w2')));
  u.addOAuth('other', 'tok-o');
  const bad = u.run(['migrate', 'other', '--as', 'no.dots']);
  assert.notEqual(bad.status, 0);
  assert.match(bad.stdout + bad.stderr, /no\.dots/);
  const taken = u.run(['migrate', 'other', '--as', 'w2', '--json']);
  assert.equal(JSON.parse(taken.stdout).results[0].code, 'NATIVE_NAME_TAKEN');
});

test('migrate rolls back when wrangler cannot use the copy', () => {
  const t = setup();
  t.addOAuth('work', 'tok-w');
  const r = t.run(['migrate', 'work', '--json'], { WA_FAKE_TOKEN_FAIL: '1' });
  assert.equal(r.status, 1);
  assert.equal(JSON.parse(r.stdout).results[0].code, 'VERIFY_FAILED');
  assert.ok(!fs.existsSync(t.nativeFile('work')));
  assert.equal(fs.readFileSync(path.join(t.profiles, 'work', 'config.toml'), 'utf8'), TOML('tok-w'));
  assert.equal(t.meta('work').backend, undefined);
  // --no-verify skips the wrangler check
  assert.equal(t.json(t.run(['migrate', 'work', '--no-verify', '--json'], { WA_FAKE_TOKEN_FAIL: '1' })).results[0].verified, false);
});

test('migrate needs native support and says how to get it', () => {
  const t = setup({ bin: OLD_BIN });
  t.addOAuth('work');
  const r = t.run(['migrate', 'work']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /npm i -g wrangler@latest/);
  assert.match(r.stderr, /4\.149/);
});

test('protect <oauth>: migrates, wrangler encrypts, no plaintext left, runs still work', () => {
  const t = setup();
  t.addOAuth('work', 'tok-w');
  const out = t.json(t.run(['protect', 'work', '--json']));
  const r = out.results[0];
  assert.equal(r.status, 'protected');
  assert.equal(r.migrated, true);
  assert.ok(fs.existsSync(t.nativeFile('work', 'enc')));
  assert.ok(!fs.existsSync(t.nativeFile('work')));
  assert.ok(!fs.existsSync(path.join(t.profiles, 'work', 'config.toml')));
  // the key lives in the key store under service "wrangler"
  assert.ok(fs.readdirSync(t.store).some((f) => f.startsWith('wrangler--work')));
  // nothing in the tree contains the token in plaintext
  const grep = spawnSync('grep', ['-r', 'tok-w', t.cfg, t.profiles], { encoding: 'utf8' });
  assert.equal(grep.stdout, '');

  const list = t.json(t.run(['list', '--json']));
  assert.equal(list[0].status, 'encrypted');
  assert.match(list[0].credentialStore, /^file:/);
  assert.match(t.run(['list']).stdout, /encrypted/);

  const run = t.json(t.run(['--profile', 'work', 'deploy']));
  assert.equal(run.oauthToken, 'tok-w');
  assert.equal(run.env.CLOUDFLARE_AUTH_USE_KEYRING, 'true');
  const who = t.run(['exec', 'work', '--', 'wrangler', 'whoami']);
  assert.match(who.stdout, /work@example\.com/);
  assert.equal(t.json(t.run(['list', '--deep', '--json']))[0].verified, true);
  assert.equal(t.json(t.run(['protect', 'work', '--json'])).results[0].status, 'already');
  assert.match(t.run(['protect', 'work']).stdout, /keyring disable/);
});

test('protect restores the plaintext when wrangler does not encrypt', () => {
  const t = setup();
  t.addOAuth('work', 'tok-w');
  t.json(t.run(['migrate', 'work', '--json']));
  const r = t.run(['protect', 'work', '--json'], { WA_FAKE_NO_MIGRATE: '1' });
  assert.equal(r.status, 1);
  assert.equal(fs.readFileSync(t.nativeFile('work'), 'utf8'), TOML('tok-w'));
  assert.ok(!fs.existsSync(t.nativeFile('work', 'enc')));
  assert.ok(!fs.existsSync(t.store) || !fs.readdirSync(t.store).some((f) => f.startsWith('wrangler--')));
});

test('unprotect decrypts in-process, deletes .enc and the key, never via keyring disable', () => {
  const t = setup();
  t.addOAuth('work', 'tok-w');
  t.json(t.run(['protect', 'work', '--json']));
  const out = t.json(t.run(['unprotect', 'work', '--json']));
  assert.equal(out.results[0].status, 'unprotected');
  assert.equal(out.results[0].secretRemoved, true);
  assert.equal(fs.readFileSync(t.nativeFile('work'), 'utf8'), TOML('tok-w'));
  assert.equal(fs.statSync(t.nativeFile('work')).mode & 0o777, 0o600);
  assert.ok(!fs.existsSync(t.nativeFile('work', 'enc')));
  assert.ok(!fs.readdirSync(t.store).some((f) => f.startsWith('wrangler--')));
  assert.equal(t.json(t.run(['--profile', 'work', 'deploy'])).oauthToken, 'tok-w');
});

test('protect/unprotect --all cover token and OAuth profiles', () => {
  const t = setup();
  t.addOAuth('work', 'tok-w');
  t.addToken('ci', 'api-ci');
  const p = t.json(t.run(['protect', '--all', '--json']));
  assert.deepEqual(p.results.map((r) => [r.name, r.status]).sort(), [['ci', 'protected'], ['work', 'protected']]);
  const u = t.json(t.run(['unprotect', '--all', '--json']));
  assert.deepEqual(u.results.map((r) => [r.name, r.status]).sort(), [['ci', 'unprotected'], ['work', 'unprotected']]);
});

test('protect <oauth> without native support is skipped with an upgrade hint (1.8.0 exit code)', () => {
  const t = setup({ bin: OLD_BIN });
  t.addOAuth('work');
  const r = t.run(['protect', 'work', '--json']);
  assert.equal(r.status, 0);
  const res = JSON.parse(r.stdout).results[0];
  assert.equal(res.status, 'skipped');
  assert.match(res.reason, /wrangler@latest/);
  assert.ok(fs.existsSync(path.join(t.profiles, 'work', 'config.toml')));
});

test('unmigrate brings the credentials back (also from .enc) and removes the native copy', () => {
  const t = setup();
  t.addOAuth('work', 'tok-w');
  t.json(t.run(['protect', 'work', '--json']));
  const out = t.json(t.run(['unmigrate', 'work', '--json'])).results[0];
  assert.equal(out.status, 'unmigrated');
  assert.equal(out.wasEncrypted, true);
  assert.equal(out.keyRemoved, true);
  assert.equal(fs.readFileSync(path.join(t.profiles, 'work', 'config.toml'), 'utf8'), TOML('tok-w'));
  assert.ok(!fs.existsSync(t.nativeFile('work', 'enc')));
  assert.equal(t.meta('work').backend, undefined);
  assert.deepEqual(t.meta('work').identity, IDENTITY);
  const run = t.json(t.run(['--profile', 'work', 'deploy']));
  assert.equal(run.homeIsShadow, true);
  assert.deepEqual(run.argv, ['deploy']);

  const k = setup();
  k.addOAuth('work', 'tok-w');
  k.json(k.run(['migrate', 'work', '--json']));
  const kept = k.json(k.run(['unmigrate', 'work', '--keep-native', '--json'])).results[0];
  assert.equal(kept.keptNative, true);
  assert.ok(fs.existsSync(k.nativeFile('work')));
});

test('remove keeps the native profile unless --delete-native', () => {
  const t = setup();
  t.addOAuth('work', 'tok-w');
  t.addOAuth('two', 'tok-2');
  t.json(t.run(['migrate', 'work', '--json']));
  t.json(t.run(['protect', 'two', '--json']));
  const kept = t.json(t.run(['remove', 'work', '--json']));
  assert.equal(kept.nativeKept, true);
  assert.ok(fs.existsSync(t.nativeFile('work')));
  assert.match(t.run(['list']).stdout, /two/);

  const gone = t.json(t.run(['remove', 'two', '--delete-native', '--json']));
  assert.equal(gone.nativeKept, false);
  assert.equal(gone.nativeKeyRemoved, true);
  assert.ok(!fs.existsSync(t.nativeFile('two', 'enc')));
  assert.ok(!fs.readdirSync(t.store).some((f) => f.startsWith('wrangler--two')));
});

test('sync / save --force write into the native profile; an encrypted one is refused', () => {
  const t = setup({ bin: `${NATIVE_BIN}` });
  t.addOAuth('work', 'tok-w');
  t.json(t.run(['migrate', 'work', '--json']));
  // the current wrangler login (default.toml) belongs to profile work: fake whoami says default@example.com
  fs.writeFileSync(path.join(t.cfg, 'config', 'default.toml'), TOML('tok-fresh'));
  fs.writeFileSync(path.join(t.profiles, 'work', 'meta.json'), JSON.stringify({ ...t.meta('work'), identity: { email: 'default@example.com', accountId: null } }));
  const synced = t.run(['sync', 'work', '--json']);
  assert.equal(synced.status, 0, synced.stderr);
  assert.equal(fs.readFileSync(t.nativeFile('work'), 'utf8'), TOML('tok-fresh'));
  assert.equal(t.meta('work').backend, 'native');

  fs.writeFileSync(path.join(t.cfg, 'config', 'default.toml'), TOML('tok-saved'));
  assert.equal(t.run(['save', 'work', '--force', '--json']).status, 0);
  assert.equal(fs.readFileSync(t.nativeFile('work'), 'utf8'), TOML('tok-saved'));

  t.json(t.run(['protect', 'work', '--json']));
  const refused = t.run(['save', 'work', '--force']);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /refusing to overwrite/);
});

test('login <native> re-authenticates with `wrangler auth create` and keeps encryption', () => {
  const t = setup();
  t.addOAuth('work', 'tok-w');
  t.json(t.run(['protect', 'work', '--json']));
  const r = t.run(['login', 'work', '--force', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.backend, 'native');
  assert.equal(out.identity.email, 'work@example.com');
  assert.ok(fs.existsSync(t.nativeFile('work', 'enc')));
  assert.ok(!fs.existsSync(t.nativeFile('work')));
  assert.equal(t.json(t.run(['--profile', 'work', 'deploy'])).oauthToken, 'created-work');
});

test('shadow backend forces CLOUDFLARE_AUTH_USE_KEYRING=false even with keyring enabled globally', () => {
  const t = setup();
  t.addOAuth('work', 'tok-w');
  fs.writeFileSync(path.join(t.cfg, 'preferences.json'), JSON.stringify({ keyring_enabled: true }));
  const out = t.json(t.run(['--profile', 'work', 'deploy'], { CLOUDFLARE_AUTH_USE_KEYRING: 'true' }));
  assert.equal(out.env.CLOUDFLARE_AUTH_USE_KEYRING, 'false');
  assert.equal(out.env.WA_ORIG_AUTH_USE_KEYRING, 'true');
  assert.equal(out.oauthToken, 'tok-w');
  // nothing got encrypted anywhere, the profile file is untouched
  assert.equal(fs.readFileSync(path.join(t.profiles, 'work', 'config.toml'), 'utf8'), TOML('tok-w'));
  assert.ok(!fs.existsSync(t.store));
});

test('a native profile with wrangler downgraded fails fast with upgrade / unmigrate hints', () => {
  const t = setup();
  t.addOAuth('work');
  t.json(t.run(['migrate', 'work', '--json']));
  const r = t.run(['--profile', 'work', 'deploy'], { PATH: `${OLD_BIN}${path.delimiter}${process.env.PATH}` });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unmigrate work/);
});

test('a failed wrangler token check reports a clean reason: no colour codes, no deleted log path', () => {
  let env = null;
  const res = native.wranglerTokenCheck('work', {
    env: { HOME: '/nowhere' },
    spawn: (cmd, args, opts) => {
      env = opts.env;
      return {
        status: 1,
        stdout: '',
        stderr:
          '\n\x1b[31m✘ \x1b[41;31m[\x1b[41;97mERROR\x1b[41;31m]\x1b[0m \x1b[1mNot logged in.\x1b[0m\n\n' +
          `🪵  Logs were written to "${opts.env.WRANGLER_LOG_PATH}"\n`,
      };
    },
  });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'wrangler auth token exited 1: Not logged in.');
  assert.equal(env.FORCE_COLOR, '0');
  assert.equal(env.NO_COLOR, '1');
});

test('the wrangler token check never lets wrangler write the token into ~/.wrangler/logs', () => {
  let seen = null;
  const res = native.wranglerTokenCheck('work', {
    env: { HOME: '/nowhere' },
    spawn: (cmd, args, opts) => {
      seen = { args, logPath: opts.env.WRANGLER_LOG_PATH };
      assert.ok(fs.existsSync(path.dirname(opts.env.WRANGLER_LOG_PATH)));
      return { status: 0, stdout: '{"type":"oauth","token":"t"}', stderr: '' };
    },
  });
  assert.equal(res.ok, true);
  assert.deepEqual(seen.args, ['auth', 'token', '--json', '--profile', 'work']);
  assert.ok(seen.logPath.startsWith(fs.realpathSync(os.tmpdir())) || seen.logPath.startsWith(os.tmpdir()));
  assert.ok(!fs.existsSync(path.dirname(seen.logPath)), 'temp log dir removed');
});
