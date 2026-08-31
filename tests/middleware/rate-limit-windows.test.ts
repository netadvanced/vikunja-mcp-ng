/**
 * Regression tests for issue #263 (CRIT-2) and #296 LOW-18 / LOW-20 on the
 * per-identity rate limiter.
 *
 * Each block here fails on the pre-fix middleware:
 *  - window rotation: `MemoryStore` was never `init()`ed, so `windowMs` was
 *    `undefined`, every client's `resetTime` was `NaN`, and no counter ever
 *    rotated — "60 per minute" was really "60 per process lifetime", and the
 *    61st call ever made 429'd until restart.
 *  - hourly limit: incremented into `hourStore` but read back out of
 *    `minuteStore`, so it could never trip.
 *  - `clearSession(id)`: ignored its argument and reset every identity.
 *  - execution deadline: the timer was never cleared and losing the race did
 *    nothing to the handler.
 *
 * Timer note: middleware instances are always constructed BEFORE
 * `jest.useFakeTimers()`, so the stores' own window-sweep intervals stay
 * real. What the fake clock then controls is `Date.now()` (which is what
 * decides whether a bucket's window has elapsed) and the deadline timer.
 */

import { SecureRateLimitMiddleware } from '../../src/middleware/simplified-rate-limit';
import { getExecutionAbortSignal } from '../../src/context/executionContext';
import { runWithRequestContext, identityKey } from '../../src/context/requestContext';
import type { Identity } from '../../src/context/requestContext';
import { AuthManager } from '../../src/auth/AuthManager';
import { ErrorCode } from '../../src/types/errors';

const identityA: Identity = { issuer: 'https://idp.example/realm', sub: 'user-a' };
const identityB: Identity = { issuer: 'https://idp.example/realm', sub: 'user-b' };

function authManagerFor(sub: string): AuthManager {
  const authManager = new AuthManager();
  authManager.connect('https://vikunja.example/api/v1', `tk_${sub}-token-1234567890`);
  return authManager;
}

function middlewareWith(
  overrides: Partial<{
    requestsPerMinute: number;
    requestsPerHour: number;
    executionTimeout: number;
  }>,
): SecureRateLimitMiddleware {
  return new SecureRateLimitMiddleware(
    {
      default: {
        requestsPerMinute: 3,
        requestsPerHour: 1000,
        maxRequestSize: 1_000_000,
        maxResponseSize: 1_000_000,
        executionTimeout: 5000,
        enabled: true,
        ...overrides,
      },
      bulk: {
        requestsPerMinute: 50,
        requestsPerHour: 1000,
        maxRequestSize: 1_000_000,
        maxResponseSize: 1_000_000,
        executionTimeout: 5000,
        enabled: true,
      },
    },
    true,
  );
}

const runAs = <T>(identity: Identity, fn: () => Promise<T>): Promise<T> =>
  runWithRequestContext({ identity, authManager: authManagerFor(identity.sub) }, fn);

describe('rate limiter: real window rotation (#263)', () => {
  let middleware: SecureRateLimitMiddleware;

  afterEach(() => {
    jest.useRealTimers();
    middleware.shutdown();
  });

  it('rotates the per-minute window: an exhausted bucket recovers after 60s', async () => {
    middleware = middlewareWith({ requestsPerMinute: 3 });
    jest.useFakeTimers();

    const handler = jest.fn().mockResolvedValue('ok');
    const wrapped = middleware.withRateLimit('vikunja_tasks', handler);

    await wrapped({});
    await wrapped({});
    await wrapped({});

    // 4th call inside the same window is refused.
    await expect(wrapped({})).rejects.toEqual(
      expect.objectContaining({ code: ErrorCode.RATE_LIMIT_EXCEEDED }),
    );

    // Advance past the window without clearing any store by hand. Pre-fix
    // this stayed refused forever, because `resetTime` was NaN.
    jest.advanceTimersByTime(60_001);

    await expect(wrapped({})).resolves.toBe('ok');
    expect(handler).toHaveBeenCalledTimes(4);
  });

  it('does not rotate the per-minute window early (a partial window still counts)', async () => {
    middleware = middlewareWith({ requestsPerMinute: 2 });
    jest.useFakeTimers();

    const wrapped = middleware.withRateLimit('vikunja_tasks', jest.fn().mockResolvedValue('ok'));

    await wrapped({});
    await wrapped({});

    jest.advanceTimersByTime(30_000);

    await expect(wrapped({})).rejects.toEqual(
      expect.objectContaining({ code: ErrorCode.RATE_LIMIT_EXCEEDED }),
    );
  });

  it('enforces the hourly limit across several rotated minute windows', async () => {
    // Minute budget deliberately generous, hour budget small: the only way
    // to trip this is for the hour count to be read from the store it is
    // actually written to.
    middleware = middlewareWith({ requestsPerMinute: 100, requestsPerHour: 4 });
    jest.useFakeTimers();

    const handler = jest.fn().mockResolvedValue('ok');
    const wrapped = middleware.withRateLimit('vikunja_tasks', handler);

    for (let i = 0; i < 4; i++) {
      await wrapped({});
      // Each call lands in a fresh minute window; the hour bucket must not
      // rotate with it.
      jest.advanceTimersByTime(60_001);
    }

    await expect(wrapped({})).rejects.toEqual(
      expect.objectContaining({
        code: ErrorCode.RATE_LIMIT_EXCEEDED,
        message: expect.stringContaining('4/4 requests per hour'),
      }),
    );
    expect(handler).toHaveBeenCalledTimes(4);
  });

  it('rotates the per-hour window after an hour', async () => {
    middleware = middlewareWith({ requestsPerMinute: 100, requestsPerHour: 2 });
    jest.useFakeTimers();

    const wrapped = middleware.withRateLimit('vikunja_tasks', jest.fn().mockResolvedValue('ok'));

    await wrapped({});
    await wrapped({});
    await expect(wrapped({})).rejects.toEqual(
      expect.objectContaining({ code: ErrorCode.RATE_LIMIT_EXCEEDED }),
    );

    jest.advanceTimersByTime(3_600_001);

    await expect(wrapped({})).resolves.toBe('ok');
  });

  it('reports live per-window counts through getRateLimitStatusAsync', async () => {
    middleware = middlewareWith({ requestsPerMinute: 100, requestsPerHour: 100 });
    jest.useFakeTimers();

    const wrapped = middleware.withRateLimit('vikunja_tasks', jest.fn().mockResolvedValue('ok'));

    await wrapped({});
    await wrapped({});

    let status = await middleware.getRateLimitStatusAsync();
    expect(status.requestsLastMinute).toBe(2);
    expect(status.requestsLastHour).toBe(2);

    jest.advanceTimersByTime(60_001);
    await wrapped({});

    // The minute bucket rotated; the hour bucket kept accumulating.
    status = await middleware.getRateLimitStatusAsync();
    expect(status.requestsLastMinute).toBe(1);
    expect(status.requestsLastHour).toBe(3);
  });
});

