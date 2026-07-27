/**
 * Simple Response Types
 * Replaces over-engineered AORP system with clean response types
 */

import type { components } from './generated/vikunja-openapi';

/** `models.Task` per the OpenAPI spec — task shape carried in responses. */
type Task = components['schemas']['models.Task'];

/**
 * Task-specific response data structure
 * Provides type safety for task operation responses
 */
export interface TaskResponseData {
  /** Single task object (for create, get, update operations) */
  task?: Task;
  /** Array of tasks (for list operations) */
  tasks?: Task[];
  /** Deleted task ID (for delete operations when task not found) */
  deletedTaskId?: number;
  /** Additional operation-specific data */
  [key: string]: unknown;
}

/**
 * Task-specific response metadata
 * Extends standard metadata with task-specific fields
 */
export interface TaskResponseMetadata {
  /** ISO timestamp of when the operation was performed */
  timestamp: string;
  /** Number of items affected/returned */
  count?: number;
  /** Project ID for task operations */
  projectId?: number;
  /** Task ID for single task operations */
  taskId?: number;
  /** Fields that were modified (for update operations) */
  affectedFields?: string[];
  /** Previous state before update (for update operations) */
  previousState?: Partial<Task>;
  /** Whether labels were successfully added */
  labelsAdded?: boolean;
  /** Whether assignees were successfully added */
  assigneesAdded?: boolean;
  /** Task title for reference */
  taskTitle?: string;
  /** Session ID for AORP tracking */
  sessionId?: string;
  /** Additional context-specific metadata */
  [key: string]: unknown;
}

/**
 * Quality indicator data structure
 * Used by AORP quality assessment functions
 */
export interface QualityIndicatorData {
  /** Task object for quality assessment */
  task?: Task;
  /** Additional data for quality calculations */
  [key: string]: unknown;
}

/**
 * Quality indicator function type
 * Functions that calculate quality scores from task data
 */
export type QualityIndicatorFunction = (data: unknown, context: {
  operation: string;
  success: boolean;
  dataSize: number;
  processingTime: number;
  complexity?: number;
  cacheHit?: boolean;
  [key: string]: unknown;
}) => number;

/**
 * Standard metadata included in all responses
 * Now AORP-compatible
 */
export interface ResponseMetadata {
  /** ISO timestamp of when the operation was performed */
  timestamp?: string;
  /** Number of items affected/returned */
  count?: number;
  /** Fields that were modified (for update operations) */
  affectedFields?: string[];
  /** Previous state (for update operations) */
  previousState?: Record<string, unknown>;
  /** Session ID for AORP tracking */
  sessionId?: string;
  /** Success flag */
  success?: boolean;
  /** Operation context */
  operation?: string;
  /** Error information */
  error?: {
    code: string;
    message: string;
  };
  /** Additional context-specific metadata */
  [key: string]: unknown;
}

// `StandardErrorResponse` and its `createErrorResponse` factory used to live
// here. Nothing imported either — the live error path is
// `utils/simple-response.ts`'s `createErrorResponse`, re-exported through this
// barrel — so they were removed rather than retro-fitted with tests (CLAUDE.md:
// untestable/unreachable code goes).
