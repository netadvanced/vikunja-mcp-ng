/**
 * Simplified bulk operations for tasks (~250 lines)
 *
 * This superseded the old bulk/ implementation (BulkOperationProcessor,
 * BulkOperationErrorHandler, BatchProcessorFactory), which was dead code -
 * unreachable from src/tools/index.ts or src/tools/tasks/index.ts - and has
 * since been deleted. Only BulkOperationValidator survives from that folder,
 * reused here for its field/value validation.
 */

import {
  MCPError,
  ErrorCode,
  createStandardResponse,
  logger,
  isAuthenticationError,
  RETRY_CONFIG,
  transformApiError,
  handleFetchError,
} from '../../index';
import type { AuthManager } from '../../auth/AuthManager';
import { vikunjaRestRequest } from '../../utils/vikunja-rest';
import { getTaskViaRest } from '../../utils/task-rest-transport';
import { withRetry } from '../../utils/retry';
import { setTaskLabels } from '../../utils/label-bulk';
import { BatchProcessor } from '../../utils/performance/batch-processor';
import type { components } from '../../types/generated/vikunja-openapi';
import { convertRepeatConfiguration, applyFieldUpdate, normalizeDateForApi } from './validation';
import { percentDoneToFraction } from '../../utils/percent-done';
import { formatAorpAsMarkdown } from '../../utils/response-factory';
import { AUTH_ERROR_MESSAGES, REPEAT_MODE_MAP } from './constants';
import { bulkOperationValidator } from './bulk/BulkOperationValidator';
import type {
  BulkUpdateArgs,
  BulkDeleteArgs,
  BulkCreateArgs,
  BulkCreateTaskData,
} from './bulk/BulkOperationValidator';

/** `models.Task` per the OpenAPI spec — request/response shape for the task endpoints. */
type Task = components['schemas']['models.Task'];
/** `models.BulkTask` per the OpenAPI spec — request/response shape for POST /tasks/bulk. */
type BulkTask = components['schemas']['models.BulkTask'];
/**
 * `models.BulkAssignees` per the OpenAPI spec — request body for
 * `POST /tasks/{taskID}/assignees/bulk`. REPLACE semantics: the task's
 * assignees become exactly this list. Used ONLY for the post-bulk-update
 * assignee restore below, where that's exactly what's wanted (a complete
 * snapshot is being restored) — see the comment at the call site and
 * docs/ENDPOINT-TAIL-RETRIAGE.md line ~87 for why the additive per-user
 * loop remains the default everywhere else.
 */
type BulkAssignees = components['schemas']['models.BulkAssignees'];

// ==================== BATCH PROCESSORS ====================

/**
 * Default concurrency for bulk task **creates**: sequential. See the long
 * comment on `processors.create` below for why, and `getBulkWriteConcurrency`
 * for the opt-in override.
 */
const DEFAULT_BULK_WRITE_CONCURRENCY = 1;
/** Env var that overrides {@link DEFAULT_BULK_WRITE_CONCURRENCY}. */
const BULK_WRITE_CONCURRENCY_ENV_VAR = 'VIKUNJA_BULK_WRITE_CONCURRENCY';
/**
 * Hard upper bound for the override. 10 is already far past the point where the
 * historical SQLite lock storm reproduced (it reproduced at 8), so anything
 * higher is a typo or a misunderstanding, not a tuning choice.
 */
const MAX_BULK_WRITE_CONCURRENCY = 10;

const processors = {
  update: new BatchProcessor({
    maxConcurrency: 5,
    batchSize: 10,
    enableMetrics: true,
    batchDelay: 0,
  }),
  delete: new BatchProcessor({
    maxConcurrency: 3,
    batchSize: 5,
    enableMetrics: true,
    batchDelay: 100,
  }),
  // Creates are WRITES and must run sequentially. On SQLite-backed Vikunja
  // (the default deployment), N concurrent task creates 500 with "database is
  // locked"; the REST layer's 5xx retry then re-enters the still-contended
  // pool, and the burst of failures trips the shared
  // `vikunja-rest-projects-tasks` circuit breaker — after which EVERY create
  // fails instantly with "Breaker is open" until the reset timeout. Live
  // repro on 2.3.0: three 12-task bulk-creates at maxConcurrency 8 yielded
  // 2/12, 0/12, 0/12. Sequential creates never storm the lock, so the
  // existing retry absorbs the odd transient 500 and the breaker stays
  // closed (36/36 in the same scenario). Same reasoning as the #97 sweep's
  // "bounded/sequential writes" rule — this call site was previously ruled
  // safe-as-is on the assumption that bounded-at-8 plus retry was enough.
  //
  // Current status (2.4.0 alignment, tracking issue #28 item A1): Vikunja
  // 2.4.0's `GET /api/v1/info` advertises a new `concurrent_writes: true`
  // field, and the same 12-task bulk-create stress check run repeatedly
  // against a 2.4.0/sqlite stack came back clean (12/12) every time — see
  // docs/LOCAL-TESTING.md's SQLite section / docs/API-COVERAGE.md for the
  // pass-rate numbers. This strongly suggests upstream shipped (or now at
  // least advertises) a real SQLite write-concurrency fix. This
  // client-side serialization is **retained regardless, as defense-in-depth**
  // — serializing creates costs little in the common (small-N) case.
  //
  // Revisit condition (unchanged, and it is a CONJUNCTION): only reconsider
  // dropping this once the minimum supported Vikunja version is raised to
  // >= 2.4.0 AND further multi-run evidence (beyond this wave's handful of
  // runs) confirms the fix is durable across upstream point releases, not a
  // one-off. **Status 2026-08-31: the first arm has fired** — the floor rose
  // 2.3.0 -> 2.4.0 (docs/ROADMAP.md §3 decision 27), so every supported
  // server now advertises `concurrent_writes`. The second arm has not: no
  // evidence has been gathered beyond the original 2.4.0-alignment runs.
  // Do not drop the serialization on the first arm alone.
  //
  // Cross-request scope (issue #288): the serialization below is enforced by
  // a semaphore that lives on the BatchProcessor instance, so it binds every
  // caller of this singleton for the life of the process — not just the
  // requests inside one bulk call. That matters under
  // `VIKUNJA_MCP_TRANSPORT=http`, where one process serves many identities
  // concurrently and N simultaneous bulk-creates would otherwise produce N
  // independent create bursts against the same upstream Vikunja.
  //
  // Escape hatch: `VIKUNJA_BULK_WRITE_CONCURRENCY` (see
  // `getBulkWriteConcurrency` below and docs/CONFIGURATION.md) raises this at
  // the caller's own risk for deployments that are *not* SQLite-backed — the
  // default is unchanged at 1, and the per-call override is applied in
  // `bulkCreateTasks`, not baked in here, so it stays readable at runtime.
  // Proposed by @joyjit in democratize-technology/vikunja-mcp#97.
  create: new BatchProcessor({
    maxConcurrency: DEFAULT_BULK_WRITE_CONCURRENCY,
    batchSize: 15,
    enableMetrics: true,
    batchDelay: 0,
  }),
};

