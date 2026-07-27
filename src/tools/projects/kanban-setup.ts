/**
 * `setup-kanban` — a single-call composite that provisions a project (new or
 * existing) and its tasks. `columns` is optional (issue #185): when
 * supplied, it also provisions a Kanban view with ordered buckets/columns
 * and places each task into its named column; when omitted, this is purely
 * a project+tasks composite — no Kanban view, bucket, or placement step
 * runs at all, and it costs strictly fewer API calls than the columns form.
 *
 * Why this exists (issue #173, battle-campaign transcript analysis
 * 2026-07-23/24): the `q3-offsite-kanban` battle scenario (new project, a
 * 3-column board, 10 tasks distributed across those columns, priorities,
 * due dates) is not a *correctness* problem post-0.6.0 — it is an
 * orchestration-overhead problem. A weak agent doing this by hand needs
 * roughly: 1 create-project + 1 (resolve/verify Kanban view) + up to
 * N create-bucket + 1 bulk-create-tasks + up to M set-bucket/bulk-set-bucket
 * calls — haiku measured at ~38 calls against an optimal ~15. This
 * composite collapses that entire flow into ONE tool call: the caller
 * supplies a project title (or an existing `id` to reuse), an ordered list
 * of column names, and optionally a list of tasks (each carrying its
 * column name plus the normal task fields) — every project/view/bucket id
 * is resolved and threaded through internally; the caller never sees or
 * supplies one.
 *
 * REUSE, not reimplementation — every step below goes through the same
 * primitives the standalone subcommands already use:
 *  - `resolveKanbanView` (`src/utils/vikunja-rest.ts`) — the same Kanban
 *    view resolution `list-buckets`/`create-bucket`/`set-done-bucket` use.
 *  - `fetchBuckets`/`createBucketRaw`/`updateBucketRaw`
 *    (`src/tools/projects/buckets.ts`) — the exact same requests
 *    `list-buckets`/`create-bucket`/`update-bucket` send, extracted so this
 *    module gets the raw, structured `VikunjaBucket` back (with its
 *    numeric id) rather than a formatted MCP response.
 *  - `createOneBulkTask` (`src/tools/tasks/bulk-operations-simplified.ts`)
 *    — literally the same per-task creation path `vikunja_task_bulk
 *    bulk-create` uses (title/description/dates via `normalizeDateForApi`,
 *    priority, labels, assignees), extracted for the same "need the raw
 *    created `Task` back" reason.
 *  - `moveTaskToBucket` (`src/tools/tasks/buckets.ts`) — the exact bucket
 *    placement `set-bucket`/`bulk-set-bucket` use.
 *  - `ensureLabelByTitle` (`src/utils/label-ensure.ts`) — the same
 *    get-or-create-by-title label resolution `vikunja_task_labels
 *    apply-label` uses, so this composite's tasks can carry human-readable
 *    label titles instead of requiring pre-resolved numeric ids.
 *
 * Idempotent-ish existing-project reuse: when `id` is supplied instead of
 * `title`, no new project is created. The project's Kanban view and its
 * existing buckets are read first; requested columns are matched against
 * existing bucket titles (case-insensitive) and reused rather than
 * duplicated. A requested column with no title match repurposes the first
 * still-unclaimed existing bucket (renaming it) before falling back to
 * creating a brand new one — so calling this twice with the same columns
 * against the same project does not pile up duplicate buckets. Buckets NOT
 * claimed by any requested column are left untouched (never deleted) —
 * this composite only ever creates, renames, or reuses; it never removes.
 *
 * Ordering guarantee: every bucket this composite touches — reused,
 * renamed, or newly created — has its `position` explicitly pinned to a
 * NON-ZERO, 65536-spaced value derived from its index in the requested
 * `columns` array (`bucketPositionForIndex`: `(index + 1) * 65536`), never
 * the raw zero-based index. This holds regardless of the buckets'
 * pre-existing positions, so the resulting board's column order always
 * matches the requested order exactly. The non-zero requirement is load
 * bearing, not cosmetic — see `bucketPositionForIndex`'s doc comment for the
 * omitted-vs-zero wire ambiguity that silently broke ordering for whichever
 * column landed at index 0.
 *
 * Fail fast on an unknown column (issue #173 follow-up, live-harness
 * finding): every task's `column` (when given) is validated against the
 * requested `columns` list UP FRONT — before the project, view, or any
 * bucket/task is touched — since that list is fully known with zero API
 * calls. A task naming a column outside that list rejects the WHOLE call
 * with a `VALIDATION_ERROR` naming the offending column, the task's title,
 * and the valid column names; nothing is created. This is deliberately
 * NOT part of the "honest partial failure" reporting below — a typo in
 * `column` is a caller mistake, not a runtime failure, and rejecting it
 * up front is cheap to recover from (re-running setup-kanban reuses the
 * existing project/view/buckets rather than duplicating them), whereas an
 * orphaned created-but-unplaced task is not. A task with no `column` at all
 * is never an error — it is simply created unplaced. Same fail-fast
 * treatment applies when `columns` is omitted altogether: a task naming a
 * `column` with no `columns` array at all rejects the WHOLE call up front,
 * for the same reason — there is no board to place it on.
 *
 * Error semantics (honest, server-derived, bulk-style): resolving each
 * column and creating+placing each task are independent, try/caught
 * per-item operations — a failure in one does not abort the rest. The
 * response reports every column's and every task's actual outcome
 * (`reused`/`renamed`/`created`/`failed` for columns;
 * `placed`/`created`/`created-not-placed`/`failed` for tasks), with error
 * detail on failures — never a blanket "success" when something did not
 * land. The whole call only hard-fails when NO column could be
 * created/resolved at all (no board could be established), mirroring the
 * "throw only when nothing succeeded, otherwise report partial" contract
 * `bulkCreateTasks`/`bulkSetTaskBucket` already use. A genuine partial
 * failure (e.g. the server rejects a placement) still surfaces the
 * project's id in the SAME `(ID: N)`-extractable format the fully
 * successful path uses — see the "project ... (ID: ...)" summary line
 * below — so a caller can recover the project handle and retry rather than
 * losing track of a project that really was created.
 */

