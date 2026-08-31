/**
 * Production-Ready Retry with Opossum Circuit Breaker
 * Replaces 374-line custom implementation with battle-tested patterns
 */

import CircuitBreaker from 'opossum';
import { logger } from './logger';
import { isAuthenticationError } from './auth-error-handler';
import { MCPError } from '../types/errors';
import { extractHttpStatus } from './http-error-detail';

/**
 * Simple circuit breaker registry for tracking and managing circuit breakers
 *
 * NOT re-keyed by identity in `oidc-http` mode (docs/OIDC-RESOURCE-SERVER.md
 * §3d, decision D3, isolation-table row #6) — deliberately, not an
 * oversight. Breakers are keyed per-endpoint-path and protect the *one
 * shared upstream Vikunja instance*, not a per-user resource; per-`sub`
 * rate-limit buckets (`src/middleware/simplified-rate-limit.ts`) already
 * give per-user fairness independently of breaker state. One user's
 * pathological requests can still trip a breaker for everyone — an
 * accepted, honestly-documented cross-user coupling (§4), not a leak of
 * per-user data (breakers hold no credentials or user-identifiable state).
 * Revisit condition (D3): if multi-Vikunja-instance support ever lands
 * (different users' requests routing to *different* upstream Vikunja
 * instances), per-instance or per-sub breaker isolation becomes necessary.
 */
class CircuitBreakerRegistry {
  private breakers = new Map<string, CircuitBreaker>();

  register(name: string, breaker: CircuitBreaker): void {
    this.breakers.set(name, breaker);
  }

  get(name: string): CircuitBreaker | undefined {
    return this.breakers.get(name);
  }

  async resetAll(): Promise<void> {
    const promises = Array.from(this.breakers.values()).map((breaker) => {
      return new Promise<void>((resolve) => {
        if (breaker.opened) {
          breaker.close();
        }
        resolve();
      });
    });
    await Promise.all(promises);
  }

  /**
   * Shuts down and forgets every registered breaker, including its
   * accumulated failure/success stats. `resetAll` only closes breakers that
   * are currently open — it leaves their rolling stats intact, so a breaker
   * that tripped once would still be closer to tripping again. Test suites
   * that exercise `vikunjaRestRequest` (which registers a real, named
   * breaker per endpoint group) need full isolation between test cases;
   * this is that reset.
   */
  clear(): void {
    for (const breaker of this.breakers.values()) {
      breaker.shutdown();
    }
    this.breakers.clear();
  }

  getAllStats(): Record<string, unknown> {
    const stats: Record<string, unknown> = {};
    for (const [name, breaker] of this.breakers.entries()) {
      stats[name] = breaker.stats;
    }
    return stats;
  }

  getAllStatsSync(): Record<string, unknown> {
    return this.getAllStats();
  }
}

export const circuitBreakerRegistry = new CircuitBreakerRegistry();

/**
 * Resolves after `ms` milliseconds, via a `setTimeout` that is `.unref()`d
 * (mirrors the pattern opossum itself uses for its own internal timers — see
 * `node_modules/opossum/lib/circuit.js`/`status.js`). `withRetry`'s
 * exponential backoff (below) is the only place this module schedules a
 * real (non-breaker-owned) timer; without `.unref()` a pending backoff delay
 * (up to `maxDelay`, 30s by default) counts as an active handle keeping the
 * process — or a `jest --runInBand` run — alive even though nothing is
 * actually waiting on it to fire. `.unref()` only affects whether the timer
 * alone can keep the event loop alive; it still fires normally and this
 * function still resolves at the same time either way.
 */
function sleepUnref(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    // Guards environments where `setTimeout` doesn't return an unref-able
    // handle (e.g. a DOM/browser global returning a plain number) — not
    // expected here (`testEnvironment: 'node'`), but matches opossum's own
    // defensive check rather than assuming Node's timer shape.
    if (typeof timer.unref === 'function') {
      timer.unref();
    }
  });
}

/**
 * Interface for errors that have code properties (like Node.js system errors)
 */
interface ErrorWithCode extends Error {
  code?: string;
  status?: number;
}

/**
 * opossum's own code for a fast-failed call while the breaker is open
 * (`buildError('Breaker is open', 'EOPENBREAKER')` in `opossum/lib/circuit.js`).
 */
const OPEN_BREAKER_CODE = 'EOPENBREAKER';

