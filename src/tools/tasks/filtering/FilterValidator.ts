/**
 * Filter validation for task filtering operations
 * Handles validation of filter expressions and task listing parameters
 */

import type { components } from '../../../types/generated/vikunja-openapi';
import type {
  FilterCondition,
  FilterExpression,
  FilterGroup,
  ParseResult,
} from '../../../types/filters';
import type {
  TaskListingArgs,
  TaskFilterValidationConfig,
  TaskFilterStorage,
} from '../types/filters';
import type { AuthManager } from '../../../auth/AuthManager';
import { MCPError, ErrorCode } from '../../../types';
import { parseFilterString, expressionToString } from '../../../utils/filters';
import { validateTaskCountLimit } from '../../../utils/memory';
import { resolveLabelIdByTitle } from '../../../utils/label-ensure';
import { logger } from '../../../utils/logger';
import { VALID_SORT_FIELDS, SORT_FIELD_ALIASES } from '../constants';

/** `models.Task` per the OpenAPI spec — sample task for memory estimation. */
type Task = components['schemas']['models.Task'];

const VALID_SORT_FIELD_SET = new Set<string>(VALID_SORT_FIELDS);

/**
 * Normalizes a `sort` argument (comma-separated `sort_by` field list) by
 * translating this tool's camelCase field aliases to the API's snake_case
 * names (`dueDate` -> `due_date`, mirroring `FILTER_FIELD_TO_API_FIELD`),
 * then checks every resulting token against `VALID_SORT_FIELDS`.
 *
 * Without this, an unrecognized `sort_by` value is silently ignored by
 * Vikunja (tasks come back in default order with no error) — exactly the
 * "free-form field selector that silently no-ops" pattern this validation
 * closes, per the field/enum allowlist ergonomics sweep.
 */
function normalizeAndValidateSort(sort: string): { normalized: string; invalidTokens: string[] } {
  const invalidTokens: string[] = [];
  const normalizedTokens = sort.split(',').map((rawToken) => {
    const token = rawToken.trim();
    const apiField = SORT_FIELD_ALIASES[token] ?? token;
    if (!VALID_SORT_FIELD_SET.has(apiField)) {
      invalidTokens.push(token);
    }
    return apiField;
  });
  return { normalized: normalizedTokens.join(','), invalidTokens };
}

/**
 * True for a value that is already a Vikunja label id rather than a title.
 * A boolean or an empty/non-numeric string is a title (or nonsense), never
 * an id — `Number('true')` and `Number('')`'s zero are both rejected here.
 */
function isNumericLabelValue(value: string | number | boolean): boolean {
  const trimmed = String(value).trim();
  return trimmed !== '' && Number.isFinite(Number(trimmed));
}

/**
 * Rewrites every `labels` condition in a parsed filter expression so its
 * values are label **ids**, resolving any title the caller wrote.
 *
 * Why this exists (issue #227). The filter DSL documents `labels in 'HU'` —
 * label titles — but Vikunja's `labels` filter field matches on the label id
 * column and rejects a title outright:
 *
 *   GET /api/v1/tasks?filter=labels in HU
 *   -> 400 {"code":4019,"message":"The task filter value 'HU' for field 'labels' is invalid."}
 *
 * (verified against 2.4.0). So the server-side attempt always failed, the
 * call fell through to the client-side fallback, and the fallback compared
 * `Number('HU')` (NaN) against the task's label ids — matching nothing. The
 * result was `Found 0 tasks`, reported as a clean success, for a label that
 * demonstrably had tasks. Resolving titles to ids HERE — once, before the
 * expression is both serialised for the wire AND handed to the client-side
 * evaluator — fixes both halves with one change.
 *
 * Failure is loud, never a silent empty result: if NONE of the titles in a
 * `labels` condition resolve, the filter cannot be honoured at all and a
 * VALIDATION_ERROR is thrown naming them. If SOME resolve, the condition is
 * still honourable (`in` is a disjunction) so the resolved ids are used and a
 * warning naming the unresolved titles is surfaced in the response metadata.
 *
 * Values that are already numeric are left untouched and cost no API call, so
 * a caller filtering by id never pays for a `GET /labels` round trip — which
 * also means an API token without label read scope only ever hits this path
 * when it genuinely asked to filter by title.
 */
