'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function expandHome(p) {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function resolvePath(p) {
  if (!p) return p;
  return path.resolve(expandHome(p));
}

function detectConfigPath(cliPath, env = process.env) {
  if (cliPath) return resolvePath(cliPath);
  if (env.WRANGLER_CONFIG_PATH) {
    return resolvePath(env.WRANGLER_CONFIG_PATH);
  }

  const home = os.homedir();
  const candidates = [
    path.join(home, '.wrangler', 'config', 'default.toml'),
    path.join(home, 'Library', 'Preferences', '.wrangler', 'config', 'default.toml'),
    path.join(home, '.config', '.wrangler', 'config', 'default.toml'),
    path.join(home, '.config', 'wrangler', 'config', 'default.toml'),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  return candidates[0];
}

function detectProfilesDir(cliPath, env = process.env) {
  if (cliPath) return resolvePath(cliPath);
  if (env.WRANGLER_ACCOUNTS_DIR) {
    return resolvePath(env.WRANGLER_ACCOUNTS_DIR);
  }

  const xdg = env.XDG_CONFIG_HOME;
  if (xdg) return path.join(resolvePath(xdg), 'wrangler-accounts');

  return path.join(os.homedir(), '.config', 'wrangler-accounts');
}

function isDirectory(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// Same rules as xdg-app-paths' config() used by wrangler / cf.
function xdgConfigBase(env = process.env, home = os.homedir()) {
  if (env.XDG_CONFIG_HOME) return env.XDG_CONFIG_HOME;
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Preferences');
  if (process.platform === 'win32') {
    return path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'xdg.config');
  }
  return path.join(home, '.config');
}

/**
 * Wrangler's global config dir, exactly as wrangler resolves it
 * (getGlobalConfigPath): `~/.wrangler` when that is a directory, otherwise
 * `<xdg config>/.wrangler`. Native profiles live in `<dir>/config/<name>.toml`.
 * Never create `~/.wrangler` ourselves: that would move wrangler's config.
 */
function wranglerGlobalConfigDir(env = process.env, home = os.homedir()) {
  const legacy = path.join(home, '.wrangler');
  if (isDirectory(legacy)) return legacy;
  return path.join(xdgConfigBase(env, home), '.wrangler');
}

/** Cloudflare's `cf` CLI config dir (appName "cloudflare", no legacy dir). */
function cfConfigDir(env = process.env, home = os.homedir()) {
  return path.join(xdgConfigBase(env, home), 'cloudflare');
}

module.exports = {
  isDirectory,
  xdgConfigBase,
  wranglerGlobalConfigDir,
  cfConfigDir,
  expandHome,
  resolvePath,
  detectConfigPath,
  detectProfilesDir,
};
