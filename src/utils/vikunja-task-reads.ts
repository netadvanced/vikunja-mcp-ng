/**
 * Version-aware task READ transport.
 *
 * This is the first place in the codebase where an operation actually runs
 * against Vikunja's v2 API. Everything P1 and P2 built was behaviour-neutral
 * plumbing; this module spends it.
 *
 * ## Why reads go to v2 at all
 *
 * Exactly one reason: `?format=markdown`. v1 always returns HTML in rich-text
 * fields, v2 returns GitHub-flavoured markdown when asked. This server feeds an
 * LLM, so a task description arriving as `Hello **bold**` rather than
 * `<p>Hello <strong>bold</strong></p>` is the single largest caller-visible
 * quality win in the milestone. Verified live on 2.4.0, 2.5.0 and 2.6.0 on
 * 2026-09-05, so it is available across the whole support window and needs no
 * `minVersion` floor of its own.
 *
 * The rationale the original design gave — that `GET /projects/{id}/tasks` was
 * a v2-only endpoint whose adoption saved a view-resolution round trip — was
 * disproved live: v1 serves that path on all three supported versions. It is
 * deliberately not repeated here. See
 * docs/superpowers/specs/2026-08-02-vikunja-v2-native-adoption-design.md.
 *
 * ## Read/write asymmetry, decided rather than overlooked
 *
 * `format` is declared on v2's `GET`/`POST`/`PUT` and NOT on `PATCH`, and a
 * live `PATCH ...?format=markdown` returns HTML regardless. Owner decision of
 * 2026-09-05: request markdown on reads and leave update responses exactly as
 * they are. The same description therefore comes back as markdown when read and
 * as HTML when returned by an update. That is deliberate. Do not add a re-read
 * after an update to reconcile them (it costs back the round trip `PATCH`
 * exists to save), and do not convert between the two formats anywhere.
 *
 * Concretely, this module is used by the caller-facing READ paths only. The
 * internal `GET /tasks/{id}` that `TaskUpdateService` issues before its
 * fetch-merge-POST deliberately stays on v1: it feeds a description straight
 * back into a v1 write, so reading markdown there would replace the stored HTML
 * with its markdown source.
 *
 * ## Why this is a dispatcher and not a strategy pair
 *
 * The spec's rule: introduce a strategy pair only where the CALL SHAPE differs,
 * and let the normalizer carry the rest. For task reads the call shape is
 * identical on both versions — one GET per page, same pagination walk, same
 * ordering. What differs is the URL prefix (handled by the transport), the
 * response envelope (handled by `normalizeV2Response`, applied by default
 * inside `vikunjaRestV2Request`), the name of the search parameter, and the
 * added `format`. Those last two are query building, which is what this module
 * owns.
 */

import type { AuthManager } from '../auth/AuthManager';
import { MCPError } from '../types';
import { resolveApiVersion, type ApiVersion } from './api-version';
import { describeLikelyExpandScopeFailure, vikunjaRestRequest } from './vikunja-rest';
import { vikunjaRestV2Request } from './vikunja-rest-v2';
import type { FilteringArgs, TaskListApiParams, VikunjaTask } from './filtering/types';

/**
 * The `format` value every v2 read here asks for. v2 accepts `html` (its
 * default, matching v1) and `markdown`; anything else answers 422 with
 * `expected value to be one of "html, markdown"` (verified on 2.6.0).
 */
export const V2_READ_FORMAT = 'markdown';

/**
 * `max_permission` is populated on v2 single-entity reads and has no v1
 * counterpart. The spec's non-goals put it explicitly outside P3's tool
 * surface, and this wave's hard constraint is that nothing about a response
 * changes except the description format. So it is dropped at the boundary,
 * exactly like `$schema` is by the normalizer.
 *
 * Applied to list items too even though live 2.4.0/2.5.0/2.6.0 list responses
 * omit the key entirely: the single-entity route does carry it, the two routes
 * share one server-side model, and the cost of the guard is one `in` check per
 * task.
 */
const V2_ONLY_FIELDS = ['max_permission'];

/**
 * The list-only query params that never applied to single-project listing
 * pre-migration. Same shape `buildTasksListQuery` has always taken.
 */
export type TaskListQueryExtras = Pick<
  FilteringArgs,
  'orderBy' | 'filterTimezone' | 'filterIncludeNulls' | 'expand'
>;

