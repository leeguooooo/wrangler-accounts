'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { expandHome } = require('./paths');

const TEMPLATE_PATH = path.join(__dirname, 'wrangler-shim.sh');
const RC_BEGIN = '# >>> wrangler-accounts shim >>>';
const RC_END = '# <<< wrangler-accounts shim <<<';

/**
 * Directory where the `wrangler` shim is written. Override with
 * WRANGLER_ACCOUNTS_SHIM_DIR; defaults to ~/.wrangler-accounts/shims.
 */
function getShimDir(env = process.env) {
  if (env.WRANGLER_ACCOUNTS_SHIM_DIR) {
    return path.resolve(expandHome(env.WRANGLER_ACCOUNTS_SHIM_DIR));
  }
  return path.join(os.homedir(), '.wrangler-accounts', 'shims');
}

function getShimPath(shimDir) {
  return path.join(shimDir, 'wrangler');
}

function realpathOr(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * First `wrangler` on PATH that is NOT inside shimDir. Returns its absolute
 * path, or null if none found.
 */
function findRealWrangler({ pathEnv = process.env.PATH || '', shimDir } = {}) {
  const shimReal = shimDir ? realpathOr(shimDir) : null;
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    if (shimReal && realpathOr(dir) === shimReal) continue;
    const candidate = path.join(dir, 'wrangler');
    try {
      if (fs.statSync(candidate).isFile()) {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      }
    } catch {
      /* not here, keep looking */
    }
  }
  return null;
}

function isShimInstalled(shimDir) {
  const p = getShimPath(shimDir);
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * Write the shim into shimDir (creating it) and mark it executable.
 * Returns the shim path.
 */
function installShim({ shimDir, templatePath = TEMPLATE_PATH } = {}) {
  fs.mkdirSync(shimDir, { recursive: true });
  const shimPath = getShimPath(shimDir);
  // Bake the resolved (canonical) shim directory into the script so it can
  // find the real wrangler and never exec itself — $0 is unreliable when the
  // shim is invoked as a bare `wrangler`.
  const resolvedDir = realpathOr(shimDir);
  const body = fs
    .readFileSync(templatePath, 'utf8')
    .split('__WA_SHIM_DIR__')
    .join(resolvedDir);
  fs.writeFileSync(shimPath, body, { mode: 0o755 });
  fs.chmodSync(shimPath, 0o755);
  return shimPath;
}

/**
 * Remove the shim file (and the shim dir if it becomes empty).
 * Returns true if a shim was removed.
 */
function uninstallShim({ shimDir } = {}) {
  const shimPath = getShimPath(shimDir);
  let removed = false;
  try {
    fs.unlinkSync(shimPath);
    removed = true;
  } catch {
    /* nothing to remove */
  }
  try {
    if (fs.readdirSync(shimDir).length === 0) {
      fs.rmdirSync(shimDir);
    }
  } catch {
    /* leave a non-empty or missing dir alone */
  }
  return removed;
}

function pathDirIndex(pathEnv, dir) {
  const target = realpathOr(dir);
  const dirs = pathEnv.split(path.delimiter);
  for (let i = 0; i < dirs.length; i += 1) {
    if (dirs[i] && realpathOr(dirs[i]) === target) return i;
  }
  return -1;
}

/**
 * Inspect the shim's installed/active state.
 */
function shimStatus({ shimDir, pathEnv = process.env.PATH || '' } = {}) {
  const installed = isShimInstalled(shimDir);
  const realWrangler = findRealWrangler({ pathEnv, shimDir });
  const shimIdx = pathDirIndex(pathEnv, shimDir);
  const realIdx = realWrangler ? pathDirIndex(pathEnv, path.dirname(realWrangler)) : -1;
  const onPath = shimIdx >= 0;
  // The shim only takes effect when its directory is reached before the
  // directory holding the real wrangler (or when there is no other wrangler).
  const active = installed && onPath && (realIdx === -1 || shimIdx < realIdx);
  return {
    installed,
    shimDir,
    shimPath: getShimPath(shimDir),
    onPath,
    active,
    realWrangler,
  };
}

/**
 * Detect the user's shell rc file for the --apply convenience.
 */
/**
 * The shell family driving rc syntax: 'zsh' | 'bash' | 'fish' | 'sh'.
 */
function detectShell(env = process.env) {
  const shell = path.basename(env.SHELL || '');
  if (shell === 'zsh' || shell === 'bash' || shell === 'fish') return shell;
  return 'sh';
}

function fishConfigPath(env = process.env) {
  const base = env.XDG_CONFIG_HOME
    ? path.resolve(expandHome(env.XDG_CONFIG_HOME))
    : path.join(os.homedir(), '.config');
  return path.join(base, 'fish', 'config.fish');
}

/**
 * The rc file to edit for --apply, based on the user's shell.
 */
function detectShellRc(env = process.env) {
  const shell = detectShell(env);
  const home = os.homedir();
  if (shell === 'zsh') return path.join(home, '.zshrc');
  if (shell === 'fish') return fishConfigPath(env);
  if (shell === 'bash') {
    const profile = path.join(home, '.bash_profile');
    if (fs.existsSync(profile) && !fs.existsSync(path.join(home, '.bashrc'))) {
      return profile;
    }
    return path.join(home, '.bashrc');
  }
  return path.join(home, '.profile');
}

/**
 * The single line that puts the shim dir at the front of PATH, in the syntax
 * of the given shell. Shown to the user and written into the rc block.
 */
function pathLine(shimDir, shell = 'sh') {
  if (shell === 'fish') return `fish_add_path -p ${shimDir}`;
  return `export PATH="${shimDir}:$PATH"`;
}

function rcBlock(shimDir, shell = 'sh') {
  // RC_BEGIN/RC_END use `#` comments, valid in zsh/bash/fish alike.
  return `${RC_BEGIN}\n${pathLine(shimDir, shell)}\n${RC_END}\n`;
}

/**
 * Idempotently add the shim dir to PATH in rcPath. Returns true if the file
 * was modified.
 */
function applyToRc({ rcPath, shimDir, shell = 'sh' }) {
  let current = '';
  try {
    current = fs.readFileSync(rcPath, 'utf8');
  } catch {
    /* file may not exist yet */
  }
  if (current.includes(RC_BEGIN)) return false;
  fs.mkdirSync(path.dirname(rcPath), { recursive: true });
  const prefix = current && !current.endsWith('\n') ? '\n' : '';
  fs.appendFileSync(rcPath, `${prefix}${rcBlock(shimDir, shell)}`);
  return true;
}

/**
 * Strip the shim block from rcPath. Returns true if the file was modified.
 */
function removeFromRc({ rcPath }) {
  let current;
  try {
    current = fs.readFileSync(rcPath, 'utf8');
  } catch {
    return false;
  }
  if (!current.includes(RC_BEGIN)) return false;
  const pattern = new RegExp(
    `\\n?${escapeRe(RC_BEGIN)}[\\s\\S]*?${escapeRe(RC_END)}\\n?`,
    'g',
  );
  const next = current.replace(pattern, '\n');
  fs.writeFileSync(rcPath, next);
  return true;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = {
  TEMPLATE_PATH,
  getShimDir,
  getShimPath,
  findRealWrangler,
  isShimInstalled,
  installShim,
  uninstallShim,
  shimStatus,
  detectShell,
  detectShellRc,
  pathLine,
  applyToRc,
  removeFromRc,
};
