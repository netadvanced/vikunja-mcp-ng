/**
 * Assignee response formatter service
 * Handles response formatting for assignee operations
 */

import type { StandardTaskResponse, ResponseMetadata, TaskWithAssignees } from '../../../types';
import { createStandardResponse } from '../../../types';
import { formatAorpAsMarkdown } from '../../../utils/response-factory';

/**
 * Service for formatting assignee operation responses
 */
export const AssigneeResponseFormatter = {
  /**
   * Format successful assign operation response
   */
  formatAssignResponse(task: TaskWithAssignees): StandardTaskResponse {
    return {
      success: true,
      operation: 'assign',
      message: 'Users assigned to task successfully',
      task: task,
      metadata: {
        timestamp: new Date().toISOString(),
        affectedFields: ['assignees'],
      },
    };
  },

  /**
   * Format successful unassign operation response
   */
  formatUnassignResponse(task: TaskWithAssignees): StandardTaskResponse {
    return {
      success: true,
      operation: 'unassign',
      message: 'Users removed from task successfully',
      task: task,
      metadata: {
        timestamp: new Date().toISOString(),
        affectedFields: ['assignees'],
      },
    };
  },

  /**
   * Format MCP response wrapper
   */
  formatMcpResponse(response: StandardTaskResponse): {
    content: Array<{ type: 'text'; text: string }>;
  } {
    // Create proper AORP response instead of casting StandardTaskResponse.
    // `success` MUST be carried through explicitly: createStandardResponse
    // (createTaskResponse in response-factory.ts) reads metadata.success to
    // decide whether to render the ✅/❌ header, defaulting to `true` when
    // it's absent. Without this, a caller that flips response.success to
    // false after formatAssignResponse (e.g. on a failed post-assign
    // verification) would have that failure silently dropped here and the
    // response would still render under a success header.
    const metadata: ResponseMetadata = {
      timestamp: response.metadata?.timestamp || new Date().toISOString(),
      success: response.success,
      ...(response.metadata?.count !== undefined ? { count: response.metadata.count } : {}),
      ...(response.metadata?.affectedFields
        ? { affectedFields: response.metadata.affectedFields }
        : {}),
      // Convert previousState to proper Record<string, unknown> if it exists
      ...(response.metadata?.previousState &&
      typeof response.metadata.previousState === 'object' &&
      response.metadata.previousState !== null
        ? { previousState: response.metadata.previousState as Record<string, unknown> }
        : {}),
    };

    const aorpResponse = createStandardResponse(
      response.operation || 'unknown',
      response.message || 'Operation completed',
      // StandardTaskResponse carries the generated `models.Task` (all fields
      // spec-optional); the formatter's `ResponseData` wants the local `Task`.
      // The formatter reads fields defensively, so narrow via the param type.
      response as unknown as Parameters<typeof createStandardResponse>[2],
      metadata,
    );

    return {
      content: [
        {
          type: 'text' as const,
          text: formatAorpAsMarkdown(aorpResponse), // Format AORP response as markdown
        },
      ],
    };
  },
};
