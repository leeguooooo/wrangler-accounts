'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  listProfiles,
  getProfileType,
  saveTokenProfile,
  readTokenCredentials,
  readTokenSessionState,
} = require('../lib/profile-store');
const {
  createShadowHome,
  cleanupShadow,
  buildIsolatedEnv,
} = require('../lib/isolation');

const CLI = path.join(__dirname, '..', 'bin', 'wrangler-accounts.js');

function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `wa-token-${prefix}-`));
}

function mkRealHome() {
  const home = mkTmp('home');
  fs.writeFileSync(path.join(home, '.npmrc'), 'registry=https://example.com\n');
  return home;
}

function mkWranglerShim(script) {
  const dir = mkTmp('shim');
  const shim = path.join(dir, 'wrangler');
  fs.writeFileSync(shim, script, { mode: 0o755 });
  return { dir, shim };
}

test('saveTokenProfile creates token.json with 0o600 and meta.json', () => {
  const profilesDir = mkTmp('store');

  saveTokenProfile('work', 'CF_TOKEN_HERE', 'ACCOUNT_ID_HERE', profilesDir, false);

  const profileDir = path.join(profilesDir, 'work');
  const tokenPath = path.join(profileDir, 'token.json');
  const metaPath = path.join(profileDir, 'meta.json');
  const token = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));

  assert.deepEqual(token, {
    apiToken: 'CF_TOKEN_HERE',
    accountId: 'ACCOUNT_ID_HERE',
  });
  assert.equal(fs.statSync(tokenPath).mode & 0o777, 0o600);
  assert.equal(meta.name, 'work');
  assert.equal(meta.type, 'token');
  assert.equal(meta.accountId, 'ACCOUNT_ID_HERE');
  assert.ok(meta.savedAt);
});

test('listProfiles includes token profiles and getProfileType distinguishes token vs oauth', () => {
  const profilesDir = mkTmp('types');

  saveTokenProfile('token-work', 'token-123', 'acct-123', profilesDir, false);

  const oauthDir = path.join(profilesDir, 'oauth-work');
  fs.mkdirSync(oauthDir, { recursive: true });
  fs.writeFileSync(path.join(oauthDir, 'config.toml'), 'oauth_token = "x"\n');

  assert.deepEqual(listProfiles(profilesDir), ['oauth-work', 'token-work']);
  assert.equal(getProfileType(path.join(profilesDir, 'token-work')), 'token');
  assert.equal(getProfileType(path.join(profilesDir, 'oauth-work')), 'oauth');
  assert.equal(getProfileType(path.join(profilesDir, 'missing')), null);
});

test('readTokenCredentials reads token credentials and readTokenSessionState reports token mode', () => {
  const profilesDir = mkTmp('read');

  saveTokenProfile('work', 'token-abc', 'acct-abc', profilesDir, false);

  assert.deepEqual(
    readTokenCredentials(path.join(profilesDir, 'work')),
    { apiToken: 'token-abc', accountId: 'acct-abc' },
  );
  assert.deepEqual(readTokenSessionState(), {
    expirationTime: null,
    expired: null,
    hasRefreshToken: false,
    effective: 'token',
  });
});

test('createShadowHome with null profileCfg writes empty default.toml', () => {
  const realHome = mkRealHome();
  const shadow = createShadowHome({ realHome, profileCfg: null, label: 'wa-token-null' });

  try {
    const defaultToml = path.join(shadow, '.wrangler', 'config', 'default.toml');
    assert.equal(fs.lstatSync(defaultToml).isSymbolicLink(), false);
    assert.equal(fs.readFileSync(defaultToml, 'utf8'), '');
  } finally {
    cleanupShadow(shadow);
  }
});

test('buildIsolatedEnv injects API token and account id', () => {
  const env = buildIsolatedEnv({
    shadow: '/tmp/fake-shadow',
    realHome: '/Users/fake',
    profile: 'work',
    baseEnv: {},
    apiToken: 'tok-123',
    accountId: 'acct-123',
  });

  assert.equal(env.CLOUDFLARE_API_TOKEN, 'tok-123');
  assert.equal(env.CLOUDFLARE_ACCOUNT_ID, 'acct-123');
});

test('token-add CLI command creates a token profile', () => {
  const profilesDir = mkTmp('token-add');
  const result = spawnSync(
    process.execPath,
    [CLI, 'token-add', 'work', 'tok-cli', 'acct-cli'],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        WRANGLER_ACCOUNTS_DIR: profilesDir,
      },
    },
  );

  assert.equal(result.status, 0, `stderr=${result.stderr}`);
  assert.match(result.stdout, /Saved token profile 'work'/);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(profilesDir, 'work', 'token.json'), 'utf8')),
    { apiToken: 'tok-cli', accountId: 'acct-cli' },
  );
});

test('whoami falls back to anonymous token mode when CLOUDFLARE_API_TOKEN is set', () => {
  const profilesDir = mkTmp('anon');
  const { dir: shimDir } = mkWranglerShim(`#!/bin/sh
echo "token:$CLOUDFLARE_API_TOKEN account:$CLOUDFLARE_ACCOUNT_ID"
`);

  const result = spawnSync(
    process.execPath,
    [CLI, 'whoami'],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${shimDir}${path.delimiter}${process.env.PATH || ''}`,
        WRANGLER_ACCOUNTS_DIR: profilesDir,
        CLOUDFLARE_API_TOKEN: 'anon-token',
        CLOUDFLARE_ACCOUNT_ID: 'anon-account',
        WRANGLER_PROFILE: '',
      },
    },
    );

  assert.equal(result.status, 0, `stderr=${result.stderr}`);
  assert.match(result.stdout, /token:anon-token account:anon-account/);
});
