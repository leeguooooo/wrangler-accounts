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

module.exports = {
  expandHome,
  resolvePath,
  detectConfigPath,
  detectProfilesDir,
};
