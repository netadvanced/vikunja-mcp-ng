/**
 * Encrypted JSON credential vault (docs/OIDC-RESOURCE-SERVER.md §3c, D1/D4).
 *
 * Maps a validated OIDC identity `(issuer, sub)` to an encrypted Vikunja
 * `tk_` API token. This is the piece that closes the "critical gap" §1.2 of
 * the spec describes: a Keycloak access token authenticates a *person*, it
 * is not itself a Vikunja credential — `oidc-http` mode needs a per-user
 * lookup from the validated identity to a Vikunja token, and this module is
 * that lookup, persisted to disk.
 *
 * Design, matching the locked decisions:
 *  - **D1** — a single encrypted JSON file, not a database. Modeled directly
 *    on `src/storage/templateFileStore.ts`'s proven shape: load-into-memory,
 *    write-temp-then-rename on every mutation. Reads tolerate a missing file
 *    (fresh deployment) and log-and-empty on a malformed one, exactly like
 *    the templates loader.
 *  - **D4** — AES-256-GCM via Node's built-in `crypto`. One operator-supplied
 *    32-byte master key (`VIKUNJA_MCP_VAULT_KEY[_FILE]`, resolved through the
 *    existing `_FILE` secrets convention, `src/config/secrets.ts`), a random
 *    12-byte IV per record, and an authenticated GCM tag verified on every
 *    decrypt. A wrong key or a tampered record fails the tag check loudly
 *    (`decryptToken` throws) rather than silently returning garbage. The tag
 *    additionally covers the record's identity key and `vikunjaUrl` as GCM
 *    AAD (`vaultRecordAad`, `keyVersion: 2`) so the plaintext fields around
 *    the ciphertext cannot be edited or spliced either — issue #262.
 *
 * Concurrency: every mutation (`provision`/`deprovision`) is serialized
 * through a single `async-mutex` `Mutex` (matching the codebase's existing
 * thread-safety convention — see `src/client.ts`, `src/storage/
 * SimpleFilterStorage.ts`), so two concurrent provisions/deprovisions can
 * never interleave their read-modify-write cycle and tear the file.
 *
 * That mutex covers concurrent *requests*, not concurrent *processes*: two
 * servers sharing one vault file would each rewrite the whole map and the
 * later write would erase the earlier one's provisioning. No file locking is
 * added because a second process is out of scope by design — enrollment
 * tickets, rate-limit counters and circuit-breaker state are process-local
 * too, so a second replica breaks those first. `oidc-http` mode is
 * single-process; see docs/CONFIGURATION.md ("Run exactly one server process
 * per vault file") and docs/OIDC-RESOURCE-SERVER.md §3(c).
 *
 * `getCredential` — the method the `VikunjaCredentialSource` interface
 * requires (`src/auth/CredentialSource.ts`) — is deliberately synchronous
 * (Node's `crypto` decrypt calls are sync), so it never throws: a missing
 * record or a decrypt failure (wrong key / corrupted record) both resolve to
 * `null`, which is exactly the interface's "no credential linked yet"
 * signal — a decrypt failure must never crash the OIDC auth middleware.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Mutex } from 'async-mutex';
import { logger } from '../utils/logger';
import { maskCredential } from '../utils/security';
import { ConfigurationError } from '../config/types';
import { readSecretEnv } from '../config/secrets';
import { identityKey, type Identity } from '../context/requestContext';
import { fsyncPath } from './fsync';
import { AuthManager } from '../auth/AuthManager';
import type { VikunjaCredential } from '../auth/CredentialSource';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const KEY_LENGTH = 32;

/**
 * Record format 1: AES-256-GCM with NO additional authenticated data, so the
 * record's `vikunjaUrl` and its identity key were outside the GCM tag
 * (issue #262 / CRIT-1). Still readable, never written any more.
 */
const KEY_VERSION_NO_AAD = 1;

/**
 * Record format 2 (current): identical crypto, but `vaultRecordAad()` —
 * the identity key plus the record's `vikunjaUrl` — is fed to the cipher as
 * GCM additional authenticated data, so neither can be swapped without the
 * tag check failing.
 */
const CURRENT_KEY_VERSION = 2;

/**
 * How often a record's `lastUsedAt` is actually flushed to disk (issue
 * #278). `getCredential` runs per request, so the timestamp is throttled to
 * at most one vault write per identity per interval.
 */
const DEFAULT_LAST_USED_FLUSH_INTERVAL_MS = 60_000;

