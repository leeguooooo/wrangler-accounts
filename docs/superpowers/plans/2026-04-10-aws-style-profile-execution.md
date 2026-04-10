# AWS-style Profile Execution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship v1.0 of `wrangler-accounts` with AWS-style profile execution — per-invocation isolation (`wrangler-accounts --profile work deploy`), session mode (`wrangler-accounts exec work -- npm run deploy`), and a `default` profile — backed by a shadow HOME mechanism that safely syncs OAuth token refreshes back to saved profiles.

**Architecture:** The existing ~770-line single-file CLI (`bin/wrangler-accounts.js`) is refactored into a thin dispatcher plus a small `lib/` of focused modules. A new `lib/isolation.js` creates a per-invocation shadow HOME (a tmpdir that symlinks most of real `$HOME` back out, except `.wrangler`) with the profile's `config.toml` symlinked at `<shadow>/.wrangler/config/default.toml` so Wrangler's in-place `writeFileSync` token refreshes flow straight back into the profile file. A new `lib/resolve.js` implements AWS-style profile resolution (`--profile > $WRANGLER_PROFILE > profilesDir/default > error`). Management commands (`list/status/save/sync/remove`) keep their v0 behavior. New commands (`default/whoami/exec/gc/sync-default`) are added. `use` and `sync-active` become deprecated aliases.

**Tech Stack:** Node.js ≥16 (already in `engines`), `node:test` as the test runner (built in, zero new deps), `node:assert/strict` for assertions. No TypeScript, no build step, no lint config — match the existing minimalism.

**Spec reference:** `docs/superpowers/specs/2026-04-10-aws-style-profile-execution-design.md` — consult this for behavioral details that the plan references by section rather than restating.

---

## File structure (target state after this plan)

```
bin/
  wrangler-accounts.js         # CLI entry: arg parsing + command dispatch only (shrinks from ~770 → ~250 LOC)
lib/
  paths.js                     # detectConfigPath, detectProfilesDir, resolvePath, expandHome
  profile-store.js             # listProfiles, saveProfile, removeProfile, readMeta, writeMeta, readSessionState, file hashing, active/default file I/O
  identity.js                  # parseWranglerWhoamiOutput, getCurrentIdentity, identitiesMatch, describeIdentity, getMetaIdentity, findProfilesByIdentity
  resolve.js                   # resolveProfile (NEW)
  isolation.js                 # createShadowHome, buildIsolatedEnv, runIsolated, cleanupShadow (NEW)
test/
  paths.test.js                # characterization tests for extracted helpers
  profile-store.test.js        # CRUD, meta, session-state tests
  identity.test.js             # whoami parsing, identity matching
  resolve.test.js              # precedence order (NEW)
  isolation.test.js            # shadow HOME structure, env injection, cleanup (NEW)
  integration.test.js          # end-to-end with fake wrangler binary (NEW)
  fixtures/
    fake-wrangler.sh           # shell script that dumps env and argv to sentinel file
completions/
  wrangler-accounts.zsh        # extended with new commands
README.md                       # rewritten lead; management commands demoted below exec/profile
skills/wrangler-accounts/SKILL.md  # rewritten Tasks section
docs/superpowers/specs/...      # already exists, untouched
docs/superpowers/plans/...      # this file
package.json                    # version 1.0.0, test script added
```

**Responsibility boundaries:**
- `lib/paths.js` — pure filesystem path resolution. No I/O except `fs.existsSync` for candidate scanning. No `process.exit`.
- `lib/profile-store.js` — all profile directory mutations and reads. Returns data or throws `Error`; never exits the process.
- `lib/identity.js` — shells out to `wrangler whoami`, parses it, compares identities. The only module that `spawnSync('wrangler', ['whoami'])`.
- `lib/resolve.js` — pure function from `(cliProfile, env, profileStore) → { name, source }` or throws a structured error.
- `lib/isolation.js` — all shadow HOME lifecycle and child-process spawning with isolated env. The only module that reads real `$HOME`.
- `bin/wrangler-accounts.js` — arg parsing, JSON output formatting, routing each subcommand to a lib function, `die()` + exit codes. Contains the top-level `main()`.

**YAGNI guardrails for the implementer:**
- Do not add TypeScript, a bundler, ESM, a linter, a format config, or a CI workflow in this plan. The repo is CommonJS + plain JS on purpose.
- Do not add a logging library. `console.log` / `console.error` are sufficient.
- Do not add a retry library, a CLI framework (yargs / commander), or `chalk`. The existing hand-rolled parser stays.
- Do not refactor anything unrelated to this plan. If you notice a drive-by improvement, skip it.

---

## Task 1: Add test scaffolding and a baseline smoke test

**Goal:** Get `npm test` working against the current behavior before touching production code.

**Files:**
- Modify: `package.json`
- Create: `test/smoke.test.js`
- Create: `.gitignore` entries if needed

- [ ] **Step 1: Add test script to package.json**

Modify `package.json` to add a `scripts.test` field (do not add any dependencies):

```json
"scripts": {
  "test": "node --test test/"
}
```

- [ ] **Step 2: Write a baseline smoke test that exercises the v0 CLI**

Create `test/smoke.test.js` — drives `bin/wrangler-accounts.js` through `child_process.spawnSync` against a temporary `--profiles` directory to lock in v0 behavior. The test must cover at minimum:

- `list` against an empty profiles dir prints "No profiles found."
- `list --json` against empty dir prints `[]`
- `save workname` with a stub config file creates `<profilesDir>/workname/config.toml` and `meta.json`
- `list` after save prints `workname`
- `remove workname` removes the directory
- Invalid profile name (e.g. `bad name!`) exits non-zero with "Invalid profile name"

The test constructs a fake wrangler config file under a tmpdir and passes it via `-c`. Use `fs.mkdtempSync(path.join(os.tmpdir(), 'wa-test-'))` for isolation. Each test case should use its own tmpdir. Do not run commands that invoke `wrangler` (the `status` and `save` code paths call `getCurrentIdentity` which spawns wrangler — for this smoke test, use commands that don't touch identity: `list`, `remove`, and a minimal `save` path that can tolerate missing wrangler).

Full example skeleton (implementer should expand):

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CLI = path.join(__dirname, '..', 'bin', 'wrangler-accounts.js');

function runCli(args, { profilesDir, configPath, env = {} } = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      WRANGLER_ACCOUNTS_DIR: profilesDir,
      WRANGLER_CONFIG_PATH: configPath,
      ...env,
    },
  });
}

function mkTmp(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `wa-test-${name}-`));
}

test('list on empty dir prints no-profiles message', () => {
  const dir = mkTmp('list-empty');
  const r = runCli(['list'], { profilesDir: dir });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /No profiles found\./);
});

test('list --json on empty dir prints []', () => {
  const dir = mkTmp('list-json');
  const r = runCli(['list', '--json'], { profilesDir: dir });
  assert.equal(r.status, 0);
  assert.deepEqual(JSON.parse(r.stdout), []);
});

// ...etc
```

- [ ] **Step 3: Run the smoke test**

Run: `npm test`
Expected: all test cases pass against the existing `bin/wrangler-accounts.js`.

- [ ] **Step 4: Commit**

```bash
git add package.json test/smoke.test.js
git commit -m "test: add node:test scaffolding and v0 CLI smoke test"
```

---

## Task 2: Extract `lib/paths.js`

**Goal:** Move path detection helpers out of `bin/wrangler-accounts.js` with zero behavior change. Add unit tests.

**Files:**
- Create: `lib/paths.js`
- Create: `test/paths.test.js`
- Modify: `bin/wrangler-accounts.js` (remove extracted functions, import from `lib/paths.js`)

- [ ] **Step 1: Write failing tests for paths module**

Create `test/paths.test.js` with tests for:

- `expandHome('~')` → `os.homedir()`
- `expandHome('~/foo')` → `path.join(os.homedir(), 'foo')`
- `expandHome('/abs')` → `'/abs'` (unchanged)
- `expandHome('rel')` → `'rel'` (unchanged)
- `resolvePath('~/x')` → absolute path under home
- `detectConfigPath('/explicit/path')` → `/explicit/path` resolved
- `detectConfigPath()` with `WRANGLER_CONFIG_PATH=/env/path` in env → resolved env path (use a sub-module trick or pass env in)
- `detectProfilesDir('/explicit')` → resolved
- `detectProfilesDir()` with `WRANGLER_ACCOUNTS_DIR=/env` → resolved
- `detectProfilesDir()` with `XDG_CONFIG_HOME=/xdg` → `/xdg/wrangler-accounts`

**Important:** `detectConfigPath` currently reads `process.env` directly. For testability, refactor its signature to accept an optional `env` parameter that defaults to `process.env`. Same for `detectProfilesDir`. This is a one-line change and keeps the existing callers working.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- --test-name-pattern paths`
Expected: FAIL (module not found)

