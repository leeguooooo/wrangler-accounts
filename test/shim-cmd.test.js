'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CLI = path.join(__dirname, '..', 'bin', 'wrangler-accounts.js');
const shimLib = require('../lib/shim');

function mkTmp(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `wa-shim-cmd-${name}-`));
}

function run(args, { shimDir, extraEnv = {} } = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      WRANGLER_ACCOUNTS_SHIM_DIR: shimDir,
      ...extraEnv,
    },
  });
}

test('shim install writes an executable shim and reports the export line', () => {
  const shimDir = mkTmp('install');
  const r = run(['shim', 'install', '--json'], { shimDir });
  assert.equal(r.status, 0, `stderr=${r.stderr}`);
  const out = JSON.parse(r.stdout);
  assert.equal(out.action, 'install');
  assert.equal(out.shimPath, path.join(shimDir, 'wrangler'));
  assert.match(out.exportLine, /export PATH=/);

  const stat = fs.statSync(out.shimPath);
  assert.ok(stat.isFile());
  assert.ok(stat.mode & 0o111, 'shim should be executable');

  const body = fs.readFileSync(out.shimPath, 'utf8');
  assert.match(body, /wrangler-accounts shim/);
});

test('shim status reports installed + active when ahead of the real wrangler on PATH', () => {
  const shimDir = mkTmp('status');
  shimLib.installShim({ shimDir });

  const realDir = mkTmp('real');
  fs.writeFileSync(path.join(realDir, 'wrangler'), '#!/bin/sh\nexit 0\n');
  fs.chmodSync(path.join(realDir, 'wrangler'), 0o755);

  const r = run(['shim', 'status', '--json'], {
    shimDir,
    extraEnv: { PATH: [shimDir, realDir].join(path.delimiter) },
  });
  assert.equal(r.status, 0, `stderr=${r.stderr}`);
  const out = JSON.parse(r.stdout);
  assert.equal(out.installed, true);
  assert.equal(out.onPath, true);
  assert.equal(out.active, true);
  assert.equal(out.realWrangler, path.join(realDir, 'wrangler'));
});

test('shim status reports not-active when the real wrangler comes first on PATH', () => {
  const shimDir = mkTmp('status2');
  shimLib.installShim({ shimDir });

  const realDir = mkTmp('real2');
  fs.writeFileSync(path.join(realDir, 'wrangler'), '#!/bin/sh\nexit 0\n');
  fs.chmodSync(path.join(realDir, 'wrangler'), 0o755);

  const r = run(['shim', 'status', '--json'], {
    shimDir,
    extraEnv: { PATH: [realDir, shimDir].join(path.delimiter) },
  });
  const out = JSON.parse(r.stdout);
  assert.equal(out.installed, true);
  assert.equal(out.active, false);
});

test('shim uninstall removes the shim', () => {
  const shimDir = mkTmp('uninstall');
  shimLib.installShim({ shimDir });
  assert.ok(fs.existsSync(path.join(shimDir, 'wrangler')));

  const r = run(['shim', 'uninstall', '--json'], { shimDir });
  assert.equal(r.status, 0, `stderr=${r.stderr}`);
  const out = JSON.parse(r.stdout);
  assert.equal(out.removed, true);
  assert.ok(!fs.existsSync(path.join(shimDir, 'wrangler')));
});

test('findRealWrangler skips the shim dir', () => {
  const shimDir = mkTmp('find-shim');
  const realDir = mkTmp('find-real');
  shimLib.installShim({ shimDir });
  fs.writeFileSync(path.join(realDir, 'wrangler'), '#!/bin/sh\nexit 0\n');
  fs.chmodSync(path.join(realDir, 'wrangler'), 0o755);

  const found = shimLib.findRealWrangler({
    pathEnv: [shimDir, realDir].join(path.delimiter),
    shimDir,
  });
  assert.equal(found, path.join(realDir, 'wrangler'));
});

test('applyToRc / removeFromRc are idempotent', () => {
  const rcDir = mkTmp('rc');
  const rcPath = path.join(rcDir, '.zshrc');
  fs.writeFileSync(rcPath, '# existing\nexport FOO=1\n');
  const shimDir = '/tmp/wa-shims';

  assert.equal(shimLib.applyToRc({ rcPath, shimDir }), true);
  assert.equal(shimLib.applyToRc({ rcPath, shimDir }), false, 'second apply is a no-op');
  const after = fs.readFileSync(rcPath, 'utf8');
  assert.match(after, /export PATH="\/tmp\/wa-shims:\$PATH"/);
  assert.equal((after.match(/wrangler-accounts shim/g) || []).length, 2);

  assert.equal(shimLib.removeFromRc({ rcPath }), true);
  const cleaned = fs.readFileSync(rcPath, 'utf8');
  assert.doesNotMatch(cleaned, /wrangler-accounts shim/);
  assert.match(cleaned, /export FOO=1/);
  assert.equal(shimLib.removeFromRc({ rcPath }), false, 'second remove is a no-op');
});
