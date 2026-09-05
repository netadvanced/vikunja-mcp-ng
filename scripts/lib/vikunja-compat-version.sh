#!/usr/bin/env bash
#
# vikunja-compat-version.sh — single source of truth for "which Vikunja server version is this
# build aligned to". Prints the normalized base version (e.g. "2.4.0") to stdout; nothing else
# on stdout, so this is safe to use via command substitution:
#
#   VIKUNJA_COMPAT_VERSION="$(scripts/lib/vikunja-compat-version.sh)"
#
# Source: the vendored OpenAPI spec's `info.version` field (docs/vikunja-openapi.json), which is
# the same spec generated types are built from (see docs/RELEASING.md "Vikunja compatibility").
# That field is a `git describe`-style string off the Vikunja server repo, e.g.
# "v2.4.0-1019-g95b7e673" — this script normalizes it down to the base release "2.4.0".
#
# Never hand-type this version anywhere else (Docker tags, docs, CHANGELOG) — always derive it
# from this script (or read the printed value from a run of it) so there is exactly one place
# that can drift.

set -euo pipefail

# Minimum supported Vikunja version (the v1-floor). Policy value, not derivable from the spec —
# this is the single machine-readable source of truth for it (docs/RELEASING.md §3 and the
# `-vikunja<min>` Docker compat alias both reference it).
#
# Raised 2.3.0 -> 2.4.0 on 2026-08-31 (docs/ROADMAP.md §3 decision 27): nine operations this
# project ships as implemented do not exist on a released Vikunja 2.3.0, so the old floor was
# never true.
#
# It briefly EQUALLED the aligned version; it no longer does. Aligned moved to 2.6.0 on
# 2026-09-02 (issue #254) and the floor deliberately stayed here, so a release now publishes
# TWO distinct compat aliases again (.github/workflows/release.yml compares MIN against COMPAT
# and only omits the duplicate when they match). Do not raise this to match the aligned version
# without an explicit decision: nothing in 2.6.0 makes 2.4.0 unsupportable, 2.6.0 is weeks old,
# and the floor is a support promise rather than a convenience.
MIN_SUPPORTED_VIKUNJA="2.4.0"

# `--min-supported` prints the floor and exits (no spec/jq needed) — used by the release workflow
# to emit the floor compat tag alongside the aligned one.
if [[ "${1:-}" == "--min-supported" ]]; then
  echo "$MIN_SUPPORTED_VIKUNJA"
  exit 0
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SPEC_FILE="${REPO_ROOT}/docs/vikunja-openapi.json"

if [[ ! -f "$SPEC_FILE" ]]; then
  echo "ERROR: vendored OpenAPI spec not found at $SPEC_FILE" >&2
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "ERROR: jq is required to read $SPEC_FILE (already a project dependency via npm run fetch:api-spec)" >&2
  exit 1
fi

RAW_VERSION="$(jq -r '.info.version' "$SPEC_FILE")"
if [[ -z "$RAW_VERSION" || "$RAW_VERSION" == "null" ]]; then
  echo "ERROR: could not read .info.version from $SPEC_FILE" >&2
  exit 1
fi

# Normalize "v2.4.0-1019-g95b7e673" (or plain "2.4.0") down to "2.4.0":
# strip a leading 'v', then strip everything from the first '-' onward.
BASE_VERSION="${RAW_VERSION#v}"
BASE_VERSION="${BASE_VERSION%%-*}"

if [[ ! "$BASE_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "ERROR: could not parse a X.Y.Z release out of spec info.version '$RAW_VERSION' (got '$BASE_VERSION')" >&2
  exit 1
fi

# Cross-check against the e2e aligned pin, if present. This is a loud WARNING, not a
# failure: the vendored spec is the single source of truth for the compat tag (see header comment
# above); the e2e pin is a separately-maintained decision that should normally agree with it but
# isn't required to gate a release publish.
#
# WHICH PIN THIS COMPARES AGAINST. `DEFAULT_TARGET` in scripts/lib/e2e-target.ts, not the
# compose file's `${VIKUNJA_VERSION:-...}` fallback. Since #254 that fallback deliberately names
# the 2.4.0 DEDICATED-Postgres target rather than the aligned one (the aligned target keeps its
# database in a shared server a bare compose invocation cannot start), so comparing against it
# would warn on every single run. The resolver constant is the actual pin.
TARGET_FILE="${REPO_ROOT}/scripts/lib/e2e-target.ts"
if [[ -f "$TARGET_FILE" ]]; then
  ALIGNED_PIN="$(grep -oE "DEFAULT_TARGET = '[0-9]+\.[0-9]+\.[0-9]+" "$TARGET_FILE" \
    | head -1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' || true)"
  if [[ -n "$ALIGNED_PIN" && "$ALIGNED_PIN" != "$BASE_VERSION" ]]; then
    echo "WARNING: vendored spec base version ($BASE_VERSION) does not match DEFAULT_TARGET" >&2
    echo "         ($ALIGNED_PIN) in $TARGET_FILE — these should usually agree. If the spec was" >&2
    echo "         just refreshed, consider bumping DEFAULT_TARGET too (and vice versa)." >&2
  fi
fi

echo "$BASE_VERSION"
