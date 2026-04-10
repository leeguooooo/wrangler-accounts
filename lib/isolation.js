'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

/**
 * Create a per-invocation shadow HOME directory.
 *
 * Layout:
 *   $shadow/
 *     .wrangler/config/default.toml  → symlink to profileCfg  (token refresh
 *                                                                syncs back)
 *     .npmrc   → symlink to $realHome/.npmrc
 *     .ssh     → symlink to $realHome/.ssh
 *     Library  → symlink to $realHome/Library
 *     ...      every other top-level entry in realHome except `.wrangler`
 *
 * Caller MUST call cleanupShadow(shadow) when done.
 *
 * @param {object} args
 * @param {string} args.realHome
 * @param {string} args.profileCfg - path to the profile's config.toml file
 * @param {string} [args.label] - optional label for the tmpdir name
 * @returns {string} path to the shadow HOME
 */
function createShadowHome({ realHome, profileCfg, label = 'wa' }) {
  if (!realHome || !fs.existsSync(realHome)) {
    throw new Error(`real HOME does not exist: ${realHome}`);
  }
  if (!profileCfg || !fs.existsSync(profileCfg)) {
    throw new Error(`profile config does not exist: ${profileCfg}`);
  }

  const shadow = fs.mkdtempSync(path.join(os.tmpdir(), `${label}-`));
  fs.chmodSync(shadow, 0o700);

  // Mirror every top-level entry from real HOME except .wrangler.
  for (const entry of fs.readdirSync(realHome)) {
    if (entry === '.wrangler') continue;
    try {
      fs.symlinkSync(
        path.join(realHome, entry),
        path.join(shadow, entry),
      );
    } catch (err) {
      // If symlinking a specific entry fails (permissions, weird file type),
      // log to stderr and continue. Missing entries are a UX problem, not a
      // correctness one — the subprocess will just not find that file.
      process.stderr.write(
        `[wrangler-accounts] skip symlink ${entry}: ${err.message}\n`,
      );
    }
  }

  // The one file that matters — a real symlink to the profile file so
  // Wrangler's in-place writeFileSync token refreshes flow back into the
  // saved profile automatically.
  const shadowWranglerConfig = path.join(shadow, '.wrangler', 'config');
  fs.mkdirSync(shadowWranglerConfig, { recursive: true });
  fs.symlinkSync(
    profileCfg,
    path.join(shadowWranglerConfig, 'default.toml'),
  );

  return shadow;
}

/**
 * Remove a shadow HOME. Safe because the shadow contains only symlinks and
 * small directories owned by this process. fs.rmSync does not follow
 * symlinks (it unlinks them), so files in real HOME are never at risk.
 */
function cleanupShadow(shadow) {
  if (!shadow) return;
  try {
    fs.rmSync(shadow, { recursive: true, force: true });
  } catch (err) {
    process.stderr.write(
      `[wrangler-accounts] cleanup warning: ${err.message}\n`,
    );
  }
}

/**
 * Build the environment variable set that every isolated child process gets.
 * This is a pure function — no I/O.
 */
function buildIsolatedEnv({
  shadow,
  realHome,
  profile,
  baseEnv = process.env,
  cloudflaredPath = null,
}) {
  const env = { ...baseEnv };
  env.HOME = shadow;
  env.WRANGLER_PROFILE = profile;
  env.WRANGLER_ACCOUNT = profile;
  env.WRANGLER_ACCOUNT_REAL_HOME = realHome;
  env.WRANGLER_REGISTRY_PATH = path.join(realHome, '.wrangler', 'registry');
  env.WRANGLER_CACHE_DIR = path.join(realHome, '.wrangler', 'cache');
  env.WRANGLER_LOG_PATH = path.join(realHome, '.wrangler', 'logs');
  env.WRANGLER_SEND_METRICS = 'false';
  if (cloudflaredPath) {
    env.CLOUDFLARED_PATH = cloudflaredPath;
  }
  return env;
}

/**
 * Spawn a command inside a shadow HOME for the given profile.
 * Handles setup, spawning, and cleanup in a try/finally so cleanup runs
 * even on unexpected errors.
 *
 * @param {object} args
 * @param {string} args.profile
 * @param {string} args.profileCfg
 * @param {string} args.realHome
 * @param {string} args.command
 * @param {string[]} args.args
 * @param {object} [args.baseEnv]
 * @param {boolean} [args.captureStdout]
 * @param {string|null} [args.cloudflaredPath]
 * @returns {{exitCode: number, stdout?: string, stderr?: string}}
 */
function runIsolated({
  profile,
  profileCfg,
  realHome,
  command,
  args,
  baseEnv = process.env,
  captureStdout = false,
  cloudflaredPath = null,
}) {
  const shadow = createShadowHome({
    realHome,
    profileCfg,
    label: `wa-${profile}`,
  });
  const env = buildIsolatedEnv({
    shadow,
    realHome,
    profile,
    baseEnv,
    cloudflaredPath,
  });

  let result;
  try {
    result = spawnSync(command, args, {
      stdio: captureStdout ? ['inherit', 'pipe', 'pipe'] : 'inherit',
      env,
      encoding: 'utf8',
    });
  } finally {
    cleanupShadow(shadow);
  }

  const exitCode =
    result.status == null ? (result.signal ? 128 : 1) : result.status;

  return {
    exitCode,
    stdout: captureStdout ? result.stdout || '' : undefined,
    stderr: captureStdout ? result.stderr || '' : undefined,
  };
}

module.exports = {
  createShadowHome,
  cleanupShadow,
  buildIsolatedEnv,
  runIsolated,
};
