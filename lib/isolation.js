'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { provideLegacyDefaultToml, withSignalsDeferred } = require('./legacy-auth');

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
 * @param {string|null} [args.profileCfg] - path to the profile's config.toml file
 * @param {string} [args.label] - optional label for the tmpdir name
 * @returns {string} path to the shadow HOME
 */
function createShadowHome({ realHome, profileCfg = null, label = 'wa' }) {
  if (!realHome || !fs.existsSync(realHome)) {
    throw new Error(`real HOME does not exist: ${realHome}`);
  }
  if (profileCfg && !fs.existsSync(profileCfg)) {
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
  const defaultConfigPath = path.join(shadowWranglerConfig, 'default.toml');
  if (profileCfg) {
    fs.symlinkSync(profileCfg, defaultConfigPath);
  } else {
    fs.writeFileSync(defaultConfigPath, '');
  }

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
  profileDir = null,
  apiToken = null,
  accountId = null,
  baseEnv = process.env,
  cloudflaredPath = null,
  keyring = 'false',
  extraPathDir = null,
}) {
  const env = { ...baseEnv };

  // CRITICAL: the isolated child must be the SOLE authority on which
  // Cloudflare identity it talks to — the resolved profile, nothing else.
  // Any Cloudflare credential inherited from the parent shell
  // (`CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_API_KEY`,
  // `CLOUDFLARE_EMAIL`) is ambient state that does NOT belong to this
  // profile and must be cleared before we layer the profile's own values
  // back on below. Otherwise an exported `CLOUDFLARE_ACCOUNT_ID` (a very
  // common wrangler setup, and the exact "workaround" users reach for)
  // silently overrides the profile's account: wrangler keeps using the
  // profile's OAuth/token credential but routes account-scoped operations
  // (KV `--namespace-id`, R2, D1, ...) to the LEAKED account. The damage is
  // invisible for symmetric read/write pairs — `kv key put` and a follow-up
  // `kv key get` both hit the same wrong account, so the CLI reports success
  // and reads the value back — while the value never lands in the account
  // the user's Worker is actually bound to. Strip them here so the only
  // identity in play is the one we set from the resolved profile.
  delete env.CLOUDFLARE_ACCOUNT_ID;
  delete env.CLOUDFLARE_API_TOKEN;
  delete env.CLOUDFLARE_API_KEY;
  delete env.CLOUDFLARE_EMAIL;

  // Tell the `wrangler` PATH shim (if installed) to step aside: every command
  // we spawn here is already isolated to the resolved profile, so a bare
  // `wrangler` inside this subprocess (or inside an `exec` subshell) must run
  // the real binary, not be re-blocked. Without this the shim would recurse.
  env.WA_PASSTHROUGH = '1';

  applyKeyringEnv(env, keyring);

  if (extraPathDir) {
    env.PATH = `${extraPathDir}${path.delimiter}${env.PATH || ''}`;
  }

  env.HOME = shadow;
  env.WRANGLER_PROFILE = profile;
  env.WRANGLER_ACCOUNT = profile;
  env.WRANGLER_ACCOUNT_REAL_HOME = realHome;
  env.WRANGLER_REGISTRY_PATH = path.join(realHome, '.wrangler', 'registry');
  env.WRANGLER_LOG_PATH = path.join(realHome, '.wrangler', 'logs');
  env.WRANGLER_SEND_METRICS = 'false';
  if (!env.WA_TEST_OUT) {
    env.WA_TEST_OUT = path.join(shadow, '.wrangler', 'wa-test-out.json');
  }

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
  const cacheRoot = profileDir || (profileCfg ? path.dirname(profileCfg) : null);
  if (cacheRoot) {
    const cacheDir = path.join(cacheRoot, 'cache');
    try {
      fs.mkdirSync(cacheDir, { recursive: true });
    } catch (err) {
      process.stderr.write(
        `[wrangler-accounts] could not create per-profile cache dir ${cacheDir}: ${err.message}\n`,
      );
    }
    env.WRANGLER_CACHE_DIR = cacheDir;
  }

  if (apiToken) {
    env.CLOUDFLARE_API_TOKEN = apiToken;
  }

  if (accountId) {
    env.CLOUDFLARE_ACCOUNT_ID = accountId;
  }

  if (cloudflaredPath) {
    env.CLOUDFLARED_PATH = cloudflaredPath;
  }
  return env;
}


