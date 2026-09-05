import { z } from 'zod';
import { MCPError, ErrorCode } from '../types';
import { percentDoneSchema } from '../utils/percent-done';

/* ===================================================================
 * TYPE DEFINITIONS & SCHEMAS
 * Zod schemas and TypeScript interfaces for imported tasks from JSON
 * =================================================================== */

/**
 * Zod schema for validating imported task data from JSON
 * Defines the structure and validation rules for task objects
 */
export const importedTaskSchema = z
  .object({
    title: z.string().min(1),
    description: z.string().optional(),
    done: z.boolean().optional(),
    dueDate: z.string().optional(),
    priority: z.number().optional(),
    labels: z.array(z.string()).optional(),
    assignees: z.array(z.string()).optional(),
    startDate: z.string().optional(),
    endDate: z.string().optional(),
    hexColor: z
      .string()
      .regex(/^#[0-9A-Fa-f]{6}$/)
      .optional(),
    // Whole percentage 0-100, the same scale as `percentDone` everywhere else
    // on this tool surface. Converted to Vikunja's 0-1 wire fraction in
    // `TaskCreationService.prepareTaskData` — see src/utils/percent-done.ts.
    percentDone: percentDoneSchema,
    repeatAfter: z.number().optional(),
    repeatMode: z.number().optional(),
    reminders: z.array(z.string()).optional(),
  })
  .strict(); // Reject unknown properties

/**
 * TypeScript type inferred from the importedTaskSchema
 * Represents a valid task object that can be imported
 */
export type ImportedTask = z.infer<typeof importedTaskSchema>;

/**
 * One input row/task that was dropped during parsing because it failed
 * `importedTaskSchema` validation while `skipErrors` was set. `index` is the
 * row's 0-based position within the original input (the JSON array position,
 * or the CSV data-row order — see each parser for its exact numbering); the
 * caller uses it to tell the operator which row to go fix. Kept in sync by
 * {@link parseJSONInput} and `parseCSVInput` (src/parsers/InputParserFactory.ts)
 * so both parsers report skipped rows the same shape (#323).
 */
export interface SkippedRow {
  index: number;
  error: string;
}

/**
 * Return shape for both parsers: the tasks that validated, plus a full
 * record of every row that did not (when `skipErrors` allowed parsing to
 * continue past them). Replaces the old bare `ImportedTask[]` return, which
 * gave `skipErrors:true` callers no way to know anything was dropped (#323).
 */
export interface ParsedTasksResult {
  tasks: ImportedTask[];
  skipped: SkippedRow[];
}

/* ===================================================================
 * JSON PARSING FUNCTIONS
 * Functions for parsing and validating JSON input data
 * =================================================================== */

/**
 * Parses JSON input and normalizes to array of ImportedTask objects.
 * Handles both single task objects and arrays of tasks.
 * Validates each task against importedTaskSchema.
 *
 * @param data - JSON string containing task data
 * @param skipErrors - When true, a task that fails schema validation is
 *   dropped rather than aborting the whole import — matching the CSV path's
 *   documented `skipErrors` contract (previously JSON silently ignored this
 *   flag and always threw on the first invalid task, MED-14 from #294).
 *   Malformed JSON syntax (the input isn't parseable at all) always throws
 *   regardless of `skipErrors`: there is no per-task boundary to skip within
 *   a document that doesn't parse. Every dropped task is now recorded in the
 *   returned `skipped` array instead of silently vanishing (#323).
 * @returns `{ tasks, skipped }` — the validated tasks, and every task index
 *   that failed validation and was dropped (only ever non-empty when
 *   `skipErrors` is true; otherwise the first failure throws instead).
 * @throws {MCPError} If JSON is malformed, or if validation fails and
 *   `skipErrors` is not set
 *
 * @example
 * parseJSONInput('{"title": "Task 1"}')
 * // Returns: { tasks: [{title: "Task 1"}], skipped: [] }
 *
 * parseJSONInput('[{"title": "Task 1"}, {"title": "Task 2"}]')
 * // Returns: { tasks: [{title: "Task 1"}, {title: "Task 2"}], skipped: [] }
 */
export function parseJSONInput(data: string, skipErrors: boolean = false): ParsedTasksResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data) as unknown;
  } catch (error) {
    throw new MCPError(
      ErrorCode.VALIDATION_ERROR,
      `Invalid JSON data: ${error instanceof Error ? error.message : 'Unknown error'}`,
    );
  }

  const taskArray = Array.isArray(parsed) ? parsed : [parsed];

  const tasks: ImportedTask[] = [];
  const skipped: SkippedRow[] = [];
  taskArray.forEach((task, index) => {
    try {
      const validatedTask = importedTaskSchema.parse(task);
      tasks.push(validatedTask);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      if (!skipErrors) {
        throw new MCPError(ErrorCode.VALIDATION_ERROR, `Invalid JSON data: ${message}`);
      }
      // skipErrors is set: drop this task, keep processing the rest, but
      // record it so the caller can report it instead of silently losing it.
      skipped.push({ index, error: message });
    }
  });
  return { tasks, skipped };
}
