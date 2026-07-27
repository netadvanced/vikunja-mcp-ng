# Vikunja v2 Transport, Error Adapter, and Routing — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a capability-gated Vikunja v2 REST transport with a `problem+json` error adapter, a routing decision point, and a kill switch — without changing the behaviour of any existing operation.

**Architecture:** A new `src/utils/vikunja-rest-v2.ts` module mirrors the shape of the existing v1 helper (`src/utils/vikunja-rest.ts`) but targets `/api/v2`, sends RFC 7386 merge-patch by default on `PATCH`, and converts `application/problem+json` error bodies into the existing `MCPError` model. A separate `src/utils/api-version.ts` holds the single routing decision (`resolveApiVersion`), consulting the session's cached `hasV2Api` capability and a new `featureFlags.forceV1Api` kill switch. Nothing in `src/tools/` routes through v2 in this phase except `vikunja_auth`, which reports which path is active.

**Tech Stack:** TypeScript (strict), Jest + ts-jest, Zod (config schemas), opossum (circuit breaker, via `src/utils/retry.ts`), native `fetch`.

**Spec:** `docs/superpowers/specs/2026-07-27-vikunja-v2-transport-design.md`
**Issue:** [#184](https://github.com/netadvanced/vikunja-mcp-ng/issues/184), phases P1 + P2.

## Global Constraints

- **v1 is the permanent floor and must not regress.** `src/utils/vikunja-rest.ts` gets exactly one edit in this plan: adding `export` to `isTransientNetworkError`. No other line in that file changes.
- **No tool-surface change.** No new tools, no new subcommands, no caller-visible schema change. `vikunja_auth` response metadata gains fields; nothing is removed or renamed.
- **No operation routes through v2 in this phase.** `resolveApiVersion` has exactly one caller when this plan lands: `src/tools/auth.ts`.
- **Coverage ratchet:** `npm run test:coverage` must stay green at 92 lines / 83 branches / 82 functions / 92 statements. Thresholds are never lowered.
- **Defensive-programming rule:** if code cannot be tested, it must be removed. Every fallback branch written here has a test that triggers it.
- **Pre-commit gate (all three must pass):** `npm run lint`, `npm run typecheck`, `npm run test:coverage`.
- **Breaker names must not collide across API versions.** v2 breakers are prefixed `vikunja-rest-v2-`; v1 keeps `vikunja-rest-`.
- **Minimum supported Vikunja stays 2.3.0** (v1-only). Every v2 path needs a working v1 fallback.
- Commit messages end with: `Claude-Session: https://claude.ai/code/session_013PagXz55C36TboMkNDGa7Q`

---

### Task 1: v2 base URL resolution and breaker naming

Pure functions, no network. These are the foundation the transport builds on, and the breaker-name test is the regression guard for the v1/v2 collision described in the spec.

**Files:**
- Create: `src/utils/vikunja-rest-v2.ts`
- Test: `tests/utils/vikunja-rest-v2.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `resolveV2BaseUrl(apiUrl: string): string`
  - `deriveRestV2BreakerName(path: string): string`

- [ ] **Step 1: Write the failing test**

Create `tests/utils/vikunja-rest-v2.test.ts`:

```typescript
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
} from '../../src/utils/vikunja-rest-v2';
import { deriveRestBreakerName } from '../../src/utils/vikunja-rest';

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
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/utils/vikunja-rest-v2.test.ts`
Expected: FAIL — `Cannot find module '../../src/utils/vikunja-rest-v2'`

- [ ] **Step 3: Write minimal implementation**

Create `src/utils/vikunja-rest-v2.ts`:

```typescript
/**
 * Vikunja v2 REST transport.
 *
 * A deliberate sibling of `./vikunja-rest` rather than a branch inside it.
 * v1 is the permanent backward-compatible floor (minimum supported Vikunja
 * is 2.3.0, which is v1-only), so v2 support must not put new logic on the
 * code path v1 executes. Shared machinery — the retry loop, the named
 * circuit breaker registry, the retry predicate — is imported, not copied;
 * only URL resolution, breaker naming, request content type, and error
 * parsing differ.
 *
 * See docs/superpowers/specs/2026-07-27-vikunja-v2-transport-design.md.
 */

/**
 * Resolves the v2 API base URL for a session, normalizing whether or not
 * `apiUrl` already carries an `/api/v{n}` suffix (depends on how
 * `VIKUNJA_URL` was configured). Mirrors `resolveBaseUrl` in
 * `./vikunja-rest`, but targets v2 and replaces — rather than preserves —
 * an existing version suffix, matching `resolveV2ProbeUrl` in
 * `./capabilities`.
 */
export function resolveV2BaseUrl(apiUrl: string): string {
  const trimmed = apiUrl.replace(/\/+$/, '');
  const withoutVersion = trimmed.replace(/\/api\/v\d+$/, '');
  return `${withoutVersion}/api/v2`;
}

/**
 * Derives a stable, endpoint-group-scoped circuit breaker name for a v2
 * request path, using the same segment-collapsing rules as
 * `deriveRestBreakerName` in `./vikunja-rest` but under a distinct
 * `vikunja-rest-v2-` prefix.
 *
 * The prefix is load-bearing, not cosmetic. Breakers are process-wide and
 * keyed by name in the shared registry in `./retry`; without it, a v2
 * `PATCH /tasks/{id}` and a v1 `POST /tasks/{id}` would both derive
 * `vikunja-rest-tasks` and silently share one rolling failure window across
 * two different API surfaces.
 */
