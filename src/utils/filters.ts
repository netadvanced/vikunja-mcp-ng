/**
 * Zod-based filter validation and parsing system
 * Replaces the complex custom tokenizer/parser with secure Zod schemas
 */

import { z } from 'zod';
import { FIELD_TYPES } from '../types/filters';
import type {
  FilterCondition,
  FilterExpression,
  FilterField,
  FilterGroup,
  FilterOperator,
  FilterValidationResult,
  FilterValidationConfig,
  LogicalOperator,
  ParseResult,
  ParseError,
} from '../types/filters';

/**
 * Security constants
 */
const MAX_FILTER_LENGTH = 1000;
const MAX_VALUE_LENGTH = 200;
const ALLOWED_CHARS = /^[\t\n\r\u0020-\u007D\u00C0-\u017F\u4E00-\u9FFF]*$/;

/**
 * Pre-compiled optimized regex patterns for performance and security
 * Using atomic groups, possessive quantifiers, and non-backtracking patterns to prevent ReDoS
 */
const DATE_PATTERNS = {
  // Combined pattern with atomic groups to prevent backtracking
  QUICK_DATE_CHECK: /^(?:(?:\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2})?)|now(?:[+-]\d{1,4}[smhdwMy])?|now\/[smhdwMy])$/,

  // Individual optimized patterns for specific validation
  ISO_DATE: /^\d{4}-\d{2}-\d{2}$/,
  ISO_DATETIME: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
  NOW_LITERAL: /^now$/,
  RELATIVE_DATE: /^now([+-]\d{1,4}[smhdwMy])$/,
  PERIOD_DATE: /^now\/([smhdwMy])$/,

  // Fast rejection patterns - optimized for performance
  SECURITY_REJECTION: [
    /\s/,                           // Any spaces
    /now\+\d+day/,                  // "day" instead of "d"
    /now\/day/,                     // "day" instead of "d"
    /\d{4}\/\d{1}\/\d{1}/,          // Missing leading zeros in YYYY/M/D
    /\d{1}-\d{2}-\d{4}/,            // Wrong order D-MM-YYYY
    /now\+\d+\.\d+[a-z]/,           // Decimal numbers
    /now\+\+/,                      // Double operator
    /now\+-/,                       // Conflicting operators
  ],
} as const;

// Repeated character check for DoS prevention - optimized pattern
const REPEATED_CHAR_PATTERN = /(.)\1{20,}/;

/**
 * Zod schemas for validation
 */
const FilterFieldSchema = z.enum([
  'done', 'priority', 'percentDone', 'dueDate', 'startDate', 'endDate',
  'doneAt', 'project', 'assignees',
  'labels', 'created', 'updated', 'title', 'description'
]);

const FilterOperatorSchema = z.enum([
  '=', '!=', '>', '>=', '<', '<=', 'like', 'LIKE', 'in', 'not in'
]);

const LogicalOperatorSchema = z.enum(['&&', '||']);

const FilterValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.array(z.string()),
  z.array(z.number())
]);

const FilterConditionSchema = z.object({
  field: FilterFieldSchema,
  operator: FilterOperatorSchema,
  value: FilterValueSchema,
}).strict();

const FilterGroupSchema = z.object({
  conditions: z.array(FilterConditionSchema).min(1, 'Group must contain at least one condition'),
  operator: LogicalOperatorSchema.default('&&'),
}).strict();

const FilterExpressionSchema = z.object({
  groups: z.array(FilterGroupSchema).min(1, 'Expression must contain at least one group'),
  operator: LogicalOperatorSchema.optional(),
}).strict();

/**
 * Security validation functions
 */
export const SecurityValidator = {
  /**
   * Validates input string contains only allowed characters
   */
  validateAllowedChars(input: string): boolean {
    return ALLOWED_CHARS.test(input);
  },

  /**
   * Validates filter string length
   */
  validateLength(input: string): { isValid: boolean; error?: string } {
    if (input.length > MAX_FILTER_LENGTH) {
      return {
        isValid: false,
        error: `Filter string too long. Maximum length is ${MAX_FILTER_LENGTH} characters, got ${input.length}`
      };
    }
    return { isValid: true };
  },

  /**
   * Validates individual value length and safety
   */
  validateValue(value: string): { isValid: boolean; error?: string } {
    if (value.length > MAX_VALUE_LENGTH) {
      return {
        isValid: false,
        error: `Value too long. Maximum length is ${MAX_VALUE_LENGTH} characters`
      };
    }
    return { isValid: true };
  }
};

