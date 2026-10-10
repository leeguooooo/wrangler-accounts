#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { spawnSync } = require("child_process");

const {
  expandHome,
  resolvePath,
  detectConfigPath,
  detectProfilesDir,
} = require("../lib/paths");
const {
  ensureDir,
  isValidName,
  isBackupName,
  listProfiles,
  getProfileType,
  fileHash,
  readExpirationTime,
  readSessionState,
  readTokenSessionState,
  filesEqual,
  writeMeta,
  readMeta,
  getActiveProfile,
  getDefaultProfile,
  setDefaultProfile,
  unsetDefaultProfile,
  timestampForFile,
  findMatchingProfile,
  saveProfile: saveProfileImpl,
  saveTokenProfile: saveTokenProfileImpl,
  readTokenCredentials,
  resolveTokenCredentials,
  protectTokenProfile,
  unprotectTokenProfile,
  setProfileNote: setProfileNoteImpl,
  removeProfile: removeProfileImpl,
  getProfileBackend,
  updateMeta,
} = require("../lib/profile-store");
const native = require("../lib/native");
const {
  MigrateError,
  UNSUPPORTED_HINT,
  migrateProfile,
  unmigrateProfile,
  protectOAuthProfile,
  unprotectOAuthProfile,
} = require("../lib/migrate");
const {
  findCloudflareCf,
  isCloudflareCf,
  cfProfileExists,
  cfProfileFiles,
  isCfCommand,
} = require("../lib/cf");
const { backendName } = require("../lib/secret-store");
const {
  parseWranglerWhoamiOutput,
  getWranglerAuthPath,
  canInspectIdentity,
  getCurrentIdentity,
  getMetaIdentity,
  identitiesMatch,
  describeIdentity,
  findProfilesByIdentity,
} = require("../lib/identity");
const { resolveProfile, ResolveError } = require("../lib/resolve");
const {
  runIsolated,
  runNative,
  runBoundShadow,
  buildIsolatedEnv,
  buildNativeEnv,
  cleanupShadow,
} = require("../lib/isolation");
const {
  getShimDir,
  findRealWrangler,
  installShim,
  installCfShim,
  isCfShimInstalled,
  uninstallShim,
  shimStatus,
  detectShell,
  detectShellRc,
  pathLine,
  applyToRc,
  removeFromRc,
} = require("../lib/shim");

const MANAGEMENT_SUBCOMMANDS = new Set([
  "list",
  "status",
  "save",
  "sync",
  "sync-active",
  "sync-default",
  "login",
  "remove",
  "default",
  "token-add",
  "protect",
  "unprotect",
  "note",
  "whoami",
  "gc",
  "use",
  "exec",
  "shim",
  "migrate",
  "unmigrate",
  "__is-cloudflare-cf",
]);

function findCloudflared() {
  const dirs = (process.env.PATH || "").split(path.delimiter);
  for (const d of dirs) {
    if (!d) continue;
    const candidate = path.join(d, "cloudflared");
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {}
  }
  return null;
}

function warnDeprecated(oldName, replacement) {
  process.stderr.write(
    `[wrangler-accounts] '${oldName}' is deprecated. Use '${replacement}' instead. See README for details.\n`,
  );
}

// Parse a short duration string like "1h", "30m", "7d", "90s" into ms.
function parseDuration(s) {
  const m = String(s).trim().match(/^(\d+)\s*([smhd])?$/);
  if (!m) throw new Error(`Invalid duration: ${s}`);
  const n = parseInt(m[1], 10);
  const unit = m[2] || "s";
  const mult = { s: 1000, m: 60000, h: 3600000, d: 86400000 }[unit];
  return n * mult;
}

// Format an ISO expiration timestamp as a compact relative + absolute
// string, e.g. "in 14d (2026-04-24)" or "30d ago (2026-03-11)".
function formatExpiry(iso, now = Date.now()) {
  if (!iso) return "(unknown)";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "(unknown)";
  const delta = then - now;
  const abs = Math.abs(delta);
  const day = 86400000;
  const hour = 3600000;
  const minute = 60000;
  let relative;
  if (abs >= day) {
    relative = `${Math.floor(abs / day)}d`;
  } else if (abs >= hour) {
    relative = `${Math.floor(abs / hour)}h`;
  } else {
    relative = `${Math.max(1, Math.floor(abs / minute))}m`;
  }
  const date = iso.slice(0, 10); // YYYY-MM-DD
  return delta >= 0 ? `in ${relative} (${date})` : `${relative} ago (${date})`;
}

// Thin wrappers that turn thrown errors into die() calls, so the lib
// functions remain pure / testable without depending on process.exit.
function saveProfile(...args) {
  try { return saveProfileImpl(...args); }
  catch (err) { die(err.message); }
}
function removeProfile(...args) {
  try { return removeProfileImpl(...args); }
  catch (err) { die(err.message); }
}
function saveTokenProfile(...args) {
  try { return saveTokenProfileImpl(...args); }
  catch (err) { die(err.message); }
}

let outputJson = false;

function die(message, exitCode = 1) {
  if (outputJson) {
    console.error(JSON.stringify({ error: message }, null, 2));
  } else {
    console.error(`Error: ${message}`);
  }
  process.exit(exitCode);
}

function profileTypeForName(profilesDir, name) {
  return getProfileType(path.join(profilesDir, name));
}

function tokenProfileExists(profilesDir, name) {
  return profileTypeForName(profilesDir, name) !== null;
}

function noProfileMessage() {
  return [
    'No profile specified. Options:',
    '  - wrangler-accounts --profile <name> ...',
    '  - WRANGLER_PROFILE=<name> wrangler-accounts ...',
    '  - wrangler-accounts default <name>   (set a persistent default)',
  ].join('\n');
}

function resolveProfileAny({
  cliProfile,
  positional,
  env,
  profilesDir,
  managementSubcommands,
}) {
  try {
    return resolveProfile({
      cliProfile,
      positional,
      env,
      profilesDir,
      managementSubcommands,
    });
  } catch (err) {
    if (!(err instanceof ResolveError)) throw err;
    if (err.code === "INVALID_NAME") throw err;
  }

  if (cliProfile) {
    if (!isValidName(cliProfile)) {
      throw new ResolveError(`Invalid profile name: ${cliProfile}`, "INVALID_NAME");
    }
    if (tokenProfileExists(profilesDir, cliProfile)) {
      return { name: cliProfile, source: "cli" };
    }
    throw new ResolveError(`Profile not found: ${cliProfile}`, "PROFILE_NOT_FOUND");
  }

  if (positional && !managementSubcommands.has(positional)) {
    if (isValidName(positional) && tokenProfileExists(profilesDir, positional)) {
      return { name: positional, source: "positional" };
    }
  }

  const envProfile = env && env.WRANGLER_PROFILE;
  if (envProfile && envProfile.length) {
    if (!isValidName(envProfile)) {
      throw new ResolveError(`Invalid profile name: ${envProfile}`, "INVALID_NAME");
    }
    if (tokenProfileExists(profilesDir, envProfile)) {
      return { name: envProfile, source: "env" };
    }
    throw new ResolveError(`Profile not found: ${envProfile}`, "PROFILE_NOT_FOUND");
  }

  const def = getDefaultProfile(profilesDir);
  if (def) {
    if (!isValidName(def)) {
      throw new ResolveError(`Invalid profile name: ${def}`, "INVALID_NAME");
    }
    if (tokenProfileExists(profilesDir, def)) {
      return { name: def, source: "default" };
    }
    throw new ResolveError(`Profile not found: ${def}`, "PROFILE_NOT_FOUND");
  }

  throw new ResolveError(noProfileMessage(), "NO_PROFILE");
}

function runAnonymousTokenMode({
  command,
  args,
  captureStdout = false,
}) {
  return runIsolated({
    profile: "token-env",
    profileCfg: null,
    profileDir: null,
    realHome: os.homedir(),
    command,
    args,
    apiToken: process.env.CLOUDFLARE_API_TOKEN || null,
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID || null,
    baseEnv: process.env,
    captureStdout,
    cloudflaredPath: findCloudflared(),
  });
}

// ---------------------------------------------------------------------------
// Native-profile (wrangler --profile) and cf helpers.

function nativeContext(profilesDir, name) {
  const profileDir = path.join(profilesDir, name);
  const meta = readMeta(profileDir) || {};
  const nativeName = meta.nativeName || null;
  const files = nativeName ? native.nativePaths(nativeName) : null;
  const state = nativeName ? native.nativeState(nativeName) : "missing";
  return {
    profileDir,
    meta,
    nativeName,
    files,
    state,
    accountId: getMetaIdentity(meta)?.accountId || null,
  };
}

let nativeProbeResult = null;
function nativeProbe(profilesDir) {
  if (!nativeProbeResult) nativeProbeResult = native.probeNativeSupport({ profilesDir });
  return nativeProbeResult;
}

function nativeSessionState(ctx) {
  if (ctx.state === "plaintext") return readSessionState(ctx.files.toml);
  return {
    expirationTime: null,
    expired: null,
    hasRefreshToken: false,
    effective: ctx.state === "encrypted" ? "encrypted" : "missing",
  };
}

function ensureNativeUsable(name, ctx) {
  if (ctx.state === "missing") {
    die(
      [
        `wrangler has no credentials for native profile '${ctx.nativeName}' (${ctx.files.toml}).`,
        `wrangler 里找不到 '${ctx.nativeName}' 的凭据（可能被 wrangler auth delete / keyring disable 删掉了）。`,
        `Re-authenticate: wrangler-accounts login ${name} --force`,
      ].join("\n"),
      3,
    );
  }
}