/**
 * Resolve the concurrency used for bulk task **creates**.
 *
 * Defaults to {@link DEFAULT_BULK_WRITE_CONCURRENCY} (1 — sequential), which is
 * the safe setting for SQLite-backed Vikunja instances for the reasons spelled
 * out on `processors.create` above. `VIKUNJA_BULK_WRITE_CONCURRENCY` lets an
 * operator who knows their backend is not SQLite (Postgres/MySQL) trade that
 * safety for throughput.
 *
 * Deliberately read on every call rather than at module load so the value is
 * observable in tests and so a long-running server picks up a changed
 * environment without a rebuild; the read is a couple of string ops per bulk
 * request, not per task.
 *
 * Invalid values never throw — they log a warning and fall back to the default
 * (or the cap), mirroring `getMaxTasksLimit()` in `src/utils/memory.ts`. A
 * typo in an env var must not take the server down at startup.
 *
 * Scope: **creates only.** `processors.update` (5) drives per-task fallback
 * updates and `processors.delete` (3) drives deletes; those numbers are
 * ordinary throughput tuning that has never been reported as a problem, while
 * create's `1` is a workaround for a specific server-side defect and is
 * therefore the only one an operator has a principled reason to change.
 */
export function getBulkWriteConcurrency(): number {
  const raw = process.env[BULK_WRITE_CONCURRENCY_ENV_VAR];
  if (raw === undefined || raw.trim() === '') {
    return DEFAULT_BULK_WRITE_CONCURRENCY;
  }

  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    logger.warn(
      `Invalid ${BULK_WRITE_CONCURRENCY_ENV_VAR} value: ${raw}. Must be a positive integer. ` +
        `Using default: ${DEFAULT_BULK_WRITE_CONCURRENCY}`,
    );
    return DEFAULT_BULK_WRITE_CONCURRENCY;
  }

  const parsed = parseInt(trimmed, 10);
  if (parsed <= 0) {
    logger.warn(
      `Invalid ${BULK_WRITE_CONCURRENCY_ENV_VAR} value: ${raw}. Must be a positive integer. ` +
        `Using default: ${DEFAULT_BULK_WRITE_CONCURRENCY}`,
    );
    return DEFAULT_BULK_WRITE_CONCURRENCY;
  }

  if (parsed > MAX_BULK_WRITE_CONCURRENCY) {
    logger.warn(
      `${BULK_WRITE_CONCURRENCY_ENV_VAR} value too high: ${parsed}. ` +
        `Capping at ${MAX_BULK_WRITE_CONCURRENCY}.`,
    );
    return MAX_BULK_WRITE_CONCURRENCY;
  }

  return parsed;
}

// ==================== VALIDATION WRAPPERS ====================

// Re-use validation logic from BulkOperationValidator to eliminate duplication
const validateBulkUpdate = (args: BulkUpdateArgs): void => {
  bulkOperationValidator.validateBulkUpdate(args);
  bulkOperationValidator.preprocessFieldValue(args);
  bulkOperationValidator.validateFieldConstraints(args);
};

const validateBulkCreate = (args: BulkCreateArgs): void =>
  bulkOperationValidator.validateBulkCreate(args);
const validateBulkDelete = (args: BulkDeleteArgs): void =>
  bulkOperationValidator.validateBulkDelete(args);

// Re-export types for backward compatibility
export type { BulkUpdateArgs, BulkDeleteArgs, BulkCreateArgs, BulkCreateTaskData };

// ==================== RESPONSE HELPERS ====================

interface SuccessResponse {
  content: Array<{ type: 'text'; text: string }>;
}

const successResponse = (
  op: string,
  msg: string,
  tasks: Task[],
  meta: Record<string, unknown>,
): SuccessResponse => ({
  content: [
    {
      type: 'text' as const,
      text: formatAorpAsMarkdown(
        createStandardResponse(
          op,
          msg,
          { tasks } as unknown as Parameters<typeof createStandardResponse>[2],
          { timestamp: new Date().toISOString(), ...meta },
        ),
      ),
    },
  ],
});

