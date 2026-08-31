/**
 * Validation utilities for task operations
 */

import type { components } from '../../types/generated/vikunja-openapi';
import { MCPError, ErrorCode } from '../../types';
import { validateId as validateSharedId } from '../../utils/validation';

/** `models.Task` per the OpenAPI spec. */
type Task = components['schemas']['models.Task'];

/**
 * Validates that a date string is in valid ISO 8601 format
 */
export function validateDateString(date: string, fieldName: string): void {
  const parsed = new Date(date);
  if (isNaN(parsed.getTime())) {
    throw new MCPError(
      ErrorCode.VALIDATION_ERROR,
      `${fieldName} must be a valid ISO 8601 date string (e.g., 2024-05-24T10:00:00Z)`,
    );
  }
}

/**
 * Coerce a date-only `YYYY-MM-DD` string to a full RFC3339 timestamp
 * (`YYYY-MM-DDT00:00:00Z`) before it is sent to Vikunja.
 *
 * Vikunja's API expects `due_date`/`start_date`/`end_date` as RFC3339. A bare
 * date-only value on these create-family paths does NOT silently vanish:
 * verified live against 2.4.0, it is rejected outright with **HTTP 400,
 * code 2004** ("Invalid model provided") — the whole request fails, nothing
 * is persisted. This repo's own issue history contains both
 * characterizations (#164/#165 originally reported a silent drop; #167/#163
 * pinned it down as the 400) — the 400 is what actually applies to the
 * paths this helper normalizes for, and the "silently drops" wording above
 * is the stale one. See docs/VIKUNJA_API_ISSUES.md #19 for the full
 * writeup; don't re-flip this back without re-reading that. This helper
 * is the single normalization point for that coercion; already-full
 * timestamps (anything containing a `T`) are passed through unchanged, and
 * empty/undefined input is passed through as-is (validation of malformed
 * strings is `validateDateString`'s job, not this function's).
 *
 * It ALSO coerces the SQL-ish space-separated form `YYYY-MM-DD HH:MM[:SS]`
 * to `YYYY-MM-DDTHH:MM:SSZ` (issue #225). That spelling is what an agent
 * naturally writes inside a filter string — `created >= '2026-08-16
 * 00:00:00'` — and Vikunja rejects it outright with HTTP 400 code 4019
 * ("The task filter value '2026-08-16 00:00:00' for field 'created' is
 * invalid.", verified against 2.4.0). Because it is rejected rather than
 * accepted-and-ignored, the whole filtered call failed and silently dropped
 * into a fallback path. Coercing here keeps ONE date normalizer for both
 * task fields and filter literals (see `conditionToString` in
 * src/utils/filters.ts, the filter-string call site).
 */
export function normalizeDateForApi(date: string | undefined): string | undefined {
  if (!date) return date;
  const trimmed = date.trim();
  if (trimmed === '') return date;
  // Already a full timestamp (has a time component) - leave untouched.
  if (trimmed.includes('T')) return date;
  // Bare date-only form, e.g. '2026-07-24'.
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return `${trimmed}T00:00:00Z`;
  }
  // SQL-ish space-separated form, e.g. '2026-08-16 00:00:00' or
  // '2026-08-16 09:30'. Seconds are optional; anything already carrying an
  // explicit zone/offset is left for the branch above (it contains a 'T').
  const spaceSeparated = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})(:\d{2})?$/.exec(trimmed);
  if (spaceSeparated) {
    return `${spaceSeparated[1]}T${spaceSeparated[2]}${spaceSeparated[3] ?? ':00'}Z`;
  }
  // Anything else (malformed, or a format we don't recognize) - leave
  // untouched; validateDateString is responsible for rejecting it.
  return date;
}

/**
 * Validates a task `hexColor` (`models.Task.hex_color`).
 *
 * Accepts `#RRGGBB` — the same spelling `vikunja_projects` and
 * `vikunja_labels` already require — and, additionally, the empty string,
 * which is the ONLY way to clear a colour: Vikunja's task update explicitly
 * maps an empty `hex_color` back onto the stored task (`if t.HexColor == ""
 * { ot.HexColor = "" }`, pkg/models/tasks.go), so `hexColor: ''` is a real
 * caller intent and must not be mistaken for "not supplied". Everything on
 * this path therefore tests `!== undefined`, never truthiness.
 *
 * The server itself is laxer (`utils.NormalizeHex` just strips a leading `#`
 * and truncates to 6 chars, so `zzzzzz` would be stored verbatim); this
 * rejects malformed input up front rather than writing a colour no client can
 * render.
 */
