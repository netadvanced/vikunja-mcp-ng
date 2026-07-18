/**
 * Subtask composites for `vikunja_tasks`.
 *
 * Vikunja has no first-class "subtask" resource — a subtask is a plain task
 * connected to its parent by a `models.TaskRelation` with `relation_kind:
 * "subtask"` (see `src/tools/tasks-relations.ts`, the direction semantics
 * this module relies on).
 *
 * Direction, per `models.TaskRelation`'s field docs (`task_id`: "the ID of
 * the 'base' task, the task which has a relation to another"; `other_task_id`:
 * "the ID of the other task, the task which is being related"): a relation
 * created as `PUT /tasks/{parentId}/relations` with body `{task_id: parentId,
 * other_task_id: childId, relation_kind: "subtask"}` stores the child under
 * the *parent's* `related_tasks["subtask"]` — Vikunja mirrors the inverse
 * relation (`"parenttask"`) onto the child automatically server-side. So the
 * base task of the PUT must be the parent, not the new child.
 *
 * `create-subtask` (composite-first, docs/ENDPOINT-PLAYBOOK.md §1): resolves
 * the parent task to inherit its project, creates the new task in that
 * project, optionally attaches labels/assignees and places it in a Kanban
 * bucket (reusing the `set-bucket` code path), creates the parent -> child
 * `subtask` relation, then re-reads the parent to verify the relation
 * actually landed. Built on `CompositeOperation`
 * (`src/utils/composite-operation.ts`) — best-effort by default (a failure
 * after the task was created is reported honestly, including the orphaned
 * task id, rather than silently rolled back); `atomic: true` opts into
 * best-effort rollback (deleting the created task) per the helper's design.
 *
 * `bulk-create-subtasks` (battle-campaign friction #4, docs/ROADMAP.md
 * decision 4): resolves the parent's project ONCE, then runs the same
 * create -> label -> assign -> relate -> bucket -> verify sequence per
 * subtask spec, sequentially, each with its own independent
 * `CompositeOperation` (so one subtask's failure never blocks the rest of
 * the batch). See its doc comment below for the full shape.
 *
 * `list-subtasks` is a read composite: one `GET /tasks/{id}` call, filtered
 * to the `"subtask"` slice of `related_tasks` and summarized.
 */

import type { AuthManager } from '../../auth/AuthManager';
import { MCPError, ErrorCode } from '../../types';
import { vikunjaRestRequest } from '../../utils/vikunja-rest';
import { getTaskViaRest } from '../../utils/task-rest-transport';
import { validateId, sanitizeString } from '../../utils/validation';
import { validateDateString } from './validation';
import { transformApiError } from '../../utils/error-handler';
import { createStandardResponse, formatAorpAsMarkdown } from '../../utils/response-factory';
import { CompositeOperation } from '../../utils/composite-operation';
import { setTaskBucket } from './buckets';
import { MAX_BULK_OPERATION_TASKS } from './constants';
import type { components } from '../../types/generated/vikunja-openapi';

/** `models.Task` per the OpenAPI spec. */
type VikunjaTask = components['schemas']['models.Task'];
/** `models.TaskRelation` per the OpenAPI spec. */
type VikunjaTaskRelation = components['schemas']['models.TaskRelation'];

type McpResponse = { content: Array<{ type: 'text'; text: string }> };

/** Re-throws a 404 as a friendly not-found MCPError; everything else passes through `transformApiError`. */
function rethrow(error: unknown, notFoundMessage: string | undefined, context: string): never {
  if (error instanceof MCPError) {
    if (notFoundMessage && error.details?.statusCode === 404) {
      throw new MCPError(ErrorCode.NOT_FOUND, notFoundMessage);
    }
    throw error;
  }
  throw transformApiError(error, context);
}

/**
 * Reads one relation-kind slice out of a task's `related_tasks` map.
 * `related_tasks` (`models.RelatedTaskMap`) is a map of relation kind ->
 * `Task[]`, not a flat array — see the same pattern in
 * `src/tools/tasks-relations.ts`'s `relations` subcommand.
 */
function extractRelatedTasks(task: VikunjaTask, kind: string): VikunjaTask[] {
  const map = (task.related_tasks ?? {}) as unknown as Record<string, VikunjaTask[] | undefined>;
  const list = map[kind];
  return Array.isArray(list) ? list : [];
}

