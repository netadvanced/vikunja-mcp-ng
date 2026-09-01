/**
 * Client-side filtering strategy
 *
 * This strategy loads all tasks from the API and then applies filtering
 * logic on the client side. This is the traditional approach that works
 * with all versions of Vikunja but may be less efficient for large datasets.
 */

import type { TaskFilteringStrategy } from './TaskFilteringStrategy';
import type {
  FilteringArgs,
  FilteringParams,
  FilteringResult,
  TaskListApiParams,
  VikunjaTask,
} from './types';
import type { AuthManager } from '../../auth/AuthManager';
import { vikunjaRestRequest } from '../vikunja-rest';
import { MCPError, ErrorCode } from '../../types';
import { validateId } from '../../tools/tasks/validation';
import { applyFilter } from '../../tools/tasks/filtering';
import { getMaxTasksLimit } from '../memory';
import { logger } from '../logger';
import { buildTasksListQuery } from './RestCrossProjectFilteringStrategy';

/** `models.Project` per the OpenAPI spec — only the fields this module reads. */
interface VikunjaProjectSummary {
  id?: number;
  title?: string;
}

/**
 * A shared, mutable budget for one aggregation run: how many more tasks may
 * still be loaded before the memory bound (`VIKUNJA_MAX_TASKS_LIMIT`, via
 * `getMaxTasksLimit()`) is reached, and whether the bound has actually
 * clipped anything.
 *
 * The bound is deliberately the SAME limit `FilterValidator` /
 * `FilterExecutor` already validate loaded task counts against, rather than a
 * new per-strategy cap — one number, one env var, one documented knob.
 */
interface TaskLoadBudget {
  remaining: number;
  /** Set when the budget stopped a fetch that had more pages available. */
  truncated: boolean;
  /** Human-readable notes for anything that made the aggregate incomplete. */
  warnings: string[];
}

function createBudget(): TaskLoadBudget {
  return { remaining: getMaxTasksLimit(), truncated: false, warnings: [] };
}

/**
 * Hard ceiling on requests per project, so a server that keeps returning
 * full pages (or a pathological page size of 0) can never spin forever. With
 * Vikunja's default `service.maxitemsperpage` of 50 this still covers 25,000
 * tasks in a single project — far above the task-count budget that would
 * stop the loop first.
 */
const MAX_PAGES_PER_PROJECT = 500;

/**
 * The server's own `service.maxitemsperpage`, read from the cached `GET
 * /info` payload (`max_items_per_page`) when the session has one.
 *
 * Knowing the clamp turns "page 1 came back short" from ambiguous into
 * conclusive: short-of-the-clamp means the end of the collection, so the
 * common single-page project costs exactly ONE request again instead of one
 * extra probe page. Without it (no capabilities cached yet) the loop simply
 * probes one more page, which is correct but chattier.
 */
function readServerPageCap(authManager: AuthManager): number | undefined {
  const capabilities =
    typeof authManager.getCapabilities === 'function' ? authManager.getCapabilities() : undefined;
  const raw = capabilities?.features?.max_items_per_page;
  return typeof raw === 'number' && raw > 0 ? raw : undefined;
}

/**
 * Fetches a single project's tasks, FOLLOWING PAGINATION.
 *
 * Calls the same `GET /projects/{id}/tasks` path the legacy client's
 * `getProjectTasks` used pre-migration — this is a literal call-site
 * migration (legacy client -> `vikunjaRestRequest`), not an endpoint
 * redesign, so it is preserved even though `docs/vikunja-openapi.json` does
 * not document a GET method at this path (verified via `jq
 * '.paths["/projects/{id}/tasks"]'`) — the per-view `GET
 * /projects/{id}/views/{view}/tasks` endpoint the spec does document is a
 * different, wider-scoped migration (extra view-resolution round trip,
 * different Kanban response shape per docs/API_NOTES.md) left to a future
 * item rather than folded into this refactor.
 *
 * WHY IT PAGES (issue #225). This used to issue exactly one request with
 * `per_page=1000`. Vikunja clamps `per_page` to `service.maxitemsperpage`
 * (default **50** — confirmed in `GET /api/v1/info`'s `max_items_per_page`
 * on 2.4.0) and reports the real page size in `X-Pagination-Result-Count` /
 * `X-Pagination-Total-Pages`. A 193-task project therefore contributed its
 * first 50 tasks to the aggregate and silently dropped 143 — and the tasks a
 * date filter was looking for were among the dropped ones, with the response
 * still reporting success.
 *
 * Termination is page-size-based rather than header-based: `vikunjaRestRequest`
 * is the single choke point every REST call funnels through (circuit breaker
 * + retry) and it returns the parsed JSON body only, discarding headers. The
 * server's *effective* page size is whatever page 1 actually returned (NOT
 * what we asked for — that is the clamp), so the loop continues while each
 * page comes back exactly that full and stops on the first short or empty
 * page. That reaches the same answer as reading `x-pagination-total-pages`
 * without threading a second response shape through the shared transport.
 *
 * Paging is only automatic when the caller expressed no pagination intent of
 * their own (`autoPaginate`). A caller who asked for a specific `page`/
 * `perPage` gets exactly that page — silently returning every page to
 * somebody who asked for page 2 of 20 would be its own wrong answer.
 */
