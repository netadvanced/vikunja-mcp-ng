/**
 * Tests for the Zod-based filter utilities in src/utils/filters.ts
 *
 * This suite was rewritten against the current architecture. The previous
 * version tested `parseSimpleFilter`/`applyClientSideFilter` and a
 * `SimpleFilter` type, all of which predate the Zod-based grammar and no
 * longer exist. The equivalent "apply a filter to a list of tasks"
 * capability now lives in `applyFilter` under
 * `src/tools/tasks/filtering/evaluators.ts` (see
 * tests/tools/tasks-simple-filters.test.ts) and is exercised together with
 * `parseFilterString` from this module.
 */

import { describe, it, expect } from '@jest/globals';
import {
  validateCondition,
  validateFilterExpression,
  conditionToString,
  groupToString,
  expressionToString,
  conditionToDslString,
  groupToDslString,
  expressionToDslString,
  parseFilterString,
  FilterBuilder,
  SecurityValidator,
  FILTER_FIELD_ALIASES,
} from '../../src/utils/filters';
import { FIELD_TYPES } from '../../src/types/filters';
import type { FilterCondition, FilterExpression, FilterField, FilterGroup } from '../../src/types/index';

describe('Consolidated Filter Utilities', () => {
  describe('validateCondition', () => {
    it('should validate simple valid conditions', () => {
      const condition: FilterCondition = {
        field: 'done',
        operator: '=',
        value: true,
      };

      const errors = validateCondition(condition);
      expect(errors).toHaveLength(0);
    });

    it('should reject invalid field names with a Zod-derived error', () => {
      const condition = {
        field: 'invalidField',
        operator: '=',
        value: true,
      };

      const errors = validateCondition(condition as unknown as FilterCondition);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain('Invalid field name');
    });

    it('should reject invalid operators with a Zod-derived error', () => {
      const condition = {
        field: 'done',
        operator: 'invalid',
        value: true,
      };

      const errors = validateCondition(condition as unknown as FilterCondition);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain('Invalid field name');
    });

    it('should accept string "true"/"false" for boolean fields', () => {
      const condition: FilterCondition = {
        field: 'done',
        operator: '=',
        value: 'true',
      };

      const errors = validateCondition(condition);
      expect(errors).toHaveLength(0);
    });

    it('should reject non-boolean, non "true"/"false" values for the done field', () => {
      const condition: FilterCondition = {
        field: 'done',
        operator: '=',
        value: 'yes',
      };

      const errors = validateCondition(condition);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain('Field "done" requires a boolean value');
    });

    it('should reject non-numeric values for priority field', () => {
      const condition: FilterCondition = {
        field: 'priority',
        operator: '=',
        value: 'high', // string instead of number
      };

      const errors = validateCondition(condition);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain('Field "priority" requires a numeric value');
    });
  });

  describe('validateFilterExpression', () => {
    it('should validate simple expressions', () => {
      const expression: FilterExpression = {
        groups: [
          {
            operator: '&&',
            conditions: [
              {
                field: 'done',
                operator: '=',
                value: true,
              },
            ],
          },
        ],
      };

      const result = validateFilterExpression(expression);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should surface condition validation errors with group/condition context', () => {
      const expression: FilterExpression = {
        groups: [
          {
            operator: '&&',
            conditions: [
              {
                field: 'priority',
                operator: '=',
                value: 'not-a-number' as unknown as number,
              },
            ],
          },
        ],
      };

      const result = validateFilterExpression(expression);
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('Group 1, Condition 1');
      expect(result.errors[0]).toContain('Field "priority" requires a numeric value');
    });

    it('should warn when the number of conditions exceeds the default performance threshold', () => {
      const conditions = Array(11)
        .fill(null)
        .map((_, i) => ({
          field: 'priority' as const,
          operator: '=' as const,
          value: i,
        }));

      const expression: FilterExpression = {
        groups: [
          {
            operator: '&&',
            conditions,
          },
        ],
      };

      const result = validateFilterExpression(expression);
      expect(result.valid).toBe(true);
      expect(result.warnings?.[0]).toContain('Complex filters');
    });

    it('should respect a custom performanceWarningThreshold', () => {
      const conditions = Array(6)
        .fill(null)
        .map((_, i) => ({
          field: 'priority' as const,
          operator: '=' as const,
          value: i,
        }));

      const expression: FilterExpression = {
        groups: [
          {
            operator: '&&',
            conditions,
          },
        ],
      };

      const resultNoWarning = validateFilterExpression(expression, {
        performanceWarningThreshold: 10,
      });
      expect(resultNoWarning.warnings).toBeUndefined();

      const resultWithWarning = validateFilterExpression(expression, {
        performanceWarningThreshold: 5,
      });
      expect(resultWithWarning.warnings?.[0]).toContain('Complex filters');
    });
  });

  describe('conditionToString', () => {
    it('should convert a simple condition to string', () => {
      const condition: FilterCondition = {
        field: 'done',
        operator: '=',
        value: true,
      };

      const result = conditionToString(condition);
      expect(result).toBe('done = true');
    });

    it('should quote string values only for the like operator', () => {
      const likeCondition: FilterCondition = {
        field: 'title',
        operator: 'like',
        value: 'test task',
      };
      expect(conditionToString(likeCondition)).toBe('title like "test task"');

      const eqCondition: FilterCondition = {
        field: 'title',
        operator: '=',
        value: 'test task',
      };
      expect(conditionToString(eqCondition)).toBe('title = test task');
    });

    it('should join array values with commas', () => {
      const condition: FilterCondition = {
        field: 'labels',
        operator: 'in',
        value: ['1', '2'],
      };
      expect(conditionToString(condition)).toBe('labels in 1, 2');
    });

    describe('camelCase to snake_case field-name translation for the server-side filter string', () => {
      // The DSL's camelCase field names must be translated to the API's
      // snake_case Task JSON field names before being sent as the server-side
      // `filter` query param - see FILTER_FIELD_TO_API_FIELD in
      // src/utils/filters.ts and the matching evaluateCondition switch in
      // src/tools/tasks/filtering/evaluators.ts used for client-side evaluation.
      it.each<[FilterCondition['field'], string, FilterCondition['value'], string]>([
        ['percentDone', '>=', 75, 'percent_done >= 75'],
        ['dueDate', '<', 'now', 'due_date < now'],
        ['startDate', '>=', '2024-01-01', 'start_date >= 2024-01-01'],
        ['endDate', '<=', '2024-12-31', 'end_date <= 2024-12-31'],
        ['doneAt', '!=', 'now', 'done_at != now'],
        // 'project' is not just camelCased differently - it renames to the
        // API's project_id field entirely.
        ['project', '=', 4, 'project_id = 4'],
      ])('translates %s to its API field name', (field, operator, value, expected) => {
        const condition: FilterCondition = {
          field,
          operator: operator as FilterCondition['operator'],
          value,
        };
        expect(conditionToString(condition)).toBe(expected);
      });

      it.each<FilterCondition['field']>([
        'done',
        'priority',
        'assignees',
        'labels',
        'created',
        'updated',
        'title',
        'description',
      ])('leaves %s unchanged (already matches the API field name)', (field) => {
        const value = field === 'done' ? true : field === 'assignees' || field === 'labels' ? [1] : 'x';
        const condition: FilterCondition = { field, operator: '=', value };
        expect(conditionToString(condition)).toBe(
          `${field} = ${Array.isArray(value) ? value.join(', ') : String(value)}`,
        );
      });

      it('translates every multi-word field name inside a built expression', () => {
        const expression: FilterExpression = {
          groups: [
            {
              operator: '&&',
              conditions: [
                { field: 'dueDate', operator: '<', value: 'now' },
                { field: 'startDate', operator: '>=', value: '2024-01-01' },
                { field: 'endDate', operator: '<=', value: '2024-12-31' },
                { field: 'doneAt', operator: '!=', value: 'now' },
                { field: 'percentDone', operator: '>=', value: 50 },
                { field: 'project', operator: '=', value: 4 },
              ],
            },
          ],
        };

        const result = expressionToString(expression);
        expect(result).toBe(
          '(due_date < now && start_date >= 2024-01-01 && end_date <= 2024-12-31 && done_at != now && percent_done >= 50 && project_id = 4)',
        );
      });

      it('translates the field name for "in"/"not in" operators too', () => {
        expect(conditionToString({ field: 'project', operator: 'in', value: [1, 2, 3] })).toBe(
          'project_id in 1, 2, 3',
        );
      });
    });
  });

  describe('groupToString', () => {
    it('should render a single-condition group without parentheses', () => {
      const group: FilterGroup = {
        operator: '&&',
        conditions: [
          {
            field: 'done',
            operator: '=',
            value: true,
          },
        ],
      };

      const result = groupToString(group);
      expect(result).toBe('done = true');
    });

    it('should wrap a multi-condition group in parentheses joined by its operator', () => {
      const group: FilterGroup = {
        operator: '||',
        conditions: [
          {
            field: 'done',
            operator: '=',
            value: true,
          },
          {
            field: 'priority',
            operator: '>',
            value: 3,
          },
        ],
      };

      const result = groupToString(group);
      expect(result).toBe('(done = true || priority > 3)');
    });
  });

  describe('expressionToString', () => {
    it('should join groups using the expression operator, defaulting to &&', () => {
      const expression: FilterExpression = {
        groups: [
          {
            operator: '&&',
            conditions: [
              {
                field: 'done',
                operator: '=',
                value: true,
              },
            ],
          },
          {
            operator: '||',
            conditions: [
              {
                field: 'priority',
                operator: '>',
                value: 3,
              },
              {
                field: 'priority',
                operator: '<',
                value: 1,
              },
            ],
          },
        ],
        operator: '||',
      };

      const result = expressionToString(expression);
      expect(result).toBe('done = true || (priority > 3 || priority < 1)');
    });

    it('should default to && when no expression operator is set', () => {
      const expression: FilterExpression = {
        groups: [
          {
            operator: '&&',
            conditions: [{ field: 'done', operator: '=', value: true }],
          },
          {
            operator: '&&',
            conditions: [{ field: 'priority', operator: '>', value: 3 }],
          },
        ],
      };

      expect(expressionToString(expression)).toBe('done = true && priority > 3');
    });
  });

  describe('conditionToDslString / groupToDslString / expressionToDslString', () => {
    // These are the DSL-casing (camelCase) counterparts to
    // conditionToString/groupToString/expressionToString above - they must
    // NEVER apply FILTER_FIELD_TO_API_FIELD's snake_case translation, since
    // their whole purpose (backing `vikunja_filters build`'s output) is to
    // hand back a string in the same casing parseFilterString/`vikunja_tasks
    // list`'s `filter` argument accept as canonical. This is exactly the
    // battle-testing regression this item fixes: `build` used to emit
    // conditionToString's snake_case (due_date), which the validator it had
    // just accepted camelCase input through then rejected right back.
    it.each<[FilterCondition['field'], string, FilterCondition['value'], string]>([
      ['percentDone', '>=', 75, 'percentDone >= 75'],
      ['dueDate', '<', 'now', 'dueDate < now'],
      ['startDate', '>=', '2024-01-01', 'startDate >= 2024-01-01'],
      ['endDate', '<=', '2024-12-31', 'endDate <= 2024-12-31'],
      ['doneAt', '!=', 'now', 'doneAt != now'],
      ['project', '=', 4, 'project = 4'],
    ])('conditionToDslString keeps %s in DSL casing, unlike conditionToString', (field, operator, value, expected) => {
      const condition: FilterCondition = { field, operator: operator as FilterCondition['operator'], value };
      expect(conditionToDslString(condition)).toBe(expected);
      // Sanity check that this genuinely differs from the API-casing sibling
      // for every field where the two casings diverge - otherwise this test
      // wouldn't actually be exercising the bug it targets.
      expect(conditionToDslString(condition)).not.toBe(conditionToString(condition));
    });

    it('groupToDslString wraps a multi-condition group without translating field names', () => {
      const group: FilterGroup = {
        operator: '&&',
        conditions: [
          { field: 'dueDate', operator: '<', value: 'now' },
          { field: 'percentDone', operator: '>=', value: 50 },
        ],
      };
      expect(groupToDslString(group)).toBe('(dueDate < now && percentDone >= 50)');
    });

    it('expressionToDslString translates a full expression while keeping camelCase field names', () => {
      const expression: FilterExpression = {
        groups: [
          {
            operator: '&&',
            conditions: [
              { field: 'dueDate', operator: '<', value: 'now' },
              { field: 'startDate', operator: '>=', value: '2024-01-01' },
              { field: 'endDate', operator: '<=', value: '2024-12-31' },
              { field: 'doneAt', operator: '!=', value: 'now' },
              { field: 'percentDone', operator: '>=', value: 50 },
              { field: 'project', operator: '=', value: 4 },
            ],
          },
        ],
      };

      expect(expressionToDslString(expression)).toBe(
        '(dueDate < now && startDate >= 2024-01-01 && endDate <= 2024-12-31 && doneAt != now && percentDone >= 50 && project = 4)',
      );
      // And the API-casing sibling must still translate, so the two
      // functions are genuinely serving different purposes rather than one
      // having quietly become a no-op alias of the other.
      expect(expressionToString(expression)).toBe(
        '(due_date < now && start_date >= 2024-01-01 && end_date <= 2024-12-31 && done_at != now && percent_done >= 50 && project_id = 4)',
      );
    });
  });

  describe('round-trip: every supported field survives build -> parse in DSL casing', () => {
    // The core regression test for this fix: whatever `expressionToDslString`
    // (and therefore `FilterBuilder.toDslString()` and `vikunja_filters
    // build`'s output) emits for a field must be re-parseable by
    // `parseFilterString` - the exact validator `vikunja_tasks list`'s
    // `filter` argument runs - without the caller having to change casing.
    const sampleValueFor = (field: FilterField): FilterCondition['value'] => {
      switch (FIELD_TYPES[field]) {
        case 'boolean':
          return true;
        case 'number':
          return 3;
        case 'array':
          return ['1', '2'];
        case 'date':
          return 'now';
        case 'string':
        default:
          return 'sample';
      }
    };

    it.each(Object.keys(FIELD_TYPES) as FilterField[])('round-trips the %s field', (field) => {
      const operator = FIELD_TYPES[field] === 'array' ? 'in' : '=';
      const value = sampleValueFor(field);
      const builder = new FilterBuilder().where(field, operator, value);
      const dslString = builder.toDslString();

      // Emitted string uses the canonical camelCase spelling verbatim.
      expect(dslString.startsWith(field)).toBe(true);

      const parseResult = parseFilterString(dslString);
      expect(parseResult.error).toBeUndefined();
      expect(parseResult.expression?.groups[0]?.conditions[0]?.field).toBe(field);

      const validation = validateFilterExpression(parseResult.expression as FilterExpression);
      expect(validation.valid).toBe(true);
    });
  });

  describe('round-trip: parse -> expressionToString (server-boundary re-serialization) -> parse again preserves semantics', () => {
    // The core regression coverage for the filter-verbatim-passthrough fix:
    // FilterValidator.validateAndParseFilter now ALWAYS re-serializes a
    // caller-supplied filter string through expressionToString before it
    // reaches Vikunja's `filter` query param, rather than passing the raw
    // string through unmodified. That re-serialization must (a) still be
    // parseable by parseFilterString - the server's own SQL-like grammar
    // that Vikunja accepts - and (b) preserve the parsed expression's
    // semantics (same fields/operators/values), even though the surface
    // syntax (parens, quoting, array spacing) may differ from the input.
    const sampleValueFor = (field: FilterField): FilterCondition['value'] => {
      switch (FIELD_TYPES[field]) {
        case 'boolean':
          return true;
        case 'number':
          return 3;
        case 'array':
          return ['1', '2'];
        case 'date':
          return 'now';
        case 'string':
        default:
          return 'sample';
      }
    };

    it.each(Object.keys(FIELD_TYPES) as FilterField[])(
      'round-trips a single-condition %s filter through the API-casing serializer',
      (field) => {
        const operator = FIELD_TYPES[field] === 'array' ? 'in' : '=';
        const value = sampleValueFor(field);
        const builder = new FilterBuilder().where(field, operator, value);
        const expression = builder.build();

        const serialized = expressionToString(expression);
        const reparsed = parseFilterString(serialized);

        expect(reparsed.error).toBeUndefined();
        expect(reparsed.expression?.groups[0]?.conditions[0]).toEqual(
          expression.groups[0]?.conditions[0],
        );
      },
    );

    it('round-trips a multi-condition group (adds parens, preserves both conditions)', () => {
      const expression: FilterExpression = {
        groups: [
          {
            conditions: [
              { field: 'priority', operator: '>=', value: 4 },
              { field: 'done', operator: '=', value: false },
            ],
            operator: '&&',
          },
        ],
      };

      const serialized = expressionToString(expression);
      expect(serialized).toBe('(priority >= 4 && done = false)');

      const reparsed = parseFilterString(serialized);
      expect(reparsed.error).toBeUndefined();
      expect(reparsed.expression).toEqual(expression);
    });

    it('round-trips a multi-group expression joined by ||', () => {
      const expression: FilterExpression = {
        groups: [
          {
            conditions: [
              { field: 'priority', operator: '>=', value: 4 },
              { field: 'done', operator: '=', value: false },
            ],
            operator: '&&',
          },
          {
            conditions: [{ field: 'assignees', operator: 'in', value: ['1'] }],
            operator: '&&',
          },
        ],
        operator: '||',
      };

      const serialized = expressionToString(expression);
      const reparsed = parseFilterString(serialized);
      expect(reparsed.error).toBeUndefined();
      expect(reparsed.expression).toEqual(expression);
    });

    it('round-trips an "in" condition with a multi-value array (normalized spacing survives re-parse)', () => {
      const expression: FilterExpression = {
        groups: [
          { conditions: [{ field: 'priority', operator: 'in', value: ['3', '4', '5'] }], operator: '&&' },
        ],
      };

      const serialized = expressionToString(expression);
      expect(serialized).toBe('priority in 3, 4, 5');

      const reparsed = parseFilterString(serialized);
      expect(reparsed.error).toBeUndefined();
      expect(reparsed.expression?.groups[0]?.conditions[0]?.value).toEqual(['3', '4', '5']);
    });

    it('round-trips a `like` value containing an embedded double quote (escaping fix)', () => {
      // Regression test for the conditionToString/conditionToDslString
      // escaping fix: without escaping, `"${value}"` would emit
      // `"she said "hi""`, which parseQuotedString re-parses as ending at
      // the first embedded `"`, truncating the value to `she said `. This
      // is exactly the "exotic quoting" class of case this item's
      // instructions called out - properly escaping the value (rather than
      // falling back to raw passthrough) keeps the fix's "always
      // re-serialize" behavior total, with no narrow verbatim carve-out
      // needed.
      const expression: FilterExpression = {
        groups: [
          { conditions: [{ field: 'title', operator: 'like', value: 'she said "hi"' }], operator: '&&' },
        ],
      };

      const serialized = expressionToString(expression);
      expect(serialized).toBe('title like "she said \\"hi\\""');

      const reparsed = parseFilterString(serialized);
      expect(reparsed.error).toBeUndefined();
      expect(reparsed.expression?.groups[0]?.conditions[0]?.value).toBe('she said "hi"');
    });

    it('round-trips a `like` value containing a literal backslash (escaping fix)', () => {
      const expression: FilterExpression = {
        groups: [
          { conditions: [{ field: 'title', operator: 'like', value: 'C:\\temp' }], operator: '&&' },
        ],
      };

      const serialized = expressionToString(expression);
      const reparsed = parseFilterString(serialized);
      expect(reparsed.error).toBeUndefined();
      expect(reparsed.expression?.groups[0]?.conditions[0]?.value).toBe('C:\\temp');
    });

    it('round-trips a single-quoted `like` value the same as a double-quoted one', () => {
      // parseQuotedString accepts either `"` or `'` as the quote character
      // (see its doc comment) - without that, a caller writing SQL-style
      // single-quoted strings (`title like 'urgent'`) would have the
      // literal quote characters baked into the parsed value, and
      // re-serializing (which always double-quotes) would then produce a
      // corrupted `"'urgent'"` instead of `"urgent"`.
      const single = parseFilterString("title like 'urgent'");
      const double = parseFilterString('title like "urgent"');

      expect(single.error).toBeUndefined();
      expect(single.expression?.groups[0]?.conditions[0]?.value).toBe('urgent');
      expect(single.expression).toEqual(double.expression);

      const serialized = expressionToString(single.expression as FilterExpression);
      expect(serialized).toBe('title like "urgent"');
    });
  });

  describe('parseFilterString', () => {
    it('should reject non-string input', () => {
      const result = parseFilterString(123 as unknown as string);
      expect(result.expression).toBeNull();
      expect(result.error?.message).toBe('Filter input must be a string');
    });

    it('should reject overly long input', () => {
      const longString = 'a'.repeat(1001);
      const result = parseFilterString(longString);
      expect(result.expression).toBeNull();
      expect(result.error?.message).toContain('too long');
    });

    it('should reject empty input', () => {
      const result = parseFilterString('');
      expect(result.expression).toBeNull();
      expect(result.error?.message).toBe('Filter string cannot be empty');
    });

    it('should reject syntactically invalid input', () => {
      const result = parseFilterString('title = test; DROP TABLE users;');
      expect(result.expression).toBeNull();
      expect(result.error).toBeDefined();
    });

    it('should parse valid simple input with no error', () => {
      const result = parseFilterString('done = true');
      expect(result.expression).toEqual({
        groups: [
          {
            conditions: [{ field: 'done', operator: '=', value: true }],
            operator: '&&',
          },
        ],
      });
      expect(result.error).toBeUndefined();
    });

    it('should parse comma-separated values for the in operator', () => {
      const result = parseFilterString('labels in 1, 2');
      expect(result.error).toBeUndefined();
      expect(result.expression?.groups[0]?.conditions[0]).toEqual({
        field: 'labels',
        operator: 'in',
        value: ['1', '2'],
      });
    });

    describe('snake_case field aliases are accepted and normalized to camelCase', () => {
      // The exact friction from battle-testing finding #2: an agent tries
      // the snake_case Task JSON spelling (due_date) before the DSL's
      // camelCase spelling (dueDate) and gets rejected. Accepting the alias
      // and normalizing it removes that failure class entirely rather than
      // just wording the error message better.
      it.each<[string, FilterField, FilterCondition['value']]>([
        ['due_date < now', 'dueDate', 'now'],
        ['percent_done >= 50', 'percentDone', 50],
        ['start_date >= 2024-01-01', 'startDate', '2024-01-01'],
        ['end_date <= 2024-12-31', 'endDate', '2024-12-31'],
        ['done_at != now', 'doneAt', 'now'],
        ['project_id = 4', 'project', 4],
      ])('normalizes %s to the %s field', (filterStr, expectedField, expectedValue) => {
        const result = parseFilterString(filterStr);
        expect(result.error).toBeUndefined();
        expect(result.expression?.groups[0]?.conditions[0]).toEqual({
          field: expectedField,
          operator: filterStr.includes('!=') ? '!=' : filterStr.includes('>=') ? '>=' : filterStr.includes('<=') ? '<=' : filterStr.includes('<') ? '<' : '=',
          value: expectedValue,
        });
      });

      it('accepts a snake_case alias combined with a canonical camelCase field in the same expression', () => {
        const result = parseFilterString('due_date < now && priority >= 3');
        expect(result.error).toBeUndefined();
        expect(result.expression?.groups[0]?.conditions).toEqual([
          { field: 'dueDate', operator: '<', value: 'now' },
          { field: 'priority', operator: '>=', value: 3 },
        ]);
      });

      it('exposes every alias mapping to a canonical FilterField declared in FIELD_TYPES (no dangling aliases)', () => {
        for (const canonical of Object.values(FILTER_FIELD_ALIASES)) {
          expect(Object.keys(FIELD_TYPES)).toContain(canonical);
        }
      });

      it('still rejects a genuinely unrecognized field, with a camelCase-and-alias hint in the error', () => {
        const result = parseFilterString('notARealField = 1');
        expect(result.expression).toBeNull();
        expect(result.error?.message).toContain('Expected condition');
        // Casing-consistency audit: the hint must show canonical camelCase
        // examples (dueDate) and explicitly acknowledge snake_case aliases,
        // never the other way around.
        expect(result.error?.message).toContain('dueDate');
        expect(result.error?.message).toMatch(/snake_case/i);
      });
    });
  });

  describe('SecurityValidator', () => {
    it('should validate allowed characters', () => {
      expect(SecurityValidator.validateAllowedChars('done = true')).toBe(true);
      expect(SecurityValidator.validateAllowedChars('title > "test"')).toBe(true);
    });

    it('should reject strings containing disallowed control characters', () => {
      // \x00 (NUL) falls outside the allowed printable/whitespace range.
      expect(SecurityValidator.validateAllowedChars('done = true\x00')).toBe(false);
    });

    it('should validate filter string length', () => {
      expect(SecurityValidator.validateLength('done = true').isValid).toBe(true);

      const tooLong = SecurityValidator.validateLength('a'.repeat(1001));
      expect(tooLong.isValid).toBe(false);
      expect(tooLong.error).toContain('Maximum length is 1000');
    });

    it('should validate individual value length', () => {
      expect(SecurityValidator.validateValue('short value').isValid).toBe(true);

      const tooLong = SecurityValidator.validateValue('a'.repeat(201));
      expect(tooLong.isValid).toBe(false);
      expect(tooLong.error).toContain('Maximum length is 200');
    });
  });

  describe('FilterBuilder', () => {
    it('should build simple conditions joined by &&', () => {
      const builder = new FilterBuilder();
      const result = builder.where('done', '=', true).where('priority', '>', 3).toString();

      expect(result).toBe('(done = true && priority > 3)');
    });

    it('should apply or() to the current group', () => {
      const builder = new FilterBuilder();
      const result = builder
        .where('done', '=', true)
        .where('priority', '=', 3)
        .or()
        .where('done', '=', false)
        .toString();

      expect(result).toBe('(done = true || priority = 3 || done = false)');
    });

    it('should support multiple groups combined with groupOperator', () => {
      const builder = new FilterBuilder();
      const result = builder
        .where('done', '=', true)
        .group('||')
        .where('priority', '>', 3)
        .where('priority', '<', 1)
        .groupOperator('||')
        .toString();

      expect(result).toBe('done = true || (priority > 3 || priority < 1)');
    });

    it('should build a FilterExpression via build()', () => {
      const builder = new FilterBuilder();
      const result = builder.where('done', '=', true).where('priority', '>', 3).build();

      expect(result.groups).toHaveLength(1);
      expect(result.groups[0]?.conditions).toHaveLength(2);
      expect(result.groups[0]?.conditions[0]?.field).toBe('done');
      expect(result.groups[0]?.conditions[1]?.field).toBe('priority');
    });

    it('should handle an empty builder', () => {
      const builder = new FilterBuilder();
      expect(builder.toString()).toBe('');
      expect(builder.build().groups).toHaveLength(0);
    });

    it('should handle a single condition without an explicit group', () => {
      const builder = new FilterBuilder();
      const result = builder.where('done', '=', false).build();

      expect(result.groups[0]?.conditions).toHaveLength(1);
      expect(result.groups[0]?.conditions[0]?.value).toBe(false);
    });

    it('should validate the built expression', () => {
      const builder = new FilterBuilder();
      const result = builder.where('done', '=', true).validate();

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });
  });
});