/**
 * The vault stores Vikunja **API tokens** (`tk_*`) and nothing else — issue
 * #322.
 *
 * This is the invariant behind `getCredential`'s `authType: 'api-token'`,
 * which used to be an unconditional hardcode on a value nothing checked. In
 * `oidc-http` mode that label is fed straight into `authManager.connect(...)`
 * (`src/transport/oidcHttpAuth.ts`), so a mislabeled credential would make
 * the per-identity auth manager lie about what it holds — and the JWT-only
 * registration gate (`src/tools/index.ts`, issue #270) reads exactly that
 * value. Enforcing the invariant at the single write path makes the label
 * true by construction instead of true by assumption.
 *
 * Rejecting a JWT here is not an arbitrary narrowing; it is the mode's
 * design (docs/OIDC-RESOURCE-SERVER.md §1.2 and wave item H1-6, "uniform
 * `api-token` assumption"):
 *  - Vikunja's own JWTs come from *its* login form, expire in hours, and
 *    this server holds no refresh path for them (ROADMAP §4's "Never"
 *    verdict on `token/refresh`), so a vaulted JWT is a credential that
 *    silently dies — the vault is explicitly a long-lived-token store.
 *  - The one-click SSO enrollment flow (`src/transport/enrollment.ts`) mints
 *    a `tk_*` token for exactly this reason.
 *
 * A non-`tk_`, non-JWT string is still accepted: `AuthManager.detectAuthType`
 * treats anything unrecognized as an API token for backward compatibility,
 * and the caller has already round-tripped the token against Vikunja before
 * reaching the vault. Only the positively-identified JWT shape is refused.
 */
export function assertVaultableToken(apiToken: string): void {
  if (AuthManager.detectAuthType(apiToken) === 'jwt') {
    throw new Error(
      'The credential vault stores Vikunja API tokens only, and this looks like a JWT ' +
        '(eyJ...). Create an API token in Vikunja → Settings → API Tokens (it starts with ' +
        '"tk_") and link that instead: a Vikunja JWT comes from an interactive login, ' +
        'expires within hours, and this server cannot refresh it.',
    );
  }
}

/** One vault record's on-disk shape (docs/OIDC-RESOURCE-SERVER.md §3c file-shape table). */
export interface VaultRecord {
  readonly vikunjaUrl: string;
  readonly ciphertext: string;
  readonly iv: string;
  readonly authTag: string;
  readonly keyVersion: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastUsedAt: string | null;
}

/** Status shape returned by `vikunja_auth status` in oidc-http mode. */
export interface VaultStatus {
  /**
   * Whether this identity has a credential that actually WORKS — a stored
   * record whose decrypt succeeds. A record that is present but
   * undecryptable (master key rotated/mismatched, tampered binding) reports
   * `false` here, because every request using it fails exactly as if nothing
   * were linked; `recordPresent` + `issue` explain the difference (#278).
   */
  readonly provisioned: boolean;
  /** True when a record exists for this identity, decryptable or not. */
  readonly recordPresent?: boolean;
  /** Human-readable reason a present record is nevertheless unusable. */
  readonly issue?: string;
  readonly vikunjaUrl?: string;
  /** Masked (`maskCredential`) token prefix — never the full token. */
  readonly maskedToken?: string;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly lastUsedAt?: string | null;
  /** On-disk record format of this identity's own record, when one exists. */
  readonly keyVersion?: number;
  /**
   * True when this identity's record is usable but written in an outdated
   * format that the owner should re-provision to upgrade — today, the
   * pre-AAD `keyVersion: 1` shape (issue #262) or a token stored before the
   * vault refused JWTs (issue #322). `migrationNotice` says which and what
   * to do; unlike `issue`, the credential still works meanwhile.
   */
  readonly needsMigration?: boolean;
  /** Human-readable, actionable explanation of `needsMigration`. */
  readonly migrationNotice?: string;
  // Index signature so this shape can be passed directly as `ResponseData`
  // to `createStandardResponse` (`src/utils/response-factory.ts`) without a
  // separate re-shaping step.
  readonly [key: string]: unknown;
}

/**
 * Operator-facing summary of how many stored records still sit in an
 * outdated on-disk format (issue #322 finding 2). Identities are masked.
 */
export interface VaultMigrationSummary {
  readonly totalRecords: number;
  readonly legacyRecords: number;
  /** Masked identity keys of the records still on `keyVersion: 1`. */
  readonly legacyIdentities: readonly string[];
  /** Present when this process's view of the vault is known incomplete (#266). */
  readonly incompleteReason?: string;
}

/**
 * The per-identity half of the migration visibility (issue #322): what, if
 * anything, this record's owner should re-provision — and why. Returns
 * `undefined` for an already-current record.
 *
 * Both cases are *usable* credentials, which is why they are a notice and
 * not a `VaultStatus.issue`: nothing is broken today, but the record was
 * written by a build with weaker guarantees than the current one.
 */
