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
