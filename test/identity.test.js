'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  parseWranglerWhoamiOutput,
  getMetaIdentity,
  identitiesMatch,
  describeIdentity,
  findProfilesByIdentity,
  getCurrentIdentity,
} = require('../lib/identity');

const WHOAMI_SAMPLE = [
  ' ⛅️ wrangler 4.79.0 (update available 4.81.1)',
  '─────────────────────────────────────────────',
  'Getting User settings...',
  '👋 You are logged in with an OAuth Token, associated with the email xdreamstar2025@gmail.com.',
  '┌────────────────────────────────────┬──────────────────────────────────┐',
  '│ Account Name                       │ Account ID                       │',
  '├────────────────────────────────────┼──────────────────────────────────┤',
  "│ Xdreamstar2025@gmail.com's Account │ 5544eac7cfb260d4fec9467d49513cea │",
  '└────────────────────────────────────┴──────────────────────────────────┘',
].join('\n');

test('parseWranglerWhoamiOutput extracts email, account name, and account ID', () => {
  const result = parseWranglerWhoamiOutput(WHOAMI_SAMPLE);
  assert.deepEqual(result, {
    email: 'xdreamstar2025@gmail.com',
    accountName: "Xdreamstar2025@gmail.com's Account",
    accountId: '5544eac7cfb260d4fec9467d49513cea',
  });
});

test('parseWranglerWhoamiOutput returns null for empty input', () => {
  assert.equal(parseWranglerWhoamiOutput(''), null);
  assert.equal(parseWranglerWhoamiOutput(null), null);
  assert.equal(parseWranglerWhoamiOutput(undefined), null);
});

test('parseWranglerWhoamiOutput returns partial for email-only output', () => {
  const partial = '👋 You are logged in with an OAuth Token, associated with the email only@example.com.\n';
  const result = parseWranglerWhoamiOutput(partial);
  assert.equal(result.email, 'only@example.com');
  assert.equal(result.accountName, null);
  assert.equal(result.accountId, null);
});

test('identitiesMatch prefers accountId when both sides have it', () => {
  assert.equal(identitiesMatch({ accountId: 'X' }, { accountId: 'X' }), true);
  assert.equal(identitiesMatch({ accountId: 'X' }, { accountId: 'Y' }), false);
});

test('identitiesMatch falls back to email when accountId missing', () => {
  assert.equal(identitiesMatch({ email: 'a@example.com' }, { email: 'a@example.com' }), true);
  assert.equal(identitiesMatch({ email: 'a@example.com' }, { email: 'b@example.com' }), false);
});

test('identitiesMatch returns false for null/empty inputs', () => {
  assert.equal(identitiesMatch(null, { email: 'a' }), false);
  assert.equal(identitiesMatch({ email: 'a' }, null), false);
  assert.equal(identitiesMatch({}, {}), false);
  assert.equal(identitiesMatch(null, null), false);
});

test('describeIdentity formats email and account ID', () => {
  assert.equal(
    describeIdentity({ email: 'a@example.com', accountId: 'X' }),
    'a@example.com / X',
  );
  assert.equal(describeIdentity({ email: 'a@example.com' }), 'a@example.com');
  assert.equal(describeIdentity({ accountId: 'X' }), 'X');
  assert.equal(describeIdentity(null), 'unknown');
  assert.equal(describeIdentity({}), 'unknown');
});

test('getMetaIdentity extracts identity fields from meta', () => {
  const meta = {
    name: 'work',
    identity: { email: 'a@example.com', accountId: 'X', accountName: 'Test' },
  };
  assert.deepEqual(getMetaIdentity(meta), {
    email: 'a@example.com',
    accountId: 'X',
    accountName: 'Test',
  });
});

test('getMetaIdentity returns null when meta has no identity', () => {
  assert.equal(getMetaIdentity({ name: 'work' }), null);
  assert.equal(getMetaIdentity(null), null);
  assert.equal(getMetaIdentity({}), null);
});

test('getMetaIdentity returns null when identity is empty', () => {
  assert.equal(getMetaIdentity({ identity: {} }), null);
  assert.equal(getMetaIdentity({ identity: { email: null } }), null);
});

test('findProfilesByIdentity returns matching profile names', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-fpbi-'));
  // profile 1: matches by email
  fs.mkdirSync(path.join(dir, 'work'));
  fs.writeFileSync(path.join(dir, 'work', 'config.toml'), '');
  fs.writeFileSync(
    path.join(dir, 'work', 'meta.json'),
    JSON.stringify({ name: 'work', identity: { email: 'a@example.com' } }),
  );
  // profile 2: does not match
  fs.mkdirSync(path.join(dir, 'personal'));
  fs.writeFileSync(path.join(dir, 'personal', 'config.toml'), '');
  fs.writeFileSync(
    path.join(dir, 'personal', 'meta.json'),
    JSON.stringify({ name: 'personal', identity: { email: 'b@example.com' } }),
  );

  const result = findProfilesByIdentity(dir, { email: 'a@example.com' });
  assert.deepEqual(result, ['work']);
});

test('findProfilesByIdentity returns empty array for null identity', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-fpbi-null-'));
  assert.deepEqual(findProfilesByIdentity(dir, null), []);
});

test('getCurrentIdentity reports identity-lookup-unavailable when config path mismatches', () => {
  // Inject an env that makes getWranglerAuthPath resolve to a specific path,
  // then pass a DIFFERENT configPath to getCurrentIdentity.
  const result = getCurrentIdentity('/tmp/different-path.toml', {
    env: { WRANGLER_CONFIG_PATH: '/tmp/auth-path.toml' },
    spawn: () => { throw new Error('should not be called'); },
  });
  assert.equal(result.identity, null);
  assert.match(result.error, /Identity lookup only works/);
});

test('getCurrentIdentity returns parsed identity when spawn succeeds', () => {
  const fakeSpawn = () => ({
    error: null,
    status: 0,
    stdout: WHOAMI_SAMPLE,
    stderr: '',
  });
  const cfg = '/tmp/match-path.toml';
  const result = getCurrentIdentity(cfg, {
    env: { WRANGLER_CONFIG_PATH: cfg },
    spawn: fakeSpawn,
  });
  assert.equal(result.error, null);
  assert.equal(result.identity.email, 'xdreamstar2025@gmail.com');
});

test('getCurrentIdentity reports "Not logged in" branch', () => {
  const fakeSpawn = () => ({
    error: null,
    status: 1,
    stdout: '',
    stderr: 'Not logged in',
  });
  const cfg = '/tmp/match-path.toml';
  const result = getCurrentIdentity(cfg, {
    env: { WRANGLER_CONFIG_PATH: cfg },
    spawn: fakeSpawn,
  });
  assert.equal(result.identity, null);
  assert.equal(result.error, 'Not logged in');
});

test('getCurrentIdentity surfaces spawn error', () => {
  const fakeSpawn = () => ({ error: new Error('ENOENT'), status: null });
  const cfg = '/tmp/match-path.toml';
  const result = getCurrentIdentity(cfg, {
    env: { WRANGLER_CONFIG_PATH: cfg },
    spawn: fakeSpawn,
  });
  assert.equal(result.identity, null);
  assert.equal(result.error, 'ENOENT');
});
