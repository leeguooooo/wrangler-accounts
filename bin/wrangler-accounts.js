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
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
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
    } else if (arg === "--config" || arg === "-c") {
      opts.config = argv[i + 1];
      if (!opts.config) die("Missing value for --config");
      i += 1;
    } else if (arg === "--profiles" || arg === "-p") {
      opts.profiles = argv[i + 1];
      if (!opts.profiles) die("Missing value for --profiles");
      i += 1;
    } else {
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
    ensureDir(profilesDir);
    runWranglerLogin();
    if (!fs.existsSync(configPath)) {
      die(`Config file not found after login: ${configPath}`);
    }
    const profileDir = path.join(profilesDir, name);
    const existed = fs.existsSync(profileDir);
    const refreshedIdentityResult = getCurrentIdentity(configPath);
    saveProfile(name, configPath, profilesDir, true, refreshedIdentityResult.identity);
    const note = existed ? " (overwritten)" : "";
    if (opts.json) {
      console.log(
        JSON.stringify(
          {
            command: "login",
            name,
            configPath,
            profilesDir,
            overwritten: existed,
            identity: refreshedIdentityResult.identity,
          },
          null,
          2
        )
      );
    } else {
      console.log(`Logged in and saved profile '${name}' from ${configPath}${note}`);
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

  die(`Unknown command: ${command}`);
}

main();
