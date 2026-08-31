/**
 * Tests for the `percentDone` scale boundary (src/utils/percent-done.ts).
 *
 * The tool surface exposes `percentDone` as a whole percentage 0-100; Vikunja's
 * wire field `percent_done` is a 0-1 fraction. These tests pin the two
 * properties the rest of the codebase relies on:
 *
 * 1. **Exactness.** `n / 100` for an integer `n` must land on the same IEEE-754
 *    double as the decimal literal, so no write introduces a float artifact.
 * 2. **The rounding rule.** The read path reports the nearest whole percent,
 *    halves up — see the module header. Filter thresholds use the
 *    non-rounding variant instead, and that difference is deliberate.
 *
 * Plus the validation messages, which exist to TEACH: `0.5` must produce a
 * sentence naming the scale, not Zod's "Expected integer, received float".
 */

import { describe, it, expect } from '@jest/globals';
import {
  PERCENT_DONE_SCALE_HINT,
  percentDoneScaleError,
  isValidPercentDone,
  assertValidPercentDone,
  percentDoneSchema,
  percentDoneToFraction,
  fractionToPercentDone,
  fractionToPercentExact,
} from '../../src/utils/percent-done';
import { MCPError, ErrorCode } from '../../src/types';

describe('percentDoneToFraction', () => {
  it.each([
    [0, 0],
    [1, 0.01],
    [25, 0.25],
    [50, 0.5],
    [75, 0.75],
    [100, 1],
  ])('converts %i%% to the wire fraction %f', (percentage, fraction) => {
    expect(percentDoneToFraction(percentage)).toBe(fraction);
  });

  it('is exact for every integer 0-100 (no float artifacts on the wire)', () => {
    for (let pct = 0; pct <= 100; pct++) {
      const fraction = percentDoneToFraction(pct);
      // The double `pct / 100` produces must be the SAME double the decimal
      // literal produces — i.e. round-tripping through its own shortest
      // decimal representation is lossless.
      expect(fraction).toBe(Number(fraction.toString()));
      expect(fraction.toString()).not.toContain('e');
      expect(fractionToPercentDone(fraction)).toBe(pct);
    }
  });
});

describe('fractionToPercentDone', () => {
  it.each([
    [0, 0],
    [0.01, 1],
    [0.25, 25],
    [0.33, 33],
    [0.5, 50],
    [1, 100],
  ])('renders the wire fraction %f as %i%%', (fraction, percentage) => {
    expect(fractionToPercentDone(fraction)).toBe(percentage);
  });

  it.each([
    [0.07, 7],
    [0.14, 14],
    [0.28, 28],
    [0.29, 29],
    [0.55, 55],
    [0.56, 56],
    [0.57, 57],
    [0.58, 58],
  ])('kills the float artifact when reading back %f', (fraction, percentage) => {
    // These eight are exactly the percentages 0-100 where the naive
    // `fraction * 100` does NOT land on the integer (0.07 * 100 is
    // 7.000000000000001, 0.29 * 100 is 28.999999999999996). Rounding on the
    // read path is what keeps the round trip exact for all of them.
    expect(fraction * 100).not.toBe(percentage);
    expect(fractionToPercentDone(fraction)).toBe(percentage);
  });

  it('rounds a sub-percent value written by another client to the nearest whole percent', () => {
    // Vikunja's own web-UI slider, an import, or a hand-written API call can
    // store a value this tool surface would never accept.
    expect(fractionToPercentDone(0.334)).toBe(33);
    expect(fractionToPercentDone(0.336)).toBe(34);
  });

  it('rounds an exact half up, per the documented rule', () => {
    expect(fractionToPercentDone(0.335)).toBe(34);
    expect(fractionToPercentDone(0.005)).toBe(1);
  });
});

describe('fractionToPercentExact', () => {
  it('scales up without rounding to a whole percent', () => {
    expect(fractionToPercentExact(0.335)).toBe(33.5);
    expect(fractionToPercentExact(0.075)).toBe(7.5);
  });

  it('still strips the float artifact for whole percentages', () => {
    expect(fractionToPercentExact(0.07)).toBe(7);
    expect(fractionToPercentExact(0.29)).toBe(29);
  });

  it('differs from fractionToPercentDone exactly where a filter threshold needs it to', () => {
    // A saved filter of `percent_done > 0.335` is a legitimate cutoff; reading
    // it back as `> 34` would change which tasks the caller is told it selects.
    expect(fractionToPercentExact(0.335)).not.toBe(fractionToPercentDone(0.335));
  });
});

describe('isValidPercentDone', () => {
  it.each([0, 1, 50, 99, 100])('accepts the integer %i', (value) => {
    expect(isValidPercentDone(value)).toBe(true);
  });

  it.each([
    ['a fraction', 0.5],
    ['a negative', -1],
    ['above 100', 101],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
  ])('rejects %s', (_label, value) => {
    expect(isValidPercentDone(value)).toBe(false);
  });

  it.each([
    ['a numeric string', '50'],
    ['null', null],
    ['undefined', undefined],
    ['an object', {}],
  ])('rejects %s (wrong type)', (_label, value) => {
    expect(isValidPercentDone(value)).toBe(false);
  });
});

describe('assertValidPercentDone', () => {
  it('passes a valid percentage through silently', () => {
    expect(() => assertValidPercentDone(75)).not.toThrow();
  });

  it('throws a VALIDATION_ERROR MCPError naming the scale', () => {
    let thrown: unknown;
    try {
      assertValidPercentDone(0.5);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(MCPError);
    expect((thrown as MCPError).code).toBe(ErrorCode.VALIDATION_ERROR);
    expect((thrown as MCPError).message).toContain(
      'percentDone must be a whole number between 0 and 100',
    );
    expect((thrown as MCPError).message).toContain('use 50 for 50%');
  });

  it('names the caller-supplied label so a bulk error points at the offending item', () => {
    expect(() => assertValidPercentDone(0.5, 'tasks[2].percentDone')).toThrow(
      'tasks[2].percentDone must be a whole number between 0 and 100',
    );
  });
});

describe('percentDoneScaleError / PERCENT_DONE_SCALE_HINT', () => {
  it('teaches the scale rather than restating the constraint', () => {
    const message = percentDoneScaleError();
    expect(message).toContain(PERCENT_DONE_SCALE_HINT);
    expect(message).toContain('use 50 for 50%');
    expect(message).toContain('100 for done');
    // The failure an agent is most likely to make, spelled out.
    expect(message).toContain('0.5');
  });
});

describe('percentDoneSchema', () => {
  it.each([0, 25, 100])('accepts the integer %i', (value) => {
    expect(percentDoneSchema.parse(value)).toBe(value);
  });

  it('accepts undefined (the field is optional everywhere it is used)', () => {
    expect(percentDoneSchema.parse(undefined)).toBeUndefined();
  });

  it.each([
    ['a fraction', 0.5],
    ['a negative', -1],
    ['above 100', 101],
  ])('rejects %s with the teaching message, not a bare Zod message', (_label, value) => {
    const result = percentDoneSchema.safeParse(value);
    expect(result.success).toBe(false);
    const message = result.success ? '' : (result.error.issues[0]?.message ?? '');
    expect(message).toContain('percentDone must be a whole number between 0 and 100');
    expect(message).not.toContain('Expected integer');
  });
});
