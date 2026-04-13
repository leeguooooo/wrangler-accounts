#!/usr/bin/env bash
set -euo pipefail

INPUT_JSON="$(cat)"

parse_with_jq() {
  TOOL_NAME="$(printf '%s' "$INPUT_JSON" | jq -r '.tool_name // empty' 2>/dev/null || true)"
  TOOL_COMMAND="$(printf '%s' "$INPUT_JSON" | jq -r '.tool_input.command // empty' 2>/dev/null || true)"
}

parse_with_python() {
  local parsed
  parsed="$(
    printf '%s' "$INPUT_JSON" | python3 -c '
import json
import sys

try:
    payload = json.load(sys.stdin)
except Exception:
    print("")
    print("")
    raise SystemExit(0)

print(payload.get("tool_name", ""))
print(payload.get("tool_input", {}).get("command", ""))
' 2>/dev/null || true
  )"
  TOOL_NAME="$(printf '%s\n' "$parsed" | sed -n '1p')"
  TOOL_COMMAND="$(printf '%s\n' "$parsed" | sed -n '2,$p')"
}

TOOL_NAME=""
TOOL_COMMAND=""

if command -v jq >/dev/null 2>&1; then
  parse_with_jq
elif command -v python3 >/dev/null 2>&1; then
  parse_with_python
else
  exit 0
fi

[ "${TOOL_NAME:-}" = "Bash" ] || exit 0
[ -n "${TOOL_COMMAND:-}" ] || exit 0

if [ "${NOWRANGLER_ACCOUNTS_GUARD:-}" = "1" ]; then
  exit 0
fi

case "$TOOL_COMMAND" in
  *NOWRANGLER_ACCOUNTS_GUARD=1*)
    exit 0
    ;;
esac

if [ -n "${CLOUDFLARE_API_TOKEN:-}" ] || [ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ]; then
  :
elif [ -f "wrangler.toml" ] || [ -f "wrangler.jsonc" ] || [ -f "wrangler.json" ]; then
  :
else
  exit 0
fi

if printf '%s' "$TOOL_COMMAND" | grep -Eq '(^|[[:space:];(|&])(npx|pnpm|yarn|bunx)[[:space:]]+wrangler[[:space:]]'; then
  exit 0
fi

if ! printf '%s' "$TOOL_COMMAND" | grep -Eq '(^|[[:space:];(|&])wrangler[[:space:]]'; then
  exit 0
fi

if ! command -v wrangler-accounts >/dev/null 2>&1; then
  exit 0
fi

PROFILES="$(wrangler-accounts list --plain 2>/dev/null || true)"
[ -n "$PROFILES" ] || exit 0

DEFAULT_PROFILE="$(wrangler-accounts default 2>/dev/null || true)"

{
  echo "wrangler-accounts guard: blocked a direct \`wrangler\` command."
  echo
  echo "Direct \`wrangler\` calls bypass wrangler-accounts profile isolation when local profiles are configured."
  echo "Retry with one of these forms instead:"
  echo
  echo "  wrangler-accounts --profile <name> <wrangler-args...>"
  echo "  wrangler-accounts exec <name> -- <your-original-command>"
  echo
  echo "Configured profiles:"
  printf '%s\n' "$PROFILES" | sed 's/^/  - /'
  echo "Default profile: ${DEFAULT_PROFILE:-"(none)"}"
  echo
  echo "If the user explicitly wants raw wrangler, prepend NOWRANGLER_ACCOUNTS_GUARD=1."
} >&2

exit 2