- [ ] **Step 3: Create `lib/paths.js` by moving functions verbatim**

Copy these functions from `bin/wrangler-accounts.js` into `lib/paths.js` and export them (CommonJS):

- `expandHome(p)`
- `resolvePath(p)`
- `detectConfigPath(cliPath, env = process.env)` — add env param
- `detectProfilesDir(cliPath, env = process.env)` — add env param

Module:

```js
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function expandHome(p) { /* ...unchanged body... */ }
function resolvePath(p) { /* ...unchanged body... */ }
function detectConfigPath(cliPath, env = process.env) { /* ... */ }
function detectProfilesDir(cliPath, env = process.env) { /* ... */ }

module.exports = { expandHome, resolvePath, detectConfigPath, detectProfilesDir };
```

- [ ] **Step 4: Update `bin/wrangler-accounts.js` to import from `lib/paths.js`**

Delete the function bodies from the bin file and add at the top:

```js
const {
  expandHome,
  resolvePath,
  detectConfigPath,
  detectProfilesDir,
} = require('../lib/paths');
```

- [ ] **Step 5: Run tests**

Run: `npm test`
Expected: PASS — both the new paths tests and the existing smoke test.

- [ ] **Step 6: Commit**

```bash
git add lib/paths.js test/paths.test.js bin/wrangler-accounts.js
git commit -m "refactor: extract path detection helpers into lib/paths.js"
```

---

## Task 3: Extract `lib/profile-store.js`

**Goal:** Move all profile directory CRUD, meta, session state, active/default file I/O into `lib/profile-store.js`.

**Files:**
- Create: `lib/profile-store.js`
- Create: `test/profile-store.test.js`
- Modify: `bin/wrangler-accounts.js`

- [ ] **Step 1: Write failing tests**

Create `test/profile-store.test.js` with tests covering:

- `listProfiles(dir)` on empty dir returns `[]`
- `listProfiles(dir)` excludes backup dirs (`__backup-*`) by default
- `listProfiles(dir, { includeBackups: true })` includes them
- `listProfiles(dir)` requires `config.toml` to exist (skips dirs without it)
- `isValidName('abc_1.2-3')` → true
- `isValidName('bad name!')` → false
- `saveProfile('work', configPath, dir)` creates `dir/work/config.toml` and `dir/work/meta.json`
- `saveProfile` throws when target exists and `force` is false
- `saveProfile` overwrites when `force` is true
- `readMeta` returns parsed JSON or null for missing/corrupt file
- `writeMeta` produces meta with `name`, `savedAt`, `sourcePath`, `bytes`, `sha256` fields
- `readSessionState` returns `{ expirationTime, expired }` for a TOML with expiration_time
- `readSessionState` returns `{ expirationTime: null, expired: null }` for config without it
- `findMatchingProfile(dir, configPath)` hashes and finds a profile whose config matches
- `removeProfile('work', dir)` removes the directory
- `removeProfile` clears `active` file if active profile was removed
- `getActiveProfile(dir)` / `setActiveProfile(dir, name)` round-trip
- `getDefaultProfile(dir)` returns null if no default file, else the trimmed content
- `setDefaultProfile(dir, name)` writes `profilesDir/default` as a plain text file
- `unsetDefaultProfile(dir)` removes the default file (idempotent)

- [ ] **Step 2: Run tests — fail**

Run: `npm test -- --test-name-pattern profile-store`
Expected: FAIL (module not found)

- [ ] **Step 3: Create `lib/profile-store.js`**

Move these functions verbatim from `bin/wrangler-accounts.js`:

- `ensureDir`
- `isValidName`
- `isBackupName`
- `listProfiles`
- `fileHash`
- `readExpirationTime`
- `readSessionState`
- `writeMeta`
- `readMeta`
- `filesEqual`
- `setActiveProfile`
- `getActiveProfile`
- `timestampForFile`
- `backupCurrentConfig`
- `findMatchingProfile`
- `saveProfile`
- `removeProfile`

Add three **NEW** functions (the `default` file mechanism):

```js
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
```

Export everything.

- [ ] **Step 4: Update `bin/wrangler-accounts.js` to import**

Replace deleted function definitions with `require('../lib/profile-store')` destructuring.

- [ ] **Step 5: Run tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/profile-store.js test/profile-store.test.js bin/wrangler-accounts.js
git commit -m "refactor: extract profile storage into lib/profile-store.js; add default file helpers"
```

---

## Task 4: Extract `lib/identity.js`

**Goal:** Move wrangler whoami shelling and identity matching into `lib/identity.js`.

**Files:**
- Create: `lib/identity.js`
- Create: `test/identity.test.js`
- Modify: `bin/wrangler-accounts.js`

- [ ] **Step 1: Write failing tests**

Create `test/identity.test.js`. The whoami spawn cannot be unit-tested against real wrangler, so tests focus on pure functions:

- `parseWranglerWhoamiOutput(sampleOutput)` extracts email + account name + account ID
- `parseWranglerWhoamiOutput('')` returns null
- `parseWranglerWhoamiOutput(outputWithOnlyEmail)` returns partial
- `identitiesMatch({accountId:'X'}, {accountId:'X'})` → true
- `identitiesMatch({accountId:'X'}, {accountId:'Y'})` → false
- `identitiesMatch({email:'a'}, {email:'a'})` → true
- `identitiesMatch({}, {})` → false
- `describeIdentity({email:'a', accountId:'X'})` → "a / X"
- `describeIdentity(null)` → "unknown"
- `getMetaIdentity({identity:{email:'a'}})` → `{email:'a', accountName:null, accountId:null}`
- `getMetaIdentity({})` → null
- `findProfilesByIdentity(dir, identity)` returns matching profile names

Use a fixture sample of real wrangler whoami output in a string constant (copy-paste from the b7 run earlier in the session):

```
 ⛅️ wrangler 4.79.0 (update available 4.81.1)
─────────────────────────────────────────────
Getting User settings...
👋 You are logged in with an OAuth Token, associated with the email xdreamstar2025@gmail.com.
┌────────────────────────────────────┬──────────────────────────────────┐
│ Account Name                       │ Account ID                       │
├────────────────────────────────────┼──────────────────────────────────┤
│ Xdreamstar2025@gmail.com's Account │ 5544eac7cfb260d4fec9467d49513cea │
└────────────────────────────────────┴──────────────────────────────────┘
```

- [ ] **Step 2: Run tests — fail**

Run: `npm test -- --test-name-pattern identity`
Expected: FAIL.

- [ ] **Step 3: Create `lib/identity.js`**

Move verbatim:

- `parseWranglerWhoamiOutput`
- `getWranglerAuthPath`
- `canInspectIdentity`
- `getCurrentIdentity`
- `identitiesMatch`
- `describeIdentity`
- `getMetaIdentity`
- `findProfilesByIdentity`

`getCurrentIdentity` will still `spawnSync('wrangler', ['whoami'])`. For testability, add an optional `spawn` parameter defaulting to real `spawnSync`, so tests can inject a fake. Unit tests for `getCurrentIdentity` should use this injection to verify the "not logged in" and "error" branches without shelling out.

- [ ] **Step 4: Update bin/wrangler-accounts.js to import**

- [ ] **Step 5: Run tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/identity.js test/identity.test.js bin/wrangler-accounts.js
git commit -m "refactor: extract identity parsing and lookup into lib/identity.js"
```

---

## Task 5: Add `lib/resolve.js` with profile resolution precedence

**Goal:** Implement the AWS-style resolution order as a pure function with full test coverage.

**Files:**
- Create: `lib/resolve.js`
- Create: `test/resolve.test.js`

- [ ] **Step 1: Write failing tests**

Create `test/resolve.test.js` covering each tier of the precedence (spec §"Profile resolution order"):

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveProfile, ResolveError } = require('../lib/resolve');

function mkStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-resolve-'));
  return dir;
}
function addProfile(dir, name) {
  fs.mkdirSync(path.join(dir, name), { recursive: true });
  fs.writeFileSync(path.join(dir, name, 'config.toml'), '');
}

