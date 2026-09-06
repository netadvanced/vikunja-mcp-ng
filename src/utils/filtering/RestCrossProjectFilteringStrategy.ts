/**
 * REST cross-project filtering strategy
 *
 * Vikunja documents a single-call `GET /tasks` endpoint for listing tasks
 * across every project the user can access, with `page`, `per_page`, `s`,
 * `sort_by`, `order_by`, `filter`, `filter_timezone`, `filter_include_nulls`
 * and `expand` query params (see docs/vikunja-openapi.json). Neither
 * the legacy client's `getAllTasks` (which calls the non-existent `GET
 * /tasks/all`, confirmed to 400 "Invalid model provided" on real servers —
 * see `ClientSideFilteringStrategy`) nor any other code path in this
 * project ever called the real endpoint.
 *
 * This strategy calls `GET /tasks` directly via `requestTaskListPage`
 * (`../vikunja-task-reads`, which picks the v1 or v2 transport per
 * `resolveApiVersion` and asks v2 for markdown descriptions) and is
 * the PRIMARY strategy for cross-project ("all projects" or no `projectId`)
 * listing — one call instead of an N+1 per-project aggregation. If the
 * direct call fails for any reason (older server without the endpoint, the
 * circuit breaker open, a transient network error surviving retries, etc.)
 * it falls back to the existing per-project aggregation
 * (`ClientSideFilteringStrategy`, which itself applies `filterExpression`
 * client-side), kept as the documented fallback per
 * docs/ENDPOINT-PLAYBOOK.md's hybrid pattern — the fallback matters if some
 * server versions reject `GET /tasks`.
 *
 * Single-project listing is untouched by this strategy: it is only selected
 * by `FilteringContext` when the listing is cross-project.
 *
 * PAGINATION (issue #268 / audit CRIT-7). This used to issue exactly one
 * request; see `./pagination`'s doc comment for why the single silent
 * request was a bug and how the multi-page walk terminates.
 */

import type { TaskFilteringStrategy } from './TaskFilteringStrategy';
import type { FilteringParams, FilteringResult, VikunjaTask } from './types';
import { ClientSideFilteringStrategy } from './ClientSideFilteringStrategy';
import { MCPError, ErrorCode } from '../../types';
import { logger } from '../logger';
import {
  createBudget,
  DEFAULT_SERVER_PAGE_CAP,
  fetchAllPages,
  readServerPageCap,
} from './pagination';
import { requestTaskListPage } from '../vikunja-task-reads';

/**
 * The `GET /tasks` / `GET /projects/{id}/tasks` query builder now lives in
 * `../vikunja-task-reads` next to its v2 spelling (which renames `s` to `q` and
 * adds `format=markdown`). Re-exported here so the modules that have always
 * imported it from this file keep working.
 */
export { buildTasksListQuery } from '../vikunja-task-reads';

