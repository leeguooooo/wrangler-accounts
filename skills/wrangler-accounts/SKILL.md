---
name: wrangler-accounts
description: AWS-style multi-account convenience for Cloudflare Wrangler. Use when you need to run wrangler commands against a specific Cloudflare account, manage saved OAuth profiles, set or switch the persistent default profile, or open an isolated subshell for a profile. Prefer --json for machine-readable output.
---

# Wrangler Accounts

## Overview

`wrangler-accounts` runs `wrangler` under per-invocation **shadow HOME** isolation, so multiple shells can use different Cloudflare accounts in parallel without any global switching. Profile resolution order: `--profile` / `-p` > positional shorthand > `$WRANGLER_PROFILE` > `profilesDir/default` > hard error.

## Prerequisites (check before running any recipe below)

This skill is only documentation — the actual `wrangler-accounts` binary must also be installed on the user's `PATH`. Before running any command below, verify:

```bash
command -v wrangler-accounts
```

If the command is missing, tell the user to install the CLI first:

```bash
npm i -g @leeguoo/wrangler-accounts
```

`wrangler` itself (the Cloudflare CLI) must also be on `PATH`. If missing:

```bash
npm i -g wrangler
```

## Quick Start

- `wrangler-accounts login <name>` — interactive OAuth login into a new profile (never touches real `~/.wrangler`)
- `wrangler-accounts default <name>` — set the persistent default profile
- `wrangler-accounts deploy` — run `wrangler deploy` under the default profile
- `wrangler-accounts --profile personal deploy` — one-shot override
- `wrangler-accounts exec work -- npm run release` — run a command in an isolated subshell for the `work` profile

## Tasks

### Run wrangler against a profile

Per-invocation (preferred for scripts):

`wrangler-accounts --profile <name> <wrangler-args...>`

Or with env var:

`WRANGLER_PROFILE=<name> wrangler-accounts <wrangler-args...>`

Or positional shorthand (only when `<name>` is a saved profile name, not a management subcommand):

`wrangler-accounts <name> <wrangler-args...>`

### Open a subshell for a profile

`wrangler-accounts exec <name>` — launches `$SHELL -i` with isolated `HOME` and `WRANGLER_PROFILE` set. Everything inside the subshell sees the profile, including nested `npm run` scripts, Makefiles, and `npx wrangler`.

Run a single command instead:

`wrangler-accounts exec <name> -- <cmd> [args]`

### Manage the persistent default profile

- `wrangler-accounts default` — print current default (exit 1 if none set)
- `wrangler-accounts default <name>` — set the default
- `wrangler-accounts default --unset` — clear the default
- `wrangler-accounts default --json` — JSON output

### Show the resolved identity for a profile

`wrangler-accounts whoami [--profile <name>]` — reports the profile name, source tier (cli / positional / env / default), and identity from `meta.json`. Does not spawn wrangler.

Use `--json` for structured output.

### List and inspect profiles

- `wrangler-accounts list` — text table with NAME / STATUS / EXPIRES / IDENTITY columns
- `wrangler-accounts list --json` — structured: array of `{name, isDefault, isActive, status, expirationTime, hasRefreshToken, identity, verified, verifyError}`
- `wrangler-accounts list --plain` — one profile name per line (scriptable)
- `wrangler-accounts list --deep` — **authoritative** check: spawns `wrangler whoami` in a shadow HOME for every profile and reports whether Cloudflare actually accepts the credentials. Slower (makes network calls), but the only way to catch revoked refresh tokens or broken profile files.
- `wrangler-accounts status` / `status --json`
- Pass `--include-backups` to show hidden backup profiles.

**STATUS values (1.3.0+):**

| value | meaning | user action |
|---|---|---|
| `valid` | access_token is currently valid | none |
| `valid*` / `refreshable` | access_token past expiry **BUT** refresh_token present; wrangler will auto-refresh on next use | **none** — this is fine, don't scare the user |
| `EXPIRED` / `expired` | access_token expired **AND** no refresh_token saved; profile is genuinely broken | `wrangler-accounts login <name>` |
| `unknown` | profile file has no `expiration_time` field | run `list --deep` to verify live |

**Cloudflare OAuth lifecycle reference:** access tokens are short-lived (~1 hour) by design. Every profile with `offline_access` in its scopes also has a long-lived refresh_token (~30 days, silently extended on use). Wrangler refreshes access tokens automatically whenever it runs a command and the current one is past expiry. **Do not tell the user to re-login just because `list` shows an expired access token** — check `hasRefreshToken` first. If the profile's STATUS is `valid*` / `refreshable`, nothing is wrong.

