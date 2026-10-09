'use strict';

// Wrangler's native auth profiles (wrangler >= 4.149, beta):
//   <globalConfig>/config/<name>.toml   plaintext, same TOML as default.toml
//   <globalConfig>/config/<name>.enc    AES-256-GCM envelope, key in the OS keyring
//   <globalConfig>/profiles/directory-bindings.json
// Everything here mirrors wrangler-dist/cli.js 4.149.0 (workers-auth); see
// docs/superpowers/specs/2026-10-09-native-profiles-design.md.

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { wranglerGlobalConfigDir } = require('./paths');
const { availableBackend, getBackend, backendName, SecretStoreError } = require('./secret-store');
const { findRealWrangler, getShimDir } = require('./shim');

const NATIVE_NAME_RE = /^[a-zA-Z0-9_-]+$/;
const RESERVED_NATIVE_NAMES = ['default', 'staging'];
const WRANGLER_KEY_SERVICE = 'wrangler';
const PROBE_CACHE = '.native-probe.json';

function nativeNameProblem(name) {
  if (!name) return 'empty name';
  if (RESERVED_NATIVE_NAMES.includes(String(name).toLowerCase())) {
    return `"${name}" is reserved by wrangler`;
  }
  if (!NATIVE_NAME_RE.test(name)) {
    return `"${name}" has characters wrangler profiles do not allow (only letters, digits, - and _)`;
  }
  return null;
}

/** A wrangler-valid name derived from a wrangler-accounts name. */
function suggestNativeName(name) {
  let candidate = String(name).replace(/[^a-zA-Z0-9_-]/g, '-');
  if (!candidate) return null;
  if (RESERVED_NATIVE_NAMES.includes(candidate.toLowerCase())) candidate = `${candidate}-wa`;
  return nativeNameProblem(candidate) ? null : candidate;
}

function nativePaths(nativeName, { env = process.env, home = os.homedir() } = {}) {
  const configDir = wranglerGlobalConfigDir(env, home);
  return {
    configDir,
    dir: path.join(configDir, 'config'),
    toml: path.join(configDir, 'config', `${nativeName}.toml`),
    enc: path.join(configDir, 'config', `${nativeName}.enc`),
    bindings: path.join(configDir, 'profiles', 'directory-bindings.json'),
    preferences: path.join(configDir, 'preferences.json'),
  };
}

/** 'encrypted' | 'plaintext' | 'missing' — wrangler reads .enc first. */
function nativeState(nativeName, opts = {}) {
  const p = nativePaths(nativeName, opts);
  if (fs.existsSync(p.enc)) return 'encrypted';
  if (fs.existsSync(p.toml)) return 'plaintext';
  return 'missing';
}

function keyringPreferenceEnabled(opts = {}) {
  try {
    const prefs = JSON.parse(fs.readFileSync(nativePaths('x', opts).preferences, 'utf8'));
    return prefs.keyring_enabled === true;
  } catch {
    return false;
  }
}

function readBindings(opts = {}) {
  try {
    return JSON.parse(fs.readFileSync(nativePaths('x', opts).bindings, 'utf8')) || {};
  } catch {
    return {};
  }
}

function bindingsFor(nativeName, opts = {}) {
  return Object.entries(readBindings(opts))
    .filter(([, p]) => p === nativeName)
    .map(([dir]) => dir);
}

// ---------------------------------------------------------------------------
// Encryption format (workers-auth): envelope {v:1, alg:"AES-256-GCM", iv, tag,
// ciphertext} (base64), key stored as JSON {v:1, key:<base64 32 bytes>, created}.

const ALG = 'AES-256-GCM';

function encodeKeyEnvelope(key) {
  return JSON.stringify({ v: 1, key: Buffer.from(key).toString('base64'), created: new Date().toISOString() });
}

function decodeKeyEnvelope(raw) {
  try {
    const parsed = JSON.parse(String(raw).trim());
    if (!parsed || parsed.v !== 1 || typeof parsed.key !== 'string') return null;
    const buf = Buffer.from(parsed.key, 'base64');
    return buf.length === 32 ? buf : null;
  } catch {
    return null;
  }
}

function encryptToEnvelope(plaintext, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    v: 1,
    alg: ALG,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
}

function decryptEnvelope(raw, key) {
  const env = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!env || env.v !== 1 || env.alg !== ALG) throw new Error('not a wrangler encrypted credentials file');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(env.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(env.tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(env.ciphertext, 'base64')), decipher.final()]).toString('utf8');
}

