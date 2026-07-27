/**
 * Client-side filter evaluation coverage.
 *
 * These are the pure predicates behind client-side (and hybrid-fallback)
 * filtering — the path that decides which tasks a user actually sees when the
 * server cannot answer a filter itself. Every operator/field pair is exercised
 * here, including the Vikunja-specific unset-date sentinel ('0001-01-01…')
 * and the null-due-date rule that only `!=` matches.
 */

import type { components } from '../../../../src/types/generated/vikunja-openapi';
import type { FilterCondition, FilterExpression, FilterGroup } from '../../../../src/types/filters';
import {
  applyFilter,
  evaluateArrayComparison,
  evaluateComparison,
  evaluateCondition,
  evaluateDateComparison,
  evaluateGroup,
  evaluateStringComparison,
  parseRelativeDate,
} from '../../../../src/tools/tasks/filtering/evaluators';

type Task = components['schemas']['models.Task'];

const task = (overrides: Partial<Task> = {}): Task =>
  ({
    id: 1,
    title: 'Write the report',
    description: 'Quarterly numbers',
    done: false,
    priority: 3,
    percent_done: 25,
    project_id: 7,
    ...overrides,
  }) as Task;

const condition = (field: string, operator: string, value: unknown): FilterCondition =>
  ({ field, operator, value }) as unknown as FilterCondition;

describe('evaluateComparison', () => {
  it.each([
    ['=', 5, 5, true],
    ['=', 5, 6, false],
    ['!=', 5, 6, true],
    ['!=', 5, 5, false],
    ['>', 6, 5, true],
    ['>', 5, 5, false],
    ['>=', 5, 5, true],
    ['>=', 4, 5, false],
    ['<', 4, 5, true],
    ['<', 5, 5, false],
    ['<=', 5, 5, true],
    ['<=', 6, 5, false],
  ])('%s compares %p against %p → %p', (operator, actual, expected, result) => {
    expect(evaluateComparison(actual, operator, expected)).toBe(result);
  });

  it('returns false for an unknown operator instead of throwing', () => {
    expect(evaluateComparison(5, 'like', 5)).toBe(false);
  });

  it('compares numerically for ordering operators even when given strings', () => {
    expect(evaluateComparison('10', '>', '9')).toBe(true);
  });

  it('uses strict equality — a numeric string does not equal its number', () => {
    expect(evaluateComparison('5', '=', 5)).toBe(false);
  });
});

describe('evaluateStringComparison', () => {
  it('matches exact equality', () => {
    expect(evaluateStringComparison('report', '=', 'report')).toBe(true);
    expect(evaluateStringComparison('report', '=', 'Report')).toBe(false);
  });

  it('matches inequality', () => {
    expect(evaluateStringComparison('report', '!=', 'summary')).toBe(true);
    expect(evaluateStringComparison('report', '!=', 'report')).toBe(false);
  });

  it('treats `like` as a case-insensitive substring match', () => {
    expect(evaluateStringComparison('Write the REPORT', 'like', 'report')).toBe(true);
    expect(evaluateStringComparison('Write the report', 'like', 'invoice')).toBe(false);
  });

  it('returns false for unsupported operators', () => {
    expect(evaluateStringComparison('report', '>', 'a')).toBe(false);
  });
});

describe('evaluateArrayComparison', () => {
  it('`in` matches when any expected id is present', () => {
    expect(evaluateArrayComparison([1, 2, 3], 'in', [3, 9])).toBe(true);
    expect(evaluateArrayComparison([1, 2, 3], 'in', [9])).toBe(false);
  });

  it('`not in` matches only when no expected id is present', () => {
    expect(evaluateArrayComparison([1, 2, 3], 'not in', [9])).toBe(true);
    expect(evaluateArrayComparison([1, 2, 3], 'not in', [3, 9])).toBe(false);
  });

  it('returns false for unsupported operators', () => {
    expect(evaluateArrayComparison([1], '=', [1])).toBe(false);
  });

  it('`not in` is vacuously true against an empty task list', () => {
    expect(evaluateArrayComparison([], 'not in', [1])).toBe(true);
  });
});

