/**
 * Tests for SQL-like filter syntax handling
 * Tests filtering functionality with complex boolean expressions
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AuthManager } from '../../src/auth/AuthManager';
import { createMockTestableAuthManager } from '../utils/test-utils';
import { registerTasksTool } from '../../src/tools/tasks';
import { MCPError } from '../../src/types';
import type { components } from '../../src/types/generated/vikunja-openapi';

type Task = components['schemas']['models.Task'];
import type { MockVikunjaClient, MockAuthManager, MockServer } from '../types/mocks';
import { parseMarkdown } from '../utils/markdown';
import { circuitBreakerRegistry } from '../../src/utils/retry';

// Import the function we're mocking
import { getAuthManagerFromContext } from '../../src/client';

// Mock the modules
jest.mock('../../src/client', () => ({
  getAuthManagerFromContext: jest.fn(),
  setGlobalClientFactory: jest.fn(),
  clearGlobalClientFactory: jest.fn(),
}));
jest.mock('../../src/auth/AuthManager');
jest.mock('../../src/utils/logger');

// Cross-project listing (no projectId / allProjects) now goes through the
// direct-REST GET /tasks strategy first (RestCrossProjectFilteringStrategy)
// rather than node-vikunja's getAllTasks. Mock global fetch so those tests
// exercise the real primary path instead of falling back and hitting the
// (deliberately incomplete) mockClient.projects stub.
const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

/** Minimal Response-like object for the REST helper. */
function mockRestResponse(opts: { ok?: boolean; status?: number; statusText?: string; text?: string }): Response {
  const { ok = true, status = 200, statusText = 'OK', text = '' } = opts;
  return {
    ok,
    status,
    statusText,
    text: jest.fn(async () => text),
  } as unknown as Response;
}

/** Mocks a single successful `GET /tasks` REST call returning `tasks`. */
function mockRestTasksSuccess(tasks: Task[]): void {
  mockFetch.mockResolvedValueOnce(mockRestResponse({ text: JSON.stringify(tasks) }));
}

/**
 * Builds the expected `GET /tasks` URL from ordered query entries, using
 * `URLSearchParams` (as the production code does) rather than
 * `encodeURIComponent` so percent-encoding matches exactly (e.g. spaces as
 * `+`, not `%20`).
 */
function expectedTasksUrl(entries: Array<[string, string]>): string {
  const query = new URLSearchParams();
  for (const [key, value] of entries) {
    query.set(key, value);
  }
  return `https://api.vikunja.test/api/v1/tasks?${query.toString()}`;
}