/**
 * Builds the v1 `GET /tasks` / `GET /projects/{id}/tasks` query string from the
 * shared API params plus the task-list-only extras (`order_by`,
 * `filter_timezone`, `filter_include_nulls`, `expand`) — single-project listing
 * (`ClientSideFilteringStrategy`/`ServerSideFilteringStrategy`) does not honor
 * these, since they were never part of the legacy client's `GetTasksParams`
 * shape that the pre-migration single-project call sites used (see
 * docs/ENDPOINT-PLAYBOOK.md's direct-REST rule).
 *
 * Lives here rather than in `./filtering/RestCrossProjectFilteringStrategy`,
 * where it used to, so that the v1 and v2 spellings sit side by side and so the
 * strategies can import the dispatcher without an import cycle. That module
 * re-exports it, so existing importers are unaffected.
 */
export function buildTasksListQuery(
  apiParams: TaskListApiParams,
  filterString: string | undefined,
  args: TaskListQueryExtras,
): string {
  const query = new URLSearchParams();
  if (apiParams.page !== undefined) query.set('page', String(apiParams.page));
  if (apiParams.per_page !== undefined) query.set('per_page', String(apiParams.per_page));
  if (apiParams.s !== undefined) query.set('s', String(apiParams.s));
  if (apiParams.sort_by !== undefined) query.set('sort_by', String(apiParams.sort_by));
  if (filterString) query.set('filter', filterString);
  if (args.orderBy) query.set('order_by', args.orderBy);
  if (args.filterTimezone) query.set('filter_timezone', args.filterTimezone);
  if (args.filterIncludeNulls !== undefined) {
    query.set('filter_include_nulls', args.filterIncludeNulls ? 'true' : 'false');
  }
  if (args.expand && args.expand.length > 0) {
    for (const value of args.expand) {
      query.append('expand', value);
    }
  }
  return query.toString();
}

/**
 * The v2 spelling of the same query.
 *
 * Two differences, both load-bearing:
 *
 * 1. **`s` becomes `q`.** This is the trap that makes a v2 port dangerous
 *    rather than merely wrong. v2 SILENTLY IGNORES a query parameter it does
 *    not implement and answers 200: measured live on 2.6.0,
 *    `GET /api/v2/projects/60/tasks?q=zzzbeta` returned the 1 matching task
 *    while `?s=zzzbeta` returned all 4 tasks in the project, with no error and
 *    nothing in the body to say a search had not happened. A mis-ported
 *    parameter name therefore degrades to "no filter applied" presented as a
 *    successful search. The mapping is deliberately here, in the v2 query
 *    builder, and not in the shared response normalizer: it is
 *    operation-specific, not envelope-shaped.
 * 2. **`format=markdown` is added.** The whole reason these reads go to v2.
 *
 * Everything else (`page`, `per_page`, `sort_by`, `filter`, `order_by`,
 * `filter_timezone`, `filter_include_nulls`, `expand`) keeps its v1 name: v2
 * declares all of them on `GET /tasks` and `GET /projects/{project}/tasks`, and
 * `filter`, `sort_by`/`order_by` and `page`/`per_page` were each confirmed to
 * actually apply on 2.6.0 rather than merely return 200.
 */
export function buildTasksListQueryV2(
  apiParams: TaskListApiParams,
  filterString: string | undefined,
  args: TaskListQueryExtras,
): string {
  const query = new URLSearchParams();
  if (apiParams.page !== undefined) query.set('page', String(apiParams.page));
  if (apiParams.per_page !== undefined) query.set('per_page', String(apiParams.per_page));
  if (apiParams.s !== undefined) query.set('q', String(apiParams.s));
  if (apiParams.sort_by !== undefined) query.set('sort_by', String(apiParams.sort_by));
  if (filterString) query.set('filter', filterString);
  if (args.orderBy) query.set('order_by', args.orderBy);
  if (args.filterTimezone) query.set('filter_timezone', args.filterTimezone);
  if (args.filterIncludeNulls !== undefined) {
    query.set('filter_include_nulls', args.filterIncludeNulls ? 'true' : 'false');
  }
  if (args.expand && args.expand.length > 0) {
    for (const value of args.expand) {
      query.append('expand', value);
    }
  }
  query.set('format', V2_READ_FORMAT);
  return query.toString();
}

/** Picks the query spelling that matches the transport about to be used. */
export function buildTaskListQueryForVersion(
  version: ApiVersion,
  apiParams: TaskListApiParams,
  filterString: string | undefined,
  args: TaskListQueryExtras,
): string {
  return version === 'v2'
    ? buildTasksListQueryV2(apiParams, filterString, args)
    : buildTasksListQuery(apiParams, filterString, args);
}

/**
 * Drops the fields only v2 populates, so a v2-served task is byte-identical to
 * a v1-served one apart from its rich-text format. Returns the input unchanged
 * when there is nothing to drop, which is the normal case for a list item.
 */
