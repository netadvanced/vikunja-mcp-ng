/**
 * Task Bulk Operations Tool
 * Handles bulk task operations: bulk-create, bulk-update, bulk-delete
 * Replaces monolithic tasks tool with focused individual tool
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AuthManager } from '../auth/AuthManager';
import type { VikunjaClientFactory } from '../client/VikunjaClientFactory';
import { MCPError, ErrorCode } from '../types';
import { getAuthManagerFromContext, hasRequestContext, setGlobalClientFactory } from '../client';
import { logger } from '../utils/logger';
import { createAuthRequiredError } from '../utils/error-handler';
import { assertWriteAllowed, getToolAnnotations, withReadOnlyNote } from '../utils/read-only';
import { percentDoneSchema } from '../utils/percent-done';
import { strictNestedObject } from '../utils/strict-nested-object';
import type { BulkCreateTaskData } from './tasks/bulk/BulkOperationValidator';

/** One entry of `vikunja_task_bulk bulk-create`'s `tasks[]`, as Zod parses it. */
export interface BulkCreateTaskInput {
  title: string;
  description?: string | undefined;
  dueDate?: string | undefined;
  startDate?: string | undefined;
  endDate?: string | undefined;
  priority?: number | undefined;
  percentDone?: number | undefined;
  labels?: number[] | undefined;
  assignees?: number[] | undefined;
  repeatAfter?: number | undefined;
  repeatMode?: ('day' | 'week' | 'month' | 'year') | undefined;
}

/**
 * Maps one parsed `tasks[]` entry onto the {@link BulkCreateTaskData} shape
 * `bulkCreateTasks`/`createOneBulkTask` actually read.
 *
 * Rebuilt key by key (rather than spread) so `exactOptionalPropertyTypes` is
 * satisfied — but **typed as `BulkCreateTaskData`**, which the version this
 * replaced was not. That earlier mapping used an inline anonymous type with
 * snake_case names (`due_date`, `repeat_after`, `repeat_mode`) that nothing
 * downstream reads, and never copied `percentDone` at all. Four fields the
 * schema HAD accepted were therefore dropped between the MCP boundary and the
 * API call: the caller got a success response and a task with no due date, no
 * repeat configuration and no progress. Naming the real type here makes any
 * future drift a compile error instead of a silent loss.
 *
 * Exported for direct testing: the handler reaches `bulkCreateTasks` through a
 * dynamic `import()`, which cannot be exercised under the CJS test runner.
 */
export function toBulkCreateTaskData(task: BulkCreateTaskInput): BulkCreateTaskData {
  const mapped: BulkCreateTaskData = { title: task.title };
  if (task.description !== undefined) mapped.description = task.description;
  if (task.dueDate !== undefined) mapped.dueDate = task.dueDate;
  if (task.startDate !== undefined) mapped.startDate = task.startDate;
  if (task.endDate !== undefined) mapped.endDate = task.endDate;
  if (task.priority !== undefined) mapped.priority = task.priority;
  // Whole percentage 0-100 in; createOneBulkTask converts it to Vikunja's
  // 0-1 wire fraction (src/utils/percent-done.ts).
  if (task.percentDone !== undefined) mapped.percentDone = task.percentDone;
  if (task.labels !== undefined) mapped.labels = task.labels;
  if (task.assignees !== undefined) mapped.assignees = task.assignees;
  if (task.repeatAfter !== undefined) mapped.repeatAfter = task.repeatAfter;
  if (task.repeatMode !== undefined) mapped.repeatMode = task.repeatMode;
  return mapped;
}

/**
 * Register task bulk operations tool
 */
