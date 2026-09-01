/**
 * Notifications Tool
 *
 * Wraps Vikunja's `/notifications` endpoints (see docs/vikunja-openapi.json):
 *   - GET  /notifications        -> list, with page/per_page pagination
 *   - POST /notifications        -> mark every notification read
 *   - POST /notifications/{id}   -> mark a single notification's read state.
 *     Documented as a bodyless toggle, but confirmed live (issue #314,
 *     docs/VIKUNJA_API_ISSUES.md item #21) that an empty body never
 *     persists — this codebase sends an explicit `{ read: true }` body
 *     instead, which does. See `ensureNotificationRead`'s doc comment.
 *
 * All calls go through `vikunjaRestRequest` (direct-REST rule, see
 * docs/ENDPOINT-PLAYBOOK.md §3) — legacy client has no notifications support
 * to migrate away from, so this is a pure new call site.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AuthManager } from '../auth/AuthManager';
import type { VikunjaClientFactory } from '../client/VikunjaClientFactory';
import { MCPError, ErrorCode } from '../types';
import { getAuthManagerFromContext, hasRequestContext } from '../client';
import { logger } from '../utils/logger';
import { assertWriteAllowed, getToolAnnotations, withReadOnlyNote } from '../utils/read-only';
import { validateAndConvertId } from '../utils/validation';
import { createAorpResponse } from '../utils/response-factory';
import { vikunjaRestRequest } from '../utils/vikunja-rest';
import {
  createBudget,
  DEFAULT_SERVER_PAGE_CAP,
  fetchAllPages,
  readServerPageCap,
} from '../utils/filtering/pagination';

/**
 * Shape of a notification as returned by `GET /notifications`
 * (`notifications.DatabaseNotification` in the spec) and by
 * `POST /notifications/{id}` (`models.DatabaseNotifications`, which adds a
 * `read` boolean alongside the same fields — `GET /notifications`'s own
 * schema has NO `read` field, only `read_at`). The spec leaves
 * `notification` completely untyped (`"description": "The actual content of
 * the notification."`, no `type`/`$ref`) — its shape varies by notification
 * kind and is not documented, so it is passed through as `unknown` rather
 * than guessed at (see docs/ENDPOINT-PLAYBOOK.md §2: never infer field
 * shapes that aren't in the spec).
 */
interface VikunjaNotification {
  id: number;
  name: string;
  created: string;
  notification?: unknown;
  read_at?: string | null;
  read?: boolean;
}

/**
 * CONFIRMED live against a Vikunja 2.4.0 instance (issue #286 / audit
 * HIGH-15, previously "suspected"): `read_at` for a genuinely unread
 * notification serializes as the truthy Go zero-time string
 * `"0001-01-01T00:00:00Z"`, not `null` — the same sentinel pattern this
 * codebase already handles for task date fields
 * (`src/tools/tasks/filtering/evaluators.ts`'s `startDate`/`endDate`/
 * `doneAt` handling). A bare `!notification.read_at` truthiness check is
 * therefore always false, never matching "unread" — it would make
 * `unreadOnly: true` filter out every notification, and would make
 * `ensureNotificationRead`'s idempotency check never detect "still unread"
 * (see that function's doc comment).
 */
function isNotificationUnread(readAt: string | null | undefined): boolean {
  return !readAt || readAt.startsWith('0001-');
}

/**
 * Best-effort, zero-extra-request enrichment: some notification kinds (e.g.
 * task assignment, task comments) embed a `{ task: { id, title } }` shape in
 * their untyped `notification` payload in practice, but this is NOT
 * documented in the OpenAPI spec (see `VikunjaNotification` doc comment
 * above) — so this is purely a defensive, best-effort extraction over data
 * already in hand from the `list` response, never a new API call, and it
 * silently returns `undefined` (rather than throwing) whenever the shape
 * doesn't match. This is what backs the `list` subcommand's optional
 * `relatedTask` convenience field.
 */
function extractRelatedTask(content: unknown): { id: number; title: string } | undefined {
  if (!content || typeof content !== 'object') {
    return undefined;
  }
  const task = (content as Record<string, unknown>).task;
  if (!task || typeof task !== 'object') {
    return undefined;
  }
  const id = (task as Record<string, unknown>).id;
  const title = (task as Record<string, unknown>).title;
  if (typeof id === 'number' && typeof title === 'string') {
    return { id, title };
  }
  return undefined;
}