test('explicit --profile wins over everything else', () => {
  const dir = mkStore();
  addProfile(dir, 'work');
  addProfile(dir, 'personal');
  fs.writeFileSync(path.join(dir, 'default'), 'personal\n');
  const r = resolveProfile({
    cliProfile: 'work',
    positional: null,
    env: { WRANGLER_PROFILE: 'personal' },
    profilesDir: dir,
  });
  assert.deepEqual(r, { name: 'work', source: 'cli' });
});

test('positional shorthand resolves when it matches a profile', () => {
  const dir = mkStore();
  addProfile(dir, 'work');
  const r = resolveProfile({
    cliProfile: null,
    positional: 'work',
    env: {},
    profilesDir: dir,
  });
  assert.deepEqual(r, { name: 'work', source: 'positional' });
});

test('positional that matches a management subcommand is ignored', () => {
  const dir = mkStore();
  addProfile(dir, 'list');  // user has a profile called list
  const r = resolveProfile({
    cliProfile: null,
    positional: 'list',
    env: {},
    profilesDir: dir,
    managementSubcommands: new Set(['list', 'status', 'save', 'sync', 'sync-default', 'login', 'remove', 'default', 'whoami', 'gc', 'use', 'sync-active', 'exec']),
  });
  // list is a management command — positional is ignored; falls through to env/default → error
  assert.throws(() => { throw r instanceof Error ? r : new ResolveError('should throw'); });
  // (Adjust assertion to match actual behavior: resolveProfile should return null or throw ResolveError.)
});

test('WRANGLER_PROFILE is used when no CLI arg', () => {
  const dir = mkStore();
  addProfile(dir, 'work');
  const r = resolveProfile({
    cliProfile: null,
    positional: null,
    env: { WRANGLER_PROFILE: 'work' },
    profilesDir: dir,
  });
  assert.deepEqual(r, { name: 'work', source: 'env' });
});

test('profilesDir/default file is used when no CLI and no env', () => {
  const dir = mkStore();
  addProfile(dir, 'work');
  fs.writeFileSync(path.join(dir, 'default'), 'work\n');
  const r = resolveProfile({
    cliProfile: null,
    positional: null,
    env: {},
    profilesDir: dir,
  });
  assert.deepEqual(r, { name: 'work', source: 'default' });
});

test('missing profile throws ResolveError with actionable hint', () => {
  const dir = mkStore();
  assert.throws(
    () => resolveProfile({ cliProfile: null, positional: null, env: {}, profilesDir: dir }),
    (err) => err instanceof ResolveError && /--profile/.test(err.message) && /WRANGLER_PROFILE/.test(err.message),
  );
});

test('explicitly named profile that does not exist throws ResolveError', () => {
  const dir = mkStore();
  assert.throws(
    () => resolveProfile({ cliProfile: 'ghost', positional: null, env: {}, profilesDir: dir }),
    (err) => err instanceof ResolveError && /ghost/.test(err.message),
  );
});
```

- [ ] **Step 2: Run tests — fail**

Run: `npm test -- --test-name-pattern resolve`
Expected: FAIL (module not found).

- [ ] **Step 3: Create `lib/resolve.js`**

```js
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { getDefaultProfile, listProfiles, isValidName } = require('./profile-store');

class ResolveError extends Error {
  constructor(message, code = 'PROFILE_NOT_FOUND') {
    super(message);
    this.name = 'ResolveError';
    this.code = code;
  }
}

/**
 * Resolve a profile name using AWS-style precedence.
 *
 * @param {object} args
 * @param {string|null} args.cliProfile - value of --profile / -p (or null)
 * @param {string|null} args.positional - first positional arg if candidate for shorthand
 * @param {object} args.env - environment variables (usually process.env)
 * @param {string} args.profilesDir - path to profiles directory
 * @param {Set<string>} [args.managementSubcommands] - names the positional
 *   shorthand should NOT resolve as profile names (the management subcommand
 *   interpretation wins).
 * @returns {{ name: string, source: 'cli' | 'positional' | 'env' | 'default' }}
 * @throws ResolveError
 */
function resolveProfile({
  cliProfile,
  positional,
  env,
  profilesDir,
  managementSubcommands = new Set(),
}) {
  // 1. Explicit --profile / -p
  if (cliProfile) {
    assertValid(cliProfile);
    assertExists(cliProfile, profilesDir);
    return { name: cliProfile, source: 'cli' };
  }

  // 2. Positional shorthand (only when it's a valid saved profile and NOT a management subcommand name)
  if (positional && !managementSubcommands.has(positional)) {
    if (isValidName(positional) && profileExists(positional, profilesDir)) {
      return { name: positional, source: 'positional' };
    }
  }

  // 3. Env var
  const envProfile = env.WRANGLER_PROFILE;
  if (envProfile && envProfile.length) {
    assertValid(envProfile);
    assertExists(envProfile, profilesDir);
    return { name: envProfile, source: 'env' };
  }

  // 4. Persistent default
  const def = getDefaultProfile(profilesDir);
  if (def) {
    assertValid(def);
    assertExists(def, profilesDir);
    return { name: def, source: 'default' };
  }

  // 5. Error
  throw new ResolveError(
    [
      'No profile specified. Options:',
      '  - wrangler-accounts --profile <name> ...',
      '  - WRANGLER_PROFILE=<name> wrangler-accounts ...',
      '  - wrangler-accounts default <name>   (set a persistent default)',
    ].join('\n'),
    'NO_PROFILE',
  );
}

function assertValid(name) {
  if (!isValidName(name)) {
    throw new ResolveError(`Invalid profile name: ${name}`, 'INVALID_NAME');
  }
}

function profileExists(name, profilesDir) {
  return fs.existsSync(path.join(profilesDir, name, 'config.toml'));
}

function assertExists(name, profilesDir) {
  if (!profileExists(name, profilesDir)) {
    throw new ResolveError(`Profile not found: ${name}`, 'PROFILE_NOT_FOUND');
  }
}

module.exports = { resolveProfile, ResolveError };
```

- [ ] **Step 4: Run tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/resolve.js test/resolve.test.js
git commit -m "feat: add lib/resolve.js with AWS-style profile resolution"
```

---

## Task 6: Add `createShadowHome` to `lib/isolation.js`

**Goal:** Pure shadow HOME construction. No spawn yet — just filesystem shape and cleanup.

**Files:**
- Create: `lib/isolation.js`
- Create: `test/isolation.test.js`

- [ ] **Step 1: Write failing tests**

Create `test/isolation.test.js` with tests covering (spec §"Shadow HOME construction"):

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  createShadowHome,
  cleanupShadow,
} = require('../lib/isolation');

function mkFakeRealHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-fakehome-'));
  // populate with a few representative top-level entries
  fs.writeFileSync(path.join(home, '.npmrc'), 'registry=https://example.com\n');
  fs.writeFileSync(path.join(home, '.gitconfig'), '[user]\n');
  fs.mkdirSync(path.join(home, '.ssh'));
  fs.mkdirSync(path.join(home, 'projects'));
  fs.writeFileSync(path.join(home, 'projects', 'foo.txt'), 'x');
  return home;
}

function mkProfile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-profile-'));
  fs.mkdirSync(path.join(dir, 'work'));
  fs.writeFileSync(path.join(dir, 'work', 'config.toml'), 'oauth_token = "fake"\n');
  return { profilesDir: dir, profileCfg: path.join(dir, 'work', 'config.toml') };
}

test('shadow HOME mirrors every top-level entry except .wrangler', () => {
  const realHome = mkFakeRealHome();
  const { profileCfg } = mkProfile();
  const shadow = createShadowHome({ realHome, profileCfg });
  try {
    const entries = fs.readdirSync(shadow).sort();
    assert.ok(entries.includes('.npmrc'));
    assert.ok(entries.includes('.gitconfig'));
    assert.ok(entries.includes('.ssh'));
    assert.ok(entries.includes('projects'));
    assert.ok(entries.includes('.wrangler'));
    // symlinks
    assert.equal(fs.lstatSync(path.join(shadow, '.npmrc')).isSymbolicLink(), true);
    assert.equal(fs.lstatSync(path.join(shadow, 'projects')).isSymbolicLink(), true);
    // .wrangler is a real dir, not a symlink
    assert.equal(fs.lstatSync(path.join(shadow, '.wrangler')).isSymbolicLink(), false);
  } finally {
    cleanupShadow(shadow);
  }
});

