/**
 * v1/v2 transport parity (#184 P3, wave 3).
 *
 * `src/utils/vikunja-rest-v2.ts` is a deliberate sibling of the v1 transport
 * rather than a branch inside it, and the cost of that split is that a
 * protection added to one is silently missing from the other. Two were:
 *
 *  - upstream error text reached the caller UNREDACTED on v2 (v1 has run
 *    every error body through `redactUpstreamText` since audit #292 MED-18);
 *  - the tool-execution deadline's abort signal was never handed to `fetch`,
 *    so a v2 request could outlive the deadline that was supposed to bound it
 *    (LOW-20, #296).
 *
 * Both were harmless while nothing routed through v2. Wave 2 made them live:
 * task reads, task listings and task update now select v2 against a
 * v2-capable server.
 *
 * These tests pin the v2 side and, where the two transports must agree
 * exactly, compare them directly rather than restating v1's contract.
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { AuthManager } from '../../src/auth/AuthManager';
import { parseVikunjaV2Error, vikunjaRestV2Request } from '../../src/utils/vikunja-rest-v2';
import { vikunjaRestRequest } from '../../src/utils/vikunja-rest';
import { runWithExecutionSignal } from '../../src/context/executionContext';
import { circuitBreakerRegistry, isClientErrorExcludedFromBreaker } from '../../src/utils/retry';
import { MCPError, ErrorCode } from '../../src/types';

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

/** A `tk_*` token shaped like a real one, so the redaction rules match it. */
const SECRET_TOKEN = 'tk_9fbc4a2e7d1148c6ab35';

function mockV2Response(opts: {
  ok?: boolean;
  status?: number;
  statusText?: string;
  text?: string;
  contentType?: string | null;
}): Response {
  const {
    ok = true,
    status = 200,
    statusText = 'OK',
    text = '',
    contentType = 'application/json',
  } = opts;
  return {
    ok,
    status,
    statusText,
    headers: {
      get: (name: string) => (name.toLowerCase() === 'content-type' ? contentType : null),
    },
    text: jest.fn(async () => text),
  } as unknown as Response;
}