/**
 * Resolve bulk-update field value for Vikunja's updateTask payload.
 * Native bulk API used a numeric repeat_mode map; keep that conversion when merging.
 *
 * This is the single conversion point for the whole bulk-update path: its
 * return value feeds BOTH the native `POST /tasks/bulk` payload's `values`
 * and the per-task fallback's `applyFieldUpdate` merge, so every wire-shape
 * translation (repeat_mode enum, date normalization, and the percent_done
 * percentage -> fraction scale) belongs here and nowhere downstream.
 */
function resolveBulkUpdateValue(field: string | undefined, value: unknown): unknown {
  if (field === 'repeat_mode' && typeof value === 'string') {
    return REPEAT_MODE_MAP[value] ?? value;
  }
  // percent_done crosses our boundary as a whole percentage 0-100 (the same
  // scale as `percentDone` everywhere else, even though this path names the
  // field by its raw snake_case API spelling) and reaches Vikunja as the 0-1
  // wire fraction. BulkOperationValidator has already rejected anything that
  // is not an integer 0-100 by the time this runs.
  if (field === 'percent_done' && typeof value === 'number') {
    return percentDoneToFraction(value);
  }
  // Coerce date-only 'YYYY-MM-DD' values to RFC3339 - Vikunja silently
  // drops a bare date-only due_date/start_date/end_date (issue #164).
  if (['due_date', 'start_date', 'end_date'].includes(field ?? '') && typeof value === 'string') {
    return normalizeDateForApi(value);
  }
  return value;
}

/** One task's pre-update assignee snapshot: task id -> its complete assignee id list. */
type AssigneeSnapshot = Map<number, number[]>;

/**
 * Restore each snapshotted task's assignees to exactly its pre-update list.
 *
 * This is a restore-to-snapshot, not a general assign flow: `userIds` is the
 * task's own complete pre-update assignee list, so ONE
 * `POST /tasks/{taskID}/assignees/bulk` (`models.BulkAssignees`, REPLACE
 * semantics) call per task sets it back to exactly that list — safe here
 * precisely because the whole set is known, unlike the additive per-user
 * `PUT /assignees` loop used everywhere else for general assign/unassign
 * (where replace semantics would silently unassign everyone else — upstream
 * issue democratize-technology/vikunja-mcp#15; see the PARKED note in
 * docs/ENDPOINT-TAIL-RETRIAGE.md line ~87). Sequential across tasks on
 * purpose: concurrent writes 500 with "database is locked" on SQLite backends.
 *
 * Failures are returned (not just logged) so a lost assignee is surfaced to
 * the caller rather than silently swallowed — same {taskId, userId} failure
 * surface as PR #95's `assigneeRestoreFailures` contract, populated per-task
 * instead of per-user-per-task.
 *
 * Extracted to a named function (issue #267) because the restore now has TWO
 * call sites: the native bulk path, and the per-task fallback that path can
 * hand off to *after* the destructive `POST /tasks/bulk` has already run.
 */
async function restoreAssigneeSnapshot(
  authManager: AuthManager,
  snapshot: AssigneeSnapshot,
): Promise<Array<{ taskId: number; userId: number }>> {
  const failures: Array<{ taskId: number; userId: number }> = [];
  for (const [taskId, userIds] of snapshot) {
    const body: BulkAssignees = { assignees: userIds.map((userId) => ({ id: userId })) };
    try {
      await vikunjaRestRequest(authManager, 'POST', `/tasks/${taskId}/assignees/bulk`, body);
    } catch (e) {
      logger.warn('Could not restore assignees after bulk update', {
        taskId,
        userIds,
        error: e instanceof Error ? e.message : String(e),
      });
      for (const userId of userIds) {
        failures.push({ taskId, userId });
      }
    }
  }
  return failures;
}

/** `Assignee restoration failed for task(s): ...` suffix, or '' when nothing failed. */
function assigneeRestoreNote(failures: Array<{ taskId: number; userId: number }>): string {
  if (failures.length === 0) return '';
  const taskIds = [...new Set(failures.map((f) => f.taskId))];
  return ` Assignee restoration failed for task(s): ${taskIds.join(', ')}.`;
}

// ==================== BULK UPDATE ====================

/**
 * Bulk-update.
 *
 * Scalar fields go through Vikunja's native `POST /tasks/bulk` in ONE request.
 * The endpoint's real contract (see `models.BulkTask` in the generated OpenAPI
 * types) is `{ task_ids, fields: string[], values: models.Task }` — the server
 * applies exactly the listed fields and preserves everything else. The old
 * belief that the endpoint full-replaces tasks came from node-vikunja's stale
 * `{ task_ids, field, value }` type (democratize-technology/vikunja-mcp#46):
 * with that malformed payload the server sees `fields: null` and applies a
 * zero-value task. A single request also sidesteps the `database is locked`
 * partial failures that concurrent per-task updates hit on SQLite-backed
 * instances (democratize-technology/vikunja-mcp#79).
 *
 * Two server-side caveats handled here — source-verified against
 * go-vikunja/vikunja's `pkg/models/tasks.go` and `task_assignees.go`, not
 * just observed live behavior:
 * - **Assignees**: `updateSingleTask()` calls `updateTaskAssignees(s,
 *   t.Assignees, a)` *before* the `fields`-allowlist gate is even evaluated,
 *   reconciling to whatever `values.assignees` decoded to. A scalar-only
 *   bulk request never sets that field, so it decodes to `nil`, which trips
 *   the unconditional full-delete branch in `task_assignees.go` for every
 *   task in `task_ids` — regardless of what `fields` lists. So assignees are
 *   snapshotted first and restored afterwards (see below).
 * - **Labels**: genuinely inert, not merely unscoped — the label-sync call
 *   in that same `updateSingleTask()` is literally commented out upstream
 *   (`// Maybe FIXME:`, an acknowledged, unresolved refactor need), for both
 *   `POST /tasks/bulk` and single-task `POST /tasks/{id}`. So labels always
 *   use the dedicated per-task label endpoint, not because the bulk
 *   endpoint clears them, but because it never touches them at all.
 *
 * Current status (2.4.0 alignment, tracking issue #28 item A1): the
 * assignee-wipe defect is **not version-gated and has no removal
 * condition** — a dedicated v2-API research report (2026-07-20) confirmed
 * the exact same unconditional `ot.updateTaskAssignees(s, t.Assignees, a)`
 * call exists, byte-for-byte unchanged, in the shared model code on
 * `origin/main` (i.e. also present in whatever ships in v2.4.0+ and in
 * Vikunja's newer v2 API, which calls into the identical
 * `models.BulkTask.Update()` chain — there is no PATCH alternative for bulk
 * update in v2 either, since `bulk_task.go` registers only `PUT`, no `GET`,
 * so Huma's AutoPatch can't synthesize one). This is a standing defect in
 * shared server-side model code, orthogonal to which REST API version or
 * Vikunja release is in use — the snapshot/restore workaround below stays
 * indefinitely until upstream actually fixes `updateSingleTask`/
 * `updateTaskAssignees`, not merely until this project bumps a version pin.
 */