/**
 * Parse state for tracking position during parsing
 */
interface ParseState {
  input: string;
  position: number;
  length: number;
}

/**
 * Create parse error with context
 */
function createParseError(message: string, state: ParseState, contextLength = 20): ParseError {
  const start = Math.max(0, state.position - contextLength);
  const end = Math.min(state.length, state.position + contextLength);
  const prefix = start > 0 ? '...' : '';
  const suffix = end < state.length ? '...' : '';
  const context = state.input.substring(start, end);
  const markerPosition = state.position - start + prefix.length;
  const marker = ' '.repeat(markerPosition) + '^';

  return {
    message,
    position: state.position,
    context: `${prefix}${context}${suffix}\n${marker}`
  };
}

/**
 * Skip whitespace in input
 */
function skipWhitespace(state: ParseState): void {
  while (state.position < state.length && state.input[state.position] !== undefined) {
    const char = state.input[state.position];
    if (char && /\s/.test(char)) {
      state.position++;
    } else {
      break;
    }
  }
}

/**
 * Parse quoted string value. Accepts either `"` or `'` as the quote
 * character (SQL-like filter grammars commonly accept both for string
 * literals) - whichever opens the value is also what closes it; the two
 * are never mixed within a single value. Recognizing `'` as a quote
 * character (not just `"`) matters for round-tripping: without it, a
 * caller-supplied value like `'urgent'` isn't treated as a quoted string at
 * all (single quotes aren't excluded from `parseUnquotedValue`'s character
 * class), so the literal quote characters end up baked into the parsed
 * value - and re-serializing through `conditionToString`/`expressionToString`
 * (which always emits double-quoted `like` values) would then wrap an
 * *already-quoted-looking* string in a second layer of quotes
 * (`"'urgent'"`), corrupting the value instead of just reformatting it.
 *
 * Recognizes two escape sequences: `\<quoteChar>` (a literal quote
 * character of whichever kind opened this value) and `\\` (a literal
 * backslash) - both are the escape-side counterpart of
 * `escapeDoubleQuotedValue`'s `\\` -> `\\\\` / `"` -> `\"` substitutions, so
 * a value round-tripped through `conditionToString`/`conditionToDslString`
 * and back through this function comes out byte-for-byte identical. Any
 * other backslash (not followed by the quote char or another backslash) is
 * kept as a literal backslash.
 */
function parseQuotedString(state: ParseState): string | null {
  const quoteChar = state.input[state.position];
  if (state.position >= state.length || (quoteChar !== '"' && quoteChar !== "'")) {
    return null;
  }

  state.position++; // Skip opening quote

  let value = '';
  while (state.position < state.length && state.input[state.position] !== quoteChar) {
    const char = state.input[state.position];
    const nextChar = state.position + 1 < state.length ? state.input[state.position + 1] : undefined;

    // Handle escaped quotes/backslashes (of the same quote character that
    // opened this value, or a literal backslash).
    if (char === '\\' && (nextChar === quoteChar || nextChar === '\\')) {
      value += nextChar;
      state.position += 2;
    } else if (char !== undefined) {
      value += char;
      state.position++;
    }

    // Prevent extremely long quoted values
    if (value.length > MAX_VALUE_LENGTH) {
      return null;
    }
  }

  if (state.position >= state.length) {
    return null; // Unclosed quote
  }

  state.position++; // Skip closing quote
  return value;
}

/**
 * Parse unquoted value
 */
function parseUnquotedValue(state: ParseState): string | null {
  const start = state.position;

  while (
    state.position < state.length &&
    state.input[state.position] !== undefined
  ) {
    const char = state.input[state.position];
    if (char && /[^\s(),=!<>&|]/.test(char)) {
      state.position++;
    } else {
      break;
    }
  }

  if (start === state.position) {
    return null;
  }

  return state.input.substring(start, state.position);
}

