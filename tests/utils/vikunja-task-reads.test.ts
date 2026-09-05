/**
 * Tests for the version-aware task read transport
 * (src/utils/vikunja-task-reads.ts) and for the filtering strategies now
 * routed through it — #184 P3 step 3.
 *
 * These deliberately exercise the REAL v1 and v2 transports with only
 * `global.fetch` mocked, rather than mocking `vikunjaRestRequest` /
 * `vikunjaRestV2Request`. Two reasons:
 *
 * 1. The v2 envelope is unwrapped inside `vikunjaRestV2Request`
 *    (`normalizeV2Response`). Mocking the transport would skip the very step
 *    that makes a v2 read look like a v1 one, so the assertions would prove
 *    nothing about the real path.
 * 2. The dangerous failure this step can introduce is a query parameter the
 *    server silently ignores. That can only be caught by looking at the URL
 *    actually requested, which needs the transport in the loop.
 *
 * Every payload below is a real response captured from the running 2.6.0 stack
 * on 2026-09-05, trimmed only by dropping tasks, never by inventing fields.
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { AuthManager } from '../../src/auth/AuthManager';
import { ConfigurationManager } from '../../src/config/ConfigurationManager';
import { circuitBreakerRegistry } from '../../src/utils/retry';
import { MCPError } from '../../src/types';
import {
  buildTasksListQuery,
  buildTasksListQueryV2,
  buildTaskListQueryForVersion,
  requestTaskListPage,
  requestTaskRead,
} from '../../src/utils/vikunja-task-reads';
import { getTask } from '../../src/tools/tasks/crud';
import { RestCrossProjectFilteringStrategy } from '../../src/utils/filtering/RestCrossProjectFilteringStrategy';
import { ServerSideFilteringStrategy } from '../../src/utils/filtering/ServerSideFilteringStrategy';
import { ClientSideFilteringStrategy } from '../../src/utils/filtering/ClientSideFilteringStrategy';
import type { FilteringParams } from '../../src/utils/filtering/types';

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

/** A `GET /api/v2/tasks/{id}?format=markdown` body, captured from 2.6.0. */
const V2_SINGLE_TASK = {
  $schema: 'http://localhost:9260/api/v2/schemas/TaskReadOneBody.json',
  id: 185,
  title: 'w2a markdown probe alpha',
  description: 'Hello **bold** and a [link](https://example.com)\n\n- one\n- two',
  done: false,
  project_id: 60,
  identifier: '#2',
  index: 2,
  related_tasks: {},
  attachments: null,
  is_favorite: false,
  created: '2026-09-05T21:35:53Z',
  updated: '2026-09-05T21:35:53Z',
  max_permission: 2,
};

/**
 * The same task as it appears INSIDE a `PaginatedTask` envelope, also captured
 * from 2.6.0. Envelope items carry neither `$schema` nor `max_permission`: the
 * envelope owns the former and the latter is populated on single-entity reads
 * only.
 */
const V2_LIST_ITEM = {
  id: 185,
  title: 'w2a markdown probe alpha',
  description: 'Hello **bold** and a [link](https://example.com)\n\n- one\n- two',
  done: false,
  project_id: 60,
  identifier: '#2',
  index: 2,
  related_tasks: {},
  attachments: null,
  is_favorite: false,
  created: '2026-09-05T21:35:53Z',
  updated: '2026-09-05T21:35:53Z',
};

/** The same task as v1 serves it: no `$schema`, no `max_permission`, HTML. */
const V1_SINGLE_TASK = {
  id: 185,
  title: 'w2a markdown probe alpha',
  description:
    '<p>Hello <strong>bold</strong> and a <a href="https://example.com">link</a></p><ul><li>one</li><li>two</li></ul>',
  done: false,
  project_id: 60,
};

/** A `PaginatedTask` envelope, captured from 2.6.0. */
function v2Envelope(items: unknown[]): Record<string, unknown> {
  return {
    $schema: 'http://localhost:9260/api/v2/schemas/PaginatedTask.json',
    items,
    total: items.length,
    page: 1,
    per_page: 50,
    total_pages: 1,
  };
}

function jsonResponse(body: unknown, contentType = 'application/json'): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: { get: (n: string) => (n.toLowerCase() === 'content-type' ? contentType : null) },
    text: jest.fn(async () => JSON.stringify(body)),
  } as unknown as Response;
}

function errorResponse(status: number, body: unknown, contentType: string): Response {
  return {
    ok: false,
    status,
    statusText: 'Unauthorized',
    headers: { get: (n: string) => (n.toLowerCase() === 'content-type' ? contentType : null) },
    text: jest.fn(async () => JSON.stringify(body)),
  } as unknown as Response;
}

/** The URL of the nth fetch this test made. */
function requestedUrl(index = 0): string {
  return (mockFetch.mock.calls[index] as [string, RequestInit])[0];
}

function v1Session(): AuthManager {
  const auth = new AuthManager();
  auth.connect('https://vikunja.test', 'tk_test-token');
  auth.setCapabilities({ features: {}, hasV2Api: false, serverVersion: 'v2.4.0' });
  return auth;
}

function v2Session(serverVersion = 'v2.6.0'): AuthManager {
  const auth = new AuthManager();
  auth.connect('https://vikunja.test', 'tk_test-token');
  auth.setCapabilities({ features: {}, hasV2Api: true, serverVersion });
  return auth;
}

describe('vikunja-task-reads', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFetch.mockReset();
    circuitBreakerRegistry.clear();
    ConfigurationManager.reset();
  });

  afterEach(() => {
    delete process.env.VIKUNJA_MCP_FORCE_V1_API;
    ConfigurationManager.reset();
  });

  describe('query builders', () => {
    const apiParams = { page: 2, per_page: 50, s: 'needle', sort_by: 'due_date' };
    const extras = {
      orderBy: 'desc' as const,
      filterTimezone: 'Europe/Zurich',
      filterIncludeNulls: false,
      expand: ['subtasks', 'comments'],
    };

    it('spells the search parameter `s` on v1 and adds no format', () => {
      const query = new URLSearchParams(buildTasksListQuery(apiParams, 'done = false', extras));

      expect(query.get('s')).toBe('needle');
      expect(query.get('q')).toBeNull();
      expect(query.get('format')).toBeNull();
    });

    /**
     * The trap this whole step has to survive. Measured live on 2.6.0:
     * `GET /api/v2/projects/60/tasks?q=zzzbeta` returned the 1 matching task
     * while `?s=zzzbeta` returned all 4 tasks in the project — HTTP 200 both
     * times, nothing in the body saying a search had not happened.
     */
    it('renames the search parameter to `q` on v2 and asks for markdown', () => {
      const query = new URLSearchParams(buildTasksListQueryV2(apiParams, 'done = false', extras));

      expect(query.get('q')).toBe('needle');
      expect(query.get('s')).toBeNull();
      expect(query.get('format')).toBe('markdown');
    });

    it('spells every other parameter identically on both versions', () => {
      const v1 = new URLSearchParams(buildTasksListQuery(apiParams, 'done = false', extras));
      const v2 = new URLSearchParams(buildTasksListQueryV2(apiParams, 'done = false', extras));

      for (const key of [
        'page',
        'per_page',
        'sort_by',
        'filter',
        'order_by',
        'filter_timezone',
        'filter_include_nulls',
      ]) {
        expect(v2.get(key)).toBe(v1.get(key));
      }
      expect(v2.getAll('expand')).toEqual(v1.getAll('expand'));
    });

    it('omits absent parameters on both versions', () => {
      expect(buildTasksListQuery({}, undefined, {})).toBe('');
      expect(buildTasksListQueryV2({}, undefined, {})).toBe('format=markdown');
    });

    it('sends filter_include_nulls=true when asked for', () => {
      const v1 = new URLSearchParams(
        buildTasksListQuery({}, undefined, {
          filterIncludeNulls: true,
        }),
      );
      const v2 = new URLSearchParams(
        buildTasksListQueryV2({}, undefined, {
          filterIncludeNulls: true,
        }),
      );

      expect(v1.get('filter_include_nulls')).toBe('true');
      expect(v2.get('filter_include_nulls')).toBe('true');
    });

    it('picks the spelling that matches the transport', () => {
      expect(buildTaskListQueryForVersion('v1', apiParams, undefined, {})).toBe(
        buildTasksListQuery(apiParams, undefined, {}),
      );
      expect(buildTaskListQueryForVersion('v2', apiParams, undefined, {})).toBe(
        buildTasksListQueryV2(apiParams, undefined, {}),
      );
    });
  });

  describe('requestTaskListPage', () => {
    it('reads v1 and keeps `s` when the server has no v2 API', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse([V1_SINGLE_TASK]));

      const tasks = await requestTaskListPage(v1Session(), '/tasks', { s: 'needle' }, undefined);

      expect(requestedUrl()).toBe('https://vikunja.test/api/v1/tasks?s=needle');
      expect(tasks).toEqual([V1_SINGLE_TASK]);
    });

    it('reads v1 when the session has no cached capabilities at all', async () => {
      const auth = new AuthManager();
      auth.connect('https://vikunja.test', 'tk_test-token');
      mockFetch.mockResolvedValueOnce(jsonResponse([]));

      await requestTaskListPage(auth, '/tasks', {}, undefined);

      expect(requestedUrl()).toBe('https://vikunja.test/api/v1/tasks');
    });

    it('reads v2 with markdown and unwraps the pagination envelope', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse(v2Envelope([V2_LIST_ITEM])));

      const tasks = await requestTaskListPage(
        v2Session(),
        '/projects/60/tasks',
        { per_page: 50 },
        undefined,
      );

      expect(requestedUrl()).toBe(
        'https://vikunja.test/api/v2/projects/60/tasks?per_page=50&format=markdown',
      );
      expect(Array.isArray(tasks)).toBe(true);
      expect(tasks).toHaveLength(1);
      expect(tasks[0]?.description).toBe(
        'Hello **bold** and a [link](https://example.com)\n\n- one\n- two',
      );
    });

    /**
     * The silent-ignore trap, end to end. `fakeServer` mirrors what 2.6.0
     * actually does: honour `q`, ignore `s` entirely, answer 200 either way.
     * A regression that sent `s` to v2 would return BOTH tasks here with no
     * error, which is exactly the failure mode this test exists to catch.
     */
    it('actually filters on v2 rather than merely getting a 200 back', async () => {
      const alpha = { id: 1, title: 'w2a probe zzzbeta', description: '' };
      const beta = { id: 2, title: 'unrelated task', description: '' };

      mockFetch.mockImplementation(async (url: unknown) => {
        const query = new URL(String(url)).searchParams;
        const term = query.get('q');
        const matched =
          term === null ? [alpha, beta] : [alpha, beta].filter((t) => t.title.includes(term));
        return jsonResponse(v2Envelope(matched));
      });

      const tasks = await requestTaskListPage(v2Session(), '/tasks', { s: 'zzzbeta' }, undefined);

      expect(tasks).toEqual([alpha]);
    });

    it('sends the server-side filter unchanged on v2', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse(v2Envelope([])));

      await requestTaskListPage(v2Session(), '/tasks', {}, 'done = false');

      expect(requestedUrl()).toContain('filter=done+%3D+false');
    });

    /**
     * Live 2.4.0/2.5.0/2.6.0 envelope items carry no `max_permission`, so this
     * feeds one that does: the single-entity route populates it, the two
     * routes share one server-side model, and the guard is what keeps a
     * future version from leaking a field the spec keeps off P3's tool
     * surface.
     */
    it('drops v2-only fields so a v2 task is shaped like a v1 one', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse(v2Envelope([{ ...V2_LIST_ITEM, max_permission: 2 }])),
      );

      const tasks = await requestTaskListPage(v2Session(), '/tasks', {}, undefined);

      expect(tasks[0]).not.toHaveProperty('max_permission');
      expect(tasks[0]?.id).toBe(185);
    });

    it('leaves an ordinary v2 list item untouched', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse(v2Envelope([V2_LIST_ITEM])));

      const tasks = await requestTaskListPage(v2Session(), '/tasks', {}, undefined);

      expect(tasks[0]).toEqual(V2_LIST_ITEM);
    });

    it('returns an empty array when v2 answers with something that is not a list', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ unexpected: true }));

      await expect(requestTaskListPage(v2Session(), '/tasks', {}, undefined)).resolves.toEqual([]);
    });

    it('returns an empty array when v1 answers with something that is not a list', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ unexpected: true }));

      await expect(requestTaskListPage(v1Session(), '/tasks', {}, undefined)).resolves.toEqual([]);
    });

    /**
     * The kill switch has to make a v2-capable server indistinguishable from
     * a v1-only one, including the query spelling.
     */
    it('stays on v1 with the forceV1Api kill switch set', async () => {
      process.env.VIKUNJA_MCP_FORCE_V1_API = 'true';
      ConfigurationManager.reset();
      mockFetch.mockResolvedValueOnce(jsonResponse([V1_SINGLE_TASK]));

      const tasks = await requestTaskListPage(v2Session(), '/tasks', { s: 'needle' }, undefined);

      expect(requestedUrl()).toBe('https://vikunja.test/api/v1/tasks?s=needle');
      expect(tasks[0]?.description).toContain('<strong>');
    });

    it('needs no minVersion floor: markdown works on the 2.4.0 floor too', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse(v2Envelope([])));

      await requestTaskListPage(v2Session('v2.4.0'), '/tasks', {}, undefined);

      expect(requestedUrl()).toContain('/api/v2/tasks');
      expect(requestedUrl()).toContain('format=markdown');
    });
  });

  describe('requestTaskRead', () => {
    it('reads v1 unchanged when the server has no v2 API', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse(V1_SINGLE_TASK));

      const task = await requestTaskRead(v1Session(), 185);

      expect(requestedUrl()).toBe('https://vikunja.test/api/v1/tasks/185');
      expect(task).toEqual(V1_SINGLE_TASK);
    });

    it('reads v2 with markdown and strips the v2-only fields', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse(V2_SINGLE_TASK));

      const task = await requestTaskRead(v2Session(), 185);

      expect(requestedUrl()).toBe('https://vikunja.test/api/v2/tasks/185?format=markdown');
      expect(task.description).toBe(
        'Hello **bold** and a [link](https://example.com)\n\n- one\n- two',
      );
      expect(task).not.toHaveProperty('$schema');
      expect(task).not.toHaveProperty('max_permission');
      expect(task.id).toBe(185);
    });

    it('stays on v1 with the kill switch set', async () => {
      process.env.VIKUNJA_MCP_FORCE_V1_API = 'true';
      ConfigurationManager.reset();
      mockFetch.mockResolvedValueOnce(jsonResponse(V1_SINGLE_TASK));

      await requestTaskRead(v2Session(), 185);

      expect(requestedUrl()).toBe('https://vikunja.test/api/v1/tasks/185');
    });

    it('surfaces a v2 404 with the status the caller keys on', async () => {
      mockFetch.mockResolvedValue(
        errorResponse(
          404,
          { title: 'Not Found', detail: 'This task does not exist', code: 4002 },
          'application/problem+json',
        ),
      );

      await expect(requestTaskRead(v2Session(), 999999)).rejects.toMatchObject({
        details: { statusCode: 404 },
      });
    });
  });

  /**
   * From Vikunja 2.6.0 an API token's scopes are checked against expanded
   * data, and a token missing them gets a 401 indistinguishable from an
   * expired session. v1's transport infers that and sets
   * `details.insufficientScope`, which `RestCrossProjectFilteringStrategy`
   * reads to refuse a fallback that would silently drop `expand` (#254 A1).
   * The v2 transport carries none of that, so the read path re-applies it.
   */
  describe('expand scope diagnosis on the v2 path', () => {
    const unauthorized = () =>
      errorResponse(
        401,
        { title: 'Unauthorized', detail: 'invalid token' },
        'application/problem+json',
      );

    it('marks a v2 401 on an expand request as an insufficient scope', async () => {
      mockFetch.mockResolvedValue(unauthorized());

      const error = await requestTaskListPage(v2Session(), '/tasks', {}, undefined, {
        expand: ['comments'],
      }).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(MCPError);
      expect((error as MCPError).details?.insufficientScope).toBe(true);
      expect((error as MCPError).message).toContain('expand=comments');
    });

    it('leaves a v2 401 without expand alone', async () => {
      mockFetch.mockResolvedValue(unauthorized());

      const error = await requestTaskListPage(v2Session(), '/tasks', {}, undefined).catch(
        (e: unknown) => e,
      );

      expect(error).toBeInstanceOf(MCPError);
      expect((error as MCPError).details?.insufficientScope).toBeUndefined();
    });

    it('leaves a JWT session alone, where the scope inference does not apply', async () => {
      const auth = new AuthManager();
      auth.connect('https://vikunja.test', 'eyJhbGciOi.eyJpZCI6MX0.signature');
      auth.setCapabilities({ features: {}, hasV2Api: true, serverVersion: 'v2.6.0' });
      mockFetch.mockResolvedValue(unauthorized());

      const error = await requestTaskListPage(auth, '/tasks', {}, undefined, {
        expand: ['comments'],
      }).catch((e: unknown) => e);

      expect((error as MCPError).details?.insufficientScope).toBeUndefined();
    });

    it('leaves a non-HTTP v2 failure alone', async () => {
      mockFetch.mockRejectedValue(new Error('fetch failed'));

      const error = await requestTaskListPage(v2Session(), '/tasks', {}, undefined, {
        expand: ['comments'],
      }).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(MCPError);
      expect((error as MCPError).details?.insufficientScope).toBeUndefined();
    });
  });

  /**
   * The whole point of the step: what a caller of `vikunja_tasks get` reads.
   */
  describe('vikunja_tasks get', () => {
    it('hands the caller a markdown description on a v2 server', async () => {
      mockFetch.mockResolvedValue(jsonResponse(V2_SINGLE_TASK));

      const result = await getTask({ id: 185 }, v2Session());

      expect(requestedUrl()).toBe('https://vikunja.test/api/v2/tasks/185?format=markdown');
      expect(result.content[0]?.text).toContain('Hello **bold**');
      expect(result.content[0]?.text).not.toContain('<strong>');
      expect(result.content[0]?.text).not.toContain('max_permission');
    });

    it('hands the caller HTML on a v1-only server, exactly as before', async () => {
      mockFetch.mockResolvedValue(jsonResponse(V1_SINGLE_TASK));

      const result = await getTask({ id: 185 }, v1Session());

      expect(requestedUrl()).toBe('https://vikunja.test/api/v1/tasks/185');
      expect(result.content[0]?.text).toContain('<strong>');
    });

    it('still reports a missing task as NOT_FOUND over v2', async () => {
      mockFetch.mockResolvedValue(
        errorResponse(
          404,
          { title: 'Not Found', detail: 'This task does not exist', code: 4002 },
          'application/problem+json',
        ),
      );

      await expect(getTask({ id: 999999 }, v2Session())).rejects.toThrow(
        'Task with ID 999999 not found',
      );
    });
  });

  /**
   * The strategies are what the tool surface actually calls, so the routing
   * has to be proven there and not only in the helper.
   */
  describe('filtering strategies route through the resolved version', () => {
    const baseParams = (authManager: AuthManager): FilteringParams => ({
      args: { page: 1, perPage: 50 },
      filterExpression: null,
      filterString: undefined,
      params: { page: 1, per_page: 50 },
      authManager,
    });

    it('RestCrossProjectFilteringStrategy reads v2 markdown for a cross-project listing', async () => {
      mockFetch.mockResolvedValue(
        jsonResponse(v2Envelope([{ ...V2_LIST_ITEM, max_permission: 2 }])),
      );

      const result = await new RestCrossProjectFilteringStrategy().execute(baseParams(v2Session()));

      expect(requestedUrl()).toBe(
        'https://vikunja.test/api/v2/tasks?page=1&per_page=50&format=markdown',
      );
      expect(result.tasks).toHaveLength(1);
      expect(result.tasks[0]?.description).toContain('**bold**');
      expect(result.tasks[0]).not.toHaveProperty('max_permission');
    });

    it('RestCrossProjectFilteringStrategy is byte-identical to today with the kill switch on', async () => {
      process.env.VIKUNJA_MCP_FORCE_V1_API = 'true';
      ConfigurationManager.reset();
      mockFetch.mockResolvedValue(jsonResponse([V1_SINGLE_TASK]));

      const result = await new RestCrossProjectFilteringStrategy().execute(baseParams(v2Session()));

      expect(requestedUrl()).toBe('https://vikunja.test/api/v1/tasks?page=1&per_page=50');
      expect(result.tasks).toEqual([V1_SINGLE_TASK]);
    });

    it('ServerSideFilteringStrategy sends its filter to v2 alongside the markdown request', async () => {
      mockFetch.mockResolvedValue(
        jsonResponse(v2Envelope([{ ...V2_LIST_ITEM, max_permission: 2 }])),
      );

      const params = baseParams(v2Session());
      const result = await new ServerSideFilteringStrategy().execute({
        ...params,
        args: { ...params.args, projectId: 60 },
        filterString: 'done = false',
      });

      const url = new URL(requestedUrl());
      expect(url.pathname).toBe('/api/v2/projects/60/tasks');
      expect(url.searchParams.get('filter')).toBe('done = false');
      expect(url.searchParams.get('format')).toBe('markdown');
      expect(result.metadata.serverSideFilteringUsed).toBe(true);
    });

    it('ClientSideFilteringStrategy reads a single project over v2', async () => {
      mockFetch.mockResolvedValue(
        jsonResponse(v2Envelope([{ ...V2_LIST_ITEM, max_permission: 2 }])),
      );

      const params = baseParams(v2Session());
      const result = await new ClientSideFilteringStrategy().execute({
        ...params,
        args: { ...params.args, projectId: 60 },
      });

      const url = new URL(requestedUrl());
      expect(url.pathname).toBe('/api/v2/projects/60/tasks');
      expect(url.searchParams.get('format')).toBe('markdown');
      expect(result.tasks[0]?.description).toContain('**bold**');
    });

    it('ClientSideFilteringStrategy stays on v1 against a v1-only server', async () => {
      mockFetch.mockResolvedValue(jsonResponse([V1_SINGLE_TASK]));

      const params = baseParams(v1Session());
      await new ClientSideFilteringStrategy().execute({
        ...params,
        args: { ...params.args, projectId: 60 },
      });

      expect(new URL(requestedUrl()).pathname).toBe('/api/v1/projects/60/tasks');
      expect(requestedUrl()).not.toContain('format=');
    });
  });
});
