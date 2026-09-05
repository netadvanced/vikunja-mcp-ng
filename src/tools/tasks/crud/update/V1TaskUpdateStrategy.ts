/**
 * Task update against Vikunja's v1 API: fetch, merge, `POST` the whole model,
 * then fix up the relationships the model cannot carry.
 *
 * This is the permanent floor, not a fallback. On a 2.4.0 server this *is* the
 * correct implementation of "update a task": that release's v2 `PATCH` answers
 * 422 for any task carrying a subscription, and assigning a user
 * auto-subscribes them, so the operation this milestone exists to improve is
 * exactly the one v2 cannot serve there (verified live, 2026-09-05).
 *
 * The sequence is unchanged from before the strategy split, deliberately. It
 * was moved, not rewritten:
 *
 *   POST /tasks/{id}  (full model)
 *   -> POST /tasks/{id}/labels/bulk   when labels were supplied
 *   -> GET + PUT/DELETE per user      when assignees were supplied
 *   -> bucket move                    when a bucket was supplied
 *   -> GET /tasks/{id}                to report the final state
 *
 * The full-model `POST` is why the merge exists: v1 replaces every column it
 * is given, so anything not sent back would be cleared. That is also the
 * read-modify-write race the v2 strategy retires.
 */

import { vikunjaRestRequest } from '../../../../utils/vikunja-rest';
import { buildTaskFieldPatch } from './analysis';
import { updateTaskLabels, updateTaskAssignees, moveTaskToRequestedBucket } from './relationships';
import type { TaskUpdateInput, TaskUpdateStrategy, UpdateTaskArgs, VikunjaTask } from './types';

/**
 * Builds the update data object by merging current task data with updates.
 * This prevents the API from clearing fields that aren't explicitly updated.
 */
export function buildUpdateData(currentTask: VikunjaTask, args: UpdateTaskArgs): VikunjaTask {
  return {
    ...currentTask,
    // Override with any provided updates
    ...buildTaskFieldPatch(args),
  };
}

export class V1TaskUpdateStrategy implements TaskUpdateStrategy {
  readonly apiVersion = 'v1' as const;

  async execute(input: TaskUpdateInput): Promise<VikunjaTask> {
    const { authManager, taskId, args, currentTask } = input;

    // Build and apply the update (full-model merge — Vikunja replaces the whole task)
    const updateData = buildUpdateData(currentTask, args);
    await vikunjaRestRequest<VikunjaTask>(authManager, 'POST', `/tasks/${taskId}`, updateData);

    // Update labels if provided
    if (args.labels !== undefined) {
      await updateTaskLabels(authManager, taskId, args.labels);
    }

    // Update assignees if provided
    if (args.assignees !== undefined) {
      await updateTaskAssignees(authManager, taskId, args.assignees);
    }

    // Move the task into a Kanban bucket if requested. Runs after the
    // full-model update above so that a same-call project move (args.projectId)
    // has already landed — moveTaskToBucket resolves the project from
    // args.projectId when given, otherwise re-fetches the task's (now
    // possibly new) project itself.
    if (args.bucketId !== undefined) {
      await moveTaskToRequestedBucket(authManager, taskId, args.bucketId, args);
    }

    // Fetch the complete updated task
    return vikunjaRestRequest<VikunjaTask>(authManager, 'GET', `/tasks/${taskId}`);
  }
}
