/**
 * Tests for FilterValidator.validateAndParseFilter — folding the `done` flag
 * into the server-side filter.
 *
 * BUG 1: `done` was never sent to Vikunja; it was applied client-side after
 * pagination, so open tasks were scattered unpredictably across raw pages.
 * It is now folded into the filter expression / string so Vikunja applies it
 * server-side, before pagination.
 */

import { describe, it, expect, jest } from '@jest/globals';

jest.mock('../../src/utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { FilterValidator } from '../../src/tools/tasks/filtering/FilterValidator';
import type { TaskListingArgs, TaskFilterStorage } from '../../src/tools/tasks/types/filters';

const storage = { get: jest.fn() } as unknown as TaskFilterStorage;

describe('FilterValidator.validateAndParseFilter — done folding', () => {
  it('folds done=false into the filter when no user filter is given', async () => {
    const result = await FilterValidator.validateAndParseFilter(
      { done: false } as TaskListingArgs,
      storage,
    );

    expect(result.filterString).toBe('done = false');
    expect(result.filterExpression).not.toBeNull();
    expect(result.filterExpression?.groups[0]?.conditions[0]).toEqual({
      field: 'done',
      operator: '=',
      value: false,
    });
  });

  it('folds done=true into the filter', async () => {
    const result = await FilterValidator.validateAndParseFilter(
      { done: true } as TaskListingArgs,
      storage,
    );

    expect(result.filterString).toBe('done = true');
  });

  it('produces no filter when neither done nor filter is given', async () => {
    const result = await FilterValidator.validateAndParseFilter(
      {} as TaskListingArgs,
      storage,
    );

    expect(result.filterString).toBeUndefined();
    expect(result.filterExpression).toBeNull();
  });

  it('leaves a user filter untouched when done is not given', async () => {
    const result = await FilterValidator.validateAndParseFilter(
      { filter: 'priority >= 4' } as TaskListingArgs,
      storage,
    );

    expect(result.filterString).toBe('priority >= 4');
  });

  it('ANDs done onto a single-group user filter', async () => {
    const result = await FilterValidator.validateAndParseFilter(
      { filter: 'priority >= 4', done: false } as TaskListingArgs,
      storage,
    );

    expect(result.filterString).toBe('priority >= 4 && done = false');
  });

  it('parenthesises an OR user filter before ANDing done', async () => {
    const result = await FilterValidator.validateAndParseFilter(
      { filter: 'priority >= 4 || priority = 3', done: false } as TaskListingArgs,
      storage,
    );

    expect(result.filterString).toBe('(priority >= 4 || priority = 3) && done = false');
  });

  // Battle-testing finding #2: an agent reaching for the snake_case Task
  // JSON field spelling (due_date) in vikunja_tasks list's `filter` argument
  // used to fail here with "Invalid filter syntax: Expected condition after
  // logical operator" — this is the exact entry point that error came
  // through. It must now succeed, normalizing to the canonical dueDate
  // field, exactly as if the caller had spelled it correctly the first time.
  it('accepts a snake_case field alias (due_date) in the filter string, normalizing to dueDate', async () => {
    const result = await FilterValidator.validateAndParseFilter(
      { filter: 'priority >= 4 && due_date < now+14d' } as TaskListingArgs,
      storage,
    );

    expect(result.filterString).toBe('priority >= 4 && due_date < now+14d');
    expect(result.filterExpression).not.toBeNull();
    expect(result.filterExpression?.groups[0]?.conditions).toEqual([
      { field: 'priority', operator: '>=', value: 4 },
      { field: 'dueDate', operator: '<', value: 'now+14d' },
    ]);
  });

  it('still surfaces a helpful, casing-consistent error for a genuinely unrecognized field', async () => {
    await expect(
      FilterValidator.validateAndParseFilter(
        { filter: 'notARealField = 1' } as TaskListingArgs,
        storage,
      ),
    ).rejects.toThrow(/Invalid filter syntax:.*Expected condition.*dueDate.*snake_case/is);
  });
});