export interface CreateSubtaskArgs {
  /** Id of the existing task the new task becomes a subtask of. Its project is inherited. */
  parentTaskId?: number;
  title?: string;
  description?: string;
  dueDate?: string;
  priority?: number;
  labels?: number[];
  assignees?: number[];
  /** Optional Kanban bucket to place the new subtask into, via the existing `set-bucket` path. */
  bucketId?: number;
  /**
   * Opt into atomic rollback: if any later step fails, previously-succeeded
   * steps are compensated in reverse order (the created task is deleted).
   * Default `false` (best-effort) — see
   * docs/ENDPOINT-PLAYBOOK.md §5 / `CompositeOperation`'s design rule (a).
   * This is best-effort compensation against a live API, not a real
   * transaction: side effects of intermediate writes (e.g. any webhook the
   * task-create step fires) are not undone by the rollback.
   */
  atomic?: boolean;
  sessionId?: string;
}

/**
 * Core per-subtask fields shared by `create-subtask` and `bulk-create-subtasks`
 * once the caller-supplied `title`/`description` have already been sanitized.
 */
interface SubtaskCoreSpec {
  title: string;
  description?: string;
  dueDate?: string;
  priority?: number;
  labels?: number[];
  assignees?: number[];
  bucketId?: number;
}

/**
 * Registers the create-task -> [apply-labels] -> [apply-assignees] ->
 * create-relation -> [set-bucket] -> verify-relation steps of the
 * create-subtask composite onto `op`, shared by both the single
 * `createSubtask` composite (below) and `bulkCreateSubtasks` (one fresh `op`
 * per subtask spec, looped sequentially). Deliberately excludes the
 * resolve-parent step: `createSubtask` resolves the parent as its own first
 * step (so a failure there participates in the same trace/compensation
 * flow), while `bulkCreateSubtasks` resolves the parent's project ONCE
 * up-front and reuses it across every subtask in the batch — see that
 * function's doc comment.
 *
 * `getParentProjectId` is a callback rather than a plain number because for
 * the single-subtask flow the project id isn't known until the
 * resolve-parent step (registered before this one) actually executes.
 */
