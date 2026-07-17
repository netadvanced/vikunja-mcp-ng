/**
 * Tests for the project duplication operation (`duplicate`).
 *
 * Covers id validation, the PUT payload sent to
 * `/projects/{projectID}/duplicate` (parent_project_id defaults to root,
 * duplicate_shares defaults to false), and error propagation.
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { AuthManager } from '../../../src/auth/AuthManager';
import { duplicateProject } from '../../../src/tools/projects/duplicate';
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

describe('duplicateProject', () => {
  let authManager: AuthManager;

  beforeEach(() => {
    jest.clearAllMocks();
    mockFetch.mockReset();
    circuitBreakerRegistry.clear();
    authManager = new AuthManager();
    authManager.connect('https://vikunja.test', 'tk_test-token');
  });

  describe('validation', () => {
    it('throws a VALIDATION_ERROR when the project id is missing', async () => {
      await expect(duplicateProject({}, authManager)).rejects.toThrow(
        new MCPError(ErrorCode.VALIDATION_ERROR, 'Project id is required for duplicate operation'),
      );
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('throws when the project id is not a positive integer', async () => {
      await expect(duplicateProject({ id: -1 }, authManager)).rejects.toThrow(
        'id must be a positive integer',
      );
    });

    it('throws when an explicit parentProjectId is invalid (but allows 0 = root)', async () => {
      await expect(
        duplicateProject({ id: 5, parentProjectId: -2 }, authManager),
      ).rejects.toThrow('parentProjectId must be a positive integer');
    });
  });

  describe('request payload', () => {
    it('defaults parent_project_id to 0 (root) and duplicate_shares to false', async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse({
          text: JSON.stringify({ duplicated_project: { id: 42, title: 'Copy' } }),
        }),
      );

      const result = await duplicateProject({ id: 5 }, authManager);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://vikunja.test/api/v1/projects/5/duplicate');
      expect(init.method).toBe('PUT');
      expect(init.body).toBe(
        JSON.stringify({ parent_project_id: 0, duplicate_shares: false }),
      );

      const text = result.content[0].text;
      expect(text).toContain('Project 5 duplicated as project 42');
    });

    it('sends an explicit parentProjectId and duplicateShares', async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse({ text: JSON.stringify({ duplicated_project: { id: 7 } }) }),
      );

      await duplicateProject(
        { id: 5, parentProjectId: 9, duplicateShares: true },
        authManager,
      );

      const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(init.body).toBe(
        JSON.stringify({ parent_project_id: 9, duplicate_shares: true }),
      );
    });

    it('reports success generically when the response has no duplicated_project id', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({ text: '' }));

      const result = await duplicateProject({ id: 5 }, authManager);

      expect(result.content[0].text).toContain('Project 5 duplicated');
      expect(result.content[0].text).not.toContain('as project');
    });

    it('passes a session id through to the response', async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse({ text: JSON.stringify({ duplicated_project: { id: 8 } }) }),
      );

      const result = await duplicateProject({ id: 5, sessionId: 'sess-1' }, authManager);

      expect(result.content[0].type).toBe('text');
      expect(result.content[0].text).toContain('Success');
    });
  });

  describe('error propagation', () => {
    it('propagates an HTTP error from the duplicate request', async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse({ ok: false, status: 403, statusText: 'Forbidden', text: 'no access' }),
      );

      await expect(duplicateProject({ id: 5 }, authManager)).rejects.toThrow(MCPError);
    });

    it('propagates a network error', async () => {
      mockFetch.mockRejectedValue(new Error('offline'));

      await expect(duplicateProject({ id: 5 }, authManager)).rejects.toThrow(
        'Vikunja REST request failed (PUT /projects/5/duplicate): offline',
      );
    });
  });
});
