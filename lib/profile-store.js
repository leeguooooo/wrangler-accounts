'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function isValidName(name) {
  return /^[A-Za-z0-9._-]+$/.test(name);
}

function isBackupName(name) {
  return name.startsWith('__backup-');
}

function getProfileType(profileDir) {
  if (!profileDir || !fs.existsSync(profileDir)) return null;
  if (fs.existsSync(path.join(profileDir, 'config.toml'))) return 'oauth';
  if (fs.existsSync(path.join(profileDir, 'token.json'))) return 'token';
  return null;
}

function listProfiles(profilesDir, { includeBackups = false } = {}) {
  if (!fs.existsSync(profilesDir)) return [];
  const entries = fs.readdirSync(profilesDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => includeBackups || !isBackupName(name))
    .filter((name) => getProfileType(path.join(profilesDir, name)) !== null)
    .sort();
}

function fileHash(filePath) {
  const data = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(data).digest('hex');
}

function readExpirationTime(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const text = fs.readFileSync(filePath, 'utf8');
  const match = text.match(/^\s*expiration_time\s*=\s*"([^"]+)"/m);
  return match ? match[1] : null;
}

function hasRefreshToken(filePath) {
  if (!fs.existsSync(filePath)) return false;
  const text = fs.readFileSync(filePath, 'utf8');
  // Any non-empty string value counts. Cloudflare's offline_access scope
  // causes wrangler to store a refresh_token; profiles without that scope
  // won't have one, and those are "really expired" once the access token
  // runs out (~1h).
  return /^\s*refresh_token\s*=\s*"[^"]+"/m.test(text);
}

/**
 * Read the session state of a profile config.toml.
 *
 * Returns:
 *   expirationTime:    ISO string of access_token expiry, or null
 *   expired:           boolean — access_token past expirationTime, or null
 *   hasRefreshToken:   boolean — whether the profile has a refresh_token
 *                      that wrangler will auto-use for silent refresh
 *   effective:         'valid' | 'refreshable' | 'expired' | 'unknown'
 *     - 'valid':       access_token currently valid
 *     - 'refreshable': access_token past expiry but refresh_token present,
 *                      so wrangler will auto-refresh on next use (no user
 *                      action needed)
 *     - 'expired':     access_token past expiry AND no refresh_token,
 *                      profile is genuinely broken, user must re-login
 *     - 'unknown':     no expiration_time field, can't tell statically
 */
function readSessionState(filePath) {
  const expirationTime = readExpirationTime(filePath);
  const refreshable = hasRefreshToken(filePath);

  if (!expirationTime) {
    return {
      expirationTime: null,
      expired: null,
      hasRefreshToken: refreshable,
      effective: 'unknown',
    };
  }

  const expiresAt = new Date(expirationTime);
  if (Number.isNaN(expiresAt.getTime())) {
    return {
      expirationTime,
      expired: null,
      hasRefreshToken: refreshable,
      effective: 'unknown',
    };
  }

  const expired = expiresAt.getTime() <= Date.now();

  let effective;
  if (!expired) {
    effective = 'valid';
  } else if (refreshable) {
    effective = 'refreshable';
  } else {
    effective = 'expired';
  }

  return {
    expirationTime,
    expired,
    hasRefreshToken: refreshable,
    effective,
  };
}

function filesEqual(pathA, pathB) {
  if (!fs.existsSync(pathA) || !fs.existsSync(pathB)) return false;
  const statA = fs.statSync(pathA);
  const statB = fs.statSync(pathB);
  if (statA.size !== statB.size) return false;
  return fileHash(pathA) === fileHash(pathB);
}

function writeMeta(profileDir, name, sourcePath, identity = null) {
  const configPath = path.join(profileDir, 'config.toml');
  const stat = fs.statSync(configPath);
  const meta = {
    name,
    savedAt: new Date().toISOString(),
    sourcePath,
    bytes: stat.size,
    sha256: fileHash(configPath),
  };
  if (identity) {
    meta.identity = identity;
  }
  fs.writeFileSync(path.join(profileDir, 'meta.json'), JSON.stringify(meta, null, 2));
}