function addSubtaskCreationSteps(
  op: CompositeOperation,
  authManager: AuthManager,
  parentTaskId: number,
  getParentProjectId: () => number,
  spec: SubtaskCoreSpec,
): { getCreatedTaskId: () => number | undefined } {
  let createdTaskId: number | undefined;

  op.addStep<VikunjaTask, undefined>({
    name: 'create-task',
    execute: async () => {
      const projectId = getParentProjectId();
      const newTask: VikunjaTask = { title: spec.title, project_id: projectId };
      if (spec.description !== undefined) newTask.description = spec.description;
      if (spec.dueDate !== undefined) newTask.due_date = spec.dueDate;
      if (spec.priority !== undefined) newTask.priority = spec.priority;

      let created: VikunjaTask;
      try {
        created = await vikunjaRestRequest<VikunjaTask>(
          authManager,
          'PUT',
          `/projects/${projectId}/tasks`,
          newTask,
        );
      } catch (error) {
        rethrow(error, undefined, 'Failed to create subtask');
      }
      if (!created.id) {
        throw new MCPError(
          ErrorCode.API_ERROR,
          'Subtask was created but Vikunja did not return a task id',
        );
      }
      createdTaskId = created.id;
      return created;
    },
    compensate: async () => {
      if (createdTaskId === undefined) return undefined;
      await vikunjaRestRequest(authManager, 'DELETE', `/tasks/${createdTaskId}`);
      return undefined;
    },
  });

  if (spec.labels && spec.labels.length > 0) {
    const labelIds = spec.labels;
    op.addStep<undefined, undefined>({
      name: 'apply-labels',
      execute: async () => {
        const taskId = createdTaskId as number;
        // Additive per-label endpoint (PUT /tasks/{taskID}/labels, body
        // {label_id}) — same as apply-label / TaskCreationService.
        // Intentionally sequential: label attach order should not matter,
        // but keeping it simple avoids a Promise.all partial-failure
        // ordering surprise across labels.
        for (const labelId of labelIds) {
          await vikunjaRestRequest(authManager, 'PUT', `/tasks/${taskId}/labels`, {
            label_id: labelId,
          });
        }
      },
    });
  }

  if (spec.assignees && spec.assignees.length > 0) {
    const assigneeIds = spec.assignees;
    op.addStep<undefined, undefined>({
      name: 'apply-assignees',
      execute: async () => {
        const taskId = createdTaskId as number;
        // Additive per-user endpoint (PUT /tasks/{taskID}/assignees, body
        // {user_id}) — never the bulk endpoint, which REPLACES the whole
        // assignee list (see TaskCreationService.addAssigneesToTask).
        // Sequential on purpose (post-#89 pattern sweep, mirrors the
        // apply-labels step above): concurrent per-user writes to the same
        // task risk "database is locked" 500s on SQLite-backed instances.
        for (const userId of assigneeIds) {
          await vikunjaRestRequest(authManager, 'PUT', `/tasks/${taskId}/assignees`, {
            user_id: userId,
          });
        }
      },
    });
  }

  op.addStep<VikunjaTaskRelation, undefined>({
    name: 'create-relation',
    execute: async () => {
      const childId = createdTaskId as number;
      try {
        // Base task (task_id) of the relation must be the PARENT — see the
        // module doc comment for the direction semantics this depends on.
        return await vikunjaRestRequest<VikunjaTaskRelation>(
          authManager,
          'PUT',
          `/tasks/${parentTaskId}/relations`,
          {
            task_id: parentTaskId,
            other_task_id: childId,
            relation_kind: 'subtask',
          } satisfies VikunjaTaskRelation,
        );
      } catch (error) {
        rethrow(error, undefined, 'Failed to relate subtask to parent task');
      }
    },
  });

  if (spec.bucketId !== undefined) {
    const bucketId = spec.bucketId;
    op.addStep<undefined, undefined>({
      name: 'set-bucket',
      execute: async () => {
        const taskId = createdTaskId as number;
        const projectId = getParentProjectId();
        // Reuses the existing set-bucket path (Kanban view auto-resolution
        // + the bucket-placement write) rather than duplicating it. Its own
        // formatted MCP response is discarded — only the side effect (the
        // task landing in the bucket) matters to this composite.
        await setTaskBucket({ id: taskId, bucketId, projectId }, authManager);
      },
    });
  }

  op.addStep<boolean, undefined>({
    name: 'verify-relation',
    execute: async () => {
      const childId = createdTaskId as number;
      let parent: VikunjaTask;
      try {
        parent = await getTaskViaRest(authManager, parentTaskId);
      } catch (error) {
        rethrow(error, undefined, 'Failed to verify subtask relation');
      }
      const subtasks = extractRelatedTasks(parent, 'subtask');
      const found = subtasks.some((t) => t.id === childId);
      if (!found) {
        throw new MCPError(
          ErrorCode.INTERNAL_ERROR,
          `Subtask ${childId} was created and related to parent ${parentTaskId} but did not ` +
            `appear under the parent's "subtask" relations on verification`,
        );
      }
      return true;
    },
  });

  return { getCreatedTaskId: () => createdTaskId };
}

/**
 * Composite: create a new task as a subtask of an existing task.
 *
 * Steps: resolve-parent (inherit project) -> create-task (compensatable:
 * delete on rollback) -> apply-labels / apply-assignees (only when supplied)
 * -> create-relation (parent -subtask-> child) -> set-bucket (only when
 * `bucketId` supplied, reuses `setTaskBucket`) -> verify-relation (re-reads
 * the parent's `related_tasks` to confirm the child actually appears under
 * `"subtask"`).
 */
