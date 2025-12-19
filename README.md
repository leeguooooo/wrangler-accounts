# wrangler-accounts

Local CLI to manage multiple Cloudflare Wrangler login profiles by saving and swapping the Wrangler config file.

## What it does

- Save the current Wrangler config as a named profile
- Switch between profiles by copying a saved config into place
- List or inspect status (active profile and matching profile)
- Optional automatic backups when switching

## Install (npm)

```bash
npm i -g @leeguoo/wrangler-accounts
```

## Install (local)

From this repo:

```bash
npm link
```

Or run directly:

```bash
node bin/wrangler-accounts.js <command>
```

## Usage

```bash
wrangler-accounts list
wrangler-accounts status
wrangler-accounts save work
wrangler-accounts use personal
wrangler-accounts remove old
```

## Options

```text
-c, --config <path>     Wrangler config path
-p, --profiles <path>   Profiles directory
--json                  JSON output for list/status
-f, --force             Overwrite existing profile on save
--backup                Backup current config on use (default)
--no-backup             Disable backup on use
```

## Environment variables

- WRANGLER_CONFIG_PATH
- WRANGLER_ACCOUNTS_DIR
- XDG_CONFIG_HOME

## Defaults

If you do not specify a config path, the CLI checks for these and uses the first existing path:

- ~/.wrangler/config/default.toml
- ~/.config/.wrangler/config/default.toml
- ~/.config/wrangler/config/default.toml

The profiles directory defaults to:

- $XDG_CONFIG_HOME/wrangler-accounts (if set)
- ~/.config/wrangler-accounts

## Notes

- Profile names accept only letters, numbers, dot, underscore, and dash.
- On `use`, the current config is backed up into `__backup-YYYYMMDD-HHMMSS` unless you pass `--no-backup`.
