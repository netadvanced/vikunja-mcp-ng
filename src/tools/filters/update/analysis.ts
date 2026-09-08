/**
 * The shared field mapping both saved-filter update strategies read from.
 *
 * One function decides which of `filter` / `conditions` actually supplies the
 * new query string, and both the reported `affectedFields` and the request
 * body derive from that single decision. The alternative, each side asking
 * the question again, is precisely the drift that produced LOW-4, where the
 * reporting used an `!== undefined` check while the merge used a truthy one
 * and an empty-string `filter` was reported as a change that never happened.
 */

import type { ConditionInput } from '../query';
import { buildFilterStringFromConditions, translateFilterString } from '../query';
import type {
  SavedFilterUpdateField,
  SavedFilterUpdateFields,
  SavedFilterUpdateParams,
} from './types';

/**
 * The argument that replaces the stored filter query, carrying its own value
 * rather than just naming itself. Keeping the value here is what lets
 * `resolveSavedFilterFields` below run the pipeline without re-deriving (and
 * re-defending against) what the source check already established.
 */
type FilterQueryChange =
  | { readonly source: 'filter'; readonly filter: string }
  | { readonly source: 'conditions'; readonly conditions: ConditionInput[] };

/**
 * Which argument, if any, replaces the stored filter query.
 *
 * `filter` wins over `conditions` when both are supplied. Both checks are
 * truthy rather than `!== undefined`: `filter: ''` and `conditions: []` are
 * present-but-empty and change nothing, and reporting them as changes was the
 * LOW-4 bug.
 */
function resolveFilterQueryChange(params: SavedFilterUpdateParams): FilterQueryChange | undefined {
  if (params.filter) {
    return { source: 'filter', filter: params.filter };
  }
  if (params.conditions && params.conditions.length > 0) {
    return { source: 'conditions', conditions: params.conditions };
  }
  return undefined;
}

/**
 * The keys this update actually touches, in the order the tool has always
 * reported them.
 *
 * Pure and total: it never parses a filter string, so it can be called before
 * the strategy runs without stealing the pipeline's validation error.
 */
export function resolveSavedFilterAffectedFields(
  params: SavedFilterUpdateParams,
): SavedFilterUpdateField[] {
  const affectedFields = (['title', 'description', 'isFavorite'] as const).filter(
    (key) => params[key] !== undefined,
  ) as SavedFilterUpdateField[];

  const change = resolveFilterQueryChange(params);
  if (change !== undefined) {
    affectedFields.push(change.source);
  }
  return affectedFields;
}

/**
 * Maps the caller's arguments onto the fields a strategy writes, running the
 * filter-query pipeline when a new query was supplied.
 *
 * A key is present here only when the caller actually asked for that field to
 * change, which is what lets the v2 strategy send a minimal merge patch and
 * the v1 strategy know what to overlay onto the model it read.
 *
 * @throws {MCPError} VALIDATION_ERROR when the supplied filter or conditions
 *         fail to parse or validate
 */
export function resolveSavedFilterFields(params: SavedFilterUpdateParams): SavedFilterUpdateFields {
  const change = resolveFilterQueryChange(params);
  const filterQuery =
    change === undefined
      ? undefined
      : change.source === 'filter'
        ? translateFilterString(change.filter)
        : buildFilterStringFromConditions(change.conditions, params.groupOperator);

  return {
    ...(params.title !== undefined ? { title: params.title } : {}),
    ...(params.description !== undefined ? { description: params.description } : {}),
    ...(params.isFavorite !== undefined ? { isFavorite: params.isFavorite } : {}),
    ...(filterQuery !== undefined ? { filterQuery } : {}),
  };
}
