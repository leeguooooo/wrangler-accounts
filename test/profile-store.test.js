'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const store = require('../lib/profile-store');

function mkTmp(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `wa-store-${name}-`));
}

function makeCfg(dir, name = 'default.toml', content = 'oauth_token = "test"\n') {
  const p = path.join(dir, name);
  fs.writeFileSync(p, content);
  return p;
}

test('isValidName accepts letters, numbers, dot, underscore, dash', () => {
  assert.equal(store.isValidName('abc_1.2-3'), true);
  assert.equal(store.isValidName('WORK'), true);
  assert.equal(store.isValidName('a'), true);
});

test('isValidName rejects spaces and special chars', () => {
  assert.equal(store.isValidName('bad name'), false);
  assert.equal(store.isValidName('bad!'), false);
  assert.equal(store.isValidName(''), false);
  assert.equal(store.isValidName('bad/slash'), false);
});

test('isBackupName detects __backup- prefix', () => {
  assert.equal(store.isBackupName('__backup-20260410-120000'), true);
  assert.equal(store.isBackupName('work'), false);
});

test('listProfiles on empty dir returns []', () => {
  const dir = mkTmp('list-empty');
  assert.deepEqual(store.listProfiles(dir), []);
});

test('listProfiles on missing dir returns []', () => {
  assert.deepEqual(store.listProfiles('/nonexistent-path-abc123'), []);
});

test('listProfiles excludes backup dirs by default', () => {
  const dir = mkTmp('list-excl-bk');
  fs.mkdirSync(path.join(dir, 'work'));
  fs.writeFileSync(path.join(dir, 'work', 'config.toml'), '');
  fs.mkdirSync(path.join(dir, '__backup-20260410-120000'));
  fs.writeFileSync(path.join(dir, '__backup-20260410-120000', 'config.toml'), '');
  assert.deepEqual(store.listProfiles(dir), ['work']);
});

test('listProfiles includes backups when requested', () => {
  const dir = mkTmp('list-incl-bk');
  fs.mkdirSync(path.join(dir, 'work'));
  fs.writeFileSync(path.join(dir, 'work', 'config.toml'), '');
  fs.mkdirSync(path.join(dir, '__backup-20260410-120000'));
  fs.writeFileSync(path.join(dir, '__backup-20260410-120000', 'config.toml'), '');
  assert.deepEqual(
    store.listProfiles(dir, { includeBackups: true }).sort(),
    ['__backup-20260410-120000', 'work'],
  );
});

test('listProfiles skips directories without config.toml', () => {
  const dir = mkTmp('list-skip');
  fs.mkdirSync(path.join(dir, 'empty'));
  fs.mkdirSync(path.join(dir, 'good'));
  fs.writeFileSync(path.join(dir, 'good', 'config.toml'), '');
  assert.deepEqual(store.listProfiles(dir), ['good']);
});

test('saveProfile creates config.toml and meta.json', () => {
  const profilesDir = mkTmp('save');
  const cfgDir = mkTmp('save-src');
  const src = makeCfg(cfgDir);

  store.saveProfile('work', src, profilesDir, false);
  assert.ok(fs.existsSync(path.join(profilesDir, 'work', 'config.toml')));
  assert.ok(fs.existsSync(path.join(profilesDir, 'work', 'meta.json')));
  const meta = JSON.parse(fs.readFileSync(path.join(profilesDir, 'work', 'meta.json'), 'utf8'));
  assert.equal(meta.name, 'work');
  assert.ok(meta.savedAt);
  assert.ok(meta.sha256);
  assert.ok(meta.bytes > 0);
});

test('saveProfile throws when target exists and force is false', () => {
  const profilesDir = mkTmp('save-noforce');
  const cfgDir = mkTmp('save-noforce-src');
  const src = makeCfg(cfgDir);
  store.saveProfile('work', src, profilesDir, false);
  assert.throws(() => store.saveProfile('work', src, profilesDir, false), /Profile exists/);
});

