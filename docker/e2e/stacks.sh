#!/usr/bin/env bash
# Lifecycle helper for the per-target e2e stacks (issue #205).
#
#   docker/e2e/stacks.sh up [target...]      bootstrap each target (default: all standard targets)
#   docker/e2e/stacks.sh down [target...]    STOP containers, KEEP volumes and tokens
#   docker/e2e/stacks.sh reset [target...]   destroy volumes — the only credential-rotating path
#   docker/e2e/stacks.sh status              what is running, on which port, with which version
#
# `down` deliberately does not pass `-v`. Destroying volumes recreates the
# database, the user, and therefore the API token — which is exactly how a
# concurrent worktree lost its credential on 2026-07-28. Rotation must be an
# explicit `reset`, never a side effect of stopping a stack.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
COMPOSE_FILE="$SCRIPT_DIR/docker-compose.yml"

cmd="${1:-status}"
shift || true

targets=("$@")
if [ ${#targets[@]} -eq 0 ]; then
  # shellcheck disable=SC2207
  targets=($(cd "$REPO_ROOT" && npx tsx scripts/lib/e2e-target-cli.ts --list))
fi

resolve() {
  eval "$(cd "$REPO_ROOT" && npx tsx scripts/lib/e2e-target-cli.ts --shell "$1")"
  export E2E_PROJECT E2E_PORT E2E_DB_PORT
  export VIKUNJA_VERSION="$E2E_VERSION"
}

case "$cmd" in
  up)
    for t in "${targets[@]}"; do
      echo "==> up $t"
      VIKUNJA_E2E_TARGET="$t" "$SCRIPT_DIR/bootstrap.sh" > /dev/null
      resolve "$t"
      echo "    $E2E_TARGET_ID ready on $E2E_API_URL"
    done
    ;;
  down)
    for t in "${targets[@]}"; do
      resolve "$t"
      echo "==> down $E2E_TARGET_ID (volumes kept — tokens stay valid)"
      docker compose -f "$COMPOSE_FILE" --profile postgres --profile sqlite down || true
    done
    ;;
  reset)
    for t in "${targets[@]}"; do
      resolve "$t"
      echo "==> RESET $E2E_TARGET_ID (destroying volumes — this rotates its API token)"
      docker compose -f "$COMPOSE_FILE" --profile postgres --profile sqlite down -v || true
      rm -f "$REPO_ROOT/$E2E_ENV_FILE"
    done
    ;;
  status)
    printf '%-18s %-6s %-8s %-10s %s\n' TARGET PORT STATE VERSION URL
    for t in "${targets[@]}"; do
      resolve "$t"
      state="down"
      version="-"
      if info="$(curl -sS --max-time 3 "$E2E_API_URL/info" 2>/dev/null)"; then
        state="up"
        version="$(echo "$info" | jq -r '.version // "-"')"
      fi
      printf '%-18s %-6s %-8s %-10s %s\n' "$E2E_TARGET_ID" "$E2E_PORT" "$state" "$version" "$E2E_API_URL"
    done
    ;;
  *)
    echo "usage: stacks.sh {up|down|reset|status} [target...]" >&2
    exit 1
    ;;
esac
