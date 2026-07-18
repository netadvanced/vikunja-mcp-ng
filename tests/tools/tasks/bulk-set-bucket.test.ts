/**
 * Tests for the `bulk-set-bucket` composite (`bulkSetTaskBucket`).
 *
 * Covers validation, resolving project/view ONCE and reusing them across
 * every task, sequential per-task writes, and honest partial-failure
 * reporting (PR #95's shape) when some tasks fail while others succeed.
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { AuthManager } from '../../../src/auth/AuthManager';
import { bulkSetTaskBucket } from '../../../src/tools/tasks/buckets';
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

const kanbanViews = JSON.stringify([
  { id: 10, title: 'List', project_id: 5, view_kind: 'list' },
  { id: 11, title: 'Kanban', project_id: 5, view_kind: 'kanban' },
]);

describe('bulkSetTaskBucket', () => {
  let authManager: AuthManager;

  beforeEach(() => {
    jest.clearAllMocks();
    mockFetch.mockReset();
    circuitBreakerRegistry.clear();
    authManager = new AuthManager();
    authManager.connect('https://vikunja.test', 'tk_test-token');
  });

  describe('validation', () => {
    it('throws a VALIDATION_ERROR when taskIds is missing', async () => {
      await expect(bulkSetTaskBucket({ bucketId: 3 }, authManager)).rejects.toThrow(
        'taskIds array is required for bulk-set-bucket operation',
      );
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('throws a VALIDATION_ERROR when taskIds is empty', async () => {
      await expect(
        bulkSetTaskBucket({ taskIds: [], bucketId: 3 }, authManager),
      ).rejects.toThrow('taskIds array is required for bulk-set-bucket operation');
    });

    it('throws a VALIDATION_ERROR when bucketId is undefined', async () => {
      await expect(
        bulkSetTaskBucket({ taskIds: [1, 2] }, authManager),
      ).rejects.toThrow('bucketId is required for bulk-set-bucket operation');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('rejects a batch larger than MAX_BULK_OPERATION_TASKS', async () => {
      const taskIds = Array.from({ length: 101 }, (_, i) => i + 1);
      await expect(
        bulkSetTaskBucket({ taskIds, bucketId: 3 }, authManager),
      ).rejects.toThrow(/Too many tasks for bulk operation/);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('validates each task id', async () => {
      await expect(
        bulkSetTaskBucket({ taskIds: [1, -2], bucketId: 3 }, authManager),
      ).rejects.toThrow(MCPError);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('validates bucketId, viewId, and projectId', async () => {
      await expect(
        bulkSetTaskBucket({ taskIds: [1], bucketId: 0 }, authManager),
      ).rejects.toThrow('bucketId must be a positive integer');
      await expect(
        bulkSetTaskBucket({ taskIds: [1], bucketId: 3, viewId: -1 }, authManager),
      ).rejects.toThrow('viewId must be a positive integer');
      await expect(
        bulkSetTaskBucket({ taskIds: [1], bucketId: 3, projectId: 0 }, authManager),
      ).rejects.toThrow('projectId must be a positive integer');
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe('resolution reuse and sequential writes', () => {
    it('resolves project (from the first task) and view ONCE, then places every task sequentially', async () => {
      mockFetch
        // 1) GET /tasks/1 (resolve project from first task)
        .mockResolvedValueOnce(
          mockResponse({ text: JSON.stringify({ id: 1, project_id: 5, title: 'T1' }) }),
        )
        // 2) GET /projects/5/views (resolve Kanban view)
        .mockResolvedValueOnce(mockResponse({ text: kanbanViews }))
        // 3-5) POST bucket placement, one per task
        .mockResolvedValueOnce(mockResponse({ text: '' }))
        .mockResolvedValueOnce(mockResponse({ text: '' }))
        .mockResolvedValueOnce(mockResponse({ text: '' }));

      const result = await bulkSetTaskBucket(
        { taskIds: [1, 2, 3], bucketId: 9 },
        authManager,
      );

      expect(mockFetch).toHaveBeenCalledTimes(5);
      const calls = mockFetch.mock.calls as [string, RequestInit?][];
      expect(calls[0][0]).toBe('https://vikunja.test/api/v1/tasks/1');
      expect(calls[1][0]).toBe('https://vikunja.test/api/v1/projects/5/views');
      // Every subsequent call reuses the SAME resolved project/view — no
      // repeated GET /tasks or GET /views calls per task.
      for (const i of [2, 3, 4]) {
        expect(calls[i][0]).toBe('https://vikunja.test/api/v1/projects/5/views/11/buckets/9/tasks');
        expect((calls[i][1] as RequestInit).method).toBe('POST');
      }
      expect(JSON.parse(calls[2][1]?.body as string)).toEqual({ task_id: 1, bucket_id: 9 });
      expect(JSON.parse(calls[3][1]?.body as string)).toEqual({ task_id: 2, bucket_id: 9 });
      expect(JSON.parse(calls[4][1]?.body as string)).toEqual({ task_id: 3, bucket_id: 9 });

      const text = result.content[0].text;
      expect(text).toContain('Successfully moved 3 tasks to bucket 9');
    });

    it('skips both resolution calls when projectId and viewId are both supplied', async () => {
      mockFetch
        .mockResolvedValueOnce(mockResponse({ text: '' }))
        .mockResolvedValueOnce(mockResponse({ text: '' }));

      await bulkSetTaskBucket(
        { taskIds: [1, 2], bucketId: 9, projectId: 5, viewId: 11 },
        authManager,
      );

      expect(mockFetch).toHaveBeenCalledTimes(2);
      const urls = mockFetch.mock.calls.map((c) => c[0]);
      expect(urls[0]).toBe('https://vikunja.test/api/v1/projects/5/views/11/buckets/9/tasks');
      expect(urls[1]).toBe('https://vikunja.test/api/v1/projects/5/views/11/buckets/9/tasks');
    });

    it('throws NOT_FOUND when the first task cannot be resolved to a project', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({ text: '' }));

      await expect(
        bulkSetTaskBucket({ taskIds: [7, 8], bucketId: 9 }, authManager),
      ).rejects.toThrow(
        new MCPError(ErrorCode.NOT_FOUND, 'Could not resolve the project of task 7'),
      );
      // Only the first task is used for project resolution — no per-task
      // resolution attempted for task 8.
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe('partial failure reporting', () => {
    it('reports a partial success with failedIds when some tasks fail and others succeed', async () => {
      mockFetch
        .mockResolvedValueOnce(mockResponse({ text: '' })) // task 1 succeeds
        .mockResolvedValueOnce(
          mockResponse({ ok: false, status: 400, statusText: 'Bad Request', text: 'nope' }),
        ) // task 2 fails
        .mockResolvedValueOnce(mockResponse({ text: '' })); // task 3 succeeds

      const result = await bulkSetTaskBucket(
        { taskIds: [1, 2, 3], bucketId: 9, projectId: 5, viewId: 11 },
        authManager,
      );

      expect(mockFetch).toHaveBeenCalledTimes(3);
      const text = result.content[0].text;
      expect(text).toContain('Bulk set-bucket partially completed');
      expect(text).toContain('Successfully moved 2 of 3 tasks');
      expect(text).toContain('Failed task IDs: 2');
    });

    it('throws an API_ERROR when every task fails', async () => {
      mockFetch
        .mockResolvedValueOnce(
          mockResponse({ ok: false, status: 400, statusText: 'Bad Request', text: 'nope' }),
        )
        .mockResolvedValueOnce(
          mockResponse({ ok: false, status: 400, statusText: 'Bad Request', text: 'nope' }),
        );

      await expect(
        bulkSetTaskBucket({ taskIds: [1, 2], bucketId: 9, projectId: 5, viewId: 11 }, authManager),
      ).rejects.toThrow(/Bulk set-bucket failed\. Could not move any tasks/);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });
});
