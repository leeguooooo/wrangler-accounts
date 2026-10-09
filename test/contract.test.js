'use strict';

// "No feature lost" contract.
//
// Runs every CLI command against a fixed fixture (temp HOME, temp profiles
// dir, fake wrangler on PATH) and compares the normalized result with
// test/fixtures/contract-snapshot.json, which was recorded with v1.8.0 before
// the native-profile work started.
//
// Comparison is a SUBSET match: every key/value that 1.8.0 produced must still
// be produced (same exit code, same JSON fields and values, same text lines),
// but new versions may ADD fields or lines. Re-record only on purpose:
//   WA_CONTRACT_RECORD=1 node --test test/contract.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CLI = path.join(__dirname, '..', 'bin', 'wrangler-accounts.js');
const FAKE_BIN = path.join(__dirname, 'fixtures', 'contract-bin');
const NATIVE_BIN = path.join(__dirname, 'fixtures', 'native-bin');
const SNAPSHOT = path.join(__dirname, 'fixtures', 'contract-snapshot.json');

const OAUTH_TOML = [
  'oauth_token = "oauth-fixture"',
  'refresh_token = "refresh-fixture"',
  'expiration_time = "2099-01-01T00:00:00.000Z"',
  'scopes = ["account:read"]',
  '',
].join('\n');
const EXPIRED_TOML = 'oauth_token = "old"\nexpiration_time = "2000-01-01T00:00:00.000Z"\n';

function setup() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wa-contract-')));
  const home = path.join(root, 'home');
  const profiles = path.join(root, 'profiles');
  const store = path.join(root, 'store');
  fs.mkdirSync(path.join(home, '.wrangler', 'config'), { recursive: true });
  fs.writeFileSync(path.join(home, '.wrangler', 'config', 'default.toml'), OAUTH_TOML);
  fs.writeFileSync(path.join(home, '.npmrc'), 'x=1\n');

  const mk = (name, files) => {
    fs.mkdirSync(path.join(profiles, name), { recursive: true });
    for (const [f, body] of Object.entries(files)) fs.writeFileSync(path.join(profiles, name, f), body);
  };
  const identity = { email: 'test@example.com', accountName: 'Test Account', accountId: '0123456789abcdef0123456789abcdef' };
  mk('work', {
    'config.toml': OAUTH_TOML,
    'meta.json': JSON.stringify({ name: 'work', savedAt: '2026-01-01T00:00:00.000Z', identity, description: 'main account' }),
  });
  mk('stale', { 'config.toml': EXPIRED_TOML });
  mk('ci', {
    'token.json': JSON.stringify({ apiToken: 'tok-ci', accountId: 'acct-ci' }),
    'meta.json': JSON.stringify({ name: 'ci', type: 'token', accountId: 'acct-ci', savedAt: '2026-01-01T00:00:00.000Z' }),
  });
  mk('__backup-20260101-000000', { 'config.toml': OAUTH_TOML });

  const env = {
    PATH: `${FAKE_BIN}${path.delimiter}${process.env.PATH}`,
    HOME: home,
    WRANGLER_ACCOUNTS_DIR: profiles,
    WRANGLER_ACCOUNTS_SECRET_BACKEND: `file:${store}`,
    WRANGLER_ACCOUNTS_SHIM_DIR: path.join(root, 'shims'),
    WA_CONTRACT_REAL_HOME: home,
    // ambient credentials that must never leak into a profile run
    CLOUDFLARE_API_TOKEN: 'leaked-token',
    CLOUDFLARE_ACCOUNT_ID: 'leaked-account',
    SHELL: '/bin/sh',
    TMPDIR: process.env.TMPDIR || os.tmpdir(),
  };
  return { root, home, profiles, env };
}

