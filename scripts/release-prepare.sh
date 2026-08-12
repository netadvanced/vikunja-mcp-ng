#!/usr/bin/env bash
#
# release-prepare.sh — start a release: bump the version, draft the changelog, open a branch.
#
# Usage:
#   scripts/release-prepare.sh patch|minor|preminor|prerelease [--preid=<id>]
#
# The `pre*` scopes cut a prerelease (`--preid` defaults to `beta`):
#   preminor   0.6.2        -> 0.7.0-beta.0    start a beta line for the next minor
#   prerelease 0.7.0-beta.0 -> 0.7.0-beta.1    advance an existing beta line
#   minor      0.7.0-beta.3 -> 0.7.0           promote the beta line to stable
# The release workflow reads the channel back off the tag, so publishing to the `beta`
# dist-tag instead of `latest` needs no further decision — see docs/RELEASING.md.
#
# What it does (see docs/RELEASING.md for the full policy):
#   1. Verifies the working tree is clean and we're on an up-to-date `main`.
#   2. Creates a fresh `release/vX.Y.Z` branch off `main`.
#   3. Runs the full gate suite (lint, typecheck, tests, coverage) — a release never starts red.
#   4. Bumps package.json / package-lock.json via `npm version <bump> --no-git-tag-version`
#      (no git tag yet — that's scripts/release-tag.sh, run after the release PR merges).
#   5. Generates a draft changelog section from conventional commits since the last tag and
#      inserts it into CHANGELOG.md under [Unreleased].
#   6. Commits everything as `release: vX.Y.Z` and prints the next steps.
#
# This script never pushes and never opens a PR — that's a manual step so a human reviews the
# generated changelog first.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# shellcheck source=./lib/changelog-draft.sh
source "$REPO_ROOT/scripts/lib/changelog-draft.sh"
# shellcheck source=./lib/sync-server-json.sh
source "$REPO_ROOT/scripts/lib/sync-server-json.sh"

# ---------------------------------------------------------------------------
# 0. Args
# ---------------------------------------------------------------------------

BUMP="${1:-}"
PREID="beta"

if [[ -n "${2:-}" ]]; then
  case "$2" in
    --preid=*)
      PREID="${2#--preid=}"
      if [[ -z "$PREID" || "$PREID" =~ [^a-zA-Z0-9-] ]]; then
        echo "ERROR: --preid must be a non-empty alphanumeric identifier (got '${2#--preid=}')." >&2
        exit 1
      fi
      ;;
    *)
      echo "ERROR: unexpected argument '$2' (expected --preid=<id>)." >&2
      exit 1
      ;;
  esac
fi

case "$BUMP" in
  patch | minor | preminor | prerelease) ;;
  *)
    echo "Usage: $0 patch|minor|preminor|prerelease [--preid=<id>]" >&2
    echo "" >&2
    echo "This project is pre-1.0 (see docs/RELEASING.md §1) — stable releases are patch or minor." >&2
    echo "A major (1.0.0) bump is a deliberate, hand-run 'npm version major' as part of a" >&2
    echo "declared-stable release, not something this script automates." >&2
    echo "" >&2
    echo "Prereleases: 'preminor' starts a beta line (0.6.2 -> 0.7.0-beta.0), 'prerelease'" >&2
    echo "advances it (-> beta.1), and a later 'minor' promotes it to stable (-> 0.7.0)." >&2
    exit 1
    ;;
esac

if [[ "$BUMP" == pre* ]]; then
  echo "==> Release scope: $BUMP (prerelease identifier: $PREID)"
else
  echo "==> Release scope: $BUMP"
fi

# ---------------------------------------------------------------------------
# 1. Preconditions: clean tree, on main, up to date with origin/main
# ---------------------------------------------------------------------------

if [[ -n "$(git status --porcelain)" ]]; then
  echo "ERROR: working tree is not clean. Commit, stash elsewhere, or discard changes first." >&2
  git status --short >&2
  exit 1
fi
echo "==> Working tree is clean"

CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [[ "$CURRENT_BRANCH" != "main" ]]; then
  echo "ERROR: must run this from 'main' (currently on '$CURRENT_BRANCH')." >&2
  echo "       git checkout main && git pull" >&2
  exit 1
fi

echo "==> Fetching origin/main"
git fetch origin main --quiet

LOCAL_SHA="$(git rev-parse main)"
REMOTE_SHA="$(git rev-parse origin/main)"
if [[ "$LOCAL_SHA" != "$REMOTE_SHA" ]]; then
  echo "ERROR: local main ($LOCAL_SHA) does not match origin/main ($REMOTE_SHA)." >&2
  echo "       git pull --ff-only" >&2
  exit 1
fi
echo "==> main is up to date with origin/main ($LOCAL_SHA)"

