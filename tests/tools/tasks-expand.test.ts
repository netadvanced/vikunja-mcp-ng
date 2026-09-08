/**
 * End-to-end (`vikunja_tasks list` handler -> wire request -> rendered
 * response) tests for the `expand` parameter — #184 P3 step 7.
 *
 * `expand` used to be parsed and then dropped on every single-project
 * listing: the tool pushed it into `ignoredParams`, told the caller it was
 * "only honored for cross-project listing", and sent a request without it.
 * That claim was never true of the API. Live probing of the running 2.4.0,
 * 2.5.0 and 2.6.0 stacks on 2026-09-05 established:
 *
 * - `GET /api/v1/projects/{id}/tasks?expand=...` accepts the full value set
 *   and populates it (`expand=buckets` came back with real bucket objects on
 *   2.4.0, `expand=comment_count` with the real count on 2.6.0).
 * - `GET /api/v1/tasks?expand=...` behaves identically.
 * - `GET /api/v1/tasks/all` answers `400 {"code":2004,"message":"Invalid
 *   model provided: Bad Request"}` on all three versions **with and without**
 *   `expand` — the endpoint does not exist, so it can never carry `expand`.
 * - An unknown value answers `412 {"code":2002,"message":"Expand must be one
 *   of the following values: subtasks, buckets, reactions, comments,
 *   comment_count, time_entries_count, is_unread","invalid_fields":
 *   ["expand"]}` on every listing endpoint and every supported version.
 *
 * The bodies asserted below are those captured responses, not invented ones.
 *
 * These drive the request through the real transport with only `global.fetch`
 * mocked, because the thing under test is the URL that goes on the wire: a
 * parameter that never reaches the query string is exactly the bug.
 *
 * Most cases pass an explicit `perPage` so each listing is one request per
 * endpoint: auto-pagination is not what is being tested here, and a
 * multi-page walk would only add noise to the wire assertions.
 */

import { registerTasksTool } from '../../src/tools/tasks';
import { getAuthManagerFromContext } from '../../src/client';
import { createMockTestableAuthManager } from '../utils/test-utils';
import type { MockAuthManager, MockServer } from '../types/mocks';
import { circuitBreakerRegistry } from '../../src/utils/retry';

jest.mock('../../src/client');
jest.mock('../../src/auth/AuthManager');
jest.mock('../../src/utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));

const mockGetAuthManagerFromContext = getAuthManagerFromContext as jest.MockedFunction<
  typeof getAuthManagerFromContext
>;

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

function jsonResponse(data: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    text: jest.fn(async () => JSON.stringify(data)),
  } as unknown as Response;
}

function errorResponse(status: number, body: string): Response {
  return {
    ok: false,
    status,
    statusText: 'Error',
    text: jest.fn(async () => body),
  } as unknown as Response;
}

/** Every path+query string that reached the wire, in order. */
function wirePaths(): string[] {
  return mockFetch.mock.calls.map((call) => {
    const url = new URL(String(call[0]));
    return `${url.pathname}${url.search}`;
  });
}

/** The repeated `expand` values of the nth request that reached the wire. */
function expandSentOn(index: number): string[] {
  return new URL(String(mockFetch.mock.calls[index]?.[0])).searchParams.getAll('expand');
}

/**
 * One page of `GET /projects`: a single project on page 1 and nothing after
 * it, so `loadAllProjects`'s page walk terminates on the second request
 * instead of re-serving the same project forever.
 */
function projectListPage(url: string): unknown[] {
  const page = new URL(url).searchParams.get('page');
  return page === null || page === '1' ? [{ id: 7, title: 'P7' }] : [];
}