describe('parseRelativeDate', () => {
  it('parses an ISO date', () => {
    expect(parseRelativeDate('2026-03-04')?.toISOString()).toBe('2026-03-04T00:00:00.000Z');
  });

  it('parses an ISO datetime', () => {
    expect(parseRelativeDate('2026-03-04T10:30:00Z')?.toISOString()).toBe('2026-03-04T10:30:00.000Z');
  });

  it('parses bare `now`', () => {
    const before = Date.now();
    const parsed = parseRelativeDate('now');
    expect(parsed).toBeInstanceOf(Date);
    expect(parsed!.getTime()).toBeGreaterThanOrEqual(before);
  });

  it.each([
    ['now+30s', 30 * 1000],
    ['now+15m', 15 * 60 * 1000],
    ['now+2h', 2 * 60 * 60 * 1000],
    ['now+3d', 3 * 24 * 60 * 60 * 1000],
    ['now+1w', 7 * 24 * 60 * 60 * 1000],
  ])('applies the %s offset', (input, expectedDeltaMs) => {
    const base = Date.now();
    const parsed = parseRelativeDate(input);
    expect(parsed).not.toBeNull();
    // Generous tolerance: the implementation reads the clock itself.
    expect(Math.abs(parsed!.getTime() - (base + expectedDeltaMs))).toBeLessThan(5000);
  });

  it('applies calendar-aware month offsets', () => {
    const parsed = parseRelativeDate('now+1M');
    const expected = new Date();
    expected.setMonth(expected.getMonth() + 1);
    expect(parsed!.getMonth()).toBe(expected.getMonth());
  });

  it('applies calendar-aware year offsets', () => {
    const parsed = parseRelativeDate('now+1y');
    expect(parsed!.getFullYear()).toBe(new Date().getFullYear() + 1);
  });

  it('defaults a unit-less offset to days', () => {
    const withUnit = parseRelativeDate('now+2d')!;
    const withoutUnit = parseRelativeDate('now+2')!;
    expect(Math.abs(withUnit.getTime() - withoutUnit.getTime())).toBeLessThan(5000);
  });

  it('supports negative offsets', () => {
    const parsed = parseRelativeDate('now-1d')!;
    expect(parsed.getTime()).toBeLessThan(Date.now());
  });

  it('returns null for unparseable input', () => {
    expect(parseRelativeDate('tomorrow')).toBeNull();
    expect(parseRelativeDate('')).toBeNull();
    expect(parseRelativeDate('now++1d')).toBeNull();
  });
});

describe('evaluateDateComparison', () => {
  const actual = '2026-03-04T12:00:00Z';

  // `=`/`!=` compare via Date#toDateString(), i.e. the *local* calendar day of
  // each instant. Same-day fixtures below are derived from one local midday so
  // they hold in any runner timezone.
  const localMidday = new Date(2026, 2, 4, 12, 0, 0).toISOString();
  const localSameDayEvening = new Date(2026, 2, 4, 20, 0, 0).toISOString();

  it('compares only the date part for equality — differing times on one local day match', () => {
    expect(evaluateDateComparison(localMidday, '=', localSameDayEvening)).toBe(true);
    expect(evaluateDateComparison(localMidday, '=', '2026-03-10')).toBe(false);
  });

  it('compares only the date part for inequality', () => {
    expect(evaluateDateComparison(localMidday, '!=', '2026-03-10')).toBe(true);
    expect(evaluateDateComparison(localMidday, '!=', localSameDayEvening)).toBe(false);
  });

  it.each([
    ['>', '2026-03-03', true],
    ['>', '2026-03-05', false],
    ['>=', '2026-03-04T12:00:00Z', true],
    ['<', '2026-03-05', true],
    ['<', '2026-03-03', false],
    ['<=', '2026-03-04T12:00:00Z', true],
  ])('orders with %s against %s → %p', (operator, expected, result) => {
    expect(evaluateDateComparison(actual, operator, expected)).toBe(result);
  });

  it('returns false when the expected value cannot be parsed', () => {
    expect(evaluateDateComparison(actual, '=', 'whenever')).toBe(false);
  });

  it('returns false for unsupported operators', () => {
    expect(evaluateDateComparison(actual, 'like', '2026-03-04')).toBe(false);
  });

  it('accepts a relative expected date', () => {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    expect(evaluateDateComparison(yesterday, '<', 'now')).toBe(true);
  });
});

