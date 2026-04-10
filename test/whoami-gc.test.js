'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CLI = path.join(__dirname, '..', 'bin', 'wrangler-accounts.js');

function mkStore() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wa-wg-store-'));
}

function addProfile(dir, name, identity = null) {
  fs.mkdirSync(path.join(dir, name), { recursive: true });
  fs.writeFileSync(path.join(dir, name, 'config.toml'), 'oauth_token = "x"\n');
  const meta = { name, savedAt: new Date().toISOString(), sourcePath: '/fake', bytes: 0, sha256: '' };
  if (identity) meta.identity = identity;
  fs.writeFileSync(path.join(dir, name, 'meta.json'), JSON.stringify(meta, null, 2));
}

function run(args, profilesDir, extraEnv = {}) {
  const env = { ...process.env, WRANGLER_ACCOUNTS_DIR: profilesDir, ...extraEnv };
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env });
}

test('whoami with no profile resolvable exits 2', () => {
  const dir = mkStore();
  const r = run(['whoami'], dir, { WRANGLER_PROFILE: '' });
  assert.equal(r.status, 2);
});

test('whoami --profile <work> prints profile name and source when meta has no identity', () => {
  const dir = mkStore();
  addProfile(dir, 'work');
  const r = run(['whoami', '--profile', 'work'], dir);
  assert.equal(r.status, 0, `stderr=${r.stderr}`);
  assert.match(r.stdout, /work \[cli\]/);
  assert.match(r.stdout, /identity unknown/);
});

test('whoami --profile <work> prints identity from meta.json', () => {
  const dir = mkStore();
  addProfile(dir, 'work', { email: 'a@example.com', accountId: 'X', accountName: 'Test' });
  const r = run(['whoami', '--profile', 'work'], dir);
  assert.equal(r.status, 0, `stderr=${r.stderr}`);
  assert.match(r.stdout, /a@example\.com/);
});

test('whoami --json emits structured payload', () => {
  const dir = mkStore();
  addProfile(dir, 'work', { email: 'a@example.com', accountId: 'X', accountName: 'Test' });
  const r = run(['whoami', '--profile', 'work', '--json'], dir);
  assert.equal(r.status, 0, `stderr=${r.stderr}`);
  const payload = JSON.parse(r.stdout);
  assert.equal(payload.command, 'whoami');
  assert.equal(payload.profile, 'work');
  assert.equal(payload.source, 'cli');
  assert.equal(payload.identity.email, 'a@example.com');
});

test('whoami without explicit profile uses persistent default', () => {
  const dir = mkStore();
  addProfile(dir, 'work', { email: 'a@example.com' });
  fs.writeFileSync(path.join(dir, 'default'), 'work\n');
  const r = run(['whoami'], dir);
  assert.equal(r.status, 0, `stderr=${r.stderr}`);
  assert.match(r.stdout, /work \[default\]/);
});

// gc tests

test('gc with no stale shadows prints "nothing to clean"', () => {
  const dir = mkStore();
  // Use a very tiny threshold on a fresh store — nothing under $TMPDIR
  // started with "wa-" that is owned by this process should be stale.
  // But there could be stale ones from prior runs. Use a huge threshold
  // so nothing qualifies.
  const r = run(['gc', '--older-than', '999d'], dir);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /nothing to clean/);
});

test('gc removes a fake aged shadow dir', () => {
  const dir = mkStore();
  // Create a fake shadow dir under tmpdir with an old mtime
  const stale = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-stale-'));
  // Set mtime to 2 hours ago
  const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000);
  fs.utimesSync(stale, twoHoursAgo, twoHoursAgo);

  const r = run(['gc', '--older-than', '1h'], dir);
  assert.equal(r.status, 0, `stderr=${r.stderr}`);
  assert.match(r.stdout, new RegExp(stale.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(fs.existsSync(stale), false);
});

test('gc preserves shadows newer than threshold', () => {
  const dir = mkStore();
  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-fresh-'));
  const r = run(['gc', '--older-than', '1h'], dir);
  assert.equal(r.status, 0);
  assert.equal(fs.existsSync(fresh), true, 'fresh shadow must not be cleaned');
  // manual cleanup
  fs.rmSync(fresh, { recursive: true, force: true });
});

test('gc --json emits removed list', () => {
  const dir = mkStore();
  const stale = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-stalejson-'));
  const oldDate = new Date(Date.now() - 2 * 3600 * 1000);
  fs.utimesSync(stale, oldDate, oldDate);
  const r = run(['gc', '--older-than', '1h', '--json'], dir);
  assert.equal(r.status, 0);
  const payload = JSON.parse(r.stdout);
  assert.equal(payload.command, 'gc');
  assert.ok(payload.removed.includes(stale));
});
