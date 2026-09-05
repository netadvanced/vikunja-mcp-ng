/**
 * Saved filter update against Vikunja's v2 API: one merge patch carrying only
 * the fields the caller asked to change.
 *
 * v1 has to read the filter, overlay the caller's fields onto the whole model
 * and `POST` it back, because `POST /filters/{id}` replaces the resource. v2
 * replaces both calls with one:
 *
 *   PATCH /api/v2/filters/{filter}   changed fields, returns the updated filter
 *
 * That removes the read-modify-write window in which a concurrent edit gets
 * clobbered by a stale model, and the `PATCH` response is the canonical
 * result, so nothing is re-read afterwards.
 *
 * Probed live on 2.4.0, 2.5.0 and 2.6.0 on 2026-09-05, all three identical, so
 * this operation carries **no `minVersion` floor**:
 *
 * - a title-only patch applies and leaves `description`, `is_favorite` and
 *   every key inside `filters` untouched;
 * - `filters` merges *per key*: `{"filters":{"filter":"..."}}` rewrites the
 *   query and preserves the stored `s`, `sort_by`, `order_by` and
 *   `filter_include_nulls` beside it. That is why the body below sends
 *   `filters` with `filter` alone and does not have to read the current
 *   collection options first;
 * - `is_favorite: false` is applied, not swallowed. Saved filters have none of
 *   the `UseBool` false-is-invisible behaviour documented for projects in
 *   docs/API_NOTES.md, so the merge is not guarding anything here;
 * - an invalid query string is rejected (`400`, Vikunja code 4016) exactly as
 *   v1 rejects it, so routing writes to v2 does not weaken validation.
 *
 * Not done here, on purpose:
 *
 * - No `?format=markdown`. v2 ignores it on `PATCH` (confirmed live: the
 *   response came back as HTML with the parameter set), and the owner decision
 *   of 2026-09-05 is that update responses keep today's format rather than
 *   paying a re-read to make them cosmetically consistent with reads.
 * - No `If-Match`. v2 accepts the header and ignores it.
 */

import type { AuthManager } from '../../../auth/AuthManager';
import { MCPError } from '../../../types';
import { vikunjaRestV2Request } from '../../../utils/vikunja-rest-v2';
import { fetchSavedFilterOrThrow, mapNotFound } from '../saved-filter-api';
import { resolveSavedFilterFields } from './analysis';
import type {
  SavedFilterApi,
  SavedFilterUpdateFields,
  SavedFilterUpdateInput,
  SavedFilterUpdateStrategy,
} from './types';

/**
 * Fields v2 adds to a saved filter that v1 has never returned, and that must
 * not reach a caller: the P3 spec's non-goals put `max_permission` explicitly
 * out of scope for this milestone's tool surface, and leaking it would be a
 * caller-visible tell of which strategy ran. (`$schema`, the only other v2
 * addition, is already removed by the transport's response normalizer.)
 *
 * The live `PATCH` response happens not to carry `max_permission` today while
 * the live v2 `GET` does. Stripping it regardless costs one `delete` and means
 * a future release that starts returning it on `PATCH` cannot change the tool
 * surface behind our backs.
 */
type V2OnlySavedFilterFields = { max_permission?: unknown };

/**
 * Vikunja answers `304 Not Modified`, with no body, when a merge patch would
 * leave the filter exactly as it is, including the trivial case of setting a
 * field to the value it already holds. Confirmed live on all three versions.
 */
const NOT_MODIFIED = 304;

/**
 * Builds the merge-patch body from the resolved fields.
 *
 * A key is present only when the caller asked for that field to change, which
 * is the whole point: anything absent is left alone server-side.
 */
export function buildSavedFilterPatchBody(fields: SavedFilterUpdateFields): SavedFilterApi {
  return {
    ...(fields.title !== undefined ? { title: fields.title } : {}),
    ...(fields.description !== undefined ? { description: fields.description } : {}),
    ...(fields.isFavorite !== undefined ? { is_favorite: fields.isFavorite } : {}),
    ...(fields.filterQuery !== undefined ? { filters: { filter: fields.filterQuery } } : {}),
  };
}

/**
 * Removes v2-only fields so the returned filter is shaped exactly like the one
 * the v1 strategy produces.
 */
function toCanonicalSavedFilter(filter: SavedFilterApi): SavedFilterApi {
  const canonical: SavedFilterApi & V2OnlySavedFilterFields = { ...filter };
  delete canonical.max_permission;
  return canonical;
}

function isNotModified(error: unknown): boolean {
  return error instanceof MCPError && error.details?.statusCode === NOT_MODIFIED;
}

export class V2SavedFilterUpdateStrategy implements SavedFilterUpdateStrategy {
  readonly apiVersion = 'v2' as const;

  async execute(input: SavedFilterUpdateInput): Promise<SavedFilterApi> {
    const { authManager, filterId, params } = input;
    const body = buildSavedFilterPatchBody(resolveSavedFilterFields(params));

    // Two paths end in a read instead, both meaning "the patch changed
    // nothing", and both of which still owe the caller a current filter: an
    // empty body (the caller supplied only an id, or only present-but-empty
    // arguments), which is not worth a request, and a 304, which is what a
    // no-op patch actually answers.
    if (Object.keys(body).length === 0) {
      return fetchSavedFilterOrThrow(authManager, filterId);
    }

    try {
      const patched = await vikunjaRestV2Request<SavedFilterApi>(
        authManager,
        'PATCH',
        `/filters/${filterId}`,
        body,
      );
      return toCanonicalSavedFilter(patched);
    } catch (error) {
      return this.recover(error, authManager, filterId);
    }
  }

  /**
   * A 304 is re-read on v1, the same call `get` makes, so the filter the
   * caller gets back is shaped identically whichever branch produced it.
   * Anything else keeps the read's NOT_FOUND mapping and is otherwise
   * propagated untouched.
   */
  private async recover(
    error: unknown,
    authManager: AuthManager,
    filterId: number,
  ): Promise<SavedFilterApi> {
    if (isNotModified(error)) {
      return fetchSavedFilterOrThrow(authManager, filterId);
    }
    throw mapNotFound(error, filterId);
  }
}