The only time a user actually needs `wrangler-accounts login <name>` again is:
1. STATUS is `EXPIRED` (no refresh_token at all — profile was saved without `offline_access` scope)
2. OR `list --deep` returns `✗` with "Not logged in" / "refresh token may be revoked" (refresh token itself got invalidated)

### Save, sync, login, remove

- `wrangler-accounts save <name>` — snapshot current Wrangler config as a profile
- `wrangler-accounts sync <name>` — refresh a specific profile from the current login
- `wrangler-accounts sync-default` — refresh the default profile
- `wrangler-accounts login <name>` — fresh isolated OAuth login
- `wrangler-accounts remove <name>` — delete a profile

### Clean up stale shadow HOMEs

`wrangler-accounts gc [--older-than 1h]` — removes `wa-*` directories under `$TMPDIR` older than the threshold (default 1h). Safe to run at any time.

## Common Recipes

These are the patterns the user is most likely asking about when they mention "Cloudflare accounts", "wrangler", or "multi-account deploys". Pick the one that matches intent.

### User wants: deploy a worker to a specific account

```bash
wrangler-accounts --profile work deploy
```

Or, when the user will be on this account for a while:

```bash
wrangler-accounts default work          # set once
wrangler-accounts deploy                # uses work from now on
wrangler-accounts deploy --env staging  # wrangler flags pass through unchanged
```

### User wants: tail production logs on one account while developing on another

```bash
# shell 1
wrangler-accounts --profile work tail my-worker --format pretty

# shell 2 (simultaneously, zero interference)
wrangler-accounts --profile personal dev
```

The two shells each get their own shadow `HOME`, so there's no global state for the other to clobber.

### User wants: run a deploy script / npm script / Makefile against a specific account

```bash
wrangler-accounts exec work -- npm run deploy
wrangler-accounts exec work -- make release
wrangler-accounts exec work -- bash scripts/deploy.sh
```

Anything inside the subshell that calls `wrangler` (directly, via `npx`, via `pnpm`, via a package.json script) automatically uses the `work` profile.

### User wants: set up a new Cloudflare account from scratch

```bash
wrangler-accounts login new-account    # opens the browser OAuth flow
wrangler-accounts whoami --profile new-account   # verify identity
wrangler-accounts list                 # confirm the profile is saved
```

The login flow runs inside an isolated shadow `HOME`, so the user's real `~/.wrangler/config/default.toml` is never touched.

### User wants: check which account a profile is tied to, without running wrangler

```bash
wrangler-accounts whoami --profile <name>           # text
wrangler-accounts whoami --profile <name> --json    # structured
```

Returns the email + account ID from the saved `meta.json`. No network call.

### User wants: swap between many accounts quickly in one shell

Use `default` as a "current" setting:

```bash
wrangler-accounts default work
wrangler-accounts deploy               # work
wrangler-accounts default personal
wrangler-accounts dev                  # personal
```

Or use positional shorthand inline:

```bash
wrangler-accounts work deploy          # one-shot, no persistent default
wrangler-accounts personal dev
```

### User wants: run wrangler in CI with multiple accounts

**Don't use `wrangler-accounts` in CI.** Use native env vars:

```bash
# In CI secrets:
CLOUDFLARE_API_TOKEN=<token-with-workers-deploy-scope>
CLOUDFLARE_ACCOUNT_ID=<account-id>

# In the pipeline:
wrangler deploy
```

`wrangler-accounts` is for **local developer** OAuth sessions. CI should use long-lived API tokens directly with plain `wrangler`. Recommend this even if the user asks to use `wrangler-accounts` in CI.

## Troubleshooting

### "Profile 'X' has expired Wrangler OAuth credentials"

The saved OAuth access token is past its `expiration_time` and the refresh didn't happen (or Wrangler is older than 4.x). Refresh it interactively:

```bash
wrangler-accounts login <name>
```

This overwrites the existing profile with a fresh OAuth session. Any saved metadata (identity, etc.) is re-verified.

### "No profile specified. Options: ..."

The user ran `wrangler-accounts <wrangler-args>` without a resolvable profile. Fix one of:

```bash
wrangler-accounts --profile <name> <args>       # one-shot
WRANGLER_PROFILE=<name> wrangler-accounts <args> # env var
wrangler-accounts default <name>                # persistent default
```

### "Profile not found: X"

