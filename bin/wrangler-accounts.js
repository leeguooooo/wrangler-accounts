#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { spawnSync } = require("child_process");

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
  use <name>
  remove <name>

Options:
  -c, --config <path>     Wrangler config path
  -p, --profiles <path>   Profiles directory
  --json                  JSON output for all commands
  --plain                 Plain output for list (one name per line)
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
  wrangler-accounts use personal
`;
  console.log(text);
  process.exit(exitCode);
}

function expandHome(p) {
  if (!p) return p;
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

function resolvePath(p) {
  if (!p) return p;
  return path.resolve(expandHome(p));
}

function parseArgs(argv) {
  const opts = {
    json: false,
    force: false,
    backup: true,
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

function detectConfigPath(cliPath) {
  if (cliPath) return resolvePath(cliPath);
  if (process.env.WRANGLER_CONFIG_PATH) {
    return resolvePath(process.env.WRANGLER_CONFIG_PATH);
  }

  const home = os.homedir();
  const candidates = [
    path.join(home, ".wrangler", "config", "default.toml"),
    path.join(home, "Library", "Preferences", ".wrangler", "config", "default.toml"),
    path.join(home, ".config", ".wrangler", "config", "default.toml"),
    path.join(home, ".config", "wrangler", "config", "default.toml"),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  return candidates[0];
}

function detectProfilesDir(cliPath) {
  if (cliPath) return resolvePath(cliPath);
  if (process.env.WRANGLER_ACCOUNTS_DIR) {
    return resolvePath(process.env.WRANGLER_ACCOUNTS_DIR);
  }

  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg) return path.join(resolvePath(xdg), "wrangler-accounts");

  return path.join(os.homedir(), ".config", "wrangler-accounts");
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function isValidName(name) {
  return /^[A-Za-z0-9._-]+$/.test(name);
}

function listProfiles(profilesDir) {
  if (!fs.existsSync(profilesDir)) return [];
  const entries = fs.readdirSync(profilesDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => fs.existsSync(path.join(profilesDir, name, "config.toml")))
    .sort();
}

function fileHash(filePath) {
  const data = fs.readFileSync(filePath);
  return crypto.createHash("sha256").update(data).digest("hex");
}

function filesEqual(pathA, pathB) {
  if (!fs.existsSync(pathA) || !fs.existsSync(pathB)) return false;
  const statA = fs.statSync(pathA);
  const statB = fs.statSync(pathB);
  if (statA.size !== statB.size) return false;
  return fileHash(pathA) === fileHash(pathB);
}

function writeMeta(profileDir, name, sourcePath) {
  const configPath = path.join(profileDir, "config.toml");
  const stat = fs.statSync(configPath);
  const meta = {
    name,
    savedAt: new Date().toISOString(),
    sourcePath,
    bytes: stat.size,
    sha256: fileHash(configPath),
  };
  fs.writeFileSync(path.join(profileDir, "meta.json"), JSON.stringify(meta, null, 2));
}

function setActiveProfile(profilesDir, name) {
  ensureDir(profilesDir);
  fs.writeFileSync(path.join(profilesDir, "active"), `${name}\n`);
}

function getActiveProfile(profilesDir) {
  const activePath = path.join(profilesDir, "active");
  if (!fs.existsSync(activePath)) return null;
  const value = fs.readFileSync(activePath, "utf8").trim();
  return value.length ? value : null;
}

function timestampForFile() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    "-",
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds()),
  ].join("");
}

function backupCurrentConfig(configPath, profilesDir) {
  const backupName = `__backup-${timestampForFile()}`;
  const backupDir = path.join(profilesDir, backupName);
  ensureDir(backupDir);
  fs.copyFileSync(configPath, path.join(backupDir, "config.toml"));
  writeMeta(backupDir, backupName, configPath);
  return backupName;
}

function findMatchingProfile(profilesDir, configPath) {
  if (!fs.existsSync(configPath)) return null;
  const configHash = fileHash(configPath);
  const profiles = listProfiles(profilesDir);
  for (const name of profiles) {
    const profileConfig = path.join(profilesDir, name, "config.toml");
    if (fileHash(profileConfig) === configHash) return name;
  }
  return null;
}

function saveProfile(name, configPath, profilesDir, force) {
  if (!isValidName(name)) {
    die(`Invalid profile name: ${name}`);
  }
  if (!fs.existsSync(configPath)) {
    die(`Config file not found: ${configPath}`);
  }

  const profileDir = path.join(profilesDir, name);
  if (fs.existsSync(profileDir) && !force) {
    die(`Profile exists: ${name} (use --force to overwrite)`);
  }

  ensureDir(profileDir);
  fs.copyFileSync(configPath, path.join(profileDir, "config.toml"));
  writeMeta(profileDir, name, configPath);
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

  let backupName = null;
  if (backup && fs.existsSync(configPath) && !filesEqual(configPath, profileConfig)) {
    backupName = backupCurrentConfig(configPath, profilesDir);
  }

  ensureDir(path.dirname(configPath));
  fs.copyFileSync(profileConfig, configPath);
  setActiveProfile(profilesDir, name);

  return backupName;
}

function removeProfile(name, profilesDir) {
  if (!isValidName(name)) {
    die(`Invalid profile name: ${name}`);
  }
  const profileDir = path.join(profilesDir, name);
  if (!fs.existsSync(profileDir)) {
    die(`Profile not found: ${name}`);
  }

  fs.rmSync(profileDir, { recursive: true, force: true });

  const active = getActiveProfile(profilesDir);
  if (active === name) {
    const activePath = path.join(profilesDir, "active");
    if (fs.existsSync(activePath)) fs.unlinkSync(activePath);
  }
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

  if (command === "list") {
    const profiles = listProfiles(profilesDir);
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
    const profiles = listProfiles(profilesDir);
    const active = getActiveProfile(profilesDir);
    const match = findMatchingProfile(profilesDir, configPath);
    const payload = {
      configPath,
      configExists: fs.existsSync(configPath),
      profilesDir,
      profileCount: profiles.length,
      profiles,
      activeProfile: active,
      matchingProfile: match,
    };

    if (opts.json) {
      console.log(JSON.stringify(payload, null, 2));
    } else {
      console.log(`Config: ${payload.configPath} (${payload.configExists ? "exists" : "missing"})`);
      console.log(`Profiles: ${payload.profilesDir} (${payload.profileCount})`);
      console.log(`Active: ${payload.activeProfile || "-"}`);
      console.log(`Match: ${payload.matchingProfile || "-"}`);
    }
    return;
  }

  if (command === "save") {
    const name = rest[1];
    if (!name) die("Missing profile name for save");
    ensureDir(profilesDir);
    const profileDir = path.join(profilesDir, name);
    const existed = fs.existsSync(profileDir);
    saveProfile(name, configPath, profilesDir, opts.force);
    if (opts.json) {
      console.log(
        JSON.stringify(
          {
            command: "save",
            name,
            configPath,
            profilesDir,
            overwritten: existed,
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
    saveProfile(name, configPath, profilesDir, true);
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
