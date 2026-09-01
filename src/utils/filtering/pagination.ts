/**
 * Shared page-walking helper for direct-REST GET listing endpoints —
 * originally written for the task-listing strategies
 * (`RestCrossProjectFilteringStrategy`'s `GET /tasks`,
 * `ServerSideFilteringStrategy`'s single-project `GET
 * /projects/{id}/tasks`), and reused by other unpaginated list reads that
 * share the exact same failure shape (`vikunja_notifications list`,
 * `list-comments`, and similar — issue #289 / audit HIGH-18). Generic in the
 * item type (`T`) so it isn't task-specific despite its origin.
 *
 * WHY THIS EXISTS (issue #268 / audit CRIT-7). The task-listing strategies
 * used to issue exactly one request with a large `per_page`. Vikunja clamps
 * `per_page` server-side to `service.maxitemsperpage` (default **50** — see
 * docs/VIKUNJA_API_ISSUES.md #18, which documents this as a clamp on
 * listing endpoints generally, not one specific to `/tasks`) and reports the
 * real page size only via response headers, which `vikunjaRestRequest` does
 * not surface. A user with 193 tasks asking to list them all got "Found 50
 * tasks" with no signal 143 were missing, and the response was never marked
 * incomplete. The same shape recurs at every other unpaginated single-GET
 * list read in this codebase.
 *
 * TERMINATION HEURISTIC. `ClientSideFilteringStrategy`'s per-project
 * pagination (issue #225) treats whatever page 1 returns as its own
 * reference and, when the server's real page cap isn't cached, spends one
 * extra probe request to confirm there is no page 2. This module takes a
 * simpler approach that avoids that probe in the common case: it compares
 * every page's length against the server's REAL cached page cap
 * (`GET /info`'s `max_items_per_page`, via `readServerPageCap`) when
 * available, or Vikunja's documented DEFAULT clamp (50) otherwise. A page
 * shorter than that cap is conclusively the end of the collection - no
 * probe needed - and a small result set (the overwhelmingly common case,
 * and every existing single-page test fixture in this repo) still costs
 * exactly one request. The tradeoff: a server configured with a NON-default
 * `service.maxitemsperpage` smaller than 50, whose real value isn't cached
 * yet, could in theory stop one page early. That is strictly better than
 * this module's prior behavior (never paginating at all), and the common,
 * tested, default-50 deployment is handled exactly.
 */

import type { AuthManager } from '../../auth/AuthManager';
import { getMaxTasksLimit } from '../memory';

/**
 * A shared, mutable budget for one listing: how many more items may still
 * be loaded before the memory bound (`VIKUNJA_MAX_TASKS_LIMIT`, via
 * `getMaxTasksLimit()`) is reached, and whether the bound has actually
 * clipped anything. The same knob governs every listing path this module's
 * `fetchAllPages` walks, not only task listings — `getMaxTasksLimit`'s name
 * is a holdover from where this bound was first introduced, not a scope
 * limit on what it protects.
 */
export interface LoadBudget {
  remaining: number;
  /** Set when something stopped a fetch that had more pages/items available. */
  truncated: boolean;
  /** Human-readable notes for anything that made the result incomplete. */
  warnings: string[];
}

export function createBudget(): LoadBudget {
  return { remaining: getMaxTasksLimit(), truncated: false, warnings: [] };
}

/**
 * Vikunja's documented default `service.maxitemsperpage`
 * (docs/VIKUNJA_API_ISSUES.md #18). Used as the page-clamp assumption when
 * the real value isn't cached on the session yet.
 */
export const DEFAULT_SERVER_PAGE_CAP = 50;

/**
 * The server's own `service.maxitemsperpage`, read from the cached `GET
 * /info` payload (`max_items_per_page`) when the session has one.
 */
export function readServerPageCap(authManager?: AuthManager): number | undefined {
  const capabilities =
    typeof authManager?.getCapabilities === 'function' ? authManager.getCapabilities() : undefined;
  const raw = capabilities?.features?.max_items_per_page;
  return typeof raw === 'number' && raw > 0 ? raw : undefined;
}

/**
 * Hard ceiling on requests per listing, so a server that keeps returning
 * full pages can never spin forever. Mirrors
 * `ClientSideFilteringStrategy.MAX_PAGES_PER_PROJECT`.
 */
export const MAX_PAGES = 500;

/**
 * Walks pages of a single GET listing (via `requestPage`), stopping as soon
 * as a page comes back shorter than `cap` — see the module doc comment for
 * why that is a safe, single-request-in-the-common-case termination rule.
 *
 * Paging is only attempted when `autoPaginate` is true (the caller expressed
 * no pagination intent of their own); otherwise exactly the requested page
 * is fetched, matching the pre-existing single-request behavior.
 */
export async function fetchAllPages<T>(
  requestPage: (page: number) => Promise<T[]>,
  options: {
    autoPaginate: boolean;
    firstPage: number;
    budget: LoadBudget;
    cap: number;
    resourceLabel: string;
  },
): Promise<T[]> {
  const { autoPaginate, firstPage, budget, cap, resourceLabel } = options;

  if (!autoPaginate) {
    const single = await requestPage(firstPage);
    budget.remaining -= single.length;
    return single;
  }

  const collected: T[] = [];

  for (let offset = 0; offset < MAX_PAGES; offset++) {
    if (budget.remaining <= 0) {
      budget.truncated = true;
      budget.warnings.push(
        `${resourceLabel}: stopped loading at the ${getMaxTasksLimit()}-item limit ` +
          `(VIKUNJA_MAX_TASKS_LIMIT); more items exist that are not in this result.`,
      );
      break;
    }

    const page = await requestPage(firstPage + offset);

    if (page.length === 0) break;

    // The budget is a HARD cap, not an advisory one: take only what fits
    // and say so, rather than overshooting it.
    if (page.length > budget.remaining) {
      collected.push(...page.slice(0, budget.remaining));
      budget.remaining = 0;
      budget.truncated = true;
      budget.warnings.push(
        `${resourceLabel}: stopped loading at the ${getMaxTasksLimit()}-item limit ` +
          `(VIKUNJA_MAX_TASKS_LIMIT); more items exist that are not in this result.`,
      );
      break;
    }

    collected.push(...page);
    budget.remaining -= page.length;

    // Shorter than the (known or assumed) page cap: this was the last page.
    if (page.length < cap) break;

    if (offset === MAX_PAGES - 1) {
      budget.truncated = true;
      budget.warnings.push(
        `${resourceLabel}: stopped after ${MAX_PAGES} pages; ` +
          'more items exist that are not in this result.',
      );
    }
  }

  return collected;
}

/**
 * The "at minimum" half of the CRIT-7 fix shape, for the smaller secondary
 * list reads spot-checked under issue #289 / audit HIGH-18
 * (`list-assignees`, `list-attachments`, `list-labels`, `list-teams`): these
 * stay single-request (no new pagination walk — that page clamp is rarely
 * actually hit for a per-task assignee/label/attachment list, and a global
 * team list growing past 50 is comparatively rare), but a caller who did NOT
 * pin a specific page and got back a page that exactly fills the (known or
 * assumed) server cap cannot tell "that's everyone" from "there's a page 2"
 * without this signal.
 *
 * Returns an empty object (no `resultComplete`/`warnings` keys at all) when
 * nothing looks truncated, so callers can spread the result straight into a
 * response's metadata.
 */
export function describePossibleTruncation(
  itemCount: number,
  options: { autoPaginate: boolean; cap: number; resourceLabel: string },
): { resultComplete?: false; warnings?: string[] } {
  const { autoPaginate, cap, resourceLabel } = options;
  if (!autoPaginate || itemCount < cap) {
    return {};
  }
  return {
    resultComplete: false,
    warnings: [
      `${resourceLabel}: this page came back full (${itemCount} items, at or above the ` +
        `server's page size); more may exist beyond it. Pass an explicit page/perPage to ` +
        `see further pages.`,
    ],
  };
}