export async function bulkUpdateTasks(
  args: BulkUpdateArgs,
  authManager: AuthManager,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  try {
    validateBulkUpdate(args);
    // Validation ensures taskIds exists
    const taskIds = args.taskIds ?? [];
    const fieldValue = resolveBulkUpdateValue(args.field, args.value);

    /**
     * Per-task get+merge+update fallback.
     *
     * `assigneeSnapshot` is the pre-update assignee state captured before the
     * native `POST /tasks/bulk` ran. It is passed ONLY when that destructive
     * call already happened and its assignees have not been restored yet
     * (issue #267(b)): the honesty check downstream of the POST can throw, and
     * this fallback then re-fetches tasks whose assignees Vikunja has already
     * wiped — merging that empty list back would make the wipe permanent. The
     * restore therefore has to come from the snapshot, never from a re-read.
     */
    const perTaskUpdate = async (
      assigneeSnapshot?: AssigneeSnapshot,
    ): Promise<{ content: Array<{ type: 'text'; text: string }> }> => {
      const updateResult = await processors.update.processBatches(taskIds, async (taskId) => {
        const current = await vikunjaRestRequest<Task>(authManager, 'GET', `/tasks/${taskId}`);
        // Spread current task so fields not being changed survive Vikunja's full replace
        const update = applyFieldUpdate({ ...current }, args.field, fieldValue);

        const updated = await vikunjaRestRequest<Task>(
          authManager,
          'POST',
          `/tasks/${taskId}`,
          update,
        );

        if (args.field === 'assignees' && Array.isArray(args.value)) {
          const currentTask = await getTaskViaRest(authManager, taskId);
          const currentAssignees = (currentTask.assignees ?? [])
            .map((a) => a.id)
            .filter((id): id is number => typeof id === 'number');
          // Reconcile as a SET DIFFERENCE, never "add everything requested,
          // then remove everything that was there" (issue #267(c)). Verified
          // live against Vikunja 2.4.0:
          //   - re-adding an already-assigned user returns HTTP 400 code 4021
          //     "This user is already assigned to that task", which aborts the
          //     whole per-task update partway through; and
          //   - the unconditional removal loop then deleted members of the
          //     requested set, silently unassigning users the caller had just
          //     asked to keep.
          // Both disappear once the overlap is excluded from both loops.
          const requestedAssignees = args.value as number[];
          const currentSet = new Set(currentAssignees);
          const requestedSet = new Set(requestedAssignees);
          const assigneesToAdd = requestedAssignees.filter((id) => !currentSet.has(id));
          const assigneesToRemove = currentAssignees.filter((id) => !requestedSet.has(id));
          if (assigneesToAdd.length > 0) {
            try {
              // Per-user additive assign (PUT /tasks/{taskID}/assignees, body
              // { user_id }, models.TaskAssginee) instead of the bulk endpoint,
              // which REPLACES the whole list and would silently unassign
              // everyone (democratize-technology/vikunja-mcp#15). Sequential
              // on purpose (post-#89 pattern sweep, mirrors the removal loop
              // directly below): concurrent per-user writes to the same task
              // risk "database is locked" 500s on SQLite-backed instances.
              for (const userId of assigneesToAdd) {
                await withRetry(
                  () =>
                    vikunjaRestRequest(authManager, 'PUT', `/tasks/${taskId}/assignees`, {
                      user_id: userId,
                    }),
                  { ...RETRY_CONFIG.AUTH_ERRORS, shouldRetry: isAuthenticationError },
                );
              }
            } catch (assigneeError) {
              if (isAuthenticationError(assigneeError))
                throw new MCPError(
                  ErrorCode.API_ERROR,
                  'Assignee operations may have authentication issues',
                );
              throw assigneeError;
            }
          }
          // DELETE /tasks/{taskID}/assignees/{userID} per the OpenAPI spec — no body.
          for (const userId of assigneesToRemove) {
            try {
              await withRetry(
                () =>
                  vikunjaRestRequest(authManager, 'DELETE', `/tasks/${taskId}/assignees/${userId}`),
                { ...RETRY_CONFIG.AUTH_ERRORS, shouldRetry: isAuthenticationError },
              );
            } catch (e) {
              if (isAuthenticationError(e))
                throw new MCPError(
                  ErrorCode.API_ERROR,
                  `${AUTH_ERROR_MESSAGES.ASSIGNEE_REMOVE_PARTIAL} (Retried ${RETRY_CONFIG.AUTH_ERRORS.maxRetries} times)`,
                );
              throw e;
            }
          }
        }
        // Labels are never applied by Vikunja's task update payload; persist them
        // explicitly via setTaskLabels (correct labels payload shape) — re-impl #49.
        if (args.field === 'labels' && Array.isArray(args.value)) {
          await withRetry(() => setTaskLabels(authManager, taskId, args.value as number[]), {
            ...RETRY_CONFIG.AUTH_ERRORS,
            shouldRetry: isAuthenticationError,
          });
        }
        return updated;
      });
      // Put back whatever the already-executed native bulk call wiped. Runs
      // before the branches below so it happens even when every per-task
      // update failed — the assignees were destroyed by the bulk POST, not by
      // this fallback, so a failed fallback must not leave them lost.
      const assigneeRestoreFailures = assigneeSnapshot
        ? await restoreAssigneeSnapshot(authManager, assigneeSnapshot)
        : [];
      const restoreNote = assigneeRestoreNote(assigneeRestoreFailures);

      if (updateResult.failed.length > 0 && updateResult.successful.length === 0) {
        const firstError = updateResult.failed[0]?.error;
        // Preserve MCPError instances with auth messages
        if (firstError instanceof MCPError && firstError.message.includes('authentication'))
          throw firstError;
        throw new MCPError(
          ErrorCode.API_ERROR,
          `Bulk update failed. Could not update any tasks. Failed IDs: ${updateResult.failed.map((f) => f.originalItem).join(', ')}${restoreNote}`,
        );
      }
      // Report partial failure honestly (mirrors bulkDeleteTasks) instead of
      // claiming every task was updated.
      if (updateResult.failed.length > 0 || assigneeRestoreFailures.length > 0) {
        const failedIds = updateResult.failed.map((f) => f.originalItem);
        const summary =
          failedIds.length > 0
            ? `Bulk update partially completed. Successfully updated ${updateResult.successful.length} tasks. Failed task IDs: ${failedIds.join(', ')}`
            : `Successfully updated ${updateResult.successful.length} tasks`;
        return successResponse('update-task', `${summary}${restoreNote}`, updateResult.successful, {
          count: updateResult.successful.length,
          ...(failedIds.length > 0 && {
            failedCount: updateResult.failed.length,
            failedIds,
          }),
          affectedFields: [args.field],
          success: false,
          ...(assigneeRestoreFailures.length > 0 && { assigneeRestoreFailures }),
        });
      }
      return successResponse(
        'update-task',
        `Successfully updated ${taskIds.length} tasks`,
        updateResult.successful,
        {
          count: taskIds.length,
          affectedFields: [args.field],
          performanceMetrics: {
            totalDuration: updateResult.metrics.totalDuration,
            operationsPerSecond: updateResult.metrics.operationsPerSecond,
            apiCallsUsed:
              updateResult.metrics.successfulOperations + updateResult.metrics.failedOperations,
          },
        },
      );
    };

    // Assignees and labels have their own endpoints; the native bulk endpoint
    // does not handle them.
    if (args.field === 'assignees' || args.field === 'labels') {
      return await perTaskUpdate();
    }

    // Declared OUTSIDE the try so the snapshot survives into the catch: the
    // native bulk POST below is destructive to assignees and the honesty
    // check that follows it can throw, handing control to the per-task
    // fallback with the wipe already committed (issue #267(b)). Holds only
    // the tasks whose assignees still need putting back.
    let pendingAssigneeSnapshot: AssigneeSnapshot | undefined;

    try {
      // Snapshot assignees first. Verified mechanism (not just observed
      // behavior): `updateTaskAssignees` runs before the `fields` gate and
      // reconciles to `values.assignees`, which is `nil` for a scalar-only
      // bulk request, triggering a full delete (`task_assignees.go`'s
      // full-delete branch) for every task in `task_ids`, regardless of
      // `fields`. Re-confirmed live on Vikunja 2.4.0 while fixing #267: a
      // `fields:["priority"]` bulk update left the task's assignee list empty.
      const preFetch = await processors.update.processBatches(
        taskIds,
        async (id) => await vikunjaRestRequest<Task>(authManager, 'GET', `/tasks/${id}`),
      );

      // A task whose snapshot read FAILED must not enter the bulk call
      // (issue #267(a)): the endpoint would wipe its assignees and there
      // would be nothing to restore them from, and the old code reported that
      // silent loss as a full success. Drop those ids from the bulk set; they
      // surface below as ordinary missing/failed ids because the server never
      // returns them.
      const snapshotFailedIds = preFetch.failed
        .map((f) => f.originalItem)
        .filter((id): id is number => typeof id === 'number');
      const bulkTaskIds = taskIds.filter((id) => !snapshotFailedIds.includes(id));
      if (bulkTaskIds.length === 0) {
        throw new MCPError(
          ErrorCode.API_ERROR,
          'Could not read any task before the bulk update; refusing to call the ' +
            'assignee-destructive native bulk endpoint without a restorable snapshot',
        );
      }

      const assigneesByTask: AssigneeSnapshot = new Map<number, number[]>();
      for (const t of preFetch.successful) {
        if (!t?.id) continue;
        const ids = (t.assignees ?? [])
          .map((a) => a.id)
          .filter((id): id is number => typeof id === 'number');
        if (ids.length > 0) assigneesByTask.set(t.id, ids);
      }

      const payload: BulkTask = {
        task_ids: bulkTaskIds,
        fields: [args.field as string],
        values: { [args.field as string]: fieldValue },
      };
      const result = await vikunjaRestRequest<BulkTask | Task[]>(
        authManager,
        'POST',
        '/tasks/bulk',
        payload,
      );

      // The POST resolved, so the server ran `updateSingleTask` and the
      // assignee wipe is committed. From here on the snapshot is a debt owed
      // to the caller no matter which way the rest of this block exits — hand
      // it to the catch below so the per-task fallback settles it if the
      // honesty check throws (issue #267(b)). Deliberately NOT set when the
      // POST itself throws: Vikunja runs the bulk handler in a transaction,
      // so a failed call leaves assignees intact and restoring would be a
      // pointless extra write.
      pendingAssigneeSnapshot = assigneesByTask;

      // 2.x echoes { task_ids, fields, values, tasks }; tolerate a bare Task[] too.
      // The honesty check below is derived from THIS array — the server's own
      // account of what it updated — never from the requested taskIds.
      const updatedTasks: Task[] = Array.isArray(result) ? result : (result?.tasks ?? []);

      // Re-add the assignees the bulk endpoint cleared. Runs BEFORE the
      // honesty check on purpose (issue #267(b)): that check throws into the
      // per-task fallback, which re-fetches each task — and a task re-read
      // after the wipe reports an empty assignee list, so the fallback would
      // cement the loss rather than repair it.
      const assigneeRestoreFailures = await restoreAssigneeSnapshot(authManager, assigneesByTask);
      // Whatever came back restored is settled; keep only the outstanding
      // tasks so the fallback (if the honesty check throws) retries exactly
      // those and never double-writes the rest.
      const unrestoredTaskIds = new Set(assigneeRestoreFailures.map((f) => f.taskId));
      pendingAssigneeSnapshot = new Map(
        [...assigneesByTask].filter(([taskId]) => unrestoredTaskIds.has(taskId)),
      );

      // Sanity-check the server actually applied the value — guards against
      // running into an older server that ignores fields/values.
      const verifiable = ['priority', 'done', 'project_id'].includes(args.field as string);
      const applied =
        updatedTasks.length > 0 &&
        (!verifiable || updatedTasks.every((t) => t[args.field as keyof Task] === fieldValue));
      if (!applied) {
        throw new MCPError(
          ErrorCode.API_ERROR,
          'Native bulk update did not apply the requested value',
        );
      }

      // A server that silently drops a subset of the requested IDs
      // (permissions, partial bulk transaction) must not be reported as a
      // full success. Match the server-returned IDs against what was asked
      // for — `taskIds`, not `bulkTaskIds`, so tasks withheld from the bulk
      // call because their snapshot read failed are reported as failures too.
      const returnedIds = new Set(
        updatedTasks.map((t) => t.id).filter((id): id is number => typeof id === 'number'),
      );
      const missingIds = taskIds.filter((id) => !returnedIds.has(id));

      // Re-fetch when assignees were restored so the response reflects them.
      // This is presentation only — it does not feed the honesty check above,
      // which stays fixed to what POST /tasks/bulk itself returned.
      const responseTasks =
        assigneesByTask.size > 0
          ? (
              await processors.update.processBatches(
                bulkTaskIds,
                async (id) => await vikunjaRestRequest<Task>(authManager, 'GET', `/tasks/${id}`),
              )
            ).successful
          : updatedTasks;

      if (missingIds.length > 0 || assigneeRestoreFailures.length > 0) {
        const messages: string[] = [
          missingIds.length > 0
            ? `Bulk update partially completed. Successfully updated ${updatedTasks.length} tasks. Failed task IDs: ${missingIds.join(', ')}`
            : `Successfully updated ${updatedTasks.length} tasks`,
        ];
        if (snapshotFailedIds.length > 0) {
          messages.push(
            `Task(s) ${snapshotFailedIds.join(', ')} were left untouched because their ` +
              `pre-update assignee snapshot could not be read (updating them would have ` +
              `wiped their assignees unrecoverably).`,
          );
        }
        if (assigneeRestoreFailures.length > 0) {
          const restoreFailedTaskIds = [...new Set(assigneeRestoreFailures.map((f) => f.taskId))];
          messages.push(
            `Assignee restoration failed for task(s): ${restoreFailedTaskIds.join(', ')}.`,
          );
        }
        return successResponse('update-task', messages.join(' '), responseTasks, {
          count: updatedTasks.length,
          affectedFields: [args.field],
          success: false,
          ...(missingIds.length > 0 && { failedCount: missingIds.length, failedIds: missingIds }),
          ...(snapshotFailedIds.length > 0 && { snapshotFailedIds }),
          ...(assigneeRestoreFailures.length > 0 && { assigneeRestoreFailures }),
        });
      }

      return successResponse(
        'update-task',
        `Successfully updated ${taskIds.length} tasks`,
        responseTasks,
        { count: taskIds.length, affectedFields: [args.field] },
      );
    } catch (nativeError) {
      if (nativeError instanceof MCPError && nativeError.message.includes('authentication'))
        throw nativeError;
      logger.warn('Native bulk update failed; falling back to per-task merge', {
        error: nativeError instanceof Error ? nativeError.message : String(nativeError),
        field: args.field,
      });
      return await perTaskUpdate(
        pendingAssigneeSnapshot && pendingAssigneeSnapshot.size > 0
          ? pendingAssigneeSnapshot
          : undefined,
      );
    }
  } catch (error) {
    if (error instanceof MCPError) throw error;
    if (
      error instanceof Error &&
      (error.message.includes('fetch failed') ||
        error.message.includes('ECONNREFUSED') ||
        error.message.includes('ENOTFOUND'))
    )
      throw handleFetchError(error, 'bulk update tasks');
    throw transformApiError(error, 'Failed to bulk update tasks');
  }
}

