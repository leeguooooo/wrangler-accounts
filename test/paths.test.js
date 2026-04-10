'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const {
  expandHome,
  resolvePath,
  detectConfigPath,
  detectProfilesDir,
} = require('../lib/paths');

test('expandHome("~") returns homedir', () => {
  assert.equal(expandHome('~'), os.homedir());
});

test('expandHome("~/foo") joins home with foo', () => {
  assert.equal(expandHome('~/foo'), path.join(os.homedir(), 'foo'));
});

test('expandHome("/abs") returns unchanged', () => {
  assert.equal(expandHome('/abs'), '/abs');
});

test('expandHome("rel") returns unchanged', () => {
  assert.equal(expandHome('rel'), 'rel');
});

test('expandHome(null/undefined/"") returns the input', () => {
  assert.equal(expandHome(null), null);
  assert.equal(expandHome(undefined), undefined);
  assert.equal(expandHome(''), '');
});

test('resolvePath expands "~" and resolves to absolute', () => {
  const result = resolvePath('~/x');
  assert.equal(path.isAbsolute(result), true);
  assert.ok(result.endsWith('/x') || result.endsWith('\\x'));
});

test('detectConfigPath honors explicit cliPath', () => {
  assert.equal(detectConfigPath('/explicit/path.toml', {}), '/explicit/path.toml');
});

test('detectConfigPath reads WRANGLER_CONFIG_PATH from injected env', () => {
  assert.equal(
    detectConfigPath(undefined, { WRANGLER_CONFIG_PATH: '/env/path.toml' }),
    '/env/path.toml',
  );
});

test('detectConfigPath falls back to candidate list when env unset', () => {
  // When nothing is provided, it should return a path under home or the first candidate.
  const result = detectConfigPath(undefined, {});
  assert.ok(result.includes('.wrangler') || result.includes('wrangler'));
  assert.equal(path.isAbsolute(result), true);
});

test('detectProfilesDir honors explicit cliPath', () => {
  assert.equal(detectProfilesDir('/explicit/dir', {}), '/explicit/dir');
});

test('detectProfilesDir reads WRANGLER_ACCOUNTS_DIR from injected env', () => {
  assert.equal(
    detectProfilesDir(undefined, { WRANGLER_ACCOUNTS_DIR: '/env/dir' }),
    '/env/dir',
  );
});

test('detectProfilesDir uses XDG_CONFIG_HOME when provided', () => {
  const result = detectProfilesDir(undefined, { XDG_CONFIG_HOME: '/xdg' });
  assert.equal(result, path.join('/xdg', 'wrangler-accounts'));
});

test('detectProfilesDir default falls back to ~/.config/wrangler-accounts', () => {
  const result = detectProfilesDir(undefined, {});
  assert.equal(result, path.join(os.homedir(), '.config', 'wrangler-accounts'));
});