test('shadow .wrangler/config/default.toml symlinks to profile config', () => {
  const realHome = mkFakeRealHome();
  const { profileCfg } = mkProfile();
  const shadow = createShadowHome({ realHome, profileCfg });
  try {
    const linkPath = path.join(shadow, '.wrangler', 'config', 'default.toml');
    const stat = fs.lstatSync(linkPath);
    assert.equal(stat.isSymbolicLink(), true);
    assert.equal(fs.readlinkSync(linkPath), profileCfg);
    assert.equal(fs.readFileSync(linkPath, 'utf8'), 'oauth_token = "fake"\n');
  } finally {
    cleanupShadow(shadow);
  }
});

test('shadow HOME skips .wrangler when real HOME has one', () => {
  const realHome = mkFakeRealHome();
  fs.mkdirSync(path.join(realHome, '.wrangler'));
  fs.writeFileSync(path.join(realHome, '.wrangler', 'marker.txt'), 'legacy');
  const { profileCfg } = mkProfile();
  const shadow = createShadowHome({ realHome, profileCfg });
  try {
    // shadow .wrangler must NOT contain the legacy marker
    assert.equal(fs.existsSync(path.join(shadow, '.wrangler', 'marker.txt')), false);
  } finally {
    cleanupShadow(shadow);
  }
});

test('shadow HOME has mode 0o700', () => {
  const realHome = mkFakeRealHome();
  const { profileCfg } = mkProfile();
  const shadow = createShadowHome({ realHome, profileCfg });
  try {
    const mode = fs.statSync(shadow).mode & 0o777;
    assert.equal(mode, 0o700);
  } finally {
    cleanupShadow(shadow);
  }
});

test('cleanupShadow removes the shadow dir', () => {
  const realHome = mkFakeRealHome();
  const { profileCfg } = mkProfile();
  const shadow = createShadowHome({ realHome, profileCfg });
  cleanupShadow(shadow);
  assert.equal(fs.existsSync(shadow), false);
});

test('cleanupShadow does not touch real HOME through symlinks', () => {
  const realHome = mkFakeRealHome();
  const { profileCfg } = mkProfile();
  const shadow = createShadowHome({ realHome, profileCfg });
  cleanupShadow(shadow);
  // real HOME's .npmrc must still exist
  assert.equal(fs.existsSync(path.join(realHome, '.npmrc')), true);
  assert.equal(fs.existsSync(path.join(realHome, 'projects', 'foo.txt')), true);
});

test('token refresh through the symlink writes back to the profile file', () => {
  const realHome = mkFakeRealHome();
  const { profileCfg } = mkProfile();
  const shadow = createShadowHome({ realHome, profileCfg });
  try {
    const linkPath = path.join(shadow, '.wrangler', 'config', 'default.toml');
    // simulate wrangler refreshing the token (writeFileSync is in-place)
    fs.writeFileSync(linkPath, 'oauth_token = "refreshed"\n');
    // profile file must reflect the refresh
    assert.equal(fs.readFileSync(profileCfg, 'utf8'), 'oauth_token = "refreshed"\n');
  } finally {
    cleanupShadow(shadow);
  }
});
```

- [ ] **Step 2: Run tests — fail**

Run: `npm test -- --test-name-pattern isolation`
Expected: FAIL.

- [ ] **Step 3: Implement `lib/isolation.js` (createShadowHome + cleanupShadow only)**

```js
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * Create a per-invocation shadow HOME. Returns the path to the shadow dir.
 * Caller MUST call cleanupShadow(shadow) when done.
 *
 * @param {object} args
 * @param {string} args.realHome - the user's real HOME directory
 * @param {string} args.profileCfg - path to the profile's config.toml file
 * @param {string} [args.label] - optional label baked into the tmpdir name for debugging
 * @returns {string} shadow HOME path
 */
function createShadowHome({ realHome, profileCfg, label = 'wa' }) {
  if (!realHome || !fs.existsSync(realHome)) {
    throw new Error(`real HOME does not exist: ${realHome}`);
  }
  if (!profileCfg || !fs.existsSync(profileCfg)) {
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
      process.stderr.write(`[wrangler-accounts] skip symlink ${entry}: ${err.message}\n`);
    }
  }

  // The one file that matters — a real symlink to the profile file so
  // Wrangler's in-place writeFileSync token refreshes flow back to the
  // profile automatically.
  const shadowWranglerConfig = path.join(shadow, '.wrangler', 'config');
  fs.mkdirSync(shadowWranglerConfig, { recursive: true });
  fs.symlinkSync(
    profileCfg,
    path.join(shadowWranglerConfig, 'default.toml'),
  );

  return shadow;
}

/**
 * Remove a shadow HOME. Safe because the shadow contains only symlinks and
 * empty/small directories. Never follows symlinks into the real HOME.
 *
 * Uses `fs.rmSync` with `recursive: true, force: true`. Node's rm never
 * follows symlinks (it unlinks them as files), so `.npmrc` in the real HOME
 * is not at risk.
 */
function cleanupShadow(shadow) {
  if (!shadow) return;
  try {
    fs.rmSync(shadow, { recursive: true, force: true });
  } catch (err) {
    process.stderr.write(`[wrangler-accounts] cleanup warning: ${err.message}\n`);
  }
}

module.exports = { createShadowHome, cleanupShadow };
```

- [ ] **Step 4: Run tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/isolation.js test/isolation.test.js
git commit -m "feat: add createShadowHome and cleanupShadow in lib/isolation.js"
```

---

## Task 7: Add `buildIsolatedEnv` and `runIsolated` to `lib/isolation.js`

**Goal:** Complete the isolation module with environment injection and child-process spawning. Integration-test against a fake wrangler binary.

**Files:**
- Modify: `lib/isolation.js`
- Modify: `test/isolation.test.js` (add tests)
- Create: `test/fixtures/fake-wrangler.sh`

- [ ] **Step 1: Write the fake wrangler fixture**

Create `test/fixtures/fake-wrangler.sh`:

```sh
#!/bin/sh
# Fake wrangler used by integration tests.
# Dumps HOME, all WRANGLER_* env vars, CWD, and argv as a JSON blob to
# $WA_TEST_OUT (if set) or stdout.
out="${WA_TEST_OUT:-/dev/stdout}"
{
  printf '{'
  printf '"home":"%s",' "$HOME"
  printf '"cwd":"%s",' "$(pwd)"
  printf '"argv":['
  first=1
  for a in "$@"; do
    if [ $first -eq 0 ]; then printf ','; fi
    printf '"%s"' "$a"
    first=0
  done
  printf '],'
  printf '"env":{'
  printf '"WRANGLER_PROFILE":"%s",' "$WRANGLER_PROFILE"
  printf '"WRANGLER_ACCOUNT":"%s",' "$WRANGLER_ACCOUNT"
  printf '"WRANGLER_REGISTRY_PATH":"%s",' "$WRANGLER_REGISTRY_PATH"
  printf '"WRANGLER_CACHE_DIR":"%s",' "$WRANGLER_CACHE_DIR"
  printf '"WRANGLER_LOG_PATH":"%s",' "$WRANGLER_LOG_PATH"
  printf '"CLOUDFLARED_PATH":"%s",' "$CLOUDFLARED_PATH"
  printf '"WRANGLER_SEND_METRICS":"%s"' "$WRANGLER_SEND_METRICS"
  printf '}'
  printf '}'
} > "$out"
```

Chmod +x in the test setup.

- [ ] **Step 2: Write failing tests for buildIsolatedEnv**

Add to `test/isolation.test.js`:

```js
const { buildIsolatedEnv, runIsolated } = require('../lib/isolation');

test('buildIsolatedEnv sets HOME to shadow and WRANGLER_PROFILE to profile name', () => {
  const env = buildIsolatedEnv({
    shadow: '/tmp/fake-shadow',
    realHome: '/Users/fake',
    profile: 'work',
    baseEnv: { PATH: '/usr/bin', FOO: 'bar' },
  });
  assert.equal(env.HOME, '/tmp/fake-shadow');
  assert.equal(env.WRANGLER_PROFILE, 'work');
  assert.equal(env.WRANGLER_ACCOUNT, 'work');
  assert.equal(env.WRANGLER_ACCOUNT_REAL_HOME, '/Users/fake');
  assert.equal(env.WRANGLER_REGISTRY_PATH, '/Users/fake/.wrangler/registry');
  assert.equal(env.WRANGLER_CACHE_DIR, '/Users/fake/.wrangler/cache');
  assert.equal(env.WRANGLER_LOG_PATH, '/Users/fake/.wrangler/logs');
  assert.equal(env.WRANGLER_SEND_METRICS, 'false');
  // PATH and other base env vars preserved
  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.FOO, 'bar');
});

test('buildIsolatedEnv includes CLOUDFLARED_PATH only when provided', () => {
  const envWith = buildIsolatedEnv({
    shadow: '/a', realHome: '/b', profile: 'w', baseEnv: {},
    cloudflaredPath: '/usr/local/bin/cloudflared',
  });
  assert.equal(envWith.CLOUDFLARED_PATH, '/usr/local/bin/cloudflared');

  const envWithout = buildIsolatedEnv({
    shadow: '/a', realHome: '/b', profile: 'w', baseEnv: {},
  });
  assert.equal('CLOUDFLARED_PATH' in envWithout, false);
});
```

