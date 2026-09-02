/**
 * Vikunja 2.6.0 alignment: the REST-layer behaviours (issue #254).
 *
 * Every expectation here was measured against live 2.4.0 and 2.6.0 servers
 * before any of it was written — the status codes, error codes and bodies
 * below are transcribed from those runs, not inferred from the changelog or
 * the Go source. Where the issue's own prediction turned out to be wrong the
 * test follows the server; the most important such case is that a
 * missing-expand-scope 401 is byte-for-byte identical to a bad-token 401,
 * which is why the guidance can only ever be phrased as an inference.
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { AuthManager } from '../../src/auth/AuthManager';
import {
  deriveRestBreakerName,
  describeLikelyExpandScopeFailure,
  describeTightenedRefusal,
  vikunjaRestRequest,
} from '../../src/utils/vikunja-rest';
import { MCPError, ErrorCode } from '../../src/types';
import { circuitBreakerRegistry, isClientErrorExcludedFromBreaker } from '../../src/utils/retry';

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

function mockResponse(opts: { ok?: boolean; status?: number; statusText?: string; text?: string }): Response {
  const { ok = true, status = 200, statusText = 'OK', text = '' } = opts;
  return { ok, status, statusText, text: jest.fn(async () => text) } as unknown as Response;
}

/** Exactly what a live 2.6.0 server sends for a scope-refused expand. */
const INVALID_TOKEN_BODY = JSON.stringify({
  code: 11,
  message: 'missing, malformed, expired or otherwise invalid token provided',
});

/** Exactly what a live 2.6.0 server sends for a write on an archived project. */
const ARCHIVED_BODY = JSON.stringify({
  code: 3008,
  message: 'This project is archived. Editing or creating new tasks is not possible.',
});

