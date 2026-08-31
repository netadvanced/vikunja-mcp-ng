/**
 * Tests for the task-field gaps closed on the CREATE paths.
 *
 * Surfaced by comparing against community PRs on the dormant upstream
 * (democratize-technology/vikunja-mcp#94 by @joyjit, #82 by @Alex-Blanes):
 * `percentDone` was supported on update but not on create or bulk-create,
 * `percent_done` was missing from the bulk-update field allowlist, and
 * `bucketId`/`position` were accepted by the flat tool schema on create and
 * silently dropped.
 *
 * Every assertion here checks the WIRE payload (the JSON body actually sent to
 * Vikunja), not merely that a helper was called.
 *
 * SCALE NOTE: the tool surface takes `percentDone` as a WHOLE PERCENTAGE 0-100
 * (integers only); Vikunja's wire field `percent_done` is a 0-1 fraction
 * (`PercentDone float64`, pkg/models/tasks.go). The conversion lives in
 * `src/utils/percent-done.ts` and these tests assert both ends of it: the
 * percentage that goes in, and the fraction that lands in the request body.
 * See decision 22 in docs/ROADMAP.md §3 for why the boundary moved here — and
 * note the upstream PRs above (#94, #82) read the interface as 0-100 too.
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { AuthManager } from '../../../src/auth/AuthManager';
import { createTask } from '../../../src/tools/tasks/crud';
import { createOneBulkTask } from '../../../src/tools/tasks/bulk-operations-simplified';
import { bulkOperationValidator } from '../../../src/tools/tasks/bulk/BulkOperationValidator';
import { circuitBreakerRegistry } from '../../../src/utils/retry';

jest.mock('../../../src/utils/logger');

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

interface FetchCall {
  method: string;
  path: string;
  body: Record<string, unknown> | undefined;
}

/** All fetch calls made, decoded into { method, path, body }. */
function fetchCalls(): FetchCall[] {
  return mockFetch.mock.calls.map((call) => {
    const [url, init] = call as [string, { method?: string; body?: string } | undefined];
    return {
      method: init?.method ?? 'GET',
      path: new URL(url).pathname.replace(/^\/api\/v\d+/, ''),
      body:
        init?.body !== undefined ? (JSON.parse(init.body) as Record<string, unknown>) : undefined,
    };
  });
}

/** The decoded body of the PUT /projects/{id}/tasks create request. */
function createBody(): Record<string, unknown> {
  const call = fetchCalls().find(
    (c) => c.method === 'PUT' && /^\/projects\/\d+\/tasks$/.test(c.path),
  );
  if (!call) throw new Error('no create request was sent');
  return call.body as Record<string, unknown>;
}