async function fetchProjectTasks(
  authManager: AuthManager,
  projectId: number,
  params: TaskListApiParams,
  options: {
    autoPaginate: boolean;
    budget: TaskLoadBudget;
    /**
     * True only for the cross-project aggregation call site
     * (`loadTasksAcrossProjects`), where N projects' single-request fetches
     * (the `!autoPaginate` branch below) run concurrently via `Promise.all`
     * and must therefore coordinate against the shared `budget` (issue #290
     * MED-19) rather than each independently fetching a full page and only
     * decrementing afterwards.
     *
     * False for the single-project call site in `execute()`: there is
     * exactly one fetch there, so there is no concurrent-overshoot race to
     * coordinate against, and a server that ignores `per_page` and returns
     * far more than requested is intentionally left for the existing
     * post-load hard limit in `FilterExecutor.executeFiltering` to catch
     * (`actualCount > maxAllowed * 1.5` -> throws) — silently clamping it
     * here instead would turn that into a silently-truncated success.
     */
    coordinateSingleRequestBudget?: boolean;
  },
  /**
   * `orderBy`/`filterTimezone`/`filterIncludeNulls` from the original
   * `FilteringArgs`, threaded through ONLY when this is the cross-project
   * fallback (`loadTasksAcrossProjects`) — see that function's doc comment
   * (issue #290 MED-7). The plain single-project call site below never
   * passes this, matching `FilteringArgs`'s documented REST-cross-project-
   * only scope for these fields.
   */
  extras: Pick<FilteringArgs, 'orderBy' | 'filterTimezone' | 'filterIncludeNulls'> = {},
): Promise<VikunjaTask[]> {
  const { autoPaginate, budget, coordinateSingleRequestBudget = false } = options;

  const requestPage = async (page: number | undefined): Promise<VikunjaTask[]> => {
    // Client-side filtering never sends `filter` server-side (that's the whole
    // point of this strategy) — apiParams never carries one for this code
    // path, but the query is built explicitly without it for clarity.
    const query = buildTasksListQuery(
      page === undefined ? params : { ...params, page },
      undefined,
      extras,
    );
    const path = `/projects/${projectId}/tasks${query ? `?${query}` : ''}`;
    const tasks = await vikunjaRestRequest<VikunjaTask[]>(authManager, 'GET', path);
    return Array.isArray(tasks) ? tasks : [];
  };

  if (!autoPaginate) {
    if (!coordinateSingleRequestBudget) {
      // Single call site, no concurrency to race — see the doc comment on
      // `coordinateSingleRequestBudget` above for why this intentionally
      // does not clamp.
      const single = await requestPage(undefined);
      budget.remaining -= single.length;
      return single;
    }

    // The cross-project aggregation path: every project's fetch here is a
    // single request, and `Promise.all` in `loadTasksAcrossProjects` fires
    // them all concurrently — so this branch must coordinate against the
    // SAME shared budget the auto-paginate loop below coordinates against,
    // not just decrement it as an afterthought. A pre-check for a budget
    // already exhausted by an earlier-resolving sibling avoids firing a
    // request that can only be discarded; the check-slice-decrement
    // immediately after the await is what actually matters, because it runs
    // synchronously (no `await` in between), so concurrent projects
    // resolving in any order still each atomically claim only what's left
    // rather than racing past the limit together (issue #290 MED-19:
    // previously fetched-then-decremented with no check at all, so N
    // concurrent projects could together return N times the budget with
    // `resultComplete` staying a silent `true`).
    if (budget.remaining <= 0) {
      budget.truncated = true;
      budget.warnings.push(
        `Project ${projectId}: stopped loading at the ${getMaxTasksLimit()}-task limit ` +
          `(VIKUNJA_MAX_TASKS_LIMIT); more tasks exist that are not in this result.`,
      );
      return [];
    }

    const single = await requestPage(undefined);

    if (single.length > budget.remaining) {
      const clamped = single.slice(0, budget.remaining);
      budget.remaining = 0;
      budget.truncated = true;
      budget.warnings.push(
        `Project ${projectId}: stopped loading at the ${getMaxTasksLimit()}-task limit ` +
          `(VIKUNJA_MAX_TASKS_LIMIT); more tasks exist that are not in this result.`,
      );
      return clamped;
    }

    budget.remaining -= single.length;
    return single;
  }

  const firstPage = Math.max(1, params.page ?? 1);
  const serverPageCap = readServerPageCap(authManager);
  const collected: VikunjaTask[] = [];
  let pageSize = 0;

  for (let offset = 0; offset < MAX_PAGES_PER_PROJECT; offset++) {
    if (budget.remaining <= 0) {
      budget.truncated = true;
      budget.warnings.push(
        `Project ${projectId}: stopped loading at the ${getMaxTasksLimit()}-task limit ` +
          `(VIKUNJA_MAX_TASKS_LIMIT); more tasks exist that are not in this result.`,
      );
      break;
    }

    const page = await requestPage(firstPage + offset);

    if (offset === 0) {
      pageSize = page.length;
      // A first page that is already short (or empty) means the project fits
      // in one response — nothing more to fetch.
      if (pageSize === 0) break;
      if (serverPageCap !== undefined && pageSize < serverPageCap) {
        // The whole project fits in this one page — but the budget can
        // still cut it short. Sibling branch below (`page.length >
        // budget.remaining`, a few lines down) sets `truncated`/warnings
        // when that happens; this branch must too (issue #290 MED-6).
        if (page.length > budget.remaining) {
          collected.push(...page.slice(0, budget.remaining));
          budget.remaining = 0;
          budget.truncated = true;
          budget.warnings.push(
            `Project ${projectId}: stopped loading at the ${getMaxTasksLimit()}-task limit ` +
              `(VIKUNJA_MAX_TASKS_LIMIT); more tasks exist that are not in this result.`,
          );
        } else {
          collected.push(...page);
          budget.remaining -= page.length;
        }
        break;
      }
    }

    // The budget is a HARD cap, not an advisory one: take only what fits and
    // say so, rather than overshooting it by up to a page per project.
    if (page.length > budget.remaining) {
      collected.push(...page.slice(0, budget.remaining));
      budget.remaining = 0;
      budget.truncated = true;
      budget.warnings.push(
        `Project ${projectId}: stopped loading at the ${getMaxTasksLimit()}-task limit ` +
          `(VIKUNJA_MAX_TASKS_LIMIT); more tasks exist that are not in this result.`,
      );
      break;
    }

    collected.push(...page);
    budget.remaining -= page.length;

    if (page.length < pageSize) break;

    if (offset === MAX_PAGES_PER_PROJECT - 1) {
      budget.truncated = true;
      budget.warnings.push(
        `Project ${projectId}: stopped after ${MAX_PAGES_PER_PROJECT} pages; ` +
          'more tasks exist that are not in this result.',
      );
    }
  }

  return collected;
}

