'use strict';

// Unit-level tests for the parseArgs function in bin/wrangler-accounts.js.
// Loaded via a child process because parseArgs is not exported.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const CLI = path.join(__dirname, '..', 'bin', 'wrangler-accounts.js');
const FIXTURE = path.join(__dirname, 'fixtures', 'fake-wrangler.sh');

function setupShimAndProfiles() {
  const shim = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-parse-shim-'));
  fs.copyFileSync(FIXTURE, path.join(shim, 'wrangler'));
  fs.chmodSync(path.join(shim, 'wrangler'), 0o755);

  const profilesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-parse-pdir-'));
  fs.mkdirSync(path.join(profilesDir, 'work'));
  fs.writeFileSync(path.join(profilesDir, 'work', 'config.toml'), 'oauth_token = "w"\n');
  fs.mkdirSync(path.join(profilesDir, 'personal'));
  fs.writeFileSync(path.join(profilesDir, 'personal', 'config.toml'), 'oauth_token = "p"\n');
  return { shim, profilesDir };
}

function runCli(args, { profilesDir, shim, extraEnv = {} } = {}) {
  const outFile = path.join(os.tmpdir(), `wa-out-${Date.now()}-${Math.random()}.json`);
  const env = { ...process.env };
  delete env.WRANGLER_CONFIG_PATH;
  delete env.WRANGLER_PROFILE;
  if (profilesDir) env.WRANGLER_ACCOUNTS_DIR = profilesDir;
  if (shim) env.PATH = `${shim}${path.delimiter}${process.env.PATH}`;
  env.WA_TEST_OUT = outFile;
  Object.assign(env, extraEnv);

  const r = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env,
  });
  let payload = null;
  if (fs.existsSync(outFile)) {
    try { payload = JSON.parse(fs.readFileSync(outFile, 'utf8')); } catch {}
    fs.unlinkSync(outFile);
  }
  return { ...r, payload };
}

test('--profile work deploy --env production: argv carries deploy and --env', () => {
  const { shim, profilesDir } = setupShimAndProfiles();
  const r = runCli(['--profile', 'work', 'deploy', '--env', 'production'], { shim, profilesDir });
  assert.equal(r.status, 0, `stderr=${r.stderr}`);
  assert.deepEqual(r.payload.argv, ['deploy', '--env', 'production']);
  assert.equal(r.payload.env.WRANGLER_PROFILE, 'work');
});

test('list --json: management subcommand parses --json after the subcommand', () => {
  const { profilesDir } = setupShimAndProfiles();
  const r = spawnSync(process.execPath, [CLI, 'list', '--json'], {
    encoding: 'utf8',
    env: { ...process.env, WRANGLER_ACCOUNTS_DIR: profilesDir },
  });
  assert.equal(r.status, 0);
  const list = JSON.parse(r.stdout);
  assert.deepEqual(list.sort(), ['personal', 'work']);
});

test('positional shorthand: wrangler-accounts work deploy forwards deploy only', () => {
  const { shim, profilesDir } = setupShimAndProfiles();
  const r = runCli(['work', 'deploy'], { shim, profilesDir });
  assert.equal(r.status, 0, `stderr=${r.stderr}`);
  assert.deepEqual(r.payload.argv, ['deploy']);
  assert.equal(r.payload.env.WRANGLER_PROFILE, 'work');
});

test('save work --force: management subcommand parses --force after positional', () => {
  const { profilesDir } = setupShimAndProfiles();
  const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-save-src-'));
  const cfgPath = path.join(cfgDir, 'default.toml');
  fs.writeFileSync(cfgPath, 'oauth_token = "new"\n');
  const r = spawnSync(process.execPath, [CLI, 'save', 'work', '--force', '-c', cfgPath], {
    encoding: 'utf8',
    env: { ...process.env, WRANGLER_ACCOUNTS_DIR: profilesDir },
  });
  assert.equal(r.status, 0, `stderr=${r.stderr}`);
  // verify the profile config was overwritten with the new content
  const content = fs.readFileSync(path.join(profilesDir, 'work', 'config.toml'), 'utf8');
  assert.match(content, /new/);
});

test('WRANGLER_PROFILE env var resolves when no CLI arg', () => {
  const { shim, profilesDir } = setupShimAndProfiles();
  const r = runCli(['deploy'], { shim, profilesDir, extraEnv: { WRANGLER_PROFILE: 'personal' } });
  assert.equal(r.status, 0, `stderr=${r.stderr}`);
  assert.deepEqual(r.payload.argv, ['deploy']);
  assert.equal(r.payload.env.WRANGLER_PROFILE, 'personal');
});

test('deploy --json is forwarded to wrangler (json stays in argv)', () => {
  const { shim, profilesDir } = setupShimAndProfiles();
  const r = runCli(['--profile', 'work', 'deploy', '--json'], { shim, profilesDir });
  assert.equal(r.status, 0, `stderr=${r.stderr}`);
  // --json after `deploy` should be forwarded, not consumed by wrangler-accounts
  assert.deepEqual(r.payload.argv, ['deploy', '--json']);
});

test('no profile and no default → exit 2 with actionable message', () => {
  const profilesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-noprof-'));
  const r = spawnSync(process.execPath, [CLI, 'deploy'], {
    encoding: 'utf8',
    env: { ...process.env, WRANGLER_ACCOUNTS_DIR: profilesDir, WRANGLER_PROFILE: '' },
  });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--profile|No profile specified/);
});

test('-p is now --profile (v1.0 breaking change)', () => {
  const { shim, profilesDir } = setupShimAndProfiles();
  const r = runCli(['-p', 'work', 'deploy'], { shim, profilesDir });
  assert.equal(r.status, 0, `stderr=${r.stderr}`);
  assert.equal(r.payload.env.WRANGLER_PROFILE, 'work');
});