/**
 * CLOUDFLARE_AUTH_USE_KEYRING handling.
 *
 * Shadow HOME runs force it to the exact string "false" (wrangler's boolean
 * env parser throws on anything else): every shadow profile looks like
 * wrangler's `default` profile, so keyring encryption there would share one
 * key across profiles and write `default.enc` into the throw-away shadow dir.
 * Encrypted native profiles need "true" so wrangler reads `<name>.enc` even
 * when the user's global keyring preference is off.
 *
 * The user's original value is kept in WA_ORIG_AUTH_USE_KEYRING so the cf
 * wrapper inside `exec` can hand cf the setting the user chose.
 */
function applyKeyringEnv(env, keyring) {
  if (keyring === null || keyring === undefined) return env;
  if (env.WA_ORIG_AUTH_USE_KEYRING === undefined && env.CLOUDFLARE_AUTH_USE_KEYRING !== undefined) {
    env.WA_ORIG_AUTH_USE_KEYRING = env.CLOUDFLARE_AUTH_USE_KEYRING;
  }
  env.CLOUDFLARE_AUTH_USE_KEYRING = keyring;
  return env;
}

function stripInheritedCredentials(env) {
  delete env.CLOUDFLARE_ACCOUNT_ID;
  delete env.CLOUDFLARE_API_TOKEN;
  delete env.CLOUDFLARE_API_KEY;
  delete env.CLOUDFLARE_EMAIL;
  return env;
}

function ensureCacheDir(profileDir) {
  if (!profileDir) return null;
  const cacheDir = path.join(profileDir, 'cache');
  try {
    fs.mkdirSync(cacheDir, { recursive: true });
  } catch (err) {
    process.stderr.write(
      `[wrangler-accounts] could not create per-profile cache dir ${cacheDir}: ${err.message}\n`,
    );
  }
  return cacheDir;
}

/**
 * Environment for a native-profile run: the REAL HOME (wrangler finds the
 * profile in its own store via --profile), with the same credential hygiene
 * as the shadow backend: inherited Cloudflare credentials stripped, the
 * profile's own account id re-exported, per-profile WRANGLER_CACHE_DIR.
 */
function buildNativeEnv({
  realHome,
  profile,
  profileDir = null,
  accountId = null,
  apiToken = null,
  baseEnv = process.env,
  cloudflaredPath = null,
  encrypted = false,
}) {
  const env = stripInheritedCredentials({ ...baseEnv });
  env.WA_PASSTHROUGH = '1';
  env.HOME = realHome;
  env.WRANGLER_PROFILE = profile;
  env.WRANGLER_ACCOUNT = profile;
  env.WRANGLER_SEND_METRICS = 'false';
  if (encrypted) applyKeyringEnv(env, 'true');
  const cacheDir = ensureCacheDir(profileDir);
  if (cacheDir) env.WRANGLER_CACHE_DIR = cacheDir;
  if (apiToken) env.CLOUDFLARE_API_TOKEN = apiToken;
  if (accountId) env.CLOUDFLARE_ACCOUNT_ID = accountId;
  if (cloudflaredPath) env.CLOUDFLARED_PATH = cloudflaredPath;
  return env;
}

/**
 * Root-level directories to bind in a bound shadow. wrangler matches a
 * binding only for the bound dir itself or its descendants, so binding `/`
 * plus every top-level entry covers any cwd on the machine.
 */
function rootBindingDirs() {
  const dirs = [path.parse(process.cwd()).root];
  try {
    for (const entry of fs.readdirSync(dirs[0])) dirs.push(path.join(dirs[0], entry));
  } catch {
    /* fall back to cwd only */
  }
  dirs.push(process.cwd());
  return [...new Set(dirs)];
}

/**
 * Shadow HOME for a NATIVE profile, used where `--profile` cannot be passed
 * (`wrangler whoami`, an `exec` subshell, `npm run deploy`, ...):
 *   .wrangler/config/<name>.toml|.enc -> symlinks to the native files (so
 *       token refreshes and re-encryption write through to the real store)
 *   .wrangler/profiles/directory-bindings.json -> every dir bound to <name>
 * so a bare `wrangler` anywhere resolves to this profile and nothing else.
 * runBoundShadow adds .wrangler/config/default.toml with the same
 * credentials for wrangler < 4.149 (see legacy-auth.js).
 */
