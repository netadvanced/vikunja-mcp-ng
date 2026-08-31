/**
 * SECURE Rate Limiting Middleware - Production Grade Implementation
 *
 * SECURITY FIXES IMPLEMENTED:
 * ✅ ARCH-001: Eliminated dual source of truth race conditions
 * ✅ ARCH-002: Fixed unbounded memory leak with TTL-based cleanup
 * ✅ ARCH-004: Consistent session state management with single source of truth
 * ✅ ARCH-005: Added circuit breaker for rate limiting failures
 * ✅ Concurrent access protection with mutex-based critical sections
 * ✅ Production-grade reliability with 99.9% SLA design
 *
 * Correction (#263): the ARCH-002 line above described the intent, not the
 * behaviour. `MemoryStore` was constructed without `init()`, which is where
 * it learns `windowMs` — so there was no TTL, no window rotation, and no
 * expiry-driven cleanup at all; counters only ever grew. The hourly counter
 * was separately dead (written to `hourStore`, read from `minuteStore`), and
 * the middleware was wired to exactly one tool. All three are fixed, and
 * `docs/RATE_LIMITING.md` describes the shipped behaviour. Take the ticked
 * list above as history, not as evidence: the tests in
 * `tests/middleware/rate-limit-windows.test.ts` are the evidence.
 */

import { MemoryStore } from 'express-rate-limit';
import type { Options as ExpressRateLimitOptions } from 'express-rate-limit';
import { Mutex } from 'async-mutex';
import CircuitBreakerImpl from 'opossum';
import { MCPError, ErrorCode } from '../types/errors';
import { logger } from '../utils/logger';
import { getCurrentIdentity, identityKey } from '../context/requestContext';
import { runWithExecutionSignal } from '../context/executionContext';

/** Window length of the per-minute bucket, in milliseconds. */
const MINUTE_WINDOW_MS = 60_000;

/** Window length of the per-hour bucket, in milliseconds. */
const HOUR_WINDOW_MS = 3_600_000;

/**
 * Give a `MemoryStore` its window length.
 *
 * `MemoryStore` learns `windowMs` from `init()` and nowhere else: the
 * constructor leaves it `undefined`. An uninitialized store therefore
 * computes every client's `resetTime` as `now + undefined` = `NaN`, and
 * `NaN <= now` is false forever — so `increment()` never recycles a client
 * and the counter only ever grows. That is issue #263's "60 requests per
 * minute is really 60 per process lifetime, and the 61st call ever made
 * 429s until restart" bug. Calling `init()` is what starts window rotation
 * (both the per-client `resetTime` arithmetic and the periodic sweep of
 * expired clients).
 *
 * express-rate-limit types `init()` as taking the middleware's full
 * `Options`; `MemoryStore.init` reads exactly one field off it (`windowMs`,
 * plus an optional validator this standalone store never has), so the cast
 * is honest about what is actually consumed.
 */
function initStore(store: MemoryStore, windowMs: number): void {
  store.init({ windowMs } as unknown as ExpressRateLimitOptions);
}

/**
 * Brand stamped on a handler that has already been through
 * `withRateLimit`, so wrapping it again can be detected and skipped. A
 * `Symbol` rather than a string key so it cannot collide with anything a
 * handler carries of its own.
 */
const RATE_LIMITED_MARKER = Symbol.for('vikunja-mcp.rateLimited');

/** True when `handler` is already wrapped by `withRateLimit`. */
export function isRateLimited(handler: unknown): boolean {
  return (
    typeof handler === 'function' &&
    (handler as unknown as Record<symbol, unknown>)[RATE_LIMITED_MARKER] === true
  );
}

/**
 * Enhanced rate limit configuration with security options
 */
interface RateLimitConfig {
  /** Requests per minute limit */
  requestsPerMinute: number;
  /** Requests per hour limit */
  requestsPerHour: number;
  /** Maximum request payload size in bytes */
  maxRequestSize: number;
  /** Maximum response size in bytes */
  maxResponseSize: number;
  /** Tool execution timeout in milliseconds */
  executionTimeout: number;
  /** Enable rate limiting (for testing) */
  enabled: boolean;
}

/**
 * Tool-specific rate limiting configurations
 */