- [ ] **Step 3: Write failing integration tests for runIsolated**

Add to `test/isolation.test.js`:

```js
test('runIsolated spawns child with shadow HOME and correct env', () => {
  const realHome = mkFakeRealHome();
  const { profilesDir, profileCfg } = mkProfile();
  const outFile = path.join(os.tmpdir(), `wa-out-${Date.now()}.json`);
  const fakeWrangler = path.join(__dirname, 'fixtures', 'fake-wrangler.sh');
  fs.chmodSync(fakeWrangler, 0o755);

  const result = runIsolated({
    profile: 'work',
    profileCfg,
    realHome,
    command: fakeWrangler,
    args: ['deploy', '--env', 'production'],
    baseEnv: { ...process.env, WA_TEST_OUT: outFile, PATH: process.env.PATH },
  });

  assert.equal(result.exitCode, 0);
  const payload = JSON.parse(fs.readFileSync(outFile, 'utf8'));
  assert.ok(payload.home.startsWith(os.tmpdir()));
  assert.notEqual(payload.home, realHome);
  assert.deepEqual(payload.argv, ['deploy', '--env', 'production']);
  assert.equal(payload.env.WRANGLER_PROFILE, 'work');
  assert.equal(payload.env.WRANGLER_ACCOUNT, 'work');
  assert.equal(payload.env.WRANGLER_REGISTRY_PATH, path.join(realHome, '.wrangler/registry'));
  // shadow HOME should be cleaned up after runIsolated returns
  assert.equal(fs.existsSync(payload.home), false);

  fs.unlinkSync(outFile);
});

test('runIsolated cleans up shadow even when child exits non-zero', () => {
  const realHome = mkFakeRealHome();
  const { profileCfg } = mkProfile();
  const result = runIsolated({
    profile: 'work',
    profileCfg,
    realHome,
    command: 'sh',
    args: ['-c', 'exit 42'],
    baseEnv: { ...process.env },
  });
  assert.equal(result.exitCode, 42);
  // implicit: no leaked shadow (can't easily check without capturing the path;
  // the test passes if runIsolated completes without error)
});

test('two runIsolated calls with same profile are independent', () => {
  const realHome = mkFakeRealHome();
  const { profileCfg } = mkProfile();
  const r1 = runIsolated({
    profile: 'work', profileCfg, realHome,
    command: 'sh', args: ['-c', 'echo $HOME'],
    baseEnv: { ...process.env },
    captureStdout: true,
  });
  const r2 = runIsolated({
    profile: 'work', profileCfg, realHome,
    command: 'sh', args: ['-c', 'echo $HOME'],
    baseEnv: { ...process.env },
    captureStdout: true,
  });
  assert.notEqual(r1.stdout, r2.stdout, 'each invocation should see a different shadow HOME');
});
```

- [ ] **Step 4: Run tests — fail**

Run: `npm test -- --test-name-pattern isolation`
Expected: FAIL (functions not exported yet).

- [ ] **Step 5: Implement `buildIsolatedEnv` and `runIsolated`**

Append to `lib/isolation.js`:

```js
const { spawnSync } = require('node:child_process');

function buildIsolatedEnv({
  shadow,
  realHome,
  profile,
  baseEnv = process.env,
  cloudflaredPath = null,
}) {
  const env = { ...baseEnv };
  env.HOME = shadow;
  env.WRANGLER_PROFILE = profile;
  env.WRANGLER_ACCOUNT = profile;
  env.WRANGLER_ACCOUNT_REAL_HOME = realHome;
  env.WRANGLER_REGISTRY_PATH = path.join(realHome, '.wrangler', 'registry');
  env.WRANGLER_CACHE_DIR = path.join(realHome, '.wrangler', 'cache');
  env.WRANGLER_LOG_PATH = path.join(realHome, '.wrangler', 'logs');
  env.WRANGLER_SEND_METRICS = 'false';
  if (cloudflaredPath) {
    env.CLOUDFLARED_PATH = cloudflaredPath;
  }
  return env;
}

/**
 * Run a command inside an isolated shadow HOME for the given profile.
 *
 * @param {object} args
 * @param {string} args.profile - profile name
 * @param {string} args.profileCfg - path to profile config.toml
 * @param {string} args.realHome - user's real HOME
 * @param {string} args.command - command to spawn (e.g. 'wrangler', '$SHELL', any)
 * @param {string[]} args.args - command argv
 * @param {object} [args.baseEnv] - base env (defaults to process.env)
 * @param {boolean} [args.captureStdout] - if true, capture instead of inherit
 * @param {string|null} [args.cloudflaredPath] - optional CLOUDFLARED_PATH override
 * @returns {{exitCode: number, stdout?: string, stderr?: string, shadowPath: string}}
 */
function runIsolated({
  profile,
  profileCfg,
  realHome,
  command,
  args,
  baseEnv = process.env,
  captureStdout = false,
  cloudflaredPath = null,
}) {
  const shadow = createShadowHome({ realHome, profileCfg, label: `wa-${profile}` });
  const env = buildIsolatedEnv({ shadow, realHome, profile, baseEnv, cloudflaredPath });

  let result;
  try {
    result = spawnSync(command, args, {
      stdio: captureStdout ? ['inherit', 'pipe', 'pipe'] : 'inherit',
      env,
      encoding: 'utf8',
    });
  } finally {
    cleanupShadow(shadow);
  }

  return {
    exitCode: result.status == null ? (result.signal ? 128 : 1) : result.status,
    stdout: captureStdout ? (result.stdout || '') : undefined,
    stderr: captureStdout ? (result.stderr || '') : undefined,
    shadowPath: shadow, // path is returned even after cleanup for test assertions
  };
}

module.exports = {
  createShadowHome,
  cleanupShadow,
  buildIsolatedEnv,
  runIsolated,
};
```

- [ ] **Step 6: Run tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add lib/isolation.js test/isolation.test.js test/fixtures/fake-wrangler.sh
git commit -m "feat: add buildIsolatedEnv and runIsolated with fake-wrangler integration tests"
```

---

## Task 8: Wire per-invocation execution into the CLI

**Goal:** `wrangler-accounts --profile X <wrangler args...>` and `wrangler-accounts <existing-profile-name> <args>` should spawn wrangler in a shadow HOME.

**Files:**
- Modify: `bin/wrangler-accounts.js`
- Create: `test/exec-invoke.test.js`

- [ ] **Step 1: Update arg parser to recognize `--profile` / `-p`**

Extend the existing `parseArgs` function so that `--profile <name>` / `-p <name>` populate `opts.profile`. Do not error on unknown flags: after the management subcommand check, any remaining argv should be forwarded to wrangler.

- [ ] **Step 2: In `main()`, add a new dispatch branch**

After parsing, before the existing subcommand dispatch, handle the "not a management subcommand" case:

```js
const MANAGEMENT_SUBCOMMANDS = new Set([
  'list', 'status', 'save', 'sync', 'sync-active', 'sync-default',
  'login', 'remove', 'default', 'whoami', 'gc', 'use', 'exec',
]);

// existing management subcommand dispatch lives inside this branch now:
if (command && MANAGEMENT_SUBCOMMANDS.has(command)) {
  // ... existing switch/if chain ...
  return;
}

// Otherwise, treat rest as wrangler args and resolve a profile.
const profileArg = opts.profile || null;
// positional shorthand: if first positional arg matches an existing profile,
// treat it as the profile name, not as a wrangler subcommand.
const positional = rest[0] || null;

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
  if (err instanceof ResolveError) die(err.message);
  throw err;
}

const profileCfg = path.join(profilesDir, resolved.name, 'config.toml');
const session = readSessionState(profileCfg);
if (session.expired) {
  die(`Profile '${resolved.name}' is expired (${session.expirationTime}). Run 'wrangler-accounts login ${resolved.name}' to refresh.`, 3);
}