function readMeta(profileDir) {
  const metaPath = path.join(profileDir, 'meta.json');
  if (!fs.existsSync(metaPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  } catch {
    return null;
  }
}

function setActiveProfile(profilesDir, name) {
  ensureDir(profilesDir);
  fs.writeFileSync(path.join(profilesDir, 'active'), `${name}\n`);
}

function getActiveProfile(profilesDir) {
  const activePath = path.join(profilesDir, 'active');
  if (!fs.existsSync(activePath)) return null;
  const value = fs.readFileSync(activePath, 'utf8').trim();
  return value.length ? value : null;
}

function getDefaultProfile(profilesDir) {
  const p = path.join(profilesDir, 'default');
  if (!fs.existsSync(p)) return null;
  const raw = fs.readFileSync(p, 'utf8').trim();
  return raw.length ? raw : null;
}

function setDefaultProfile(profilesDir, name) {
  ensureDir(profilesDir);
  fs.writeFileSync(path.join(profilesDir, 'default'), `${name}\n`);
}

function unsetDefaultProfile(profilesDir) {
  const p = path.join(profilesDir, 'default');
  if (fs.existsSync(p)) fs.unlinkSync(p);
}

function timestampForFile() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    '-',
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds()),
  ].join('');
}

function backupCurrentConfig(configPath, profilesDir) {
  const backupName = `__backup-${timestampForFile()}`;
  const backupDir = path.join(profilesDir, backupName);
  ensureDir(backupDir);
  fs.copyFileSync(configPath, path.join(backupDir, 'config.toml'));
  writeMeta(backupDir, backupName, configPath);
  return backupName;
}

function findMatchingProfile(profilesDir, configPath, { includeBackups = false } = {}) {
  if (!fs.existsSync(configPath)) return null;
  const configHash = fileHash(configPath);
  const profiles = listProfiles(profilesDir, { includeBackups });
  for (const name of profiles) {
    const profileDir = path.join(profilesDir, name);
    if (getProfileType(profileDir) !== 'oauth') continue;
    const profileConfig = path.join(profileDir, 'config.toml');
    if (fileHash(profileConfig) === configHash) return name;
  }
  return null;
}

function saveProfile(name, configPath, profilesDir, force, identity = null) {
  if (!isValidName(name)) {
    throw new Error(`Invalid profile name: ${name}`);
  }
  if (!fs.existsSync(configPath)) {
    throw new Error(`Config file not found: ${configPath}`);
  }

  const profileDir = path.join(profilesDir, name);
  if (fs.existsSync(profileDir) && !force) {
    throw new Error(`Profile exists: ${name} (use --force to overwrite)`);
  }

  ensureDir(profileDir);
  fs.copyFileSync(configPath, path.join(profileDir, 'config.toml'));
  writeMeta(profileDir, name, configPath, identity);
}

function saveTokenProfile(name, apiToken, accountId, profilesDir, force) {
  if (!isValidName(name)) {
    throw new Error(`Invalid profile name: ${name}`);
  }

  const profileDir = path.join(profilesDir, name);
  if (fs.existsSync(profileDir) && !force) {
    throw new Error(`Profile exists: ${name} (use --force to overwrite)`);
  }

  ensureDir(profileDir);

  const tokenPath = path.join(profileDir, 'token.json');
  fs.writeFileSync(
    tokenPath,
    JSON.stringify({ apiToken, accountId }, null, 2),
  );
  fs.chmodSync(tokenPath, 0o600);

  fs.writeFileSync(
    path.join(profileDir, 'meta.json'),
    JSON.stringify(
      {
        name,
        savedAt: new Date().toISOString(),
        type: 'token',
        accountId,
      },
      null,
      2,
    ),
  );
}

function readTokenCredentials(profileDir) {
  const tokenPath = path.join(profileDir, 'token.json');
  if (!fs.existsSync(tokenPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
  } catch {
    return null;
  }
}

function readTokenSessionState() {
  return {
    expirationTime: null,
    expired: null,
    hasRefreshToken: false,
    effective: 'token',
  };
}

function removeProfile(name, profilesDir) {
  if (!isValidName(name)) {
    throw new Error(`Invalid profile name: ${name}`);
  }
  const profileDir = path.join(profilesDir, name);
  if (!fs.existsSync(profileDir)) {
    throw new Error(`Profile not found: ${name}`);
  }

  fs.rmSync(profileDir, { recursive: true, force: true });

  const active = getActiveProfile(profilesDir);
  if (active === name) {
    const activePath = path.join(profilesDir, 'active');
    if (fs.existsSync(activePath)) fs.unlinkSync(activePath);
  }
}

module.exports = {
  ensureDir,
  isValidName,
  isBackupName,
  getProfileType,
  listProfiles,
  fileHash,
  readExpirationTime,
  readSessionState,
  readTokenSessionState,
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
  saveProfile,
  saveTokenProfile,
  readTokenCredentials,
  removeProfile,
};
