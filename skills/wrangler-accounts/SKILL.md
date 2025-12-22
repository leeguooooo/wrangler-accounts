---
name: wrangler-accounts
description: Manage multiple Cloudflare Wrangler login profiles with the wrangler-accounts CLI. Use when Codex needs to list profiles, inspect status, save or login profiles, switch active configs, remove profiles, or adjust config/profiles paths via flags or env vars.
---

# Wrangler Accounts

## Overview

Use the wrangler-accounts CLI to save, switch, and inspect Cloudflare Wrangler login profiles by copying the Wrangler config file. Prefer --json when returning data to another tool.

## Quick Start

- `wrangler-accounts list`
- `wrangler-accounts status`
- `wrangler-accounts save <name>`
- `wrangler-accounts use <name>`

## Tasks

### List profiles

Run:

`wrangler-accounts list`

For machine output, use:

`wrangler-accounts list --json` or `wrangler-accounts list --plain`

### Check status

Run:

`wrangler-accounts status`

Use `--json` to read fields like `configPath`, `profilesDir`, `activeProfile`, and `matchingProfile`.

### Save current config as a profile

Run:

`wrangler-accounts save <name>`

Use `--force` to overwrite an existing profile.

### Login and save a profile

Run:

`wrangler-accounts login <name>`

This runs `wrangler login` first, then saves the config under the name.

### Switch to a profile

Run:

`wrangler-accounts use <name>`

Keep backups on by default; pass `--no-backup` to disable. With `--json`, read `backupName` when a backup is created.

### Remove a profile

Run:

`wrangler-accounts remove <name>`

## Paths and Environment

Use `--config` to point at a Wrangler config path and `--profiles` for the profiles directory. The tool also reads:

- `WRANGLER_CONFIG_PATH`
- `WRANGLER_ACCOUNTS_DIR`
- `XDG_CONFIG_HOME`

## Output Conventions

Prefer `--json` when another tool needs to parse results. Non-list commands return an action payload with `command`, `name`, and relevant paths.

## Naming Rules

Use only letters, numbers, dot, underscore, and dash in profile names.
