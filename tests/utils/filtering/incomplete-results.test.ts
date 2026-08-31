/**
 * Regression tests for issue #225 — "date-filtered cross-project listing
 * silently drops tasks".
 *
 * Two independent defects, both verified against a live Vikunja 2.4.0:
 *
 *  a) FILTER DATE LITERALS WERE NOT COERCED. `GET /tasks?filter=created >=
 *     '2026-08-16 00:00:00'` is rejected with
 *     `400 {"code":4019,"message":"The task filter value '2026-08-16
 *     00:00:00' for field 'created' is invalid."}`, while the RFC3339
 *     spelling `created >= 2026-08-16T00:00:00Z` returns 200. So every
 *     date-filtered cross-project listing failed the primary single-call
 *     strategy and dropped into the per-project fallback. Covered by the
 *     `date literals` block below and by tests/utils/filters.test.ts.
 *
 *  b) THE PER-PROJECT FALLBACK IGNORED PAGINATION. It issued one
 *     `GET /projects/{id}/tasks?per_page=1000`; Vikunja clamps `per_page` to
 *     `service.maxitemsperpage` (default 50 — see `max_items_per_page` in
 *     `GET /api/v1/info`), so a 193-task project contributed 50 tasks and
 *     silently dropped 143. The response still reported success.
 *
 * The through-line of both, and of the assertions here: a result that is
 * knowingly incomplete must never be reported as a plain success.
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';

jest.mock('../../../src/utils/vikunja-rest', () => ({
  vikunjaRestRequest: jest.fn(),
}));

jest.mock('../../../src/utils/logger', () => ({
  logger: { info: jest.fn(), error: jest.fn(), debug: jest.fn(), warn: jest.fn() },
}));

jest.mock('../../../src/tools/tasks/validation', () => {
  const actual = jest.requireActual('../../../src/tools/tasks/validation') as Record<
    string,
    unknown
  >;
  return { ...actual, validateId: jest.fn() };
});

import { ClientSideFilteringStrategy } from '../../../src/utils/filtering/ClientSideFilteringStrategy';
import { RestCrossProjectFilteringStrategy } from '../../../src/utils/filtering/RestCrossProjectFilteringStrategy';
import type { FilteringParams, VikunjaTask } from '../../../src/utils/filtering/types';
import type { AuthManager } from '../../../src/auth/AuthManager';
import { vikunjaRestRequest } from '../../../src/utils/vikunja-rest';
import { conditionToString, expressionToString } from '../../../src/utils/filters';

const restMock = vikunjaRestRequest as jest.Mock;
const authManager = {} as AuthManager;

/** An auth manager whose cached `GET /info` reports the server's page clamp. */
const authManagerWithPageCap = (max: number): AuthManager =>
  ({
    getCapabilities: () => ({ features: { max_items_per_page: max }, hasV2Api: false }),
  }) as unknown as AuthManager;

const makeTask = (id: number, projectId: number): VikunjaTask =>
  ({ id, title: `Task ${id}`, project_id: projectId, done: false }) as VikunjaTask;

/**
 * A fake Vikunja that clamps `per_page` to `clamp` (the server's
 * `service.maxitemsperpage`) exactly the way the real one does, and serves a
 * fixed number of tasks per project.
 */
function serverWith(opts: {
  clamp: number;
  projects: number[];
  tasksPerProject: Record<number, number>;
  failProjects?: number[];
}): void {
  restMock.mockImplementation((_auth: unknown, _method: string, path: string) => {
    const [rawPath, rawQuery = ''] = path.split('?');
    const query = new URLSearchParams(rawQuery);
    const page = Number(query.get('page') ?? '1');

    if (rawPath === '/projects') {
      // The project list is clamped too — that is why it has to be paged.
      const slice = opts.projects.slice((page - 1) * opts.clamp, page * opts.clamp);
      return Promise.resolve(slice.map((id) => ({ id, title: `Project ${id}` })));
    }

    const match = /^\/projects\/(-?\d+)\/tasks$/.exec(rawPath ?? '');
    if (match?.[1] !== undefined) {
      const projectId = Number(match[1]);
      if (opts.failProjects?.includes(projectId)) {
        return Promise.reject(new Error(`boom on project ${projectId}`));
      }
      const total = opts.tasksPerProject[projectId] ?? 0;
      const perPage = Math.min(Number(query.get('per_page') ?? '50'), opts.clamp);
      const start = (page - 1) * perPage;
      const ids = Array.from({ length: total }, (_, i) => projectId * 1000 + i);
      return Promise.resolve(
        ids.slice(start, start + perPage).map((id) => makeTask(id, projectId)),
      );
    }

    return Promise.resolve([]);
  });
}

