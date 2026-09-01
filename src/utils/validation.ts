/**
 * Comprehensive Input Sanitization and Security Validation Layer
 *
 * Provides enterprise-grade protection against:
 * - XSS attacks (script injection, HTML injection)
 * - SQL injection (UNION, boolean-based, time-based)
 * - Command injection (shell command execution)
 * - Path traversal attacks
 * - LDAP injection
 * - NoSQL injection
 * - Unicode and encoding bypasses
 * - Content Security Policy violations
 *
 * Integration: Works seamlessly with existing security.ts credential masking
 */

import { z } from 'zod';
import type {
  FilterExpression,
  FilterField,
  FilterOperator,
  LogicalOperator,
} from '../types/filters';
import { MCPError, ErrorCode } from '../types/errors';

/**
 * Maximum allowed nesting depth for filter expressions (prevents DoS)
 */
const MAX_NESTING_DEPTH = 10;

/**
 * Maximum allowed number of conditions per expression (prevents DoS)
 */
const MAX_CONDITIONS = 50;

/**
 * Maximum string length for filter values (prevents storage bloat)
 */
const MAX_STRING_LENGTH = 1000;

/**
 * Zod schemas for type-safe validation
 */
const FieldSchema: z.ZodType<FilterField> = z.enum([
  'done',
  'priority',
  'percentDone',
  'dueDate',
  'startDate',
  'endDate',
  'doneAt',
  'project',
  'assignees',
  'labels',
  'created',
  'updated',
  'title',
  'description',
]);

const OperatorSchema: z.ZodType<FilterOperator> = z.enum([
  '=',
  '!=',
  '>',
  '>=',
  '<',
  '<=',
  'like',
  'in',
  'not in',
]);

const LogicalOperatorSchema: z.ZodType<LogicalOperator> = z.enum(['&&', '||']);

/**
 * Server-appropriate security validation patterns
 * Created fresh each call to avoid regex state issues
 */

/**
 * Allowed characters for additional strictness (optional, can be relaxed)
 */

/**
 * Validate and sanitize a string value to prevent XSS using pattern matching + HTML escaping
 * Server-appropriate approach that avoids DOM parsing while providing comprehensive protection
 *
 * @param value - The string to validate/sanitize
 * @param fieldName - Optional field name (e.g. `'description'`, `'subtasks[2].title'`), included
 * in the thrown error so a caller isn't stuck guessing which field/argument was rejected
 * (see issue #226: the bare "String contains potentially dangerous content" message named
 * neither the field nor the offending pattern/substring).
 */