export function registerTaskBulkTool(
  server: McpServer,
  authManager: AuthManager,
  clientFactory?: VikunjaClientFactory,
): void {
  server.tool(
    'vikunja_task_bulk',
    withReadOnlyNote(
      'vikunja_task_bulk',
      'Manage bulk task operations: create, update, delete multiple tasks, move multiple tasks into a Kanban bucket. ' +
        'bulk-set-bucket resolves the project/view once, then applies each move sequentially, honest partial reporting of failedIds.',
    ),
    {
      operation: z.enum(['bulk-create', 'bulk-update', 'bulk-delete', 'bulk-set-bucket']),
      // Bulk operation fields
      taskIds: z.array(z.number()).optional(),
      field: z
        .string()
        .optional()
        .describe(
          "The task field to bulk-update, e.g. 'due_date', 'start_date', 'end_date', " +
            "'priority', 'percent_done', 'done', 'project_id', 'assignees', 'labels', " +
            "'repeat_after', 'repeat_mode'.",
        ),
      value: z
        .unknown()
        .optional()
        .describe(
          "The new value for 'field'. For due_date/start_date/end_date, a RFC3339/ISO 8601 " +
            'date-time (e.g., 2024-05-24T10:00:00Z) or a date-only value (e.g., 2024-05-24), ' +
            'which is normalized to midnight UTC before being sent to Vikunja. For ' +
            'percent_done, a whole percentage 0-100 (75 = 75%, 100 = done) — the same scale ' +
            'as percentDone everywhere else on this tool surface; 0.75 is rejected.',
        ),
      projectId: z.number().optional(), // Add projectId for bulk-create; also optional override for bulk-set-bucket
      // bulk-set-bucket fields
      bucketId: z.coerce.number().optional(),
      viewId: z.coerce.number().optional(),
      tasks: z
        .array(
          strictNestedObject(
            {
              title: z.string(),
              description: z.string().optional(),
              dueDate: z
                .string()
                .optional()
                .describe(
                  'RFC3339/ISO 8601 date-time (e.g., 2024-05-24T10:00:00Z). A date-only value ' +
                    '(e.g., 2024-05-24) is also accepted and normalized to midnight UTC before ' +
                    'being sent to Vikunja.',
                ),
              startDate: z
                .string()
                .optional()
                .describe(
                  'RFC3339/ISO 8601 date-time (e.g., 2024-05-24T10:00:00Z). A date-only value ' +
                    '(e.g., 2024-05-24) is also accepted and normalized to midnight UTC before ' +
                    'being sent to Vikunja.',
                ),
              endDate: z
                .string()
                .optional()
                .describe(
                  'RFC3339/ISO 8601 date-time (e.g., 2024-05-24T10:00:00Z). A date-only value ' +
                    '(e.g., 2024-05-24) is also accepted and normalized to midnight UTC before ' +
                    'being sent to Vikunja.',
                ),
              priority: z.number().min(0).max(5).optional(),
              // Whole percentage 0-100 (25 = 25%), converted to Vikunja's 0-1
              // wire fraction in createOneBulkTask — see the percentDone note in
              // src/tools/tasks/index.ts and src/utils/percent-done.ts.
              percentDone: percentDoneSchema.describe(
                'Completion progress as a whole percentage between 0 and 100 (25 = 25%, ' +
                  '100 = done). Must be an integer — 0.5 is rejected, not silently read as ' +
                  'half a percent.',
              ),
              labels: z.array(z.number()).optional(),
              assignees: z.array(z.number()).optional(),
              repeatAfter: z.number().min(0).optional(),
              repeatMode: z.enum(['day', 'week', 'month', 'year']).optional(),
            },
            'a bulk-create task',
            'projectId is a TOP-LEVEL argument, not a per-task one. Fields with no bulk-create ' +
              'equivalent (done, hexColor, position, bucketId) belong on vikunja_tasks — ' +
              'bulk-create the tasks here, then use vikunja_tasks update / set-bucket / ' +
              'set-position, or vikunja_task_bulk bulk-update / bulk-set-bucket.',
          ),
        )
        .optional(),
    },
    getToolAnnotations('vikunja_task_bulk'),
    async (args) => {
      try {
        logger.debug('Executing task bulk operations tool', {
          operation: args.operation,
          taskCount: args.tasks?.length || args.taskIds?.length,
        });

        // Check authentication (closure-gate precedence fix: defer to the
        // per-request context when bound — see hasRequestContext's doc
        // comment, src/client.ts)
        if (hasRequestContext()) {
          await getAuthManagerFromContext();
        } else if (!authManager.isAuthenticated()) {
          throw createAuthRequiredError('access task bulk operations');
        }

        assertWriteAllowed('vikunja_task_bulk', args.operation);

        // Set the client factory for this request if provided
        if (clientFactory) {
          await setGlobalClientFactory(clientFactory);
        }

        // Test client connection
        await getAuthManagerFromContext();

        switch (args.operation) {
          case 'bulk-create': {
            const { bulkCreateTasks } = await import('./tasks/bulk-operations.js');
            // Filter out undefined values for type safety
            if (!args.projectId) {
              throw new MCPError(
                ErrorCode.VALIDATION_ERROR,
                'projectId is required for bulk create operations',
              );
            }
            const filteredTasks = (args.tasks || []).map(toBulkCreateTaskData);

            const filteredArgs = {
              projectId: args.projectId,
              tasks: filteredTasks,
            };
            return bulkCreateTasks(filteredArgs, authManager);
          }

          case 'bulk-update': {
            const { bulkUpdateTasks } = await import('./tasks/bulk-operations.js');
            // Filter out undefined values for type safety
            if (!args.field) {
              throw new MCPError(
                ErrorCode.VALIDATION_ERROR,
                'field is required for bulk update operations',
              );
            }
            const filteredArgs = {
              taskIds: args.taskIds || [],
              field: args.field,
              value: args.value,
            };
            return bulkUpdateTasks(filteredArgs, authManager);
          }

          case 'bulk-delete': {
            const { bulkDeleteTasks } = await import('./tasks/bulk-operations.js');
            // Filter out undefined values for type safety
            const filteredArgs = {
              taskIds: args.taskIds || [],
            };
            return bulkDeleteTasks(filteredArgs, authManager);
          }

          case 'bulk-set-bucket': {
            const { bulkSetTaskBucket } = await import('./tasks/buckets.js');
            if (args.bucketId === undefined || args.bucketId === null) {
              throw new MCPError(
                ErrorCode.VALIDATION_ERROR,
                'bucketId is required for bulk-set-bucket operation',
              );
            }
            const filteredArgs = {
              taskIds: args.taskIds || [],
              bucketId: args.bucketId,
              ...(args.viewId !== undefined && { viewId: args.viewId }),
              ...(args.projectId !== undefined && { projectId: args.projectId }),
            };
            return bulkSetTaskBucket(filteredArgs, authManager);
          }

          default:
            throw new MCPError(
              ErrorCode.VALIDATION_ERROR,
              `Unknown operation: ${String(args.operation)}`,
            );
        }
      } catch (error) {
        if (error instanceof MCPError) {
          throw error;
        }
        throw new MCPError(
          ErrorCode.INTERNAL_ERROR,
          `Task bulk operation error: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
  );
}