/**
 * Loads tasks from every project the user can access.
 *
 * Vikunja's dedicated "all tasks" endpoint (the legacy client's `getAllTasks` ->
 * GET /tasks/all) returns HTTP 400 "Invalid model provided" on some servers
 * (reproduced on v2.3.0), so it cannot be relied on for cross-project listing.
 * This aggregates GET /projects/{id}/tasks across every project instead, which
 * is consistently available.
 *
 * A project that fails individually is still skipped rather than failing the
 * whole listing — but it is now RECORDED (`budget.warnings`, `resultComplete:
 * false`) instead of only logged, because "some projects silently contributed
 * nothing" is indistinguishable from "those projects are empty" to the caller.
 *
 * The project list itself is paged for the same reason the task lists are:
 * `per_page=1000` is clamped to 50, so a user with more than 50 projects was
 * only ever aggregating over the first 50 of them.
 */
async function loadAllProjects(
  authManager: AuthManager,
  budget: TaskLoadBudget,
): Promise<VikunjaProjectSummary[]> {
  const collected: VikunjaProjectSummary[] = [];
  let pageSize = 0;

  for (let page = 1; page <= MAX_PAGES_PER_PROJECT; page++) {
    // Page 1 keeps the original `?per_page=1000` spelling exactly (no `page`
    // param) so the single-page case — by far the common one — issues the
    // identical request it always did.
    let projects: VikunjaProjectSummary[];
    try {
      projects = await vikunjaRestRequest<VikunjaProjectSummary[]>(
        authManager,
        'GET',
        page === 1 ? '/projects?per_page=1000' : `/projects?per_page=1000&page=${page}`,
      );
    } catch (error) {
      // Page 1 failing means we have no project list at all — that is a real
      // error and still propagates. A LATER page failing means we have part
      // of the list: keep what we have and say it is partial, rather than
      // discarding a usable answer or (worse) returning it as if complete.
      if (page === 1) throw error;
      budget.truncated = true;
      budget.warnings.push(
        `The project list could not be read past page ${page - 1} ` +
          `(${error instanceof Error ? error.message : String(error)}); ` +
          'some projects were not searched.',
      );
      break;
    }
    const safe = Array.isArray(projects) ? projects : [];
    collected.push(...safe);

    if (page === 1) {
      pageSize = safe.length;
      if (pageSize === 0) break;
      const serverPageCap = readServerPageCap(authManager);
      if (serverPageCap !== undefined && pageSize < serverPageCap) break;
    }
    if (safe.length < pageSize) break;
    if (page === MAX_PAGES_PER_PROJECT) {
      budget.truncated = true;
      budget.warnings.push(
        `Project list stopped after ${MAX_PAGES_PER_PROJECT} pages; ` +
          'some projects were not searched.',
      );
    }
  }

  return collected;
}

