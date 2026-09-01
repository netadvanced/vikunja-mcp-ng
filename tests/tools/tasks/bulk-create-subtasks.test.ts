/**
 * Tests for the `bulk-create-subtasks` composite (`bulkCreateSubtasks`).
 *
 * Resolves the parent's project ONCE, then runs the same create -> label ->
 * assign -> relate -> [bucket] -> verify sequence per subtask spec,
 * sequentially, each with its own independent `CompositeOperation` — a
 * failure in one subtask never blocks the rest of the batch. Covers
 * validation, single-resolution reuse, per-subtask atomic rollback, and
 * honest partial-failure reporting (PR #95's shape).
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { AuthManager } from '../../../src/auth/AuthManager';
import { bulkCreateSubtasks } from '../../../src/tools/tasks/subtasks';
import { MCPError, ErrorCode } from '../../../src/types';
import { circuitBreakerRegistry } from '../../../src/utils/retry';

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

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

const parentTask = { id: 1, title: 'Parent', project_id: 5, related_tasks: {} };
const parentTaskWithChildren = (childIds: number[]) => ({
  id: 1,
  title: 'Parent',
  project_id: 5,
  related_tasks: { subtask: childIds.map((id) => ({ id, title: `Child ${id}`, done: false })) },
});

describe('bulkCreateSubtasks', () => {
  let authManager: AuthManager;

  beforeEach(() => {
    jest.clearAllMocks();
    mockFetch.mockReset();
    circuitBreakerRegistry.clear();
    authManager = new AuthManager();
    authManager.connect('https://vikunja.test', 'tk_test-token');
  });

  describe('validation', () => {
    it('requires parentTaskId before making any request', async () => {
      await expect(bulkCreateSubtasks({ subtasks: [{ title: 'A' }] }, authManager)).rejects.toThrow(
        'parentTaskId is required to create subtasks',
      );
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('requires a non-empty subtasks array', async () => {
      await expect(bulkCreateSubtasks({ parentTaskId: 1 }, authManager)).rejects.toThrow(
        'subtasks array is required and must contain at least one subtask',
      );
      await expect(
        bulkCreateSubtasks({ parentTaskId: 1, subtasks: [] }, authManager),
      ).rejects.toThrow('subtasks array is required and must contain at least one subtask');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('rejects a batch larger than MAX_BULK_OPERATION_TASKS', async () => {
      const subtasks = Array.from({ length: 101 }, (_, i) => ({ title: `Task ${i}` }));
      await expect(bulkCreateSubtasks({ parentTaskId: 1, subtasks }, authManager)).rejects.toThrow(
        /Too many subtasks for bulk operation/,
      );
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('requires every subtask spec to have a title, but a title-less item does not block its valid siblings (issue #226)', async () => {
      // Item 1 (missing title) fails pre-flight validation; item 0 is otherwise valid and
      // must still be attempted — a single invalid item must not sink the whole batch.
      mockFetch
        .mockResolvedValueOnce(mockResponse({ text: JSON.stringify(parentTask) })) // resolve-parent
        .mockResolvedValueOnce(
          mockResponse({ text: JSON.stringify({ id: 42, title: 'A', project_id: 5 }) }),
        ) // subtask A: create-task
        .mockResolvedValueOnce(
          mockResponse({
            text: JSON.stringify({ task_id: 1, other_task_id: 42, relation_kind: 'subtask' }),
          }),
        ) // subtask A: create-relation
        .mockResolvedValueOnce(
          mockResponse({ text: JSON.stringify(parentTaskWithChildren([42])) }),
        ); // subtask A: verify-relation

      const result = await bulkCreateSubtasks(
        { parentTaskId: 1, subtasks: [{ title: 'A' }, {}] },
        authManager,
      );

      const text = result.content[0].text;
      expect(text).toContain('partially completed');
      expect(text).toContain('Successfully created and related 1 of 2 subtask(s)');
      expect(text).toContain('Failed indexes: 1');
      // The invalid item was never attempted against the API — no extra fetch calls
      // beyond resolve-parent + subtask A's own create/relate/verify sequence.
      expect(mockFetch).toHaveBeenCalledTimes(4);
    });

    it('reports subtasks[N].title/label/assignee/bucket validation errors per-item and fails the whole batch only when nothing could succeed', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({ text: JSON.stringify(parentTask) }));
      await expect(
        bulkCreateSubtasks(
          { parentTaskId: 1, subtasks: [{ title: 'A', labels: [-1] }] },
          authManager,
        ),
      ).rejects.toThrow(MCPError);

      mockFetch.mockResolvedValueOnce(mockResponse({ text: JSON.stringify(parentTask) }));
      await expect(
        bulkCreateSubtasks(
          { parentTaskId: 1, subtasks: [{ title: 'A', assignees: [0] }] },
          authManager,
        ),
      ).rejects.toThrow(MCPError);

      mockFetch.mockResolvedValueOnce(mockResponse({ text: JSON.stringify(parentTask) }));
      await expect(
        bulkCreateSubtasks(
          { parentTaskId: 1, subtasks: [{ title: 'A', bucketId: -5 }] },
          authManager,
        ),
      ).rejects.toThrow(MCPError);

      // Every one of the 3 single-item batches above resolves the parent (the only
      // possible request when every item in a batch is invalid) but never reaches a
      // create-task call.
      expect(mockFetch).toHaveBeenCalledTimes(3);
      expect(
        mockFetch.mock.calls.every(
          (call) =>
            call[0] === 'https://vikunja.test/api/v1/tasks/1' &&
            (call[1]?.method ?? 'GET') === 'GET',
        ),
      ).toBe(true);
    });

    it('names the field and matched rule when a subtask description trips the dangerous-content check, without failing valid siblings', async () => {
      // Regression for issue #226: a false-positive-prone description used to throw out of
      // the pre-flight `.map()` and abort the entire batch before any subtask was attempted.
      mockFetch
        .mockResolvedValueOnce(mockResponse({ text: JSON.stringify(parentTask) })) // resolve-parent
        .mockResolvedValueOnce(
          mockResponse({ text: JSON.stringify({ id: 42, title: 'Good', project_id: 5 }) }),
        ) // subtask 0 (valid): create-task
        .mockResolvedValueOnce(
          mockResponse({
            text: JSON.stringify({ task_id: 1, other_task_id: 42, relation_kind: 'subtask' }),
          }),
        ) // subtask 0: create-relation
        .mockResolvedValueOnce(
          mockResponse({ text: JSON.stringify(parentTaskWithChildren([42])) }),
        ); // subtask 0: verify-relation

      const result = await bulkCreateSubtasks(
        {
          parentTaskId: 1,
          subtasks: [
            { title: 'Good' },
            { title: 'Bad', description: '<script>alert(1)</script>' },
          ],
        },
        authManager,
      );

      const text = result.content[0].text;
      expect(text).toContain('Successfully created and related 1 of 2 subtask(s)');
      expect(text).toContain('subtasks[1].description');
      expect(text).toContain('script tag');
      expect(mockFetch).toHaveBeenCalledTimes(4);
    });

    it('surfaces a friendly NOT_FOUND when the parent task does not exist', async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse({ ok: false, status: 404, statusText: 'Not Found' }),
      );

      await expect(
        bulkCreateSubtasks({ parentTaskId: 999, subtasks: [{ title: 'A' }] }, authManager),
      ).rejects.toThrow(MCPError);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe('happy path', () => {
    it('resolves the parent ONCE, then creates + relates every subtask sequentially', async () => {
      mockFetch
        // 1) resolve-parent (once for the whole batch)
        .mockResolvedValueOnce(mockResponse({ text: JSON.stringify(parentTask) }))
        // Subtask A: create -> relate -> verify
        .mockResolvedValueOnce(
          mockResponse({ text: JSON.stringify({ id: 42, title: 'A', project_id: 5 }) }),
        )
        .mockResolvedValueOnce(
          mockResponse({
            text: JSON.stringify({ task_id: 1, other_task_id: 42, relation_kind: 'subtask' }),
          }),
        )
        .mockResolvedValueOnce(mockResponse({ text: JSON.stringify(parentTaskWithChildren([42])) }))
        // Subtask B: create -> relate -> verify
        .mockResolvedValueOnce(
          mockResponse({ text: JSON.stringify({ id: 43, title: 'B', project_id: 5 }) }),
        )
        .mockResolvedValueOnce(
          mockResponse({
            text: JSON.stringify({ task_id: 1, other_task_id: 43, relation_kind: 'subtask' }),
          }),
        )
        .mockResolvedValueOnce(
          mockResponse({ text: JSON.stringify(parentTaskWithChildren([42, 43])) }),
        );

      const result = await bulkCreateSubtasks(
        { parentTaskId: 1, subtasks: [{ title: 'A' }, { title: 'B' }] },
        authManager,
      );

      expect(mockFetch).toHaveBeenCalledTimes(7);
      const calls = mockFetch.mock.calls as [string, RequestInit?][];
      // resolve-parent happens exactly once, as the first call.
      expect(calls[0][0]).toBe('https://vikunja.test/api/v1/tasks/1');
      expect(calls[0][1]?.method ?? 'GET').toBe('GET');

      // Subtask A's create-task call.
      expect(calls[1][0]).toBe('https://vikunja.test/api/v1/projects/5/tasks');
      expect(JSON.parse(calls[1][1]?.body as string)).toEqual({ title: 'A', project_id: 5 });
      // Subtask B's create-task call — same project, reused without a
      // second parent resolution.
      expect(calls[4][0]).toBe('https://vikunja.test/api/v1/projects/5/tasks');
      expect(JSON.parse(calls[4][1]?.body as string)).toEqual({ title: 'B', project_id: 5 });

      const text = result.content[0].text;
      expect(text).toContain('Successfully created and related 2 subtask(s) under parent 1');
    });

    describe('date normalization', () => {
      it('coerces date-only dueDate/startDate/endDate to RFC3339 before sending the create-task request', async () => {
        mockFetch
          .mockResolvedValueOnce(mockResponse({ text: JSON.stringify(parentTask) })) // resolve-parent
          .mockResolvedValueOnce(
            mockResponse({ text: JSON.stringify({ id: 42, title: 'A', project_id: 5 }) }),
          ) // create-task
          .mockResolvedValueOnce(
            mockResponse({
              text: JSON.stringify({ task_id: 1, other_task_id: 42, relation_kind: 'subtask' }),
            }),
          ) // create-relation
          .mockResolvedValueOnce(
            mockResponse({ text: JSON.stringify(parentTaskWithChildren([42])) }),
          ); // verify

        await bulkCreateSubtasks(
          {
            parentTaskId: 1,
            subtasks: [
              { title: 'A', dueDate: '2026-09-01', startDate: '2026-09-02', endDate: '2026-09-03' },
            ],
          },
          authManager,
        );

        const calls = mockFetch.mock.calls as [string, RequestInit?][];
        expect(JSON.parse(calls[1][1]?.body as string)).toEqual({
          title: 'A',
          project_id: 5,
          due_date: '2026-09-01T00:00:00Z',
          start_date: '2026-09-02T00:00:00Z',
          end_date: '2026-09-03T00:00:00Z',
        });
      });

      it('leaves a full RFC3339 dueDate timestamp unchanged', async () => {
        mockFetch
          .mockResolvedValueOnce(mockResponse({ text: JSON.stringify(parentTask) })) // resolve-parent
          .mockResolvedValueOnce(
            mockResponse({ text: JSON.stringify({ id: 42, title: 'A', project_id: 5 }) }),
          ) // create-task
          .mockResolvedValueOnce(
            mockResponse({
              text: JSON.stringify({ task_id: 1, other_task_id: 42, relation_kind: 'subtask' }),
            }),
          ) // create-relation
          .mockResolvedValueOnce(
            mockResponse({ text: JSON.stringify(parentTaskWithChildren([42])) }),
          ); // verify

        await bulkCreateSubtasks(
          { parentTaskId: 1, subtasks: [{ title: 'A', dueDate: '2026-09-01T15:30:00Z' }] },
          authManager,
        );

        const calls = mockFetch.mock.calls as [string, RequestInit?][];
        expect(JSON.parse(calls[1][1]?.body as string)).toEqual({
          title: 'A',
          project_id: 5,
          due_date: '2026-09-01T15:30:00Z',
        });
      });

      it('does not add due_date/start_date/end_date fields when not provided', async () => {
        mockFetch
          .mockResolvedValueOnce(mockResponse({ text: JSON.stringify(parentTask) })) // resolve-parent
          .mockResolvedValueOnce(
            mockResponse({ text: JSON.stringify({ id: 42, title: 'A', project_id: 5 }) }),
          ) // create-task
          .mockResolvedValueOnce(
            mockResponse({
              text: JSON.stringify({ task_id: 1, other_task_id: 42, relation_kind: 'subtask' }),
            }),
          ) // create-relation
          .mockResolvedValueOnce(
            mockResponse({ text: JSON.stringify(parentTaskWithChildren([42])) }),
          ); // verify

        await bulkCreateSubtasks({ parentTaskId: 1, subtasks: [{ title: 'A' }] }, authManager);

        const calls = mockFetch.mock.calls as [string, RequestInit?][];
        const body = JSON.parse(calls[1][1]?.body as string);
        expect(body).not.toHaveProperty('due_date');
        expect(body).not.toHaveProperty('start_date');
        expect(body).not.toHaveProperty('end_date');
      });
    });

    it('applies labels/assignees and places the subtask into a Kanban bucket, in order', async () => {
      const createdWithLabel = { id: 42, title: 'A', project_id: 5, labels: [{ id: 7 }] };
      const createdWithLabelAndAssignee = { ...createdWithLabel, assignees: [{ id: 3 }] };
      mockFetch
        .mockResolvedValueOnce(mockResponse({ text: JSON.stringify(parentTask) })) // resolve-parent
        .mockResolvedValueOnce(
          mockResponse({ text: JSON.stringify({ id: 42, title: 'A', project_id: 5 }) }),
        ) // create-task
        .mockResolvedValueOnce(mockResponse({ text: '{}' })) // apply-labels: label 7
        .mockResolvedValueOnce(mockResponse({ text: JSON.stringify(createdWithLabel) })) // verify-labels: GET /tasks/42
        .mockResolvedValueOnce(mockResponse({ text: '{}' })) // apply-assignees: user 3
        .mockResolvedValueOnce(
          mockResponse({ text: JSON.stringify(createdWithLabelAndAssignee) }),
        ) // verify-assignees: GET /tasks/42
        .mockResolvedValueOnce(
          mockResponse({
            text: JSON.stringify({ task_id: 1, other_task_id: 42, relation_kind: 'subtask' }),
          }),
        ) // create-relation
        // set-bucket internals: resolveKanbanViewId -> GET /projects/5/views
        .mockResolvedValueOnce(
          mockResponse({
            text: JSON.stringify([{ id: 11, title: 'Kanban', project_id: 5, view_kind: 'kanban' }]),
          }),
        )
        .mockResolvedValueOnce(mockResponse({ text: '{}' })) // set-bucket POST
        .mockResolvedValueOnce(
          mockResponse({ text: JSON.stringify(parentTaskWithChildren([42])) }),
        ); // verify-relation

      await bulkCreateSubtasks(
        { parentTaskId: 1, subtasks: [{ title: 'A', labels: [7], assignees: [3], bucketId: 9 }] },
        authManager,
      );

      const calls = mockFetch.mock.calls as [string, RequestInit?][];
      expect(calls[2][0]).toBe('https://vikunja.test/api/v1/tasks/42/labels');
      expect(JSON.parse(calls[2][1]?.body as string)).toEqual({ label_id: 7 });
      expect(calls[3][0]).toBe('https://vikunja.test/api/v1/tasks/42');
      expect(calls[3][1]?.method ?? 'GET').toBe('GET');
      expect(calls[4][0]).toBe('https://vikunja.test/api/v1/tasks/42/assignees');
      expect(JSON.parse(calls[4][1]?.body as string)).toEqual({ user_id: 3 });
      expect(calls[5][0]).toBe('https://vikunja.test/api/v1/tasks/42');
      expect(calls[5][1]?.method ?? 'GET').toBe('GET');
      expect(calls[7][0]).toBe('https://vikunja.test/api/v1/projects/5/views');
      expect(calls[8][0]).toBe('https://vikunja.test/api/v1/projects/5/views/11/buckets/9/tasks');
    });

    it('fails the subtask (but not the whole batch) when a label attach PUT reports success but the label does not persist (LOW-22)', async () => {
      mockFetch
        .mockResolvedValueOnce(mockResponse({ text: JSON.stringify(parentTask) })) // resolve-parent
        .mockResolvedValueOnce(
          mockResponse({ text: JSON.stringify({ id: 42, title: 'A', project_id: 5 }) }),
        ) // create-task
        .mockResolvedValueOnce(mockResponse({ text: '{}' })) // apply-labels: label 7 (PUT reports 200)
        .mockResolvedValueOnce(
          mockResponse({ text: JSON.stringify({ id: 42, title: 'A', project_id: 5, labels: [] }) }),
        ) // verify-labels: re-read shows it never persisted
        .mockResolvedValueOnce(
          mockResponse({ text: JSON.stringify({ id: 43, title: 'B', project_id: 5 }) }),
        ) // subtask B: create-task
        .mockResolvedValueOnce(
          mockResponse({
            text: JSON.stringify({ task_id: 1, other_task_id: 43, relation_kind: 'subtask' }),
          }),
        ) // subtask B: create-relation
        .mockResolvedValueOnce(
          mockResponse({ text: JSON.stringify(parentTaskWithChildren([43])) }),
        ); // subtask B: verify-relation

      const result = await bulkCreateSubtasks(
        {
          parentTaskId: 1,
          subtasks: [{ title: 'A', labels: [7] }, { title: 'B' }],
        },
        authManager,
      );

      const text = result.content[0].text;
      expect(text).toContain('partially completed');
      expect(text).toContain('Successfully created and related 1 of 2 subtask(s)');
      expect(text).toContain('Failed indexes: 0');
    });
  });

  describe('partial failure reporting', () => {
    it('best-effort (default): one subtask failing does not block the rest of the batch', async () => {
      mockFetch
        .mockResolvedValueOnce(mockResponse({ text: JSON.stringify(parentTask) })) // resolve-parent
        // Subtask A: create -> relate FAILS
        .mockResolvedValueOnce(
          mockResponse({ text: JSON.stringify({ id: 42, title: 'A', project_id: 5 }) }),
        )
        .mockResolvedValueOnce(mockResponse({ ok: false, status: 400, statusText: 'Bad Request' }))
        // Subtask B: create -> relate -> verify all succeed
        .mockResolvedValueOnce(
          mockResponse({ text: JSON.stringify({ id: 43, title: 'B', project_id: 5 }) }),
        )
        .mockResolvedValueOnce(
          mockResponse({
            text: JSON.stringify({ task_id: 1, other_task_id: 43, relation_kind: 'subtask' }),
          }),
        )
        .mockResolvedValueOnce(
          mockResponse({ text: JSON.stringify(parentTaskWithChildren([43])) }),
        );

      const result = await bulkCreateSubtasks(
        { parentTaskId: 1, subtasks: [{ title: 'A' }, { title: 'B' }] },
        authManager,
      );

      // best-effort: no DELETE compensation call for subtask A's orphaned task.
      expect(
        mockFetch.mock.calls.some((call) => (call[1] as RequestInit)?.method === 'DELETE'),
      ).toBe(false);
      expect(mockFetch).toHaveBeenCalledTimes(6);

      const text = result.content[0].text;
      expect(text).toContain('Bulk create-subtasks partially completed under parent 1');
      expect(text).toContain('Successfully created and related 1 of 2 subtask(s)');
      expect(text).toContain('Failed indexes: 0');
    });

    it('atomic:true rolls back only the failing subtask, leaving earlier successes untouched', async () => {
      mockFetch
        .mockResolvedValueOnce(mockResponse({ text: JSON.stringify(parentTask) })) // resolve-parent
        // Subtask A succeeds fully.
        .mockResolvedValueOnce(
          mockResponse({ text: JSON.stringify({ id: 42, title: 'A', project_id: 5 }) }),
        )
        .mockResolvedValueOnce(
          mockResponse({
            text: JSON.stringify({ task_id: 1, other_task_id: 42, relation_kind: 'subtask' }),
          }),
        )
        .mockResolvedValueOnce(mockResponse({ text: JSON.stringify(parentTaskWithChildren([42])) }))
        // Subtask B: create -> relate FAILS -> atomic compensation deletes task 43.
        .mockResolvedValueOnce(
          mockResponse({ text: JSON.stringify({ id: 43, title: 'B', project_id: 5 }) }),
        )
        .mockResolvedValueOnce(mockResponse({ ok: false, status: 400, statusText: 'Bad Request' }))
        .mockResolvedValueOnce(mockResponse({ text: '{}' })); // DELETE /tasks/43

      const result = await bulkCreateSubtasks(
        { parentTaskId: 1, subtasks: [{ title: 'A' }, { title: 'B' }], atomic: true },
        authManager,
      );

      expect(mockFetch).toHaveBeenCalledTimes(7);
      const compensateCall = mockFetch.mock.calls[6] as [string, RequestInit];
      expect(compensateCall[0]).toBe('https://vikunja.test/api/v1/tasks/43');
      expect(compensateCall[1].method).toBe('DELETE');

      const text = result.content[0].text;
      expect(text).toContain('Successfully created and related 1 of 2 subtask(s)');
      expect(text).toContain('Failed indexes: 1');
    });

    it('throws an API_ERROR when every subtask fails', async () => {
      mockFetch
        .mockResolvedValueOnce(mockResponse({ text: JSON.stringify(parentTask) })) // resolve-parent
        .mockResolvedValueOnce(mockResponse({ ok: false, status: 400, statusText: 'Bad Request' })) // A: create fails
        .mockResolvedValueOnce(mockResponse({ ok: false, status: 400, statusText: 'Bad Request' })); // B: create fails

      await expect(
        bulkCreateSubtasks(
          { parentTaskId: 1, subtasks: [{ title: 'A' }, { title: 'B' }] },
          authManager,
        ),
      ).rejects.toThrow(
        /Bulk create-subtasks failed\. Could not create any subtasks under parent 1/,
      );
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });
  });
});
