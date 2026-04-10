#!/bin/sh
# Fake wrangler for login tests.
# - `wrangler login` writes a sentinel config.toml to $HOME/.wrangler/config/
# - `wrangler whoami` emits a parseable whoami output
# Honors $WA_FAKE_WRANGLER_WHOAMI_FAIL=1 to simulate whoami failure.
case "$1" in
  login)
    mkdir -p "$HOME/.wrangler/config"
    cat > "$HOME/.wrangler/config/default.toml" <<EOF
oauth_token = "fake-from-login"
refresh_token = "fake-refresh"
expiration_time = "2099-01-01T00:00:00.000Z"
scopes = ["account:read"]
EOF
    # Write diagnostic to stderr so it doesn't pollute --json stdout
    echo "fake login done" >&2
    exit 0
    ;;
  whoami)
    if [ "${WA_FAKE_WRANGLER_WHOAMI_FAIL:-0}" = "1" ]; then
      echo "Not logged in" >&2
      exit 1
    fi
    cat <<'EOF'
 ⛅️ wrangler 4.79.0
─────────────────────────────────────────────
Getting User settings...
👋 You are logged in with an OAuth Token, associated with the email test@example.com.
┌─────────────────────┬──────────────────────────────────┐
│ Account Name        │ Account ID                       │
├─────────────────────┼──────────────────────────────────┤
│ Test Account        │ 0123456789abcdef0123456789abcdef │
└─────────────────────┴──────────────────────────────────┘
EOF
    exit 0
    ;;
  *)
    echo "fake wrangler: unknown subcommand $1" >&2
    exit 1
    ;;
esac
