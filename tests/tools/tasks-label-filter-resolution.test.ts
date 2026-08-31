/**
 * Regression tests for issue #227 — "label filters return 0 results, reported
 * as success".
 *
 * Two independent defects, both verified against a live Vikunja 2.4.0 before
 * being fixed:
 *
 *  a) SERVER SIDE. Vikunja's `labels` filter field matches on label **ids**
 *     and rejects a title outright:
 *       GET /api/v1/tasks?filter=labels in HU
 *       -> 400 {"code":4019,"message":"The task filter value 'HU' for field 'labels' is invalid."}
 *     The documented DSL spelling uses titles, so every title-based label
 *     filter failed the server-side attempt.
 *
 *  b) CLIENT SIDE. The fallback then evaluated `Number('HU')` -> NaN against
 *     the task's label ids, so it matched nothing either. (The issue
 *     hypothesised that `list` responses return `"labels": null` for tasks
 *     that DO have labels — that is NOT what 2.4.0 does: labels are fully
 *     populated in `GET /projects/{id}/tasks` and `GET /tasks`. The real
 *     cause was the title -> NaN coercion.)
 *
 * The result was `Found 0 tasks` reported as a clean success for a label that
 * demonstrably had tasks — indistinguishable from "nothing matched".
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';

jest.mock('../../src/utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('../../src/utils/vikunja-rest', () => ({
  vikunjaRestRequest: jest.fn(),
}));

import { FilterValidator } from '../../src/tools/tasks/filtering/FilterValidator';
import type { TaskListingArgs, TaskFilterStorage } from '../../src/tools/tasks/types/filters';
import { vikunjaRestRequest } from '../../src/utils/vikunja-rest';
import type { AuthManager } from '../../src/auth/AuthManager';
import { MCPError, ErrorCode } from '../../src/types';
import { applyFilter } from '../../src/tools/tasks/filtering';
import type { components } from '../../src/types/generated/vikunja-openapi';

type Task = components['schemas']['models.Task'];

const storage = { get: jest.fn() } as unknown as TaskFilterStorage;
const authManager = {} as AuthManager;
const restMock = vikunjaRestRequest as jest.Mock;

/** A task carrying the `HU` label exactly as Vikunja 2.4.0 returns it. */
const taskWithHu = {
  id: 255,
  title: 'Tagged task',
  labels: [{ id: 100, title: 'HU' }],
} as Task;

/** Vikunja returns `labels: null` (not `[]`) for a task with no labels. */
const taskWithoutLabels = { id: 256, title: 'Untagged task', labels: null } as unknown as Task;

