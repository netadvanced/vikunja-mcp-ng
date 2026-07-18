/**
 * Tests for the task duplication operation (`duplicate`).
 *
 * Covers id validation, the PUT request sent to `/tasks/{taskID}/duplicate`
 * (no body), the `models.TaskDuplicate` (`{ duplicated_task }`) response
 * envelope, and error propagation. Direct parallel to
 * tests/tools/projects/duplicate.test.ts.
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { AuthManager } from '../../../src/auth/AuthManager';
import { duplicateTask } from '../../../src/tools/tasks/duplicate';
import { MCPError, ErrorCode } from '../../../src/types';
import { circuitBreakerRegistry } from '../../../src/utils/retry';

// Mock global fetch
const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

/** Minimal Response-like object for the REST helper. */
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

describe('duplicateTask', () => {
  let authManager: AuthManager;

  beforeEach(() => {
    jest.clearAllMocks();
    mockFetch.mockReset();
    circuitBreakerRegistry.clear();
    authManager = new AuthManager();
    authManager.connect('https://vikunja.test', 'tk_test-token');
  });

  describe('validation', () => {
    it('throws a VALIDATION_ERROR when the task id is missing', async () => {
      await expect(duplicateTask({}, authManager)).rejects.toThrow(
        new MCPError(ErrorCode.VALIDATION_ERROR, 'Task id is required for duplicate operation'),
      );
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('throws when the task id is not a positive integer', async () => {
      await expect(duplicateTask({ id: -1 }, authManager)).rejects.toThrow(
        'id must be a positive integer',
      );
    });
  });

  describe('request payload', () => {
    it('sends a bodyless PUT to /tasks/{id}/duplicate', async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse({
          text: JSON.stringify({ duplicated_task: { id: 42, title: 'Copy' } }),
        }),
      );

      const result = await duplicateTask({ id: 5 }, authManager);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://vikunja.test/api/v1/tasks/5/duplicate');
      expect(init.method).toBe('PUT');
      expect(init.body).toBeUndefined();

      const text = result.content[0].text;
      expect(text).toContain('Task 5 duplicated as task 42');
    });

    it('reports success generically when the response has no duplicated_task id', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({ text: '' }));

      const result = await duplicateTask({ id: 5 }, authManager);

      expect(result.content[0].text).toContain('Task 5 duplicated');
      expect(result.content[0].text).not.toContain('as task');
    });

    it('passes a session id through to the response', async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse({ text: JSON.stringify({ duplicated_task: { id: 8 } }) }),
      );

      const result = await duplicateTask({ id: 5, sessionId: 'sess-1' }, authManager);

      expect(result.content[0].type).toBe('text');
      expect(result.content[0].text).toContain('Success');
    });
  });

  describe('error propagation', () => {
    it('propagates an HTTP error from the duplicate request', async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse({ ok: false, status: 403, statusText: 'Forbidden', text: 'no access' }),
      );

      await expect(duplicateTask({ id: 5 }, authManager)).rejects.toThrow(MCPError);
    });

    it('propagates a network error', async () => {
      mockFetch.mockRejectedValue(new Error('offline'));

      await expect(duplicateTask({ id: 5 }, authManager)).rejects.toThrow(
        'Vikunja REST request failed (PUT /tasks/5/duplicate): offline',
      );
    });
  });
});
