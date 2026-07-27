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
