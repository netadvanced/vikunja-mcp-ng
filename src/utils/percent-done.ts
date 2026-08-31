/**
 * `percentDone` scale conversion — the ONE place the tool surface's
 * percentage scale meets Vikunja's wire fraction.
 *
 * **The tool surface exposes `percentDone` as a whole percentage, 0-100.**
 * Vikunja's wire contract is a fraction 0-1 (`models.Task.percent_done` is a
 * `PercentDone float64`; the frontend's own picker stores `[0, 0.1, … 1]` in
 * `PercentDoneSelect.vue` and every display site renders `percentDone * 100`).
 * Those two facts are both true — the fraction is real, it is just an
 * implementation detail of the transport, and this module keeps it there.
 *
 * Why the boundary sits here rather than passing the fraction through
 * (decision 22, docs/ROADMAP.md §3):
 *
 * - The wire fraction leaked an implementation detail agents had to
 *   memorize. A real Claude session using this MCP wrote the 0-1 scale down
 *   in its list of "gotchas" — the model compensating for the interface.
 *   That memory dies with the session and transfers to no other MCP client.
 * - Vikunja's own human-facing scale is 0-100 (its i18n describes the field
 *   that way); only the wire is a fraction. Two independent upstream
 *   contributors (democratize-technology/vikunja-mcp#94, #82) also assumed
 *   0-100.
 * - Design pillar 1 (docs/ROADMAP.md §1): the OpenAPI spec is our coverage
 *   *checklist*, not our tool design. This server is deliberately not a 1:1
 *   REST proxy.
 * - **INTEGERS ONLY is a safety property, not a style choice.** Under the
 *   0-1 contract an agent passing `percentDone: 1` meaning "done" silently
 *   wrote 1% — accepted, no error, wrong data. Requiring an integer makes
 *   `1` unambiguously 1%, and makes `0.5` a loud validation error that
 *   teaches instead of a silent 0.5%.
 *
 * ## Exactness and the rounding rule
 *
 * Write (`percentDoneToFraction`): `n / 100` for an integer `n` rounds to
 * exactly the same IEEE-754 double as the decimal literal a human would
 * write (`33 / 100 === 0.33`), so the write direction is as exact as the
 * wire representation allows and never introduces an artifact of its own.
 *
 * Read (`fractionToPercentDone`): `Math.round(fraction * 100)`. Rounding is
 * required, not cosmetic — the naive multiplication misses the integer for
 * eight of the 101 percentages (`0.07 * 100` is `7.000000000000001`,
 * `0.29 * 100` is `28.999999999999996`), and a value written by another
 * Vikunja client need not be a whole percent at all (the web UI's slider, an
 * import). **The rule: the read path reports the nearest whole percent, with
 * exact halves rounding up (`0.335` → `34`).** A fraction is therefore
 * round-trip safe through this pair for every integer 0-100, and lossy in
 * exactly one direction for sub-percent precision this tool surface
 * deliberately does not expose.
 */

import { z } from 'zod';
import { MCPError, ErrorCode } from '../types';

/**
 * The single teaching sentence every `percentDone` validation failure ends
 * with — Zod schema rejections and the hand-rolled guards on the paths
 * reachable without Zod alike. A bare "Number must be less than or equal to
 * 1" told an agent nothing it could act on; this tells it the scale, the
 * unit, and the exact mistake it most likely made.
 */
export const PERCENT_DONE_SCALE_HINT =
  'percentDone is a whole percentage 0-100 — use 50 for 50%, 100 for done. ' +
  'Fractions like 0.5 are not accepted (0.5 would mean half of one percent).';

/**
 * Builds the validation message for a rejected `percentDone`, naming the
 * field the caller actually used (`percentDone`, `percent_done`,
 * `tasks[2].percentDone`, …) so a bulk error points at the offending item.
 */
export function percentDoneScaleError(label = 'percentDone'): string {
  return `${label} must be a whole number between 0 and 100. ${PERCENT_DONE_SCALE_HINT}`;
}

/**
 * True when `value` is a valid tool-surface percentage: a finite integer in
 * `[0, 100]`.
 */
export function isValidPercentDone(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 100;
}

/**
 * Throws a teaching {@link MCPError} unless `value` is a valid 0-100 integer
 * percentage. Used on the code paths that are exported and therefore
 * reachable without the Zod schema in front of them (`createTask`,
 * `updateTask`, the bulk validators) — the Zod schemas enforce the same
 * range with the same wording at the MCP boundary.
 */
export function assertValidPercentDone(
  value: unknown,
  label = 'percentDone',
): asserts value is number {
  if (!isValidPercentDone(value)) {
    throw new MCPError(ErrorCode.VALIDATION_ERROR, percentDoneScaleError(label));
  }
}

/**
 * The optional `percentDone` Zod field, shared by every MCP schema that
 * accepts it (`vikunja_tasks`' flat args and its nested `tasks[]` shape,
 * `vikunja_task_bulk`'s `tasks[]`). Each of the three ways to get this wrong
 * — a non-integer, a negative, an over-100 value — reports the same teaching
 * message rather than Zod's default "Expected integer, received float".
 *
 * `.optional()` is baked in: every call site is optional today, and building
 * it in keeps the three schemas literally identical instead of
 * near-identical.
 */
export const percentDoneSchema = z
  .number()
  .int(percentDoneScaleError())
  .min(0, percentDoneScaleError())
  .max(100, percentDoneScaleError())
  .optional();

/**
 * Tool surface (0-100 integer) → Vikunja wire (0-1 fraction).
 *
 * Exact for every integer 0-100: `n / 100` and the decimal literal `0.nn`
 * round to the same double.
 */
export function percentDoneToFraction(percentage: number): number {
  return percentage / 100;
}

/**
 * Vikunja wire (0-1 fraction) → tool surface (0-100 integer).
 *
 * Rounds to the nearest whole percent, halves up — see the rounding rule in
 * this module's header.
 */
export function fractionToPercentDone(fraction: number): number {
  return Math.round(fraction * 100);
}

/**
 * Vikunja wire (0-1 fraction) → percent scale, WITHOUT rounding to a whole
 * percent — only the float artifact is cleaned up (`0.07 * 100` is
 * `7.000000000000001`; this returns `7`).
 *
 * Used for filter *thresholds*, not task field values, and the difference is
 * deliberate. A task's `percentDone` is an integer by contract, so
 * {@link fractionToPercentDone} rounding to a whole percent is honest. A
 * filter threshold is a comparison bound, never stored on a task — a saved
 * filter of `percent_done > 0.335` is a legitimate "more than a third done"
 * cutoff, and rounding it to `34` on read-back would silently change which
 * tasks the caller is told the filter selects.
 */
export function fractionToPercentExact(fraction: number): number {
  return Number((fraction * 100).toFixed(10));
}
