'use strict';

// Old wrangler (< 4.149, e.g. a project's locked 4.40) has no native profiles:
// it ignores directory bindings, `<name>.toml|.enc` and the keyring, and only
// reads <HOME>/.wrangler/config/default.toml. A bound shadow for a native
// profile therefore also gets a default.toml holding that profile's
// credentials, so `exec <name> -- npx wrangler ...` works with any wrangler.
//
//   plaintext native profile -> default.toml is a symlink to <name>.toml, so
//                               old wrangler's token refreshes write through.
//   encrypted native profile -> default.toml is a 0600 decrypted copy inside
//                               the 0700 shadow. After the run a refreshed
//                               copy is re-encrypted into <name>.enc with the
//                               same keyring key; the copy goes away with the
//                               shadow.

const fs = require('node:fs');
const path = require('node:path');

const native = require('./native');

const LEGACY_FILE = 'default.toml';

function warn(msg) {
  process.stderr.write(`[wrangler-accounts] ${msg}\n`);
}

function readOrNull(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Put an old-wrangler default.toml for a native profile into a shadow's
 * `.wrangler/config` dir. Returns a handle whose syncBack() must run after
 * the child exits (before the shadow is removed), or null when there is
 * nothing to provide. Never throws: a profile we cannot decrypt still works
 * for new wrangler, which reads the .enc itself.
 */
function provideLegacyDefaultToml({ configDir, nativeName, nativeFiles, env = process.env }) {
  const dest = path.join(configDir, LEGACY_FILE);
  // wrangler reads .enc first, so do we.
  if (nativeFiles.enc && fs.existsSync(nativeFiles.enc)) {
    let key;
    let encRaw;
    let text;
    try {
      key = native.readNativeKey(nativeName, env);
      if (!key) throw new Error(`no keyring key for wrangler profile "${nativeName}"`);
      encRaw = fs.readFileSync(nativeFiles.enc, 'utf8');
      text = native.decryptEnvelope(encRaw, key);
    } catch (err) {
      warn(`could not decrypt '${nativeName}' for wrangler < 4.149 (only newer wrangler will be logged in): ${err.message}`);
      return null;
    }
    fs.writeFileSync(dest, text, { mode: 0o600, flag: 'wx' });
    fs.chmodSync(dest, 0o600);
    return {
      mode: 'decrypted',
      syncBack() {
        const now = readOrNull(dest);
        // An old-wrangler `logout` removes only this copy; never propagate that.
        if (now === null || now === text || !native.looksLikeOAuthToml(now)) return false;
        if (readOrNull(nativeFiles.enc) !== encRaw) {
          warn(`'${nativeName}' was changed by another wrangler during this run; kept that version, dropped the old-wrangler token refresh`);
          return false;
        }
        native.writeFileAtomic(nativeFiles.enc, JSON.stringify(native.encryptToEnvelope(now, key), null, '\t'));
        return true;
      },
    };
  }
  if (nativeFiles.toml && fs.existsSync(nativeFiles.toml)) {
    fs.symlinkSync(nativeFiles.toml, dest);
    return { mode: 'symlink', syncBack: () => false };
  }
  return null;
}

const GUARDED_SIGNALS = ['SIGINT', 'SIGHUP'];

/**
 * Run fn() with Ctrl-C / hangup not killing this process, so the `finally`
 * that removes a decrypted copy always runs. The child still gets the signal
 * (same process group) and spawnSync returns once it exits.
 */
function withSignalsDeferred(fn) {
  const noop = () => {};
  for (const sig of GUARDED_SIGNALS) process.on(sig, noop);
  try {
    return fn();
  } finally {
    for (const sig of GUARDED_SIGNALS) process.removeListener(sig, noop);
  }
}

module.exports = {
  LEGACY_FILE,
  provideLegacyDefaultToml,
  withSignalsDeferred,
};
