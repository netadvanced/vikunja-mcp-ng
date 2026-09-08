/**
 * Saved filter update against Vikunja's v1 API: fetch, merge, `POST` the whole
 * model back.
 *
 * This is the permanent floor, not a fallback. v1 has no `PATCH` for a saved
 * filter, and `POST /filters/{id}` replaces the resource: probed live, a
 * `POST` carrying only a title answers `412` with `filters: non zero value
 * required`, so the read is not defensive politeness, it is what makes a
 * partial update expressible at all.
 *
 * The sequence is unchanged from before the strategy split, deliberately. It
 * was moved, not rewritten, including the ordering: the current filter is
 * read *before* the caller's filter query is parsed, so an invalid
 * `conditions` array is still rejected after exactly one request, the way it
 * always has been.
 */

import type { AuthManager } from '../../../auth/AuthManager';
import { vikunjaRestRequest } from '../../../utils/vikunja-rest';
import { fetchSavedFilterOrThrow, mapNotFound } from '../saved-filter-api';
import { resolveSavedFilterFields } from './analysis';
import type {
  SavedFilterApi,
  SavedFilterUpdateFields,
  SavedFilterUpdateInput,
  SavedFilterUpdateStrategy,
} from './types';

/**
 * Overlays the caller's fields onto the filter as it exists on the server.
 *
 * Every field not explicitly supplied is carried forward from the read rather
 * than omitted, because omission means "clear it" on a full-replace endpoint.
 * Fields are only assigned when defined (rather than via a bare `?? current.x`)
 * because `exactOptionalPropertyTypes` treats an explicit `undefined`
 * assignment differently from omitting the key entirely.
 */
export function buildSavedFilterUpdatePayload(
  current: SavedFilterApi,
  fields: SavedFilterUpdateFields,
): SavedFilterApi {
  const mergedDescription = fields.description ?? current.description;
  const mergedIsFavorite = fields.isFavorite ?? current.is_favorite;

  return {
    title: fields.title ?? current.title ?? '',
    ...(mergedDescription !== undefined ? { description: mergedDescription } : {}),
    ...(mergedIsFavorite !== undefined ? { is_favorite: mergedIsFavorite } : {}),
    filters: {
      ...current.filters,
      ...(fields.filterQuery !== undefined ? { filter: fields.filterQuery } : {}),
    },
  };
}

export class V1SavedFilterUpdateStrategy implements SavedFilterUpdateStrategy {
  readonly apiVersion = 'v1' as const;

  async execute(input: SavedFilterUpdateInput): Promise<SavedFilterApi> {
    const { authManager, filterId, params } = input;

    const current = await fetchSavedFilterOrThrow(authManager, filterId);
    const payload = buildSavedFilterUpdatePayload(current, resolveSavedFilterFields(params));

    return this.post(authManager, filterId, payload);
  }

  /**
   * The write, with the same NOT_FOUND mapping the read uses so a filter
   * deleted between the two calls reports the way a missing one does instead
   * of surfacing a raw HTTP error.
   */
  private async post(
    authManager: AuthManager,
    filterId: number,
    payload: SavedFilterApi,
  ): Promise<SavedFilterApi> {
    try {
      return await vikunjaRestRequest<SavedFilterApi>(
        authManager,
        'POST',
        `/filters/${filterId}`,
        payload,
      );
    } catch (error) {
      throw mapNotFound(error, filterId);
    }
  }
}