export async function createSubtask(
  args: CreateSubtaskArgs,
  authManager: AuthManager,
): Promise<McpResponse> {
  if (!args.parentTaskId) {
    throw new MCPError(ErrorCode.VALIDATION_ERROR, 'parentTaskId is required to create a subtask');
  }
  validateId(args.parentTaskId, 'parentTaskId');

  if (!args.title) {
    throw new MCPError(ErrorCode.VALIDATION_ERROR, 'title is required to create a subtask');
  }
  const sanitizedTitle = sanitizeString(args.title);
  const sanitizedDescription =
    args.description !== undefined ? sanitizeString(args.description) : undefined;

  if (args.dueDate) {
    validateDateString(args.dueDate, 'dueDate');
  }
  if (args.labels && args.labels.length > 0) {
    args.labels.forEach((id) => validateId(id, 'label ID'));
  }
  if (args.assignees && args.assignees.length > 0) {
    args.assignees.forEach((id) => validateId(id, 'assignee ID'));
  }
  if (args.bucketId !== undefined) {
    validateId(args.bucketId, 'bucketId');
  }

  const parentTaskId = args.parentTaskId;
  let parentProjectId: number | undefined;

  const op = new CompositeOperation();

  op.addStep<VikunjaTask, undefined>({
    name: 'resolve-parent',
    execute: async () => {
      let parent: VikunjaTask;
      try {
        parent = await getTaskViaRest(authManager, parentTaskId);
      } catch (error) {
        rethrow(error, `Parent task ${parentTaskId} not found`, 'Failed to resolve parent task');
      }
      if (!parent || typeof parent.project_id !== 'number') {
        throw new MCPError(
          ErrorCode.NOT_FOUND,
          `Parent task ${parentTaskId} not found or has no project`,
        );
      }
      parentProjectId = parent.project_id;
      return parent;
    },
  });

  const { getCreatedTaskId } = addSubtaskCreationSteps(
    op,
    authManager,
    parentTaskId,
    () => parentProjectId as number,
    {
      title: sanitizedTitle,
      ...(sanitizedDescription !== undefined ? { description: sanitizedDescription } : {}),
      ...(args.dueDate !== undefined ? { dueDate: args.dueDate } : {}),
      ...(args.priority !== undefined ? { priority: args.priority } : {}),
      ...(args.labels !== undefined ? { labels: args.labels } : {}),
      ...(args.assignees !== undefined ? { assignees: args.assignees } : {}),
      ...(args.bucketId !== undefined ? { bucketId: args.bucketId } : {}),
    },
  );

  const atomic = args.atomic ?? false;
  const result = await op.run({ atomic });
  const createdTaskId = getCreatedTaskId();

  if (!result.ok) {
    const err = result.error instanceof Error ? result.error : new Error(String(result.error));
    throw new MCPError(
      err instanceof MCPError ? err.code : ErrorCode.API_ERROR,
      `create-subtask failed: ${err.message}${result.guidance ? `\n${result.guidance}` : ''}`,
      { vikunjaError: result },
    );
  }

  const response = createStandardResponse(
    'create-subtask',
    `Created subtask ${createdTaskId} ("${sanitizedTitle}") under parent task ${parentTaskId}`,
    {
      subtaskId: createdTaskId,
      parentTaskId,
      projectId: parentProjectId,
      bucketId: args.bucketId,
      atomic,
      trace: result.steps,
    },
    { timestamp: new Date().toISOString() },
    args.sessionId,
  );

  return { content: [{ type: 'text' as const, text: formatAorpAsMarkdown(response) }] };
}

export interface BulkCreateSubtaskSpec {
  title?: string;
  description?: string;
  dueDate?: string;
  priority?: number;
  labels?: number[];
  assignees?: number[];
  bucketId?: number;
}

export interface BulkCreateSubtasksArgs {
  /** Id of the existing task every new task in `subtasks` becomes a subtask of. */
  parentTaskId?: number;
  /** Subtask specs, same shape as `create-subtask`'s own per-item fields. */
  subtasks?: BulkCreateSubtaskSpec[];
  /**
   * Opt into atomic rollback PER SUBTASK: if a given subtask's own steps
   * fail partway, that subtask's created task is compensated (deleted).
   * Default `false` (best-effort), same meaning as `create-subtask`'s
   * `atomic` flag — see its doc comment and
   * docs/ENDPOINT-PLAYBOOK.md §5. This never rolls back OTHER, already-
   * succeeded subtasks in the same batch — a bulk operation's partial
   * success is normal, not a failure condition requiring a full-batch undo.
   */
  atomic?: boolean;
  sessionId?: string;
}

/** Per-subtask outcome reported by `bulkCreateSubtasks` — the honest partial-reporting shape (PR #95). */
export interface BulkCreateSubtaskResult {
  index: number;
  title: string;
  created: boolean;
  related: boolean;
  subtaskId?: number;
  error?: string;
}

