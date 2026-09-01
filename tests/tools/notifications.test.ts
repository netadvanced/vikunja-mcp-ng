/**
 * Notifications Tool Tests
 *
 * notifications.ts routes every HTTP call through vikunjaRestRequest (see
 * src/utils/vikunja-rest.ts), which normalizes the configured apiUrl to
 * always include the `/api/v1` prefix. These tests mock global fetch the
 * same way tests/tools/webhooks.test.ts does, and assert against the
 * normalized `/api/v1/...` URLs AND the exact outgoing request bodies
 * (docs/ENDPOINT-PLAYBOOK.md §6 — assert on the outgoing payload, not just
 * the return value).
 */

import { jest } from '@jest/globals';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { AuthManager } from '../../src/auth/AuthManager';
import { registerNotificationsTool } from '../../src/tools/notifications';
import { MCPError, ErrorCode } from '../../src/types';
import { getAuthManagerFromContext } from '../../src/client';
import * as validationUtils from '../../src/utils/validation';
import type { MockVikunjaClient, MockAuthManager, MockServer } from '../types/mocks';
import { circuitBreakerRegistry } from '../../src/utils/retry';
import { ConfigurationManager } from '../../src/config';
import { callAndCatch, isReadOnlyRejection } from '../utils/read-only-test-helpers';

jest.mock('../../src/client', () => ({
  getAuthManagerFromContext: jest.fn(),
  setGlobalClientFactory: jest.fn(),
  clearGlobalClientFactory: jest.fn(),
  hasRequestContext: jest.fn(() => false),
}));
jest.mock('../../src/auth/AuthManager');

const mockFetch = jest.fn();
global.fetch = mockFetch as any;

function mockResponse(opts: {
  ok?: boolean;
  status?: number;
  statusText?: string;
  body?: unknown;
}): Response {
  const { ok = true, status = 200, statusText = 'OK', body } = opts;
  const text = body === undefined ? '' : JSON.stringify(body);
  return {
    ok,
    status,
    statusText,
    text: jest.fn(async () => text),
  } as unknown as Response;
}

