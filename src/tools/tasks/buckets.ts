/**
 * Task Kanban bucket operations
 *
 * Implements `set-bucket`, which moves a task into a Kanban bucket (column)
 * of its project's Kanban view. This is the operation behind a "move card to
 * the Doing column" workflow.
 *
 * Also implements `bulk-set-bucket` (composite-first, docs/ROADMAP.md
 * decision 4): distributing several tasks across Kanban buckets ("q3-offsite
 * kanban" battle-campaign friction #4) previously meant one `set-bucket` call
 * per task, each re-resolving the same project/view. `bulk-set-bucket`
 * resolves the project + Kanban view ONCE, then applies the per-task bucket
 * placement write sequentially (SQLite lock discipline — see the per-task
 * loops in bulk-operations-simplified.ts), collecting per-task failures
 * rather than aborting the whole batch on the first error (PR #95's honest
 * partial-reporting shape).
 *
 * legacy client does not expose the Kanban view endpoints, so this calls the
 * Vikunja REST API directly via the shared `vikunja-rest` helper.
 */

import type { AuthManager } from '../../auth/AuthManager';
import { MCPError, ErrorCode } from '../../types';
import { validateId } from '../../utils/validation';
import { createStandardResponse, formatAorpAsMarkdown } from '../../utils/response-factory';
import { vikunjaRestRequest, resolveKanbanViewId } from '../../utils/vikunja-rest';
import { MAX_BULK_OPERATION_TASKS } from './constants';

export interface SetTaskBucketArgs {
  /** Id of the task to move. */
  id?: number;
  /** Id of the destination Kanban bucket. */
  bucketId?: number;
  /** Optional Kanban view id. Auto-resolved from the project when omitted. */
  viewId?: number;
  /** Optional project id. Auto-resolved from the task when omitted. */
  projectId?: number;
  /** Session id for response tracking. */
  sessionId?: string;
}

interface VikunjaTaskSummary {
  id: number;
  project_id: number;
  title?: string;
}

/** Inputs shared by every caller that needs to place a task into a bucket. */
export interface MoveTaskToBucketArgs {
  taskId: number;
  bucketId: number;
  /** Optional Kanban view id. Auto-resolved from the project when omitted. */
  viewId?: number | undefined;
  /** Optional project id. Auto-resolved from the task when omitted. */
  projectId?: number | undefined;
}

/** Resolved ids the move was actually performed against. */
export interface MoveTaskToBucketResult {
  viewId: number;
  projectId: number;
}

/**
 * Moves a task into a Kanban bucket via the dedicated view/bucket endpoint.
 *
 * This is the single implementation behind both the `set-bucket` subcommand
 * and `update`'s `bucketId` field (see `TaskUpdateService.ts`) — both need
 * identical project/view resolution and must call the same endpoint so that
 * `update` doesn't silently drop `bucketId` (battle-tested friction: the
 * schema accepted `bucketId` on update but nothing ever read it, forcing
 * agents to redo the work via `set-bucket`).
 *
 * Resolution order when optional ids are omitted:
 *  - projectId: fetched from the task itself
 *  - viewId: resolved to the project's Kanban view
 *
 * @param authManager - Active auth manager holding session credentials
 * @param args - Task id, destination bucket id, and optional view/project ids
 * @returns The resolved view/project ids the move was applied against
 * @throws MCPError when the task, project, or Kanban view cannot be resolved,
 *   or when the bucket-move request itself fails
 */