/**
 * Ensures a notification ends up marked READ.
 *
 * `POST /notifications/{id}` is documented (docs/vikunja-openapi.json) as a
 * pure toggle with NO request body ("Marks a notification as either read or
 * unread"). Issue #314 confirmed live against Vikunja 2.4.0 — on BOTH a
 * postgres-backed and a freshly-provisioned sqlite-backed instance, so this
 * is general server behavior, not stale state on one long-running stack —
 * that sending the toggle with an empty body per the spec never actually
 * persists: repeated empty-body calls leave `read_at` at the Go zero-time
 * sentinel forever and the response's own `read` field never flips to
 * `true`. Sniffing the real Vikunja frontend's own request (see
 * docs/LOCAL-TESTING.md, "A note on POST /notifications/{id}", found
 * independently while building a docs screenshot capture) showed it sends
 * `{"read": true}` explicitly instead of an empty body, and that DOES
 * persist correctly on both backends. This function does the same, rather
 * than relying on the documented-but-non-functional empty-body toggle. See
 * docs/VIKUNJA_API_ISSUES.md item #21 for the full writeup.
 *
 * The retry-if-still-unread step is kept as a defensive fallback (e.g. a
 * server version that reverts to genuine toggle semantics, where an
 * explicit `read: true` sent while already-read could still flip to
 * unread) — this makes `mark-read` idempotent (verify-then-apply,
 * docs/ENDPOINT-PLAYBOOK.md §1) by checking the response and retrying once
 * if it didn't land on `read: true`. At most 2 requests; typically 1.
 *
 * Checks the response's own explicit `read` boolean rather than `read_at`
 * truthiness (issue #286 / HIGH-15): `read_at` is always a non-empty
 * string — either a real timestamp or the zero-time sentinel for "unread"
 * (see `isNotificationUnread`'s doc comment) — so a truthiness check can
 * never detect "the toggle actually landed on unread."
 *
 * If the retry ALSO fails to land on `read: true`, a warning is returned
 * alongside the notification instead of silently reporting success (#314's
 * suggested next step) — this can no longer happen against the specific
 * empty-body-never-persists behavior this function now works around, but
 * still guards against a genuinely unresponsive server or some other
 * as-yet-unseen persistence failure.
 */
async function ensureNotificationRead(
  authManager: AuthManager,
  notificationId: number,
): Promise<{ notification: VikunjaNotification; warning?: string }> {
  let notification = await vikunjaRestRequest<VikunjaNotification>(
    authManager,
    'POST',
    `/notifications/${notificationId}`,
    { read: true },
  );
  if (notification?.read !== true) {
    notification = await vikunjaRestRequest<VikunjaNotification>(
      authManager,
      'POST',
      `/notifications/${notificationId}`,
      { read: true },
    );
  }
  if (notification?.read !== true) {
    return {
      notification,
      warning:
        `Notification ${notificationId} may not actually be marked read server-side: ` +
        "the server did not confirm read: true after 2 attempts sending { read: true }.",
    };
  }
  return { notification };
}