describe('Tasks Tool - SQL-like Filter Syntax', () => {
  let mockClient: MockVikunjaClient;
  let mockAuthManager: MockAuthManager;
  let mockServer: MockServer;
  let toolHandler: (args: any) => Promise<any>;

  // Helper function to call a tool
  async function callTool(subcommand: string, args: Record<string, any> = {}) {
    return toolHandler({
      subcommand,
      ...args,
    });
  }

  // Mock data
  const mockHighPriorityTask: Task = {
    id: 1,
    title: 'High Priority Task',
    description: 'Important task',
    done: false,
    priority: 5,
    project_id: 1,
    created: new Date().toISOString(),
    updated: new Date().toISOString(),
  } as Task;

  const mockLowPriorityTask: Task = {
    id: 2,
    title: 'Low Priority Task',
    description: 'Less important task',
    done: false,
    priority: 2,
    project_id: 1,
    created: new Date().toISOString(),
    updated: new Date().toISOString(),
  } as Task;

  beforeEach(async () => {
    // Reset all mocks
    jest.clearAllMocks();
    mockFetch.mockReset();
    // vikunjaRestRequest protects every call with a process-wide named
    // circuit breaker; clear accumulated stats between tests so a
    // deliberately failing scenario doesn't trip the breaker for a later
    // test sharing the same auto-derived breaker name.
    circuitBreakerRegistry.clear();

    // Create fresh mock instances
    mockClient = {
      getToken: jest.fn(),
      projects: {} as any,
      labels: {} as any,
      users: {} as any,
      teams: {} as any,
      shares: {} as any,
      tasks: {
        getAllTasks: jest.fn(),
        getProjectTasks: jest.fn(),
        createTask: jest.fn(),
        getTask: jest.fn(),
        updateTask: jest.fn(),
        deleteTask: jest.fn(),
        getTaskComments: jest.fn(),
        createTaskComment: jest.fn(),
        updateTaskLabels: jest.fn(),
        bulkAssignUsersToTask: jest.fn(),
        removeUserFromTask: jest.fn(),
        bulkUpdateTasks: jest.fn(),
      },
    } as MockVikunjaClient;

    mockAuthManager = createMockTestableAuthManager();
    mockAuthManager.isAuthenticated.mockReturnValue(true);
    mockAuthManager.getSession.mockReturnValue({
      apiUrl: 'https://api.vikunja.test',
      apiToken: 'test-token',
      authType: 'api-token' as const,
      userId: 'test-user-123'
    });
    mockAuthManager.getAuthType.mockReturnValue('api-token');

    // Setup mock server
    mockServer = {
      tool: jest.fn() as jest.MockedFunction<(name: string, description: string, schema: any, handler: any) => void>,
    } as MockServer;

    // Set up the session guard (returns the AuthManager now; the actual task
    // listing goes through the mocked global fetch).
    (
      getAuthManagerFromContext as jest.MockedFunction<typeof getAuthManagerFromContext>
    ).mockResolvedValue(mockAuthManager as unknown as AuthManager);

    // Register the tool
    registerTasksTool(mockServer, mockAuthManager);

    // Get the tool handler
    expect(mockServer.tool).toHaveBeenCalledWith(
      'vikunja_tasks',
      'Manage tasks with comprehensive operations (create, update, delete, list, assign, attach/list/delete files, comment, bulk operations, set Kanban bucket, bulk set Kanban bucket, set position, lookup by per-project index, create/list subtasks, bulk create subtasks, duplicate, mark-read). download-attachment cannot deliver file bytes through MCP (no binary channel) — it returns the direct download URL and auth guidance instead. create-subtask is a composite (resolve parent -> create task -> relate -> verify) with opt-in atomic rollback via `atomic: true` (default best-effort — see docs/ENDPOINT-PLAYBOOK.md §5). bulk-create-subtasks creates several subtasks under the same parent in one call (resolves the parent once, then creates/relates each sequentially, per-subtask atomic rollback, honest partial reporting of which subtasks were created/related/failed). bulk-set-bucket moves several tasks into the same Kanban bucket in one call (resolves the project/view once, then applies each move sequentially, honest partial reporting of failedIds). duplicate copies a task (labels, assignees, attachments, reminders) into the same project (PUT /tasks/{taskID}/duplicate, no body). mark-read removes the current unread status entry for a task (POST /tasks/{projecttask}/read).',
      expect.any(Object),
      expect.any(Object), // ToolAnnotations
      expect.any(Function),
    );
    const calls = mockServer.tool.mock.calls;
    if (calls.length > 0 && calls[0] && calls[0].length > 3) {
      toolHandler = calls[0][calls[0].length - 1];
    } else {
      throw new Error('Tool handler not found');
    }
  });

  describe('Filter string with special characters', () => {
    it('should re-serialize a redundantly-parenthesized single-condition filter before sending it to the API', async () => {
      // Simple filter with parentheses the user didn't need to write - a
      // single-condition group never needs wrapping parens.
      const filter = '(priority >= 4)';
      // FilterValidator now always re-serializes the parsed expression
      // through expressionToString (the server-boundary, snake_case-field
      // translation) instead of passing the caller's raw string verbatim -
      // see FilterValidator.validateAndParseFilter. groupToString only adds
      // parens around a group with more than one condition, so the
      // redundant parens the caller wrote are dropped; the semantics
      // (a single `priority >= 4` condition) are unchanged.
      const expectedFilter = 'priority >= 4';

      // Mock successful response - the API should handle the filter correctly
      mockRestTasksSuccess([mockHighPriorityTask]);

      const result = await callTool('list', { filter });

      // Cross-project listing goes straight to the direct-REST GET /tasks
      // endpoint, with the re-serialized filter string passed as a query param.
      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url] = mockFetch.mock.calls[0] as [string];
      expect(url).toBe(
        expectedTasksUrl([
          ['page', '1'],
          ['per_page', '1000'],
          ['filter', expectedFilter],
        ]),
      );
      expect(mockClient.tasks.getAllTasks).not.toHaveBeenCalled();

      const markdown = result.content[0].text;
      const parsed = parseMarkdown(markdown);
      expect(markdown).toContain("## ✅ Success");
      expect(markdown).toContain('list-tasks');
      expect(markdown).toContain('1 task');
    });

    it('should handle complex filter that cannot be converted', async () => {
      // This is the exact filter from the issue report - too complex to convert
      const filter = '(priority >= 4 && done = false)';

      // The direct REST call fails, and so does the per-project aggregation
      // fallback (this file's mock client stubs `projects` as `{}`).
      mockFetch.mockRejectedValue(new Error('mock: REST GET /tasks unavailable'));

      await expect(callTool('list', { filter })).rejects.toThrow(MCPError);
    });

    it('should handle filter without parentheses', async () => {
      const filter = 'priority >= 4 && done = false';

      mockFetch.mockRejectedValue(new Error('mock: REST GET /tasks unavailable'));

      await expect(callTool('list', { filter })).rejects.toThrow(MCPError);
    });

    it('should handle simple filter expressions', async () => {
      const filter = 'priority >= 4';

      mockRestTasksSuccess([mockHighPriorityTask]);

      const result = await callTool('list', { filter });

      // Cross-project listing goes straight to the direct-REST GET /tasks
      // endpoint, with the raw filter string passed through as a query param.
      const [url] = mockFetch.mock.calls[0] as [string];
      expect(url).toBe(
        expectedTasksUrl([
          ['page', '1'],
          ['per_page', '1000'],
          ['filter', filter],
        ]),
      );

      const markdown = result.content[0].text;
      const parsed = parseMarkdown(markdown);
      expect(markdown).toContain("## ✅ Success");
    });

    it('should handle complex filter with multiple conditions', async () => {
      const filter = "(priority >= 3 && priority <= 5) || (done = true && updated > '2024-01-01')";

      mockFetch.mockRejectedValue(new Error('mock: REST GET /tasks unavailable'));

      await expect(callTool('list', { filter })).rejects.toThrow(MCPError);
    });

    it('should handle filter with project-specific tasks', async () => {
      const projectId = 42;
      const filter = '(priority >= 4 && done = false)';

      // Single-project + filter goes through ServerSideFilteringStrategy
      // (direct REST GET /projects/{id}/tasks), not node-vikunja's
      // getProjectTasks.
      mockRestTasksSuccess([mockHighPriorityTask]);

      const result = await callTool('list', { projectId, filter });

      const query = new URLSearchParams();
      query.set('page', '1');
      query.set('per_page', '1000');
      query.set('filter', filter);
      const [url] = mockFetch.mock.calls[0] as [string];
      expect(url).toBe(`https://api.vikunja.test/api/v1/projects/${projectId}/tasks?${query.toString()}`);

      const markdown = result.content[0].text;
      const parsed = parseMarkdown(markdown);
      expect(markdown).toContain("## ✅ Success");
    });

    it('should combine filter with other query parameters', async () => {
      const filter = '(priority >= 4 && done = false)';

      mockRestTasksSuccess([mockHighPriorityTask]);

      const result = await callTool('list', {
        filter,
        page: 2,
        perPage: 20,
        sort: 'priority',
        search: 'urgent',
      });

      const [url] = mockFetch.mock.calls[0] as [string];
      expect(url).toBe(
        expectedTasksUrl([
          ['page', '2'],
          ['per_page', '20'],
          ['s', 'urgent'],
          ['sort_by', 'priority'],
          ['filter', filter],
        ]),
      );

      const markdown = result.content[0].text;
      const parsed = parseMarkdown(markdown);
      expect(markdown).toContain("## ✅ Success");
    });

    it('should handle API errors gracefully', async () => {
      const filter = '(priority >= 4 && done = false)';

      // Simulate the failure: direct REST fails, and so does the
      // per-project aggregation fallback's own GET /projects call (which
      // vikunjaRestRequest wraps as an MCPError, propagated as-is by
      // listTasks rather than re-wrapped generically).
      mockFetch.mockRejectedValue(new Error('Internal Server Error'));

      await expect(callTool('list', { filter })).rejects.toThrow(MCPError);
      await expect(callTool('list', { filter })).rejects.toMatchObject({
        code: 'API_ERROR',
        message: expect.stringContaining('Vikunja REST request failed'),
      });
    });
  });

  describe('camelCase field-name translation (filter-verbatim-passthrough fix)', () => {
    // Regression test for the fix itself: a raw filter string using the
    // filter DSL's canonical camelCase field name (`dueDate`) must reach
    // Vikunja translated to the API's snake_case Task field (`due_date`) -
    // previously (when `args.done` was undefined) the raw string reached
    // the server untranslated, either erroring server-side (silently
    // tripping the hybrid client-side fallback) or being ignored outright.
    it('translates a camelCase field to snake_case in the outgoing filter, with no client-side fallback', async () => {
      const filter = 'dueDate < now+7d';

      mockRestTasksSuccess([mockHighPriorityTask]);

      const result = await callTool('list', { filter });

      // Exactly one call: server-side filtering succeeds outright, no
      // fallback to per-project aggregation / client-side filtering.
      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url] = mockFetch.mock.calls[0] as [string];
      expect(url).toBe(
        expectedTasksUrl([
          ['page', '1'],
          ['per_page', '1000'],
          ['filter', 'due_date < now+7d'],
        ]),
      );

      // The filtering-accounting metadata reports this honestly as
      // server-side-used, not a client-side fallback - see
      // RestCrossProjectFilteringStrategy.execute's metadata and
      // src/tools/tasks/index.ts's filteringMessage derivation.
      const markdown = result.content[0].text;
      expect(markdown).toContain("## ✅ Success");
      expect(markdown).toContain('(filtered server-side)');
      expect(markdown).not.toContain('server-side fallback');
    });

    it('translates a camelCase field combined with other conditions, still with no fallback', async () => {
      const filter = 'priority >= 4 && dueDate < now+7d';

      mockRestTasksSuccess([mockHighPriorityTask]);

      const result = await callTool('list', { filter });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url] = mockFetch.mock.calls[0] as [string];
      expect(url).toBe(
        expectedTasksUrl([
          ['page', '1'],
          ['per_page', '1000'],
          ['filter', '(priority >= 4 && due_date < now+7d)'],
        ]),
      );

      const markdown = result.content[0].text;
      expect(markdown).toContain("## ✅ Success");
      expect(markdown).toContain('(filtered server-side)');
    });
  });

  describe('Filter operators', () => {
    const testCases = [
      {
        filter: 'priority = 5',
        description: 'equals operator',
        expected: { page: 1, per_page: 1000 },
      },
      {
        filter: 'priority > 3',
        description: 'greater than operator',
        expected: { page: 1, per_page: 1000 },
      },
      {
        filter: 'priority >= 4',
        description: 'greater than or equal operator',
        expected: { page: 1, per_page: 1000 },
      },
      {
        filter: 'priority < 3',
        description: 'less than operator',
        expected: { page: 1, per_page: 1000 },
      },
      {
        filter: 'priority <= 2',
        description: 'less than or equal operator',
        expected: { page: 1, per_page: 1000 },
      },
      {
        filter: "title like 'urgent'",
        // FilterValidator re-serializes through expressionToString, which
        // always double-quotes `like` values regardless of the caller's own
        // quote style (single quotes here) - this is the server-boundary
        // quoting Vikunja's filter grammar actually expects; the value
        // itself (`urgent`) is unchanged. (parseQuotedString now accepts
        // `'` as a quote character too, so the single-quoted value round-
        // trips as the string `urgent`, not the literal 4 characters
        // `'urgent'` - see parseQuotedString's doc comment.)
        expectedFilter: 'title like "urgent"',
        description: 'like operator',
        expected: { page: 1, per_page: 1000 },
      },
      {
        filter: 'priority in 3,4,5',
        // expressionToString normalizes `in`/`not in` array spacing to
        // `value, value, ...` - the values themselves are unchanged.
        expectedFilter: 'priority in 3, 4, 5',
        description: 'in operator',
        expected: { page: 1, per_page: 1000 },
      },
    ];

    testCases.forEach(({ filter, expectedFilter, description, expected }) => {
      it(`should handle ${description}`, async () => {
        mockRestTasksSuccess([mockHighPriorityTask]);

        const result = await callTool('list', { filter });

        // Cross-project listing goes straight to the direct-REST GET /tasks
        // endpoint. FilterValidator re-serializes the parsed filter through
        // expressionToString before it reaches the API (see
        // FilterValidator.validateAndParseFilter) rather than passing the
        // caller's raw string verbatim, so the query param may differ
        // syntactically (though never semantically) from `filter`.
        const [url] = mockFetch.mock.calls[0] as [string];
        expect(url).toBe(
          expectedTasksUrl([
            ['page', String(expected.page)],
            ['per_page', String(expected.per_page)],
            ['filter', expectedFilter ?? filter],
          ]),
        );

        const markdown = result.content[0].text;
        const parsed = parseMarkdown(markdown);
        expect(markdown).toContain("## ✅ Success");
      });
    });
  });

  describe('Filter logical operators', () => {
    const testCases = [
      {
        filter: 'priority >= 4 && done = false',
        // expressionToString's groupToString parenthesizes any group with
        // more than one condition (here, both conditions share a single
        // implicit group joined by `&&`) - matching the parenthesized form
        // Vikunja's own filter grammar examples use for multi-condition
        // groups (see docs/API_NOTES.md), and identical in meaning to the
        // caller's unparenthesized original.
        expectedFilter: '(priority >= 4 && done = false)',
        description: 'AND operator',
      },
      {
        filter: 'priority >= 5 || done = true',
        expectedFilter: '(priority >= 5 || done = true)',
        description: 'OR operator',
      },
      {
        // Already fully parenthesized by the caller in a way that survives
        // re-serialization unchanged: two separate groups (`(priority >= 4
        // && done = false)` and `assignees in 1`) joined by the top-level
        // `||` - the first group has 2 conditions so groupToString adds
        // parens (already present); the second has exactly 1 condition so
        // groupToString adds none (none were present).
        filter: '(priority >= 4 && done = false) || assignees in 1',
        description: 'combined operators with parentheses',
      },
    ];

    testCases.forEach(({ filter, description, ...rest }) => {
      const expectedFilter = 'expectedFilter' in rest ? rest.expectedFilter : filter;
      it(`should handle ${description}`, async () => {
        mockRestTasksSuccess([mockHighPriorityTask]);

        const result = await callTool('list', { filter });

        // Cross-project listing goes straight to the direct-REST GET /tasks
        // endpoint. FilterValidator re-serializes the parsed filter through
        // expressionToString before it reaches the API (see
        // FilterValidator.validateAndParseFilter) rather than passing the
        // caller's raw string verbatim, so the query param may differ
        // syntactically (though never semantically) from `filter`.
        const [url] = mockFetch.mock.calls[0] as [string];
        expect(url).toBe(
          expectedTasksUrl([
            ['page', '1'],
            ['per_page', '1000'],
            ['filter', expectedFilter],
          ]),
        );

        const markdown = result.content[0].text;
        const parsed = parseMarkdown(markdown);
        expect(markdown).toContain("## ✅ Success");
      });
    });
  });
});