describe('v2 transport parity: upstream error text is redacted', () => {
  // The degraded branch, and the one a real v2 auth failure takes: measured
  // on a live 2.6.0 server, a 401 answers `Content-Type: application/json`,
  // not problem+json, so it is rendered from the raw body.
  it('redacts a credential echoed by a non-problem+json body', () => {
    const error = parseVikunjaV2Error(
      'GET',
      '/tasks/7',
      401,
      'Unauthorized',
      'application/json',
      `{"code":11,"message":"invalid token provided: Bearer ${SECRET_TOKEN}"}`,
    );

    expect(error.message).not.toContain(SECRET_TOKEN);
    expect(error.message).toContain('[REDACTED_TOKEN]');
  });

  it('redacts a credential in a problem+json detail field', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJlLXZhbHVl';
    const error = parseVikunjaV2Error(
      'PATCH',
      '/tasks/7',
      403,
      'Forbidden',
      'application/problem+json',
      JSON.stringify({ title: 'Forbidden', detail: `token ${jwt} may not edit this task` }),
    );

    expect(error.message).not.toContain(jwt);
    expect(error.message).toContain('[REDACTED_JWT]');
  });

  // Composing first and redacting the whole string is what lets the
  // name-based rules see a credential whose NAME and VALUE arrived in
  // different fields of the same errors[] entry.
  it('redacts a secret split across an entry location and message', () => {
    const error = parseVikunjaV2Error(
      'PUT',
      '/webhooks',
      422,
      'Unprocessable Entity',
      'application/problem+json',
      JSON.stringify({
        detail: 'validation failed',
        errors: [{ location: 'body.api_key', message: 'hunter2-is-not-a-valid-key' }],
      }),
    );

    expect(error.message).not.toContain('hunter2');
    expect(error.message).toContain('[REDACTED]');
  });

  // The redaction pass has to scan further than the message keeps, or a
  // secret straddling the 500-character display cut loses its tail and keeps
  // its head — a partial credential no pattern matches any more.
  it('redacts a secret that straddles the 500-character display cut', () => {
    const error = parseVikunjaV2Error(
      'GET',
      '/tasks/7',
      502,
      'Bad Gateway',
      null,
      `${'x'.repeat(495)}${SECRET_TOKEN} rest of the body`,
    );

    expect(error.message).not.toContain('tk_9fbc');
  });

  describe('the echoed errors[] value', () => {
    // Measured on a live 2.6.0 server: POST /api/v2/projects with
    // `{"title":12345,"description":{"nested":"..."}}` answers 422 whose
    // errors[] echo both values back verbatim. Whatever a caller put in the
    // request body can therefore reappear here.
    it('redacts a token echoed back as a string value', () => {
      const error = parseVikunjaV2Error(
        'POST',
        '/projects',
        422,
        'Unprocessable Entity',
        'application/problem+json',
        JSON.stringify({
          detail: 'validation failed',
          errors: [{ location: 'body.title', message: 'expected string', value: SECRET_TOKEN }],
        }),
      );

      expect(error.details?.vikunjaError?.errors).toEqual([
        { location: 'body.title', message: 'expected string', value: '[REDACTED_TOKEN]' },
      ]);
    });

    // A structured value is redacted in its serialized form precisely so the
    // name-based rules can see key and value together; a tree walk would hand
    // them a bare "hunter2" that matches nothing.
    it('redacts a credential-named key inside a structured value, keeping the shape', () => {
      const error = parseVikunjaV2Error(
        'POST',
        '/projects',
        422,
        'Unprocessable Entity',
        'application/problem+json',
        JSON.stringify({
          errors: [
            {
              location: 'body.description',
              message: 'expected string',
              value: { nested: { password: 'hunter2' }, keep: 'visible' },
            },
          ],
        }),
      );

      expect(error.details?.vikunjaError?.errors).toEqual([
        {
          location: 'body.description',
          message: 'expected string',
          value: { nested: { password: '[REDACTED]' }, keep: 'visible' },
        },
      ]);
    });

    it('leaves a value with no text to redact exactly as it arrived', () => {
      const error = parseVikunjaV2Error(
        'POST',
        '/projects',
        422,
        'Unprocessable Entity',
        'application/problem+json',
        JSON.stringify({
          errors: [
            { location: 'body.title', value: 12345 },
            { location: 'body.done', value: true },
            { location: 'body.due_date', value: null },
          ],
        }),
      );

      expect(error.details?.vikunjaError?.errors).toEqual([
        { location: 'body.title', value: 12345 },
        { location: 'body.done', value: true },
        { location: 'body.due_date', value: null },
      ]);
    });

    // Redacting a `name: "value` run consumes the opening quote, which can
    // leave text that no longer parses as JSON. What the caller then gets is
    // the redacted TEXT — never the original value, which is the property
    // that matters: the token below is gone either way.
    it('falls back to redacted text when redaction leaves unparseable JSON', () => {
      const error = parseVikunjaV2Error(
        'POST',
        '/projects',
        422,
        'Unprocessable Entity',
        'application/problem+json',
        JSON.stringify({
          errors: [{ location: 'body.note', value: { note: 'password: "x', token: SECRET_TOKEN } }],
        }),
      );

      const [entry] = (error.details?.vikunjaError?.errors ?? []) as Array<{ value: unknown }>;
      expect(typeof entry?.value).toBe('string');
      expect(entry?.value).toContain('[REDACTED');
      expect(entry?.value).not.toContain(SECRET_TOKEN);
    });
  });

  it('redacts through the transport, not only in the parser', async () => {
    const authManager = new AuthManager();
    authManager.connect('https://vikunja.test', 'tk_test-token');
    circuitBreakerRegistry.clear();
    mockFetch.mockReset();
    mockFetch.mockResolvedValueOnce(
      mockV2Response({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        contentType: 'application/json',
        text: `proxy rejected: Authorization: Bearer ${SECRET_TOKEN}`,
      }),
    );

    const error = await vikunjaRestV2Request(authManager, 'GET', '/tasks/7').catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(MCPError);
    expect((error as MCPError).message).not.toContain(SECRET_TOKEN);
  });

  it('redacts the message of a fetch-level failure, which embeds the URL', async () => {
    const authManager = new AuthManager();
    authManager.connect('https://vikunja.test', 'tk_test-token');
    circuitBreakerRegistry.clear();
    mockFetch.mockReset();
    mockFetch.mockRejectedValue(
      new Error('request to https://user:s3cr3t@vikunja.test/api/v2/tasks/7 failed'),
    );

    const error = await vikunjaRestV2Request(authManager, 'GET', '/tasks/7', undefined, {
      retry: { maxRetries: 0 },
    }).catch((caught: unknown) => caught);

    expect((error as MCPError).message).not.toContain('s3cr3t');
    expect((error as MCPError).message).toContain('REDACTED');
  });
});