export function registerNotificationsTool(
  server: McpServer,
  authManager: AuthManager,
  _clientFactory?: VikunjaClientFactory,
): void {
  server.tool(
    'vikunja_notifications',
    withReadOnlyNote(
      'vikunja_notifications',
      "Manage the current user's Vikunja notifications: list (with optional " +
        'unread filtering and pagination), mark a single notification read ' +
        '(idempotent — safe to call repeatedly), and mark all notifications ' +
        'read at once.',
    ),
    {
      subcommand: z.enum(['list', 'mark-read', 'mark-all-read']),

      // list parameters
      unreadOnly: z.boolean().optional(),
      page: z.number().int().positive().optional(),
      perPage: z.number().int().positive().optional(),

      // mark-read parameter
      notificationId: z.number().int().positive().optional(),
    },
    getToolAnnotations('vikunja_notifications'),
    async (args) => {
      // Closure-gate precedence fix: defer to the per-request context when
      // bound (see hasRequestContext's doc comment, src/client.ts).
      if (hasRequestContext()) {
        await getAuthManagerFromContext();
      } else if (!authManager.isAuthenticated()) {
        throw new MCPError(
          ErrorCode.AUTH_REQUIRED,
          'Authentication required. Please use vikunja_auth.connect first.',
        );
      }

      await getAuthManagerFromContext(); // Ensure the session is initialized
      const subcommand = args.subcommand;

      assertWriteAllowed('vikunja_notifications', subcommand);

      logger.debug('Notifications tool called', { subcommand, args });

      try {
        switch (subcommand) {
          case 'list': {
            // Paginate only when the caller expressed no pagination intent
            // of their own — the same silent-page-clamp pattern issue #268
            // fixed for task listing recurs here (issue #289 / audit
            // HIGH-18): a single unpaged `GET /notifications` could report
            // "Retrieved 0" (or an incomplete page) while more notifications
            // — unread ones included — exist beyond page 1. See
            // `src/utils/filtering/pagination.ts` for the shared
            // pagination/resultComplete pattern this reuses.
            const autoPaginate = args.page === undefined && args.perPage === undefined;
            const firstPage = args.page ?? 1;
            const cap = readServerPageCap(authManager) ?? DEFAULT_SERVER_PAGE_CAP;
            const budget = createBudget();

            const requestPage = async (page: number): Promise<VikunjaNotification[]> => {
              const query: string[] = [];
              // Preserve the exact original query spelling for the first
              // page (no `page` param at all when the caller didn't supply
              // one) — only pages synthesised by the auto-pagination walk
              // itself (page !== firstPage) force an explicit `page`.
              const pageParam = page === firstPage ? args.page : page;
              if (pageParam !== undefined) {
                query.push(`page=${encodeURIComponent(String(pageParam))}`);
              }
              if (args.perPage !== undefined) {
                query.push(`per_page=${encodeURIComponent(String(args.perPage))}`);
              }
              const qs = query.length > 0 ? `?${query.join('&')}` : '';
              const result = await vikunjaRestRequest<VikunjaNotification[]>(
                authManager,
                'GET',
                `/notifications${qs}`,
              );
              return Array.isArray(result) ? result : [];
            };

            const allNotifications = await fetchAllPages(requestPage, {
              autoPaginate,
              firstPage,
              budget,
              cap,
              resourceLabel: 'GET /notifications',
            });

            // The spec's page/per_page are the only server-side filters
            // documented for this endpoint — there is no server-side
            // unread filter, so `unreadOnly` is applied client-side over the
            // fetched page. Uses `isNotificationUnread` (issue #286 /
            // HIGH-15), not a bare `read_at` truthiness check — see its doc
            // comment for why a truthiness check would filter out every
            // notification.
            const notifications = args.unreadOnly
              ? allNotifications.filter((n) => isNotificationUnread(n.read_at))
              : allNotifications;

            // Read-composite (docs/ENDPOINT-PLAYBOOK.md §1): attach a
            // best-effort relatedTask summary with zero extra requests,
            // see extractRelatedTask() doc comment for why this is
            // heuristic rather than spec-guaranteed.
            const enriched = notifications.map((n) => {
              const relatedTask = extractRelatedTask(n.notification);
              return relatedTask ? { ...n, relatedTask } : n;
            });

            logger.info('Listed notifications', {
              count: enriched.length,
              unreadOnly: !!args.unreadOnly,
            });

            // A result that is knowingly a subset of what was asked for is
            // never reported as a plain success — same rule tasks listing
            // follows (src/tools/tasks/index.ts) for the pattern issue #268
            // established.
            const incomplete = budget.truncated || budget.warnings.length > 0;
            const reliabilityMessage = incomplete
              ? ` — INCOMPLETE RESULT: ${budget.warnings.join(' ')}`
              : '';

            const aorpResult = createAorpResponse(
              'list',
              `Retrieved ${enriched.length} notification(s)${reliabilityMessage}`,
              { notifications: enriched },
              {
                success: true,
                metadata: {
                  count: enriched.length,
                  ...(incomplete ? { resultComplete: false, warnings: budget.warnings } : {}),
                },
              },
            );

            return {
              content: [{ type: 'text' as const, text: aorpResult.content }],
            };
          }

          case 'mark-read': {
            const notificationId = validateAndConvertId(args.notificationId, 'notificationId');

            const { notification, warning } = await ensureNotificationRead(
              authManager,
              notificationId,
            );

            logger.info('Marked notification read', { notificationId, warning });

            // A result that could not be confirmed server-side is never
            // reported as a plain, unqualified success — same reliability
            // rule the `list` case above follows for pagination (issue
            // #268), applied here for #314's mark-read persistence warning.
            const aorpResult = createAorpResponse(
              'mark-read',
              warning
                ? `Notification ${notificationId} marked as read — WARNING: ${warning}`
                : `Notification ${notificationId} marked as read`,
              { notification },
              {
                success: true,
                metadata: {
                  count: 1,
                  ...(warning ? { resultComplete: false, warnings: [warning] } : {}),
                },
              },
            );

            return {
              content: [{ type: 'text' as const, text: aorpResult.content }],
            };
          }

          case 'mark-all-read': {
            const result = await vikunjaRestRequest<{ message?: string }>(
              authManager,
              'POST',
              '/notifications',
            );

            logger.info('Marked all notifications read');

            const aorpResult = createAorpResponse(
              'mark-all-read',
              result?.message ?? 'All notifications marked as read',
              {},
              { success: true },
            );

            return {
              content: [{ type: 'text' as const, text: aorpResult.content }],
            };
          }

          default:
            throw new MCPError(
              ErrorCode.VALIDATION_ERROR,
              `Unknown subcommand: ${subcommand as string}`,
            );
        }
      } catch (error) {
        logger.error('Notifications operation failed', { error, subcommand, args });

        if (error instanceof MCPError) {
          // Link shares cannot have notifications — the spec documents a
          // dedicated 403 for this case; surface it plainly rather than the
          // generic HTTP error text.
          const statusCode = error.details?.statusCode;
          if (statusCode === 403) {
            throw new MCPError(
              ErrorCode.PERMISSION_DENIED,
              'Link shares cannot have notifications. Authenticate as a full user to use vikunja_notifications.',
            );
          }
          throw error;
        }

        if (error instanceof Error) {
          throw new MCPError(
            ErrorCode.API_ERROR,
            `Notifications operation failed: ${error.message}`,
          );
        }

        throw new MCPError(
          ErrorCode.INTERNAL_ERROR,
          'An unexpected error occurred during a notifications operation',
        );
      }
    },
  );
}
