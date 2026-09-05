/**
 * Type definitions for the filtering strategy pattern
 */

import type { FilterExpression } from '../../types/filters';
import type { AuthManager } from '../../auth/AuthManager';
import type { components } from '../../types/generated/vikunja-openapi';

/** `models.Task` per the OpenAPI spec. */
export type VikunjaTask = components['schemas']['models.Task'];

/**
 * Query params shared by the task-listing endpoints (page/per_page/s/sort_by
 * plus the server-side `filter` string). Mirrors the legacy client's
 * `GetTasksParams` shape without depending on the (EOL) legacy client package.
 */
export interface TaskListApiParams {
  page?: number;
  per_page?: number;
  s?: string;
  sort_by?: string;
  filter?: string;
}

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
  /**
   * The documented GET /tasks `order_by` param ('asc' | 'desc', paired with
   * `sort_by`). Only honored by `RestCrossProjectFilteringStrategy` —
   * single-project listing (`ClientSideFilteringStrategy`/
   * `ServerSideFilteringStrategy`) never supported this param even
   * pre-migration, so it stays REST-cross-project-only to preserve exact
   * behavior.
   */
  orderBy?: 'asc' | 'desc';
  /** GET /tasks `filter_timezone` param. Same REST-only scope as `orderBy`. */
  filterTimezone?: string;
  /** GET /tasks `filter_include_nulls` param. Same REST-only scope as `orderBy`. */
  filterIncludeNulls?: boolean;
  /**
   * The `expand` param (repeatable), honored on BOTH listing shapes since
   * #184 P3 step 7 — unlike the three fields above. v1 accepts it on
   * `GET /tasks` and on `GET /projects/{id}/tasks`, verified live on 2.4.0,
   * 2.5.0 and 2.6.0; the only listing path that cannot carry it is
   * `ServerSideFilteringStrategy`'s unreachable `GET /tasks/all` branch,
   * which rejects it explicitly rather than dropping it.
   */
  expand?: string[];
}

/**
 * Parameters passed to filtering strategies
 */
export interface FilteringParams {
  args: FilteringArgs;
  filterExpression: FilterExpression | null;
  filterString: string | undefined;
  params: TaskListApiParams;
  /**
   * Active auth manager, required by strategies that call the direct-REST
   * helper (`RestCrossProjectFilteringStrategy`). Kept as its own field
   * rather than folded into `args` so that logging/debugging code that logs
   * `args` wholesale never accidentally serializes session credentials.
   */
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
  tasks: VikunjaTask[];
  metadata: FilteringMetadata;
}

/**
 * Configuration for strategy selection
 */
export interface StrategyConfig {
  enableServerSide: boolean;
  /**
   * True when the listing spans every accessible project (no `projectId`,
   * or `allProjects: true`). Cross-project listing always routes through
   * `RestCrossProjectFilteringStrategy` (direct REST GET /tasks, falling
   * back to per-project aggregation), regardless of `enableServerSide` —
   * the documented single-call endpoint is strictly better than the N+1
   * aggregation whether or not a filter is present.
   */
  crossProject?: boolean;
}

/**
 * Task filtering strategy interface
 */
export interface TaskFilteringStrategy {
  /**
   * Execute the filtering strategy
   * @param params - Filtering parameters
   * @returns Promise resolving to filtering result
   */
  execute(params: FilteringParams): Promise<FilteringResult>;
}