// ==================== BULK DELETE ====================

export async function bulkDeleteTasks(
  args: BulkDeleteArgs,
  authManager: AuthManager,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  try {
    validateBulkDelete(args);
    // Validation ensures taskIds exists
    const taskIds = args.taskIds ?? [];

    const fetchResult = await processors.delete.processBatches(
      taskIds,
      async (id) => await vikunjaRestRequest<Task>(authManager, 'GET', `/tasks/${id}`),
    );
    const deletionResult = await processors.delete.processBatches(taskIds, async (id) => {
      await vikunjaRestRequest(authManager, 'DELETE', `/tasks/${id}`);
      return { taskId: id, deleted: true };
    });

    if (deletionResult.failed.length > 0) {
      const failedIds = deletionResult.failed.map((f) => f.originalItem);
      if (deletionResult.successful.length > 0) {
        return successResponse(
          'delete-task',
          `Bulk delete partially completed. Successfully deleted ${deletionResult.successful.length} tasks. Failed to delete task IDs: ${failedIds.join(', ')}`,
          [],
          {
            count: deletionResult.successful.length,
            failedCount: deletionResult.failed.length,
            failedIds,
            previousState: fetchResult.successful,
            success: false,
          },
        );
      }
      throw new MCPError(
        ErrorCode.API_ERROR,
        `Bulk delete failed. Could not delete any tasks. Failed IDs: ${failedIds.join(', ')}`,
      );
    }

    return successResponse('delete-task', `Successfully deleted ${taskIds.length} tasks`, [], {
      count: taskIds.length,
      deletedTaskIds: taskIds,
      previousState: fetchResult.successful,
    });
  } catch (error) {
    if (error instanceof MCPError) throw error;
    if (
      error instanceof Error &&
      (error.message.includes('fetch failed') ||
        error.message.includes('ECONNREFUSED') ||
        error.message.includes('ENOTFOUND'))
    )
      throw handleFetchError(error, 'bulk delete tasks');
    throw transformApiError(error, 'Failed to bulk delete tasks');
  }
}

