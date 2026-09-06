/**
 * The saved-filter tool's filter-query pipeline: parse, validate, translate.
 *
 * Extracted from `../filters.ts` unchanged so that `create` (which still lives
 * in that module) and the `update` strategy pair in `./update` share one
 * implementation instead of two copies that can drift. Nothing about the
 * pipeline itself changed.
 *
 * This stage is version-independent on purpose. Both v1 and v2 store the
 * filter query as an opaque string and both parse it with the same server-side
 * code: probed live on 2.4.0, 2.5.0 and 2.6.0, `PATCH /api/v2/filters/{id}`
 * with `filters.filter = "bogusfield ~~ 3"` answers `400` with Vikunja error
 * code 4016 ("The task field 'bogusfield' is invalid"), the same rejection v1
 * gives, and a valid string is stored byte-for-byte identically by both.
 *
 * The `s` -> `q` search-parameter rename that v2 applies to task *listing*
 * routes does not reach in here either. A saved filter's own query lives in
 * `filters.s` inside the request body, and v2's `TaskCollection` schema still
 * names that field `s` (checked in docs/vikunja-openapi-v2.json and confirmed
 * live: a filter created with `filters.s = "needle"` reads back as `s` through
 * v2 and survives a v2 `PATCH` untouched). The rename is a query-string
 * concern, not a stored-body one.
 */

import {
  FilterBuilder,
  validateFilterExpression,
  parseFilterString,
  expressionToString,
} from '../../utils/filters';
import type { FilterField, FilterOperator } from '../../types/filters';
import { createValidationError } from '../../utils/error-handler';

export type ConditionInput = {
  field: FilterField;
  operator: FilterOperator;
  value: string | number | boolean | (string | number)[];
};

/**
 * Parses, validates, and translates a caller-supplied DSL filter string into
 * the snake_case query string Vikunja's API expects.
 *
 * This is the "existing validated pipeline" the filters tool must route
 * through: `parseFilterString` (secure Zod-backed parser - accepts both
 * canonical camelCase field names and their snake_case aliases, see
 * `FILTER_FIELD_ALIASES`), `validateFilterExpression` (field/operator/value
 * semantics), and `expressionToString` (applies `FILTER_FIELD_TO_API_FIELD`,
 * e.g. `dueDate` -> `due_date`) — see src/utils/filters.ts. Without the
 * last step, a DSL field name sent verbatim is not a Task field Vikunja
 * recognizes.
 *
 * @throws {MCPError} VALIDATION_ERROR when the filter fails to parse/validate
 */
export function translateFilterString(filterStr: string): string {
  const parseResult = parseFilterString(filterStr);
  if (!parseResult.expression) {
    throw createValidationError(
      `Invalid filter: ${parseResult.error?.message || 'Invalid filter syntax'}`,
    );
  }
  const validation = validateFilterExpression(parseResult.expression);
  if (!validation.valid) {
    throw createValidationError(`Invalid filter: ${validation.errors.join('; ')}`);
  }
  return expressionToString(parseResult.expression);
}

/**
 * Builds, validates, and translates a filter query string from structured
 * `conditions` (the same pipeline as `translateFilterString`, entered via
 * `FilterBuilder` instead of the string parser).
 *
 * @throws {MCPError} VALIDATION_ERROR when the built expression fails
 *         semantic validation (e.g. an operator incompatible with a field)
 */
export function buildFilterStringFromConditions(
  conditions: ConditionInput[],
  groupOperator?: '&&' | '||',
): string {
  const builder = new FilterBuilder();
  conditions.forEach((condition, index) => {
    if (index > 0 && groupOperator === '||') {
      builder.or();
    }
    builder.where(condition.field, condition.operator, condition.value);
  });
  const expression = builder.build();
  const validation = validateFilterExpression(expression);
  if (!validation.valid) {
    throw createValidationError(`Invalid filter: ${validation.errors.join('; ')}`);
  }
  return expressionToString(expression);
}