The profile name doesn't exist in `profilesDir`. Check what's saved:

```bash
wrangler-accounts list
```

Create it with `wrangler-accounts login <name>` or copy an existing Wrangler login with `wrangler-accounts save <name>`.

### Inside `wrangler-accounts exec`, `cd ~` lands in a weird tmpdir

Expected. Inside an `exec` session, `$HOME` is the shadow HOME. The real home is still accessible:

```bash
cd "$WRANGLER_ACCOUNT_REAL_HOME"
```

Or users can add a shell alias: `alias realhome='cd "$WRANGLER_ACCOUNT_REAL_HOME"'`.

### Deprecated `use` command warning

`wrangler-accounts use <name>` still works but prints a deprecation warning. Suggest the replacement based on intent:

- "I want this account to stick for a while" → `wrangler-accounts default <name>`
- "Just this one command" → `wrangler-accounts --profile <name> <wrangler-args>`

### `[ERROR] A request to the Cloudflare API ... Authentication error [code: 10000]` with `code: 7403` ("not authorized to access this service")

The OAuth token is fine but **the URL contains the wrong account ID**. wrangler caches the user's selected account in `wrangler-account.json`. If that cache file is shared across profiles, profile A's OAuth token gets paired with profile B's cached account ID, sending API calls to the wrong account. Symptoms:

