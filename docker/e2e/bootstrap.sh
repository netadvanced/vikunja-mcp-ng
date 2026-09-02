#!/usr/bin/env bash
# Brings up ONE persistent e2e stack ("target") and makes sure stable
# credentials for it exist on disk.
#
# A target is `<version>-<db>` (e.g. `2.4.0-postgres`). Each target is its own
# Compose project with its own volumes and its own ports, so several Vikunja
# versions run side by side — see scripts/lib/e2e-target.ts, which owns the
# port formula and is evaluated below rather than duplicated here.
#
# Postgres targets come in two arrangements (issue #254). The legacy lanes
# (2.3.0, 2.4.0 — see `DEDICATED_DB_VERSIONS` in scripts/lib/e2e-target.ts)
# each run a dedicated Postgres container inside their own project. Every
# newer postgres target instead gets a database of its own inside ONE shared
# Postgres server (docker-compose.shared-db-server.yml), brought up on demand
# by `ensure_shared_db` below. Either way the target's ports, project and
# credentials stay exactly as isolated as before.
#
#   npm run e2e:up                          # the default target (2.4.0-postgres, API on 8240)
#   VIKUNJA_E2E_TARGET=2.4.0-sqlite npm run e2e:up      # the sqlite backend, API on 9240
#   npm run e2e:up:all                      # every standard target at once
#
# STABLE TOKENS (issue #205). This script is idempotent about credentials: if
# the target's env file already holds a token that still authenticates, it is
# reused and nothing is minted. A token therefore survives `npm run e2e:down`
# (which stops containers but KEEPS volumes) and only ever changes when
# someone deliberately runs `npm run e2e:reset`. The old behaviour — a
# `down -v` in `e2e:down` — silently rotated the credential out from under
# any process holding it, which broke a concurrent worktree on 2026-07-28.
#
# TWO USERS, DELIBERATELY:
#   e2e-test     the shared identity every harness authenticates as. Its
#                token is THE test token. Nothing may mutate its
#                user-level state.
#   e2e-mutable  for tests that change identity-scoped state — API tokens,
#                user settings, avatar provider. Breaking this user cannot
#                break anyone else's run.
#
# See docs/LOCAL-TESTING.md for the full workflow.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
COMPOSE_FILE="$SCRIPT_DIR/docker-compose.yml"

# Resolve the target through the single source of truth. Exported because
# `docker compose` interpolates E2E_PROJECT/E2E_PORT/E2E_DB_PORT out of this
# process's environment (see docker-compose.yml).
eval "$(cd "$REPO_ROOT" && npx tsx scripts/lib/e2e-target-cli.ts --shell "${VIKUNJA_E2E_TARGET:-}")"
export E2E_PROJECT E2E_PORT E2E_DB_PORT E2E_DB_NAME
# Kept exported for the vikunja image tag interpolation in docker-compose.yml.
export VIKUNJA_VERSION="$E2E_VERSION"

ENV_FILE="$REPO_ROOT/$E2E_ENV_FILE"
VIKUNJA_URL="$E2E_API_URL"

TEST_USERNAME="e2e-test"
TEST_EMAIL="e2e-test@vikunja-mcp.local"
TEST_PASSWORD="VikunjaMcpE2E-2026!"
# Same password by design: these are throwaway identities on a disposable
# localhost-only stack, and one constant keeps every harness's login trivial.
MUTABLE_USERNAME="e2e-mutable"
MUTABLE_EMAIL="e2e-mutable@vikunja-mcp.local"
TOKEN_TITLE="vikunja-mcp-e2e"

log() { echo "[bootstrap] $*" >&2; }

# Opt-in OpenID overlay (issue #220 — SSO enrollment lane). When
# VIKUNJA_E2E_OIDC=1, docker-compose.oidc.yml configures Vikunja with one
# OpenID provider pointing at the harness's mock IdP on the host, published
# on E2E_OIDC_IDP_PORT (derived: E2E_PORT + 4000 -> 2.4.0-postgres: 12240).
# Without the flag the overlay is never passed to compose, so existing lanes
# are byte-for-byte unaffected; a later flag-less bootstrap run recreates the
# container without the provider again (compose config-hash change).
export E2E_OIDC_IDP_PORT="${E2E_OIDC_IDP_PORT:-$((E2E_PORT + 4000))}"