describe('rate limiter: clearSession is scoped to one identity (LOW-18, #296)', () => {
  let middleware: SecureRateLimitMiddleware;

  beforeEach(() => {
    middleware = middlewareWith({ requestsPerMinute: 2 });
  });

  afterEach(() => {
    middleware.shutdown();
  });

  it("clearing A's counters leaves B's counters alone", async () => {
    const wrapped = middleware.withRateLimit('vikunja_tasks', jest.fn().mockResolvedValue('ok'));

    // Both identities exhaust their own bucket.
    await runAs(identityA, () => wrapped({}));
    await runAs(identityA, () => wrapped({}));
    await runAs(identityB, () => wrapped({}));
    await runAs(identityB, () => wrapped({}));

    await expect(runAs(identityA, () => wrapped({}))).rejects.toEqual(
      expect.objectContaining({ code: ErrorCode.RATE_LIMIT_EXCEEDED }),
    );
    await expect(runAs(identityB, () => wrapped({}))).rejects.toEqual(
      expect.objectContaining({ code: ErrorCode.RATE_LIMIT_EXCEEDED }),
    );

    // Reset A only.
    await middleware.clearSession(identityKey(identityA));

    await expect(runAs(identityA, () => wrapped({}))).resolves.toBe('ok');
    // Pre-fix this resolved too, because clearSession reset every identity.
    await expect(runAs(identityB, () => wrapped({}))).rejects.toEqual(
      expect.objectContaining({ code: ErrorCode.RATE_LIMIT_EXCEEDED }),
    );
  });

  it('defaults to the calling identity rather than to everyone', async () => {
    const wrapped = middleware.withRateLimit('vikunja_tasks', jest.fn().mockResolvedValue('ok'));

    await runAs(identityA, () => wrapped({}));
    await runAs(identityA, () => wrapped({}));
    await runAs(identityB, () => wrapped({}));
    await runAs(identityB, () => wrapped({}));

    // No argument, called inside A's context: clears A's bucket only.
    await runAs(identityA, () => middleware.clearSession());

    await expect(runAs(identityA, () => wrapped({}))).resolves.toBe('ok');
    await expect(runAs(identityB, () => wrapped({}))).rejects.toEqual(
      expect.objectContaining({ code: ErrorCode.RATE_LIMIT_EXCEEDED }),
    );
  });

  it('clears every category the identity owns, including the hour buckets', async () => {
    const wrapped = middleware.withRateLimit('vikunja_tasks', jest.fn().mockResolvedValue('ok'));
    const bulk = middleware.withRateLimit('vikunja_task_bulk', jest.fn().mockResolvedValue('ok'));

    await wrapped({});
    await wrapped({});
    await bulk({});
    await bulk({});
    await bulk({});

    let status = await middleware.getRateLimitStatusAsync();
    expect(status.requestsLastMinute).toBe(5);
    expect(status.requestsLastHour).toBe(5);

    await middleware.clearSession();

    status = await middleware.getRateLimitStatusAsync();
    expect(status.requestsLastMinute).toBe(0);
    expect(status.requestsLastHour).toBe(0);
  });

  it('surfaces store failures rather than silently reporting success', async () => {
    const stores = middleware as unknown as {
      minuteStore: { resetKey: (key: string) => Promise<void> };
    };
    jest.spyOn(stores.minuteStore, 'resetKey').mockRejectedValue(new Error('store unavailable'));

    await expect(middleware.clearSession('someone')).rejects.toThrow('store unavailable');
  });
});

