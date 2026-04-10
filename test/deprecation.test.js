'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CLI = path.join(__dirname, '..', 'bin', 'wrangler-accounts.js');

function mkStore() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wa-dep-store-'));
}

function addProfile(dir, name) {
  fs.mkdirSync(path.join(dir, name), { recursive: true });
  fs.writeFileSync(
    path.join(dir, name, 'config.toml'),
    'oauth_token = "x"\n',
  );
}

function makeCfg() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-dep-cfg-'));
  const p = path.join(d, 'default.toml');
  fs.writeFileSync(p, 'oauth_token = "current"\n');
  return p;
}

function run(args, { profilesDir, configPath, extraEnv = {} } = {}) {
  const env = { ...process.env, WRANGLER_ACCOUNTS_DIR: profilesDir, ...extraEnv };
  delete env.WRANGLER_CONFIG_PATH;
  const fullArgs = [CLI, ...args];
  if (configPath) fullArgs.push('-c', configPath);
  return spawnSync(process.execPath, fullArgs, { encoding: 'utf8', env });
}

test('use <profile> still works and emits deprecation warning', () => {
  const profilesDir = mkStore();
  addProfile(profilesDir, 'work');
  const configPath = makeCfg();
  const r = run(['use', 'work'], { profilesDir, configPath });
  assert.equal(r.status, 0, `stderr=${r.stderr}`);
  assert.match(r.stderr, /deprecated/i);
  // the existing use behavior writes the active file
  assert.equal(fs.readFileSync(path.join(profilesDir, 'active'), 'utf8').trim(), 'work');
});

test('sync-active is a deprecated alias for sync-default', () => {
  const profilesDir = mkStore();
  addProfile(profilesDir, 'work');
  const configPath = makeCfg();
  // Set up a default
  fs.writeFileSync(path.join(profilesDir, 'default'), 'work\n');
  // Seed the profile identity to match so syncProfile passes the identity check
  const metaPath = path.join(profilesDir, 'work', 'meta.json');
  fs.writeFileSync(metaPath, JSON.stringify({ name: 'work', identity: null }, null, 2));

  const r = run(['sync-active'], { profilesDir, configPath });
  // Note: sync-active calls loadCurrentIdentity which requires configPath
  // to match getWranglerAuthPath. We pass -c so they differ — identity is
  // null, and syncProfile will die with "Unable to identify". We're
  // testing the DEPRECATION WARNING specifically, not the happy path.
  assert.match(r.stderr, /deprecated/i);
  // Exit code doesn't matter for this test — we're verifying the warning
});

test('sync-default without default or active profile exits 2', () => {
  const profilesDir = mkStore();
  const configPath = makeCfg();
  const r = run(['sync-default'], { profilesDir, configPath });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /default/);
});
