/**
 * Task-specific filtering type definitions
 * Extends the base filter types with task-specific functionality
 */

import type { FilterExpression, SavedFilter, FilterValidationConfig } from '../../../types/filters';
import type { AorpBuilderConfig } from '../../../types';
import type { SimpleFilterStorage } from '../../../storage';
import type { AuthManager } from '../../../auth/AuthManager';
import type { VikunjaTask, TaskListApiParams } from '../../../utils/filtering/types';

/** `models.Task` per the OpenAPI spec. */
type Task = VikunjaTask;
/** Query params shared by the task-listing endpoints. */
type GetTasksParams = TaskListApiParams;

/**
 * Arguments for filtering operations
 */
export interface FilteringArgs {
  projectId?: number;
  page?: number;
  perPage?: number;
  search?: string;
  sort?: string;
  filter?: string;
  filterId?: string;
  allProjects?: boolean;
  done?: boolean;
  /** GET /tasks `order_by` param. Only honored for cross-project listing (direct REST). */
  orderBy?: 'asc' | 'desc';
  /** GET /tasks `filter_timezone` param. Only honored for cross-project listing (direct REST). */
  filterTimezone?: string;
  /** GET /tasks `filter_include_nulls` param. Only honored for cross-project listing (direct REST). */
  filterIncludeNulls?: boolean;
  /** GET /tasks `expand` param (repeatable). Only honored for cross-project listing (direct REST). */
  expand?: string[];
}

/**
 * Parameters passed to filtering strategies
 */
export interface FilteringParams {
  args: FilteringArgs;
  filterExpression: FilterExpression | null;
  filterString: string | undefined;
  params: GetTasksParams;
  /** See `utils/filtering/types.ts`'s `FilteringParams.authManager` doc comment. */
  authManager?: AuthManager;
}

/**
 * Metadata about the filtering operation performed
 */
export interface FilteringMetadata {
  serverSideFilteringUsed: boolean;
  serverSideFilteringAttempted: boolean;
  clientSideFiltering: boolean;
  filteringNote: string;
  /**
   * `false` when the returned set is KNOWN to be a subset of what was asked
   * for — a per-project page budget was exhausted, or a project failed
   * mid-aggregation and was skipped. Absent/`true` means the listing is
   * believed complete for the requested page.
   *
   * This exists because the failure mode being fixed (issues #225/#227) was
   * never an exception — it was a plausible-looking answer. A caller asking
   * "what is tagged X so I know what to act on" must be able to tell "nothing
   * matched" from "here is part of the answer". Anything that sets this to
   * `false` MUST also explain itself in `warnings`, and the tool surface
   * renders it visibly rather than burying it in metadata.
   */
  resultComplete?: boolean;
  /**
   * Human-readable notes about anything that makes the result less than a
   * plain, complete success: truncation, skipped projects, a partially
   * resolved filter. Surfaced to the caller, not just logged.
   */
  warnings?: string[];
}

/**
 * Result of a filtering operation
 */
export interface FilteringResult {
  tasks: Task[];
  metadata: FilteringMetadata;
}

/**
 * Task listing arguments with filtering support
 */
export interface TaskListingArgs extends FilteringArgs {
  verbosity?: string;
  useOptimizedFormat?: boolean;
  useAorp?: boolean;
  aorpConfig?: AorpBuilderConfig;
  sessionId?: string;
}

/**
 * Enhanced filtering parameters for task operations
 */
export interface TaskFilteringParams extends FilteringParams {
  args: TaskListingArgs;
}

/**
 * Enhanced filtering result with task-specific metadata
 */
export type TaskFilteringResult = FilteringResult;

/**
 * Task filtering validation configuration
 */
export interface TaskFilterValidationConfig extends FilterValidationConfig {
  /** Enable memory usage validation */
  enableMemoryValidation?: boolean;
  /** Task count limit for validation */
  maxTaskCount?: number;
}

/**
 * Task filtering storage interface
 */
export interface TaskFilterStorage {
  list(): Promise<SavedFilter[]>;
  get(id: string): Promise<SavedFilter | null>;
  create(filter: Omit<SavedFilter, 'id' | 'created' | 'updated'>): Promise<SavedFilter>;
  update(
    id: string,
    filter: Partial<Omit<SavedFilter, 'id' | 'created' | 'updated'>>,
  ): Promise<SavedFilter>;
  delete(id: string): Promise<void>;
  findByName(name: string): Promise<SavedFilter | null>;
}

/**
 * Task filtering execution context
 */
export interface TaskFilteringContext {
  /** Vikunja API parameters */
  params: GetTasksParams;
  /** Filter expression if provided */
  filterExpression: FilterExpression | null;
  /** Raw filter string */
  filterString: string | undefined;
  /** Task listing arguments */
  args: TaskListingArgs;
  /** Storage interface for saved filters */
  storage: SimpleFilterStorage;
}

/**
 * Task filtering result with metadata
 */
export interface TaskFilterExecutionResult {
  /** Whether the filtering operation was successful */
  success: boolean;
  /** Filtered tasks */
  tasks: Task[];
  /** Filtering metadata */
  metadata: FilteringMetadata;
  /** Memory usage information */
  memoryInfo?: {
    actualCount: number;
    maxAllowed: number;
    estimatedMemoryMB: number;
  };
}
