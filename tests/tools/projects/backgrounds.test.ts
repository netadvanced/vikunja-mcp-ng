/**
 * Tests for the project backgrounds operations (G7,
 * docs/ENDPOINT-TAIL-RETRIAGE.md): remove-background, set-unsplash-background,
 * search-unsplash.
 *
 * Covers id/argument validation, the REST calls made
 * (DELETE /projects/{id}/background, POST /projects/{id}/backgrounds/unsplash,
 * GET /backgrounds/unsplash/search), the friendly "unsplash not configured"
 * error rewrite, and generic error propagation.
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { AuthManager } from '../../../src/auth/AuthManager';
import {
  removeProjectBackground,
  setUnsplashBackground,
  searchUnsplashBackgrounds,
} from '../../../src/tools/projects/backgrounds';
import { MCPError, ErrorCode } from '../../../src/types';
import { circuitBreakerRegistry } from '../../../src/utils/retry';

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

describe('project backgrounds (G7)', () => {
  let authManager: AuthManager;

  beforeEach(() => {
    jest.clearAllMocks();
    mockFetch.mockReset();
    circuitBreakerRegistry.clear();
    authManager = new AuthManager();
    authManager.connect('https://vikunja.test', 'tk_test-token');
  });

  describe('removeProjectBackground', () => {
    it('throws a VALIDATION_ERROR when the project id is missing', async () => {
      await expect(removeProjectBackground({}, authManager)).rejects.toThrow(
        new MCPError(ErrorCode.VALIDATION_ERROR, 'Project id is required for remove-background operation'),
      );
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('throws when the project id is not a positive integer', async () => {
      await expect(removeProjectBackground({ id: -1 }, authManager)).rejects.toThrow(
        'id must be a positive integer',
      );
    });

    it('calls DELETE /projects/{id}/background and returns the project', async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse({ text: JSON.stringify({ id: 5, title: 'My Project' }) }),
      );

      const result = await removeProjectBackground({ id: 5 }, authManager);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://vikunja.test/api/v1/projects/5/background');
      expect(init.method).toBe('DELETE');
      expect(result.content[0].text).toContain('Background removed from project 5');
    });

    it('propagates an HTTP error', async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse({ ok: false, status: 403, statusText: 'Forbidden', text: 'no access' }),
      );
      await expect(removeProjectBackground({ id: 5 }, authManager)).rejects.toThrow(MCPError);
    });

    it('propagates a network error', async () => {
      mockFetch.mockRejectedValue(new Error('offline'));
      await expect(removeProjectBackground({ id: 5 }, authManager)).rejects.toThrow(
        'Vikunja REST request failed (DELETE /projects/5/background): offline',
      );
    });
  });

  describe('setUnsplashBackground', () => {
    it('throws a VALIDATION_ERROR when the project id is missing', async () => {
      await expect(
        setUnsplashBackground({ unsplashImageId: 'abc' }, authManager),
      ).rejects.toThrow('Project id is required for set-unsplash-background operation');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('throws when the project id is not a positive integer', async () => {
      await expect(
        setUnsplashBackground({ id: -1, unsplashImageId: 'abc' }, authManager),
      ).rejects.toThrow('id must be a positive integer');
    });

    it('throws a VALIDATION_ERROR when unsplashImageId is missing', async () => {
      await expect(setUnsplashBackground({ id: 5 }, authManager)).rejects.toThrow(
        'unsplashImageId is required for set-unsplash-background operation',
      );
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('throws a VALIDATION_ERROR when unsplashImageId is blank', async () => {
      await expect(
        setUnsplashBackground({ id: 5, unsplashImageId: '   ' }, authManager),
      ).rejects.toThrow('unsplashImageId is required for set-unsplash-background operation');
    });

    it('sends only the photo id as the request body and returns the project', async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse({ text: JSON.stringify({ id: 5, title: 'My Project' }) }),
      );

      const result = await setUnsplashBackground({ id: 5, unsplashImageId: 'photo-123' }, authManager);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://vikunja.test/api/v1/projects/5/backgrounds/unsplash');
      expect(init.method).toBe('POST');
      expect(init.body).toBe(JSON.stringify({ id: 'photo-123' }));
      expect(result.content[0].text).toContain('background set to unsplash photo photo-123');
    });

    it('rewrites a provider-not-configured error into a friendly message', async () => {
      // 5xx responses are retried (see defaultRestShouldRetry), so mock
      // every attempt with the same response rather than mockResolvedValueOnce.
      mockFetch.mockResolvedValue(
        mockResponse({
          ok: false,
          status: 500,
          statusText: 'Internal Server Error',
          text: JSON.stringify({ message: 'unsplash is not configured on this server' }),
        }),
      );

      await expect(
        setUnsplashBackground({ id: 5, unsplashImageId: 'photo-123' }, authManager),
      ).rejects.toThrow(/Unsplash API key/);
    });

    it('passes through an unrelated HTTP error unchanged', async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse({ ok: false, status: 403, statusText: 'Forbidden', text: 'no access to this project' }),
      );

      await expect(
        setUnsplashBackground({ id: 5, unsplashImageId: 'photo-123' }, authManager),
      ).rejects.toThrow(/HTTP 403/);
    });

    it('propagates a network error', async () => {
      mockFetch.mockRejectedValue(new Error('offline'));
      await expect(
        setUnsplashBackground({ id: 5, unsplashImageId: 'photo-123' }, authManager),
      ).rejects.toThrow('offline');
    });
  });

  describe('searchUnsplashBackgrounds', () => {
    it('builds the query string from unsplashQuery (s) and page (p)', async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse({ text: JSON.stringify([{ id: 'p1', url: 'http://x' }]) }),
      );

      const result = await searchUnsplashBackgrounds(
        { unsplashQuery: 'mountains', page: 2 },
        authManager,
      );

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://vikunja.test/api/v1/backgrounds/unsplash/search?s=mountains&p=2');
      expect(result.content[0].text).toContain('Found 1 unsplash photo');
    });

    it('omits query params entirely when neither is provided', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({ text: JSON.stringify([]) }));

      const result = await searchUnsplashBackgrounds({}, authManager);

      const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://vikunja.test/api/v1/backgrounds/unsplash/search');
      expect(result.content[0].text).toContain('Found 0 unsplash photos');
    });

    it('ignores a blank unsplashQuery', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({ text: JSON.stringify([]) }));

      await searchUnsplashBackgrounds({ unsplashQuery: '   ' }, authManager);

      const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://vikunja.test/api/v1/backgrounds/unsplash/search');
    });

    it('throws a VALIDATION_ERROR for a non-positive page', async () => {
      await expect(searchUnsplashBackgrounds({ page: 0 }, authManager)).rejects.toThrow(
        'page must be a positive integer',
      );
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('treats a non-array response as an empty result', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({ text: JSON.stringify({ oops: true }) }));

      const result = await searchUnsplashBackgrounds({}, authManager);

      expect(result.content[0].text).toContain('Found 0 unsplash photos');
    });

    it('rewrites a provider-not-configured error into a friendly message', async () => {
      // 5xx responses are retried (see defaultRestShouldRetry), so mock
      // every attempt with the same response rather than mockResolvedValueOnce.
      mockFetch.mockResolvedValue(
        mockResponse({
          ok: false,
          status: 500,
          statusText: 'Internal Server Error',
          text: JSON.stringify({ message: 'no unsplash access token configured' }),
        }),
      );

      await expect(searchUnsplashBackgrounds({ unsplashQuery: 'x' }, authManager)).rejects.toThrow(
        /administrator to set up an Unsplash API key/,
      );
    });

    it('passes through an unrelated error unchanged', async () => {
      mockFetch.mockResolvedValue(
        mockResponse({ ok: false, status: 500, statusText: 'Internal Server Error', text: 'boom' }),
      );

      await expect(searchUnsplashBackgrounds({}, authManager)).rejects.toThrow(/HTTP 500/);
    });

    it('propagates a network error', async () => {
      mockFetch.mockRejectedValue(new Error('offline'));
      await expect(searchUnsplashBackgrounds({}, authManager)).rejects.toThrow('offline');
    });
  });
});
