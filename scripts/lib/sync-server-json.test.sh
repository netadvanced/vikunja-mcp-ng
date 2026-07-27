#!/usr/bin/env bash
#
# sync-server-json.test.sh — shell-level self-check for scripts/lib/sync-server-json.sh.
#
# scripts/ sits outside Jest's coverage scope, so this is the harness for the
# server.json version-sync logic used by scripts/release-prepare.sh. Run directly:
#
#   bash scripts/lib/sync-server-json.test.sh
#
# or via `npm run test:release-prepare`. Exits non-zero (and prints every failing
# assertion) if anything regresses.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=./sync-server-json.sh
source "$REPO_ROOT/scripts/lib/sync-server-json.sh"

PASS=0
FAIL=0

assert_eq() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    echo "FAIL: $label"
    echo "  expected: $(printf '%q' "$expected")"
    echo "  actual:   $(printf '%q' "$actual")"
  fi
}

assert_success() {
  local label="$1"
  shift
  if "$@" >/tmp/sync-server-json-test-out.$$ 2>&1; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    echo "FAIL: $label (expected success, command failed)"
    cat "/tmp/sync-server-json-test-out.$$"
  fi
  rm -f "/tmp/sync-server-json-test-out.$$"
}

assert_failure() {
  local label="$1"
  shift
  if "$@" >/tmp/sync-server-json-test-out.$$ 2>&1; then
    FAIL=$((FAIL + 1))
    echo "FAIL: $label (expected failure, command succeeded)"
  else
    PASS=$((PASS + 1))
  fi
  rm -f "/tmp/sync-server-json-test-out.$$"
}

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

echo "== sync_server_json_version =="

FIXTURE="$WORKDIR/server.json"
cat >"$FIXTURE" <<'EOF'
{
  "version": "0.3.0",
  "packages": [
    {
      "identifier": "vikunja-mcp-ng",
      "version": "0.3.0"
    }
  ]
}
EOF

sync_server_json_version "$FIXTURE" "0.6.2"
NEW_TOP_VERSION="$(node -pe "require('$FIXTURE').version")"
NEW_PKG_VERSION="$(node -pe "require('$FIXTURE').packages[0].version")"
assert_eq "rewrites top-level .version" "0.6.2" "$NEW_TOP_VERSION"
assert_eq "rewrites .packages[0].version" "0.6.2" "$NEW_PKG_VERSION"

# Unrelated fields must survive the rewrite untouched.
IDENTIFIER="$(node -pe "require('$FIXTURE').packages[0].identifier")"
assert_eq "leaves unrelated fields untouched" "vikunja-mcp-ng" "$IDENTIFIER"

echo "== assert_server_json_version_matches =="

assert_success "passes when both fields match" assert_server_json_version_matches "$FIXTURE" "0.6.2"
assert_failure "fails when expected version disagrees" assert_server_json_version_matches "$FIXTURE" "9.9.9"

# Simulate a hand-edited manifest where only one field drifted.
DRIFTED="$WORKDIR/server-drifted.json"
cat >"$DRIFTED" <<'EOF'
{
  "version": "0.6.2",
  "packages": [
    {
      "identifier": "vikunja-mcp-ng",
      "version": "0.6.1"
    }
  ]
}
EOF
assert_failure "fails when only one of the two fields drifted" assert_server_json_version_matches "$DRIFTED" "0.6.2"

echo ""
echo "Passed: $PASS, Failed: $FAIL"
if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi
