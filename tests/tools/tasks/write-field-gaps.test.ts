/**
 * Silently-dropped-field gaps closed on the task WRITE paths.
 *
 * The bug class (see src/utils/strict-nested-object.ts and PR #229's
 * `position` rejection): an agent sends a field, we discard it, the tool
 * reports success, and the caller's intent is lost with no error. Every gap
 * below had to end as either "declared AND forwarded" or "rejected loudly" —
 * never stripped.
 *
 * The four gaps, and why each was resolved the way it was (evidence from
 * go-vikunja v2.3.0, pkg/models/tasks.go — the handler, not the swagger
 * annotation, per docs/VIKUNJA_API_ISSUES.md):
 *
 * 1. `done` on create — SUPPORTED. `createTask` inserts the whole task
 *    struct, `done` included, and `setTaskInBucketInViews` even routes a
 *    `done: true` task into the Kanban Done bucket. The field was declared on
 *    the tool schema and forwarded by update and batch-import, but never
 *    copied by `createTask`.
 * 2. `hexColor` on create/update — SUPPORTED. `createTask` normalises and
 *    inserts `hex_color`; `updateSingleTask` lists `hex_color` in its column
 *    allowlist and maps an empty value back onto the task (so `''` clears the
 *    colour). batch-import already accepted a per-task `hexColor`, so the
 *    field worked in one entry point and was unknown in another.
 * 3. `labelTitles` on `vikunja_tasks apply-label` — SUPPORTED (see
 *    apply-label-title-gap.test.ts for the behavioural half).
 * 4. `repeatAfter`/`repeatMode` on `create-subtask` — SUPPORTED. A subtask is
 *    a plain `models.Task` and `PUT /projects/{id}/tasks` validates and
 *    stores the repeat configuration like any other task; the flat schema
 *    declared both fields and the composite never read them.
 *
 * Assertions are on the WIRE PAYLOAD (docs/ENDPOINT-PLAYBOOK.md §6) — the
 * JSON body actually sent to Vikunja, not that a helper was called. The
 * falsy cases (`done: false`, `hexColor: ''`) are tested explicitly: they are
 * exactly what a naive `if (value)` guard drops.
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { z } from 'zod';
import { AuthManager } from '../../../src/auth/AuthManager';
import { createTask, updateTask } from '../../../src/tools/tasks/crud';
import { createSubtask } from '../../../src/tools/tasks/subtasks';
import { registerTasksTool } from '../../../src/tools/tasks';
import { circuitBreakerRegistry } from '../../../src/utils/retry';
import type { MockServer } from '../../types/mocks';

jest.mock('../../../src/utils/logger');

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

/** Answers every request from `handler`, keyed on method + path. */
function routeByPath(handler: (method: string, path: string) => unknown): void {
  mockFetch.mockImplementation(async (url: unknown, init?: unknown) => {
    const path = new URL(String(url)).pathname.replace(/^\/api\/v\d+/, '');
    const method = ((init as { method?: string } | undefined)?.method ?? 'GET').toUpperCase();
    return mockResponse(handler(method, path));
  });
}

/** Decoded body of the (first) request matching method + path. */
function bodyOf(method: string, pathname: string): Record<string, unknown> | undefined {
  const calls = mockFetch.mock.calls as Array<[string, { method?: string; body?: string }]>;
  const call = calls.find(([url, init]) => {
    const p = new URL(String(url)).pathname.replace(/^\/api\/v\d+/, '');
    return (init?.method ?? 'GET').toUpperCase() === method && p === pathname;
  });
  if (!call?.[1]?.body) return undefined;
  return JSON.parse(call[1].body) as Record<string, unknown>;
}

/** The `vikunja_tasks` Zod shape, exactly as the MCP boundary validates it. */
function tasksShape(): Record<string, z.ZodTypeAny> {
  const server = {
    tool: jest.fn() as jest.MockedFunction<(...args: unknown[]) => void>,
  } as unknown as MockServer;
  registerTasksTool(
    server as never,
    { isAuthenticated: () => true } as unknown as AuthManager,
    undefined,
  );
  const call = (server.tool as unknown as jest.Mock).mock.calls[0] as unknown[];
  return call[2] as Record<string, z.ZodTypeAny>;
}

