const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CLI = path.join(__dirname, '..', 'bin', 'wrangler-accounts.js');

function runCli(args, { profilesDir, configPath, env = {} } = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      WRANGLER_ACCOUNTS_DIR: profilesDir,
      WRANGLER_CONFIG_PATH: configPath,
      ...env,
    },
  });
}

function mkTmp(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `wa-test-${name}-`));
}

test('list on empty dir prints no-profiles message', () => {
  const profilesDir = mkTmp('list-empty');
  const r = runCli(['list'], { profilesDir });
  assert.equal(r.status, 0, `stderr=${r.stderr}`);
  assert.match(r.stdout, /No profiles found\./);
});

test('list --json on empty dir prints []', () => {
  const profilesDir = mkTmp('list-json');
  const r = runCli(['list', '--json'], { profilesDir });
  assert.equal(r.status, 0, `stderr=${r.stderr}`);
  assert.deepEqual(JSON.parse(r.stdout), []);
});

test('save then list then remove works against a temp profiles dir', () => {
  const profilesDir = mkTmp('save-remove-profiles');
  const configDir = mkTmp('save-remove-cfg');
  const configPath = path.join(configDir, 'default.toml');
  fs.writeFileSync(configPath, 'oauth_token = "test"\n');

  const saveResult = runCli(['save', 'workname', '-c', configPath], {
    profilesDir,
    configPath,
  });
  assert.equal(saveResult.status, 0, `stderr=${saveResult.stderr}`);
  assert.ok(fs.existsSync(path.join(profilesDir, 'workname', 'config.toml')));
  assert.ok(fs.existsSync(path.join(profilesDir, 'workname', 'meta.json')));

  const listResult = runCli(['list'], { profilesDir, configPath });
  assert.equal(listResult.status, 0, `stderr=${listResult.stderr}`);
  assert.match(listResult.stdout, /workname/);

  const removeResult = runCli(['remove', 'workname'], { profilesDir, configPath });
  assert.equal(removeResult.status, 0, `stderr=${removeResult.stderr}`);
  assert.equal(fs.existsSync(path.join(profilesDir, 'workname')), false);
});

test('invalid profile name exits non-zero with an error', () => {
  const profilesDir = mkTmp('invalid-name-profiles');
  const configDir = mkTmp('invalid-name-cfg');
  const configPath = path.join(configDir, 'default.toml');
  fs.writeFileSync(configPath, 'oauth_token = "test"\n');

  const r = runCli(['save', 'bad name!', '-c', configPath], {
    profilesDir,
    configPath,
  });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Invalid profile name/);
});

test('status with stubbed wrangler reports parsed identity (baseline for Task 4)', () => {
  const profilesDir = mkTmp('status-profiles');
  const shimDir = mkTmp('status-shim');
  const cfgDir = mkTmp('status-cfg');

  const fakeWrangler = path.join(shimDir, 'wrangler');
  fs.writeFileSync(
    fakeWrangler,
    [
      '#!/bin/sh',
      "cat <<'EOF'",
      ' ⛅️ wrangler 4.79.0',
      '─────────────────────────────────────────────',
      'Getting User settings...',
      '👋 You are logged in with an OAuth Token, associated with the email test@example.com.',
      '┌──────────────┬──────────────────────────────────┐',
      '│ Test Account │ 0123456789abcdef0123456789abcdef │',
      '└──────────────┴──────────────────────────────────┘',
      'EOF',
      '',
    ].join('\n'),
  );
  fs.chmodSync(fakeWrangler, 0o755);

  const cfgPath = path.join(cfgDir, 'default.toml');
  fs.writeFileSync(cfgPath, 'oauth_token = "test"\n');

  const r = runCli(['status', '--json'], {
    profilesDir,
    configPath: cfgPath,
    env: {
      PATH: `${shimDir}${path.delimiter}${process.env.PATH}`,
    },
  });
  assert.equal(r.status, 0, `stderr=${r.stderr}`);
  const payload = JSON.parse(r.stdout);
  assert.ok(payload.currentIdentity, 'expected currentIdentity to be populated');
  assert.equal(payload.currentIdentity.email, 'test@example.com');
  assert.equal(payload.currentIdentity.accountId, '0123456789abcdef0123456789abcdef');
});
