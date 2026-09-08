import * as fs from 'fs';
import * as path from 'path';

import { logger } from './logger';

// Used only if package.json can't be read/parsed — the handshake must never
// throw over a version lookup, but this makes a broken lookup obvious rather
// than silently reporting a plausible-looking real version.
const FALLBACK_VERSION = '0.0.0';

/**
 * Reads the `version` field out of the package.json one directory above
 * `baseDir`. Callers pass their own `__dirname` — for both `src/index.ts`
 * (dev/tsx) and the built `dist/index.js`, package.json sits exactly one
 * level up, so this resolves correctly for all three shipped launch paths
 * (`npx vikunja-mcp-ng`, the GHCR image, `node dist/index.js`) without
 * depending on `process.cwd()`.
 */
export function resolvePackageVersion(baseDir: string): string {
  const packageJsonPath = path.join(baseDir, '..', 'package.json');
  try {
    const raw = fs.readFileSync(packageJsonPath, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    const version = (parsed as { version?: unknown }).version;
    if (typeof version === 'string' && version.trim().length > 0) {
      return version;
    }
    logger.warn(
      `package.json at ${packageJsonPath} has no valid "version" field; falling back to ${FALLBACK_VERSION}`,
    );
  } catch (error) {
    logger.warn(
      `Failed to resolve package version from ${packageJsonPath}; falling back to ${FALLBACK_VERSION}`,
      error,
    );
  }
  return FALLBACK_VERSION;
}

/**
 * Compares two plain `X.Y.Z` version strings. Returns a negative number when
 * `a` sorts before `b`, 0 when equal, positive when after. A leading `v` is
 * accepted on either side, which is not cosmetic: `GET /info` reports
 * `v2.6.0` on every supported Vikunja release, so a comparison that does not
 * strip it reads the version as unparseable and sorts it as 0.0.0.
 *
 * Only the first three components are compared, and non-numeric or missing
 * components sort as 0. So `2.6` compares equal to `2.6.0`, and a
 * prerelease-ish `2.5.0-rc1` compares equal to `2.5.0` rather than throwing.
 * That last case is deliberate: this is a routing gate, not a package
 * resolver, and a server reporting something unexpected must degrade to a
 * decision rather than crash a request.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string): number[] =>
    v
      .replace(/^v/, '')
      .split('.')
      .map((part) => {
        const n = Number.parseInt(part, 10);
        return Number.isFinite(n) ? n : 0;
      });
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * True when the detected server version is `min` or newer.
 *
 * An UNDETECTED version (`null`/`undefined`) returns `false`. "We could not
 * tell" is never evidence that a server is new enough, and callers use this
 * to decide whether an operation may take a newer code path, so guessing
 * upward would route a request at a server that cannot serve it.
 */
export function serverAtLeast(detected: string | null | undefined, min: string): boolean {
  if (!detected) return false;
  return compareVersions(detected, min) >= 0;
}