function migrationNoticeFor(record: VaultRecord, token: string): string | undefined {
  if (AuthManager.detectAuthType(token) === 'jwt') {
    // Predates `assertVaultableToken`. The stored JWT is almost certainly
    // expired already, and it can never register the JWT-only tools in this
    // mode, so say so plainly rather than leaving the owner to guess.
    return (
      'The credential stored for you is a JWT, not a Vikunja API token. It was linked ' +
      "before this server rejected JWTs, it expires on Vikunja's own schedule and cannot " +
      'be refreshed here. Run vikunja_auth provision with a "tk_" API token instead.'
    );
  }
  if (record.keyVersion === KEY_VERSION_NO_AAD) {
    return (
      'Your credential is stored in the legacy pre-binding format (keyVersion 1): its ' +
      'Vikunja URL and identity binding are not covered by the encryption tag. It still ' +
      'works — re-run vikunja_auth provision with the same token to upgrade it.'
    );
  }
  return undefined;
}

function isVaultRecord(value: unknown): value is VaultRecord {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.vikunjaUrl === 'string' &&
    typeof record.ciphertext === 'string' &&
    typeof record.iv === 'string' &&
    typeof record.authTag === 'string' &&
    typeof record.keyVersion === 'number' &&
    typeof record.createdAt === 'string' &&
    typeof record.updatedAt === 'string' &&
    (record.lastUsedAt === null || typeof record.lastUsedAt === 'string')
  );
}

/**
 * Parse an operator-supplied master key string into exactly 32 raw bytes,
 * accepting EITHER encoding an operator would naturally reach for:
 *  - 64 hex characters (`openssl rand -hex 32`), or
 *  - standard base64 of 32 bytes (`openssl rand -base64 32`).
 *
 * Hex is tried first (a 64-hex string is also valid base64, but would decode
 * to 48 bytes, so the order matters). Throws a plain `Error` on anything that
 * does not decode to exactly {@link KEY_LENGTH} bytes; the env-reading
 * {@link resolveVaultMasterKey} wrapper translates that into a startup-fatal
 * `ConfigurationError`.
 */
export function parseMasterKey(raw: string): Buffer {
  const trimmed = raw.trim();
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return Buffer.from(trimmed, 'hex');
  }
  const decoded = Buffer.from(trimmed, 'base64');
  if (decoded.length === KEY_LENGTH) {
    return decoded;
  }
  throw new Error(
    `VIKUNJA_MCP_VAULT_KEY must decode to exactly ${KEY_LENGTH} bytes: either 64 hex ` +
      'characters, or standard base64 (e.g. `openssl rand -hex 32` or `openssl rand -base64 32`).',
  );
}

/**
 * Resolve the master encryption key from `VIKUNJA_MCP_VAULT_KEY[_FILE]`
 * (the existing `_FILE` secrets convention, `src/config/secrets.ts`).
 * Throws a clear `ConfigurationError` when unset or not a 32-byte hex/base64
 * value — `oidc-http` mode must fail loud at startup rather than run with no
 * usable vault.
 */
export function resolveVaultMasterKey(): Buffer {
  const raw = readSecretEnv('VIKUNJA_MCP_VAULT_KEY');
  if (!raw || raw.trim().length === 0) {
    throw new ConfigurationError(
      'VIKUNJA_MCP_VAULT_KEY',
      'oidc-http mode requires a credential vault master key. Set ' +
        'VIKUNJA_MCP_VAULT_KEY (or VIKUNJA_MCP_VAULT_KEY_FILE) to a 32-byte value, ' +
        'encoded as hex or base64 — e.g. generate one with `openssl rand -base64 32`.',
    );
  }
  try {
    return parseMasterKey(raw);
  } catch (error) {
    throw new ConfigurationError(
      'VIKUNJA_MCP_VAULT_KEY',
      error instanceof Error ? error.message : String(error),
    );
  }
}

/**
 * Resolve the effective vault file path: `VIKUNJA_MCP_VAULT_PATH` env var
 * wins over the `vault.path` config value (matching
 * `resolveTemplatesPersistPath`'s existing env-over-config-file precedence),
 * returning `undefined` when neither is set.
 */
export function resolveVaultPath(configuredPath: string | undefined): string | undefined {
  const envPath = process.env.VIKUNJA_MCP_VAULT_PATH;
  if (envPath !== undefined && envPath.trim().length > 0) {
    return envPath;
  }
  if (configuredPath !== undefined && configuredPath.trim().length > 0) {
    return configuredPath;
  }
  return undefined;
}