export function sanitizeString(value: string, fieldName?: string): string {
  if (typeof value !== 'string') {
    throw new MCPError(
      ErrorCode.VALIDATION_ERROR,
      fieldName ? `${fieldName}: value must be a string` : 'Value must be a string',
    );
  }

  if (value.length > MAX_STRING_LENGTH) {
    throw new MCPError(
      ErrorCode.VALIDATION_ERROR,
      `${fieldName ? `${fieldName}: ` : ''}String value exceeds maximum length of ${MAX_STRING_LENGTH}`,
    );
  }

  // Step 1: Check for dangerous HTML/JavaScript patterns and REJECT them (don't sanitize)
  // Convert to lowercase for case-insensitive pattern matching
  const lowerValue = value.toLowerCase();

  // Create fresh patterns each time to avoid regex state issues.
  // Each entry is [human-readable label, pattern] so a rejection can name which rule
  // fired and what it matched, instead of the previous unhelpful blanket message.
  const dangerousPatterns: Array<[string, RegExp]> = [
    // Enhanced XSS patterns - comprehensive script and injection detection
    ['script tag', /<script[^>]*>/gi],
    ['closing script tag', /<\/script>/gi],
    ['iframe tag', /<iframe[^>]*>/gi],
    ['closing iframe tag', /<\/iframe>/gi],
    ['object tag', /<object[^>]*>/gi],
    ['closing object tag', /<\/object>/gi],
    ['embed tag', /<embed[^>]*>/gi],
    ['link tag', /<link[^>]*>/gi],
    ['meta tag', /<meta[^>]*>/gi],
    ['svg tag', /<svg[^>]*>/gi],
    ['closing svg tag', /<\/svg>/gi],
    ['style tag', /<style[^>]*>/gi],
    ['closing style tag', /<\/style>/gi],
    ['img tag with event handler', /<img[^>]*on[^>]*>/gi],
    ['div tag with event handler', /<div[^>]*on[^>]*>/gi],
    ['anchor tag with event handler', /<a[^>]*on[^>]*>/gi],
    ['body tag with event handler', /<body[^>]*on[^>]*>/gi],
    ['form tag with event handler', /<form[^>]*on[^>]*>/gi],
    ['input tag with event handler', /<input[^>]*on[^>]*>/gi],
    ['button tag with event handler', /<button[^>]*on[^>]*>/gi],
    ['select tag with event handler', /<select[^>]*on[^>]*>/gi],
    ['textarea tag with event handler', /<textarea[^>]*on[^>]*>/gi],

    // Event handlers with attributes (more specific to avoid false positives)
    ['event handler attribute (onXXX="...")', /on\w+\s*=\s*["'][^"']*["']/gi],
    ['event handler keyword (onclick)', /onclick/gi],
    ['event handler keyword (onload)', /onload/gi],
    ['event handler keyword (onerror)', /onerror/gi],
    ['event handler keyword (onmouseover)', /onmouseover/gi],
    ['event handler keyword (onmouseout)', /onmouseout/gi],
    ['event handler keyword (onmousedown)', /onmousedown/gi],
    ['event handler keyword (onmouseup)', /onmouseup/gi],
    ['event handler keyword (onkeydown)', /onkeydown/gi],
    ['event handler keyword (onkeyup)', /onkeyup/gi],
    ['event handler keyword (onkeypress)', /onkeypress/gi],
    ['event handler keyword (onfocus)', /onfocus/gi],
    ['event handler keyword (onblur)', /onblur/gi],
    ['event handler keyword (onchange)', /onchange/gi],
    ['event handler keyword (onsubmit)', /onsubmit/gi],
    ['event handler keyword (onreset)', /onreset/gi],
    ['event handler keyword (onselect)', /onselect/gi],
    ['event handler keyword (onunload)', /onunload/gi],
    ['event handler keyword (onabort)', /onabort/gi],
    ['event handler keyword (oncanplay)', /oncanplay/gi],
    ['event handler keyword (oncanplaythrough)', /oncanplaythrough/gi],
    ['event handler keyword (oncuechange)', /oncuechange/gi],
    ['event handler keyword (ondurationchange)', /ondurationchange/gi],
    ['event handler keyword (onemptied)', /onemptied/gi],
    ['event handler keyword (onended)', /onended/gi],
    ['event handler keyword (onloadeddata)', /onloadeddata/gi],
    ['event handler keyword (onloadedmetadata)', /onloadedmetadata/gi],
    ['event handler keyword (onloadstart)', /onloadstart/gi],
    ['event handler keyword (onpause)', /onpause/gi],
    ['event handler keyword (onplay)', /onplay/gi],
    ['event handler keyword (onplaying)', /onplaying/gi],
    ['event handler keyword (onprogress)', /onprogress/gi],
    ['event handler keyword (onratechange)', /onratechange/gi],
    ['event handler keyword (onseeked)', /onseeked/gi],
    ['event handler keyword (onseeking)', /onseeking/gi],
    ['event handler keyword (onstalled)', /onstalled/gi],
    ['event handler keyword (onsuspend)', /onsuspend/gi],
    ['event handler keyword (ontimeupdate)', /ontimeupdate/gi],
    ['event handler keyword (onvolumechange)', /onvolumechange/gi],
    ['event handler keyword (onwaiting)', /onwaiting/gi],

    // Dangerous protocols and schemes
    ['javascript: protocol', /javascript:/gi],
    ['vbscript: protocol', /vbscript:/gi],
    ['data:text/html URI', /data:text\/html/gi],
    ['data:application/javascript URI', /data:application\/javascript/gi],
    ['data:text/javascript URI', /data:text\/javascript/gi],
    ['data:text/vbscript URI', /data:text\/vbscript/gi],
    ['data:application/x-javascript URI', /data:application\/x-javascript/gi],

    // CSS-based attacks
    ['CSS expression()', /expression\s*\(/gi],
    ['CSS @import', /@import/gi],
    ['CSS url()', /url\s*\(/gi],
    ['CSS binding:', /binding\s*:/gi],
    ['CSS behavior:', /behavior\s*:/gi],
    ['CSS -moz-binding:', /-moz-binding\s*:/gi],
    ['CSS -o-link:', /-o-link\s*:/gi],
    ['CSS -webkit-binding:', /-webkit-binding\s*:/gi],

    // SQL injection patterns (narrow: only flag time-delay/blind injection, not plain English
    // words). Kept as defense-in-depth for callers that feed sanitizeString into a filter/query
    // string (see validateValue/sanitizeObjectStrings below) even though this codebase never
    // interpolates these strings into raw SQL (direct REST calls only, see
    // docs/ENDPOINT-PLAYBOOK.md) — see issue #226 for the false-positive this class of pattern
    // can cause on free text, and why the actual bug there was a different pattern (the removed
    // unanchored `on\w+...=` rule below), not this one.
    ['time-delay/blind SQL injection keyword', /(\b(WAITFOR\s+DELAY|SLEEP\s*\(|BENCHMARK\s*\(|DBMS_PIPE\.RECEIVE_MESSAGE)\b)/gi],
    ['SQL Server extended procedure (XP_/SP_)', /(\b(XP_|SP_)\w+)/gi],
    // Boolean-based blind SQL injection (e.g. `' OR '1'='1`). Requires a quote immediately
    // after OR/AND plus an `=` comparison, so it doesn't false-positive on ordinary English
    // like "Fix bug or issue" or "Cost or budget = 500" (no quote follows OR/AND there).
    ['boolean-based blind SQL injection (OR/AND \'x\'=\'y)', /(\b(OR|AND)\b\s*["'][^"']*["']?\s*=\s*["']?[^"']*["']?)/gi],

    // HTML comments (XSS vector regardless of context)
    ['HTML comment', /<!--/gi],

    // Command injection patterns (more specific to avoid false positives)
    // The broad shell-metacharacter blocklist (`;&|`$(){}[]\'"*?<>~`) was removed because it
    // rejected any string containing a bare quote or angle bracket. Generic, non-scripting
    // HTML-like text (e.g. `<div class="x">`) is passed through unmodified: this boundary is a
    // JSON API call, not an HTML render, so there is nothing to escape (see f2b0b93, which
    // removed render-time HTML-escaping here for the same reason). Only constructs with actual
    // scripting/DOM-execution vectors (script/iframe/style/svg tags, event handlers, dangerous
    // protocols, etc.) are rejected above.
    ['shell command keyword (wget/curl/nc/...)', /(\b(wget|curl|nc|netcat|telnet|ssh|ftp|sftp)\b)/gi],
    ['destructive shell command (rm -rf/del/format/...)', /(rm\s+-rf|del\s+\/s|format|fdisk|mkfs)/gi],
    ['shell redirect/pipe operator', /(>\s*\/dev\/null|2>&1|\|\|)/gi],
    ['shell command substitution ($(...) or `...`)', /(\$\([^)]*\)|`[^`]*`)/gi],

    // Path traversal patterns
    ['path traversal (../)', /(\.\.[/\\])/gi],
    ['URL-encoded path traversal (%2e%2e/)', /(%2e%2e[/\\])/gi],
    ['URL-encoded path traversal (%2e%2e%2f)', /(%2e%2e%2f)/gi],
    ['URL-encoded path traversal (%2e%2e%5c)', /(%2e%2e%5c)/gi],
    ['sensitive system file path (/etc/passwd, ...)', /(\/etc\/passwd|\/etc\/shadow|\/proc\/)/gi],
    ['Windows system path traversal', /(c:\\\\windows\\\\system32|\\\\..\\\\)/gi],

    // LDAP injection patterns
    ['LDAP injection (*)(...)', /(\*\)\([&*)]*)/gi],
    ['LDAP injection (*...*)', /(\*\)([^)]*\*)*)/gi],
    ['LDAP injection (|(...))', /(\|\()([^)]*)(\)\|)/gi],
    ['LDAP injection (!(...))', /(!\()([^)]*)(\))/gi],

    // NoSQL injection patterns. The optional `["']?` before the colon covers both the raw
    // `$gt:` form and the quoted-JSON-key form (`"$gt":`) produced by e.g. JSON.stringify.
    ['MongoDB operator ($gt/$lt/...)', /(\$\w+\s*["']?\s*:)/gi],
    ['MongoDB $where operator', /(\{\s*["']?\$where\s*["']?\s*:)/gi],
    ['MongoDB $ne operator', /(\{\s*["']?\$ne\s*["']?\s*:)/gi],
    ['MongoDB $gt operator', /(\{\s*["']?\$gt\s*["']?\s*:)/gi],
    ['MongoDB $regex operator', /(\{\s*["']?\$regex\s*["']?\s*:)/gi],

    // HTML5 dangerous attributes
    ['HTML5 formaction attribute', /formaction\s*=/gi],
    ['HTML5 poster attribute', /poster\s*=/gi],
    ['HTML5 autofocus attribute', /autofocus\s*=/gi],
    ['HTML5 controls attribute', /controls\s*=/gi],
    ['HTML5 autoplay attribute', /autoplay\s*=/gi],
    ['HTML5 loop attribute', /loop\s*=/gi],
    ['HTML5 muted attribute', /muted\s*=/gi],

    // Unicode and encoding bypass attempts
    ['zero-width/invisible Unicode character', /[\u200b-\u200f\u2060\u180e\ufeff]/g],
    ['Unicode variation selector', /[\uFE00-\uFE0F]/g],
    ['Unicode escape sequence (\\uXXXX)', /\\u[0-9a-fA-F]{4}/g],
    ['hex escape sequence (\\xXX)', /\\x[0-9a-fA-F]{2}/g],

    // Prototype pollution patterns
    ['prototype pollution keyword (__proto__/constructor/prototype)', /(__proto__|constructor|prototype)/gi],

    // Content Security Policy violations
    ['CSP-violating function call (eval/Function/setTimeout/...)', /(base64|atob|btoa|eval|Function|setTimeout|setInterval)\s*\(/gi],
    ['DOM write/navigation call (document.write/window.open/...)', /(document\.(write|writeln|open|close)|window\.(open|location|navigate))/gi],

    // HTML-encoded dangerous content (prevent XSS through encoded vectors). These are all
    // anchored to the `&lt;...&gt;` entity-encoded tag shape, EXCEPT the two that used to close
    // this list — `javascript:[^&]*` and `on\w+[^&]*=` — which had no such anchor and matched
    // far too much: `on\w+[^&]*=` in particular matched any word containing "on" (e.g.
    // "autonomie", "question", "million") followed anywhere later by an `=` sign, which is how
    // ordinary text like `(13,75 V = 13 j d'autonomie, 12 V = 44 j)` got rejected (issue #226).
    // Real onXXX/javascript: content, encoded or not, is still caught by the un-encoded
    // "event handler keyword" and "javascript: protocol" patterns above — entity-encoding `<`/`>`
    // doesn't obscure the attribute name or scheme itself. Removed rather than re-anchored:
    // it added no coverage the other patterns didn't already provide.
    ['HTML-encoded script tag', /&lt;script[^&]*&gt;/gi],
    ['HTML-encoded closing script tag', /&lt;\/script&gt;/gi],
    ['HTML-encoded iframe tag', /&lt;iframe[^&]*&gt;/gi],
    ['HTML-encoded closing iframe tag', /&lt;\/iframe&gt;/gi],
    ['HTML-encoded object tag', /&lt;object[^&]*&gt;/gi],
    ['HTML-encoded svg tag', /&lt;svg[^&]*&gt;/gi],
    ['HTML-encoded img tag with event handler', /&lt;img[^&]*on[^&]*&gt;/gi],
    ['HTML-encoded div tag with event handler', /&lt;div[^&]*on[^&]*&gt;/gi],
    ['HTML-encoded anchor tag with event handler', /&lt;a[^&]*on[^&]*&gt;/gi],
    ['HTML-encoded body tag with event handler', /&lt;body[^&]*on[^&]*&gt;/gi],
    ['HTML-encoded style tag', /&lt;style[^&]*&gt;/gi],
    ['HTML-encoded form tag with event handler', /&lt;form[^&]*on[^&]*&gt;/gi],
    ['HTML-encoded comment', /&lt;!--.*?--&gt;/gis],
  ];

  const MAX_MATCH_PREVIEW = 50;
  for (const [label, pattern] of dangerousPatterns) {
    // Reset regex lastIndex to avoid state issues with global flags
    pattern.lastIndex = 0;
    const match = pattern.exec(lowerValue);
    if (match) {
      const matched =
        match[0].length > MAX_MATCH_PREVIEW
          ? `${match[0].slice(0, MAX_MATCH_PREVIEW)}...`
          : match[0];
      throw new MCPError(
        ErrorCode.VALIDATION_ERROR,
        `${fieldName ? `${fieldName}: ` : ''}String contains potentially dangerous content ` +
          `(matched rule "${label}" on "${matched}")`,
      );
    }
  }

  // Step 2: Apply comprehensive sanitization for safe content

  // First, normalize Unicode to prevent bypass attacks
  let normalizedValue = value.normalize('NFC');

  // Remove dangerous Unicode characters that weren't caught by pattern matching
  normalizedValue = normalizedValue.replace(/[\u200b-\u200f\u2060\u180e\ufeff]/g, '');
  normalizedValue = normalizedValue.replace(/[\uFE00-\uFE0F]/g, '');

  // Apply path traversal sanitization for file system safety
  normalizedValue = normalizedValue.replace(/\.\.[/\\]/g, '...');
  normalizedValue = normalizedValue.replace(/%2e%2e[/\\]/gi, '...');
  normalizedValue = normalizedValue.replace(/\/etc\/passwd/gi, 'etc/passwd');
  normalizedValue = normalizedValue.replace(/c:\\windows\\system32/gi, 'c:/windows/system32');

  return normalizedValue;
}

/**
 * Validate a field name against Zod schema
 */
export function validateField(field: string): FilterField {
  if (typeof field !== 'string') {
    throw new MCPError(ErrorCode.VALIDATION_ERROR, 'Field must be a string');
  }

  // Check for prototype pollution attempts first
  const pollutionPatterns = [
    '__proto__',
    'constructor',
    'prototype',
    '__defineGetter__',
    '__defineSetter__',
    '__lookupGetter__',
    '__lookupSetter__',
  ];
  if (pollutionPatterns.includes(field)) {
    throw new MCPError(
      ErrorCode.VALIDATION_ERROR,
      'Invalid field name: potential prototype pollution',
    );
  }

  try {
    const result = FieldSchema.parse(field);
    return result;
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new MCPError(
        ErrorCode.VALIDATION_ERROR,
        `Invalid field: ${error.issues[0]?.message || 'Unknown validation error'}`,
      );
    }
    throw new MCPError(ErrorCode.VALIDATION_ERROR, 'Invalid field: Validation failed');
  }
}

/**
 * Validate an operator against Zod schema
 */
export function validateOperator(operator: string): FilterOperator {
  if (typeof operator !== 'string') {
    throw new MCPError(ErrorCode.VALIDATION_ERROR, 'Operator must be a string');
  }

  try {
    const result = OperatorSchema.parse(operator);
    return result;
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new MCPError(
        ErrorCode.VALIDATION_ERROR,
        `Invalid operator: ${error.issues[0]?.message || 'Unknown validation error'}`,
      );
    }
    throw new MCPError(ErrorCode.VALIDATION_ERROR, 'Invalid operator: Validation failed');
  }
}

/**
 * Validate a logical operator against Zod schema
 */
export function validateLogicalOperator(operator: string): LogicalOperator {
  if (typeof operator !== 'string') {
    throw new MCPError(ErrorCode.VALIDATION_ERROR, 'Logical operator must be a string');
  }

  try {
    const result = LogicalOperatorSchema.parse(operator);
    return result;
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new MCPError(
        ErrorCode.VALIDATION_ERROR,
        `Invalid logical operator: ${error.issues[0]?.message || 'Unknown validation error'}`,
      );
    }
    throw new MCPError(ErrorCode.VALIDATION_ERROR, 'Invalid logical operator: Validation failed');
  }
}

/**
 * Validate and normalize a value using custom logic (more comprehensive than Zod for this use case)
 */
export function validateValue(value: unknown): string | number | boolean | string[] | number[] {
  // Handle null/undefined
  if (value === null || value === undefined) {
    throw new MCPError(ErrorCode.VALIDATION_ERROR, 'Invalid value type');
  }

  // Handle string values
  if (typeof value === 'string') {
    return value;
  }

  // Handle boolean values
  if (typeof value === 'boolean') {
    return value;
  }

  // Handle number values with infinite/NaN checks
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new MCPError(
        ErrorCode.VALIDATION_ERROR,
        'Numeric values must be finite, not infinite or NaN',
      );
    }
    return value;
  }

  // Handle array values
  if (Array.isArray(value)) {
    if (value.length > 100) {
      throw new MCPError(ErrorCode.VALIDATION_ERROR, 'Array values cannot exceed 100 elements');
    }

    if (value.length === 0) {
      return [];
    }

    // Check array type consistency with proper type guards
    const firstElementType = typeof value[0];
    if (firstElementType !== 'string' && firstElementType !== 'number') {
      throw new MCPError(
        ErrorCode.VALIDATION_ERROR,
        'Array elements must be all strings or all finite numbers, not mixed',
      );
    }

    // Validate all elements are of the same type and valid
    for (let i = 0; i < value.length; i++) {
      const element: unknown = value[i];
      const elementType = typeof element;

      // Additional safety: reject null/undefined/object elements
      if (element === null || element === undefined || typeof element === 'object') {
        throw new MCPError(
          ErrorCode.VALIDATION_ERROR,
          'Array elements must be strings, numbers, or booleans, not objects',
        );
      }

      if (elementType !== firstElementType) {
        throw new MCPError(
          ErrorCode.VALIDATION_ERROR,
          'Array elements must be all strings or all finite numbers, not mixed',
        );
      }

      if (firstElementType === 'number') {
        // Type-safe numeric validation without casting
        if (typeof element !== 'number' || !Number.isFinite(element)) {
          throw new MCPError(
            ErrorCode.VALIDATION_ERROR,
            'Array numeric values must be finite, not infinite or NaN',
          );
        }
      }

      if (firstElementType === 'string') {
        // Type-safe string validation with comprehensive sanitization
        if (typeof element !== 'string') {
          throw new MCPError(ErrorCode.VALIDATION_ERROR, 'Array string elements must be strings');
        }

        // Apply comprehensive input sanitization to all string array elements
        // This prevents injection attacks in bulk operations
        try {
          (value as string[])[i] = sanitizeString(element);
        } catch (sanitizationError) {
          throw new MCPError(
            ErrorCode.VALIDATION_ERROR,
            `Array element ${i} contains potentially dangerous content: ${sanitizationError instanceof Error ? sanitizationError.message : 'Unknown error'}`,
          );
        }
      }
    }

    // Type-safe return without unsafe casting - we've validated the types above
    if (firstElementType === 'string') {
      // We've proven all elements are strings
      return value as string[];
    } else if (firstElementType === 'number') {
      // We've proven all elements are finite numbers
      return value as number[];
    } else {
      // This should never happen due to earlier validation
      throw new MCPError(ErrorCode.VALIDATION_ERROR, 'Array contains unsupported element types');
    }
  }

  // Reject all other types
  throw new MCPError(ErrorCode.VALIDATION_ERROR, 'Invalid value type');
}

/**
 * Schema for filter conditions
 */
const ConditionSchema = z.object({
  field: FieldSchema,
  operator: OperatorSchema,
  value: z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.array(z.string()),
    z.array(z.number()),
    z.null(),
  ]),
});

/**
 * Validate a filter condition object using Zod schema
 */
export function validateCondition(condition: unknown): {
  field: FilterField;
  operator: FilterOperator;
  value: string | number | boolean | string[] | number[] | null;
} {
  try {
    const result = ConditionSchema.parse(condition);
    return result;
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new MCPError(
        ErrorCode.VALIDATION_ERROR,
        `Invalid condition: ${error.issues[0]?.message || 'Condition validation failed'}`,
      );
    }
    throw new MCPError(ErrorCode.VALIDATION_ERROR, 'Invalid condition: Validation failed');
  }
}

/**
 * Zod schema for filter groups
 */
const FilterGroupSchema = z.object({
  operator: LogicalOperatorSchema,
  conditions: z.array(ConditionSchema).min(1).max(MAX_CONDITIONS),
});

/**
 * Zod schema for filter expressions
 */
const FilterExpressionSchema = z
  .object({
    groups: z.array(FilterGroupSchema).min(1).max(MAX_NESTING_DEPTH),
    operator: LogicalOperatorSchema.optional(),
  })
  .refine(
    (expr) => {
      // Check total conditions across all groups
      const totalConditions = expr.groups.reduce((sum, group) => sum + group.conditions.length, 0);
      return totalConditions <= MAX_CONDITIONS;
    },
    {
      message: `Filter expression cannot exceed ${MAX_CONDITIONS} total conditions`,
    },
  );

/**
 * Validate a filter expression using Zod schema with comprehensive type safety
 */
export function validateFilterExpression(expression: unknown): FilterExpression {
  try {
    // Use Zod for comprehensive type-safe validation
    const result = FilterExpressionSchema.parse(expression);

    // Additional runtime checks for edge cases Zod might not catch
    if (result.groups.length === 0) {
      throw new MCPError(
        ErrorCode.VALIDATION_ERROR,
        'Filter expression must have at least one group',
      );
    }

    // Validate each condition individually for additional safety
    let totalConditions = 0;
    for (let i = 0; i < result.groups.length; i++) {
      const group = result.groups[i];

      // Type guard to ensure group is defined
      if (!group) {
        throw new MCPError(ErrorCode.VALIDATION_ERROR, `Group ${i} is undefined`);
      }

      // Validate operator with stricter validation
      try {
        validateLogicalOperator(group.operator);
      } catch (error) {
        throw new MCPError(
          ErrorCode.VALIDATION_ERROR,
          `Group ${i} has invalid operator: ${error instanceof Error ? error.message : 'Unknown error'}`,
        );
      }

      // Validate each condition individually
      for (let j = 0; j < group.conditions.length; j++) {
        const condition = group.conditions[j];
        try {
          validateCondition(condition);
        } catch (error) {
          throw new MCPError(
            ErrorCode.VALIDATION_ERROR,
            `Group ${i}, condition ${j}: ${error instanceof Error ? error.message : 'Unknown error'}`,
          );
        }
        totalConditions++;
      }
    }

    // Final check for total conditions
    if (totalConditions > MAX_CONDITIONS) {
      throw new MCPError(
        ErrorCode.VALIDATION_ERROR,
        `Filter expression cannot exceed ${MAX_CONDITIONS} total conditions`,
      );
    }

    // Type-safe return - Zod has validated the structure
    return result as FilterExpression;
  } catch (error) {
    if (error instanceof z.ZodError) {
      // Check for specific Zod errors and provide better error messages
      const firstIssue = error.issues[0];
      if (firstIssue) {
        // Handle empty groups array
        if (
          firstIssue.code === 'too_small' &&
          firstIssue.path.length > 0 &&
          firstIssue.path[firstIssue.path.length - 1] === 'groups'
        ) {
          throw new MCPError(
            ErrorCode.VALIDATION_ERROR,
            'Filter expression must have at least one group',
          );
        }
        // Handle exceed maximum nesting depth or array size
        if (firstIssue.code === 'too_big') {
          if (firstIssue.message.includes('Array must contain at most 10 element(s)')) {
            throw new MCPError(
              ErrorCode.VALIDATION_ERROR,
              'Filter expression exceeds maximum nesting depth of 10',
            );
          }
          if (
            firstIssue.message.includes('conditions') ||
            firstIssue.message.includes('50') ||
            firstIssue.message.includes('Array must contain at most 50')
          ) {
            throw new MCPError(
              ErrorCode.VALIDATION_ERROR,
              'Filter expression cannot exceed 50 total conditions',
            );
          }
          // Generic too_big error for filter expressions
          throw new MCPError(
            ErrorCode.VALIDATION_ERROR,
            'Filter expression exceeds maximum nesting depth of 10',
          );
        }

        // Handle "Required" errors which might indicate missing required fields in deeply nested structures
        if (firstIssue.code === 'invalid_type' && firstIssue.message === 'Required') {
          throw new MCPError(
            ErrorCode.VALIDATION_ERROR,
            'Filter expression exceeds maximum nesting depth of 10',
          );
        }

        // Check if any issue mentions conditions or 50
        if (
          error.issues.some(
            (issue) =>
              issue.message.includes('conditions') ||
              issue.message.includes('50') ||
              issue.message.includes('Array must contain at most 50'),
          )
        ) {
          throw new MCPError(
            ErrorCode.VALIDATION_ERROR,
            'Filter expression cannot exceed 50 total conditions',
          );
        }
      }

      const errorDetails = error.issues.map((issue) => issue.message).join('; ');
      throw new MCPError(ErrorCode.VALIDATION_ERROR, `Invalid filter expression: ${errorDetails}`);
    }
    if (error instanceof MCPError) {
      throw error; // Re-throw MCPError as-is
    }
    throw new MCPError(
      ErrorCode.VALIDATION_ERROR,
      `Filter expression validation failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
    );
  }
}

/**
 * Safely stringify JSON with comprehensive protection
 * Prevents prototype pollution and sanitizes string values
 */
export function safeJsonStringify(obj: unknown): string {
  try {
    // Validate the object structure first - this will throw for invalid structures
    const validated = validateFilterExpression(obj);

    // Create a safe copy to prevent prototype pollution
    const safeObj = createSafeObjectCopy(validated);

    // Check for circular references before sanitizing
    if (safeObj === null) {
      throw new Error('Circular reference detected');
    }

    // Recursively sanitize string values in the object (but not operators)
    const sanitizedObj = sanitizeObjectStrings(safeObj);

    const jsonString = JSON.stringify(sanitizedObj);
    return jsonString; // No need to sanitize the JSON string itself since we sanitized values
  } catch (error) {
    if (error instanceof MCPError) {
      throw error; // Re-throw MCPError as-is
    }
    throw new MCPError(
      ErrorCode.VALIDATION_ERROR,
      `Failed to stringify object: ${error instanceof Error ? error.message : 'Unknown error'}`,
    );
  }
}

/**
 * Safely parse JSON with comprehensive protection
 * Prevents prototype pollution and validates against dangerous content
 */
export function safeJsonParse(jsonString: string): FilterExpression {
  if (typeof jsonString !== 'string') {
    throw new MCPError(ErrorCode.VALIDATION_ERROR, 'JSON string must be a string');
  }

  // Check for maximum length
  if (jsonString.length > 50000) {
    throw new MCPError(ErrorCode.VALIDATION_ERROR, 'JSON string exceeds maximum length');
  }

  // Check for prototype pollution patterns before parsing
  if (containsPrototypePollution(jsonString)) {
    throw new MCPError(
      ErrorCode.VALIDATION_ERROR,
      'JSON contains potentially dangerous prototype pollution patterns',
    );
  }

  try {
    const parsed: unknown = JSON.parse(jsonString);

    // Create a safe copy to prevent prototype pollution attacks
    const safeObj = createSafeObjectCopy(parsed);

    // Validate and sanitize the parsed object
    return validateFilterExpression(safeObj);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new MCPError(ErrorCode.VALIDATION_ERROR, `Invalid JSON: ${error.message}`);
    }
    if (error instanceof MCPError) {
      throw error; // Re-throw our validation errors
    }
    throw new MCPError(
      ErrorCode.VALIDATION_ERROR,
      `Failed to parse JSON: ${error instanceof Error ? error.message : 'Unknown error'}`,
    );
  }
}

/**
 * Validate ID parameters
 */
export function validateId(id: number, fieldName: string): void {
  if (typeof id !== 'number' || !Number.isInteger(id) || id <= 0) {
    throw new MCPError(ErrorCode.VALIDATION_ERROR, `${fieldName} must be a positive integer`);
  }
}

/**
 * Validate and convert ID from various formats
 */
export function validateAndConvertId(id: unknown, fieldName: string): number {
  // Handle booleans - true converts to 1, false is rejected
  if (typeof id === 'boolean') {
    if (id === true) {
      return 1;
    }
    throw new MCPError(ErrorCode.VALIDATION_ERROR, `${fieldName} must be a positive integer`);
  }

  if (typeof id === 'string') {
    // Use Number() instead of parseInt for better conversion handling
    // This handles hex strings like '0x42', exponential like '1e5', etc.
    const parsed = Number(id);
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
      throw new MCPError(ErrorCode.VALIDATION_ERROR, `${fieldName} must be a positive integer`);
    }
    return parsed;
  }

  if (typeof id === 'number') {
    validateId(id, fieldName);
    return id;
  }

  throw new MCPError(
    ErrorCode.VALIDATION_ERROR,
    `${fieldName} must be a number or positive integer string`,
  );
}

/**
 * Helper functions for comprehensive input sanitization
 */

/**
 * Checks for prototype pollution patterns in JSON strings
 */
function containsPrototypePollution(jsonString: string): boolean {
  const lowerJson = jsonString.toLowerCase();

  // Check for dangerous prototype pollution patterns
  const pollutionPatterns = [
    '__proto__',
    'constructor',
    'prototype',
    '"__proto__":',
    '"constructor":',
    '"prototype":',
    '"__proto__":',
    '{"__proto__"',
    'constructor.prototype',
    '__defineGetter__',
    '__defineSetter__',
    '__lookupGetter__',
    '__lookupSetter__',
  ];

  return pollutionPatterns.some((pattern) => lowerJson.includes(pattern));
}

/**
 * Creates a deep copy of an object while preventing prototype pollution
 */
function createSafeObjectCopy(obj: unknown, visited = new WeakSet()): unknown {
  // Handle null and primitive types
  if (obj === null || typeof obj !== 'object') {
    return obj;
  }

  // Prevent circular reference issues
  if (visited.has(obj)) {
    return null;
  }
  visited.add(obj);

  // Handle arrays
  if (Array.isArray(obj)) {
    return obj.map((item) => createSafeObjectCopy(item, visited));
  }

  // Handle Date objects
  if (obj instanceof Date) {
    return new Date(obj.getTime());
  }

  // Handle objects - create safe copy without prototype chain
  const safeObj: Record<string, unknown> = {};

  for (const key in obj) {
    // Skip dangerous prototype properties
    if (isSafeProperty(key)) {
      try {
        const value = (obj as Record<string, unknown>)[key];
        safeObj[key] = createSafeObjectCopy(value, visited);
      } catch {
        // Skip properties that cause errors during copying
        continue;
      }
    }
  }

  return safeObj;
}

/**
 * Checks if a property key is safe (not dangerous for prototype pollution)
 */
function isSafeProperty(key: string): boolean {
  const dangerousKeys = [
    '__proto__',
    'constructor',
    'prototype',
    '__defineGetter__',
    '__defineSetter__',
    '__lookupGetter__',
    '__lookupSetter__',
    'hasOwnProperty',
    'isPrototypeOf',
    'propertyIsEnumerable',
    'toLocaleString',
    'toString',
    'valueOf',
  ];

  return !dangerousKeys.includes(key) && typeof key === 'string';
}

/**
 * Recursively sanitizes all string values in an object
 * Skips known operator values to avoid HTML entity encoding
 */
function sanitizeObjectStrings(
  obj: unknown,
  visited = new WeakSet(),
  key: string | null = null,
): unknown {
  // Handle null and primitive types
  if (obj === null || typeof obj !== 'object') {
    if (typeof obj === 'string') {
      // Don't sanitize known operator values
      const knownOperators = ['=', '!=', '>', '>=', '<', '<=', 'like', 'in', 'not in', '&&', '||'];
      if (knownOperators.includes(obj)) {
        return obj;
      }
      return sanitizeString(obj);
    }
    return obj;
  }

  // Prevent circular reference issues
  if (visited.has(obj)) {
    return null;
  }
  visited.add(obj);

  // Handle arrays
  if (Array.isArray(obj)) {
    return obj.map((item) => sanitizeObjectStrings(item, visited, key));
  }

  // Handle Date objects (don't modify)
  if (obj instanceof Date) {
    return obj;
  }

  // Handle objects
  const sanitizedObj: Record<string, unknown> = {};

  for (const key in obj) {
    if (isSafeProperty(key)) {
      try {
        const value = (obj as Record<string, unknown>)[key];
        sanitizedObj[key] = sanitizeObjectStrings(value, visited, key);
      } catch {
        // Skip properties that cause errors during sanitization
        continue;
      }
    }
  }

  return sanitizedObj;
}