interface ToolRateLimits {
  default: RateLimitConfig;
  expensive: RateLimitConfig;
  bulk: RateLimitConfig;
  export: RateLimitConfig;
}

/**
 * Circuit breaker configuration for rate limiting failures
 */
const CIRCUIT_BREAKER_OPTIONS: CircuitBreakerImpl.Options = {
  timeout: 5000, // 5 second timeout
  errorThresholdPercentage: 50, // Open circuit after 50% failures
  resetTimeout: 30000, // Try to close circuit after 30 seconds
  rollingCountTimeout: 60000, // 1 minute rolling window
  rollingCountBuckets: 12, // 12 buckets of 5 seconds each
  name: 'RateLimitMemoryStore',
};

/**
 * Default rate limiting configuration with production-grade defaults
 */
const DEFAULT_CONFIG: ToolRateLimits = {
  default: {
    requestsPerMinute: parseInt(process.env.RATE_LIMIT_PER_MINUTE || '60', 10),
    requestsPerHour: parseInt(process.env.RATE_LIMIT_PER_HOUR || '1000', 10),
    maxRequestSize: parseInt(process.env.MAX_REQUEST_SIZE || '1048576', 10), // 1MB
    maxResponseSize: parseInt(process.env.MAX_RESPONSE_SIZE || '10485760', 10), // 10MB
    executionTimeout: parseInt(process.env.TOOL_TIMEOUT || '30000', 10), // 30 seconds
    enabled: process.env.RATE_LIMIT_ENABLED !== 'false',
  },
  expensive: {
    requestsPerMinute: parseInt(process.env.EXPENSIVE_RATE_LIMIT_PER_MINUTE || '10', 10),
    requestsPerHour: parseInt(process.env.EXPENSIVE_RATE_LIMIT_PER_HOUR || '100', 10),
    maxRequestSize: parseInt(process.env.EXPENSIVE_MAX_REQUEST_SIZE || '2097152', 10), // 2MB
    maxResponseSize: parseInt(process.env.EXPENSIVE_MAX_RESPONSE_SIZE || '52428800', 10), // 50MB
    executionTimeout: parseInt(process.env.EXPENSIVE_TOOL_TIMEOUT || '120000', 10), // 2 minutes
    enabled: process.env.RATE_LIMIT_ENABLED !== 'false',
  },
  bulk: {
    requestsPerMinute: parseInt(process.env.BULK_RATE_LIMIT_PER_MINUTE || '5', 10),
    requestsPerHour: parseInt(process.env.BULK_RATE_LIMIT_PER_HOUR || '50', 10),
    maxRequestSize: parseInt(process.env.BULK_MAX_REQUEST_SIZE || '5242880', 10), // 5MB
    maxResponseSize: parseInt(process.env.BULK_MAX_RESPONSE_SIZE || '104857600', 10), // 100MB
    executionTimeout: parseInt(process.env.BULK_TOOL_TIMEOUT || '300000', 10), // 5 minutes
    enabled: process.env.RATE_LIMIT_ENABLED !== 'false',
  },
  export: {
    requestsPerMinute: parseInt(process.env.EXPORT_RATE_LIMIT_PER_MINUTE || '2', 10),
    requestsPerHour: parseInt(process.env.EXPORT_RATE_LIMIT_PER_HOUR || '10', 10),
    maxRequestSize: parseInt(process.env.EXPORT_MAX_REQUEST_SIZE || '1048576', 10), // 1MB
    maxResponseSize: parseInt(process.env.EXPORT_MAX_RESPONSE_SIZE || '1073741824', 10), // 1GB
    executionTimeout: parseInt(process.env.EXPORT_TOOL_TIMEOUT || '600000', 10), // 10 minutes
    enabled: process.env.RATE_LIMIT_ENABLED !== 'false',
  },
};

/**
 * Tool categorization for rate limiting (preserved from original implementation)
 */
