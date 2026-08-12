#!/usr/bin/env bash

set -uo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
PACKAGE="$ROOT/packages/opencode"
cd "$ROOT"

opencode() {
  OPENCODE_CONFIG_CONTENT='{"experimental":{"pi_ai":{"providers":["anthropic","openai","openrouter","opencode-go"]}},"provider":{"anthropic":{},"openai":{},"openrouter":{},"opencode-go":{}}}' \
    bun run --conditions=browser "$PACKAGE/src/index.ts" --pure "$@"
}

login() {
  case "$1" in
    anthropic)
      opencode auth login --provider anthropic --method "Anthropic (Claude Pro/Max)"
      ;;
    openai)
      opencode auth login --provider openai --method "OpenAI (ChatGPT Plus/Pro)"
      ;;
    openrouter)
      opencode auth login --provider openrouter --method "Sign in with OpenRouter"
      ;;
    opencode-go)
      opencode auth login --provider opencode-go --method "OpenCode API key"
      ;;
    *)
      printf 'Unknown provider: %s\n' "$1" >&2
      return 2
      ;;
  esac
}

run() {
  if login "$1"; then
    printf '\nCredential saved. Current logins:\n'
    opencode auth list
    return
  fi
  printf '\nLogin did not complete for %s.\n' "$1" >&2
  return 1
}

if (($# > 0)); then
  status=0
  for provider in "$@"; do
    run "$provider" || status=$?
  done
  exit "$status"
fi

while true; do
  printf '\nPi auth login\n'
  printf '  1. Anthropic (Claude Pro/Max)\n'
  printf '  2. OpenAI (ChatGPT Plus/Pro)\n'
  printf '  3. OpenRouter OAuth\n'
  printf '  4. OpenCode Go API key\n'
  printf '  5. Show current logins\n'
  printf '  6. Exit\n'
  if ! read -r -p 'Choose: ' choice; then
    printf '\n'
    exit 0
  fi

  case "$choice" in
    1) run anthropic ;;
    2) run openai ;;
    3) run openrouter ;;
    4) run opencode-go ;;
    5) opencode auth list ;;
    6) exit 0 ;;
    *) printf 'Choose 1-6.\n' ;;
  esac
done