function cfMissingMessage(found) {
  if (found && found.other) {
    return [
      `The 'cf' on PATH (${found.other}) is not Cloudflare's CLI (it looks like Cloud Foundry), so wrangler-accounts will not run it.`,
      `PATH 里的 cf（${found.other}）不是 Cloudflare 的 CLI（看起来是 Cloud Foundry），不会代为执行。`,
      `Install Cloudflare's: npm i -g cf   (needs Node.js 22+; it also installs a 'cloudflare' command)`,
    ].join("\n");
  }
  return [
    "Cloudflare's 'cf' CLI is not installed. 未安装 Cloudflare 的 cf 命令行。",
    "Install it: npm i -g cf   (needs Node.js 22+)",
  ].join("\n");
}

function cfProfileNameFor(name, meta) {
  return (meta && (meta.cfProfile || meta.nativeName)) || native.suggestNativeName(name) || name;
}

function cfLoginGuidance(name, cfName) {
  return [
    `cf has no login for profile '${cfName}' yet — cf and wrangler keep separate logins.`,
    `cf 还没有 '${cfName}' 的登录（cf 和 wrangler 的登录是分开的）。先运行一次：`,
    ``,
    `  cf auth create ${cfName}`,
    ``,
    `Then retry: wrangler-accounts --profile ${name} cf ...`,
    `(Token profiles need no cf login: wrangler-accounts token-add <name> <api-token> <account-id>)`,
  ].join("\n");
}

function findCf() {
  return findCloudflareCf({ pathEnv: process.env.PATH || "", skipDirs: [getShimDir(process.env)] });
}

/**
 * Run Cloudflare's cf for a resolved profile. Token profiles: the token and
 * account id go in the environment. OAuth profiles: cf's own profile with the
 * same name via --profile (cf and wrangler use different OAuth clients, so
 * wrangler's credentials are never handed to cf).
 */
function runCfForProfile({ resolved, profilesDir, args, cfPath = null }) {
  let bin = cfPath;
  if (!bin) {
    const found = findCf();
    if (!found || !found.path) die(cfMissingMessage(found), 2);
    bin = found.path;
  }
  const profileDir = path.join(profilesDir, resolved.name);
  const type = getProfileType(profileDir);
  const meta = readMeta(profileDir) || {};
  if (type === "token") {
    let creds;
    try {
      creds = resolveTokenCredentials(profileDir);
    } catch (err) {
      die(`Token profile '${resolved.name}' is protected but its token could not be read: ${err.message}`);
    }
    if (!creds || !creds.apiToken) die(`Token profile '${resolved.name}' is missing token.json credentials.`);
    return runNative({
      command: bin,
      args,
      realHome: os.homedir(),
      profile: resolved.name,
      profileDir,
      apiToken: creds.apiToken,
      accountId: creds.accountId || null,
    });
  }
  const cfName = cfProfileNameFor(resolved.name, meta);
  const sub = native.firstPositional(args);
  const authSub = sub === "auth" ? native.firstPositional(args.slice(args.indexOf("auth") + 1)) : null;
  let cfArgs = args;
  // `cf auth whoami` takes --profile; the other `cf auth` commands are global.
  if (sub !== "auth" || authSub === "whoami") {
    if (!cfProfileExists(cfName)) die(cfLoginGuidance(resolved.name, cfName), 2);
    cfArgs = native.withProfileFlag(args, cfName);
  }
  return runNative({
    command: bin,
    args: cfArgs,
    realHome: os.homedir(),
    profile: resolved.name,
    profileDir,
    accountId: getMetaIdentity(meta)?.accountId || null,
  });
}

function shQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/**
 * Inside `exec <oauth-profile>`, a bare `cf` must not fall back to cf's own
 * default login. Put a wrapper first on PATH that adds --profile <name> (or
 * explains how to create that cf login). No-op when Cloudflare's cf is not
 * installed — Cloud Foundry's cf is left completely alone.
 */
function cfWrapperPreparer(name, meta) {
  const found = findCf();
  if (!found || !found.path) return null;
  const cfName = cfProfileNameFor(name, meta);
  const files = cfProfileFiles(cfName);
  return (shadow) => {
    const binDir = path.join(shadow, ".wa-bin");
    fs.mkdirSync(binDir, { recursive: true });
    const guidance = cfLoginGuidance(name, cfName)
      .split("\n")
      .map((l) => `  echo ${shQuote(l)} >&2`)
      .join("\n");
    const script = `#!/bin/sh
# wrangler-accounts: cf for profile ${name} (exec subshell)
if [ -n "\${WA_ORIG_AUTH_USE_KEYRING+x}" ]; then
  CLOUDFLARE_AUTH_USE_KEYRING="$WA_ORIG_AUTH_USE_KEYRING"; export CLOUDFLARE_AUTH_USE_KEYRING
else
  unset CLOUDFLARE_AUTH_USE_KEYRING
fi
for _a in "$@"; do
  case "$_a" in --profile|--profile=*) exec ${shQuote(found.path)} "$@" ;; esac
done
case "\${1:-} \${2:-}" in
  "auth whoami"*) ;;
  " "* | "auth "* | "-v "* | "--version "* | "-h "* | "--help "*) exec ${shQuote(found.path)} "$@" ;;
esac
if [ ! -e ${shQuote(files.json)} ] && [ ! -e ${shQuote(files.enc)} ]; then
${guidance}
  exit 2
fi
exec ${shQuote(found.path)} "$@" --profile ${shQuote(cfName)}
`;
    for (const bin of ["cf", "cloudflare"]) {
      const p = path.join(binDir, bin);
      fs.writeFileSync(p, script, { mode: 0o755 });
      fs.chmodSync(p, 0o755);
    }
    return binDir;
  };
}

/** Is `cmd` (as given to exec) Cloudflare's cf? Never true for Cloud Foundry. */
function resolveExecCf(cmd) {
  if (!isCfCommand(cmd)) return null;
  if (cmd.includes("/")) return isCloudflareCf(cmd) ? cmd : null;
  const found = findCf();
  if (!found || !found.path) return null;
  // `exec x -- cf` means the first cf on PATH; only take over when that one is Cloudflare's.
  if (path.basename(cmd) === "cf" && found.via !== "cf") return null;
  return found.path;
}

function nativeLoginGuidance(name, first) {
  return [
    `'wrangler ${first}' cannot target a named wrangler profile — it would act on wrangler's DEFAULT login.`,
    `'wrangler ${first}' 不能指定 profile，会作用在 wrangler 的默认登录上，已拦下。`,
    first === "login"
      ? `Re-authenticate this profile with: wrangler-accounts login ${name} --force`
      : `Remove this profile with: wrangler-accounts remove ${name} --delete-native`,
  ].join("\n");
}

function runNativeProfileCommand({ resolved, profilesDir, command, args, captureStdout }) {
  const ctx = nativeContext(profilesDir, resolved.name);
  ensureNativeUsable(resolved.name, ctx);
  if (ctx.state === "plaintext") {
    const session = readSessionState(ctx.files.toml);
    if (session.effective === "expired") {
      die(
        `Profile '${resolved.name}' has expired Wrangler OAuth credentials and no refresh_token to renew them (expiration_time: ${session.expirationTime}). Run 'wrangler-accounts login ${resolved.name}' to re-authenticate.`,
        3,
      );
    }
  }
  const encrypted = ctx.state === "encrypted";
  const common = {
    profile: resolved.name,
    profileDir: ctx.profileDir,
    realHome: os.homedir(),
    accountId: ctx.accountId,
    baseEnv: process.env,
    captureStdout,
    cloudflaredPath: findCloudflared(),
  };
  const boundShadow = (cmd, cmdArgs, prepareShadow = null) =>
    runBoundShadow({
      ...common,
      nativeName: ctx.nativeName,
      nativeFiles: ctx.files,
      command: cmd,
      args: cmdArgs,
      encrypted,
      prepareShadow,
    });

  if (command !== "wrangler") {
    // exec: a subshell / arbitrary command. A bound shadow makes every bare
    // `wrangler` (including `npx wrangler` / `npm run deploy`) resolve to
    // this profile without needing --profile.
    return boundShadow(command, args, captureStdout ? null : cfWrapperPreparer(resolved.name, ctx.meta));
  }
  const first = native.firstPositional(args);
  if (first === "login" || first === "logout") die(nativeLoginGuidance(resolved.name, first), 2);
  // `wrangler whoami` rejects --profile; resolve it through the bound shadow.
  // A wrangler on PATH older than 4.149 has no --profile at all: it reads the
  // bound shadow's default.toml instead.
  if (first === "whoami" || !nativeProbe(profilesDir).supported) return boundShadow("wrangler", args);
  let wranglerArgs = native.withProfileFlag(args, ctx.nativeName);
  if (first === "auth") {
    const rest = args.slice(args.indexOf("auth") + 1);
    // Only `auth token` takes --profile; the other auth commands are global.
    wranglerArgs = native.firstPositional(rest) === "token" ? native.withProfileFlag(args, ctx.nativeName) : args;
  }
  return runNative({ ...common, command: "wrangler", args: wranglerArgs, encrypted });
}