describe('evaluateCondition', () => {
  it('evaluates `done`, coercing the string "true"', () => {
    expect(evaluateCondition(task({ done: true }), condition('done', '=', true))).toBe(true);
    expect(evaluateCondition(task({ done: true }), condition('done', '=', 'true'))).toBe(true);
    expect(evaluateCondition(task({ done: true }), condition('done', '=', 'false'))).toBe(false);
    expect(evaluateCondition(task({ done: false }), condition('done', '!=', true))).toBe(true);
  });

  it('evaluates `priority`, defaulting a missing priority to 0', () => {
    expect(evaluateCondition(task({ priority: 5 }), condition('priority', '>=', 4))).toBe(true);
    expect(evaluateCondition(task({ priority: undefined }), condition('priority', '=', 0))).toBe(true);
  });

  it('evaluates `percentDone`, defaulting a missing value to 0', () => {
    expect(evaluateCondition(task({ percent_done: 50 }), condition('percentDone', '>', 25))).toBe(true);
    expect(evaluateCondition(task({ percent_done: undefined }), condition('percentDone', '=', 0))).toBe(true);
  });

  it('evaluates `project`, defaulting a missing project to 0', () => {
    expect(evaluateCondition(task({ project_id: 7 }), condition('project', '=', 7))).toBe(true);
    expect(evaluateCondition(task({ project_id: undefined }), condition('project', '=', 0))).toBe(true);
  });

  it('evaluates `title` and `description` as strings', () => {
    expect(evaluateCondition(task(), condition('title', 'like', 'REPORT'))).toBe(true);
    expect(evaluateCondition(task({ title: undefined }), condition('title', '=', ''))).toBe(true);
    expect(evaluateCondition(task(), condition('description', 'like', 'numbers'))).toBe(true);
    expect(evaluateCondition(task({ description: undefined }), condition('description', '=', ''))).toBe(true);
  });

  describe('due dates', () => {
    it('matches a set due date by comparison', () => {
      const t = task({ due_date: '2026-03-04T12:00:00Z' });
      expect(evaluateCondition(t, condition('dueDate', '<', '2026-03-05'))).toBe(true);
    });

    it('matches a null due date only with !=', () => {
      const t = task({ due_date: undefined });
      expect(evaluateCondition(t, condition('dueDate', '!=', '2026-03-04'))).toBe(true);
      expect(evaluateCondition(t, condition('dueDate', '=', '2026-03-04'))).toBe(false);
      expect(evaluateCondition(t, condition('dueDate', '<', '2026-03-04'))).toBe(false);
    });
  });

  describe.each(['startDate', 'endDate', 'doneAt'] as const)('%s unset sentinel', (field) => {
    const apiField = { startDate: 'start_date', endDate: 'end_date', doneAt: 'done_at' }[field];

    it("treats Vikunja's '0001-01-01' zero-date as unset (only != matches)", () => {
      const t = task({ [apiField]: '0001-01-01T00:00:00Z' } as Partial<Task>);
      expect(evaluateCondition(t, condition(field, '!=', '2026-03-04'))).toBe(true);
      expect(evaluateCondition(t, condition(field, '=', '2026-03-04'))).toBe(false);
    });

    it('treats a missing value as unset (only != matches)', () => {
      const t = task({ [apiField]: undefined } as Partial<Task>);
      expect(evaluateCondition(t, condition(field, '!=', '2026-03-04'))).toBe(true);
      expect(evaluateCondition(t, condition(field, '>', '2026-03-04'))).toBe(false);
    });

    it('compares a real value normally', () => {
      const t = task({ [apiField]: '2026-03-04T12:00:00Z' } as Partial<Task>);
      expect(evaluateCondition(t, condition(field, '>', '2026-03-01'))).toBe(true);
    });
  });

  describe.each(['created', 'updated'] as const)('%s timestamps', (field) => {
    it('compares when present', () => {
      const t = task({ [field]: '2026-03-04T12:00:00Z' } as Partial<Task>);
      expect(evaluateCondition(t, condition(field, '>', '2026-03-01'))).toBe(true);
    });

    it('never matches when absent — not even with !=', () => {
      const t = task({ [field]: undefined } as Partial<Task>);
      expect(evaluateCondition(t, condition(field, '!=', '2026-03-01'))).toBe(false);
    });
  });

  describe.each(['assignees', 'labels'] as const)('%s membership', (field) => {
    const withIds = (ids: number[]) =>
      task({ [field]: ids.map((id) => ({ id })) } as unknown as Partial<Task>);

    it('matches against an array of expected ids', () => {
      expect(evaluateCondition(withIds([1, 2]), condition(field, 'in', [2, 3]))).toBe(true);
      expect(evaluateCondition(withIds([1, 2]), condition(field, 'not in', [3]))).toBe(true);
    });

    it('wraps a scalar expected value into an array', () => {
      expect(evaluateCondition(withIds([1, 2]), condition(field, 'in', 2))).toBe(true);
      expect(evaluateCondition(withIds([1, 2]), condition(field, 'in', 9))).toBe(false);
    });

    it('treats a missing collection as empty', () => {
      const t = task({ [field]: undefined } as Partial<Task>);
      expect(evaluateCondition(t, condition(field, 'in', [1]))).toBe(false);
      expect(evaluateCondition(t, condition(field, 'not in', [1]))).toBe(true);
    });

    it('skips entries with no id rather than matching NaN', () => {
      const t = task({ [field]: [{ id: undefined }, { id: 4 }] } as unknown as Partial<Task>);
      expect(evaluateCondition(t, condition(field, 'in', [4]))).toBe(true);
      expect(evaluateCondition(t, condition(field, 'in', [1]))).toBe(false);
    });
  });

  it('returns false for an unknown field instead of throwing', () => {
    expect(evaluateCondition(task(), condition('nonexistent', '=', 'x'))).toBe(false);
  });
});