/**
 * Parse a value (quoted or unquoted)
 */
function parseValue(state: ParseState): string | null {
  const quoted = parseQuotedString(state);
  if (quoted !== null) {
    return quoted;
  }

  return parseUnquotedValue(state);
}

/**
 * Parse operator token
 */
function parseOperator(state: ParseState): FilterOperator | null {
  const operators = ['>=', '<=', '!=', '>', '<', '=', 'like', 'in', 'not in'];
  for (const op of operators.sort((a, b) => b.length - a.length)) {
    const substr = state.input.substring(state.position, state.position + op.length);
    if (substr.toLowerCase() === op.toLowerCase()) {
      state.position += op.length;
      // Preserve original case
      return substr as FilterOperator;
    }
  }

  return null;
}

/**
 * Snake_case aliases for the filter DSL's canonical camelCase field names,
 * accepted at parse time and normalized to their canonical form before the
 * rest of the pipeline ever sees them. This is the *input-side* counterpart
 * to `FILTER_FIELD_TO_API_FIELD` below (which translates the other
 * direction, canonical DSL -> API query param, for the outgoing server-side
 * `filter` string): the underlying Vikunja Task JSON field names are
 * snake_case (`due_date`, `percent_done`, ...), so agents composing a
 * filter string reach for that spelling first even though this DSL's
 * canonical, documented, and error-message-advertised spelling is camelCase
 * (`dueDate`). Accepting both kills that friction rather than just
 * documenting around it (battle-testing finding: filter grammar casing
 * mismatch - agent tried `due_date`, was rejected twice, only succeeded
 * after switching to `dueDate`).
 *
 * Fields not listed here are already spelled identically in both casings
 * (`done`, `priority`, `assignees`, `labels`, `created`, `updated`, `title`,
 * `description`) and need no alias entry.
 */
export const FILTER_FIELD_ALIASES: Readonly<Record<string, FilterField>> = {
  percent_done: 'percentDone',
  due_date: 'dueDate',
  start_date: 'startDate',
  end_date: 'endDate',
  done_at: 'doneAt',
  project_id: 'project',
};

/**
 * Every token `parseField` will recognize - canonical camelCase field names
 * plus their snake_case aliases - sorted longest-first so a longer token is
 * never shadowed by a shorter prefix of itself (e.g. `doneAt`/`done_at`
 * before `done`, `project_id` before `project`). Computed once at module
 * load rather than per-call.
 */
const FIELD_TOKEN_CANDIDATES: ReadonlyArray<{ token: string; field: FilterField }> = [
  ...(Object.keys(FIELD_TYPES) as FilterField[]).map((field) => ({ token: field as string, field })),
  ...Object.entries(FILTER_FIELD_ALIASES).map(([token, field]) => ({ token, field })),
].sort((a, b) => b.token.length - a.token.length);

/**
 * Appended to "Expected condition"-class parse errors (the ones raised when
 * a field name wasn't recognized at all - see `parseCondition`/`parseGroup`)
 * so a genuinely invalid/misspelled field name gets an actionable,
 * casing-consistent hint instead of a bare "Expected condition". Lists the
 * canonical camelCase spellings only - the snake_case aliases are mentioned
 * separately so the primary, error-message-advertised casing stays
 * unambiguous.
 */
const FIELD_NAME_HINT = `Valid fields (camelCase): ${(Object.keys(FIELD_TYPES) as FilterField[]).join(', ')}. Snake_case aliases (e.g. due_date, percent_done, project_id) are also accepted and normalized.`;

/**
 * Parse field name
 */
function parseField(state: ParseState): FilterField | null {
  // Word-boundary substring match against every recognized token (canonical
  // camelCase names and their snake_case aliases, see FIELD_TOKEN_CANDIDATES
  // above). Alias tokens resolve to their canonical camelCase FilterField,
  // so everything downstream (convertValue, validateFilterExpression,
  // expressionToString/expressionToDslString) only ever sees canonical
  // field names - snake_case input is a pure convenience at the parsing
  // boundary, never a second internal representation.
  for (const { token, field } of FIELD_TOKEN_CANDIDATES) {
    const substr = state.input.substring(state.position, state.position + token.length);
    if (substr === token &&
        (state.position + token.length >= state.length ||
         /[\s=!<>]/.test(state.input[state.position + token.length] || ''))) {
      state.position += token.length;
      return field;
    }
  }

  return null;
}

