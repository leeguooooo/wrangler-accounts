#!/bin/sh
# wrangler-accounts cf shim
# -------------------------
# Same idea as the wrangler shim, for Cloudflare's `cf` CLI: a bare `cf ...`
# would use cf's own default login, whatever account that is. This shim sends
# callers to `wrangler-accounts --profile <name> cf ...` instead.
#
# `cf` is also Cloud Foundry's CLI. This shim only ever blocks when the real
# `cf` it found is Cloudflare's (checked by `wrangler-accounts
# __is-cloudflare-cf`); anything else is passed straight through.
#
# Managed by `wrangler-accounts shim install` / `shim uninstall`.

set -u

if [ "${_WA_CF_SHIM_ACTIVE:-}" = "1" ]; then
  echo "wrangler-accounts cf shim: cannot locate the real cf (only the shim is on PATH)." >&2
  exit 127
fi

shim_dir="__WA_SHIM_DIR__"
case "$shim_dir" in
  __WA_SHIM_DIR__ | "")
    case "$0" in
      */*) shim_dir=$(CDPATH= cd -- "${0%/*}" 2>/dev/null && pwd) || shim_dir="" ;;
      *) shim_dir="" ;;
    esac
    ;;
esac

real_cf=""
_old_ifs=$IFS
IFS=:
for _d in $PATH; do
  [ -n "$_d" ] || continue
  _cand="$_d/cf"
  [ -x "$_cand" ] || continue
  if [ -n "$shim_dir" ]; then
    _cd=$(CDPATH= cd -- "$_d" 2>/dev/null && pwd) || _cd="$_d"
    [ "$_cd" = "$shim_dir" ] && continue
  fi
  real_cf="$_cand"
  break
done
IFS=$_old_ifs

passthrough() {
  if [ -n "$real_cf" ]; then
    _WA_CF_SHIM_ACTIVE=1 exec "$real_cf" "$@"
  fi
  echo "cf: command not found (wrangler-accounts cf shim found no real cf on PATH)." >&2
  exit 127
}

# 1. Escape hatches (also set inside wrangler-accounts' own subprocesses).
if [ "${WA_PASSTHROUGH:-}" = "1" ] || [ "${NOWRANGLER_ACCOUNTS_GUARD:-}" = "1" ]; then
  passthrough "$@"
fi

# 2. Account-agnostic or explicitly-scoped invocations.
case "${1:-}" in
  "" | -v | --version | -h | --help | help | auth) passthrough "$@" ;;
esac
if [ -z "${CLOUDFLARE_API_TOKEN:-}" ] && [ -z "${CLOUDFLARE_ACCOUNT_ID:-}" ] && [ -z "${CLOUDFLARE_API_KEY:-}" ]; then
  for _a in "$@"; do
    case "$_a" in --profile|--profile=*) passthrough "$@" ;; esac
  done
fi

# 3. No wrangler-accounts, not Cloudflare's cf, or no profiles: stay out of the way.
if [ -z "$real_cf" ] || ! command -v wrangler-accounts >/dev/null 2>&1; then
  passthrough "$@"
fi
if ! wrangler-accounts __is-cloudflare-cf "$real_cf" >/dev/null 2>&1; then
  passthrough "$@"
fi
profiles=$(wrangler-accounts list --plain 2>/dev/null || true)
if [ -z "$profiles" ]; then
  passthrough "$@"
fi
default_profile=$(wrangler-accounts default 2>/dev/null || true)

{
  echo "wrangler-accounts: direct \`cf\` is blocked."
  echo
  echo "A bare \`cf\` uses cf's own default login, which may be a different Cloudflare"
  echo "account than the one this project uses. Retry with one of:"
  echo
  if [ -n "$default_profile" ]; then
    echo "  wrangler-accounts cf $*"
    echo "      # runs under default profile '$default_profile'"
  fi
  echo "  wrangler-accounts --profile <name> cf $*"
  echo "  cf --profile <cf-profile> $*"
  echo
  echo "Profiles on this machine:"
  printf '%s\n' "$profiles" | while IFS= read -r _p; do
    [ -n "$_p" ] && echo "  - $_p"
  done
  echo "Default profile: ${default_profile:-(none)}"
  echo
  echo "To force raw cf this once: WA_PASSTHROUGH=1 cf $*"
} >&2
exit 1
