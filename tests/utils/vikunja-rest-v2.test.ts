/**
 * Tests for the Vikunja v2 REST transport (src/utils/vikunja-rest-v2.ts).
 *
 * Covers v2 base-URL normalization, version-scoped circuit breaker naming,
 * the problem+json error adapter, and the request helper itself.
 */

import { describe, it, expect } from '@jest/globals';
import {
  resolveV2BaseUrl,
  deriveRestV2BreakerName,
  parseVikunjaV2Error,
} from '../../src/utils/vikunja-rest-v2';
import { deriveRestBreakerName } from '../../src/utils/vikunja-rest';
import { MCPError, ErrorCode } from '../../src/types';

describe('vikunja-rest-v2 helper', () => {
  describe('resolveV2BaseUrl', () => {
    it('appends /api/v2 when no version suffix is present', () => {
      expect(resolveV2BaseUrl('https://vikunja.test')).toBe('https://vikunja.test/api/v2');
    });

    it('strips trailing slashes before appending', () => {
      expect(resolveV2BaseUrl('https://vikunja.test/')).toBe('https://vikunja.test/api/v2');
    });

    it('replaces an existing /api/v1 suffix with /api/v2', () => {
      expect(resolveV2BaseUrl('https://vikunja.test/api/v1')).toBe('https://vikunja.test/api/v2');
    });

    it('leaves an existing /api/v2 suffix intact', () => {
      expect(resolveV2BaseUrl('https://vikunja.test/api/v2')).toBe('https://vikunja.test/api/v2');
    });
  });

  describe('deriveRestV2BreakerName', () => {
    it('drops numeric id segments and prefixes with vikunja-rest-v2', () => {
      expect(deriveRestV2BreakerName('/tasks/7')).toBe('vikunja-rest-v2-tasks');
    });

    it('keeps the first two non-numeric segments', () => {
      expect(deriveRestV2BreakerName('/projects/4/views')).toBe('vikunja-rest-v2-projects-views');
    });

    it('falls back to "root" for a path with no usable segments', () => {
      expect(deriveRestV2BreakerName('/')).toBe('vikunja-rest-v2-root');
    });

    // Regression guard: breakers are process-wide and keyed by name, so a
    // shared name would let v1 failures trip the v2 breaker and vice versa.
    it('never collides with the v1 breaker name for the same path', () => {
      for (const path of ['/tasks/7', '/projects/4/views', '/labels/1']) {
        expect(deriveRestV2BreakerName(path)).not.toBe(deriveRestBreakerName(path));
      }
    });
  });

  describe('parseVikunjaV2Error', () => {
    const problemBody = JSON.stringify({
      $schema: '/api/v2/schemas/VikunjaErrorModel.json',
      type: 'https://vikunja.io/docs/errors/',
      title: 'Bad Request',
      status: 400,
      detail: 'Property title is required but is missing.',
      code: 4001,
      errors: [{ location: 'body.title', message: 'expected string', value: null }],
    });

    it('preserves the numeric Vikunja code and the errors[] details', () => {
      const error = parseVikunjaV2Error(
        'PATCH',
        '/tasks/7',
        400,
        'Bad Request',
        'application/problem+json',
        problemBody,
      );

      expect(error).toBeInstanceOf(MCPError);
      expect(error.code).toBe(ErrorCode.API_ERROR);
      expect(error.details?.statusCode).toBe(400);
      expect(error.details?.vikunjaError).toEqual({
        code: 4001,
        errors: [{ location: 'body.title', message: 'expected string', value: null }],
      });
    });

    it('names the failing field in the message', () => {
      const error = parseVikunjaV2Error(
        'PATCH',
        '/tasks/7',
        400,
        'Bad Request',
        'application/problem+json',
        problemBody,
      );

      expect(error.message).toContain('Vikunja REST request failed (PATCH /tasks/7)');
      expect(error.message).toContain('Bad Request: Property title is required but is missing.');
      expect(error.message).toContain('body.title: expected string');
    });

    // Shared classifiers (isAuthenticationError, extractHttpStatus) read
    // `.status` off the error object, not `.details.statusCode`.
    it('exposes the HTTP status as a top-level .status', () => {
      const error = parseVikunjaV2Error(
        'GET',
        '/tasks/7',
        403,
        'Forbidden',
        'application/problem+json',
        JSON.stringify({ title: 'Forbidden', status: 403, code: 4003 }),
      );

      expect((error as unknown as { status?: number }).status).toBe(403);
      expect(error.details?.statusCode).toBe(403);
    });

    // The transport status wins over the body's `status` field: the breaker
    // and retry predicate key off the real status, and a server-side bug in
    // the body must not be able to change retry behaviour.
    it('trusts the transport status over a disagreeing body status', () => {
      const error = parseVikunjaV2Error(
        'GET',
        '/tasks/7',
        500,
        'Internal Server Error',
        'application/problem+json',
        JSON.stringify({ title: 'Nope', status: 200, code: 9999 }),
      );

      expect(error.details?.statusCode).toBe(500);
    });

    it('honours a content type with charset parameters', () => {
      const error = parseVikunjaV2Error(
        'GET',
        '/tasks/7',
        404,
        'Not Found',
        'application/problem+json; charset=utf-8',
        JSON.stringify({ title: 'Not Found', code: 4004 }),
      );

      expect(error.details?.vikunjaError).toEqual({ code: 4004, errors: [] });
    });

    it('falls back to the v1 message shape when the body is not valid JSON', () => {
      const error = parseVikunjaV2Error(
        'GET',
        '/tasks/7',
        400,
        'Bad Request',
        'application/problem+json',
        'not json at all',
      );

      expect(error.message).toBe(
        'Vikunja REST request failed (GET /tasks/7): HTTP 400 Bad Request — not json at all',
      );
      expect(error.details?.statusCode).toBe(400);
      expect(error.details?.vikunjaError).toBeUndefined();
    });

    it('falls back when JSON parses to a non-object', () => {
      const error = parseVikunjaV2Error(
        'GET',
        '/tasks/7',
        400,
        'Bad Request',
        'application/problem+json',
        '"just a string"',
      );

      expect(error.message).toContain('— "just a string"');
      expect(error.details?.vikunjaError).toBeUndefined();
    });

    // A reverse proxy between the client and Vikunja can return a plain-text
    // 502 that never reaches Vikunja's error rendering.
    it('falls back for a non-problem+json content type', () => {
      const error = parseVikunjaV2Error(
        'GET',
        '/tasks/7',
        502,
        'Bad Gateway',
        'text/html',
        '<html>gateway down</html>',
      );

      expect(error.message).toBe(
        'Vikunja REST request failed (GET /tasks/7): HTTP 502 Bad Gateway — <html>gateway down</html>',
      );
      expect(error.details?.statusCode).toBe(502);
    });

    it('falls back when there is no content type at all', () => {
      const error = parseVikunjaV2Error('GET', '/tasks/7', 502, 'Bad Gateway', null, 'oops');

      expect(error.message).toContain('HTTP 502 Bad Gateway — oops');
    });

    it('omits the detail suffix entirely for an empty body', () => {
      const error = parseVikunjaV2Error('GET', '/tasks/7', 502, 'Bad Gateway', null, '');

      expect(error.message).toBe(
        'Vikunja REST request failed (GET /tasks/7): HTTP 502 Bad Gateway',
      );
    });

    it('truncates an oversized fallback body to 500 characters', () => {
      const error = parseVikunjaV2Error('GET', '/tasks/7', 500, 'Error', null, 'x'.repeat(900));

      expect(error.message).toContain(`— ${'x'.repeat(500)}`);
      expect(error.message).not.toContain('x'.repeat(501));
    });

    it('renders a problem body carrying only errors[] and no title or detail', () => {
      const error = parseVikunjaV2Error(
        'PATCH',
        '/tasks/7',
        422,
        'Unprocessable Entity',
        'application/problem+json',
        JSON.stringify({ errors: [{ location: 'body.due_date', message: 'invalid date' }] }),
      );

      expect(error.message).toBe(
        'Vikunja REST request failed (PATCH /tasks/7): HTTP 422 Unprocessable Entity — [body.due_date: invalid date]',
      );
    });

    it('renders a problem body with neither summary nor errors as the bare status line', () => {
      const error = parseVikunjaV2Error(
        'GET',
        '/tasks/7',
        500,
        'Internal Server Error',
        'application/problem+json',
        JSON.stringify({ code: 5000 }),
      );

      expect(error.message).toBe(
        'Vikunja REST request failed (GET /tasks/7): HTTP 500 Internal Server Error',
      );
      expect(error.details?.vikunjaError).toEqual({ code: 5000, errors: [] });
    });

    // Defensive test: error entries may omit location or message fields.
    // This exercises the conditional branches in readErrorDetails.
    it('handles error entries with only location (no message)', () => {
      const error = parseVikunjaV2Error(
        'PATCH',
        '/tasks/7',
        422,
        'Unprocessable Entity',
        'application/problem+json',
        JSON.stringify({
          title: 'Validation failed',
          errors: [{ location: 'body.tags', value: 'invalid' }],
        }),
      );

      expect(error.message).toContain('body.tags');
      expect(error.details?.vikunjaError?.errors).toEqual([
        { location: 'body.tags', value: 'invalid' },
      ]);
    });

    it('handles error entries with only message (no location)', () => {
      const error = parseVikunjaV2Error(
        'PATCH',
        '/tasks/7',
        422,
        'Unprocessable Entity',
        'application/problem+json',
        JSON.stringify({
          title: 'Validation failed',
          errors: [{ message: 'must be at least 3 characters', value: 'xy' }],
        }),
      );

      expect(error.message).toContain('must be at least 3 characters');
      expect(error.details?.vikunjaError?.errors).toEqual([
        { message: 'must be at least 3 characters', value: 'xy' },
      ]);
    });

    it('handles error entries with neither location nor message', () => {
      const error = parseVikunjaV2Error(
        'PATCH',
        '/tasks/7',
        422,
        'Unprocessable Entity',
        'application/problem+json',
        JSON.stringify({
          title: 'Validation failed',
          errors: [{ value: null }],
        }),
      );

      // Entry with no location or message is skipped in the fields list
      expect(error.message).toBe(
        'Vikunja REST request failed (PATCH /tasks/7): HTTP 422 Unprocessable Entity — Validation failed',
      );
      expect(error.details?.vikunjaError?.errors).toEqual([{ value: null }]);
    });

    it('renders mixed error entries with varying completeness', () => {
      const error = parseVikunjaV2Error(
        'PATCH',
        '/tasks/7',
        422,
        'Unprocessable Entity',
        'application/problem+json',
        JSON.stringify({
          errors: [
            { location: 'body.title', message: 'required' },
            { location: 'body.tags' },
            { message: 'unexpected field' },
            { value: 'extra' },
          ],
        }),
      );

      // Should render complete entry, location-only, message-only, and skip valueless
      expect(error.message).toContain('body.title: required');
      expect(error.message).toContain('body.tags');
      expect(error.message).toContain('unexpected field');
      expect(error.details?.vikunjaError?.errors).toEqual([
        { location: 'body.title', message: 'required' },
        { location: 'body.tags' },
        { message: 'unexpected field' },
        { value: 'extra' },
      ]);
    });
  });
});
