'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  saveTokenProfile,
  readTokenCredentials,
  resolveTokenCredentials,
  protectTokenProfile,
  unprotectTokenProfile,
  removeProfile,
  listProfiles,
  getProfileType,
} = require('../lib/profile-store');
const { getBackend, secretAccount } = require('../lib/secret-store');

const CLI = path.join(__dirname, '..', 'bin', 'wrangler-accounts.js');

function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `wa-protect-${prefix}-`));
}

function fileEnv() {
  const store = mkTmp('store');
  return { env: { ...process.env, WRANGLER_ACCOUNTS_SECRET_BACKEND: `file:${store}` }, store };
}

function runCli(args, env) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env });
}

test('protect moves the token out of token.json only after it reads back', () => {
  const profilesDir = mkTmp('p');
  const { env } = fileEnv();
  saveTokenProfile('work', 'tok-123', 'acct-1', profilesDir, false);

  const res = protectTokenProfile(profilesDir, 'work', { env });
  assert.equal(res.status, 'protected');

  const onDisk = readTokenCredentials(path.join(profilesDir, 'work'));
  assert.equal(onDisk.apiToken, undefined);
  assert.equal(onDisk.accountId, 'acct-1');
  assert.equal(fs.statSync(path.join(profilesDir, 'work', 'token.json')).mode & 0o777, 0o600);
  assert.deepEqual(resolveTokenCredentials(path.join(profilesDir, 'work'), env), {
    accountId: 'acct-1',
    apiToken: 'tok-123',
  });
  // still a token profile everywhere else
  assert.equal(getProfileType(path.join(profilesDir, 'work')), 'token');
  assert.deepEqual(listProfiles(profilesDir), ['work']);
  assert.equal(protectTokenProfile(profilesDir, 'work', { env }).status, 'already');
});

test('a store that does not read back leaves token.json untouched', () => {
  const profilesDir = mkTmp('bad');
  const { env, store } = fileEnv();
  saveTokenProfile('work', 'tok-123', 'acct-1', profilesDir, false);
  const before = fs.readFileSync(path.join(profilesDir, 'work', 'token.json'), 'utf8');
  fs.mkdirSync(store, { recursive: true });
  fs.chmodSync(store, 0o500); // writes fail
  try {
    assert.throws(() => protectTokenProfile(profilesDir, 'work', { env }));
  } finally {
    fs.chmodSync(store, 0o700);
  }
  assert.equal(fs.readFileSync(path.join(profilesDir, 'work', 'token.json'), 'utf8'), before);
});

test('unprotect restores token.json and removes the stored secret', () => {
  const profilesDir = mkTmp('u');
  const { env } = fileEnv();
  saveTokenProfile('work', 'tok-xyz', 'acct-2', profilesDir, false);
  protectTokenProfile(profilesDir, 'work', { env });
  const res = unprotectTokenProfile(profilesDir, 'work', { env });
  assert.equal(res.status, 'unprotected');
  assert.equal(res.secretRemoved, true);
  assert.deepEqual(readTokenCredentials(path.join(profilesDir, 'work')), {
    apiToken: 'tok-xyz',
    accountId: 'acct-2',
  });
  const backend = getBackend(env.WRANGLER_ACCOUNTS_SECRET_BACKEND, env);
  assert.throws(() => backend.get(secretAccount(profilesDir, 'work'), env));
});

test('oauth profiles are skipped, not touched', () => {
  const profilesDir = mkTmp('o');
  const { env } = fileEnv();
  const dir = path.join(profilesDir, 'oauth');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.toml'), 'oauth_token = "x"\n');
  assert.equal(protectTokenProfile(profilesDir, 'oauth', { env }).status, 'skipped');
  assert.equal(fs.readFileSync(path.join(dir, 'config.toml'), 'utf8'), 'oauth_token = "x"\n');
});

test('token-add --protect never writes the token to disk', () => {
  const profilesDir = mkTmp('add');
  const { env, store } = fileEnv();
  const res = runCli(['token-add', 'work', 'tok-secret', 'acct-3', '--protect'], {
    ...env,
    WRANGLER_ACCOUNTS_DIR: profilesDir,
  });
  assert.equal(res.status, 0, res.stderr);
  const raw = fs.readFileSync(path.join(profilesDir, 'work', 'token.json'), 'utf8');
  assert.doesNotMatch(raw, /tok-secret/);
  assert.equal(fs.readdirSync(store).length, 1);
});

