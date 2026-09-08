/**
 * Comment operations service
 * Handles core business logic for task comment management
 */

import type { Message, TaskComment } from '../../../types/vikunja';
import type { AuthManager } from '../../../auth/AuthManager';
import { MCPError } from '../../../types';
import { vikunjaRestRequest } from '../../../utils/vikunja-rest';
import { vikunjaRestV2Request } from '../../../utils/vikunja-rest-v2';
import { resolveApiVersion, type ApiVersion } from '../../../utils/api-version';
import { HTTP_NOT_MODIFIED } from '../../../utils/retry';
import type { components } from '../../../types/generated/vikunja-openapi';
import {
  createBudget,
  DEFAULT_SERVER_PAGE_CAP,
  fetchAllPages,
  readServerPageCap,
} from '../../../utils/filtering/pagination';

/** `models.TaskComment` per the OpenAPI spec — note there is no `task_id` field. */
type VikunjaTaskComment = components['schemas']['models.TaskComment'];

/**
 * Result of `fetchTaskComments`. `resultComplete`/`warnings` are present
 * only when the listing is knowingly incomplete (issue #268's
 * `FilteringMetadata.resultComplete` pattern, reused here) — absent means a
 * plain, complete success.
 */
export interface TaskCommentListResult {
  comments: TaskComment[];
  resultComplete?: false;
  warnings?: string[];
}

/**
 * Maps the REST response shape (`models.TaskComment`, no `task_id`) onto
 * this codebase's local `TaskComment` type (which carries `task_id` for
 * caller convenience). `task_id` is always known from the URL path the
 * request was made against, so it's injected here rather than expected on
 * the wire.
 */
function toTaskComment(taskId: number, raw: VikunjaTaskComment): TaskComment {
  const comment: TaskComment = {
    task_id: taskId,
    comment: raw.comment ?? '',
  };
  if (raw.id !== undefined) comment.id = raw.id;
  if (raw.author !== undefined) {
    comment.author = raw.author as unknown as NonNullable<TaskComment['author']>;
  }
  if (raw.created !== undefined) comment.created = raw.created;
  if (raw.updated !== undefined) comment.updated = raw.updated;
  return comment;
}

/**
 * Picks the API version one comment update runs against — #184 P3 step 6.
 *
 * **No `minVersion` floor, and that is a decision rather than an omission.**
 * `PATCH /api/v2/tasks/{task}/comments/{commentid}` was probed against the
 * live 2.4.0, 2.5.0 and 2.6.0 stacks on 2026-09-06 and behaves identically on
 * all three: 200 with the updated comment, `author`/`created` untouched, 404
 * problem+json for a missing comment, 422 for an unknown property, and an
 * empty 304 for a patch that would change nothing. The subscription-422 that
 * forces `vikunja_tasks update` to carry a 2.5.0 floor is specific to tasks;
 * comments have no equivalent, so copying that floor here would keep 2.4.0 on
 * v1 for no reason.
 *
 * `resolveApiVersion` carries the rest of the policy: the `forceV1Api` kill
 * switch means v1 everywhere, and a server whose capabilities were never
 * probed means v1 rather than an optimistic guess.
 *
 * The `getCapabilities` guard is not paranoia about `AuthManager`. The comment
 * tools are reached from call sites holding a narrower auth-manager-shaped
 * object (the same reason `selectTaskUpdateStrategy` and `pagination.ts` guard
 * it), and an update must fall back to the always-correct v1 path rather than
 * throw when capability detection is not part of that object at all.
 */
export function selectCommentUpdateApiVersion(authManager: AuthManager): ApiVersion {
  if (typeof authManager.getCapabilities !== 'function') {
    return 'v1';
  }
  return resolveApiVersion(authManager);
}

function isNotModified(error: unknown): boolean {
  return error instanceof MCPError && error.details?.statusCode === HTTP_NOT_MODIFIED;
}