describe('task create field gaps', () => {
  let authManager: AuthManager;

  beforeEach(() => {
    jest.clearAllMocks();
    mockFetch.mockReset();
    // vikunjaRestRequest protects every call with a process-wide named
    // circuit breaker; clear accumulated stats between tests so a
    // deliberately failing scenario doesn't trip the breaker for a later test.
    circuitBreakerRegistry.clear();
    authManager = new AuthManager();
    authManager.connect('https://vikunja.test', 'tk_test-token');
  });

  describe('createTask — percentDone', () => {
    /** Routes the plain create flow: PUT create, then GET the complete task. */
    function routeCreateOnly(task: Record<string, unknown>): void {
      mockFetch.mockImplementation(async () =>
        mockResponse({ text: JSON.stringify({ id: 7, ...task }) }),
      );
    }

    it('converts a 0-100 percentDone to the 0-1 wire fraction', async () => {
      routeCreateOnly({ title: 'T', percent_done: 0.5 });

      await createTask({ projectId: 1, title: 'T', percentDone: 50 }, authManager);

      expect(createBody()).toEqual({ title: 'T', project_id: 1, percent_done: 0.5 });
    });

    it('converts an odd percentage exactly (33 -> 0.33, no float artifact)', async () => {
      routeCreateOnly({ title: 'T', percent_done: 0.33 });

      await createTask({ projectId: 1, title: 'T', percentDone: 33 }, authManager);

      // Not 0.33000000000000007 — `n / 100` lands on the same double as the
      // decimal literal.
      expect(createBody()).toHaveProperty('percent_done', 0.33);
    });

    it('sends percent_done: 0 rather than dropping the falsy value', async () => {
      routeCreateOnly({ title: 'T', percent_done: 0 });

      await createTask({ projectId: 1, title: 'T', percentDone: 0 }, authManager);

      expect(createBody()).toHaveProperty('percent_done', 0);
    });

    it('sends percent_done: 1 for a fully-complete task (percentDone: 100)', async () => {
      routeCreateOnly({ title: 'T', percent_done: 1 });

      await createTask({ projectId: 1, title: 'T', percentDone: 100 }, authManager);

      expect(createBody()).toHaveProperty('percent_done', 1);
    });

    it('reads percentDone: 1 as one percent, not as "done"', async () => {
      routeCreateOnly({ title: 'T', percent_done: 0.01 });

      await createTask({ projectId: 1, title: 'T', percentDone: 1 }, authManager);

      // The whole point of the integer percentage scale: under the old 0-1
      // contract this same call silently wrote 100%.
      expect(createBody()).toHaveProperty('percent_done', 0.01);
    });

    it('omits percent_done entirely when percentDone is not supplied', async () => {
      routeCreateOnly({ title: 'T' });

      await createTask({ projectId: 1, title: 'T' }, authManager);

      expect(createBody()).not.toHaveProperty('percent_done');
    });

    it('rejects a fraction with a message that teaches the scale', async () => {
      await expect(
        createTask({ projectId: 1, title: 'T', percentDone: 0.5 }, authManager),
      ).rejects.toThrow('percentDone must be a whole number between 0 and 100');
      await expect(
        createTask({ projectId: 1, title: 'T', percentDone: 0.5 }, authManager),
      ).rejects.toThrow('use 50 for 50%');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('rejects a value above 100 before any request is sent', async () => {
      await expect(
        createTask({ projectId: 1, title: 'T', percentDone: 101 }, authManager),
      ).rejects.toThrow('percentDone must be a whole number between 0 and 100');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('rejects a negative value before any request is sent', async () => {
      await expect(
        createTask({ projectId: 1, title: 'T', percentDone: -1 }, authManager),
      ).rejects.toThrow('percentDone must be a whole number between 0 and 100');
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe('createTask — bucketId', () => {
    /**
     * Routes PUT create -> GET /projects/1/views (Kanban resolution) ->
     * POST the bucket placement -> GET /tasks/7.
     */
    function routeCreateWithBucket(bucketFails = false): void {
      mockFetch.mockImplementation(async (url: unknown, init?: unknown) => {
        const path = new URL(url as string).pathname.replace(/^\/api\/v\d+/, '');
        const method = (init as { method?: string } | undefined)?.method ?? 'GET';
        if (method === 'PUT' && path === '/projects/1/tasks') {
          return mockResponse({ text: JSON.stringify({ id: 7, title: 'T', project_id: 1 }) });
        }
        if (method === 'GET' && path === '/projects/1/views') {
          return mockResponse({
            text: JSON.stringify([
              { id: 10, title: 'List', project_id: 1, view_kind: 'list' },
              { id: 11, title: 'Kanban', project_id: 1, view_kind: 'kanban' },
            ]),
          });
        }
        if (method === 'POST' && /\/buckets\/\d+\/tasks$/.test(path)) {
          if (bucketFails) {
            return mockResponse({
              ok: false,
              status: 403,
              statusText: 'Forbidden',
              text: 'no access to that bucket',
            });
          }
          return mockResponse({ text: JSON.stringify({ task_id: 7, bucket_id: 3 }) });
        }
        if (method === 'GET' && path === '/tasks/7') {
          return mockResponse({ text: JSON.stringify({ id: 7, title: 'T', project_id: 1 }) });
        }
        throw new Error(`unhandled ${method} ${path}`);
      });
    }

    it('places the new task in the bucket via the view/bucket endpoint', async () => {
      routeCreateWithBucket();

      await createTask({ projectId: 1, title: 'T', bucketId: 3 }, authManager);

      const bucketCall = fetchCalls().find((c) => c.method === 'POST');
      expect(bucketCall?.path).toBe('/projects/1/views/11/buckets/3/tasks');
      expect(bucketCall?.body).toEqual({ task_id: 7, bucket_id: 3 });
      // bucketId is NOT part of the create payload — Vikunja's task create
      // endpoint has no bucket field, hence the separate placement call.
      expect(createBody()).not.toHaveProperty('bucket_id');
    });

    it('honours an explicit viewId and skips Kanban view resolution', async () => {
      routeCreateWithBucket();

      await createTask({ projectId: 1, title: 'T', bucketId: 3, viewId: 11 }, authManager);

      expect(fetchCalls().some((c) => c.path === '/projects/1/views')).toBe(false);
      expect(fetchCalls().find((c) => c.method === 'POST')?.path).toBe(
        '/projects/1/views/11/buckets/3/tasks',
      );
    });

    it('reports the created task id when the bucket move fails, and does NOT delete the task', async () => {
      routeCreateWithBucket(true);

      await expect(
        createTask({ projectId: 1, title: 'T', bucketId: 3 }, authManager),
      ).rejects.toThrow(/Task 7 was created but could not be moved into bucket 3/);

      // The task itself was created correctly — destroying it would lose work.
      expect(fetchCalls().some((c) => c.method === 'DELETE')).toBe(false);
    });

    it('rejects an invalid bucketId before any request is sent', async () => {
      await expect(
        createTask({ projectId: 1, title: 'T', bucketId: -1 }, authManager),
      ).rejects.toThrow('bucketId must be a positive integer');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('rejects an invalid viewId before any request is sent', async () => {
      await expect(
        createTask({ projectId: 1, title: 'T', bucketId: 3, viewId: 0 }, authManager),
      ).rejects.toThrow('viewId must be a positive integer');
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe('createTask — position is rejected, never silently dropped', () => {
    it('rejects position with a pointer to set-position', async () => {
      await expect(
        createTask({ projectId: 1, title: 'T', position: 100 }, authManager),
      ).rejects.toThrow('position cannot be set when creating a task');
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe('createOneBulkTask — percentDone', () => {
    it('converts a 0-100 percentDone to the 0-1 wire fraction', async () => {
      mockFetch.mockImplementation(async () =>
        mockResponse({ text: JSON.stringify({ id: 9, title: 'B', percent_done: 0.25 }) }),
      );

      await createOneBulkTask(authManager, 4, { title: 'B', percentDone: 25 });

      const call = fetchCalls().find((c) => c.method === 'PUT');
      expect(call?.path).toBe('/projects/4/tasks');
      expect(call?.body).toEqual({ title: 'B', project_id: 4, percent_done: 0.25 });
    });

    it('omits percent_done when not supplied', async () => {
      mockFetch.mockImplementation(async () =>
        mockResponse({ text: JSON.stringify({ id: 9, title: 'B' }) }),
      );

      await createOneBulkTask(authManager, 4, { title: 'B' });

      expect(fetchCalls()[0]?.body).not.toHaveProperty('percent_done');
    });
  });

  describe('validateBulkCreate — percentDone range', () => {
    it.each([0, 75, 100])('accepts the whole percentage %i', (pct) => {
      expect(() =>
        bulkOperationValidator.validateBulkCreate({
          projectId: 1,
          tasks: [{ title: 'A', percentDone: pct }],
        }),
      ).not.toThrow();
    });

    it('rejects a fraction with the offending index and a teaching message', () => {
      expect(() =>
        bulkOperationValidator.validateBulkCreate({
          projectId: 1,
          tasks: [{ title: 'A' }, { title: 'B', percentDone: 0.75 }],
        }),
      ).toThrow('tasks[1].percentDone must be a whole number between 0 and 100');
    });

    it('rejects a value above 100 with the offending index', () => {
      expect(() =>
        bulkOperationValidator.validateBulkCreate({
          projectId: 1,
          tasks: [{ title: 'A' }, { title: 'B', percentDone: 101 }],
        }),
      ).toThrow('tasks[1].percentDone must be a whole number between 0 and 100');
    });

    it('rejects a non-numeric value', () => {
      expect(() =>
        bulkOperationValidator.validateBulkCreate({
          projectId: 1,
          tasks: [{ title: 'A', percentDone: '50' as unknown as number }],
        }),
      ).toThrow('tasks[0].percentDone must be a whole number between 0 and 100');
    });
  });
});