export function validateHexColor(hexColor: string, fieldName = 'hexColor'): void {
  if (hexColor === '') return;
  if (!/^#[0-9A-Fa-f]{6}$/.test(hexColor)) {
    throw new MCPError(
      ErrorCode.VALIDATION_ERROR,
      `Invalid ${fieldName} format. Expected #RRGGBB (e.g. #4287f5, #FF0000), ` +
        `or '' to clear the color.`,
    );
  }
}

/**
 * Validates that an ID is a positive integer
 * @deprecated Use validateSharedId from '../../../utils/validation' instead
 */
export const validateId = validateSharedId;

/**
 * Convert repeat configuration from user-friendly format to Vikunja API format
 *
 * Vikunja API expects:
 * - repeat_after: time in seconds
 * - repeat_mode: 0 = default (use repeat_after), 1 = monthly, 2 = from current date
 *
 * We accept:
 * - repeatAfter: number (interpreted based on repeatMode)
 * - repeatMode: 'day' | 'week' | 'month' | 'year'
 */
export function convertRepeatConfiguration(
  repeatAfter?: number,
  repeatMode?: 'day' | 'week' | 'month' | 'year',
): { repeat_after?: number; repeat_mode?: number } {
  const result: { repeat_after?: number; repeat_mode?: number } = {};

  if (repeatMode === 'month') {
    // For monthly repeat, use repeat_mode = 1 (ignores repeat_after)
    result.repeat_mode = 1;
    // Still set repeat_after for consistency, though it will be ignored
    if (repeatAfter !== undefined) {
      result.repeat_after = repeatAfter * 30 * 24 * 60 * 60; // Approximate month in seconds
    }
  } else if (repeatAfter !== undefined) {
    // For other modes, use repeat_mode = 0 and convert to seconds
    result.repeat_mode = 0;

    switch (repeatMode) {
      case 'day':
        result.repeat_after = repeatAfter * 24 * 60 * 60; // Days to seconds
        break;
      case 'week':
        result.repeat_after = repeatAfter * 7 * 24 * 60 * 60; // Weeks to seconds
        break;
      case 'year':
        result.repeat_after = repeatAfter * 365 * 24 * 60 * 60; // Years to seconds (approximate)
        break;
      default:
        // If no mode specified, assume the value is already in seconds
        result.repeat_after = repeatAfter;
    }
  }

  return result;
}

/**
 * Process an array in batches
 */
export async function processBatches<T, R>(
  items: T[],
  batchSize: number,
  processor: (batch: T[]) => Promise<R[]>,
): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const batchResults = await processor(batch);
    results.push(...batchResults);
  }
  return results;
}

/**
 * Apply field update to a task object for bulk operations
 * Maps field names to their corresponding task properties
 *
 * @param task - The task object to update (will be mutated)
 * @param field - The field name to update (optional, will be checked)
 * @param value - The new value
 * @returns The same task object with the field applied
 */
export function applyFieldUpdate(task: Task, field: string | undefined, value: unknown): Task {
  if (!field) return task;

  switch (field) {
    case 'done':
      task.done = value as boolean;
      break;
    case 'priority':
      task.priority = value as number;
      break;
    // Already the 0-1 wire fraction by the time it gets here. The tool
    // surface's scale is a whole percentage 0-100; the single conversion for
    // the bulk-update path happens upstream in `resolveBulkUpdateValue`
    // (./bulk-operations-simplified.ts), because that same resolved value
    // also goes straight into the native POST /tasks/bulk payload. Converting
    // again here would halve it a second time — see src/utils/percent-done.ts.
    case 'percent_done':
    case 'percentDone':
      task.percent_done = value as number;
      break;
    case 'due_date':
      task.due_date = value as string;
      break;
    // Accept both snake_case (Vikunja API form) and camelCase (MCP schema form):
    // bulk-update routes snake_case here, but per-task update may pass camelCase.
    case 'start_date':
    case 'startDate':
      task.start_date = value as string;
      break;
    case 'end_date':
    case 'endDate':
      task.end_date = value as string;
      break;
    case 'project_id':
      task.project_id = value as number;
      break;
    case 'repeat_after':
      task.repeat_after = value as number;
      break;
    case 'repeat_mode':
      (task as Record<string, unknown>).repeat_mode = value;
      break;
    case 'assignees':
    case 'labels':
      // These are handled separately with special API calls
      break;
    default:
      // Unknown field - leave task unchanged
      break;
  }
  return task;
}
