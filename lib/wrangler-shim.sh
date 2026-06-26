#!/bin/sh
# wrangler-accounts shim
# ----------------------
# Intercepts a bare `wrangler ...` call so that ANY caller (an AI coding
# agent, a plain terminal, a script) is redirected to wrangler-accounts
# profile isolation instead of silently deploying to whatever Cloudflare
# account happens to be globally logged in.
#
# Managed by `wrangler-accounts shim install` / `shim uninstall`.
# Do not edit by hand — reinstall to update.
#
# Implementation notes:
#   - Uses only POSIX shell builtins (plus `wrangler-accounts`) so it works
#     even on a minimal PATH.
#   - The shim's own directory is baked in at install time (__WA_SHIM_DIR__),
#     because $0 is unreliable when the shim is invoked as bare `wrangler`.
#     This is what guarantees we locate the REAL wrangler and never exec
#     ourselves.
#
# Decision flow:
#   1. WA_PASSTHROUGH=1 / NOWRANGLER_ACCOUNTS_GUARD=1 set -> run real wrangler
#   2. account-agnostic command (--version / --help / no args) -> run real wrangler
#   3. wrangler-accounts missing OR no profiles configured -> run real wrangler
#   4. otherwise -> print guidance and exit 1

set -u

# Safety net: if a shim exec'd us and we're a shim too, selection failed.
# Bail instead of recursing forever.
if [ "${_WA_SHIM_ACTIVE:-}" = "1" ]; then
  echo "wrangler-accounts shim: cannot locate the real wrangler (only the shim is on PATH)." >&2
  exit 127
fi

# This shim's own directory, baked in at install time.
shim_dir="__WA_SHIM_DIR__"
case "$shim_dir" in
  __WA_SHIM_DIR__ | "")
    # Template was not processed; best-effort fall back to $0.
    case "$0" in
      */*) shim_dir=$(CDPATH= cd -- "${0%/*}" 2>/dev/null && pwd) || shim_dir="" ;;
      *) shim_dir="" ;;
    esac
    ;;
esac

# Find the real wrangler on PATH, skipping this shim's directory.
real_wrangler=""
_old_ifs=$IFS
IFS=:
for _d in $PATH; do
  [ -n "$_d" ] || continue
  _cand="$_d/wrangler"
  [ -x "$_cand" ] || continue
  if [ -n "$shim_dir" ]; then
    _cd=$(CDPATH= cd -- "$_d" 2>/dev/null && pwd) || _cd="$_d"
    [ "$_cd" = "$shim_dir" ] && continue
  fi
  real_wrangler="$_cand"
  break
done
IFS=$_old_ifs

passthrough() {
  if [ -n "$real_wrangler" ]; then
    _WA_SHIM_ACTIVE=1 exec "$real_wrangler" "$@"
  fi
  echo "wrangler-accounts shim: no real 'wrangler' found on PATH." >&2
  echo "Install it with: npm i -g wrangler" >&2
  exit 127
}

# 1. Explicit escape hatch (also set automatically inside wrangler-accounts'
#    own isolated subprocesses, so internal spawns never hit this guard).
if [ "${WA_PASSTHROUGH:-}" = "1" ] || [ "${NOWRANGLER_ACCOUNTS_GUARD:-}" = "1" ]; then
  passthrough "$@"
fi

# 2. Account-agnostic commands are harmless; let tooling probe them.
case "${1:-}" in
  "" | -v | --version | -h | --help | help) passthrough "$@" ;;
esac

# 3. If wrangler-accounts isn't installed or has no profiles, stay out of the way.
if ! command -v wrangler-accounts >/dev/null 2>&1; then
  passthrough "$@"
fi
profiles=$(wrangler-accounts list --plain 2>/dev/null || true)
if [ -z "$profiles" ]; then
  passthrough "$@"
fi
default_profile=$(wrangler-accounts default 2>/dev/null || true)

# 4. Block with guidance.
{
  echo "wrangler-accounts: direct \`wrangler\` is blocked."
  echo
  echo "Direct \`wrangler\` bypasses wrangler-accounts profile isolation, which risks"
  echo "deploying to the wrong Cloudflare account. Retry with one of:"
  echo
  if [ -n "$default_profile" ]; then
    echo "  wrangler-accounts $*"
    echo "      # runs under default profile '$default_profile'"
  fi
  echo "  wrangler-accounts --profile <name> $*"
  echo "  wrangler-accounts exec <name> -- wrangler $*"
  echo
  echo "Profiles on this machine:"
  printf '%s\n' "$profiles" | while IFS= read -r _p; do
    [ -n "$_p" ] && echo "  - $_p"
  done
  echo "Default profile: ${default_profile:-(none)}"
  echo
  echo "To force raw wrangler this once: WA_PASSTHROUGH=1 wrangler $*"
} >&2
exit 1