SHARED_DB_FILE="$SCRIPT_DIR/docker-compose.shared-db-server.yml"

compose() {
  local files=(-f "$COMPOSE_FILE")
  # Shared-Postgres lanes (issue #254): a third service block living in an
  # overlay, so the dedicated-Postgres and sqlite lanes never even parse it.
  if [ "$E2E_DB_MODE" = "shared" ]; then
    files+=(-f "$SCRIPT_DIR/docker-compose.shared-db.yml")
  fi
  if [ "${VIKUNJA_E2E_OIDC:-0}" = "1" ]; then
    files+=(-f "$SCRIPT_DIR/docker-compose.oidc.yml")
  fi
  docker compose "${files[@]}" --profile "$E2E_PROFILE" "$@"
}

# Shared-Postgres lanes only: bring up the one long-lived Postgres server
# (its own Compose project, which also owns the external network the target
# stack joins) and make sure this target's own database exists inside it.
# Both steps are idempotent, so this is a cheap no-op on every later run.
ensure_shared_db() {
  [ "$E2E_DB_MODE" = "shared" ] || return 0
  log "Shared Postgres: ensuring the server project is up..."
  docker compose -f "$SHARED_DB_FILE" up -d --wait --wait-timeout 120
  if docker compose -f "$SHARED_DB_FILE" exec -T shared-db \
      psql -U vikunja -d postgres -tAc \
      "SELECT 1 FROM pg_database WHERE datname = '$E2E_DB_NAME'" | grep -q 1; then
    log "Shared Postgres: database '$E2E_DB_NAME' already exists."
  else
    log "Shared Postgres: creating database '$E2E_DB_NAME'..."
    docker compose -f "$SHARED_DB_FILE" exec -T shared-db \
      psql -U vikunja -d postgres -c "CREATE DATABASE \"$E2E_DB_NAME\" OWNER vikunja"
  fi
}

wait_for_health() {
  # OIDC overlay runs get a longer budget: Vikunja's startup provider
  # discovery retries can stall for minutes when the container->host hop to
  # the mock IdP hangs rather than fails fast (observed on Docker Desktop),
  # and the container is healthy shortly after.
  local wait_timeout=180
  if [ "${VIKUNJA_E2E_OIDC:-0}" = "1" ]; then
    wait_timeout=420
  fi
  log "Waiting for $E2E_TARGET_ID (project $E2E_PROJECT, service $E2E_SERVICE) to report healthy..."
  if [ "${VIKUNJA_E2E_OIDC:-0}" = "1" ]; then
    # Force a fresh Vikunja boot even when the compose config is unchanged:
    # v2.4.0 caches an EMPTY openid provider list in its (in-memory) keyvalue
    # forever if the issuer was unreachable at first discovery
    # (GetAllProviders keyvalue.Put's the list even when every provider
    # errored), so the enrollment lane must guarantee the container starts
    # only while the mock IdP is already answering.
    compose up -d --wait --wait-timeout "$wait_timeout" --force-recreate "$E2E_SERVICE"
  else
    compose up -d --wait --wait-timeout "$wait_timeout"
  fi
  log "Stack is healthy on $VIKUNJA_URL"
}

# Returns 0 and prints the JWT on stdout if login succeeds, 1 otherwise.
try_login() {
  local username="${1:-$TEST_USERNAME}"
  local resp
  resp="$(curl -sS -w '\n%{http_code}' -X POST "$VIKUNJA_URL/login" \
    -H 'Content-Type: application/json' \
    -d "{\"username\":\"$username\",\"password\":\"$TEST_PASSWORD\"}" || true)"
  local status body
  status="${resp##*$'\n'}"
  body="${resp%$'\n'*}"
  if [ "$status" = "200" ]; then
    echo "$body" | jq -r '.token'
    return 0
  fi
  return 1
}

create_user() {
  local username="$1" email="$2"
  log "Creating user '$username' via container CLI..."
  if compose exec -T "$E2E_SERVICE" /app/vikunja/vikunja user create \
    -u "$username" -e "$email" -p "$TEST_PASSWORD"; then
    log "User '$username' created."
  else
    log "User create for '$username' exited non-zero -- assuming it already" \
        "exists from a previous bootstrap and continuing."
  fi
}

