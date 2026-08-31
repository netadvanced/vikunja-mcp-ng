/**
 * `strictNestedObject` — the loud-rejection half of the silently-dropped-field
 * fix.
 *
 * ## The bug class this closes
 *
 * Zod strips unknown object keys by default. So when an AI caller sends a
 * field one of our schemas does not declare, the key vanishes: no error, no
 * warning, the tool reports success, and the caller's stated intent is
 * silently lost. That is the worst failure mode this codebase recognizes —
 * a loud error beats silent wrongness every time (the same reasoning that
 * made `position` on `vikunja_tasks create` reject with a pointer at
 * `set-position` rather than be ignored, PR #229).
 *
 * The failure is worst inside **nested array-of-object shapes** — the
 * per-task shape of `vikunja_projects setup-kanban`, the `tasks[]` of
 * `vikunja_task_bulk bulk-create`, the `subtasks[]` of
 * `vikunja_tasks bulk-create-subtasks`. The top-level call still looks
 * well-formed, so nothing anywhere signals that a field went missing. A real
 * battle run hit exactly this: asked to record a task as "75% done", the model
 * sent one `setup-kanban` call carrying `tasks: [{ title: …, percentDone: 75 }]`,
 * `percentDone` was undeclared on that shape, and the task was created at 0%
 * with a success response.
 *
 * ## Why strict here and not everywhere
 *
 * These nested shapes have a **closed, small vocabulary** — there is no
 * legitimate "harmless extra" a caller passes to a per-task spec. The big
 * top-level tool shapes are the opposite: they are shared across every
 * subcommand of a tool and deliberately tolerate fields that are meaningless
 * for the subcommand in play (`projectId`/`id` aliases, query params carried
 * over between calls), so making THOSE strict would reject calls that are
 * fine today. Strictness is applied where an unknown key is always a mistake,
 * not as a blanket policy. `importedTaskSchema` (src/parsers/JSONParser.ts)
 * has drawn the same line since batch-import shipped.
 *
 * ## Why not plain `.strict()`
 *
 * Zod's default message ("Unrecognized key(s) in object: 'percentDone'") names
 * the key but teaches nothing — it does not say what the shape *does* accept
 * or where the field the caller wanted actually lives. `.strict(message)`
 * would replace that message wholesale and lose the key name. This helper
 * keeps the key names AND appends the supported-field list plus a
 * caller-supplied pointer at the right tool/subcommand.
 */

import { z } from 'zod';

/**
 * Builds a `.strict()` object schema whose unknown-key error names the
 * offending key(s), lists what the shape actually accepts, and appends a
 * caller-supplied hint pointing at the right place for the field.
 *
 * @param shape - the object shape, exactly as it would be passed to `z.object`
 * @param label - what this shape is, for the error's first sentence (e.g.
 *   `'a setup-kanban task'`)
 * @param hint - a teaching sentence naming the tool/subcommand that DOES own
 *   the kind of field a caller is likely to have reached for
 */
export function strictNestedObject<T extends z.ZodRawShape>(
  shape: T,
  label: string,
  hint: string,
): z.ZodObject<T, 'strict'> {
  const supported = Object.keys(shape).join(', ');
  return z
    .object(shape, {
      errorMap: (issue, ctx) => {
        if (issue.code === z.ZodIssueCode.unrecognized_keys) {
          const keys = issue.keys.map((k) => `"${k}"`).join(', ');
          return {
            message:
              `Unrecognized field(s) ${keys} on ${label} — rejected rather than silently ` +
              `dropped. ${label} accepts: ${supported}. ${hint}`,
          };
        }
        return { message: ctx.defaultError };
      },
    })
    .strict();
}
