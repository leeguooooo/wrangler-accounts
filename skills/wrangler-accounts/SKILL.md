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
