'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const shimLib = require('../lib/shim');

function writeExecutable(file, content) {
  fs.writeFileSync(file, content);
  fs.chmodSync(file, 0o755);
}

// Build an isolated environment:
//   shimDir/wrangler            -> the real shim under test
//   realDir/wrangler            -> a fake "real" wrangler that prints a marker
//   waDir/wrangler-accounts     -> a fake wrangler-accounts (list --plain / default)
// PATH order: shimDir : realDir : waDir
function setup({ profiles = 'work', defaultProfile = 'work' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-shim-'));
  const shimDir = path.join(root, 'shims');
  const realDir = path.join(root, 'real');
  const waDir = path.join(root, 'wa');
  fs.mkdirSync(shimDir);
  fs.mkdirSync(realDir);
  fs.mkdirSync(waDir);

  shimLib.installShim({ shimDir });

  writeExecutable(
    path.join(realDir, 'wrangler'),
    '#!/bin/sh\necho "REAL_WRANGLER $*"\nexit 0\n',
  );

  writeExecutable(
    path.join(waDir, 'wrangler-accounts'),
    [
      '#!/bin/sh',
      'if [ "$1" = "list" ] && [ "$2" = "--plain" ]; then',
      '  [ -n "$WA_TEST_PROFILES" ] && printf "%s\\n" "$WA_TEST_PROFILES"',
      '  exit 0',
      'fi',
      'if [ "$1" = "default" ]; then',
      '  [ -n "$WA_TEST_DEFAULT" ] && printf "%s\\n" "$WA_TEST_DEFAULT"',
      '  exit 0',
      'fi',
      'exit 0',
      '',
    ].join('\n'),
  );

  const PATH = [shimDir, realDir, waDir].join(path.delimiter);
  return { root, shimDir, realDir, waDir, PATH, profiles, defaultProfile };
}

function runShim(ctx, args, extraEnv = {}) {
  return spawnSync(path.join(ctx.shimDir, 'wrangler'), args, {
    encoding: 'utf8',
    env: {
      PATH: ctx.PATH,
      WA_TEST_PROFILES: ctx.profiles,
      WA_TEST_DEFAULT: ctx.defaultProfile,
      ...extraEnv,
    },
  });
}

test('shim blocks bare wrangler when profiles exist', () => {
  const ctx = setup();
  const r = runShim(ctx, ['deploy']);
  assert.equal(r.status, 1, `stdout=${r.stdout}\nstderr=${r.stderr}`);
  assert.match(r.stderr, /direct `wrangler` is blocked/);
  assert.match(r.stderr, /- work/);
  assert.doesNotMatch(r.stdout, /REAL_WRANGLER/);
});

test('shim passes through with WA_PASSTHROUGH=1 (and does not recurse)', () => {
  const ctx = setup();
  const r = runShim(ctx, ['deploy'], { WA_PASSTHROUGH: '1' });
  assert.equal(r.status, 0, `stderr=${r.stderr}`);
  assert.match(r.stdout, /REAL_WRANGLER deploy/);
});

test('shim honors the legacy NOWRANGLER_ACCOUNTS_GUARD bypass', () => {
  const ctx = setup();
  const r = runShim(ctx, ['deploy'], { NOWRANGLER_ACCOUNTS_GUARD: '1' });
  assert.equal(r.status, 0, `stderr=${r.stderr}`);
  assert.match(r.stdout, /REAL_WRANGLER deploy/);
});

test('shim passes through when no profiles are configured', () => {
  const ctx = setup({ profiles: '' });
  const r = runShim(ctx, ['deploy']);
  assert.equal(r.status, 0, `stderr=${r.stderr}`);
  assert.match(r.stdout, /REAL_WRANGLER deploy/);
});

test('shim passes through account-agnostic commands like --version', () => {
  const ctx = setup();
  const r = runShim(ctx, ['--version']);
  assert.equal(r.status, 0, `stderr=${r.stderr}`);
  assert.match(r.stdout, /REAL_WRANGLER --version/);
});

test('shim passes through when wrangler-accounts is not on PATH', () => {
  const ctx = setup();
  // PATH without the wa dir -> wrangler-accounts missing
  const r = spawnSync(path.join(ctx.shimDir, 'wrangler'), ['deploy'], {
    encoding: 'utf8',
    env: { PATH: [ctx.shimDir, ctx.realDir].join(path.delimiter) },
  });
  assert.equal(r.status, 0, `stderr=${r.stderr}`);
  assert.match(r.stdout, /REAL_WRANGLER deploy/);
});
