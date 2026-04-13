'use strict';

// Regression coverage for: pre-flight pass-through and exec used to refuse
// any profile whose access_token had passed expiration_time, even when a
// refresh_token was present and wrangler would silently auto-refresh on
// the next call.
//
// After the fix, only `effective === 'expired'` (access expired AND no
// refresh_token) blocks. `effective === 'refreshable'` is allowed through;
// the spawned wrangler refreshes the token itself.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CLI = path.join(__dirname, '..', 'bin', 'wrangler-accounts.js');
const FIXTURE = path.join(__dirname, 'fixtures', 'fake-wrangler.sh');

function setupShim() {
  const shim = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-refresh-shim-'));
  fs.copyFileSync(FIXTURE, path.join(shim, 'wrangler'));
  fs.chmodSync(path.join(shim, 'wrangler'), 0o755);
  return shim;
}

function setupProfile(name, { refreshToken }) {
  const profilesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-refresh-pdir-'));
  fs.mkdirSync(path.join(profilesDir, name));
  const lines = [
    'oauth_token = "fake-access-token"',
    'expiration_time = "2020-01-01T00:00:00.000Z"',
  ];
  if (refreshToken) {
    lines.push('refresh_token = "fake-refresh-token"');
  }
  fs.writeFileSync(path.join(profilesDir, name, 'config.toml'), lines.join('\n') + '\n');
  return profilesDir;
}

function runCli(args, { profilesDir, shim, extraEnv = {} } = {}) {
  const env = { ...process.env };
  delete env.WRANGLER_CONFIG_PATH;
  delete env.WRANGLER_PROFILE;
  if (profilesDir) env.WRANGLER_ACCOUNTS_DIR = profilesDir;
  if (shim) env.PATH = `${shim}${path.delimiter}${process.env.PATH}`;
  Object.assign(env, extraEnv);
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env });
}

test('pass-through: refreshable profile (expired access + refresh_token) is NOT blocked', () => {
  const profilesDir = setupProfile('work', { refreshToken: true });
  const shim = setupShim();
  const r = runCli(['--profile', 'work', 'deploy'], { profilesDir, shim });
  assert.equal(r.status, 0, `unexpected exit; stderr=${r.stderr}`);
  assert.doesNotMatch(r.stderr, /has expired Wrangler OAuth credentials/);
});

test('pass-through: truly expired profile (no refresh_token) IS blocked with actionable error', () => {
  const profilesDir = setupProfile('work', { refreshToken: false });
  const shim = setupShim();
  const r = runCli(['--profile', 'work', 'deploy'], { profilesDir, shim });
  assert.equal(r.status, 3);
  assert.match(r.stderr, /has expired Wrangler OAuth credentials/);
  assert.match(r.stderr, /wrangler-accounts login work/);
});

test('exec: refreshable profile is NOT blocked', () => {
  const profilesDir = setupProfile('work', { refreshToken: true });
  const r = runCli(['exec', 'work', '--', 'sh', '-c', 'echo ok'], { profilesDir });
  assert.equal(r.status, 0, `unexpected exit; stderr=${r.stderr}`);
  assert.doesNotMatch(r.stderr, /has expired Wrangler OAuth credentials/);
  assert.match(r.stdout, /ok/);
});

test('exec: truly expired profile (no refresh_token) IS blocked', () => {
  const profilesDir = setupProfile('work', { refreshToken: false });
  const r = runCli(['exec', 'work', '--', 'sh', '-c', 'echo ok'], { profilesDir });
  assert.equal(r.status, 3);
  assert.match(r.stderr, /has expired Wrangler OAuth credentials/);
  assert.match(r.stderr, /wrangler-accounts login work/);
});