function normalize(text, ctx) {
  let out = String(text || '');
  out = out.split(ctx.root).join('<ROOT>');
  out = out.split(path.join(__dirname, '..')).join('<REPO>');
  out = out.split(require('../package.json').version).join('<VERSION>');
  const tmp = fs.realpathSync(os.tmpdir());
  out = out.split(tmp).join('<TMP>');
  out = out.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, '<TS>');
  out = out.replace(/<TMP>\/wa-[^"\s/]+/g, '<SHADOW>');
  out = out.replace(/\bin \d+[dhm] \(\d{4}-\d{2}-\d{2}\)/g, 'in <REL>');
  out = out.replace(/\d+[dhm] ago \(\d{4}-\d{2}-\d{2}\)/g, '<REL> ago');
  return out;
}

function parseMaybeJson(s) {
  const t = s.trim();
  if (!t) return null;
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
}

// Each case: [label, args, options]. Cases run in order against ONE fixture,
// so mutating commands come after the read-only ones.
const CASES = [
  ['version', ['--version']],
  ['version-json', ['--version', '--json']],
  ['help', ['--help']],
  ['no-command', []],
  ['list-json', ['list', '--json']],
  ['list-plain', ['list', '--plain']],
  ['list-text', ['list']],
  ['list-backups-json', ['list', '--json', '--include-backups']],
  ['list-deep-json', ['list', '--deep', '--json']],
  ['status-json', ['status', '--json']],
  ['status-text', ['status']],
  ['whoami-work-json', ['whoami', '--profile', 'work', '--json']],
  ['whoami-positional', ['whoami', 'work']],
  ['whoami-token', ['whoami', '--profile', 'ci']],
  ['whoami-missing', ['whoami', '--profile', 'ghost', '--json']],
  ['default-none', ['default']],
  ['default-none-json', ['default', '--json']],
  ['default-set', ['default', 'work', '--json']],
  ['default-get', ['default']],
  ['default-ghost', ['default', 'ghost']],
  ['run-default', ['deploy', '--env', 'prod']],
  ['run-profile-flag', ['--profile', 'ci', 'kv', 'namespace', 'list']],
  ['run-profile-after', ['deploy', '--profile', 'work', '--config', 'x.toml']],
  ['run-positional', ['ci', 'deploy']],
  ['run-ghost', ['--profile', 'ghost', 'deploy']],
  ['run-expired', ['--profile', 'stale', 'deploy']],
  ['exec-env', ['exec', 'work', '--', 'sh', '-c', 'echo "P=$WRANGLER_PROFILE A=$CLOUDFLARE_ACCOUNT_ID T=${CLOUDFLARE_API_TOKEN:-none} PT=$WA_PASSTHROUGH"']],
  ['exec-token-env', ['exec', 'ci', '--', 'sh', '-c', 'echo "P=$WRANGLER_PROFILE A=$CLOUDFLARE_ACCOUNT_ID T=$CLOUDFLARE_API_TOKEN"']],
  ['exec-missing-cmd', ['exec', 'work', '--']],
  ['exec-ghost', ['exec', 'ghost', '--', 'true']],
  ['note-get', ['note', 'work']],
  ['note-set', ['note', 'ci', 'ci token']],
  ['note-get-ci', ['note', 'ci']],
  ['use', ['use', 'work']],
  ['unknown-shim-action', ['shim', 'bogus']],
  ['shim-status-json', ['shim', 'status', '--json']],
  ['gc-json', ['gc', '--json', '--older-than', '9999d']],
  ['login-non-tty', ['login', 'newone']],
  ['token-add', ['token-add', 'ci2', 'tok-2', 'acct-2', '--json']],
  ['token-add-dup', ['token-add', 'ci2', 'tok-3', 'acct-3']],
  ['protect-ci2', ['protect', 'ci2', '--json']],
  ['protect-oauth', ['protect', 'stale', '--json'], { contractOnly: ['exitCode'] }],
  ['list-after-protect', ['list', '--json']],
  ['run-protected-token', ['--profile', 'ci2', 'whoami-not', 'x']],
  ['unprotect-ci2', ['unprotect', 'ci2', '--json']],
  ['protect-all', ['protect', '--all', '--json'], { contractOnly: ['exitCode'] }],
  ['unprotect-all', ['unprotect', '--all', '--json'], { contractOnly: ['exitCode'] }],
  ['save-new', ['save', 'fromdefault', '--json']],
  ['save-dup', ['save', 'fromdefault']],
  ['save-force', ['save', 'fromdefault', '--force', '--json']],
  ['sync-work', ['sync', 'work', '--json']],
  ['sync-default', ['sync-default', '--json']],
  ['sync-active-legacy', ['sync-active', '--json']],
  ['remove-ci2', ['remove', 'ci2', '--json']],
  ['remove-ghost', ['remove', 'ghost']],
  ['default-unset', ['default', '--unset', '--json']],
  ['list-final', ['list', '--json']],
];

function runAll({ nativeMode = false } = {}) {
  const ctx = setup();
  if (nativeMode) {
    // Same fixture, but wrangler supports native profiles and every OAuth
    // profile has been migrated into wrangler's own store first.
    ctx.env.PATH = `${NATIVE_BIN}${path.delimiter}${process.env.PATH}`;
    ctx.env.WA_FAKE_CONTRACT = '1';
    const m = spawnSync(process.execPath, [CLI, 'migrate', '--all', '--no-verify', '--json'], {
      encoding: 'utf8',
      env: ctx.env,
      cwd: ctx.root,
    });
    const migrated = JSON.parse(m.stdout).results.filter((r) => r.status === 'migrated').map((r) => r.name);
    assert.deepEqual(migrated.sort(), ['stale', 'work'], m.stderr);
  }
  const results = {};
  for (const [label, args, opts = {}] of CASES) {
    const started = Date.now();
    const r = spawnSync(process.execPath, [CLI, ...args], {
      encoding: 'utf8',
      env: ctx.env,
      cwd: ctx.root,
      input: '',
    });
    if (process.env.WA_CONTRACT_TIMING) process.stderr.write(`${nativeMode ? 'native' : 'shadow'} ${label} ${Date.now() - started}ms\n`);
    const stdout = normalize(r.stdout, ctx);
    const stderr = normalize(r.stderr, ctx);
    const entry = { exitCode: r.status };
    if (!opts.contractOnly) {
      const json = parseMaybeJson(stdout);
      if (json !== undefined && json !== null) entry.json = json;
      else entry.stdoutLines = stdout.split('\n').filter((l) => l.trim().length);
      const errJson = parseMaybeJson(stderr);
      if (errJson && typeof errJson === 'object') entry.stderrJson = errJson;
      else entry.stderrLines = stderr.split('\n').filter((l) => l.trim().length);
    }
    results[label] = entry;
  }
  fs.rmSync(ctx.root, { recursive: true, force: true });
  return results;
}

// Is `expected` contained in `actual`? Objects: every key must match
// recursively (extra keys in actual are fine). Arrays of lines: every expected
// line must appear in order. Other arrays: same length, element-wise subset.
function subsetDiff(expected, actual, where, diffs, { lines = false } = {}) {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) {
      diffs.push(`${where}: expected array, got ${JSON.stringify(actual)}`);
      return;
    }
    if (lines) {
      let i = 0;
      for (const line of expected) {
        while (i < actual.length && actual[i] !== line) i += 1;
        if (i >= actual.length) {
          diffs.push(`${where}: missing line ${JSON.stringify(line)}`);
          return;
        }
        i += 1;
      }
      return;
    }
    if (expected.length !== actual.length) {
      diffs.push(`${where}: length ${expected.length} != ${actual.length}`);
      return;
    }
    expected.forEach((v, i) => subsetDiff(v, actual[i], `${where}[${i}]`, diffs));
    return;
  }
  if (expected && typeof expected === 'object') {
    if (!actual || typeof actual !== 'object') {
      diffs.push(`${where}: expected object, got ${JSON.stringify(actual)}`);
      return;
    }
    for (const [k, v] of Object.entries(expected)) {
      if (k.startsWith('_')) continue; // annotations such as _note
      if (!(k in actual)) {
        diffs.push(`${where}.${k}: missing`);
        continue;
      }
      subsetDiff(v, actual[k], `${where}.${k}`, diffs, { lines: k === 'stdoutLines' || k === 'stderrLines' });
    }
    return;
  }
  if (expected !== actual) diffs.push(`${where}: ${JSON.stringify(expected)} != ${JSON.stringify(actual)}`);
}

