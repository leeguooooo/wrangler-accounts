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
  fileHash,
  readExpirationTime,
  readSessionState,
  filesEqual,
  writeMeta,
  readMeta,
  setActiveProfile,
  getActiveProfile,
  getDefaultProfile,
  setDefaultProfile,
  unsetDefaultProfile,
  timestampForFile,
  backupCurrentConfig,
  findMatchingProfile,
  saveProfile: saveProfileImpl,
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

let outputJson = false;

function die(message, exitCode = 1) {
  if (outputJson) {
    console.error(JSON.stringify({ error: message }, null, 2));
  } else {
    console.error(`Error: ${message}`);
  }
  process.exit(exitCode);
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
  sync <name>
  sync-active
  use <name>
  remove <name>

Options:
  -c, --config <path>     Wrangler config path
  -p, --profiles <path>   Profiles directory
  --json                  JSON output for all commands
  --plain                 Plain output for list (one name per line)
  --include-backups       Include backup profiles in list/status
  -f, --force             Overwrite existing profile on save
  --backup                Backup current config on use (default)
  --no-backup             Disable backup on use
  -h, --help              Show help

Env:
  WRANGLER_CONFIG_PATH
  WRANGLER_ACCOUNTS_DIR
  XDG_CONFIG_HOME

Examples:
  wrangler-accounts save work
  wrangler-accounts sync-active
  wrangler-accounts use personal
`;
  console.log(text);
  process.exit(exitCode);
}

function parseArgs(argv) {
  const opts = {
    json: false,
    force: false,
    backup: true,
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
      rest.push(arg);
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      opts.help = true;
    } else if (arg === "--json") {
      opts.json = true;
    } else if (arg === "--plain") {
      opts.plain = true;
    } else if (arg === "--include-backups") {
      opts.includeBackups = true;
    } else if (arg === "--force" || arg === "-f") {
      opts.force = true;
    } else if (arg === "--backup") {
      opts.backup = true;
    } else if (arg === "--no-backup") {
      opts.backup = false;
    } else if (arg === "--unset") {
      opts.unset = true;
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

function useProfile(name, configPath, profilesDir, backup) {
  if (!isValidName(name)) {
    die(`Invalid profile name: ${name}`);
  }

  const profileDir = path.join(profilesDir, name);
  const profileConfig = path.join(profileDir, "config.toml");
  if (!fs.existsSync(profileConfig)) {
    die(`Profile not found: ${name}`);
  }

  const session = readSessionState(profileConfig);
  if (session.expired) {
    die(
      `Profile '${name}' has expired Wrangler OAuth credentials (expiration_time: ${session.expirationTime}). Run 'wrangler-accounts login ${name}' to refresh it.`
    );
  }

  let backupName = null;
  if (backup && fs.existsSync(configPath) && !filesEqual(configPath, profileConfig)) {
    backupName = backupCurrentConfig(configPath, profilesDir);
  }

  ensureDir(path.dirname(configPath));
  fs.copyFileSync(profileConfig, configPath);
  setActiveProfile(profilesDir, name);

  return backupName;
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
      resolved = resolveProfile({
        cliProfile: profileArg,
        positional,
        env: process.env,
        profilesDir,
        managementSubcommands: MANAGEMENT_SUBCOMMANDS,
      });
    } catch (err) {
      if (err instanceof ResolveError) {
        const exitCode =
          err.code === "NO_PROFILE" || err.code === "PROFILE_NOT_FOUND" ? 2 : 1;
        die(err.message, exitCode);
      }
      throw err;
    }

    const profileCfg = path.join(profilesDir, resolved.name, "config.toml");
    const session = readSessionState(profileCfg);
    if (session.expired) {
      die(
        `Profile '${resolved.name}' has expired Wrangler OAuth credentials (expiration_time: ${session.expirationTime}). Run 'wrangler-accounts login ${resolved.name}' to refresh it.`,
        3
      );
    }

    // If positional was consumed as profile, drop it from wrangler argv
    const wranglerArgs = resolved.source === "positional" ? rest.slice(1) : rest;

    const result = runIsolated({
      profile: resolved.name,
      profileCfg,
      realHome: os.homedir(),
      command: "wrangler",
      args: wranglerArgs,
      baseEnv: process.env,
      cloudflaredPath: findCloudflared(),
    });
    process.exit(result.exitCode);
  }

  if (command === "list") {
    const profiles = listProfiles(profilesDir, { includeBackups });
    if (opts.json) {
      console.log(JSON.stringify(profiles, null, 2));
    } else if (opts.plain) {
      if (profiles.length) console.log(profiles.join("\n"));
    } else if (profiles.length === 0) {
      console.log("No profiles found.");
    } else {
      console.log(profiles.join("\n"));
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
        const profileConfig = path.join(profilesDir, name, "config.toml");
        const meta = readMeta(path.join(profilesDir, name));
        return [
          name,
          {
            ...readSessionState(profileConfig),
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
        if (!profileSession.expirationTime) continue;
        const state = profileSession.expired ? "expired" : "valid";
        const suffix = profileSession.identity ? `, ${describeIdentity(profileSession.identity)}` : "";
        console.log(`- ${name}: ${profileSession.expirationTime} (${state}${suffix ? suffix : ""})`);
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

  if (command === "login") {
    const name = rest[1];
    if (!name) die("Missing profile name for login");
    if (!isValidName(name)) die(`Invalid profile name: ${name}`);
    ensureDir(profilesDir);

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

    const env = buildIsolatedEnv({
      shadow,
      realHome,
      profile: name,
      baseEnv: process.env,
      cloudflaredPath: findCloudflared(),
    });

    const profileDir = path.join(profilesDir, name);
    const existed = fs.existsSync(profileDir);
    let identity = null;

    try {
      const loginResult = spawnSync("wrangler", ["login"], {
        stdio: "inherit",
        env,
      });
      if (loginResult.error) {
        die(`Failed to run 'wrangler login': ${loginResult.error.message}`);
      }
      if (loginResult.status !== 0) {
        die(`'wrangler login' exited with code ${loginResult.status}`);
      }

      const freshCfg = path.join(shadowWranglerConfig, "default.toml");
      if (!fs.existsSync(freshCfg)) {
        die(`wrangler login completed but no config was written at ${freshCfg}`);
      }

      // Verify identity via `wrangler whoami` in the same shadow.
      const whoamiResult = spawnSync("wrangler", ["whoami"], {
        env,
        encoding: "utf8",
      });
      const output = `${whoamiResult.stdout || ""}\n${whoamiResult.stderr || ""}`;
      identity = parseWranglerWhoamiOutput(output);
      if (!identity) {
        die("Login succeeded but could not parse 'wrangler whoami' output");
      }

      // Move the fresh config into the profile directory. Use writeFile
      // (copy) so the profile config is a real file, not a symlink.
      ensureDir(profileDir);
      const destCfg = path.join(profileDir, "config.toml");
      fs.copyFileSync(freshCfg, destCfg);
      writeMeta(profileDir, name, destCfg, identity);
    } finally {
      cleanupShadow(shadow);
    }

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

  if (command === "sync-active") {
    const { identity: currentIdentity } = loadCurrentIdentity();
    const active = getActiveProfile(profilesDir);
    if (!active) die("No active profile to sync");
    ensureDir(profilesDir);
    syncProfile(active, configPath, profilesDir, currentIdentity);
    if (opts.json) {
      console.log(
        JSON.stringify(
          {
            command: "sync-active",
            name: active,
            configPath,
            profilesDir,
            identity: currentIdentity,
          },
          null,
          2
        )
      );
    } else {
      console.log(`Synced current Wrangler login into active profile '${active}'`);
    }
    return;
  }

  if (command === "use") {
    const name = rest[1];
    if (!name) die("Missing profile name for use");
    ensureDir(profilesDir);
    const backupName = useProfile(name, configPath, profilesDir, opts.backup);
    const backupNote = backupName ? ` (backup: ${backupName})` : "";
    if (opts.json) {
      console.log(
        JSON.stringify(
          {
            command: "use",
            name,
            configPath,
            profilesDir,
            backupName,
          },
          null,
          2
        )
      );
    } else {
      console.log(`Switched to profile '${name}'${backupNote}`);
    }
    return;
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

  if (command === "exec") {
    const profileName = rest[1];
    if (!profileName) die("Missing profile name for exec", 2);

    let resolved;
    try {
      resolved = resolveProfile({
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

    const profileCfg = path.join(profilesDir, resolved.name, "config.toml");
    const session = readSessionState(profileCfg);
    if (session.expired) {
      die(
        `Profile '${resolved.name}' has expired Wrangler OAuth credentials. Run 'wrangler-accounts login ${resolved.name}' to refresh it.`,
        3
      );
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

    const result = runIsolated({
      profile: resolved.name,
      profileCfg,
      realHome: os.homedir(),
      command: cmd,
      args: cmdArgs,
      baseEnv: process.env,
      cloudflaredPath: findCloudflared(),
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
    const cfg = path.join(profilesDir, name, "config.toml");
    if (!fs.existsSync(cfg)) die(`Profile not found: ${name}`, 2);
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