test('exec hands a protected token to wrangler via env', () => {
  const profilesDir = mkTmp('exec');
  const { env } = fileEnv();
  saveTokenProfile('work', 'tok-exec', 'acct-4', profilesDir, false);
  protectTokenProfile(profilesDir, 'work', { env });
  const shimDir = mkTmp('shim');
  fs.writeFileSync(
    path.join(shimDir, 'wrangler'),
    '#!/bin/sh\necho "token:$CLOUDFLARE_API_TOKEN account:$CLOUDFLARE_ACCOUNT_ID"\n',
    { mode: 0o755 },
  );
  const res = runCli(['--profile', 'work', 'whoami'], {
    ...env,
    PATH: `${shimDir}${path.delimiter}${process.env.PATH}`,
    WRANGLER_ACCOUNTS_DIR: profilesDir,
    CLOUDFLARE_API_TOKEN: '',
  });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /token:tok-exec account:acct-4/);
});

test('exec explains a missing keychain item instead of running without a token', () => {
  const profilesDir = mkTmp('missing');
  const { env, store } = fileEnv();
  saveTokenProfile('work', 'tok-gone', 'acct-5', profilesDir, false);
  protectTokenProfile(profilesDir, 'work', { env });
  for (const f of fs.readdirSync(store)) fs.unlinkSync(path.join(store, f));
  const res = runCli(['--profile', 'work', 'whoami'], { ...env, WRANGLER_ACCOUNTS_DIR: profilesDir });
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /could not be read/);
  assert.match(res.stderr, /token-add work/);
});

test('protect --all / unprotect --all via CLI, and remove cleans the secret', () => {
  const profilesDir = mkTmp('all');
  const { env, store } = fileEnv();
  saveTokenProfile('a', 'tok-a', 'acct-a', profilesDir, false);
  saveTokenProfile('b', 'tok-b', 'acct-b', profilesDir, false);
  const cliEnv = { ...env, WRANGLER_ACCOUNTS_DIR: profilesDir };
  let res = runCli(['protect', '--all', '--json'], cliEnv);
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(JSON.parse(res.stdout).results.map((r) => r.status), ['protected', 'protected']);
  res = runCli(['list', '--json'], cliEnv);
  assert.deepEqual(JSON.parse(res.stdout).map((e) => e.credentialStore), [env.WRANGLER_ACCOUNTS_SECRET_BACKEND, env.WRANGLER_ACCOUNTS_SECRET_BACKEND]);
  removeProfile('a', profilesDir, { env });
  assert.equal(fs.readdirSync(store).length, 1);
  res = runCli(['unprotect', '--all'], cliEnv);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(readTokenCredentials(path.join(profilesDir, 'b')).apiToken, 'tok-b');
  assert.equal(fs.readdirSync(store).length, 0);
});

test('macOS keychain backend round-trip (temporary keychain)', { skip: process.platform !== 'darwin' }, () => {
  const dir = mkTmp('kc');
  const kc = path.join(dir, 'test.keychain-db');
  const mk = spawnSync('security', ['create-keychain', '-p', 'pw', kc]);
  if (mk.status !== 0) return; // no keychain services (e.g. sandboxed CI)
  spawnSync('security', ['unlock-keychain', '-p', 'pw', kc]);
  try {
    const env = { ...process.env, WRANGLER_ACCOUNTS_SECRET_BACKEND: 'keychain', WRANGLER_ACCOUNTS_KEYCHAIN: kc };
    const profilesDir = mkTmp('kcp');
    saveTokenProfile('work', 'tok_KC-1', 'acct-kc', profilesDir, false);
    assert.equal(protectTokenProfile(profilesDir, 'work', { env }).status, 'protected');
    assert.equal(resolveTokenCredentials(path.join(profilesDir, 'work'), env).apiToken, 'tok_KC-1');
    assert.equal(unprotectTokenProfile(profilesDir, 'work', { env }).secretRemoved, true);
    assert.equal(readTokenCredentials(path.join(profilesDir, 'work')).apiToken, 'tok_KC-1');
  } finally {
    spawnSync('security', ['delete-keychain', kc]);
  }
});
