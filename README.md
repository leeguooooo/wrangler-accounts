# wrangler-accounts

AWS-style multi-account convenience for Cloudflare Wrangler. Run commands against different Cloudflare accounts in parallel shells without switching global state.

```bash
wrangler-accounts login work                   # first-time setup (isolated)
wrangler-accounts default work                 # set persistent default
wrangler-accounts deploy                       # uses default profile
wrangler-accounts --profile personal deploy
wrangler-accounts exec personal -- npm run release
```

Two shells side by side, two different Cloudflare accounts, zero interference:

```bash
# terminal 1
wrangler-accounts --profile work tail my-worker

# terminal 2
wrangler-accounts --profile personal dev
```

## Claude Code users (recommended)

Install the marketplace and plugin first:

```text
/plugin marketplace add leeguooooo/wrangler-accounts
/plugin install wrangler-accounts@leeguoo-tools
```

The plugin bundles the `wrangler-accounts` skill plus a Bash `PreToolUse` hook, so Claude Code can learn the workflow and block raw `wrangler` calls before they bypass your local profile isolation. No manual `settings.json` editing is required.

The plugin does **not** install the CLI binary. Keep the npm package on your `PATH`:

```bash
npm i -g @leeguoo/wrangler-accounts
```

The guard only blocks direct `wrangler ...` Bash commands when all of these are true:

- `wrangler-accounts` is installed on `PATH`
- at least one local profile is configured
- the current directory looks like a Cloudflare project (`wrangler.toml`, `wrangler.json`, or `wrangler.jsonc`) or Cloudflare API env vars are set

If you explicitly want raw `wrangler`, bypass the hook for that command:

```bash
NOWRANGLER_ACCOUNTS_GUARD=1 wrangler deploy
```

### Upgrading from the `skills.sh` install

If you previously installed this skill via `npx skills add leeguooooo/wrangler-accounts`, remove that standalone copy after installing the plugin — otherwise Claude Code's slash command picker shows two identical `/wrangler-accounts` entries (one from the skills.sh directory, one from the plugin):

```bash
npx skills remove wrangler-accounts
# or, if the CLI is missing: rm -rf ~/.agents/skills/wrangler-accounts
```

Then run `/reload-plugins` and confirm only one entry remains.

## What it does

Every execution runs `wrangler` inside a per-invocation **shadow HOME** — a temporary directory that mirrors most of your real home, except `.wrangler/config/default.toml` is a symlink pointing at the saved profile's config. Token refreshes flow back to the profile automatically. Nothing touches your real `~/.wrangler`. Two parallel invocations get two independent shadow HOMEs.

## Install

If you do **not** use Claude Code plugins, install the CLI binary and the mirrored `skills.sh` skill separately:

```bash
# 1. The CLI (always required)
npm i -g @leeguoo/wrangler-accounts

# 2. The AI agent skill mirror (recommended if you use Cursor / Codex / Gemini CLI / etc.)
npx skills add leeguooooo/wrangler-accounts -g -y
```

The CLI works standalone — you can skip step 2 if you don't use an AI coding agent. The skill is just markdown documentation the AI reads; it cannot run anything without the CLI installed.

### Why two steps?

| | Installs | For |
|---|---|---|
| `npm i -g @leeguoo/wrangler-accounts` | The `wrangler-accounts` executable onto your `PATH` | Your shell |
| `npx skills add leeguooooo/wrangler-accounts` | `SKILL.md` (markdown) into your AI agent's skills directory | Your AI agent to read |

The AI will tell you to run commands like `wrangler-accounts --profile work deploy`; without step 1 those commands fail with "command not found".

### `skills.sh` mirror — more options