test('saveProfile overwrites when force is true', () => {
  const profilesDir = mkTmp('save-force');
  const cfgDir = mkTmp('save-force-src');
  const src = makeCfg(cfgDir, 'default.toml', 'oauth_token = "first"\n');
  store.saveProfile('work', src, profilesDir, false);
  fs.writeFileSync(src, 'oauth_token = "second"\n');
  store.saveProfile('work', src, profilesDir, true);
  const content = fs.readFileSync(path.join(profilesDir, 'work', 'config.toml'), 'utf8');
  assert.match(content, /second/);
});

test('saveProfile throws on invalid name', () => {
  const profilesDir = mkTmp('save-invalid');
  const cfgDir = mkTmp('save-invalid-src');
  const src = makeCfg(cfgDir);
  assert.throws(() => store.saveProfile('bad name!', src, profilesDir, false), /Invalid profile name/);
});

test('saveProfile throws when config file missing', () => {
  const profilesDir = mkTmp('save-missing');
  assert.throws(
    () => store.saveProfile('work', '/nonexistent/cfg.toml', profilesDir, false),
    /Config file not found/,
  );
});

test('readMeta returns parsed JSON for existing meta', () => {
  const profilesDir = mkTmp('meta-read');
  const cfgDir = mkTmp('meta-read-src');
  const src = makeCfg(cfgDir);
  store.saveProfile('work', src, profilesDir, false);
  const meta = store.readMeta(path.join(profilesDir, 'work'));
  assert.equal(meta.name, 'work');
});

test('readMeta returns null for missing file', () => {
  const profilesDir = mkTmp('meta-missing');
  fs.mkdirSync(path.join(profilesDir, 'x'), { recursive: true });
  assert.equal(store.readMeta(path.join(profilesDir, 'x')), null);
});

test('readMeta returns null for corrupt JSON', () => {
  const profilesDir = mkTmp('meta-corrupt');
  const p = path.join(profilesDir, 'x');
  fs.mkdirSync(p, { recursive: true });
  fs.writeFileSync(path.join(p, 'meta.json'), 'not json{');
  assert.equal(store.readMeta(p), null);
});

test('readSessionState returns expired=false for future expiration', () => {
  const dir = mkTmp('session-future');
  const p = path.join(dir, 'default.toml');
  fs.writeFileSync(p, 'expiration_time = "2099-01-01T00:00:00.000Z"\n');
  const s = store.readSessionState(p);
  assert.equal(s.expirationTime, '2099-01-01T00:00:00.000Z');
  assert.equal(s.expired, false);
  assert.equal(s.effective, 'valid');
});

test('readSessionState returns expired=true for past expiration', () => {
  const dir = mkTmp('session-past');
  const p = path.join(dir, 'default.toml');
  fs.writeFileSync(p, 'expiration_time = "2000-01-01T00:00:00.000Z"\n');
  const s = store.readSessionState(p);
  assert.equal(s.expired, true);
});

test('readSessionState returns nulls + effective=unknown for config without expiration', () => {
  const dir = mkTmp('session-none');
  const p = path.join(dir, 'default.toml');
  fs.writeFileSync(p, 'oauth_token = "x"\n');
  const s = store.readSessionState(p);
  assert.equal(s.expirationTime, null);
  assert.equal(s.expired, null);
  assert.equal(s.hasRefreshToken, false);
  assert.equal(s.effective, 'unknown');
});

test('readSessionState detects hasRefreshToken presence', () => {
  const dir = mkTmp('session-with-refresh');
  const p = path.join(dir, 'default.toml');
  fs.writeFileSync(
    p,
    [
      'oauth_token = "x"',
      'expiration_time = "2099-01-01T00:00:00.000Z"',
      'refresh_token = "r"',
    ].join('\n'),
  );
  const s = store.readSessionState(p);
  assert.equal(s.hasRefreshToken, true);
  assert.equal(s.effective, 'valid');
});

test('readSessionState effective=refreshable when access expired but refresh_token present', () => {
  const dir = mkTmp('session-refreshable');
  const p = path.join(dir, 'default.toml');
  fs.writeFileSync(
    p,
    [
      'oauth_token = "expired"',
      'expiration_time = "2000-01-01T00:00:00.000Z"',
      'refresh_token = "still-valid"',
    ].join('\n'),
  );
  const s = store.readSessionState(p);
  assert.equal(s.expired, true);
  assert.equal(s.hasRefreshToken, true);
  assert.equal(s.effective, 'refreshable');
});