export async function moveTaskToBucket(
  authManager: AuthManager,
  args: MoveTaskToBucketArgs,
): Promise<MoveTaskToBucketResult> {
  // Resolve the project id from the task when the caller did not supply it.
  let projectId = args.projectId;
  if (projectId === undefined) {
    const task = await vikunjaRestRequest<VikunjaTaskSummary>(
      authManager,
      'GET',
      `/tasks/${args.taskId}`,
    );
    if (!task || typeof task.project_id !== 'number') {
      throw new MCPError(
        ErrorCode.NOT_FOUND,
        `Could not resolve the project of task ${args.taskId}`,
      );
    }
    projectId = task.project_id;
  }

  // Resolve the Kanban view id when the caller did not supply it.
  const viewId =
    args.viewId !== undefined ? args.viewId : await resolveKanbanViewId(authManager, projectId);

  // Place the task into the bucket. Vikunja's bucket-task endpoint expects the
  // TaskBucket payload; bucket_id is also part of the URL but is sent in the
  // body as the API model requires it.
  await vikunjaRestRequest(
    authManager,
    'POST',
    `/projects/${projectId}/views/${viewId}/buckets/${args.bucketId}/tasks`,
    { task_id: args.taskId, bucket_id: args.bucketId },
  );

  return { viewId, projectId };
}

/**
 * Moves a task into a Kanban bucket.
 *
 * Resolution order when optional ids are omitted:
 *  - projectId: fetched from the task itself
 *  - viewId: resolved to the project's Kanban view
 *
 * @param args - Task id, destination bucket id, and optional view/project ids
 * @param authManager - Active auth manager holding session credentials
 * @returns MCP response describing the move
 */
export async function setTaskBucket(
  args: SetTaskBucketArgs,
  authManager: AuthManager,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  if (!args.id) {
    throw new MCPError(ErrorCode.VALIDATION_ERROR, 'Task id is required for set-bucket operation');
  }
  if (args.bucketId === undefined || args.bucketId === null) {
    throw new MCPError(
      ErrorCode.VALIDATION_ERROR,
      'bucketId is required for set-bucket operation',
    );
  }
  validateId(args.id, 'id');
  validateId(args.bucketId, 'bucketId');
  if (args.viewId !== undefined) validateId(args.viewId, 'viewId');
  if (args.projectId !== undefined) validateId(args.projectId, 'projectId');

  const { viewId, projectId } = await moveTaskToBucket(authManager, {
    taskId: args.id,
    bucketId: args.bucketId,
    viewId: args.viewId,
    projectId: args.projectId,
  });

  const response = createStandardResponse(
    'set-task-bucket',
    `Task ${args.id} moved to bucket ${args.bucketId}`,
    {
      taskId: args.id,
      bucketId: args.bucketId,
      viewId,
      projectId,
    },
    {
      timestamp: new Date().toISOString(),
      affectedFields: ['bucket_id'],
    },
    args.sessionId,
  );

  return {
    content: [
      {
        type: 'text' as const,
        text: formatAorpAsMarkdown(response),
      },
    ],
  };
}

export interface BulkSetTaskBucketArgs {
  /** Ids of the tasks to move into the destination bucket. */
  taskIds?: number[];
  /** Id of the destination Kanban bucket. */
  bucketId?: number;
  /** Optional Kanban view id. Auto-resolved from the project when omitted. */
  viewId?: number;
  /**
   * Optional project id. Auto-resolved from the FIRST task in `taskIds` when
   * omitted — a Kanban bucket belongs to exactly one project's view, so
   * every task in the batch is expected to share that project.
   */
  projectId?: number;
  /** Session id for response tracking. */
  sessionId?: string;
}

/** Per-task outcome reported by `bulkSetTaskBucket`. */
interface BulkBucketFailure {
  taskId: number;
  error: string;
}

/**
 * Moves several tasks into the same Kanban bucket in one call.
 *
 * Resolves the project (from `projectId`, or from the first task when
 * omitted) and the Kanban view ONCE, then places each task into the bucket
 * with SEQUENTIAL writes — concurrent writes into the same view/bucket risk
 * "database is locked" 500s on SQLite-backed Vikunja instances (the same
 * discipline the per-task assignee/label loops elsewhere in this codebase
 * follow, post-#89 pattern sweep). Per-task failures are collected instead of
 * aborting the whole batch; the reported success count comes from confirmed
 * per-task successes, with `failedIds` surfaced on a partial result.
 *
 * @param args - Task ids, destination bucket id, and optional view/project ids
 * @param authManager - Active auth manager holding session credentials
 * @returns MCP response describing the batch move, honestly reporting partial failures
 */
