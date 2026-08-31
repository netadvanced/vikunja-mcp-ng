/**
 * `labelTitles` on `vikunja_tasks apply-label` — the third silently-dropped
 * field gap.
 *
 * `applyLabels` (src/tools/tasks/labels.ts) has always read `labelTitles`,
 * and the sibling `vikunja_task_labels` tool has always declared it. The
 * monolithic `vikunja_tasks` shape did not, and Zod strips unknown keys, so
 * at the MCP boundary:
 *
 * - `{ labels: [1], labelTitles: ['urgent'] }` lost the titles and quietly
 *   applied only the id, reporting success;
 * - `{ labelTitles: ['urgent'] }` alone failed with "At least one label id
 *   (labels) or label title (labelTitles) is required" — an error insisting
 *   no titles were given to a caller that had just given some.
 *
 * Resolved as SUPPORTED (the implementation was already there; only the
 * declaration was missing). `remove-label` takes ids only, so `labelTitles`
 * there is rejected loudly instead — the same treatment `position` gets on
 * create.
 *
 * These tests drive the registered tool HANDLER with schema-parsed arguments
 * and assert the resulting wire traffic, not that a helper was called.
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { z } from 'zod';

jest.mock('../../../src/client', () => ({
  getAuthManagerFromContext: jest.fn().mockResolvedValue(undefined),
  hasRequestContext: jest.fn().mockReturnValue(false),
  setGlobalClientFactory: jest.fn(),
  clearGlobalClientFactory: jest.fn(),
}));
jest.mock('../../../src/utils/logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { AuthManager } from '../../../src/auth/AuthManager';
import { registerTasksTool } from '../../../src/tools/tasks';
import { circuitBreakerRegistry } from '../../../src/utils/retry';

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

function mockResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    text: jest.fn(async () => JSON.stringify(body)),
  } as unknown as Response;
}

interface Captured {
  shape: Record<string, z.ZodTypeAny>;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

function registerAndCapture(authManager: AuthManager): Captured {
  let shape: Record<string, z.ZodTypeAny> | undefined;
  let handler: ((args: Record<string, unknown>) => Promise<unknown>) | undefined;
  const server = {
    tool: (...args: unknown[]): void => {
      shape = args[2] as Record<string, z.ZodTypeAny>;
      handler = args[args.length - 1] as (args: Record<string, unknown>) => Promise<unknown>;
    },
  };
  registerTasksTool(server as never, authManager, undefined);
  if (!shape || !handler) throw new Error('tool was not registered');
  return { shape, handler };
}

/** Requests made, as `METHOD path` strings. */
function requests(): string[] {
  return (mockFetch.mock.calls as Array<[string, { method?: string } | undefined]>).map(
    ([url, init]) =>
      `${(init?.method ?? 'GET').toUpperCase()} ${new URL(String(url)).pathname.replace(/^\/api\/v\d+/, '')}${new URL(String(url)).search}`,
  );
}

/** Bodies of every request matching method + path. */
function bodiesOf(method: string, pathname: string): Array<Record<string, unknown>> {
  return (mockFetch.mock.calls as Array<[string, { method?: string; body?: string }]>)
    .filter(([url, init]) => {
      const p = new URL(String(url)).pathname.replace(/^\/api\/v\d+/, '');
      return (init?.method ?? 'GET').toUpperCase() === method && p === pathname;
    })
    .map(([, init]) => JSON.parse(init.body as string) as Record<string, unknown>);
}