/**
 * Parse logical operator
 */
function parseLogicalOperator(state: ParseState): LogicalOperator | null {
  if (state.input.substring(state.position, state.position + 2) === '&&') {
    state.position += 2;
    return '&&';
  }
  if (state.input.substring(state.position, state.position + 2) === '||') {
    state.position += 2;
    return '||';
  }
  return null;
}

/**
 * Parse comma-separated values for IN/NOT IN operators
 */
function parseArrayValues(state: ParseState): string[] | null {
  const values: string[] = [];

  const firstValue = parseValue(state);
  if (firstValue === null) {
    return null;
  }
  values.push(firstValue);

  while (state.position < state.length) {
    skipWhitespace(state);

    if (state.position >= state.length || state.input[state.position] !== ',') {
      break;
    }

    state.position++; // Skip comma
    skipWhitespace(state);

    const nextValue = parseValue(state);
    if (nextValue === null) {
      return null;
    }
    values.push(nextValue);
  }

  return values;
}

/**
 * Convert string value to appropriate type based on field
 */
function convertValue(value: string, field: FilterField, operator: FilterOperator): string | number | boolean | string[] {
  if (operator === 'in' || operator === 'not in') {
    return value.split(',').map(v => v.trim());
  }

  const fieldType = {
    done: 'boolean',
    priority: 'number',
    percentDone: 'number',
    dueDate: 'date',
    startDate: 'date',
    endDate: 'date',
    doneAt: 'date',
    project: 'number',
    assignees: 'array',
    labels: 'array',
    created: 'date',
    updated: 'date',
    title: 'string',
    description: 'string',
  }[field];

  if (fieldType === 'boolean') {
    return value === 'true';
  } else if (fieldType === 'number') {
    const num = Number(value);
    if (isNaN(num)) {
      throw new Error(`Invalid number: ${value}`);
    }
    return num;
  }

  return value;
}

/**
 * Parse a single condition
 */
function parseCondition(state: ParseState): FilterCondition | null {
  const field = parseField(state);
  if (field === null) {
    return null;
  }

  skipWhitespace(state);
  const operator = parseOperator(state);
  if (operator === null) {
    throw new Error('Expected operator');
  }

  skipWhitespace(state);
  let rawValue: string | string[];

  if (operator === 'in' || operator === 'not in') {
    const values = parseArrayValues(state);
    if (values === null) {
      throw new Error('Expected value(s) for IN/NOT IN operator');
    }
    rawValue = values.join(',');
  } else {
    const value = parseValue(state);
    if (value === null) {
      throw new Error('Expected value');
    }
    rawValue = value;
  }

  try {
    const convertedValue = convertValue(rawValue, field, operator);
    return { field, operator, value: convertedValue };
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : 'Invalid value');
  }
}

/**
 * Parse a group (conditions optionally in parentheses)
 */
function parseGroup(state: ParseState): FilterGroup {
  const conditions: FilterCondition[] = [];
  let operator: LogicalOperator = '&&';
  let hasParens = false;

  skipWhitespace(state);

  if (state.position < state.length && state.input[state.position] === '(') {
    hasParens = true;
    state.position++; // Skip opening parenthesis
    skipWhitespace(state);
  }

  // Parse first condition
  const firstCondition = parseCondition(state);
  if (firstCondition === null) {
    throw new Error(`Expected condition. ${FIELD_NAME_HINT}`);
  }
  conditions.push(firstCondition);

  skipWhitespace(state);

  // Parse additional conditions with logical operators
  while (state.position < state.length) {
    // Check for closing parenthesis
    if (hasParens && state.position < state.length && state.input[state.position] === ')') {
      state.position++;
      break;
    }

    // Check for logical operator
    const logicalOp = parseLogicalOperator(state);
    if (logicalOp === null) {
      break;
    }

    operator = logicalOp;
    skipWhitespace(state);

    // Parse next condition
    const nextCondition = parseCondition(state);
    if (nextCondition === null) {
      throw new Error(`Expected condition after logical operator. ${FIELD_NAME_HINT}`);
    }
    conditions.push(nextCondition);

    skipWhitespace(state);
  }

  // If we had parentheses but didn't find closing one, it's an error
  if (hasParens && state.position <= state.length && state.input[state.position - 1] !== ')') {
    throw new Error('Expected closing parenthesis');
  }

  return { conditions, operator };
}

