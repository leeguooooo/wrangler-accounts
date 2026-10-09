'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  SecretStoreError,
  availableBackend,
  getBackend,
  secretAccount,
} = require('./secret-store');

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

function writeJsonPrivate(filePath, value) {
  // Write-then-rename so a crash never leaves a half-written credentials file.
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, filePath);
}

function updateMeta(profileDir, patch) {
  const meta = readMeta(profileDir) || {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined || value === null) delete meta[key];
    else meta[key] = value;
  }
  fs.writeFileSync(path.join(profileDir, 'meta.json'), JSON.stringify(meta, null, 2));
}

function storeSecretVerified(profilesDir, name, apiToken, env) {
  const selected = availableBackend(env);
  if (!selected) {
    throw new SecretStoreError(
      'No OS secret store available (macOS Keychain, or Linux secret-tool). The token stays in token.json.',
    );
  }
  const account = secretAccount(profilesDir, name);
  selected.backend.put(account, apiToken, `wrangler-accounts: ${name}`, env);
  let readBack = null;
  try {
    readBack = selected.backend.get(account, env);
  } catch (err) {
    readBack = null;
  }
  if (readBack !== apiToken) {
    selected.backend.remove(account, env);
    throw new SecretStoreError(`${selected.backend.label} did not return the token that was just stored; nothing changed.`);
  }
  return { store: selected.name, account };
}

function saveTokenProfile(name, apiToken, accountId, profilesDir, force, { protect = false, env = process.env } = {}) {
  if (!isValidName(name)) {
    throw new Error(`Invalid profile name: ${name}`);
  }

  const profileDir = path.join(profilesDir, name);
  if (fs.existsSync(profileDir) && !force) {
    throw new Error(`Profile exists: ${name} (use --force to overwrite)`);
  }
  const previous = readTokenCredentials(profileDir);

  // With protect, the secret goes to the OS store first and token.json never
  // holds it — not even briefly.
  const stored = protect ? storeSecretVerified(profilesDir, name, apiToken, env) : null;

  ensureDir(profileDir);
  const tokenPath = path.join(profileDir, 'token.json');
  writeJsonPrivate(
    tokenPath,
    stored
      ? { accountId, credentialStore: stored.store, secretAccount: stored.account }
      : { apiToken, accountId },
  );

  fs.writeFileSync(
    path.join(profileDir, 'meta.json'),
    JSON.stringify(
      {
        name,
        savedAt: new Date().toISOString(),
        type: 'token',
        accountId,
        ...(stored ? { credentialStore: stored.store } : {}),
      },
      null,
      2,
    ),
  );

  // Overwrote a protected profile with a different store entry (or none):
  // drop the stale secret.
  if (previous && previous.credentialStore && previous.secretAccount
      && !(stored && stored.store === previous.credentialStore && stored.account === previous.secretAccount)) {
    const backend = getBackend(previous.credentialStore, env);
    if (backend) backend.remove(previous.secretAccount, env);
  }
}

