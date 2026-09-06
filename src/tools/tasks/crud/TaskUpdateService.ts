/**
 * Task Update Service
 *
 * Validates the caller's arguments, reads the task once to build the diff the
 * response reports, then hands the actual write to whichever strategy this
 * session resolves to (see ./update/TaskUpdateContext). Everything from the
 * first write onwards — call count, ordering, request bodies — belongs to the
 * strategy, because v1 and v2 genuinely differ there; everything before and
 * after it is version-blind, so a caller cannot tell which one ran.
 */

import { MCPError, ErrorCode } from '../../../types';
import type { AuthManager } from '../../../auth/AuthManager';
import { validateDateString, validateHexColor, validateId } from '../validation';
import { sanitizeString } from '../../../utils/validation';
import { assertValidPercentDone } from '../../../utils/percent-done';
import {
  transformApiError,
  handleFetchError,
  handleStatusCodeError,
  wrapIfRestOrigin,
} from '../../../utils/error-handler';
import { createTaskResponse } from './TaskResponseFormatter';
import { formatAorpAsMarkdown } from '../../../utils/response-factory';
import { analyzeUpdateState } from './update/analysis';
import { TaskUpdateContext } from './update/TaskUpdateContext';
import type { UpdateTaskArgs } from './update/types';

export type { UpdateTaskArgs } from './update/types';

/**
 * Updates a task with comprehensive field diffing and relationship management
 */
export async function updateTask(
  args: UpdateTaskArgs,
  authManager: AuthManager,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  try {
    if (!args.id) {
      throw new MCPError(ErrorCode.VALIDATION_ERROR, 'Task id is required for update operation');
    }
    validateId(args.id, 'id');

    // Sanitize title/description the same way TaskCreationService does — previously this
    // service passed both straight through unsanitized, so `update` silently accepted
    // content that `create`/`create-subtask`/`bulk-create-subtasks` rejected (issue #226).
    // Mutating args in place so every downstream read (affected-field diffing in
    // analyzeUpdateState, the payload the strategy builds) sees the sanitized value.
    if (args.title !== undefined) {
      args.title = sanitizeString(args.title, 'title');
    }
    if (args.description !== undefined) {
      args.description = sanitizeString(args.description, 'description');
    }

    // Validate dates if provided
    if (args.dueDate) {
      validateDateString(args.dueDate, 'dueDate');
    }
    if (args.startDate) {
      validateDateString(args.startDate, 'startDate');
    }
    if (args.endDate) {
      validateDateString(args.endDate, 'endDate');
    }

    // percentDone is a whole percentage 0-100 on this tool surface. Guarded
    // here as well as in the Zod schema because updateTask is exported and
    // reachable from callers that never see the schema.
    if (args.percentDone !== undefined) {
      assertValidPercentDone(args.percentDone);
    }

    // `hexColor: ''` clears the colour, so this is an explicit undefined
    // check rather than a truthiness guard.
    if (args.hexColor !== undefined) {
      validateHexColor(args.hexColor);
    }

    // Validate project move target if provided
    if (args.projectId !== undefined) {
      validateId(args.projectId, 'projectId');
    }

    // Validate Kanban bucket move target if provided
    if (args.bucketId !== undefined) {
      validateId(args.bucketId, 'bucketId');
    }
    if (args.viewId !== undefined) {
      validateId(args.viewId, 'viewId');
    }

    // Analyze current state and track changes. Read once, on both paths: the
    // v1 strategy merges it into its full-model write, the v2 strategy never
    // sends it anywhere and only the response metadata below depends on it.
    const updateState = await analyzeUpdateState(authManager, args.id, args);

    // Apply the update. v1 fetch-merge-POST plus per-user assignee calls, or
    // v2's single PATCH with inline assignees — resolved per session.
    const context = new TaskUpdateContext(authManager);
    const completeTask = await context.execute({
      authManager,
      taskId: args.id,
      args,
      currentTask: updateState.currentTask,
    });

    // Verify project move actually stuck — Vikunja can report success while leaving
    // the task in the old project (silent failure → data loss if the old project is deleted)
    if (args.projectId !== undefined && completeTask.project_id !== args.projectId) {
      throw new MCPError(
        ErrorCode.API_ERROR,
        `Failed to move task ${args.id} to project ${args.projectId}: ` +
          `task remains in project ${completeTask.project_id ?? 'unknown'}. ` +
          `The move was not applied by Vikunja.`,
      );
    }

    const response = createTaskResponse(
      'update-task',
      'Task updated successfully',
      { task: completeTask },
      {
        timestamp: new Date().toISOString(),
        affectedFields: updateState.affectedFields,
        previousState: updateState.previousState,
        taskId: args.id,
      },
      undefined, // verbosity (ignored - using standard AORP)
      undefined, // useOptimizedFormat (ignored - using standard AORP)
      undefined, // useAorp (ignored - always using AORP)
      undefined, // aorpConfig (using auto-generated)
      args.sessionId,
    );

    return {
      content: [
        {
          type: 'text' as const,
          text: formatAorpAsMarkdown(response.response),
        },
      ],
    };
  } catch (error) {
    // A REST 404 is translated to the same friendly "not found" message the
    // pre-migration legacy client error path produced via handleStatusCodeError
    // (which keys off a bare `.statusCode` property, not the `.details`
    // nesting vikunjaRestRequest's thrown MCPError uses). Any other
    // REST-origin MCPError (label/assignee writes, the task-refresh GET —
    // all now throw MCPError directly via vikunjaRestRequest, unlike the
    // pre-migration legacy client) gets the conventional "Failed to update
    // task: ..." wrapping restored via wrapIfRestOrigin, preserving the
    // original code/details; this tool's own validation/internal MCPErrors
    // (no REST statusCode) still pass through unmodified. The v2 transport
    // builds the same message prefix on purpose, so a v2 PATCH failure is
    // wrapped identically to a v1 POST one.
    if (error instanceof MCPError) {
      if (error.details?.statusCode === 404 && args.id) {
        throw new MCPError(ErrorCode.NOT_FOUND, `Task with ID ${args.id} not found`);
      }
      throw wrapIfRestOrigin(error, 'update task');
    }

    // Handle fetch/connection errors with helpful guidance
    if (
      error instanceof Error &&
      (error.message.includes('fetch failed') ||
        error.message.includes('ECONNREFUSED') ||
        error.message.includes('ENOTFOUND'))
    ) {
      throw handleFetchError(error, 'update task');
    }

    // Use standardized error transformation for all other errors
    if (args.id) {
      throw handleStatusCodeError(
        error,
        'update task',
        args.id,
        `Task with ID ${args.id} not found`,
      );
    }
    throw transformApiError(error, 'Failed to update task');
  }
}