/**
 * opossum `errorFilter` predicate (issue #163): decides which rejections
 * from the wrapped operation must NOT count toward tripping the circuit
 * breaker open.
 *
 * Root cause of #163: an intermittent bulk-create HTTP 400 ("Invalid model
 * provided", Vikunja error code 2004) tripped the `vikunja-rest-*` breaker
 * OPEN, after which every later create in the same session failed instantly
 * with "Breaker is open" — one client-side validation error poisoned the
 * whole session (a failing run logged ~19 such rejections; a clean run
 * logged 0).
 *
 * A CLIENT-SIDE 4xx (bad request body, forbidden, not found, conflict,
 * unprocessable entity, ...) reflects a problem with THIS call's data or
 * permissions, not the health of the Vikunja service — so it must never
 * count as a breaker "failure". Per opossum's `handleError` (`lib/circuit.js`),
 * an `errorFilter` match does not swallow the error: the caller still sees
 * the real rejection, it is just recorded as a 'success' for the breaker's
 * rolling stats instead of a 'failure'.
 *
 * 401 is deliberately EXCLUDED from this filter — i.e. it still counts
 * toward opening the breaker, unchanged from before this fix. Auth errors
 * already have dedicated handling one layer up (`isAuthenticationError` /
 * `RETRY_CONFIG.AUTH_ERRORS`), and a storm of 401s across otherwise-unrelated
 * calls (e.g. a revoked/expired session) is arguably still a "stop hammering
 * the service" signal worth tripping the breaker for. #163's evidence is
 * specifically about a data-validation 400, not auth — widening the
 * exclusion to 401 as well was deliberately left out of scope here.
 *
 * Errors with no discoverable HTTP status (network failures, timeouts,
 * `ECONNRESET`/`ETIMEDOUT`, opossum's own `ETIMEDOUT`/`ESHUTDOWN`/
 * `ESEMLOCKED`) are NOT filtered — they keep counting toward opening the
 * breaker, which is exactly the "service looks unhealthy" signal the
 * breaker exists to catch. The one exception is a caller-side cancellation
 * (`details.cancelled`), handled first below.
 */
export function isClientErrorExcludedFromBreaker(error: unknown): boolean {
  // A request the CALLER aborted (the tool-execution deadline elapsed — see
  // `cancelled` in src/types/errors.ts) is the same kind of non-signal as a
  // 4xx: it says nothing about upstream health. Counting it would let one
  // identity's slow or oversized calls trip breakers that, per decision
  // 16(c), every other tenant in the process shares.
  if (error instanceof MCPError && error.details?.cancelled === true) {
    return true;
  }

  const status = extractHttpStatus(error);
  if (status === null) return false;
  if (status === 401) return false;
  return status >= 400 && status < 500;
}

/**
 * Rewords opossum's open-circuit rejection ("Breaker is open", code
 * `EOPENBREAKER`) so an agent understands it as a TRANSIENT, self-recovering
 * server-load condition rather than a hard/permanent failure.
 *
 * A live battle transcript showed an agent responding to the raw "Breaker is
 * open" message by calling `vikunja_auth disconnect` — self-sabotaging its
 * own session over a condition that resolves itself once `resetTimeout`
 * elapses and has nothing to do with authentication. The reworded message
 * explicitly tells the caller to back off and retry, and explicitly NOT to
 * re-authenticate or disconnect.
 *
 * Non-`EOPENBREAKER` errors (including opossum's other internal errors like
 * `ESHUTDOWN`/`ETIMEDOUT`/`ESEMLOCKED`, and ordinary operation failures) pass
 * through unchanged.
 */
export function rewordBreakerOpenError(error: unknown): unknown {
  if (!(error instanceof Error) || (error as ErrorWithCode).code !== OPEN_BREAKER_CODE) {
    return error;
  }

  // NOTE: deliberately avoids the substrings 'timeout', 'connection',
  // 'network', and 'rate limit' — `isRetryableError` (below) treats any of
  // those as grounds to retry, and an open breaker must NOT be retried
  // immediately (it will still be open; retrying just burns the backoff
  // delay for nothing). The original opossum message ("Breaker is open")
  // was already non-retryable for the same reason; this rewording preserves
  // that property.
  const reworded = new Error(
    'Vikunja API calls are temporarily paused after repeated recent failures ' +
      '(circuit breaker open). This is a TRANSIENT, self-recovering server-load ' +
      'condition, not an authentication or session problem — wait a bit, then ' +
      'retry the same request again. Do NOT re-authenticate, reconnect, or ' +
      'disconnect in response to this error.',
  );
  (reworded as ErrorWithCode).code = OPEN_BREAKER_CODE;
  return reworded;
}