function createBoundShadowHome({ realHome, nativeName, nativeFiles, label = 'wa' }) {
  const shadow = createShadowHome({ realHome, profileCfg: null, label });
  const configDir = path.join(shadow, '.wrangler', 'config');
  // createShadowHome writes an empty default.toml placeholder; drop it.
  // runBoundShadow puts the profile's own credentials there for old wrangler.
  try {
    fs.unlinkSync(path.join(configDir, 'default.toml'));
  } catch {
    /* already gone */
  }
  for (const target of [nativeFiles.toml, nativeFiles.enc]) {
    if (target && fs.existsSync(target)) {
      fs.symlinkSync(target, path.join(configDir, path.basename(target)));
    }
  }
  const bindings = {};
  for (const dir of rootBindingDirs()) bindings[dir] = nativeName;
  const bindingsPath = path.join(shadow, '.wrangler', 'profiles', 'directory-bindings.json');
  fs.mkdirSync(path.dirname(bindingsPath), { recursive: true });
  fs.writeFileSync(bindingsPath, JSON.stringify(bindings, null, 2));
  return shadow;
}

function spawnAndReport(command, args, { env, captureStdout }) {
  const result = spawnSync(command, args, {
    stdio: captureStdout ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    env,
    encoding: 'utf8',
  });
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

/** Run a command for a native profile with the real HOME (no shadow). */
function runNative({ command, args, captureStdout = false, ...envArgs }) {
  return spawnAndReport(command, args, { env: buildNativeEnv(envArgs), captureStdout });
}

/** Run a command for a native profile inside a bound shadow HOME. */
function runBoundShadow({
  profile,
  nativeName,
  nativeFiles,
  profileDir = null,
  realHome,
  command,
  args,
  accountId = null,
  baseEnv = process.env,
  captureStdout = false,
  cloudflaredPath = null,
  encrypted = false,
  prepareShadow = null,
}) {
  const shadow = createBoundShadowHome({ realHome, nativeName, nativeFiles, label: `wa-${profile}` });
  let legacy = null;
  try {
    // wrangler < 4.149 ignores the binding and only reads default.toml.
    legacy = provideLegacyDefaultToml({
      configDir: path.join(shadow, '.wrangler', 'config'),
      nativeName,
      nativeFiles,
      env: baseEnv,
    });
    const extraPathDir = prepareShadow ? prepareShadow(shadow) : null;
    const env = buildIsolatedEnv({
      shadow,
      realHome,
      profile,
      profileDir,
      accountId,
      baseEnv,
      cloudflaredPath,
      keyring: encrypted ? 'true' : 'false',
      extraPathDir,
    });
    return withSignalsDeferred(() => spawnAndReport(command, args, { env, captureStdout }));
  } finally {
    try {
      if (legacy) legacy.syncBack();
    } catch (err) {
      process.stderr.write(`[wrangler-accounts] could not save the refreshed token for '${nativeName}': ${err.message}\n`);
    }
    cleanupShadow(shadow);
  }
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
  profileDir = null,
  realHome,
  command,
  args,
  apiToken = null,
  accountId = null,
  baseEnv = process.env,
  captureStdout = false,
  cloudflaredPath = null,
  prepareShadow = null,
}) {
  const shadow = createShadowHome({
    realHome,
    profileCfg,
    label: `wa-${profile}`,
  });
  let extraPathDir = null;
  try {
    extraPathDir = prepareShadow ? prepareShadow(shadow) : null;
  } catch (err) {
    cleanupShadow(shadow);
    throw err;
  }
  const env = buildIsolatedEnv({
    extraPathDir,
    shadow,
    realHome,
    profile,
    profileCfg,
    profileDir,
    apiToken,
    accountId,
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
  createBoundShadowHome,
  cleanupShadow,
  buildIsolatedEnv,
  buildNativeEnv,
  applyKeyringEnv,
  stripInheritedCredentials,
  runIsolated,
  runNative,
  runBoundShadow,
};