async function resolveLabelTitlesInExpression(
  expression: FilterExpression,
  authManager: AuthManager | undefined,
  warnings: string[],
): Promise<FilterExpression> {
  const mentionsLabelTitle = expression.groups.some((group) =>
    group.conditions.some(
      (condition) =>
        condition.field === 'labels' &&
        (Array.isArray(condition.value)
          ? condition.value.some((v) => !isNumericLabelValue(v))
          : !isNumericLabelValue(condition.value)),
    ),
  );
  if (!mentionsLabelTitle) return expression;

  if (!authManager) {
    // No credentials threaded through (pure-validation call sites). Leave the
    // titles alone rather than pretending they resolved — the client-side
    // evaluator matches label titles as well as ids, so the expression is
    // still evaluable; only the server-side spelling would be wrong, and
    // callers without an authManager never issue a server-side request.
    return expression;
  }

  // One lookup per distinct title, not per occurrence.
  const cache = new Map<string, number | undefined>();
  const resolve = async (title: string): Promise<number | undefined> => {
    const key = title.trim().toLowerCase();
    if (cache.has(key)) return cache.get(key);
    let id: number | undefined;
    try {
      id = await resolveLabelIdByTitle(authManager, title.trim());
    } catch (error) {
      // A lookup that fails (403 from a scope-limited API token, network
      // error, ...) must not be mistaken for "no such label" — that is
      // exactly the silent-wrong-answer this fix removes.
      throw new MCPError(
        ErrorCode.API_ERROR,
        `Could not resolve label title '${title}' used in the filter: ` +
          `${error instanceof Error ? error.message : String(error)}. ` +
          'Filter by numeric label id to avoid the lookup, or grant the token read access to labels.',
      );
    }
    cache.set(key, id);
    return id;
  };

  const unresolvedAll: string[] = [];

  const groups: FilterGroup[] = [];
  for (const group of expression.groups) {
    const conditions: FilterCondition[] = [];
    for (const condition of group.conditions) {
      if (condition.field !== 'labels') {
        conditions.push(condition);
        continue;
      }

      const rawValues: Array<string | number | boolean> = Array.isArray(condition.value)
        ? condition.value
        : [condition.value];

      const resolved: Array<string | number> = [];
      const unresolved: string[] = [];
      for (const raw of rawValues) {
        if (isNumericLabelValue(raw)) {
          resolved.push(Number(raw));
          continue;
        }
        const title = String(raw);
        const id = await resolve(title);
        if (id === undefined) {
          unresolved.push(title);
        } else {
          resolved.push(id);
        }
      }

      if (resolved.length === 0) {
        throw new MCPError(
          ErrorCode.VALIDATION_ERROR,
          `Label filter cannot be honoured: no label exists with ` +
            `${unresolved.length === 1 ? 'the title' : 'any of the titles'} ` +
            `${unresolved.map((t) => `'${t}'`).join(', ')}. ` +
            'Use vikunja_labels list to see available labels, or filter by numeric label id. ' +
            'Refusing to return an empty result set that would be indistinguishable from "no tasks match".',
        );
      }

      if (unresolved.length > 0) {
        unresolvedAll.push(...unresolved);
      }

      conditions.push({
        ...condition,
        value: (Array.isArray(condition.value)
          ? resolved.map(String)
          : resolved[0]) as unknown as (typeof condition)['value'],
      });
    }
    groups.push({ ...group, conditions });
  }

  if (unresolvedAll.length > 0) {
    warnings.push(
      `Label filter partially resolved: no label exists with ${unresolvedAll
        .map((t) => `'${t}'`)
        .join(', ')}; those titles were dropped from the filter.`,
    );
  }

  return { ...expression, groups };
}

/**
 * Validates filter parameters for task listing operations
 */
