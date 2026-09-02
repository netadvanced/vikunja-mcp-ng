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
#
# Two Postgres arrangements coexist (issue #254): the legacy lanes (2.3.0,
# 2.4.0) each own a dedicated Postgres container, while every newer postgres
# target keeps a database of its own inside ONE shared server
# (docker-compose.shared-db-server.yml). `reset` therefore drops a shared
# lane's database explicitly — `down -v` only reaches per-project volumes,
# and would leave a "reset" shared lane fully intact.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
COMPOSE_FILE="$SCRIPT_DIR/docker-compose.yml"
SHARED_OVERLAY="$SCRIPT_DIR/docker-compose.shared-db.yml"
SHARED_DB_FILE="$SCRIPT_DIR/docker-compose.shared-db-server.yml"

# Every profile, so `down`/`reset` catch whichever variant a target runs.
ALL_PROFILES=(--profile postgres --profile sqlite --profile postgres-shared)

cmd="${1:-status}"
shift || true

targets=("$@")
if [ ${#targets[@]} -eq 0 ]; then
  # shellcheck disable=SC2207
  targets=($(cd "$REPO_ROOT" && npx tsx scripts/lib/e2e-target-cli.ts --list))
fi

resolve() {
  eval "$(cd "$REPO_ROOT" && npx tsx scripts/lib/e2e-target-cli.ts --shell "$1")"
  export E2E_PROJECT E2E_PORT E2E_DB_PORT E2E_DB_NAME
  export VIKUNJA_VERSION="$E2E_VERSION"
}

# `docker compose` invocation for the resolved target: the shared-Postgres
# lanes need their overlay passed, or their service block doesn't exist and
# `down` silently stops nothing.
target_compose() {
  local files=(-f "$COMPOSE_FILE")
  if [ "$E2E_DB_MODE" = "shared" ]; then
    files+=(-f "$SHARED_OVERLAY")
  fi
  docker compose "${files[@]}" "${ALL_PROFILES[@]}" "$@"
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
      target_compose down || true
    done
    # The shared Postgres server is deliberately left running: it belongs to
    # no single target, and stopping it would take every other shared lane
    # down with it. Remove it explicitly when you really mean to:
    #   docker compose -f docker/e2e/docker-compose.shared-db-server.yml down -v
    ;;
  reset)
    for t in "${targets[@]}"; do
      resolve "$t"
      echo "==> RESET $E2E_TARGET_ID (destroying volumes — this rotates its API token)"
      target_compose down -v || true
      if [ "$E2E_DB_MODE" = "shared" ]; then
        # A shared lane's data lives in a database, not a volume, so `down -v`
        # alone would leave it fully intact and the reset would be a lie.
        echo "    dropping shared database $E2E_DB_NAME"
        docker compose -f "$SHARED_DB_FILE" exec -T shared-db \
          psql -U vikunja -d postgres -c "DROP DATABASE IF EXISTS \"$E2E_DB_NAME\"" || true
      fi
      rm -f "$REPO_ROOT/$E2E_ENV_FILE"
    done
    ;;
  status)
    printf '%-18s %-6s %-8s %-10s %-10s %s\n' TARGET PORT STATE VERSION DB URL
    for t in "${targets[@]}"; do
      resolve "$t"
      state="down"
      version="-"
      if info="$(curl -sS --max-time 3 "$E2E_API_URL/info" 2>/dev/null)"; then
        state="up"
        version="$(echo "$info" | jq -r '.version // "-"')"
      fi
      printf '%-18s %-6s %-8s %-10s %-10s %s\n' \
        "$E2E_TARGET_ID" "$E2E_PORT" "$state" "$version" "$E2E_DB_MODE" "$E2E_API_URL"
    done
    ;;
  *)
    echo "usage: stacks.sh {up|down|reset|status} [target...]" >&2
    exit 1
    ;;
esac