function runResolvedProfileCommand({
  resolved,
  profilesDir,
  command,
  args,
  captureStdout = false,
}) {
  const profileDir = path.join(profilesDir, resolved.name);
  const profileType = getProfileType(profileDir);

  if (profileType === "oauth" && getProfileBackend(profileDir) === "native") {
    return runNativeProfileCommand({ resolved, profilesDir, command, args, captureStdout });
  }

  if (profileType === "token") {
    let creds;
    try {
      creds = resolveTokenCredentials(profileDir);
    } catch (err) {
      const stored = readTokenCredentials(profileDir) || {};
      die(
        `Token profile '${resolved.name}' is protected in the ${stored.credentialStore || "OS"} store, but its token could not be read: ${err.message}\n` +
          `Usually the keychain is locked or there is no desktop session (SSH, headless). Unlock it and retry.\n` +
          `If the item was deleted, re-add the profile: wrangler-accounts token-add ${resolved.name} <api-token> <account-id> --force [--protect]`,
      );
    }
    if (!creds || !creds.apiToken) {
      die(`Token profile '${resolved.name}' is missing token.json credentials.`);
    }
    return runIsolated({
      profile: resolved.name,
      profileCfg: null,
      profileDir,
      realHome: os.homedir(),
      command,
      args,
      apiToken: creds.apiToken,
      accountId: creds.accountId || null,
      baseEnv: process.env,
      captureStdout,
      cloudflaredPath: findCloudflared(),
    });
  }

  const profileCfg = path.join(profileDir, "config.toml");
  const session = readSessionState(profileCfg);
  if (session.effective === 'expired') {
    die(
      `Profile '${resolved.name}' has expired Wrangler OAuth credentials and no refresh_token to renew them (expiration_time: ${session.expirationTime}). Run 'wrangler-accounts login ${resolved.name}' to re-authenticate.`,
      3
    );
  }

  // Account-scoped commands (`d1 create`, `r2`, `kv`, ...) need an explicit
  // account id; an OAuth token alone is not enough. buildEnv() deliberately
  // strips any inherited CLOUDFLARE_ACCOUNT_ID, so unless we put the profile's
  // own account back, wrangler falls through to whatever the project config
  // says — including a literal `YOUR_CLOUDFLARE_ACCOUNT_ID` placeholder — or
  // stops to ask interactively, which fails outright under an agent or CI.
  // The id is the one recorded at login time and shown by `list --deep`.
  const oauthAccountId = getMetaIdentity(readMeta(profileDir))?.accountId || null;

  return runIsolated({
    profile: resolved.name,
    profileCfg,
    profileDir,
    realHome: os.homedir(),
    command,
    args,
    accountId: oauthAccountId,
    baseEnv: process.env,
    captureStdout,
    cloudflaredPath: findCloudflared(),
    prepareShadow:
      command !== "wrangler" && !captureStdout
        ? cfWrapperPreparer(resolved.name, readMeta(profileDir))
        : null,
  });
}

function printHelp(exitCode = 0) {
  const text = `wrangler-accounts - manage multiple Wrangler login profiles

Usage:
  wrangler-accounts <command> [options]

Commands:
  list
  status
  login <name>
  save <name>
  token-add <name> <api-token> <account-id> [--protect]
  protect <name> | --all  Move token profile secrets into the OS keychain
                          OAuth profiles: encrypted at rest by wrangler's keyring support (wrangler 4.149+)
  unprotect <name> | --all
  migrate <name> | --all  Move OAuth profiles into wrangler's native profile store
                          [--as <wrangler-name>] [--dry-run] [--force] [--no-verify]
  unmigrate <name> | --all [--keep-native]
  sync <name>
  sync-active
  sync-default
  default [name | --unset]
  whoami [--profile <name>]
  exec <name> [-- <cmd> [args]]
  shim [install | uninstall | status] [--apply]
  remove <name>
  remove <name> --delete-native   Also delete the native wrangler profile
  --profile <name> cf <args>      Run Cloudflare's cf CLI under a profile

Deprecated:
  use <name>              Prints migration guidance; use 'default' or '--profile' instead

Options:
  -c, --config <path>     Wrangler config path
  -p, --profiles <path>   Profiles directory
  --json                  JSON output for all commands
  --plain                 Plain output for list (one name per line)
  --include-backups       Include backup profiles in list/status
  -f, --force             Overwrite existing profile on save
  --protect               token-add: store the token in the OS keychain, not token.json
  --all                   protect/unprotect: every token profile
                          (1.9+: every profile; migrate/unmigrate: every OAuth profile)
  --as <name>             migrate: wrangler profile name to use
  --dry-run               migrate: show what would happen, change nothing
  -h, --help              Show help
  -v, --version           Print version

Env:
  WRANGLER_CONFIG_PATH
  WRANGLER_ACCOUNTS_DIR
  WRANGLER_ACCOUNTS_SHIM_DIR
  WRANGLER_ACCOUNTS_PROTECT_TOKENS=1   token-add defaults to --protect
  WRANGLER_ACCOUNTS_NATIVE=0|1         force native wrangler profile support off/on
  XDG_CONFIG_HOME

Examples:
  wrangler-accounts save work
  wrangler-accounts default work
  wrangler-accounts --profile work deploy
  wrangler-accounts shim install --apply
  wrangler-accounts migrate work            # native wrangler profile, same commands
  wrangler-accounts protect work            # encrypt OAuth credentials (keychain)
  wrangler-accounts --profile work cf dns records list --zone example.com
`;
  console.log(text);
  process.exit(exitCode);
}

function parseArgs(argv) {
  const opts = {
    json: false,
    force: false,
    includeBackups: false,
  };
  const rest = [];
  let sawFirstNonFlag = false;
  let sawManagementSubcommand = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    // POSIX: `--` ends flag parsing. Everything after is a positional,
    // including `-c` / `--profile` etc. This is critical for `exec`:
    // `wrangler-accounts exec work -- sh -c "echo $X"` must not have -c
    // consumed as --config.
    if (arg === "--") {
      rest.push(arg);
      for (let j = i + 1; j < argv.length; j += 1) {
        rest.push(argv[j]);
      }
      return { opts, rest };
    }

    // Once we've seen the first non-flag token AND it was NOT a management
    // subcommand, stop parsing our flags — everything from here is
    // forwarded to wrangler verbatim (including wrangler's own --env,
    // --json, etc.).
    if (sawFirstNonFlag && !sawManagementSubcommand) {
      // --profile / -p must not be forwarded to wrangler; absorb it here so
      // users can write it after the wrangler subcommand:
      //   wrangler-accounts deploy --config wrangler.prod.toml --profile myprof
      if ((arg === "--profile" || arg === "-p") && i + 1 < argv.length) {
        opts.profile = argv[i + 1];
        i += 1;
        continue;
      }
      rest.push(arg);
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      opts.help = true;
    } else if (arg === "--version" || arg === "-v" || arg === "-V") {
      opts.version = true;
    } else if (arg === "--json") {
      opts.json = true;
    } else if (arg === "--plain") {
      opts.plain = true;
    } else if (arg === "--include-backups") {
      opts.includeBackups = true;
    } else if (arg === "--force" || arg === "-f") {
      opts.force = true;
    } else if (arg === "--protect" || arg === "--keychain") {
      opts.protect = true;
    } else if (arg === "--all") {
      opts.all = true;
    } else if (arg === "--unset") {
      opts.unset = true;
    } else if (arg === "--apply") {
      opts.apply = true;
    } else if (arg === "--deep" || arg === "--verify") {
      opts.deep = true;
    } else if (arg === "--dry-run") {
      opts.dryRun = true;
    } else if (arg === "--no-verify") {
      opts.noVerify = true;
    } else if (arg === "--keep-native") {
      opts.keepNative = true;
    } else if (arg === "--delete-native") {
      opts.deleteNative = true;
    } else if (arg === "--clear") {
      opts.clear = true;
    } else if (arg === "--as") {
      opts.as = argv[i + 1];
      if (!opts.as) die("Missing value for --as");
      i += 1;
    } else if (arg === "--config" || arg === "-c") {
      opts.config = argv[i + 1];
      if (!opts.config) die("Missing value for --config");
      i += 1;
    } else if (arg === "--profile" || arg === "-p") {
      // NOTE: -p now means --profile (v1.0 breaking change vs 0.1.x,
      // where -p meant --profiles). Use --profiles long form for the
      // profiles directory path.
      opts.profile = argv[i + 1];
      if (!opts.profile) die("Missing value for --profile");
      i += 1;
    } else if (arg === "--profiles") {
      opts.profiles = argv[i + 1];
      if (!opts.profiles) die("Missing value for --profiles");
      i += 1;
    } else if (arg === "--older-than") {
      opts.olderThan = argv[i + 1];
      if (!opts.olderThan) die("Missing value for --older-than");
      i += 1;
    } else {
      // Non-flag token.
      if (!sawFirstNonFlag) {
        sawFirstNonFlag = true;
        if (MANAGEMENT_SUBCOMMANDS.has(arg)) {
          sawManagementSubcommand = true;
        }
      }
      rest.push(arg);
    }
  }
  return { opts, rest };
}

function runWranglerLogin() {
  const result = spawnSync("wrangler", ["login"], {
    stdio: "inherit",
    env: { ...process.env, WA_PASSTHROUGH: "1" },
  });
  if (result.error) {
    die(`Failed to run 'wrangler login': ${result.error.message}`);
  }
  if (result.status !== 0) {
    die(`'wrangler login' exited with code ${result.status}`);
  }
}

function syncProfile(name, configPath, profilesDir, identity) {
  if (!isValidName(name)) {
    die(`Invalid profile name: ${name}`);
  }
  if (!fs.existsSync(configPath)) {
    die(`Config file not found: ${configPath}`);
  }

  const currentSession = readSessionState(configPath);
  if (currentSession.expired) {
    die(
      `Current Wrangler OAuth credentials have expired (expiration_time: ${currentSession.expirationTime}). Run 'wrangler login' first.`
    );
  }

  if (!identity) {
    die("Unable to identify the current Wrangler account. Make sure 'wrangler whoami' works first.");
  }

  const profileDir = path.join(profilesDir, name);
  const profileConfig = path.join(profileDir, "config.toml");
  const isNative = getProfileBackend(profileDir) === "native";
  if (!isNative && !fs.existsSync(profileConfig)) {
    die(`Profile not found: ${name}`);
  }

  const meta = readMeta(profileDir);
  const profileIdentity = getMetaIdentity(meta);
  if (profileIdentity && !identitiesMatch(identity, profileIdentity)) {
    die(
      `Current Wrangler account (${describeIdentity(identity)}) does not match profile '${name}' (${describeIdentity(
        profileIdentity
      )}).`
    );
  }

  if (isNative) {
    storeIntoNative(profilesDir, name, configPath, identity);
    return;
  }
  fs.copyFileSync(configPath, profileConfig);
  writeMeta(profileDir, name, configPath, identity);
}

/**
 * save --force / sync into a native profile: overwrite wrangler's
 * <name>.toml. An encrypted profile is refused — writing plaintext next to
 * <name>.enc would be ignored by wrangler (it reads .enc first).
 */