/**
 * Simple retry configuration using opossum's built-in capabilities
 */
export interface RetryOptions {
  maxRetries?: number;
  timeout?: number;
  resetTimeout?: number;
  errorThresholdPercentage?: number;
  volumeThreshold?: number;
  shouldRetry?: (error: Error | ErrorWithCode) => boolean;
  initialDelay?: number;
  backoffFactor?: number;
  maxDelay?: number;
}

// Production-ready defaults
const DEFAULT_OPTIONS: Required<Omit<RetryOptions, 'shouldRetry'>> = {
  maxRetries: 3,
  timeout: 30000,
  resetTimeout: 30000,
  errorThresholdPercentage: 50,
  volumeThreshold: 5,
  initialDelay: 1000,
  backoffFactor: 2,
  maxDelay: 30000,
};

/**
 * Simple circuit breaker factory using opossum directly.
 *
 * `operation` MUST be a stable function reference — not a closure captured
 * per call-site invocation — because the registry caches the breaker (and
 * therefore the action it was constructed with) by `name` and returns the
 * cached instance on every subsequent call with that name, silently
 * discarding whatever `operation` was passed that time. Passing a fresh
 * closure each call under a shared/reused name was the exact bug fixed in
 * the wave0 baseline (a later call's arguments got lost, and the FIRST
 * closure ever registered under that name kept firing instead). Callers
 * that need per-call arguments must give `operation` a signature that takes
 * those arguments as parameters and pass them to `breaker.fire(...)` —
 * never bake them into the closure.
 */
export function createCircuitBreaker<TArgs extends unknown[], TR>(
  operation: (...args: TArgs) => Promise<TR>,
  name: string,
  options: RetryOptions = {},
): CircuitBreaker<TArgs, TR> {
  // Check if a circuit breaker with this name already exists. A cached
  // breaker is only reusable if it wraps the SAME operation — see #199: the
  // JSON and multipart REST helpers derived the same breaker name for
  // `/user/settings/avatar` vs `/user/settings/avatar/upload`, so whichever
  // ran first defined what that name executed for the rest of the session,
  // and multipart uploads were silently fired through the JSON helper
  // (`Content-Type: application/json`, `FormData` JSON.stringify'd to `{}`,
  // server 500). Rather than hand back a breaker that runs the wrong code,
  // register the mismatched operation under a disambiguated name and say so
  // loudly — a collision is a programming error, but failing a live upload
  // is a worse way to learn about it than a log line.
  let registryKey = name;
  const existingBreaker = circuitBreakerRegistry.get(registryKey);
  if (existingBreaker) {
    if ((existingBreaker as unknown as { action?: unknown }).action === operation) {
      return existingBreaker as unknown as CircuitBreaker<TArgs, TR>;
    }
    registryKey = `${name}#${operation.name || 'anonymous'}`;
    const existingForOperation = circuitBreakerRegistry.get(registryKey);
    // LOW-16 (#296): `registryKey` is derived from `operation.name`, which is
    // '' for every anonymous function — so two DISTINCT anonymous operations
    // that collide under the same `name` land on the identical disambiguated
    // key. Without re-checking `.action`, a third anonymous operation here
    // would silently reuse the second's breaker (wrong action fired). Fall
    // through to the loop below whenever the cached action doesn't actually
    // match, exactly as the outer check above does for `registryKey === name`.
    if (
      existingForOperation &&
      (existingForOperation as unknown as { action?: unknown }).action === operation
    ) {
      return existingForOperation as unknown as CircuitBreaker<TArgs, TR>;
    }
    if (existingForOperation) {
      // Still colliding after the first disambiguation (e.g. a third
      // anonymous operation) — keep appending a numeric suffix until we find
      // either this exact operation's breaker or a free slot.
      let suffix = 2;
      let candidateKey = `${registryKey}#${suffix}`;
      let candidate = circuitBreakerRegistry.get(candidateKey);
      while (
        candidate &&
        (candidate as unknown as { action?: unknown }).action !== operation
      ) {
        suffix += 1;
        candidateKey = `${registryKey}#${suffix}`;
        candidate = circuitBreakerRegistry.get(candidateKey);
      }
      if (candidate) {
        return candidate as unknown as CircuitBreaker<TArgs, TR>;
      }
      registryKey = candidateKey;
    }
    logger.error(
      `Circuit breaker name collision: "${name}" is already registered for a different operation. ` +
        `Registering "${operation.name || 'anonymous'}" under "${registryKey}" instead — give the two ` +
        'call sites distinct breaker names (see deriveRestBreakerName / VikunjaRestRequestOptions.breakerName).',
    );
  }

  const opts = { ...DEFAULT_OPTIONS, ...options };

  const breaker = new CircuitBreaker<TArgs, TR>(operation, {
    name: registryKey,
    timeout: opts.timeout,
    resetTimeout: opts.resetTimeout,
    errorThresholdPercentage: opts.errorThresholdPercentage,
    volumeThreshold: opts.volumeThreshold,
    // #163: client-side 4xx responses (bad data, not found, conflict, ...)
    // must not count toward tripping this breaker — see
    // `isClientErrorExcludedFromBreaker` for the full rationale. The
    // rejection itself is unaffected; only the breaker's failure/success
    // bookkeeping changes.
    errorFilter: isClientErrorExcludedFromBreaker,
  });

  // Register with the global registry
  circuitBreakerRegistry.register(registryKey, breaker);

  // Essential logging only
  breaker.on('open', () => logger.warn(`Circuit breaker ${registryKey} opened`));
  breaker.on('close', () => logger.info(`Circuit breaker ${registryKey} closed`));

  return breaker;
}