import type { AuthManager } from '../../auth/AuthManager';
import { MCPError, ErrorCode, type CreateProjectRequest } from '../../types';
import { validateId } from '../../utils/validation';
import { createStandardResponse, formatAorpAsMarkdown } from '../../utils/response-factory';
import { vikunjaRestRequest, resolveKanbanView } from '../../utils/vikunja-rest';
import { ensureLabelByTitle } from '../../utils/label-ensure';
import { fetchBuckets, createBucketRaw, updateBucketRaw } from './buckets';
import { moveTaskToBucket } from '../tasks/buckets';
import { createOneBulkTask, type BulkCreateTaskData } from '../tasks/bulk-operations';
import { MAX_BULK_OPERATION_TASKS } from '../tasks/constants';
import type { VikunjaProject } from './crud';
import type { components } from '../../types/generated/vikunja-openapi';

/** `models.Bucket` per the OpenAPI spec — see docs/API-SPEC.md. */
type VikunjaBucket = components['schemas']['models.Bucket'];

/** One task to bulk-create and (optionally) place into a named column. */
export interface SetupKanbanTaskInput {
  /** Task title. */
  title: string;
  /**
   * Name of the column (must match one of `columns`, case-insensitively) to
   * place this task into after creation. Omitted = task is created but left
   * wherever the project's Kanban view defaults new tasks to.
   */
  column?: string;
  description?: string;
  /** 0 (unset) through 5 (DO NOW), per Vikunja's priority range. */
  priority?: number;
  /** RFC3339/ISO 8601, or a date-only 'YYYY-MM-DD' (normalized to midnight UTC). */
  dueDate?: string;
  /** RFC3339/ISO 8601, or a date-only 'YYYY-MM-DD' (normalized to midnight UTC). */
  startDate?: string;
  /** RFC3339/ISO 8601, or a date-only 'YYYY-MM-DD' (normalized to midnight UTC). */
  endDate?: string;
  /** Label titles — get-or-created via `ensureLabelByTitle`, same as `apply-label`. */
  labels?: string[];
  /** Numeric assignee user ids. */
  assignees?: number[];
}

