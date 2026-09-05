/**
 * Project update against Vikunja's v2 API: one merge patch carrying only the
 * fields the caller named.
 *
 * The interesting question for this entity was not whether `PATCH` exists but
 * whether it actually retires the fetch-merge, because the merge on the v1
 * path guards two full-replace traps rather than one (see
 * `./V1ProjectUpdateStrategy`). Assuming it does would have been a way to
 * silently unfavorite or unparent every project this server touches, so it
 * was probed instead. Live against 2.4.0, 2.5.0 and 2.6.0 on 2026-09-06, on a
 * favorited child project carrying a description and a hex colour:
 *
 *   | Patch body                 | 2.4.0 | 2.5.0 | 2.6.0 | Result                    |
 *   |----------------------------|-------|-------|-------|---------------------------|
 *   | `{title}`                  | 200   | 200   | 200   | favorite + parent survive |
 *   | `{description}`            | 200   | 200   | 200   | favorite + parent survive |
 *   | `{is_favorite: false}`     | 200   | 200   | 200   | unfavorited               |
 *   | `{is_favorite: true}`      | 200   | 200   | 200   | favorited again           |
 *   | `{is_archived: true/false}`| 200   | 200   | 200   | applied, nothing else lost|
 *   | `{parent_project_id: 0}`   | 200   | 200   | 200   | moved to root             |
 *   | `{parent_project_id: N}`   | 200   | 200   | 200   | moved under N             |
 *
 * So both traps are genuinely closed on the v2 path: an omitted field is not
 * bound to a zero value, because the server applies the patch to the stored
 * project before running the same `UpdateProject` code v1 reaches. An
 * explicit `false` still unfavorites, which is the behaviour the tool surface
 * promises. The merge is therefore correct to drop here and correct to keep
 * on v1 — the same conclusion, opposite directions, for the same reason.
 *
 * Two more things the probe settled:
 *
 * - **No `minVersion` floor.** Unlike task update, whose v2 `PATCH` 422s on
 *   2.4.0 for any subscribed task, project `PATCH` answered 200 on every
 *   supported version. Routing it below 2.5.0 is safe, so `resolveApiVersion`
 *   is called without a floor.
 * - **Nothing to strip.** v1's `GET /projects/{id}` already returns
 *   `max_permission`, so unlike the task strategy this one has no v2-only
 *   field to remove. `$schema`, the only key v2 adds, is already dropped by
 *   the transport's response normalizer.
 *
 * Not done here, on purpose: no `?format=markdown` (v2 ignores it on `PATCH`,
 * and the owner decision of 2026-09-05 is that update responses keep today's
 * format rather than paying a re-read), and no `If-Match` (accepted and
 * ignored, so there is no optimistic locking to build on).
 */

import { MCPError } from '../../../types';
import { vikunjaRestRequest } from '../../../utils/vikunja-rest';
import { vikunjaRestV2Request } from '../../../utils/vikunja-rest-v2';
import { buildProjectFieldPatch } from './analysis';
import type { ProjectUpdateInput, ProjectUpdateStrategy, VikunjaProject } from './types';

/**
 * Vikunja answers `304 Not Modified`, with no body, when a merge patch would
 * leave the project exactly as it is — including the trivial case of setting
 * a field to the value it already holds, which is an ordinary thing for a
 * caller to do. Confirmed live on all three supported versions.
 *
 * The transport surfaces it as an `MCPError`, because `304` is not
 * `response.ok`.
 */
const NOT_MODIFIED = 304;

function isNotModified(error: unknown): boolean {
  return error instanceof MCPError && error.details?.statusCode === NOT_MODIFIED;
}

export class V2ProjectUpdateStrategy implements ProjectUpdateStrategy {
  readonly apiVersion = 'v2' as const;

  async execute(input: ProjectUpdateInput): Promise<VikunjaProject> {
    const { authManager, projectId, fields } = input;

    try {
      return await vikunjaRestV2Request<VikunjaProject>(
        authManager,
        'PATCH',
        `/projects/${projectId}`,
        buildProjectFieldPatch(fields),
      );
    } catch (error) {
      if (isNotModified(error)) {
        return this.readProject(input);
      }
      throw error;
    }
  }

  /**
   * Answers a `304` with a fresh read rather than with the caller's
   * pre-update snapshot.
   *
   * The snapshot would usually be right and occasionally be wrong: the server
   * computed "nothing to change" against its *current* state, not against the
   * copy we fetched before the intervening validation calls, so a concurrent
   * change would make the snapshot stale precisely when it looked safest. The
   * read stays on v1, the same call the snapshot itself used, so the project
   * the caller gets back is shaped identically whichever branch produced it.
   */
  private async readProject(input: ProjectUpdateInput): Promise<VikunjaProject> {
    return vikunjaRestRequest<VikunjaProject>(
      input.authManager,
      'GET',
      `/projects/${input.projectId}`,
    );
  }
}