test('every 1.8.0 command result is still produced (subset contract)', () => {
  const results = runAll();
  if (process.env.WA_CONTRACT_RECORD === '1') {
    fs.writeFileSync(SNAPSHOT, `${JSON.stringify(results, null, 2)}\n`);
    return;
  }
  const snapshot = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8'));
  const diffs = [];
  for (const [label, expected] of Object.entries(snapshot)) {
    if (!(label in results)) {
      diffs.push(`${label}: case no longer runs`);
      continue;
    }
    subsetDiff(expected, results[label], label, diffs);
  }
  assert.deepEqual(diffs, [], `contract drift:\n${diffs.join('\n')}`);
});

// Differences that are the point of the native backend (documented in
// docs/superpowers/specs/2026-10-09-native-profiles-design.md). Anything else
// that drifts for migrated profiles fails the test.
const NATIVE_ALLOWED = [
  // native runs keep the real HOME (wrangler finds the profile via --profile)
  /^run-(default|profile-after)\.json\.homeIsReal: false != true$/,
  // the list/status text marks native profiles: "[oauth]" -> "[oauth, native]"
  // (which also widens the NAME column of the table header)
  /^(list-text|status-text|list-final|list-after-protect)\b.*\[oauth\]/,
  /^list-text\.stdoutLines: missing line "  NAME +STATUS/,
  // the fixture's fake wrangler lives in another directory
  /^shim-status-json\.json\.realWrangler: /,
  // sync into a native profile keeps the profile note (1.8.0 shadow sync drops it)
  /^list-final\.json\[\d\]\.description: null != "main account"$/,
  // `protect stale` now really encrypts the (migrated) OAuth profile
  /^(list-after-protect|list-final)\.json\[\d\]\.(status|credentialStore|expirationTime|hasRefreshToken): /,
  // credentials in wrangler's store: stale's expired session lives in the
  // native file; deep check / expired guard behave as for shadow (exit 3)
];

test('native backend: the same commands still work for migrated OAuth profiles', () => {
  const results = runAll({ nativeMode: true });
  const snapshot = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8'));
  const diffs = [];
  for (const [label, expected] of Object.entries(snapshot)) {
    if (!(label in results)) {
      diffs.push(`${label}: case no longer runs`);
      continue;
    }
    subsetDiff(expected, results[label], label, diffs);
  }
  const unexpected = diffs.filter((d) => !NATIVE_ALLOWED.some((re) => re.test(d)));
  assert.deepEqual(unexpected, [], `native contract drift:\n${unexpected.join('\n')}`);
});
