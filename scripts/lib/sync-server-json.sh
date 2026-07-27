#!/usr/bin/env bash
#
# sync-server-json.sh — keeps server.json's two version fields (the MCP registry
# manifest) aligned with package.json's version at release time.
#
# server.json is a static published manifest, not runtime state, so nothing derives
# it automatically the way src/index.ts derives the MCP handshake version (see
# src/utils/version.ts, issue #186) — this is the release-time equivalent. Kept in
# its own file (rather than inline in release-prepare.sh) so it can be exercised by
# scripts/lib/sync-server-json.test.sh — scripts/ sits outside Jest's coverage
# scope, so this is the harness for it. Source this file, then call
# sync_server_json_version / assert_server_json_version_matches.

set -u

# sync_server_json_version <server_json_path> <target_version>
# Rewrites both `.version` and `.packages[0].version` in the given server.json to
# <target_version> via node (no jq dependency needed). Preserves key order and
# 2-space indentation, with a trailing newline to match the file's existing style.
# Fails (node's non-zero exit) if the file is missing, isn't valid JSON, or has no
# packages[0] to version-sync.
sync_server_json_version() {
  local server_json_path="$1" target_version="$2"
  node -e '
    const fs = require("fs");
    const path = process.argv[1];
    const version = process.argv[2];
    const data = JSON.parse(fs.readFileSync(path, "utf-8"));
    if (!data.packages || !data.packages[0]) {
      throw new Error(`server.json at ${path} has no packages[0] to version-sync`);
    }
    data.version = version;
    data.packages[0].version = version;
    fs.writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
  ' "$server_json_path" "$target_version"
}

# assert_server_json_version_matches <server_json_path> <expected_version>
# Fails loudly (non-zero exit, message to stderr) if either version field in
# server.json disagrees with expected_version. This is the release-time guard so a
# hand-edited manifest — or a regression in sync_server_json_version itself — can
# never ship silently drifted from package.json.
assert_server_json_version_matches() {
  local server_json_path="$1" expected_version="$2"
  node -e '
    const fs = require("fs");
    const path = process.argv[1];
    const expected = process.argv[2];
    const data = JSON.parse(fs.readFileSync(path, "utf-8"));
    const topVersion = data.version;
    const pkgVersion = data.packages && data.packages[0] ? data.packages[0].version : undefined;
    if (topVersion !== expected || pkgVersion !== expected) {
      console.error(
        `server.json version mismatch: expected "${expected}", got .version="${topVersion}" ` +
        `.packages[0].version="${pkgVersion}"`
      );
      process.exit(1);
    }
  ' "$server_json_path" "$expected_version"
}
