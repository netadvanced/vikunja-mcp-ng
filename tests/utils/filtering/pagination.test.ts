/**
 * Direct unit tests for the shared pagination helper (issue #268 / CRIT-7,
 * reused for issue #289 / HIGH-18 secondary list reads). Covers the
 * `fetchAllPages` walk and `describePossibleTruncation`'s "at minimum"
 * signal-only variant in isolation from any particular strategy or tool.
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
  createBudget,
  DEFAULT_SERVER_PAGE_CAP,
  describePossibleTruncation,
  fetchAllPages,
  MAX_PAGES,
  readServerPageCap,
} from '../../../src/utils/filtering/pagination';
import type { AuthManager } from '../../../src/auth/AuthManager';

describe('pagination helpers', () => {
  const originalEnv = process.env.VIKUNJA_MAX_TASKS_LIMIT;

  beforeEach(() => {
    delete process.env.VIKUNJA_MAX_TASKS_LIMIT;
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.VIKUNJA_MAX_TASKS_LIMIT;
    } else {
      process.env.VIKUNJA_MAX_TASKS_LIMIT = originalEnv;
    }
  });

  describe('readServerPageCap', () => {
    it('returns undefined when authManager is undefined', () => {
      expect(readServerPageCap(undefined)).toBeUndefined();
    });

    it('returns undefined when getCapabilities is not a function', () => {
      expect(readServerPageCap({} as AuthManager)).toBeUndefined();
    });

    it('returns the cached max_items_per_page when present and positive', () => {
      const authManager = {
        getCapabilities: () => ({ features: { max_items_per_page: 25 } }),
      } as unknown as AuthManager;
      expect(readServerPageCap(authManager)).toBe(25);
    });

    it('ignores a nonsensical (zero/negative/non-number) max_items_per_page', () => {
      const zero = {
        getCapabilities: () => ({ features: { max_items_per_page: 0 } }),
      } as unknown as AuthManager;
      const negative = {
        getCapabilities: () => ({ features: { max_items_per_page: -5 } }),
      } as unknown as AuthManager;
      const nonNumber = {
        getCapabilities: () => ({ features: { max_items_per_page: 'fifty' } }),
      } as unknown as AuthManager;
      expect(readServerPageCap(zero)).toBeUndefined();
      expect(readServerPageCap(negative)).toBeUndefined();
      expect(readServerPageCap(nonNumber)).toBeUndefined();
    });
  });

  describe('fetchAllPages', () => {
    it('fetches exactly the requested page when autoPaginate is false', async () => {
      const calls: number[] = [];
      const requestPage = async (page: number) => {
        calls.push(page);
        return [1, 2, 3];
      };
      const budget = createBudget();

      const result = await fetchAllPages(requestPage, {
        autoPaginate: false,
        firstPage: 3,
        budget,
        cap: DEFAULT_SERVER_PAGE_CAP,
        resourceLabel: 'test',
      });

      expect(calls).toEqual([3]);
      expect(result).toEqual([1, 2, 3]);
      expect(budget.remaining).toBe(createBudget().remaining - 3);
    });

    it('stops immediately on an empty first page', async () => {
      const requestPage = async () => [] as number[];
      const budget = createBudget();

      const result = await fetchAllPages(requestPage, {
        autoPaginate: true,
        firstPage: 1,
        budget,
        cap: DEFAULT_SERVER_PAGE_CAP,
        resourceLabel: 'test',
      });

      expect(result).toEqual([]);
      expect(budget.truncated).toBe(false);
    });

    it('walks multiple pages until a short page ends the collection', async () => {
      const pages: Record<number, number[]> = {
        1: Array.from({ length: 5 }, (_, i) => i),
        2: Array.from({ length: 5 }, (_, i) => 5 + i),
        3: [10, 11],
      };
      const calls: number[] = [];
      const requestPage = async (page: number) => {
        calls.push(page);
        return pages[page] ?? [];
      };
      const budget = createBudget();

      const result = await fetchAllPages(requestPage, {
        autoPaginate: true,
        firstPage: 1,
        budget,
        cap: 5,
        resourceLabel: 'test',
      });

      expect(calls).toEqual([1, 2, 3]);
      expect(result).toHaveLength(12);
      expect(budget.truncated).toBe(false);
      expect(budget.warnings).toEqual([]);
    });

    it('cuts a page short and flags truncation when it exceeds the remaining budget', async () => {
      process.env.VIKUNJA_MAX_TASKS_LIMIT = '3';
      const requestPage = async () => [1, 2, 3, 4, 5];
      const budget = createBudget();

      const result = await fetchAllPages(requestPage, {
        autoPaginate: true,
        firstPage: 1,
        budget,
        cap: 5,
        resourceLabel: 'test-resource',
      });

      expect(result).toEqual([1, 2, 3]);
      expect(budget.remaining).toBe(0);
      expect(budget.truncated).toBe(true);
      expect(budget.warnings).toEqual([
        expect.stringContaining('test-resource: stopped loading at the 3-item limit'),
      ]);
    });

    it('flags truncation via the top-of-loop budget check when a prior page exactly exhausts it', async () => {
      // Budget lands on EXACTLY 0 after page 2 (not mid-page), so the cut
      // happens on page 3's pre-fetch budget check, not the mid-page slice.
      process.env.VIKUNJA_MAX_TASKS_LIMIT = '10';
      const pages: Record<number, number[]> = {
        1: Array.from({ length: 5 }, (_, i) => i),
        2: Array.from({ length: 5 }, (_, i) => 5 + i),
        3: Array.from({ length: 5 }, (_, i) => 10 + i),
      };
      const calls: number[] = [];
      const requestPage = async (page: number) => {
        calls.push(page);
        return pages[page] ?? [];
      };
      const budget = createBudget();

      const result = await fetchAllPages(requestPage, {
        autoPaginate: true,
        firstPage: 1,
        budget,
        cap: 5,
        resourceLabel: 'test-resource',
      });

      // Page 3 is never actually requested — the budget check at the top of
      // the loop stops the walk before issuing it.
      expect(calls).toEqual([1, 2]);
      expect(result).toHaveLength(10);
      expect(budget.truncated).toBe(true);
      expect(budget.warnings).toEqual([
        expect.stringContaining('test-resource: stopped loading at the 10-item limit'),
      ]);
    });

    it('stops at the MAX_PAGES ceiling and flags it when the server never returns a short page', async () => {
      process.env.VIKUNJA_MAX_TASKS_LIMIT = String(MAX_PAGES * 2);
      let calls = 0;
      const requestPage = async () => {
        calls += 1;
        return [1]; // Always exactly the cap (1) — never a "short" page.
      };
      const budget = createBudget();

      const result = await fetchAllPages(requestPage, {
        autoPaginate: true,
        firstPage: 1,
        budget,
        cap: 1,
        resourceLabel: 'never-ending',
      });

      expect(calls).toBe(MAX_PAGES);
      expect(result).toHaveLength(MAX_PAGES);
      expect(budget.truncated).toBe(true);
      expect(budget.warnings).toEqual([
        expect.stringContaining(`never-ending: stopped after ${MAX_PAGES} pages`),
      ]);
    });
  });

  describe('describePossibleTruncation', () => {
    it('returns an empty object when the caller pinned an explicit page', () => {
      expect(
        describePossibleTruncation(100, {
          autoPaginate: false,
          cap: 50,
          resourceLabel: 'x',
        }),
      ).toEqual({});
    });

    it('returns an empty object when the item count is below the cap', () => {
      expect(
        describePossibleTruncation(49, {
          autoPaginate: true,
          cap: 50,
          resourceLabel: 'x',
        }),
      ).toEqual({});
    });

    it('flags possible truncation when auto-paginate is true and the count is at or above the cap', () => {
      const result = describePossibleTruncation(50, {
        autoPaginate: true,
        cap: 50,
        resourceLabel: 'Task 1 labels',
      });

      expect(result.resultComplete).toBe(false);
      expect(result.warnings?.[0]).toContain('Task 1 labels');
      expect(result.warnings?.[0]).toContain('50 items');
    });
  });
});
