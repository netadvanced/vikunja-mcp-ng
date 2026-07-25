/**
 * Label operations for tasks
 */

import type { MinimalTask } from '../../types';
import { MCPError, ErrorCode } from '../../types';
import type { AuthManager } from '../../auth/AuthManager';
import { extractHttpStatus } from '../../utils/http-error-detail';
import { withRetry, RETRY_CONFIG } from '../../utils/retry';
import { vikunjaRestRequest } from '../../utils/vikunja-rest';
import { getTaskViaRest } from '../../utils/task-rest-transport';
import { validateId } from './validation';
import { createSimpleResponse, formatAorpAsMarkdown } from '../../utils/response-factory';
import { ensureLabelByTitle } from '../../utils/label-ensure';
import { MAX_BULK_OPERATION_TASKS } from './constants';
import type { components } from '../../types/generated/vikunja-openapi';

/** `models.Label` per the OpenAPI spec, as returned by `GET /tasks/{task}/labels`. */
type VikunjaLabel = components['schemas']['models.Label'];

/**
 * Detects Vikunja's "label already exists on the task" response so that a
 * duplicate label can be treated as a no-op rather than a fatal error.
 */
function isLabelAlreadyOnTaskError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return error.message.toLowerCase().includes('already exists');
}

/**
 * Resolves each requested title to an id via the shared get-or-create
 * helper, caching by lowercased title so a repeated (or differently cased)
 * title resolves ONCE per call — reused verbatim across every task on a
 * multi-task `taskIds` apply-label call, not re-resolved per task. See
 * netadvanced/vikunja-mcp#28 friction: `existing-label-reuse` cost weak
 * agents 5 calls against an optimal of 3 because apply-label was
 * one-task-at-a-time.
 */
async function resolveLabelTitlesOnce(
  authManager: AuthManager,
  labelTitles: string[],
): Promise<{ id: number; title: string; created: boolean }[]> {
  const titleCache = new Map<string, { id: number; title: string; created: boolean }>();
  for (const title of labelTitles) {
    const cacheKey = title.toLowerCase();
    if (titleCache.has(cacheKey)) continue;
    const resolved = await ensureLabelByTitle(authManager, title);
    titleCache.set(cacheKey, resolved);
  }
  return [...titleCache.values()];
}

/** Result of applying a resolved set of label ids to a single task. */
interface ApplyToOneTaskResult {
  newlyApplied: number[];
  alreadyPresent: number[];
}

/**
 * Applies an already-resolved list of label ids to a single task.
 *
 * Extracted so both the single-task (`id`) and multi-task (`taskIds`) paths
 * of `applyLabels` share identical per-task semantics: skip labels already
 * on the task, tolerate a duplicate-label race as a no-op, and only ever
 * retry a genuine 401 (never a resource-level 403/other failure).
 */
async function applyLabelIdsToOneTask(
  taskId: number,
  requestedLabelIds: number[],
  authManager: AuthManager,
): Promise<ApplyToOneTaskResult> {
  // Skip labels already on the task: applying a duplicate makes Vikunja
  // reject the request, so pre-filtering keeps the operation idempotent.
  const alreadyPresent: number[] = [];
  let toApply = requestedLabelIds;
  try {
    const currentLabels = await vikunjaRestRequest<VikunjaLabel[]>(
      authManager,
      'GET',
      `/tasks/${taskId}/labels`,
    );
    const existingIds = new Set(
      (Array.isArray(currentLabels) ? currentLabels : [])
        .map((label) => label.id)
        .filter((id): id is number => typeof id === 'number'),
    );
    toApply = requestedLabelIds.filter((id) => {
      if (existingIds.has(id)) {
        alreadyPresent.push(id);
        return false;
      }
      return true;
    });
  } catch {
    // Current labels could not be read; attempt every requested label.
    // A duplicate is still tolerated per-label below.
  }

  // Add the remaining labels to the task with retry logic. PUT
  // /tasks/{task}/labels per the OpenAPI spec, body { label_id }
  // (models.LabelTask).
  const newlyApplied: number[] = [];
  for (const labelId of toApply) {
    try {
      await withRetry(
        () =>
          vikunjaRestRequest(authManager, 'PUT', `/tasks/${taskId}/labels`, {
            label_id: labelId,
          }),
        {
          ...RETRY_CONFIG.AUTH_ERRORS,
          // Only a genuine 401 session failure is worth retrying; a resource
          // 403 will not change on retry and must not be masked as auth.
          shouldRetry: (error: unknown) => extractHttpStatus(error) === 401,
        },
      );
      newlyApplied.push(labelId);
    } catch (labelError) {
      // A genuine session failure after retries — surface it as auth.
      if (extractHttpStatus(labelError) === 401) {
        throw new MCPError(
          ErrorCode.API_ERROR,
          `Failed to apply label to task (Retried ${RETRY_CONFIG.AUTH_ERRORS.maxRetries} times)`,
        );
      }
      // A label already on the task is not a failure: skip it and keep
      // applying the rest instead of aborting the whole operation.
      if (isLabelAlreadyOnTaskError(labelError)) {
        alreadyPresent.push(labelId);
        continue;
      }
      throw labelError;
    }
  }

  return { newlyApplied, alreadyPresent };
}