async function loadTasksAcrossProjects(
  authManager: AuthManager,
  params: TaskListApiParams,
  options: { autoPaginate: boolean; budget: TaskLoadBudget },
  /**
   * `orderBy`/`filterTimezone`/`filterIncludeNulls` from the original
   * `FilteringArgs`, threaded through to every per-project GET. This
   * function is ONLY ever reached as the cross-project listing path — the
   * plain aggregate branch of `execute()` below, or
   * `RestCrossProjectFilteringStrategy`'s fallback when its direct
   * `GET /tasks` call fails — so these REST-cross-project-only params
   * (see `FilteringArgs`) are always in scope here, unlike the
   * single-project branch of `execute()` (issue #290 MED-7: these used to
   * be dropped on ANY fallback cause, not just the tracked #237 chain).
   */
  extras: Pick<FilteringArgs, 'orderBy' | 'filterTimezone' | 'filterIncludeNulls'> = {},
): Promise<VikunjaTask[]> {
  const safeProjects = await loadAllProjects(authManager, options.budget);
  const skipped: number[] = [];

  // Coordination (issue #290 MED-19) only matters once there is more than
  // one project to race: a single project's single-request fetch has no
  // sibling to overshoot the budget alongside, so it stays on the same
  // "bypass and let the downstream hard limit catch a gross overshoot" path
  // the lone single-project call site in `execute()` uses (see
  // `coordinateSingleRequestBudget`'s doc comment) rather than silently
  // truncating a result the caller's own explicit page/perPage asked for.
  const coordinateSingleRequestBudget = safeProjects.length > 1;

  const perProject = await Promise.all(
    safeProjects.map(async (project): Promise<VikunjaTask[]> => {
      const projectId = project.id;
      // Skip pseudo-projects (e.g. Favorites uses a negative id) to avoid duplicate tasks.
      if (typeof projectId !== 'number' || projectId <= 0) {
        return [];
      }
      try {
        return await fetchProjectTasks(
          authManager,
          projectId,
          params,
          { ...options, coordinateSingleRequestBudget },
          extras,
        );
      } catch (error) {
        logger.warn('Skipping a project that failed during all-projects task aggregation', {
          projectId,
          error: error instanceof Error ? error.message : String(error),
        });
        skipped.push(projectId);
        return [];
      }
    }),
  );

  if (skipped.length > 0) {
    options.budget.truncated = true;
    options.budget.warnings.push(
      `${skipped.length} project(s) could not be read and contributed no tasks ` +
        `(ids: ${skipped.join(', ')}); this result is incomplete.`,
    );
  }

  // No extra aggregate clamp is needed here: projects are fetched
  // concurrently, but in `fetchProjectTasks` the budget check and its
  // decrement (whether that's the auto-paginate loop's per-page check or the
  // single-request branch's check-slice-decrement, issue #290 MED-19) are
  // always a synchronous pair with no `await` between them, so no project
  // can observe room that another has already claimed. `budget.remaining` is
  // therefore a real ceiling on the total in both cases, not an approximate
  // one.
  return perProject.flat();
}

