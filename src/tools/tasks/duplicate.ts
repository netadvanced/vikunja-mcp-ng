/**
 * Task duplication
 *
 * Implements `duplicate` (`PUT /tasks/{taskID}/duplicate`), which copies a
 * task with all its properties (labels, assignees, attachments, reminders)
 * into the same project and creates a "copied from" relation between the
 * new and original task. Direct parallel to the already-shipped
 * `vikunja_projects duplicate` (`src/tools/projects/duplicate.ts`) — see
 * docs/ENDPOINT-TAIL-RETRIAGE.md item G2. No request body; the endpoint
 * takes only the path parameter.
 */

import type { AuthManager } from '../../auth/AuthManager';
import { MCPError, ErrorCode } from '../../types';
import { validateId } from '../../utils/validation';
import { createStandardResponse, formatAorpAsMarkdown } from '../../utils/response-factory';
import { vikunjaRestRequest } from '../../utils/vikunja-rest';
import type { components } from '../../types/generated/vikunja-openapi';

// Sourced from the vendored OpenAPI spec (docs/vikunja-openapi.json). Note
// the response envelope is `models.TaskDuplicate` (`{ duplicated_task }`),
// mirroring `models.ProjectDuplicate`'s `{ duplicated_project }` shape —
// not a bare `models.Task`.
type TaskDuplicate = components['schemas']['models.TaskDuplicate'];

export interface DuplicateTaskArgs {
  /** Id of the task to duplicate. */
  id?: number;
  /** Session id for response tracking. */
  sessionId?: string;
}

/**
 * Duplicates a task.
 */
export async function duplicateTask(
  args: DuplicateTaskArgs,
  authManager: AuthManager,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  if (!args.id) {
    throw new MCPError(ErrorCode.VALIDATION_ERROR, 'Task id is required for duplicate operation');
  }
  validateId(args.id, 'id');

  const result = await vikunjaRestRequest<TaskDuplicate>(
    authManager,
    'PUT',
    `/tasks/${args.id}/duplicate`,
  );

  const duplicated = result?.duplicated_task;

  const response = createStandardResponse(
    'duplicate',
    duplicated?.id !== undefined
      ? `Task ${args.id} duplicated as task ${duplicated.id}`
      : `Task ${args.id} duplicated`,
    {
      sourceTaskId: args.id,
      duplicatedTask: duplicated,
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
