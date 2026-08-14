/**
 * Task Labels Tool
 * Handles task label operations: apply-label, remove-label, list-labels
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
import { applyLabels, removeLabels, listTaskLabels } from '../tools/tasks/labels';
import { assertWriteAllowed, getToolAnnotations, withReadOnlyNote } from '../utils/read-only';

/**
 * Register task labels tool
 */
export function registerTaskLabelsTool(
  server: McpServer,
  authManager: AuthManager,
  clientFactory?: VikunjaClientFactory,
): void {
  server.tool(
    'vikunja_task_labels',
    withReadOnlyNote(
      'vikunja_task_labels',
      'Manage task labels: apply, remove, list labels. remove-label/list-labels take label IDs. ' +
        'apply-label takes label IDs (`labels`) AND/OR label titles (`labelTitles`) — to attach a ' +
        'label by name, just pass `labelTitles`: each title is get-or-created and attached in ONE ' +
        'call, no separate lookup needed. ' +
        'apply-label and remove-label both operate on MULTIPLE tasks in one call via `taskIds` ' +
        '(instead of `id`) — label titles are resolved ONCE for the whole call and reused across ' +
        'every task, and results are reported per-task (a partial failure is never reported as a ' +
        'clean success). Provide exactly one of `id` (single task) or `taskIds` (multiple tasks); ' +
        'supplying both is rejected.',
    ),
    {
      operation: z.enum(['apply-label', 'remove-label', 'list-labels']),
      // Task and label identification. Exactly one of `id`/`taskIds` is
      // required by apply-label/remove-label (list-labels uses `id` only).
      id: z
        .number()
        .optional()
        .describe(
          'The task id, for a single-task apply-label/remove-label/list-labels call. ' +
            'apply-label/remove-label also accept `taskIds` (an array) to operate on multiple ' +
            'tasks in one call instead — provide exactly one of `id` or `taskIds`.',
        ),
      taskIds: z
        .array(z.number())
        .optional()
        .describe(
          'apply-label/remove-label only: task ids to apply/remove the same label(s) to/from ' +
            'in ONE call. Use this instead of `id` when targeting more than one task — label ' +
            'titles (`labelTitles`) are resolved once and reused across every task. Provide ' +
            'exactly one of `id` or `taskIds`; supplying both is rejected.',
        ),
      labels: z.array(z.number()).optional(),
      // apply-label only: label titles to get-or-create-then-attach, merged
      // with `labels` (deduped) — see src/utils/label-ensure.ts.
      labelTitles: z.array(z.string().min(1)).optional(),
    },
    getToolAnnotations('vikunja_task_labels'),
    async (args) => {
      try {
        logger.debug('Executing task labels tool', {
          operation: args.operation,
          taskId: args.id,
          taskIdCount: args.taskIds?.length,
          labelCount: args.labels?.length,
        });

        // Check authentication (closure-gate precedence fix: defer to the
        // per-request context when bound — see hasRequestContext's doc
        // comment, src/client.ts)
        if (hasRequestContext()) {
          await getAuthManagerFromContext();
        } else if (!authManager.isAuthenticated()) {
          throw createAuthRequiredError('access task label operations');
        }

        assertWriteAllowed('vikunja_task_labels', args.operation);

        // Set the client factory for this request if provided
        if (clientFactory) {
          await setGlobalClientFactory(clientFactory);
        }

        // Test client connection
        await getAuthManagerFromContext();

        switch (args.operation) {
          case 'apply-label':
            return applyLabels(
              {
                id: args.id,
                taskIds: args.taskIds,
                labels: args.labels || [],
                labelTitles: args.labelTitles || [],
              },
              authManager,
            );

          case 'remove-label':
            return removeLabels(
              {
                id: args.id,
                taskIds: args.taskIds,
                labels: args.labels || [],
              },
              authManager,
            );

          case 'list-labels':
            return listTaskLabels(args, authManager);

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
          `Task label operation error: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
  );
}
