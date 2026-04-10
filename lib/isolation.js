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
 *
 * Note: not pure — when profileCfg is provided, ensures the per-profile
 * cache directory exists so wrangler doesn't ENOENT on first write.
 */
function buildIsolatedEnv({
  shadow,
  realHome,
  profile,
  profileCfg = null,
  baseEnv = process.env,
  cloudflaredPath = null,
}) {
  const env = { ...baseEnv };
  env.HOME = shadow;
  env.WRANGLER_PROFILE = profile;
  env.WRANGLER_ACCOUNT = profile;
  env.WRANGLER_ACCOUNT_REAL_HOME = realHome;
  env.WRANGLER_REGISTRY_PATH = path.join(realHome, '.wrangler', 'registry');
  env.WRANGLER_LOG_PATH = path.join(realHome, '.wrangler', 'logs');
  env.WRANGLER_SEND_METRICS = 'false';

  // CRITICAL: Wrangler caches the user's selected Cloudflare account ID
  // in `wrangler-account.json` inside `getCacheFolder()`. If multiple
  // profiles share one cache directory, profile A's OAuth token can be
  // paired with profile B's cached account ID, causing wrangler to
  // write to the WRONG ACCOUNT — silently, until something like an R2
  // bucket gets created in the wrong place.
  //
  // The cache must be per-profile. We point WRANGLER_CACHE_DIR at a
  // `cache/` directory next to the profile's config.toml. Wrangler's
  // getCacheFolder() honors this env var and skips its own cwd-based
  // discovery (cli.js:62549).
  //
  // Earlier versions of this tool (≤1.2.1) pointed WRANGLER_CACHE_DIR
  // at real $HOME/.wrangler/cache hoping to "share workerd cache" —
  // that was wrong. workerd/cloudflared binaries live elsewhere
  // (CLOUDFLARED_PATH / node_modules); WRANGLER_CACHE_DIR is only for
  // config-cache files like wrangler-account.json and
  // pages-config-cache.json.
  if (profileCfg) {
    const profileDir = path.dirname(profileCfg);
    const cacheDir = path.join(profileDir, 'cache');
    try {
      fs.mkdirSync(cacheDir, { recursive: true });
    } catch (err) {
      process.stderr.write(
        `[wrangler-accounts] could not create per-profile cache dir ${cacheDir}: ${err.message}\n`,
      );
    }
    env.WRANGLER_CACHE_DIR = cacheDir;
  }

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
    profileCfg,
    baseEnv,
    cloudflaredPath,
  });

  let result;
  try {
    // captureStdout mode is used for non-interactive checks (e.g.
    // background `wrangler whoami` during `list --deep`), so we close
    // stdin on the child rather than letting it read from the user's
    // terminal. Normal inherit mode keeps stdin attached for interactive
    // flows like `login` and `exec`.
    result = spawnSync(command, args, {
      stdio: captureStdout ? ['ignore', 'pipe', 'pipe'] : 'inherit',
      env,
      encoding: 'utf8',
    });
  } finally {
    cleanupShadow(shadow);
  }

  // spawnSync surfaces spawn-time errors (ENOENT, EACCES, etc.) via
  // result.error. Forward the message to stderr so the user can diagnose
  // "command not found" scenarios instead of seeing a silent exit 1.
  if (result.error) {
    process.stderr.write(
      `[wrangler-accounts] failed to spawn '${command}': ${result.error.message}\n`,
    );
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
