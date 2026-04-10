# AWS-style profile execution for wrangler-accounts

**Status:** Draft
**Date:** 2026-04-10
**Owner:** leo (@leeguooooo)

## Goal

Make `wrangler-accounts` feel like AWS multi-account tooling: one-liner profile
selection (`--profile` / `WRANGLER_PROFILE`), true concurrent isolation across
shells, no hidden global state, and honest guidance for CI.

The primary user need is running two shells simultaneously against different
Cloudflare accounts (e.g. `wrangler deploy` on the personal account in one
shell while `wrangler tail` runs on the work account in another) without one
clobbering the other. The current global-switch `use` model cannot do this
because it mutates `~/.wrangler/config/default.toml` as a shared mutex-free
global.

## Non-goals

- `.wrangler-profile` cwd dotfile auto-discovery. Account choice must not change
  silently because of `cd`.
- A PATH-prepended `wrangler` shim. It fakes a bare `wrangler` experience but
  buys long-term debt in PATH, upgrades, and debugging.
- `credential_process`, source profiles, or role assumption chains. These are
  IAM concepts that don't map to Cloudflare OAuth.
- Treating saved OAuth profiles as the primary CI auth path. CI should use
  native `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` with plain `wrangler`;
  this tool is a **local developer** convenience.
- Windows. Tracked separately; v1 targets macOS and Linux.

## Background: why Wrangler is hard

Wrangler 4.x hardcodes its OAuth config lookup inside `wrangler-dist/cli.js`:

```js
function getGlobalWranglerConfigPath() {
  const configDir = envPaths(".wrangler").config;
  const legacyConfigDir = path.join(os.homedir(), ".wrangler");
  if (isDirectory(legacyConfigDir)) return legacyConfigDir;
  return configDir;
}
```

Unlike AWS CLI, there is **no environment variable** to redirect the OAuth
config directory. `WRANGLER_HOME`, `WRANGLER_CONFIG_PATH`, and `XDG_CONFIG_HOME`
were all empirically verified to not work. The only hook is `os.homedir()`,
which reads `$HOME`. Therefore the only portable way to isolate credentials per
invocation is to override `$HOME`.

Wrangler also mutates `default.toml` during normal operation: `refreshToken()`
calls `writeAuthConfigFile()` (cli.js:128694) whenever an access token is close
to expiring. Any per-invocation copy-then-discard approach would silently
discard these token refreshes and cause profiles to rot.

## High-level design

Three command surfaces, one shared execution core:

```
wrangler-accounts [--profile <p>] <wrangler-args...>      # per-invocation
wrangler-accounts exec <profile> [-- <cmd...>]            # per-session
wrangler-accounts login <profile>                         # isolated login
```

All three route through `runIsolated(profile, { mode, argv })`, which:

1. Resolves the profile name (explicit flag > env var > persistent default).
2. Verifies the profile exists and its OAuth session isn't expired.
3. Creates a **shadow HOME** — a per-invocation temporary directory that
   mirrors the real `$HOME` through top-level symlinks, except `.wrangler`,
   which is a real directory containing `config/default.toml` **symlinked to
   the profile file** so token refreshes sync back automatically.
4. Injects a set of environment variables that route Wrangler's non-credential
   state (registry, cache, cloudflared) back to real `$HOME`, preventing
   split-brain behavior in local dev.
5. Spawns the child process (`wrangler`, `$SHELL`, or a user command) with the
   shadow HOME as `HOME`.
6. Cleans up the shadow HOME on exit. Because the shadow contains only
   symlinks and one more symlink to the profile file, cleanup is a safe
   `rm -rf` with no data loss risk.

## Command surface

### Per-invocation: the main entry point

```
wrangler-accounts [--profile <name> | -p <name>] <wrangler-args...>
```

Examples:

```bash
wrangler-accounts --profile work deploy worker.js
wrangler-accounts -p personal tail my-worker
WRANGLER_PROFILE=work wrangler-accounts deploy
wrangler-accounts deploy        # uses the persistent default profile
```

When no management subcommand (`list`, `status`, `save`, etc.) is matched as
the first positional arg, `wrangler-accounts` treats the remaining argv as
Wrangler arguments and runs it inside an isolated shadow HOME.

**Positional shorthand:** a legacy form `wrangler-accounts <profile> <wrangler-args...>`
is supported only when `<profile>` is unambiguously a saved profile name
(checked against `profilesDir`). If the first positional arg is also a
management subcommand name, the management interpretation wins. Documented as
convenience; `--profile` is canonical.

### Per-session: exec mode

```
wrangler-accounts exec <profile> [-- <cmd> [args...]]
```

Examples:

```bash
wrangler-accounts exec work                       # opens $SHELL
wrangler-accounts exec work -- npm run deploy     # runs one command
wrangler-accounts exec work -- bash ci/release.sh # runs a script
```

