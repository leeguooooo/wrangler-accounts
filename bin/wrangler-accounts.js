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
  setProfileNote: setProfileNoteImpl,
  removeProfile: removeProfileImpl,
} = require("../lib/profile-store");
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
  buildIsolatedEnv,
  cleanupShadow,
} = require("../lib/isolation");

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
  "note",
  "whoami",
  "gc",
  "use",
  "exec",
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

function runResolvedProfileCommand({
  resolved,
  profilesDir,
  command,
  args,
  captureStdout = false,
}) {
  const profileDir = path.join(profilesDir, resolved.name);
  const profileType = getProfileType(profileDir);

  if (profileType === "token") {
    const creds = readTokenCredentials(profileDir);
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

  return runIsolated({
    profile: resolved.name,
    profileCfg,
    profileDir,
    realHome: os.homedir(),
    command,
    args,
    baseEnv: process.env,
    captureStdout,
    cloudflaredPath: findCloudflared(),
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
  token-add <name> <api-token> <account-id>
  sync <name>
  sync-active
  sync-default
  default [name | --unset]
  whoami [--profile <name>]
  exec <name> [-- <cmd> [args]]
  remove <name>

Deprecated:
  use <name>              Prints migration guidance; use 'default' or '--profile' instead

Options:
  -c, --config <path>     Wrangler config path
  -p, --profiles <path>   Profiles directory
  --json                  JSON output for all commands
  --plain                 Plain output for list (one name per line)
  --include-backups       Include backup profiles in list/status
  -f, --force             Overwrite existing profile on save
  -h, --help              Show help
  -v, --version           Print version

Env:
  WRANGLER_CONFIG_PATH
  WRANGLER_ACCOUNTS_DIR
  XDG_CONFIG_HOME

Examples:
  wrangler-accounts save work
  wrangler-accounts default work
  wrangler-accounts --profile work deploy
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
    } else if (arg === "--unset") {
      opts.unset = true;
    } else if (arg === "--deep" || arg === "--verify") {
      opts.deep = true;
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
  const result = spawnSync("wrangler", ["login"], { stdio: "inherit" });
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
  if (!fs.existsSync(profileConfig)) {
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

  fs.copyFileSync(configPath, profileConfig);
  writeMeta(profileDir, name, configPath, identity);
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
          const result = runAnonymousTokenMode({
            command: "wrangler",
            args: rest,
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
      const session =
        type === "token" ? readTokenSessionState() : readSessionState(cfgPath);
      const meta = readMeta(profileDir);
      const identity = getMetaIdentity(meta);
      return {
        name,
        type,
        isDefault: name === defaultName,
        isActive: name === activeName,
        status: session.effective, // 'valid' | 'refreshable' | 'expired' | 'unknown' | 'token'
        expirationTime: session.expirationTime,
        hasRefreshToken: session.hasRefreshToken,
        identity,
        description: (meta && meta.description) || null,
        verified: null,
        verifyError: null,
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
      name: `${e.name} [${e.type}]`,
      status:
        e.status === "expired" ? "EXPIRED"
        : e.status === "refreshable" ? "valid*"
        : e.status === "valid" ? "valid"
        : e.status === "token" ? "token"
        : "unknown",
      expires: e.type === "token" ? "—" : formatExpiry(e.expirationTime),
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
    return;
  }

  if (command === "status") {
    const { identity: currentIdentity, error: currentIdentityError } = loadCurrentIdentity();
    const profiles = listProfiles(profilesDir, { includeBackups });
    const active = getActiveProfile(profilesDir);
    const exactMatch = findMatchingProfile(profilesDir, configPath, { includeBackups });
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
        return [
          name,
          {
            ...(type === "token" ? readTokenSessionState() : readSessionState(profileConfig)),
            type,
            identity: getMetaIdentity(meta),
          },
        ];
      })
    );
    const syncAvailable =
      Boolean(currentIdentity) &&
      Boolean(matchingProfile) &&
      !exactMatch &&
      filesEqual(configPath, path.join(profilesDir, matchingProfile, "config.toml")) === false;
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
            : profileSession.expired ? "expired" : "valid";
        const suffix = profileSession.identity ? `, ${describeIdentity(profileSession.identity)}` : "";
        const expiry = profileSession.expirationTime || "(n/a)";
        console.log(`- ${name} [${profileSession.type}]: ${expiry} (${state}${suffix ? suffix : ""})`);
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
    saveProfile(name, configPath, profilesDir, opts.force, currentIdentity);
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
    saveTokenProfile(name, apiToken, accountId, profilesDir, opts.force);
    console.log(`Saved token profile '${name}'`);
    return;
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
    removeProfile(name, profilesDir);
    if (opts.json) {
      console.log(
        JSON.stringify(
          {
            command: "remove",
            name,
            profilesDir,
          },
          null,
          2
        )
      );
    } else {
      console.log(`Removed profile '${name}'`);
    }
    return;
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

  die(`Unknown command: ${command}`);
}

main();