function readTokenCredentials(profileDir) {
  if (!profileDir) return null;
  const tokenPath = path.join(profileDir, 'token.json');
  if (!fs.existsSync(tokenPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Resolve a token profile to { apiToken, accountId }, fetching the token from
 * the OS secret store when the profile is protected. Throws SecretStoreError
 * when a protected token cannot be read (locked keychain, no session bus, ...).
 */
function resolveTokenCredentials(profileDir, env = process.env) {
  const creds = readTokenCredentials(profileDir);
  if (!creds) return null;
  if (!creds.credentialStore) return creds;
  const backend = getBackend(creds.credentialStore, env);
  if (!backend) {
    throw new SecretStoreError(`unknown credential store '${creds.credentialStore}'`);
  }
  return { accountId: creds.accountId, apiToken: backend.get(creds.secretAccount, env) };
}

/**
 * Move a token profile's API token from token.json into the OS secret store.
 * The plaintext file is only rewritten after the stored value reads back
 * identical, so a failure at any step leaves the profile exactly as it was.
 */
function protectTokenProfile(profilesDir, name, { env = process.env } = {}) {
  if (!isValidName(name)) throw new Error(`Invalid profile name: ${name}`);
  const profileDir = path.join(profilesDir, name);
  const type = getProfileType(profileDir);
  if (!type) throw new Error(`Profile not found: ${name}`);
  if (type !== 'token') return { name, status: 'skipped', reason: 'oauth profiles cannot be protected yet' };
  const creds = readTokenCredentials(profileDir);
  if (creds && creds.credentialStore) return { name, status: 'already', store: creds.credentialStore };
  if (!creds || !creds.apiToken) throw new Error(`Token profile '${name}' has no apiToken in token.json`);

  const stored = storeSecretVerified(profilesDir, name, creds.apiToken, env);
  writeJsonPrivate(path.join(profileDir, 'token.json'), {
    accountId: creds.accountId,
    credentialStore: stored.store,
    secretAccount: stored.account,
  });
  updateMeta(profileDir, { credentialStore: stored.store });
  return { name, status: 'protected', store: stored.store };
}

/** Reverse of protectTokenProfile: put the token back into token.json (0600). */
function unprotectTokenProfile(profilesDir, name, { env = process.env } = {}) {
  if (!isValidName(name)) throw new Error(`Invalid profile name: ${name}`);
  const profileDir = path.join(profilesDir, name);
  const type = getProfileType(profileDir);
  if (!type) throw new Error(`Profile not found: ${name}`);
  if (type !== 'token') return { name, status: 'skipped', reason: 'oauth profiles are not protected' };
  const creds = readTokenCredentials(profileDir);
  if (!creds || !creds.credentialStore) return { name, status: 'already' };

  const { apiToken } = resolveTokenCredentials(profileDir, env);
  const tokenPath = path.join(profileDir, 'token.json');
  writeJsonPrivate(tokenPath, { apiToken, accountId: creds.accountId });
  const check = readTokenCredentials(profileDir);
  if (!check || check.apiToken !== apiToken) {
    throw new Error(`Could not write ${tokenPath}; the token is still in the secret store.`);
  }
  updateMeta(profileDir, { credentialStore: null });
  const backend = getBackend(creds.credentialStore, env);
  const removed = backend ? backend.remove(creds.secretAccount, env) : false;
  return { name, status: 'unprotected', store: creds.credentialStore, secretRemoved: removed };
}

function readTokenSessionState() {
  return {
    expirationTime: null,
    expired: null,
    hasRefreshToken: false,
    effective: 'token',
  };
}

/**
 * Set or clear the human-readable note for a profile.
 * Stored as `description` inside meta.json. Pass null/empty to clear.
 */
function setProfileNote(profilesDir, name, note) {
  if (!isValidName(name)) {
    throw new Error(`Invalid profile name: ${name}`);
  }
  const profileDir = path.join(profilesDir, name);
  if (!fs.existsSync(profileDir)) {
    throw new Error(`Profile not found: ${name}`);
  }
  const meta = readMeta(profileDir) || { name };
  if (note && note.trim()) {
    meta.description = note.trim();
  } else {
    delete meta.description;
  }
  fs.writeFileSync(path.join(profileDir, 'meta.json'), JSON.stringify(meta, null, 2));
}

function removeProfile(name, profilesDir, { env = process.env } = {}) {
  if (!isValidName(name)) {
    throw new Error(`Invalid profile name: ${name}`);
  }
  const profileDir = path.join(profilesDir, name);
  if (!fs.existsSync(profileDir)) {
    throw new Error(`Profile not found: ${name}`);
  }
  const creds = readTokenCredentials(profileDir);

  fs.rmSync(profileDir, { recursive: true, force: true });

  if (creds && creds.credentialStore && creds.secretAccount) {
    const backend = getBackend(creds.credentialStore, env);
    if (backend) backend.remove(creds.secretAccount, env);
  }

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
  resolveTokenCredentials,
  protectTokenProfile,
  unprotectTokenProfile,
  setProfileNote,
  removeProfile,
};