/**
 * Parse complete filter expression
 */
function parseExpression(state: ParseState): FilterExpression {
  const groups: FilterGroup[] = [];
  let groupOperator: LogicalOperator | undefined;

  // Parse first group
  const firstGroup = parseGroup(state);
  groups.push(firstGroup);

  skipWhitespace(state);

  // Parse additional groups with logical operators
  while (state.position < state.length) {
    const logicalOp = parseLogicalOperator(state);
    if (logicalOp === null) {
      break;
    }

    if (!groupOperator) {
      groupOperator = logicalOp;
    }

    skipWhitespace(state);
    const nextGroup = parseGroup(state);
    groups.push(nextGroup);

    skipWhitespace(state);
  }

  const expression = groupOperator
    ? { groups, operator: groupOperator } as FilterExpression
    : { groups } as FilterExpression;

  return expression;
}

/**
 * Main filter string parsing function
 * Replaces the complex tokenizer/parser system with Zod validation
 */
export function parseFilterString(filterStr: string): ParseResult {
  // Input validation
  if (typeof filterStr !== 'string') {
    return {
      expression: null,
      error: {
        message: 'Filter input must be a string',
        position: 0,
      },
    };
  }

  if (!filterStr || filterStr.trim().length === 0) {
    return {
      expression: null,
      error: {
        message: 'Filter string cannot be empty',
        position: 0,
      },
    };
  }

  // Security validation
  if (!SecurityValidator.validateAllowedChars(filterStr)) {
    return {
      expression: null,
      error: {
        message: 'Filter string contains invalid characters',
        position: 0,
        context: 'Only alphanumeric characters, common punctuation, and international characters are allowed'
      },
    };
  }

  const lengthValidation = SecurityValidator.validateLength(filterStr);
  if (!lengthValidation.isValid) {
    return {
      expression: null,
      error: {
        message: lengthValidation.error || 'Filter string too long',
        position: 0,
      },
    };
  }

  // Parse the filter string
  const state: ParseState = {
    input: filterStr.trim(),
    position: 0,
    length: filterStr.trim().length
  };

  try {
    const expression = parseExpression(state);

    // Check if we consumed the entire input
    skipWhitespace(state);
    if (state.position < state.length) {
      const remainingChar = state.input[state.position];
      // Handle specific cases that should return "Invalid filter syntax"
      if (remainingChar === '&' || remainingChar === '|' || remainingChar === '!' ||
          remainingChar === '(' || remainingChar === ')') {
        return {
          expression: null,
          error: {
            message: 'Invalid filter syntax',
            position: state.position,
            context: state.input.substring(state.position, Math.min(state.position + 40, state.length))
          }
        };
      }

      return {
        expression: null,
        error: createParseError(`Unexpected token: ${state.input.substring(state.position, Math.min(state.position + 20, state.length))}`, state)
      };
    }

    // Validate with Zod schema
    const validationResult = FilterExpressionSchema.safeParse(expression);
    if (!validationResult.success) {
      return {
        expression: null,
        error: {
          message: 'Invalid filter structure',
          position: 0,
          context: validationResult.error.errors.map(e => e.message).join(', ')
        }
      };
    }

    return { expression: validationResult.data as FilterExpression };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Parse error';

    // Handle specific parsing errors that should return "Invalid filter syntax"
    if (message.includes('Expected value') || message.includes('Unclosed quote')) {
      return {
        expression: null,
        error: {
          message: 'Invalid filter syntax',
          position: state.position,
          context: state.input.substring(Math.max(0, state.position - 20), Math.min(state.position + 20, state.length))
        }
      };
    }

    return {
      expression: null,
      error: createParseError(message, state)
    };
  }
}