export class ClientSideFilteringStrategy implements TaskFilteringStrategy {
  async execute(params: FilteringParams): Promise<FilteringResult> {
    const { args, filterExpression, filterString, params: apiParams, authManager } = params;

    if (!authManager) {
      // Programmer error: FilteringContext must only select this strategy
      // when an authManager was threaded through from the tool handler.
      throw new MCPError(
        ErrorCode.INTERNAL_ERROR,
        'ClientSideFilteringStrategy requires an authManager',
      );
    }

    logger.info('Using client-side filtering', {
      filter: filterString,
      endpoint:
        args.projectId && !args.allProjects
          ? 'getProjectTasks'
          : 'getProjectTasks (aggregated across all projects)',
    });

    // Follow pagination only when the caller expressed no pagination intent
    // of their own. `FilterExecutor.prepareQueryParameters` synthesises
    // `per_page: 1000, page: 1` when neither was supplied — that synthetic
    // default is precisely the "give me everything" case, and it is the one
    // Vikunja's `maxitemsperpage` clamp silently truncated (issue #225).
    const autoPaginate = args.perPage === undefined && args.page === undefined;
    const budget = createBudget();

    // Load tasks without server-side filtering
    let tasks;
    if (args.projectId !== undefined && !args.allProjects) {
      // Validate project ID
      validateId(args.projectId, 'projectId');
      // Get tasks for specific project without filter
      tasks = await fetchProjectTasks(authManager, args.projectId, apiParams, {
        autoPaginate,
        budget,
      });
    } else {
      // Aggregate tasks across all projects (GET /tasks/all is unreliable).
      // Thread orderBy/filterTimezone/filterIncludeNulls through this
      // cross-project path (issue #290 MED-7) — they stay unsupported on
      // the single-project branch above, matching FilteringArgs's
      // documented REST-cross-project-only scope for these fields.
      tasks = await loadTasksAcrossProjects(
        authManager,
        apiParams,
        { autoPaginate, budget },
        {
          ...(args.orderBy !== undefined && { orderBy: args.orderBy }),
          ...(args.filterTimezone !== undefined && { filterTimezone: args.filterTimezone }),
          ...(args.filterIncludeNulls !== undefined && {
            filterIncludeNulls: args.filterIncludeNulls,
          }),
        },
      );
    }

    logger.info('Tasks loaded for client-side filtering', {
      totalTasksLoaded: tasks?.length || 0,
      filter: filterString,
    });

    // Apply client-side filtering if we have a filter expression
    const safeTasks = tasks || [];
    let filteredTasks = safeTasks;

    if (filterExpression) {
      const originalCount = safeTasks.length;
      // applyFilter (evaluators.ts) and this strategy both type tasks as the
      // generated `models.Task`; the cast here bridges the two nominally-
      // distinct aliases at this boundary.
      filteredTasks = applyFilter(safeTasks, filterExpression);
      logger.debug('Applied client-side filter', {
        originalCount,
        filteredCount: filteredTasks?.length || 0,
        filter: filterString,
      });
    }

    // A result that is knowingly a subset of what was asked for is NEVER
    // reported as a plain success — see FilteringMetadata.resultComplete.
    const metadata: FilteringResult['metadata'] = {
      serverSideFilteringUsed: false,
      serverSideFilteringAttempted: false,
      clientSideFiltering: Boolean(filterExpression),
      filteringNote: filterExpression
        ? 'Client-side filtering applied'
        : 'No filter applied; tasks returned as loaded',
    };

    if (budget.truncated || budget.warnings.length > 0) {
      metadata.resultComplete = false;
      metadata.warnings = budget.warnings;
      metadata.filteringNote = `${metadata.filteringNote} — INCOMPLETE: ${budget.warnings.join(' ')}`;
      logger.warn('Client-side aggregation returned an incomplete result', {
        warnings: budget.warnings,
        filter: filterString,
      });
    }

    return {
      tasks: filteredTasks || [],
      metadata,
    };
  }
}