export const FilterValidator = {
  /**
   * Validates and processes filter string or filter ID
   */
  async validateAndParseFilter(
    args: TaskListingArgs,
    storage: TaskFilterStorage,
    authManager?: AuthManager,
  ): Promise<{
    filterExpression: FilterExpression | null;
    filterString: string | undefined;
    validationWarnings: string[];
  }> {
    let filterExpression: FilterExpression | null = null;
    let filterString: string | undefined;
    const validationWarnings: string[] = [];

    try {
      // Resolve the user-supplied filter - either a direct filter string or a
      // saved filter referenced by id.
      let userFilter: string | undefined;
      if (args.filterId) {
        const savedFilter = await storage.get(args.filterId);
        if (!savedFilter) {
          throw new MCPError(
            ErrorCode.VALIDATION_ERROR,
            `Filter with id ${args.filterId} not found`,
          );
        }
        userFilter = savedFilter.filter;
      } else if (args.filter !== undefined) {
        userFilter = args.filter;
      }

      // Parse the user-supplied filter into an expression.
      if (userFilter) {
        const parseResult: ParseResult = parseFilterString(userFilter);
        if (parseResult.error) {
          throw new MCPError(
            ErrorCode.VALIDATION_ERROR,
            `Invalid filter syntax: ${parseResult.error.message}${parseResult.error.context ? `\n${parseResult.error.context}` : ''}`,
          );
        }
        filterExpression = parseResult.expression;
      }

      // Fold the `done` flag into the filter expression so it is applied
      // server-side (before pagination) rather than trimming an already
      // paginated page. Without this, `done=false` scattered open tasks
      // unpredictably across raw pages.
      //
      // `doneFoldedIntoExpression` tracks whether that fold happened at the
      // `FilterExpression` level (0- or 1-group case, below) so the
      // multi-group fallback (after serialisation, near `expressionToString`)
      // knows whether it still needs to fold `done` in itself.
      let doneFoldedIntoExpression = false;
      if (args.done !== undefined) {
        const doneGroup: FilterGroup = {
          conditions: [{ field: 'done', operator: '=', value: args.done }],
          operator: '&&',
        };
        if (!filterExpression) {
          filterExpression = { groups: [doneGroup] };
          doneFoldedIntoExpression = true;
        } else if (filterExpression.groups.length === 1) {
          // Single user group: AND `done` on as a second group. The user's
          // group is parenthesised when serialised, so its own &&/|| operator
          // is preserved.
          filterExpression = {
            groups: [...filterExpression.groups, doneGroup],
            operator: '&&',
          };
          doneFoldedIntoExpression = true;
        }
        // Multi-group user filter (2+ top-level groups, only reachable via
        // explicit parens like `(a && b) || (c && d)`): NOT folded here,
        // because `FilterExpression` has a single top-level operator shared
        // across every group, so naively appending a third group here would
        // silently change `(a) || (b)`'s semantics to `(a) || (b) && done`.
        // Folded onto the SERIALIZED string instead, below, by wrapping the
        // whole thing in one set of parens before ANDing `done` on — see
        // the `!doneFoldedIntoExpression` block near `expressionToString`.
        // Previously this case was left to
        // `FilterExecutor.applyPostProcessingFilters` alone, which ran on a
        // possibly page-clamped result (issue #268 / CRIT-7's compounding
        // case) — that post-filter still runs too, but is now redundant
        // rather than load-bearing for this case.
      }

      // Serialise the final expression for Vikunja's server-side `filter`
      // query param. ALWAYS re-serialise through expressionToString, rather
      // than passing a raw user-supplied filter string straight through: a
      // caller-supplied camelCase field name (e.g. `dueDate`) is only
      // translated to the API's snake_case Task field (`due_date`) by this
      // serialisation step (via FILTER_FIELD_TO_API_FIELD). Passing the raw
      // string verbatim - the previous behaviour when `done` was undefined -
      // sent untranslated camelCase field names straight to Vikunja, which
      // doesn't recognize them as Task columns; the server then either
      // errors (tripping HybridFilteringStrategy's client-side fallback -
      // correct results, but silently paying the client-side-filtering cost
      // on every such call) or ignores the condition outright. Re-serialising
      // unconditionally closes that gap so server-side filtering actually
      // works for the fields it should.
      //
      // This does change the exact surface syntax of what reaches the API
      // in some cases versus the caller's original string: `expressionToString`
      // parenthesises any group with more than one condition (even if the
      // caller didn't write parens), always double-quotes `like` values
      // (even if the caller single-quoted or left them bare), and normalizes
      // `in`/`not in` array spacing (`1,2` -> `1, 2`). All three are
      // semantics-preserving re-formattings of the same SQL-like grammar the
      // API already accepts (see tests/tools/tasks-filter-sql-syntax.test.ts
      // and the round-trip property tests in tests/utils/filters.test.ts),
      // so this is a safe, deliberate behavior change, not a regression.
      // Rewrite label TITLES to label ids before anything downstream sees the
      // expression — both the wire `filter` string built below AND the
      // client-side evaluator run off this same object (issue #227).
      if (filterExpression) {
        filterExpression = await resolveLabelTitlesInExpression(
          filterExpression,
          authManager,
          validationWarnings,
        );
      }

      if (filterExpression) {
        filterString = expressionToString(filterExpression);
      }

      // Multi-group case deferred from the fold above: AND `done` onto the
      // fully-serialized string, wrapped in its own parens so it correctly
      // applies to the WHOLE expression regardless of the expression's own
      // top-level &&/|| operator.
      if (args.done !== undefined && !doneFoldedIntoExpression && filterString) {
        filterString = `(${filterString}) && done = ${args.done}`;
      }

      if (filterString) {
        // Log that we're preparing to attempt hybrid filtering
        logger.info('Preparing hybrid filtering (server-side attempt + client-side fallback)', {
          filter: filterString,
        });
      }

      return { filterExpression, filterString, validationWarnings };
    } catch (error) {
      if (error instanceof MCPError) {
        throw error;
      }
      throw new MCPError(
        ErrorCode.VALIDATION_ERROR,
        `Filter validation failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  },

  /**
   * Validates pagination and memory constraints
   */
  validateMemoryConstraints(
    args: TaskListingArgs,
    requestedPageSize: number,
  ): {
    isValid: boolean;
    warnings: string[];
    maxAllowed?: number;
  } {
    const warnings: string[] = [];

    // Validate pagination limits for memory protection with enhanced analysis
    const taskCountValidation = validateTaskCountLimit(
      requestedPageSize,
      undefined,
      args.filter
        ? {
            filterExpression: args.filter,
            operationType: 'list',
          }
        : undefined,
    );

    if (!taskCountValidation.allowed) {
      throw new MCPError(
        ErrorCode.VALIDATION_ERROR,
        `Task count limit exceeded. Requested: ${requestedPageSize}, Max allowed: ${taskCountValidation.maxAllowed}. ` +
          `Estimated memory usage: ${taskCountValidation.estimatedMemoryMB}MB (risk: ${taskCountValidation.riskLevel}). ` +
          'Reduce the perPage parameter, use pagination with smaller page sizes, or apply more specific filters.',
      );
    }

    // Add warnings for large page sizes
    if (requestedPageSize > 500) {
      warnings.push(
        `Large page size (${requestedPageSize}) may impact performance. Consider using smaller pages or more specific filters.`,
      );
    }

    // Include enhanced memory validation warnings
    if (taskCountValidation.warnings.length > 0) {
      warnings.push(...taskCountValidation.warnings);
    }

    return {
      isValid: true,
      warnings,
      maxAllowed: taskCountValidation.maxAllowed,
    };
  },

  /**
   * Validates the actual loaded task count against limits
   */
  validateLoadedTasks(
    actualTaskCount: number,
    sampleTask?: Task,
  ): {
    isValid: boolean;
    warnings: string[];
    shouldThrow: boolean;
    riskLevel?: 'low' | 'medium' | 'high';
    estimatedMemoryMB?: number;
  } {
    const warnings: string[] = [];
    const finalTaskCountValidation = validateTaskCountLimit(actualTaskCount, sampleTask);

    if (!finalTaskCountValidation.allowed) {
      // Log warning but don't fail since tasks are already loaded
      logger.warn('Loaded task count exceeds recommended limits', {
        actualCount: actualTaskCount,
        maxRecommended: finalTaskCountValidation.maxAllowed,
        estimatedMemoryMB: finalTaskCountValidation.estimatedMemoryMB,
        riskLevel: finalTaskCountValidation.riskLevel,
      });

      warnings.push(
        `Loaded ${actualTaskCount} tasks, which exceeds recommended limit of ${finalTaskCountValidation.maxAllowed}. ` +
          `Estimated memory usage: ${finalTaskCountValidation.estimatedMemoryMB}MB (risk: ${finalTaskCountValidation.riskLevel}).`,
      );

      // For extremely large datasets, still enforce hard limits
      if (actualTaskCount > finalTaskCountValidation.maxAllowed * 1.5) {
        return {
          isValid: false,
          warnings,
          shouldThrow: true,
          riskLevel: finalTaskCountValidation.riskLevel,
          estimatedMemoryMB: finalTaskCountValidation.estimatedMemoryMB,
        };
      }
    }

    // Include warnings from enhanced validation
    if (finalTaskCountValidation.warnings.length > 0) {
      warnings.push(...finalTaskCountValidation.warnings);
    }

    return {
      isValid: true,
      warnings,
      shouldThrow: false,
      riskLevel: finalTaskCountValidation.riskLevel,
      estimatedMemoryMB: finalTaskCountValidation.estimatedMemoryMB,
    };
  },

  /**
   * Validates task listing arguments
   */
  validateTaskListingArgs(args: TaskListingArgs): string[] {
    const errors: string[] = [];

    // Validate numeric parameters
    if (args.page !== undefined && (args.page < 1 || !Number.isInteger(args.page))) {
      errors.push('Page number must be a positive integer');
    }

    if (args.perPage !== undefined && (args.perPage < 1 || !Number.isInteger(args.perPage))) {
      errors.push('Per page count must be a positive integer');
    }

    if (args.projectId !== undefined && (args.projectId < 1 || !Number.isInteger(args.projectId))) {
      errors.push('Project ID must be a positive integer');
    }

    // Validate boolean parameters
    if (args.done !== undefined && typeof args.done !== 'boolean') {
      errors.push('Done parameter must be a boolean value');
    }

    // Validate string parameters
    if (args.search !== undefined && typeof args.search !== 'string') {
      errors.push('Search parameter must be a string');
    }

    if (args.sort !== undefined && typeof args.sort !== 'string') {
      errors.push('Sort parameter must be a string');
    } else if (args.sort !== undefined && args.sort.trim() !== '') {
      const { normalized, invalidTokens } = normalizeAndValidateSort(args.sort);
      if (invalidTokens.length > 0) {
        errors.push(
          `Invalid sort field(s): ${invalidTokens.join(', ')}. Valid fields: ${VALID_SORT_FIELDS.join(', ')} ` +
            `(camelCase aliases also accepted: ${Object.keys(SORT_FIELD_ALIASES).join(', ')})`,
        );
      } else {
        // Normalize in place so the corrected (snake_case) value is what
        // actually reaches the API — validation runs before
        // FilterExecutor.prepareQueryParameters reads args.sort.
        args.sort = normalized;
      }
    }

    if (args.filter !== undefined && typeof args.filter !== 'string') {
      errors.push('Filter parameter must be a string');
    }

    if (args.filterId !== undefined && typeof args.filterId !== 'string') {
      errors.push('Filter ID parameter must be a string');
    }

    return errors;
  },

  /**
   * Performs comprehensive validation of task filtering parameters
   */
  async validateTaskFiltering(
    args: TaskListingArgs,
    storage: TaskFilterStorage,
    _config: TaskFilterValidationConfig = {},
    authManager?: AuthManager,
  ): Promise<{
    filterExpression: FilterExpression | null;
    filterString: string | undefined;
    validationWarnings: string[];
    /**
     * The subset of `validationWarnings` produced while resolving the FILTER
     * itself (e.g. a label title that matched no label). Kept separate from
     * the noisy per-call memory/page-size advisories so only the warnings
     * that actually change how the caller should read the result set are
     * surfaced in the response metadata.
     */
    filterWarnings: string[];
    memoryValidation: {
      isValid: boolean;
      warnings: string[];
      maxAllowed?: number;
    };
  }> {
    const allWarnings: string[] = [];

    // Validate basic arguments
    const argValidationErrors = FilterValidator.validateTaskListingArgs(args);
    if (argValidationErrors.length > 0) {
      throw new MCPError(
        ErrorCode.VALIDATION_ERROR,
        `Invalid task listing arguments: ${argValidationErrors.join(', ')}`,
      );
    }

    // Validate and parse filter
    const filterValidation = await FilterValidator.validateAndParseFilter(
      args,
      storage,
      authManager,
    );
    allWarnings.push(...filterValidation.validationWarnings);

    // Validate memory constraints
    const pageSize = args.perPage || 1000; // Default pagination
    const memoryValidation = FilterValidator.validateMemoryConstraints(args, pageSize);
    allWarnings.push(...memoryValidation.warnings);

    return {
      filterExpression: filterValidation.filterExpression,
      filterString: filterValidation.filterString,
      validationWarnings: allWarnings,
      filterWarnings: filterValidation.validationWarnings,
      memoryValidation,
    };
  },
};
