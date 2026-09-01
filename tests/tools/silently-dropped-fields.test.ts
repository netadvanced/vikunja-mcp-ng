/**
 * Regression guards for the **silently-dropped-field** bug class.
 *
 * Zod strips unknown object keys by default, and a hand-rolled arg remap can
 * lose a key the schema DID declare. Either way the field vanishes with no
 * error, the tool reports success, and the caller's stated intent is lost —
 * the worst failure mode in this codebase's value system, and the same
 * reasoning that made `position` on task create reject loudly (PR #229)
 * instead of being ignored.
 *
 * The confirmed instance: a battle run asked for a task "75% done", the model
 * sent one `setup-kanban` call with `tasks: [{ …, percentDone: 75 }]`, the
 * per-task shape did not declare `percentDone`, and the task was created at 0%.
 *
 * Two guarantees are tested here, per docs/ENDPOINT-PLAYBOOK.md §6 (assert the
 * OUTGOING PAYLOAD, not the return value):
 *
 * 1. **Declared-and-forwarded.** Fields the nested per-task/per-subtask shapes
 *    accept actually reach the wire, in the wire's own units.
 * 2. **Loud rejection.** An undeclared key on one of those closed nested
 *    shapes errors, naming the offending key, rather than being stripped.
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { z } from 'zod';
import type { AuthManager } from '../../src/auth/AuthManager';
import { AuthManager as RealAuthManager } from '../../src/auth/AuthManager';
import { registerTaskBulkTool, toBulkCreateTaskData } from '../../src/tools/task-bulk';
import { bulkCreateTasks } from '../../src/tools/tasks/bulk-operations';
import { registerTasksTool } from '../../src/tools/tasks';
import { registerProjectsTool } from '../../src/tools/projects';
import { createSubtask, bulkCreateSubtasks } from '../../src/tools/tasks/subtasks';
import { parseInputData } from '../../src/parsers/InputParserFactory';
import { circuitBreakerRegistry } from '../../src/utils/retry';
import type { MockAuthManager, MockServer } from '../types/mocks';

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

function mockResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    text: jest.fn(async () => JSON.stringify(body)),
  } as unknown as Response;
}

/** Records every request and answers with a body derived from the path. */
function routeByPath(handler: (method: string, path: string, body: unknown) => unknown): void {
  mockFetch.mockImplementation(async (url: unknown, init?: RequestInit) => {
    const path = new URL(String(url)).pathname.replace(/^\/api\/v\d+/, '');
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = init?.body ? (JSON.parse(init.body as string) as unknown) : undefined;
    return mockResponse(handler(method, path, body));
  });
}

/** The body of the (first) request matching method + pathname. */
function bodyOf(method: string, pathname: string): Record<string, unknown> | undefined {
  const calls = mockFetch.mock.calls as [string, RequestInit][];
  const call = calls.find(([url, init]) => {
    const p = new URL(String(url)).pathname.replace(/^\/api\/v\d+/, '');
    return (init?.method ?? 'GET').toUpperCase() === method && p === pathname;
  });
  if (!call?.[1]?.body) return undefined;
  return JSON.parse(call[1].body as string) as Record<string, unknown>;
}

function makeMockAuthManager(): MockAuthManager {
  return {
    isAuthenticated: jest.fn().mockReturnValue(true),
    getSession: jest.fn().mockReturnValue({
      apiUrl: 'https://vikunja.example.com',
      apiToken: 'test-token',
    }),
    setSession: jest.fn(),
    clearSession: jest.fn(),
    connect: jest.fn(),
    getStatus: jest.fn(),
    isConnected: jest.fn(),
    disconnect: jest.fn(),
  } as MockAuthManager;
}

/**
 * Registers a tool against a mock server and hands back both its Zod shape
 * (argument 3 of `server.tool`) and its handler (the last argument).
 */
function registerAndCapture(
  register: (server: MockServer, auth: AuthManager) => void,
  auth: MockAuthManager,
): { shape: Record<string, z.ZodTypeAny>; handler: (args: unknown) => Promise<unknown> } {
  const server = {
    tool: jest.fn() as jest.MockedFunction<
      (name: string, description: string, schema: unknown, ...rest: unknown[]) => void
    >,
  } as MockServer;
  register(server, auth as unknown as AuthManager);
  const call = server.tool.mock.calls[0] as unknown[];
  return {
    shape: call[2] as Record<string, z.ZodTypeAny>,
    handler: call[call.length - 1] as (args: unknown) => Promise<unknown>,
  };
}