/**
 * Enhanced validation with field type checking and value validation
 */
function validateFieldTypeAndValue(field: FilterField, operator: FilterOperator, value: unknown): string[] {
  const errors: string[] = [];
  const FIELD_TYPE_MAP: Record<string, string> = {
    done: 'boolean',
    priority: 'number',
    percentDone: 'number',
    dueDate: 'date',
    startDate: 'date',
    endDate: 'date',
    doneAt: 'date',
    project: 'number',
    assignees: 'array',
    labels: 'array',
    created: 'date',
    updated: 'date',
    title: 'string',
    description: 'string',
  };
  const fieldType = FIELD_TYPE_MAP[field];

  // Basic field validation
  if (!Object.keys(FIELD_TYPE_MAP).includes(field)) {
    return ['Invalid field name'];
  }

  // Operator validation for field types
  if (fieldType === 'boolean' && !['=', '!='].includes(operator)) {
    errors.push(`Invalid operator '${operator}' for boolean field '${field}'. Only = and != are allowed.`);
  }

  if (fieldType === 'array' && !['=', '!=', 'in', 'not in'].includes(operator)) {
    errors.push(`Invalid operator '${operator}' for array field '${field}'. Only =, !=, in, and not in are allowed.`);
  }

  // Value type validation
  if (fieldType === 'boolean') {
    if (typeof value === 'string' && (value === 'true' || value === 'false')) {
      // String boolean values are acceptable
    } else if (typeof value !== 'boolean') {
      errors.push(`Field "${field}" requires a boolean value`);
    }
  }

  if (fieldType === 'number' && (typeof value !== 'number' || isNaN(Number(value)))) {
    errors.push(`Field "${field}" requires a numeric value`);
  }

  if (fieldType === 'array' && !Array.isArray(value) && typeof value !== 'string') {
    errors.push(`Field "${field}" requires an array or comma-separated string`);
  }

  // Date validation (optimized for performance and security)
  if (fieldType === 'date' && typeof value === 'string') {
    // Security check: reject extremely long values that could cause DoS
    if (value.length > 50) {
      errors.push(`Field "${field}" requires a valid date value`);
      return errors;
    }

    // Fast security check: prevent repeated characters that could indicate attacks
    if (REPEATED_CHAR_PATTERN.test(value)) {
      errors.push(`Field "${field}" requires a valid date value`);
      return errors;
    }

    // Fast rejection: check against known invalid patterns first (optimized)
    for (const pattern of DATE_PATTERNS.SECURITY_REJECTION) {
      if (pattern.test(value)) {
        errors.push(`Field "${field}" requires a valid date value`);
        return errors;
      }
    }

    // Quick validation: use combined pattern for fast acceptance (prevents backtracking)
    if (!DATE_PATTERNS.QUICK_DATE_CHECK.test(value)) {
      errors.push(`Field "${field}" requires a valid date value`);
      return errors;
    }

    // Specific validation: only run additional checks if needed
    // This minimizes regex operations for common cases
    if (DATE_PATTERNS.ISO_DATE.test(value)) {
      // Validate actual calendar date only for ISO date format
      const dateMatch = value.match(DATE_PATTERNS.ISO_DATE);
      if (dateMatch) {
        const [yearStr, monthStr, dayStr] = dateMatch[0].split('-');
        if (!yearStr || !monthStr || !dayStr) {
          errors.push(`Field "${field}" requires a valid date in YYYY-MM-DD format`);
          return errors;
        }

        const year = parseInt(yearStr, 10);
        const month = parseInt(monthStr, 10);
        const day = parseInt(dayStr, 10);

        const date = new Date(year, month - 1, day);

        // Check if the date is valid (month and day within bounds)
        if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
          errors.push(`Field "${field}" requires a valid date value`);
          return errors;
        }
      }
    }
    // No additional validation needed for other formats - they were validated by QUICK_DATE_CHECK
  }

  return errors;
}

/**
 * Validate a filter condition using enhanced validation
 */
