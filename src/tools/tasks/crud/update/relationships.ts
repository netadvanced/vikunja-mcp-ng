/**
 * Label and assignee writes shared by the two task-update strategies.
 *
 * Labels are identical on both paths: neither v1 nor v2 applies a task's
 * labels from the task body, so both need the dedicated bulk endpoint
 * (verified live on 2.4.0, 2.5.0 and 2.6.0). Assignees are not shared —
 * v2 sends them inline in the `PATCH` body, so only v1 needs the
 * add/remove diff below.
 */

import { MCPError, ErrorCode } from '../../../../types';
import type { AuthManager } from '../../../../auth/AuthManager';
import { vikunjaRestRequest } from '../../../../utils/vikunja-rest';
import { getTaskViaRest } from '../../../../utils/task-rest-transport';
import { isAuthenticationError } from '../../../../utils/auth-error-handler';
import { RETRY_CONFIG } from '../../../../utils/retry';
import { setTaskLabels } from '../../../../utils/label-bulk';
import { extractHttpErrorDetail } from '../../../../utils/http-error-detail';
import { AUTH_ERROR_MESSAGES } from '../../constants';
import { moveTaskToBucket } from '../../buckets';
import type { UpdateTaskArgs } from './types';

/**
 * Places the task into the Kanban bucket the caller asked for.
 *
 * Identical on both paths, and it stays a v1 call on both: v2 registers only
 * `GET`/`POST` on the bucket collection and `PUT`/`DELETE` on a single bucket,
 * with no partial-update route, so there is nothing to gain by porting it.
 */
export async function moveTaskToRequestedBucket(
  authManager: AuthManager,
  taskId: number,
  bucketId: number,
  args: Pick<UpdateTaskArgs, 'viewId' | 'projectId'>,
): Promise<void> {
  await moveTaskToBucket(authManager, {
    taskId,
    bucketId,
    viewId: args.viewId,
    projectId: args.projectId,
  });
}

/**
 * Updates task labels with authentication error handling.
 *
 * The catch surfaces the HTTP status + body of the underlying Vikunja error
 * in both branches. Previously the catch replaced any 403/422 from
 * `POST /tasks/{id}/labels/bulk` with the generic LABEL_UPDATE "known
 * limitation" message, which hid the real cause (e.g. a permission failure
 * vs an invalid label id) from the MCP client and made the diagnostic
 * round-trip much longer for the consumer.
 */
export async function updateTaskLabels(
  authManager: AuthManager,
  taskId: number,
  labelIds: number[],
): Promise<void> {
  try {
    await setTaskLabels(authManager, taskId, labelIds);
  } catch (labelError) {
    const detail = extractHttpErrorDetail(labelError);
    if (isAuthenticationError(labelError)) {
      throw new MCPError(
        ErrorCode.API_ERROR,
        detail ? `${AUTH_ERROR_MESSAGES.LABEL_UPDATE} ${detail}` : AUTH_ERROR_MESSAGES.LABEL_UPDATE,
      );
    }
    if (detail) {
      throw new MCPError(ErrorCode.API_ERROR, `Failed to update task labels ${detail}`);
    }
    throw labelError;
  }
}

/**
 * Updates task assignees with diff calculation and authentication error
 * handling, via the direct-REST assignee endpoints.
 *
 * v1 only. This is the read-modify-write the milestone exists to retire: it
 * costs one read plus one call per added and per removed user, because v1's
 * task body cannot carry assignees. The v2 strategy sends them inline in the
 * `PATCH` instead and never calls this.
 */
export async function updateTaskAssignees(
  authManager: AuthManager,
  taskId: number,
  newAssigneeIds: number[],
): Promise<void> {
  try {
    // Get current assignees to calculate diff
    const currentTask = await getTaskViaRest(authManager, taskId);
    const currentAssigneeIds = (currentTask.assignees ?? [])
      .map((a) => a.id)
      .filter((id): id is number => typeof id === 'number');

    // Calculate which assignees to add and remove
    const toAdd = newAssigneeIds.filter((id: number) => !currentAssigneeIds.includes(id));
    const toRemove = currentAssigneeIds.filter((id: number) => !newAssigneeIds.includes(id));

    // Add new assignees first to avoid leaving task unassigned if removal fails.
    // Use the ADDITIVE single-assign endpoint per user (PUT
    // /tasks/{taskID}/assignees, body { user_id }, models.TaskAssginee) rather
    // than the bulk endpoint (POST .../assignees/bulk), which REPLACES the
    // whole list and would silently unassign everyone
    // (democratize-technology/vikunja-mcp#15).
    // Sequential on purpose (post-#89 pattern sweep, mirrors the per-user
    // removal loop directly below): concurrent per-user writes to the same
    // task risk "database is locked" 500s on SQLite-backed instances.
    for (const userId of toAdd) {
      await vikunjaRestRequest(authManager, 'PUT', `/tasks/${taskId}/assignees`, {
        user_id: userId,
      });
    }

    // Remove old assignees only after new ones are successfully added. DELETE
    // /tasks/{taskID}/assignees/{userID} per the OpenAPI spec — no body.
    for (const userId of toRemove) {
      try {
        await vikunjaRestRequest(authManager, 'DELETE', `/tasks/${taskId}/assignees/${userId}`);
      } catch (removeError) {
        // Check if it's an auth error on remove
        if (isAuthenticationError(removeError)) {
          throw new MCPError(ErrorCode.API_ERROR, AUTH_ERROR_MESSAGES.ASSIGNEE_REMOVE_PARTIAL);
        }
        throw removeError;
      }
    }
  } catch (assigneeError) {
    // Check if it's an auth error after retries
    if (isAuthenticationError(assigneeError)) {
      throw new MCPError(
        ErrorCode.API_ERROR,
        `${AUTH_ERROR_MESSAGES.ASSIGNEE_UPDATE} (Retried ${RETRY_CONFIG.AUTH_ERRORS.maxRetries} times)`,
      );
    }
    throw assigneeError;
  }
}
