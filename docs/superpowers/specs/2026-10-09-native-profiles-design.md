# Native Wrangler profiles as a second backend (v1.9.0)

## Why

Wrangler 4.149 ships named auth profiles (beta): `wrangler auth create|activate|deactivate|list|delete`,
a global `--profile <name>` flag, per-directory bindings and optional OS-keyring encryption of the
OAuth credentials. wrangler-accounts has done the same job since 1.0 with a per-invocation shadow
HOME. 1.9.0 builds on the native feature where it helps (encryption at rest, `wrangler --profile`
working outside wrangler-accounts) without dropping anything the shadow backend does.

Hard requirement: no existing command, flag, output field or exit code may disappear.
`test/contract.test.js` runs every command against a fixture and compares with a snapshot recorded
on 1.8.0 (subset match: new fields/lines allowed, old ones must stay).

## Facts from wrangler 4.149.0 `wrangler-dist/cli.js` (verified)

| Topic | Behaviour |
| --- | --- |
| Config dir | `getGlobalConfigPath()`: `~/.wrangler` if it is a directory, else `$XDG_CONFIG_HOME/.wrangler` (macOS default `~/Library/Preferences/.wrangler`, Linux `~/.config/.wrangler`). |
| Profile files | `<cfg>/config/<name>.toml` (same TOML as `default.toml`) or `<cfg>/config/<name>.enc`. |
| Names | `/^[a-zA-Z0-9_-]+$/`, `default` and `staging` reserved (case-insensitive). wrangler-accounts also allows `.`. |
| Resolution | `CLOUDFLARE_API_TOKEN` > `--profile` > nearest bound directory (`<cfg>/profiles/directory-bindings.json`, longest prefix, keyed by the cwd or the dir of `--config`) > `default`. There is no env var for the profile. |
| `--profile` rejected by | `whoami`, `login`, `logout`, `auth create/activate/deactivate/list/keyring`. Accepted by `auth token`. |
| Keyring | `CLOUDFLARE_AUTH_USE_KEYRING` (`"true"`/`"false"` only, anything else throws) overrides the global preference `<cfg>/preferences.json: keyring_enabled`. When on, a plaintext `<name>.toml` is migrated to `<name>.enc` on first read and deleted. AES-256-GCM, envelope `{v:1,alg,iv,tag,ciphertext}`; key = `{v:1,key:<base64 32B>}` stored under service `wrangler`, account `<name>` (macOS `/usr/bin/security`, Linux `secret-tool`, Windows `@napi-rs/keyring`). |
| Danger | `wrangler auth keyring disable` deletes **every** `.enc` profile and its key (`scrubAllEncryptedProfiles`). `wrangler auth delete`/`logout` delete the key. |
| Account cache | native profiles use `wrangler-account-<profile>.json`; we still set a per-profile `WRANGLER_CACHE_DIR`. |