# ---------------------------------------------------------------------------
# 2. Compute the target version (before bumping, so we can name the branch)
# ---------------------------------------------------------------------------

CURRENT_VERSION="$(node -pe "require('./package.json').version")"
echo "==> Current version: $CURRENT_VERSION"

# The target version is computed by npm itself, against a throwaway copy of package.json,
# rather than by arithmetic here. Hand-rolled semver gets the prerelease transitions subtly
# wrong — `minor` on 0.7.0-beta.3 yields 0.7.0, not 0.8.0, and `patch` on a prerelease drops
# the suffix instead of incrementing — and a predictor that disagrees with npm would block a
# legitimate release at the assertion in step 5. Same engine, same answer, by construction.
VERSION_PROBE_DIR="$(mktemp -d)"
trap 'rm -rf "$VERSION_PROBE_DIR"' EXIT
cp package.json "$VERSION_PROBE_DIR/package.json"
TARGET_VERSION="$(
  cd "$VERSION_PROBE_DIR"
  npm version "$BUMP" --preid "$PREID" --no-git-tag-version >/dev/null 2>&1
  node -pe "require('./package.json').version"
)"
if [[ -z "$TARGET_VERSION" ]]; then
  echo "ERROR: could not compute the target version for bump '$BUMP'." >&2
  exit 1
fi
echo "==> Target version:  $TARGET_VERSION"

RELEASE_BRANCH="release/v${TARGET_VERSION}"
TAG_NAME="v${TARGET_VERSION}"

if git rev-parse "$TAG_NAME" >/dev/null 2>&1; then
  echo "ERROR: tag $TAG_NAME already exists. Nothing to prepare." >&2
  exit 1
fi
if git show-ref --verify --quiet "refs/heads/$RELEASE_BRANCH"; then
  echo "ERROR: branch $RELEASE_BRANCH already exists locally. Remove it or resume from it." >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# 3. Create the release branch
# ---------------------------------------------------------------------------

echo "==> Creating branch $RELEASE_BRANCH"
git checkout -b "$RELEASE_BRANCH"

# ---------------------------------------------------------------------------
# 4. Run the full gate suite — a release never starts from red
# ---------------------------------------------------------------------------

echo "==> Running gates: lint"
npm run lint

echo "==> Running gates: typecheck"
npm run typecheck

echo "==> Running gates: test"
npx jest --silent

echo "==> Running gates: test:coverage"
npm run test:coverage

echo "==> All gates passed"

# ---------------------------------------------------------------------------
# 5. Bump package.json / package-lock.json
# ---------------------------------------------------------------------------

echo "==> Bumping version ($BUMP)"
NPM_VERSION_OUTPUT="$(npm version "$BUMP" --preid "$PREID" --no-git-tag-version)"
# npm prints the new version prefixed with 'v', e.g. "v0.3.1"
BUMPED_VERSION="${NPM_VERSION_OUTPUT#v}"

if [[ "$BUMPED_VERSION" != "$TARGET_VERSION" ]]; then
  echo "ERROR: npm bumped to $BUMPED_VERSION but this script expected $TARGET_VERSION." >&2
  echo "       (package.json may have changed underneath this script — investigate before continuing.)" >&2
  exit 1
fi
echo "==> package.json now at $BUMPED_VERSION"

# ---------------------------------------------------------------------------
# 5b. Sync server.json's two version fields to match (netadvanced/vikunja-mcp-ng#186:
#     the MCP registry manifest is static, not runtime state, so nothing derives it
#     automatically — the release process is the single place that keeps it aligned).
# ---------------------------------------------------------------------------

echo "==> Syncing server.json version fields to $BUMPED_VERSION"
sync_server_json_version "$REPO_ROOT/server.json" "$BUMPED_VERSION"
if ! assert_server_json_version_matches "$REPO_ROOT/server.json" "$BUMPED_VERSION"; then
  echo "ERROR: server.json version fields do not match package.json ($BUMPED_VERSION) after sync." >&2
  exit 1
fi
echo "==> server.json now at $BUMPED_VERSION"

# ---------------------------------------------------------------------------
# 6. Generate a draft changelog section from conventional commits since the last tag
# ---------------------------------------------------------------------------

echo "==> Generating draft changelog section"

LAST_TAG="$(git describe --tags --abbrev=0 --match 'v*' "${LOCAL_SHA}" 2>/dev/null || true)"
if [[ -n "$LAST_TAG" ]]; then
  echo "==> Last tag reachable from main: $LAST_TAG"
  COMMIT_RANGE="${LAST_TAG}..${LOCAL_SHA}"
else
  echo "==> No prior v* tag reachable from main — this is the first tagged release; using full history"
  COMMIT_RANGE="${LOCAL_SHA}"
fi

