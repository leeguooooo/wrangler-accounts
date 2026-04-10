'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { resolveProfile, ResolveError } = require('../lib/resolve');

function mkStore() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wa-resolve-'));
}

function addProfile(dir, name) {
  fs.mkdirSync(path.join(dir, name), { recursive: true });
  fs.writeFileSync(path.join(dir, name, 'config.toml'), '');
}

const MANAGEMENT = new Set([
  'list', 'status', 'save', 'sync', 'sync-active', 'sync-default',
  'login', 'remove', 'default', 'whoami', 'gc', 'use', 'exec',
]);

test('explicit --profile wins over everything else', () => {
  const dir = mkStore();
  addProfile(dir, 'work');
  addProfile(dir, 'personal');
  fs.writeFileSync(path.join(dir, 'default'), 'personal\n');
  const r = resolveProfile({
    cliProfile: 'work',
    positional: null,
    env: { WRANGLER_PROFILE: 'personal' },
    profilesDir: dir,
    managementSubcommands: MANAGEMENT,
  });
  assert.deepEqual(r, { name: 'work', source: 'cli' });
});

test('positional shorthand resolves when it matches a profile', () => {
  const dir = mkStore();
  addProfile(dir, 'work');
  const r = resolveProfile({
    cliProfile: null,
    positional: 'work',
    env: {},
    profilesDir: dir,
    managementSubcommands: MANAGEMENT,
  });
  assert.deepEqual(r, { name: 'work', source: 'positional' });
});

test('positional that matches a management subcommand is ignored', () => {
  const dir = mkStore();
  // profile named `list` exists on disk, but management interpretation wins
  addProfile(dir, 'list');
  assert.throws(
    () =>
      resolveProfile({
        cliProfile: null,
        positional: 'list',
        env: {},
        profilesDir: dir,
        managementSubcommands: MANAGEMENT,
      }),
    (err) => err instanceof ResolveError && err.code === 'NO_PROFILE',
  );
});

test('positional that does not match any profile falls through to env', () => {
  const dir = mkStore();
  addProfile(dir, 'work');
  const r = resolveProfile({
    cliProfile: null,
    positional: 'deploy',   // wrangler subcommand, not a profile
    env: { WRANGLER_PROFILE: 'work' },
    profilesDir: dir,
    managementSubcommands: MANAGEMENT,
  });
  assert.deepEqual(r, { name: 'work', source: 'env' });
});

test('WRANGLER_PROFILE is used when no CLI arg and no positional match', () => {
  const dir = mkStore();
  addProfile(dir, 'work');
  const r = resolveProfile({
    cliProfile: null,
    positional: null,
    env: { WRANGLER_PROFILE: 'work' },
    profilesDir: dir,
    managementSubcommands: MANAGEMENT,
  });
  assert.deepEqual(r, { name: 'work', source: 'env' });
});

test('profilesDir/default is used when no CLI and no env', () => {
  const dir = mkStore();
  addProfile(dir, 'work');
  fs.writeFileSync(path.join(dir, 'default'), 'work\n');
  const r = resolveProfile({
    cliProfile: null,
    positional: null,
    env: {},
    profilesDir: dir,
    managementSubcommands: MANAGEMENT,
  });
  assert.deepEqual(r, { name: 'work', source: 'default' });
});

test('missing profile throws ResolveError with NO_PROFILE code and actionable hint', () => {
  const dir = mkStore();
  try {
    resolveProfile({
      cliProfile: null,
      positional: null,
      env: {},
      profilesDir: dir,
      managementSubcommands: MANAGEMENT,
    });
    assert.fail('expected throw');
  } catch (err) {
    assert.ok(err instanceof ResolveError);
    assert.equal(err.code, 'NO_PROFILE');
    assert.match(err.message, /--profile/);
    assert.match(err.message, /WRANGLER_PROFILE/);
    assert.match(err.message, /default/);
  }
});

test('explicitly named profile that does not exist throws PROFILE_NOT_FOUND', () => {
  const dir = mkStore();
  try {
    resolveProfile({
      cliProfile: 'ghost',
      positional: null,
      env: {},
      profilesDir: dir,
      managementSubcommands: MANAGEMENT,
    });
    assert.fail('expected throw');
  } catch (err) {
    assert.ok(err instanceof ResolveError);
    assert.equal(err.code, 'PROFILE_NOT_FOUND');
    assert.match(err.message, /ghost/);
  }
});

test('invalid profile name throws INVALID_NAME', () => {
  const dir = mkStore();
  try {
    resolveProfile({
      cliProfile: 'bad name!',
      positional: null,
      env: {},
      profilesDir: dir,
      managementSubcommands: MANAGEMENT,
    });
    assert.fail('expected throw');
  } catch (err) {
    assert.ok(err instanceof ResolveError);
    assert.equal(err.code, 'INVALID_NAME');
  }
});

test('env WRANGLER_PROFILE pointing at non-existent profile throws', () => {
  const dir = mkStore();
  try {
    resolveProfile({
      cliProfile: null,
      positional: null,
      env: { WRANGLER_PROFILE: 'ghost' },
      profilesDir: dir,
      managementSubcommands: MANAGEMENT,
    });
    assert.fail('expected throw');
  } catch (err) {
    assert.equal(err.code, 'PROFILE_NOT_FOUND');
  }
});

test('default file pointing at non-existent profile throws', () => {
  const dir = mkStore();
  fs.writeFileSync(path.join(dir, 'default'), 'ghost\n');
  assert.throws(
    () =>
      resolveProfile({
        cliProfile: null,
        positional: null,
        env: {},
        profilesDir: dir,
        managementSubcommands: MANAGEMENT,
      }),
    (err) => err.code === 'PROFILE_NOT_FOUND',
  );
});