describe('v2 transport parity: the execution abort signal is honoured', () => {
  let authManager: AuthManager;

  beforeEach(() => {
    jest.clearAllMocks();
    mockFetch.mockReset();
    // Process-wide singleton keyed by name; several tests here deliberately
    // fail the same path.
    circuitBreakerRegistry.clear();
    authManager = new AuthManager();
    authManager.connect('https://vikunja.test', 'tk_test-token');
  });

  it('passes the execution signal to fetch', async () => {
    const controller = new AbortController();
    mockFetch.mockResolvedValueOnce(mockV2Response({ text: '{"id":7}' }));

    await runWithExecutionSignal(controller.signal, () =>
      vikunjaRestV2Request(authManager, 'GET', '/tasks/7'),
    );

    expect(mockFetch.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ signal: controller.signal }),
    );
  });

  it('sends no signal key at all when no deadline is in scope', async () => {
    mockFetch.mockResolvedValueOnce(mockV2Response({ text: '{"id":7}' }));

    await vikunjaRestV2Request(authManager, 'GET', '/tasks/7');

    expect(mockFetch.mock.calls[0]?.[1]).not.toHaveProperty('signal');
  });

  it('reports an aborted request honestly and does not retry it', async () => {
    const controller = new AbortController();
    mockFetch.mockImplementation(() => {
      controller.abort(new Error('Tool execution deadline of 20ms elapsed'));
      return Promise.reject(new Error('This operation was aborted'));
    });

    const error = await runWithExecutionSignal(controller.signal, () =>
      vikunjaRestV2Request(authManager, 'PATCH', '/tasks/7', { priority: 3 }),
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(MCPError);
    expect((error as MCPError).code).toBe(ErrorCode.TIMEOUT_ERROR);
    expect((error as MCPError).message).toContain('cancelled (PATCH /tasks/7)');
    expect((error as MCPError).details).toEqual(
      expect.objectContaining({ cancelled: true, transient: false }),
    );

    // The whole point: a PATCH the caller already gave up on must not be
    // fired a second time.
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('keeps the cancelled request out of the shared circuit breaker statistics', async () => {
    const controller = new AbortController();
    mockFetch.mockImplementation(() => {
      controller.abort(new Error('Tool execution deadline of 20ms elapsed'));
      return Promise.reject(new Error('This operation was aborted'));
    });

    const error = await runWithExecutionSignal(controller.signal, () =>
      vikunjaRestV2Request(authManager, 'GET', '/tasks/7'),
    ).catch((caught: unknown) => caught);

    // The breakers are process-wide and shared across tenants, so one
    // identity's slow calls must not trip them for everyone else.
    expect(isClientErrorExcludedFromBreaker(error)).toBe(true);
  });

  it('still reports an ordinary network failure as an API error when the signal is intact', async () => {
    const controller = new AbortController();
    mockFetch.mockRejectedValue(new Error('boom'));

    const error = await runWithExecutionSignal(controller.signal, () =>
      vikunjaRestV2Request(authManager, 'GET', '/tasks/7', undefined, {
        retry: { maxRetries: 0 },
      }),
    ).catch((caught: unknown) => caught);

    expect((error as MCPError).code).toBe(ErrorCode.API_ERROR);
    expect((error as MCPError).details?.cancelled).toBeUndefined();
  });

  // The point of this item is that the two transports agree, so compare them
  // rather than asserting v2 against a hand-written copy of v1's contract.
  it('produces the same cancellation error as the v1 transport', async () => {
    async function cancelledError(
      call: (manager: AuthManager) => Promise<unknown>,
    ): Promise<MCPError> {
      const controller = new AbortController();
      mockFetch.mockReset();
      circuitBreakerRegistry.clear();
      mockFetch.mockImplementation(() => {
        controller.abort(new Error('Tool execution deadline of 20ms elapsed'));
        return Promise.reject(new Error('This operation was aborted'));
      });
      return (await runWithExecutionSignal(controller.signal, () => call(authManager)).catch(
        (caught: unknown) => caught,
      )) as MCPError;
    }

    const v1 = await cancelledError((manager) =>
      vikunjaRestRequest(manager, 'POST', '/tasks/7', { priority: 3 }),
    );
    const v2 = await cancelledError((manager) =>
      vikunjaRestV2Request(manager, 'POST', '/tasks/7', { priority: 3 }),
    );

    expect(v2.message).toBe(v1.message);
    expect(v2.code).toBe(v1.code);
    expect(v2.details).toEqual(v1.details);
  });
});