export class RestCrossProjectFilteringStrategy implements TaskFilteringStrategy {
  async execute(params: FilteringParams): Promise<FilteringResult> {
    const { authManager, filterString, args, params: apiParams } = params;

    if (!authManager) {
      // Programmer error: FilteringContext must only select this strategy
      // when an authManager was threaded through from the tool handler.
      throw new MCPError(
        ErrorCode.INTERNAL_ERROR,
        'RestCrossProjectFilteringStrategy requires an authManager',
      );
    }

    // Paginate only when the caller expressed no pagination intent of their
    // own — `FilterExecutor.prepareQueryParameters` synthesises
    // `per_page: 1000, page: 1` when neither `page` nor `perPage` was
    // supplied, which is precisely the "give me everything" case Vikunja's
    // `maxitemsperpage` clamp silently truncated (issue #268 / CRIT-7).
    const autoPaginate = args.perPage === undefined && args.page === undefined;
    const firstPage = Math.max(1, apiParams.page ?? 1);
    const cap = readServerPageCap(authManager) ?? DEFAULT_SERVER_PAGE_CAP;
    const budget = createBudget();

    const requestPage = async (page: number): Promise<VikunjaTask[]> => {
      const pageApiParams = page === firstPage ? apiParams : { ...apiParams, page };
      // Version-aware since #184 P3 step 3: on a v2-capable server this reads
      // `GET /api/v2/tasks?...&format=markdown` instead, which is the only
      // caller-visible difference (descriptions arrive as markdown). The
      // envelope is unwrapped by the transport's normalizer, and `s` is
      // renamed to `q` inside the v2 query builder.
      return requestTaskListPage(authManager, '/tasks', pageApiParams, filterString, args);
    };

    try {
      logger.info('Attempting cross-project task listing via direct REST GET /tasks', {
        filter: filterString,
        autoPaginate,
      });

      const safeTasks = await fetchAllPages(requestPage, {
        autoPaginate,
        firstPage,
        budget,
        cap,
        resourceLabel: 'GET /tasks',
      });

      logger.info('Direct REST GET /tasks succeeded for cross-project listing', {
        taskCount: safeTasks.length,
      });

      const metadata: FilteringResult['metadata'] = {
        serverSideFilteringUsed: Boolean(filterString),
        serverSideFilteringAttempted: true,
        clientSideFiltering: false,
        filteringNote: filterString
          ? 'Server-side filtering used via direct REST GET /tasks'
          : 'Cross-project listing via direct REST GET /tasks (single call, no per-project aggregation)',
      };

      if (budget.truncated || budget.warnings.length > 0) {
        metadata.resultComplete = false;
        metadata.warnings = budget.warnings;
        metadata.filteringNote = `${metadata.filteringNote} — INCOMPLETE: ${budget.warnings.join(' ')}`;
        logger.warn('Direct REST GET /tasks pagination returned an incomplete result', {
          warnings: budget.warnings,
          filter: filterString,
        });
      }

      return { tasks: safeTasks, metadata };
    } catch (error) {
      // An `expand` value the API token has no scope for (Vikunja >= 2.6.0)
      // must NOT fall back (issue #254, item A1). Falling back would cost a
      // full per-project aggregation and end in the same refusal, since the
      // fallback now forwards `expand` too (#184 P3 step 7) — so failing
      // here is the same answer, immediately, with the scope diagnosis
      // intact.
      //
      // Before that step the fallback dropped `expand` entirely, which was
      // worse still: the caller got a perfectly successful task list quietly
      // missing the very data they asked to expand. Verified live against
      // 2.6.0 at the time: a narrow `tk_*` token requesting expand=comments
      // came back 200 with no `comments` key on any task. Nothing downstream
      // could tell "expanded and empty" from "never expanded".
      if (error instanceof MCPError && error.details?.insufficientScope === true) {
        logger.warn('Direct REST GET /tasks refused an expand value for lack of token scope', {
          filter: filterString,
          expand: args.expand,
        });
        throw error;
      }

      logger.warn(
        'Direct REST GET /tasks failed for cross-project listing, falling back to per-project aggregation',
        {
          error: error instanceof Error ? error.message : String(error),
          filter: filterString,
        },
      );

      const fallbackResult = await new ClientSideFilteringStrategy().execute(params);

      // Carry the server's own reason forward instead of a generic "failed":
      // the reported bugs were both diagnosable ONLY from that message
      // (`4019 ... value '2026-08-16 00:00:00' for field 'created' is
      // invalid`, `4019 ... value 'HU' for field 'labels' is invalid`), and
      // swallowing it is what made a broken filter look like an empty one.
      const reason = error instanceof Error ? error.message : String(error);
      const baseNote = `Direct REST GET /tasks failed (${reason}); used per-project aggregation fallback`;
      const fallbackWarnings = fallbackResult.metadata.warnings ?? [];

      return {
        ...fallbackResult,
        metadata: {
          ...fallbackResult.metadata,
          serverSideFilteringAttempted: true,
          filteringNote:
            fallbackWarnings.length > 0
              ? `${baseNote} — INCOMPLETE: ${fallbackWarnings.join(' ')}`
              : baseNote,
        },
      };
    }
  }
}