The repo keeps a mirrored Agent Skill at `skills/wrangler-accounts/SKILL.md` for [skills.sh](https://skills.sh). Claude Code users should prefer the plugin marketplace flow above; other agents can keep using `skills.sh` to install the same guidance markdown into their own skill directories.

```bash
npx skills add leeguooooo/wrangler-accounts -g -y        # user-global, non-interactive
npx skills add leeguooooo/wrangler-accounts              # project-scoped, interactive
npx skills add leeguooooo/wrangler-accounts -a claude-code cursor   # specific agents only
npx skills add leeguooooo/wrangler-accounts --list       # preview without installing
```

After both are installed, ask your AI agent something like "deploy my worker to the work account" or "set up a new Cloudflare profile" and the skill will guide it through the right commands.

## Usage

```bash
wrangler-accounts <wrangler-args...>            # uses default profile
wrangler-accounts --profile <name> <wrangler-args...>
wrangler-accounts -p <name> <wrangler-args...>
WRANGLER_PROFILE=<name> wrangler-accounts <wrangler-args...>

wrangler-accounts exec <name>                   # interactive subshell
wrangler-accounts exec <name> -- <cmd> [args]   # one command

wrangler-accounts login <name>                  # isolated OAuth login (browser)
wrangler-accounts token-add <name> <api-token> <account-id> [--force]  # API token profile (no browser)
wrangler-accounts default [name | --unset]      # manage persistent default
wrangler-accounts whoami [--profile <name>]     # show resolved identity
wrangler-accounts list                          # fast table (name/status/expires/identity)
wrangler-accounts list --deep                   # authoritative check via wrangler whoami
wrangler-accounts list --json                   # structured output for scripts
wrangler-accounts status
wrangler-accounts save <name>                   # snapshot current Wrangler config
wrangler-accounts sync <name>                   # refresh a profile from current login
wrangler-accounts sync-default                  # refresh the default profile
wrangler-accounts remove <name>
wrangler-accounts gc [--older-than 1h]          # clean stale shadow HOMEs
-v, --version                                   # print version
```

### `list` output

Fast default (no network calls — read from saved `config.toml` only):

```
Default: work

  NAME            STATUS  EXPIRES              IDENTITY
* work            valid   in 47m (2026-04-10)  work@example.com / 0123456789abcdef0123456789abcdef
  personal        valid   in 53m (2026-04-10)  me@example.com / fedcba9876543210fedcba9876543210

Legend: * = default profile, EXPIRED = access token past expiration_time (wrangler may still auto-refresh)
        STATUS is derived from the saved file only. For a live check that runs 'wrangler whoami' against Cloudflare,
        pass --deep (slower, makes network calls).
```

Authoritative `--deep` check (spawns `wrangler whoami` in a shadow HOME per profile, ~1s each, network required):

```
[wrangler-accounts] running deep check (wrangler whoami) for 2 profile(s)...
  NAME            STATUS  EXPIRES              VERIFIED                                     IDENTITY
* work            valid   in 47m (2026-04-10)  ✓ ok                                         work@example.com / ...
  personal        valid   in 53m (2026-04-10)  ✗ not logged in (refresh token may be revoked) me@example.com / ...
```

**When to use `--deep`**: when you actually need to know whether a profile still works. The default fast check only reads the saved `expiration_time`, which can lie in both directions — it can't tell you if Cloudflare has revoked the refresh token, and it flags fine profiles as `EXPIRED` just because their access token is past its 1-hour lifetime (wrangler auto-refreshes those transparently).

The `--json` output includes the same fields as the table plus raw `expirationTime`, `isDefault`, `isActive`, and (with `--deep`) `verified`, `verifyError`, and `liveIdentity`.

## Profile resolution order

When you run `wrangler-accounts <wrangler-args>`, the active profile is resolved in this order:

1. Explicit `--profile <name>` / `-p <name>`
2. Positional shorthand: `wrangler-accounts <profile> <wrangler-args...>` (only when `<profile>` matches a saved profile name)
3. `$WRANGLER_PROFILE`
4. `profilesDir/default` (set via `wrangler-accounts default <name>`)
5. Hard error with actionable hint

## API token profiles (no browser required)

Since 1.6.0 you can save a Cloudflare API token + account ID as a named profile — no OAuth browser flow:

```bash
# Get your API token: Cloudflare dashboard → My Profile → API Tokens
wrangler-accounts token-add work CF_TOKEN_HERE ACCOUNT_ID_HERE

# Use exactly like an OAuth profile
wrangler-accounts --profile work deploy
wrangler-accounts work r2 list
```

Token profiles appear in `list` with `[token]` type and `STATUS: token`. There's no expiration; they're always ready.

**Env-var pass-through:** if `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` are already in the environment, no profile selection is needed at all:

```bash
CLOUDFLARE_API_TOKEN=xxx CLOUDFLARE_ACCOUNT_ID=yyy wrangler-accounts deploy
```

## When to use `wrangler-accounts` vs. native env vars

- **Local dev, multiple OAuth accounts** → `wrangler-accounts login <name>` (the classic use case)
- **Local dev, API token accounts** → `wrangler-accounts token-add <name> <token> <account-id>` (1.6.0+)
- **CI / deploy pipelines** → either `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` with plain `wrangler`, or the env-var pass-through mode above
- **Shared scripts** that run locally or in CI → parameterize on `WRANGLER_PROFILE` so devs can run them with `WRANGLER_PROFILE=work wrangler-accounts ./deploy.sh`.

## Options

```text
-c, --config <path>     Wrangler config path
    --profiles <path>   Profiles directory (long form only)
-p, --profile <name>    Profile name for this invocation
    --json              JSON output
    --plain             Plain output for list (one name per line)
    --include-backups   Include backup profiles in list/status
-f, --force             Overwrite existing profile on save
    --unset             With 'default': clear the persistent default
    --deep, --verify    With 'list': run wrangler whoami per profile for live verification
    --older-than <dur>  With 'gc': age threshold (e.g. 1h, 30m, 7d)
-v, -V, --version       Print version
-h, --help              Show help
```

## Environment variables

- `WRANGLER_PROFILE` — profile to use when no `--profile` flag is given
- `WRANGLER_CONFIG_PATH` — Wrangler config path override
- `WRANGLER_ACCOUNTS_DIR` — profiles directory override
- `XDG_CONFIG_HOME` — fallback base for the profiles directory

Inside an isolated session, these are automatically set for the child process:

- `HOME` — the shadow HOME
- `WRANGLER_PROFILE` / `WRANGLER_ACCOUNT` — current profile name (useful for shell prompt integration)
- `WRANGLER_ACCOUNT_REAL_HOME` — path to your real home (escape hatch)
- `WRANGLER_CACHE_DIR` — **per-profile**, points at `<profilesDir>/<name>/cache/`. Holds wrangler's `wrangler-account.json` (selected account ID), `pages-config-cache.json`, etc. Isolating this is critical: see "What is and isn't isolated" below.
- `WRANGLER_REGISTRY_PATH`, `WRANGLER_LOG_PATH` — pointed at real HOME so Miniflare dev registry and debug logs are shared across profiles (cross-profile dev worker discovery is intentional)
- `CLOUDFLARED_PATH` — set when `cloudflared` is on your PATH
- `WRANGLER_SEND_METRICS=false`

## What is and isn't isolated

`wrangler-accounts` isolates the things that determine **which account a wrangler command targets**, but deliberately shares some state for performance and ergonomics. Know the boundary:

| State | Location | Isolated? |
|---|---|---|
| OAuth credentials (`config.toml`, refresh token) | shadow `$HOME/.wrangler/config/default.toml` → symlink to per-profile file | ✅ per profile |
| Account-id cache (`wrangler-account.json`) | `WRANGLER_CACHE_DIR` = `<profilesDir>/<name>/cache/` | ✅ per profile |
| Pages config cache | same as above | ✅ per profile |
| Miniflare dev registry | `WRANGLER_REGISTRY_PATH` = `$HOME/.wrangler/registry` | ❌ **shared** (intentional — local dev workers discover each other across profiles) |
| Wrangler debug logs | `WRANGLER_LOG_PATH` = `$HOME/.wrangler/logs` | ❌ **shared** (append-only) |
| Project-local state (`./.wrangler/state/`, `./node_modules/.cache/wrangler`) | inside the project directory | ❌ **shared at project level** — same project from two profiles uses the same project-local state. If you hit a "wrong account" symptom, clearing `./.wrangler/state/` is a good first step. |
| `cloudflared` binary cache | `~/.wrangler/cloudflared/` or `$CLOUDFLARED_PATH` | ❌ shared (binary, not account-scoped) |
| Shell history, `.npmrc`, `.gitconfig`, `.ssh/` etc. | symlinked through to real `$HOME` | ❌ shared by design (so `exec` subshells feel like a normal terminal) |

> **Why this matters**: in 1.2.1 and earlier, `WRANGLER_CACHE_DIR` was pointed at real `$HOME/.wrangler/cache`, which meant `wrangler-account.json` was shared across profiles. Profile A's OAuth token could end up paired with profile B's cached account ID, causing wrangler to write resources to the wrong account *silently*. Fixed in 1.2.2 by per-profile `WRANGLER_CACHE_DIR`. Upgrade if you're on ≤1.2.1.

## Breaking changes in 1.0

- **`-p` is now `--profile`** (was `--profiles` in 0.1.x). Use the long form `--profiles <path>` to specify the profiles directory.
- **`use` is no longer supported**. The command now exits with migration guidance. Use `default <name>` for persistence or `--profile <name>` for one-shot execution.
- **`sync-active` is deprecated**, replaced by `sync-default`. The alias still works with a warning.
- Profile names matching management subcommand names (`exec`, `default`, `whoami`, `gc`, `login`, `list`, `status`, `save`, `sync`, `sync-default`, `remove`, `use`, `sync-active`) cannot be reached via positional shorthand. Use `--profile <name>` instead.
- First-time setup of a new profile via `wrangler-accounts login <name>` no longer touches your real `~/.wrangler/config/default.toml`. All credential writes go directly into the profile directory.

## Defaults and paths

If you do not specify a config path, the CLI checks these paths and uses the first existing one:

- `~/.wrangler/config/default.toml`
- `~/Library/Preferences/.wrangler/config/default.toml`
- `~/.config/.wrangler/config/default.toml`
- `~/.config/wrangler/config/default.toml`

The profiles directory defaults to:

- `$XDG_CONFIG_HOME/wrangler-accounts` (if set)
- `~/.config/wrangler-accounts`

## Notes

- Profile names accept only letters, numbers, dot, underscore, and dash.
- Saved OAuth sessions can expire. If a profile is expired, running it will stop and tell you to run `wrangler-accounts login <name>` again.
- Legacy backups created by older `use` flows are hidden from `list` and `status` unless you pass `--include-backups`.

## FAQ

### How do I use Cloudflare Wrangler with multiple accounts?

`wrangler` itself only supports one OAuth login at a time — running `wrangler login` overwrites `~/.wrangler/config/default.toml`, forcing you to re-login every time you switch accounts. `wrangler-accounts` saves each login as a named profile and runs `wrangler` inside a per-invocation **shadow HOME**, so different shells can use different Cloudflare accounts in parallel.

```bash
npm i -g @leeguoo/wrangler-accounts
wrangler-accounts login work
wrangler-accounts login personal
wrangler-accounts --profile work deploy
wrangler-accounts --profile personal tail my-worker
```

### How do I switch between Cloudflare Workers accounts without logging out?

Use `wrangler-accounts --profile <name>` for a single command, or `wrangler-accounts default <name>` to set a persistent default. Neither touches your existing `~/.wrangler/config/default.toml`; profiles live in their own directory.

### Can I run `wrangler dev` on one Cloudflare account while deploying to another?

Yes. That's the whole point of the shadow HOME isolation — each shell gets its own temporary HOME with the profile's OAuth config, so two invocations never share state.

```bash
# terminal 1
wrangler-accounts --profile work tail my-worker --format pretty

# terminal 2
wrangler-accounts --profile personal dev
```

### How do I use Wrangler with multiple accounts in CI?

**Don't use `wrangler-accounts` in CI.** Use native env vars — `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` — with plain `wrangler`. That's what Cloudflare designed wrangler for; `wrangler-accounts` is a local developer convenience for juggling OAuth sessions on your workstation.

### Is this like `aws-vault` / `aws --profile` but for Cloudflare?

Yes. `wrangler-accounts` is to Cloudflare Wrangler what `aws --profile` and `aws-vault exec` are to the AWS CLI: named profiles, per-invocation isolation, subshell mode, AWS-style resolution order (`--profile` > `$WRANGLER_PROFILE` > persistent default). Unlike AWS CLI, `wrangler` has no native `--profile` flag, so `wrangler-accounts` sits in front of `wrangler` and sets up an isolated `HOME` per invocation.

### How do I know if a saved profile still works?

`wrangler-accounts list` shows a fast table with STATUS (derived from the saved `expiration_time`), but that can miss revoked refresh tokens. For an authoritative check, run:

```bash
wrangler-accounts list --deep
```

This spawns `wrangler whoami` inside each profile's shadow HOME and reports whether Cloudflare actually accepts the credentials.

### I get "Not logged in" even though I just ran `wrangler login`

If you used plain `wrangler login`, it wrote to your real `~/.wrangler/config/default.toml`. Capture that as a named profile before it gets overwritten:

```bash
wrangler-accounts save work
```

Or start fresh with `wrangler-accounts login work`, which does the OAuth flow inside an isolated shadow HOME and writes directly into the profile directory.

## Discoverability

Project: Cloudflare Wrangler multi-account manager — save and switch between multiple Cloudflare Workers OAuth logins without re-authenticating each time.

**Search keywords**: cloudflare wrangler multi account, wrangler multiple accounts, cloudflare workers switch account, wrangler profile manager, wrangler login profiles, cloudflare account switcher, wrangler --profile, AWS-style profile for wrangler, aws-vault for cloudflare, wrangler oauth multi account, cloudflare workers different accounts, per-invocation isolation, shadow home, wrangler account management CLI.

**AI agent keywords**: agent skill, skills.sh, Claude Code skill, Cursor skill, Codex skill, Gemini CLI skill — see "Install as an AI agent skill" above.

Related tools / alternatives:
- [AWS CLI `--profile`](https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-files.html) — same concept for AWS, natively supported
- [aws-vault](https://github.com/99designs/aws-vault) — OAuth-safe AWS profile wrapper that inspired the `exec` design here
- [direnv](https://direnv.net/) — directory-based env switching (orthogonal, can be combined)

## Shell completion (zsh)

```bash
mkdir -p ~/.zsh/completions
cp $(pnpm root -g)/@leeguoo/wrangler-accounts/completions/wrangler-accounts.zsh ~/.zsh/completions/_wrangler-accounts
```

Then add to your `~/.zshrc`:

```bash
fpath=(~/.zsh/completions $fpath)
autoload -Uz compinit && compinit
```