/**
 * The GCM additional-authenticated-data (AAD) that binds a record's
 * ciphertext to BOTH the identity that owns it and the Vikunja URL the
 * decrypted token will be sent to (issue #262 / CRIT-1).
 *
 * Without it only `ciphertext/iv/authTag` are covered by the auth tag, so
 * someone who can write the vault file but does NOT hold the master key can
 * (a) retarget `vikunjaUrl` at a server they control and collect the
 * victim's plaintext token on its next use, or (b) splice identity A's
 * ciphertext trio under identity B's key and impersonate A. Both edits leave
 * the tag valid because the tag never covered those bytes. Feeding this
 * value to `cipher.setAAD`/`decipher.setAAD` makes either edit fail the tag
 * check, which `getCredential` already translates into `null`.
 *
 * The two components are LENGTH-PREFIXED rather than just concatenated: an
 * `identityKey` is `"<issuer>|<sub>"` and a URL can itself contain any
 * separator character, so plain concatenation would let a crafted
 * (issuer, sub, url) triple re-partition into a different one and collide.
 */
export function vaultRecordAad(identityKeyValue: string, vikunjaUrl: string): Buffer {
  return Buffer.from(
    `vikunja-mcp-vault/v${CURRENT_KEY_VERSION}:` +
      `${identityKeyValue.length}:${identityKeyValue}:` +
      `${vikunjaUrl.length}:${vikunjaUrl}`,
    'utf-8',
  );
}

/**
 * Encrypts `plaintext` (a Vikunja `tk_` token) with AES-256-GCM: a fresh
 * random 12-byte IV per call (D4), returning base64-encoded ciphertext/iv/
 * authTag ready to store on a `VaultRecord`.
 *
 * `aad`, when supplied ({@link vaultRecordAad}), is covered by the resulting
 * authentication tag without being encrypted — that is what binds the record
 * to its identity and `vikunjaUrl`. It is optional only so the legacy
 * `keyVersion: 1` format stays decryptable; every new record passes one.
 */
export function encryptToken(
  plaintext: string,
  key: Buffer,
  aad?: Buffer,
): { ciphertext: string; iv: string; authTag: string } {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  if (aad !== undefined) {
    cipher.setAAD(aad);
  }
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    ciphertext: encrypted.toString('base64'),
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
  };
}

/**
 * Decrypts a `VaultRecord`'s ciphertext back to the plaintext `tk_` token.
 * Throws (GCM authentication-tag verification failure, or malformed
 * base64/ciphertext) when the key is wrong or the record has been tampered
 * with — this function itself never silently returns garbage; callers that
 * must not throw (`VaultFileStore.getCredential`) catch and translate this
 * into `null` themselves.
 *
 * `aad` must be byte-identical to the value passed to {@link encryptToken}
 * (i.e. {@link vaultRecordAad} for `keyVersion: 2` records, omitted for
 * legacy `keyVersion: 1` ones) or the tag check fails.
 */
export function decryptToken(
  record: Pick<VaultRecord, 'ciphertext' | 'iv' | 'authTag'>,
  key: Buffer,
  aad?: Buffer,
): string {
  const iv = Buffer.from(record.iv, 'base64');
  const authTag = Buffer.from(record.authTag, 'base64');
  const ciphertext = Buffer.from(record.ciphertext, 'base64');
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  if (aad !== undefined) {
    decipher.setAAD(aad);
  }
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString('utf-8');
}

/** {@link loadVaultFileWithStatus}'s result: the records plus how trustworthy they are. */
export interface VaultLoadResult {
  /** Every record that loaded cleanly. Possibly empty. */
  readonly records: Map<string, VaultRecord>;
  /**
   * `undefined` when the load is a faithful view of the file (including the
   * legitimately-empty "file does not exist yet" case). Otherwise a short
   * human-readable reason why `records` is known to be INCOMPLETE — the
   * file could not be read, was not parseable, or held entries that had to
   * be dropped. A caller must never write `records` back over the file in
   * that state: the write would make the loss permanent (issue #266).
   */
  readonly incompleteReason?: string;
}

/**
 * Load the vault file into an in-memory `Map` keyed by `identityKey()`
 * (`"<issuer>|<sub>"`). Never throws: a missing file (fresh deployment / no
 * volume yet) or a malformed one (not JSON, not an object, individual
 * malformed entries) all fall back to an empty (or partially-empty) vault
 * with a warning logged — matching `loadTemplatesFile`'s defensive posture.
 *
 * Unlike `loadTemplatesFile`, the *reason* matters here, because a vault
 * holds other people's credentials: everything except "the file isn't there
 * yet" is reported as `incompleteReason` so `VaultFileStore` can refuse to
 * write an incomplete map back over the real file (issue #266).
 */