/** Which OS store holds wrangler's keys on this machine (tests: file:<dir>). */
function nativeKeyStore(env = process.env) {
  return availableBackend(env);
}

/** Wrangler's key for a profile, or null when there is none. Throws on store errors. */
function readNativeKey(nativeName, env = process.env) {
  const store = nativeKeyStore(env);
  if (!store) throw new SecretStoreError('no OS keyring available (macOS Keychain or Linux secret-tool)');
  let raw;
  try {
    raw = store.backend.get(nativeName, env, WRANGLER_KEY_SERVICE);
  } catch (err) {
    if (err && err.notFound) return null;
    throw err;
  }
  const key = decodeKeyEnvelope(raw);
  if (!key) throw new SecretStoreError(`the keyring entry for "${nativeName}" is not a wrangler key`);
  return key;
}

function deleteNativeKey(nativeName, env = process.env) {
  const store = nativeKeyStore(env);
  if (!store) return false;
  return store.backend.remove(nativeName, env, WRANGLER_KEY_SERVICE);
}

/** Plaintext TOML of an encrypted native profile (decrypted in memory). */
function decryptNativeProfile(nativeName, { env = process.env, home = os.homedir() } = {}) {
  const p = nativePaths(nativeName, { env, home });
  const key = readNativeKey(nativeName, env);
  if (!key) throw new Error(`no keyring key for wrangler profile "${nativeName}" (service "${WRANGLER_KEY_SERVICE}")`);
  return decryptEnvelope(fs.readFileSync(p.enc, 'utf8'), key);
}

/** Read a native profile's credentials as TOML text, whichever form it is in. */
function readNativeCredentials(nativeName, opts = {}) {
  const state = nativeState(nativeName, opts);
  if (state === 'plaintext') return fs.readFileSync(nativePaths(nativeName, opts).toml, 'utf8');
  if (state === 'encrypted') return decryptNativeProfile(nativeName, opts);
  return null;
}

