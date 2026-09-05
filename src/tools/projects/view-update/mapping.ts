/**
 * The single field mapping both project-view update strategies feed from.
 *
 * `buildViewFieldPatch` turns the caller's flat, camelCase deltas into the
 * snake_case wire object Vikunja's `models.ProjectView` expects. The v2
 * strategy sends exactly that object as a merge patch; the v1 strategy lays it
 * over the fetched view (`buildViewUpdatePayload`) before its full-model
 * `POST`. One mapping, two consumers, so the two paths cannot drift apart in
 * how they name or translate a field.
 */

import { MCPError, ErrorCode } from '../../../types';
import {
  parseFilterString,
  validateFilterExpression,
  expressionToString,
} from '../../../utils/filters';
import type {
  VikunjaProjectView,
  VikunjaTaskCollection,
  VikunjaBucketConfiguration,
  ViewBucketConfigurationInput,
  ViewFieldUpdates,
} from './types';

/**
 * Parses, validates, and translates a caller-supplied DSL filter string into
 * the snake_case form Vikunja's API expects — the SAME pipeline
 * `vikunja_filters` and `vikunja_tasks list` route through
 * (`parseFilterString` -> `validateFilterExpression` -> `expressionToString`,
 * see src/utils/filters.ts). Without the last step a DSL field name
 * (`dueDate`) is sent verbatim and Vikunja rejects it, since the real field
 * is `due_date`.
 *
 * @throws {MCPError} VALIDATION_ERROR when the filter fails to parse/validate.
 */
export function translateViewFilter(filterStr: string, label: string): string {
  const parseResult = parseFilterString(filterStr);
  if (!parseResult.expression) {
    throw new MCPError(
      ErrorCode.VALIDATION_ERROR,
      `Invalid ${label}: ${parseResult.error?.message || 'Invalid filter syntax'}`,
    );
  }
  const validation = validateFilterExpression(parseResult.expression);
  if (!validation.valid) {
    throw new MCPError(
      ErrorCode.VALIDATION_ERROR,
      `Invalid ${label}: ${validation.errors.join('; ')}`,
    );
  }
  return expressionToString(parseResult.expression);
}

/**
 * Builds the nested `filter` object Vikunja's ProjectView model expects.
 *
 * The wire shape is NOT a bare string: `models.ProjectView.filter` is a
 * `models.TaskCollection` (`{ filter: "<query>" }`) — verified against the
 * vendored spec and against `ProjectView.Filter *TaskCollection` in
 * go-vikunja's `pkg/models/project_view.go`. The existing collection (sort_by,
 * order_by, s, ...) is preserved when one is already set on the view, so
 * changing the query on an update doesn't wipe the rest of the collection.
 *
 * `current` is supplied by the v1 strategy, which has the fetched view in
 * hand. The v2 strategy passes nothing and still keeps the rest of the
 * collection, because a JSON merge patch recurses into nested objects and only
 * touches the keys it names: patching `{"filter":{"filter":"done = true"}}`
 * onto a view left `s`, `sort_by`, `order_by` and `filter_include_nulls`
 * intact on 2.4.0, 2.5.0 and 2.6.0 (verified live 2026-09-05). Same end state,
 * merged in a different place.
 */
export function buildViewFilter(
  filterStr: string,
  current?: VikunjaTaskCollection,
): VikunjaTaskCollection {
  return { ...(current ?? {}), filter: translateViewFilter(filterStr, 'filter') };
}

/** Maps the caller's flat bucket-configuration entries onto the wire shape. */
export function buildBucketConfiguration(
  entries: ViewBucketConfigurationInput[],
): VikunjaBucketConfiguration[] {
  return entries.map((entry, index) => {
    if (typeof entry?.title !== 'string' || entry.title.trim() === '') {
      throw new MCPError(
        ErrorCode.VALIDATION_ERROR,
        `bucketConfiguration[${index}].title is required and must be a non-empty string`,
      );
    }
    const mapped: VikunjaBucketConfiguration = { title: entry.title.trim() };
    if (entry.filter !== undefined) {
      mapped.filter = {
        filter: translateViewFilter(entry.filter, `bucketConfiguration[${index}].filter`),
      };
    }
    return mapped;
  });
}

/**
 * Translates the caller's deltas into a partial `models.ProjectView`.
 *
 * Only the fields the caller actually named appear in the result, which is
 * what makes it usable as a merge-patch body on its own. `position: 0` is a
 * real value and reaches the wire on both paths: the checks are on
 * `undefined`, and RFC 7386 only treats `null` as a deletion.
 */
export function buildViewFieldPatch(
  updates: ViewFieldUpdates,
  currentFilter?: VikunjaTaskCollection,
): Partial<VikunjaProjectView> {
  return {
    ...(updates.title !== undefined && { title: updates.title.trim() }),
    ...(updates.viewKind !== undefined && { view_kind: updates.viewKind }),
    ...(updates.bucketConfigurationMode !== undefined && {
      bucket_configuration_mode: updates.bucketConfigurationMode,
    }),
    ...(updates.bucketConfiguration !== undefined && {
      bucket_configuration: buildBucketConfiguration(updates.bucketConfiguration),
    }),
    ...(updates.position !== undefined && { position: updates.position }),
    ...(updates.filter !== undefined && {
      filter: buildViewFilter(updates.filter, currentFilter),
    }),
    ...(updates.doneBucketId !== undefined && { done_bucket_id: updates.doneBucketId }),
    ...(updates.defaultBucketId !== undefined && { default_bucket_id: updates.defaultBucketId }),
  };
}

/**
 * Builds a project view update payload by merging the current view with
 * requested field changes, so fields the caller didn't mention survive the
 * full-model-replace `POST /projects/{project}/views/{id}` round trip.
 *
 * v1 only. `position` and `filter` are in the v1 handler's explicit
 * `Cols(...)` list (go-vikunja pkg/models/project_view.go `ProjectView.Update`)
 * and are therefore written even when zero or empty, so merging the fetched
 * view forward is what keeps an untouched position from being reset to 0.
 * v2's `PATCH` performs that merge server-side and needs no fetch.
 */
export function buildViewUpdatePayload(
  currentView: VikunjaProjectView,
  updates: ViewFieldUpdates,
): VikunjaProjectView {
  return {
    ...currentView,
    ...buildViewFieldPatch(updates, currentView.filter),
  };
}