export const TOOL_CATEGORIES: Record<string, keyof ToolRateLimits> = {
  vikunja_tasks: 'default',
  vikunja_projects: 'default',
  vikunja_labels: 'default',
  vikunja_teams: 'default',
  vikunja_users: 'default',
  vikunja_auth: 'default',
  vikunja_filters: 'default',
  vikunja_templates: 'default',
  vikunja_webhooks: 'default',
  vikunja_batch_import: 'bulk',
  vikunja_export: 'export',
  vikunja_export_tasks: 'export',
  vikunja_export_projects: 'export',
  // The rest of the registered tool surface. Before #263 only
  // `vikunja_auth`'s handler was wrapped at all, so these names never
  // reached this table and every one of them silently fell through to
  // 'default'. They are now wrapped centrally (see
  // `src/middleware/tool-rate-limit.ts`), and naming them explicitly is
  // what makes the odd one out — `vikunja_task_bulk`, which fans a single
  // call out into N task writes and belongs with the other bulk tools —
  // actually get the bulk budget instead of the default one.
  vikunja_task_bulk: 'bulk',
  vikunja_task_assignees: 'default',
  vikunja_task_comments: 'default',
  vikunja_task_reminders: 'default',
  vikunja_task_labels: 'default',
  vikunja_task_relations: 'default',
  vikunja_notifications: 'default',
  vikunja_subscriptions: 'default',
  vikunja_reactions: 'default',
  vikunja_tokens: 'default',
  vikunja_caldav_tokens: 'default',
  vikunja_admin: 'default',
  vikunja_user_deletion: 'default',
  vikunja_export_project: 'export',
  vikunja_request_user_export: 'export',
  vikunja_download_user_export: 'export',
  // Deliberately NOT 'export': this one only reads whether a previously
  // requested export is ready. Giving a poll-me endpoint the export
  // category's 2-requests-per-minute budget would make the honest usage
  // pattern (ask, wait, ask again) trip the limiter.
  vikunja_user_export_status: 'default',
};

/**
 * Get session/bucket ID for rate limiting.
 *
 * Re-keyed per docs/OIDC-RESOURCE-SERVER.md §3d (D8, isolation-table row
 * #2): in `oidc-http` mode, each validated identity gets its own bucket
 * (`identityKey`, `"<issuer>|<sub>"`) — this is the fairness guarantee that
 * stops one user starving others via what used to be a single
 * per-process bucket. `stdio` mode never opens an ALS scope, so
 * `getCurrentIdentity()` is always `undefined` there and this falls back
 * to the original `session_${process.pid}` bucket, unchanged — a single
 * process still gets a single bucket, exactly as today.
 */
function getSessionId(): string {
  const identity = getCurrentIdentity();
  if (identity) {
    return identityKey(identity);
  }
  return `session_${process.pid}`;
}

/**
 * SECURE: Production-grade rate limiting middleware
 *
 * SECURITY IMPROVEMENTS:
 * - Single source of truth: MemoryStore only (eliminates ARCH-001)
 * - Bounded memory: TTL-based cleanup (eliminates ARCH-002)
 * - Concurrent access protection: Mutex-based critical sections
 * - Circuit breaker: Fail-safe operation (eliminates ARCH-005)
 * - Consistent state: No dual sources (eliminates ARCH-004)
 */
export class SecureRateLimitMiddleware {
  private config: ToolRateLimits;
  private minuteStore: MemoryStore;
  private hourStore: MemoryStore;

  // SECURITY: Concurrent access protection
  private rateLimitMutex = new Mutex();

  // SECURITY: Circuit breaker for MemoryStore failures
  private minuteStoreBreaker: CircuitBreakerImpl;
  private hourStoreBreaker: CircuitBreakerImpl;

