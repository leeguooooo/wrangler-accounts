'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CLI = path.join(__dirname, '..', 'bin', 'wrangler-accounts.js');

function mkStore() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wa-listenriched-'));
}

function addProfile(dir, name, { expired = false, identity = null } = {}) {
  fs.mkdirSync(path.join(dir, name), { recursive: true });
  const exp = expired
    ? '2000-01-01T00:00:00.000Z'
    : '2099-01-01T00:00:00.000Z';
  fs.writeFileSync(
    path.join(dir, name, 'config.toml'),
    `oauth_token = "x"\nexpiration_time = "${exp}"\n`,
  );
  const meta = {
    name,
    savedAt: new Date().toISOString(),
    sourcePath: '/fake',
    bytes: 0,
    sha256: '',
  };
  if (identity) meta.identity = identity;
  fs.writeFileSync(path.join(dir, name, 'meta.json'), JSON.stringify(meta, null, 2));
}

function run(args, profilesDir) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, WRANGLER_ACCOUNTS_DIR: profilesDir },
  });
}

test('list --json returns enriched objects per profile', () => {
  const dir = mkStore();
  addProfile(dir, 'work', {
    identity: { email: 'work@example.com', accountId: 'a1', accountName: 'Work' },
  });
  addProfile(dir, 'personal', {
    expired: true,
    identity: { email: 'me@example.com', accountId: 'a2', accountName: 'Personal' },
  });
  fs.writeFileSync(path.join(dir, 'default'), 'work\n');

  const r = run(['list', '--json'], dir);
  assert.equal(r.status, 0, `stderr=${r.stderr}`);
  const entries = JSON.parse(r.stdout);
  assert.equal(entries.length, 2);

  const byName = Object.fromEntries(entries.map((e) => [e.name, e]));

  assert.equal(byName.work.status, 'valid');
  assert.equal(byName.work.isDefault, true);
  assert.equal(byName.work.identity.email, 'work@example.com');
  assert.equal(byName.work.expirationTime, '2099-01-01T00:00:00.000Z');

  assert.equal(byName.personal.status, 'expired');
  assert.equal(byName.personal.isDefault, false);
  assert.equal(byName.personal.identity.email, 'me@example.com');
});

test('list text output shows EXPIRED marker and default asterisk', () => {
  const dir = mkStore();
  addProfile(dir, 'work', {
    identity: { email: 'work@example.com', accountId: 'a1', accountName: 'Work' },
  });
  addProfile(dir, 'stale', { expired: true });
  fs.writeFileSync(path.join(dir, 'default'), 'work\n');

  const r = run(['list'], dir);
  assert.equal(r.status, 0, `stderr=${r.stderr}`);
  assert.match(r.stdout, /Default: work/);
  assert.match(r.stdout, /\* work/);
  assert.match(r.stdout, /EXPIRED/);
  assert.match(r.stdout, /stale/);
  assert.match(r.stdout, /work@example\.com/);
});

test('list text output shows EXPIRES column for both valid and expired profiles', () => {
  const dir = mkStore();
  addProfile(dir, 'work');            // valid, far future
  addProfile(dir, 'stale', { expired: true });  // expired, 2000-01-01
  const r = run(['list'], dir);
  assert.equal(r.status, 0, `stderr=${r.stderr}`);
  // Header should have EXPIRES column
  assert.match(r.stdout, /EXPIRES/);
  // Valid profile should show 'in Nd' format and ISO date
  assert.match(r.stdout, /in \d+d \(2099-01-01\)/);
  // Expired profile should show 'ago' + ISO date
  assert.match(r.stdout, /\d+d ago \(2000-01-01\)/);
});

test('list --plain is unchanged (names only, one per line)', () => {
  const dir = mkStore();
  addProfile(dir, 'work');
  addProfile(dir, 'personal');
  const r = run(['list', '--plain'], dir);
  assert.equal(r.status, 0, `stderr=${r.stderr}`);
  const names = r.stdout.trim().split('\n').sort();
  assert.deepEqual(names, ['personal', 'work']);
});

test('list --json on empty dir still returns []', () => {
  const dir = mkStore();
  const r = run(['list', '--json'], dir);
  assert.equal(r.status, 0);
  assert.deepEqual(JSON.parse(r.stdout), []);
});

test('list text on empty dir still says "No profiles found."', () => {
  const dir = mkStore();
  const r = run(['list'], dir);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /No profiles found\./);
});
