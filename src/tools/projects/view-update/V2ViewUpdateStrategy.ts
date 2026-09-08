/**
 * Project view update against Vikunja's v2 API: one merge patch, no read.
 *
 *   PATCH /api/v2/projects/{project}/views/{view}
 *
 * The v1 sequence exists entirely because of the `Cols(...)` allowlist
 * described in ../view-update/V1ViewUpdateStrategy: a partial body there wipes
 * the fields it omits, so the client has to fetch the view and send the whole
 * model back. v2 does that merge on the server, which removes the read, the
 * full-model body, and the read-modify-write race between two concurrent
 * updates.
 *
 * Probed live on 2.4.0, 2.5.0 and 2.6.0 (2026-09-05), all three identical:
 *
 *   - `PATCH {"title":"Renamed"}` on a view with `position: 4242` and a filter
 *     returned 200 with position and filter intact, and a v1 re-read agreed.
 *   - `PATCH {"filter":{"filter":"done = true"}}` changed only the query and
 *     left `s`, `sort_by`, `order_by` and `filter_include_nulls` alone, since
 *     a merge patch recurses into nested objects.
 *   - `PATCH {"done_bucket_id":<other bucket>}` applied and left
 *     `default_bucket_id` untouched.
 *   - A patch that would change nothing answered `304` with no body.
 *
 * So there is no `minVersion` floor here: nothing about this route is broken
 * on the 2.4.0 support floor, unlike task update. See ./ViewUpdateContext.
 *
 * Kanban buckets are a different story and stay on v1 permanently: v2
 * registers `GET`/`POST` on `/projects/{project}/views/{view}/buckets` and
 * `PUT`/`DELETE` on a single bucket, and no `PATCH` anywhere. Nothing in this
 * module touches a bucket route — `done_bucket_id` and `default_bucket_id` are
 * fields of the *view*, which is why `set-done-bucket` belongs here at all
 * (docs/API_NOTES.md, "Setting the Done Bucket").
 *
 * Not done here, on purpose:
 *
 * - No `?format=markdown`. v2 ignores it on `PATCH`, and the owner decision of
 *   2026-09-05 is that update responses keep today's format rather than paying
 *   a re-read for cosmetic consistency with reads.
 * - No `If-Match`. v2 accepts the header and ignores it. There is no
 *   optimistic locking to build on.
 * - No stripping of `max_permission`. v2's `PATCH` answers with the
 *   `ProjectView` schema, which does not carry it (confirmed live: the 200
 *   body holds no `max_permission` on any of the three versions), and
 *   `viewSummary` in ../views.ts projects onto a fixed key list anyway, so no
 *   v2-only field could reach a caller even if a later release added one.
 *   `$schema` is already removed by the transport's response normalizer.
 */

import { MCPError } from '../../../types';
import { vikunjaRestRequest } from '../../../utils/vikunja-rest';
import { vikunjaRestV2Request } from '../../../utils/vikunja-rest-v2';
import { buildViewFieldPatch } from './mapping';
import type { ViewUpdateInput, ViewUpdateStrategy, VikunjaProjectView } from './types';

/**
 * Vikunja answers `304 Not Modified`, with no body, when a merge patch would
 * leave the view exactly as it is — including the trivial case of setting a
 * field to the value it already holds, which is precisely what
 * `set-done-bucket` does when the requested bucket is already the done bucket.
 * Our transport surfaces it as an `MCPError`, since 304 is not `response.ok`.
 */
const NOT_MODIFIED = 304;

function isNotModified(error: unknown): boolean {
  return error instanceof MCPError && error.details?.statusCode === NOT_MODIFIED;
}

export class V2ViewUpdateStrategy implements ViewUpdateStrategy {
  readonly apiVersion = 'v2' as const;

  async execute(input: ViewUpdateInput): Promise<VikunjaProjectView> {
    const { authManager, projectId, viewId, updates } = input;
    const path = `/projects/${projectId}/views/${viewId}`;

    // No `currentFilter`: the server merges nested objects itself, so the
    // patch carries only the query the caller asked for.
    const body = buildViewFieldPatch(updates);

    try {
      return await vikunjaRestV2Request<VikunjaProjectView>(authManager, 'PATCH', path, body);
    } catch (error) {
      if (isNotModified(error)) {
        return this.readView(authManager, path);
      }
      throw error;
    }
  }

  /**
   * The no-op fallback read stays on v1. A 304 means the view already holds
   * every value the caller asked for, and the callers still need a view to
   * report; reading it through v1 gives back exactly the shape the v1 strategy
   * would have produced, with no v2-only field to strip.
   */
  private async readView(
    authManager: ViewUpdateInput['authManager'],
    path: string,
  ): Promise<VikunjaProjectView> {
    return vikunjaRestRequest<VikunjaProjectView>(authManager, 'GET', path);
  }
}
