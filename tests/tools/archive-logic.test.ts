/**
 * Tests for archiveProject/unarchiveProject, migrated off node-vikunja onto
 * `vikunjaRestRequest` (Wave D domain migration, tracking issue #28).
 *
 * Mocks the REST layer directly (fetch), not a node-vikunja client — see
 * docs/ENDPOINT-PLAYBOOK.md §6.
 */
import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { archiveProject, unarchiveProject } from '../../src/tools/projects/crud';
import { AuthManager } from '../../src/auth/AuthManager';
import { circuitBreakerRegistry } from '../../src/utils/retry';

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

function mockResponse(opts: {
  ok?: boolean;
  status?: number;
  statusText?: string;
  body?: unknown;
  text?: string;
}): Response {
  const { ok = true, status = 200, statusText = 'OK' } = opts;
  const text = opts.text !== undefined ? opts.text : JSON.stringify(opts.body ?? {});
  return {
    ok,
    status,
    statusText,
    text: jest.fn(async () => text),
  } as unknown as Response;
}

describe('Archive/Unarchive Logic (REST-migrated)', () => {
  let authManager: AuthManager;

  // Mock data
  const mockProject = {
    id: 1,
    title: 'Test Project',
    description: 'Test Description',
    is_archived: false,
    hex_color: '#4287f5',
    created: new Date().toISOString(),
    updated: new Date().toISOString(),
    position: 1,
    identifier: 'TEST',
  };

  const archivedProject = {
    ...mockProject,
    is_archived: true,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockFetch.mockReset();
    circuitBreakerRegistry.clear();
    authManager = new AuthManager();
    authManager.connect('https://vikunja.test', 'tk_test-token');
  });

  describe('archiveProject', () => {
    it('should check if project is already archived and return early if true', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({ body: archivedProject }));

      const result = await archiveProject({ id: 1 }, authManager);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://vikunja.test/api/v1/projects/1',
        expect.objectContaining({ method: 'GET' }),
      );

      const markdown = result.content[0].text;
      expect(markdown).toContain('## ✅ Success');
      expect(markdown).toContain('Project "Test Project" is already archived');
      expect(markdown).toContain('**Operation:** archive_project');
    });

    it('should archive project if not already archived', async () => {
      mockFetch
        .mockResolvedValueOnce(mockResponse({ body: mockProject }))
        .mockResolvedValueOnce(mockResponse({ body: archivedProject }));

      const result = await archiveProject({ id: 1 }, authManager);

      expect(mockFetch).toHaveBeenCalledTimes(2);
      const [, postCall] = mockFetch.mock.calls as [string, RequestInit][][];
      expect(postCall[0]).toBe('https://vikunja.test/api/v1/projects/1');
      expect(postCall[1]?.method).toBe('POST');
      expect(JSON.parse(postCall[1]?.body as string)).toEqual({
        ...mockProject,
        is_archived: true,
      });

      const markdown = result.content[0].text;
      expect(markdown).toContain('## ✅ Success');
      expect(markdown).toContain('Project "Test Project" archived successfully');
      expect(markdown).toContain('**Operation:** archive_project');
    });
  });

  describe('unarchiveProject', () => {
    it('should check if project is already active and return early if true', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({ body: mockProject }));

      const result = await unarchiveProject({ id: 1 }, authManager);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://vikunja.test/api/v1/projects/1',
        expect.objectContaining({ method: 'GET' }),
      );

      const markdown = result.content[0].text;
      expect(markdown).toContain('## ✅ Success');
      expect(markdown).toContain('Project "Test Project" is already active (not archived)');
      expect(markdown).toContain('**Operation:** unarchive_project');
    });

    it('should unarchive project if currently archived', async () => {
      mockFetch
        .mockResolvedValueOnce(mockResponse({ body: archivedProject }))
        .mockResolvedValueOnce(mockResponse({ body: mockProject }));

      const result = await unarchiveProject({ id: 1 }, authManager);

      expect(mockFetch).toHaveBeenCalledTimes(2);
      const [, postCall] = mockFetch.mock.calls as [string, RequestInit][][];
      expect(postCall[0]).toBe('https://vikunja.test/api/v1/projects/1');
      expect(postCall[1]?.method).toBe('POST');
      expect(JSON.parse(postCall[1]?.body as string)).toEqual({
        ...archivedProject,
        is_archived: false,
      });

      const markdown = result.content[0].text;
      expect(markdown).toContain('## ✅ Success');
      expect(markdown).toContain('Project "Test Project" unarchived successfully');
      expect(markdown).toContain('**Operation:** unarchive_project');
    });
  });
});