/**
 * Execute operation with automatic retry and circuit breaking
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  let lastError: unknown;
  let delay = opts.initialDelay || 1000;
  // `?? 3`, not `|| 3`: 0 is a meaningful, valid value ("don't retry at
  // all") and must not be coerced to the default of 3 the way `||` would.
  const maxRetries = opts.maxRetries ?? 3;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      // Execute the operation directly. Note: we intentionally do NOT wrap
      // this in a name-cached circuit breaker here. The breaker registry
      // caches breakers by name and opossum binds the action closure at
      // construction time, so a shared 'anonymous' breaker would silently
      // re-fire whichever operation first created it instead of this one.
      // Callers that want circuit-breaker semantics should use
      // withNamedRetry/withTaskRetry/withBulkRetry with a real, unique name.
      return await operation();
    } catch (error) {
      lastError = error;

      // Check if we should retry this error
      const shouldRetry = opts.shouldRetry
        ? opts.shouldRetry(error as Error)
        : isRetryableError(error);

      // If this is the last attempt or error is not retryable, throw
      if (attempt === maxRetries || !shouldRetry) {
        throw error;
      }

      // Log retry attempt
      logger.debug(`Retry attempt ${attempt + 1}/${maxRetries} after ${delay}ms`);

      // Wait before retrying with exponential backoff
      await sleepUnref(delay);
      delay = Math.min(delay * (opts.backoffFactor || 2), opts.maxDelay || 30000);
    }
  }

  throw lastError;
}

/**
 * Execute operation with named circuit breaker for stats
 */
export async function withNamedRetry<T>(
  operation: () => Promise<T>,
  name: string,
  options: RetryOptions = {},
): Promise<T> {
  // Register a STABLE action and pass the per-call operation as a fire()
  // argument, exactly as `createCircuitBreaker`'s doc comment prescribes.
  // Registering `operation` itself would mean every caller of a shared name
  // (e.g. `withTaskRetry(..., 'create')`, which deliberately pools all task
  // creates behind one breaker) hands in a different closure: before #199's
  // fix that silently re-fired whichever closure was registered FIRST — two
  // different creates, the first one executed twice — and after it, each
  // closure would get its own breaker, defeating the pooling these helpers
  // exist for. Threading the operation through `fire()` keeps both
  // properties: one shared breaker per name, and the right code runs.
  const breaker = createCircuitBreaker(invokeOperation, name, options);
  try {
    return (await breaker.fire(operation)) as T;
  } catch (error) {
    throw rewordBreakerOpenError(error);
  }
}

/**
 * The stable breaker action used by {@link withNamedRetry}: invokes whatever
 * operation it is fired with. Must stay a single top-level reference — that
 * is what makes every `withNamedRetry` call under one name resolve to the
 * same registered breaker.
 */
function invokeOperation(operation: () => Promise<unknown>): Promise<unknown> {
  return operation();
}

/**
 * Alias for withNamedRetry for backward compatibility
 */
export const withCircuitBreaker = withNamedRetry;

/**
 * Get circuit breaker health stats
 */
export function getHealthStats(breaker: CircuitBreaker): CircuitBreaker.Stats {
  return breaker.stats;
}

/**
 * Check if error is retryable (basic implementation)
 */