export function loadVaultFileWithStatus(filePath: string): VaultLoadResult {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      // Not a failure: a fresh deployment has no vault file yet.
      return { records: new Map() };
    }
    const message = error instanceof Error ? error.message : String(error);
    logger.warn('Failed to read credential vault file, starting with an empty vault', {
      filePath,
      error: message,
    });
    return { records: new Map(), incompleteReason: `the vault file could not be read (${message})` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    logger.warn('Credential vault file is not valid JSON, starting with an empty vault', {
      filePath,
      error: error instanceof Error ? error.message : String(error),
    });
    return { records: new Map(), incompleteReason: 'the vault file is not valid JSON' };
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    logger.warn('Credential vault file did not contain a JSON object, starting with an empty vault', {
      filePath,
    });
    return { records: new Map(), incompleteReason: 'the vault file is not a JSON object' };
  }

  const map = new Map<string, VaultRecord>();
  const entries = Object.entries(parsed as Record<string, unknown>);
  for (const [key, value] of entries) {
    if (isVaultRecord(value)) {
      map.set(key, value);
    }
  }
  if (map.size !== entries.length) {
    logger.warn('Credential vault file contained malformed entries, dropping them', {
      filePath,
      totalEntries: entries.length,
      validEntries: map.size,
    });
    return {
      records: map,
      incompleteReason:
        `the vault file contained ${entries.length - map.size} malformed ` +
        `entr${entries.length - map.size === 1 ? 'y' : 'ies'} that had to be dropped`,
    };
  }
  return { records: map };
}

/**
 * {@link loadVaultFileWithStatus} without the load status — the plain
 * "give me the records" reader. Prefer the status-returning variant anywhere
 * the result may be written back (issue #266).
 */
export function loadVaultFile(filePath: string): Map<string, VaultRecord> {
  return loadVaultFileWithStatus(filePath).records;
}

/**
 * Write the full record map to `filePath` atomically: serialize to a temp
 * file in the same directory, then `renameSync` it over the target path.
 * Rename is atomic on the same filesystem (POSIX and Windows both
 * guarantee this — mirrors `writeTemplatesFileAtomic`), so a reader never
 * observes a partially-written vault file and a crash mid-write leaves the
 * previous good file intact. Creates the parent directory if missing, and
 * best-effort restricts the file to `0600` (owner read/write only) — never
 * fatal if the platform doesn't support it (e.g. some Windows filesystems).
 */
export function writeVaultFileAtomic(filePath: string, records: Map<string, VaultRecord>): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  const obj: Record<string, VaultRecord> = {};
  for (const [key, record] of records) {
    obj[key] = record;
  }
  // Create the temp file already restricted to owner read/write (0600) so the
  // plaintext-adjacent ciphertext is never briefly world-readable under the
  // process umask before the chmod below — defense in depth on top of the
  // post-rename chmod.
  fs.writeFileSync(tmpPath, JSON.stringify(obj, null, 2), { encoding: 'utf-8', mode: 0o600 });
  // Flush the temp file's contents to the physical device BEFORE the rename
  // (issue #293 / LOW-10). Without this, `writeFileSync` + `renameSync` only
  // guarantees ordering within the page cache: a power loss seconds after a
  // "successful" provision can leave the renamed file empty or truncated,
  // silently losing every credential in the vault.
  fsyncPath(tmpPath, 'r+');
  fs.renameSync(tmpPath, filePath);
  // ...and flush the directory entry itself, so the rename survives too.
  // Best-effort: opening a directory for fsync is not supported everywhere
  // (notably Windows), and a durable file with an unflushed rename is still
  // strictly better than neither.
  try {
    fsyncPath(dir, 'r');
  } catch {
    // Intentionally ignored — see above.
  }
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Best-effort only — never fatal (e.g. unsupported on some filesystems).
  }
}

/**
 * The encrypted JSON credential vault. One instance is constructed at
 * `oidc-http` startup (`src/transport/oidcHttpAuth.ts`'s `setupOidcHttpAuth`)
 * and shared, via {@link setActiveVaultStore}/{@link getActiveVaultStore},
 * between the `VikunjaCredentialSource` the JWT-auth middleware reads from
 * on every request and the `vikunja_auth provision`/`status`/`deprovision`
 * subcommands (`src/tools/auth.ts`) that mutate it — the SAME in-memory
 * cache must back both, or a fresh `provision` would be invisible to the
 * next request until the file is reloaded from disk.
 */
export class VaultFileStore {
  private readonly mutex = new Mutex();
  private cache: Map<string, VaultRecord> | undefined;
  /**
   * Set when {@link load} produced a map that is known NOT to be the whole
   * file (unreadable file, unparseable JSON, dropped entries). While set,
   * every mutation refuses to write — see {@link assertWritable} (#266).
   */
  private incompleteLoadReason: string | undefined;
  /** Identity keys already warned about being on the legacy no-AAD format. */
  private readonly legacyFormatWarned = new Set<string>();
  /** How rarely `lastUsedAt` is flushed to disk — see {@link touchLastUsed}. */
  private readonly lastUsedFlushIntervalMs: number;