describe('label filters — title to id resolution (issue #227)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('server-side wire spelling', () => {
    it('resolves a label title to its id so the wire filter is one Vikunja accepts', async () => {
      restMock.mockResolvedValue([{ id: 100, title: 'HU' }]);

      const result = await FilterValidator.validateAndParseFilter(
        { filter: "labels in 'HU'" } as TaskListingArgs,
        storage,
        authManager,
      );

      // The lookup goes through the shared label search helper.
      expect(restMock).toHaveBeenCalledWith(authManager, 'GET', '/labels?s=HU');
      // The wire string carries the ID, never the title — a title is a hard
      // 400 (code 4019) on the server.
      expect(result.filterString).toBe('labels in 100');
      expect(result.filterExpression?.groups[0]?.conditions[0]?.value).toEqual(['100']);
      expect(result.validationWarnings).toEqual([]);
    });

    it('matches the title case-insensitively', async () => {
      restMock.mockResolvedValue([{ id: 100, title: 'HU' }]);

      const result = await FilterValidator.validateAndParseFilter(
        { filter: "labels in 'hu'" } as TaskListingArgs,
        storage,
        authManager,
      );

      expect(result.filterString).toBe('labels in 100');
    });

    it('resolves each distinct title exactly once, however often it appears', async () => {
      restMock.mockResolvedValue([{ id: 100, title: 'HU' }]);

      await FilterValidator.validateAndParseFilter(
        { filter: "labels in 'HU', 'HU'" } as TaskListingArgs,
        storage,
        authManager,
      );

      expect(restMock).toHaveBeenCalledTimes(1);
    });

    it('leaves a numeric label filter alone and issues no lookup at all', async () => {
      const result = await FilterValidator.validateAndParseFilter(
        { filter: 'labels in 100, 101' } as TaskListingArgs,
        storage,
        authManager,
      );

      expect(restMock).not.toHaveBeenCalled();
      expect(result.filterString).toBe('labels in 100, 101');
    });

    it('resolves only the titles in a mixed id/title list, leaving the ids as given', async () => {
      restMock.mockResolvedValue([{ id: 100, title: 'HU' }]);

      const result = await FilterValidator.validateAndParseFilter(
        { filter: "labels in 42, 'HU'" } as TaskListingArgs,
        storage,
        authManager,
      );

      expect(restMock).toHaveBeenCalledTimes(1);
      expect(result.filterString).toBe('labels in 42, 100');
    });

    it('resolves titles inside a `not in` condition too', async () => {
      restMock.mockResolvedValue([{ id: 100, title: 'HU' }]);

      const result = await FilterValidator.validateAndParseFilter(
        { filter: "labels not in 'HU'" } as TaskListingArgs,
        storage,
        authManager,
      );

      expect(result.filterString).toBe('labels not in 100');
    });

    it('leaves non-label conditions untouched while resolving the label one', async () => {
      restMock.mockResolvedValue([{ id: 100, title: 'HU' }]);

      const result = await FilterValidator.validateAndParseFilter(
        { filter: "done = false && labels in 'HU'" } as TaskListingArgs,
        storage,
        authManager,
      );

      expect(result.filterString).toBe('(done = false && labels in 100)');
    });
  });

  describe('a filter that cannot be honoured is never a clean empty result', () => {
    it('throws instead of returning an empty result when no label has that title', async () => {
      restMock.mockResolvedValue([]);

      await expect(
        FilterValidator.validateAndParseFilter(
          { filter: "labels in 'HU'" } as TaskListingArgs,
          storage,
          authManager,
        ),
      ).rejects.toMatchObject({
        code: ErrorCode.VALIDATION_ERROR,
        message: expect.stringContaining("no label exists with the title 'HU'"),
      });
    });

    it('names every unresolvable title when none of them exist', async () => {
      restMock.mockResolvedValue([]);

      await expect(
        FilterValidator.validateAndParseFilter(
          { filter: "labels in 'HU', 'lynx'" } as TaskListingArgs,
          storage,
          authManager,
        ),
      ).rejects.toMatchObject({
        message: expect.stringContaining("'HU', 'lynx'"),
      });
    });

    it('keeps the resolvable half and WARNS about the rest rather than silently narrowing', async () => {
      restMock.mockImplementation((_auth: unknown, _method: string, path: string) =>
        Promise.resolve(path === '/labels?s=HU' ? [{ id: 100, title: 'HU' }] : []),
      );

      const result = await FilterValidator.validateAndParseFilter(
        { filter: "labels in 'HU', 'ghost'" } as TaskListingArgs,
        storage,
        authManager,
      );

      expect(result.filterString).toBe('labels in 100');
      expect(result.validationWarnings).toEqual([
        expect.stringContaining("no label exists with 'ghost'"),
      ]);
    });

    it('reports a FAILED lookup as an error, never as "no such label"', async () => {
      // A scope-limited API token gets 403 on GET /labels. Treating that as
      // "the label does not exist" would turn one silent wrong answer into
      // another.
      restMock.mockRejectedValue(new MCPError(ErrorCode.API_ERROR, 'HTTP 403 Forbidden'));

      await expect(
        FilterValidator.validateAndParseFilter(
          { filter: "labels in 'HU'" } as TaskListingArgs,
          storage,
          authManager,
        ),
      ).rejects.toMatchObject({
        code: ErrorCode.API_ERROR,
        message: expect.stringContaining("Could not resolve label title 'HU'"),
      });
    });

    it('leaves titles unresolved (rather than guessing) when no authManager is available', async () => {
      const result = await FilterValidator.validateAndParseFilter(
        { filter: "labels in 'HU'" } as TaskListingArgs,
        storage,
      );

      expect(restMock).not.toHaveBeenCalled();
      expect(result.filterExpression?.groups[0]?.conditions[0]?.value).toEqual(['HU']);
    });
  });

  describe('client-side evaluation (the fallback path)', () => {
    it('matches a task by label ID', () => {
      const expression = {
        groups: [
          {
            conditions: [{ field: 'labels' as const, operator: 'in' as const, value: ['100'] }],
            operator: '&&' as const,
          },
        ],
      };

      expect(applyFilter([taskWithHu, taskWithoutLabels], expression)).toEqual([taskWithHu]);
    });

    it('matches a task by label TITLE — the spelling that used to become NaN', () => {
      const expression = {
        groups: [
          {
            conditions: [{ field: 'labels' as const, operator: 'in' as const, value: ['HU'] }],
            operator: '&&' as const,
          },
        ],
      };

      expect(applyFilter([taskWithHu, taskWithoutLabels], expression)).toEqual([taskWithHu]);
    });

    it('matches a label title case-insensitively', () => {
      const expression = {
        groups: [
          {
            conditions: [{ field: 'labels' as const, operator: 'in' as const, value: ['hu'] }],
            operator: '&&' as const,
          },
        ],
      };

      expect(applyFilter([taskWithHu], expression)).toEqual([taskWithHu]);
    });

    it('handles `labels: null` (a task with no labels) without matching', () => {
      const expression = {
        groups: [
          {
            conditions: [{ field: 'labels' as const, operator: 'in' as const, value: ['HU'] }],
            operator: '&&' as const,
          },
        ],
      };

      expect(applyFilter([taskWithoutLabels], expression)).toEqual([]);
    });

    it('inverts correctly for `not in`', () => {
      const expression = {
        groups: [
          {
            conditions: [{ field: 'labels' as const, operator: 'not in' as const, value: ['HU'] }],
            operator: '&&' as const,
          },
        ],
      };

      expect(applyFilter([taskWithHu, taskWithoutLabels], expression)).toEqual([taskWithoutLabels]);
    });

    it('does not match on an operator it cannot evaluate', () => {
      const expression = {
        groups: [
          {
            conditions: [{ field: 'labels' as const, operator: '=' as const, value: 'HU' }],
            operator: '&&' as const,
          },
        ],
      };

      expect(applyFilter([taskWithHu], expression)).toEqual([]);
    });

    it('ignores an empty filter value instead of matching everything', () => {
      const expression = {
        groups: [
          {
            conditions: [{ field: 'labels' as const, operator: 'in' as const, value: ['  '] }],
            operator: '&&' as const,
          },
        ],
      };

      expect(applyFilter([taskWithHu], expression)).toEqual([]);
    });
  });
});