describe('Notifications Tool', () => {
  let mockServer: MockServer;
  let mockAuthManager: MockAuthManager;
  let mockHandler: (args: any) => Promise<any>;
  let mockClient: MockVikunjaClient;

  beforeEach(() => {
    jest.clearAllMocks();

    mockClient = {
      get: jest.fn(),
      post: jest.fn(),
      put: jest.fn(),
      delete: jest.fn(),
      patch: jest.fn(),
    } as MockVikunjaClient;

    mockAuthManager = {
      isAuthenticated: jest.fn().mockReturnValue(true),
      getSession: jest.fn(),
      setSession: jest.fn(),
      clearSession: jest.fn(),
    } as MockAuthManager;

    mockServer = {
      tool: jest.fn() as jest.MockedFunction<(name: string, schema: any, handler: any) => void>,
    } as MockServer;

    (getAuthManagerFromContext as jest.Mock).mockResolvedValue(mockClient);

    mockAuthManager.getSession.mockReturnValue({
      apiUrl: 'https://api.vikunja.test',
      apiToken: 'test-token',
    });

    mockFetch.mockReset();
    circuitBreakerRegistry.clear();

    registerNotificationsTool(
      mockServer as unknown as McpServer,
      mockAuthManager as unknown as AuthManager,
    );

    const calls = (mockServer.tool as jest.Mock).mock.calls;
    if (calls.length > 0) {
      mockHandler = calls[0][calls[0].length - 1];
    } else {
      throw new Error('Tool handler not found');
    }
  });

  describe('Authentication', () => {
    it('should throw error when not authenticated', async () => {
      mockAuthManager.isAuthenticated.mockReturnValue(false);

      await expect(mockHandler({ subcommand: 'list' })).rejects.toThrow(
        new MCPError(
          ErrorCode.AUTH_REQUIRED,
          'Authentication required. Please use vikunja_auth.connect first.',
        ),
      );
    });
  });

  describe('list', () => {
    it('should throw validation error when no subcommand provided', async () => {
      await expect(mockHandler({})).rejects.toThrow('Unknown subcommand: undefined');
    });

    it('should list notifications with no query params', async () => {
      const notifications = [
        {
          id: 1,
          name: 'task.assigned',
          created: '2026-01-01T00:00:00Z',
          notification: {},
          read_at: null,
        },
      ];
      mockFetch.mockResolvedValueOnce(mockResponse({ body: notifications }));

      const result = await mockHandler({ subcommand: 'list' });

      expect(mockFetch).toHaveBeenCalledWith('https://api.vikunja.test/api/v1/notifications', {
        method: 'GET',
        headers: {
          Authorization: 'Bearer test-token',
          'Content-Type': 'application/json',
        },
      });
      expect(result.content[0].text).toContain('**success:** true');
      expect(result.content[0].text).toContain('**count:** 1');
    });

    it('should pass page and perPage as query parameters', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({ body: [] }));

      await mockHandler({ subcommand: 'list', page: 2, perPage: 10 });

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.vikunja.test/api/v1/notifications?page=2&per_page=10',
        expect.objectContaining({ method: 'GET' }),
      );
    });

    it('should filter to unread notifications client-side when unreadOnly is set', async () => {
      const notifications = [
        {
          id: 1,
          name: 'a',
          created: '2026-01-01T00:00:00Z',
          notification: {},
          read_at: '2026-01-02T00:00:00Z',
        },
        { id: 2, name: 'b', created: '2026-01-01T00:00:00Z', notification: {}, read_at: null },
      ];
      mockFetch.mockResolvedValueOnce(mockResponse({ body: notifications }));

      const result = await mockHandler({ subcommand: 'list', unreadOnly: true });

      expect(result.content[0].text).toContain('**count:** 1');
      expect(result.content[0].text).toContain('"id": 2');
      expect(result.content[0].text).not.toContain('"id": 1');
    });

    // Regression for issue #286 / HIGH-15, confirmed live against a real
    // Vikunja 2.4.0 instance: `read_at` for a genuinely unread notification
    // serializes as the truthy zero-time string "0001-01-01T00:00:00Z", not
    // `null`. A bare `!n.read_at` truthiness check treats that as "read"
    // and would filter it OUT of `unreadOnly: true` results.
    it('treats the zero-time read_at sentinel as unread for unreadOnly filtering', async () => {
      const notifications = [
        {
          id: 1,
          name: 'a',
          created: '2026-01-01T00:00:00Z',
          notification: {},
          read_at: '2026-01-02T00:00:00Z',
        },
        {
          id: 2,
          name: 'b',
          created: '2026-01-01T00:00:00Z',
          notification: {},
          read_at: '0001-01-01T00:00:00Z',
        },
      ];
      mockFetch.mockResolvedValueOnce(mockResponse({ body: notifications }));

      const result = await mockHandler({ subcommand: 'list', unreadOnly: true });

      expect(result.content[0].text).toContain('**count:** 1');
      expect(result.content[0].text).toContain('"id": 2');
      expect(result.content[0].text).not.toContain('"id": 1');
    });

    // Regression for issue #289 / HIGH-18: a single unpaged GET
    // /notifications used to silently cap out at whatever the server's
    // page clamp is, with no signal more notifications existed.
    describe('pagination (issue #289 / HIGH-18)', () => {
      const makeNotification = (id: number) => ({
        id,
        name: 'a',
        created: '2026-01-01T00:00:00Z',
        notification: {},
        read_at: '2026-01-02T00:00:00Z',
      });

      it('fetches a second page when the first page comes back full', async () => {
        const page1 = Array.from({ length: 50 }, (_, i) => makeNotification(i + 1));
        const page2 = [makeNotification(51)];
        mockFetch
          .mockResolvedValueOnce(mockResponse({ body: page1 }))
          .mockResolvedValueOnce(mockResponse({ body: page2 }));

        const result = await mockHandler({ subcommand: 'list' });

        expect(mockFetch).toHaveBeenCalledTimes(2);
        expect(mockFetch).toHaveBeenNthCalledWith(
          1,
          'https://api.vikunja.test/api/v1/notifications',
          expect.objectContaining({ method: 'GET' }),
        );
        expect(mockFetch).toHaveBeenNthCalledWith(
          2,
          'https://api.vikunja.test/api/v1/notifications?page=2',
          expect.objectContaining({ method: 'GET' }),
        );
        expect(result.content[0].text).toContain('**count:** 51');
        expect(result.content[0].text).not.toContain('INCOMPLETE');
      });

      it('does not auto-paginate when the caller supplied an explicit page/perPage', async () => {
        const page1 = Array.from({ length: 50 }, (_, i) => makeNotification(i + 1));
        mockFetch.mockResolvedValueOnce(mockResponse({ body: page1 }));

        const result = await mockHandler({ subcommand: 'list', page: 1, perPage: 50 });

        expect(mockFetch).toHaveBeenCalledTimes(1);
        expect(result.content[0].text).toContain('**count:** 50');
      });

      it('marks the result INCOMPLETE when the VIKUNJA_MAX_TASKS_LIMIT budget is hit mid-walk', async () => {
        const originalEnv = process.env.VIKUNJA_MAX_TASKS_LIMIT;
        process.env.VIKUNJA_MAX_TASKS_LIMIT = '60';
        try {
          const page1 = Array.from({ length: 50 }, (_, i) => makeNotification(i + 1));
          const page2 = Array.from({ length: 50 }, (_, i) => makeNotification(51 + i));
          mockFetch
            .mockResolvedValueOnce(mockResponse({ body: page1 }))
            .mockResolvedValueOnce(mockResponse({ body: page2 }));

          const result = await mockHandler({ subcommand: 'list' });

          expect(result.content[0].text).toContain('**count:** 60');
          expect(result.content[0].text).toContain('INCOMPLETE');
          expect(result.content[0].text).toContain('VIKUNJA_MAX_TASKS_LIMIT');
        } finally {
          if (originalEnv === undefined) {
            delete process.env.VIKUNJA_MAX_TASKS_LIMIT;
          } else {
            process.env.VIKUNJA_MAX_TASKS_LIMIT = originalEnv;
          }
        }
      });
    });

    it('should handle an empty notification list', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({ body: [] }));

      const result = await mockHandler({ subcommand: 'list' });

      expect(result.content[0].text).toContain('**count:** 0');
    });

    it('should attach a best-effort relatedTask when the notification payload embeds one', async () => {
      const notifications = [
        {
          id: 1,
          name: 'task.assigned',
          created: '2026-01-01T00:00:00Z',
          notification: { task: { id: 42, title: 'Ship the feature' } },
          read_at: null,
        },
      ];
      mockFetch.mockResolvedValueOnce(mockResponse({ body: notifications }));

      const result = await mockHandler({ subcommand: 'list' });

      expect(result.content[0].text).toContain('"relatedTask"');
      expect(result.content[0].text).toContain('Ship the feature');
    });

    it('should omit relatedTask when the notification payload does not embed a recognizable task', async () => {
      const notifications = [
        {
          id: 1,
          name: 'team.added',
          created: '2026-01-01T00:00:00Z',
          notification: { team: { id: 1 } },
          read_at: null,
        },
      ];
      mockFetch.mockResolvedValueOnce(mockResponse({ body: notifications }));

      const result = await mockHandler({ subcommand: 'list' });

      expect(result.content[0].text).not.toContain('relatedTask');
    });

    it('should omit relatedTask when the embedded task object has the wrong field types', async () => {
      const notifications = [
        {
          id: 1,
          name: 'task.assigned',
          created: '2026-01-01T00:00:00Z',
          notification: { task: { id: 'not-a-number', title: 42 } },
          read_at: null,
        },
      ];
      mockFetch.mockResolvedValueOnce(mockResponse({ body: notifications }));

      const result = await mockHandler({ subcommand: 'list' });

      expect(result.content[0].text).not.toContain('relatedTask');
    });

    it('should treat a null/non-object notification payload as having no relatedTask', async () => {
      const notifications = [
        { id: 1, name: 'x', created: '2026-01-01T00:00:00Z', notification: null, read_at: null },
        {
          id: 2,
          name: 'y',
          created: '2026-01-01T00:00:00Z',
          notification: 'a string',
          read_at: null,
        },
      ];
      mockFetch.mockResolvedValueOnce(mockResponse({ body: notifications }));

      const result = await mockHandler({ subcommand: 'list' });

      expect(result.content[0].text).not.toContain('relatedTask');
    });

    it('should handle API errors', async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse({ ok: false, status: 400, statusText: 'Bad Request' }),
      );

      await expect(mockHandler({ subcommand: 'list' })).rejects.toThrow('HTTP 400');
    });

    it('should surface link-share 403s with a plain-language message', async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse({ ok: false, status: 403, statusText: 'Forbidden' }),
      );

      await expect(mockHandler({ subcommand: 'list' })).rejects.toThrow(
        new MCPError(
          ErrorCode.PERMISSION_DENIED,
          'Link shares cannot have notifications. Authenticate as a full user to use vikunja_notifications.',
        ),
      );
    });
  });

  describe('mark-read', () => {
    it('should throw error for invalid notification id', async () => {
      await expect(
        mockHandler({ subcommand: 'mark-read', notificationId: 'invalid' }),
      ).rejects.toThrow(
        new MCPError(ErrorCode.VALIDATION_ERROR, 'notificationId must be a positive integer'),
      );
    });

    it('should POST an explicit { read: true } body, not the documented empty body', async () => {
      // Issue #314, confirmed live against Vikunja 2.4.0 on both a postgres
      // and a freshly-provisioned sqlite backend: the spec-documented
      // bodyless toggle (docs/vikunja-openapi.json says "no request body")
      // never actually persists a read state, no matter how many times it
      // is called. Sniffing the real frontend's own request showed it sends
      // `{"read": true}` explicitly, which DOES persist — see
      // `ensureNotificationRead`'s doc comment and
      // docs/VIKUNJA_API_ISSUES.md item #21. This asserts the outgoing
      // request body carries that fix (docs/ENDPOINT-PLAYBOOK.md §6).
      mockFetch.mockResolvedValueOnce(
        mockResponse({
          body: {
            id: 5,
            name: 'x',
            created: '2026-01-01T00:00:00Z',
            read_at: '2026-01-02T00:00:00Z',
            read: true,
          },
        }),
      );

      const result = await mockHandler({ subcommand: 'mark-read', notificationId: 5 });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch).toHaveBeenCalledWith('https://api.vikunja.test/api/v1/notifications/5', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ read: true }),
      });
      expect(result.content[0].text).toContain('marked as read');
      expect(result.content[0].text).not.toContain('WARNING');
    });

    it('should retry once, still sending { read: true }, when the first call does not confirm read: true', async () => {
      // Defensive fallback path (kept from before #314's fix): if the
      // server's response doesn't confirm `read: true` on the first
      // attempt, retry once before giving up, so mark-read stays
      // idempotent no matter the notification's starting state or a
      // transient server hiccup.
      mockFetch
        .mockResolvedValueOnce(
          mockResponse({
            body: {
              id: 5,
              name: 'x',
              created: '2026-01-01T00:00:00Z',
              read_at: '0001-01-01T00:00:00Z',
              read: false,
            },
          }),
        )
        .mockResolvedValueOnce(
          mockResponse({
            body: {
              id: 5,
              name: 'x',
              created: '2026-01-01T00:00:00Z',
              read_at: '2026-01-02T00:00:00Z',
              read: true,
            },
          }),
        );

      const result = await mockHandler({ subcommand: 'mark-read', notificationId: 5 });

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(mockFetch).toHaveBeenNthCalledWith(
        1,
        'https://api.vikunja.test/api/v1/notifications/5',
        expect.objectContaining({ method: 'POST', body: JSON.stringify({ read: true }) }),
      );
      expect(mockFetch).toHaveBeenNthCalledWith(
        2,
        'https://api.vikunja.test/api/v1/notifications/5',
        expect.objectContaining({ method: 'POST', body: JSON.stringify({ read: true }) }),
      );
      expect(result.content[0].text).toContain('marked as read');
      expect(result.content[0].text).not.toContain('WARNING');
    });

    it('should surface a warning instead of a silent success when both attempts fail to confirm read: true', async () => {
      // #314's suggested next step: don't silently report "marked as read"
      // when the server never actually confirmed it, even after the retry.
      mockFetch
        .mockResolvedValueOnce(
          mockResponse({
            body: {
              id: 5,
              name: 'x',
              created: '2026-01-01T00:00:00Z',
              read_at: '0001-01-01T00:00:00Z',
              read: false,
            },
          }),
        )
        .mockResolvedValueOnce(
          mockResponse({
            body: {
              id: 5,
              name: 'x',
              created: '2026-01-01T00:00:00Z',
              read_at: '0001-01-01T00:00:00Z',
              read: false,
            },
          }),
        );

      const result = await mockHandler({ subcommand: 'mark-read', notificationId: 5 });

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(result.content[0].text).toContain('WARNING');
      expect(result.content[0].text).toContain(
        'did not confirm read: true after 2 attempts',
      );
    });
  });

  describe('mark-all-read', () => {
    it('should POST to /notifications with no body', async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse({ body: { message: 'All notifications marked as read.' } }),
      );

      const result = await mockHandler({ subcommand: 'mark-all-read' });

      expect(mockFetch).toHaveBeenCalledWith('https://api.vikunja.test/api/v1/notifications', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-token',
          'Content-Type': 'application/json',
        },
      });
      expect(result.content[0].text).toContain('All notifications marked as read.');
    });

    it('should fall back to a default message when the API returns no message field', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({ body: {} }));

      const result = await mockHandler({ subcommand: 'mark-all-read' });

      expect(result.content[0].text).toContain('All notifications marked as read');
    });
  });

  describe('error handling', () => {
    it('should handle unknown subcommand', async () => {
      await expect(mockHandler({ subcommand: 'unknown' })).rejects.toThrow(
        new MCPError(ErrorCode.VALIDATION_ERROR, 'Unknown subcommand: unknown'),
      );
    });

    it('should surface a network failure (fetch rejects) as the MCPError vikunjaRestRequest already produced', async () => {
      // vikunjaRestRequest wraps every fetch failure into an MCPError before
      // it ever reaches notifications.ts, so this already carries a clear,
      // specific message — it does not fall through to the generic
      // "Notifications operation failed: ..." wrapper.
      mockFetch.mockRejectedValue(new Error('boom'));

      await expect(mockHandler({ subcommand: 'list' })).rejects.toThrow(
        'Vikunja REST request failed (GET /notifications): boom',
      );
    });

    // The generic Error/non-Error branches of the outer catch exist as a
    // safety net for failures that do not originate from vikunjaRestRequest
    // (which always throws MCPError). validateAndConvertId is one such
    // dependency; mock it to simulate an unexpected non-MCPError failure and
    // confirm the safety net still works.
    describe('unexpected (non-MCPError) failures from other dependencies', () => {
      let validateAndConvertIdSpy: jest.SpiedFunction<typeof validationUtils.validateAndConvertId>;

      beforeEach(() => {
        validateAndConvertIdSpy = jest.spyOn(validationUtils, 'validateAndConvertId');
      });

      afterEach(() => {
        validateAndConvertIdSpy.mockRestore();
      });

      it('should wrap a plain Error as an API_ERROR', async () => {
        validateAndConvertIdSpy.mockImplementationOnce(() => {
          throw new Error('unexpected failure');
        });

        await expect(mockHandler({ subcommand: 'mark-read', notificationId: 1 })).rejects.toThrow(
          new MCPError(ErrorCode.API_ERROR, 'Notifications operation failed: unexpected failure'),
        );
      });

      it('should handle a non-Error throw as an INTERNAL_ERROR', async () => {
        validateAndConvertIdSpy.mockImplementationOnce(() => {
          // eslint-disable-next-line @typescript-eslint/no-throw-literal
          throw 'string error';
        });

        await expect(mockHandler({ subcommand: 'mark-read', notificationId: 1 })).rejects.toThrow(
          new MCPError(
            ErrorCode.INTERNAL_ERROR,
            'An unexpected error occurred during a notifications operation',
          ),
        );
      });
    });
  });

  describe('global read-only mode', () => {
    afterEach(() => {
      ConfigurationManager.reset();
    });

    it('rejects mark-read/mark-all-read when readOnly is on', async () => {
      ConfigurationManager.reset();
      ConfigurationManager.getInstance({ sources: { readOnly: true } });

      expect(
        isReadOnlyRejection(
          await callAndCatch(mockHandler, { subcommand: 'mark-read', notificationId: 1 }),
        ),
      ).toBe(true);
      expect(
        isReadOnlyRejection(await callAndCatch(mockHandler, { subcommand: 'mark-all-read' })),
      ).toBe(true);
    });

    it('does not raise the read-only error for list when readOnly is on', async () => {
      ConfigurationManager.reset();
      ConfigurationManager.getInstance({ sources: { readOnly: true } });

      expect(isReadOnlyRejection(await callAndCatch(mockHandler, { subcommand: 'list' }))).toBe(
        false,
      );
    });

    it('does not raise the read-only error for mark-all-read when readOnly is off', async () => {
      ConfigurationManager.reset();
      ConfigurationManager.getInstance({ sources: { readOnly: false } });

      expect(
        isReadOnlyRejection(await callAndCatch(mockHandler, { subcommand: 'mark-all-read' })),
      ).toBe(false);
    });
  });
});
