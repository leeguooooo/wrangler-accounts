---
name: wrangler-accounts
description: AWS-style multi-account convenience for Cloudflare Wrangler. Use when you need to run wrangler commands against a specific Cloudflare account, manage saved OAuth profiles, set or switch the persistent default profile, or open an isolated subshell for a profile. Prefer --json for machine-readable output.
---

# Wrangler Accounts

## Overview

`wrangler-accounts` runs `wrangler` under per-invocation **shadow HOME** isolation, so multiple shells can use different Cloudflare accounts in parallel without any global switching. Profile resolution order: `--profile` / `-p` > positional shorthand > `$WRANGLER_PROFILE` > `profilesDir/default` > hard error.

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

- `wrangler-accounts list` / `list --json` / `list --plain`
- `wrangler-accounts status` / `status --json`
- Pass `--include-backups` to show hidden backup profiles.

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

### Shell history / `.zsh_history` seems to grow when running `exec`

Intentional. By design the shadow HOME symlinks all top-level entries of real HOME except `.wrangler`, so shell history writes pass through to the real file. This is a **convenience** bias, not a clean-room sandbox — the goal is that `exec` subshells feel like a normal terminal with a different Cloudflare account, not a jail.

## Invariants the AI should rely on

- **Real `~/.wrangler/config/default.toml` is never written to by `wrangler-accounts`.** If a user reports that it changed, something else touched it (e.g. a direct `wrangler login` outside `wrangler-accounts`).
- **Two `wrangler-accounts --profile A` and `wrangler-accounts --profile B` running in parallel never clobber each other.** Each gets its own `mkdtemp` shadow HOME.
- **OAuth token refresh inside a profile is automatic.** The shadow HOME contains a symlink from `.wrangler/config/default.toml` to the saved profile file, so Wrangler's in-place `fs.writeFileSync` during `refreshToken()` flows straight back to the profile.
- **`wrangler-accounts <args>` without a management subcommand forwards everything to wrangler verbatim**, including `--env`, `--dry-run`, `--json`, and any wrangler-native flags. The only flags consumed by `wrangler-accounts` itself are the ones listed in "Paths and environment" below.

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
