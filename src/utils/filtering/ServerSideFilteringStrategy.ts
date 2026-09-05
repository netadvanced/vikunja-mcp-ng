/**
 * Server-side filtering strategy
 *
 * This strategy attempts to use Vikunja's server-side filtering capabilities
 * by passing filter parameters directly to the API. This is the most efficient
 * approach when the server supports advanced filtering.
 */

import type { TaskFilteringStrategy } from './TaskFilteringStrategy';
import type { FilteringParams, FilteringResult, VikunjaTask } from './types';
import { vikunjaRestRequest } from '../vikunja-rest';
import { validateId } from '../../tools/tasks/validation';
import { logger } from '../logger';
import { MCPError, ErrorCode } from '../../types';
import { buildTasksListQuery } from './RestCrossProjectFilteringStrategy';
import {
  createBudget,
  DEFAULT_SERVER_PAGE_CAP,
  fetchAllPages,
  readServerPageCap,
} from './pagination';

export class ServerSideFilteringStrategy implements TaskFilteringStrategy {
  async execute(params: FilteringParams): Promise<FilteringResult> {
    const { args, filterString, params: apiParams, authManager } = params;

    if (!filterString) {
      throw new MCPError(
        ErrorCode.VALIDATION_ERROR,
        'Server-side filtering requires a filter string',
      );
    }

    if (!authManager) {
      // Programmer error: FilteringContext must only select this strategy
      // (via HybridFilteringStrategy) when an authManager was threaded
      // through from the tool handler.
      throw new MCPError(
        ErrorCode.INTERNAL_ERROR,
        'ServerSideFilteringStrategy requires an authManager',
      );
    }

    const singleProject = args.projectId !== undefined && !args.allProjects;

    logger.info('Attempting server-side filtering', {
      filter: filterString,
      endpoint: singleProject ? 'getProjectTasks' : 'getAllTasks',
    });

    // Only the single-project branch below paginates (issue #268 / CRIT-7):
    // the `else` branch calls the non-existent, confirmed-unreachable
    // `GET /tasks/all` path (see its own comment) that `FilteringContext`
    // never routes a real cross-project listing through, so there is no
    // truncation exposure there to fix.
    const budget = createBudget();

    try {
      let tasks: VikunjaTask[];

      if (singleProject && args.projectId !== undefined) {
        // Validate project ID
        validateId(args.projectId, 'projectId');
        const projectId = args.projectId;

        // Paginate only when the caller expressed no pagination intent of
        // their own — see `./pagination`'s doc comment for the termination
        // rule. Without this, a single `per_page=1000` request silently
        // covered only the first `service.maxitemsperpage` (default 50)
        // tasks of a larger project (issue #268 / CRIT-7).
        const autoPaginate = args.perPage === undefined && args.page === undefined;
        const firstPage = Math.max(1, apiParams.page ?? 1);
        const cap = readServerPageCap(authManager) ?? DEFAULT_SERVER_PAGE_CAP;

        // Get tasks for specific project with server-side filter. Calls the
        // same `GET /projects/{id}/tasks` path the legacy client's
        // `getProjectTasks` used pre-migration — a literal call-site
        // migration, not an endpoint redesign (see
        // ClientSideFilteringStrategy's `fetchProjectTasks` doc comment for
        // why the spec's `get?: never` at this path doesn't block reusing it
        // here).
        const requestPage = async (page: number): Promise<VikunjaTask[]> => {
          const pageApiParams = page === firstPage ? apiParams : { ...apiParams, page };
          const query = buildTasksListQuery(pageApiParams, filterString, {});
          const path = `/projects/${projectId}/tasks${query ? `?${query}` : ''}`;
          const result = await vikunjaRestRequest<VikunjaTask[]>(authManager, 'GET', path);
          return Array.isArray(result) ? result : [];
        };

        tasks = await fetchAllPages(requestPage, {
          autoPaginate,
          firstPage,
          budget,
          cap,
          resourceLabel: `Project ${projectId}`,
        });
      } else {
        // Get all tasks across all projects with server-side filter. Calls
        // the same (non-existent, confirmed 400 "Invalid model provided" on
        // real servers) `GET /tasks/all` path the legacy client's `getAllTasks`
        // used pre-migration. This branch is unreachable in production —
        // `FilteringContext` always routes cross-project listings through
        // `RestCrossProjectFilteringStrategy` (real `GET /tasks`) before
        // this strategy is ever selected — but the literal call-site
        // migration is preserved rather than silently redirected to a
        // different, working endpoint, per this item's byte-compatible
        // refactor-not-redesign scope.
        const query = buildTasksListQuery(apiParams, filterString, {});
        const path = `/tasks/all${query ? `?${query}` : ''}`;
        const result = await vikunjaRestRequest<VikunjaTask[]>(authManager, 'GET', path);
        tasks = Array.isArray(result) ? result : [];
      }

      logger.info('Server-side filtering completed successfully', {
        taskCount: tasks.length,
        filter: filterString,
      });

      const metadata: FilteringResult['metadata'] = {
        serverSideFilteringUsed: true,
        serverSideFilteringAttempted: true,
        clientSideFiltering: false,
        filteringNote: 'Server-side filtering used (modern Vikunja)',
      };

      if (budget.truncated || budget.warnings.length > 0) {
        metadata.resultComplete = false;
        metadata.warnings = budget.warnings;
        metadata.filteringNote = `${metadata.filteringNote} — INCOMPLETE: ${budget.warnings.join(' ')}`;
        logger.warn('Server-side filtering pagination returned an incomplete result', {
          warnings: budget.warnings,
          filter: filterString,
        });
      }

      return { tasks, metadata };
    } catch (error) {
      logger.error('Server-side filtering failed', {
        error: error instanceof Error ? error.message : String(error),
        filter: filterString,
      });

      // Re-throw the error to be handled by the calling code
      throw error;
    }
  }
}