/**
 * Reads one comment over v1. Shared by `getComment` and by the 304 branch of
 * `updateComment`, so the two cannot drift apart.
 */
async function readComment(
  authManager: AuthManager,
  taskId: number,
  commentId: number,
): Promise<TaskComment> {
  const result = await vikunjaRestRequest<VikunjaTaskComment>(
    authManager,
    'GET',
    `/tasks/${taskId}/comments/${commentId}`,
  );
  return toTaskComment(taskId, result);
}

/**
 * Service for managing task comment operations
 */
export const CommentOperationsService = {
  /**
   * Create a new comment on a task via `PUT /tasks/{taskID}/comments`. The
   * request body is `models.TaskComment`, which per the spec carries only
   * `comment` as a writable field (`task_id` comes from the URL, not the
   * body).
   */
  async createComment(
    authManager: AuthManager,
    taskId: number,
    commentText: string,
  ): Promise<TaskComment> {
    const result = await vikunjaRestRequest<VikunjaTaskComment>(
      authManager,
      'PUT',
      `/tasks/${taskId}/comments`,
      { comment: commentText },
    );
    return toTaskComment(taskId, result);
  },

  /**
   * Fetch all comments for a task via `GET /tasks/{taskID}/comments`.
   *
   * PAGINATES (issue #289 / audit HIGH-18): the OpenAPI spec documents no
   * `page`/`per_page` params for this endpoint (only `order_by`), but a live
   * Vikunja 2.4.0 instance confirms the SAME `service.maxitemsperpage`
   * clamp applies anyway — verified live: 60 comments added to one task,
   * `GET /tasks/{id}/comments` (no query) returned exactly 50 with
   * `X-Pagination-Total-Pages: 2`, and `?page=2` returned the remaining 10.
   * A single unpaged request therefore silently dropped comments past the
   * clamp, the same shape issue #268 fixed for task listing — this call
   * site never exposed a `page`/`perPage` param to its own callers, so it
   * always auto-paginates (there is no "caller asked for a specific page"
   * case to opt out with, unlike the task-listing strategies).
   */
  async fetchTaskComments(
    authManager: AuthManager,
    taskId: number,
  ): Promise<TaskCommentListResult> {
    const cap = readServerPageCap(authManager) ?? DEFAULT_SERVER_PAGE_CAP;
    const budget = createBudget();

    const requestPage = async (page: number): Promise<VikunjaTaskComment[]> => {
      const qs = page === 1 ? '' : `?page=${page}`;
      const result = await vikunjaRestRequest<VikunjaTaskComment[]>(
        authManager,
        'GET',
        `/tasks/${taskId}/comments${qs}`,
      );
      return Array.isArray(result) ? result : [];
    };

    const raw = await fetchAllPages(requestPage, {
      autoPaginate: true,
      firstPage: 1,
      budget,
      cap,
      resourceLabel: `Task ${taskId} comments`,
    });

    return {
      comments: raw.map((comment) => toTaskComment(taskId, comment)),
      ...(budget.truncated || budget.warnings.length > 0
        ? { resultComplete: false as const, warnings: budget.warnings }
        : {}),
    };
  },

  /**
   * Fetch a single comment on a task via
   * `GET /tasks/{taskID}/comments/{commentID}`.
   */
  async getComment(
    authManager: AuthManager,
    taskId: number,
    commentId: number,
  ): Promise<TaskComment> {
    return readComment(authManager, taskId, commentId);
  },

  /**
   * Update an existing comment on a task — #184 P3 step 6.
   *
   * v1: `POST /tasks/{taskID}/comments/{commentID}`. The spec omits an
   * explicit body schema for this endpoint's parameters, but its behavior
   * mirrors the create endpoint's `models.TaskComment` — only `comment` is
   * sent.
   *
   * v2: `PATCH /tasks/{task}/comments/{commentid}` with the same one-field
   * body as a merge patch.
   *
   * ## Why this is a dispatcher and not a strategy pair
   *
   * The spec's rule, restated in the wave brief: introduce a strategy pair
   * only where the CALL SHAPE differs, and let the transport's normalizer
   * carry the rest. It does not differ here. A comment update was already a
   * single request carrying a single field — there is no fetch-merge to
   * retire, because `POST /tasks/{id}/comments/{cid}` only ever replaces
   * `comment` and leaves `author`/`created` alone (confirmed live: after a v1
   * update, a re-read still shows the original author and creation time). So
   * what v2 changes is the verb, the URL prefix and the content type, all of
   * which `vikunjaRestV2Request` owns, plus the one branch below. A
   * `CommentUpdateContext` with two strategy classes would be three files of
   * ceremony around one `if`.
   *
   * ## Rich text, and the read/write asymmetry
   *
   * A comment body is rich text, so this operation sits directly on the owner
   * decision of 2026-09-05. `?format=markdown` is honoured on v2 `GET` and
   * IGNORED on v2 `PATCH` — verified live on 2.4.0, 2.5.0 and 2.6.0, where
   * `PATCH ...?format=markdown` returned HTML and a 200. So the update
   * response keeps today's HTML on both paths, no `format` is sent on the
   * patch, and no re-read is bolted on to convert it. Comment READS are
   * untouched by this change and still run on v1, so nothing a caller sees
   * changes format today; when a later P3 step routes comment reads to v2 for
   * markdown, this response deliberately stays HTML.
   *
   * ## One improvement the caller does see
   *
   * v1's update response is malformed in a way its stored data is not: it
   * echoes `author: null` and `created: "0001-01-01T00:00:00Z"` (reproduced
   * live on all three versions), so today's callers get a comment object with
   * a null author back from an update even though the row is intact. v2's
   * `PATCH` response carries the real author and creation time. The response
   * SHAPE is unchanged — same fields, same mapper — but on v2 two of them stop
   * being garbage. That is not worth hiding behind a normalization step.
   */
  async updateComment(
    authManager: AuthManager,
    taskId: number,
    commentId: number,
    commentText: string,
  ): Promise<TaskComment> {
    const path = `/tasks/${taskId}/comments/${commentId}`;
    const body = { comment: commentText };

    if (selectCommentUpdateApiVersion(authManager) === 'v1') {
      const result = await vikunjaRestRequest<VikunjaTaskComment>(authManager, 'POST', path, body);
      return toTaskComment(taskId, result);
    }

    try {
      const result = await vikunjaRestV2Request<VikunjaTaskComment>(
        authManager,
        'PATCH',
        path,
        body,
      );
      return toTaskComment(taskId, result);
    } catch (error) {
      if (!isNotModified(error)) {
        throw error;
      }
      // Vikunja answers an empty 304 when the patch would change nothing —
      // including the ordinary case of re-sending a comment's current text,
      // which v1 answers with a plain 200. The transport surfaces that as an
      // MCPError because 304 is not `Response.ok`, so without this branch a
      // no-op update would start failing where it used to succeed. There is no
      // body to report, so the current comment has to be read back.
      //
      // The re-read stays on v1 on purpose. It is byte-for-byte the call
      // `getComment` already makes, and it cannot ask for markdown — a v2
      // re-read that did would make a no-op update return markdown while a
      // real update returns HTML, which is the asymmetry this operation exists
      // to keep out of a single response.
      return readComment(authManager, taskId, commentId);
    }
  },

  /**
   * Delete a comment from a task via
   * `DELETE /tasks/{taskID}/comments/{commentID}`.
   */
  async deleteComment(
    authManager: AuthManager,
    taskId: number,
    commentId: number,
  ): Promise<Message> {
    const result = await vikunjaRestRequest<Message | null>(
      authManager,
      'DELETE',
      `/tasks/${taskId}/comments/${commentId}`,
    );
    return result ?? { message: 'Successfully deleted.' };
  },

  /**
   * Get comment count from comments array
   */
  getCommentCount(comments: TaskComment[]): number {
    return comments.length;
  },
};
