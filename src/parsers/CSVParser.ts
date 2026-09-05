/**
 * CSV Parser utilities for parsing CSV formatted strings according to RFC 4180.
 *
 * This module provides functions to parse CSV lines with proper handling of:
 * - Quoted fields containing commas
 * - Escaped quotes within quoted fields (double quotes)
 * - Empty fields
 * - Whitespace trimming
 */

/**
 * Parses a single CSV line into an array of fields.
 *
 * Implements RFC 4180 compliance:
 * - Fields may be enclosed in double quotes
 * - Fields containing commas, quotes, or newlines must be quoted
 * - Quotes within fields are escaped by doubling them (""")
 * - Empty fields are returned as empty strings
 * - Leading/trailing whitespace is trimmed from unquoted fields
 *
 * @param line - The CSV line to parse
 * @returns Array of parsed field values
 *
 * @example
 * ```typescript
 * parseCSVLine('title,description,done')
 * // Returns: ['title', 'description', 'done']
 *
 * parseCSVLine('"Task with, comma","Description with ""quotes""",true')
 * // Returns: ['Task with, comma', 'Description with "quotes"', 'true']
 *
 * parseCSVLine('simple,"quoted, with, commas",unquoted')
 * // Returns: ['simple', 'quoted, with, commas', 'unquoted']
 * ```
 */
/**
 * Splits a full CSV document into row segments, honoring RFC 4180 quoting:
 * a newline inside an open (odd-parity) quote is part of the field's value,
 * not a row boundary, so a quoted field may legitimately span multiple
 * physical lines (e.g. `"line1\nline2"`).
 *
 * This intentionally does the row-boundary decision on the *whole document*
 * before any per-line parsing happens — the previous approach split on `\n`
 * first and only then ran quote-aware parsing per line, which had no way to
 * recover once a multiline quoted field had already been torn in two (see
 * issue #275). Each returned segment is safe to hand to {@link parseCSVLine}
 * unchanged: an embedded (non-row-terminating) newline inside a quoted field
 * is preserved as an ordinary character by both functions.
 *
 * Quote-state tracking here does not need the escaped-quote (`""`) lookahead
 * {@link parseCSVLine} uses: toggling "in quotes" once per literal `"`
 * character is parity-invariant, so a doubled quote (two toggles) always
 * nets out to "no change" regardless of whether it is treated as one escape
 * or two independent toggles.
 *
 * @param data - The raw CSV document
 * @returns Array of row segments, one per logical (not physical) CSV row
 */
export function splitCSVRows(data: string): string[] {
  const rows: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < data.length; i++) {
    const char = data[i];

    if (char === '"') {
      inQuotes = !inQuotes;
      current += char;
    } else if (char === '\n' && !inQuotes) {
      rows.push(current);
      current = '';
    } else {
      current += char;
    }
  }

  // Final row (may be empty when the document ends with a row-terminating
  // newline) — callers filter blank rows same as they always have.
  rows.push(current);
  return rows;
}

export function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    const nextChar = line[i + 1];

    if (char === '"') {
      if (inQuotes && nextChar === '"') {
        // Escaped quote
        current += '"';
        i++; // Skip next quote
      } else {
        // Toggle quote mode
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      // End of field
      result.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }

  // Don't forget the last field
  result.push(current.trim());
  return result;
}