export function deriveRestV2BreakerName(path: string): string {
  const segments = path.split('/').filter((seg) => seg.length > 0 && !/^\d+$/.test(seg));
  const group = segments.slice(0, 2).join('-') || 'root';
  return `vikunja-rest-v2-${group}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/utils/vikunja-rest-v2.test.ts`
Expected: PASS (8 tests)

- [ ] **Step 5: Commit**

```bash
git add src/utils/vikunja-rest-v2.ts tests/utils/vikunja-rest-v2.test.ts
git commit -m "feat(v2): v2 base URL resolution and version-scoped breaker naming (#184)

Claude-Session: https://claude.ai/code/session_013PagXz55C36TboMkNDGa7Q"
```

---

### Task 2: problem+json → MCPError adapter

v2 returns `application/problem+json` (`VikunjaErrorModel`) where v1 returns `web.HTTPError` as plain text. This adapter is a pure function over already-read response fields, so it needs no `Response` mock.

**Files:**
- Modify: `src/utils/vikunja-rest-v2.ts` (append)
- Test: `tests/utils/vikunja-rest-v2.test.ts` (append)

**Interfaces:**
- Consumes: `MCPError`, `ErrorCode` from `src/types`.
- Produces: `parseVikunjaV2Error(method: HttpMethodV2, path: string, status: number, statusText: string, contentType: string | null, rawBody: string): MCPError` and the exported type `HttpMethodV2 = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'`.

- [ ] **Step 1: Write the failing test**

Append to `tests/utils/vikunja-rest-v2.test.ts` — add `parseVikunjaV2Error` to the import from `../../src/utils/vikunja-rest-v2`, add `import { MCPError, ErrorCode } from '../../src/types';`, and add this block inside the outer `describe`:

```typescript
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
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/utils/vikunja-rest-v2.test.ts -t parseVikunjaV2Error`
Expected: FAIL — `parseVikunjaV2Error is not a function`

- [ ] **Step 3: Write minimal implementation**

Append to `src/utils/vikunja-rest-v2.ts` (and add `import { MCPError, ErrorCode } from '../types';` at the top):

```typescript
export type HttpMethodV2 = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** Matches how much of a non-problem+json error body v1 keeps. */
const MAX_FALLBACK_BODY_LENGTH = 500;

/**
 * The subset of v2's `VikunjaErrorModel` this adapter consumes. Declared
 * locally rather than imported from the generated OpenAPI types because
 * this data arrives off the network and must be validated field by field
 * rather than asserted — a server or proxy can send anything.
 */
interface VikunjaProblemJson {
  title?: unknown;
  detail?: unknown;
  code?: unknown;
  errors?: unknown;
}

interface ParsedErrorDetail {
  location?: string;
  message?: string;
  value?: unknown;
}

function isProblemJson(contentType: string | null): boolean {
  return contentType !== null && contentType.toLowerCase().includes('application/problem+json');
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Normalizes the model's `errors[]` list, dropping entries that are not
 * objects. Always returns an array so callers never have to distinguish
 * "absent" from "empty".
 */
function readErrorDetails(value: unknown): ParsedErrorDetail[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null)
    .map((entry) => ({
      ...(readString(entry.location) !== undefined ? { location: readString(entry.location) } : {}),
      ...(readString(entry.message) !== undefined ? { message: readString(entry.message) } : {}),
      value: entry.value,
    }));
}

function buildBaseMessage(
  method: HttpMethodV2,
  path: string,
  status: number,
  statusText: string,
): string {
  // Deliberately identical to the v1 prefix: `wrapIfRestOrigin` in
  // ./error-handler matches the literal string "Vikunja REST request
  // failed (", so both transports get the same wrapping behaviour.
  return `Vikunja REST request failed (${method} ${path}): HTTP ${status} ${statusText}`;
}

function buildFallbackError(
  method: HttpMethodV2,
  path: string,
  status: number,
  statusText: string,
  rawBody: string,
): MCPError {
  const detail = rawBody.slice(0, MAX_FALLBACK_BODY_LENGTH);
  const base = buildBaseMessage(method, path, status, statusText);
  return new MCPError(ErrorCode.API_ERROR, detail ? `${base} — ${detail}` : base, {
    statusCode: status,
  });
}

/**
 * Converts a non-2xx v2 response into an `MCPError`, preserving everything
 * downstream logic keys on: the HTTP status (in both `details.statusCode`
 * and a top-level `.status`), Vikunja's numeric error `code`, and the
 * per-field `errors[]` list.
 *
 * Degrades to v1's "status line plus truncated body" message shape when the
 * response is not problem+json or its body does not parse — which happens
 * for real: a reverse proxy or gateway in front of Vikunja can return a
 * plain-text 502 that never reaches Vikunja's error rendering.
 */
export function parseVikunjaV2Error(
  method: HttpMethodV2,
  path: string,
  status: number,
  statusText: string,
  contentType: string | null,
  rawBody: string,
): MCPError {
  let error: MCPError;

  if (!isProblemJson(contentType)) {
    error = buildFallbackError(method, path, status, statusText, rawBody);
  } else {
    let model: VikunjaProblemJson | undefined;
    try {
      const parsed: unknown = JSON.parse(rawBody);
      if (typeof parsed === 'object' && parsed !== null) {
        model = parsed as VikunjaProblemJson;
      }
    } catch {
      // Malformed body — handled by the `model === undefined` branch below.
    }

    if (model === undefined) {
      error = buildFallbackError(method, path, status, statusText, rawBody);
    } else {
      const summary = [readString(model.title), readString(model.detail)]
        .filter((part): part is string => part !== undefined)
        .join(': ');
      const details = readErrorDetails(model.errors);
      const fields = details
        .map((entry) => [entry.location, entry.message].filter(Boolean).join(': '))
        .filter((entry) => entry.length > 0);
      const fieldSuffix = fields.length > 0 ? `[${fields.join('; ')}]` : '';
      const suffix = [summary, fieldSuffix].filter((part) => part.length > 0).join(' ');
      const base = buildBaseMessage(method, path, status, statusText);

      error = new MCPError(ErrorCode.API_ERROR, suffix ? `${base} — ${suffix}` : base, {
        statusCode: status,
        vikunjaError: {
          ...(typeof model.code === 'number' ? { code: model.code } : {}),
          errors: details,
        },
      });
    }
  }

  // Mirrors vikunja-rest.ts: shared classifiers (isAuthenticationError,
  // extractHttpStatus) read `.status`/`.response.status` off the error
  // object rather than `.details.statusCode`.
  Object.assign(error, { status });
  return error;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/utils/vikunja-rest-v2.test.ts`
Expected: PASS (all Task 1 and Task 2 tests)

- [ ] **Step 5: Commit**

```bash
git add src/utils/vikunja-rest-v2.ts tests/utils/vikunja-rest-v2.test.ts
git commit -m "feat(v2): problem+json to MCPError adapter (#184)

Preserves Vikunja's numeric code, the errors[] field list, and the HTTP
status in both details.statusCode and a top-level .status. Falls back to
the v1 message shape for non-problem+json or malformed bodies.

Claude-Session: https://claude.ai/code/session_013PagXz55C36TboMkNDGa7Q"
```

---

### Task 3: the v2 request helper

Wires the pieces together: auth header, content-type selection, retry loop, and named circuit breaker.

**Files:**
- Modify: `src/utils/vikunja-rest.ts:117` (add `export` to `isTransientNetworkError` — the only edit to this file in the whole plan)
- Modify: `src/utils/vikunja-rest-v2.ts` (append)
- Test: `tests/utils/vikunja-rest-v2.test.ts` (append)

**Interfaces:**
- Consumes: `resolveV2BaseUrl`, `deriveRestV2BreakerName`, `parseVikunjaV2Error`, `HttpMethodV2` from Tasks 1–2. From `./vikunja-rest`: `defaultRestShouldRetry` (already exported), `isTransientNetworkError` (exported by this task), `VikunjaRestRequestOptions` (already exported). From `./retry`: `createCircuitBreaker`, `withRetry`, `rewordBreakerOpenError`, `RetryOptions`.
- Produces: `vikunjaRestV2Request<T>(authManager: AuthManager, method: HttpMethodV2, path: string, body?: unknown, options?: VikunjaRestV2RequestOptions): Promise<T>` and `interface VikunjaRestV2RequestOptions extends VikunjaRestRequestOptions { patchFormat?: 'merge' | 'json-patch' }`.

- [ ] **Step 1: Write the failing test**

Append to `tests/utils/vikunja-rest-v2.test.ts`. Extend the imports at the top of the file to:

```typescript
import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { AuthManager } from '../../src/auth/AuthManager';
import { circuitBreakerRegistry } from '../../src/utils/retry';
import {
  resolveV2BaseUrl,
  deriveRestV2BreakerName,
  parseVikunjaV2Error,
  vikunjaRestV2Request,
} from '../../src/utils/vikunja-rest-v2';
import { deriveRestBreakerName } from '../../src/utils/vikunja-rest';
import { MCPError, ErrorCode } from '../../src/types';

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

/**
 * Builds a Response-like object good enough for vikunjaRestV2Request, which
 * reads `.ok`, `.status`, `.statusText`, `.headers.get()` and `.text()`.
 */
function mockV2Response(opts: {
  ok?: boolean;
  status?: number;
  statusText?: string;
  text?: string;
  contentType?: string | null;
}): Response {
  const {
    ok = true,
    status = 200,
    statusText = 'OK',
    text = '',
    contentType = 'application/json',
  } = opts;
  return {
    ok,
    status,
    statusText,
    headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? contentType : null) },
    text: jest.fn(async () => text),
  } as unknown as Response;
}
```

Then add this block inside the outer `describe`:

```typescript
  describe('vikunjaRestV2Request', () => {
    let authManager: AuthManager;

    beforeEach(() => {
      jest.clearAllMocks();
      mockFetch.mockReset();
      // The breaker registry in ../../src/utils/retry is a process-wide
      // singleton keyed by name; several tests below deliberately fail the
      // same path, so without clearing accumulated stats a later test
      // starts seeing "Breaker is open" instead of its own scenario.
      circuitBreakerRegistry.clear();
      authManager = new AuthManager();
      authManager.connect('https://vikunja.test', 'tk_test-token');
    });

    it('targets the v2 base URL and sends the bearer token', async () => {
      mockFetch.mockResolvedValueOnce(mockV2Response({ text: JSON.stringify({ id: 7 }) }));

      const result = await vikunjaRestV2Request(authManager, 'GET', '/tasks/7');

      expect(result).toEqual({ id: 7 });
      const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://vikunja.test/api/v2/tasks/7');
      expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tk_test-token');
      expect(init.body).toBeUndefined();
    });

    it('sends merge-patch+json for PATCH by default', async () => {
      mockFetch.mockResolvedValueOnce(mockV2Response({ text: '{}' }));

      await vikunjaRestV2Request(authManager, 'PATCH', '/tasks/7', { priority: 3 });

      const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect((init.headers as Record<string, string>)['Content-Type']).toBe(
        'application/merge-patch+json',
      );
      expect(init.body).toBe(JSON.stringify({ priority: 3 }));
    });

    it('sends json-patch+json when that patch format is requested', async () => {
      mockFetch.mockResolvedValueOnce(mockV2Response({ text: '{}' }));

      await vikunjaRestV2Request(authManager, 'PATCH', '/tasks/7', [{ op: 'remove', path: '/assignees/0' }], {
        patchFormat: 'json-patch',
      });

      const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect((init.headers as Record<string, string>)['Content-Type']).toBe(
        'application/json-patch+json',
      );
    });

    it('sends plain application/json for non-PATCH methods', async () => {
      mockFetch.mockResolvedValueOnce(mockV2Response({ text: '{}' }));

      await vikunjaRestV2Request(authManager, 'POST', '/tasks', { title: 'x' });

      const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    });

    it('returns null for an empty response body', async () => {
      mockFetch.mockResolvedValueOnce(mockV2Response({ text: '' }));

      await expect(vikunjaRestV2Request(authManager, 'DELETE', '/tasks/7')).resolves.toBeNull();
    });

    it('returns null for a 2xx response with a non-JSON body', async () => {
      mockFetch.mockResolvedValueOnce(mockV2Response({ text: 'not json' }));

      await expect(vikunjaRestV2Request(authManager, 'GET', '/tasks/7')).resolves.toBeNull();
    });

    it('routes a problem+json error through the adapter', async () => {
      mockFetch.mockResolvedValueOnce(
        mockV2Response({
          ok: false,
          status: 404,
          statusText: 'Not Found',
          contentType: 'application/problem+json',
          text: JSON.stringify({ title: 'Not Found', code: 4004 }),
        }),
      );

      await expect(vikunjaRestV2Request(authManager, 'GET', '/tasks/7')).rejects.toMatchObject({
        code: ErrorCode.API_ERROR,
        details: { statusCode: 404, vikunjaError: { code: 4004, errors: [] } },
      });
    });

    it('wraps a network-layer failure as a transient MCPError', async () => {
      const netError = Object.assign(new Error('fetch failed'), { code: 'ECONNRESET' });
      mockFetch.mockRejectedValue(netError);

      const promise = vikunjaRestV2Request(authManager, 'GET', '/tasks/7', undefined, {
        retry: { maxRetries: 0 },
      });

      await expect(promise).rejects.toBeInstanceOf(MCPError);
      await expect(promise).rejects.toMatchObject({ details: { transient: true } });
    });

    it('retries a 500 and succeeds on the next attempt', async () => {
      mockFetch
        .mockResolvedValueOnce(
          mockV2Response({ ok: false, status: 500, statusText: 'Server Error', contentType: null }),
        )
        .mockResolvedValueOnce(mockV2Response({ text: JSON.stringify({ id: 7 }) }));

      const result = await vikunjaRestV2Request(authManager, 'GET', '/tasks/7', undefined, {
        retry: { initialDelay: 1 },
      });

      expect(result).toEqual({ id: 7 });
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('does not retry a 404', async () => {
      mockFetch.mockResolvedValue(
        mockV2Response({
          ok: false,
          status: 404,
          statusText: 'Not Found',
          contentType: 'application/problem+json',
          text: JSON.stringify({ title: 'Not Found' }),
        }),
      );

      await expect(vikunjaRestV2Request(authManager, 'GET', '/tasks/7')).rejects.toBeInstanceOf(
        MCPError,
      );
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    // isClientErrorExcludedFromBreaker in ./retry is status-generic, so it
    // applies to v2 unchanged — this pins that it actually does.
    it('does not count 4xx responses toward the breaker', async () => {
      mockFetch.mockResolvedValue(
        mockV2Response({
          ok: false,
          status: 404,
          statusText: 'Not Found',
          contentType: 'application/problem+json',
          text: JSON.stringify({ title: 'Not Found' }),
        }),
      );

      // Iteration count must exceed the breaker's volume threshold so that a
      // regression (4xx wrongly counted) would actually trip it. Check the
      // configured threshold in ./retry and raise this number if it is >= 12.
      for (let i = 0; i < 12; i++) {
        await expect(vikunjaRestV2Request(authManager, 'GET', '/tasks/7')).rejects.toBeInstanceOf(
          MCPError,
        );
      }

      // A tripped breaker rejects with a reworded "circuit breaker is open"
      // message instead of the underlying 404 — assert we still see the 404.
      await expect(
        vikunjaRestV2Request(authManager, 'GET', '/tasks/7'),
      ).rejects.toMatchObject({ details: { statusCode: 404 } });
    });

    it('registers its breaker under the v2-prefixed name', async () => {
      mockFetch.mockResolvedValueOnce(mockV2Response({ text: '{}' }));

      await vikunjaRestV2Request(authManager, 'GET', '/tasks/7');

      expect(circuitBreakerRegistry.has('vikunja-rest-v2-tasks')).toBe(true);
      expect(circuitBreakerRegistry.has('vikunja-rest-tasks')).toBe(false);
    });

    it('honours an explicit breaker name override', async () => {
      mockFetch.mockResolvedValueOnce(mockV2Response({ text: '{}' }));

      await vikunjaRestV2Request(authManager, 'GET', '/tasks/7', undefined, {
        breakerName: 'vikunja-rest-v2-custom',
      });

      expect(circuitBreakerRegistry.has('vikunja-rest-v2-custom')).toBe(true);
    });
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/utils/vikunja-rest-v2.test.ts -t vikunjaRestV2Request`
Expected: FAIL — `vikunjaRestV2Request is not a function`

- [ ] **Step 3a: Export the shared transient-network check from the v1 module**

In `src/utils/vikunja-rest.ts`, change line 117 from:

```typescript
function isTransientNetworkError(error: unknown): boolean {
```

to:

```typescript
export function isTransientNetworkError(error: unknown): boolean {
```

Nothing else in that file changes. Sharing this function is preferable to duplicating `TRANSIENT_NETWORK_CODES` into a second file where the two copies could drift.

- [ ] **Step 3b: Write the transport**

Append to `src/utils/vikunja-rest-v2.ts`, extending the imports at the top of the file with:

```typescript
import type { AuthManager } from '../auth/AuthManager';
import {
  defaultRestShouldRetry,
  isTransientNetworkError,
  type VikunjaRestRequestOptions,
} from './vikunja-rest';
import {
  createCircuitBreaker,
  withRetry,
  rewordBreakerOpenError,
  type RetryOptions,
} from './retry';
```

then append:

```typescript
/** Which RFC the PATCH request body follows. v2 accepts both on every PATCH route. */
export type PatchFormat = 'merge' | 'json-patch';

export interface VikunjaRestV2RequestOptions extends VikunjaRestRequestOptions {
  /**
   * Request body format for PATCH calls. `'merge'` (RFC 7386
   * merge-patch+json, the default) matches the shape of our tool arguments;
   * `'json-patch'` (RFC 6902) is the only way to express true array
   * operations such as removing a single assignee. Ignored for other methods.
   */
  patchFormat?: PatchFormat;
}

/**
 * Same modest retry/backoff tuning as the v1 helper — a safety net for
 * transient failures, not a substitute for thinking about idempotency.
 */
const DEFAULT_V2_JSON_RETRY: RetryOptions = {
  maxRetries: 2,
  initialDelay: 250,
  maxDelay: 2000,
  backoffFactor: 2,
};

function resolveContentType(method: HttpMethodV2, patchFormat: PatchFormat): string {
  if (method !== 'PATCH') {
    return 'application/json';
  }
  return patchFormat === 'json-patch'
    ? 'application/json-patch+json'
    : 'application/merge-patch+json';
}

/**
 * The actual network call, with no retry/breaker logic of its own.
 * Intentionally a plain top-level function rather than a closure factory so
 * it can be registered once per breaker name and re-fired with fresh
 * arguments — see `createCircuitBreaker` in ./retry for why a call-site
 * closure here was the shape of the anonymous-breaker bug.
 */
async function vikunjaRestV2RequestRaw(
  authManager: AuthManager,
  method: HttpMethodV2,
  path: string,
  body: unknown,
  patchFormat: PatchFormat,
): Promise<unknown> {
  const session = authManager.getSession();
  const url = `${resolveV2BaseUrl(session.apiUrl)}${path}`;

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${session.apiToken}`,
        'Content-Type': resolveContentType(method, patchFormat),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch (error) {
    throw new MCPError(
      ErrorCode.API_ERROR,
      `Vikunja REST request failed (${method} ${path}): ${
        error instanceof Error ? error.message : String(error)
      }`,
      { transient: isTransientNetworkError(error) },
    );
  }

  if (!response.ok) {
    let rawBody = '';
    try {
      rawBody = await response.text();
    } catch {
      // Body could not be read — the adapter falls back to the status line.
    }
    throw parseVikunjaV2Error(
      method,
      path,
      response.status,
      response.statusText,
      response.headers.get('content-type'),
      rawBody,
    );
  }

  const text = await response.text();
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    // A 2xx response with a non-JSON body (rare) is treated as an empty result.
    return null;
  }
}

