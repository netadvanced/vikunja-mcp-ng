/**
 * Redaction regressions for the thrown-error surface (audit #287 / #292).
 *
 * Three distinct gaps are covered here:
 *
 * 1. #287 (HIGH-16) — `SecureErrorHandler.sanitize` had no bare-credential
 *    pattern, so a JWT / API token / PEM key that ended up inside a thrown
 *    `MCPError.message` reached the MCP client verbatim. Only `Logger.log`
 *    went through `redactSecretsInText`.
 * 2. #292 MED-8 — the shared `SECURITY_PATTERNS` array used stateful `/g`
 *    regexes with `.test()`. `lastIndex` survived between calls, so one
 *    request's match made the *next* request's sanitization silently
 *    no-op. In oidc-http mode that is a cross-tenant information leak.
 * 3. #292 MED-18 — the first 500 characters of a REST error body were
 *    interpolated into `MCPError.message` unfiltered.
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import {
  transformApiError,
  wrapToolError,
  handleStatusCodeError,
  createInternalError,
} from '../../src/utils/error-handler';
import { AuthManager } from '../../src/auth/AuthManager';
import { vikunjaRestRequest } from '../../src/utils/vikunja-rest';
import { MCPError } from '../../src/types';
import { circuitBreakerRegistry } from '../../src/utils/retry';
import { redactSecretsInText } from '../../src/utils/security';

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

// A syntactically valid, obviously fake JWT (base64url, no `/`, no dotted
// quads) so it exercises the bare-JWT rule and nothing else.
const FAKE_JWT =
  'eyJhbGciOiJIUzINiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJhbGljZSIsInRlbmFudCI6ImFjbWUifQ.dGhpcy1pcy1ub3QtYS1yZWFsLXNpZ25hdHVyZQ';

describe('thrown-error redaction (#287 / #292)', () => {
  describe('bare credentials in MCPError.message (#287, HIGH-16)', () => {
    it('redacts a bare JWT passed through transformApiError', () => {
      const result = transformApiError(
        new Error(`share auth returned token ${FAKE_JWT} unexpectedly`),
        'Failed to authenticate to share',
      );

      expect(result.message).not.toContain('eyJ');
      expect(result.message).not.toContain(FAKE_JWT);
      expect(result.message).toContain('[REDACTED_JWT]');
    });

    it('redacts a bare JWT passed through wrapToolError', () => {
      const result = wrapToolError(
        new Error(`upstream said ${FAKE_JWT}`),
        'vikunja_projects',
        'auth share',
      );

      expect(result.message).not.toContain('eyJ');
      expect(result.message).toContain('[REDACTED_JWT]');
    });

    it('redacts a bare JWT passed through handleStatusCodeError', () => {
      const result = handleStatusCodeError(new Error(`boom ${FAKE_JWT}`), 'get task');

      expect(result.message).not.toContain('eyJ');
      expect(result.message).toContain('[REDACTED_JWT]');
    });

    it('withholds detail from createInternalError when the detail carried a credential', () => {
      const result = createInternalError('Share auth failed', new Error(`token ${FAKE_JWT}`));

      expect(result.message).not.toContain('eyJ');
    });

    it('redacts credentials embedded in a URL inside an error message', () => {
      const result = transformApiError(
        new Error('callback failed: https://hooks.example.com/services/Ab3xYz9Qw1Er5Tz7Uk2Mn8'),
        'Failed to notify',
      );

      expect(result.message).not.toContain('Ab3xYz9Qw1Er5Tz7Uk2Mn8');
    });

    it('leaves an ordinary error message untouched', () => {
      const result = transformApiError(
        new Error('Task with ID 42 not found'),
        'Failed to get task',
      );

      expect(result.message).toBe('Failed to get task: Task with ID 42 not found');
    });
  });

  describe('quoted (JSON) credential pairs in redactSecretsInText', () => {
    it('redacts a plain JSON credential field', () => {
      expect(redactSecretsInText('{"user":"alice","password":"hunter2"}')).toBe(
        '{"user":"alice","password":"[REDACTED]"}',
      );
    });

    it('redacts a once-escaped JSON credential field', () => {
      expect(redactSecretsInText('body was {\\"api_key\\":\\"abc123\\"}')).toBe(
        'body was {\\"api_key\\":\\"[REDACTED]\\"}',
      );
    });

    it('leaves non-credential JSON fields alone', () => {
      expect(redactSecretsInText('{"title":"buy milk","priority":"3"}')).toBe(
        '{"title":"buy milk","priority":"3"}',
      );
    });

    it('leaves an empty credential value alone', () => {
      expect(redactSecretsInText('{"token":""}')).toBe('{"token":""}');
    });
  });

  describe('cross-request state leak in the shared sanitizer (#292, MED-8)', () => {
    /**
     * Reproduces the leak the way oidc-http mode hits it: two sequential
     * "requests" handled by the same process, through the same shared
     * `SecureErrorHandler` singleton. Request A's error text is long enough
     * that its match lands late in the string; with a stateful `/g` regex the
     * surviving `lastIndex` made request B's (shorter) message start its scan
     * past its own secret, so B was returned unsanitized.
     */
    const requestAMessage = `${'padding text '.repeat(8)}frame :120:44)`;
    const requestBMessage = 'other tenant frame :7:3)';

    it('sanitizes request B identically whether or not request A ran first', () => {
      const bAlone = transformApiError(new Error(requestBMessage), 'ctx').message;

      transformApiError(new Error(requestAMessage), 'ctx');
      const bAfterA = transformApiError(new Error(requestBMessage), 'ctx').message;

      expect(bAfterA).toBe(bAlone);
      expect(bAfterA).not.toContain(':7:3)');
    });

    it('stays stable across many alternating requests', () => {
      const seen = new Set<string>();
      for (let i = 0; i < 10; i += 1) {
        transformApiError(new Error(requestAMessage), 'ctx');
        seen.add(transformApiError(new Error(requestBMessage), 'ctx').message);
      }

      expect(seen.size).toBe(1);
      expect([...seen][0]).not.toContain(':7:3)');
    });

    it('is deterministic for a repeated identical message', () => {
      const first = transformApiError(new Error(requestAMessage), 'ctx').message;
      const second = transformApiError(new Error(requestAMessage), 'ctx').message;
      const third = transformApiError(new Error(requestAMessage), 'ctx').message;

      expect(second).toBe(first);
      expect(third).toBe(first);
    });
  });

  describe('REST error body passthrough (#292, MED-18)', () => {
    let authManager: AuthManager;

    beforeEach(() => {
      jest.clearAllMocks();
      mockFetch.mockReset();
      circuitBreakerRegistry.clear();
      authManager = new AuthManager();
      authManager.connect('https://vikunja.test', 'tk_test-token');
    });

    function mockResponse(opts: {
      ok?: boolean;
      status?: number;
      statusText?: string;
      text?: string;
    }): Response {
      const { ok = true, status = 200, statusText = 'OK', text = '' } = opts;
      return {
        ok,
        status,
        statusText,
        text: jest.fn(async () => text),
      } as unknown as Response;
    }

    it('redacts a credential echoed back in a JSON error body', async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse({
          ok: false,
          status: 400,
          statusText: 'Bad Request',
          text: JSON.stringify({
            message: `Invalid model provided: {"password":"hunter2-correct-horse"}`,
          }),
        }),
      );

      const error = (await vikunjaRestRequest(authManager, 'POST', '/shares/abc/auth', {
        password: 'hunter2-correct-horse',
      }).catch((e: unknown) => e)) as MCPError;

      expect(error).toBeInstanceOf(MCPError);
      expect(error.message).not.toContain('hunter2-correct-horse');
      expect(error.message).toContain('HTTP 400');
    });

    it('redacts a bearer token echoed back by a fronting proxy error page', async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse({
          ok: false,
          status: 502,
          statusText: 'Bad Gateway',
          text: `proxy rejected upstream request with Authorization: Bearer ${FAKE_JWT}`,
        }),
      );

      const error = (await vikunjaRestRequest(authManager, 'GET', '/tasks/1', undefined, {
        retry: { maxRetries: 0 },
      }).catch((e: unknown) => e)) as MCPError;

      expect(error).toBeInstanceOf(MCPError);
      expect(error.message).not.toContain('eyJ');
      expect(error.message).toContain('HTTP 502');
    });

    it('keeps a benign error body readable', async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse({
          ok: false,
          status: 404,
          statusText: 'Not Found',
          text: JSON.stringify({ message: 'task does not exist', code: 4005 }),
        }),
      );

      const error = (await vikunjaRestRequest(authManager, 'GET', '/tasks/999').catch(
        (e: unknown) => e,
      )) as MCPError;

      expect(error.message).toContain('task does not exist');
    });

    it('redacts a credential surfaced by a network-layer failure', async () => {
      mockFetch.mockRejectedValue(
        new Error(`connect ECONNREFUSED https://svc:${FAKE_JWT}@vikunja.test/api/v1/tasks/1`),
      );

      const error = (await vikunjaRestRequest(authManager, 'GET', '/tasks/1', undefined, {
        retry: { maxRetries: 0 },
      }).catch((e: unknown) => e)) as MCPError;

      expect(error).toBeInstanceOf(MCPError);
      expect(error.message).not.toContain('eyJ');
    });
  });
});
