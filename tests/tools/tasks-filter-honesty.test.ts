/**
 * End-to-end (`vikunja_tasks list` handler -> wire request -> rendered
 * response) regression tests for issues #227 and #225.
 *
 * They assert BOTH halves the repo's endpoint playbook asks for: the exact
 * request that goes on the wire, and the parsed outcome the caller sees.
 *
 * The shared theme: a filtered listing that could not be honoured, or that is
 * knowingly incomplete, must never render as a plain `Found N tasks` success.
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
    statusText: 'Bad Request',
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

describe('filtered listings never report a wrong or partial answer as success', () => {
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

  describe('date-filtered listing reaches the server un-rejected (issue #225a)', () => {
    it('sends an RFC3339 literal, not the form Vikunja rejects with code 4019', async () => {
      mockFetch.mockImplementation(async (url: string) => {
        const path = new URL(url).pathname.replace(/^\/api\/v\d+/, '');
        if (path === '/tasks') {
          return jsonResponse([{ id: 1, title: 'New task', project_id: 32 }]);
        }
        throw new Error(`unexpected path ${path}`);
      });

      const result = await toolHandler({
        subcommand: 'list',
        filter: "created >= '2026-08-16 00:00:00'",
      });

      const filterSent = new URL(String(mockFetch.mock.calls[0]?.[0])).searchParams.get('filter');
      expect(filterSent).toBe('created >= 2026-08-16T00:00:00Z');
      // One call: the primary single-call strategy actually worked, so there
      // was no drop into the per-project fallback at all.
      expect(wirePaths()).toHaveLength(1);
      expect(result.content[0]?.text).toContain('**success:** true');
      expect(result.content[0]?.text).toContain('Found 1 tasks (filtered server-side)');
      expect(result.content[0]?.text).not.toContain('INCOMPLETE');
    });

    it('a rejected filter reports the server’s own 4019 reason instead of a bare failure', async () => {
      mockFetch.mockImplementation(async (url: string) => {
        const parsed = new URL(url);
        const path = parsed.pathname.replace(/^\/api\/v\d+/, '');
        if (path === '/tasks') {
          return errorResponse(
            400,
            '{"code":4019,"message":"The task filter value \'bogus\' for field \'created\' is invalid."}',
          );
        }
        if (path === '/projects') return jsonResponse([]);
        throw new Error(`unexpected path ${path}`);
      });

      const result = await toolHandler({ subcommand: 'list', filter: "created >= 'now'" });

      expect(result.content[0]?.text).toContain('4019');
    });
  });

  describe('label filter by title (issue #227)', () => {
    beforeEach(() => {
      mockFetch.mockImplementation(async (url: string) => {
        const parsed = new URL(url);
        const path = parsed.pathname.replace(/^\/api\/v\d+/, '');
        if (path === '/labels') {
          return jsonResponse(
            parsed.searchParams.get('s') === 'HU' ? [{ id: 100, title: 'HU' }] : [],
          );
        }
        if (path === '/projects/113/tasks') {
          return jsonResponse([
            { id: 255, title: 'Tagged', project_id: 113, labels: [{ id: 100, title: 'HU' }] },
          ]);
        }
        throw new Error(`unexpected path ${path}`);
      });
    });

    it('resolves the title to an id and finds the tasks that carry it', async () => {
      const result = await toolHandler({
        subcommand: 'list',
        projectId: 113,
        filter: "labels in 'HU'",
      });

      // The label lookup, then the task query carrying the resolved ID.
      expect(wirePaths()).toEqual([
        '/api/v1/labels?s=HU',
        '/api/v1/projects/113/tasks?page=1&per_page=1000&filter=labels+in+100',
      ]);
      expect(result.content[0]?.text).toContain('Found 1 tasks (filtered server-side)');
    });

    it('refuses rather than returning the "Found 0 tasks" that used to be indistinguishable from an empty set', async () => {
      const result = await toolHandler({
        subcommand: 'list',
        projectId: 113,
        filter: "labels in 'ghost'",
      }).catch((error: Error) => error);

      expect(result).toBeInstanceOf(Error);
      expect((result as Error).message).toContain("no label exists with the title 'ghost'");
      // Crucially: no task request was ever made, and nothing rendered as a
      // successful empty listing.
      expect(wirePaths()).toEqual(['/api/v1/labels?s=ghost']);
    });

    it('marks a partially-resolved label filter in the rendered response', async () => {
      const result = await toolHandler({
        subcommand: 'list',
        projectId: 113,
        filter: "labels in 'HU', 'ghost'",
      });

      const text = result.content[0]?.text ?? '';
      expect(text).toContain('PARTIAL FILTER');
      expect(text).toContain("no label exists with 'ghost'");
    });
  });

  describe('a truncated aggregate is labelled in the rendered response (issue #225b)', () => {
    it('says INCOMPLETE RESULT rather than reporting a plain success', async () => {
      // Above the synthetic per_page=1000 default (which is pre-validated
      // against this same limit) so the truncation happens while LOADING,
      // which is the case under test.
      process.env.VIKUNJA_MAX_TASKS_LIMIT = '1200';
      mockFetch.mockImplementation(async (url: string) => {
        const parsed = new URL(url);
        const path = parsed.pathname.replace(/^\/api\/v\d+/, '');
        const page = Number(parsed.searchParams.get('page') ?? '1');
        if (path === '/tasks') return errorResponse(400, 'no cross-project endpoint');
        if (path === '/projects') {
          return jsonResponse(page > 1 ? [] : [{ id: 32, title: 'Big project' }]);
        }
        if (path === '/projects/32/tasks') {
          // A server clamping to 500 per page, over a project far bigger
          // than the configured task budget.
          return jsonResponse(
            Array.from({ length: 500 }, (_, i) => ({
              id: page * 1000 + i,
              title: `T${page}-${i}`,
              project_id: 32,
            })),
          );
        }
        throw new Error(`unexpected path ${path}`);
      });

      try {
        const result = await toolHandler({ subcommand: 'list' });
        const text = result.content[0]?.text ?? '';

        expect(text).toContain('INCOMPLETE RESULT');
        expect(text).toContain('VIKUNJA_MAX_TASKS_LIMIT');
      } finally {
        delete process.env.VIKUNJA_MAX_TASKS_LIMIT;
      }
    });

    it('says so when a project could not be read at all', async () => {
      mockFetch.mockImplementation(async (url: string) => {
        const parsed = new URL(url);
        const path = parsed.pathname.replace(/^\/api\/v\d+/, '');
        const page = Number(parsed.searchParams.get('page') ?? '1');
        if (path === '/tasks') return errorResponse(400, 'no cross-project endpoint');
        if (path === '/projects') {
          return jsonResponse(
            page > 1
              ? []
              : [
                  { id: 1, title: 'Readable' },
                  { id: 2, title: 'Forbidden' },
                ],
          );
        }
        if (path === '/projects/1/tasks') {
          return jsonResponse(page > 1 ? [] : [{ id: 11, title: 'Visible', project_id: 1 }]);
        }
        if (path === '/projects/2/tasks') return errorResponse(403, 'forbidden');
        throw new Error(`unexpected path ${path}`);
      });

      const result = await toolHandler({ subcommand: 'list' });
      const text = result.content[0]?.text ?? '';

      expect(text).toContain('INCOMPLETE RESULT');
      expect(text).toContain('1 project(s) could not be read');
    });
  });

  // Regression for issue #290 LOW-3: orderBy/filterTimezone/
  // filterIncludeNulls/expand are GET /tasks query params only honored for
  // cross-project listing. Supplying one on a single-project listing used
  // to be silently accepted and silently ignored, with no signal at all.
  describe('single-project listing warns about cross-project-only params (issue #290 LOW-3)', () => {
    it('warns in the response when orderBy is supplied on a single-project listing', async () => {
      mockFetch.mockImplementation(async (url: string) => {
        const path = new URL(url).pathname.replace(/^\/api\/v\d+/, '');
        if (path === '/projects/1/tasks') {
          return jsonResponse([{ id: 11, title: 'A task', project_id: 1 }]);
        }
        throw new Error(`unexpected path ${path}`);
      });

      const result = await toolHandler({ subcommand: 'list', projectId: 1, orderBy: 'desc' });
      const text = result.content[0]?.text ?? '';

      expect(text).toContain('NOTE');
      expect(text).toContain('orderBy');
      expect(text).toContain('ignored on this single-project listing');
    });

    it('lists every ignored param when several are supplied together', async () => {
      mockFetch.mockImplementation(async (url: string) => {
        const path = new URL(url).pathname.replace(/^\/api\/v\d+/, '');
        if (path === '/projects/1/tasks') return jsonResponse([]);
        throw new Error(`unexpected path ${path}`);
      });

      const result = await toolHandler({
        subcommand: 'list',
        projectId: 1,
        orderBy: 'desc',
        filterTimezone: 'Europe/Zurich',
        filterIncludeNulls: true,
        expand: ['comments'],
      });
      const text = result.content[0]?.text ?? '';

      expect(text).toContain('orderBy, filterTimezone, filterIncludeNulls, expand');
    });

    it('does not warn when the same params are supplied on a cross-project (allProjects) listing', async () => {
      mockFetch.mockImplementation(async (url: string) => {
        const path = new URL(url).pathname.replace(/^\/api\/v\d+/, '');
        if (path === '/tasks') return jsonResponse([{ id: 1, title: 'A task', project_id: 1 }]);
        throw new Error(`unexpected path ${path}`);
      });

      const result = await toolHandler({
        subcommand: 'list',
        allProjects: true,
        orderBy: 'desc',
      });
      const text = result.content[0]?.text ?? '';

      expect(text).not.toContain('NOTE');
      expect(text).not.toContain('ignored on this single-project listing');
    });

    it('does not warn on a single-project listing when none of these params are supplied', async () => {
      mockFetch.mockImplementation(async (url: string) => {
        const path = new URL(url).pathname.replace(/^\/api\/v\d+/, '');
        if (path === '/projects/1/tasks') {
          return jsonResponse([{ id: 11, title: 'A task', project_id: 1 }]);
        }
        throw new Error(`unexpected path ${path}`);
      });

      const result = await toolHandler({ subcommand: 'list', projectId: 1 });
      const text = result.content[0]?.text ?? '';

      expect(text).not.toContain('ignored on this single-project listing');
    });
  });
});