describe('vikunja_tasks list honours `expand` instead of dropping it (#184 P3 step 7)', () => {
  let mockServer: MockServer;
  let mockAuthManager: MockAuthManager;
  let toolHandler: (args: Record<string, unknown>) => Promise<{ content: { text: string }[] }>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockFetch.mockReset();
    circuitBreakerRegistry.clear();

    mockAuthManager = createMockTestableAuthManager();
    mockAuthManager.isAuthenticated.mockReturnValue(true);
    mockAuthManager.getSession.mockReturnValue({
      apiUrl: 'https://api.vikunja.test',
      apiToken: 'test-token',
      authType: 'api-token' as const,
      userId: 'test-user-123',
    });
    mockAuthManager.getAuthType.mockReturnValue('api-token');

    mockServer = { tool: jest.fn() } as unknown as MockServer;
    mockGetAuthManagerFromContext.mockResolvedValue(mockAuthManager as never);
    registerTasksTool(mockServer as never, mockAuthManager as never);

    const calls = (mockServer.tool as jest.Mock).mock.calls;
    toolHandler = calls[0]?.[calls[0].length - 1] as typeof toolHandler;
  });

  describe('single-project listing (GET /projects/{id}/tasks)', () => {
    it('sends expand on the wire instead of discarding it', async () => {
      mockFetch.mockImplementation(async (url: string) => {
        const path = new URL(url).pathname.replace(/^\/api\/v\d+/, '');
        if (path === '/projects/1/tasks') {
          return jsonResponse([
            { id: 11, title: 'A task', project_id: 1, buckets: [{ id: 529, title: 'To-Do' }] },
          ]);
        }
        throw new Error(`unexpected path ${path}`);
      });

      await toolHandler({ subcommand: 'list', projectId: 1, perPage: 50, expand: ['buckets'] });

      expect(wirePaths()).toHaveLength(1);
      expect(expandSentOn(0)).toEqual(['buckets']);
    });

    it('repeats the parameter once per value, the spelling v1 documents', async () => {
      mockFetch.mockImplementation(async () => jsonResponse([]));

      await toolHandler({
        subcommand: 'list',
        projectId: 1,
        perPage: 50,
        expand: ['subtasks', 'buckets', 'reactions'],
      });

      expect(expandSentOn(0)).toEqual(['subtasks', 'buckets', 'reactions']);
    });

    it('no longer tells the caller expand was ignored', async () => {
      mockFetch.mockImplementation(async () => jsonResponse([]));

      const result = await toolHandler({
        subcommand: 'list',
        projectId: 1,
        perPage: 50,
        expand: ['comments'],
      });
      const text = result.content[0]?.text ?? '';

      expect(text).not.toContain('ignored on this single-project listing');
    });

    it('still warns about the params that really are cross-project-only', async () => {
      mockFetch.mockImplementation(async () => jsonResponse([]));

      const result = await toolHandler({
        subcommand: 'list',
        projectId: 1,
        perPage: 50,
        orderBy: 'desc',
        filterTimezone: 'Europe/Zurich',
        filterIncludeNulls: true,
        expand: ['comments'],
      });
      const text = result.content[0]?.text ?? '';

      expect(text).toContain('orderBy, filterTimezone, filterIncludeNulls');
      expect(text).not.toContain('filterIncludeNulls, expand');
    });

    it('sends expand alongside a server-side filter on the same request', async () => {
      mockFetch.mockImplementation(async (url: string) => {
        const path = new URL(url).pathname.replace(/^\/api\/v\d+/, '');
        if (path === '/projects/1/tasks') return jsonResponse([]);
        throw new Error(`unexpected path ${path}`);
      });

      await toolHandler({
        subcommand: 'list',
        projectId: 1,
        perPage: 50,
        filter: 'done = false',
        expand: ['comments'],
      });

      const sent = new URL(String(mockFetch.mock.calls[0]?.[0]));
      expect(sent.searchParams.get('filter')).toBe('done = false');
      expect(sent.searchParams.getAll('expand')).toEqual(['comments']);
    });

    it('keeps expand on the client-side fallback when the filtered request fails', async () => {
      // The server-side attempt fails, HybridFilteringStrategy retries the
      // same listing client-side. That second request must still carry
      // `expand` — dropping it there is the same silent degradation, one
      // layer down.
      let call = 0;
      mockFetch.mockImplementation(async (url: string) => {
        const path = new URL(url).pathname.replace(/^\/api\/v\d+/, '');
        if (path !== '/projects/1/tasks') throw new Error(`unexpected path ${path}`);
        call += 1;
        if (call === 1) {
          return errorResponse(
            400,
            '{"code":4019,"message":"The task filter value \'bogus\' for field \'created\' is invalid."}',
          );
        }
        return jsonResponse([{ id: 11, title: 'A task', project_id: 1 }]);
      });

      await toolHandler({
        subcommand: 'list',
        projectId: 1,
        perPage: 50,
        filter: 'done = false',
        expand: ['subtasks'],
      });

      expect(mockFetch.mock.calls.length).toBe(2);
      expect(expandSentOn(0)).toEqual(['subtasks']);
      expect(expandSentOn(1)).toEqual(['subtasks']);
    });

    it("surfaces v1's 412 for an unknown expand value rather than swallowing it", async () => {
      // A value that is valid today and retired by a later Vikunja would
      // arrive exactly like this. The server's own list of accepted values
      // must reach the caller.
      mockFetch.mockImplementation(async () =>
        errorResponse(
          412,
          '{"code":2002,"message":"Expand must be one of the following values: subtasks, buckets, reactions, comments, comment_count, time_entries_count, is_unread","invalid_fields":["expand"]}',
        ),
      );

      await expect(
        toolHandler({ subcommand: 'list', projectId: 1, perPage: 50, expand: ['comments'] }),
      ).rejects.toThrow(/Expand must be one of the following values/);
    });
  });

  describe('cross-project listing', () => {
    it('still sends expand on the primary GET /tasks call', async () => {
      mockFetch.mockImplementation(async (url: string) => {
        const path = new URL(url).pathname.replace(/^\/api\/v\d+/, '');
        if (path === '/tasks') return jsonResponse([{ id: 1, title: 'A task', project_id: 1 }]);
        throw new Error(`unexpected path ${path}`);
      });

      await toolHandler({
        subcommand: 'list',
        allProjects: true,
        perPage: 50,
        expand: ['subtasks'],
      });

      expect(wirePaths()).toHaveLength(1);
      expect(expandSentOn(0)).toEqual(['subtasks']);
    });

    it('keeps expand on the per-project aggregation fallback', async () => {
      // GET /tasks failing used to turn "expanded listing" into "unexpanded
      // listing reported as a success", because the fallback rebuilt the
      // query without expand.
      mockFetch.mockImplementation(async (url: string) => {
        const path = new URL(url).pathname.replace(/^\/api\/v\d+/, '');
        if (path === '/tasks') return errorResponse(500, '{"message":"boom"}');
        if (path === '/projects') return jsonResponse(projectListPage(url));
        if (path === '/projects/7/tasks') {
          return jsonResponse([{ id: 71, title: 'A task', project_id: 7 }]);
        }
        throw new Error(`unexpected path ${path}`);
      });

      await toolHandler({
        subcommand: 'list',
        allProjects: true,
        perPage: 50,
        expand: ['buckets'],
      });

      const perProject = wirePaths().filter((p) => p.startsWith('/api/v1/projects/7/tasks'));
      expect(perProject.length).toBeGreaterThan(0);
      for (const path of perProject) {
        expect(new URLSearchParams(path.split('?')[1]).getAll('expand')).toEqual(['buckets']);
      }
    });

    it('fails the aggregation fallback outright when expand is refused for lack of token scope', async () => {
      // A 401 on a `tk_*` session that asked for a scope-checked expand value
      // is diagnosed as an insufficient-scope refusal. Skipping every project
      // and reporting "N project(s) could not be read" would bury the one
      // thing the caller can act on, so it propagates instead.
      mockFetch.mockImplementation(async (url: string) => {
        const path = new URL(url).pathname.replace(/^\/api\/v\d+/, '');
        if (path === '/tasks') return errorResponse(500, '{"message":"boom"}');
        if (path === '/projects') return jsonResponse(projectListPage(url));
        return errorResponse(
          401,
          '{"code":11,"message":"missing, malformed, expired or otherwise invalid token provided"}',
        );
      });

      await expect(
        toolHandler({
          subcommand: 'list',
          allProjects: true,
          perPage: 50,
          expand: ['comments'],
        }),
      ).rejects.toThrow(/scopes are checked against the expanded data/);
    });
  });
});
