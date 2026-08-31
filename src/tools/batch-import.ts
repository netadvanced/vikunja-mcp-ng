import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AuthManager } from '../auth/AuthManager';
import type { VikunjaClientFactory } from '../client/VikunjaClientFactory';
import { getAuthManagerFromContext, hasRequestContext } from '../client';
import { logger } from '../utils/logger';
import { MCPError, ErrorCode } from '../types';
import { parseInputData } from '../parsers/InputParserFactory';
import { EntityResolver } from '../services/EntityResolver';
import { TaskCreationService } from '../services/TaskCreationService';
import {
  BatchImportResponseFormatter,
  type ImportResult,
} from '../formatters/BatchImportResponseFormatter';
import { assertWriteAllowed, getToolAnnotations, withReadOnlyNote } from '../utils/read-only';

const MAX_BATCH_SIZE = 100;

/* ===================================================================
 * BATCH IMPORT ORCHESTRATION
 * Main tool registration and orchestration layer for batch task import
 * =================================================================== */

export function registerBatchImportTool(
  server: McpServer,
  authManager: AuthManager,
  _clientFactory?: VikunjaClientFactory,
): void {
  server.tool(
    'vikunja_batch_import',
    withReadOnlyNote(
      'vikunja_batch_import',
      'Import tasks in bulk from CSV or JSON formats with error handling and dry-run support',
    ),
    {
      projectId: z.number(),
      format: z.enum(['csv', 'json']),
      data: z.string(),
      skipErrors: z.boolean().optional(),
      dryRun: z.boolean().optional(),
    },
    getToolAnnotations('vikunja_batch_import'),
    async (args) => {
      try {
        logger.debug('Executing batch import', {
          projectId: args.projectId,
          format: args.format,
          skipErrors: args.skipErrors,
          dryRun: args.dryRun,
        });

        // Authentication check (closure-gate precedence fix: defer to the
        // per-request context when bound — see hasRequestContext's doc
        // comment, src/client.ts)
        if (hasRequestContext()) {
          await getAuthManagerFromContext();
        } else if (!authManager.isAuthenticated()) {
          throw new MCPError(
            ErrorCode.AUTH_REQUIRED,
            'Authentication required. Please use vikunja_auth.connect first.',
          );
        }

        // No subcommand field on this single-purpose tool — 'import' is
        // its fixed classification-table key. dryRun never writes to
        // Vikunja, so it is exempt from read-only mode.
        assertWriteAllowed('vikunja_batch_import', 'import', args.dryRun ? 'read' : undefined);

        const responseFormatter = new BatchImportResponseFormatter();

        // Parse input data
        const parseOptions = {
          format: args.format,
          data: args.data,
          ...(args.skipErrors !== undefined && { skipErrors: args.skipErrors }),
        };

        const tasks = parseInputData(parseOptions);

        // Validate tasks
        if (tasks.length === 0) {
          throw new MCPError(ErrorCode.VALIDATION_ERROR, 'No valid tasks found to import');
        }

        if (tasks.length > MAX_BATCH_SIZE) {
          throw new MCPError(
            ErrorCode.VALIDATION_ERROR,
            `Batch size exceeds maximum limit of ${MAX_BATCH_SIZE} tasks. Please split your import into smaller batches.`,
          );
        }

        // Handle dry run
        if (args.dryRun) {
          return {
            content: [
              {
                type: 'text',
                text: `Validation successful. ${tasks.length} tasks ready to import.`,
              },
            ],
          };
        }

        // Initialize services
        const entityResolver = new EntityResolver();
        const taskCreationService = new TaskCreationService();

        // Resolve entities (labels and users). GET /users is a *search*
        // endpoint per the OpenAPI spec (see EntityResolver.fetchUsers), so
        // rather than one parameter-less "list everyone" call, gather every
        // unique username actually referenced by this batch's assignees and
        // search for each one individually.
        const assigneeUsernames = Array.from(
          new Set(tasks.flatMap((task) => task.assignees ?? [])),
        );
        const entityResult = await entityResolver.resolveEntities(authManager, assigneeUsernames);
        const { userFetchFailedDueToAuth } = entityResult;

        // Process tasks
        const result: ImportResult = {
          success: 0,
          failed: 0,
          errors: [],
          createdTasks: [],
        };
        // Computed up front (not just for the final response) so a
        // mid-batch abort can also format an accurate partial summary.
        const hasAssignees = tasks.some((t) => t.assignees && t.assignees.length > 0);

        for (let i = 0; i < tasks.length; i++) {
          const task = tasks[i];
          if (!task) continue;

          try {
            const creationResult = await taskCreationService.createTask(
              task,
              args.projectId,
              authManager,
              entityResult,
              args.skipErrors === true,
            );

            if (creationResult.success) {
              result.success++;
              if (creationResult.taskId) {
                result.createdTasks.push({
                  id: creationResult.taskId,
                  title: creationResult.title,
                });
              }

              if (creationResult.warnings?.length) {
                if (!result.warnings) result.warnings = [];
                creationResult.warnings.forEach((warning) => {
                  (result.warnings || []).push({
                    taskId: creationResult.taskId || 0,
                    title: creationResult.title,
                    warning,
                  });
                });
              }
            } else {
              result.failed++;
              result.errors.push({
                index: i,
                title: task.title,
                error: creationResult.error || 'Unknown error',
              });
            }
          } catch (error) {
            result.failed++;
            result.errors.push({
              index: i,
              title: task.title,
              error: error instanceof Error ? error.message : 'Unknown error',
            });

            if (!args.skipErrors) {
              // Abort. `result` at this point may already hold tasks that
              // WERE created before this failure — discarding it here (the
              // old behavior) meant the response never mentioned them,
              // inviting a retry that duplicates every task that did land.
              // Fold the partial result into the thrown error's message
              // instead, and let it propagate as a genuine failure (caught
              // below, rethrown) so this surfaces as isError:true like every
              // other tool on this server does — batch-import used to be the
              // one exception, converting every error into plain
              // success-shaped content instead (issue #269 CRIT-8).
              const partialSummary = responseFormatter.formatResult(
                result,
                userFetchFailedDueToAuth,
                hasAssignees,
              );
              throw new MCPError(
                ErrorCode.API_ERROR,
                `Batch import aborted: ${error instanceof Error ? error.message : String(error)}\n\n${partialSummary}`,
              );
            }
          }
        }

        // Format and return response
        const responseText = responseFormatter.formatResult(
          result,
          userFetchFailedDueToAuth,
          hasAssignees,
        );

        return {
          content: [
            {
              type: 'text',
              text: responseText,
            },
          ],
        };
      } catch (error) {
        // Matches this codebase's standard tool error-handling pattern (see
        // CLAUDE.md "Error Handling Pattern"): re-throw our own MCPErrors
        // as-is, wrap anything else. Previously this converted EVERY error
        // — including a genuine mid-batch abort — into plain
        // success-shaped MCP content with no `isError`, unlike every other
        // tool on this server (issue #269 CRIT-8). Letting it throw here
        // instead means the MCP SDK marks the response `isError: true`, so
        // a caller checking that flag (rather than pattern-matching the
        // text) correctly sees the import did not fully succeed.
        if (error instanceof MCPError) {
          throw error;
        }

        logger.error('Batch import error', {
          error: error instanceof Error ? error.stack : String(error),
          message: error instanceof Error ? error.message : 'Unknown error',
        });

        throw new MCPError(
          ErrorCode.API_ERROR,
          `Failed to import tasks: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
  );
}