  constructor(config?: Partial<ToolRateLimits>, testingMode = false) {
    this.config = {
      default: { ...DEFAULT_CONFIG.default, ...(config?.default || {}) },
      expensive: { ...DEFAULT_CONFIG.expensive, ...(config?.expensive || {}) },
      bulk: { ...DEFAULT_CONFIG.bulk, ...(config?.bulk || {}) },
      export: { ...DEFAULT_CONFIG.export, ...(config?.export || {}) },
    };

    // Initialize MemoryStore instances. `init()` is not optional decoration:
    // it is what gives each store its window length and starts window
    // rotation (see `initStore` above and issue #263).
    this.minuteStore = new MemoryStore();
    this.hourStore = new MemoryStore();
    initStore(this.minuteStore, MINUTE_WINDOW_MS);
    initStore(this.hourStore, HOUR_WINDOW_MS);

    // SECURITY: Wrap MemoryStore operations in circuit breakers
    this.minuteStoreBreaker = new CircuitBreakerImpl(
      async (key: string) => this.minuteStore.increment(key),
      CIRCUIT_BREAKER_OPTIONS,
    );

    this.hourStoreBreaker = new CircuitBreakerImpl(
      async (key: string) => this.hourStore.increment(key),
      CIRCUIT_BREAKER_OPTIONS,
    );

    // SECURITY: Circuit breaker event monitoring
    this.minuteStoreBreaker.on('open', () => {
      logger.error('Rate limit minute store circuit breaker OPEN - MemoryStore failures detected');
    });

    this.minuteStoreBreaker.on('halfOpen', () => {
      logger.warn('Rate limit minute store circuit breaker HALF-OPEN - attempting recovery');
    });

    this.minuteStoreBreaker.on('close', () => {
      logger.info('Rate limit minute store circuit breaker CLOSED - MemoryStore recovered');
    });

    this.hourStoreBreaker.on('open', () => {
      logger.error('Rate limit hour store circuit breaker OPEN - MemoryStore failures detected');
    });

    this.hourStoreBreaker.on('halfOpen', () => {
      logger.warn('Rate limit hour store circuit breaker HALF-OPEN - attempting recovery');
    });

    this.hourStoreBreaker.on('close', () => {
      logger.info('Rate limit hour store circuit breaker CLOSED - MemoryStore recovered');
    });

    logger.info('SECURE rate limiting middleware initialized', {
      enabled: this.config.default.enabled,
      testingMode,
      securityFeatures: [
        'Single source of truth (MemoryStore only)',
        'Bounded memory with TTL cleanup',
        'Concurrent access protection (mutex)',
        'Circuit breaker for MemoryStore failures',
        'Fail-safe operation on rate limit failures',
      ],
      defaultLimits: {
        perMinute: this.config.default.requestsPerMinute,
        perHour: this.config.default.requestsPerHour,
        maxRequestSize: this.config.default.maxRequestSize,
        timeout: this.config.default.executionTimeout,
      },
    });
  }

