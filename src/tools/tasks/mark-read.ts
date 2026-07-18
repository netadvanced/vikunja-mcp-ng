/**
 * Mark a task as read
 *
 * Implements `mark-read` (`POST /tasks/{projecttask}/read`), which marks a
 * task as read for the current user by removing its unread status entry —
 * pairs with the task's `is_unread` field (see docs/ENDPOINT-TAIL-RETRIAGE.md
 * item G2). The spec's path parameter is oddly named `projecttask` (not
 * `taskID`, unlike every other task-scoped path in this file group) but it
 * is still just the task id.
 */

import type { AuthManager } from '../../auth/AuthManager';
import { MCPError, ErrorCode } from '../../types';
import { validateId } from '../../utils/validation';
import { createStandardResponse, formatAorpAsMarkdown } from '../../utils/response-factory';
import { vikunjaRestRequest } from '../../utils/vikunja-rest';
import type { components } from '../../types/generated/vikunja-openapi';

// Sourced from the vendored OpenAPI spec (docs/vikunja-openapi.json).
type TaskUnreadStatus = components['schemas']['models.TaskUnreadStatus'];

export interface MarkTaskReadArgs {
  /** Id of the task to mark as read. */
  id?: number;
  /** Session id for response tracking. */
  sessionId?: string;
}

/**
 * Marks a task as read for the current user.
 */
export async function markTaskRead(
  args: MarkTaskReadArgs,
  authManager: AuthManager,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  if (!args.id) {
    throw new MCPError(ErrorCode.VALIDATION_ERROR, 'Task id is required for mark-read operation');
  }
  validateId(args.id, 'id');

  // Path segment is named `projecttask` in the spec; it takes the task id.
  const result = await vikunjaRestRequest<TaskUnreadStatus>(
    authManager,
    'POST',
    `/tasks/${args.id}/read`,
  );

  const response = createStandardResponse(
    'mark-read',
    `Task ${args.id} marked as read`,
    {
      taskId: result?.taskID ?? args.id,
      userId: result?.userID,
    },
    {
      timestamp: new Date().toISOString(),
    },
    args.sessionId,
  );

  return {
    content: [{ type: 'text' as const, text: formatAorpAsMarkdown(response) }],
  };
}