describe('task write-path field gaps', () => {
  let authManager: AuthManager;

  beforeEach(() => {
    jest.clearAllMocks();
    mockFetch.mockReset();
    circuitBreakerRegistry.clear();
    authManager = new AuthManager();
    authManager.connect('https://vikunja.test', 'tk_test-token');
  });

  /** PUT create + the follow-up GET of the complete task. */
  function routeCreate(): void {
    routeByPath((method, path) => {
      if (method === 'PUT' && path === '/projects/1/tasks') return { id: 7, project_id: 1 };
      if (method === 'GET' && path === '/tasks/7') return { id: 7, project_id: 1 };
      return {};
    });
  }

  describe('create — done', () => {
    it('sends done: true so "create this task, already done" is not silently created open', async () => {
      routeCreate();

      await createTask({ projectId: 1, title: 'Shipped it', done: true }, authManager);

      expect(bodyOf('PUT', '/projects/1/tasks')).toEqual({
        title: 'Shipped it',
        project_id: 1,
        done: true,
      });
    });

    it('sends done: false rather than dropping the falsy value', async () => {
      routeCreate();

      await createTask({ projectId: 1, title: 'T', done: false }, authManager);

      // An `if (args.done)` guard would omit this entirely. The value is
      // explicit caller intent, so it goes on the wire.
      expect(bodyOf('PUT', '/projects/1/tasks')).toHaveProperty('done', false);
    });

    it('omits done entirely when it is not supplied', async () => {
      routeCreate();

      await createTask({ projectId: 1, title: 'T' }, authManager);

      expect(bodyOf('PUT', '/projects/1/tasks')).not.toHaveProperty('done');
    });
  });

  describe('create — hexColor', () => {
    it('sends hex_color on the create payload', async () => {
      routeCreate();

      await createTask({ projectId: 1, title: 'T', hexColor: '#4287f5' }, authManager);

      expect(bodyOf('PUT', '/projects/1/tasks')).toEqual({
        title: 'T',
        project_id: 1,
        hex_color: '#4287f5',
      });
    });

    it("sends hex_color: '' rather than dropping the falsy value", async () => {
      routeCreate();

      await createTask({ projectId: 1, title: 'T', hexColor: '' }, authManager);

      expect(bodyOf('PUT', '/projects/1/tasks')).toHaveProperty('hex_color', '');
    });

    it('omits hex_color entirely when it is not supplied', async () => {
      routeCreate();

      await createTask({ projectId: 1, title: 'T' }, authManager);

      expect(bodyOf('PUT', '/projects/1/tasks')).not.toHaveProperty('hex_color');
    });

    it('rejects a malformed hexColor before any request is sent', async () => {
      await expect(
        createTask({ projectId: 1, title: 'T', hexColor: 'blue' }, authManager),
      ).rejects.toThrow('Invalid hexColor format');
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe('update — hexColor', () => {
    /** GET (analyse) -> POST (full-model update) -> GET (complete task). */
    function routeUpdate(current: Record<string, unknown>): void {
      routeByPath((method, path) => {
        if (path === '/tasks/5') return { id: 5, project_id: 1, title: 'T', ...current };
        return {};
      });
    }

    it('sends hex_color inside the full-model merge, preserving untouched fields', async () => {
      routeUpdate({ hex_color: 'ff0000', description: 'keep me' });

      await updateTask({ id: 5, hexColor: '#4287f5' }, authManager);

      const body = bodyOf('POST', '/tasks/5');
      expect(body).toHaveProperty('hex_color', '#4287f5');
      // POST /tasks/{id} is a full-model replace — anything omitted is
      // cleared, so the merge must carry the rest of the task through.
      expect(body).toHaveProperty('description', 'keep me');
      expect(body).toHaveProperty('title', 'T');
    });

    it("sends hex_color: '' to CLEAR the colour, rather than dropping the falsy value", async () => {
      routeUpdate({ hex_color: 'ff0000' });

      await updateTask({ id: 5, hexColor: '' }, authManager);

      // Vikunja's update maps an empty hex_color back onto the task
      // (`if t.HexColor == "" { ot.HexColor = "" }`), so this is the only way
      // to clear a colour — and precisely what a truthiness guard would eat.
      expect(bodyOf('POST', '/tasks/5')).toHaveProperty('hex_color', '');
    });

    it("leaves the stored colour untouched when hexColor isn't supplied", async () => {
      routeUpdate({ hex_color: 'ff0000' });

      await updateTask({ id: 5, title: 'Renamed' }, authManager);

      expect(bodyOf('POST', '/tasks/5')).toHaveProperty('hex_color', 'ff0000');
    });

    it('rejects a malformed hexColor before any request is sent', async () => {
      await expect(updateTask({ id: 5, hexColor: '#12345' }, authManager)).rejects.toThrow(
        'Invalid hexColor format',
      );
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('reports hexColor as an affected field and snapshots the previous colour', async () => {
      routeUpdate({ hex_color: 'ff0000' });

      const result = await updateTask({ id: 5, hexColor: '#4287f5' }, authManager);
      const text = result.content[0]?.text ?? '';

      expect(text).toMatch(/\*\*affectedFields:\*\* \[\s*"hexColor"\s*\]/);
      expect(text).toContain('"hex_color": "ff0000"');
    });

    it('does NOT report a change when the colour is already that value', async () => {
      routeUpdate({ hex_color: '4287f5' });

      // Vikunja stores hex_color without the leading '#', so a caller
      // re-sending '#4287F5' is a no-op — reporting it as changed would be a
      // lie in the response metadata.
      const result = await updateTask({ id: 5, hexColor: '#4287F5' }, authManager);

      expect(result.content[0]?.text ?? '').toContain('**affectedFields:** []');
    });
  });

  describe('update — repeat configuration (#274, HIGH-3)', () => {
    /** GET (analyse) -> POST (full-model update) -> GET (complete task). */
    function routeUpdate(current: Record<string, unknown>): void {
      routeByPath((method, path) => {
        if (path === '/tasks/5') return { id: 5, project_id: 1, title: 'T', ...current };
        return {};
      });
    }

    it('does not re-multiply an already-in-seconds repeat_after when only repeatMode changes', async () => {
      // Exact numbers from the bug scenario: a weekly task's repeat_after is
      // already 604800 seconds on the wire. Updating just repeatMode must
      // not feed that value back through the day/week/year multiplier.
      routeUpdate({ repeat_after: 604800, repeat_mode: 0 });

      await updateTask({ id: 5, repeatMode: 'week' }, authManager);

      const body = bodyOf('POST', '/tasks/5');
      expect(body).toHaveProperty('repeat_after', 604800);
      expect(body).toHaveProperty('repeat_mode', 0);
    });

    it('sets repeat_mode = 1 for month, leaving repeat_after untouched, when only repeatMode changes', async () => {
      routeUpdate({ repeat_after: 604800, repeat_mode: 0 });

      await updateTask({ id: 5, repeatMode: 'month' }, authManager);

      const body = bodyOf('POST', '/tasks/5');
      expect(body).toHaveProperty('repeat_after', 604800);
      expect(body).toHaveProperty('repeat_mode', 1);
    });

    it('converts a fresh repeatAfter count using the provided repeatMode', async () => {
      routeUpdate({ repeat_after: 604800, repeat_mode: 0 });

      await updateTask({ id: 5, repeatAfter: 2, repeatMode: 'week' }, authManager);

      const body = bodyOf('POST', '/tasks/5');
      expect(body).toHaveProperty('repeat_after', 2 * 7 * 24 * 60 * 60);
      expect(body).toHaveProperty('repeat_mode', 0);
    });
  });

  describe('create-subtask — repeatAfter / repeatMode / done / hexColor', () => {
    function routeSubtaskCreation(): void {
      routeByPath((method, path) => {
        if (method === 'GET' && path === '/tasks/10')
          return { id: 10, project_id: 3, related_tasks: { subtask: [{ id: 11 }] } };
        if (method === 'PUT' && path === '/projects/3/tasks') return { id: 11, project_id: 3 };
        if (method === 'GET' && path === '/tasks/11')
          return { id: 11, project_id: 3, related_tasks: { parenttask: [{ id: 10 }] } };
        return {};
      });
    }

    it('converts a weekly repeat to seconds and mode 0 on the wire', async () => {
      routeSubtaskCreation();

      await createSubtask(
        { parentTaskId: 10, title: 'Weekly check', repeatAfter: 2, repeatMode: 'week' },
        authManager,
      );

      expect(bodyOf('PUT', '/projects/3/tasks')).toMatchObject({
        repeat_after: 2 * 7 * 24 * 60 * 60,
        repeat_mode: 0,
      });
    });

    it('maps a monthly repeat to mode 1, exactly as create does', async () => {
      routeSubtaskCreation();

      await createSubtask(
        { parentTaskId: 10, title: 'Monthly', repeatAfter: 1, repeatMode: 'month' },
        authManager,
      );

      expect(bodyOf('PUT', '/projects/3/tasks')).toMatchObject({ repeat_mode: 1 });
    });

    it('treats a bare repeatAfter as seconds (no mode supplied)', async () => {
      routeSubtaskCreation();

      await createSubtask({ parentTaskId: 10, title: 'Raw', repeatAfter: 3600 }, authManager);

      expect(bodyOf('PUT', '/projects/3/tasks')).toMatchObject({
        repeat_after: 3600,
        repeat_mode: 0,
      });
    });

    it('omits the repeat configuration entirely when neither field is supplied', async () => {
      routeSubtaskCreation();

      await createSubtask({ parentTaskId: 10, title: 'Plain' }, authManager);

      const body = bodyOf('PUT', '/projects/3/tasks');
      expect(body).not.toHaveProperty('repeat_after');
      expect(body).not.toHaveProperty('repeat_mode');
    });

    it('forwards done and hexColor, including their falsy values', async () => {
      routeSubtaskCreation();

      await createSubtask(
        { parentTaskId: 10, title: 'Sub', done: false, hexColor: '' },
        authManager,
      );

      const body = bodyOf('PUT', '/projects/3/tasks');
      expect(body).toHaveProperty('done', false);
      expect(body).toHaveProperty('hex_color', '');
    });

    it('rejects a malformed hexColor before any request is sent', async () => {
      await expect(
        createSubtask({ parentTaskId: 10, title: 'Sub', hexColor: 'rebeccapurple' }, authManager),
      ).rejects.toThrow('Invalid hexColor format');
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe('vikunja_tasks schema declares the fields its handlers read', () => {
    it('keeps hexColor instead of stripping it at the MCP boundary', () => {
      const parsed = z
        .object(tasksShape())
        .parse({ subcommand: 'create', projectId: 1, title: 'T', hexColor: '#4287f5' });
      expect(parsed).toHaveProperty('hexColor', '#4287f5');
    });

    it("accepts hexColor: '' (clear the colour) and rejects a non-#RRGGBB value", () => {
      const shape = tasksShape();
      expect(() =>
        z.object(shape).parse({ subcommand: 'update', id: 1, hexColor: '' }),
      ).not.toThrow();
      const bad = z.object(shape).safeParse({ subcommand: 'update', id: 1, hexColor: '4287f5' });
      expect(bad.success).toBe(false);
      expect(bad.success ? '' : (bad.error.issues[0]?.message ?? '')).toContain('#RRGGBB');
    });

    it('keeps labelTitles instead of stripping it at the MCP boundary', () => {
      const parsed = z
        .object(tasksShape())
        .parse({ subcommand: 'apply-label', id: 5, labels: [1], labelTitles: ['urgent'] });
      expect(parsed).toHaveProperty('labelTitles', ['urgent']);
    });

    it('keeps done, which create now forwards as well as update', () => {
      const parsed = z
        .object(tasksShape())
        .parse({ subcommand: 'create', projectId: 1, title: 'T', done: true });
      expect(parsed).toHaveProperty('done', true);
    });
  });
});