// ==================== BULK CREATE ====================

/**
 * Creates a single task via the bulk-create shape (`BulkCreateTaskData`):
 * builds the `models.Task` body (dates normalized via `normalizeDateForApi`,
 * repeat config converted), `PUT`s it, then attaches labels/assignees, with
 * cleanup-on-failure (the created task is deleted if label/assignee
 * attachment fails, so a partial task never lingers as an orphan).
 *
 * Extracted from `bulkCreateTasks`'s per-item processor so this exact
 * create-one-task path (the "bulk-create path" referenced elsewhere in this
 * codebase) has a single, directly-callable implementation — used by
 * `bulkCreateTasks` itself (via `processors.create.processBatches`) and by
 * `setupKanban` (`src/tools/projects/kanban-setup.ts`), which needs the raw
 * created `Task` (with its numeric id) back to place it into a Kanban bucket
 * afterward — `bulkCreateTasks`'s own return value is a formatted MCP
 * response, not structured data suitable for that chaining.
 *
 * @param authManager - Active auth manager holding session credentials
 * @param projectId - Project the task is created in
 * @param t - The task's bulk-create field set (labels/assignees are already-resolved numeric ids)
 * @returns The created (and, if labels/assignees were supplied, re-fetched) task
 */
export async function createOneBulkTask(
  authManager: AuthManager,
  projectId: number,
  t: BulkCreateTaskData,
): Promise<Task> {
  const newTask: Task = { title: t.title, project_id: projectId };
  if (t.description !== undefined) newTask.description = t.description;
  if (t.dueDate !== undefined) newTask.due_date = normalizeDateForApi(t.dueDate) ?? t.dueDate;
  // Issue #168: startDate/endDate were accepted on the bulk task shape
  // but never forwarded, silently dropped. Mirror the dueDate handling
  // (issue #164) — coerce date-only 'YYYY-MM-DD' values to RFC3339,
  // same as resolveBulkUpdateValue does for bulk-update.
  if (t.startDate !== undefined)
    newTask.start_date = normalizeDateForApi(t.startDate) ?? t.startDate;
  if (t.endDate !== undefined) newTask.end_date = normalizeDateForApi(t.endDate) ?? t.endDate;
  if (t.priority !== undefined) newTask.priority = t.priority;
  // Whole percentage 0-100 in (see BulkCreateTaskData.percentDone), 0-1 wire
  // fraction out.
  if (t.percentDone !== undefined) newTask.percent_done = percentDoneToFraction(t.percentDone);
  if (t.repeatAfter !== undefined || t.repeatMode !== undefined) {
    const rc = convertRepeatConfiguration(t.repeatAfter, t.repeatMode);
    if (rc.repeat_after !== undefined) newTask.repeat_after = rc.repeat_after;
    if (rc.repeat_mode !== undefined) newTask.repeat_mode = rc.repeat_mode as 0 | 1 | 2;
  }

  // PUT /projects/{id}/tasks per the OpenAPI spec (models.Task body).
  const created = await vikunjaRestRequest<Task>(
    authManager,
    'PUT',
    `/projects/${projectId}/tasks`,
    newTask,
  );
  if (!created.id) return created;

  // Narrow type - id is guaranteed to exist after early return
  const createdId = created.id;

  try {
    const labels = t.labels;
    if (labels && labels.length > 0)
      await withRetry(() => setTaskLabels(authManager, createdId, labels), {
        maxRetries: RETRY_CONFIG.AUTH_ERRORS.maxRetries ?? 3,
        timeout:
          (RETRY_CONFIG.AUTH_ERRORS.initialDelay ?? 1000) +
          (RETRY_CONFIG.AUTH_ERRORS.maxDelay ?? 10000),
        shouldRetry: isAuthenticationError,
      });
    const assignees = t.assignees;
    if (assignees && assignees.length > 0) {
      try {
        // Per-user additive assign (PUT /tasks/{taskID}/assignees, body
        // { user_id }, models.TaskAssginee) instead of the bulk endpoint,
        // which REPLACES the list and would silently unassign everyone
        // (democratize-technology/vikunja-mcp#15). Sequential on
        // purpose (post-#89 pattern sweep): concurrent per-user writes
        // to the same task risk "database is locked" 500s on
        // SQLite-backed instances.
        for (const userId of assignees) {
          await withRetry(
            () =>
              vikunjaRestRequest(authManager, 'PUT', `/tasks/${createdId}/assignees`, {
                user_id: userId,
              }),
            {
              maxRetries: RETRY_CONFIG.AUTH_ERRORS.maxRetries ?? 3,
              timeout:
                (RETRY_CONFIG.AUTH_ERRORS.initialDelay ?? 1000) +
                (RETRY_CONFIG.AUTH_ERRORS.maxDelay ?? 10000),
              shouldRetry: isAuthenticationError,
            },
          );
        }
      } catch (assigneeError) {
        if (isAuthenticationError(assigneeError)) {
          throw new MCPError(
            ErrorCode.API_ERROR,
            'Assignee operations may have authentication issues',
          );
        }
        // Wrap assignee errors to distinguish from createTask errors
        if (assigneeError instanceof Error) {
          const wrappedError = new MCPError(ErrorCode.API_ERROR, assigneeError.message);
          (wrappedError as unknown as Record<string, unknown>).isLabelAssigneeError = true;
          throw wrappedError;
        }
        throw assigneeError;
      }
    }
    return await vikunjaRestRequest<Task>(authManager, 'GET', `/tasks/${createdId}`);
  } catch (updateError) {
    // Clean up the created task since labels/assignees failed
    try {
      await vikunjaRestRequest(authManager, 'DELETE', `/tasks/${createdId}`);
    } catch (deleteError) {
      logger.error('Cleanup failed', deleteError);
    }
    // Wrap label errors to distinguish from createTask errors
    if (updateError instanceof Error && !(updateError instanceof MCPError)) {
      const wrappedError = new MCPError(ErrorCode.API_ERROR, updateError.message);
      (wrappedError as unknown as Record<string, unknown>).isLabelAssigneeError = true;
      throw wrappedError;
    }
    throw updateError;
  }
}