DRAFT_FILE="$(mktemp)"
# Replaces the earlier trap, so it has to clean up the version probe directory too —
# a bare `rm -f "$DRAFT_FILE"` here would silently leak it.
trap 'rm -f "$DRAFT_FILE"; rm -rf "$VERSION_PROBE_DIR"' EXIT

{
  echo ""
  echo "## [${TARGET_VERSION}] - $(date -u +%Y-%m-%d)"
  echo ""
  echo "_Draft generated from conventional commits by scripts/release-prepare.sh — curate before merging._"
} >>"$DRAFT_FILE"

# Group commit subjects by conventional-commit prefix. Dependency-free: plain git log +
# shell (see scripts/lib/changelog-draft.sh, tested by scripts/lib/changelog-draft.test.sh).
declare -A CHANGELOG_BUCKETS
declare -a CHANGELOG_UNCLASSIFIED_SUBJECTS=()
for key in "${CHANGELOG_SECTION_ORDER[@]}"; do
  CHANGELOG_BUCKETS[$key]=""
done

# NOTE: `git log --pretty=format:'%s'` deliberately has no trailing newline after the
# final (oldest) commit in the range — build_changelog_buckets accounts for that (a plain
# `while read` loop would silently drop that commit; see scripts/lib/changelog-draft.sh
# for the full writeup of the bug this fixes).
build_changelog_buckets < <(git log --no-merges --pretty=format:'%s' "$COMMIT_RANGE" 2>/dev/null || true)

WROTE_ANY=false
for key in "${CHANGELOG_SECTION_ORDER[@]}"; do
  if [[ -n "${CHANGELOG_BUCKETS[$key]}" ]]; then
    {
      echo ""
      echo "### ${CHANGELOG_SECTION_TITLES[$key]}"
      echo ""
      printf '%s' "${CHANGELOG_BUCKETS[$key]}"
    } >>"$DRAFT_FILE"
    WROTE_ANY=true
  fi
done

if [[ "$WROTE_ANY" == false ]]; then
  {
    echo ""
    echo "_No conventional commits found in range \`${COMMIT_RANGE}\` — fill this in by hand._"
  } >>"$DRAFT_FILE"
fi

# Make the failure mode loud: every commit that didn't match a recognized conventional-commit
# prefix is already in the CHANGELOG's "Unclassified — review manually" section above, but
# print it to the terminal too so it can't be missed before the draft is curated.
if [[ "${#CHANGELOG_UNCLASSIFIED_SUBJECTS[@]}" -gt 0 ]]; then
  echo "" >&2
  echo "==> WARNING: ${#CHANGELOG_UNCLASSIFIED_SUBJECTS[@]} commit(s) in range could not be classified" >&2
  echo "    and were placed under 'Unclassified — review manually' in CHANGELOG.md:" >&2
  for subject in "${CHANGELOG_UNCLASSIFIED_SUBJECTS[@]}"; do
    echo "      - ${subject}" >&2
  done
  echo "    Review that section by hand before merging the release PR." >&2
fi

# Insert the draft section right after the "## [Unreleased]" heading's own body.
# We locate the first "## [" heading that isn't Unreleased and insert before it; if none,
# append at end of file.
CHANGELOG="CHANGELOG.md"
if [[ ! -f "$CHANGELOG" ]]; then
  echo "ERROR: $CHANGELOG not found at repo root." >&2
  exit 1
fi

INSERT_LINE="$(grep -n '^## \[' "$CHANGELOG" | awk -F: '$0 !~ /Unreleased/ {print $1; exit}')"

if [[ -z "$INSERT_LINE" ]]; then
  cat "$DRAFT_FILE" >>"$CHANGELOG"
else
  awk -v insert_line="$INSERT_LINE" -v draft_file="$DRAFT_FILE" '
    NR == insert_line { while ((getline line < draft_file) > 0) print line; print "" }
    { print }
  ' "$CHANGELOG" >"${CHANGELOG}.tmp"
  mv "${CHANGELOG}.tmp" "$CHANGELOG"
fi

echo "==> CHANGELOG.md updated with draft section for ${TARGET_VERSION}"

# ---------------------------------------------------------------------------
# 7. Commit
# ---------------------------------------------------------------------------

git add package.json package-lock.json server.json CHANGELOG.md
git commit -m "release: v${TARGET_VERSION}"

echo ""
echo "=================================================================="
echo "  Prepared release v${TARGET_VERSION} on branch ${RELEASE_BRANCH}"
echo "=================================================================="
echo ""
echo "Next steps:"
echo "  1. Review and curate the generated CHANGELOG.md section (it's a draft)."
echo "  2. git push -u origin ${RELEASE_BRANCH}"
echo "  3. gh pr create --repo netadvanced/vikunja-mcp-ng --base main \\"
echo "       --title \"release: v${TARGET_VERSION}\" --body \"See CHANGELOG.md\""
echo "  4. After merge: git checkout main && git pull && npm run release:tag"
echo ""