  constructor(
    private readonly filePath: string,
    private readonly masterKey: Buffer,
    options: { lastUsedFlushIntervalMs?: number } = {},
  ) {
    this.lastUsedFlushIntervalMs =
      options.lastUsedFlushIntervalMs ?? DEFAULT_LAST_USED_FLUSH_INTERVAL_MS;
  }

  private load(): Map<string, VaultRecord> {
    if (!this.cache) {
      const result = loadVaultFileWithStatus(this.filePath);
      this.cache = result.records;
      this.incompleteLoadReason = result.incompleteReason;
    }
    return this.cache;
  }

  /**
   * Guards every write path (issue #266).
   *
   * The cache is populated once and never invalidated, so a single failed or
   * partial load — an EACCES on a mis-permissioned volume, an EIO, a
   * half-written file — would otherwise become the process's permanent idea
   * of the vault's contents. The next `provision` writes the WHOLE map back,
   * which would silently delete every identity that failed to load. Refusing
   * to write keeps a read-side outage from turning into permanent data loss:
   * already-provisioned users whose records did load keep working, and the
   * operator gets an actionable error instead of a wiped vault.
   *
   * Recovery is deliberately an explicit operator action (fix the
   * permissions, or move the damaged file aside) followed by a restart —
   * never something a tool call can trigger on a tenant's behalf.
   */
  private assertWritable(): void {
    this.load();
    if (this.incompleteLoadReason !== undefined) {
      logger.error('Refusing to write the credential vault after an incomplete load', {
        filePath: this.filePath,
        reason: this.incompleteLoadReason,
      });
      throw new Error(
        `The credential vault cannot be updated right now: ${this.incompleteLoadReason}. ` +
          'Writing would overwrite the vault with an incomplete view and permanently ' +
          'destroy the records that failed to load. An operator must repair or move aside ' +
          'the vault file and restart the server.',
      );
    }
  }

  /**
   * Whether this process's view of the vault is known to be incomplete
   * (issue #266) — writes are refused while true. Exposed for `readyz`-style
   * health reporting and for `getStatus`'s honesty about why an identity
   * looks unprovisioned.
   */
  isDegraded(): boolean {
    this.load();
    return this.incompleteLoadReason !== undefined;
  }

  /**
   * Decrypts one record with the AAD its `keyVersion` calls for (#262).
   *
   * `keyVersion: 2` (current) verifies the identity+`vikunjaUrl` binding;
   * `keyVersion: 1` predates the binding and is decrypted without AAD so a
   * vault written by an older build keeps working across the upgrade — the
   * operator is told (once per identity) to re-provision, which rewrites the
   * record in the bound format. Any other `keyVersion` is a record this
   * build cannot read: it throws like a failed tag check, and every caller
   * already turns that into `null`/"unusable" rather than a crash.
   */
  private decryptRecord(record: VaultRecord, key: string): string {
    if (record.keyVersion === CURRENT_KEY_VERSION) {
      return decryptToken(record, this.masterKey, vaultRecordAad(key, record.vikunjaUrl));
    }
    if (record.keyVersion === KEY_VERSION_NO_AAD) {
      if (!this.legacyFormatWarned.has(key)) {
        this.legacyFormatWarned.add(key);
        logger.warn(
          'Vault record is in the legacy pre-AAD format (keyVersion 1); its vikunjaUrl and ' +
            'identity binding are not covered by the authentication tag. Re-run ' +
            'vikunja_auth provision for this identity to upgrade it.',
          { identity: maskCredential(key) },
        );
      }
      return decryptToken(record, this.masterKey);
    }
    throw new Error(
      `Unsupported vault record keyVersion ${record.keyVersion} (this build reads 1 and ` +
        `${CURRENT_KEY_VERSION}); the record was written by a newer server version.`,
    );
  }