const crossProjectParams = (): FilteringParams => ({
  // No page/perPage in `args` is exactly what the tool synthesises a
  // `per_page: 1000, page: 1` default for — the "give me everything" case.
  args: { allProjects: true },
  filterExpression: null,
  filterString: undefined,
  params: { page: 1, per_page: 1000 },
  authManager,
});

describe('incomplete filtered results are never reported as a clean success', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.VIKUNJA_MAX_TASKS_LIMIT;
  });

  describe('per-project pagination (issue #225b)', () => {
    it('aggregates ALL pages of a project the server clamped to 50 per page', async () => {
      // The reported case: a 193-task project that contributed only 50.
      serverWith({ clamp: 50, projects: [32], tasksPerProject: { 32: 193 } });

      const result = await new ClientSideFilteringStrategy().execute(crossProjectParams());

      expect(result.tasks).toHaveLength(193);
      // 4 task pages (50/50/50/43) plus the project list.
      const taskCalls = restMock.mock.calls.filter((c) =>
        String(c[2]).startsWith('/projects/32/tasks'),
      );
      expect(taskCalls).toHaveLength(4);
      expect(taskCalls.map((c) => String(c[2]))).toEqual([
        '/projects/32/tasks?page=1&per_page=1000',
        '/projects/32/tasks?page=2&per_page=1000',
        '/projects/32/tasks?page=3&per_page=1000',
        '/projects/32/tasks?page=4&per_page=1000',
      ]);
      // Nothing was dropped, so nothing is flagged.
      expect(result.metadata.resultComplete).toBeUndefined();
      expect(result.metadata.warnings).toBeUndefined();
    });

    it('stops after ONE request when the server page cap is known and the project fits', async () => {
      // `GET /info`'s max_items_per_page is cached on the session, so a first
      // page shorter than the cap is conclusively the end of the collection.
      serverWith({ clamp: 50, projects: [7], tasksPerProject: { 7: 12 } });

      const result = await new ClientSideFilteringStrategy().execute({
        ...crossProjectParams(),
        authManager: authManagerWithPageCap(50),
      });

      expect(result.tasks).toHaveLength(12);
      expect(
        restMock.mock.calls.filter((c) => String(c[2]).startsWith('/projects/7/tasks')),
      ).toHaveLength(1);
      // The project list is short of the cap too, so it also stops at one call.
      expect(restMock.mock.calls.filter((c) => String(c[2]).startsWith('/projects?'))).toHaveLength(
        1,
      );
    });

    it('probes one extra page when the server page cap is unknown, and still stops', async () => {
      serverWith({ clamp: 50, projects: [7], tasksPerProject: { 7: 12 } });

      const result = await new ClientSideFilteringStrategy().execute(crossProjectParams());

      expect(result.tasks).toHaveLength(12);
      expect(
        restMock.mock.calls.filter((c) => String(c[2]).startsWith('/projects/7/tasks')),
      ).toHaveLength(2);
    });

    it('keeps paging when the first page is exactly the server cap', async () => {
      serverWith({ clamp: 50, projects: [7], tasksPerProject: { 7: 120 } });

      const result = await new ClientSideFilteringStrategy().execute({
        ...crossProjectParams(),
        authManager: authManagerWithPageCap(50),
      });

      expect(result.tasks).toHaveLength(120);
    });

    it('ignores a nonsensical max_items_per_page and falls back to probing', async () => {
      serverWith({ clamp: 50, projects: [7], tasksPerProject: { 7: 12 } });

      const result = await new ClientSideFilteringStrategy().execute({
        ...crossProjectParams(),
        authManager: authManagerWithPageCap(0),
      });

      expect(result.tasks).toHaveLength(12);
      expect(
        restMock.mock.calls.filter((c) => String(c[2]).startsWith('/projects/7/tasks')),
      ).toHaveLength(2);
    });

    it('pages a SINGLE-project listing too', async () => {
      serverWith({ clamp: 50, projects: [32], tasksPerProject: { 32: 120 } });

      const result = await new ClientSideFilteringStrategy().execute({
        ...crossProjectParams(),
        args: { projectId: 32 },
      });

      expect(result.tasks).toHaveLength(120);
    });

    it('honours an explicitly requested page instead of silently returning every page', async () => {
      serverWith({ clamp: 50, projects: [32], tasksPerProject: { 32: 193 } });

      const result = await new ClientSideFilteringStrategy().execute({
        ...crossProjectParams(),
        args: { allProjects: true, page: 2, perPage: 50 },
        params: { page: 2, per_page: 50 },
      });

      expect(result.tasks).toHaveLength(50);
      expect(
        restMock.mock.calls.filter((c) => String(c[2]).startsWith('/projects/32/tasks')),
      ).toHaveLength(1);
    });

    it('pages the PROJECT list, which the server clamps the same way', async () => {
      // 120 projects with one task each: the old single `?per_page=1000` call
      // only ever saw the first 50 of them.
      const projects = Array.from({ length: 120 }, (_, i) => i + 1);
      serverWith({
        clamp: 50,
        projects,
        tasksPerProject: Object.fromEntries(projects.map((id) => [id, 1])),
      });

      const result = await new ClientSideFilteringStrategy().execute(crossProjectParams());

      expect(result.tasks).toHaveLength(120);
      expect(restMock).toHaveBeenCalledWith(authManager, 'GET', '/projects?per_page=1000');
      expect(restMock).toHaveBeenCalledWith(authManager, 'GET', '/projects?per_page=1000&page=2');
      expect(restMock).toHaveBeenCalledWith(authManager, 'GET', '/projects?per_page=1000&page=3');
    });
  });

  describe('the bound is reported when it is hit', () => {
    it('stops at VIKUNJA_MAX_TASKS_LIMIT and marks the result incomplete', async () => {
      process.env.VIKUNJA_MAX_TASKS_LIMIT = '120';
      serverWith({ clamp: 50, projects: [32], tasksPerProject: { 32: 500 } });

      const result = await new ClientSideFilteringStrategy().execute(crossProjectParams());

      expect(result.tasks).toHaveLength(120);
      expect(result.metadata.resultComplete).toBe(false);
      expect(result.metadata.warnings).toEqual([
        expect.stringContaining('120-task limit (VIKUNJA_MAX_TASKS_LIMIT)'),
      ]);
      // The note a caller actually reads must say so too.
      expect(result.metadata.filteringNote).toContain('INCOMPLETE');
    });

    it('clamps the concurrent multi-project aggregate to the same limit and says so', async () => {
      process.env.VIKUNJA_MAX_TASKS_LIMIT = '100';
      serverWith({
        clamp: 50,
        projects: [1, 2, 3],
        tasksPerProject: { 1: 90, 2: 90, 3: 90 },
      });

      const result = await new ClientSideFilteringStrategy().execute(crossProjectParams());

      expect(result.tasks).toHaveLength(100);
      expect(result.metadata.resultComplete).toBe(false);
      expect(result.metadata.warnings?.join(' ')).toContain('100-task limit');
    });

    it('stops at the per-project page ceiling and says so', async () => {
      // A server handing out one task per page can never exhaust the task
      // budget in a sane number of requests; the page ceiling is the guard
      // that keeps that bounded.
      process.env.VIKUNJA_MAX_TASKS_LIMIT = '100000';
      serverWith({ clamp: 1, projects: [4], tasksPerProject: { 4: 600 } });

      const result = await new ClientSideFilteringStrategy().execute(crossProjectParams());

      expect(result.tasks).toHaveLength(500);
      expect(result.metadata.resultComplete).toBe(false);
      expect(result.metadata.warnings).toEqual([
        expect.stringContaining('stopped after 500 pages'),
      ]);
    });

    it('marks the result incomplete when a project could not be read', async () => {
      serverWith({
        clamp: 50,
        projects: [1, 2],
        tasksPerProject: { 1: 3, 2: 3 },
        failProjects: [2],
      });

      const result = await new ClientSideFilteringStrategy().execute(crossProjectParams());

      // The good project's tasks still come back — but not as a clean success.
      expect(result.tasks).toHaveLength(3);
      expect(result.metadata.resultComplete).toBe(false);
      expect(result.metadata.warnings).toEqual([
        expect.stringContaining('1 project(s) could not be read'),
      ]);
    });

    it('keeps a partial project list rather than failing, and flags it', async () => {
      restMock.mockImplementation((_auth: unknown, _method: string, path: string) => {
        if (path === '/projects?per_page=1000') {
          return Promise.resolve(
            Array.from({ length: 50 }, (_, i) => ({ id: i + 1, title: `P${i + 1}` })),
          );
        }
        if (path.startsWith('/projects?')) {
          return Promise.reject(new Error('project list page 2 exploded'));
        }
        return Promise.resolve([]);
      });

      const result = await new ClientSideFilteringStrategy().execute(crossProjectParams());

      expect(result.metadata.resultComplete).toBe(false);
      expect(result.metadata.warnings).toEqual([
        expect.stringContaining('could not be read past page 1'),
      ]);
    });

    it('still fails outright when the FIRST project-list page fails', async () => {
      restMock.mockRejectedValue(new Error('no project list at all'));

      await expect(new ClientSideFilteringStrategy().execute(crossProjectParams())).rejects.toThrow(
        'no project list at all',
      );
    });
  });

  describe('the fallback carries the server’s own reason forward', () => {
    it('names the 4019 rejection instead of a generic "failed"', async () => {
      restMock.mockImplementation((_auth: unknown, _method: string, path: string) => {
        if (path.startsWith('/tasks?')) {
          return Promise.reject(
            new Error(
              'HTTP 400 — {"code":4019,"message":"The task filter value \'2026-08-16 00:00:00\' for field \'created\' is invalid."}',
            ),
          );
        }
        if (path === '/projects?per_page=1000') return Promise.resolve([{ id: 1, title: 'P1' }]);
        if (path.startsWith('/projects?')) return Promise.resolve([]);
        return Promise.resolve([]);
      });

      const result = await new RestCrossProjectFilteringStrategy().execute({
        ...crossProjectParams(),
        filterString: "created >= '2026-08-16 00:00:00'",
      });

      expect(result.metadata.serverSideFilteringAttempted).toBe(true);
      expect(result.metadata.serverSideFilteringUsed).toBe(false);
      expect(result.metadata.filteringNote).toContain('4019');
    });

    it('surfaces the fallback’s incompleteness through the cross-project strategy', async () => {
      process.env.VIKUNJA_MAX_TASKS_LIMIT = '60';
      restMock.mockImplementation((_auth: unknown, _method: string, path: string) => {
        if (path.startsWith('/tasks?')) return Promise.reject(new Error('HTTP 400'));
        if (path === '/projects?per_page=1000') return Promise.resolve([{ id: 1, title: 'P1' }]);
        if (path.startsWith('/projects?')) return Promise.resolve([]);
        const page = Number(new URLSearchParams(path.split('?')[1]).get('page') ?? '1');
        return Promise.resolve(
          page <= 4 ? Array.from({ length: 50 }, (_, i) => makeTask(page * 100 + i, 1)) : [],
        );
      });

      const result = await new RestCrossProjectFilteringStrategy().execute(crossProjectParams());

      expect(result.metadata.resultComplete).toBe(false);
      expect(result.metadata.filteringNote).toContain('INCOMPLETE');
      expect(result.metadata.warnings?.join(' ')).toContain('60-task limit');
    });
  });

  describe('date literals in filter strings (issue #225a)', () => {
    it('coerces the SQL-ish space-separated form Vikunja rejects with code 4019', () => {
      expect(
        conditionToString({ field: 'created', operator: '>=', value: '2026-08-16 00:00:00' }),
      ).toBe('created >= 2026-08-16T00:00:00Z');
    });

    it('coerces a bare date to midnight UTC', () => {
      expect(conditionToString({ field: 'dueDate', operator: '<', value: '2026-08-16' })).toBe(
        'due_date < 2026-08-16T00:00:00Z',
      );
    });

    it('leaves an already-RFC3339 literal byte-identical', () => {
      expect(
        conditionToString({ field: 'updated', operator: '>', value: '2026-08-16T09:30:00Z' }),
      ).toBe('updated > 2026-08-16T09:30:00Z');
    });

    it('leaves relative literals alone — Vikunja understands them natively', () => {
      expect(conditionToString({ field: 'dueDate', operator: '<', value: 'now+7d' })).toBe(
        'due_date < now+7d',
      );
      expect(conditionToString({ field: 'doneAt', operator: '!=', value: 'now' })).toBe(
        'done_at != now',
      );
    });

    it('coerces every member of an in-list', () => {
      expect(
        conditionToString({
          field: 'created',
          operator: 'in',
          value: ['2026-08-16 00:00:00', '2026-08-17'],
        }),
      ).toBe('created in 2026-08-16T00:00:00Z, 2026-08-17T00:00:00Z');
    });

    it('does not touch non-date fields that happen to hold date-shaped text', () => {
      expect(conditionToString({ field: 'title', operator: 'like', value: '2026-08-16' })).toBe(
        'title like "2026-08-16"',
      );
    });

    it('does not disturb the percentDone wire rescaling on the same path', () => {
      expect(
        expressionToString({
          groups: [
            {
              conditions: [
                { field: 'percentDone', operator: '>=', value: 50 },
                { field: 'created', operator: '>=', value: '2026-08-16 00:00:00' },
              ],
              operator: '&&',
            },
          ],
        }),
      ).toBe('(percent_done >= 0.5 && created >= 2026-08-16T00:00:00Z)');
    });
  });
});