`exec` launches `$SHELL` (or the user's command) with:

- `HOME` = shadow HOME
- `WRANGLER_PROFILE` = `<profile>` (propagated so any nested
  `wrangler-accounts` call in the session inherits it)
- `WRANGLER_ACCOUNT` = `<profile>` (for prompt integration)
- All other env vars listed in the "Env injection" section below

**No shim is installed.** Any `wrangler` invoked inside the session — whether
from `$PATH`, `./node_modules/.bin/wrangler`, `npx wrangler`, or a Makefile
rule — runs against the shadow HOME and therefore the correct profile, without
the wrapper interposing on command resolution.

### Isolated login

```
wrangler-accounts login <profile>
```

Replaces the current implementation (which runs `wrangler login` against the
global config). New flow:

1. Create shadow HOME but **do not** pre-create `.wrangler/config/default.toml`.
2. Spawn `wrangler login` with `HOME=shadow`. Wrangler performs the browser
   OAuth flow and writes `shadow/.wrangler/config/default.toml`.
3. Atomically `rename` the resulting file into `profilesDir/<profile>/config.toml`
   (creating the profile dir if needed) and write updated meta.json.
4. Clean up shadow.

Side effect: `wrangler-accounts login` never touches the user's real
`~/.wrangler/config/default.toml`. First-time setup no longer pollutes the
global config.

### Default profile management

A first-class subcommand, modeled on `aws configure set default.profile`:

```
wrangler-accounts default             # print current default, exit 0 / 1
wrangler-accounts default <name>      # set default (validates existence)
wrangler-accounts default --unset     # clear default
```

Stored as a plain text file at `profilesDir/default` containing the profile
name on a single line. Not a symlink — grep-friendly, portable, trivial to
validate. `profilesDir/active` (written by the deprecated `use`) is not
repurposed; see "Migration".

### whoami

```
wrangler-accounts whoami [--profile <name>]
```

Reports which profile would be resolved given current flags/env/default, and
its saved identity (email / account name / account ID from profile meta). Does
not spawn Wrangler. Useful for scripts and for sanity-checking prompts before
running a destructive command.

### Management commands (unchanged or lightly touched)

- `list` — unchanged
- `status` — unchanged, with one addition: reports the resolved default profile
- `save <name>` — unchanged; gains post-write identity validation (see below)
- `sync <name>` — unchanged
- `sync-active` — **renamed** to `sync-default`; `sync-active` kept as a
  deprecation alias that prints a warning and delegates
- `remove <name>` — unchanged; refuses to remove the default profile unless
  `--force` is passed
- `gc [--older-than <duration>]` — **new**: removes stale shadow HOMEs left
  under `$TMPDIR` after crashes. Default `--older-than 1h`.

### Deprecated

- `use <name>` — still works, prints a one-line deprecation warning to stderr
  pointing at `wrangler-accounts default <name>` for persistence or
  `wrangler-accounts --profile <name>` for one-shot execution. Will be removed
  in a future major.
- `sync-active` — as above.

## Profile resolution order

Resolved by a single `resolveProfile()` function called from every entry
point:

1. Explicit CLI flag: `--profile <name>` or `-p <name>`
2. Positional shorthand: first positional arg when it matches an existing
   profile name and no management subcommand is in play
3. Environment variable: `$WRANGLER_PROFILE`
4. Persistent default: contents of `profilesDir/default`
5. Hard error with actionable message:

   ```
   No profile specified. Options:
     - wrangler-accounts --profile <name> ...
     - WRANGLER_PROFILE=<name> wrangler-accounts ...
     - wrangler-accounts default <name>   (set a persistent default)
   ```

No cwd dotfile layer. No implicit config-file sections modeled on `~/.aws/config`.

## Execution core

### Shadow HOME construction

Pseudocode:

```js
function createShadowHome(profile) {
  const profileCfg = path.join(profilesDir, profile, "config.toml");
  assertExistsAndNotExpired(profileCfg);

  const shadow = fs.mkdtempSync(path.join(os.tmpdir(), `wa-${profile}-`));
  fs.chmodSync(shadow, 0o700);

  // Mirror top-level entries from real HOME, except .wrangler.
  const realHome = realHomeFromEnv();
  for (const entry of fs.readdirSync(realHome)) {
    if (entry === ".wrangler") continue;
    fs.symlinkSync(
      path.join(realHome, entry),
      path.join(shadow, entry),
    );
  }

  // The one file that matters — symlinked to the profile so Wrangler's
  // token refresh writes back to the profile, not to the shadow.
  fs.mkdirSync(path.join(shadow, ".wrangler", "config"), { recursive: true });
  fs.symlinkSync(
    profileCfg,
    path.join(shadow, ".wrangler", "config", "default.toml"),
  );

  return shadow;
}
```

Notes:

- "Allow all top-level entries except `.wrangler`" is a deliberate convenience
  bias. Writes that happen to go through symlinks (`.zsh_history`,
  `.bash_sessions`, completion caches) land in the real home. This is the
  opposite of a clean-room sandbox; it is the trade-off that makes exec-mode
  sub-shells feel like the user's normal shell.
- Users needing tighter isolation can opt in with `--strict`, which mirrors
  only an allowlist (`.npmrc`, `.gitconfig`, `.ssh`, `Library` on macOS).
  Deferred to v1.1 if demand exists.
- If real HOME already contains `.wrangler` (legacy install), it is **not**
  mirrored. Shadow HOME's own `.wrangler` directory is what Wrangler will find
  and use.

### Env injection

In addition to `HOME`, set the following on the child process:

| Variable | Value | Purpose |
|---|---|---|
| `HOME` | `<shadow>` | Credential isolation |
| `WRANGLER_PROFILE` | `<profile>` | Propagation to nested wrangler-accounts calls |
| `WRANGLER_ACCOUNT` | `<profile>` | Prompt integration (matches aws-vault's `AWS_VAULT`) |
| `WRANGLER_ACCOUNT_REAL_HOME` | `<realHome>` | Escape hatch for scripts that need real HOME |
| `WRANGLER_REGISTRY_PATH` | `<realHome>/.wrangler/registry` | Keep Miniflare dev registry shared across profiles so local multi-worker discovery still works |
| `WRANGLER_CACHE_DIR` | `<realHome>/.wrangler/cache` | Avoid re-downloading workerd per invocation |
| `WRANGLER_LOG_PATH` | `<realHome>/.wrangler/logs` | Keep debug logs persistent |
| `CLOUDFLARED_PATH` | `$(which cloudflared)` if available | Avoid re-downloading cloudflared |
| `WRANGLER_SEND_METRICS` | `false` (only in `runIsolated`) | Metrics file would be ephemeral anyway |

Rationale: the shadow only isolates the OAuth credential; all other
"global-ish" wrangler state (dev registry, cache, logs) is deliberately routed
back to the real HOME because it is not account-scoped and splitting it would
break local dev and cause cache churn. This is what keeps the isolation tight
without making the tool feel broken.

### Spawn and cleanup

```js
function runIsolated(profile, { mode, argv, userCmd }) {
  const shadow = createShadowHome(profile);
  const env = buildEnv(profile, shadow);

  const [cmd, args] = (() => {
    if (mode === "invoke") return ["wrangler", argv];
    if (mode === "login")  return ["wrangler", ["login"]];
    if (mode === "exec") {
      if (userCmd && userCmd.length) return [userCmd[0], userCmd.slice(1)];
      return [process.env.SHELL || "/bin/sh", ["-i"]];
    }
  })();

  let exitCode = 1;
  try {
    const r = spawnSync(cmd, args, { stdio: "inherit", env });
    exitCode = r.status ?? 1;
    // login mode: after successful exit, copy shadow config into profile
    if (mode === "login" && exitCode === 0) {
      persistLoginResult(profile, shadow);
    }
  } finally {
    fs.rmSync(shadow, { recursive: true, force: true });
  }

  return exitCode;
}
```

Cleanup is safe because the shadow contains only directory entries that are
either symlinks (to real files) or a symlinked `.wrangler/config/default.toml`
(to the profile file). A crash leaks an empty directory, not secrets.

### gc

`wrangler-accounts gc [--older-than <duration>]` scans `$TMPDIR` for
`wa-*` directories whose mtime is older than the threshold and removes them.
Exits with a short report. Safe by construction because of the symlink-only
structure.

## Login validation

New in v1: when `login` or `save` writes a profile, the tool:

1. Runs `wrangler whoami` inside the same shadow HOME used for the login/save
2. Parses the output for account ID and email
3. Stores them in `meta.json` alongside the profile
4. Fails the command with a clear error if parsing fails or the session is
   already expired (the latter shouldn't happen after a fresh login, but
   defends against interrupted flows)

This mirrors the AWS UX expectation that "valid profile = verified identity",
and prevents silent creation of broken profiles.

## CI guidance

The README and skill doc will say this plainly:

> For CI and automation, **use `CLOUDFLARE_API_TOKEN` and
> `CLOUDFLARE_ACCOUNT_ID` with plain `wrangler`**, not saved OAuth profiles.
> Wrangler is designed to read those env vars natively. `wrangler-accounts`
> is a local developer convenience for juggling OAuth sessions on your
> workstation.

A section titled "When to use `wrangler-accounts` vs. native env vars" will
enumerate:

- Local dev, multiple accounts → `wrangler-accounts`
- CI / deploy pipelines → native env vars + plain `wrangler`
- Shared scripts → parameterize on `WRANGLER_PROFILE` so devs can run them
  with `WRANGLER_PROFILE=work wrangler-accounts ./deploy.sh`

## Migration from v0.x

- `use <name>` — still works, deprecation warning on stderr
- `sync-active` — still works as alias for `sync-default`, deprecation warning
- `profilesDir/active` (written by old `use`) — on first run of the new CLI:
  - If `profilesDir/default` exists, ignore `active`
  - If `profilesDir/default` does not exist and `active` does, print a one-time
    migration hint: "Found legacy `active` profile '<name>'. Run
    `wrangler-accounts default <name>` to make it the persistent default."
  - Never silently auto-migrate; the user must confirm
- `profilesDir/<name>/config.toml` format — unchanged, v0 profiles work as-is

No breaking changes in profile storage. Version bumps to 1.0.0 because the
execution model is new.

## Data model

Unchanged from v0 except:

- `profilesDir/default` — new file, contains a profile name
- `meta.json` gains a `validatedAt` timestamp set by login/save validation

Directory layout:

```
$XDG_CONFIG_HOME/wrangler-accounts/
├── default                          # text: "work"
├── active                           # legacy, written only by deprecated `use`
├── work/
│   ├── config.toml
│   └── meta.json
├── personal/
│   ├── config.toml
│   └── meta.json
└── __backup-.../                    # existing backup behavior from `use`
```

## Error model

All errors flow through a single `die(message, { code, hint })` function that
in JSON mode emits `{"error": "...", "hint": "..."}` and in text mode emits
`Error: ...\nHint: ...`. Exit codes:

- `0` — success
- `1` — generic failure (bad args, missing files)
- `2` — profile not found / not resolvable
- `3` — profile expired (OAuth session needs `login`)
- `4` — wrangler child process non-zero exit (code forwarded from child when
  possible, otherwise this sentinel)
- `5` — environment problem (HOME unset, can't create shadow)

Machine-readable errors always include `code` in JSON mode.

## Testing strategy

1. **Unit tests** for:
   - Profile resolution order (all 5 tiers, including positional shorthand
     ambiguity)
   - Shadow HOME construction (symlink structure, chmod, `.wrangler` exclusion)
   - Cleanup safety (shadow with partial state, missing profile)
   - gc threshold logic

2. **Integration tests** (against a fake wrangler binary on PATH):
   - `wrangler-accounts --profile X deploy …` — verify spawned process sees
     shadow HOME and correct env
   - `wrangler-accounts exec X -- env` — verify `WRANGLER_PROFILE`,
     `WRANGLER_ACCOUNT`, and `HOME` are set in the child
   - Two concurrent invocations with different profiles must not see each
     other's state (verified by writing sentinel files via the fake wrangler)

3. **Manual smoke tests** against real wrangler 4.x:
   - Concurrent `wrangler whoami` in two shells with different profiles
   - `wrangler deploy` of a tiny worker from each profile's account
   - Token refresh sync-back: set a profile's config with a near-expiry token,
     run `wrangler whoami`, verify profile file is updated in place
   - `exec` session with `cd`, `npm run`, `npx wrangler`, and a Makefile target
   - `login` into a fresh profile, verify real `~/.wrangler/config` is untouched

4. **Regression**: existing v0 commands (`list`, `save`, `sync`, `status`,
   `remove`, `use` with warning) continue to pass their current tests.

## Open questions

These are being recorded to defer, not block:

- **`--strict` symlink mode**: worth it in v1.1 if users complain about shell
  history pollution; defer until asked
- **Windows support**: symlink mechanics differ (privileges, junctions);
  tracked separately, out of v1
- **Profile encryption at rest**: OAuth tokens sit in plaintext TOML today;
  out of v1 but worth noting in security docs
- **`wrangler-accounts config set default.profile X`**: a more AWS-shaped
  alias for `default X`; can add later without breakage

## Implementation summary

The change is additive to `bin/wrangler-accounts.js`:

- Extract existing path/detection logic into small helper modules (no behavior
  change)
- Add `resolveProfile()` at the top of `main()`
- Add `runIsolated()`, `createShadowHome()`, `buildEnv()`, `persistLoginResult()`
- Add new subcommands: `default`, `whoami`, `gc`, `exec`, `sync-default`
- Add deprecation wrappers on `use` and `sync-active`
- Extend zsh completion for the new surface (`--profile`, `exec`, `default`,
  `whoami`, `gc`)
- Update README and `skills/wrangler-accounts/SKILL.md` to lead with the new
  model and demote `use`

Estimated surface: ~500 new LOC in the CLI entrypoint plus tests; README and
skill doc rewrites.