/**
 * Composite: create several subtasks under the same parent task in one call.
 *
 * Battle-campaign friction #4 ("subtask-breakdown" transcript): agents made
 * one `create-subtask` call per item instead of a single batched call, even
 * though they readily reach for `bulk-create`/`bulk-update` when those exist
 * on `vikunja_tasks`. This composite resolves the parent's project ONCE (a
 * single `GET /tasks/{parentTaskId}`, reused by every subtask instead of
 * re-resolved per item), then runs `addSubtaskCreationSteps`' create -> label
 * -> assign -> relate -> bucket -> verify sequence per subtask, SEQUENTIALLY
 * (SQLite lock discipline — concurrent writes under the same parent/project
 * risk "database is locked" 500s, same as the per-task loops in
 * bulk-operations-simplified.ts and `bulkSetTaskBucket`).
 *
 * Each subtask gets its own fresh `CompositeOperation`, so a failure on
 * subtask N does not abort subtasks N+1..last — every spec is attempted, and
 * the response lists which subtasks were created/related/failed, with the
 * reported success count derived from confirmed per-subtask successes
 * (PR #95's honest partial-reporting shape). `atomic` (per-subtask) rolls
 * back only that subtask's own created task on failure — it never reaches
 * across subtasks.
 */
export async function bulkCreateSubtasks(
  args: BulkCreateSubtasksArgs,
  authManager: AuthManager,
): Promise<McpResponse> {
  if (!args.parentTaskId) {
    throw new MCPError(
      ErrorCode.VALIDATION_ERROR,
      'parentTaskId is required to create subtasks',
    );
  }
  validateId(args.parentTaskId, 'parentTaskId');

  if (!args.subtasks || args.subtasks.length === 0) {
    throw new MCPError(
      ErrorCode.VALIDATION_ERROR,
      'subtasks array is required and must contain at least one subtask',
    );
  }
  if (args.subtasks.length > MAX_BULK_OPERATION_TASKS) {
    throw new MCPError(
      ErrorCode.VALIDATION_ERROR,
      `Too many subtasks for bulk operation. Maximum allowed: ${MAX_BULK_OPERATION_TASKS}. Consider breaking into smaller batches.`,
    );
  }

  // Validate + sanitize every spec up-front, before making any request —
  // mirrors create-subtask's own pre-flight validation.
  const specs: SubtaskCoreSpec[] = args.subtasks.map((s, index) => {
    if (!s.title) {
      throw new MCPError(
        ErrorCode.VALIDATION_ERROR,
        `subtasks[${index}].title is required to create a subtask`,
      );
    }
    if (s.dueDate) {
      validateDateString(s.dueDate, `subtasks[${index}].dueDate`);
    }
    if (s.labels && s.labels.length > 0) {
      s.labels.forEach((id) => validateId(id, `subtasks[${index}].label ID`));
    }
    if (s.assignees && s.assignees.length > 0) {
      s.assignees.forEach((id) => validateId(id, `subtasks[${index}].assignee ID`));
    }
    if (s.bucketId !== undefined) {
      validateId(s.bucketId, `subtasks[${index}].bucketId`);
    }
    return {
      title: sanitizeString(s.title),
      ...(s.description !== undefined ? { description: sanitizeString(s.description) } : {}),
      ...(s.dueDate !== undefined ? { dueDate: s.dueDate } : {}),
      ...(s.priority !== undefined ? { priority: s.priority } : {}),
      ...(s.labels !== undefined ? { labels: s.labels } : {}),
      ...(s.assignees !== undefined ? { assignees: s.assignees } : {}),
      ...(s.bucketId !== undefined ? { bucketId: s.bucketId } : {}),
    };
  });

  const parentTaskId = args.parentTaskId;

  // Resolve the parent's project ONCE — every subtask in the batch is
  // created in the same project, so re-resolving per item would be wasted
  // round-trips (the friction this composite exists to remove).
  let parent: VikunjaTask;
  try {
    parent = await getTaskViaRest(authManager, parentTaskId);
  } catch (error) {
    rethrow(error, `Parent task ${parentTaskId} not found`, 'Failed to resolve parent task');
  }
  if (!parent || typeof parent.project_id !== 'number') {
    throw new MCPError(
      ErrorCode.NOT_FOUND,
      `Parent task ${parentTaskId} not found or has no project`,
    );
  }
  const parentProjectId = parent.project_id;

  const atomic = args.atomic ?? false;
  const results: BulkCreateSubtaskResult[] = [];

  // Sequential on purpose — see the function doc comment above.
  for (const [index, spec] of specs.entries()) {
    const op = new CompositeOperation();
    const { getCreatedTaskId } = addSubtaskCreationSteps(
      op,
      authManager,
      parentTaskId,
      () => parentProjectId,
      spec,
    );
    const result = await op.run({ atomic });
    const createdTaskId = getCreatedTaskId();
    const relateStep = result.steps.find((s) => s.name === 'create-relation');
    const related = relateStep?.status === 'succeeded';

    if (result.ok) {
      results.push({
        index,
        title: spec.title,
        created: true,
        related: true,
        ...(createdTaskId !== undefined ? { subtaskId: createdTaskId } : {}),
      });
    } else {
      const err = result.error instanceof Error ? result.error : new Error(String(result.error));
      results.push({
        index,
        title: spec.title,
        created: createdTaskId !== undefined,
        related,
        ...(createdTaskId !== undefined ? { subtaskId: createdTaskId } : {}),
        error: err.message,
      });
    }
  }

  const succeeded = results.filter((r) => r.created && r.related && !r.error);
  const failed = results.filter((r) => !(r.created && r.related && !r.error));

  if (succeeded.length === 0) {
    throw new MCPError(
      ErrorCode.API_ERROR,
      `Bulk create-subtasks failed. Could not create any subtasks under parent ${parentTaskId}. ` +
        `Failures: ${failed.map((f) => `[${f.index}] ${f.error ?? 'unknown error'}`).join('; ')}`,
    );
  }

  const partial = failed.length > 0;
  const failedIndexes = failed.map((f) => f.index);

  const response = createStandardResponse(
    'bulk-create-subtasks',
    partial
      ? `Bulk create-subtasks partially completed under parent ${parentTaskId}. Successfully created and related ${succeeded.length} of ${specs.length} subtask(s). Failed indexes: ${failedIndexes.join(', ')}`
      : `Successfully created and related ${succeeded.length} subtask(s) under parent ${parentTaskId}`,
    {
      parentTaskId,
      projectId: parentProjectId,
      atomic,
      subtasks: results,
      ...(partial ? { failedIndexes } : {}),
    },
    {
      timestamp: new Date().toISOString(),
      count: succeeded.length,
      ...(partial ? { failedCount: failed.length, success: false } : {}),
    },
    args.sessionId,
  );

  return { content: [{ type: 'text' as const, text: formatAorpAsMarkdown(response) }] };
}

