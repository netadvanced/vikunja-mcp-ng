/**
 * Task update against Vikunja's v2 API: one merge-patch that carries the
 * changed fields and the assignees together.
 *
 * This is the payoff of #184. v1 has to read the task, merge the caller's
 * fields into the whole model, `POST` it back, then read the assignees and
 * add/remove them one user at a time, then read the task again to report the
 * result. v2 replaces all of that with a single `PATCH`:
 *
 *   POST /tasks/{id}/labels/bulk   when labels were supplied
 *   -> PATCH /api/v2/tasks/{id}    fields + assignees, returns the updated task
 *   -> bucket move                 when a bucket was supplied
 *
 * Three deliberate differences from the v1 sequence, each with a reason:
 *
 * 1. **Labels go first.** v1 writes labels after the task and then re-reads to
 *    pick them up. The `PATCH` response is a complete, current task, so
 *    writing labels before it removes the trailing read entirely — the label
 *    set in the response is the one just written (verified live on 2.5.0 and
 *    2.6.0). Both orders leave the same partial state if the second call
 *    fails; neither API offers a transaction.
 * 2. **Assignees ride in the body.** v2 applies `assignees` from the request
 *    body and treats the list as a replacement, which is exactly the
 *    semantics the caller asked for. `[]` clears them (verified live). The
 *    snapshot-diff-restore dance disappears, and with it the window in which
 *    a concurrent change could be clobbered.
 * 3. **No trailing read.** The `PATCH` response is the canonical result.
 *
 * Not done here, on purpose:
 *
 * - No `?format=markdown`. v2 ignores it on `PATCH` (it is declared on
 *   `GET`/`POST`/`PUT` only), and the owner decision of 2026-09-05 is that
 *   update responses keep today's format rather than paying a re-read to make
 *   them cosmetically consistent with reads.
 * - No `If-Match`. v2 accepts the header and ignores it; a stale ETag and a
 *   garbage one both returned 200 live. There is no optimistic locking to
 *   build on.
 * - No `subscription: null`. That merge-patch workaround does make 2.4.0's
 *   `PATCH` succeed, and it is withdrawn on judgement: a future Vikunja that
 *   honours merge-patch null semantics would read it as "delete this field"
 *   and silently unsubscribe users. This strategy is simply not selected on
 *   2.4.0 (see ./TaskUpdateContext).
 */

import { MCPError } from '../../../../types';
import { vikunjaRestRequest } from '../../../../utils/vikunja-rest';
import { vikunjaRestV2Request } from '../../../../utils/vikunja-rest-v2';
import { buildTaskFieldPatch } from './analysis';
import { updateTaskLabels, moveTaskToRequestedBucket } from './relationships';
import type { TaskUpdateInput, TaskUpdateStrategy, UpdateTaskArgs, VikunjaTask } from './types';

/**
 * Fields v2 adds to a task that v1 has never returned, and that must not reach
 * a caller: the P3 spec's non-goals put `max_permission` explicitly out of
 * scope for this milestone's tool surface, and leaking it would be a
 * caller-visible tell of which strategy ran. (`$schema`, the only other v2
 * addition on a single task read live on 2.5.0, is already removed by the
 * transport's response normalizer.)
 */
type V2OnlyTaskFields = { max_permission?: unknown };

/**
 * Vikunja answers `304 Not Modified`, with no body, when a merge patch would
 * leave the task exactly as it is — including the trivial case of setting a
 * field to the value it already holds. Confirmed live on 2.5.0.
 */
const NOT_MODIFIED = 304;

/**
 * Builds the merge-patch body: the caller's changed fields, plus assignees
 * when they were supplied.
 *
 * v2 wants assignees as objects, matching the shape it returns them in. An
 * empty list is meaningful (it clears every assignee), so the check is on
 * `undefined`, not on length.
 */
export function buildTaskPatchBody(args: UpdateTaskArgs): Partial<VikunjaTask> {
  return {
    ...buildTaskFieldPatch(args),
    ...(args.assignees !== undefined && {
      assignees: args.assignees.map((id) => ({ id })),
    }),
  };
}

/**
 * Removes v2-only fields so the returned task is byte-comparable with the one
 * the v1 strategy produces.
 */
function toCanonicalTask(task: VikunjaTask): VikunjaTask {
  const canonical: VikunjaTask & V2OnlyTaskFields = { ...task };
  delete canonical.max_permission;
  return canonical;
}

function isNotModified(error: unknown): boolean {
  return error instanceof MCPError && error.details?.statusCode === NOT_MODIFIED;
}

export class V2TaskUpdateStrategy implements TaskUpdateStrategy {
  readonly apiVersion = 'v2' as const;

  async execute(input: TaskUpdateInput): Promise<VikunjaTask> {
    const { authManager, taskId, args } = input;

    // Labels first, so the PATCH response below already reflects them and no
    // trailing read is needed. Neither API version applies labels from the
    // task body, so this call exists on both paths.
    if (args.labels !== undefined) {
      await updateTaskLabels(authManager, taskId, args.labels);
    }

    const task = await this.applyPatch(input);

    // Same position as on the v1 path: after the field write, so a same-call
    // project move has landed before the bucket is resolved. It does not
    // change the task body Vikunja returns for a plain task read (bucket_id
    // is only populated when a task is read through a view — see
    // docs/API_NOTES.md, re-checked live on 2.5.0), so the PATCH response
    // stays accurate and this needs no re-read.
    if (args.bucketId !== undefined) {
      await moveTaskToRequestedBucket(authManager, taskId, args.bucketId, args);
    }

    return task;
  }

  /**
   * Sends the merge patch and returns the updated task.
   *
   * Two paths end in a read instead, both of which mean "the patch changed
   * nothing", and both of which still have to report a current task because a
   * label write or a concurrent change may have moved it since the caller's
   * pre-update snapshot was taken:
   *
   * - an empty patch body (the caller supplied only relationships), which is
   *   not worth a request; and
   * - a `304` from the server, which is what a no-op patch actually answers.
   */
  private async applyPatch(input: TaskUpdateInput): Promise<VikunjaTask> {
    const { authManager, taskId, args } = input;
    const body = buildTaskPatchBody(args);

    if (Object.keys(body).length === 0) {
      return this.readTask(authManager, taskId);
    }

    try {
      const patched = await vikunjaRestV2Request<VikunjaTask>(
        authManager,
        'PATCH',
        `/tasks/${taskId}`,
        body,
      );
      return toCanonicalTask(patched);
    } catch (error) {
      if (isNotModified(error)) {
        return this.readTask(authManager, taskId);
      }
      throw error;
    }
  }

  /**
   * The fallback read stays on v1. It is the same call the pre-update snapshot
   * used, so the task the caller gets back is shaped identically whichever
   * branch produced it, with no v2-only fields to strip.
   */
  private async readTask(
    authManager: TaskUpdateInput['authManager'],
    taskId: number,
  ): Promise<VikunjaTask> {
    return vikunjaRestRequest<VikunjaTask>(authManager, 'GET', `/tasks/${taskId}`);
  }
}
