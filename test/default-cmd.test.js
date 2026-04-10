'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CLI = path.join(__dirname, '..', 'bin', 'wrangler-accounts.js');

function mkStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-default-cmd-'));
  return dir;
}

function addProfile(dir, name) {
  fs.mkdirSync(path.join(dir, name), { recursive: true });
  fs.writeFileSync(path.join(dir, name, 'config.toml'), 'oauth_token = "x"\n');
}

function run(args, profilesDir) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, WRANGLER_ACCOUNTS_DIR: profilesDir },
  });
}

test('default with no default set prints "(no default set)" and exits 1', () => {
  const dir = mkStore();
  const r = run(['default'], dir);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /no default set/);
});

test('default <name> sets the default profile', () => {
  const dir = mkStore();
  addProfile(dir, 'work');
  const r = run(['default', 'work'], dir);
  assert.equal(r.status, 0, `stderr=${r.stderr}`);
  assert.equal(fs.readFileSync(path.join(dir, 'default'), 'utf8').trim(), 'work');
  assert.match(r.stdout, /Default profile set to 'work'/);
});

test('default (no args) prints the current default after setting', () => {
  const dir = mkStore();
  addProfile(dir, 'work');
  run(['default', 'work'], dir);
  const r = run(['default'], dir);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /work/);
});

test('default --json emits structured output', () => {
  const dir = mkStore();
  addProfile(dir, 'work');
  run(['default', 'work'], dir);
  const r = run(['default', '--json'], dir);
  assert.equal(r.status, 0);
  const payload = JSON.parse(r.stdout);
  assert.equal(payload.command, 'default');
  assert.equal(payload.name, 'work');
});

test('default <ghost> errors when profile does not exist', () => {
  const dir = mkStore();
  const r = run(['default', 'ghost'], dir);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Profile not found/);
});

test('default --unset clears the default file', () => {
  const dir = mkStore();
  addProfile(dir, 'work');
  run(['default', 'work'], dir);
  const r = run(['default', '--unset'], dir);
  assert.equal(r.status, 0);
  assert.equal(fs.existsSync(path.join(dir, 'default')), false);
});

test('default --unset is idempotent when no default set', () => {
  const dir = mkStore();
  const r = run(['default', '--unset'], dir);
  assert.equal(r.status, 0);
});

test('default <bad name!> rejects invalid names', () => {
  const dir = mkStore();
  const r = run(['default', 'bad name!'], dir);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Invalid profile name/);
});