function stripV2OnlyFields<T>(task: T): T {
  if (typeof task !== 'object' || task === null) return task;
  const record = task as Record<string, unknown>;
  if (!V2_ONLY_FIELDS.some((field) => field in record)) return task;
  const stripped = Object.fromEntries(
    Object.entries(record).filter(([key]) => !V2_ONLY_FIELDS.includes(key)),
  );
  return stripped as T;
}

/**
 * Re-applies v1's `expand` scope diagnosis to a v2 failure.
 *
 * From Vikunja 2.6.0 an API token's scopes are checked against expanded data,
 * and a token missing them is refused with a 401 indistinguishable from an
 * expired session. v1's transport infers that case and sets
 * `details.insufficientScope`, which two things depend on:
 * `isClientErrorExcludedFromBreaker` keeps it out of the shared circuit
 * breakers, and `RestCrossProjectFilteringStrategy` refuses to fall back to
 * per-project aggregation for it — because the fallback drops `expand`, turning
 * a refusal into a silently incomplete success (issue #254, item A1).
 *
 * The v2 transport is a deliberate sibling of v1's and carries none of that
 * inference. Without this, routing reads to v2 would quietly reintroduce the
 * exact silent degradation #254 fixed. Re-deriving the hint here rather than
 * inside `vikunja-rest-v2` keeps the transport free of read-path knowledge and
 * confines the concern to the call sites that can actually send `expand`.
 */
function annotateExpandScopeFailure(
  error: unknown,
  path: string,
  authManager: AuthManager,
): unknown {
  if (!(error instanceof MCPError)) return error;
  const status = error.details?.statusCode;
  if (typeof status !== 'number') return error;

  let authType: 'api-token' | 'jwt';
  try {
    authType = authManager.getAuthType();
  } catch {
    // Not authenticated any more (the session was cleared mid-flight). There
    // is nothing to diagnose, and the original error is the useful one.
    return error;
  }

  const hint = describeLikelyExpandScopeFailure(status, path, authType);
  if (hint === null) return error;

  error.message = `${error.message}\n\n${hint}`;
  error.details = { ...error.details, insufficientScope: true };
  return error;
}

async function v2Read<T>(authManager: AuthManager, path: string): Promise<T> {
  try {
    return await vikunjaRestV2Request<T>(authManager, 'GET', path);
  } catch (error) {
    throw annotateExpandScopeFailure(error, path, authManager);
  }
}

/**
 * Issues ONE page of a task listing against whichever API version this session
 * resolves to, and returns the bare array both versions' callers expect.
 *
 * `basePath` is the version-independent resource path (`/tasks` or
 * `/projects/{id}/tasks`) — both exist on v1 and on v2 across the whole support
 * window. `/tasks/all` deliberately does not go through here: it has no v2
 * route at all, so its (already unreachable) call site stays on v1.
 *
 * No `minVersion` floor is passed to `resolveApiVersion`. That is a decision,
 * not an omission: `format=markdown` was verified on 2.4.0, 2.5.0 and 2.6.0, so
 * every v2-capable server in the support window can serve these reads.
 */
export async function requestTaskListPage(
  authManager: AuthManager,
  basePath: string,
  apiParams: TaskListApiParams,
  filterString: string | undefined,
  extras: TaskListQueryExtras = {},
): Promise<VikunjaTask[]> {
  const version = resolveApiVersion(authManager);
  const query = buildTaskListQueryForVersion(version, apiParams, filterString, extras);
  const path = `${basePath}${query ? `?${query}` : ''}`;

  const tasks =
    version === 'v2'
      ? await v2Read<VikunjaTask[]>(authManager, path)
      : await vikunjaRestRequest<VikunjaTask[]>(authManager, 'GET', path);

  if (!Array.isArray(tasks)) return [];
  return version === 'v2' ? tasks.map((task) => stripV2OnlyFields(task)) : tasks;
}

/**
 * Reads one task by id against whichever API version this session resolves to.
 *
 * Only the caller-facing `vikunja_tasks get` uses this. The internal
 * `GET /tasks/{id}` reads that precede a v1 write keep calling
 * `vikunjaRestRequest` directly — see this module's doc comment.
 */
export async function requestTaskRead(
  authManager: AuthManager,
  taskId: number,
): Promise<VikunjaTask> {
  const version = resolveApiVersion(authManager);
  if (version === 'v1') {
    return vikunjaRestRequest<VikunjaTask>(authManager, 'GET', `/tasks/${taskId}`);
  }
  const task = await v2Read<VikunjaTask>(authManager, `/tasks/${taskId}?format=${V2_READ_FORMAT}`);
  return stripV2OnlyFields(task);
}