export async function bulkSetTaskBucket(
  args: BulkSetTaskBucketArgs,
  authManager: AuthManager,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  if (!args.taskIds || args.taskIds.length === 0) {
    throw new MCPError(
      ErrorCode.VALIDATION_ERROR,
      'taskIds array is required for bulk-set-bucket operation',
    );
  }
  if (args.bucketId === undefined || args.bucketId === null) {
    throw new MCPError(
      ErrorCode.VALIDATION_ERROR,
      'bucketId is required for bulk-set-bucket operation',
    );
  }
  if (args.taskIds.length > MAX_BULK_OPERATION_TASKS) {
    throw new MCPError(
      ErrorCode.VALIDATION_ERROR,
      `Too many tasks for bulk operation. Maximum allowed: ${MAX_BULK_OPERATION_TASKS}. Consider breaking into smaller batches.`,
    );
  }
  args.taskIds.forEach((id) => validateId(id, 'task ID'));
  validateId(args.bucketId, 'bucketId');
  if (args.viewId !== undefined) validateId(args.viewId, 'viewId');
  if (args.projectId !== undefined) validateId(args.projectId, 'projectId');

  const taskIds = args.taskIds;
  const bucketId = args.bucketId;

  // Resolve the project id ONCE — from the explicit arg, or from the first
  // task in the batch when omitted.
  let projectId = args.projectId;
  if (projectId === undefined) {
    const firstTaskId = taskIds[0] as number;
    const task = await vikunjaRestRequest<VikunjaTaskSummary>(
      authManager,
      'GET',
      `/tasks/${firstTaskId}`,
    );
    if (!task || typeof task.project_id !== 'number') {
      throw new MCPError(
        ErrorCode.NOT_FOUND,
        `Could not resolve the project of task ${firstTaskId}`,
      );
    }
    projectId = task.project_id;
  }

  // Resolve the Kanban view id ONCE.
  const viewId =
    args.viewId !== undefined ? args.viewId : await resolveKanbanViewId(authManager, projectId);

  const succeededIds: number[] = [];
  const failures: BulkBucketFailure[] = [];

  // Sequential on purpose — see the module/function doc comments above.
  // Reuse the shared `moveTaskToBucket` helper (the write E1 extracted) for the
  // per-task placement; passing the already-resolved `viewId`/`projectId` keeps
  // resolution one-shot (the helper only re-resolves when they are omitted).
  for (const taskId of taskIds) {
    try {
      await moveTaskToBucket(authManager, {
        taskId,
        bucketId,
        viewId,
        projectId,
      });
      succeededIds.push(taskId);
    } catch (error) {
      failures.push({ taskId, error: error instanceof Error ? error.message : String(error) });
    }
  }

  if (succeededIds.length === 0) {
    const failedIds = failures.map((f) => f.taskId);
    throw new MCPError(
      ErrorCode.API_ERROR,
      `Bulk set-bucket failed. Could not move any tasks to bucket ${bucketId}. Failed task IDs: ${failedIds.join(', ')}`,
    );
  }

  const partial = failures.length > 0;
  const failedIds = failures.map((f) => f.taskId);

  const response = createStandardResponse(
    'bulk-set-task-bucket',
    partial
      ? `Bulk set-bucket partially completed. Successfully moved ${succeededIds.length} of ${taskIds.length} tasks to bucket ${bucketId}. Failed task IDs: ${failedIds.join(', ')}`
      : `Successfully moved ${succeededIds.length} tasks to bucket ${bucketId}`,
    {
      bucketId,
      viewId,
      projectId,
      taskIds: succeededIds,
      ...(partial ? { failedIds, failures } : {}),
    },
    {
      timestamp: new Date().toISOString(),
      affectedFields: ['bucket_id'],
      count: succeededIds.length,
      ...(partial ? { failedCount: failures.length, success: false } : {}),
    },
    args.sessionId,
  );

  return {
    content: [
      {
        type: 'text' as const,
        text: formatAorpAsMarkdown(response),
      },
    ],
  };
}