export async function bulkCreateTasks(
  args: BulkCreateArgs,
  authManager: AuthManager,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  try {
    validateBulkCreate(args);
  } catch (error) {
    // Preserve validation errors
    if (error instanceof MCPError) throw error;
    throw error;
  }

  try {
    // Validation ensures projectId and tasks exist
    const projectId = args.projectId ?? 0;
    const tasks = args.tasks ?? [];

    // Per-call concurrency override (default: the sequential
    // DEFAULT_BULK_WRITE_CONCURRENCY baked into processors.create).
    const maxConcurrency = getBulkWriteConcurrency();
    const creationResult = await processors.create.processBatches(
      tasks.map((_, i) => i),
      async (index) => {
        const t = tasks[index];
        if (!t) throw new Error(`Task data at index ${index} is undefined`);
        return createOneBulkTask(authManager, projectId, t);
      },
      { maxConcurrency },
    );

    const failedTasks = creationResult.failed.map((f) => ({
      index: f.originalItem as number,
      error: f.error instanceof Error ? f.error.message : String(f.error),
    }));
    if (failedTasks.length > 0 && creationResult.successful.length === 0) {
      const firstError = creationResult.failed[0]?.error;
      // Preserve MCPError instances with auth messages or label/assignee marker
      if (
        firstError instanceof MCPError &&
        (firstError.message.includes('authentication') ||
          (firstError as unknown as Record<string, unknown>).isLabelAssigneeError === true)
      )
        throw firstError;
      // Transform all other errors (including API errors) into generic bulk create error
      throw new MCPError(ErrorCode.API_ERROR, `Bulk create failed. Could not create any tasks`);
    }

    return successResponse(
      'create-tasks',
      failedTasks.length > 0
        ? `Bulk create partially completed. Successfully created ${creationResult.successful.length} tasks, ${failedTasks.length} failed.`
        : `Successfully created ${creationResult.successful.length} tasks`,
      creationResult.successful,
      {
        count: creationResult.successful.length,
        success: failedTasks.length === 0,
        ...(failedTasks.length > 0 && { failedCount: failedTasks.length, failures: failedTasks }),
      },
    );
  } catch (error) {
    // Preserve MCPError instances from validation
    if (error instanceof MCPError) throw error;
    // Preserve fetch/connection errors
    if (
      error instanceof Error &&
      (error.message.includes('fetch failed') ||
        error.message.includes('ECONNREFUSED') ||
        error.message.includes('ENOTFOUND'))
    ) {
      throw handleFetchError(error, 'bulk create tasks');
    }
    // Transform all other errors into generic bulk create error
    throw new MCPError(ErrorCode.API_ERROR, 'Bulk create failed. Could not create any tasks');
  }
}
