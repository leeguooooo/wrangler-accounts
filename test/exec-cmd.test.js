'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CLI = path.join(__dirname, '..', 'bin', 'wrangler-accounts.js');

function mkStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-exec-cmd-'));
  return dir;
}

function addProfile(dir, name) {
  fs.mkdirSync(path.join(dir, name), { recursive: true });
  fs.writeFileSync(path.join(dir, name, 'config.toml'), 'oauth_token = "x"\n');
}

function run(args, profilesDir, extraEnv = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, WRANGLER_ACCOUNTS_DIR: profilesDir, ...extraEnv },
  });
}

test('exec without profile exits non-zero', () => {
  const dir = mkStore();
  const r = run(['exec'], dir);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Missing profile name/);
});

test('exec <ghost> errors when profile does not exist', () => {
  const dir = mkStore();
  const r = run(['exec', 'ghost'], dir);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /Profile not found|ghost/);
});

test('exec work -- sh -c "echo $WRANGLER_PROFILE" prints work', () => {
  const dir = mkStore();
  addProfile(dir, 'work');
  const r = run(['exec', 'work', '--', 'sh', '-c', 'echo $WRANGLER_PROFILE'], dir);
  assert.equal(r.status, 0, `stderr=${r.stderr}`);
  assert.match(r.stdout, /work/);
});

test('exec work -- sh -c "echo $HOME" prints a path that is not real HOME', () => {
  const dir = mkStore();
  addProfile(dir, 'work');
  const r = run(['exec', 'work', '--', 'sh', '-c', 'echo $HOME'], dir);
  assert.equal(r.status, 0, `stderr=${r.stderr}`);
  const childHome = r.stdout.trim();
  assert.notEqual(childHome, process.env.HOME);
  assert.ok(childHome.startsWith(os.tmpdir()));
});

test('exec work -- false forwards exit code', () => {
  const dir = mkStore();
  addProfile(dir, 'work');
  const r = run(['exec', 'work', '--', 'false'], dir);
  assert.equal(r.status, 1);
});

test('exec work -- sh -c "exit 42" forwards exit code', () => {
  const dir = mkStore();
  addProfile(dir, 'work');
  const r = run(['exec', 'work', '--', 'sh', '-c', 'exit 42'], dir);
  assert.equal(r.status, 42);
});

test('exec work (no --) defaults to $SHELL -i', () => {
  const dir = mkStore();
  addProfile(dir, 'work');
  // Use a known-safe `true`-like path for SHELL so we don't open an
  // actual interactive terminal during tests.
  const trueBin = ['/usr/bin/true', '/bin/true'].find((p) => fs.existsSync(p));
  assert.ok(trueBin, 'no true binary found on this system');
  const r = run(['exec', 'work'], dir, { SHELL: trueBin });
  assert.equal(r.status, 0, `stderr=${r.stderr}`);
});

test('exec work -- (with no command after) errors', () => {
  const dir = mkStore();
  addProfile(dir, 'work');
  const r = run(['exec', 'work', '--'], dir);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /No command given/);
});