export function isRetryableError(error: unknown): error is ErrorWithCode {
  if (error instanceof Error) {
    // Authentication errors are retryable
    if (isAuthenticationError(error)) {
      return true;
    }

    const message = error.message.toLowerCase();
    return (
      message.includes('timeout') ||
      message.includes('connection') ||
      message.includes('network') ||
      message.includes('rate limit') ||
      (error as ErrorWithCode).code === 'ECONNRESET' ||
      (error as ErrorWithCode).code === 'ETIMEDOUT'
    );
  }
  return false;
}

/**
 * Check if error is transient for circuit breaker purposes
 */
export function isTransientError(error: unknown): error is ErrorWithCode {
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    return (
      message.includes('timeout') ||
      message.includes('timed out') ||
      message.includes('connection') ||
      message.includes('network') ||
      message.includes('rate limit') ||
      message.includes('socket') ||
      message.includes('hang up') ||
      message.includes('econnreset') ||
      message.includes('etimedout') ||
      message.includes('reset by peer') ||
      message.includes('closed unexpectedly') ||
      (error as ErrorWithCode).code === 'ECONNRESET' ||
      (error as ErrorWithCode).code === 'ETIMEDOUT'
    );
  }
  return false;
}

/**
 * Predefined retry configurations for different operation types
 */
export const RETRY_CONFIG = {
  AUTH_ERRORS: {
    maxRetries: 3,
    initialDelay: 1000,
    maxDelay: 10000,
    backoffFactor: 2,
    enableCircuitBreaker: true,
    circuitBreakerName: 'vikunja-auth-connect',
  },
  NETWORK_ERRORS: {
    maxRetries: 5,
    initialDelay: 500,
    maxDelay: 30000,
    backoffFactor: 1.5,
    enableCircuitBreaker: true,
    circuitBreakerName: 'vikunja-api-operations',
  },
  TASK_OPERATIONS: {
    maxRetries: 3,
    initialDelay: 1000,
    maxDelay: 15000,
    backoffFactor: 2,
    enableCircuitBreaker: true,
    circuitBreakerName: 'vikunja-task-create',
  },
  BULK_OPERATIONS: {
    maxRetries: 2,
    initialDelay: 2000,
    maxDelay: 20000,
    backoffFactor: 1.5,
    enableCircuitBreaker: true,
    circuitBreakerName: 'vikunja-bulk-operations',
  },
} as const;

/**
 * Circuit breaker name constants for consistent naming across the application
 */
export const CIRCUIT_BREAKER_NAMES = {
  AUTH_CONNECT: 'vikunja-auth-connect',
  AUTH_REFRESH: 'vikunja-auth-refresh',
  AUTH_STATUS: 'vikunja-auth-status',
  API_OPERATIONS: 'vikunja-api-operations',
  CLIENT_OPERATIONS: 'vikunja-client-operations',
  FILTER_OPERATIONS: 'vikunja-filter-operations',
  TASK_CREATE: 'vikunja-task-create',
  TASK_UPDATE: 'vikunja-task-update',
  TASK_DELETE: 'vikunja-task-delete',
  TASK_GET: 'vikunja-task-get',
  TASK_LIST: 'vikunja-task-list',
  TASK_RELATIONS: 'vikunja-task-relations',
  TASK_ASSIGNEES: 'vikunja-task-assignees',
  TASK_LABELS: 'vikunja-task-labels',
  PROJECT_CRUD: 'vikunja-project-crud',
  PROJECT_HIERARCHY: 'vikunja-project-hierarchy',
  PROJECT_SHARING: 'vikunja-project-sharing',
  BULK_OPERATIONS: 'vikunja-bulk-operations',
  BULK_IMPORT: 'vikunja-bulk-import',
  BULK_EXPORT: 'vikunja-bulk-export',
} as const;

/**
 * Execute task operations with task-specific circuit breaker
 */
export async function withTaskRetry<T>(
  operation: () => Promise<T>,
  operationType: 'create' | 'update' | 'delete' | 'get',
  options: RetryOptions = {},
): Promise<T> {
  const name = `vikunja-task-${operationType}`;
  return withNamedRetry(operation, name, options);
}

/**
 * Execute bulk operations with bulk-specific circuit breaker
 */
export async function withBulkRetry<T>(
  operation: () => Promise<T>,
  operationType: 'import' | 'export',
  options: RetryOptions = {},
): Promise<T> {
  const name = `vikunja-bulk-${operationType}`;
  return withNamedRetry(operation, name, options);
}
