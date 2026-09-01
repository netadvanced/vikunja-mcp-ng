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

/**
 * How a target gets its database.
 *
 *   `dedicated`  its own `postgres:16-alpine` container and volume inside its
 *                own Compose project — the original issue #205 design.
 *   `shared`     a database of its own inside ONE long-lived Postgres server
 *                shared by every non-legacy postgres target
 *                (docker/e2e/docker-compose.shared-db-server.yml).
 *   `sqlite`     no database service at all; an embedded file.
 */
export type E2eDbMode = 'dedicated' | 'shared' | 'sqlite';

/**
 * Postgres targets that keep a DEDICATED Postgres container, rather than a
 * database inside the shared server.
 *
 * Grandfathered, not preferred: 2.4.0-postgres is a long-running stack whose
 * stable API token other worktrees hold (see docker/e2e/bootstrap.sh's
 * "STABLE TOKENS" note), and moving its data into another server would rotate
 * that credential for no benefit. 2.3.0 is kept alongside it because it is
 * still occasionally stood up ad hoc against the same expectations.
 *
 * Every other version — including any future release — is `shared` by
 * default, so adding a version needs no edit here.
 */
const DEDICATED_DB_VERSIONS = new Set(['2.3.0', '2.4.0']);

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
  /** Host port publishing Postgres (dedicated-Postgres targets only), for ad-hoc psql. */
  dbPort: number;
  /** Base API URL, always localhost — see the safety note in mcp-e2e.ts. */
  apiUrl: string;
  /** Credentials file for this target, relative to the repo root. */
  envFile: string;
  /** Compose service name; each DB variant is a separate service block. */
  service: string;
  /** Where this target's database lives — see `E2eDbMode`. */
  dbMode: E2eDbMode;
  /** Compose profile selecting this target's service block. */
  profile: string;
  /**
   * Postgres database name. `vikunja` for a dedicated server (it has the
   * server to itself), `vikunja_<version>` inside the shared one. Empty for
   * sqlite targets, which have no database name.
   */
  dbName: string;
}

/** The target every harness uses when the caller doesn't choose one. */
export const DEFAULT_TARGET = '2.4.0-postgres';

/**
 * Minimum supported Vikunja (the v1 floor).
 *
 * Raised `2.3.0` -> `2.4.0` on 2026-08-31 (docs/ROADMAP.md §3 decision 27), so it currently
 * EQUALS `DEFAULT_TARGET`'s version — floor and aligned coincide, and `standardTargets()`
 * therefore yields one version's worth of stacks, not two. They separate again the moment the
 * aligned version moves past 2.4.0 (issue #237), at which point this constant is the only edit
 * needed to bring the floor lane back.
 *
 * Note this is a *policy* value, not a limit of the resolver: `resolveTarget('2.3.0-postgres')`
 * still works and still derives port 8230 — the port formula is plain arithmetic over any
 * `X.Y.Z`, deliberately kept so an unsupported version can still be stood up ad hoc.
 */
export const FLOOR_VERSION = '2.4.0';

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

  const dbMode: E2eDbMode =
    db === 'sqlite' ? 'sqlite' : DEDICATED_DB_VERSIONS.has(version) ? 'dedicated' : 'shared';
  const service =
    dbMode === 'sqlite' ? 'vikunja-sqlite' : dbMode === 'shared' ? 'vikunja-shared' : 'vikunja';
  const profile = dbMode === 'sqlite' ? 'sqlite' : dbMode === 'shared' ? 'postgres-shared' : 'postgres';
  const dbName =
    dbMode === 'sqlite' ? '' : dbMode === 'shared' ? `vikunja_${version.replace(/\./g, '_')}` : 'vikunja';

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
    service,
    dbMode,
    profile,
    dbName,
  };
}

/**
 * Every target the repo routinely runs: the aligned version and the floor, both DB backends.
 * De-duplicated, because those two versions currently coincide (see `FLOOR_VERSION`) and a
 * stack list with the same target twice would `e2e:up:all` it twice.
 */
export function standardTargets(): E2eTarget[] {
  const versions = [...new Set([DEFAULT_TARGET.split('-')[0] as string, FLOOR_VERSION])];
  return versions
    .flatMap((version) => [`${version}-postgres`, `${version}-sqlite`])
    .map((id) => resolveTarget(id));
}