/** Per-task outcome of a multi-task apply-label call. */
interface MultiTaskApplyOutcome {
  taskId: number;
  newlyApplied: number[];
  alreadyPresent: number[];
  error?: string;
}

/**
 * Applies resolved labels to MULTIPLE tasks in one call (the `taskIds`
 * path of `apply-label`).
 *
 * Title resolution happens exactly ONCE for the whole call (by the caller,
 * before this is invoked) and the resolved ids are reused across every task
 * — the sweep evidence behind this fix (`existing-label-reuse`, 5 calls
 * against an optimal of 3) was three separate `apply-label` calls each
 * re-resolving the same `labelTitles`. Per-task writes are SEQUENTIAL,
 * mirroring `bulkSetTaskBucket`'s SQLite lock discipline (concurrent writes
 * risk "database is locked" 500s on SQLite-backed Vikunja instances), and a
 * per-task failure is isolated and reported rather than aborting the whole
 * batch — a partial failure is reported honestly, never as a clean success.
 */
async function applyLabelsToMultipleTasks(
  taskIds: number[],
  requestedLabelIds: number[],
  authManager: AuthManager,
): Promise<MultiTaskApplyOutcome[]> {
  const outcomes: MultiTaskApplyOutcome[] = [];
  for (const taskId of taskIds) {
    try {
      const { newlyApplied, alreadyPresent } = await applyLabelIdsToOneTask(
        taskId,
        requestedLabelIds,
        authManager,
      );
      outcomes.push({ taskId, newlyApplied, alreadyPresent });
    } catch (error) {
      outcomes.push({
        taskId,
        newlyApplied: [],
        alreadyPresent: [],
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return outcomes;
}

/**
 * Add labels to a task, or to MULTIPLE tasks in one call.
 *
 * Idempotent: labels already on the task are skipped instead of aborting the
 * whole operation. Vikunja rejects a duplicate label with "label already
 * exists on the task"; treating that as fatal previously stopped the loop and
 * left the remaining requested labels unapplied.
 *
 * `labelTitles` resolves each title via the shared `ensureLabelByTitle`
 * get-or-create helper (same match/create semantics as `vikunja_labels`
 * subcommand "ensure") before merging the resolved ids in with `labels` —
 * this is what lets "attach a label by name" happen in a single apply-label
 * call instead of a separate ensure-then-apply round trip. See
 * netadvanced/vikunja-mcp#28 friction #4 and src/utils/label-ensure.ts.
 *
 * Exactly ONE of `id` (single task, original behavior, preserved verbatim)
 * or `taskIds` (multiple tasks, new) must be supplied — see
 * netadvanced/vikunja-mcp#28 friction: `existing-label-reuse` cost weak
 * agents 5 calls against an optimal of 3 because apply-label previously
 * accepted only a single `id`, forcing one call per task. When `taskIds` is
 * used, `labelTitles` is resolved ONCE for the whole call and the resolved
 * ids are reused across every task; results are reported per-task with
 * honest partial-failure semantics (a partial failure is never reported as
 * a clean success).
 */
export async function applyLabels(
  args: {
    id?: number | undefined;
    taskIds?: number[] | undefined;
    labels?: number[] | undefined;
    labelTitles?: string[] | undefined;
  },
  authManager: AuthManager,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  try {
    const hasId = args.id !== undefined && args.id !== null;
    const hasTaskIds = args.taskIds !== undefined && args.taskIds !== null && args.taskIds.length > 0;

    if (hasId && hasTaskIds) {
      throw new MCPError(
        ErrorCode.VALIDATION_ERROR,
        'Provide either `id` (a single task) or `taskIds` (multiple tasks) for apply-label — ' +
          'not both.',
      );
    }
    if (!hasId && !hasTaskIds) {
      throw new MCPError(
        ErrorCode.VALIDATION_ERROR,
        'Task id is required for apply-label operation: pass `id` for a single task or ' +
          '`taskIds` for multiple tasks in one call.',
      );
    }

    const labelIds = args.labels ?? [];
    const labelTitles = args.labelTitles ?? [];

    if (labelIds.length === 0 && labelTitles.length === 0) {
      throw new MCPError(
        ErrorCode.VALIDATION_ERROR,
        'At least one label id (labels) or label title (labelTitles) is required',
      );
    }

    // Validate label IDs
    labelIds.forEach((id) => validateId(id, 'label ID'));

    // Resolve each requested title to an id via the shared get-or-create
    // helper ONCE for the whole call (single task or multi-task alike), then
    // merge/dedupe with any raw label ids.
    const titleResolutions = await resolveLabelTitlesOnce(authManager, labelTitles);
    const createdLabels = titleResolutions.filter((r) => r.created);
    const reusedLabels = titleResolutions.filter((r) => !r.created);
    const requestedLabelIds = [...new Set([...labelIds, ...titleResolutions.map((r) => r.id)])];

    const titleMessageDetails: string[] = [];
    if (createdLabels.length > 0) {
      titleMessageDetails.push(`created: ${createdLabels.map((l) => l.title).join(', ')}`);
    }
    if (reusedLabels.length > 0) {
      titleMessageDetails.push(`reused: ${reusedLabels.map((l) => l.title).join(', ')}`);
    }

    if (hasTaskIds) {
      const taskIds = args.taskIds as number[];
      if (taskIds.length > MAX_BULK_OPERATION_TASKS) {
        throw new MCPError(
          ErrorCode.VALIDATION_ERROR,
          `Too many tasks for apply-label. Maximum allowed: ${MAX_BULK_OPERATION_TASKS}. ` +
            'Consider breaking into smaller batches.',
        );
      }
      taskIds.forEach((id) => validateId(id, 'task ID'));
      const uniqueTaskIds = [...new Set(taskIds)];

      const outcomes = await applyLabelsToMultipleTasks(
        uniqueTaskIds,
        requestedLabelIds,
        authManager,
      );

      const succeeded = outcomes.filter((o) => o.error === undefined);
      const failed = outcomes.filter((o) => o.error !== undefined);

      if (succeeded.length === 0) {
        throw new MCPError(
          ErrorCode.API_ERROR,
          `Could not apply labels to any of the ${uniqueTaskIds.length} requested task(s). ` +
            `Failed task IDs: ${failed.map((f) => f.taskId).join(', ')}`,
        );
      }

      const totalNewlyApplied = succeeded.reduce((sum, o) => sum + o.newlyApplied.length, 0);
      const totalAlreadyPresent = outcomes.reduce((sum, o) => sum + o.alreadyPresent.length, 0);
      const partial = failed.length > 0;

      let message: string;
      if (partial) {
        message =
          `Labels applied to ${succeeded.length} of ${uniqueTaskIds.length} task(s); ` +
          `${failed.length} failed. Failed task IDs: ${failed.map((f) => f.taskId).join(', ')}`;
      } else if (totalNewlyApplied > 0) {
        message = `Labels applied to ${succeeded.length} task(s) successfully`;
      } else {
        message = `No labels applied: all requested label(s) already present on all ${succeeded.length} task(s)`;
      }
      if (totalAlreadyPresent > 0 && (partial || totalNewlyApplied > 0)) {
        message += ` (${totalAlreadyPresent} already-present label assignment(s) skipped)`;
      }
      if (titleMessageDetails.length > 0) {
        message += ` (${titleMessageDetails.join('; ')})`;
      }

      const response = createSimpleResponse(
        'apply-label',
        message,
        {
          results: outcomes.map((o) => ({
            taskId: o.taskId,
            newlyApplied: o.newlyApplied,
            alreadyPresent: o.alreadyPresent,
            ...(o.error !== undefined ? { error: o.error } : {}),
          })),
        },
        {
          success: !partial,
          metadata: {
            affectedFields: ['labels'],
            count: succeeded.length,
            taskIds: succeeded.map((o) => o.taskId),
            ...(partial
              ? {
                  failedCount: failed.length,
                  failedTaskIds: failed.map((f) => f.taskId),
                  failures: failed.map((f) => ({ taskId: f.taskId, error: f.error })),
                }
              : {}),
            labelsCreated: createdLabels.map((l) => ({ id: l.id, title: l.title })),
            labelsReused: reusedLabels.map((l) => ({ id: l.id, title: l.title })),
          },
        },
      );

      return {
        content: [
          {
            type: 'text' as const,
            text: formatAorpAsMarkdown(response),
          },
        ],
      };
    }

    // Single-task path (`id`) — preserved verbatim from the original
    // implementation for backward compatibility.
    validateId(args.id as number, 'id');
    const taskId = args.id as number;

    const { newlyApplied, alreadyPresent } = await applyLabelIdsToOneTask(
      taskId,
      requestedLabelIds,
      authManager,
    );

    // Fetch the updated task to show current labels via GET /tasks/{id}
    // (direct-REST), kept only to refresh the response payload.
    const task = await getTaskViaRest(authManager, taskId);

    let message: string;
    if (newlyApplied.length > 0) {
      message = `Label${newlyApplied.length > 1 ? 's' : ''} applied to task successfully`;
    } else {
      message = `No labels applied: all ${alreadyPresent.length} requested label(s) already present on the task`;
    }

    // Report which labelTitles were get-or-created vs reused, alongside the
    // existing "already present" idempotent messaging.
    const messageDetails: string[] = [];
    if (alreadyPresent.length > 0 && newlyApplied.length > 0) {
      messageDetails.push(`${alreadyPresent.length} already present, skipped`);
    }
    if (titleMessageDetails.length > 0) {
      messageDetails.push(...titleMessageDetails);
    }
    if (messageDetails.length > 0) {
      message += ` (${messageDetails.join('; ')})`;
    }

    const response = createSimpleResponse(
      'apply-label',
      message,
      { task },
      {
        metadata: {
          affectedFields: ['labels'],
          labelsApplied: newlyApplied,
          labelsAlreadyPresent: alreadyPresent,
          labelsCreated: createdLabels.map((l) => ({ id: l.id, title: l.title })),
          labelsReused: reusedLabels.map((l) => ({ id: l.id, title: l.title })),
        },
      }
    );

    return {
      content: [
        {
          type: 'text' as const,
          text: formatAorpAsMarkdown(response),
        },
      ],
    };
  } catch (error) {
    if (error instanceof MCPError) {
      throw error;
    }
    throw new MCPError(
      ErrorCode.API_ERROR,
      `Failed to apply labels to task: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Result of removing a set of label ids from a single task. */
interface RemoveFromOneTaskResult {
  removed: number[];
  alreadyAbsent: number[];
}

/**
 * Removes a set of label ids from a single task.
 *
 * Extracted so both the single-task (`id`) and multi-task (`taskIds`) paths
 * of `removeLabels` share identical per-task semantics — see the matching
 * `applyLabelIdsToOneTask` comment above for the 401-vs-403 retry rationale.
 *
 * Throws `MCPError` (VALIDATION_ERROR) when, after reconciling against the
 * task's actual label set, one or more requested labels are still attached —
 * i.e. the removal genuinely failed, as opposed to the label simply never
 * having been attached (a Vikunja 403, treated as an idempotent no-op).
 */
async function removeLabelIdsFromOneTask(
  taskId: number,
  labelIds: number[],
  authManager: AuthManager,
): Promise<RemoveFromOneTaskResult> {
  // Remove each label. DELETE /tasks/{task}/labels/{label} per the OpenAPI
  // spec — no body. Vikunja returns 403 (not 404) when the label is not
  // attached to the task, so a failed DELETE does NOT by itself mean an
  // error: we reconcile against the task's real label set below rather than
  // trusting the per-call status. Only a genuine 401 session failure is
  // retried and surfaced as auth — a static token cannot recover a 401 by
  // retrying, and the resource-level 403 here will never change on retry.
  const removeFailures: number[] = [];
  for (const labelId of labelIds) {
    try {
      await withRetry(
        () => vikunjaRestRequest(authManager, 'DELETE', `/tasks/${taskId}/labels/${labelId}`),
        {
          ...RETRY_CONFIG.AUTH_ERRORS,
          shouldRetry: (error: unknown) => extractHttpStatus(error) === 401,
        },
      );
    } catch (removeError) {
      // A genuine session failure can't be masked as an absent label.
      if (extractHttpStatus(removeError) === 401) {
        throw new MCPError(
          ErrorCode.API_ERROR,
          `Failed to remove label from task (Retried ${RETRY_CONFIG.AUTH_ERRORS.maxRetries} times)`,
        );
      }
      // Non-auth failure (typically Vikunja's 403 for a label that is not
      // attached to the task). Defer judgement to the actual labels below.
      removeFailures.push(labelId);
    }
  }

  // Reconcile against ground truth: the labels actually attached now. The
  // labels array embedded in a getTask response is unreliable (see
  // listTaskLabels), so read the dedicated GET /tasks/{id}/labels endpoint.
  let attachedIds: Set<number> | null = null;
  try {
    const currentLabels = await vikunjaRestRequest<VikunjaLabel[]>(
      authManager,
      'GET',
      `/tasks/${taskId}/labels`,
    );
    attachedIds = new Set(
      (Array.isArray(currentLabels) ? currentLabels : [])
        .map((label) => label.id)
        .filter((id): id is number => typeof id === 'number'),
    );
  } catch {
    // Current labels could not be read; fall back to trusting the DELETE
    // outcomes (any failed removal is reported as a failure below).
    attachedIds = null;
  }

  // A requested label is "still attached" only when ground truth confirms it;
  // without that confirmation, a failed DELETE is itself the failure signal.
  const stillAttached =
    attachedIds !== null ? labelIds.filter((id) => attachedIds.has(id)) : removeFailures;

  if (stillAttached.length > 0) {
    const plural = stillAttached.length > 1;
    throw new MCPError(
      ErrorCode.VALIDATION_ERROR,
      `Could not remove label${plural ? 's' : ''} ${stillAttached.join(', ')} from task ${taskId}: ` +
        `still attached after the request. Check the label id${plural ? 's' : ''} and that you have write access to the task.`,
    );
  }

  // Everything requested is off the task. Some ids may never have been
  // attached (Vikunja 403 → confirmed absent by the reconcile above); report
  // those as skipped, mirroring applyLabels' idempotent messaging.
  const alreadyAbsent = removeFailures.filter(
    (id) => attachedIds === null || !attachedIds.has(id),
  );
  const removed = labelIds.filter((id) => !removeFailures.includes(id));

  return { removed, alreadyAbsent };
}

/** Per-task outcome of a multi-task remove-label call. */
interface MultiTaskRemoveOutcome {
  taskId: number;
  removed: number[];
  alreadyAbsent: number[];
  error?: string;
}

/**
 * Removes labels from MULTIPLE tasks in one call (the `taskIds` path of
 * `remove-label`). Sequential per-task writes, per-task failure isolation —
 * see `applyLabelsToMultipleTasks` above for the identical rationale.
 */
async function removeLabelsFromMultipleTasks(
  taskIds: number[],
  labelIds: number[],
  authManager: AuthManager,
): Promise<MultiTaskRemoveOutcome[]> {
  const outcomes: MultiTaskRemoveOutcome[] = [];
  for (const taskId of taskIds) {
    try {
      const { removed, alreadyAbsent } = await removeLabelIdsFromOneTask(
        taskId,
        labelIds,
        authManager,
      );
      outcomes.push({ taskId, removed, alreadyAbsent });
    } catch (error) {
      outcomes.push({
        taskId,
        removed: [],
        alreadyAbsent: [],
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return outcomes;
}

/**
 * Remove labels from a task, or from MULTIPLE tasks in one call.
 *
 * Exactly ONE of `id` (single task, original behavior, preserved verbatim)
 * or `taskIds` (multiple tasks, new) must be supplied — see the matching
 * `applyLabels` doc comment above for the friction this addresses.
 */
export async function removeLabels(
  args: {
    id?: number | undefined;
    taskIds?: number[] | undefined;
    labels?: number[] | undefined;
  },
  authManager: AuthManager,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  try {
    const hasId = args.id !== undefined && args.id !== null;
    const hasTaskIds = args.taskIds !== undefined && args.taskIds !== null && args.taskIds.length > 0;

    if (hasId && hasTaskIds) {
      throw new MCPError(
        ErrorCode.VALIDATION_ERROR,
        'Provide either `id` (a single task) or `taskIds` (multiple tasks) for remove-label — ' +
          'not both.',
      );
    }
    if (!hasId && !hasTaskIds) {
      throw new MCPError(
        ErrorCode.VALIDATION_ERROR,
        'Task id is required for remove-label operation: pass `id` for a single task or ' +
          '`taskIds` for multiple tasks in one call.',
      );
    }

    if (!args.labels || args.labels.length === 0) {
      throw new MCPError(ErrorCode.VALIDATION_ERROR, 'At least one label id is required to remove');
    }

    // Validate label IDs
    args.labels.forEach((id) => validateId(id, 'label ID'));
    // Deduplicate so a repeated id is not removed or counted twice.
    const labelIds = [...new Set(args.labels)];

    if (hasTaskIds) {
      const taskIds = args.taskIds as number[];
      if (taskIds.length > MAX_BULK_OPERATION_TASKS) {
        throw new MCPError(
          ErrorCode.VALIDATION_ERROR,
          `Too many tasks for remove-label. Maximum allowed: ${MAX_BULK_OPERATION_TASKS}. ` +
            'Consider breaking into smaller batches.',
        );
      }
      taskIds.forEach((id) => validateId(id, 'task ID'));
      const uniqueTaskIds = [...new Set(taskIds)];

      const outcomes = await removeLabelsFromMultipleTasks(uniqueTaskIds, labelIds, authManager);

      const succeeded = outcomes.filter((o) => o.error === undefined);
      const failed = outcomes.filter((o) => o.error !== undefined);

      if (succeeded.length === 0) {
        throw new MCPError(
          ErrorCode.API_ERROR,
          `Could not remove labels from any of the ${uniqueTaskIds.length} requested task(s). ` +
            `Failed task IDs: ${failed.map((f) => f.taskId).join(', ')}`,
        );
      }

      const totalRemoved = succeeded.reduce((sum, o) => sum + o.removed.length, 0);
      const totalAlreadyAbsent = outcomes.reduce((sum, o) => sum + o.alreadyAbsent.length, 0);
      const partial = failed.length > 0;

      let message: string;
      if (partial) {
        message =
          `Labels removed from ${succeeded.length} of ${uniqueTaskIds.length} task(s); ` +
          `${failed.length} failed. Failed task IDs: ${failed.map((f) => f.taskId).join(', ')}`;
      } else if (totalRemoved > 0) {
        message = `Labels removed from ${succeeded.length} task(s) successfully`;
      } else {
        message = `No labels removed: all requested label(s) were already not attached on all ${succeeded.length} task(s)`;
      }
      if (totalAlreadyAbsent > 0 && (partial || totalRemoved > 0)) {
        message += ` (${totalAlreadyAbsent} already-absent label removal(s) skipped)`;
      }

      const response = createSimpleResponse(
        'remove-label',
        message,
        {
          results: outcomes.map((o) => ({
            taskId: o.taskId,
            removed: o.removed,
            alreadyAbsent: o.alreadyAbsent,
            ...(o.error !== undefined ? { error: o.error } : {}),
          })),
        },
        {
          success: !partial,
          metadata: {
            affectedFields: ['labels'],
            count: succeeded.length,
            taskIds: succeeded.map((o) => o.taskId),
            ...(partial
              ? {
                  failedCount: failed.length,
                  failedTaskIds: failed.map((f) => f.taskId),
                  failures: failed.map((f) => ({ taskId: f.taskId, error: f.error })),
                }
              : {}),
          },
        },
      );

      return {
        content: [
          {
            type: 'text' as const,
            text: formatAorpAsMarkdown(response),
          },
        ],
      };
    }

    // Single-task path (`id`) — preserved verbatim from the original
    // implementation for backward compatibility.
    validateId(args.id as number, 'id');
    const taskId = args.id as number;

    const { removed, alreadyAbsent } = await removeLabelIdsFromOneTask(taskId, labelIds, authManager);

    let message: string;
    if (removed.length > 0) {
      message = `Label${removed.length > 1 ? 's' : ''} removed from task successfully`;
      if (alreadyAbsent.length > 0) {
        message += ` (${alreadyAbsent.length} already not attached, skipped)`;
      }
    } else {
      message = `No labels removed: all ${alreadyAbsent.length} requested label(s) were already not attached to the task`;
    }

    // Fetch the updated task to show current labels via GET /tasks/{id}
    // (direct-REST) — see the matching comment in applyLabels above.
    const task = await getTaskViaRest(authManager, taskId);

    const response = createSimpleResponse(
      'remove-label',
      message,
      { task },
      {
        metadata: {
          affectedFields: ['labels'],
          labelsRemoved: removed,
          labelsAlreadyAbsent: alreadyAbsent,
        },
      }
    );

    return {
      content: [
        {
          type: 'text' as const,
          text: formatAorpAsMarkdown(response),
        },
      ],
    };
  } catch (error) {
    if (error instanceof MCPError) {
      throw error;
    }
    throw new MCPError(
      ErrorCode.API_ERROR,
      `Failed to remove labels from task: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * List labels of a task
 *
 * Reads the labels from the dedicated GET /tasks/{id}/labels endpoint. The
 * labels array embedded in a getTask response is not reliably populated, so
 * relying on it reported zero labels on tasks that actually had some.
 */
export async function listTaskLabels(
  args: {
    id?: number | undefined;
  },
  authManager: AuthManager,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  try {
    if (args.id === undefined) {
      throw new MCPError(
        ErrorCode.VALIDATION_ERROR,
        'Task id is required for list-labels operation',
      );
    }
    validateId(args.id, 'id');

    // Authoritative source for a task's labels
    const taskLabels = await vikunjaRestRequest<VikunjaLabel[]>(
      authManager,
      'GET',
      `/tasks/${args.id}/labels`,
    );
    const labels = Array.isArray(taskLabels) ? taskLabels : [];

    // Fetch the task itself only for its identifying fields via GET /tasks/{id}
    // (direct-REST) — see the matching comment in applyLabels above.
    const task = await getTaskViaRest(authManager, args.id);

    const minimalTask: MinimalTask = {
      ...(task.id !== undefined && { id: task.id }),
      title: task.title ?? '',
    };

    const response = createSimpleResponse(
      'list-labels',
      `Task has ${labels.length} label(s)`,
      { task: { ...minimalTask, labels: labels } },
      { metadata: { count: labels.length } }
    );

    return {
      content: [
        {
          type: 'text' as const,
          text: formatAorpAsMarkdown(response),
        },
      ],
    };
  } catch (error) {
    if (error instanceof MCPError) {
      throw error;
    }
    throw new MCPError(
      ErrorCode.API_ERROR,
      `Failed to list task labels: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
