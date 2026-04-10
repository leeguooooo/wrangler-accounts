#!/usr/bin/env node
'use strict';

// Pre-publish package verification.
// Packs the current tree with `npm pack`, installs the tarball into a
// throwaway dir, and runs the installed binary end-to-end. Catches the
// class of bug where bin/ references files missing from package.json's
// `files` array (as happened when lib/ was forgotten in 1.0.0).

const { execSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

function log(msg) {
  process.stdout.write(`[verify-package] ${msg}\n`);
}

function die(msg) {
  process.stderr.write(`[verify-package] FAIL: ${msg}\n`);
  process.exit(1);
}

// 1. Pack
log('running npm pack...');
let tarballName;
try {
  const stdout = execSync('npm pack --json', { cwd: ROOT, encoding: 'utf8' });
  // npm pack --json emits a multi-line JSON array on stdout. Parse the
  // whole thing; the first element's `filename` is the tarball.
  const parsed = JSON.parse(stdout);
  if (!Array.isArray(parsed) || !parsed[0] || !parsed[0].filename) {
    die(`unexpected npm pack --json output:\n${stdout.slice(0, 500)}`);
  }
  tarballName = parsed[0].filename;
} catch (err) {
  die(`npm pack failed: ${err.message}`);
}
const tarballPath = path.join(ROOT, tarballName);
if (!fs.existsSync(tarballPath)) die(`tarball not at expected path: ${tarballPath}`);
log(`packed: ${tarballName}`);

// 2. Install into a throwaway dir
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-verify-'));
log(`scratch dir: ${scratch}`);

let cleanup = () => {
  try { fs.rmSync(scratch, { recursive: true, force: true }); } catch {}
  try { fs.unlinkSync(tarballPath); } catch {}
};
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(130); });

try {
  execSync('npm init -y', { cwd: scratch, stdio: 'ignore' });
  execSync(`npm install "${tarballPath}"`, { cwd: scratch, stdio: 'ignore' });
} catch (err) {
  die(`install failed: ${err.message}`);
}

const binPath = path.join(scratch, 'node_modules', '.bin', 'wrangler-accounts');
if (!fs.existsSync(binPath)) die(`binary missing after install: ${binPath}`);

// 3. Smoke: --version
const versionResult = spawnSync(binPath, ['--version'], { encoding: 'utf8' });
if (versionResult.status !== 0) {
  die(`--version exited ${versionResult.status}. stderr:\n${versionResult.stderr}`);
}
const reportedVersion = versionResult.stdout.trim();
if (reportedVersion !== pkg.version) {
  die(`--version reported '${reportedVersion}', expected '${pkg.version}'`);
}
log(`--version → ${reportedVersion} ✓`);

// 4. Smoke: list (exercises the lib/profile-store and lib/paths import chain)
const profilesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-verify-profiles-'));
process.on('exit', () => {
  try { fs.rmSync(profilesDir, { recursive: true, force: true }); } catch {}
});
const listResult = spawnSync(binPath, ['list'], {
  encoding: 'utf8',
  env: { ...process.env, WRANGLER_ACCOUNTS_DIR: profilesDir },
});
if (listResult.status !== 0) {
  die(`list exited ${listResult.status}. stderr:\n${listResult.stderr}`);
}
if (!/No profiles found/.test(listResult.stdout)) {
  die(`list output unexpected:\n${listResult.stdout}`);
}
log('list → "No profiles found." ✓');

// 5. Smoke: verify every lib file declared in bin is actually in the tarball
const binContent = fs.readFileSync(path.join(ROOT, 'bin', 'wrangler-accounts.js'), 'utf8');
const libRequires = [
  ...binContent.matchAll(/require\(["']\.\.\/(lib\/[^"']+)["']\)/g),
].map((m) => m[1]);
const installed = path.join(scratch, 'node_modules', pkg.name);
for (const rel of libRequires) {
  // The require path may resolve as either `lib/foo` or `lib/foo.js`
  const candidate = path.join(installed, rel);
  const withJs = candidate.endsWith('.js') ? candidate : `${candidate}.js`;
  if (!fs.existsSync(candidate) && !fs.existsSync(withJs)) {
    die(`installed package missing required file: ${rel}`);
  }
}
log(`all ${libRequires.length} lib/ imports resolved in installed package ✓`);

log('package verification passed');
process.exit(0);