function writeFileAtomic(filePath, data, mode = 0o600) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.wa-${process.pid}.tmp`;
  fs.writeFileSync(tmp, data, { mode });
  fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, filePath);
}

function looksLikeOAuthToml(text) {
  return /^\s*oauth_token\s*=\s*"[^"]+"/m.test(String(text || ''));
}

// ---------------------------------------------------------------------------
// Native support probe.

function statKey(p) {
  try {
    const real = fs.realpathSync(p);
    const st = fs.statSync(real);
    return { real, mtimeMs: Math.round(st.mtimeMs), size: st.size };
  } catch {
    return null;
  }
}

/**
 * Does the wrangler on PATH support native profiles? Runs
 * `wrangler auth --help` once per wrangler binary (cached by realpath, mtime
 * and size). WRANGLER_ACCOUNTS_NATIVE=0 forces "no", =1 forces "yes".
 */
function probeNativeSupport({ profilesDir = null, env = process.env, refresh = false, spawn = spawnSync } = {}) {
  if (env.WRANGLER_ACCOUNTS_NATIVE === '0') {
    return { supported: false, wrangler: null, reason: 'disabled by WRANGLER_ACCOUNTS_NATIVE=0' };
  }
  if (env.WRANGLER_ACCOUNTS_NATIVE === '1') {
    return { supported: true, wrangler: null, reason: 'forced by WRANGLER_ACCOUNTS_NATIVE=1' };
  }
  const wrangler = findRealWrangler({ pathEnv: env.PATH || '', shimDir: getShimDir(env) });
  if (!wrangler) return { supported: false, wrangler: null, reason: 'no wrangler on PATH' };
  const key = statKey(wrangler);
  const cachePath = profilesDir ? path.join(profilesDir, PROBE_CACHE) : null;
  if (!refresh && cachePath && key) {
    try {
      const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      if (cached.real === key.real && cached.mtimeMs === key.mtimeMs && cached.size === key.size) {
        return { supported: cached.supported, wrangler, version: cached.version || null, reason: cached.reason, cached: true };
      }
    } catch {
      /* no cache yet */
    }
  }
  const res = spawn(wrangler, ['auth', '--help'], {
    encoding: 'utf8',
    env: { ...env, WA_PASSTHROUGH: '1', WRANGLER_SEND_METRICS: 'false' },
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60000,
  });
  const out = `${res.stdout || ''}\n${res.stderr || ''}`;
  const supported = /wrangler auth create/.test(out) && /wrangler auth activate/.test(out);
  const versionMatch = out.match(/wrangler (\d+\.\d+\.\d+)/);
  const result = {
    supported,
    wrangler,
    version: versionMatch ? versionMatch[1] : null,
    reason: supported ? 'wrangler auth create/activate available' : 'this wrangler has no `wrangler auth create` (native profiles need wrangler >= 4.149)',
  };
  if (cachePath && key && !res.error) {
    try {
      fs.mkdirSync(path.dirname(cachePath), { recursive: true });
      fs.writeFileSync(cachePath, JSON.stringify({ ...key, supported, version: result.version, reason: result.reason, probedAt: new Date().toISOString() }, null, 2));
    } catch {
      /* cache is best effort */
    }
  }
  return result;
}

/**
 * Insert `--profile <name>` into a wrangler/cf argv: before a bare `--`, else
 * at the end. Leaves argv alone when it already selects a profile.
 */
function withProfileFlag(args, name) {
  if (args.some((a) => a === '--profile' || a.startsWith('--profile='))) return [...args];
  const idx = args.indexOf('--');
  if (idx === -1) return [...args, '--profile', name];
  return [...args.slice(0, idx), '--profile', name, ...args.slice(idx)];
}

function firstPositional(args) {
  for (const a of args) {
    if (a === '--') return null;
    if (!a.startsWith('-')) return a;
  }
  return null;
}

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

/**
 * Turn wrangler's stderr into a short one-line reason: no colour codes, no box
 * drawing, and no "Logs were written to <path>" line — that log lives in a
 * temp dir that is already deleted by the time the user reads the message.
 */
function cleanWranglerStderr(stderr) {
  return String(stderr || '')
    .replace(ANSI_RE, '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !/^[─┌└│╭╰]/.test(l) && !/Logs were written to/i.test(l))
    .map((l) => l.replace(/^(?:✘|X)\s*\[ERROR\]\s*/, ''))
    .slice(-3)
    .join(' ');
}

/**
 * Ask wrangler for the profile's OAuth token without printing it. Proves that
 * wrangler resolves the profile, can read (and if needed decrypt/refresh) it.
 */
function wranglerTokenCheck(nativeName, { env, spawn = spawnSync }) {
  // wrangler copies everything it prints — including this token — into its
  // debug log file (~/.wrangler/logs). Point the log at a private temp dir and
  // delete it, so verification never leaves the token on disk.
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-tokencheck-'));
  fs.chmodSync(logDir, 0o700);
  let res;
  try {
    res = spawn('wrangler', ['auth', 'token', '--json', '--profile', nativeName], {
      encoding: 'utf8',
      env: { ...env, WRANGLER_LOG_PATH: path.join(logDir, 'wrangler.log'), FORCE_COLOR: '0', NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120000,
    });
  } finally {
    fs.rmSync(logDir, { recursive: true, force: true });
  }
  if (res.error) return { ok: false, error: `could not run wrangler: ${res.error.message}` };
  const out = String(res.stdout || '');
  let parsed = null;
  const start = out.indexOf('{');
  const end = out.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try {
      parsed = JSON.parse(out.slice(start, end + 1));
    } catch {
      parsed = null;
    }
  }
  if (res.status === 0 && parsed && parsed.type === 'oauth' && parsed.token) return { ok: true };
  const err = cleanWranglerStderr(res.stderr);
  return { ok: false, error: `wrangler auth token exited ${res.status}${err ? `: ${err}` : ''}` };
}

module.exports = {
  NATIVE_NAME_RE,
  RESERVED_NATIVE_NAMES,
  WRANGLER_KEY_SERVICE,
  nativeNameProblem,
  suggestNativeName,
  nativePaths,
  nativeState,
  keyringPreferenceEnabled,
  readBindings,
  bindingsFor,
  encodeKeyEnvelope,
  decodeKeyEnvelope,
  encryptToEnvelope,
  decryptEnvelope,
  nativeKeyStore,
  readNativeKey,
  deleteNativeKey,
  decryptNativeProfile,
  readNativeCredentials,
  writeFileAtomic,
  looksLikeOAuthToml,
  probeNativeSupport,
  withProfileFlag,
  firstPositional,
  wranglerTokenCheck,
  backendName,
  getBackend,
};
