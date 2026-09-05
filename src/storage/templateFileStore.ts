/**
 * Opt-in file-backed persistence for templates.
 *
 * Templates are in-memory only by default (backed by `SimpleFilterStorage`,
 * session-scoped, lost on process restart — see docs/STORAGE.md). When a
 * persist path is configured (`templates.persistPath` config key, or the
 * `VIKUNJA_MCP_TEMPLATES_FILE` env var, which wins — see
 * docs/CONFIGURATION.md), `src/tools/templates.ts` write-throughs the full
 * template set to that file on every mutation and reloads it the first time
 * templates storage is touched in a process.
 *
 * This is intentionally *not* a general-purpose persistence adapter bolted
 * onto `SimpleFilterStorage`: templates.ts is the only consumer of
 * durability today (owner decision, see the N3-templates-persistence work
 * item), so this module stays scoped to templates rather than growing into a
 * second storage backend for saved filters. SQLite was evaluated for this
 * and parked — native-dep cost outweighs the need for a single opt-in JSON
 * file (see docs/ROADMAP.md).
 */

import * as fs from 'fs';
import * as path from 'path';
import { Mutex } from 'async-mutex';
import { logger } from '../utils/logger';
import { fsyncPath } from './fsync';

/**
 * A single persisted template entry. `data` is an opaque JSON-serialized
 * blob (the `TemplateData` shape from templates.ts) — this module doesn't
 * need to know its internal fields, only that it round-trips.
 *
 * `identity` is the owning session's stable identity string (the same value
 * used to key `SimpleFilterStorage` instances — `(issuer,sub)` in
 * `oidc-http` mode, `apiUrl:tokenPrefix` in `stdio` mode; see
 * `getEffectiveSessionId`). Required as of the #265 (CRIT-4) fix: without
 * it, hydration loaded every record in the file into whichever identity
 * touched storage first, and each write-through overwrote the *entire*
 * file with just that identity's set, silently erasing every other
 * identity's templates. A record with no `identity` predates this fix and
 * cannot be safely attributed to a tenant, so it is treated as malformed
 * (dropped, with a warning) like any other invalid entry — see
 * `isPersistedTemplateRecord`.
 */
export interface PersistedTemplateRecord {
  /** The template's own id (`template_<timestamp>`), used for lookups. */
  id: string;
  /** Same as `id` today — kept distinct for forward-compatibility with the
   *  underlying SavedFilter-shaped storage record. */
  name: string;
  data: string;
  /** Owning identity — see the interface doc comment above. */
  identity: string;
}

function isPersistedTemplateRecord(value: unknown): value is PersistedTemplateRecord {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === 'string' &&
    typeof record.name === 'string' &&
    typeof record.data === 'string' &&
    typeof record.identity === 'string'
  );
}

/**
 * Resolve the effective templates persistence path.
 *
 * `VIKUNJA_MCP_TEMPLATES_FILE` env var wins over the `templates.persistPath`
 * config value when both are set, matching ConfigurationManager's general
 * env-over-config-file precedence (see docs/CONFIGURATION.md). Returns
 * `undefined` when neither is set — persistence stays opt-in, and the
 * in-memory-only default is byte-identical to pre-persistence behavior.
 */
export function resolveTemplatesPersistPath(
  configuredPath: string | undefined,
): string | undefined {
  const envPath = process.env.VIKUNJA_MCP_TEMPLATES_FILE;
  if (envPath !== undefined && envPath.trim().length > 0) {
    return envPath;
  }
  if (configuredPath !== undefined && configuredPath.trim().length > 0) {
    return configuredPath;
  }
  return undefined;
}

/**
 * Load persisted templates from disk.
 *
 * Never throws: a missing file (first run / fresh volume) or a corrupt /
 * malformed file both fall back to an empty template set, logging a warning
 * for the latter so operators can tell "opted out" from "data got mangled".
 */
export function loadTemplatesFile(filePath: string): PersistedTemplateRecord[] {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      logger.warn(
        'Failed to read templates persistence file, starting with an empty template set',
        {
          filePath,
          error: error instanceof Error ? error.message : String(error),
        },
      );
    }
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    logger.warn(
      'Templates persistence file is not valid JSON, starting with an empty template set',
      {
        filePath,
        error: error instanceof Error ? error.message : String(error),
      },
    );
    return [];
  }

  if (!Array.isArray(parsed)) {
    logger.warn(
      'Templates persistence file did not contain a JSON array, starting with an empty template set',
      { filePath },
    );
    return [];
  }

  const records = parsed.filter(isPersistedTemplateRecord);
  if (records.length !== parsed.length) {
    logger.warn('Templates persistence file contained malformed entries, dropping them', {
      filePath,
      totalEntries: parsed.length,
      validEntries: records.length,
    });
  }
  return records;
}

/**
 * Write the full template set to `filePath` atomically: write to a temp
 * file in the same directory, then rename it over the target path. Rename
 * is atomic on the same filesystem (POSIX and Windows both guarantee this),
 * so a reader never observes a partially-written file, and a crash mid-write
 * leaves the previous good file intact.
 *
 * Creates the parent directory if it doesn't exist yet, so a fresh Docker
 * volume mount works without a separate provisioning step.
 *
 * The temp file is `fsync`ed before the rename and the directory after it
 * (issue #293 / LOW-10) — atomic-on-rename only orders the change within the
 * page cache, so without the flush a power loss right after a "saved"
 * template can still leave an empty or truncated file behind.
 */
export function writeTemplatesFileAtomic(
  filePath: string,
  records: PersistedTemplateRecord[],
): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmpPath, JSON.stringify(records, null, 2), 'utf-8');
  fsyncPath(tmpPath, 'r+');
  fs.renameSync(tmpPath, filePath);
  try {
    fsyncPath(dir, 'r');
  } catch {
    // Best-effort: opening a directory for fsync isn't portable (Windows).
  }
}

/**
 * Serializes every persist call made through `persistIdentityTemplateRecords`
 * (across every identity and, since only one persist path is ever configured
 * per process, effectively across the whole file) so a read-modify-write
 * cycle from one identity can never interleave with another's. Without this,
 * two concurrent `create`/`update`/`delete` calls from different identities
 * could both read the same on-disk snapshot, and whichever finishes last
 * would silently clobber the other's write (part of #265 / CRIT-4).
 */
const writeMutex = new Mutex();

/**
 * Merge `identityRecords` (the full, current template set for one identity)
 * into the persistence file, replacing only that identity's own prior
 * entries and leaving every other identity's records untouched, then write
 * the result back atomically.
 *
 * This is the identity-scoped counterpart to the old (buggy) behavior of
 * write-throughs overwriting the *entire* file with a single session's set
 * — see the `PersistedTemplateRecord.identity` doc comment for why that was
 * unsafe. The whole read-modify-write cycle runs under `writeMutex` so
 * concurrent persists from different identities merge correctly instead of
 * racing.
 */
export async function persistIdentityTemplateRecords(
  filePath: string,
  identity: string,
  identityRecords: PersistedTemplateRecord[],
): Promise<void> {
  const release = await writeMutex.acquire();
  try {
    const existing = loadTemplatesFile(filePath);
    const others = existing.filter((record) => record.identity !== identity);
    writeTemplatesFileAtomic(filePath, [...others, ...identityRecords]);
  } finally {
    release();
  }
}