export function validateCondition(condition: FilterCondition): string[] {
  // Check if condition has valid structure first
  const result = FilterConditionSchema.safeParse(condition);
  if (!result.success) {
    const errors = result.error.errors.map(e => e.message);

    // Convert Zod enum error to more user-friendly message
    if (errors.some(e => e.includes('enum value'))) {
      return ['Invalid field name'];
    }

    return errors;
  }

  const { field, operator, value } = condition;

  // Enhanced field and value validation
  const fieldValidationErrors = validateFieldTypeAndValue(field, operator, value);

  return fieldValidationErrors;
}

/**
 * Validate filter expression using Zod
 */
export function validateFilterExpression(
  expression: FilterExpression,
  config: FilterValidationConfig = {},
): FilterValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Zod schema validation
  const schemaResult = FilterExpressionSchema.safeParse(expression);
  if (!schemaResult.success) {
    errors.push(...schemaResult.error.errors.map(e => e.message));
  }

  // Custom validation
  if (expression.groups) {
    expression.groups.forEach((group, groupIndex) => {
      if (!group.conditions || group.conditions.length === 0) {
        errors.push(`Group ${groupIndex + 1} must contain at least one condition`);
      }

      group.conditions.forEach((condition, conditionIndex) => {
        const conditionErrors = validateCondition(condition);
        conditionErrors.forEach(errorMessage => {
          errors.push(`Group ${groupIndex + 1}, Condition ${conditionIndex + 1}: ${errorMessage}`);
        });
      });
    });

    // Performance warnings
    const totalConditions = expression.groups.reduce(
      (sum, group) => sum + group.conditions.length,
      0,
    );

    const threshold = config.performanceWarningThreshold ?? 10;
    if (totalConditions > threshold) {
      warnings.push(
        `Complex filters with many conditions (${totalConditions}) may impact performance`,
      );
    }
  }

  const result: FilterValidationResult = {
    valid: errors.length === 0,
    errors,
  };

  if (warnings.length > 0) {
    result.warnings = warnings;
  }

  return result;
}

/**
 * Maps the filter DSL's camelCase field names to the Vikunja API's snake_case
 * Task JSON field names, for fields where they differ. Mirrors the mapping
 * `evaluators.ts` uses for client-side evaluation (see the `evaluateCondition`
 * switch in `src/tools/tasks/filtering/evaluators.ts`). Fields not listed here
 * are identical between the DSL and the API (e.g. `done`, `priority`,
 * `assignees`, `labels`, `created`, `updated`, `title`, `description`).
 *
 * Without this translation, the server-side `filter` query string built by
 * `conditionToString`/`expressionToString` sends DSL field names verbatim
 * (e.g. `dueDate`), which the API does not recognize as Task fields
 * (it expects `due_date`).
 */
const FILTER_FIELD_TO_API_FIELD: Partial<Record<FilterField, string>> = {
  percentDone: 'percent_done',
  dueDate: 'due_date',
  startDate: 'start_date',
  endDate: 'end_date',
  doneAt: 'done_at',
  project: 'project_id',
};

/**
 * Escapes backslashes and double quotes in a `like` value before it is
 * wrapped in double quotes for the server-side `filter` string (or the DSL
 * string handed back to a caller). Without this, a value that itself
 * contains a literal `"` (e.g. `she said "hi"`) would produce
 * `"she said "hi""` - a string `parseQuotedString` re-parses as ending at
 * the *first* embedded quote, silently truncating the value. Escaping
 * (`\"`) round-trips correctly because `parseQuotedString` already
 * recognizes and unescapes `\"` when reading a quoted value back in.
 */
function escapeDoubleQuotedValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Convert condition to string representation
 */
export function conditionToString(condition: FilterCondition): string {
  const { field, operator, value } = condition;
  const apiField = FILTER_FIELD_TO_API_FIELD[field] ?? field;

  let valueStr: string;
  if (Array.isArray(value)) {
    valueStr = value.join(', ');
  } else if (typeof value === 'string' && operator === 'like') {
    valueStr = `"${escapeDoubleQuotedValue(value)}"`;
  } else if (typeof value === 'boolean') {
    valueStr = value.toString();
  } else {
    valueStr = String(value);
  }

  if (operator === 'in' || operator === 'not in') {
    return `${apiField} ${operator} ${valueStr}`;
  }

  return `${apiField} ${operator} ${valueStr}`;
}