ensure_user() {
  local username="$1" email="$2"
  if try_login "$username" > /dev/null; then
    return 0
  fi
  create_user "$username" "$email"
}

# Prints the existing token if the env file holds one that still works.
reuse_existing_token() {
  [ -f "$ENV_FILE" ] || return 1
  local existing
  existing="$(grep -E '^VIKUNJA_API_TOKEN=' "$ENV_FILE" | head -1 | cut -d= -f2-)"
  [ -n "$existing" ] || return 1
  local status
  status="$(curl -sS -o /dev/null -w '%{http_code}' "$VIKUNJA_URL/projects" \
    -H "Authorization: Bearer $existing" || true)"
  if [ "$status" = "200" ]; then
    echo "$existing"
    return 0
  fi
  log "Stored token no longer authenticates (HTTP $status) -- minting a fresh one."
  return 1
}

mint_api_token() {
  local jwt="$1"
  local expires_at
  expires_at="$(node -e 'console.log(new Date(Date.now()+10*365*24*3600*1000).toISOString())')"

  log "Fetching available permissions from GET /routes..."
  local routes
  if ! routes="$(curl -sSf "$VIKUNJA_URL/routes" -H "Authorization: Bearer $jwt")"; then
    log "GET /routes failed; cannot mint a scoped api token."
    return 1
  fi

  local permissions
  permissions="$(echo "$routes" | jq 'to_entries | map({(.key): (.value | keys)}) | add')"

  log "Creating long-lived API token '$TOKEN_TITLE' via PUT /tokens..."
  local resp status body
  resp="$(curl -sS -w '\n%{http_code}' -X PUT "$VIKUNJA_URL/tokens" \
    -H "Authorization: Bearer $jwt" \
    -H 'Content-Type: application/json' \
    -d "$(jq -n --arg title "$TOKEN_TITLE" --arg exp "$expires_at" --argjson perms "$permissions" \
      '{title: $title, permissions: $perms, expires_at: $exp}')")"
  status="${resp##*$'\n'}"
  body="${resp%$'\n'*}"

  # The OpenAPI spec documents 200 for a successful PUT /tokens, but the
  # real server responds 201 Created. Accept both.
  if [ "$status" != "200" ] && [ "$status" != "201" ]; then
    log "PUT /tokens failed (HTTP $status): $body"
    return 1
  fi

  echo "$body" | jq -r '.token'
}

main() {
  log "Target: $E2E_TARGET_ID (Vikunja $E2E_VERSION, $E2E_DB/$E2E_DB_MODE, API port $E2E_PORT)"
  ensure_shared_db
  wait_for_health

  ensure_user "$TEST_USERNAME" "$TEST_EMAIL"
  # Created up front so tests that mutate identity-scoped state always have a
  # user to burn; see the header note.
  ensure_user "$MUTABLE_USERNAME" "$MUTABLE_EMAIL"

  local token token_kind
  if token="$(reuse_existing_token)"; then
    token_kind="reused (stable)"
  else
    local jwt
    if ! jwt="$(try_login "$TEST_USERNAME")"; then
      log "ERROR: login as '$TEST_USERNAME' failed after ensuring the user exists. Aborting."
      exit 1
    fi
    if token="$(mint_api_token "$jwt")" && [ -n "$token" ] && [ "$token" != "null" ]; then
      token_kind="tk_* api token (freshly minted)"
    else
      log "Falling back to the JWT itself as VIKUNJA_API_TOKEN."
      token="$jwt"
      token_kind="JWT (fallback)"
    fi
  fi

  {
    echo "VIKUNJA_E2E_TARGET=$E2E_TARGET_ID"
    echo "VIKUNJA_URL=$VIKUNJA_URL"
    echo "VIKUNJA_API_TOKEN=$token"
    echo "VIKUNJA_E2E_USERNAME=$TEST_USERNAME"
    echo "VIKUNJA_E2E_PASSWORD=$TEST_PASSWORD"
    echo "VIKUNJA_E2E_MUTABLE_USERNAME=$MUTABLE_USERNAME"
  } > "$ENV_FILE"

  log "Wrote $E2E_ENV_FILE"
  log "Token: $token_kind"
  echo ""
  echo "export VIKUNJA_URL=$VIKUNJA_URL"
  echo "export VIKUNJA_API_TOKEN=$token"
}

main "$@"
