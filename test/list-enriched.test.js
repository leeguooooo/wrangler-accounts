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

function addProfile(dir, name, { expired = false, withRefresh = false, identity = null } = {}) {
  fs.mkdirSync(path.join(dir, name), { recursive: true });
  const exp = expired
    ? '2000-01-01T00:00:00.000Z'
    : '2099-01-01T00:00:00.000Z';
  const lines = [
    'oauth_token = "x"',
    `expiration_time = "${exp}"`,
  ];
  if (withRefresh) lines.push('refresh_token = "r"');
  fs.writeFileSync(path.join(dir, name, 'config.toml'), lines.join('\n') + '\n');
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

test('list distinguishes refreshable vs truly-expired profiles', () => {
  const dir = mkStore();
  addProfile(dir, 'refreshable', { expired: true, withRefresh: true });
  addProfile(dir, 'trulydead', { expired: true, withRefresh: false });
  addProfile(dir, 'fresh', { expired: false, withRefresh: true });

  const r = run(['list', '--json'], dir);
  assert.equal(r.status, 0, `stderr=${r.stderr}`);
  const byName = Object.fromEntries(JSON.parse(r.stdout).map((e) => [e.name, e]));

  assert.equal(byName.fresh.status, 'valid');
  assert.equal(byName.fresh.hasRefreshToken, true);

  assert.equal(byName.refreshable.status, 'refreshable');
  assert.equal(byName.refreshable.hasRefreshToken, true);

  assert.equal(byName.trulydead.status, 'expired');
  assert.equal(byName.trulydead.hasRefreshToken, false);
});

test('list text output shows "valid*" for refreshable and "EXPIRED" for truly-expired', () => {
  const dir = mkStore();
  addProfile(dir, 'refreshable', { expired: true, withRefresh: true });
  addProfile(dir, 'trulydead', { expired: true, withRefresh: false });
  const r = run(['list'], dir);
  assert.equal(r.status, 0, `stderr=${r.stderr}`);
  // refreshable row must show 'valid*' (the asterisk distinguishes it from real valid)
  const refreshableRow = r.stdout.split('\n').find((l) => /\brefreshable\b/.test(l) && !/Legend/.test(l));
  assert.ok(refreshableRow, 'refreshable row missing');
  assert.match(refreshableRow, /valid\*/);
  // trulydead row must show 'EXPIRED'
  const trulydeadRow = r.stdout.split('\n').find((l) => /\btrulydead\b/.test(l) && !/Legend/.test(l));
  assert.ok(trulydeadRow, 'trulydead row missing');
  assert.match(trulydeadRow, /EXPIRED/);
});

test('list text on empty dir still says "No profiles found."', () => {
  const dir = mkStore();
  const r = run(['list'], dir);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /No profiles found\./);
});

// --deep tests use a fake wrangler on PATH so they don't hit real Cloudflare
function setupDeepShim({ failForName = null } = {}) {
  const shim = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-deep-shim-'));
  const fakeWrangler = path.join(shim, 'wrangler');
  // The fake reads its profile name from a marker file in $HOME/.wrangler/config/default.toml
  // and returns "not logged in" for the name listed in $WA_FAIL_PROFILE, otherwise success.
  fs.writeFileSync(fakeWrangler, `#!/bin/sh
case "$1" in
  whoami)
    cfg="$HOME/.wrangler/config/default.toml"
    if [ ! -f "$cfg" ]; then
      echo "Not logged in" >&2
      exit 1
    fi
    # read the marker token to identify the profile
    token=$(grep -o 'oauth_token = "[^"]*"' "$cfg" | sed 's/oauth_token = "//;s/"$//')
    if [ "\${WA_FAIL_PROFILE:-}" = "$token" ]; then
      echo "Not logged in" >&2
      exit 1
    fi
    cat <<EOF
 ⛅️ wrangler 4.79.0
👋 You are logged in with an OAuth Token, associated with the email $token@example.com.
┌───────────┬──────────────────────────────────┐
│ $token Acct │ 0123456789abcdef0123456789abcdef │
└───────────┴──────────────────────────────────┘
EOF
    exit 0
    ;;
  *)
    echo "fake wrangler: unknown $1" >&2
    exit 1
    ;;
esac
`);
  fs.chmodSync(fakeWrangler, 0o755);
  return shim;
}

test('list --deep reports ✓ ok for profiles whose wrangler whoami succeeds', () => {
  const dir = mkStore();
  addProfile(dir, 'work');
  // Override the token in config.toml to be the profile name so the fake shim can identify it
  fs.writeFileSync(
    path.join(dir, 'work', 'config.toml'),
    `oauth_token = "work"\nexpiration_time = "2099-01-01T00:00:00.000Z"\n`,
  );
  const shim = setupDeepShim();
  const env = {
    ...process.env,
    WRANGLER_ACCOUNTS_DIR: dir,
    PATH: `${shim}${path.delimiter}${process.env.PATH}`,
  };
  const r = spawnSync(process.execPath, [CLI, 'list', '--deep'], { encoding: 'utf8', env });
  assert.equal(r.status, 0, `stderr=${r.stderr}`);
  assert.match(r.stdout, /VERIFIED/);
  // check only the table body (line containing the profile name), not the legend
  const profileRow = r.stdout.split('\n').find((line) => /\bwork\b/.test(line) && !/Legend/.test(line));
  assert.ok(profileRow, `profile row not found in:\n${r.stdout}`);
  assert.match(profileRow, /✓ ok/);
  assert.doesNotMatch(profileRow, /✗/);
});

test('list --deep reports ✗ for profiles whose wrangler whoami fails', () => {
  const dir = mkStore();
  addProfile(dir, 'broken');
  fs.writeFileSync(
    path.join(dir, 'broken', 'config.toml'),
    `oauth_token = "broken"\nexpiration_time = "2099-01-01T00:00:00.000Z"\n`,
  );
  const shim = setupDeepShim();
  const env = {
    ...process.env,
    WRANGLER_ACCOUNTS_DIR: dir,
    PATH: `${shim}${path.delimiter}${process.env.PATH}`,
    WA_FAIL_PROFILE: 'broken',
  };
  const r = spawnSync(process.execPath, [CLI, 'list', '--deep'], { encoding: 'utf8', env });
  assert.equal(r.status, 0, `stderr=${r.stderr}`);
  assert.match(r.stdout, /✗ not logged in/i);
});

test('list --deep --json includes verified and verifyError fields', () => {
  const dir = mkStore();
  addProfile(dir, 'work');
  fs.writeFileSync(
    path.join(dir, 'work', 'config.toml'),
    `oauth_token = "work"\nexpiration_time = "2099-01-01T00:00:00.000Z"\n`,
  );
  const shim = setupDeepShim();
  const env = {
    ...process.env,
    WRANGLER_ACCOUNTS_DIR: dir,
    PATH: `${shim}${path.delimiter}${process.env.PATH}`,
  };
  const r = spawnSync(process.execPath, [CLI, 'list', '--deep', '--json'], { encoding: 'utf8', env });
  assert.equal(r.status, 0, `stderr=${r.stderr}`);
  const entries = JSON.parse(r.stdout);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].verified, true);
  assert.equal(entries[0].verifyError, null);
  assert.ok(entries[0].liveIdentity);
});