test('readSessionState effective=expired when access expired and no refresh_token', () => {
  const dir = mkTmp('session-truly-expired');
  const p = path.join(dir, 'default.toml');
  fs.writeFileSync(
    p,
    [
      'oauth_token = "expired"',
      'expiration_time = "2000-01-01T00:00:00.000Z"',
    ].join('\n'),
  );
  const s = store.readSessionState(p);
  assert.equal(s.expired, true);
  assert.equal(s.hasRefreshToken, false);
  assert.equal(s.effective, 'expired');
});

test('findMatchingProfile finds by hash', () => {
  const profilesDir = mkTmp('match');
  const cfgDir = mkTmp('match-src');
  const src = makeCfg(cfgDir, 'default.toml', 'oauth_token = "same"\n');
  store.saveProfile('work', src, profilesDir, false);
  assert.equal(store.findMatchingProfile(profilesDir, src), 'work');
});

test('findMatchingProfile returns null when nothing matches', () => {
  const profilesDir = mkTmp('match-none');
  const cfgDir = mkTmp('match-none-src');
  const src = makeCfg(cfgDir, 'default.toml', 'oauth_token = "different"\n');
  store.saveProfile('work', makeCfg(mkTmp('match-none-work'), 'default.toml', 'other\n'), profilesDir, false);
  assert.equal(store.findMatchingProfile(profilesDir, src), null);
});

test('removeProfile removes the dir', () => {
  const profilesDir = mkTmp('remove');
  const cfgDir = mkTmp('remove-src');
  const src = makeCfg(cfgDir);
  store.saveProfile('work', src, profilesDir, false);
  store.removeProfile('work', profilesDir);
  assert.equal(fs.existsSync(path.join(profilesDir, 'work')), false);
});

test('removeProfile throws when profile missing', () => {
  const profilesDir = mkTmp('remove-missing');
  assert.throws(() => store.removeProfile('ghost', profilesDir), /Profile not found/);
});

test('removeProfile clears active file when active profile removed', () => {
  const profilesDir = mkTmp('remove-active');
  const cfgDir = mkTmp('remove-active-src');
  const src = makeCfg(cfgDir);
  store.saveProfile('work', src, profilesDir, false);
  store.setActiveProfile(profilesDir, 'work');
  assert.equal(store.getActiveProfile(profilesDir), 'work');
  store.removeProfile('work', profilesDir);
  assert.equal(store.getActiveProfile(profilesDir), null);
});

test('setActiveProfile and getActiveProfile round-trip', () => {
  const dir = mkTmp('active');
  store.setActiveProfile(dir, 'work');
  assert.equal(store.getActiveProfile(dir), 'work');
});

test('getActiveProfile returns null when file missing', () => {
  const dir = mkTmp('active-missing');
  assert.equal(store.getActiveProfile(dir), null);
});

test('getDefaultProfile returns null when no default file', () => {
  const dir = mkTmp('default-missing');
  assert.equal(store.getDefaultProfile(dir), null);
});

test('setDefaultProfile writes to profilesDir/default and getDefaultProfile reads it', () => {
  const dir = mkTmp('default-set');
  store.setDefaultProfile(dir, 'work');
  assert.equal(fs.readFileSync(path.join(dir, 'default'), 'utf8').trim(), 'work');
  assert.equal(store.getDefaultProfile(dir), 'work');
});

test('unsetDefaultProfile removes the default file', () => {
  const dir = mkTmp('default-unset');
  store.setDefaultProfile(dir, 'work');
  store.unsetDefaultProfile(dir);
  assert.equal(store.getDefaultProfile(dir), null);
});

test('unsetDefaultProfile is idempotent when no default set', () => {
  const dir = mkTmp('default-unset-idem');
  fs.mkdirSync(dir, { recursive: true });
  store.unsetDefaultProfile(dir);  // should not throw
  assert.equal(store.getDefaultProfile(dir), null);
});