export interface SetupKanbanArgs {
  /**
   * Existing project id to set the board up on, reusing its Kanban view and
   * existing buckets by name instead of duplicating them. Mutually
   * exclusive with `title` (aliased from `projectId` at the
   * `vikunja_projects` dispatch layer — see `PROJECT_ID_ALIAS_SUBCOMMANDS`
   * in `src/tools/projects/index.ts`).
   */
  id?: number;
  /** Title for a NEW project. Required when `id` is omitted. */
  title?: string;
  /** New project's description. Only used when creating a new project (`id` omitted). */
  description?: string;
  /** New project's parent project id. Only used when creating a new project (`id` omitted). */
  parentProjectId?: number;
  /**
   * Ordered list of Kanban column (bucket) names, e.g. `["To Do", "Doing",
   * "Done"]`. Order is authoritative — see the module doc's "Ordering
   * guarantee".
   */
  columns?: string[];
  /** Tasks to bulk-create and place into their named column. */
  tasks?: SetupKanbanTaskInput[];
  /** Session id for response tracking. */
  sessionId?: string;
}

/** Per-column outcome (bulk-style honest reporting). */
export interface KanbanColumnOutcome {
  column: string;
  bucketId?: number;
  status: 'reused' | 'renamed' | 'created' | 'failed';
  error?: string;
}

/** Per-task outcome (bulk-style honest reporting). */
export interface KanbanTaskOutcome {
  index: number;
  title: string;
  taskId?: number;
  column?: string;
  bucketId?: number;
  /**
   * 'placed': created and placed into its requested column.
   * 'created': created, no column requested — nothing to place.
   * 'created-not-placed': created, but placement failed — the requested
   *   column's own bucket could not be resolved (see the columns result for
   *   why), or the bucket-move request itself failed. The task exists but is
   *   not where it was asked to be. An unrecognized column name is no longer
   *   possible here — `setupKanban` rejects the whole call up front (see its
   *   fail-fast column validation) before anything is created.
   * 'failed': task creation itself failed — no task was created.
   */
  status: 'placed' | 'created' | 'created-not-placed' | 'failed';
  error?: string;
}