// If positional was consumed as profile, drop it from wrangler argv
const wranglerArgs = resolved.source === 'positional' ? rest.slice(1) : rest;

const realHome = os.homedir();
const result = runIsolated({
  profile: resolved.name,
  profileCfg,
  realHome,
  command: 'wrangler',
  args: wranglerArgs,
  baseEnv: process.env,
  cloudflaredPath: findCloudflared(),
});
process.exit(result.exitCode);
```

Where `findCloudflared()` is a small helper:

```js
function findCloudflared() {
  const path = require('node:path');
  const fs = require('node:fs');
  const dirs = (process.env.PATH || '').split(path.delimiter);
  for (const d of dirs) {
    if (!d) continue;
    const candidate = path.join(d, 'cloudflared');
    try { if (fs.statSync(candidate).isFile()) return candidate; } catch {}
  }
  return null;
}
```

- [ ] **Step 3: Write integration tests**

Create `test/exec-invoke.test.js`. The test uses the fake wrangler binary via a temporary PATH prepend:

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const CLI = path.join(__dirname, '..', 'bin', 'wrangler-accounts.js');
const FIXTURE = path.join(__dirname, 'fixtures', 'fake-wrangler.sh');

function setupShimDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-shim-'));
  fs.copyFileSync(FIXTURE, path.join(d, 'wrangler'));
  fs.chmodSync(path.join(d, 'wrangler'), 0o755);
  return d;
}

function mkProfile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-p-'));
  fs.mkdirSync(path.join(dir, 'work'));
  fs.writeFileSync(path.join(dir, 'work', 'config.toml'), 'oauth_token = "x"\n');
  fs.mkdirSync(path.join(dir, 'personal'));
  fs.writeFileSync(path.join(dir, 'personal', 'config.toml'), 'oauth_token = "y"\n');
  return dir;
}

test('wrangler-accounts --profile work deploy forwards to wrangler with shadow HOME', () => {
  const shim = setupShimDir();
  const profilesDir = mkProfile();
  const outFile = path.join(os.tmpdir(), `wa-out-${Date.now()}.json`);
  const r = spawnSync(process.execPath, [CLI, '--profile', 'work', 'deploy', 'worker.js'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${shim}${path.delimiter}${process.env.PATH}`,
      WRANGLER_ACCOUNTS_DIR: profilesDir,
      WA_TEST_OUT: outFile,
    },
  });
  assert.equal(r.status, 0, `stderr=${r.stderr}`);
  const payload = JSON.parse(fs.readFileSync(outFile, 'utf8'));
  assert.deepEqual(payload.argv, ['deploy', 'worker.js']);
  assert.equal(payload.env.WRANGLER_PROFILE, 'work');
  assert.ok(payload.home !== process.env.HOME);
});

test('positional shorthand wrangler-accounts work deploy works', () => {
  const shim = setupShimDir();
  const profilesDir = mkProfile();
  const outFile = path.join(os.tmpdir(), `wa-out-${Date.now()}.json`);
  const r = spawnSync(process.execPath, [CLI, 'work', 'deploy'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${shim}${path.delimiter}${process.env.PATH}`,
      WRANGLER_ACCOUNTS_DIR: profilesDir,
      WA_TEST_OUT: outFile,
    },
  });
  assert.equal(r.status, 0);
  const payload = JSON.parse(fs.readFileSync(outFile, 'utf8'));
  assert.deepEqual(payload.argv, ['deploy']);
  assert.equal(payload.env.WRANGLER_PROFILE, 'work');
});

test('WRANGLER_PROFILE env var resolves when no CLI arg', () => {
  const shim = setupShimDir();
  const profilesDir = mkProfile();
  const outFile = path.join(os.tmpdir(), `wa-out-${Date.now()}.json`);
  const r = spawnSync(process.execPath, [CLI, 'deploy'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${shim}${path.delimiter}${process.env.PATH}`,
      WRANGLER_ACCOUNTS_DIR: profilesDir,
      WRANGLER_PROFILE: 'personal',
      WA_TEST_OUT: outFile,
    },
  });
  assert.equal(r.status, 0);
  const payload = JSON.parse(fs.readFileSync(outFile, 'utf8'));
  assert.equal(payload.env.WRANGLER_PROFILE, 'personal');
});

test('no profile resolution → exit 2 with actionable hint', () => {
  const profilesDir = mkProfile();
  const r = spawnSync(process.execPath, [CLI, 'deploy'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      WRANGLER_ACCOUNTS_DIR: profilesDir,
    },
  });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /--profile/);
});
```

- [ ] **Step 4: Run tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add bin/wrangler-accounts.js test/exec-invoke.test.js
git commit -m "feat: wire per-invocation execution through runIsolated"
```

---

## Task 9: Add `default` command

**Goal:** `wrangler-accounts default [name | --unset]` manages `profilesDir/default`.

**Files:**
- Modify: `bin/wrangler-accounts.js`
- Create: `test/default-cmd.test.js`

- [ ] **Step 1: Write failing tests**

`test/default-cmd.test.js` covers:

- `wrangler-accounts default` on empty store → stdout "(no default set)", exit 1
- `wrangler-accounts default work` on store with `work` profile → writes `profilesDir/default` with "work\n", exit 0
- `wrangler-accounts default` after setting → prints "work", exit 0
- `wrangler-accounts default` with `--json` → JSON shape
- `wrangler-accounts default ghost` (non-existent profile) → exits non-zero
- `wrangler-accounts default --unset` → removes default file, exit 0
- `wrangler-accounts default --unset` when none set → exit 0 (idempotent)

- [ ] **Step 2: Implement the command**

Add to `bin/wrangler-accounts.js` management switch:

```js
if (command === 'default') {
  const name = rest[1];
  if (opts.unset || name === '--unset') {
    unsetDefaultProfile(profilesDir);
    if (opts.json) console.log(JSON.stringify({ command: 'default', unset: true }, null, 2));
    else console.log('Default profile unset.');
    return;
  }
  if (!name) {
    const current = getDefaultProfile(profilesDir);
    if (opts.json) console.log(JSON.stringify({ command: 'default', name: current }, null, 2));
    else if (current) console.log(current);
    else { console.log('(no default set)'); process.exit(1); }
    return;
  }
  if (!isValidName(name)) die(`Invalid profile name: ${name}`);
  const cfg = path.join(profilesDir, name, 'config.toml');
  if (!fs.existsSync(cfg)) die(`Profile not found: ${name}`);
  setDefaultProfile(profilesDir, name);
  if (opts.json) console.log(JSON.stringify({ command: 'default', name }, null, 2));
  else console.log(`Default profile set to '${name}'`);
  return;
}
```

Parse `--unset` in `parseArgs` as `opts.unset = true`.

