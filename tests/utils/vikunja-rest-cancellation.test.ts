/**
 * The REST layer's half of LOW-20 (#296).
 *
 * The complaint was that a tool call which hits its execution deadline
 * reports TIMEOUT_ERROR to the caller while the underlying request keeps
 * running and may still commit. The middleware now aborts a per-execution
 * signal (`src/context/executionContext.ts`); these tests pin the REST
 * layer's side of that contract:
 *
 *  - the signal is handed to `fetch`, so the in-flight request is really
 *    aborted rather than orphaned;
 *  - the resulting error is honest about the uncertainty and is NOT
 *    retried (re-firing a write the caller gave up on is the hazard);
 *  - it does not count against the shared circuit breakers, which per
 *    decision 16(c) every tenant in the process shares;
 *  - and outside a deadline scope nothing changes at all — no `signal` key
 *    reaches `fetch`.
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { AuthManager } from '../../src/auth/AuthManager';
import { vikunjaRestRequest, vikunjaRestMultipartRequest } from '../../src/utils/vikunja-rest';
import { runWithExecutionSignal } from '../../src/context/executionContext';
import { circuitBreakerRegistry, isClientErrorExcludedFromBreaker } from '../../src/utils/retry';
import { MCPError, ErrorCode } from '../../src/types';

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

function makeForm(): FormData {
  const form = new FormData();
  form.append('files', new Blob(['hi']), 'hi.txt');
  return form;
}

describe('vikunja-rest: tool-execution deadline cancellation', () => {
  let authManager: AuthManager;

  beforeEach(() => {
    jest.clearAllMocks();
    mockFetch.mockReset();
    circuitBreakerRegistry.clear();
    authManager = new AuthManager();
    authManager.connect('https://vikunja.test', 'tk_test-token');
  });

  it('passes the execution signal to fetch', async () => {
    const controller = new AbortController();
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: jest.fn(async () => '{"id":1}'),
    });

    await runWithExecutionSignal(controller.signal, () =>
      vikunjaRestRequest(authManager, 'GET', '/tasks/1'),
    );

    expect(mockFetch.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ signal: controller.signal }),
    );
  });

  it('sends no signal key at all when no deadline is in scope', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: jest.fn(async () => '{"id":1}'),
    });

    await vikunjaRestRequest(authManager, 'GET', '/tasks/1');

    expect(mockFetch.mock.calls[0]?.[1]).not.toHaveProperty('signal');
  });

  it('reports an aborted request honestly and does not retry it', async () => {
    const controller = new AbortController();
    mockFetch.mockImplementation(() => {
      controller.abort(new Error('Tool execution deadline of 20ms elapsed'));
      return Promise.reject(new Error('This operation was aborted'));
    });

    const error = await runWithExecutionSignal(controller.signal, () =>
      vikunjaRestRequest(authManager, 'POST', '/tasks/1', { title: 'x' }),
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(MCPError);
    expect((error as MCPError).code).toBe(ErrorCode.TIMEOUT_ERROR);
    expect((error as MCPError).message).toContain('cancelled (POST /tasks/1)');
    expect((error as MCPError).message).toContain('re-check before retrying');
    expect((error as MCPError).details).toEqual(
      expect.objectContaining({ cancelled: true, transient: false }),
    );

    // The whole point: a request the caller already gave up on must not be
    // fired a second time.
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('reports an aborted multipart request the same way', async () => {
    const controller = new AbortController();
    mockFetch.mockImplementation(() => {
      controller.abort(new Error('Tool execution deadline of 20ms elapsed'));
      return Promise.reject(new Error('This operation was aborted'));
    });

    const error = await runWithExecutionSignal(controller.signal, () =>
      vikunjaRestMultipartRequest(authManager, 'PUT', '/tasks/1/attachments', makeForm()),
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(MCPError);
    expect((error as MCPError).code).toBe(ErrorCode.TIMEOUT_ERROR);
    expect((error as MCPError).details?.cancelled).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('still reports an ordinary network failure as an API error when the signal is intact', async () => {
    const controller = new AbortController();
    mockFetch.mockRejectedValue(new Error('boom'));

    const error = await runWithExecutionSignal(controller.signal, () =>
      vikunjaRestRequest(authManager, 'GET', '/tasks/1'),
    ).catch((caught: unknown) => caught);

    expect((error as MCPError).code).toBe(ErrorCode.API_ERROR);
    expect((error as MCPError).details?.cancelled).toBeUndefined();
  });

  it('keeps a cancelled request out of the shared circuit breakers statistics', () => {
    const cancelled = new MCPError(ErrorCode.TIMEOUT_ERROR, 'cancelled', {
      cancelled: true,
      transient: false,
    });
    expect(isClientErrorExcludedFromBreaker(cancelled)).toBe(true);

    // Contrast: an ordinary upstream failure still counts.
    const upstream = new MCPError(ErrorCode.API_ERROR, 'boom', { statusCode: 500 });
    expect(isClientErrorExcludedFromBreaker(upstream)).toBe(false);
  });
});
