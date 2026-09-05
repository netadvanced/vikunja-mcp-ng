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

import { MCPError, ErrorCode } from '../types';
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
import { resolveV2BaseUrl } from './vikunja-v2-url';

/**
 * Resolves the v2 API base URL for a session, normalizing whether or not
 * `apiUrl` already carries an `/api/v{n}` suffix (depends on how
 * `VIKUNJA_URL` was configured). Mirrors `resolveBaseUrl` in
 * `./vikunja-rest`, but targets v2 and replaces — rather than preserves —
 * an existing version suffix, matching `resolveV2ProbeUrl` in
 * `./capabilities`.
 *
 * Re-exported from `./vikunja-v2-url`, the shared implementation both this
 * module and `./capabilities` import — see that module's doc comment for why
 * it isn't defined in either consumer directly.
 */
export { resolveV2BaseUrl };

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
 *
 * Namespace constraint: v1 and v2 breaker names share one flat registry keyed
 * purely by string, so this scheme only avoids collisions because
 * `deriveRestBreakerName` (v1) never itself produces a `vikunja-rest-v2-...`
 * name. If a v1 request path's first non-numeric segment were ever literally
 * `v2` (e.g. a hypothetical v1 route `/v2/...`), it would derive
 * `vikunja-rest-v2-...` and collide with this namespace. No such v1 path
 * exists today — just don't introduce one without revisiting this.
 */
export function deriveRestV2BreakerName(path: string): string {
  const segments = path.split('/').filter((seg) => seg.length > 0 && !/^\d+$/.test(seg));
  const group = segments.slice(0, 2).join('-') || 'root';
  return `vikunja-rest-v2-${group}`;
}

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
    .map((entry) => {
      const location = readString(entry.location);
      const message = readString(entry.message);
      const detail: ParsedErrorDetail = { value: entry.value };
      if (location !== undefined) {
        detail.location = location;
      }
      if (message !== undefined) {
        detail.message = message;
      }
      return detail;
    });
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
      const rawSuffix = [summary, fieldSuffix].filter((part) => part.length > 0).join(' ');
      // Bounds the composed suffix the same way buildFallbackError bounds its
      // raw body: a server or proxy can return an oversized `detail` or an
      // `errors[]` list with thousands of entries, and without this cap that
      // would produce an unbounded MCP error message.
      const suffix = rawSuffix.slice(0, MAX_FALLBACK_BODY_LENGTH);
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

/** Which RFC the PATCH request body follows. v2 accepts both on every PATCH route. */
export type PatchFormat = 'merge' | 'json-patch';

/**
 * Extends `VikunjaRestRequestOptions` (v1's option shape) rather than
 * defining an unrelated interface, which means a `VikunjaRestV2RequestOptions`
 * object — including one carrying `patchFormat` — is structurally assignable
 * to v1's `vikunjaRestRequest`. v1 has no notion of PATCH body format and
 * will silently ignore `patchFormat` if passed to it. That is harmless today
 * only because nothing routes through v2 yet (this phase wires up no
 * operation). In P3, if a call site builds one options object and passes it
 * to whichever transport `resolveApiVersion` picks, an accidental v1 fallback
 * carrying `patchFormat: 'json-patch'` would silently send a JSON-Patch array
 * body to v1's full-model POST/PUT — a corrupt update, not an error. Callers
 * must construct/pass options per-transport rather than sharing one object
 * across both.
 */
export interface VikunjaRestV2RequestOptions extends VikunjaRestRequestOptions {
  /**
   * Request body format for PATCH calls. `'merge'` (RFC 7386
   * merge-patch+json, the default) matches the shape of our tool arguments;
   * `'json-patch'` (RFC 6902) is the only way to express true array
   * operations such as removing a single assignee. Ignored for other methods.
   *
   * v1-unaware: `vikunjaRestRequest` (v1) accepts a `VikunjaRestRequestOptions`
   * and has no `patchFormat` concept — if this field is ever passed through to
   * v1 (e.g. via a shared options object in a future per-endpoint migration),
   * it is silently ignored there rather than rejected. See the interface doc
   * comment above for the concrete P3 failure mode.
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
