/**
 * Shared, version-blind parts of a task update: the pre-update read that
 * feeds the response metadata, and the caller-args-to-wire-fields mapping.
 *
 * Both strategies use both. Keeping the field mapping in one place is the
 * point: v1 spreads it over a full-model copy and v2 sends it on its own as a
 * merge patch, so if the mapping were written twice the two paths would drift
 * on the next field added — which is exactly the failure the strategy split
 * exists to prevent.
 */

import type { AuthManager } from '../../../../auth/AuthManager';
import { vikunjaRestRequest } from '../../../../utils/vikunja-rest';
import { percentDoneToFraction } from '../../../../utils/percent-done';
import { convertRepeatConfiguration } from '../../validation';
import type { UpdateTaskArgs, VikunjaTask } from './types';

/**
 * Pre-update snapshot plus the diff the response reports back to the caller.
 */
export interface UpdateState {
  currentTask: VikunjaTask;
  previousState: Record<string, unknown>;
  affectedFields: string[];
}

/**
 * Reads the task as it stands and works out which of the supplied fields
 * actually change it.
 *
 * This read happens on both the v1 and the v2 path. On v1 it is also the
 * "read" half of read-modify-write; on v2 it only feeds `previousState` and
 * `affectedFields`, both of which are caller-visible in the AORP response and
 * cannot be derived from a `PATCH` response (which reports the new state, not
 * the old one). Dropping it on v2 would make the two strategies observably
 * different, which the P3 spec forbids.
 */