/**
 * Performs an authenticated request against the Vikunja **v2** REST API,
 * protected by a named circuit breaker and a bounded retry loop, with the
 * same retry policy as v1 (`defaultRestShouldRetry`: 5xx/429 and transient
 * network failures, never 4xx).
 *
 * Callers should not invoke this directly based on their own version
 * assumptions — route through `resolveApiVersion` in ./api-version so the
 * v1 fallback stays honest.
 *
 * @throws MCPError with `details.statusCode` set from the final attempt;
 *         for problem+json responses `details.vikunjaError` also carries
 *         Vikunja's numeric code and the per-field `errors[]` list.
 */
export async function vikunjaRestV2Request<T = unknown>(
  authManager: AuthManager,
  method: HttpMethodV2,
  path: string,
  body?: unknown,
  options?: VikunjaRestV2RequestOptions,
): Promise<T> {
  const breakerName = options?.breakerName ?? deriveRestV2BreakerName(path);
  const patchFormat: PatchFormat = options?.patchFormat ?? 'merge';
  const retryOptions: RetryOptions = {
    ...DEFAULT_V2_JSON_RETRY,
    shouldRetry: defaultRestShouldRetry,
    ...options?.retry,
  };
  const breaker = createCircuitBreaker(vikunjaRestV2RequestRaw, breakerName, retryOptions);
  const result = await withRetry(
    () =>
      breaker.fire(authManager, method, path, body, patchFormat).catch((error: unknown) => {
        throw rewordBreakerOpenError(error);
      }),
    retryOptions,
  );
  return result as T;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest tests/utils/vikunja-rest-v2.test.ts tests/utils/vikunja-rest.test.ts`
Expected: PASS — both the new v2 suite and the untouched v1 suite (the v1 suite proves the `export` keyword changed nothing).

- [ ] **Step 5: Commit**

```bash
git add src/utils/vikunja-rest-v2.ts src/utils/vikunja-rest.ts tests/utils/vikunja-rest-v2.test.ts
git commit -m "feat(v2): v2 REST request helper with merge-patch default (#184)

Same retry/breaker discipline as v1 under a distinct vikunja-rest-v2-
breaker prefix. The only change to vikunja-rest.ts is exporting
isTransientNetworkError so both transports share one transient-code list.

Claude-Session: https://claude.ai/code/session_013PagXz55C36TboMkNDGa7Q"
```

---

### Task 4: `forceV1Api` kill switch

Config schema, env override, synchronous accessor, and the user-facing docs for it.

**Files:**
- Modify: `src/config/types.ts:87-91` (`FeatureFlagsConfigSchema`)
- Modify: `src/config/ConfigurationManager.ts:389-399` (env wiring), and add `isV1Forced()` next to `isReadOnly()` at `:220-228`
- Modify: `vikunja-mcp.config.example.json`
- Modify: `docs/CONFIGURATION.md`
- Test: `tests/config/ConfigurationManager.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `ConfigurationManager.isV1Forced(): boolean`, config key `featureFlags.forceV1Api`, env var `VIKUNJA_MCP_FORCE_V1_API`.

- [ ] **Step 1: Write the failing test**

Append to `tests/config/ConfigurationManager.test.ts`, inside the top-level `describe`.

```typescript
  describe('forceV1Api kill switch', () => {
    afterEach(() => {
      delete process.env.VIKUNJA_MCP_FORCE_V1_API;
      ConfigurationManager.reset();
    });

    it('defaults to false when nothing sets it', () => {
      ConfigurationManager.reset();
      expect(ConfigurationManager.getInstance().isV1Forced()).toBe(false);
    });

    it('is enabled by the VIKUNJA_MCP_FORCE_V1_API env var', () => {
      process.env.VIKUNJA_MCP_FORCE_V1_API = 'true';
      ConfigurationManager.reset();
      expect(ConfigurationManager.getInstance().isV1Forced()).toBe(true);
    });

    it('is explicitly disabled by the env var set to false', () => {
      process.env.VIKUNJA_MCP_FORCE_V1_API = 'false';
      ConfigurationManager.reset();
      expect(ConfigurationManager.getInstance().isV1Forced()).toBe(false);
    });

    it('reads the value from a programmatic config source', () => {
      ConfigurationManager.reset();
      // ConfigLoadOptions.sources is a Record<string, unknown> merged as the
      // highest-priority layer — see src/config/types.ts:222-231.
      const manager = ConfigurationManager.getInstance({
        sources: { featureFlags: { forceV1Api: true } },
      });
      expect(manager.isV1Forced()).toBe(true);
    });
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/config/ConfigurationManager.test.ts -t forceV1Api`
Expected: FAIL — `manager.isV1Forced is not a function`

- [ ] **Step 3a: Add the schema field**

In `src/config/types.ts`, replace the `FeatureFlagsConfigSchema` definition with:

```typescript
export const FeatureFlagsConfigSchema = z.object({
  enableServerSideFiltering: z.boolean().default(true),
  enableAdvancedMetrics: z.boolean().default(false),
  enableExperimentalFeatures: z.boolean().default(false),
  // Kill switch for the v2 API fast path: when true, every operation uses
  // the v1 API even if this session's capability probe reported v2 support.
  // Config file key: `featureFlags.forceV1Api`. Env override:
  // `VIKUNJA_MCP_FORCE_V1_API` (env always wins, per standard layering).
  // Deliberately absent from ENVIRONMENT_PROFILES so it stays false in every
  // environment unless explicitly set. See src/utils/api-version.ts.
  forceV1Api: z.boolean().default(false),
});
```

- [ ] **Step 3b: Wire the env override**

In `src/config/ConfigurationManager.ts`, in the "Feature flag variables" block, add a second `assignEnvValue` before the `if (Object.keys(featureFlags).length > 0)` guard:

```typescript
    this.assignEnvValue(
      featureFlags,
      'forceV1Api',
      process.env.VIKUNJA_MCP_FORCE_V1_API,
      true
    );
```

- [ ] **Step 3c: Add the synchronous accessor**

In `src/config/ConfigurationManager.ts`, directly after `isReadOnly()`:

```typescript
  /**
   * Whether the v2 API fast path is force-disabled. Synchronous for the same
   * reason as `isReadOnly()` above: `loadConfiguration()` is synchronous and
   * cached after the first call, and `resolveApiVersion` sits on a
   * per-request path where an async config read would be a needless await.
   */
  public isV1Forced(): boolean {
    return this.loadConfiguration().featureFlags.forceV1Api;
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/config/ConfigurationManager.test.ts`
Expected: PASS (the whole config suite, including the four new cases)

- [ ] **Step 5: Document the setting**

In `vikunja-mcp.config.example.json`, add a `featureFlags` block between `modules` and `logging`:

```json
  "featureFlags": {
    "forceV1Api": false
  },
```

In `docs/CONFIGURATION.md`, add a subsection near the "Global Read-Only Safety Mode" section (which documents `readOnly` at `:335`, the closest precedent for wording):

```markdown
### Forcing the v1 API

The server detects once per session whether the Vikunja instance exposes the v2
API, and uses v2's `PATCH` routes for partial updates when it does. Set this to
force every operation onto the v1 API regardless of what was detected.

- **Config file key**: `featureFlags.forceV1Api` (boolean, default `false`)
- **Env override**: `VIKUNJA_MCP_FORCE_V1_API` (`true`/`false`) — as with every
  other setting, the environment variable wins over the config file.

```
VIKUNJA_MCP_FORCE_V1_API=true
```

With this set, behaviour is identical to running against a v1-only Vikunja
server (2.3.0 and earlier). `vikunja_auth status` reports `activeApiVersion:
"v1"`. Use it to rule the v2 path out when diagnosing a problem, or to pin
behaviour if a v2 route misbehaves on your server.
```

- [ ] **Step 6: Verify docs and config are valid, then commit**

Run: `node -e "JSON.parse(require('fs').readFileSync('vikunja-mcp.config.example.json','utf8')); console.log('valid json')"`
Expected: `valid json`

```bash
git add src/config/types.ts src/config/ConfigurationManager.ts tests/config/ConfigurationManager.test.ts vikunja-mcp.config.example.json docs/CONFIGURATION.md
git commit -m "feat(v2): forceV1Api kill switch with env override (#184)

Config key featureFlags.forceV1Api plus VIKUNJA_MCP_FORCE_V1_API, read
through a synchronous isV1Forced() accessor following the isReadOnly()
precedent.

Claude-Session: https://claude.ai/code/session_013PagXz55C36TboMkNDGa7Q"
```

---

### Task 5: `resolveApiVersion` routing decision point

The single place that decides v1 vs v2. Its own module: the decision depends on config and session capabilities, and keeping it out of the transport avoids coupling the transport to `ConfigurationManager`.

**Files:**
- Create: `src/utils/api-version.ts`
- Test: `tests/utils/api-version.test.ts`

**Interfaces:**
- Consumes: `ConfigurationManager.isV1Forced()` from Task 4; `AuthManager.getCapabilities()` (existing, `src/auth/AuthManager.ts:132-134`).
- Produces: `type ApiVersion = 'v1' | 'v2'` and `resolveApiVersion(authManager: AuthManager): ApiVersion`.

- [ ] **Step 1: Write the failing test**

Create `tests/utils/api-version.test.ts`:

```typescript
/**
 * Tests for the v1/v2 routing decision point (src/utils/api-version.ts).
 */

import { describe, it, expect, afterEach, beforeEach } from '@jest/globals';
import { resolveApiVersion } from '../../src/utils/api-version';
import { AuthManager } from '../../src/auth/AuthManager';
import { ConfigurationManager } from '../../src/config/ConfigurationManager';

describe('resolveApiVersion', () => {
  let authManager: AuthManager;

  beforeEach(() => {
    ConfigurationManager.reset();
    authManager = new AuthManager();
    authManager.connect('https://vikunja.test', 'tk_test-token');
  });

  afterEach(() => {
    delete process.env.VIKUNJA_MCP_FORCE_V1_API;
    ConfigurationManager.reset();
  });

  it('returns v2 when the session cached hasV2Api: true', () => {
    authManager.setCapabilities({ features: {}, hasV2Api: true, serverVersion: '2.4.0' });

    expect(resolveApiVersion(authManager)).toBe('v2');
  });

  it('returns v1 when the session cached hasV2Api: false', () => {
    authManager.setCapabilities({ features: {}, hasV2Api: false, serverVersion: '2.3.0' });

    expect(resolveApiVersion(authManager)).toBe('v1');
  });

  // Capabilities are populated during connect/info and cleared on
  // disconnect, so an uninitialized session must fall back rather than
  // assume v2.
  it('returns v1 when no capability snapshot has been cached', () => {
    expect(authManager.getCapabilities()).toBeUndefined();
    expect(resolveApiVersion(authManager)).toBe('v1');
  });

  it('returns v1 for an unauthenticated manager', () => {
    expect(resolveApiVersion(new AuthManager())).toBe('v1');
  });

  it('returns v1 when the kill switch is set despite a v2-capable server', () => {
    process.env.VIKUNJA_MCP_FORCE_V1_API = 'true';
    ConfigurationManager.reset();
    authManager.setCapabilities({ features: {}, hasV2Api: true, serverVersion: '2.4.0' });

    expect(resolveApiVersion(authManager)).toBe('v1');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/utils/api-version.test.ts`
Expected: FAIL — `Cannot find module '../../src/utils/api-version'`

- [ ] **Step 3: Write minimal implementation**

Create `src/utils/api-version.ts`:

```typescript
/**
 * The single decision point for whether an operation runs against Vikunja's
 * v1 or v2 API.
 *
 * v1 is the permanent backward-compatible floor: the minimum supported
 * Vikunja is 2.3.0, which has no v2 API at all, and self-hosters lag. So
 * every branch here defaults to v1 and only opts into v2 on positive
 * evidence — a cached capability probe that actually got a 2xx from
 * `GET /api/v2/openapi.json` (see ./capabilities).
 *
 * Deliberately synchronous and free of network calls: capabilities are
 * detected once per session and cached on it, and this sits on a
 * per-request path.
 */

import type { AuthManager } from '../auth/AuthManager';
import { ConfigurationManager } from '../config/ConfigurationManager';

export type ApiVersion = 'v1' | 'v2';

/**
 * Resolves which API version this session should use.
 *
 * Returns `'v2'` only when the kill switch is off AND the session has a
 * cached capability snapshot reporting v2 support; `'v1'` otherwise,
 * including for sessions that have not been through capability detection.
 */
export function resolveApiVersion(authManager: AuthManager): ApiVersion {
  if (ConfigurationManager.getInstance().isV1Forced()) {
    return 'v1';
  }

  const capabilities = authManager.getCapabilities();
  if (capabilities === undefined) {
    return 'v1';
  }

  return capabilities.hasV2Api ? 'v2' : 'v1';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/utils/api-version.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/utils/api-version.ts tests/utils/api-version.test.ts
git commit -m "feat(v2): resolveApiVersion routing decision point (#184)

Synchronous, cached-capability-driven, defaults to v1 on every path that
is not positive evidence of v2 support.

Claude-Session: https://claude.ai/code/session_013PagXz55C36TboMkNDGa7Q"
```

---

### Task 6: report the active API version from `vikunja_auth`

Makes the routing decision — and the kill switch's effect on it — observable before any operation depends on it. This is the only caller of `resolveApiVersion` in this phase.

**Files:**
- Modify: `src/tools/auth.ts` — `connect` (`:165-177`), `status` (`:184-194`), `info` (`:277-290`)
- Modify: `tests/tools/auth.test.ts:432-451` (replace a test that pins the opposite behaviour — see Step 1a)
- Test: `tests/tools/auth.test.ts`

**Interfaces:**
- Consumes: `resolveApiVersion` from Task 5.
- Produces: `activeApiVersion: 'v1' | 'v2'` in the response metadata of `vikunja_auth connect`, `status`, and `info`; plus `hasV2Api` in `connect`'s metadata (previously omitted).

**Test conventions in this file (read before writing):** responses are Markdown, asserted via
`result.content[0].text` with `toContain`. Subcommands are invoked through the local
`callTool(subcommand, args)` helper (`:68-73`). The auth manager is a `MockAuthManager` of plain
`jest.fn()`s (`:102-113`) — it already includes `getCapabilities`, which returns `undefined` by
default. `getOrDetectCapabilities` is mocked at the module level (`:57-60`).

- [ ] **Step 1a: Replace the test that pins the old `connect` behaviour**

`tests/tools/auth.test.ts:432` currently asserts the opposite of what this task implements:

```typescript
    it('should not surface hasV2Api in the connect response (only status/info do)', async () => {
      // ...
      expect(result.content[0].text).not.toContain('hasV2Api');
    });
```

That expectation was correct when written (#149 deliberately limited reporting to `status`/`info`),
but this task intentionally changes it: `connect` is the subcommand that triggers first detection,
so hiding the result there was a gap. Replace the whole test with:

```typescript
    it('should surface hasV2Api and activeApiVersion in the connect response', async () => {
      // Changed by #184 P2: connect triggers the first capability detection,
      // so it now reports the result and which API version that resolves to.
      // This replaces an earlier test that pinned connect as NOT surfacing
      // hasV2Api (correct under #149, superseded here).
      mockAuthManager.getStatus.mockReturnValue({ authenticated: false });
      mockAuthManager.getAuthType.mockReturnValue('api-token');
      mockAuthManager.getCapabilities.mockReturnValue({
        serverVersion: '1.2.3',
        features: { version: '1.2.3' },
        hasV2Api: true,
      });
      mockGetOrDetectCapabilities.mockResolvedValue({
        serverVersion: '1.2.3',
        features: { version: '1.2.3' },
        hasV2Api: true,
      });

      const result = await callTool('connect', {
        apiUrl: 'https://vikunja.example.com',
        apiToken: 'tk_test-token-123',
      });

      expect(result.content[0].text).toContain('hasV2Api');
      expect(result.content[0].text).toMatch(/activeApiVersion\W+v2/);
    });
```

- [ ] **Step 1b: Write the remaining failing tests**

Append to `tests/tools/auth.test.ts` inside the top-level `describe('Auth Tool')`. `ConfigurationManager`
is already imported at `:11`.

```typescript
  describe('active API version reporting', () => {
    afterEach(() => {
      delete process.env.VIKUNJA_MCP_FORCE_V1_API;
      ConfigurationManager.reset();
    });

    it('reports v2 from status when the session is v2-capable', async () => {
      mockAuthManager.getStatus.mockReturnValue({
        authenticated: true,
        apiUrl: 'https://vikunja.example.com',
        hasV2Api: true,
      });
      mockAuthManager.getCapabilities.mockReturnValue({
        serverVersion: '2.4.0',
        features: {},
        hasV2Api: true,
      });

      const result = await callTool('status');

      expect(result.content[0].text).toMatch(/activeApiVersion\W+v2/);
    });

    it('reports v1 from status when the session is not v2-capable', async () => {
      mockAuthManager.getStatus.mockReturnValue({
        authenticated: true,
        apiUrl: 'https://vikunja.example.com',
        hasV2Api: false,
      });
      mockAuthManager.getCapabilities.mockReturnValue({
        serverVersion: '2.3.0',
        features: {},
        hasV2Api: false,
      });

      const result = await callTool('status');

      expect(result.content[0].text).toMatch(/activeApiVersion\W+v1/);
    });

    it('omits activeApiVersion when not authenticated', async () => {
      mockAuthManager.getStatus.mockReturnValue({ authenticated: false });

      const result = await callTool('status');

      expect(result.content[0].text).not.toContain('activeApiVersion');
    });

    it('reports v1 from status when the kill switch overrides a v2-capable server', async () => {
      process.env.VIKUNJA_MCP_FORCE_V1_API = 'true';
      ConfigurationManager.reset();
      mockAuthManager.getStatus.mockReturnValue({
        authenticated: true,
        apiUrl: 'https://vikunja.example.com',
        hasV2Api: true,
      });
      mockAuthManager.getCapabilities.mockReturnValue({
        serverVersion: '2.4.0',
        features: {},
        hasV2Api: true,
      });

      const result = await callTool('status');

      // The server's capability is still reported honestly...
      expect(result.content[0].text).toContain('hasV2Api');
      // ...but the active path is forced back to v1.
      expect(result.content[0].text).toMatch(/activeApiVersion\W+v1/);
    });

    it('reports activeApiVersion from info', async () => {
      mockAuthManager.isAuthenticated.mockReturnValue(true);
      mockAuthManager.getCapabilities.mockReturnValue({
        serverVersion: '2.4.0',
        features: {},
        hasV2Api: true,
      });
      mockGetOrDetectCapabilities.mockResolvedValue({
        serverVersion: '2.4.0',
        features: { version: '2.4.0' },
        hasV2Api: true,
      });

      const result = await callTool('info');

      expect(result.content[0].text).toMatch(/activeApiVersion\W+v2/);
    });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest tests/tools/auth.test.ts -t "active API version"`
Expected: FAIL — the rendered response contains no `activeApiVersion`.

Run: `npx jest tests/tools/auth.test.ts -t "surface hasV2Api and activeApiVersion in the connect"`
Expected: FAIL — `connect` does not yet render `hasV2Api`.

- [ ] **Step 3: Wire it into the three subcommands**

In `src/tools/auth.ts`, add the import:

```typescript
import { resolveApiVersion } from '../utils/api-version';
```

In the `connect` case, replace the metadata object of the `createStandardResponse` call with:

```typescript
              {
                apiUrl: args.apiUrl,
                authType: authManager.getAuthType(),
                ...(capabilities.serverVersion !== undefined
                  ? { serverVersion: capabilities.serverVersion }
                  : {}),
                hasV2Api: capabilities.hasV2Api,
                activeApiVersion: resolveApiVersion(authManager),
              },
```

In the `status` case, replace the metadata argument with:

```typescript
              status.authenticated
                ? {
                    apiUrl: status.apiUrl,
                    activeApiVersion: resolveApiVersion(authManager),
                  }
                : undefined,
```

In the `info` case, add one line to the metadata object after `hasV2Api`:

```typescript
                activeApiVersion: resolveApiVersion(authManager),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest tests/tools/auth.test.ts`
Expected: PASS (the whole auth suite — existing assertions on `connect`/`status`/`info` metadata must still hold, since fields were only added)

- [ ] **Step 5: Commit**

```bash
git add src/tools/auth.ts tests/tools/auth.test.ts
git commit -m "feat(v2): report activeApiVersion from vikunja_auth (#184)

connect/status/info now surface which API version this session routes
through, including when the kill switch overrides a v2-capable server.
connect also reports hasV2Api, which it previously omitted despite being
the subcommand that triggers detection.

Claude-Session: https://claude.ai/code/session_013PagXz55C36TboMkNDGa7Q"
```

---

### Task 7: full gates and the live check

Mocked tests provably miss this class of bug — the 0.6.1 lesson. A hand-written `problem+json` fixture is not evidence that the adapter matches what Vikunja 2.4.0 actually sends.

**Files:**
- Modify: none expected (fix whatever the gates surface)

**Interfaces:**
- Consumes: everything from Tasks 1–6.
- Produces: verified evidence that the phase is complete.

- [ ] **Step 1: Run the full pre-commit gate**

Run: `npm run lint && npm run typecheck && npm run test:coverage`
Expected: all three pass; coverage at or above 92 lines / 83 branches / 82 functions / 92 statements.

If coverage dropped below the ratchet, add tests for the uncovered branches — do not lower the thresholds.

- [ ] **Step 2: Confirm the v1 path is untouched**

Run: `git diff main --stat -- src/utils/vikunja-rest.ts`
Expected: exactly 1 insertion and 1 deletion (the `export` keyword on `isTransientNetworkError`).

Run: `npx jest tests/utils/vikunja-rest.test.ts`
Expected: PASS with no test file modifications.

- [ ] **Step 3: Live check against Vikunja 2.4.0**

Against a real 2.4.0 server (the same stack `npm run test:mcp` targets), verify in a scratch script or REPL:

1. `resolveApiVersion` returns `'v2'` for a connected session — confirms the probe and routing agree with reality.
2. A successful v2 `GET` through `vikunjaRestV2Request` returns a parsed body from the resolved `/api/v2` base URL.
3. A deliberately failing v2 request (e.g. `GET /tasks/999999999` for a nonexistent task) produces an `MCPError` whose `details.vikunjaError.code` is a real Vikunja numeric code and whose `details.statusCode` matches the HTTP status.
4. With `VIKUNJA_MCP_FORCE_V1_API=true`, `resolveApiVersion` returns `'v1'` against that same v2-capable server.

Record the actual observed `problem+json` body from step 3 in the commit message or PR description. If it differs in shape from the fixtures in `tests/utils/vikunja-rest-v2.test.ts`, update those fixtures to match reality and re-run the suite — the real payload is the source of truth, not the vendored spec.

- [ ] **Step 4: Confirm no operation changed behaviour**

Run: `npm run test:mcp`
Expected: PASS. No tool routes through v2 yet, so results must be identical to `main`.

- [ ] **Step 5: Commit any fixes and open the PR**

```bash
git add -A
git commit -m "test(v2): align problem+json fixtures with live 2.4.0 responses (#184)

Claude-Session: https://claude.ai/code/session_013PagXz55C36TboMkNDGa7Q"
```

Then open a PR against `main` (fork only — never upstream) describing: what P1+P2 delivered, the live-check evidence from Step 3, and that P3 (per-endpoint fast paths) is the follow-on.

---

## Out of scope for this plan

These are P3–P5 of #184 and belong to later specs:

- Routing any actual operation through v2 (`vikunja_tasks update`, `vikunja_task_bulk bulk-update`, projects/views/labels/filters/comments/teams updates).
- Retiring the assignee snapshot/restore workaround in `src/tools/tasks/bulk-operations-simplified.ts:245-312`.
- Response-shape normalization (the `$schema` field, pagination envelopes) — deferred to P3 and must be verified against the live stack, not the spec. Nothing consumes a v2 response body in this phase.
- The battle-harness call-count re-baseline, `npm run test:matrix` against both 2.3.0 and 2.4.0, and the 0.7.0 release itself.
- Buckets stay on v1 permanently for now: v2 has no `PATCH` for `/projects/{project}/views/{view}/buckets/{bucket}`.
