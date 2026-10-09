'use strict';

// Cloudflare's `cf` CLI (npm package `cf`, beta). `cf` is ALSO the name of
// the Cloud Foundry CLI, so nothing here may treat "a cf on PATH" as
// Cloudflare's: we resolve the binary and require its package.json to say
// name "cf" with a cloudflare/cf repository. Detection never runs cf (cf
// needs Node >= 22; wrangler-accounts does not).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { cfConfigDir } = require('./paths');

function realpathOr(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

function isCloudflarePackageJson(pkgPath) {
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    if (pkg.name !== 'cf') return false;
    const repo = typeof pkg.repository === 'string' ? pkg.repository : (pkg.repository && pkg.repository.url) || '';
    const home = pkg.homepage || '';
    return /cloudflare\/cf(\.git)?\b/i.test(repo) || /cloudflare\/cf\b/i.test(home);
  } catch {
    return false;
  }
}

/**
 * Is the executable at binPath Cloudflare's cf? Follows symlinks (npm/pnpm
 * global bins are symlinks into node_modules/cf/bin/cf) and looks for the
 * owning package.json.
 */
function isCloudflareCf(binPath) {
  const real = realpathOr(binPath);
  if (!real) return false;
  let dir = path.dirname(real);
  for (let i = 0; i < 4; i += 1) {
    const pkg = path.join(dir, 'package.json');
    if (fs.existsSync(pkg)) return isCloudflarePackageJson(pkg);
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return false;
}

function whichAll(name, pathEnv, skipDirs = []) {
  const skip = new Set(skipDirs.map((d) => realpathOr(d) || d));
  const found = [];
  for (const dir of String(pathEnv || '').split(path.delimiter)) {
    if (!dir) continue;
    if (skip.has(realpathOr(dir) || dir)) continue;
    const candidate = path.join(dir, name);
    try {
      if (fs.statSync(candidate).isFile()) {
        fs.accessSync(candidate, fs.constants.X_OK);
        found.push(candidate);
      }
    } catch {
      /* keep looking */
    }
  }
  return found;
}

/**
 * Locate Cloudflare's cf. Prefers the `cloudflare` alias bin (same package,
 * no Cloud Foundry clash), then the first `cf` on PATH if it is Cloudflare's.
 * Returns { path, via } or null. `other` reports a non-Cloudflare `cf`
 * (e.g. Cloud Foundry) so callers can explain instead of guessing.
 */
function findCloudflareCf({ pathEnv = process.env.PATH || '', skipDirs = [] } = {}) {
  const cfs = whichAll('cf', pathEnv, skipDirs);
  const firstCf = cfs[0] || null;
  if (firstCf && isCloudflareCf(firstCf)) return { path: firstCf, via: 'cf', other: null };
  for (const alias of whichAll('cloudflare', pathEnv, skipDirs)) {
    if (isCloudflareCf(alias)) return { path: alias, via: 'cloudflare', other: firstCf };
  }
  return firstCf ? { path: null, via: null, other: firstCf } : null;
}

/** Does cf have a stored OAuth profile with this name? */
function cfProfileExists(name, { env = process.env, home = os.homedir() } = {}) {
  const dir = path.join(cfConfigDir(env, home), 'config');
  return fs.existsSync(path.join(dir, `${name}.json`)) || fs.existsSync(path.join(dir, `${name}.enc`));
}

function cfProfileFiles(name, { env = process.env, home = os.homedir() } = {}) {
  const dir = path.join(cfConfigDir(env, home), 'config');
  return { json: path.join(dir, `${name}.json`), enc: path.join(dir, `${name}.enc`) };
}

function isCfCommand(cmd) {
  const base = path.basename(String(cmd || ''));
  return base === 'cf' || base === 'cloudflare';
}

module.exports = {
  isCloudflareCf,
  isCloudflarePackageJson,
  findCloudflareCf,
  cfProfileExists,
  cfProfileFiles,
  isCfCommand,
};
