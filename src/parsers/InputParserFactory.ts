import { MCPError, ErrorCode } from '../types';
import { parseCSVLine, splitCSVRows } from './CSVParser';
import {
  parseJSONInput,
  importedTaskSchema,
  type ImportedTask,
  type ParsedTasksResult,
  type SkippedRow,
} from './JSONParser';
import { logger } from '../utils/logger';

export interface ParseInputOptions {
  format: 'csv' | 'json';
  data: string;
  skipErrors?: boolean;
}

// Re-export ImportedTask (and the shared skipped-row types) for convenience
export type { ImportedTask, ParsedTasksResult, SkippedRow } from './JSONParser';

/**
 * Factory function to parse input data based on format.
 * This centralizes format detection and parser orchestration logic.
 *
 * @param options - Parsing options including format, data, and error handling
 * @returns `{ tasks, skipped }` — the validated tasks and every row dropped
 *   during parsing (see {@link ParsedTasksResult}); non-empty `skipped` only
 *   ever happens when `skipErrors` is set, since otherwise the first invalid
 *   row throws instead (#323).
 * @throws MCPError if parsing fails or validation errors occur
 */
export function parseInputData(options: ParseInputOptions): ParsedTasksResult {
  const { format, data, skipErrors = false } = options;

  // Validate input parameters
  if (!data || data.trim() === '') {
    throw new MCPError(ErrorCode.VALIDATION_ERROR, 'Input data cannot be empty');
  }

  try {
    switch (format) {
      case 'json':
        return parseJSONInput(data, skipErrors);

      case 'csv':
        return parseCSVInput(data, skipErrors);

      default: {
        // Use format directly for error message
        throw new MCPError(
          ErrorCode.VALIDATION_ERROR,
          `Unsupported format: ${String(format)}. Supported formats are: csv, json`,
        );
      }
    }
  } catch (error) {
    // Re-throw MCP errors as-is
    if (error instanceof MCPError) {
      throw error;
    }

    // Wrap other errors in MCPError
    throw new MCPError(
      ErrorCode.VALIDATION_ERROR,
      `Failed to parse ${format} input: ${error instanceof Error ? error.message : 'Unknown error'}`,
    );
  }
}

/**
 * Every CSV column this importer understands — the exact set the per-row
 * `switch` in {@link parseCSVInput} handles, kept beside it so the two cannot
 * drift. Mirrors `importedTaskSchema`'s own field list minus `reminders`,
 * which has no CSV representation.
 */
const CSV_SUPPORTED_HEADERS = new Set([
  'title',
  'description',
  'done',
  'dueDate',
  'priority',
  'labels',
  'assignees',
  'startDate',
  'endDate',
  'hexColor',
  'percentDone',
  'repeatAfter',
  'repeatMode',
]);

/** String forms of `done` this importer recognizes as true/false, matched case-insensitively after trimming. */
const CSV_DONE_TRUE_VALUES = new Set(['true', 'yes', 'y', '1']);
const CSV_DONE_FALSE_VALUES = new Set(['false', 'no', 'n', '0']);

/**
 * Coerces a CSV `done` column value to a boolean. Recognizes the common
 * truthy/falsy string spellings a spreadsheet export is likely to produce
 * (`yes`/`no`, `1`/`0`) in addition to the literal `true`/`false` this
 * importer originally required — anything not on this list falls back to
 * `false` (unchanged from prior behavior) but is logged so a typo like
 * "maybe" does not silently become "not done" with no trace (LOW-8).
 *
 * @param value - Raw CSV cell value for the `done` column
 * @returns The coerced boolean
 */
function coerceCSVDone(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (CSV_DONE_TRUE_VALUES.has(normalized)) return true;
  if (CSV_DONE_FALSE_VALUES.has(normalized)) return false;
  logger.warn('Unrecognized "done" value in CSV import; defaulting to false', {
    rawValue: value,
    recognizedTrue: Array.from(CSV_DONE_TRUE_VALUES),
    recognizedFalse: Array.from(CSV_DONE_FALSE_VALUES),
  });
  return false;
}

/**
 * Coerces a CSV numeric column value (priority, percentDone, repeatAfter,
 * repeatMode) to an integer for {@link importedTaskSchema}, which requires
 * whole numbers for these fields.
 *
 * Deliberately NOT `parseInt`: `parseInt('3.9', 10)` silently truncates to
 * `3`, so a decimal value would import as a different, wrong integer with no
 * error and no warning (LOW-7) — the exact same "succeeded-and-lost-data"
 * shape as the unknown-CSV-header bug this file already refuses elsewhere.
 * `Number` followed by an integer check instead returns `NaN` for both
 * non-numeric garbage (matching `parseInt`'s existing failure mode, which
 * `importedTaskSchema` already rejects) and for a non-integer decimal like
 * `3.9`, routing both through the same schema-validation error path this
 * function's caller's `skipErrors` handling already governs — no truncation,
 * no silent partial acceptance.
 *
 * @param value - Raw CSV cell value for a numeric column
 * @returns The parsed integer, or `NaN` if `value` is not a whole number
 */
function parseCSVIntegerField(value: string): number {
  const num = Number(value);
  return Number.isInteger(num) ? num : NaN;
}

/**
 * Parse CSV input data and return array of ImportedTask objects.
 * Extracted from batch-import.ts to improve modularity and testability.
 *
 * @param data - Raw CSV string data
 * @param skipErrors - Whether to skip invalid rows or throw an error
 * @returns `{ tasks, skipped }` — the validated tasks and every data row that
 *   failed `importedTaskSchema` validation and was dropped (#323); `index` in
 *   each skipped entry is the row's 0-based position among data rows (the
 *   first data row, right after the header, is index 0).
 * @throws MCPError if CSV structure is invalid or validation fails (when skipErrors=false)
 */