export async function analyzeUpdateState(
  authManager: AuthManager,
  taskId: number,
  args: UpdateTaskArgs,
): Promise<UpdateState> {
  // Fetch the current task to preserve all fields and track changes
  const currentTask = await vikunjaRestRequest<VikunjaTask>(authManager, 'GET', `/tasks/${taskId}`);
  const previousState: Record<string, unknown> = {};
  if (currentTask.title !== undefined) previousState.title = currentTask.title;
  if (currentTask.description !== undefined) previousState.description = currentTask.description;
  if (currentTask.due_date !== undefined) previousState.due_date = currentTask.due_date;
  if (currentTask.start_date !== undefined) previousState.start_date = currentTask.start_date;
  if (currentTask.end_date !== undefined) previousState.end_date = currentTask.end_date;
  if (currentTask.priority !== undefined) previousState.priority = currentTask.priority;
  if (currentTask.done !== undefined) previousState.done = currentTask.done;
  if (currentTask.percent_done !== undefined) previousState.percent_done = currentTask.percent_done;
  if (currentTask.hex_color !== undefined) previousState.hex_color = currentTask.hex_color;
  if (currentTask.project_id !== undefined) previousState.project_id = currentTask.project_id;
  if (currentTask.repeat_after !== undefined) previousState.repeat_after = currentTask.repeat_after;
  if (currentTask.repeat_mode !== undefined) previousState.repeat_mode = currentTask.repeat_mode;

  // Track which fields are being updated
  const affectedFields: string[] = [];

  if (args.title !== undefined && args.title !== currentTask.title) affectedFields.push('title');
  if (args.description !== undefined && args.description !== currentTask.description)
    affectedFields.push('description');
  if (args.dueDate !== undefined && args.dueDate !== currentTask.due_date)
    affectedFields.push('dueDate');
  if (args.startDate !== undefined && args.startDate !== currentTask.start_date)
    affectedFields.push('start_date');
  if (args.endDate !== undefined && args.endDate !== currentTask.end_date)
    affectedFields.push('end_date');
  if (args.priority !== undefined && args.priority !== currentTask.priority)
    affectedFields.push('priority');
  // args.percentDone is a 0-100 percentage; currentTask.percent_done is the
  // 0-1 wire fraction. Compare in wire space so "already 75%" is correctly
  // reported as unchanged instead of always looking different.
  if (
    args.percentDone !== undefined &&
    percentDoneToFraction(args.percentDone) !== currentTask.percent_done
  )
    affectedFields.push('percentDone');
  if (args.done !== undefined && args.done !== currentTask.done) affectedFields.push('done');
  // Vikunja stores hex_color WITHOUT the leading '#' (utils.NormalizeHex), so
  // the stored '4287f5' is compared against the caller's '#4287f5' with the
  // '#' stripped — otherwise a no-op recolour would always look like a change.
  if (
    args.hexColor !== undefined &&
    args.hexColor.replace(/^#/, '').toLowerCase() !==
      (currentTask.hex_color ?? '').replace(/^#/, '').toLowerCase()
  )
    affectedFields.push('hexColor');
  if (args.projectId !== undefined && args.projectId !== currentTask.project_id)
    affectedFields.push('projectId');
  if (args.repeatAfter !== undefined && args.repeatAfter !== currentTask.repeat_after)
    affectedFields.push('repeatAfter');
  // args.repeatMode is the user-facing string enum ('day'|'week'|...);
  // currentTask.repeat_mode is the API's numeric enum (0|1|2) — these were
  // never the same representation even before this migration (the legacy client's
  // type incorrectly claimed both were the string enum), so this comparison
  // is always true when repeatMode is supplied. Cast preserves that existing
  // runtime behavior while satisfying the now-correctly-typed comparison.
  if (args.repeatMode !== undefined && (args.repeatMode as unknown) !== currentTask.repeat_mode)
    affectedFields.push('repeatMode');
  if (args.labels !== undefined) affectedFields.push('labels');
  if (args.assignees !== undefined) affectedFields.push('assignees');
  // bucketId has no comparable "current" representation here (models.Task's
  // bucket_id is only populated when the task is fetched via a view with
  // buckets — see docs/API_NOTES.md), so it's reported unconditionally like
  // labels/assignees above. If the actual move (moveTaskToBucket, called
  // by the strategy) fails, the whole request throws before this
  // affectedFields list is ever returned to the caller, so it stays honest.
  if (args.bucketId !== undefined) affectedFields.push('bucketId');

  return {
    currentTask,
    previousState,
    affectedFields,
  };
}

/**
 * Maps the caller's arguments onto Vikunja's wire field names, returning only
 * the fields the caller actually supplied.
 *
 * v1 spreads this over a copy of the whole current task, because its `POST`
 * replaces every column it is given. v2 sends it as-is, because merge-patch
 * leaves absent fields alone. Same mapping, two envelopes.
 *
 * Relationship fields (`labels`, `assignees`, `bucketId`) are deliberately not
 * here: each strategy applies them its own way, at its own point in the
 * sequence.
 */
export function buildTaskFieldPatch(args: UpdateTaskArgs): Partial<VikunjaTask> {
  return {
    ...(args.title !== undefined && { title: args.title }),
    ...(args.description !== undefined && { description: args.description }),
    ...(args.dueDate !== undefined && { due_date: args.dueDate }),
    ...(args.startDate !== undefined && { start_date: args.startDate }),
    ...(args.endDate !== undefined && { end_date: args.endDate }),
    ...(args.priority !== undefined && { priority: args.priority }),
    // 0-100 percentage in, 0-1 fraction on the wire.
    ...(args.percentDone !== undefined && {
      percent_done: percentDoneToFraction(args.percentDone),
    }),
    ...(args.done !== undefined && { done: args.done }),
    // Explicit-undefined so `hexColor: ''` reaches the wire as an empty
    // hex_color, which is how Vikunja clears a task colour.
    ...(args.hexColor !== undefined && { hex_color: args.hexColor }),
    // Move between projects — must be part of the write payload or Vikunja ignores it
    ...(args.projectId !== undefined && { project_id: args.projectId }),
    // Handle repeat configuration for updates.
    //
    // #274 (HIGH-3): `convertRepeatConfiguration` expects `repeatAfter` as a
    // user-friendly day/week/month/year *count* and multiplies it into
    // seconds. `currentTask.repeat_after` is already in seconds (it came
    // straight off the wire), so it must never be fed back into that
    // converter as a fallback — doing so re-applies the multiplier to an
    // already-converted value (e.g. a weekly task's 604800 seconds becomes
    // 604800 * 604800 seconds, ~1650 years). When only `repeatMode` is being
    // changed, leave `repeat_after` untouched and set `repeat_mode` directly.
    ...(args.repeatAfter !== undefined || args.repeatMode !== undefined
      ? ((): Partial<VikunjaTask> => {
          if (args.repeatAfter !== undefined) {
            const repeatConfig = convertRepeatConfiguration(args.repeatAfter, args.repeatMode);
            const updates: Partial<VikunjaTask> = {};
            if (repeatConfig.repeat_after !== undefined)
              updates.repeat_after = repeatConfig.repeat_after;
            if (repeatConfig.repeat_mode !== undefined)
              updates.repeat_mode = repeatConfig.repeat_mode as 0 | 1 | 2;
            return updates;
          }
          // Only repeatMode was provided: repeat_after is already in
          // seconds on the current task and must be left as-is.
          return { repeat_mode: args.repeatMode === 'month' ? 1 : 0 };
        })()
      : {}),
  };
}