export interface ListSubtasksArgs {
  /** Id of the task whose subtasks should be listed. */
  id?: number;
  sessionId?: string;
}

/** Minimal per-subtask summary returned by `list-subtasks`. */
interface SubtaskSummary {
  id: number | undefined;
  title: string | undefined;
  done: boolean | undefined;
  assignees: Array<{ id: number | undefined; username: string | undefined }>;
}

/**
 * Read composite: lists a task's subtasks in one call — the `"subtask"`
 * slice of `GET /tasks/{id}`'s `related_tasks` map, summarized to
 * id/title/done/assignees rather than the full related `Task` objects.
 */
export async function listSubtasks(args: ListSubtasksArgs, authManager: AuthManager): Promise<McpResponse> {
  if (!args.id) {
    throw new MCPError(ErrorCode.VALIDATION_ERROR, 'Task ID is required');
  }
  validateId(args.id, 'id');

  let task: VikunjaTask;
  try {
    task = await getTaskViaRest(authManager, args.id);
  } catch (error) {
    rethrow(error, `Task ${args.id} not found`, 'Failed to list subtasks');
  }

  const subtasks: SubtaskSummary[] = extractRelatedTasks(task, 'subtask').map((t) => ({
    id: t.id,
    title: t.title,
    done: t.done,
    assignees: (t.assignees ?? []).map((a) => ({ id: a.id, username: a.username })),
  }));

  const response = createStandardResponse(
    'list-subtasks',
    subtasks.length > 0
      ? `Found ${subtasks.length} subtask(s) for task ${args.id}`
      : `Found 0 subtasks for task ${args.id}`,
    { taskId: args.id, subtasks, count: subtasks.length },
    { timestamp: new Date().toISOString(), count: subtasks.length },
    args.sessionId,
  );

  return { content: [{ type: 'text' as const, text: formatAorpAsMarkdown(response) }] };
}