- `deploy` and `secret put` succeed (they don't put account ID in the URL path)
- `d1 execute --remote`, `r2 object get/put`, anything else with `/accounts/<id>/...` in the URL fails with 7403

**Fix path** (in order):

1. **Are you on wrangler-accounts ≥ 1.2.2?** Run `wrangler-accounts --version`. If `< 1.2.2`, upgrade — earlier versions pointed `WRANGLER_CACHE_DIR` at a shared global path. 1.2.2 isolates the cache per profile.
2. **Clear the polluted shared cache** (one-time, even after upgrading):
   ```bash
   rm -f ~/.wrangler/cache/wrangler-account.json
   rm -f ~/Library/Preferences/.wrangler/cache/wrangler-account.json   # macOS env-paths fallback
   ```
3. **Verify with `wrangler-accounts list --deep`** — the VERIFIED column for each profile should be `✓ ok`. If `✗`, the underlying OAuth session itself is broken; run `wrangler-accounts login <name>`.
4. **Defense in depth**: set `CLOUDFLARE_ACCOUNT_ID=<correct-id>` in the calling environment. wrangler reads this env var directly and bypasses the cache entirely. Useful for scripts or one-off recovery commands:
   ```bash
   CLOUDFLARE_ACCOUNT_ID=<id> wrangler-accounts <profile> r2 object put ...
   ```

**What to tell the user**: "wrangler returned 7403 because it cached the wrong account ID alongside your OAuth token. This was a real bug in wrangler-accounts ≤ 1.2.1 (shared cache directory across profiles). Upgrade to 1.2.2 and clear the polluted cache."

### "The OAuth config seems right, but the wrong account is being used"

Same root cause as the 7403 above. Default to the same fix path.

### `wrangler dev` (or any `--local` command) shows stale data after switching profiles

Project-local state at `<project>/.wrangler/state/` is **NOT** isolated per profile — wrangler's `getLocalPersistencePath` (cli.js:149025) hardcodes the path next to `wrangler.toml` and the only override is the `--persist-to` CLI flag (no env var hook). So if profile A's `wrangler dev` populated a local D1 emulation, then you switch to profile B and run `wrangler dev` in the same directory, B sees A's emulated rows.

This only affects `--local` simulations. **`--remote` commands hit Cloudflare directly and are unaffected** — that's the common case for d1/r2 work in a multi-account setup.

Two clean fixes:

1. **Use git worktrees** (recommended for any serious multi-profile dev workflow):
   ```bash
   git worktree add ../my-project-work main
   git worktree add ../my-project-personal main
   cd ../my-project-work && wrangler-accounts exec work     # isolated .wrangler/state/
   cd ../my-project-personal && wrangler-accounts exec personal
   ```
2. **Clear state manually before switching**:
   ```bash
   rm -rf .wrangler/state
   wrangler-accounts --profile <new> dev
   ```

`wrangler-accounts` does not auto-isolate `.wrangler/state/` because the only mechanism would be argv injection of `--persist-to`, which has too many failure modes (different subcommands accept persistTo at different positions, can't override user-supplied flags, path selection is ambiguous between per-profile and per-profile-per-project). The honest tradeoff is documented in the "What is and isn't isolated" table above — partial isolation with hidden gotchas would be worse than honest sharing.

### Shell history / `.zsh_history` seems to grow when running `exec`

Intentional. By design the shadow HOME symlinks all top-level entries of real HOME except `.wrangler`, so shell history writes pass through to the real file. This is a **convenience** bias, not a clean-room sandbox — the goal is that `exec` subshells feel like a normal terminal with a different Cloudflare account, not a jail.

## Invariants the AI should rely on

- **Real `~/.wrangler/config/default.toml` is never written to by `wrangler-accounts`.** If a user reports that it changed, something else touched it (e.g. a direct `wrangler login` outside `wrangler-accounts`).
- **Two `wrangler-accounts --profile A` and `wrangler-accounts --profile B` running in parallel never clobber each other on credentials OR account-id cache.** Each gets its own `mkdtemp` shadow HOME, and each gets its own per-profile `WRANGLER_CACHE_DIR` (next to the profile's `config.toml`) so that wrangler's `wrangler-account.json` (which stores the selected Cloudflare account ID) is naturally isolated.
- **OAuth token refresh inside a profile is automatic.** The shadow HOME contains a symlink from `.wrangler/config/default.toml` to the saved profile file, so Wrangler's in-place `fs.writeFileSync` during `refreshToken()` flows straight back to the profile.
- **`wrangler-accounts <args>` without a management subcommand forwards everything to wrangler verbatim**, including `--env`, `--dry-run`, `--json`, and any wrangler-native flags. The only flags consumed by `wrangler-accounts` itself are the ones listed in "Paths and environment" below.

## What is and isn't isolated

| State | Location | Isolated? |
|---|---|---|
| OAuth credentials (`config.toml`) | shadow `$HOME/.wrangler/config/default.toml` → symlink to per-profile file | ✅ per profile |
| Account-id cache (`wrangler-account.json`) | per-profile `WRANGLER_CACHE_DIR` (= `<profilesDir>/<name>/cache/`) | ✅ per profile |
| Pages config cache (`pages-config-cache.json`) | same as above | ✅ per profile |
| Miniflare dev registry | `WRANGLER_REGISTRY_PATH` = `$realHome/.wrangler/registry` | ❌ shared on purpose (cross-profile worker discovery during local dev) |
| Wrangler debug logs | `WRANGLER_LOG_PATH` = `$realHome/.wrangler/logs` | ❌ shared (append-only, harmless) |
| Project-local state (`./.wrangler/state/`, `./node_modules/.cache/wrangler`) | inside the project directory | ❌ shared at project level (per-project, but not per-profile) |
| `cloudflared` binary | `CLOUDFLARED_PATH` or `~/.wrangler/cloudflared/` | ❌ shared (binary, not account-scoped) |
| Shell history, npm cache, git config, ssh keys | symlinked through to real `$HOME` | ❌ shared by design (so `exec` subshells feel like a normal terminal) |

If a user is hitting a "wrong account" symptom and the credentials look right, the most likely culprit is **project-local state** in `./.wrangler/state/` — clear that and re-run.

## CI guidance

For CI and deploy pipelines, **use `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` with plain `wrangler`**, not saved OAuth profiles. `wrangler-accounts` is a local developer convenience for juggling OAuth sessions on your workstation, not a CI primitive.

## Paths and environment

- `--profile <name>` / `-p <name>` — profile for this invocation (v1.0: `-p` means `--profile`)
- `--profiles <path>` — profiles directory (long form only since v1.0)
- `-c, --config <path>` — Wrangler config path
- `WRANGLER_PROFILE` — profile to use when no `--profile` flag is given
- `WRANGLER_CONFIG_PATH`, `WRANGLER_ACCOUNTS_DIR`, `XDG_CONFIG_HOME` — path overrides

## Output conventions

Use `--json` when another tool needs to parse results. All v1.0 commands that produce structured data support `--json`.

## Naming rules

Profile names: letters, numbers, dot, underscore, dash only. Names matching management subcommand names (`exec`, `default`, `whoami`, `gc`, `login`, `list`, `status`, `save`, `sync`, `sync-default`, `remove`, `use`, `sync-active`) cannot be reached via positional shorthand — use `--profile <name>` for those.

## Deprecated

- `wrangler-accounts use <name>` — deprecated, prints warning. Use `default <name>` for persistence or `--profile <name>` for one-shot.
- `wrangler-accounts sync-active` — deprecated alias for `sync-default`.
