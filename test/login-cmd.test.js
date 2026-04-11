'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CLI = path.join(__dirname, '..', 'bin', 'wrangler-accounts.js');
const FIXTURE = path.join(__dirname, 'fixtures', 'fake-wrangler-login.sh');

function setupShim() {
  const shim = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-login-shim-'));
  fs.copyFileSync(FIXTURE, path.join(shim, 'wrangler'));
  fs.chmodSync(path.join(shim, 'wrangler'), 0o755);
  return shim;
}

function mkStore() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wa-login-store-'));
}

function run(args, { profilesDir, shim, extraEnv = {} } = {}) {
  const env = { ...process.env };
  delete env.WRANGLER_CONFIG_PATH;
  if (profilesDir) env.WRANGLER_ACCOUNTS_DIR = profilesDir;
  if (shim) env.PATH = `${shim}${path.delimiter}${process.env.PATH}`;
  Object.assign(env, extraEnv);
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env });
}

test('login <newprofile> --force creates profile with config.toml and meta.json', () => {
  // --force is required because tests run in non-TTY (no real terminal),
  // which triggers the 1.4.0 TTY guard.
  const profilesDir = mkStore();
  const shim = setupShim();
  const r = run(['login', 'newprofile', '--force'], { profilesDir, shim });
  assert.equal(r.status, 0, `stderr=${r.stderr}`);

  const cfg = path.join(profilesDir, 'newprofile', 'config.toml');
  const meta = path.join(profilesDir, 'newprofile', 'meta.json');
  assert.ok(fs.existsSync(cfg));
  assert.ok(fs.existsSync(meta));
  const cfgContent = fs.readFileSync(cfg, 'utf8');
  assert.match(cfgContent, /fake-from-login/);
  const metaJson = JSON.parse(fs.readFileSync(meta, 'utf8'));
  assert.equal(metaJson.name, 'newprofile');
  assert.equal(metaJson.identity.email, 'test@example.com');
  assert.equal(metaJson.identity.accountId, '0123456789abcdef0123456789abcdef');
});

test('login <existing> --force overwrites the profile (preserves v0 behavior with explicit force)', () => {
  const profilesDir = mkStore();
  const shim = setupShim();
  // pre-populate a profile with stale content
  fs.mkdirSync(path.join(profilesDir, 'work'));
  fs.writeFileSync(path.join(profilesDir, 'work', 'config.toml'), 'oauth_token = "stale"\n');
  fs.writeFileSync(path.join(profilesDir, 'work', 'meta.json'), '{}');

  const r = run(['login', 'work', '--force'], { profilesDir, shim });
  assert.equal(r.status, 0, `stderr=${r.stderr}`);
  const cfgContent = fs.readFileSync(path.join(profilesDir, 'work', 'config.toml'), 'utf8');
  assert.match(cfgContent, /fake-from-login/);
  assert.doesNotMatch(cfgContent, /stale/);
});

test('login does not write to real ~/.wrangler/config/default.toml', () => {
  const profilesDir = mkStore();
  const shim = setupShim();
  const realCfg = path.join(os.homedir(), '.wrangler', 'config', 'default.toml');
  const beforeExists = fs.existsSync(realCfg);
  const beforeMtime = beforeExists ? fs.statSync(realCfg).mtimeMs : null;

  const r = run(['login', 'isolated-test', '--force'], { profilesDir, shim });
  assert.equal(r.status, 0, `stderr=${r.stderr}`);

  const afterExists = fs.existsSync(realCfg);
  const afterMtime = afterExists ? fs.statSync(realCfg).mtimeMs : null;
  assert.equal(afterExists, beforeExists, 'real ~/.wrangler existence changed');
  if (beforeExists) {
    assert.equal(afterMtime, beforeMtime, 'real ~/.wrangler/config/default.toml mtime changed');
  }
});

test('login --json --force emits identity in payload', () => {
  const profilesDir = mkStore();
  const shim = setupShim();
  const r = run(['login', 'jsonprof', '--json', '--force'], { profilesDir, shim });
  assert.equal(r.status, 0, `stderr=${r.stderr}`);
  const payload = JSON.parse(r.stdout);
  assert.equal(payload.command, 'login');
  assert.equal(payload.name, 'jsonprof');
  assert.equal(payload.identity.email, 'test@example.com');
});

test('login --force fails cleanly when whoami cannot parse identity', () => {
  const profilesDir = mkStore();
  const shim = setupShim();
  const r = run(['login', 'badwhoami', '--force'], {
    profilesDir,
    shim,
    extraEnv: { WA_FAKE_WRANGLER_WHOAMI_FAIL: '1' },
  });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /could not parse|whoami/i);
  // profile should not be created
  assert.equal(fs.existsSync(path.join(profilesDir, 'badwhoami')), false);
});

test('login rejects invalid profile names (validity check fires before TTY guard)', () => {
  const profilesDir = mkStore();
  const shim = setupShim();
  const r = run(['login', 'bad name!'], { profilesDir, shim });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Invalid profile name/);
});

// 1.4.0 guards

test('GUARD: login without --force in non-TTY context fails with actionable hint', () => {
  // Tests always run in non-TTY (Node spawn context), so the TTY guard
  // should fire. The error message must point users at whoami / list --deep
  // and explain how to bypass with --force.
  const profilesDir = mkStore();
  const shim = setupShim();
  const r = run(['login', 'whatever'], { profilesDir, shim });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /interactive terminal/i);
  assert.match(r.stderr, /whoami --profile whatever/);
  assert.match(r.stderr, /list --deep/);
  assert.match(r.stderr, /--force/);
  // profile must NOT have been created
  assert.equal(fs.existsSync(path.join(profilesDir, 'whatever')), false);
});

test('GUARD: login --force on a healthy existing profile still proceeds (force bypasses both guards)', () => {
  const profilesDir = mkStore();
  const shim = setupShim();
  // Set up a HEALTHY existing profile (valid future expiry, has refresh_token)
  fs.mkdirSync(path.join(profilesDir, 'healthy'));
  fs.writeFileSync(
    path.join(profilesDir, 'healthy', 'config.toml'),
    [
      'oauth_token = "fresh"',
      'expiration_time = "2099-01-01T00:00:00.000Z"',
      'refresh_token = "r"',
    ].join('\n'),
  );
  fs.writeFileSync(path.join(profilesDir, 'healthy', 'meta.json'), '{}');

  // Without --force, the health guard fires (would fire in TTY, TTY guard
  // fires in test context — either way, we should get a non-zero exit)
  const noForce = run(['login', 'healthy'], { profilesDir, shim });
  assert.notEqual(noForce.status, 0);

  // With --force, both guards bypass, login proceeds and overwrites
  const withForce = run(['login', 'healthy', '--force'], { profilesDir, shim });
  assert.equal(withForce.status, 0, `stderr=${withForce.stderr}`);
  const cfgContent = fs.readFileSync(path.join(profilesDir, 'healthy', 'config.toml'), 'utf8');
  assert.match(cfgContent, /fake-from-login/, 'profile should have been overwritten');
});
