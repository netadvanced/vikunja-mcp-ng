/**
 * Targeted validation tests for tasks/crud.ts uncovered lines
 * This file specifically targets the remaining uncovered lines for complete coverage
 *
 * Migrated (Wave D, tasks-core) off the node-vikunja client onto
 * `vikunjaRestRequest` for the core create/get/update/delete calls.
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { createTask, getTask, updateTask, deleteTask } from '../../src/tools/tasks/crud';
import { MCPError, ErrorCode } from '../../src/types';
import type { AuthManager } from '../../src/auth/AuthManager';
import { parseMarkdown } from '../utils/markdown';

// Mock the direct-REST helper used by the migrated CRUD services
jest.mock('../../src/utils/vikunja-rest', () => ({
  vikunjaRestRequest: jest.fn(),
}));

// Mock the client module (still used by createTask/updateTask for the
// labels/assignees sub-resource — sibling item M-B — when requested)
jest.mock('../../src/client', () => ({
  getClientFromContext: jest.fn(),
  getAuthManagerFromContext: jest.fn(),
  hasRequestContext: jest.fn(() => false),
}));

// Mock logger to suppress output during tests
jest.mock('../../src/utils/logger', () => ({
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

import { vikunjaRestRequest } from '../../src/utils/vikunja-rest';

describe('Tasks CRUD - Validation Coverage', () => {
  // See tasks-crud-edge-cases.test.ts: undefined capabilities resolves to v1.
  const mockAuthManager = { getCapabilities: () => undefined } as unknown as AuthManager;
  const mockRest = vikunjaRestRequest as jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('missing validation error paths', () => {
    it('should handle missing title in createTask (line 36)', async () => {
      await expect(
        createTask(
          {
            projectId: 1,
            title: undefined as any, // Missing title
          },
          mockAuthManager,
        ),
      ).rejects.toThrow('title is required to create a task');
    });

    it('should handle empty string title in createTask', async () => {
      await expect(
        createTask(
          {
            projectId: 1,
            title: '', // Empty title
          },
          mockAuthManager,
        ),
      ).rejects.toThrow('title is required to create a task');
    });

    it('should handle missing projectId in createTask (line 30)', async () => {
      await expect(
        createTask(
          {
            projectId: undefined as any, // Missing projectId
            title: 'Test Task',
          },
          mockAuthManager,
        ),
      ).rejects.toThrow('projectId is required to create a task');
    });

    it('should handle missing id in getTask (line 202)', async () => {
      await expect(
        getTask(
          {
            id: undefined as any, // Missing id
          },
          mockAuthManager,
        ),
      ).rejects.toThrow('Task id is required for get operation');
    });

    it('should handle missing id in updateTask (line 252)', async () => {
      await expect(
        updateTask(
          {
            id: undefined as any, // Missing id
            title: 'Updated Title',
          },
          mockAuthManager,
        ),
      ).rejects.toThrow('Task id is required for update operation');
    });

    it('should handle missing id in deleteTask (line 420)', async () => {
      await expect(
        deleteTask(
          {
            id: undefined as any, // Missing id
          },
          mockAuthManager,
        ),
      ).rejects.toThrow('Task id is required for delete operation');
    });
  });

  describe('date coercion in createTask (#167)', () => {
    it('coerces a date-only dueDate to RFC3339 before sending the create request', async () => {
      const createdTask = {
        id: 1,
        title: 'Test Task',
        due_date: '2026-07-24T00:00:00Z',
      };
      mockRest
        .mockResolvedValueOnce(createdTask) // PUT /projects/{id}/tasks
        .mockResolvedValueOnce(createdTask); // final GET /tasks/{id}

      await createTask(
        {
          projectId: 1,
          title: 'Test Task',
          dueDate: '2026-07-24',
        },
        mockAuthManager,
      );

      expect(mockRest).toHaveBeenCalledWith(
        mockAuthManager,
        'PUT',
        '/projects/1/tasks',
        expect.objectContaining({ due_date: '2026-07-24T00:00:00Z' }),
      );
    });

    it('coerces date-only startDate and endDate to RFC3339 before sending the create request', async () => {
      const createdTask = { id: 1, title: 'Test Task' };
      mockRest
        .mockResolvedValueOnce(createdTask) // PUT /projects/{id}/tasks
        .mockResolvedValueOnce(createdTask); // final GET /tasks/{id}

      await createTask(
        {
          projectId: 1,
          title: 'Test Task',
          startDate: '2026-07-24',
          endDate: '2026-08-01',
        },
        mockAuthManager,
      );

      expect(mockRest).toHaveBeenCalledWith(
        mockAuthManager,
        'PUT',
        '/projects/1/tasks',
        expect.objectContaining({
          start_date: '2026-07-24T00:00:00Z',
          end_date: '2026-08-01T00:00:00Z',
        }),
      );
    });

    it('leaves a full RFC3339 dueDate timestamp unchanged', async () => {
      const createdTask = {
        id: 1,
        title: 'Test Task',
        due_date: '2026-07-24T15:30:00Z',
      };
      mockRest
        .mockResolvedValueOnce(createdTask) // PUT /projects/{id}/tasks
        .mockResolvedValueOnce(createdTask); // final GET /tasks/{id}

      await createTask(
        {
          projectId: 1,
          title: 'Test Task',
          dueDate: '2026-07-24T15:30:00Z',
        },
        mockAuthManager,
      );

      expect(mockRest).toHaveBeenCalledWith(
        mockAuthManager,
        'PUT',
        '/projects/1/tasks',
        expect.objectContaining({ due_date: '2026-07-24T15:30:00Z' }),
      );
    });

    it('does not add a due_date field when dueDate is not provided', async () => {
      const createdTask = { id: 1, title: 'Test Task' };
      mockRest
        .mockResolvedValueOnce(createdTask) // PUT /projects/{id}/tasks
        .mockResolvedValueOnce(createdTask); // final GET /tasks/{id}

      await createTask(
        {
          projectId: 1,
          title: 'Test Task',
        },
        mockAuthManager,
      );

      const [, , , body] = mockRest.mock.calls[0];
      expect(body).not.toHaveProperty('due_date');
    });
  });

  describe('error propagation paths', () => {
    it('should handle generic Error in createTask (line 187)', async () => {
      // Mock createTask (PUT /projects/{id}/tasks) to throw a generic Error
      mockRest.mockRejectedValue(new Error('Generic error'));

      await expect(
        createTask(
          {
            projectId: 1,
            title: 'Test Task',
          },
          mockAuthManager,
        ),
      ).rejects.toThrow('Failed to create task: Generic error');
    });

    it('should handle non-Error object in createTask (line 189)', async () => {
      // Mock createTask to throw a non-Error object
      mockRest.mockRejectedValue({ status: 500, message: 'Server error' });

      await expect(
        createTask(
          {
            projectId: 1,
            title: 'Test Task',
          },
          mockAuthManager,
        ),
      ).rejects.toThrow('Failed to create task: Unknown error');
    });

    it('should handle generic Error in getTask (line 229)', async () => {
      // Mock getTask (GET /tasks/{id}) to throw a generic Error
      mockRest.mockRejectedValue(new Error('Database error'));

      await expect(
        getTask(
          {
            id: 1,
          },
          mockAuthManager,
        ),
      ).rejects.toThrow('Failed to get task: Database error');
    });

    it('should handle non-Error object in getTask (line 231)', async () => {
      // Mock getTask to throw a non-Error object
      mockRest.mockRejectedValue({ code: 'DB_ERROR', details: 'Connection lost' });

      await expect(
        getTask(
          {
            id: 1,
          },
          mockAuthManager,
        ),
      ).rejects.toThrow('Failed to get task: Unknown error');
    });

    it('should handle generic Error in updateTask (line 407)', async () => {
      // Mock initial GET /tasks/{id} (analyzeUpdateState) to succeed, then the
      // POST /tasks/{id} update call to throw a generic Error.
      const mockTask = {
        id: 1,
        title: 'Original Title',
        description: 'Original Description',
        due_date: null,
        priority: 1,
        done: false,
        repeat_after: 0,
        repeat_mode: 0,
        assignees: [],
      };
      mockRest
        .mockResolvedValueOnce(mockTask) // analyzeUpdateState's GET
        .mockRejectedValueOnce(new Error('Update failed')); // POST /tasks/{id}

      await expect(
        updateTask(
          {
            id: 1,
            title: 'Updated Title',
          },
          mockAuthManager,
        ),
      ).rejects.toThrow('Failed to update task: Update failed');
    });

    it('should handle non-Error object in updateTask (line 409)', async () => {
      const mockTask = {
        id: 1,
        title: 'Original Title',
        description: 'Original Description',
        due_date: null,
        priority: 1,
        done: false,
        repeat_after: 0,
        repeat_mode: 0,
        assignees: [],
      };
      mockRest
        .mockResolvedValueOnce(mockTask) // analyzeUpdateState's GET
        // Mock updateTask to throw a non-Error object. Use a plain object (not a
        // string) here: the error handler intentionally preserves string
        // rejections as the message (consistent with transform(), see
        // src/utils/error-handler.ts) and only collapses non-Error/non-string
        // shapes to "Unknown error" to avoid leaking arbitrary object payloads.
        .mockRejectedValueOnce({ status: 503, message: 'Update service unavailable' });

      await expect(
        updateTask(
          {
            id: 1,
            title: 'Updated Title',
          },
          mockAuthManager,
        ),
      ).rejects.toThrow('Failed to update task: Unknown error');
    });

    it('should handle generic Error in deleteTask (line 459)', async () => {
      // Mock pre-delete GET to succeed, then DELETE to throw a generic Error
      const mockTask = { id: 1, title: 'Test Task' };
      mockRest
        .mockResolvedValueOnce(mockTask) // gatherDeletionContext's GET
        .mockRejectedValueOnce(new Error('Delete failed')); // DELETE

      await expect(
        deleteTask(
          {
            id: 1,
          },
          mockAuthManager,
        ),
      ).rejects.toThrow('Failed to delete task: Delete failed');
    });

    it('should handle non-Error object in deleteTask (line 461)', async () => {
      const mockTask = { id: 1, title: 'Test Task' };
      mockRest
        .mockResolvedValueOnce(mockTask) // gatherDeletionContext's GET
        .mockRejectedValueOnce(null); // DELETE

      await expect(
        deleteTask(
          {
            id: 1,
          },
          mockAuthManager,
        ),
      ).rejects.toThrow('Failed to delete task: Unknown error');
    });
  });

  describe('MCPError propagation', () => {
    it('should re-throw MCPError in createTask without wrapping', async () => {
      const originalError = new MCPError(ErrorCode.VALIDATION_ERROR, 'Custom validation error');
      mockRest.mockRejectedValue(originalError);

      await expect(
        createTask(
          {
            projectId: 1,
            title: 'Test Task',
          },
          mockAuthManager,
        ),
      ).rejects.toThrow(originalError);
    });

    it('should re-throw MCPError in updateTask without wrapping', async () => {
      const originalError = new MCPError(ErrorCode.API_ERROR, 'Custom API error');

      const mockTask = {
        id: 1,
        title: 'Original Title',
        description: 'Original Description',
        due_date: null,
        priority: 1,
        done: false,
        repeat_after: 0,
        repeat_mode: 0,
        assignees: [],
      };
      mockRest
        .mockResolvedValueOnce(mockTask) // analyzeUpdateState's GET
        .mockRejectedValueOnce(originalError); // POST /tasks/{id}

      await expect(
        updateTask(
          {
            id: 1,
            title: 'Updated Title',
          },
          mockAuthManager,
        ),
      ).rejects.toThrow(originalError);
    });
  });

  describe('affectedFields tracking', () => {
    it('should track field changes correctly in updateTask', async () => {
      const mockTask = {
        id: 1,
        title: 'Original Title',
        description: 'Original Description',
        due_date: '2024-01-01T00:00:00Z',
        priority: 1,
        done: false,
        repeat_after: 0,
        repeat_mode: 0,
        assignees: [],
      };

      const updatedTask = {
        ...mockTask,
        title: 'New Title',
        priority: 5,
        done: true,
      };

      mockRest
        .mockResolvedValueOnce(mockTask) // analyzeUpdateState's GET
        .mockResolvedValueOnce(updatedTask) // POST /tasks/{id}
        .mockResolvedValueOnce(updatedTask); // final GET /tasks/{id}

      const result = await updateTask(
        {
          id: 1,
          title: 'New Title',
          priority: 5,
          done: true,
        },
        mockAuthManager,
      );

      const markdown = result.content[0].text;
      const parsed = parseMarkdown(markdown);
      expect(markdown).toContain('## ✅ Success');
      expect(markdown).toContain('update-task');
      expect(markdown).toContain('Task updated successfully');
    });
  });

  // Issue #226: the "potentially dangerous content" description guard false-positived on
  // ordinary free text (a French engineering note with measurement figures), and was applied
  // inconsistently — create/create-subtask rejected it while update accepted the exact same
  // string. Root cause: an overly-broad HTML-encoded-attribute pattern (`/on\w+[^&]*=/gi`)
  // matched any word containing "on" (e.g. "autonomie") followed anywhere later by an `=`
  // sign; it's been removed from `dangerousPatterns` in src/utils/validation.ts. Root cause of
  // the inconsistency: updateTask never called sanitizeString on title/description at all.
  describe('description dangerous-content check: false positives + create/update parity (#226)', () => {
    // The reporter's exact rejected string.
    const reporterString =
      "2. Quelle nominale retenir (13,75 V = 13 j d'autonomie, 12 V = 44 j) ?";

    // The full bisection table from the issue: every one of these must now be ACCEPTED by
    // both create and update.
    const acceptedStrings = [
      reporterString,
      "a = 13 j autonomie, b = 44 j",
      "a = 13 j, b = 44 j",
      "a = 13 j autonomie",
      "a = 1, b = 2",
      "Fifo=2",
      "Main=50000",
      "(13,75 V = 13 j)",
      "retenir (13,75 V = 13 j d'autonomie)",
      "(13,75 V = 13 j d'autonomie, 12 V = 44 j)",
    ];

    it.each(acceptedStrings)('createTask accepts description %p', async (description) => {
      mockRest
        .mockResolvedValueOnce({ id: 1, title: 'T', description }) // create
        .mockResolvedValueOnce({ id: 1, title: 'T', description }); // final GET

      const result = await createTask(
        { projectId: 1, title: 'T', description },
        mockAuthManager,
      );
      expect(result.content[0].text).toContain('## ✅ Success');
    });

    it.each(acceptedStrings)('updateTask accepts description %p', async (description) => {
      const currentTask = { id: 1, title: 'T', description: 'old' };
      mockRest
        .mockResolvedValueOnce(currentTask) // analyzeUpdateState's GET
        .mockResolvedValueOnce({ ...currentTask, description }) // POST /tasks/{id}
        .mockResolvedValueOnce({ ...currentTask, description }); // final GET /tasks/{id}

      const result = await updateTask({ id: 1, description }, mockAuthManager);
      expect(result.content[0].text).toContain('## ✅ Success');
    });

    it('updateTask now rejects the same dangerous content createTask rejects (was the reported asymmetry)', async () => {
      const dangerous = '<script>alert(1)</script>';

      // create rejects it (pre-existing behavior)
      await expect(
        createTask({ projectId: 1, title: 'T', description: dangerous }, mockAuthManager),
      ).rejects.toThrow(MCPError);

      // update used to accept this silently; it must now reject it too, and name the field.
      await expect(
        updateTask({ id: 1, description: dangerous }, mockAuthManager),
      ).rejects.toThrow('description');
      await expect(
        updateTask({ id: 1, description: dangerous }, mockAuthManager),
      ).rejects.toThrow('script tag');

      // Neither path should have reached the API — validation happens before any request.
      expect(mockRest).not.toHaveBeenCalled();
    });

    it('createTask error names the field and the matched rule (was an unhelpful generic message)', async () => {
      await expect(
        createTask(
          { projectId: 1, title: 'T', description: '<script>alert(1)</script>' },
          mockAuthManager,
        ),
      ).rejects.toThrow('description: String contains potentially dangerous content');
    });

    it('still rejects real XSS/script-injection content on both create and update (guard against over-correction)', async () => {
      const xss = '<img src=x onerror=alert(1)>';
      await expect(
        createTask({ projectId: 1, title: 'T', description: xss }, mockAuthManager),
      ).rejects.toThrow(MCPError);
      await expect(updateTask({ id: 1, description: xss }, mockAuthManager)).rejects.toThrow(
        MCPError,
      );
    });
  });
});
