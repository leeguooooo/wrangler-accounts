'use strict';

// Native profiles used by an OLD wrangler (< 4.149, e.g. a project's locked
// 4.40 run via `exec <name> -- npx wrangler ...`). Old wrangler ignores
// --profile, directory bindings and the keyring; it only reads
// <HOME>/.wrangler/config/default.toml. test/fixtures/contract-bin/wrangler
// stands in for it: it reports that file as shadowDefaultToml.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const native = require('../lib/native');
const { provideLegacyDefaultToml } = require('../lib/legacy-auth');

const CLI = path.join(__dirname, '..', 'bin', 'wrangler-accounts.js');
const NATIVE_BIN = path.join(__dirname, 'fixtures', 'native-bin');
const OLD_BIN = path.join(__dirname, 'fixtures', 'contract-bin');

const TOML = (tok) => `oauth_token = "${tok}"\nrefresh_token = "r-${tok}"\nexpiration_time = "2099-01-01T00:00:00.000Z"\nscopes = ["account:read"]\n`;
const IDENTITY = { email: 'w@example.com', accountName: 'W', accountId: 'aaaabbbbccccddddeeeeffff00001111' };

function setup() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wa-legacy-')));
  const home = path.join(root, 'home');
  const profiles = path.join(root, 'profiles');
  const store = path.join(root, 'store');
  const tmp = path.join(root, 'tmp');
  fs.mkdirSync(path.join(home, '.wrangler', 'config'), { recursive: true });
  fs.mkdirSync(tmp);
  const env = {
    PATH: `${NATIVE_BIN}${path.delimiter}${process.env.PATH}`,
    HOME: home,
    WA_TEST_REAL_HOME: home,
    WA_CONTRACT_REAL_HOME: home,
    WRANGLER_ACCOUNTS_DIR: profiles,
    WRANGLER_ACCOUNTS_SECRET_BACKEND: `file:${store}`,
    WRANGLER_ACCOUNTS_SHIM_DIR: path.join(root, 'shims'),
    XDG_CONFIG_HOME: path.join(home, '.config'),
    SHELL: '/bin/sh',
    // shadows land here, so the test can check nothing is left behind
    TMPDIR: tmp,
  };
  const t = { root, home, profiles, store, tmp, env, cfg: path.join(home, '.wrangler') };
  t.run = (args, extra = {}) =>
    spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...env, ...extra }, cwd: root, input: '' });
  t.json = (r) => {
    assert.equal(r.status, 0, `exit ${r.status}\nstdout=${r.stdout}\nstderr=${r.stderr}`);
    try {
      return JSON.parse(r.stdout);
    } catch {
      return JSON.parse(r.stdout.trim().split('\n').pop());
    }
  };
  t.addOAuth = (name, tok) => {
    fs.mkdirSync(path.join(profiles, name), { recursive: true });
    fs.writeFileSync(path.join(profiles, name, 'config.toml'), TOML(tok));
    fs.writeFileSync(path.join(profiles, name, 'meta.json'), JSON.stringify({ name, identity: IDENTITY }));
  };
  t.nativeFile = (name, ext = 'toml') => path.join(t.cfg, 'config', `${name}.${ext}`);
  t.decrypt = (name) => native.decryptNativeProfile(name, { env, home });
  // `npx wrangler` in a project that locks an old wrangler
  t.oldWrangler = (script) => ['sh', '-c', `PATH=${OLD_BIN}:$PATH; ${script}`];
  return t;
}

test('exec <encrypted native profile> -- old wrangler: logged in via a decrypted default.toml, nothing left behind', () => {
  const t = setup();
  t.addOAuth('work', 'tok-w');
  t.json(t.run(['protect', 'work', '--json']));
  assert.ok(fs.existsSync(t.nativeFile('work', 'enc')));

  const out = t.json(t.run(['exec', 'work', '--', ...t.oldWrangler('wrangler deploy')]));
  assert.equal(out.homeIsReal, false);
  assert.equal(out.shadowDefaultToml, TOML('tok-w'));
  assert.equal(out.env.CLOUDFLARE_ACCOUNT_ID, IDENTITY.accountId);

  const mode = t.run(['exec', 'work', '--', 'sh', '-c', 'stat -f %Lp "$HOME/.wrangler/config/default.toml" 2>/dev/null || stat -c %a "$HOME/.wrangler/config/default.toml"']);
  assert.equal(mode.stdout.trim(), '600');
  const who = t.run(['exec', 'work', '--', ...t.oldWrangler('wrangler whoami')]);
  assert.equal(who.status, 0, who.stderr);
  assert.match(who.stdout, /logged in/);

  // the decrypted copy went away with the shadow; no plaintext anywhere
  assert.deepEqual(fs.readdirSync(t.tmp), []);
  const grep = spawnSync('grep', ['-r', 'tok-w', t.cfg, t.profiles, t.tmp], { encoding: 'utf8' });
  assert.equal(grep.stdout, '');
  assert.equal(t.decrypt('work'), TOML('tok-w'));
});

