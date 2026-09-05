/**
 * Tests for bulk operations
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import {
  bulkUpdateTasks as _bulkUpdateTasks,
  bulkDeleteTasks as _bulkDeleteTasks,
  bulkCreateTasks as _bulkCreateTasks,
} from '../../../src/tools/tasks/bulk-operations';
import { AuthManager } from '../../../src/auth/AuthManager';
import { MCPError, ErrorCode } from '../../../src/types';
import { isAuthenticationError } from '../../../src/utils/auth-error-handler';
import { withRetry } from '../../../src/utils/retry';
import { vikunjaRestRequest } from '../../../src/utils/vikunja-rest';
import { parseMarkdown } from '../../utils/markdown';

jest.mock('../../../src/utils/auth-error-handler');
jest.mock('../../../src/utils/retry');
jest.mock('../../../src/utils/logger');
// Migrated (Wave D, tasks-core): the core get/update/create/delete calls in
// bulk-operations-simplified.ts go through vikunjaRestRequest now.
// Labels/assignees remain on the node-vikunja client (sub-resource, sibling
// item M-B).
jest.mock('../../../src/utils/vikunja-rest', () => ({
  vikunjaRestRequest: jest.fn(),
}));

describe('Bulk operations', () => {
  const mockClient = {
    tasks: {
      bulkUpdateTasks: jest.fn(),
      getTask: jest.fn(),
      updateTask: jest.fn(),
      deleteTask: jest.fn(),
      createTask: jest.fn(),
      bulkAssignUsersToTask: jest.fn(),
      assignUserToTask: jest.fn(),
      removeUserFromTask: jest.fn(),
      updateTaskLabels: jest.fn(),
    },
  };
  const mockRest = vikunjaRestRequest as jest.Mock;

  // The bulk ops now take an AuthManager directly (REST transport). These thin
  // wrappers inject a live session so each call site stays argument-for-argument
  // identical to the pre-migration tests.
  let authManager: AuthManager;
  const bulkUpdateTasks = (args: Parameters<typeof _bulkUpdateTasks>[0]) =>
    _bulkUpdateTasks(args, authManager);
  const bulkDeleteTasks = (args: Parameters<typeof _bulkDeleteTasks>[0]) =>
    _bulkDeleteTasks(args, authManager);
  const bulkCreateTasks = (args: Parameters<typeof _bulkCreateTasks>[0]) =>
    _bulkCreateTasks(args, authManager);

  beforeEach(() => {
    jest.clearAllMocks();
    (isAuthenticationError as jest.Mock).mockReturnValue(false);
    (withRetry as jest.Mock).mockImplementation((fn) => fn());

    authManager = new AuthManager();
    authManager.connect('https://vikunja.test', 'tk_test-token');

    // Proxy the core REST calls (GET/POST /tasks/{id}, PUT
    // /projects/{id}/tasks, DELETE /tasks/{id}) through the existing
    // mockClient.tasks.{getTask,updateTask,createTask,deleteTask} mocks, so
    // every test's per-scenario mock configuration (and call-count/args
    // assertions on those methods) keeps driving behavior unchanged. The
    // label sub-resource POST /tasks/{id}/labels/bulk (setTaskLabels, post
    // Wave-D #71) and the per-user assignee PUT/DELETE (post Wave-D #70) also
    // flow through this same mocked vikunjaRestRequest and resolve success by
    // default; label/assignee-specific tests assert on mockRest directly.
    mockRest.mockImplementation(
      async (_auth: unknown, method: string, path: string, body?: unknown) => {
        const labelBulkMatch = /^\/tasks\/(\d+)\/labels\/bulk$/.exec(path);
        if (method === 'POST' && labelBulkMatch?.[1] !== undefined) {
          return undefined;
        }
        // Additive per-user assign / single-user unassign endpoints.
        if (method === 'PUT' && /^\/tasks\/\d+\/assignees$/.test(path)) {
          return undefined;
        }
        if (method === 'DELETE' && /^\/tasks\/\d+\/assignees\/\d+$/.test(path)) {
          return undefined;
        }
        const taskIdMatch = /^\/tasks\/(\d+)$/.exec(path);
        if (method === 'GET' && taskIdMatch?.[1] !== undefined) {
          return mockClient.tasks.getTask(Number(taskIdMatch[1]));
        }
        if (method === 'POST' && taskIdMatch?.[1] !== undefined) {
          return mockClient.tasks.updateTask(Number(taskIdMatch[1]), body);
        }
        if (method === 'DELETE' && taskIdMatch?.[1] !== undefined) {
          return mockClient.tasks.deleteTask(Number(taskIdMatch[1]));
        }
        const projectTasksMatch = /^\/projects\/(\d+)\/tasks$/.exec(path);
        if (method === 'PUT' && projectTasksMatch?.[1] !== undefined) {
          return mockClient.tasks.createTask(Number(projectTasksMatch[1]), body);
        }
        throw new Error(`mockRest: unhandled ${method} ${path}`);
      },
    );
  });

  describe('bulkUpdateTasks', () => {
    describe('Input validation', () => {
      it('should throw error when taskIds is missing', async () => {
        await expect(bulkUpdateTasks({ field: 'done', value: true })).rejects.toThrow(
          'taskIds array is required for bulk update operation',
        );
      });

      it('should throw error when taskIds is empty', async () => {
        await expect(bulkUpdateTasks({ taskIds: [], field: 'done', value: true })).rejects.toThrow(
          'taskIds array is required for bulk update operation',
        );
      });

      it('should throw error when field is missing', async () => {
        await expect(bulkUpdateTasks({ taskIds: [1, 2], value: true })).rejects.toThrow(
          'field is required for bulk update operation',
        );
      });

      it('should throw error when value is undefined', async () => {
        await expect(bulkUpdateTasks({ taskIds: [1, 2], field: 'done' })).rejects.toThrow(
          'value is required for bulk update operation',
        );
      });

      it('should throw error when too many tasks', async () => {
        const taskIds = Array.from({ length: 101 }, (_, i) => i + 1);
        await expect(bulkUpdateTasks({ taskIds, field: 'done', value: true })).rejects.toThrow(
          'Too many tasks for bulk operation. Maximum allowed: 100',
        );
      });

      it('should validate task IDs', async () => {
        await expect(
          bulkUpdateTasks({ taskIds: [1, -2], field: 'done', value: true }),
        ).rejects.toThrow('task ID must be a positive integer');
      });

      it('should throw error for invalid field', async () => {
        await expect(
          bulkUpdateTasks({ taskIds: [1, 2], field: 'invalid_field', value: true }),
        ).rejects.toThrow('Invalid field: invalid_field');
      });

      it('should reject a camelCase field name that would silently no-op in the native fields:[] payload', async () => {
        // The native POST /tasks/bulk payload keys `fields` by these exact
        // strings (see applyFieldUpdate / models.BulkTask); 'dueDate' is the
        // MCP-schema camelCase spelling and is never one of them, so letting
        // it through would send `fields: ["dueDate"]`, which the server
        // ignores — a silent no-op rather than an update. Reject it up
        // front and list the valid (snake_case) field names for
        // discoverability.
        await expect(
          bulkUpdateTasks({ taskIds: [1, 2], field: 'dueDate', value: '2024-05-24T10:00:00Z' }),
        ).rejects.toThrow('Invalid field: dueDate. Allowed fields:');
      });

      it('should validate priority range', async () => {
        await expect(
          bulkUpdateTasks({ taskIds: [1, 2], field: 'priority', value: 6 }),
        ).rejects.toThrow('Priority must be between 0 and 5');
      });

      it('should validate date format for due_date', async () => {
        await expect(
          bulkUpdateTasks({ taskIds: [1, 2], field: 'due_date', value: 'invalid-date' }),
        ).rejects.toThrow('due_date must be a valid ISO 8601 date string');
      });

      it('should validate project_id', async () => {
        await expect(
          bulkUpdateTasks({ taskIds: [1, 2], field: 'project_id', value: -1 }),
        ).rejects.toThrow('project_id must be a positive integer');
      });

      it('should validate assignees array', async () => {
        await expect(
          bulkUpdateTasks({ taskIds: [1, 2], field: 'assignees', value: 'not-array' }),
        ).rejects.toThrow('assignees must be an array of numbers');
      });

      it('should validate assignee IDs', async () => {
        await expect(
          bulkUpdateTasks({ taskIds: [1, 2], field: 'assignees', value: [1, -2] }),
        ).rejects.toThrow('assignees ID must be a positive integer');
      });

      it('should validate done field type', async () => {
        await expect(
          bulkUpdateTasks({ taskIds: [1, 2], field: 'done', value: 'maybe' }),
        ).rejects.toThrow('done field must be a boolean value (true or false)');
      });

      it('should validate repeat_after range', async () => {
        await expect(
          bulkUpdateTasks({ taskIds: [1, 2], field: 'repeat_after', value: -1 }),
        ).rejects.toThrow('repeat_after must be a non-negative number');
      });

      it('should validate repeat_mode values', async () => {
        await expect(
          bulkUpdateTasks({ taskIds: [1, 2], field: 'repeat_mode', value: 'invalid' }),
        ).rejects.toThrow('Invalid repeat_mode: invalid');
      });

      it('should reject legacy interval-style repeat_mode values (day/week/year) that never matched the API enum', async () => {
        for (const legacyValue of ['day', 'week', 'year']) {
          await expect(
            bulkUpdateTasks({ taskIds: [1, 2], field: 'repeat_mode', value: legacyValue }),
          ).rejects.toThrow(`Invalid repeat_mode: ${legacyValue}`);
        }
      });

      it('should accept every REPEAT_MODE_MAP key (default, month, from_current) as a valid repeat_mode', async () => {
        const repeatModeConversions: Record<string, number> = {
          default: 0,
          month: 1,
          from_current: 2,
        };

        for (const [mode, expectedNumeric] of Object.entries(repeatModeConversions)) {
          jest.clearAllMocks();
          (isAuthenticationError as jest.Mock).mockReturnValue(false);
          (withRetry as jest.Mock).mockImplementation((fn) => fn());

          mockClient.tasks.getTask.mockResolvedValue({ id: 1, title: 'T', project_id: 1 });
          mockClient.tasks.updateTask.mockResolvedValue({ id: 1, title: 'T', project_id: 1 });

          await bulkUpdateTasks({ taskIds: [1], field: 'repeat_mode', value: mode });

          expect(mockClient.tasks.updateTask).toHaveBeenCalledWith(
            1,
            expect.objectContaining({ repeat_mode: expectedNumeric }),
          );
        }
      });
    });

    describe('Type coercion', () => {
      it('should convert string "true" to boolean for done field', async () => {
        mockClient.tasks.getTask.mockResolvedValue({ id: 1, title: 'T', done: false });
        mockClient.tasks.updateTask.mockResolvedValue({ id: 1, title: 'T', done: true });

        await bulkUpdateTasks({ taskIds: [1], field: 'done', value: 'true' });

        expect(mockClient.tasks.bulkUpdateTasks).not.toHaveBeenCalled();
        expect(mockClient.tasks.updateTask).toHaveBeenCalledWith(
          1,
          expect.objectContaining({ done: true }),
        );
      });

      it('should convert string "false" to boolean for done field', async () => {
        mockClient.tasks.getTask.mockResolvedValue({ id: 1, title: 'T', done: true });
        mockClient.tasks.updateTask.mockResolvedValue({ id: 1, title: 'T', done: false });

        await bulkUpdateTasks({ taskIds: [1], field: 'done', value: 'false' });

        expect(mockClient.tasks.updateTask).toHaveBeenCalledWith(
          1,
          expect.objectContaining({ done: false }),
        );
      });

      it('should convert string numbers to numbers for priority field', async () => {
        mockClient.tasks.getTask.mockResolvedValue({ id: 1, title: 'T', priority: 0 });
        mockClient.tasks.updateTask.mockResolvedValue({ id: 1, title: 'T', priority: 3 });

        await bulkUpdateTasks({ taskIds: [1], field: 'priority', value: '3' });

        expect(mockClient.tasks.updateTask).toHaveBeenCalledWith(
          1,
          expect.objectContaining({ priority: 3 }),
        );
      });
    });

    describe('Native bulk update path (POST /tasks/bulk honesty)', () => {
      // These tests exercise the native single-request path directly, so
      // POST /tasks/bulk must be handled by the mock (the shared beforeEach
      // mockRest only routes GET/POST/DELETE for /tasks/{id} and friends).
      const routeNativeBulk = (
        bulkResponseTasks: Array<Record<string, unknown>>,
        options: {
          assigneesByTaskId?: Record<number, Array<{ id: number }>>;
          assigneeRestoreError?: Error;
        } = {},
      ) => {
        mockRest.mockImplementation(
          async (_auth: unknown, method: string, path: string, body?: unknown) => {
            const taskIdMatch = /^\/tasks\/(\d+)$/.exec(path);
            if (method === 'GET' && taskIdMatch?.[1] !== undefined) {
              const id = Number(taskIdMatch[1]);
              return {
                id,
                title: `Task ${id}`,
                done: false,
                assignees: options.assigneesByTaskId?.[id] ?? [],
              };
            }
            if (method === 'POST' && path === '/tasks/bulk') {
              return {
                task_ids: (body as { task_ids: number[] }).task_ids,
                tasks: bulkResponseTasks,
              };
            }
            // Assignee restore-to-snapshot: ONE POST .../assignees/bulk call
            // per task (models.BulkAssignees, REPLACE semantics), not a
            // per-user PUT loop.
            if (method === 'POST' && /^\/tasks\/\d+\/assignees\/bulk$/.test(path)) {
              if (options.assigneeRestoreError) throw options.assigneeRestoreError;
              return undefined;
            }
            throw new Error(`mockRest: unhandled ${method} ${path}`);
          },
        );
      };

      it('reports partial success when the server returns fewer tasks than requested (2 of 3)', async () => {
        routeNativeBulk([
          { id: 1, title: 'Task 1', done: true, assignees: [] },
          { id: 2, title: 'Task 2', done: true, assignees: [] },
        ]);

        const result = await bulkUpdateTasks({ taskIds: [1, 2, 3], field: 'done', value: true });

        const markdown = result.content[0].text;
        const parsed = parseMarkdown(markdown);
        expect(parsed.hasHeading(2, /Error/)).toBe(true);
        expect(markdown).toContain(
          'Bulk update partially completed. Successfully updated 2 tasks. Failed task IDs: 3',
        );
        expect(markdown).toContain('**count:** 2');
        expect(markdown).toContain('**FailedCount**:\n1');
        expect(markdown).toContain('**FailedIds**:\n[3]');
      });

      it('reports unchanged full success when the server returns every requested task', async () => {
        routeNativeBulk([
          { id: 1, title: 'Task 1', done: true, assignees: [] },
          { id: 2, title: 'Task 2', done: true, assignees: [] },
        ]);

        const result = await bulkUpdateTasks({ taskIds: [1, 2], field: 'done', value: true });

        const markdown = result.content[0].text;
        const parsed = parseMarkdown(markdown);
        expect(parsed.hasHeading(2, /Success/)).toBe(true);
        expect(markdown).toContain('Successfully updated 2 tasks');
        expect(markdown).toContain('**count:** 2');
        expect(markdown).not.toContain('failedCount');
        expect(markdown).not.toContain('assigneeRestoreFailures');
      });

      it('surfaces assignee-restore failures instead of silently swallowing them', async () => {
        const restoreError = new Error('assignee restore failed: database is locked');
        routeNativeBulk([{ id: 1, title: 'Task 1', done: true, assignees: [] }], {
          assigneesByTaskId: { 1: [{ id: 5 }] },
          assigneeRestoreError: restoreError,
        });

        const result = await bulkUpdateTasks({ taskIds: [1], field: 'done', value: true });

        expect(mockRest).toHaveBeenCalledWith(
          expect.anything(),
          'POST',
          '/tasks/1/assignees/bulk',
          { assignees: [{ id: 5 }] },
        );

        const markdown = result.content[0].text;
        const parsed = parseMarkdown(markdown);
        expect(parsed.hasHeading(2, /Error/)).toBe(true);
        expect(markdown).toContain('Assignee restoration failed for task(s): 1');
        expect(markdown).toContain('**count:** 1');
        // No missing IDs in this scenario — only the assignee restore failed.
        expect(markdown).not.toContain('FailedIds');
      });

      it('restores a task with multiple snapshotted assignees via ONE POST .../assignees/bulk call (not a per-user loop)', async () => {
        routeNativeBulk([{ id: 1, title: 'Task 1', done: true, assignees: [] }], {
          assigneesByTaskId: { 1: [{ id: 5 }, { id: 7 }] },
        });

        const result = await bulkUpdateTasks({ taskIds: [1], field: 'done', value: true });

        // Exactly one bulk-assignee restore call for the task, carrying
        // the full snapshotted assignee set in one request body — the
        // SIMPLIFY item's whole point (was: one PUT per user).
        const restoreCalls = mockRest.mock.calls.filter(
          (call) => call[1] === 'POST' && call[2] === '/tasks/1/assignees/bulk',
        );
        expect(restoreCalls).toHaveLength(1);
        expect(restoreCalls[0]?.[3]).toEqual({ assignees: [{ id: 5 }, { id: 7 }] });
        expect(mockRest).not.toHaveBeenCalledWith(
          expect.anything(),
          'PUT',
          '/tasks/1/assignees',
          expect.anything(),
        );

        const markdown = result.content[0].text;
        expect(markdown).toContain('## ✅ Success');
      });

      it('aggregates every snapshotted user on a task as a restore failure when the single bulk restore call fails', async () => {
        const restoreError = new Error('assignee restore failed: database is locked');
        routeNativeBulk([{ id: 1, title: 'Task 1', done: true, assignees: [] }], {
          assigneesByTaskId: { 1: [{ id: 5 }, { id: 7 }] },
          assigneeRestoreError: restoreError,
        });

        const result = await bulkUpdateTasks({ taskIds: [1], field: 'done', value: true });

        const markdown = result.content[0].text;
        const parsed = parseMarkdown(markdown);
        // Same {taskId, userId}-pair failure surface as before the
        // simplification (PR #95's assigneeRestoreFailures contract) — the
        // task is still reported as a failed restore even though only one
        // REST call failed (covering both snapshotted users).
        expect(parsed.hasHeading(2, /Error/)).toBe(true);
        expect(markdown).toContain('Assignee restoration failed for task(s): 1');
      });

      // Issue #267(a): the pre-update snapshot only read `preFetch.successful`,
      // so a task whose snapshot GET failed still went into the destructive
      // bulk call — its assignees were wiped with nothing left to restore
      // them from, and the whole thing was reported as a full success.
      describe('unreadable pre-update snapshot (issue #267(a))', () => {
        const routeWithFailingSnapshot = (failingIds: number[]) => {
          mockRest.mockImplementation(
            async (_auth: unknown, method: string, path: string, body?: unknown) => {
              const taskIdMatch = /^\/tasks\/(\d+)$/.exec(path);
              if (method === 'GET' && taskIdMatch?.[1] !== undefined) {
                const id = Number(taskIdMatch[1]);
                if (failingIds.includes(id)) throw new Error(`snapshot read failed for ${id}`);
                return { id, title: `Task ${id}`, done: false, assignees: [{ id: 5 }] };
              }
              if (method === 'POST' && path === '/tasks/bulk') {
                const ids = (body as { task_ids: number[] }).task_ids;
                return {
                  task_ids: ids,
                  tasks: ids.map((id) => ({ id, title: `Task ${id}`, done: true })),
                };
              }
              if (method === 'POST' && /^\/tasks\/\d+\/assignees\/bulk$/.test(path)) {
                return undefined;
              }
              throw new Error(`mockRest: unhandled ${method} ${path}`);
            },
          );
        };

        it('withholds a task whose snapshot read failed from the bulk payload', async () => {
          routeWithFailingSnapshot([2]);

          const result = await bulkUpdateTasks({ taskIds: [1, 2, 3], field: 'done', value: true });

          const bulkCall = mockRest.mock.calls.find(
            (call) => call[1] === 'POST' && call[2] === '/tasks/bulk',
          );
          expect((bulkCall?.[3] as { task_ids: number[] }).task_ids).toEqual([1, 3]);
          // Task 2 keeps its assignees precisely because it was never sent.
          expect(mockRest).not.toHaveBeenCalledWith(
            expect.anything(),
            'POST',
            '/tasks/2/assignees/bulk',
            expect.anything(),
          );

          const markdown = result.content[0].text;
          expect(parseMarkdown(markdown).hasHeading(2, /Error/)).toBe(true);
          expect(markdown).toContain('Failed task IDs: 2');
          expect(markdown).toContain(
            'Task(s) 2 were left untouched because their pre-update assignee snapshot could not be read',
          );
        });

        it('falls back to the per-task path rather than running a bulk call it cannot undo', async () => {
          routeWithFailingSnapshot([1]);

          // Every snapshot read fails, so there is no restorable state at all:
          // the native call must not run. The per-task fallback then fails too
          // (its own GET fails), which is honest — nothing was destroyed.
          await expect(
            bulkUpdateTasks({ taskIds: [1], field: 'done', value: true }),
          ).rejects.toThrow('Bulk update failed. Could not update any tasks');

          expect(mockRest).not.toHaveBeenCalledWith(
            expect.anything(),
            'POST',
            '/tasks/bulk',
            expect.anything(),
          );
        });
      });

      // Issue #267(b): the honesty check runs AFTER the destructive bulk POST.
      // When it throws, control passes to the per-task fallback, which
      // re-fetches each task — and a task re-read after the wipe reports an
      // empty assignee list, so the fallback used to cement the loss.
      describe('honesty-check throw after the destructive bulk POST (issue #267(b))', () => {
        it('restores the snapshot even though the bulk update is judged not applied', async () => {
          mockRest.mockImplementation(async (_auth: unknown, method: string, path: string) => {
            const taskIdMatch = /^\/tasks\/(\d+)$/.exec(path);
            if (method === 'GET' && taskIdMatch?.[1] !== undefined) {
              // After the wipe every read reports an empty assignee list.
              const wiped = mockRest.mock.calls.some(
                (call) => call[1] === 'POST' && call[2] === '/tasks/bulk',
              );
              return {
                id: 1,
                title: 'Task 1',
                done: false,
                assignees: wiped ? [] : [{ id: 5 }, { id: 7 }],
              };
            }
            if (method === 'POST' && path === '/tasks/bulk') {
              // Server echoes the task WITHOUT the requested value applied,
              // which is what trips the honesty check.
              return { task_ids: [1], tasks: [{ id: 1, title: 'Task 1', done: false }] };
            }
            if (method === 'POST' && path === '/tasks/1') {
              return { id: 1, title: 'Task 1', done: true };
            }
            if (method === 'POST' && path === '/tasks/1/assignees/bulk') {
              return undefined;
            }
            throw new Error(`mockRest: unhandled ${method} ${path}`);
          });

          const result = await bulkUpdateTasks({ taskIds: [1], field: 'done', value: true });

          const restoreCalls = mockRest.mock.calls.filter(
            (call) => call[1] === 'POST' && call[2] === '/tasks/1/assignees/bulk',
          );
          expect(restoreCalls).toHaveLength(1);
          expect(restoreCalls[0]?.[3]).toEqual({ assignees: [{ id: 5 }, { id: 7 }] });
          // Fallback still ran and produced an honest success.
          expect(mockRest).toHaveBeenCalledWith(
            expect.anything(),
            'POST',
            '/tasks/1',
            expect.anything(),
          );
          expect(result.content[0].text).toContain('## ✅ Success');
        });

        it('retries an unrestored task in the fallback and reports it when that fails too', async () => {
          mockRest.mockImplementation(async (_auth: unknown, method: string, path: string) => {
            const taskIdMatch = /^\/tasks\/(\d+)$/.exec(path);
            if (method === 'GET' && taskIdMatch?.[1] !== undefined) {
              return { id: 1, title: 'Task 1', done: false, assignees: [{ id: 5 }] };
            }
            if (method === 'POST' && path === '/tasks/bulk') {
              return { task_ids: [1], tasks: [{ id: 1, title: 'Task 1', done: false }] };
            }
            if (method === 'POST' && path === '/tasks/1') {
              return { id: 1, title: 'Task 1', done: true };
            }
            if (method === 'POST' && path === '/tasks/1/assignees/bulk') {
              throw new Error('database is locked');
            }
            throw new Error(`mockRest: unhandled ${method} ${path}`);
          });

          const result = await bulkUpdateTasks({ taskIds: [1], field: 'done', value: true });

          // Once in the native path, once more from the fallback.
          const restoreCalls = mockRest.mock.calls.filter(
            (call) => call[1] === 'POST' && call[2] === '/tasks/1/assignees/bulk',
          );
          expect(restoreCalls).toHaveLength(2);

          const markdown = result.content[0].text;
          expect(parseMarkdown(markdown).hasHeading(2, /Error/)).toBe(true);
          expect(markdown).toContain('Assignee restoration failed for task(s): 1');
        });
      });

      // `percent_done` was missing from the bulk-update field allowlist while
      // single `update` supported it — bulk-update rejected a value single
      // update accepted. The scale is a FRACTION 0-1 (0.5 = 50%), matching
      // models.Task.percent_done; see the note in
      // tests/tools/tasks/create-field-gaps.test.ts for the go-vikunja
      // evidence.
      // bulk-update addresses the field by its raw snake_case API name, but it
      // takes the SAME whole-percentage 0-100 scale as `percentDone`
      // everywhere else on the tool surface — one scale, no exception to
      // remember (decision 22, docs/ROADMAP.md §3). The conversion to the 0-1
      // wire fraction happens once, in `resolveBulkUpdateValue`, which feeds
      // both the native POST /tasks/bulk payload asserted here and the
      // per-task fallback's merge.
      describe('percent_done field (0-100 percentage in, 0-1 fraction on the wire)', () => {
        it('converts a 0-100 percent_done to the fraction in the native bulk payload', async () => {
          let sentBody: unknown;
          mockRest.mockImplementation(
            async (_auth: unknown, method: string, path: string, body?: unknown) => {
              if (method === 'GET' && /^\/tasks\/\d+$/.test(path)) {
                return { id: 1, title: 'Task 1', assignees: [] };
              }
              if (method === 'POST' && path === '/tasks/bulk') {
                sentBody = body;
                return {
                  task_ids: (body as { task_ids: number[] }).task_ids,
                  tasks: [{ id: 1, title: 'Task 1', percent_done: 0.5 }],
                };
              }
              throw new Error(`mockRest: unhandled ${method} ${path}`);
            },
          );

          const result = await bulkUpdateTasks({
            taskIds: [1],
            field: 'percent_done',
            value: 50,
          });

          expect(sentBody).toEqual({
            task_ids: [1],
            fields: ['percent_done'],
            values: { percent_done: 0.5 },
          });
          expect(result.content[0].text).toContain('## ✅ Success');
        });

        it('coerces a stringified percent_done from a stale client schema', async () => {
          let sentBody: unknown;
          mockRest.mockImplementation(
            async (_auth: unknown, method: string, path: string, body?: unknown) => {
              if (method === 'GET' && /^\/tasks\/\d+$/.test(path)) {
                return { id: 1, title: 'Task 1', assignees: [] };
              }
              if (method === 'POST' && path === '/tasks/bulk') {
                sentBody = body;
                return {
                  task_ids: (body as { task_ids: number[] }).task_ids,
                  tasks: [{ id: 1, title: 'Task 1', percent_done: 0.25 }],
                };
              }
              throw new Error(`mockRest: unhandled ${method} ${path}`);
            },
          );

          await bulkUpdateTasks({ taskIds: [1], field: 'percent_done', value: '25' });

          expect(sentBody).toEqual({
            task_ids: [1],
            fields: ['percent_done'],
            values: { percent_done: 0.25 },
          });
        });

        it('sends percent_done: 1 for value 100 (fully done)', async () => {
          let sentBody: unknown;
          mockRest.mockImplementation(
            async (_auth: unknown, method: string, path: string, body?: unknown) => {
              if (method === 'GET' && /^\/tasks\/\d+$/.test(path)) {
                return { id: 1, title: 'Task 1', assignees: [] };
              }
              if (method === 'POST' && path === '/tasks/bulk') {
                sentBody = body;
                return {
                  task_ids: (body as { task_ids: number[] }).task_ids,
                  tasks: [{ id: 1, title: 'Task 1', percent_done: 1 }],
                };
              }
              throw new Error(`mockRest: unhandled ${method} ${path}`);
            },
          );

          await bulkUpdateTasks({ taskIds: [1], field: 'percent_done', value: 100 });

          expect(sentBody).toEqual({
            task_ids: [1],
            fields: ['percent_done'],
            values: { percent_done: 1 },
          });
        });

        it('rejects a fraction with a message that teaches the scale', async () => {
          await expect(
            bulkUpdateTasks({ taskIds: [1], field: 'percent_done', value: 0.5 }),
          ).rejects.toThrow('percent_done must be a whole number between 0 and 100');
          expect(mockRest).not.toHaveBeenCalled();
        });

        it('rejects a value above 100 before any request is sent', async () => {
          await expect(
            bulkUpdateTasks({ taskIds: [1], field: 'percent_done', value: 101 }),
          ).rejects.toThrow('percent_done must be a whole number between 0 and 100');
          expect(mockRest).not.toHaveBeenCalled();
        });

        it('rejects a negative value before any request is sent', async () => {
          await expect(
            bulkUpdateTasks({ taskIds: [1], field: 'percent_done', value: -1 }),
          ).rejects.toThrow('percent_done must be a whole number between 0 and 100');
          expect(mockRest).not.toHaveBeenCalled();
        });
      });

      // Regression for issue #164: Vikunja SILENTLY DROPS a bare
      // 'YYYY-MM-DD' due_date/start_date/end_date value on POST
      // /tasks/bulk — the rest of the payload persists, so nothing errors
      // and the due date is simply gone. These assert the exact body sent
      // to POST /tasks/bulk carries a full RFC3339 timestamp.
      describe('Date field normalization (issue #164)', () => {
        it('coerces a date-only due_date to RFC3339 before the native bulk update request', async () => {
          let sentBody: unknown;
          mockRest.mockImplementation(
            async (_auth: unknown, method: string, path: string, body?: unknown) => {
              // The pre-update assignee snapshot GET has to succeed: a task
              // whose snapshot cannot be read is now deliberately withheld
              // from the bulk call (issue #267(a)).
              if (method === 'GET' && /^\/tasks\/\d+$/.test(path)) {
                return { id: 1, title: 'Task 1', assignees: [] };
              }
              if (method === 'POST' && path === '/tasks/bulk') {
                sentBody = body;
                return {
                  task_ids: (body as { task_ids: number[] }).task_ids,
                  tasks: [{ id: 1, title: 'Task 1', due_date: '2026-07-24T00:00:00Z' }],
                };
              }
              throw new Error(`mockRest: unhandled ${method} ${path}`);
            },
          );

          const result = await bulkUpdateTasks({
            taskIds: [1],
            field: 'due_date',
            value: '2026-07-24',
          });

          expect(sentBody).toEqual({
            task_ids: [1],
            fields: ['due_date'],
            values: { due_date: '2026-07-24T00:00:00Z' },
          });

          const markdown = result.content[0].text;
          expect(markdown).toContain('## ✅ Success');
        });

        it('passes an already-full RFC3339 due_date through unchanged', async () => {
          let sentBody: unknown;
          mockRest.mockImplementation(
            async (_auth: unknown, method: string, path: string, body?: unknown) => {
              if (method === 'GET' && /^\/tasks\/\d+$/.test(path)) {
                return { id: 1, title: 'Task 1', assignees: [] };
              }
              if (method === 'POST' && path === '/tasks/bulk') {
                sentBody = body;
                return {
                  task_ids: (body as { task_ids: number[] }).task_ids,
                  tasks: [{ id: 1, title: 'Task 1', due_date: '2026-07-24T10:30:00Z' }],
                };
              }
              throw new Error(`mockRest: unhandled ${method} ${path}`);
            },
          );

          await bulkUpdateTasks({ taskIds: [1], field: 'due_date', value: '2026-07-24T10:30:00Z' });

          expect(sentBody).toEqual({
            task_ids: [1],
            fields: ['due_date'],
            values: { due_date: '2026-07-24T10:30:00Z' },
          });
        });

        it('coerces a date-only start_date/end_date the same way as due_date', async () => {
          let sentBody: unknown;
          mockRest.mockImplementation(
            async (_auth: unknown, method: string, path: string, body?: unknown) => {
              if (method === 'GET' && /^\/tasks\/\d+$/.test(path)) {
                return { id: 1, title: 'Task 1', assignees: [] };
              }
              if (method === 'POST' && path === '/tasks/bulk') {
                sentBody = body;
                return {
                  task_ids: (body as { task_ids: number[] }).task_ids,
                  tasks: [{ id: 1, title: 'Task 1', start_date: '2026-07-20T00:00:00Z' }],
                };
              }
              throw new Error(`mockRest: unhandled ${method} ${path}`);
            },
          );

          await bulkUpdateTasks({ taskIds: [1], field: 'start_date', value: '2026-07-20' });

          expect(sentBody).toEqual({
            task_ids: [1],
            fields: ['start_date'],
            values: { start_date: '2026-07-20T00:00:00Z' },
          });
        });
      });
    });

    describe('Per-task merge updates (avoids native bulk wipe)', () => {
      it('should update via get+merge+update and never call native bulk API', async () => {
        const current = {
          id: 1,
          title: 'Task 1',
          project_id: 1,
          description: 'keep me',
          priority: 4,
          done: false,
        };
        const updated = { ...current, done: true };
        mockClient.tasks.getTask.mockResolvedValue(current);
        mockClient.tasks.updateTask.mockResolvedValue(updated);

        const result = await bulkUpdateTasks({ taskIds: [1], field: 'done', value: true });

        expect(mockClient.tasks.bulkUpdateTasks).not.toHaveBeenCalled();
        expect(mockClient.tasks.getTask).toHaveBeenCalledWith(1);
        expect(mockClient.tasks.updateTask).toHaveBeenCalledWith(
          1,
          expect.objectContaining({
            title: 'Task 1',
            description: 'keep me',
            priority: 4,
            done: true,
          }),
        );

        const markdown = result.content[0].text;
        expect(markdown).toContain('## ✅ Success');
        expect(markdown).toContain('Successfully updated 1 tasks');
        expect(markdown).toContain('**Operation:** update-task');
        expect(markdown).toContain('**count:** 1');
      });

      it('should preserve description and priority when marking done (issue #46)', async () => {
        const tasks = [
          {
            id: 10,
            title: 'A',
            project_id: 1,
            description: 'notes for A',
            priority: 3,
            done: false,
          },
          {
            id: 11,
            title: 'B',
            project_id: 1,
            description: 'notes for B',
            priority: 5,
            done: false,
          },
        ];
        mockClient.tasks.getTask.mockImplementation(async (id: number) => {
          const task = tasks.find((t) => t.id === id);
          if (!task) throw new Error(`missing ${id}`);
          return { ...task };
        });
        mockClient.tasks.updateTask.mockImplementation(
          async (_id: number, payload: Record<string, unknown>) => payload,
        );

        await bulkUpdateTasks({ taskIds: [10, 11], field: 'done', value: true });

        expect(mockClient.tasks.bulkUpdateTasks).not.toHaveBeenCalled();
        expect(mockClient.tasks.updateTask).toHaveBeenCalledTimes(2);
        expect(mockClient.tasks.updateTask).toHaveBeenCalledWith(
          10,
          expect.objectContaining({
            description: 'notes for A',
            priority: 3,
            done: true,
          }),
        );
        expect(mockClient.tasks.updateTask).toHaveBeenCalledWith(
          11,
          expect.objectContaining({
            description: 'notes for B',
            priority: 5,
            done: true,
          }),
        );
      });

      it('should handle repeat_mode conversion on merge path', async () => {
        mockClient.tasks.getTask.mockResolvedValue({
          id: 1,
          title: 'T',
          project_id: 1,
          repeat_mode: 0,
        });
        mockClient.tasks.updateTask.mockResolvedValue({
          id: 1,
          title: 'T',
          project_id: 1,
          repeat_mode: 1,
        });

        await bulkUpdateTasks({ taskIds: [1], field: 'repeat_mode', value: 'month' });

        expect(mockClient.tasks.bulkUpdateTasks).not.toHaveBeenCalled();
        expect(mockClient.tasks.updateTask).toHaveBeenCalledWith(
          1,
          expect.objectContaining({ repeat_mode: 1 }),
        );
      });

      it('should handle assignees field', async () => {
        const mockTask = { id: 1, title: 'Task 1', assignees: [] };

        // Both reads model the task's PRE-update state: the merge GET and the
        // reconciliation GET both run before any assignee write (the
        // intervening POST /tasks/{id} carries the spread assignee list
        // through unchanged). An earlier revision of this fixture returned
        // `[{ id: 1 }]` from the second read while asking for `[1]`, which is
        // really the issue #267(c) overlap case, not a plain assign — it is
        // covered by its own test below.
        mockClient.tasks.getTask.mockResolvedValue({ id: 1, title: 'Task 1', assignees: [] });
        mockClient.tasks.updateTask.mockResolvedValue(mockTask);

        const result = await bulkUpdateTasks({ taskIds: [1], field: 'assignees', value: [1] });

        // Additive per-user assign (PUT /tasks/{id}/assignees, body { user_id }),
        // not the destructive bulk endpoint (upstream #15).
        expect(mockRest).toHaveBeenCalledWith(expect.anything(), 'PUT', '/tasks/1/assignees', {
          user_id: 1,
        });
        expect(mockRest).not.toHaveBeenCalledWith(
          expect.anything(),
          'POST',
          '/tasks/1/assignees/bulk',
          expect.anything(),
        );

        const markdown = result.content[0].text;
        expect(markdown).toContain('## ✅ Success');
      });

      // Issue #267(c). Verified live against Vikunja 2.4.0 while writing this:
      // `PUT /tasks/{id}/assignees` for a user who is already assigned
      // returns HTTP 400 code 4021 "This user is already assigned to that
      // task", so the old add-everything loop aborted the update; and the old
      // remove-everything loop then deleted ids that were in the requested
      // set, silently unassigning a user the caller asked to keep.
      describe('overlapping assignee sets (issue #267)', () => {
        const routeAssigneeUpdate = (current: number[]) => {
          mockClient.tasks.getTask.mockResolvedValue({
            id: 1,
            title: 'Task 1',
            assignees: current.map((id) => ({ id })),
          });
          mockClient.tasks.updateTask.mockResolvedValue({ id: 1, title: 'Task 1' });
        };
        const assigneeCalls = (method: 'PUT' | 'DELETE') =>
          mockRest.mock.calls.filter(
            (call) => call[1] === method && String(call[2]).startsWith('/tasks/1/assignees'),
          );

        it('never deletes a user who is in both the current and the requested set', async () => {
          routeAssigneeUpdate([5, 7]);

          const result = await bulkUpdateTasks({ taskIds: [1], field: 'assignees', value: [5, 9] });

          // 5 is in both sets: neither re-added (400 code 4021) nor removed.
          expect(assigneeCalls('PUT').map((c) => c[3])).toEqual([{ user_id: 9 }]);
          expect(assigneeCalls('DELETE').map((c) => c[2])).toEqual(['/tasks/1/assignees/7']);
          expect(result.content[0].text).toContain('## ✅ Success');
        });

        it('issues no assignee writes at all when the requested set equals the current one', async () => {
          routeAssigneeUpdate([1]);

          const result = await bulkUpdateTasks({ taskIds: [1], field: 'assignees', value: [1] });

          expect(assigneeCalls('PUT')).toHaveLength(0);
          expect(assigneeCalls('DELETE')).toHaveLength(0);
          expect(result.content[0].text).toContain('## ✅ Success');
        });

        it('clears every assignee when an empty set is requested', async () => {
          routeAssigneeUpdate([5, 7]);

          await bulkUpdateTasks({ taskIds: [1], field: 'assignees', value: [] });

          expect(assigneeCalls('PUT')).toHaveLength(0);
          expect(assigneeCalls('DELETE').map((c) => c[2])).toEqual([
            '/tasks/1/assignees/5',
            '/tasks/1/assignees/7',
          ]);
        });
      });

      it('should handle authentication errors in assignee operations', async () => {
        const authError = new Error('Authentication failed');

        mockClient.tasks.getTask.mockResolvedValue({ id: 1, title: 'Task 1', assignees: [] });
        mockClient.tasks.updateTask.mockResolvedValue({ id: 1, title: 'Task 1' });
        (withRetry as jest.Mock).mockRejectedValue(authError);
        (isAuthenticationError as jest.Mock).mockReturnValue(true);

        await expect(
          bulkUpdateTasks({ taskIds: [1], field: 'assignees', value: [1] }),
        ).rejects.toThrow('Assignee operations may have authentication issues');
      });
    });

    describe('Labels field', () => {
      it('should set labels via the field-preserving fallback path', async () => {
        mockClient.tasks.getTask.mockResolvedValue({ id: 1, title: 'Task 1' });
        mockClient.tasks.updateTask.mockResolvedValue({ id: 1, title: 'Task 1' });

        const result = await bulkUpdateTasks({ taskIds: [1], field: 'labels', value: [3, 8] });

        // labels must never go through the native /tasks/bulk endpoint
        expect(mockClient.tasks.bulkUpdateTasks).not.toHaveBeenCalled();
        // setTaskLabels issues the label-bulk POST through vikunjaRestRequest
        // with the correct `{ labels: [{ id }, ...] }` payload shape.
        expect(mockRest).toHaveBeenCalledWith(expect.anything(), 'POST', '/tasks/1/labels/bulk', {
          labels: [{ id: 3 }, { id: 8 }],
        });
        expect(result.content[0].text).toContain('## ✅ Success');
      });

      it('should coerce a stringified labels array', async () => {
        mockClient.tasks.getTask.mockResolvedValue({ id: 1, title: 'Task 1' });
        mockClient.tasks.updateTask.mockResolvedValue({ id: 1, title: 'Task 1' });

        const result = await bulkUpdateTasks({ taskIds: [1], field: 'labels', value: '[3, 8]' });

        expect(mockRest).toHaveBeenCalledWith(expect.anything(), 'POST', '/tasks/1/labels/bulk', {
          labels: [{ id: 3 }, { id: 8 }],
        });
        expect(result.content[0].text).toContain('## ✅ Success');
      });

      it('should reject a labels value that is not a list of numbers', async () => {
        await expect(
          bulkUpdateTasks({ taskIds: [1], field: 'labels', value: 'not-a-list' }),
        ).rejects.toThrow('labels must be an array of numbers');
      });
    });

    describe('Error handling', () => {
      it('should preserve MCPError instances', async () => {
        const mcpError = new MCPError(ErrorCode.NOT_FOUND, 'Task not found');
        mockClient.tasks.getTask.mockRejectedValue(mcpError);

        await expect(bulkUpdateTasks({ taskIds: [1], field: 'done', value: true })).rejects.toThrow(
          'Bulk update failed. Could not update any tasks. Failed IDs: 1',
        );
      });

      it('should handle unknown error types', async () => {
        const unknownError = { status: 'error' };
        mockClient.tasks.getTask.mockRejectedValue(unknownError);

        await expect(bulkUpdateTasks({ taskIds: [1], field: 'done', value: true })).rejects.toThrow(
          'Bulk update failed. Could not update any tasks. Failed IDs: 1',
        );
      });
    });
  });

  describe('bulkDeleteTasks', () => {
    describe('Input validation', () => {
      it('should throw error when taskIds is missing', async () => {
        await expect(bulkDeleteTasks({})).rejects.toThrow(
          'taskIds array is required for bulk delete operation',
        );
      });

      it('should throw error when taskIds is empty', async () => {
        await expect(bulkDeleteTasks({ taskIds: [] })).rejects.toThrow(
          'taskIds array is required for bulk delete operation',
        );
      });

      it('should throw error when too many tasks', async () => {
        const taskIds = Array.from({ length: 101 }, (_, i) => i + 1);
        await expect(bulkDeleteTasks({ taskIds })).rejects.toThrow(
          'Too many tasks for bulk operation',
        );
      });

      it('should validate task IDs', async () => {
        await expect(bulkDeleteTasks({ taskIds: [1, -2] })).rejects.toThrow(
          'task ID must be a positive integer',
        );
      });
    });

    describe('Success scenarios', () => {
      it('should delete tasks successfully', async () => {
        const mockTasks = [
          { id: 1, title: 'Task 1' },
          { id: 2, title: 'Task 2' },
        ];

        mockClient.tasks.getTask
          .mockResolvedValueOnce(mockTasks[0])
          .mockResolvedValueOnce(mockTasks[1]);
        mockClient.tasks.deleteTask.mockResolvedValue({});

        const result = await bulkDeleteTasks({ taskIds: [1, 2] });

        expect(mockClient.tasks.deleteTask).toHaveBeenCalledTimes(2);
        expect(mockClient.tasks.deleteTask).toHaveBeenCalledWith(1);
        expect(mockClient.tasks.deleteTask).toHaveBeenCalledWith(2);

        const markdown = result.content[0].text;
        const parsed = parseMarkdown(markdown);
        expect(markdown).toContain('## ✅ Success');
        expect(markdown).toContain('Successfully deleted 2 tasks');
        expect(markdown).toContain('**Operation:** delete-task');
        expect(markdown).toContain('**count:** 2');
      });

      it('should handle partial deletion success', async () => {
        const mockTasks = [
          { id: 1, title: 'Task 1' },
          { id: 2, title: 'Task 2' },
        ];
        const deleteError = new Error('Delete failed');

        mockClient.tasks.getTask
          .mockResolvedValueOnce(mockTasks[0])
          .mockResolvedValueOnce(mockTasks[1]);
        mockClient.tasks.deleteTask.mockResolvedValueOnce({}).mockRejectedValueOnce(deleteError);

        const result = await bulkDeleteTasks({ taskIds: [1, 2] });

        const markdown = result.content[0].text;
        const parsed = parseMarkdown(markdown);
        // Partial success sets status to 'error' in AORP
        expect(parsed.hasHeading(2, /Error/)).toBe(true);
        expect(markdown).toContain('Bulk delete partially completed');
        expect(markdown).toContain('**FailedIds**:');
      });

      it('should handle complete deletion failure', async () => {
        const mockTasks = [{ id: 1, title: 'Task 1' }];
        const deleteError = new Error('Delete failed');

        mockClient.tasks.getTask.mockResolvedValue(mockTasks[0]);
        mockClient.tasks.deleteTask.mockRejectedValue(deleteError);

        await expect(bulkDeleteTasks({ taskIds: [1] })).rejects.toThrow(
          'Bulk delete failed. Could not delete any tasks',
        );
      });
    });
  });

  describe('bulkCreateTasks', () => {
    describe('Input validation', () => {
      it('should throw error when projectId is missing', async () => {
        await expect(bulkCreateTasks({ tasks: [{ title: 'Test' }] })).rejects.toThrow(
          'projectId is required for bulk create operation',
        );
      });

      it('should validate projectId', async () => {
        await expect(
          bulkCreateTasks({ projectId: -1, tasks: [{ title: 'Test' }] }),
        ).rejects.toThrow('projectId must be a positive integer');
      });

      it('should throw error when tasks array is missing', async () => {
        await expect(bulkCreateTasks({ projectId: 1 })).rejects.toThrow(
          'tasks array is required and must contain at least one task',
        );
      });

      it('should throw error when tasks array is empty', async () => {
        await expect(bulkCreateTasks({ projectId: 1, tasks: [] })).rejects.toThrow(
          'tasks array is required and must contain at least one task',
        );
      });

      it('should throw error when too many tasks', async () => {
        const tasks = Array.from({ length: 101 }, (_, i) => ({ title: `Task ${i}` }));
        await expect(bulkCreateTasks({ projectId: 1, tasks })).rejects.toThrow(
          'Too many tasks for bulk operation',
        );
      });

      it('should validate task titles', async () => {
        await expect(
          bulkCreateTasks({
            projectId: 1,
            tasks: [{ title: '' }],
          }),
        ).rejects.toThrow('Task at index 0 must have a non-empty title');
      });

      it('should validate due dates', async () => {
        await expect(
          bulkCreateTasks({
            projectId: 1,
            tasks: [{ title: 'Test', dueDate: 'invalid-date' }],
          }),
        ).rejects.toThrow('tasks[0].dueDate must be a valid ISO 8601 date string');
      });

      it('should validate assignee IDs', async () => {
        await expect(
          bulkCreateTasks({
            projectId: 1,
            tasks: [{ title: 'Test', assignees: [-1] }],
          }),
        ).rejects.toThrow('tasks[0].assignee ID must be a positive integer');
      });

      it('should validate label IDs', async () => {
        await expect(
          bulkCreateTasks({
            projectId: 1,
            tasks: [{ title: 'Test', labels: [-1] }],
          }),
        ).rejects.toThrow('tasks[0].label ID must be a positive integer');
      });
    });

    describe('Success scenarios', () => {
      it('should create tasks successfully', async () => {
        const mockTask = { id: 1, title: 'Test Task', project_id: 1 };

        mockClient.tasks.createTask.mockResolvedValue(mockTask);
        mockClient.tasks.getTask.mockResolvedValue(mockTask);

        const result = await bulkCreateTasks({
          projectId: 1,
          tasks: [{ title: 'Test Task' }],
        });

        expect(mockClient.tasks.createTask).toHaveBeenCalledWith(
          1,
          expect.objectContaining({
            title: 'Test Task',
            project_id: 1,
          }),
        );

        const markdown = result.content[0].text;
        const parsed = parseMarkdown(markdown);
        expect(markdown).toContain('## ✅ Success');
        expect(markdown).toContain('Successfully created 1 tasks');
        expect(markdown).toContain('**Operation:** create-tasks');
        expect(markdown).toContain('**count:** 1');
      });

      // Regression for issue #164: bulk-create forwarded a date-only
      // dueDate straight through as due_date, which Vikunja silently drops
      // (everything else in the payload persists, so nothing errors).
      it('coerces a date-only dueDate to RFC3339 before creating the task', async () => {
        const mockTask = {
          id: 1,
          title: 'Test Task',
          project_id: 1,
          due_date: '2026-07-24T00:00:00Z',
        };

        mockClient.tasks.createTask.mockResolvedValue(mockTask);
        mockClient.tasks.getTask.mockResolvedValue(mockTask);

        const result = await bulkCreateTasks({
          projectId: 1,
          tasks: [{ title: 'Test Task', dueDate: '2026-07-24' }],
        });

        expect(mockClient.tasks.createTask).toHaveBeenCalledWith(
          1,
          expect.objectContaining({
            title: 'Test Task',
            due_date: '2026-07-24T00:00:00Z',
          }),
        );

        const markdown = result.content[0].text;
        expect(markdown).toContain('## ✅ Success');
      });

      it('passes an already-full RFC3339 dueDate through unchanged', async () => {
        const mockTask = {
          id: 1,
          title: 'Test Task',
          project_id: 1,
          due_date: '2026-07-24T10:30:00Z',
        };

        mockClient.tasks.createTask.mockResolvedValue(mockTask);
        mockClient.tasks.getTask.mockResolvedValue(mockTask);

        await bulkCreateTasks({
          projectId: 1,
          tasks: [{ title: 'Test Task', dueDate: '2026-07-24T10:30:00Z' }],
        });

        expect(mockClient.tasks.createTask).toHaveBeenCalledWith(
          1,
          expect.objectContaining({
            title: 'Test Task',
            due_date: '2026-07-24T10:30:00Z',
          }),
        );
      });

      // Regression for issue #168: bulk-create accepted startDate/endDate on
      // its task shape but never forwarded them to Vikunja at all - distinct
      // from the date-FORMAT bug #164 fixed above for dueDate.
      it('forwards startDate/endDate as start_date/end_date, coercing date-only values to RFC3339', async () => {
        const mockTask = {
          id: 1,
          title: 'Test Task',
          project_id: 1,
          start_date: '2026-07-24T00:00:00Z',
          end_date: '2026-07-25T10:30:00Z',
        };

        mockClient.tasks.createTask.mockResolvedValue(mockTask);
        mockClient.tasks.getTask.mockResolvedValue(mockTask);

        const result = await bulkCreateTasks({
          projectId: 1,
          tasks: [{ title: 'Test Task', startDate: '2026-07-24', endDate: '2026-07-25T10:30:00Z' }],
        });

        expect(mockClient.tasks.createTask).toHaveBeenCalledWith(
          1,
          expect.objectContaining({
            title: 'Test Task',
            start_date: '2026-07-24T00:00:00Z',
            end_date: '2026-07-25T10:30:00Z',
          }),
        );

        const markdown = result.content[0].text;
        expect(markdown).toContain('## ✅ Success');
      });

      it('does not send start_date/end_date when startDate/endDate are omitted', async () => {
        const mockTask = { id: 1, title: 'Test Task', project_id: 1 };

        mockClient.tasks.createTask.mockResolvedValue(mockTask);
        mockClient.tasks.getTask.mockResolvedValue(mockTask);

        await bulkCreateTasks({
          projectId: 1,
          tasks: [{ title: 'Test Task' }],
        });

        const callArgs = mockClient.tasks.createTask.mock.calls[0][1];
        expect(callArgs).not.toHaveProperty('start_date');
        expect(callArgs).not.toHaveProperty('end_date');
      });

      it('should handle labels and assignees', async () => {
        const mockTask = { id: 1, title: 'Test Task', project_id: 1 };

        mockClient.tasks.createTask.mockResolvedValue(mockTask);
        mockClient.tasks.getTask.mockResolvedValue({
          ...mockTask,
          labels: [{ id: 1 }],
          assignees: [{ id: 1 }],
        });

        const result = await bulkCreateTasks({
          projectId: 1,
          tasks: [
            {
              title: 'Test Task',
              labels: [1],
              assignees: [1],
            },
          ],
        });

        // setTaskLabels issues the label-bulk POST through vikunjaRestRequest
        // with the correct `{ labels: [{ id }, ...] }` payload shape.
        expect(mockRest).toHaveBeenCalledWith(expect.anything(), 'POST', '/tasks/1/labels/bulk', {
          labels: [{ id: 1 }],
        });
        // Additive per-user assign (PUT /tasks/{id}/assignees, body { user_id }),
        // not the destructive bulk endpoint (upstream #15).
        expect(mockRest).toHaveBeenCalledWith(expect.anything(), 'PUT', '/tasks/1/assignees', {
          user_id: 1,
        });
        expect(mockRest).not.toHaveBeenCalledWith(
          expect.anything(),
          'POST',
          '/tasks/1/assignees/bulk',
          expect.anything(),
        );

        const markdown = result.content[0].text;
        const parsed = parseMarkdown(markdown);
        expect(markdown).toContain('## ✅ Success');
      });

      it('should handle authentication errors in assignee operations during create', async () => {
        const mockTask = { id: 1, title: 'Test Task', project_id: 1 };
        const authError = new Error('Authentication failed');

        mockClient.tasks.createTask.mockResolvedValue(mockTask);
        (withRetry as jest.Mock).mockRejectedValue(authError);
        (isAuthenticationError as jest.Mock).mockReturnValue(true);
        mockClient.tasks.deleteTask.mockResolvedValue({});

        await expect(
          bulkCreateTasks({
            projectId: 1,
            tasks: [{ title: 'Test Task', assignees: [1] }],
          }),
        ).rejects.toThrow('Assignee operations may have authentication issues');

        // Should have attempted cleanup
        expect(mockClient.tasks.deleteTask).toHaveBeenCalledWith(1);
      });

      it('should handle partial create success', async () => {
        const mockTask = { id: 1, title: 'Test Task', project_id: 1 };
        const createError = new Error('Create failed');

        mockClient.tasks.createTask
          .mockResolvedValueOnce(mockTask)
          .mockRejectedValueOnce(createError);
        mockClient.tasks.getTask.mockResolvedValue(mockTask);

        const result = await bulkCreateTasks({
          projectId: 1,
          tasks: [{ title: 'Test Task 1' }, { title: 'Test Task 2' }],
        });

        const markdown = result.content[0].text;
        const parsed = parseMarkdown(markdown);
        // Partial success sets status to 'error' in AORP
        expect(parsed.hasHeading(2, /Error/)).toBe(true);
        expect(markdown).toContain('Bulk create partially completed');
        expect(markdown).toContain('**FailedCount**:');
      });

      it('should handle complete create failure', async () => {
        const createError = new Error('Create failed');

        mockClient.tasks.createTask.mockRejectedValue(createError);

        await expect(
          bulkCreateTasks({
            projectId: 1,
            tasks: [{ title: 'Test Task' }],
          }),
        ).rejects.toThrow('Bulk create failed. Could not create any tasks');
      });

      // LOW-6 in #294: the partial-failure path reports `failures: [{index,
      // error}]` per task, but the total-failure path collapsed everything
      // into one generic sentence, so "all N failed" said nothing about
      // whether it was one cause or N different ones.
      describe('total-failure detail (LOW-6)', () => {
        it('names the failing index and its message when every task fails', async () => {
          mockClient.tasks.createTask.mockRejectedValue(new Error('Project not writable'));

          await expect(bulkCreateTasks({ projectId: 1, tasks: [{ title: 'A' }] })).rejects.toThrow(
            'Bulk create failed. Could not create any tasks. Task(s) 0: Project not writable',
          );
        });

        it('keeps per-index detail for distinct failures', async () => {
          mockClient.tasks.createTask
            .mockRejectedValueOnce(new Error('title too long'))
            .mockRejectedValueOnce(new Error('bucket is full'));

          await expect(
            bulkCreateTasks({ projectId: 1, tasks: [{ title: 'A' }, { title: 'B' }] }),
          ).rejects.toThrow('Task(s) 0: title too long; Task(s) 1: bucket is full');
        });

        it('groups indices that share one message instead of repeating it', async () => {
          mockClient.tasks.createTask.mockRejectedValue(new Error('database is locked'));

          await expect(
            bulkCreateTasks({
              projectId: 1,
              tasks: [{ title: 'A' }, { title: 'B' }, { title: 'C' }],
            }),
          ).rejects.toThrow('Task(s) 0, 1, 2: database is locked');
        });
      });

      it('should handle repeat configuration', async () => {
        const mockTask = { id: 1, title: 'Test Task', project_id: 1 };

        mockClient.tasks.createTask.mockResolvedValue(mockTask);
        mockClient.tasks.getTask.mockResolvedValue(mockTask);

        await bulkCreateTasks({
          projectId: 1,
          tasks: [
            {
              title: 'Test Task',
              repeatAfter: 7,
              repeatMode: 'day',
            },
          ],
        });

        expect(mockClient.tasks.createTask).toHaveBeenCalledWith(
          1,
          expect.objectContaining({
            title: 'Test Task',
            project_id: 1,
            repeat_after: 604800, // 7 days in seconds
          }),
        );
      });
    });

    describe('Error handling', () => {
      it('should preserve MCPError instances', async () => {
        const mcpError = new MCPError(ErrorCode.NOT_FOUND, 'Project not found');
        mockClient.tasks.createTask.mockRejectedValue(mcpError);

        await expect(
          bulkCreateTasks({
            projectId: 1,
            tasks: [{ title: 'Test Task' }],
          }),
        ).rejects.toThrow('Bulk create failed. Could not create any tasks');
      });

      it('should handle cleanup failure during partial create', async () => {
        const mockTask = { id: 1, title: 'Test Task', project_id: 1 };
        const labelError = new Error('Label assignment failed');
        const deleteError = new Error('Cleanup failed');

        mockClient.tasks.createTask.mockResolvedValue(mockTask);
        (withRetry as jest.Mock).mockRejectedValue(labelError);
        mockClient.tasks.deleteTask.mockRejectedValue(deleteError);

        await expect(
          bulkCreateTasks({
            projectId: 1,
            tasks: [{ title: 'Test Task', labels: [1] }],
          }),
        ).rejects.toThrow('Label assignment failed');
      });
    });
  });

  // Integration tests for batch processing
  describe('Batch processing', () => {
    it('should process large numbers of tasks in batches', async () => {
      const taskIds = Array.from({ length: 25 }, (_, i) => i + 1);

      mockClient.tasks.getTask.mockImplementation(async (id: number) => ({
        id,
        title: `Task ${id}`,
        project_id: 1,
        description: `desc ${id}`,
        priority: 2,
        done: false,
      }));
      mockClient.tasks.updateTask.mockImplementation(
        async (_id: number, payload: Record<string, unknown>) => payload,
      );

      const result = await bulkUpdateTasks({ taskIds, field: 'done', value: true });

      expect(mockClient.tasks.bulkUpdateTasks).not.toHaveBeenCalled();
      expect(mockClient.tasks.updateTask).toHaveBeenCalledTimes(25);
      expect(mockClient.tasks.updateTask).toHaveBeenCalledWith(
        1,
        expect.objectContaining({
          description: 'desc 1',
          priority: 2,
          done: true,
        }),
      );

      const markdown = result.content[0].text;
      expect(markdown).toContain('**count:** 25');
    });
  });
});