function storeIntoNative(profilesDir, name, configPath, identity) {
  const ctx = nativeContext(profilesDir, name);
  if (ctx.state === "encrypted") {
    die(
      [
        `Profile '${name}' is encrypted in the OS keychain (wrangler profile '${ctx.nativeName}'); refusing to overwrite it with a plaintext copy.`,
        `该 profile 已加密存放，不会用明文覆盖。可选：`,
        `  wrangler-accounts login ${name} --force      # re-authenticate, stays encrypted`,
        `  wrangler-accounts unprotect ${name}         # then save/sync, then protect again`,
      ].join("\n"),
    );
  }
  native.writeFileAtomic(ctx.files.toml, fs.readFileSync(configPath));
  updateMeta(ctx.profileDir, {
    savedAt: new Date().toISOString(),
    sourcePath: configPath,
    ...(identity ? { identity } : {}),
  });
}

/**
 * `login <name>` for a native profile: `wrangler auth create <nativeName>`
 * re-authenticates it in wrangler's own store (staying encrypted when it was),
 * then the identity is read back through a bound shadow.
 */
function loginNative(name, profilesDir, opts) {
  const ctx = nativeContext(profilesDir, name);
  const probe = nativeProbe(profilesDir);
  if (!probe.supported) {
    die(`${probe.reason}\n${UNSUPPORTED_HINT}\nOr move it back first: wrangler-accounts unmigrate ${name}`, 2);
  }
  if (!opts.force && ctx.state !== "missing") {
    const session = nativeSessionState(ctx);
    const looksHealthy = ["valid", "refreshable", "encrypted"].includes(session.effective);
    if (looksHealthy) {
      die(
        [
          `Profile '${name}' already exists and looks healthy:`,
          `  status:           ${session.effective}`,
          `  expirationTime:   ${session.expirationTime || "(none)"}`,
          `  wrangler profile: ${ctx.nativeName}`,
          ``,
          `'login' is DESTRUCTIVE — it opens a browser and overwrites the saved`,
          `profile. If you only wanted to verify the profile works, run instead:`,
          ``,
          `  wrangler-accounts whoami --profile ${name}     # fast, no network`,
          `  wrangler-accounts list --deep                  # authoritative, hits Cloudflare API`,
          ``,
          `If you really intend to re-authenticate, pass --force:`,
          ``,
          `  wrangler-accounts login ${name} --force`,
        ].join("\n"),
        1,
      );
    }
  }
  const encrypted = ctx.state === "encrypted";
  const env = buildNativeEnv({
    realHome: os.homedir(),
    profile: name,
    profileDir: ctx.profileDir,
    baseEnv: process.env,
    encrypted,
    cloudflaredPath: findCloudflared(),
  });
  // With --json, keep stdout clean for our JSON: wrangler's output goes to stderr.
  const res = spawnSync("wrangler", ["auth", "create", ctx.nativeName], {
    stdio: opts.json ? ["inherit", 2, "inherit"] : "inherit",
    env,
  });
  if (res.error) die(`Failed to run 'wrangler auth create': ${res.error.message}`);
  if (res.status !== 0) die(`'wrangler auth create ${ctx.nativeName}' exited with code ${res.status}`);

  const after = nativeContext(profilesDir, name);
  const who = runBoundShadow({
    profile: name,
    nativeName: after.nativeName,
    nativeFiles: after.files,
    profileDir: after.profileDir,
    realHome: os.homedir(),
    command: "wrangler",
    args: ["whoami"],
    baseEnv: process.env,
    captureStdout: true,
    encrypted: after.state === "encrypted",
  });
  const identity = parseWranglerWhoamiOutput(`${who.stdout || ""}\n${who.stderr || ""}`);
  if (!identity) die("Login succeeded but could not parse 'wrangler whoami' output");
  updateMeta(ctx.profileDir, { identity, savedAt: new Date().toISOString() });
  if (opts.json) {
    console.log(JSON.stringify({ command: "login", name, profilesDir, overwritten: true, identity, backend: "native", nativeName: ctx.nativeName }, null, 2));
  } else {
    console.log(`Logged in and saved profile '${name}' (${describeIdentity(identity)}) (overwritten, wrangler profile '${ctx.nativeName}')`);
  }
}