/** Case-insensitive, trimmed key for matching a column/bucket title. */
function columnKey(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * Lane-spacing step between pinned bucket positions (issue #173, live probe
 * against Vikunja 2.4.0 — see PRs #175/#176). Matches the 2^16 spacing
 * Vikunja itself uses between bucket ids' default (id * 65536) positions, so
 * gaps this composite leaves are wide enough for a caller to slot another
 * bucket in between afterwards without renumbering anything.
 */
const BUCKET_POSITION_STEP = 65536;

/**
 * Bucket position to pin for a column at `index` in the requested order.
 *
 * MUST be `(index + 1) * BUCKET_POSITION_STEP` — never `index * step`. This
 * looks like an off-by-one waiting to be "simplified" away, but it isn't:
 * `models.Bucket.position` is a plain (non-pointer) `float64` on the wire, so
 * an explicit `position: 0` is byte-for-byte indistinguishable from an
 * OMITTED position. When the request carries no distinguishable position,
 * Vikunja substitutes its own id-derived default (`bucket.id * 65536`)
 * instead of honoring "first". Live-probed against Vikunja 2.4.0: sending
 * position 0/1/2 for three fresh buckets stored 8585216 (= id 131 * 65536,
 * the server default) / 1 / 2 — the column meant to be FIRST landed dead
 * LAST on the board every time. Starting the sequence at `1 * step` instead
 * of `0 * step` keeps every value this composite sends non-zero, so it is
 * always honored instead of silently discarded.
 */
function bucketPositionForIndex(index: number): number {
  return (index + 1) * BUCKET_POSITION_STEP;
}

/**
 * Resolves (reuses, renames, or creates) the Kanban bucket for every
 * requested column, IN ORDER, pinning each bucket's `position` to a
 * non-zero, 65536-spaced value derived from its column index (see
 * `bucketPositionForIndex`) so the resulting board order always matches the
 * request — see the module doc's "Ordering guarantee". Existing buckets not
 * claimed by any column are left untouched.
 */
async function resolveColumns(
  authManager: AuthManager,
  projectId: number,
  viewId: number,
  columnNames: string[],
): Promise<{ results: KanbanColumnOutcome[]; bucketIdByColumn: Map<string, number> }> {
  const existingBuckets = await fetchBuckets(authManager, projectId, viewId);
  const sortedExisting = [...existingBuckets].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  const claimedIds = new Set<number>();

  // Two-pass assignment (NOT a single left-to-right pass): reserving every
  // exact-title match FIRST, across ALL requested columns, before any
  // leftover-bucket gets repurposed for an unmatched column. A single
  // combined pass would let an early unmatched column's leftover-fallback
  // greedily consume a bucket that exact-title-matches a LATER column
  // (e.g. columns ["To Do", "Doing", "Done"] against existing buckets
  // ["Backlog", "Done"] — a single pass would consume "Done" as the
  // leftover for "Doing" before ever reaching the "Done" column itself,
  // wrongly renaming the one bucket that should have been reused as-is).
  type Assignment = { kind: 'exact' | 'leftover'; bucket: VikunjaBucket } | { kind: 'create' };
  const assignments: Assignment[] = new Array(columnNames.length) as Assignment[];

  for (let i = 0; i < columnNames.length; i++) {
    const key = columnKey(columnNames[i] as string);
    const exactMatch = sortedExisting.find(
      (b) =>
        b.id !== undefined &&
        !claimedIds.has(b.id) &&
        typeof b.title === 'string' &&
        b.title.toLowerCase() === key,
    );
    if (exactMatch) {
      claimedIds.add(exactMatch.id as number);
      assignments[i] = { kind: 'exact', bucket: exactMatch };
    }
  }
  for (let i = 0; i < columnNames.length; i++) {
    if (assignments[i]) continue;
    const leftover = sortedExisting.find((b) => b.id !== undefined && !claimedIds.has(b.id));
    if (leftover) {
      claimedIds.add(leftover.id as number);
      assignments[i] = { kind: 'leftover', bucket: leftover };
    } else {
      assignments[i] = { kind: 'create' };
    }
  }

  // Perform the actual REST calls in requested column order, regardless of
  // which pass produced each assignment.
  const results: KanbanColumnOutcome[] = [];
  const bucketIdByColumn = new Map<string, number>();

  for (let i = 0; i < columnNames.length; i++) {
    const name = columnNames[i] as string;
    const key = columnKey(name);
    const assignment = assignments[i] as Assignment;
    try {
      let bucket: VikunjaBucket;
      let status: KanbanColumnOutcome['status'];
      const position = bucketPositionForIndex(i);
      if (assignment.kind === 'exact') {
        bucket = await updateBucketRaw(authManager, projectId, viewId, assignment.bucket, {
          position,
        });
        status = 'reused';
      } else if (assignment.kind === 'leftover') {
        bucket = await updateBucketRaw(authManager, projectId, viewId, assignment.bucket, {
          title: name,
          position,
        });
        status = 'renamed';
      } else {
        bucket = await createBucketRaw(authManager, projectId, viewId, { title: name, position });
        status = 'created';
      }

      if (typeof bucket.id !== 'number') {
        throw new Error(`Bucket operation for column "${name}" returned no numeric id`);
      }
      bucketIdByColumn.set(key, bucket.id);
      results.push({ column: name, bucketId: bucket.id, status });
    } catch (error) {
      results.push({
        column: name,
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { results, bucketIdByColumn };
}

/**
 * Bulk-creates the requested tasks (sequential — the same SQLite
 * write-lock discipline `bulkCreateTasks`/`bulkSetTaskBucket` follow) and
 * places each into its named column via `moveTaskToBucket`. Label titles
 * are resolved to ids via `ensureLabelByTitle` before creation.
 */
async function createAndPlaceTasks(
  authManager: AuthManager,
  projectId: number,
  viewId: number | undefined,
  bucketIdByColumn: Map<string, number>,
  tasks: SetupKanbanTaskInput[],
): Promise<KanbanTaskOutcome[]> {
  const results: KanbanTaskOutcome[] = [];

  for (let i = 0; i < tasks.length; i++) {
    const t = tasks[i] as SetupKanbanTaskInput;
    try {
      let labelIds: number[] | undefined;
      if (t.labels && t.labels.length > 0) {
        labelIds = [];
        for (const labelTitle of t.labels) {
          const ensured = await ensureLabelByTitle(authManager, labelTitle);
          labelIds.push(ensured.id);
        }
      }

      const bulkTaskData: BulkCreateTaskData = { title: t.title.trim() };
      if (t.description !== undefined) bulkTaskData.description = t.description;
      if (t.dueDate !== undefined) bulkTaskData.dueDate = t.dueDate;
      if (t.startDate !== undefined) bulkTaskData.startDate = t.startDate;
      if (t.endDate !== undefined) bulkTaskData.endDate = t.endDate;
      if (t.priority !== undefined) bulkTaskData.priority = t.priority;
      if (labelIds !== undefined) bulkTaskData.labels = labelIds;
      if (t.assignees !== undefined) bulkTaskData.assignees = t.assignees;

      const created = await createOneBulkTask(authManager, projectId, bulkTaskData);
      if (typeof created.id !== 'number') {
        throw new Error(`Task "${t.title}" was created but returned no numeric id`);
      }
      const taskId = created.id;

      if (t.column === undefined) {
        results.push({ index: i, title: t.title, taskId, status: 'created' });
        continue;
      }

      const key = columnKey(t.column);
      const bucketId = bucketIdByColumn.get(key);
      if (bucketId === undefined) {
        // Every task's column was already validated (up front, before any
        // write) against the requested `columns` list — see setupKanban's
        // fail-fast validation. So reaching here means the column WAS
        // requested but its bucket resolution failed (see the columns
        // result for the failure reason), never an unrecognized name.
        results.push({
          index: i,
          title: t.title,
          taskId,
          column: t.column,
          status: 'created-not-placed',
          error:
            `column "${t.column}" was requested but its bucket could not be resolved — see the ` +
            'columns result for the failure reason',
        });
        continue;
      }

      try {
        // bucketId only resolves on the columns path, where viewId is
        // always set before resolveColumns runs (setupKanban step 2/3).
        await moveTaskToBucket(authManager, {
          taskId,
          bucketId,
          viewId: viewId,
          projectId,
        });
        results.push({
          index: i,
          title: t.title,
          taskId,
          column: t.column,
          bucketId,
          status: 'placed',
        });
      } catch (moveError) {
        results.push({
          index: i,
          title: t.title,
          taskId,
          column: t.column,
          status: 'created-not-placed',
          error: moveError instanceof Error ? moveError.message : String(moveError),
        });
      }
    } catch (error) {
      results.push({
        index: i,
        title: t.title,
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return results;
}

/**
 * Provisions a whole Kanban board in one call: creates (or reuses) the
 * project, ensures its Kanban view, resolves the requested columns IN
 * ORDER (reusing/renaming/creating buckets as needed), then bulk-creates
 * and places the requested tasks. See the module doc comment for the full
 * design (reuse strategy, ordering guarantee, error semantics).
 */
export async function setupKanban(
  args: SetupKanbanArgs,
  authManager: AuthManager,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  // `columns` is optional (issue #185): when omitted entirely, this call is
  // a project+tasks-only composite — no Kanban view, bucket, or placement
  // step runs at all (see the "columns-less path" branches below). An
  // EXPLICITLY empty array is still rejected, same as before — it signals a
  // caller mistake (omit the field instead) rather than "no board".
  const hasColumns = args.columns !== undefined;
  if (hasColumns && args.columns?.length === 0) {
    throw new MCPError(
      ErrorCode.VALIDATION_ERROR,
      'When columns is provided it must be a non-empty array of column/bucket names (e.g. ' +
        '["To Do", "Doing", "Done"]) — omit columns entirely for the project+tasks-only path.',
    );
  }
  if (hasColumns && args.columns?.some((c) => typeof c !== 'string' || c.trim() === '')) {
    throw new MCPError(
      ErrorCode.VALIDATION_ERROR,
      'Every entry in columns must be a non-empty string.',
    );
  }
  const columnNames = hasColumns ? (args.columns as string[]).map((c) => c.trim()) : [];

  if (args.id === undefined && (!args.title || args.title.trim() === '')) {
    throw new MCPError(
      ErrorCode.VALIDATION_ERROR,
      'Either id (an existing project to set up the board on) or title (to create a new ' +
        'project) is required for setup-kanban operation.',
    );
  }
  if (args.id !== undefined) validateId(args.id, 'id');
  if (args.parentProjectId !== undefined) validateId(args.parentProjectId, 'parentProjectId');

  const tasks = args.tasks ?? [];
  if (tasks.length > MAX_BULK_OPERATION_TASKS) {
    throw new MCPError(
      ErrorCode.VALIDATION_ERROR,
      `Too many tasks for setup-kanban. Maximum allowed: ${MAX_BULK_OPERATION_TASKS}. Consider ` +
        'breaking into smaller batches.',
    );
  }
  // Fail fast on an unknown column name — checkable with ZERO API calls,
  // since the requested `columns` list is fully known before any write
  // happens. Rejecting the WHOLE call up front (nothing gets created) is
  // far cheaper for the caller to recover from than the alternative: a task
  // gets created against an unrecognized column name, cannot be placed, and
  // is left orphaned in whatever bucket the view defaults new tasks to,
  // alongside a partial-failure response. Re-running setup-kanban is
  // reuse-safe (see the module doc's "Idempotent-ish existing-project
  // reuse"), so an up-front rejection costs nothing to retry. A task with NO
  // `column` is left as-is — that is not an error, it is simply created
  // unplaced (see KanbanTaskOutcome's 'created' status).
  const columnKeySet = new Set(columnNames.map((c) => columnKey(c)));
  tasks.forEach((t, i) => {
    if (!t.title || t.title.trim() === '') {
      throw new MCPError(ErrorCode.VALIDATION_ERROR, `tasks[${i}].title is required`);
    }
    if (t.column === undefined) return;
    if (!hasColumns) {
      throw new MCPError(
        ErrorCode.VALIDATION_ERROR,
        `tasks[${i}] ("${t.title.trim()}") has column "${t.column}" but no columns were ` +
          'provided to setup-kanban. Either add a `columns` array (e.g. ["To Do", "Doing", ' +
          '"Done"]) or remove `column` from this task and re-run — no project, view, bucket, ' +
          'or task has been created by this call.',
      );
    }
    if (!columnKeySet.has(columnKey(t.column))) {
      throw new MCPError(
        ErrorCode.VALIDATION_ERROR,
        `tasks[${i}] ("${t.title.trim()}") has column "${t.column}" which is not one of the ` +
          `requested columns: ${columnNames.join(', ')}. Fix the column name (or add it to ` +
          '`columns`) and re-run setup-kanban — no project, view, bucket, or task has been ' +
          'created by this call.',
      );
    }
  });

  // 1. Resolve or create the project.
  let projectId: number;
  let projectTitle: string | undefined;
  let projectCreated = false;
  if (args.id !== undefined) {
    projectId = args.id;
  } else {
    const trimmedTitle = (args.title as string).trim();
    const projectBody: CreateProjectRequest = { title: trimmedTitle };
    if (args.description !== undefined) projectBody.description = args.description;
    if (args.parentProjectId !== undefined) projectBody.parent_project_id = args.parentProjectId;

    const createdProject = await vikunjaRestRequest<VikunjaProject>(
      authManager,
      'PUT',
      '/projects',
      projectBody,
    );
    if (typeof createdProject.id !== 'number') {
      throw new MCPError(
        ErrorCode.API_ERROR,
        `Project "${trimmedTitle}" was created but returned no numeric id`,
      );
    }
    projectId = createdProject.id;
    projectTitle = createdProject.title;
    projectCreated = true;
  }

  // 2. Resolve the Kanban view — auto-created by Vikunja for a brand new
  // project; must already exist for a reused project (propagates a clear
  // NOT_FOUND if it doesn't, same as list-buckets/create-bucket). Skipped
  // entirely on the columns-less path (issue #185) — no Kanban view, bucket,
  // or placement step runs when the caller didn't ask for a board, so this
  // path costs strictly fewer API calls than the columns form, not the same.
  let viewId: number | undefined;
  let columnResults: KanbanColumnOutcome[] = [];
  let bucketIdByColumn = new Map<string, number>();
  let columnFailures: KanbanColumnOutcome[] = [];
  if (hasColumns) {
    const kanbanView = await resolveKanbanView(authManager, projectId);
    viewId = kanbanView.id;

    // 3. Resolve every requested column's bucket, IN ORDER.
    const resolved = await resolveColumns(authManager, projectId, viewId, columnNames);
    columnResults = resolved.results;
    bucketIdByColumn = resolved.bucketIdByColumn;

    columnFailures = columnResults.filter((c) => c.status === 'failed');
    if (columnResults.length > 0 && columnFailures.length === columnResults.length) {
      throw new MCPError(
        ErrorCode.API_ERROR,
        `Kanban setup failed: could not create or resolve any of the ${columnResults.length} ` +
          `requested columns in project ${projectId}. First error: ` +
          `${columnFailures[0]?.error ?? 'unknown error'}`,
      );
    }
  }

  // 4. Bulk-create the requested tasks and place each into its column.
  const taskResults = await createAndPlaceTasks(
    authManager,
    projectId,
    viewId,
    bucketIdByColumn,
    tasks,
  );

  // 5. Build the honest, server-derived summary — never claim success for
  // anything that did not land.
  const taskFailures = taskResults.filter((r) => r.status === 'failed');
  const taskNotPlaced = taskResults.filter((r) => r.status === 'created-not-placed');
  const partial = columnFailures.length > 0 || taskFailures.length > 0 || taskNotPlaced.length > 0;

  // The project id is embedded in the SAME `(ID: N)` format
  // `formatListItemLine`/`formatSingleDataItem` (src/utils/simple-response.ts)
  // already use for every other tool's created/fetched resources, and is
  // what `extractId` (scripts/mcp-e2e.ts) parses. This must survive on the
  // PARTIAL-failure path too: `formatErrorMessage` (used whenever
  // `metadata.success` is false, see the comment on `detailParts` below)
  // drops the `data` payload entirely, so the message TEXT is the only
  // place a caller can recover the id of a project that really was
  // created — never leave it as bare prose ("project 15 created") that no
  // extractor can parse.
  const summaryParts = [
    `project ${projectId} ${projectCreated ? 'created' : 'reused'} (ID: ${projectId})`,
  ];
  if (hasColumns) {
    summaryParts.push(
      `${columnResults.length - columnFailures.length}/${columnResults.length} columns ready`,
    );
  }
  if (tasks.length > 0) {
    summaryParts.push(`${tasks.length - taskFailures.length}/${tasks.length} tasks created`);
    if (taskNotPlaced.length > 0) {
      summaryParts.push(`${taskNotPlaced.length} created but not placed in their column`);
    }
  }

  // `formatErrorMessage` (src/utils/simple-response.ts) — used whenever
  // `metadata.success` is false — drops the `data` payload entirely and
  // only renders a handful of known metadata keys (`failures`,
  // `failedCount`, `count`). This is the exact convention
  // `bulkCreateTasks`/`bulkSetTaskBucket` already rely on for honest
  // partial-failure reporting, so failure detail is embedded in BOTH the
  // message text (always visible) and a `failures` metadata array
  // (visible via formatErrorMessage) — never left to the `data.columns` /
  // `data.taskResults` arrays alone, which only render on the fully
  // successful path.
  const detailParts: string[] = [];
  if (columnFailures.length > 0) {
    detailParts.push(
      `Failed columns: ${columnFailures.map((c) => `"${c.column}" (${c.error ?? 'unknown error'})`).join('; ')}.`,
    );
  }
  if (taskFailures.length > 0) {
    detailParts.push(
      `Failed tasks: ${taskFailures
        .map((t) => `#${t.index} "${t.title}" (${t.error ?? 'unknown error'})`)
        .join('; ')}.`,
    );
  }
  if (taskNotPlaced.length > 0) {
    detailParts.push(
      `Created but not placed: ${taskNotPlaced
        .map(
          (t) =>
            `#${t.index} "${t.title}" -> "${String(t.column)}" (${t.error ?? 'unknown error'})`,
        )
        .join('; ')}.`,
    );
  }

  const summaryLine = `${partial ? 'Kanban setup partially completed' : 'Kanban setup completed'}: ${summaryParts.join(', ')}.`;
  const message = detailParts.length > 0 ? `${summaryLine} ${detailParts.join(' ')}` : summaryLine;

  const failures = [
    ...columnFailures.map((c) => ({ type: 'column' as const, column: c.column, error: c.error })),
    ...taskFailures.map((t) => ({
      type: 'task' as const,
      index: t.index,
      title: t.title,
      error: t.error,
    })),
    ...taskNotPlaced.map((t) => ({
      type: 'task-not-placed' as const,
      index: t.index,
      title: t.title,
      taskId: t.taskId,
      column: t.column,
      error: t.error,
    })),
  ];

  const response = createStandardResponse(
    'setup-kanban',
    message,
    {
      projectId,
      projectCreated,
      ...(projectTitle !== undefined && { projectTitle }),
      // `viewId`/`columns` only exist when a board was actually requested —
      // never fabricated on the columns-less path (issue #185), where no
      // Kanban view was even resolved.
      ...(hasColumns && { viewId, columns: columnResults }),
      // Named `taskResults` (not `tasks`) — `ResponseData.tasks` is typed
      // `Task[]` (full Vikunja task objects) for other tools' responses;
      // this composite's per-task outcomes are a different, smaller shape
      // (see `KanbanTaskOutcome`), so reusing that key would collide with
      // `createStandardResponse`'s data typing. Only rendered on the fully
      // successful path — see the comment above `detailParts`.
      taskResults,
    },
    {
      timestamp: new Date().toISOString(),
      success: !partial,
      count: taskResults.length - taskFailures.length,
      ...(partial && { failures, failedCount: failures.length }),
    },
    args.sessionId,
  );

  return {
    content: [{ type: 'text' as const, text: formatAorpAsMarkdown(response) }],
  };
}
