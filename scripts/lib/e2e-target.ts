/**
 * Single source of truth for e2e stack "targets" (issue #205).
 *
 * A target is one persistent Vikunja stack, identified by `<version>-<db>`
 * (e.g. `2.4.0-postgres`). Each target gets its own Compose project, its own
 * host ports, and its own credentials file — so several versions run side by
 * side and nothing an agent does to one disturbs another.
 *
 * Before this, a single stack on a single port meant the version was global
 * mutable state: `npm run test:matrix` re-pinned it mid-run, and
 * `npm run e2e:down`'s `-v` destroyed the volumes, which rotated the API
 * token out from under anyone holding it. Both were observed breaking a
 * concurrent worktree on 2026-07-28.
 *
 * PORTS ARE DERIVED, NEVER HAND-ASSIGNED, so a new Vikunja release needs no
 * table edit here:
 *
 *   postgres: 8000 + (major*100 + minor*10 + patch)   2.4.0 -> 8240
 *   sqlite:   9000 + (major*100 + minor*10 + patch)   2.4.0 -> 9240
 *
 * The auxiliary Postgres port lives in a separate 18000/19000 range (see
 * `dbPort`) so it can never collide with another target's API port.
 *
 * Consumed two ways, deliberately from one implementation:
 *   - TypeScript harnesses `import` it.
 *   - Shell (docker/e2e/bootstrap.sh) evaluates `e2e-target-cli.ts --shell`.
 */

/** Parsed `<version>-<db>` target identity plus everything derived from it. */
export interface E2eTarget {
  /** Canonical `<version>-<db>` id, e.g. `2.4.0-postgres`. */
  id: string;
  version: string;
  db: 'postgres' | 'sqlite';
  /** Docker Compose project name — also namespaces this target's volumes. */
  project: string;
  /** Host port publishing Vikunja's API. */
  port: number;
  /** Host port publishing Postgres (postgres targets only), for ad-hoc psql. */
  dbPort: number;
  /** Base API URL, always localhost — see the safety note in mcp-e2e.ts. */
  apiUrl: string;
  /** Credentials file for this target, relative to the repo root. */
  envFile: string;
  /** Compose service name; the two DB variants are separate service blocks. */
  service: string;
}

/** The target every harness uses when the caller doesn't choose one. */
export const DEFAULT_TARGET = '2.4.0-postgres';

/** Minimum supported Vikunja (the v1 floor), kept alongside the default for callers that sweep both. */
export const FLOOR_VERSION = '2.3.0';

function versionOffset(version: string): number {
  const parts = version.split('.').map((n) => Number.parseInt(n, 10));
  if (parts.length !== 3 || parts.some((n) => !Number.isInteger(n) || n < 0)) {
    throw new Error(`Unsupported Vikunja version "${version}" — expected a plain X.Y.Z release tag.`);
  }
  const [major = 0, minor = 0, patch = 0] = parts;
  if (minor > 9 || patch > 9) {
    // The compact base+MMP scheme only stays collision-free while minor and
    // patch are single digits. Fail loudly rather than silently colliding two
    // versions onto one port.
    throw new Error(
      `Vikunja version "${version}" needs a wider port scheme (minor/patch must be 0-9). ` +
        'Update versionOffset() in scripts/lib/e2e-target.ts before adding this version.',
    );
  }
  return major * 100 + minor * 10 + patch;
}

/**
 * Resolves a `<version>-<db>` id (or a bare version, which implies postgres)
 * into everything the stack and harnesses need.
 */
export function resolveTarget(id: string = DEFAULT_TARGET): E2eTarget {
  const trimmed = id.trim();
  const match = /^(\d+\.\d+\.\d+)(?:-(postgres|sqlite))?$/.exec(trimmed);
  if (!match) {
    throw new Error(
      `Invalid e2e target "${id}" — expected <version>[-postgres|-sqlite], e.g. "2.4.0-postgres".`,
    );
  }
  const version = match[1] as string;
  const db = (match[2] ?? 'postgres') as 'postgres' | 'sqlite';
  const offset = versionOffset(version);
  const port = (db === 'sqlite' ? 9000 : 8000) + offset;

  return {
    id: `${version}-${db}`,
    version,
    db,
    project: `vikunja-e2e-${version}-${db}`,
    port,
    // Separate 18000/19000 ranges so an auxiliary port can never collide with
    // another target's API port.
    dbPort: (db === 'sqlite' ? 19000 : 18000) + offset,
    apiUrl: `http://localhost:${port}/api/v1`,
    envFile: `docker/e2e/.env.${version}-${db}`,
    service: db === 'sqlite' ? 'vikunja-sqlite' : 'vikunja',
  };
}

/** Every target the repo routinely runs: aligned + floor, both backends. */
export function standardTargets(): E2eTarget[] {
  return ['2.4.0-postgres', '2.4.0-sqlite', `${FLOOR_VERSION}-postgres`, `${FLOOR_VERSION}-sqlite`].map(
    (id) => resolveTarget(id),
  );
}
