#!/usr/bin/env bash
# Runs the same checks as CI and prints one line per step; full output only for failures
# (last 40 lines), so a green run costs a few lines of context.
#   scripts/verify.sh            lint, format, typecheck, unit tests
#   scripts/verify.sh e2e        ... plus all Playwright projects
#   scripts/verify.sh e2e frame  ... plus e2e files matching "frame", desktop project only
set -uo pipefail
cd "$(dirname "$0")/.."
log=$(mktemp)
fail=0

step() {
  local name=$1
  shift
  if "$@" >"$log" 2>&1; then
    echo "PASS $name"
  else
    echo "FAIL $name"
    grep -E "✘|Error|error|FAIL|Expected|Received|×|warn" "$log" | head -40
    fail=1
  fi
}

step lint pnpm lint
step format pnpm format:check
step typecheck pnpm typecheck
step unit pnpm exec vitest run
if [[ "${1:-}" == "e2e" ]]; then
  if [[ -n "${2:-}" ]]; then
    step "e2e:$2" pnpm exec playwright test "$2" --project=desktop-chromium
  else
    step e2e pnpm exec playwright test
  fi
  grep -E "[0-9]+ (passed|failed|flaky)" "$log" | tail -3
fi
rm -f "$log"
exit $fail