cf (`npm i -g cf`, Cloudflare's new CLI, beta, Node >= 22) uses the same auth library with its own
OAuth client, config dir `$XDG_CONFIG_HOME/cloudflare` (macOS `~/Library/Preferences/cloudflare`,
Linux `~/.config/cloudflare`), files `config/<name>.json|.enc`, keyring service `cloudflare`, global
`--profile`, and reads `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID`. `cf` is also Cloud Foundry's
binary name.

## Design

### Two backends, one CLI surface

`meta.json` gains `backend: "native"` and `nativeName`. Anything without it is the shadow backend,
exactly as in 1.8.0. Profile type detection: `config.toml` -> oauth (shadow), `token.json` -> token,
`meta.backend === "native"` -> oauth (native).

| Situation | Shadow backend (default, any wrangler) | Native backend (migrated profiles) |
| --- | --- | --- |
| `wrangler-accounts -p X <wrangler args>` | shadow HOME, `default.toml` symlink | real HOME, `wrangler <args> --profile <nativeName>` (inserted before `--`) |
| `-p X whoami` / `list --deep` / identity after login | shadow HOME | *bound shadow*: shadow HOME whose `.wrangler/config/<n>.toml|.enc` symlink to the native files and whose `directory-bindings.json` binds `/` and every top-level dir to `<n>` |
| `exec X [-- cmd]` | shadow HOME | bound shadow (bare `wrangler`, `npx wrangler`, `npm run deploy` all resolve to `<n>`) |
| `-p X login` / `logout` (passthrough) | as before | refused with guidance (they would act on wrangler's default profile) |
| `CLOUDFLARE_AUTH_USE_KEYRING` | forced `"false"` (original value kept in `WA_ORIG_AUTH_USE_KEYRING` for the cf wrapper) | `"true"` when the profile is encrypted; untouched otherwise. Bound shadow: `"true"` if encrypted, `"false"` if plaintext so nothing is written into the throw-away dir |

Both backends keep: inherited `CLOUDFLARE_*` stripped, the profile's own `CLOUDFLARE_ACCOUNT_ID`
re-exported, `WA_PASSTHROUGH=1`, per-profile `WRANGLER_CACHE_DIR`, `WRANGLER_PROFILE` export.

Native support is probed with `wrangler auth --help` (looks for `auth create`), using the real
wrangler found on PATH past our own shim and `WA_PASSTHROUGH=1`. Result cached in
`<profilesDir>/.native-probe.json` keyed by realpath + mtime + size. `WRANGLER_ACCOUNTS_NATIVE=0`
forces "unsupported". A native profile with a wrangler that lost support fails fast with an
upgrade / `unmigrate` hint.

### `migrate <name> | --all [--as <native>] [--dry-run] [--force] [--no-verify]`

1. Only shadow OAuth profiles; token and `__backup-*` are skipped with a reason.
2. Native name = `--as`, else the name itself if valid, else `.`->`-` (and `-wa` suffix for reserved
   names) when that is free. `--all` never crashes on a bad name; it reports and continues.
3. Refuse if `<n>.toml` or `<n>.enc` exists unless `--force`; with `--force` the existing files are
   moved into the profile dir as `native-overwritten-<ts>.*` first.
4. Copy `config.toml` -> `<n>.toml` (0600, write+rename), check the hash, then verify with
   `wrangler --profile <n> auth token --json` (stdout captured, the token is never printed; it also
   proves wrangler can refresh). On failure, remove what we wrote and leave the profile untouched.
5. Write `backend/nativeName/migratedAt` into meta, then delete the old `config.toml` (it is stale
   after the first refresh anyway).

`unmigrate <name> | --all [--keep-native]`: read the native creds (decrypting `.enc` in-process),
write `config.toml`, verify, drop the native meta, then delete `<n>.toml|.enc` and the keychain key
unless `--keep-native`. Directory bindings that still point at the profile are listed with the
`wrangler auth deactivate <dir>` command to remove them.

### `protect` / `unprotect` for OAuth profiles (issue #3)

`protect <name>` on an OAuth profile: requires native support and macOS Keychain or Linux
`secret-tool`; migrates first if needed; runs `wrangler --profile <n> auth token --json` with
`CLOUDFLARE_AUTH_USE_KEYRING=true`, which makes wrangler itself encrypt the file. Verified when
`<n>.enc` exists, `<n>.toml` is gone, and either wrangler returned an OAuth token or our own
decryption of `.enc` yields the credentials. On failure the plaintext is restored (and a key we
created is deleted). meta records `credentialStore`.

The global keyring preference is **not** changed. wrangler-accounts always passes
`CLOUDFLARE_AUTH_USE_KEYRING=true` for encrypted profiles. Bare `wrangler --profile <n>` needs
`wrangler auth keyring enable` (or the env var); `protect` says so, and warns that
`wrangler auth keyring disable` deletes every encrypted profile.

`unprotect <name>`: decrypt in-process (key from `security find-generic-password -s wrangler -a <n> -w`
or `secret-tool lookup service wrangler account <n>`), write `<n>.toml` 0600, verify, delete `.enc`
and the key. Never calls `wrangler auth keyring disable`.

`protect --all` / `unprotect --all` now cover token and OAuth profiles. Without native support OAuth
profiles are `skipped` with a zh+en reason (exit code unchanged from 1.8.0).

### Other commands for native profiles

- `list` / `status`: new JSON fields `backend`, `nativeName`; encrypted profiles show
  `status: "encrypted"`, `credentialStore: "keychain"|"secret-service"`, expiry `—`. Plaintext native
  profiles read expiry from `<n>.toml`.
- `whoami` (static) unchanged plus `backend`.
- `save --force` / `sync` / `sync-default` into a native profile write `<n>.toml`; into an encrypted
  one they refuse with `unprotect` / `login --force` guidance.
- `login <name>` on a native profile runs `wrangler auth create <n>` (keyring env on if encrypted),
  then reads the identity through the bound shadow.
- `remove <name>`: removes the wrangler-accounts entry; the native profile is kept (it is a wrangler
  credential the user may use directly) and the output says so, with `wrangler auth delete <n>`.
  `--delete-native` removes it too (files + key).
- `default`, `note`, `gc`, completions, token profiles: unchanged.

### cf

- `wrangler-accounts -p X cf ...` and `exec X -- cf ...` run Cloudflare's cf:
  token profiles get `CLOUDFLARE_API_TOKEN/ACCOUNT_ID`; OAuth profiles get `--profile <n>` when cf has
  that profile (`<cfcfg>/config/<n>.json|.enc`), otherwise we print `cf auth create <n>` and exit 2.
  wrangler and cf use different OAuth clients, so credentials are never copied between them.
- Inside `exec X` (OAuth), a `cf` wrapper in a per-exec bin dir adds `--profile <n>`, or refuses
  with the same guidance when cf has no such profile.
- Detection: resolve the binary, realpath, walk up to `package.json` with `name: "cf"` and a
  `cloudflare/cf` repository. Cloud Foundry's `cf` never matches, so it is never blocked.
- The guard hook and the PATH shim cover bare `cf` only when that check passes. Never requires cf or
  Node 22 unless the user runs cf.

### Shim / guard relaxations

Explicit `--profile <x>` (and `cf auth ...` / `wrangler auth ...` in the shim) pass through when no
`CLOUDFLARE_API_TOKEN` is set: the account is chosen explicitly, which is the same safety level as
`wrangler-accounts --profile`.

## Testing

- `test/contract.test.js`: 1.8.0 behaviour snapshot (subset match).
- Fake wrangler (`test/fixtures/native-bin/wrangler`, Node) implementing `auth --help`,
  `--profile X auth token --json`, keyring migration through the test file key store, bindings.
- Real wrangler 4.149.0 end-to-end in a temp HOME with fake credentials (no network), plus one
  macOS login-keychain run with a throw-away `wa-selftest-<rand>` profile that is deleted afterwards.
- Linux `secret-tool` path: same code, untested on a real Secret Service in this release.
