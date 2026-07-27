/**
 * Tests for the Vikunja v2 REST transport (src/utils/vikunja-rest-v2.ts).
 *
 * Covers v2 base-URL normalization, version-scoped circuit breaker naming,
 * the problem+json error adapter, and the request helper itself.
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { AuthManager } from '../../src/auth/AuthManager';
import { circuitBreakerRegistry } from '../../src/utils/retry';
import {
  resolveV2BaseUrl,
  deriveRestV2BreakerName,
  parseVikunjaV2Error,
  vikunjaRestV2Request,
} from '../../src/utils/vikunja-rest-v2';
import { deriveRestBreakerName } from '../../src/utils/vikunja-rest';
import { MCPError, ErrorCode } from '../../src/types';

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

/**
 * Builds a Response-like object good enough for vikunjaRestV2Request, which
 * reads `.ok`, `.status`, `.statusText`, `.headers.get()` and `.text()`.
 */
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
    headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? contentType : null) },
    text: jest.fn(async () => text),
  } as unknown as Response;
}

describe('vikunja-rest-v2 helper', () => {
  describe('resolveV2BaseUrl', () => {
    it('appends /api/v2 when no version suffix is present', () => {
      expect(resolveV2BaseUrl('https://vikunja.test')).toBe('https://vikunja.test/api/v2');
    });

    it('strips trailing slashes before appending', () => {
      expect(resolveV2BaseUrl('https://vikunja.test/')).toBe('https://vikunja.test/api/v2');
    });

    it('replaces an existing /api/v1 suffix with /api/v2', () => {
      expect(resolveV2BaseUrl('https://vikunja.test/api/v1')).toBe('https://vikunja.test/api/v2');
    });

    it('leaves an existing /api/v2 suffix intact', () => {
      expect(resolveV2BaseUrl('https://vikunja.test/api/v2')).toBe('https://vikunja.test/api/v2');
    });
  });

  describe('deriveRestV2BreakerName', () => {
    it('drops numeric id segments and prefixes with vikunja-rest-v2', () => {
      expect(deriveRestV2BreakerName('/tasks/7')).toBe('vikunja-rest-v2-tasks');
    });

    it('keeps the first two non-numeric segments', () => {
      expect(deriveRestV2BreakerName('/projects/4/views')).toBe('vikunja-rest-v2-projects-views');
    });

    it('falls back to "root" for a path with no usable segments', () => {
      expect(deriveRestV2BreakerName('/')).toBe('vikunja-rest-v2-root');
    });

    // Regression guard: breakers are process-wide and keyed by name, so a
    // shared name would let v1 failures trip the v2 breaker and vice versa.
    it('never collides with the v1 breaker name for the same path', () => {
      for (const path of ['/tasks/7', '/projects/4/views', '/labels/1']) {
        expect(deriveRestV2BreakerName(path)).not.toBe(deriveRestBreakerName(path));
      }
    });
  });

  describe('parseVikunjaV2Error', () => {
    const problemBody = JSON.stringify({
      $schema: '/api/v2/schemas/VikunjaErrorModel.json',
      type: 'https://vikunja.io/docs/errors/',
      title: 'Bad Request',
      status: 400,
      detail: 'Property title is required but is missing.',
      code: 4001,
      errors: [{ location: 'body.title', message: 'expected string', value: null }],
    });

    it('preserves the numeric Vikunja code and the errors[] details', () => {
      const error = parseVikunjaV2Error(
        'PATCH',
        '/tasks/7',
        400,
        'Bad Request',
        'application/problem+json',
        problemBody,
      );

      expect(error).toBeInstanceOf(MCPError);
      expect(error.code).toBe(ErrorCode.API_ERROR);
      expect(error.details?.statusCode).toBe(400);
      expect(error.details?.vikunjaError).toEqual({
        code: 4001,
        errors: [{ location: 'body.title', message: 'expected string', value: null }],
      });
    });

    it('names the failing field in the message', () => {
      const error = parseVikunjaV2Error(
        'PATCH',
        '/tasks/7',
        400,
        'Bad Request',
        'application/problem+json',
        problemBody,
      );

      expect(error.message).toContain('Vikunja REST request failed (PATCH /tasks/7)');
      expect(error.message).toContain('Bad Request: Property title is required but is missing.');
      expect(error.message).toContain('body.title: expected string');
    });

    // Shared classifiers (isAuthenticationError, extractHttpStatus) read
    // `.status` off the error object, not `.details.statusCode`.
    it('exposes the HTTP status as a top-level .status', () => {
      const error = parseVikunjaV2Error(
        'GET',
        '/tasks/7',
        403,
        'Forbidden',
        'application/problem+json',
        JSON.stringify({ title: 'Forbidden', status: 403, code: 4003 }),
      );

      expect((error as unknown as { status?: number }).status).toBe(403);
      expect(error.details?.statusCode).toBe(403);
    });

    // The transport status wins over the body's `status` field: the breaker
    // and retry predicate key off the real status, and a server-side bug in
    // the body must not be able to change retry behaviour.
    it('trusts the transport status over a disagreeing body status', () => {
      const error = parseVikunjaV2Error(
        'GET',
        '/tasks/7',
        500,
        'Internal Server Error',
        'application/problem+json',
        JSON.stringify({ title: 'Nope', status: 200, code: 9999 }),
      );

      expect(error.details?.statusCode).toBe(500);
    });

    it('honours a content type with charset parameters', () => {
      const error = parseVikunjaV2Error(
        'GET',
        '/tasks/7',
        404,
        'Not Found',
        'application/problem+json; charset=utf-8',
        JSON.stringify({ title: 'Not Found', code: 4004 }),
      );

      expect(error.details?.vikunjaError).toEqual({ code: 4004, errors: [] });
    });

    it('falls back to the v1 message shape when the body is not valid JSON', () => {
      const error = parseVikunjaV2Error(
        'GET',
        '/tasks/7',
        400,
        'Bad Request',
        'application/problem+json',
        'not json at all',
      );

      expect(error.message).toBe(
        'Vikunja REST request failed (GET /tasks/7): HTTP 400 Bad Request — not json at all',
      );
      expect(error.details?.statusCode).toBe(400);
      expect(error.details?.vikunjaError).toBeUndefined();
    });

    it('falls back when JSON parses to a non-object', () => {
      const error = parseVikunjaV2Error(
        'GET',
        '/tasks/7',
        400,
        'Bad Request',
        'application/problem+json',
        '"just a string"',
      );

      expect(error.message).toContain('— "just a string"');
      expect(error.details?.vikunjaError).toBeUndefined();
    });

    // A reverse proxy between the client and Vikunja can return a plain-text
    // 502 that never reaches Vikunja's error rendering.
    it('falls back for a non-problem+json content type', () => {
      const error = parseVikunjaV2Error(
        'GET',
        '/tasks/7',
        502,
        'Bad Gateway',
        'text/html',
        '<html>gateway down</html>',
      );

      expect(error.message).toBe(
        'Vikunja REST request failed (GET /tasks/7): HTTP 502 Bad Gateway — <html>gateway down</html>',
      );
      expect(error.details?.statusCode).toBe(502);
    });

    it('falls back when there is no content type at all', () => {
      const error = parseVikunjaV2Error('GET', '/tasks/7', 502, 'Bad Gateway', null, 'oops');

      expect(error.message).toContain('HTTP 502 Bad Gateway — oops');
    });

    it('omits the detail suffix entirely for an empty body', () => {
      const error = parseVikunjaV2Error('GET', '/tasks/7', 502, 'Bad Gateway', null, '');

      expect(error.message).toBe(
        'Vikunja REST request failed (GET /tasks/7): HTTP 502 Bad Gateway',
      );
    });

    it('truncates an oversized fallback body to 500 characters', () => {
      const error = parseVikunjaV2Error('GET', '/tasks/7', 500, 'Error', null, 'x'.repeat(900));

      expect(error.message).toContain(`— ${'x'.repeat(500)}`);
      expect(error.message).not.toContain('x'.repeat(501));
    });

    it('renders a problem body carrying only errors[] and no title or detail', () => {
      const error = parseVikunjaV2Error(
        'PATCH',
        '/tasks/7',
        422,
        'Unprocessable Entity',
        'application/problem+json',
        JSON.stringify({ errors: [{ location: 'body.due_date', message: 'invalid date' }] }),
      );

      expect(error.message).toBe(
        'Vikunja REST request failed (PATCH /tasks/7): HTTP 422 Unprocessable Entity — [body.due_date: invalid date]',
      );
    });

    it('renders a problem body with neither summary nor errors as the bare status line', () => {
      const error = parseVikunjaV2Error(
        'GET',
        '/tasks/7',
        500,
        'Internal Server Error',
        'application/problem+json',
        JSON.stringify({ code: 5000 }),
      );

      expect(error.message).toBe(
        'Vikunja REST request failed (GET /tasks/7): HTTP 500 Internal Server Error',
      );
      expect(error.details?.vikunjaError).toEqual({ code: 5000, errors: [] });
    });

    // Defensive test: error entries may omit location or message fields.
    // This exercises the conditional branches in readErrorDetails.
    it('handles error entries with only location (no message)', () => {
      const error = parseVikunjaV2Error(
        'PATCH',
        '/tasks/7',
        422,
        'Unprocessable Entity',
        'application/problem+json',
        JSON.stringify({
          title: 'Validation failed',
          errors: [{ location: 'body.tags', value: 'invalid' }],
        }),
      );

      expect(error.message).toContain('body.tags');
      expect(error.details?.vikunjaError?.errors).toEqual([
        { location: 'body.tags', value: 'invalid' },
      ]);
    });

    it('handles error entries with only message (no location)', () => {
      const error = parseVikunjaV2Error(
        'PATCH',
        '/tasks/7',
        422,
        'Unprocessable Entity',
        'application/problem+json',
        JSON.stringify({
          title: 'Validation failed',
          errors: [{ message: 'must be at least 3 characters', value: 'xy' }],
        }),
      );

      expect(error.message).toContain('must be at least 3 characters');
      expect(error.details?.vikunjaError?.errors).toEqual([
        { message: 'must be at least 3 characters', value: 'xy' },
      ]);
    });

    it('handles error entries with neither location nor message', () => {
      const error = parseVikunjaV2Error(
        'PATCH',
        '/tasks/7',
        422,
        'Unprocessable Entity',
        'application/problem+json',
        JSON.stringify({
          title: 'Validation failed',
          errors: [{ value: null }],
        }),
      );

      // Entry with no location or message is skipped in the fields list
      expect(error.message).toBe(
        'Vikunja REST request failed (PATCH /tasks/7): HTTP 422 Unprocessable Entity — Validation failed',
      );
      expect(error.details?.vikunjaError?.errors).toEqual([{ value: null }]);
    });

    // A server or proxy can return an oversized `detail` field; the composed
    // suffix must be capped the same way the non-problem+json fallback path
    // caps its raw body, or an unbounded value here produces an unbounded
    // MCP error message.
    it('caps an oversized detail field at 500 characters', () => {
      const error = parseVikunjaV2Error(
        'PATCH',
        '/tasks/7',
        400,
        'Bad Request',
        'application/problem+json',
        JSON.stringify({ title: 'Bad Request', detail: 'x'.repeat(900) }),
      );

      const dashIndex = error.message.indexOf('— ');
      expect(dashIndex).toBeGreaterThan(-1);
      const suffix = error.message.slice(dashIndex + 2);
      expect(suffix.length).toBe(500);
      expect(suffix.startsWith('Bad Request: ')).toBe(true);
      expect(error.message).not.toContain('x'.repeat(501));
    });

    // Same cap applies when the length comes from many errors[] entries
    // rather than one long detail string.
    it('caps a message composed of many errors[] entries at 500 characters', () => {
      const errors = Array.from({ length: 200 }, (_, i) => ({
        location: `body.field${i}`,
        message: 'invalid',
      }));
      const error = parseVikunjaV2Error(
        'PATCH',
        '/tasks/7',
        422,
        'Unprocessable Entity',
        'application/problem+json',
        JSON.stringify({ errors }),
      );

      const dashIndex = error.message.indexOf('— ');
      expect(dashIndex).toBeGreaterThan(-1);
      expect(error.message.length - (dashIndex + 2)).toBe(500);
    });

    it('renders mixed error entries with varying completeness', () => {
      const error = parseVikunjaV2Error(
        'PATCH',
        '/tasks/7',
        422,
        'Unprocessable Entity',
        'application/problem+json',
        JSON.stringify({
          errors: [
            { location: 'body.title', message: 'required' },
            { location: 'body.tags' },
            { message: 'unexpected field' },
            { value: 'extra' },
          ],
        }),
      );

      // Should render complete entry, location-only, message-only, and skip valueless
      expect(error.message).toContain('body.title: required');
      expect(error.message).toContain('body.tags');
      expect(error.message).toContain('unexpected field');
      expect(error.details?.vikunjaError?.errors).toEqual([
        { location: 'body.title', message: 'required' },
        { location: 'body.tags' },
        { message: 'unexpected field' },
        { value: 'extra' },
      ]);
    });
  });

  describe('vikunjaRestV2Request', () => {
    let authManager: AuthManager;

    beforeEach(() => {
      jest.clearAllMocks();
      mockFetch.mockReset();
      // The breaker registry in ../../src/utils/retry is a process-wide
      // singleton keyed by name; several tests below deliberately fail the
      // same path, so without clearing accumulated stats a later test
      // starts seeing "Breaker is open" instead of its own scenario.
      circuitBreakerRegistry.clear();
      authManager = new AuthManager();
      authManager.connect('https://vikunja.test', 'tk_test-token');
    });

    it('targets the v2 base URL and sends the bearer token', async () => {
      mockFetch.mockResolvedValueOnce(mockV2Response({ text: JSON.stringify({ id: 7 }) }));

      const result = await vikunjaRestV2Request(authManager, 'GET', '/tasks/7');

      expect(result).toEqual({ id: 7 });
      const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://vikunja.test/api/v2/tasks/7');
      expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tk_test-token');
      expect(init.body).toBeUndefined();
    });

    it('sends merge-patch+json for PATCH by default', async () => {
      mockFetch.mockResolvedValueOnce(mockV2Response({ text: '{}' }));

      await vikunjaRestV2Request(authManager, 'PATCH', '/tasks/7', { priority: 3 });

      const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect((init.headers as Record<string, string>)['Content-Type']).toBe(
        'application/merge-patch+json',
      );
      expect(init.body).toBe(JSON.stringify({ priority: 3 }));
    });

    it('sends json-patch+json when that patch format is requested', async () => {
      mockFetch.mockResolvedValueOnce(mockV2Response({ text: '{}' }));

      await vikunjaRestV2Request(authManager, 'PATCH', '/tasks/7', [{ op: 'remove', path: '/assignees/0' }], {
        patchFormat: 'json-patch',
      });

      const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect((init.headers as Record<string, string>)['Content-Type']).toBe(
        'application/json-patch+json',
      );
    });

    it('sends plain application/json for non-PATCH methods', async () => {
      mockFetch.mockResolvedValueOnce(mockV2Response({ text: '{}' }));

      await vikunjaRestV2Request(authManager, 'POST', '/tasks', { title: 'x' });

      const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    });

    it('returns null for an empty response body', async () => {
      mockFetch.mockResolvedValueOnce(mockV2Response({ text: '' }));

      await expect(vikunjaRestV2Request(authManager, 'DELETE', '/tasks/7')).resolves.toBeNull();
    });

    it('returns null for a 2xx response with a non-JSON body', async () => {
      mockFetch.mockResolvedValueOnce(mockV2Response({ text: 'not json' }));

      await expect(vikunjaRestV2Request(authManager, 'GET', '/tasks/7')).resolves.toBeNull();
    });

    it('routes a problem+json error through the adapter', async () => {
      mockFetch.mockResolvedValueOnce(
        mockV2Response({
          ok: false,
          status: 404,
          statusText: 'Not Found',
          contentType: 'application/problem+json',
          text: JSON.stringify({ title: 'Not Found', code: 4004 }),
        }),
      );

      await expect(vikunjaRestV2Request(authManager, 'GET', '/tasks/7')).rejects.toMatchObject({
        code: ErrorCode.API_ERROR,
        details: { statusCode: 404, vikunjaError: { code: 4004, errors: [] } },
      });
    });

    it('wraps a network-layer failure as a transient MCPError', async () => {
      const netError = Object.assign(new Error('fetch failed'), { code: 'ECONNRESET' });
      mockFetch.mockRejectedValue(netError);

      const promise = vikunjaRestV2Request(authManager, 'GET', '/tasks/7', undefined, {
        retry: { maxRetries: 0 },
      });

      await expect(promise).rejects.toBeInstanceOf(MCPError);
      await expect(promise).rejects.toMatchObject({ details: { transient: true } });
    });

    // Mirrors vikunja-rest.test.ts's "stringifies a non-Error rejection
    // value": fetch can reject with a non-Error (e.g. a plain string thrown
    // by a mock or a non-standard fetch polyfill), and that branch of the
    // `error instanceof Error ? error.message : String(error)` ternary is
    // otherwise never exercised.
    it('stringifies a non-Error network rejection value', async () => {
      mockFetch.mockRejectedValue('plain string failure');

      const promise = vikunjaRestV2Request(authManager, 'GET', '/tasks/7', undefined, {
        retry: { maxRetries: 0 },
      });

      await expect(promise).rejects.toThrow(
        'Vikunja REST request failed (GET /tasks/7): plain string failure',
      );
    });

    it('retries a 500 and succeeds on the next attempt', async () => {
      mockFetch
        .mockResolvedValueOnce(
          mockV2Response({ ok: false, status: 500, statusText: 'Server Error', contentType: null }),
        )
        .mockResolvedValueOnce(mockV2Response({ text: JSON.stringify({ id: 7 }) }));

      const result = await vikunjaRestV2Request(authManager, 'GET', '/tasks/7', undefined, {
        retry: { initialDelay: 1 },
      });

      expect(result).toEqual({ id: 7 });
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('does not retry a 404', async () => {
      mockFetch.mockResolvedValue(
        mockV2Response({
          ok: false,
          status: 404,
          statusText: 'Not Found',
          contentType: 'application/problem+json',
          text: JSON.stringify({ title: 'Not Found' }),
        }),
      );

      await expect(vikunjaRestV2Request(authManager, 'GET', '/tasks/7')).rejects.toBeInstanceOf(
        MCPError,
      );
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    // isClientErrorExcludedFromBreaker in ./retry is status-generic, so it
    // applies to v2 unchanged — this pins that it actually does.
    it('does not count 4xx responses toward the breaker', async () => {
      mockFetch.mockResolvedValue(
        mockV2Response({
          ok: false,
          status: 404,
          statusText: 'Not Found',
          contentType: 'application/problem+json',
          text: JSON.stringify({ title: 'Not Found' }),
        }),
      );

      // Iteration count must exceed the breaker's volume threshold so that a
      // regression (4xx wrongly counted) would actually trip it. Check the
      // configured threshold in ./retry and raise this number if it is >= 12.
      for (let i = 0; i < 12; i++) {
        await expect(vikunjaRestV2Request(authManager, 'GET', '/tasks/7')).rejects.toBeInstanceOf(
          MCPError,
        );
      }

      // A tripped breaker rejects with a reworded "circuit breaker is open"
      // message instead of the underlying 404 — assert we still see the 404.
      await expect(
        vikunjaRestV2Request(authManager, 'GET', '/tasks/7'),
      ).rejects.toMatchObject({ details: { statusCode: 404 } });
    });

    it('registers its breaker under the v2-prefixed name', async () => {
      mockFetch.mockResolvedValueOnce(mockV2Response({ text: '{}' }));

      await vikunjaRestV2Request(authManager, 'GET', '/tasks/7');

      expect(circuitBreakerRegistry.has('vikunja-rest-v2-tasks')).toBe(true);
      expect(circuitBreakerRegistry.has('vikunja-rest-tasks')).toBe(false);
    });

    it('honours an explicit breaker name override', async () => {
      mockFetch.mockResolvedValueOnce(mockV2Response({ text: '{}' }));

      await vikunjaRestV2Request(authManager, 'GET', '/tasks/7', undefined, {
        breakerName: 'vikunja-rest-v2-custom',
      });

      expect(circuitBreakerRegistry.has('vikunja-rest-v2-custom')).toBe(true);
    });
  });
});
