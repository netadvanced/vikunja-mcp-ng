/**
 * The contract both task-update strategies satisfy.
 *
 * `vikunja_tasks update` runs one of two genuinely different algorithms
 * depending on which Vikunja version is on the other end. They are not the
 * same sequence with a different URL prefix: they differ in call count,
 * ordering and request body, so they live behind this interface rather than
 * as an `if (v2)` branch inside one function (see the "Strategy + Context per
 * operation" section of
 * docs/superpowers/specs/2026-08-02-vikunja-v2-native-adoption-design.md).
 *
 * Whichever runs, the caller sees the same canonical result: a `models.Task`
 * with the update applied, in the shape v1 has always produced.
 */

import type { AuthManager } from '../../../../auth/AuthManager';
import type { ApiVersion } from '../../../../utils/api-version';
import type { components } from '../../../../types/generated/vikunja-openapi';

/** `models.Task` per the OpenAPI spec — the canonical internal task shape. */
export type VikunjaTask = components['schemas']['models.Task'];

/**
 * Caller-supplied fields for `vikunja_tasks update`.
 *
 * Lives here rather than in `../TaskUpdateService` so the strategies can
 * depend on it without importing their own orchestrator; that module
 * re-exports it, so the public surface is unchanged.
 */
export interface UpdateTaskArgs {
  id?: number;
  title?: string;
  description?: string;
  dueDate?: string;
  startDate?: string;
  endDate?: string;
  priority?: number;
  /**
   * Completion progress as a whole percentage, **0-100** (50 = 50%), the
   * tool surface's scale. Converted to Vikunja's 0-1 wire fraction before it
   * reaches the API — see `src/utils/percent-done.ts`.
   */
  percentDone?: number;
  done?: boolean;
  /**
   * Task colour, `#RRGGBB`, or `''` to clear it.
   *
   * `hex_color` is in `updateSingleTask`'s column allowlist and Vikunja
   * deliberately maps an empty value back onto the task, so both setting and
   * clearing are real, server-backed operations — see `validateHexColor` in
   * `../../validation`.
   */
  hexColor?: string;
  /** Move the task to another project. */
  projectId?: number;
  labels?: number[];
  assignees?: number[];
  repeatAfter?: number;
  repeatMode?: 'day' | 'week' | 'month' | 'year';
  /**
   * Move the task into a Kanban bucket. Applied via the same view/bucket
   * resolution `set-bucket` uses (see `moveTaskToBucket` in `../../buckets`).
   */
  bucketId?: number;
  /** Optional Kanban view id, used with `bucketId`. Auto-resolved when omitted. */
  viewId?: number;
  /** Session ID for AORP response tracking. */
  sessionId?: string;
}

/**
 * Everything a strategy needs to apply one update.
 *
 * `currentTask` is read once by the caller, before dispatch, because the
 * response metadata (`previousState`, `affectedFields`) is derived from it on
 * both paths. Passing it in rather than letting each strategy fetch it keeps
 * the v2 path at one read: the diff read and the merge read would otherwise be
 * two separate calls, and the whole point of this step is to remove calls.
 *
 * Note what this does *not* mean: the v2 path does not read-modify-write. It
 * never feeds `currentTask` into the request body, so two concurrent v2
 * updates cannot overwrite each other's untouched fields the way two v1
 * full-model POSTs can.
 */
export interface TaskUpdateInput {
  readonly authManager: AuthManager;
  readonly taskId: number;
  readonly args: UpdateTaskArgs;
  /** The task as it was immediately before the update. */
  readonly currentTask: VikunjaTask;
}

export interface TaskUpdateStrategy {
  /** Which Vikunja API this strategy writes through. Diagnostics only. */
  readonly apiVersion: ApiVersion;

  /**
   * Applies the update and resolves with the complete, updated task.
   *
   * Implementations own their own ordering, including the label write, the
   * assignee write and any Kanban bucket move, because that ordering is
   * exactly what differs between them.
   */
  execute(input: TaskUpdateInput): Promise<VikunjaTask>;
}