describe('vikunja_tasks apply-label labelTitles', () => {
  let authManager: AuthManager;

  beforeEach(() => {
    jest.clearAllMocks();
    mockFetch.mockReset();
    circuitBreakerRegistry.clear();
    authManager = new AuthManager();
    authManager.connect('https://vikunja.test', 'tk_test-token');
  });

  /**
   * Label "urgent" does not exist yet: GET /labels?s=urgent is empty, so
   * ensureLabelByTitle creates it (PUT /labels -> id 9) before it is
   * attached to the task.
   */
  function routeLabelEnsureAndAttach(): void {
    mockFetch.mockImplementation(async (url: unknown, init?: unknown) => {
      const parsed = new URL(String(url));
      const path = parsed.pathname.replace(/^\/api\/v\d+/, '');
      const method = ((init as { method?: string } | undefined)?.method ?? 'GET').toUpperCase();
      if (method === 'GET' && path === '/labels') return mockResponse([]);
      if (method === 'PUT' && path === '/labels') return mockResponse({ id: 9, title: 'urgent' });
      if (method === 'GET' && path === '/tasks/5/labels') return mockResponse([]);
      if (method === 'PUT' && path === '/tasks/5/labels') return mockResponse({ label_id: 9 });
      if (method === 'GET' && path === '/tasks/5') return mockResponse({ id: 5, labels: [] });
      return mockResponse({});
    });
  }

  it('survives schema validation and reaches the wire as a get-or-created label', async () => {
    routeLabelEnsureAndAttach();
    const { shape, handler } = registerAndCapture(authManager);

    // Parse through the real MCP boundary shape first — the whole gap was
    // that this step used to delete labelTitles.
    const args = z
      .object(shape)
      .parse({ subcommand: 'apply-label', id: 5, labelTitles: ['urgent'] }) as Record<
      string,
      unknown
    >;
    await handler(args);

    expect(requests()).toContain('GET /labels?s=urgent');
    expect(bodiesOf('PUT', '/labels')).toEqual([{ title: 'urgent' }]);
    expect(bodiesOf('PUT', '/tasks/5/labels')).toEqual([{ label_id: 9 }]);
  });

  it('applies BOTH the ids in labels and the resolved titles, not just the ids', async () => {
    routeLabelEnsureAndAttach();
    const { shape, handler } = registerAndCapture(authManager);

    const args = z
      .object(shape)
      .parse({ subcommand: 'apply-label', id: 5, labels: [1], labelTitles: ['urgent'] }) as Record<
      string,
      unknown
    >;
    await handler(args);

    // Before the fix the titles were stripped and only label 1 was applied,
    // with a success response — the silent drop.
    expect(bodiesOf('PUT', '/tasks/5/labels')).toEqual([{ label_id: 1 }, { label_id: 9 }]);
  });

  it('rejects labelTitles on remove-label with a teaching pointer, never ignoring it', async () => {
    const { handler } = registerAndCapture(authManager);

    await expect(
      handler({ subcommand: 'remove-label', id: 5, labels: [1], labelTitles: ['urgent'] }),
    ).rejects.toThrow(/labelTitles is not supported by remove-label/);
    await expect(
      handler({ subcommand: 'remove-label', id: 5, labels: [1], labelTitles: ['urgent'] }),
    ).rejects.toThrow(/list-labels/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('leaves an ids-only remove-label untouched', async () => {
    let removed = false;
    mockFetch.mockImplementation(async (url: unknown, init?: unknown) => {
      const path = new URL(String(url)).pathname.replace(/^\/api\/v\d+/, '');
      const method = ((init as { method?: string } | undefined)?.method ?? 'GET').toUpperCase();
      if (method === 'DELETE') {
        removed = true;
        return mockResponse({});
      }
      // removeLabels verifies the removal actually stuck by re-reading the
      // task's labels, so the mock has to reflect the delete.
      if (path === '/tasks/5/labels') {
        return mockResponse(removed ? [] : [{ id: 1, title: 'bug' }]);
      }
      return mockResponse({ id: 5 });
    });
    const { handler } = registerAndCapture(authManager);

    await expect(
      handler({ subcommand: 'remove-label', id: 5, labels: [1], labelTitles: [] }),
    ).resolves.toBeDefined();
    expect(requests()).toContain('DELETE /tasks/5/labels/1');
  });
});