describe('Vikunja 2.6.0 alignment (issue #254)', () => {
  let authManager: AuthManager;

  beforeEach(() => {
    jest.clearAllMocks();
    mockFetch.mockReset();
    circuitBreakerRegistry.clear();
    authManager = new AuthManager();
    authManager.connect('https://vikunja.test', 'tk_test-token');
  });

  describe('deriveRestBreakerName strips the query string', () => {
    it('groups every /tasks listing onto one breaker regardless of its query', () => {
      expect(deriveRestBreakerName('/tasks')).toBe('vikunja-rest-tasks');
      expect(deriveRestBreakerName('/tasks?expand=comments')).toBe('vikunja-rest-tasks');
      expect(deriveRestBreakerName('/tasks?page=1&per_page=1000&expand=comments')).toBe(
        'vikunja-rest-tasks',
      );
    });

    it('keeps the documented path-segment grouping intact', () => {
      expect(deriveRestBreakerName('/projects/4/webhooks?page=2')).toBe(
        'vikunja-rest-projects-webhooks',
      );
      expect(deriveRestBreakerName('/tasks/7')).toBe('vikunja-rest-tasks');
      expect(deriveRestBreakerName('/?a=1')).toBe('vikunja-rest-root');
    });

    it('does not create a new breaker per distinct query (the registry-growth bug)', async () => {
      for (const query of ['?a=1', '?a=2', '?a=3']) {
        mockFetch.mockResolvedValueOnce(mockResponse({ text: '[]' }));
        await vikunjaRestRequest(authManager, 'GET', `/tasks${query}`);
      }
      const names = Object.keys(circuitBreakerRegistry.getAllStats());
      expect(names).toEqual(['vikunja-rest-tasks']);
    });
  });

  describe('describeLikelyExpandScopeFailure', () => {
    it('fires for a 401 on an api-token session that asked for a scope-checked expand', () => {
      const hint = describeLikelyExpandScopeFailure(401, '/tasks?expand=comments', 'api-token');
      expect(hint).toContain('tasks_comments');
      expect(hint).toContain('expand=comments');
    });

    it('names every scope-checked expand value in the request', () => {
      const hint = describeLikelyExpandScopeFailure(
        401,
        '/tasks?expand=comments&expand=reactions',
        'api-token',
      );
      expect(hint).toContain('tasks_comments');
      expect(hint).toContain('reactions');
    });

    it('presents the scope explanation as the LIKELY cause, not a certainty', () => {
      // The server sends an identical 401 for an expired token, so asserting
      // a scope problem outright would be a lie. Both branches must appear.
      const hint = describeLikelyExpandScopeFailure(401, '/tasks?expand=comments', 'api-token') ?? '';
      expect(hint).toMatch(/Most likely/);
      expect(hint).toMatch(/Less likely/);
      expect(hint).toMatch(/expired or revoked/);
    });

    it('is silent for expand values the server does not scope-check', () => {
      // Measured: the same narrow token gets 200 for these.
      expect(describeLikelyExpandScopeFailure(401, '/tasks?expand=subtasks', 'api-token')).toBeNull();
      expect(describeLikelyExpandScopeFailure(401, '/tasks?expand=buckets', 'api-token')).toBeNull();
    });

    it('is silent when no expand was requested', () => {
      expect(describeLikelyExpandScopeFailure(401, '/tasks', 'api-token')).toBeNull();
      expect(describeLikelyExpandScopeFailure(401, '/tasks?page=2', 'api-token')).toBeNull();
    });

    it('is silent for a JWT session, which never reaches the token-scope check', () => {
      expect(describeLikelyExpandScopeFailure(401, '/tasks?expand=comments', 'jwt')).toBeNull();
    });

    it('is silent for statuses other than 401', () => {
      expect(describeLikelyExpandScopeFailure(403, '/tasks?expand=comments', 'api-token')).toBeNull();
      expect(describeLikelyExpandScopeFailure(500, '/tasks?expand=comments', 'api-token')).toBeNull();
    });
  });

  describe('describeTightenedRefusal', () => {
    it('explains a 412/3008 archived-project refusal beyond the server\'s task-only wording', () => {
      const hint = describeTightenedRefusal(412, 'PUT', '/projects/9/webhooks', ARCHIVED_BODY);
      expect(hint).toContain('archived');
      expect(hint).toContain('webhooks');
      expect(hint).toContain('isArchived: false');
    });

    it('ignores a 412 that is not the archived-project code', () => {
      expect(
        describeTightenedRefusal(412, 'PUT', '/projects/9/webhooks', JSON.stringify({ code: 4001 })),
      ).toBeNull();
    });

    it('explains a 403 on relation delete', () => {
      const hint = describeTightenedRefusal(403, 'DELETE', '/tasks/4/relations/related/9', '');
      expect(hint).toContain('read access to BOTH tasks');
    });

    it('does not explain a relation 403 for a different method', () => {
      expect(describeTightenedRefusal(403, 'PUT', '/tasks/4/relations', '')).toBeNull();
    });

    it('explains a 403 when attaching an unreadable team to a project', () => {
      const hint = describeTightenedRefusal(403, 'PUT', '/projects/3/teams', '');
      expect(hint).toContain('read that team');
      expect(hint).toContain('blank name');
    });

    it('stays silent for an unrelated 403 or a success', () => {
      expect(describeTightenedRefusal(403, 'GET', '/projects/3', '')).toBeNull();
      expect(describeTightenedRefusal(200, 'PUT', '/projects/3/teams', '')).toBeNull();
    });
  });

  describe('vikunjaRestRequest end to end', () => {
    it('flags an expand-scope 401 with details.insufficientScope and the guidance', async () => {
      mockFetch.mockResolvedValue(
        mockResponse({ ok: false, status: 401, statusText: 'Unauthorized', text: INVALID_TOKEN_BODY }),
      );

      const error = await vikunjaRestRequest(authManager, 'GET', '/tasks?expand=comments').catch(
        (e: unknown) => e as MCPError,
      );

      expect(error).toBeInstanceOf(MCPError);
      expect((error as MCPError).details?.insufficientScope).toBe(true);
      expect((error as MCPError).details?.statusCode).toBe(401);
      expect((error as MCPError).message).toContain('tasks_comments');
    });

    it('does NOT flag an ordinary 401 with no expand', async () => {
      mockFetch.mockResolvedValue(
        mockResponse({ ok: false, status: 401, statusText: 'Unauthorized', text: INVALID_TOKEN_BODY }),
      );

      const error = await vikunjaRestRequest(authManager, 'GET', '/tasks').catch(
        (e: unknown) => e as MCPError,
      );

      expect((error as MCPError).details?.insufficientScope).toBeUndefined();
    });

    it('does NOT flag an expand 401 on a JWT session', async () => {
      const jwtAuth = new AuthManager();
      jwtAuth.connect('https://vikunja.test', 'eyJhbGciOiJIUzI1NiJ9.e30.sig', 'jwt');
      mockFetch.mockResolvedValue(
        mockResponse({ ok: false, status: 401, statusText: 'Unauthorized', text: INVALID_TOKEN_BODY }),
      );

      const error = await vikunjaRestRequest(jwtAuth, 'GET', '/tasks?expand=comments').catch(
        (e: unknown) => e as MCPError,
      );

      expect((error as MCPError).details?.insufficientScope).toBeUndefined();
    });

    it('appends archived-project guidance to a 412/3008', async () => {
      mockFetch.mockResolvedValue(
        mockResponse({
          ok: false,
          status: 412,
          statusText: 'Precondition Failed',
          text: ARCHIVED_BODY,
        }),
      );

      const error = await vikunjaRestRequest(authManager, 'PUT', '/projects/9/webhooks', {}).catch(
        (e: unknown) => e as MCPError,
      );

      expect((error as MCPError).message).toContain('The project is archived');
      // The server's own body is still there — guidance augments, never replaces.
      expect((error as MCPError).message).toContain('3008');
      expect((error as MCPError).details?.insufficientScope).toBeUndefined();
    });

    it('appends relation guidance to a 403 on relation delete', async () => {
      mockFetch.mockResolvedValue(
        mockResponse({ ok: false, status: 403, statusText: 'Forbidden', text: '{"code":0,"message":"Forbidden"}' }),
      );

      const error = await vikunjaRestRequest(
        authManager,
        'DELETE',
        '/tasks/4/relations/related/9',
        {},
      ).catch((e: unknown) => e as MCPError);

      expect((error as MCPError).message).toContain('read access to BOTH tasks');
    });
  });

  describe('circuit-breaker exclusion', () => {
    it('keeps an insufficient-scope 401 out of the breaker statistics', () => {
      const error = new MCPError(ErrorCode.API_ERROR, 'scope', {
        statusCode: 401,
        insufficientScope: true,
      });
      expect(isClientErrorExcludedFromBreaker(error)).toBe(true);
    });

    it('still counts a plain 401 toward the breaker (unchanged)', () => {
      const error = new MCPError(ErrorCode.API_ERROR, 'bad token', { statusCode: 401 });
      Object.assign(error, { status: 401 });
      expect(isClientErrorExcludedFromBreaker(error)).toBe(false);
    });

    it('does not open the tasks breaker after repeated expand-scope 401s', async () => {
      mockFetch.mockResolvedValue(
        mockResponse({ ok: false, status: 401, statusText: 'Unauthorized', text: INVALID_TOKEN_BODY }),
      );

      for (let i = 0; i < 12; i++) {
        await vikunjaRestRequest(authManager, 'GET', '/tasks?expand=comments').catch(() => undefined);
      }

      const breaker = circuitBreakerRegistry.get('vikunja-rest-tasks');
      expect(breaker?.opened).toBe(false);

      // ...and a following no-expand call on the SAME breaker still works.
      mockFetch.mockResolvedValueOnce(mockResponse({ text: '[]' }));
      await expect(vikunjaRestRequest(authManager, 'GET', '/tasks')).resolves.toEqual([]);
    });
  });
});