function parseCSVInput(data: string, skipErrors: boolean = false): ParsedTasksResult {
  const tasks: ImportedTask[] = [];
  const skipped: SkippedRow[] = [];

  // Split into logical CSV rows (quote-aware — see splitCSVRows's doc
  // comment for why this must run before, not on top of, a naive '\n'
  // split) and filter out blank ones.
  const lines = splitCSVRows(data).filter((line) => line.trim());
  if (lines.length < 2) {
    throw new MCPError(
      ErrorCode.VALIDATION_ERROR,
      'CSV must have at least a header row and one data row',
    );
  }

  // Parse header
  const headers = parseCSVLine(lines[0] || '');
  const requiredHeaders = ['title'];
  const missingHeaders = requiredHeaders.filter((h) => !headers.includes(h));

  if (missingHeaders.length > 0) {
    throw new MCPError(
      ErrorCode.VALIDATION_ERROR,
      `Missing required CSV headers: ${missingHeaders.join(', ')}`,
    );
  }

  // Reject unknown headers instead of ignoring them. The per-row `switch`
  // below has no `default:` case, so a column this importer does not know
  // used to be dropped without a word: the import reported every row
  // imported and the data simply was not there. That is the same
  // silently-dropped-field failure the JSON path already refuses —
  // `importedTaskSchema` is `.strict()` (src/parsers/JSONParser.ts), so the
  // identical payload as JSON errors while as CSV it succeeded-and-lost-data.
  // `skipErrors` still opts out, matching how it governs every other
  // validation failure on this path.
  const unknownHeaders = headers.filter((h) => h.trim() !== '' && !CSV_SUPPORTED_HEADERS.has(h));
  if (unknownHeaders.length > 0 && !skipErrors) {
    throw new MCPError(
      ErrorCode.VALIDATION_ERROR,
      `Unrecognized CSV column(s): ${unknownHeaders.map((h) => `"${h}"`).join(', ')}. ` +
        `Supported columns: ${[...CSV_SUPPORTED_HEADERS].join(', ')}. Remove the column (or ` +
        'set skipErrors to import anyway, dropping it).',
    );
  }

  // Parse data rows
  for (let i = 1; i < lines.length; i++) {
    const values = parseCSVLine(lines[i] || '');

    // Skip empty rows
    if (values.every((value) => !value || value.trim() === '')) {
      continue;
    }

    interface TaskDataInput {
      title?: string;
      description?: string;
      done?: boolean;
      dueDate?: string;
      priority?: number;
      labels?: string[];
      assignees?: string[];
      startDate?: string;
      endDate?: string;
      hexColor?: string;
      percentDone?: number;
      repeatAfter?: number;
      repeatMode?: number;
    }

    const taskData: TaskDataInput = {};

    headers.forEach((header, index) => {
      const value = values[index];
      if (value) {
        switch (header) {
          case 'title':
            taskData.title = value;
            break;
          case 'description':
            taskData.description = value;
            break;
          case 'done':
            taskData.done = coerceCSVDone(value);
            break;
          case 'dueDate':
            taskData.dueDate = value;
            break;
          case 'priority':
            taskData.priority = parseCSVIntegerField(value);
            break;
          case 'labels':
            taskData.labels = value
              ? value
                  .split(';')
                  .map((l) => l.trim())
                  .filter((l) => l.length > 0)
              : [];
            logger.debug('Parsed labels from CSV', {
              rawValue: value,
              parsedLabels: taskData.labels,
            });
            break;
          case 'assignees':
            taskData.assignees = value
              ? value
                  .split(';')
                  .map((a) => a.trim())
                  .filter((a) => a.length > 0)
              : [];
            break;
          case 'startDate':
            taskData.startDate = value;
            break;
          case 'endDate':
            taskData.endDate = value;
            break;
          case 'hexColor':
            taskData.hexColor = value;
            break;
          case 'percentDone':
            taskData.percentDone = parseCSVIntegerField(value);
            break;
          case 'repeatAfter':
            taskData.repeatAfter = parseCSVIntegerField(value);
            break;
          case 'repeatMode':
            taskData.repeatMode = parseCSVIntegerField(value);
            break;
        }
      }
    });

    try {
      const validatedTask = importedTaskSchema.parse(taskData);
      tasks.push(validatedTask);
    } catch (error) {
      const cause = error instanceof Error ? error.message : 'Unknown error';
      if (!skipErrors) {
        // Thrown directly to the caller with no other row-numbering context,
        // so this message names the row itself (1-based over the raw file,
        // header included — row 2 is the first data row).
        throw new MCPError(ErrorCode.VALIDATION_ERROR, `Invalid task data at row ${i + 1}: ${cause}`);
      }
      // skipErrors is set: skip this row and continue, but record it so the
      // caller can report it instead of silently losing it (#323). Store just
      // the cause (matching parseJSONInput's shape) rather than re-baking a
      // ROW-file row number in here too — BatchImportResponseFormatter already
      // prefixes every skipped entry with its own "Input row N" (1-based among
      // DATA rows via `index`), and stacking two different row-numbering
      // schemes in one line ("Input row 1: ... at row 2: ...") was confusing.
      // 0-based among data rows: the first data row (line index 1, right
      // after the header) is index 0.
      skipped.push({ index: i - 1, error: cause });
    }
  }

  return { tasks, skipped };
}