describe('silently dropped fields', () => {
  let mockAuthManager: MockAuthManager;

  beforeEach(() => {
    jest.clearAllMocks();
    mockFetch.mockReset();
    circuitBreakerRegistry.clear();
    mockAuthManager = makeMockAuthManager();
  });

  /**
   * Every nested array-of-object shape an agent can populate on a write path.
   * These vocabularies are CLOSED — unlike the big shared top-level tool
   * shapes, which deliberately tolerate fields meaningless to the subcommand
   * in play (the `id`/`projectId` aliases, query params carried between
   * calls) — so an unknown key here is always a caller mistake worth failing
   * on. See src/utils/strict-nested-object.ts for the full reasoning.
   */
  describe('closed nested shapes reject unknown keys instead of stripping them', () => {
    const cases: Array<{
      name: string;
      register: (server: MockServer, auth: AuthManager) => void;
      field: string;
      valid: Record<string, unknown>;
      strayKey: string;
    }> = [
      {
        name: 'vikunja_projects setup-kanban tasks[]',
        register: registerProjectsTool,
        field: 'tasks',
        valid: { title: 'Draft release notes' },
        strayKey: 'done',
      },
      {
        name: 'vikunja_tasks bulk-create tasks[]',
        register: registerTasksTool,
        field: 'tasks',
        valid: { title: 'Draft release notes' },
        strayKey: 'hexColor',
      },
      {
        name: 'vikunja_tasks bulk-create-subtasks subtasks[]',
        register: registerTasksTool,
        field: 'subtasks',
        valid: { title: 'Sub one' },
        strayKey: 'repeatAfter',
      },
      {
        name: 'vikunja_task_bulk bulk-create tasks[]',
        register: registerTaskBulkTool,
        field: 'tasks',
        valid: { title: 'Draft release notes' },
        strayKey: 'projectId',
      },
    ];

    it.each(cases)('$name accepts the declared fields', ({ register, field, valid }) => {
      const { shape } = registerAndCapture(register, mockAuthManager);
      expect(() => (shape[field] as z.ZodTypeAny).parse([valid])).not.toThrow();
    });

    it.each(cases)(
      '$name rejects an undeclared key, naming it and what IS supported',
      ({ register, field, valid, strayKey }) => {
        const { shape } = registerAndCapture(register, mockAuthManager);
        const result = (shape[field] as z.ZodTypeAny).safeParse([
          { ...valid, [strayKey]: 'whatever' },
        ]);
        expect(result.success).toBe(false);
        const message = result.success ? '' : (result.error.issues[0]?.message ?? '');
        expect(message).toContain(`"${strayKey}"`);
        expect(message).toContain('rejected rather than silently dropped');
        expect(message).toContain('title');
      },
    );

    it('names EVERY stray key, not just the first', () => {
      const { shape } = registerAndCapture(registerProjectsTool, mockAuthManager);
      const result = (shape.tasks as z.ZodTypeAny).safeParse([
        { title: 'x', done: true, hexColor: '#ffffff' },
      ]);
      expect(result.success).toBe(false);
      const message = result.success ? '' : (result.error.issues[0]?.message ?? '');
      expect(message).toContain('"done"');
      expect(message).toContain('"hexColor"');
    });

    it('leaves every OTHER validation error untouched (only unknown keys are re-worded)', () => {
      const { shape } = registerAndCapture(registerProjectsTool, mockAuthManager);
      // An issue the OBJECT itself raises that is not an unknown key: the
      // array element is not an object at all.
      const notAnObject = (shape.tasks as z.ZodTypeAny).safeParse(['just a string']);
      expect(notAnObject.success).toBe(false);
      const objectMessage = notAnObject.success ? '' : (notAnObject.error.issues[0]?.message ?? '');
      expect(objectMessage).toContain('Expected object');
      expect(objectMessage).not.toContain('rejected rather than silently dropped');

      // And an issue a CHILD field raises keeps its own message untouched.
      const wrongFieldType = (shape.tasks as z.ZodTypeAny).safeParse([{ title: 42 }]);
      expect(wrongFieldType.success).toBe(false);
      const fieldMessage = wrongFieldType.success
        ? ''
        : (wrongFieldType.error.issues[0]?.message ?? '');
      expect(fieldMessage).toContain('Expected string');
    });

    it('leaves the shared TOP-LEVEL tool shape non-strict (aliases and carried-over params)', () => {
      const { shape } = registerAndCapture(registerProjectsTool, mockAuthManager);
      // `id` and `projectId` are deliberate aliases of one another on several
      // subcommands; a strict top level would reject calls that work today.
      expect(() => z.object(shape).parse({ subcommand: 'get', id: 1, projectId: 1 })).not.toThrow();
    });
  });

  /**
   * `vikunja_task_bulk bulk-create` rebuilt each task by hand into an
   * anonymous type using snake_case keys (`due_date`, `repeat_after`,
   * `repeat_mode`) that `BulkCreateTaskData`/`createOneBulkTask` never read,
   * and never copied `percentDone` at all. Four schema-declared fields were
   * therefore dropped between the MCP boundary and the API call.
   */
  describe('vikunja_task_bulk bulk-create forwards every declared per-task field', () => {
    let authManager: AuthManager;

    beforeEach(() => {
      authManager = new RealAuthManager();
      authManager.connect('https://vikunja.test', 'tk_test-token');
    });

    it('maps every declared field onto the key createOneBulkTask actually reads', () => {
      expect(
        toBulkCreateTaskData({
          title: 'Draft release notes',
          description: 'd',
          dueDate: '2026-09-01',
          startDate: '2026-08-01',
          endDate: '2026-09-30',
          priority: 3,
          percentDone: 75,
          labels: [1],
          assignees: [2],
          repeatAfter: 3,
          repeatMode: 'day',
        }),
      ).toEqual({
        title: 'Draft release notes',
        description: 'd',
        dueDate: '2026-09-01',
        startDate: '2026-08-01',
        endDate: '2026-09-30',
        priority: 3,
        percentDone: 75,
        labels: [1],
        assignees: [2],
        repeatAfter: 3,
        repeatMode: 'day',
      });
    });

    it('sends dueDate, percentDone and the repeat configuration on the wire', async () => {
      routeByPath(() => ({ id: 4242, project_id: 7 }));

      await bulkCreateTasks(
        {
          projectId: 7,
          tasks: [
            toBulkCreateTaskData({
              title: 'Draft release notes',
              dueDate: '2026-09-01',
              percentDone: 75,
              repeatAfter: 3,
              repeatMode: 'day',
            }),
          ],
        },
        authManager,
      );

      expect(bodyOf('PUT', '/projects/7/tasks')).toMatchObject({
        title: 'Draft release notes',
        // date-only normalized to RFC3339 midnight UTC
        due_date: '2026-09-01T00:00:00Z',
        // tool surface 0-100 -> Vikunja's 0-1 wire fraction
        percent_done: 0.75,
        // 3 days in seconds, repeat_mode 0 ("default")
        repeat_after: 259200,
        repeat_mode: 0,
      });
    });

    it('sends the 0 and 100 percentDone boundaries as 0 and 1', async () => {
      const bodies: unknown[] = [];
      mockFetch.mockImplementation(async (url: unknown, init?: RequestInit) => {
        const path = new URL(String(url)).pathname.replace(/^\/api\/v\d+/, '');
        if ((init?.method ?? 'GET').toUpperCase() === 'PUT' && path === '/projects/7/tasks') {
          bodies.push(JSON.parse(init?.body as string));
        }
        return mockResponse({ id: 4242, project_id: 7 });
      });

      await bulkCreateTasks(
        {
          projectId: 7,
          tasks: [
            toBulkCreateTaskData({ title: 'Not started', percentDone: 0 }),
            toBulkCreateTaskData({ title: 'Finished', percentDone: 100 }),
          ],
        },
        authManager,
      );

      expect(bodies[0]).toMatchObject({ percent_done: 0 });
      expect(bodies[1]).toMatchObject({ percent_done: 1 });
    });
  });

  /**
   * `vikunja_tasks` has always DECLARED `percentDone`/`startDate`/`endDate` at
   * the top level of its schema, but the subtask composites never read them —
   * so "create a subtask that is already half done" was accepted and lost.
   */
  describe('subtask composites forward percentDone / startDate / endDate', () => {
    let authManager: AuthManager;

    beforeEach(() => {
      authManager = new RealAuthManager();
      authManager.connect('https://vikunja.test', 'tk_test-token');
    });

    function routeSubtaskCreation(): void {
      routeByPath((method, path) => {
        if (method === 'GET' && path === '/tasks/10')
          return { id: 10, project_id: 3, related_tasks: { subtask: [{ id: 11 }] } };
        if (method === 'PUT' && path === '/projects/3/tasks') return { id: 11, project_id: 3 };
        if (method === 'GET' && path === '/tasks/11')
          return { id: 11, project_id: 3, related_tasks: { parenttask: [{ id: 10 }] } };
        return {};
      });
    }

    it('create-subtask sends percent_done, start_date and end_date', async () => {
      routeSubtaskCreation();
      await createSubtask(
        {
          parentTaskId: 10,
          title: 'Half done already',
          percentDone: 50,
          startDate: '2026-09-01',
          endDate: '2026-09-30',
        },
        authManager,
      );
      // start_date/end_date are date-only on input; the create-task step
      // coerces them to RFC3339 (normalizeDateForApi) before sending, same
      // as the top-level `create` path — see the dedicated 'date
      // normalization' coverage in subtasks.test.ts.
      expect(bodyOf('PUT', '/projects/3/tasks')).toMatchObject({
        percent_done: 0.5,
        start_date: '2026-09-01T00:00:00Z',
        end_date: '2026-09-30T00:00:00Z',
      });
    });

    it('bulk-create-subtasks sends percent_done per subtask', async () => {
      routeSubtaskCreation();
      await bulkCreateSubtasks(
        { parentTaskId: 10, subtasks: [{ title: 'Half done already', percentDone: 50 }] },
        authManager,
      );
      expect(bodyOf('PUT', '/projects/3/tasks')).toMatchObject({ percent_done: 0.5 });
    });

    it('rejects a fractional percentDone on create-subtask with the shared message', async () => {
      await expect(
        createSubtask({ parentTaskId: 10, title: 'x', percentDone: 0.5 }, authManager),
      ).rejects.toThrow('percentDone must be a whole number between 0 and 100');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('reports a fractional percentDone on bulk-create-subtasks as a per-item failure, naming the index, without blocking its valid sibling', async () => {
      // Since issue #226, a single item's pre-flight validation failure is caught per-item
      // rather than thrown out of the batch's eager validation pass — item 'a' (valid) must
      // still be created even though item 'b' (fractional percentDone) fails.
      routeSubtaskCreation();
      const result = await bulkCreateSubtasks(
        { parentTaskId: 10, subtasks: [{ title: 'a' }, { title: 'b', percentDone: 0.5 }] },
        authManager,
      );
      const text = result.content[0].text;
      expect(text).toContain('Successfully created and related 1 of 2 subtask(s)');
      expect(text).toContain('Failed indexes: 1');
      expect(text).toContain('subtasks[1].percentDone must be a whole number between 0 and 100');
    });
  });

  /**
   * The CSV importer's per-column `switch` has no `default:` case, so a column
   * it does not know was dropped without a word — while the SAME payload as
   * JSON is rejected, because `importedTaskSchema` is `.strict()`.
   */
  describe('batch-import CSV rejects unrecognized columns', () => {
    it('names the unknown column and lists the supported ones', () => {
      expect(() =>
        parseInputData({ format: 'csv', data: 'title,notes\nShip it,some notes' }),
      ).toThrow(/Unrecognized CSV column\(s\): "notes"/);
      expect(() =>
        parseInputData({ format: 'csv', data: 'title,notes\nShip it,some notes' }),
      ).toThrow(/Supported columns:.*percentDone/);
    });

    it('still imports (dropping the column) when skipErrors is set', () => {
      const { tasks } = parseInputData({
        format: 'csv',
        data: 'title,notes\nShip it,some notes',
        skipErrors: true,
      });
      expect(tasks).toEqual([{ title: 'Ship it' }]);
    });

    it('accepts every supported column', () => {
      const { tasks } = parseInputData({ format: 'csv', data: 'title,percentDone\nShip it,75' });
      expect(tasks).toEqual([{ title: 'Ship it', percentDone: 75 }]);
    });
  });
});