test('a token refresh by old wrangler is re-encrypted into <name>.enc with the same key', () => {
  const t = setup();
  t.addOAuth('work', 'tok-w');
  t.json(t.run(['protect', 'work', '--json']));
  const keyFiles = fs.readdirSync(t.store).sort();

  const refreshed = TOML('tok-fresh');
  const r = t.run(['exec', 'work', '--', 'sh', '-c', `printf '%s' '${refreshed}' > "$HOME/.wrangler/config/default.toml"`]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(t.decrypt('work'), refreshed);
  assert.equal(fs.statSync(t.nativeFile('work', 'enc')).mode & 0o777, 0o600);
  assert.ok(!fs.existsSync(t.nativeFile('work')));
  assert.deepEqual(fs.readdirSync(t.store).sort(), keyFiles);
  // and the new wrangler still reads it
  assert.equal(t.json(t.run(['--profile', 'work', 'deploy'])).oauthToken, 'tok-fresh');

  // garbage or a logout (file removed) never reaches the real store
  t.run(['exec', 'work', '--', 'sh', '-c', 'echo broken > "$HOME/.wrangler/config/default.toml"']);
  t.run(['exec', 'work', '--', 'sh', '-c', 'rm "$HOME/.wrangler/config/default.toml"']);
  assert.equal(t.decrypt('work'), refreshed);
});

test('exec <plaintext native profile> -- old wrangler: default.toml links to the native file (refresh writes through)', () => {
  const t = setup();
  t.addOAuth('work', 'tok-w');
  t.json(t.run(['migrate', 'work', '--json']));
  assert.equal(t.json(t.run(['exec', 'work', '--', ...t.oldWrangler('wrangler deploy')])).shadowDefaultToml, TOML('tok-w'));
  t.run(['exec', 'work', '--', 'sh', '-c', `printf '%s' '${TOML('tok-2')}' > "$HOME/.wrangler/config/default.toml"`]);
  assert.equal(fs.readFileSync(t.nativeFile('work'), 'utf8'), TOML('tok-2'));
});

test('new wrangler in the same exec still uses the bound profile, never the default.toml copy', () => {
  const t = setup();
  t.addOAuth('work', 'tok-w');
  t.json(t.run(['protect', 'work', '--json']));
  const out = t.json(t.run(['exec', 'work', '--', 'wrangler', 'deploy']));
  assert.equal(out.profile, 'work');
  assert.equal(out.oauthToken, 'tok-w');
  // no key was created for a "default" profile
  assert.ok(!fs.readdirSync(t.store).some((f) => f.startsWith('wrangler--default')));
});

test('syncBack keeps a .enc that another wrangler rewrote during the run', () => {
  const t = setup();
  t.addOAuth('work', 'tok-w');
  t.json(t.run(['protect', 'work', '--json']));
  const files = native.nativePaths('work', { env: t.env, home: t.home });
  const configDir = fs.mkdtempSync(path.join(t.tmp, 'cfg-'));
  const handle = provideLegacyDefaultToml({ configDir, nativeName: 'work', nativeFiles: files, env: t.env });
  assert.equal(handle.mode, 'decrypted');
  const key = native.readNativeKey('work', t.env);
  const newer = JSON.stringify(native.encryptToEnvelope(TOML('tok-new'), key), null, '\t');
  fs.writeFileSync(files.enc, newer);
  fs.writeFileSync(path.join(configDir, 'default.toml'), TOML('tok-old-refresh'));
  assert.equal(handle.syncBack(), false);
  assert.equal(fs.readFileSync(files.enc, 'utf8'), newer);
});

test('a key that cannot be read leaves old wrangler logged out but the run still happens', () => {
  const t = setup();
  t.addOAuth('work', 'tok-w');
  t.json(t.run(['protect', 'work', '--json']));
  fs.rmSync(t.store, { recursive: true, force: true });
  const r = t.run(['exec', 'work', '--', ...t.oldWrangler('wrangler deploy')]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /could not decrypt 'work' for wrangler < 4\.149/);
  assert.equal(JSON.parse(r.stdout.trim()).shadowDefaultToml, null);
  assert.deepEqual(fs.readdirSync(t.tmp), []);
});