/**
 * Convert group to string representation
 */
export function groupToString(group: FilterGroup): string {
  const conditions = group.conditions.map(conditionToString);
  return conditions.length > 1
    ? `(${conditions.join(` ${group.operator} `)})`
    : conditions[0] || '';
}

/**
 * Convert expression to string representation
 */
export function expressionToString(expression: FilterExpression): string {
  const groups = expression.groups.map(groupToString);
  const operator = expression.operator || '&&';
  return groups.join(` ${operator} `);
}

/**
 * Convert a single condition to its DSL-casing string representation - i.e.
 * the canonical camelCase field spelling (`dueDate`, never `due_date`) that
 * `parseFilterString`/`parseField` accept as canonical and that every
 * filter-related error message in this codebase advertises. Unlike
 * `conditionToString`, this does NOT apply `FILTER_FIELD_TO_API_FIELD` - it
 * is not for the outgoing server-side `filter` query param, it is for
 * handing a filter string back to a caller so they can paste it straight
 * into another tool's `filter` argument (e.g. `vikunja_tasks list`) without
 * a casing round-trip. See `vikunja_filters build`, whose entire purpose is
 * producing exactly that string.
 */
export function conditionToDslString(condition: FilterCondition): string {
  const { field, operator, value } = condition;

  let valueStr: string;
  if (Array.isArray(value)) {
    valueStr = value.join(', ');
  } else if (typeof value === 'string' && operator === 'like') {
    valueStr = `"${escapeDoubleQuotedValue(value)}"`;
  } else if (typeof value === 'boolean') {
    valueStr = value.toString();
  } else {
    valueStr = String(value);
  }

  return `${field} ${operator} ${valueStr}`;
}

/**
 * Convert group to its DSL-casing string representation. See
 * `conditionToDslString`.
 */
export function groupToDslString(group: FilterGroup): string {
  const conditions = group.conditions.map(conditionToDslString);
  return conditions.length > 1
    ? `(${conditions.join(` ${group.operator} `)})`
    : conditions[0] || '';
}

/**
 * Convert expression to its DSL-casing string representation (canonical
 * camelCase field names throughout). See `conditionToDslString`.
 */
export function expressionToDslString(expression: FilterExpression): string {
  const groups = expression.groups.map(groupToDslString);
  const operator = expression.operator || '&&';
  return groups.join(` ${operator} `);
}

/**
 * Filter builder class for fluent construction
 */
export class FilterBuilder {
  private expression: FilterExpression;
  private currentGroup: FilterGroup;

  constructor() {
    this.currentGroup = {
      conditions: [],
      operator: '&&',
    };
    this.expression = {
      groups: [this.currentGroup],
    };
  }

  where(field: FilterField, operator: FilterOperator, value: unknown): FilterBuilder {
    this.currentGroup.conditions.push({
      field,
      operator,
      value: value as string | number | boolean | string[] | number[],
    });
    return this;
  }

  and(): FilterBuilder {
    this.currentGroup.operator = '&&';
    return this;
  }

  or(): FilterBuilder {
    this.currentGroup.operator = '||';
    return this;
  }

  group(operator: LogicalOperator = '&&'): FilterBuilder {
    this.currentGroup = {
      conditions: [],
      operator,
    };
    this.expression.groups.push(this.currentGroup);
    return this;
  }

  groupOperator(operator: LogicalOperator): FilterBuilder {
    this.expression.operator = operator;
    return this;
  }

  build(): FilterExpression {
    this.expression.groups = this.expression.groups.filter((g) => g.conditions.length > 0);
    return this.expression;
  }

  toString(): string {
    return expressionToString(this.build());
  }

  /**
   * DSL-casing counterpart to `toString()` - canonical camelCase field
   * names throughout (`dueDate`, never `due_date`), suitable for handing
   * straight back to a caller as a `filter` argument for another tool. See
   * `expressionToDslString`/`conditionToDslString`.
   */
  toDslString(): string {
    return expressionToDslString(this.build());
  }

  validate(config?: FilterValidationConfig): FilterValidationResult {
    return validateFilterExpression(this.build(), config);
  }
}