describe('rate limiter: execution deadline cleanup and cancellation (LOW-20, #296)', () => {
  let middleware: SecureRateLimitMiddleware;

  afterEach(() => {
    jest.useRealTimers();
    middleware.shutdown();
  });

  it('clears the deadline timer when the handler wins the race', async () => {
    middleware = middlewareWith({ requestsPerMinute: 100 });
    jest.useFakeTimers();

    const wrapped = middleware.withRateLimit('vikunja_tasks', jest.fn().mockResolvedValue('ok'));

    await expect(wrapped({})).resolves.toBe('ok');

    // Pre-fix a 5s timer stayed armed after a call that returned instantly.
    expect(jest.getTimerCount()).toBe(0);
  });

  it('clears the deadline timer when the handler rejects', async () => {
    middleware = middlewareWith({ requestsPerMinute: 100 });
    jest.useFakeTimers();

    const wrapped = middleware.withRateLimit(
      'vikunja_tasks',
      jest.fn().mockRejectedValue(new Error('handler blew up')),
    );

    await expect(wrapped({})).rejects.toThrow('handler blew up');
    expect(jest.getTimerCount()).toBe(0);
  });

  it('clears the deadline timer on the timeout path itself', async () => {
    middleware = middlewareWith({ requestsPerMinute: 100, executionTimeout: 20 });

    const wrapped = middleware.withRateLimit('vikunja_tasks', () => new Promise(() => {}));

    await expect(wrapped({})).rejects.toEqual(
      expect.objectContaining({ code: ErrorCode.TIMEOUT_ERROR }),
    );
  });

  it('aborts the execution signal when the deadline elapses', async () => {
    middleware = middlewareWith({ requestsPerMinute: 100, executionTimeout: 20 });

    let observedSignal: AbortSignal | undefined;
    let resolveAbortReason: (reason: unknown) => void = () => {};
    const abortReason = new Promise<unknown>((resolve) => {
      resolveAbortReason = resolve;
    });

    const wrapped = middleware.withRateLimit('vikunja_tasks', async () => {
      observedSignal = getExecutionAbortSignal();
      observedSignal?.addEventListener('abort', () => resolveAbortReason(observedSignal?.reason));
      // Never settles on its own: only cancellation can end this call.
      await new Promise(() => {});
      return 'never';
    });

    await expect(wrapped({})).rejects.toEqual(
      expect.objectContaining({ code: ErrorCode.TIMEOUT_ERROR }),
    );

    expect(observedSignal?.aborted).toBe(true);
    await expect(abortReason).resolves.toEqual(
      expect.objectContaining({ message: expect.stringContaining('deadline of 20ms elapsed') }),
    );
  });

  it('leaves the signal unaborted for calls that finish in time', async () => {
    middleware = middlewareWith({ requestsPerMinute: 100 });
    let observedSignal: AbortSignal | undefined;

    const wrapped = middleware.withRateLimit('vikunja_tasks', () => {
      observedSignal = getExecutionAbortSignal();
      return Promise.resolve('ok');
    });

    await expect(wrapped({})).resolves.toBe('ok');
    expect(observedSignal?.aborted).toBe(false);
  });

  it('exposes no execution signal outside a rate-limited call', () => {
    middleware = middlewareWith({});
    expect(getExecutionAbortSignal()).toBeUndefined();
  });
});

describe('rate limiter: size guards survive unserializable payloads', () => {
  let middleware: SecureRateLimitMiddleware;

  beforeEach(() => {
    middleware = middlewareWith({ requestsPerMinute: 100 });
  });

  afterEach(() => {
    middleware.shutdown();
  });

  it('skips the request-size guard instead of throwing on a cyclic argument', async () => {
    const handler = jest.fn().mockResolvedValue('ok');
    const wrapped = middleware.withRateLimit('vikunja_tasks', handler);

    const cyclic: Record<string, unknown> = { name: 'extra' };
    cyclic.self = cyclic;

    await expect(wrapped(cyclic)).resolves.toBe('ok');
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('skips the response-size guard instead of throwing on a cyclic result', async () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    const wrapped = middleware.withRateLimit('vikunja_tasks', jest.fn().mockResolvedValue(cyclic));

    await expect(wrapped({})).resolves.toBe(cyclic);
  });

  it('skips the response-size guard when the result serializes to undefined', async () => {
    // `JSON.stringify(undefined)` is `undefined`, not a string.
    const wrapped = middleware.withRateLimit(
      'vikunja_tasks',
      jest.fn().mockResolvedValue(undefined),
    );

    await expect(wrapped({})).resolves.toBeUndefined();
  });
});