- [ ] **Step 3: Run tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add bin/wrangler-accounts.js test/default-cmd.test.js
git commit -m "feat: add 'default' command for managing persistent default profile"
```

---

## Task 10: Add `exec` command

**Goal:** `wrangler-accounts exec <profile> [-- cmd args...]` launches a subshell or user command with isolated env.

**Files:**
- Modify: `bin/wrangler-accounts.js`
- Create: `test/exec-cmd.test.js`

- [ ] **Step 1: Write failing tests**

`test/exec-cmd.test.js`:

- `exec` without a profile → exit non-zero with actionable error
- `exec work -- sh -c 'echo $WRANGLER_PROFILE'` prints "work" and exits 0
- `exec work -- sh -c 'echo $HOME'` prints a path that's not the real HOME
- `exec work -- false` exits 1
- `exec ghost -- sh -c true` exits non-zero (profile not found)
- `exec work` with no command and `$SHELL=/bin/true` → runs `/bin/true -i` and exits 0 (using a controlled SHELL env to avoid opening an actual interactive shell in tests)

- [ ] **Step 2: Implement**

```js
if (command === 'exec') {
  const profileName = rest[1];
  if (!profileName) die('Missing profile name for exec', 2);

  // Validate profile exists
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

  const profileCfg = path.join(profilesDir, resolved.name, 'config.toml');
  const session = readSessionState(profileCfg);
  if (session.expired) {
    die(`Profile '${resolved.name}' is expired. Run 'wrangler-accounts login ${resolved.name}'`, 3);
  }

  // Parse the command to exec. Everything after `--` is user command.
  const dashDashIdx = rest.indexOf('--', 2);
  let cmd;
  let cmdArgs;
  if (dashDashIdx >= 0) {
    cmd = rest[dashDashIdx + 1];
    cmdArgs = rest.slice(dashDashIdx + 2);
    if (!cmd) die('No command given after --', 1);
  } else {
    cmd = process.env.SHELL || '/bin/sh';
    cmdArgs = ['-i'];
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
```

- [ ] **Step 3: Run tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add bin/wrangler-accounts.js test/exec-cmd.test.js
git commit -m "feat: add 'exec' command for per-session isolated subshell or command"
```

---

## Task 11: Rewrite `login` command for isolation

**Goal:** `wrangler-accounts login <profile>` runs `wrangler login` inside a shadow HOME, then moves the resulting `default.toml` into the profile directory. Never touches the user's real `~/.wrangler`.

**Files:**
- Modify: `bin/wrangler-accounts.js`
- Modify or create: `test/login-cmd.test.js` (mock wrangler login flow)

- [ ] **Step 1: Write failing tests**

Mocking real OAuth is out of scope. Test via a fake wrangler fixture that simulates `wrangler login` by writing a sentinel `default.toml` into `$HOME/.wrangler/config/`:

```sh
#!/bin/sh
# test/fixtures/fake-wrangler-login.sh
case "$1" in
  login)
    mkdir -p "$HOME/.wrangler/config"
    cat > "$HOME/.wrangler/config/default.toml" <<EOF
oauth_token = "fake-from-login"
refresh_token = "refresh"
expiration_time = "2099-01-01T00:00:00.000Z"
EOF
    echo "fake login done"
    ;;
  whoami)
    echo "You are logged in with an OAuth Token, associated with the email test@example.com."
    echo "│ Test Account │ 0123456789abcdef0123456789abcdef │"
    ;;
  *)
    echo "fake wrangler: unknown $1" >&2
    exit 1
    ;;
esac
```

Tests:

- `wrangler-accounts login newprofile` → creates `profilesDir/newprofile/config.toml` with the sentinel content
- After login, real `$HOME/.wrangler/config/default.toml` must NOT exist (or be unchanged)
- Login with an existing profile name overwrites it (current v0 behavior to preserve)
- Login with a profile whose identity parse fails → exit non-zero, profile not created

- [ ] **Step 2: Implement new login flow**

Replace the current `login` command body with:

```js
if (command === 'login') {
  const name = rest[1];
  if (!name) die('Missing profile name for login');
  if (!isValidName(name)) die(`Invalid profile name: ${name}`);

  ensureDir(profilesDir);

  // Create shadow HOME WITHOUT the profile symlink (wrangler will create the file fresh)
  const realHome = os.homedir();
  const shadow = fs.mkdtempSync(path.join(os.tmpdir(), `wa-login-${name}-`));
  fs.chmodSync(shadow, 0o700);
  for (const entry of fs.readdirSync(realHome)) {
    if (entry === '.wrangler') continue;
    try {
      fs.symlinkSync(path.join(realHome, entry), path.join(shadow, entry));
    } catch {}
  }
  fs.mkdirSync(path.join(shadow, '.wrangler', 'config'), { recursive: true });

  const env = buildIsolatedEnv({ shadow, realHome, profile: name, baseEnv: process.env, cloudflaredPath: findCloudflared() });

  try {
    const r = spawnSync('wrangler', ['login'], { stdio: 'inherit', env });
    if (r.error || r.status !== 0) {
      die(`'wrangler login' failed: ${r.error ? r.error.message : 'exit ' + r.status}`);
    }

    const freshCfg = path.join(shadow, '.wrangler', 'config', 'default.toml');
    if (!fs.existsSync(freshCfg)) {
      die(`wrangler login completed but no config written at ${freshCfg}`);
    }

    // Verify identity via a second spawn in the same shadow
    const whoamiResult = spawnSync('wrangler', ['whoami'], { env, encoding: 'utf8' });
    const identity = parseWranglerWhoamiOutput(`${whoamiResult.stdout || ''}\n${whoamiResult.stderr || ''}`);
    if (!identity) {
      die('Login succeeded but could not verify identity via wrangler whoami');
    }

    // Move fresh config into profile dir (overwrite allowed — preserves v0 semantics)
    const profileDir = path.join(profilesDir, name);
    ensureDir(profileDir);
    const destCfg = path.join(profileDir, 'config.toml');
    fs.copyFileSync(freshCfg, destCfg);
    writeMeta(profileDir, name, destCfg, identity);

    if (opts.json) {
      console.log(JSON.stringify({ command: 'login', name, configPath: destCfg, profilesDir, identity }, null, 2));
    } else {
      console.log(`Logged in and saved profile '${name}' (identity: ${describeIdentity(identity)})`);
    }
  } finally {
    cleanupShadow(shadow);
  }
  return;
}
```

- [ ] **Step 3: Run tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add bin/wrangler-accounts.js test/login-cmd.test.js test/fixtures/fake-wrangler-login.sh
git commit -m "feat: rewrite login command to run in isolated shadow HOME"
```

---

## Task 12: Add `whoami` and `gc` commands

**Goal:** Two small read-only commands that don't spawn wrangler.

**Files:**
- Modify: `bin/wrangler-accounts.js`
- Create: `test/whoami-gc.test.js`

- [ ] **Step 1: Write failing tests**

- `whoami` with no profile resolution → exit 2
- `whoami` with `--profile work` (no meta.json) → prints "work (identity unknown)"
- `whoami` with `--profile work` and meta.json containing identity → prints identity
- `whoami --json` → structured payload `{profile, source, identity}`
- `gc` with no stale shadows in tmpdir → exit 0, stdout "nothing to clean"
- `gc --older-than 1h` with a fake aged shadow dir `/tmp/wa-aged-.../` whose mtime is 2h ago → removes it
- `gc` preserves shadows newer than threshold

For the gc tests, use `fs.utimesSync` to set mtime explicitly on a freshly-created tmpdir, then assert it's cleaned (or preserved) accordingly.

- [ ] **Step 2: Implement**

```js
if (command === 'whoami') {
  const profileArg = opts.profile || rest[1] || null;
  let resolved;
  try {
    resolved = resolveProfile({
      cliProfile: profileArg,
      positional: null,
      env: process.env,
      profilesDir,
      managementSubcommands: MANAGEMENT_SUBCOMMANDS,
    });
  } catch (err) {
    if (err instanceof ResolveError) die(err.message, 2);
    throw err;
  }
  const profileDir = path.join(profilesDir, resolved.name);
  const meta = readMeta(profileDir);
  const identity = getMetaIdentity(meta);
  if (opts.json) {
    console.log(JSON.stringify({ command: 'whoami', profile: resolved.name, source: resolved.source, identity }, null, 2));
  } else {
    console.log(`${resolved.name} [${resolved.source}]: ${identity ? describeIdentity(identity) : 'identity unknown'}`);
  }
  return;
}

if (command === 'gc') {
  const thresholdMs = parseDuration(opts.olderThan || '1h');
  const now = Date.now();
  const dir = os.tmpdir();
  const candidates = fs.readdirSync(dir).filter((e) => e.startsWith('wa-'));
  const removed = [];
  for (const c of candidates) {
    const full = path.join(dir, c);
    let stat;
    try { stat = fs.statSync(full); } catch { continue; }
    if (!stat.isDirectory()) continue;
    if (now - stat.mtimeMs > thresholdMs) {
      try {
        fs.rmSync(full, { recursive: true, force: true });
        removed.push(full);
      } catch {}
    }
  }
  if (opts.json) {
    console.log(JSON.stringify({ command: 'gc', removed }, null, 2));
  } else if (removed.length === 0) {
    console.log('nothing to clean');
  } else {
    for (const r of removed) console.log(`removed ${r}`);
  }
  return;
}

function parseDuration(s) {
  const m = String(s).match(/^(\d+)\s*([smhd])?$/);
  if (!m) throw new Error(`Invalid duration: ${s}`);
  const n = parseInt(m[1], 10);
  const unit = m[2] || 's';
  const mult = { s: 1000, m: 60000, h: 3600000, d: 86400000 }[unit];
  return n * mult;
}
```

Parse `--older-than <dur>` in `parseArgs` as `opts.olderThan`.

- [ ] **Step 3: Run tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add bin/wrangler-accounts.js test/whoami-gc.test.js
git commit -m "feat: add 'whoami' and 'gc' commands"
```

---

## Task 13: Deprecation wrappers + `sync-default`

**Goal:** `use` and `sync-active` keep working but print a deprecation warning. `sync-active` becomes an alias for the new `sync-default`, which reads from `profilesDir/default` instead of `active`.

**Files:**
- Modify: `bin/wrangler-accounts.js`
- Modify: `test/smoke.test.js` (the v0 smoke test may need updating if it invoked `use` or `sync-active`; adjust to expect the deprecation warning on stderr)
- Create: `test/deprecation.test.js`

- [ ] **Step 1: Write failing tests**

- `use work` with a valid profile still mutates global config and writes `active` file (preserving v0 behavior) but prints deprecation warning to stderr matching `/deprecated/i`
- `sync-active` still works but prints deprecation warning and internally calls sync-default logic
- `sync-default` syncs current global config into the profile named by `profilesDir/default`
- Running `sync-default` with no `default` set → exit 2 with error

- [ ] **Step 2: Implement**

Add at the top of the command dispatch:

```js
function warnDeprecated(oldName, replacement) {
  process.stderr.write(`[wrangler-accounts] '${oldName}' is deprecated. Use '${replacement}' instead. See README for details.\n`);
}

// Rename sync-active → sync-default; keep sync-active as deprecated alias
if (command === 'sync-active') {
  warnDeprecated('sync-active', 'sync-default');
  // fall through to the sync-default branch below by reassigning:
  rest[0] = 'sync-default';
}

if (command === 'sync-default') {
  const { identity: currentIdentity } = loadCurrentIdentity();
  const def = getDefaultProfile(profilesDir);
  // Backward compat: fall back to 'active' file if 'default' missing
  const target = def || getActiveProfile(profilesDir);
  if (!target) die('No default profile set. Run `wrangler-accounts default <name>` first.', 2);
  ensureDir(profilesDir);
  syncProfile(target, configPath, profilesDir, currentIdentity);
  if (opts.json) console.log(JSON.stringify({ command: 'sync-default', name: target, configPath, profilesDir, identity: currentIdentity }, null, 2));
  else console.log(`Synced current Wrangler login into default profile '${target}'`);
  return;
}

if (command === 'use') {
  warnDeprecated('use', 'default (for persistence) or --profile (for one-shot)');
  // ... existing use behavior unchanged ...
}
```

On startup, also emit the one-time migration hint (spec §"Migration"):

```js
// Right after profilesDir is detected in main():
const hasLegacyActive = fs.existsSync(path.join(profilesDir, 'active'));
const hasNewDefault = fs.existsSync(path.join(profilesDir, 'default'));
if (hasLegacyActive && !hasNewDefault && process.stderr.isTTY && !process.env.WRANGLER_ACCOUNTS_NO_MIGRATION_HINT) {
  const legacy = getActiveProfile(profilesDir);
  if (legacy) {
    process.stderr.write(`[wrangler-accounts] Found legacy 'active' profile '${legacy}'. Run 'wrangler-accounts default ${legacy}' to make it the persistent default.\n`);
  }
}
```

- [ ] **Step 3: Run tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add bin/wrangler-accounts.js test/deprecation.test.js test/smoke.test.js
git commit -m "feat: deprecate 'use' and 'sync-active'; add 'sync-default' and migration hint"
```

---

## Task 14: Extend zsh completion

**Goal:** Tab-complete new commands, `--profile` flag, and profile names after `--profile`.

**Files:**
- Modify: `completions/wrangler-accounts.zsh`

- [ ] **Step 1: Read the existing completion file**

Review the current subcommand completion logic to understand the structure.

- [ ] **Step 2: Add new subcommands**

Include `default`, `whoami`, `exec`, `gc`, `sync-default` in the subcommand list. Add a completion for `--profile` / `-p` that lists profile directories from `WRANGLER_ACCOUNTS_DIR` or the default location.

- [ ] **Step 3: Manually verify**

Source the completion file in a zsh shell and tab-complete `wrangler-accounts <TAB>`, `wrangler-accounts --profile <TAB>`, and `wrangler-accounts exec <TAB>`. Verify output is reasonable.

- [ ] **Step 4: Commit**

```bash
git add completions/wrangler-accounts.zsh
git commit -m "chore: extend zsh completion for default, whoami, exec, gc, --profile"
```

---

## Task 15: Rewrite README and SKILL.md

**Goal:** Documentation leads with AWS-style usage. Management commands demoted to "maintenance."

**Files:**
- Modify: `README.md`
- Modify: `skills/wrangler-accounts/SKILL.md`

- [ ] **Step 1: Rewrite README**

Structure:

1. **Tagline** — "AWS-style multi-account convenience for Cloudflare Wrangler"
2. **Install** — unchanged
3. **Quick start** — four examples, in this order:
   ```bash
   wrangler-accounts login work         # first-time setup
   wrangler-accounts default work       # set persistent default
   wrangler-accounts deploy             # uses default profile
   wrangler-accounts --profile personal deploy
   wrangler-accounts exec personal -- npm run release
   ```
4. **Profile resolution** — explain the 4-tier precedence with a code block
5. **When to use `wrangler-accounts` vs native env vars** — explicit CI guidance (spec §"CI guidance")
6. **Maintenance commands** — `list`, `status`, `save`, `sync`, `sync-default`, `remove`, `gc`
7. **Deprecated** — `use`, `sync-active` with link to migration
8. **Environment variables** — `WRANGLER_PROFILE`, existing env vars
9. **Defaults and paths** — unchanged
10. **Shell completion** — unchanged

Keep it under 250 lines. Replace all `use` examples in the intro with `--profile` / `exec` / `default` equivalents.

- [ ] **Step 2: Rewrite skills/wrangler-accounts/SKILL.md**

Same structural rewrite. Lead Tasks section with "Run wrangler under a profile" and "Open a subshell for a profile" before the management tasks. Remove the `use` task from the main list (keep it only in a "Deprecated" section).

- [ ] **Step 3: Commit**

```bash
git add README.md skills/wrangler-accounts/SKILL.md
git commit -m "docs: rewrite README and SKILL to lead with AWS-style profile usage"
```

---

## Task 16: Final validation and version bump

**Goal:** Run the full suite, do a real smoke test against real wrangler, bump to 1.0.0.

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Run full test suite**

Run: `npm test`
Expected: all tests pass.

- [ ] **Step 2: Manual real-wrangler smoke test**

These tests require real OAuth profiles. They're not in CI, but the implementer should run them once before tagging:

- `wrangler-accounts list` — baseline
- `wrangler-accounts --profile <existing-profile> whoami` via wrangler (i.e. `wrangler-accounts --profile X whoami` which forwards to `wrangler whoami`) — verify it returns the right identity
- Two shells side by side: `wrangler-accounts --profile A whoami` in one, `wrangler-accounts --profile B whoami` in the other, verify each returns its own identity
- `wrangler-accounts exec <profile>` — open subshell, run `wrangler whoami`, verify correct identity, then `exit`
- Deliberately let a profile approach expiry (or use `touch -d` on the file to simulate) and run `wrangler-accounts --profile X deploy`; verify the profile's `config.toml` gets updated on refresh
- Inspect real `~/.wrangler/config/default.toml` before and after running `wrangler-accounts login newtest` — verify it was NOT modified

Record results in commit message or a scratch note, do not add a test file for these.

- [ ] **Step 3: Bump version**

Modify `package.json`:

```json
"version": "1.0.0"
```

- [ ] **Step 4: Final commit**

```bash
git add package.json
git commit -m "release: 1.0.0 — AWS-style profile execution with shadow HOME isolation"
```

- [ ] **Step 5: Print a summary of what shipped**

To stdout, not to a file. Include: number of new commands, new LOC, test count, list of deprecated commands.

---

## Notes for the implementer

- **Stay within scope.** If you discover bugs in the v0 code while refactoring, fix only if they'd block your current task. Otherwise, make a note in your final summary.
- **Commit frequently.** Each task ends with a commit. If you find yourself wanting to combine two tasks into one commit, resist — reviewers need to be able to bisect.
- **The spec is the source of truth for behavior.** If a detail in this plan conflicts with the spec, the spec wins. Flag the conflict in your final summary.
- **Do not touch Windows.** Explicitly out of scope. If a test fails on Windows, skip it with a TODO.
- **No new dependencies.** The plan is built to use only `node:test`, `node:assert`, and existing Node built-ins. If you think you need a dep, stop and check with the user.
- **Stop at Task 16.** Do not publish to npm, do not tag, do not push. The final step is the version bump commit; releasing is a separate decision.