function main() {
  const argv = process.argv.slice(2);
  outputJson = argv.includes("--json");
  const { opts, rest } = parseArgs(argv);
  if (opts.help) printHelp(0);
  if (opts.version) {
    const pkg = require("../package.json");
    if (opts.json) {
      console.log(JSON.stringify({ name: pkg.name, version: pkg.version }, null, 2));
    } else {
      console.log(pkg.version);
    }
    process.exit(0);
  }

  const command = rest[0];
  if (!command) printHelp(1);

  const configPath = detectConfigPath(opts.config);
  const profilesDir = detectProfilesDir(opts.profiles);
  const includeBackups = opts.includeBackups;
  let currentIdentityResult = null;
  function loadCurrentIdentity() {
    if (currentIdentityResult === null) {
      currentIdentityResult = getCurrentIdentity(configPath);
    }
    return currentIdentityResult;
  }

  // Per-invocation isolated execution path.
  // If the first positional token is NOT a management subcommand, treat
  // the rest of argv as wrangler arguments and run them inside a shadow
  // HOME for the resolved profile.
  if (!MANAGEMENT_SUBCOMMANDS.has(command)) {
    const profileArg = opts.profile || null;
    // Positional shorthand: `wrangler-accounts work deploy` — if `work` is
    // an existing profile, use it and forward `deploy` to wrangler.
    const positional = command;

    let resolved;
    try {
      resolved = resolveProfileAny({
        cliProfile: profileArg,
        positional,
        env: process.env,
        profilesDir,
        managementSubcommands: MANAGEMENT_SUBCOMMANDS,
      });
    } catch (err) {
      if (err instanceof ResolveError) {
        if (err.code === "NO_PROFILE" && process.env.CLOUDFLARE_API_TOKEN) {
          let anonCommand = "wrangler";
          let anonArgs = rest;
          if (rest[0] === "cf") {
            const found = findCf();
            if (!found || !found.path) die(cfMissingMessage(found), 2);
            anonCommand = found.path;
            anonArgs = rest.slice(1);
          }
          const result = runAnonymousTokenMode({
            command: anonCommand,
            args: anonArgs,
          });
          process.exit(result.exitCode);
        }
        const exitCode =
          err.code === "NO_PROFILE" || err.code === "PROFILE_NOT_FOUND" ? 2 : 1;
        die(err.message, exitCode);
      }
      throw err;
    }

    // If positional was consumed as profile, drop it from wrangler argv
    const wranglerArgs = resolved.source === "positional" ? rest.slice(1) : rest;

    // `wrangler-accounts --profile x cf ...` runs Cloudflare's cf CLI.
    if (wranglerArgs[0] === "cf") {
      const result = runCfForProfile({ resolved, profilesDir, args: wranglerArgs.slice(1) });
      process.exit(result.exitCode);
    }

    const result = runResolvedProfileCommand({
      resolved,
      profilesDir,
      command: "wrangler",
      args: wranglerArgs,
    });
    process.exit(result.exitCode);
  }

  if (command === "list") {
    const profiles = listProfiles(profilesDir, { includeBackups });
    const defaultName = getDefaultProfile(profilesDir);
    const activeName = getActiveProfile(profilesDir);

    const entries = profiles.map((name) => {
      const profileDir = path.join(profilesDir, name);
      const type = getProfileType(profileDir) || "oauth";
      const cfgPath = path.join(profileDir, "config.toml");
      const backend = type === "oauth" ? getProfileBackend(profileDir) : null;
      const nctx = backend === "native" ? nativeContext(profilesDir, name) : null;
      const session =
        type === "token" ? readTokenSessionState()
        : nctx ? nativeSessionState(nctx)
        : readSessionState(cfgPath);
      const meta = readMeta(profileDir);
      const identity = getMetaIdentity(meta);
      const tokenCreds = type === "token" ? readTokenCredentials(profileDir) : null;
      let credentialStore = "file";
      if (type === "token") credentialStore = (tokenCreds && tokenCreds.credentialStore) || "file";
      else if (nctx && nctx.state === "encrypted") credentialStore = (meta && meta.credentialStore) || backendName() || "keyring";
      return {
        name,
        type,
        credentialStore,
        isDefault: name === defaultName,
        isActive: name === activeName,
        // 'valid' | 'refreshable' | 'expired' | 'unknown' | 'token'
        // | 'encrypted' (native, keyring) | 'missing' (native, credentials gone)
        status: session.effective,
        expirationTime: session.expirationTime,
        hasRefreshToken: session.hasRefreshToken,
        identity,
        description: (meta && meta.description) || null,
        verified: null,
        verifyError: null,
        backend, // 'shadow' | 'native' | null (token)
        nativeName: nctx ? nctx.nativeName : null,
        credentialPath: type === "token" ? path.join(profileDir, "token.json")
          : nctx ? (nctx.state === "encrypted" ? nctx.files.enc : nctx.files.toml)
          : cfgPath,
      };
    });

    // --deep: actually run `wrangler whoami` inside a shadow HOME for
    // each profile. This is the only authoritative check — the fast
    // status column above is derived purely from the saved
    // expiration_time, which does not tell us whether the refresh token
    // still works or whether Cloudflare has revoked the session.
    if (opts.deep) {
      if (entries.length > 0 && !opts.json) {
        process.stderr.write(
          `[wrangler-accounts] running deep check (wrangler whoami) for ${entries.length} profile(s)...\n`,
        );
      }
      const cloudflaredPath = findCloudflared();
      for (const e of entries) {
        if (e.backend === "native" && e.status === "missing") {
          e.verified = false;
          e.verifyError = "native credentials missing (re-login with --force)";
          continue;
        }
        try {
          const resolved = { name: e.name, source: "deep" };
          const r = runResolvedProfileCommand({
            resolved,
            profilesDir,
            command: "wrangler",
            args: ["whoami"],
            captureStdout: true,
          });
          const output = `${r.stdout || ""}\n${r.stderr || ""}`;
          if (r.exitCode === 0) {
            const live = parseWranglerWhoamiOutput(output);
            if (live) {
              e.verified = true;
              e.liveIdentity = live;
            } else {
              e.verified = false;
              e.verifyError = "could not parse wrangler whoami output";
            }
          } else {
            e.verified = false;
            e.verifyError = /not logged in/i.test(output)
              ? "not logged in (refresh token may be revoked)"
              : `wrangler whoami exit ${r.exitCode}`;
          }
        } catch (err) {
          e.verified = false;
          e.verifyError = err.message;
        }
      }
    }

    if (opts.plain) {
      // --plain keeps the v1.0 contract: one name per line, scriptable.
      if (entries.length) console.log(entries.map((e) => e.name).join("\n"));
      return;
    }

    if (opts.json) {
      console.log(JSON.stringify(entries, null, 2));
      return;
    }

    // Text output: human-friendly table with status markers.
    if (entries.length === 0) {
      console.log("No profiles found.");
      return;
    }
    if (defaultName) console.log(`Default: ${defaultName}\n`);
    const rows = entries.map((e) => ({
      marker: e.isDefault ? "*" : " ",
      name: `${e.name} [${e.type}${e.backend === "native" ? ", native" : ""}]`,
      status:
        e.status === "expired" ? "EXPIRED"
        : e.status === "refreshable" ? "valid*"
        : e.status === "valid" ? "valid"
        : e.status === "token" ? (e.credentialStore && e.credentialStore !== "file" ? `token (${e.credentialStore})` : "token")
        : e.status === "encrypted" ? `encrypted (${e.credentialStore})`
        : e.status === "missing" ? "MISSING"
        : "unknown",
      expires: e.type === "token" || e.status === "encrypted" || e.status === "missing" ? "—" : formatExpiry(e.expirationTime),
      verified:
        e.verified === true ? "✓ ok"
        : e.verified === false ? `✗ ${e.verifyError || "failed"}`
        : "—",
      identity: e.identity ? describeIdentity(e.identity) : "(no identity)",
      note: e.description || "",
    }));
    const hasNotes = rows.some((r) => r.note);
    const nameW = Math.max(4, ...rows.map((r) => r.name.length));
    const statusW = Math.max(6, ...rows.map((r) => r.status.length));
    const expiresW = Math.max(7, ...rows.map((r) => r.expires.length));
    const verifiedW = Math.max(8, ...rows.map((r) => r.verified.length));
    const noteW = hasNotes ? Math.max(4, ...rows.map((r) => r.note.length)) : 0;

    let header;
    if (opts.deep) {
      header = `  ${"NAME".padEnd(nameW)}  ${"STATUS".padEnd(statusW)}  ${"EXPIRES".padEnd(expiresW)}  ${"VERIFIED".padEnd(verifiedW)}  IDENTITY`;
    } else {
      header = `  ${"NAME".padEnd(nameW)}  ${"STATUS".padEnd(statusW)}  ${"EXPIRES".padEnd(expiresW)}  IDENTITY`;
    }
    if (hasNotes) header += `  NOTE`;
    console.log(header);
    for (const r of rows) {
      let line;
      if (opts.deep) {
        line = `${r.marker} ${r.name.padEnd(nameW)}  ${r.status.padEnd(statusW)}  ${r.expires.padEnd(expiresW)}  ${r.verified.padEnd(verifiedW)}  ${r.identity}`;
      } else {
        line = `${r.marker} ${r.name.padEnd(nameW)}  ${r.status.padEnd(statusW)}  ${r.expires.padEnd(expiresW)}  ${r.identity}`;
      }
      if (hasNotes) line += `  ${r.note}`;
      console.log(line);
    }
    console.log();
    if (opts.deep) {
      console.log(
        "Legend: * = default profile | STATUS valid = access token fresh | valid* = access token expired but refresh_token will auto-refresh",
      );
      console.log(
        "        EXPIRED = access token expired and no refresh_token, must 'login <name>' again",
      );
      console.log(
        "        VERIFIED ✓ = 'wrangler whoami' succeeded in shadow HOME (authoritative) | ✗ = failed",
      );
    } else {
      console.log(
        "Legend: * = default profile | STATUS valid = access token fresh | valid* = access token expired but refresh_token will auto-refresh",
      );
      console.log(
        "        EXPIRED = access token expired and no refresh_token, must 'login <name>' again | unknown = no expiration_time saved",
      );
      console.log(
        "        STATUS is file-only. For a live check against Cloudflare, pass --deep (slower, makes network calls).",
      );
    }
    if (entries.some((e) => e.backend === "native")) {
      console.log(
        "        native = stored in wrangler's own profile store (also usable as 'wrangler --profile <name>') | encrypted = key in the OS keychain",
      );
    }
    return;
  }

  if (command === "status") {
    const { identity: currentIdentity, error: currentIdentityError } = loadCurrentIdentity();
    const profiles = listProfiles(profilesDir, { includeBackups });
    const active = getActiveProfile(profilesDir);
    const plaintextCredentialPath = (name) => {
      const dir = path.join(profilesDir, name);
      if (getProfileBackend(dir) !== "native") return path.join(dir, "config.toml");
      const nctx = nativeContext(profilesDir, name);
      return nctx.state === "plaintext" ? nctx.files.toml : null;
    };
    const exactMatch = findMatchingProfile(profilesDir, configPath, {
      includeBackups,
      credentialPathFor: plaintextCredentialPath,
    });
    const configSession = readSessionState(configPath);
    const identityMatches = findProfilesByIdentity(profilesDir, currentIdentity, { includeBackups });
    const matchingProfile = exactMatch || (identityMatches.length === 1 ? identityMatches[0] : null);
    const matchType = exactMatch ? "hash" : identityMatches.length === 1 ? "identity" : null;
    const profileStates = Object.fromEntries(
      profiles.map((name) => {
        const profileDir = path.join(profilesDir, name);
        const type = getProfileType(profileDir) || "oauth";
        const profileConfig = path.join(profileDir, "config.toml");
        const meta = readMeta(profileDir);
        const backend = type === "oauth" ? getProfileBackend(profileDir) : null;
        const nctx = backend === "native" ? nativeContext(profilesDir, name) : null;
        return [
          name,
          {
            ...(type === "token" ? readTokenSessionState()
              : nctx ? nativeSessionState(nctx)
              : readSessionState(profileConfig)),
            type,
            identity: getMetaIdentity(meta),
            backend,
            nativeName: nctx ? nctx.nativeName : null,
          },
        ];
      })
    );
    const syncAvailable =
      Boolean(currentIdentity) &&
      Boolean(matchingProfile) &&
      !exactMatch &&
      filesEqual(configPath, plaintextCredentialPath(matchingProfile) || "") === false;
    const payload = {
      configPath,
      configExists: fs.existsSync(configPath),
      configSession,
      currentIdentity,
      currentIdentityError,
      profilesDir,
      profileCount: profiles.length,
      profiles,
      profileStates,
      activeProfile: active,
      matchingProfile,
      matchType,
      syncAvailable,
    };

    if (opts.json) {
      console.log(JSON.stringify(payload, null, 2));
    } else {
      console.log(`Config: ${payload.configPath} (${payload.configExists ? "exists" : "missing"})`);
      if (payload.configSession.expirationTime) {
        const state = payload.configSession.expired ? "expired" : "valid";
        console.log(`Config session: ${payload.configSession.expirationTime} (${state})`);
      }
      if (payload.currentIdentity) {
        console.log(`Config identity: ${describeIdentity(payload.currentIdentity)}`);
      } else if (payload.currentIdentityError) {
        console.log(`Config identity: unavailable (${payload.currentIdentityError})`);
      }
      console.log(`Profiles: ${payload.profilesDir} (${payload.profileCount})`);
      console.log(`Active: ${payload.activeProfile || "-"}`);
      if (payload.matchingProfile && payload.matchType) {
        console.log(`Match: ${payload.matchingProfile} (${payload.matchType})`);
      } else {
        console.log(`Match: -`);
      }
      if (payload.syncAvailable) {
        console.log(`Sync: current config can refresh profile '${payload.matchingProfile}'`);
      }
      for (const name of profiles) {
        const profileSession = profileStates[name];
        const state =
          profileSession.effective === "token"
            ? "token"
            : profileSession.effective === "encrypted" || profileSession.effective === "missing"
              ? profileSession.effective
              : profileSession.expired ? "expired" : "valid";
        const suffix = profileSession.identity ? `, ${describeIdentity(profileSession.identity)}` : "";
        const expiry = profileSession.expirationTime || "(n/a)";
        const kind = profileSession.backend === "native" ? `${profileSession.type}, native` : profileSession.type;
        console.log(`- ${name} [${kind}]: ${expiry} (${state}${suffix ? suffix : ""})`);
      }
    }
    return;
  }

  if (command === "save") {
    const { identity: currentIdentity } = loadCurrentIdentity();
    const name = rest[1];
    if (!name) die("Missing profile name for save");
    ensureDir(profilesDir);
    const profileDir = path.join(profilesDir, name);
    const existed = fs.existsSync(profileDir);
    if (existed && opts.force && getProfileBackend(profileDir) === "native") {
      if (!fs.existsSync(configPath)) die(`Config file not found: ${configPath}`);
      storeIntoNative(profilesDir, name, configPath, currentIdentity);
    } else {
      saveProfile(name, configPath, profilesDir, opts.force, currentIdentity);
    }
    if (opts.json) {
      console.log(
        JSON.stringify(
          {
            command: "save",
            name,
            configPath,
            profilesDir,
            overwritten: existed,
            identity: currentIdentity,
          },
          null,
          2
        )
      );
    } else {
      console.log(`Saved profile '${name}' from ${configPath}`);
    }
    return;
  }

  if (command === "token-add") {
    const name = rest[1];
    const apiToken = rest[2];
    const accountId = rest[3];
    if (!name) die("Missing profile name for token-add");
    if (!apiToken) die("Missing API token for token-add");
    if (!accountId) die("Missing account ID for token-add");
    ensureDir(profilesDir);
    const protect = Boolean(opts.protect) || process.env.WRANGLER_ACCOUNTS_PROTECT_TOKENS === "1";
    saveTokenProfile(name, apiToken, accountId, profilesDir, opts.force, { protect });
    const where = protect ? ` (token in ${backendName()})` : "";
    if (opts.json) {
      console.log(JSON.stringify({ command: "token-add", name, protected: protect, credentialStore: protect ? backendName() : null }, null, 2));
    } else {
      console.log(`Saved token profile '${name}'${where}`);
    }
    return;
  }

  if (command === "protect" || command === "unprotect") {
    const name = rest[1];
    if (!name && !opts.all) die(`Usage: wrangler-accounts ${command} <name> | --all`);
    // Token profiles: API token -> OS secret store (1.8.0).
    // OAuth profiles: wrangler's own keyring encryption of the native profile
    // (migrating to native first), see lib/migrate.js.
    const names = opts.all ? listProfiles(profilesDir) : [name];
    const results = [];
    let failed = false;
    for (const n of names) {
      try {
        const type = getProfileType(path.join(profilesDir, n));
        if (type === "oauth") {
          const probe = getProfileBackend(path.join(profilesDir, n)) === "native" ? undefined : nativeProbe(profilesDir);
          results.push(
            command === "protect"
              ? protectOAuthProfile(profilesDir, n, { probe, verify: !opts.noVerify })
              : unprotectOAuthProfile(profilesDir, n),
          );
        } else {
          results.push((command === "protect" ? protectTokenProfile : unprotectTokenProfile)(profilesDir, n));
        }
      } catch (err) {
        failed = true;
        results.push({ name: n, status: "error", error: err.message });
      }
    }
    if (opts.json) {
      console.log(JSON.stringify({ command, results }, null, 2));
    } else if (!results.length) {
      console.log("No token profiles found.");
    } else {
      for (const r of results) {
        const detail = r.error || r.reason || (r.store ? `(${r.store})` : "");
        console.log(`${r.name}: ${r.status}${detail ? ` ${detail}` : ""}`);
        if (r.warning) console.log(`  note: ${r.warning}`);
      }
      const oauthProtected = results.filter((r) => r.nativeName && (r.status === "protected" || r.status === "already") && command === "protect");
      if (oauthProtected.length) {
        const n0 = oauthProtected[0].nativeName;
        console.log("");
        console.log("OAuth credentials are now encrypted by wrangler (key in the OS keychain); no plaintext file is left.");
        console.log("OAuth 凭据已由 wrangler 加密，密钥在系统钥匙串里，磁盘上不再有明文。wrangler-accounts 的用法不变。");
        console.log(`Bare wrangler needs keyring mode to read it: wrangler auth keyring enable  (or CLOUDFLARE_AUTH_USE_KEYRING=true wrangler --profile ${n0} ...)`);
        console.log("WARNING / 注意: 'wrangler auth keyring disable' deletes EVERY encrypted wrangler profile. To go back to plaintext use 'wrangler-accounts unprotect <name>'.");
        console.log("'wrangler auth keyring disable' 会删除所有加密的 wrangler profile；要恢复明文请用 'wrangler-accounts unprotect <name>'。");
      }
    }
    process.exit(failed ? 1 : 0);
  }

  if (command === "note") {
    const name = rest[1];
    if (!name) die("Usage: wrangler-accounts note <name> [<text>] [--clear]");
    if (!isValidName(name)) die(`Invalid profile name: ${name}`);
    const profileDir = path.join(profilesDir, name);
    if (!fs.existsSync(profileDir)) die(`Profile not found: ${name}`);

    if (opts.clear) {
      setProfileNoteImpl(profilesDir, name, null);
      console.log(`Note cleared for profile '${name}'.`);
    } else {
      // Everything after the name is the note text
      const noteText = rest.slice(2).join(" ").trim();
      if (!noteText) {
        // No text supplied — show current note
        const meta = readMeta(profileDir);
        const note = meta && meta.description;
        if (note) {
          console.log(note);
        } else {
          console.log(`(no note set for '${name}')`);
        }
      } else {
        setProfileNoteImpl(profilesDir, name, noteText);
        console.log(`Note set for profile '${name}'.`);
      }
    }
    return;
  }

  if (command === "login") {
    const name = rest[1];
    if (!name) die("Missing profile name for login");
    if (!isValidName(name)) die(`Invalid profile name: ${name}`);
    ensureDir(profilesDir);

    // Guard 1: refuse to run in a non-interactive context (CI, sub-agent,
    // pipe). 'wrangler login' opens a browser and requires the user to
    // click an authorize button. In a non-TTY context this hangs forever
    // and any attempt is almost certainly an AI/script applying 'login'
    // as if it were idempotent — it isn't.
    if (!process.stdin.isTTY && !opts.force) {
      die(
        [
          `'login' requires an interactive terminal — wrangler will open a browser`,
          `and wait for authorization. Stdin is not a TTY here.`,
          ``,
          `If you are an AI agent or script trying to verify a profile is`,
          `working, do NOT use 'login'. Use one of these instead:`,
          ``,
          `  wrangler-accounts whoami --profile ${name}    # static check (meta.json)`,
          `  wrangler-accounts list --deep                 # live check (network call)`,
          ``,
          `If you really need to re-authenticate this profile non-interactively,`,
          `pass --force to bypass this guard (the OAuth flow will still need a`,
          `browser to complete).`,
        ].join("\n"),
        1,
      );
    }

    if (getProfileBackend(path.join(profilesDir, name)) === "native") {
      loginNative(name, profilesDir, opts);
      return;
    }

    // Guard 2: refuse to overwrite an existing profile that's already
    // healthy unless --force is passed. 'login' is destructive — it
    // OVERWRITES the saved profile by design. If the profile is already
    // valid, the caller almost certainly meant to verify, not re-create.
    const existingCfg = path.join(profilesDir, name, "config.toml");
    if (fs.existsSync(existingCfg) && !opts.force) {
      const session = readSessionState(existingCfg);
      const looksHealthy = session.effective === "valid" || session.effective === "refreshable";
      if (looksHealthy) {
        die(
          [
            `Profile '${name}' already exists and looks healthy:`,
            `  status:           ${session.effective}`,
            `  expirationTime:   ${session.expirationTime || "(none)"}`,
            `  hasRefreshToken:  ${session.hasRefreshToken}`,
            ``,
            `'login' is DESTRUCTIVE — it opens a browser and overwrites the saved`,
            `profile. If you only wanted to verify the profile works, run instead:`,
            ``,
            `  wrangler-accounts whoami --profile ${name}     # fast, no network`,
            `  wrangler-accounts list --deep                  # authoritative, hits Cloudflare API`,
            ``,
            `If you really intend to re-authenticate (e.g. you revoked the token`,
            `in the Cloudflare dashboard, or want to switch which OAuth account`,
            `this profile is bound to), pass --force:`,
            ``,
            `  wrangler-accounts login ${name} --force`,
          ].join("\n"),
          1,
        );
      }
    }

    // Create a shadow HOME without pre-linking .wrangler/config/default.toml.
    // wrangler login will write a fresh file into shadow/.wrangler/config/
    // which we then move into the profile directory.
    const realHome = os.homedir();
    const shadow = fs.mkdtempSync(path.join(os.tmpdir(), `wa-login-${name}-`));
    fs.chmodSync(shadow, 0o700);
    for (const entry of fs.readdirSync(realHome)) {
      if (entry === ".wrangler") continue;
      try {
        fs.symlinkSync(path.join(realHome, entry), path.join(shadow, entry));
      } catch {}
    }
    const shadowWranglerConfig = path.join(shadow, ".wrangler", "config");
    fs.mkdirSync(shadowWranglerConfig, { recursive: true });

    // Pre-create the profile dir so per-profile cache lands in the right
    // place even though config.toml doesn't exist yet (login will write
    // it). This makes WRANGLER_CACHE_DIR isolated from the very first
    // command, including the login flow itself. We remember whether the
    // dir existed before so we can clean it up if login fails.
    const profileDir = path.join(profilesDir, name);
    const existed = fs.existsSync(path.join(profileDir, "config.toml"));
    const profileDirExistedBefore = fs.existsSync(profileDir);
    ensureDir(profileDir);
    const futureProfileCfg = path.join(profileDir, "config.toml");

    const env = buildIsolatedEnv({
      shadow,
      realHome,
      profile: name,
      profileCfg: futureProfileCfg,
      baseEnv: process.env,
      cloudflaredPath: findCloudflared(),
    });
    let identity = null;
    let loginSucceeded = false;

    // Use throw + catch + finally so cleanup always runs. die() calls
    // process.exit() synchronously, which would skip the finally block —
    // and that would leave a half-created profile dir behind on failure.
    let errorMsg = null;
    try {
      const loginResult = spawnSync("wrangler", ["login"], {
        stdio: "inherit",
        env,
      });
      if (loginResult.error) {
        throw new Error(`Failed to run 'wrangler login': ${loginResult.error.message}`);
      }
      if (loginResult.status !== 0) {
        throw new Error(`'wrangler login' exited with code ${loginResult.status}`);
      }

      const freshCfg = path.join(shadowWranglerConfig, "default.toml");
      if (!fs.existsSync(freshCfg)) {
        throw new Error(`wrangler login completed but no config was written at ${freshCfg}`);
      }

      // Verify identity via `wrangler whoami` in the same shadow.
      const whoamiResult = spawnSync("wrangler", ["whoami"], {
        env,
        encoding: "utf8",
      });
      const output = `${whoamiResult.stdout || ""}\n${whoamiResult.stderr || ""}`;
      identity = parseWranglerWhoamiOutput(output);
      if (!identity) {
        throw new Error("Login succeeded but could not parse 'wrangler whoami' output");
      }

      // Move the fresh config into the profile directory. Use writeFile
      // (copy) so the profile config is a real file, not a symlink.
      // (profileDir was already pre-created above for cache isolation.)
      const destCfg = path.join(profileDir, "config.toml");
      fs.copyFileSync(freshCfg, destCfg);
      writeMeta(profileDir, name, destCfg, identity);
      loginSucceeded = true;
    } catch (err) {
      errorMsg = err.message;
    } finally {
      cleanupShadow(shadow);
      // If login failed AND we created the profile dir as a side effect
      // of cache isolation (it didn't exist before), clean it up so the
      // user doesn't see a half-empty profile.
      if (!loginSucceeded && !profileDirExistedBefore) {
        try {
          fs.rmSync(profileDir, { recursive: true, force: true });
        } catch {}
      }
    }
    if (errorMsg) die(errorMsg);

    const note = existed ? " (overwritten)" : "";
    if (opts.json) {
      console.log(
        JSON.stringify(
          {
            command: "login",
            name,
            profilesDir,
            overwritten: existed,
            identity,
          },
          null,
          2
        )
      );
    } else {
      console.log(
        `Logged in and saved profile '${name}' (${describeIdentity(identity)})${note}`
      );
    }
    return;
  }

  if (command === "sync") {
    const { identity: currentIdentity } = loadCurrentIdentity();
    const name = rest[1];
    if (!name) die("Missing profile name for sync");
    ensureDir(profilesDir);
    syncProfile(name, configPath, profilesDir, currentIdentity);
    if (opts.json) {
      console.log(
        JSON.stringify(
          {
            command: "sync",
            name,
            configPath,
            profilesDir,
            identity: currentIdentity,
          },
          null,
          2
        )
      );
    } else {
      console.log(`Synced current Wrangler login into profile '${name}'`);
    }
    return;
  }

  if (command === "sync-active" || command === "sync-default") {
    const isLegacyAlias = command === "sync-active";
    if (isLegacyAlias) {
      warnDeprecated("sync-active", "sync-default");
    }
    const { identity: currentIdentity } = loadCurrentIdentity();
    // Prefer the new persistent default; fall back to legacy active for
    // backward compatibility during the transition.
    const target = getDefaultProfile(profilesDir) || getActiveProfile(profilesDir);
    if (!target) {
      die("No default profile set. Run `wrangler-accounts default <name>` first.", 2);
    }
    ensureDir(profilesDir);
    syncProfile(target, configPath, profilesDir, currentIdentity);
    if (opts.json) {
      console.log(
        JSON.stringify(
          {
            command: isLegacyAlias ? "sync-active" : "sync-default",
            name: target,
            configPath,
            profilesDir,
            identity: currentIdentity,
          },
          null,
          2
        )
      );
    } else {
      console.log(`Synced current Wrangler login into default profile '${target}'`);
    }
    return;
  }

  if (command === "use") {
    die(
      [
        "The 'use' command is no longer supported because it was ambiguous and rewrote Wrangler's global config.",
        "Use 'wrangler-accounts default <name>' for a persistent default profile.",
        "Use 'wrangler-accounts --profile <name> <wrangler-args...>' for a one-shot command.",
        "Use 'wrangler-accounts exec <name>' for an interactive subshell.",
      ].join("\n"),
      2,
    );
  }

  if (command === "remove") {
    const name = rest[1];
    if (!name) die("Missing profile name for remove");
    const isNative = isValidName(name) && getProfileBackend(path.join(profilesDir, name)) === "native";
    const nctx = isNative ? nativeContext(profilesDir, name) : null;
    removeProfile(name, profilesDir);
    // A native profile is a wrangler credential the user can also use
    // directly (wrangler --profile). Keep it unless explicitly asked.
    let nativeRemoved = [];
    let nativeKeyRemoved = false;
    if (nctx && opts.deleteNative) {
      for (const f of [nctx.files.toml, nctx.files.enc]) {
        if (fs.existsSync(f)) {
          fs.unlinkSync(f);
          nativeRemoved.push(f);
        }
      }
      if (nctx.state === "encrypted") {
        try {
          nativeKeyRemoved = native.deleteNativeKey(nctx.nativeName);
        } catch {}
      }
    }
    const bindings = nctx ? native.bindingsFor(nctx.nativeName) : [];
    if (opts.json) {
      console.log(
        JSON.stringify(
          {
            command: "remove",
            name,
            profilesDir,
            ...(nctx
              ? {
                  nativeName: nctx.nativeName,
                  nativeKept: !opts.deleteNative && nctx.state !== "missing",
                  nativeRemoved,
                  nativeKeyRemoved,
                  bindings,
                }
              : {}),
          },
          null,
          2
        )
      );
    } else {
      console.log(`Removed profile '${name}'`);
      if (nctx && !opts.deleteNative && nctx.state !== "missing") {
        console.log(
          `Kept wrangler's native profile '${nctx.nativeName}' (${nctx.state === "encrypted" ? nctx.files.enc : nctx.files.toml}); 'wrangler --profile ${nctx.nativeName}' still works.`,
        );
        console.log(`wrangler 原生 profile '${nctx.nativeName}' 仍保留。要一并删除：wrangler auth delete ${nctx.nativeName}`);
      } else if (nativeRemoved.length) {
        console.log(`Deleted wrangler's native profile '${nctx.nativeName}'${nativeKeyRemoved ? " and its keychain key" : ""}.`);
      }
      if (bindings.length) {
        console.log(`Directories still bound to '${nctx.nativeName}' (wrangler auth deactivate <dir>):`);
        for (const b of bindings) console.log(`  ${b}`);
      }
    }
    return;
  }

  if (command === "migrate" || command === "unmigrate") {
    const name = rest[1];
    if (!name && !opts.all) {
      die(`Usage: wrangler-accounts ${command} <name> | --all${command === "migrate" ? " [--as <wrangler-name>] [--dry-run] [--force] [--no-verify]" : " [--keep-native]"}`);
    }
    if (opts.all && opts.as) die("--as only works with a single profile");
    if (command === "migrate") {
      const probe = nativeProbe(profilesDir);
      if (!probe.supported) {
        die(`${probe.reason}\n${UNSUPPORTED_HINT}`, 2);
      }
    }
    const names = opts.all
      ? listProfiles(profilesDir).filter((n) => getProfileType(path.join(profilesDir, n)) === "oauth")
      : [name];
    const results = [];
    let failed = false;
    for (const n of names) {
      try {
        results.push(
          command === "migrate"
            ? migrateProfile(profilesDir, n, {
                as: opts.as,
                force: opts.force,
                dryRun: opts.dryRun,
                verify: !opts.noVerify,
                probe: nativeProbe(profilesDir),
              })
            : unmigrateProfile(profilesDir, n, { keepNative: opts.keepNative }),
        );
      } catch (err) {
        failed = true;
        const exit = err instanceof MigrateError && err.code === "PROFILE_NOT_FOUND" && !opts.all ? 2 : null;
        if (exit && !opts.json) die(err.message, exit);
        results.push({ name: n, status: "error", error: err.message, code: err.code || null });
      }
    }
    if (opts.json) {
      console.log(JSON.stringify({ command, dryRun: Boolean(opts.dryRun), results }, null, 2));
      process.exit(failed ? 1 : 0);
    }
    if (!results.length) console.log("No OAuth profiles found.");
    for (const r of results) {
      if (r.status === "error") {
        console.log(`${r.name}: error\n  ${String(r.error).split("\n").join("\n  ")}`);
      } else if (r.status === "dry-run") {
        console.log(`${r.name}: would copy ${r.source}`);
        console.log(`  -> wrangler profile '${r.nativeName}' at ${r.target}${r.replaces ? ` (replacing the existing ${r.replaces} profile, backed up first)` : ""}`);
        console.log(`  then verify with 'wrangler auth token --profile ${r.nativeName}' and remove the old copy.`);
      } else if (r.status === "migrated") {
        console.log(`${r.name}: migrated -> wrangler profile '${r.nativeName}' (${r.encrypted ? "encrypted" : r.target})${r.verified ? ", verified by wrangler" : ", NOT verified (--no-verify)"}`);
      } else if (r.status === "unmigrated") {
        console.log(`${r.name}: moved back to wrangler-accounts (shadow HOME)${r.keptNative ? `; wrangler profile '${r.nativeName}' kept (now a separate copy)` : `; wrangler profile '${r.nativeName}' removed${r.keyRemoved ? " with its keychain key" : ""}`}`);
        if (r.bindings && r.bindings.length) {
          console.log(`  directories still bound to '${r.nativeName}' (remove with: wrangler auth deactivate <dir>):`);
          for (const b of r.bindings) console.log(`    ${b}`);
        }
      } else {
        console.log(`${r.name}: ${r.status}${r.reason ? ` (${r.reason})` : r.nativeName ? ` (wrangler profile '${r.nativeName}')` : ""}`);
      }
    }
    const migrated = results.filter((r) => r.status === "migrated");
    if (migrated.length) {
      const n0 = migrated[0];
      console.log("");
      console.log(`Done. wrangler-accounts commands work exactly as before. The profile is now also a native wrangler profile:`);
      console.log(`迁移完成，wrangler-accounts 用法不变；现在也可以直接用 wrangler 原生 profile：`);
      console.log(`  wrangler --profile ${n0.nativeName} deploy`);
      console.log(`  wrangler auth activate ${n0.nativeName}      # bind the current directory`);
      console.log(`Encrypt it at rest: wrangler-accounts protect ${n0.name}    Roll back: wrangler-accounts unmigrate ${n0.name}`);
    }
    process.exit(failed ? 1 : 0);
  }

  if (command === "__is-cloudflare-cf") {
    // Internal helper for the guard hook and the cf PATH shim: exit 0 only
    // when the given (or first on PATH) cf is Cloudflare's CLI.
    const target = rest[1];
    if (target) process.exit(isCloudflareCf(target) ? 0 : 1);
    const found = findCf();
    process.exit(found && found.path ? 0 : 1);
  }

  if (command === "whoami") {
    const profileArg = opts.profile || rest[1] || null;
    let resolved;
    try {
      resolved = resolveProfileAny({
        cliProfile: profileArg,
        positional: null,
        env: process.env,
        profilesDir,
        managementSubcommands: MANAGEMENT_SUBCOMMANDS,
      });
    } catch (err) {
      if (err instanceof ResolveError) {
        if (err.code === "NO_PROFILE" && process.env.CLOUDFLARE_API_TOKEN) {
          const result = runAnonymousTokenMode({
            command: "wrangler",
            args: ["whoami"],
          });
          process.exit(result.exitCode);
        }
        die(err.message, 2);
      }
      throw err;
    }
    const profileDir = path.join(profilesDir, resolved.name);
    const profileType = getProfileType(profileDir) || "oauth";
    if (profileType === "token") {
      const result = runResolvedProfileCommand({
        resolved,
        profilesDir,
        command: "wrangler",
        args: ["whoami"],
      });
      process.exit(result.exitCode);
    }
    const meta = readMeta(profileDir);
    const identity = getMetaIdentity(meta);
    if (opts.json) {
      console.log(
        JSON.stringify(
          {
            command: "whoami",
            profile: resolved.name,
            source: resolved.source,
            type: profileType,
            identity,
            backend: getProfileBackend(profileDir),
            nativeName: (meta && meta.nativeName) || null,
          },
          null,
          2
        )
      );
    } else {
      const idStr = identity ? describeIdentity(identity) : "identity unknown";
      console.log(`${resolved.name} [${resolved.source}]: ${idStr}`);
    }
    return;
  }

  if (command === "gc") {
    const thresholdMs = parseDuration(opts.olderThan || "1h");
    const now = Date.now();
    const tmpDir = os.tmpdir();
    let entries;
    try {
      entries = fs.readdirSync(tmpDir);
    } catch {
      entries = [];
    }
    const removed = [];
    for (const entry of entries) {
      if (!entry.startsWith("wa-")) continue;
      const full = path.join(tmpDir, entry);
      let stat;
      try {
        stat = fs.statSync(full);
      } catch {
        continue;
      }
      if (!stat.isDirectory()) continue;
      if (now - stat.mtimeMs > thresholdMs) {
        try {
          fs.rmSync(full, { recursive: true, force: true });
          removed.push(full);
        } catch {}
      }
    }
    if (opts.json) {
      console.log(JSON.stringify({ command: "gc", removed }, null, 2));
    } else if (removed.length === 0) {
      console.log("nothing to clean");
    } else {
      for (const r of removed) console.log(`removed ${r}`);
    }
    return;
  }

  if (command === "exec") {
    const profileName = rest[1];
    if (!profileName) die("Missing profile name for exec", 2);

    let resolved;
    try {
      resolved = resolveProfileAny({
        cliProfile: profileName,
        positional: null,
        env: process.env,
        profilesDir,
        managementSubcommands: MANAGEMENT_SUBCOMMANDS,
      });
    } catch (err) {
      if (err instanceof ResolveError) die(err.message, 2);
      throw err;
    }

    // Everything after `--` is the user command. Without `--`, launch $SHELL -i.
    const dashDashIdx = rest.indexOf("--", 2);
    let cmd;
    let cmdArgs;
    if (dashDashIdx >= 0) {
      cmd = rest[dashDashIdx + 1];
      cmdArgs = rest.slice(dashDashIdx + 2);
      if (!cmd) die("No command given after --", 1);
    } else {
      cmd = process.env.SHELL || "/bin/sh";
      cmdArgs = ["-i"];
    }

    // `exec x -- cf ...` with Cloudflare's cf: same as `--profile x cf ...`.
    const cfPath = dashDashIdx >= 0 ? resolveExecCf(cmd) : null;
    if (cfPath) {
      const result = runCfForProfile({ resolved, profilesDir, args: cmdArgs, cfPath });
      process.exit(result.exitCode);
    }

    const result = runResolvedProfileCommand({
      resolved,
      profilesDir,
      command: cmd,
      args: cmdArgs,
    });
    process.exit(result.exitCode);
  }

  if (command === "default") {
    const name = rest[1];
    // --unset takes precedence over any positional value
    if (opts.unset) {
      unsetDefaultProfile(profilesDir);
      if (opts.json) {
        console.log(JSON.stringify({ command: "default", unset: true }, null, 2));
      } else {
        console.log("Default profile unset.");
      }
      return;
    }
    // No name given — print the current default (or error if none set)
    if (!name) {
      const current = getDefaultProfile(profilesDir);
      if (opts.json) {
        console.log(JSON.stringify({ command: "default", name: current }, null, 2));
      } else if (current) {
        console.log(current);
      } else {
        if (outputJson) {
          // handled above
        } else {
          console.log("(no default set)");
        }
        process.exit(1);
      }
      return;
    }
    // Set the default profile
    if (!isValidName(name)) die(`Invalid profile name: ${name}`);
    if (!tokenProfileExists(profilesDir, name)) die(`Profile not found: ${name}`, 2);
    setDefaultProfile(profilesDir, name);
    if (opts.json) {
      console.log(JSON.stringify({ command: "default", name }, null, 2));
    } else {
      console.log(`Default profile set to '${name}'`);
    }
    return;
  }

  if (command === "shim") {
    const action = rest[1] || "status";
    const shimDir = getShimDir(process.env);

    if (action === "install") {
      let shimPath;
      try {
        shimPath = installShim({ shimDir });
      } catch (err) {
        die(`Failed to install shim: ${err.message}`);
      }
      const realWrangler = findRealWrangler({ shimDir });
      // Cover bare `cf` too, but only when the cf on PATH is Cloudflare's —
      // Cloud Foundry's cf is never shadowed.
      const cfFound = findCloudflareCf({ pathEnv: process.env.PATH || "", skipDirs: [shimDir] });
      let cfShimPath = null;
      if (cfFound && cfFound.path && cfFound.via === "cf") {
        try {
          cfShimPath = installCfShim({ shimDir });
        } catch (err) {
          process.stderr.write(`[wrangler-accounts] could not install the cf shim: ${err.message}\n`);
        }
      }
      const shell = detectShell(process.env);
      const line = pathLine(shimDir, shell);
      let rcPath = null;
      let rcApplied = false;
      if (opts.apply) {
        rcPath = detectShellRc(process.env);
        if (!rcPath) {
          die(
            "Could not detect a shell rc file for --apply. Add the shim dir to PATH manually.",
          );
        }
        try {
          rcApplied = applyToRc({ rcPath, shimDir, shell });
        } catch (err) {
          die(`Failed to update ${rcPath}: ${err.message}`);
        }
      }
      if (opts.json) {
        console.log(
          JSON.stringify(
            { command: "shim", action: "install", shimPath, shimDir, shell, pathLine: line, realWrangler, rcPath, rcApplied, cfShimPath },
            null,
            2,
          ),
        );
        return;
      }
      console.log(`Installed wrangler shim: ${shimPath}`);
      if (cfShimPath) console.log(`Installed cf shim (Cloudflare's cf detected): ${cfShimPath}`);
      if (!realWrangler) {
        console.log(
          "Warning: no real 'wrangler' found on PATH yet. Install it with 'npm i -g wrangler'.",
        );
      }
      if (rcApplied) {
        console.log(`Added shim dir to PATH in ${rcPath}. Open a new shell, or run now:`);
        console.log(`  ${line}`);
      } else if (opts.apply) {
        console.log(`${rcPath} already references the shim — no change made.`);
      } else {
        console.log(`Add the shim dir to the FRONT of your PATH (${shell}):`);
        console.log(`  ${line}`);
        console.log("Or re-run with --apply to edit your shell rc automatically.");
      }
      return;
    }

    if (action === "uninstall") {
      const removed = uninstallShim({ shimDir });
      let rcPath = null;
      let rcCleaned = false;
      if (opts.apply) {
        rcPath = detectShellRc(process.env);
        if (rcPath) {
          try {
            rcCleaned = removeFromRc({ rcPath });
          } catch (err) {
            die(`Failed to update ${rcPath}: ${err.message}`);
          }
        }
      }
      if (opts.json) {
        console.log(
          JSON.stringify(
            { command: "shim", action: "uninstall", shimDir, removed, rcPath, rcCleaned },
            null,
            2,
          ),
        );
        return;
      }
      console.log(removed ? `Removed wrangler shim from ${shimDir}` : "No wrangler shim was installed.");
      if (rcCleaned) {
        console.log(`Removed shim PATH entry from ${rcPath}. Open a new shell for it to take effect.`);
      }
      return;
    }

    if (action === "status") {
      const status = shimStatus({ shimDir });
      if (opts.json) {
        console.log(JSON.stringify({ command: "shim", action: "status", ...status }, null, 2));
        return;
      }
      console.log(`Shim installed: ${status.installed ? "yes" : "no"} (${status.shimPath})`);
      console.log(`Shim dir on PATH: ${status.onPath ? "yes" : "no"}`);
      console.log(`Active (intercepts bare wrangler): ${status.active ? "yes" : "no"}`);
      console.log(`Real wrangler: ${status.realWrangler || "(none found)"}`);
      if (status.cfShimInstalled) console.log(`cf shim: installed (${status.cfShimPath})`);
      if (status.installed && !status.active) {
        console.log(
          "\nThe shim is installed but not active — its directory is not ahead of the real",
        );
        console.log("wrangler on PATH. Add it to the front of PATH:");
        console.log(`  ${pathLine(shimDir, detectShell(process.env))}`);
      }
      return;
    }

    die(`Unknown shim action: ${action}. Use install, uninstall, or status.`, 2);
  }

  die(`Unknown command: ${command}`);
}

main();
