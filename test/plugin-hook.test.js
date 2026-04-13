'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PLUGIN_JSON = path.join(ROOT, 'plugins', 'wrangler-accounts', '.claude-plugin', 'plugin.json');
const MARKETPLACE_JSON = path.join(ROOT, '.claude-plugin', 'marketplace.json');
const HOOKS_JSON = path.join(ROOT, 'plugins', 'wrangler-accounts', 'hooks', 'hooks.json');
const HOOK_SCRIPT = path.join(ROOT, 'plugins', 'wrangler-accounts', 'hooks', 'guard-wrangler.sh');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function mkTmp(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `wa-plugin-${name}-`));
}

function writeExecutable(file, content) {
  fs.writeFileSync(file, content);
  fs.chmodSync(file, 0o755);
}

function setupFakeWranglerAccountsBin(dir) {
  const bin = path.join(dir, 'wrangler-accounts');
  writeExecutable(
    bin,
    [
      '#!/bin/sh',
      'case "$1" in',
      '  list)',
      '    if [ "$2" = "--plain" ]; then',
      '      printf "%s\\n" "${WA_TEST_PROFILES:-work}"',
      '      exit 0',
      '    fi',
      '    exit 0',
      '    ;;',
      '  default)',
      '    printf "%s\\n" "${WA_TEST_DEFAULT_PROFILE:-work}"',
      '    exit 0',
      '    ;;',
      'esac',
      'exit 0',
      '',
    ].join('\n'),
  );
}

function runGuard(command, { bypass = false } = {}) {
  const cwd = mkTmp('cwd');
  const binDir = mkTmp('bin');
  setupFakeWranglerAccountsBin(binDir);
  fs.writeFileSync(path.join(cwd, 'wrangler.toml'), 'name = "demo"\n');

  const input = JSON.stringify({
    tool_name: 'Bash',
    tool_input: {
      command,
    },
  });

  return spawnSync('bash', [HOOK_SCRIPT], {
    cwd,
    input,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
      NOWRANGLER_ACCOUNTS_GUARD: bypass ? '1' : '',
      WA_TEST_PROFILES: 'work',
      WA_TEST_DEFAULT_PROFILE: 'work',
    },
  });
}

test('plugin.json parses and exposes required fields', () => {
  const plugin = readJson(PLUGIN_JSON);
  assert.equal(plugin.name, 'wrangler-accounts');
  assert.equal(typeof plugin.description, 'string');
  assert.equal(plugin.version, '1.5.1');
});

test('marketplace.json parses and exposes required fields', () => {
  const marketplace = readJson(MARKETPLACE_JSON);
  assert.equal(marketplace.name, 'leeguoo-tools');
  assert.equal(typeof marketplace.owner?.name, 'string');
  assert.ok(Array.isArray(marketplace.plugins));
  assert.equal(marketplace.plugins[0]?.name, 'wrangler-accounts');
});

test('hooks.json parses and exposes a Bash PreToolUse hook', () => {
  const hooks = readJson(HOOKS_JSON);
  const preToolUse = hooks.hooks?.PreToolUse;
  assert.ok(Array.isArray(preToolUse));
  assert.equal(preToolUse[0]?.matcher, 'Bash');
  assert.equal(preToolUse[0]?.hooks?.[0]?.type, 'command');
});

test('guard hook blocks raw wrangler when profiles exist in a Cloudflare project', () => {
  const result = runGuard('wrangler deploy');
  assert.equal(result.status, 2, `stdout=${result.stdout}\nstderr=${result.stderr}`);
  assert.match(result.stderr, /wrangler-accounts guard/i);
});

test('guard hook allows npx wrangler', () => {
  const result = runGuard('npx wrangler deploy');
  assert.equal(result.status, 0, `stdout=${result.stdout}\nstderr=${result.stderr}`);
});

test('guard hook allows wrangler-accounts wrapper', () => {
  const result = runGuard('wrangler-accounts --profile work deploy');
  assert.equal(result.status, 0, `stdout=${result.stdout}\nstderr=${result.stderr}`);
});

test('guard hook allows explicit NOWRANGLER_ACCOUNTS_GUARD bypass', () => {
  const result = runGuard('wrangler deploy', { bypass: true });
  assert.equal(result.status, 0, `stdout=${result.stdout}\nstderr=${result.stderr}`);
});
