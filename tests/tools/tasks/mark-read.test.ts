/**
 * Tests for the mark-a-task-as-read operation (`mark-read`).
 *
 * Covers id validation, the POST request sent to `/tasks/{id}/read` (the
 * spec's path parameter is oddly named `projecttask`, but it is still the
 * task id), the `models.TaskUnreadStatus` response, and error propagation.
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { AuthManager } from '../../../src/auth/AuthManager';
import { markTaskRead } from '../../../src/tools/tasks/mark-read';
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

describe('markTaskRead', () => {
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
      await expect(markTaskRead({}, authManager)).rejects.toThrow(
        new MCPError(ErrorCode.VALIDATION_ERROR, 'Task id is required for mark-read operation'),
      );
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('throws when the task id is not a positive integer', async () => {
      await expect(markTaskRead({ id: -1 }, authManager)).rejects.toThrow(
        'id must be a positive integer',
      );
    });
  });

  describe('request payload', () => {
    it('sends a bodyless POST to /tasks/{id}/read', async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse({
          text: JSON.stringify({ taskID: 5, userID: 3 }),
        }),
      );

      const result = await markTaskRead({ id: 5 }, authManager);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://vikunja.test/api/v1/tasks/5/read');
      expect(init.method).toBe('POST');
      expect(init.body).toBeUndefined();

      const text = result.content[0].text;
      expect(text).toContain('Task 5 marked as read');
    });

    it('falls back to the requested id when the response omits taskID', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({ text: '' }));

      const result = await markTaskRead({ id: 5 }, authManager);

      expect(result.content[0].text).toContain('Task 5 marked as read');
    });

    it('passes a session id through to the response', async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse({ text: JSON.stringify({ taskID: 5, userID: 3 }) }),
      );

      const result = await markTaskRead({ id: 5, sessionId: 'sess-1' }, authManager);

      expect(result.content[0].type).toBe('text');
      expect(result.content[0].text).toContain('Success');
    });
  });

  describe('error propagation', () => {
    it('propagates an HTTP error from the mark-read request', async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse({ ok: false, status: 403, statusText: 'Forbidden', text: 'no access' }),
      );

      await expect(markTaskRead({ id: 5 }, authManager)).rejects.toThrow(MCPError);
    });

    it('propagates a network error', async () => {
      mockFetch.mockRejectedValue(new Error('offline'));

      await expect(markTaskRead({ id: 5 }, authManager)).rejects.toThrow(
        'Vikunja REST request failed (POST /tasks/5/read): offline',
      );
    });
  });
});
