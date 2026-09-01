#!/usr/bin/env bash
# Vendors an OpenAPI spec straight out of a running, pinned e2e container
# (docs/API-SPEC.md) — the only capture source that is byte-for-byte in sync
# with the version this repo claims alignment with. try.vikunja.io always
# runs `unstable`, which is the drift class the 2.3.0-era vendored spec had.
#
#   scripts/fetch-api-spec.sh v1     # -> docs/vikunja-openapi.json
#   scripts/fetch-api-spec.sh v2     # -> docs/vikunja-openapi-v2.json
#
# WHICH STACK IT READS is resolved through scripts/lib/e2e-target.ts, exactly
# like every other harness, honouring VIKUNJA_E2E_TARGET:
#
#   VIKUNJA_E2E_TARGET=2.6.0-postgres npm run fetch:api-spec:container
#
# The port used to be hard-coded as 8240 here (issue #254, item C1). That is
# the aligned target's port *today*, so re-vendoring against a newer stack
# silently re-captured the old version's spec and looked green — the exact
# failure that had to be fixed before the 2.6.0 re-vendor (item A8).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

api="${1:-v1}"
case "$api" in
  v1) spec_path='/api/v1/docs.json'; out='docs/vikunja-openapi.json' ;;
  v2) spec_path='/api/v2/openapi.json'; out='docs/vikunja-openapi-v2.json' ;;
  *) echo "usage: fetch-api-spec.sh {v1|v2}" >&2; exit 1 ;;
esac

eval "$(cd "$REPO_ROOT" && npx tsx scripts/lib/e2e-target-cli.ts --shell "${VIKUNJA_E2E_TARGET:-}")"

url="http://localhost:${E2E_PORT}${spec_path}"

# Refuse to vendor from a stack that is not the version the caller asked for
# (or is not running at all) rather than writing a misleading file.
running="$(curl -sS --max-time 5 "http://localhost:${E2E_PORT}/api/v1/info" 2>/dev/null | jq -r '.version // empty' || true)"
if [ -z "$running" ]; then
  echo "fetch-api-spec: no Vikunja answering on port $E2E_PORT (target $E2E_TARGET_ID)." >&2
  echo "  Bring it up first: VIKUNJA_E2E_TARGET=$E2E_TARGET_ID npm run e2e:up" >&2
  exit 1
fi
if [ "${running#v}" != "$E2E_VERSION" ]; then
  echo "fetch-api-spec: port $E2E_PORT reports $running, not the target's $E2E_VERSION — refusing." >&2
  exit 1
fi

echo "fetch-api-spec: capturing $api spec from $E2E_TARGET_ID ($running) at $url" >&2
curl -sS "$url" -o "$REPO_ROOT/$out"
jq -e . "$REPO_ROOT/$out" > /dev/null
echo "fetch-api-spec: wrote $out" >&2