  /**
   * Records that `identity`'s credential was just used (issue #278 —
   * `lastUsedAt` previously had no writer anywhere in `src/` and was
   * therefore always reported as `null`).
   *
   * Throttled: `getCredential` runs on every authenticated request, and a
   * full atomic rewrite of the vault per request would be both wasteful and
   * a write-amplification DoS lever for a busy tenant. One write per
   * identity per {@link lastUsedFlushIntervalMs} keeps the timestamp useful
   * ("was this credential used in the last hour/day?") at negligible cost.
   *
   * Never throws and never propagates a write failure: this is bookkeeping,
   * and `getCredential`'s contract is that it always resolves.
   *
   * Synchronous on purpose. `provision`/`deprovision` do all of their own
   * load-mutate-write work in one uninterrupted synchronous block after
   * acquiring the mutex, so a synchronous write here can never interleave
   * with one on Node's single thread — it does not need (and must not
   * block on) the mutex.
   */
  private touchLastUsed(key: string, record: VaultRecord): void {
    if (this.incompleteLoadReason !== undefined) {
      // Never write a partial view back over the file (issue #266).
      return;
    }
    const now = Date.now();
    const previous = record.lastUsedAt === null ? Number.NaN : Date.parse(record.lastUsedAt);
    if (Number.isFinite(previous) && now - previous < this.lastUsedFlushIntervalMs) {
      return;
    }
    const updated: VaultRecord = { ...record, lastUsedAt: new Date(now).toISOString() };
    const next = new Map(this.load());
    next.set(key, updated);
    try {
      writeVaultFileAtomic(this.filePath, next);
      this.cache = next;
    } catch (error) {
      // The credential itself is fine; only the usage timestamp is stale.
      logger.warn('Failed to persist the vault lastUsedAt timestamp', {
        identity: maskCredential(key),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Resolves the calling identity's Vikunja credential. Never throws — a
   * missing record and an undecryptable one (wrong master key / tampered
   * data) both resolve to `null`, matching `VikunjaCredentialSource`'s
   * contract (`src/auth/CredentialSource.ts`) exactly.
   *
   * `authType` is `'api-token'` because {@link assertVaultableToken} makes
   * that true at every write path, not because the field is unexamined
   * (issue #322): `src/transport/oidcHttpAuth.ts` feeds this value into
   * `authManager.connect(...)`, and the JWT-only registration gate in
   * `src/tools/index.ts` reads it back, so it has to describe the token that
   * is actually stored. A record written by an older build that predates the
   * guard is caught by {@link getStatus}, which tells that identity to
   * re-provision.
   */
  getCredential(identity: Identity): VikunjaCredential | null {
    const key = identityKey(identity);
    const record = this.load().get(key);
    if (!record) {
      return null;
    }
    try {
      const apiToken = this.decryptRecord(record, key);
      this.touchLastUsed(key, record);
      return { apiUrl: record.vikunjaUrl, apiToken, authType: 'api-token' };
    } catch (error) {
      logger.error(
        'Vault record failed to decrypt (wrong master key, tampered vikunjaUrl/identity ' +
          'binding, or corrupted record)',
        {
          identity: maskCredential(key),
          error: error instanceof Error ? error.message : String(error),
        },
      );
      return null;
    }
  }

  /**
   * `vikunja_auth status` in oidc-http mode — never reveals the raw token.
   *
   * Reports decrypt HEALTH, not mere presence in the map (issue #278):
   * status used to answer "linked" for a record `getCredential` could not
   * decrypt, so a user whose vault survived a master-key rotation was told
   * everything was fine while every request failed with "no credential".
   */
  getStatus(identity: Identity): VaultStatus {
    const key = identityKey(identity);
    const map = this.load();
    if (this.incompleteLoadReason !== undefined && !map.has(key)) {
      // Don't claim "not provisioned" when we simply could not read the file
      // this record may well live in (issue #266).
      return {
        provisioned: false,
        issue: `The credential vault could not be fully read: ${this.incompleteLoadReason}.`,
      };
    }
    const record = map.get(key);
    if (!record) {
      return { provisioned: false };
    }
    let maskedToken: string | undefined;
    let issue: string | undefined;
    let migrationNotice: string | undefined;
    try {
      const token = this.decryptRecord(record, key);
      maskedToken = maskCredential(token);
      migrationNotice = migrationNoticeFor(record, token);
    } catch (error) {
      issue =
        'A credential is stored for you but cannot be decrypted (wrong vault master key, ' +
        'or a tampered/corrupted record), so it cannot be used. Run vikunja_auth ' +
        'deprovision, then provision again.';
      logger.warn('Vault status reports a stored-but-unusable record', {
        identity: maskCredential(key),
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return {
      provisioned: maskedToken !== undefined,
      recordPresent: true,
      ...(issue !== undefined ? { issue } : {}),
      vikunjaUrl: record.vikunjaUrl,
      ...(maskedToken !== undefined ? { maskedToken } : {}),
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      lastUsedAt: record.lastUsedAt,
      keyVersion: record.keyVersion,
      ...(migrationNotice !== undefined ? { needsMigration: true, migrationNotice } : {}),
    };
  }

  /**
   * Vault-wide migration state, for the OPERATOR — issue #322 finding 2.
   *
   * `decryptRecord`'s legacy warning fires at most once per identity, and
   * only if that identity happens to make a request, so an operator could
   * run indefinitely without ever learning that some records are still on
   * the unbound `keyVersion: 1` format. This is the deterministic answer:
   * how many records exist, how many still need re-provisioning, and which
   * identities (masked) they are.
   *
   * Deliberately NOT part of `getStatus`: that is a per-tenant response in a
   * multi-tenant process, and one tenant has no business counting another's
   * records. This is called at startup (`src/transport/oidcHttpAuth.ts`),
   * where the audience is the operator reading their own server's boot
   * output.
   */
  getMigrationSummary(): VaultMigrationSummary {
    const map = this.load();
    const legacyIdentities: string[] = [];
    for (const [key, record] of map) {
      if (record.keyVersion === KEY_VERSION_NO_AAD) {
        legacyIdentities.push(maskCredential(key));
      }
    }
    return {
      totalRecords: map.size,
      legacyRecords: legacyIdentities.length,
      legacyIdentities,
      ...(this.incompleteLoadReason !== undefined
        ? { incompleteReason: this.incompleteLoadReason }
        : {}),
    };
  }

  /**
   * Encrypts and upserts `apiToken` for `identity`, preserving `createdAt`
   * across a re-provision (token swap) while bumping `updatedAt`. Callers
   * MUST validate the token (round-trip against Vikunja) before calling
   * this — the vault itself has no way to check a token is real.
   *
   * Throws without writing anything when this process's view of the vault is
   * incomplete (issue #266).
   */
  async provision(identity: Identity, vikunjaUrl: string, apiToken: string): Promise<void> {
    // Enforced at the single write path, so EVERY caller is covered: the
    // `vikunja_auth provision` subcommand, the SSO enrollment flow, and any
    // future one (issue #322). See `assertVaultableToken`.
    assertVaultableToken(apiToken);
    const release = await this.mutex.acquire();
    try {
      this.assertWritable();
      const map = this.load();
      const key = identityKey(identity);
      const existing = map.get(key);
      const now = new Date().toISOString();
      // AAD binds the ciphertext to this identity AND this vikunjaUrl (#262):
      // an attacker who can rewrite the file but has no master key can no
      // longer retarget the URL or move the trio under another identity.
      const { ciphertext, iv, authTag } = encryptToken(
        apiToken,
        this.masterKey,
        vaultRecordAad(key, vikunjaUrl),
      );
      const record: VaultRecord = {
        vikunjaUrl,
        ciphertext,
        iv,
        authTag,
        keyVersion: CURRENT_KEY_VERSION,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        lastUsedAt: existing?.lastUsedAt ?? null,
      };
      // Write first, swap the in-memory view in only once the write landed
      // (issue #277). Mutating `map` up front meant a thrown write left the
      // record live in memory but absent from disk: the caller was told the
      // credential was stored, it worked until the next restart, and then
      // silently vanished. A copy keeps the failure atomic in both places.
      const next = new Map(map);
      next.set(key, record);
      writeVaultFileAtomic(this.filePath, next);
      this.cache = next;
    } finally {
      release();
    }
  }

  /**
   * Deletes `identity`'s record, if any. Idempotent — returns whether a
   * record actually existed. Throws without writing anything when this
   * process's view of the vault is incomplete (issue #266).
   */
  async deprovision(identity: Identity): Promise<boolean> {
    const release = await this.mutex.acquire();
    try {
      this.assertWritable();
      const map = this.load();
      const key = identityKey(identity);
      if (!map.has(key)) {
        return false;
      }
      // Mirror of provision's ordering (issue #277): deleting from the live
      // map before the write meant a thrown write reported the credential as
      // removed while it stayed on disk and came back on the next restart.
      const next = new Map(map);
      next.delete(key);
      writeVaultFileAtomic(this.filePath, next);
      this.cache = next;
      return true;
    } finally {
      release();
    }
  }
}

// ---------------------------------------------------------------------------
// Active-vault seam
//
// Mirrors src/transport/oidcMiddlewareSeam.ts's module-scope registration
// pattern: `setupOidcHttpAuth` constructs exactly one `VaultFileStore` at
// startup and registers it here; `vikunja_auth`'s provision/status/
// deprovision subcommands (src/tools/auth.ts) read it back through
// `getActiveVaultStore()`. This is what keeps the middleware's read path and
// the tool's write path sharing the SAME in-memory cache (see the class doc
// comment above).
// ---------------------------------------------------------------------------

let activeVaultStore: VaultFileStore | undefined;

/** Registers the process's vault store. `undefined` clears it (used by tests). */
export function setActiveVaultStore(store: VaultFileStore | undefined): void {
  activeVaultStore = store;
}

/** The registered vault store, or `undefined` if `oidc-http` mode hasn't set one up (or isn't active). */
export function getActiveVaultStore(): VaultFileStore | undefined {
  return activeVaultStore;
}