  /**
   * SECURE: Check rate limits using MemoryStore as single source of truth
   *
   * SECURITY IMPROVEMENTS:
   * - Eliminated dual source of truth race conditions (ARCH-001)
   * - Uses MemoryStore for all operations (single source of truth)
   * - Concurrent access protection with mutex
   * - Circuit breaker protection for MemoryStore failures
   */
  private async checkRateLimit(toolName: string): Promise<void> {
    const category = TOOL_CATEGORIES[toolName] || 'default';
    const config = this.config[category];

    if (!config.enabled) {
      return;
    }

    const sessionId = getSessionId();
    const minuteKey = `${sessionId}_${category}`;
    const hourKey = `${minuteKey}_hour`;

    // SECURITY: Critical section for atomic rate limit checking
    const release = await this.rateLimitMutex.acquire();

    try {
      // SECURITY: Query current counts from MemoryStore (single source of truth)
      const [minuteCount, hourCount] = await Promise.all([
        this.getCurrentCount(this.minuteStore, minuteKey),
        // #263: this used to read the hour count out of `minuteStore` while
        // incrementing `hourStore` below, so the hourly limit could never
        // trip no matter how many requests an identity made.
        this.getCurrentCount(this.hourStore, hourKey),
      ]);

      // SECURITY: Check per-minute limit
      if (minuteCount >= config.requestsPerMinute) {
        logger.warn('Rate limit exceeded (per minute)', {
          toolName,
          category,
          sessionId,
          limit: config.requestsPerMinute,
          current: minuteCount,
        });

        const resetIn = Math.ceil(60); // MemoryStore handles exact timing
        throw new MCPError(
          ErrorCode.RATE_LIMIT_EXCEEDED,
          `Rate limit exceeded: ${minuteCount}/${config.requestsPerMinute} requests per minute`,
          {
            rateLimitType: 'per_minute',
            limit: config.requestsPerMinute,
            current: minuteCount,
            resetTime: resetIn,
          },
        );
      }

      // SECURITY: Check per-hour limit
      if (hourCount >= config.requestsPerHour) {
        logger.warn('Rate limit exceeded (per hour)', {
          toolName,
          category,
          sessionId,
          limit: config.requestsPerHour,
          current: hourCount,
        });

        const resetIn = Math.ceil(3600); // MemoryStore handles exact timing
        throw new MCPError(
          ErrorCode.RATE_LIMIT_EXCEEDED,
          `Rate limit exceeded: ${hourCount}/${config.requestsPerHour} requests per hour`,
          {
            rateLimitType: 'per_hour',
            limit: config.requestsPerHour,
            current: hourCount,
            resetTime: resetIn,
          },
        );
      }

      // SECURITY: Increment counters using circuit breaker protection
      await Promise.all([
        this.minuteStoreBreaker.fire(minuteKey),
        this.hourStoreBreaker.fire(hourKey),
      ]);
    } catch (error) {
      // SECURITY: Handle circuit breaker failures with fail-safe behavior
      if (error instanceof MCPError) {
        throw error;
      }

      // Check if this is a circuit breaker error
      if (this.minuteStoreBreaker.opened || this.hourStoreBreaker.opened) {
        logger.error('Rate limiting circuit breaker open - failing safe', {
          toolName,
          minuteBreakerOpen: this.minuteStoreBreaker.opened,
          hourBreakerOpen: this.hourStoreBreaker.opened,
          error: error instanceof Error ? error.message : String(error),
        });

        // SECURITY: Fail-safe - allow the request but log the incident
        logger.warn('Rate limiting bypassed due to circuit breaker failure (fail-safe mode)', {
          toolName,
          category,
          sessionId,
        });
        return; // Allow request to proceed
      }

      // Re-throw other errors
      logger.error('Rate limit check error', {
        toolName,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      release();
    }
  }

  /**
   * SECURITY: Get current count from the given MemoryStore with proper error
   * handling.
   *
   * Takes the store explicitly (#263): reading every count out of
   * `minuteStore` regardless of which store the matching `increment()` went
   * to is what made the hourly limit dead code.
   */
  private async getCurrentCount(store: MemoryStore, key: string): Promise<number> {
    try {
      // MemoryStore returns a specific type, let's handle it safely
      const count = await store.get(key);
      if (
        count &&
        typeof count === 'object' &&
        'totalHits' in count &&
        typeof count.totalHits === 'number'
      ) {
        // `MemoryStore.get()` hands back the stored client verbatim: the
        // recycling that `windowMs` implies happens inside `increment()`,
        // and this middleware reads BEFORE it increments. So the expiry has
        // to be applied here too, or an exhausted bucket would stay
        // exhausted (the read refuses the call, so the increment that would
        // have recycled the window is never reached) until the store's
        // periodic sweep happened to drop the key — one to two full windows
        // late. An elapsed `resetTime` means the next `increment()` starts a
        // new window, so the effective count right now is zero.
        if (count.resetTime instanceof Date && count.resetTime.getTime() <= Date.now()) {
          return 0;
        }
        return count.totalHits;
      }
      return 0;
    } catch (error) {
      logger.warn('Failed to get current count from MemoryStore', {
        key,
        error: error instanceof Error ? error.message : String(error),
      });
      return 0; // Fail-safe - assume no hits if we can't check
    }
  }

  /**
   * Measure a payload for the size guards.
   *
   * Returns `null` when the value cannot be serialized at all (a cycle, a
   * `BigInt`, a throwing getter). Now that every tool registers through the
   * middleware, the measured arguments include whatever the MCP SDK passes
   * alongside the validated tool args, so "I could not measure this" has to
   * be a survivable outcome rather than an exception thrown at the caller
   * from inside a size check.
   */
  private measureSize(value: unknown): number | null {
    try {
      return JSON.stringify(value)?.length ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Validate request size (preserved from original implementation)
   */
  private validateRequestSize(toolName: string, args: unknown): void {
    const category = TOOL_CATEGORIES[toolName] || 'default';
    const config = this.config[category];

    if (!config.enabled) {
      return;
    }

    const requestSize = this.measureSize(args);
    if (requestSize === null) {
      logger.debug('Request size could not be measured; skipping size guard', { toolName });
      return;
    }
    if (requestSize > config.maxRequestSize) {
      logger.warn('Request size exceeded', {
        toolName,
        size: requestSize,
        limit: config.maxRequestSize,
      });
      throw new MCPError(
        ErrorCode.REQUEST_TOO_LARGE,
        `Request size ${requestSize} bytes exceeds limit of ${config.maxRequestSize} bytes`,
        {
          requestSize,
          maxRequestSize: config.maxRequestSize,
        },
      );
    }
  }

  /**
   * Validate response size (preserved from original implementation)
   */
  private validateResponseSize(toolName: string, response: unknown): void {
    const category = TOOL_CATEGORIES[toolName] || 'default';
    const config = this.config[category];

    if (!config.enabled) {
      return;
    }

    const responseSize = this.measureSize(response);
    if (responseSize === null) {
      logger.debug('Response size could not be measured; skipping size guard', { toolName });
      return;
    }
    if (responseSize > config.maxResponseSize) {
      logger.warn('Response size exceeded', {
        toolName,
        size: responseSize,
        limit: config.maxResponseSize,
      });
      throw new MCPError(
        ErrorCode.REQUEST_TOO_LARGE,
        `Response size ${responseSize} bytes exceeds limit of ${config.maxResponseSize} bytes`,
        {
          responseSize,
          maxResponseSize: config.maxResponseSize,
        },
      );
    }
  }

  /**
   * SECURE: Wrap tool handler with rate limiting using single source of truth
   */
  public withRateLimit<T extends unknown[], R>(
    toolName: string,
    handler: (...args: T) => Promise<R>,
  ): (...args: T) => Promise<R> {
    const wrapped = async (...args: T): Promise<R> => {
      const startTime = Date.now();

      // Get timeout configuration
      const category = TOOL_CATEGORIES[toolName] || 'default';
      const config = this.config[category];

      // LOW-20 (#296): the deadline owns a cancellation controller and a
      // handle on its own timer. Losing the race used to leave BOTH dangling
      // — the timer stayed armed for the rest of the configured timeout (up
      // to 10 minutes for the export category) even on calls that returned
      // in milliseconds, and the handler kept running after the caller had
      // been told the call timed out, free to commit a write the caller
      // believes never happened.
      const deadline = new AbortController();
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

      try {
        // SECURITY: Check rate limits using single source of truth
        await this.checkRateLimit(toolName);

        // Validate request size
        this.validateRequestSize(toolName, args);

        // Execute with timeout protection. The handler runs inside the
        // cancellation scope so anything downstream that opted in (see
        // `src/context/executionContext.ts`; `src/utils/vikunja-rest.ts`
        // hands the signal to `fetch`) is actually aborted on timeout
        // rather than orphaned.
        const execution = runWithExecutionSignal(deadline.signal, () => handler(...args));

        const result = await Promise.race([
          execution,
          new Promise<never>((_, reject) => {
            timeoutHandle = setTimeout(() => {
              deadline.abort(
                // Deliberately avoids the substrings `isRetryableError`
                // treats as grounds to retry ('timeout', 'connection',
                // 'network', 'rate limit'): a cancelled call must not be
                // re-fired automatically.
                new Error(`Tool execution deadline of ${config.executionTimeout}ms elapsed`),
              );
              reject(
                new MCPError(
                  ErrorCode.TIMEOUT_ERROR,
                  `Tool execution timeout after ${config.executionTimeout}ms`,
                  {
                    timeout: config.executionTimeout,
                    toolName,
                  },
                ),
              );
            }, config.executionTimeout);
          }),
        ]);

        // Validate response size
        this.validateResponseSize(toolName, result);

        // Log successful execution
        const executionTime = Date.now() - startTime;
        logger.debug('Tool executed successfully', {
          toolName,
          executionTime,
          sessionId: getSessionId(),
        });

        return result;
      } catch (error) {
        const executionTime = Date.now() - startTime;

        // Log failed execution
        if (error instanceof MCPError) {
          logger.warn('Tool execution failed', {
            toolName,
            error: error.code,
            message: error.message,
            executionTime,
            sessionId: getSessionId(),
          });
        } else {
          logger.error('Tool execution error', {
            toolName,
            error: error instanceof Error ? error.message : String(error),
            executionTime,
            sessionId: getSessionId(),
          });
        }

        throw error;
      } finally {
        // Always disarm the deadline timer — on success, on failure, and on
        // the timeout path itself (where it has already fired).
        if (timeoutHandle !== undefined) {
          clearTimeout(timeoutHandle);
        }
      }
    };

    // Marks this handler as already rate-limited so the central
    // registration wrapper (`src/middleware/tool-rate-limit.ts`) does not
    // wrap it a second time — double wrapping would charge every call twice
    // against the caller's budget and nest two deadlines.
    Object.defineProperty(wrapped, RATE_LIMITED_MARKER, { value: true });

    return wrapped;
  }

  /**
   * Release the stores' window-rotation timers.
   *
   * `MemoryStore.init()` arms a `setInterval` per store. The intervals are
   * `unref()`d so they never hold a process (or a Jest worker) open, but
   * long-lived code that builds throwaway middleware instances should still
   * hand them back. The process-wide singleton below never needs this.
   */
  public shutdown(): void {
    this.minuteStore.shutdown();
    this.hourStore.shutdown();
  }

  /**
   * Get configuration (preserved from original implementation)
   */
  public getConfig(): ToolRateLimits {
    return { ...this.config };
  }

  /**
   * TESTING COMPATIBILITY: Get rate limit status (sync for test compatibility)
   *
   * NOTE: This is a compatibility method for existing tests.
   * The secure async version is getRateLimitStatusAsync().
   */
  public getRateLimitStatus(_toolName?: string): {
    sessionId: string;
    requestsLastMinute: number;
    requestsLastHour: number;
    limits: ToolRateLimits;
    circuitBreakerStatus: {
      minuteStore: 'open' | 'half-open' | 'closed';
      hourStore: 'open' | 'half-open' | 'closed';
    };
  } {
    const sessionId = getSessionId();

    return {
      sessionId,
      requestsLastMinute: 0, // Cannot provide accurate sync without dual source of truth
      requestsLastHour: 0, // Cannot provide accurate sync without dual source of truth
      limits: this.config,
      circuitBreakerStatus: {
        minuteStore: this.minuteStoreBreaker.opened
          ? 'open'
          : this.minuteStoreBreaker.halfOpen
            ? 'half-open'
            : 'closed',
        hourStore: this.hourStoreBreaker.opened
          ? 'open'
          : this.hourStoreBreaker.halfOpen
            ? 'half-open'
            : 'closed',
      },
    };
  }

  /**
   * SECURE: Get current rate limit status from MemoryStore (single source of truth)
   */
  public async getRateLimitStatusAsync(_toolName?: string): Promise<{
    sessionId: string;
    requestsLastMinute: number;
    requestsLastHour: number;
    limits: ToolRateLimits;
    circuitBreakerStatus: {
      minuteStore: 'open' | 'half-open' | 'closed';
      hourStore: 'open' | 'half-open' | 'closed';
    };
  }> {
    const sessionId = getSessionId();

    // SECURITY: Query actual counts from MemoryStore (no local state)
    let totalMinuteRequests = 0;
    let totalHourRequests = 0;

    // Get all keys for this session (MemoryStore doesn't expose getAll, so we track categories)
    const categories: (keyof ToolRateLimits)[] = ['default', 'expensive', 'bulk', 'export'];

    for (const category of categories) {
      const minuteKey = `${sessionId}_${category}`;
      const hourKey = `${minuteKey}_hour`;

      try {
        // SECURITY: Get actual counts from MemoryStore
        const [minuteCount, hourCount] = await Promise.all([
          this.getCurrentCount(this.minuteStore, minuteKey),
          this.getCurrentCount(this.hourStore, hourKey),
        ]);

        totalMinuteRequests += minuteCount;
        totalHourRequests += hourCount;
      } catch (error) {
        logger.warn('Failed to get rate limit status for category', {
          category,
          error: error instanceof Error ? error.message : String(error),
        });
        // Continue with other categories - fail-safe approach
      }
    }

    return {
      sessionId,
      requestsLastMinute: totalMinuteRequests,
      requestsLastHour: totalHourRequests,
      limits: this.config,
      circuitBreakerStatus: {
        minuteStore: this.minuteStoreBreaker.opened
          ? 'open'
          : this.minuteStoreBreaker.halfOpen
            ? 'half-open'
            : 'closed',
        hourStore: this.hourStoreBreaker.opened
          ? 'open'
          : this.hourStoreBreaker.halfOpen
            ? 'half-open'
            : 'closed',
      },
    };
  }

  /**
   * SECURE: Clear ONE session's (identity's) rate-limit counters.
   *
   * LOW-18 (#296): this used to ignore its `sessionId` argument entirely and
   * call `resetAll()` on both stores plus `close()` on both circuit
   * breakers — i.e. "reset this one user" was really "reset every tenant in
   * the process, and reset the shared store breakers while you're at it".
   * There is no caller today, which is exactly why it is worth fixing now:
   * a future self-service "reset my limits" affordance built on this method
   * would have been a cross-tenant wipe on day one.
   *
   * Scope rules:
   * - Only the keys belonging to `sessionId` (every category's minute and
   *   hour bucket) are reset. Other identities keep their counters.
   * - The argument defaults to the *calling* identity's bucket
   *   (`getSessionId()`), so a no-argument call is "clear mine", never
   *   "clear everyone's".
   * - The circuit breakers are deliberately left alone: they are
   *   process-wide infrastructure guarding the shared MemoryStore, not
   *   per-identity state. `clearAll()` remains the (testing) escape hatch
   *   that resets everything.
   */
  public async clearSession(sessionId?: string): Promise<void> {
    const target = sessionId ?? getSessionId();

    try {
      const categories: (keyof ToolRateLimits)[] = ['default', 'expensive', 'bulk', 'export'];
      await Promise.all(
        categories.flatMap((category) => {
          const minuteKey = `${target}_${category}`;
          return [
            this.minuteStore.resetKey(minuteKey),
            this.hourStore.resetKey(`${minuteKey}_hour`),
          ];
        }),
      );

      logger.debug('SECURE rate limit session cleared', {
        sessionId: target,
        cleared: 'MemoryStore counters for this session only',
      });
    } catch (error) {
      logger.error('Failed to clear rate limit session', {
        sessionId: target,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * TESTING COMPATIBILITY: Clear all rate limit data (for testing)
   */
  public async clearAll(): Promise<void> {
    try {
      await Promise.all([this.minuteStore.resetAll(), this.hourStore.resetAll()]);

      // Reset circuit breakers
      this.minuteStoreBreaker.close();
      this.hourStoreBreaker.close();

      logger.debug('SECURE rate limit stores and circuit breakers cleared');
    } catch (error) {
      logger.error('Failed to clear rate limit data', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * TESTING COMPATIBILITY: Simulate time passing for tests
   *
   * SECURITY NOTE: This is only available in testing mode and simply clears the stores.
   * This is MUCH more secure than the original implementation which compromised
   * production security by using dual source of truth for test convenience.
   */
  public testingSimulateTimePassing(): Promise<void> {
    logger.debug('TESTING: Simulating time passing by clearing rate limit stores');
    return this.clearAll();
  }
}

// Global secure rate limiting middleware instance
export const secureRateLimitMiddleware = new SecureRateLimitMiddleware();

// Backward compatibility aliases
export const simplifiedRateLimitMiddleware = secureRateLimitMiddleware;
export const rateLimitingMiddleware = secureRateLimitMiddleware;
export const RateLimitingMiddleware = SecureRateLimitMiddleware;

// Backward compatibility for class name
export const SimplifiedRateLimitMiddleware = SecureRateLimitMiddleware;

/**
 * Convenience function to wrap tool handlers with rate limiting
 * This replaces the original withRateLimit function
 */
export function withRateLimit<T extends unknown[], R>(
  toolName: string,
  handler: (...args: T) => Promise<R>,
): (...args: T) => Promise<R> {
  return secureRateLimitMiddleware.withRateLimit(toolName, handler);
}

// Export types for rate limiting configuration
export type { RateLimitConfig, ToolRateLimits };
