#!/bin/sh
# Fake wrangler used by integration tests. Dumps HOME, cwd, argv, and a
# curated set of env vars as a JSON blob to $WA_TEST_OUT (or stdout).
out="${WA_TEST_OUT:-/dev/stdout}"
{
  printf '{'
  printf '"home":"%s",' "$HOME"
  printf '"cwd":"%s",' "$(pwd)"
  printf '"argv":['
  first=1
  for a in "$@"; do
    if [ $first -eq 0 ]; then printf ','; fi
    printf '"%s"' "$a"
    first=0
  done
  printf '],'
  printf '"env":{'
  printf '"WRANGLER_PROFILE":"%s",' "$WRANGLER_PROFILE"
  printf '"WRANGLER_ACCOUNT":"%s",' "$WRANGLER_ACCOUNT"
  printf '"WRANGLER_ACCOUNT_REAL_HOME":"%s",' "$WRANGLER_ACCOUNT_REAL_HOME"
  printf '"WRANGLER_REGISTRY_PATH":"%s",' "$WRANGLER_REGISTRY_PATH"
  printf '"WRANGLER_CACHE_DIR":"%s",' "$WRANGLER_CACHE_DIR"
  printf '"WRANGLER_LOG_PATH":"%s",' "$WRANGLER_LOG_PATH"
  printf '"CLOUDFLARED_PATH":"%s",' "$CLOUDFLARED_PATH"
  printf '"WRANGLER_SEND_METRICS":"%s"' "$WRANGLER_SEND_METRICS"
  printf '}'
  printf '}'
} > "$out"