describe('evaluateGroup', () => {
  const group = (operator: '&&' | '||', conditions: FilterCondition[]): FilterGroup =>
    ({ operator, conditions }) as unknown as FilterGroup;

  it('requires every condition for &&', () => {
    const t = task({ done: false, priority: 5 });
    expect(
      evaluateGroup(t, group('&&', [condition('done', '=', false), condition('priority', '>=', 4)])),
    ).toBe(true);
    expect(
      evaluateGroup(t, group('&&', [condition('done', '=', true), condition('priority', '>=', 4)])),
    ).toBe(false);
  });

  it('requires any condition for ||', () => {
    const t = task({ done: false, priority: 1 });
    expect(
      evaluateGroup(t, group('||', [condition('done', '=', true), condition('priority', '=', 1)])),
    ).toBe(true);
    expect(
      evaluateGroup(t, group('||', [condition('done', '=', true), condition('priority', '=', 5)])),
    ).toBe(false);
  });
});

describe('applyFilter', () => {
  const tasks = [
    task({ id: 1, title: 'Alpha', done: false, priority: 5 }),
    task({ id: 2, title: 'Beta', done: true, priority: 5 }),
    task({ id: 3, title: 'Gamma', done: false, priority: 1 }),
  ];

  const expression = (
    operator: '&&' | '||' | undefined,
    groups: Array<[('&&' | '||'), FilterCondition[]]>,
  ): FilterExpression =>
    ({
      ...(operator ? { operator } : {}),
      groups: groups.map(([groupOperator, conditions]) => ({ operator: groupOperator, conditions })),
    }) as unknown as FilterExpression;

  it('ANDs groups together by default', () => {
    const result = applyFilter(
      tasks,
      expression(undefined, [
        ['&&', [condition('done', '=', false)]],
        ['&&', [condition('priority', '>=', 5)]],
      ]),
    );
    expect(result.map((t) => t.id)).toEqual([1]);
  });

  it('ORs groups when the expression operator says so', () => {
    const result = applyFilter(
      tasks,
      expression('||', [
        ['&&', [condition('priority', '=', 1)]],
        ['&&', [condition('done', '=', true)]],
      ]),
    );
    expect(result.map((t) => t.id)).toEqual([2, 3]);
  });

  it('returns every task for an expression with no groups', () => {
    expect(applyFilter(tasks, expression('&&', []))).toHaveLength(3);
  });

  it('returns an empty list when nothing matches', () => {
    expect(applyFilter(tasks, expression('&&', [['&&', [condition('priority', '>', 9)]]]))).toEqual([]);
  });
});
