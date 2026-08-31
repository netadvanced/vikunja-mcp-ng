/**
 * Direct REST helper for Vikunja API endpoints not covered by legacy client.
 *
 * legacy client (the typed client this MCP server wraps) does not expose the
 * Kanban view endpoints — listing the buckets of a view, or placing a task
 * into a bucket. Those operations therefore call the Vikunja REST API
 * directly, reusing the credentials of the active authenticated session.
 *
 * Unlike the legacy client call paths (which get retry protection via
 * `withRetry` at each call site), this helper previously had none at all —
 * a single dropped connection or transient 502 failed the whole operation.
 * Every request made through `vikunjaRestRequest`/`vikunjaRestMultipartRequest`
 * now goes through a retry loop plus a NAMED opossum circuit breaker, one
 * breaker per endpoint group (derived from the request path, e.g.
 * `/webhooks/events` -> `vikunja-rest-webhooks-events`). Breakers are process
 * -wide and keyed by name via the shared registry in `./retry`, so sharing a
 * name across unrelated endpoints would let one endpoint's failures trip the
 * breaker for another's — the automatic per-path derivation exists
 * specifically to avoid that. See `createCircuitBreaker` in `./retry` for
 * why the action passed to the breaker must be a stable function reference
 * (not a call-site closure): that was the shape of the anonymous-breaker bug
 * fixed in the wave0 baseline, where a shared breaker kept re-firing the
 * first closure ever registered under a name instead of the current call's.
 */

import type { AuthManager } from '../auth/AuthManager';
import { MCPError, ErrorCode } from '../types';
import {
  createCircuitBreaker,
  withRetry,
  isRetryableError,
  rewordBreakerOpenError,
  type RetryOptions,
} from './retry';
import { resolveIdentityAuthManager } from '../context/requestContext';
import { redactSecretsInText } from './security';

type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/**
 * How much of an upstream error body is scanned for credentials before it is
 * truncated for display. Redaction has to run on more text than we keep,
 * otherwise a secret straddling the 500-character display cut would have its
 * tail removed and its head kept, leaving a partial credential that no pattern
 * matches any more. Scanning 4 KiB is cheap and covers every realistic
 * Vikunja/proxy error body.
 */
const ERROR_BODY_SCAN_LIMIT = 4096;

/** How much of the (already redacted) error body is shown to the caller. */
const ERROR_BODY_DISPLAY_LIMIT = 500;

/**
 * Prepares untrusted upstream text for interpolation into an
 * `MCPError.message`.
 *
 * The response body of a failed request is authored by something we do not
 * control: Vikunja itself, but also any reverse proxy, WAF, or auth gateway
 * in front of it. Those routinely echo request details back, including the
 * `Authorization` header or a query string, so the body can carry the
 * caller's own credential. Before this existed the body's first 500
 * characters went straight into the error message, which the MCP client sees:
 * audit #292 MED-18. It runs through the same `redactSecretsInText` pass as
 * the logger and the thrown-error sanitizer, so there is a single definition
 * of what counts as a secret.
 *
 * @param text - Raw upstream text (response body, or a network error message)
 * @param limit - Maximum length of the returned string
 * @returns The text with credentials redacted, truncated to `limit`
 */
function redactUpstreamText(text: string, limit = ERROR_BODY_DISPLAY_LIMIT): string {
  return redactSecretsInText(text.slice(0, ERROR_BODY_SCAN_LIMIT)).slice(0, limit);
}

/**
 * Same treatment for the message of a failure thrown by `fetch` itself, which
 * embeds the request URL and can therefore carry userinfo credentials.
 */
function describeRequestError(error: unknown): string {
  return redactUpstreamText(
    error instanceof Error ? error.message : String(error),
    ERROR_BODY_SCAN_LIMIT,
  );
}

/**
 * Resolves the EFFECTIVE `AuthManager` for a request, closing the
 * credential-threading gap (docs/OIDC-RESOURCE-SERVER.md §3d, D6).
 *
 * The problem this fixes: most tool handlers capture the process-global
 * `AuthManager` as a closure parameter at `registerTools()` time and pass
 * *that* straight into `vikunjaRestRequest(authManager, ...)`, even though in
 * `oidc-http` mode the credential that should be used lives on the
 * per-identity `AuthManager` bound in the ALS `RequestContext` for this
 * request — not on the global closure manager (which, in `oidc-http` mode,
 * is never authenticated). Fixing this at every call site would mean editing
 * dozens of handlers and forever policing new ones; fixing it here, once, at
 * the single choke point every REST call already funnels through, makes the
 * whole tool surface identity-correct for free.
 *
 * Rule:
 *  - When an ALS `RequestContext` is bound (`oidc-http` mode, one scope per
 *    request), its per-identity `authManager` is authoritative and the passed
 *    closure manager is ignored. Two concurrent identities therefore each send
 *    their OWN vaulted token, never the process global's.
 *  - Otherwise (`stdio` mode — which NEVER opens an ALS scope) the passed
 *    manager is used unchanged, so stdio behaviour is byte-for-byte identical.
 *  - `options.ignoreRequestContext` forces the passed manager to win even
 *    inside an ALS scope. Exactly one caller needs this: `vikunja_auth
 *    provision`'s pre-store token validation (`verifyConnection`), which must
 *    probe Vikunja with a *throwaway* manager holding the not-yet-stored
 *    candidate token, NOT the calling identity's still-unprovisioned ALS
 *    manager.
 */
function resolveEffectiveAuthManager(
  authManager: AuthManager,
  options?: VikunjaRestRequestOptions,
): AuthManager {
  if (options?.ignoreRequestContext) {
    return authManager;
  }
  // Same one rule the capability/auth-type gates use (#270/#282) — see
  // `resolveIdentityAuthManager`'s doc comment.
  return resolveIdentityAuthManager(authManager);
}

/**
 * Resolves the API base URL for a session, normalizing whether or not
 * `apiUrl` already includes the `/api/v{n}` prefix (depends on how
 * `VIKUNJA_URL` was configured).
 */
export function resolveBaseUrl(apiUrl: string): string {
  const trimmed = apiUrl.replace(/\/+$/, '');
  return /\/api\/v\d+$/.test(trimmed) ? trimmed : `${trimmed}/api/v1`;
}

/**
 * Derives a stable, endpoint-group-scoped circuit breaker name from a
 * request path, e.g. `/projects/4/webhooks` -> `vikunja-rest-projects-webhooks`,
 * `/webhooks/events` -> `vikunja-rest-webhooks-events`, `/tasks/7` ->
 * `vikunja-rest-tasks`. Numeric path segments (ids) are dropped so that
 * calls against different resource instances of the same endpoint group
 * still share one breaker; only the first two non-numeric segments are used
 * so deeply nested paths still collapse to a reasonably-scoped group rather
 * than a breaker-per-exact-path (which would defeat the point of tracking a
 * rolling failure window).
 */
export function deriveRestBreakerName(path: string): string {
  const segments = path.split('/').filter((seg) => seg.length > 0 && !/^\d+$/.test(seg));
  const group = segments.slice(0, 2).join('-') || 'root';
  return `vikunja-rest-${group}`;
}

/**
 * Default retry/backoff tuning for JSON REST calls. Deliberately modest —
 * this is a fallback safety net for transient failures, not a substitute
 * for a caller thinking about idempotency. Overridable per call via
 * `VikunjaRestRequestOptions.retry`. Note this predicate-free base is paired
 * with `defaultRestShouldRetry` for idempotent methods only; resource-
 * creating requests use {@link DEFAULT_CREATE_RETRY} instead.
 */
const DEFAULT_JSON_RETRY: RetryOptions = {
  maxRetries: 2,
  initialDelay: 250,
  maxDelay: 2000,
  backoffFactor: 2,
};

/**
 * Multipart uploads default to NO automatic retry: Vikunja's attachment
 * endpoint is additive (each successful PUT adds another attachment), so
 * blindly resending after an ambiguous failure (e.g. the server received
 * the file but the response was lost) risks silently duplicating the
 * attachment. Callers that know their upload is safe to retry (e.g. a
 * network error observed before any bytes were sent) can opt in via
 * `options.retry.maxRetries`. The circuit breaker still applies, so a
 * persistently failing endpoint fails fast rather than hanging every call.
 */
const DEFAULT_MULTIPART_RETRY: RetryOptions = {
  maxRetries: 0,
};

/**
 * Node/undici system error codes that indicate a connection-level failure
 * worth retrying (as opposed to e.g. a validation or programming error).
 * `fetch()` failures typically surface as `TypeError: fetch failed` with the
 * real cause nested in `.cause` — checked below alongside `.code` — rather
 * than as a directly-coded Error, so the code must look in both places.
 */
const TRANSIENT_NETWORK_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ENOTFOUND',
  'ENETUNREACH',
  'EAI_AGAIN',
  'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
]);

/**
 * The subset of {@link TRANSIENT_NETWORK_CODES} that PROVES the request was
 * never delivered: the connection was refused, the host never resolved, the
 * network was unreachable, or the TCP/TLS handshake itself timed out. In all
 * of those cases no request bytes ever reached the application, so the server
 * cannot have committed anything — which makes them safe to retry even for a
 * non-idempotent write (see {@link shouldRetryNonIdempotentWrite}).
 *
 * Codes that can only fire AFTER a connection exists (ECONNRESET, ETIMEDOUT,
 * EPIPE, the undici header/body timeouts) are deliberately EXCLUDED: from the
 * client's side those are indistinguishable from "the server committed the
 * write and the response was lost on the way back".
 */
const PRE_REQUEST_NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'ENETUNREACH',
  'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT',
]);

/**
 * Reads a system error code off an Error, checking both `.code` and the
 * nested `.cause.code` where undici parks the real cause of a
 * `TypeError: fetch failed`, and reports whether it is in `codes`.
 */
function hasNetworkCode(error: Error, codes: Set<string>): boolean {
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'string' && codes.has(code)) {
    return true;
  }
  const cause = (error as { cause?: unknown }).cause;
  if (cause && typeof cause === 'object' && 'code' in cause) {
    const causeCode = (cause as { code?: unknown }).code;
    if (typeof causeCode === 'string' && codes.has(causeCode)) {
      return true;
    }
  }
  return false;
}

/**
 * Whether a caught network-layer error is one of the
 * {@link PRE_REQUEST_NETWORK_CODES} — i.e. the request provably never
 * reached the server. Threaded to retry predicates via
 * `MCPErrorDetails.preRequest` for the same reason as `transient`: wrapping
 * the error into an MCPError discards the original `.code`/`.cause.code`.
 */
function isPreRequestNetworkError(error: unknown): boolean {
  return error instanceof Error && hasNetworkCode(error, PRE_REQUEST_NETWORK_CODES);
}

/**
 * Determines whether a caught network-layer error (i.e. `fetch()` itself
 * rejected, before any HTTP response was received) looks transient and
 * therefore worth retrying. Checked BEFORE the error is wrapped into an
 * MCPError, because wrapping discards the original `.code`/`.cause.code` —
 * a plain `new MCPError(..., formattedMessage)` has no such property, so a
 * retry predicate consulted only the wrapped error would silently never
 * retry any real network failure. The result is threaded through via
 * `MCPErrorDetails.transient` so `defaultRestShouldRetry` can use it later.
 */
function isTransientNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  if (hasNetworkCode(error, TRANSIENT_NETWORK_CODES)) {
    return true;
  }
  return isRetryableError(error);
}

/**
 * Default retry predicate for the REST helper: retries HTTP 5xx/429
 * responses and network-level failures that look transient, but never 4xx
 * client errors — retrying a 401/403/404 wastes the latency budget without
 * changing the outcome (see docs/VIKUNJA_API_ISSUES.md #8: `/webhooks/events`
 * is known to return 401 with an otherwise-valid token on some server
 * configurations, so callers like `getValidEvents` depend on failing fast
 * into their fallback rather than retrying a doomed request).
 */
export function defaultRestShouldRetry(error: unknown): boolean {
  if (error instanceof MCPError) {
    const statusCode = error.details?.statusCode;
    if (statusCode !== undefined) {
      return statusCode >= 500 || statusCode === 429;
    }
    if (error.details?.transient !== undefined) {
      return error.details.transient;
    }
  }
  return isRetryableError(error);
}

/**
 * Retry predicate for NON-IDEMPOTENT writes — the requests that CREATE a new
 * resource, where a repeat produces a SECOND resource rather than converging
 * on the same one.
 *
 * We do NOT retry an ambiguous failure on a create because a 5xx (or a
 * connection dropped mid-flight) does not tell us whether the write
 * committed: a proxy timeout, an LB reset, or a gateway 502 raised *after*
 * Vikunja persisted the row all look identical from here, and resending
 * then silently produces a duplicate task/project/label/comment. The same
 * reasoning already governs `DEFAULT_MULTIPART_RETRY` above (an attachment
 * upload is additive, so it never auto-retries). Losing the retry is a
 * bounded availability cost — the caller sees an error and can decide, after
 * checking, whether to create again — while a duplicate is silent data
 * corruption the caller never learns about.
 *
 * Two classes of failure ARE still retried, because in both the server
 * provably did no work:
 *  - HTTP 429: the request was rejected by the rate limiter before reaching
 *    any handler, so nothing was created. Retrying is the whole point of a
 *    429, and creates are exactly the calls that hit it (bulk imports).
 *  - `MCPErrorDetails.preRequest`: the connection was refused / never
 *    resolved / never completed its handshake, so no request bytes were sent
 *    (see {@link PRE_REQUEST_NETWORK_CODES}).
 *
 * Revisit if either premise changes: if Vikunja ever supports an idempotency
 * key on creates (`Idempotency-Key` header or equivalent), the ambiguity
 * disappears and creates can safely retry 5xx again.
 */
export function shouldRetryNonIdempotentWrite(error: unknown): boolean {
  if (error instanceof MCPError) {
    const statusCode = error.details?.statusCode;
    if (statusCode !== undefined) {
      return statusCode === 429;
    }
    return error.details?.preRequest === true;
  }
  // Anything with no status and no pre-request marker (including the
  // circuit-breaker-open error, a plain Error) is treated as ambiguous.
  return false;
}

/**
 * Retry defaults for resource-CREATING requests: same modest backoff as
 * {@link DEFAULT_JSON_RETRY}, but gated by
 * {@link shouldRetryNonIdempotentWrite} so an ambiguous failure is never
 * repeated. Applied automatically by `vikunjaRestRequest` — see the comment
 * at its `isResourceCreatingWrite` branch for why that decision lives at the
 * choke point rather than at each create call site.
 */
const DEFAULT_CREATE_RETRY: RetryOptions = {
  ...DEFAULT_JSON_RETRY,
  shouldRetry: shouldRetryNonIdempotentWrite,
};

export interface VikunjaRestRequestOptions {
  /**
   * Overrides the automatically-derived circuit breaker name for this call.
   * Only specify this to deliberately share (or split) failure accounting
   * across paths — an explicit name still MUST identify a real, unique
   * endpoint group, never be reused across unrelated operations.
   */
  breakerName?: string;
  /** Overrides merged over this helper's default retry/backoff settings. */
  retry?: RetryOptions;
  /**
   * Forces the explicitly-passed `AuthManager` to be used even when an ALS
   * `RequestContext` is bound — bypassing the per-identity manager the
   * central {@link resolveEffectiveAuthManager} would otherwise substitute.
   * The ONLY intended caller is `vikunja_auth provision`'s `verifyConnection`
   * probe, which must validate a throwaway candidate token rather than the
   * calling identity's (still unprovisioned) ALS credential. Leave unset
   * everywhere else so identity threading stays automatic.
   */
  ignoreRequestContext?: boolean;
}

/**
 * The actual network call, with no retry/breaker logic of its own. This is
 * intentionally a plain top-level function (not a closure factory) so it
 * can be safely registered once per breaker name and re-fired with fresh
 * arguments on every call — see the module doc comment above.
 */
async function vikunjaRestRequestRaw(
  authManager: AuthManager,
  method: HttpMethod,
  path: string,
  body: unknown,
): Promise<unknown> {
  const session = authManager.getSession();
  const url = `${resolveBaseUrl(session.apiUrl)}${path}`;

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${session.apiToken}`,
        'Content-Type': 'application/json',
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch (error) {
    throw new MCPError(
      ErrorCode.API_ERROR,
      `Vikunja REST request failed (${method} ${path}): ${describeRequestError(error)}`,
      {
        transient: isTransientNetworkError(error),
        preRequest: isPreRequestNetworkError(error),
      },
    );
  }

  if (!response.ok) {
    let detail = '';
    try {
      detail = redactUpstreamText(await response.text());
    } catch {
      // Body could not be read — fall back to the status line only.
    }
    const httpError = new MCPError(
      ErrorCode.API_ERROR,
      `Vikunja REST request failed (${method} ${path}): HTTP ${response.status} ${
        response.statusText
      }${detail ? ` — ${detail}` : ''}`,
      { statusCode: response.status },
    );
    // Also expose the conventional top-level `.status` (mirrors
    // `.details.statusCode`, which pre-dates this): shared classifiers
    // written against the legacy client's error shape —
    // `isAuthenticationError`/`extractHttpStatus`
    // (src/utils/auth-error-handler.ts, src/utils/http-error-detail.ts) —
    // read `.status`/`.response.status` directly on the error object, not
    // `.details.statusCode`. Without this, a REST-layer 401/403 is invisible
    // to any caller that classifies errors that way (e.g. an
    // `isAuthenticationError`-driven retry predicate).
    Object.assign(httpError, { status: response.status });
    throw httpError;
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
 * Performs an authenticated request against the Vikunja REST API, protected
 * by a named circuit breaker and a bounded retry loop (see the module doc
 * comment for why retry/breaker names work the way they do here).
 *
 * Retry policy depends on the method: PUT (Vikunja's CREATE verb) is treated
 * as a non-idempotent write and only retries failures that prove nothing was
 * created (429, connection never established) — see
 * {@link shouldRetryNonIdempotentWrite}. Every other method keeps the
 * standard {@link defaultRestShouldRetry} behaviour (5xx/429/transient
 * network). Both are overridable via `options.retry`.
 *
 * @param authManager - Active auth manager holding the session credentials
 * @param method - HTTP method
 * @param path - API path relative to the configured apiUrl, must start with '/'
 *               (e.g. '/projects/4/views')
 * @param body - Optional value serialized as a JSON request body
 * @param options - Optional breaker-name override and retry tuning
 * @returns The parsed JSON response, or null when the response has no body
 * @throws MCPError when the network call fails or the response is not OK
 *         (after retries are exhausted); the thrown error's
 *         `details.statusCode` reflects the HTTP status of the last attempt,
 *         preserved through retries so callers that treat specific status
 *         codes as fallback signals (e.g. webhooks.ts's `getValidEvents`)
 *         keep working unchanged.
 */
export async function vikunjaRestRequest<T = unknown>(
  authManager: AuthManager,
  method: HttpMethod,
  path: string,
  body?: unknown,
  options?: VikunjaRestRequestOptions,
): Promise<T> {
  const effectiveAuthManager = resolveEffectiveAuthManager(authManager, options);
  const breakerName = options?.breakerName ?? deriveRestBreakerName(path);
  // Vikunja's v1 API uses PUT as its CREATE verb (`PUT /projects/{id}/tasks`,
  // `PUT /projects`, `PUT /labels`, `PUT /tasks/{id}/comments`, ...) and POST
  // as its update verb, so the HTTP method alone identifies a non-idempotent
  // write here. Deciding this at the single choke point every REST call
  // already funnels through — rather than opting in at each create call site —
  // is deliberate: a per-call-site flag is precisely what was missing when
  // this hazard was found, and every create endpoint added later would have
  // to remember it. A caller that knows a specific PUT is safe to repeat can
  // still opt back in with `options.retry.shouldRetry`.
  const isResourceCreatingWrite = method === 'PUT';
  const retryOptions: RetryOptions = {
    ...(isResourceCreatingWrite
      ? DEFAULT_CREATE_RETRY
      : { ...DEFAULT_JSON_RETRY, shouldRetry: defaultRestShouldRetry }),
    ...options?.retry,
  };
  const breaker = createCircuitBreaker(vikunjaRestRequestRaw, breakerName, retryOptions);
  const result = await withRetry(
    () =>
      breaker.fire(effectiveAuthManager, method, path, body).catch((error: unknown) => {
        throw rewordBreakerOpenError(error);
      }),
    retryOptions,
  );
  return result as T;
}

/**
 * The multipart equivalent of `vikunjaRestRequestRaw`: same URL
 * normalization, auth, and error contract, but sends a `FormData` body and
 * deliberately omits the `Content-Type` header so `fetch` can set the
 * correct `multipart/form-data; boundary=...` value itself — setting it
 * manually breaks the boundary and the server rejects the upload.
 */
async function vikunjaRestMultipartRequestRaw(
  authManager: AuthManager,
  method: 'POST' | 'PUT',
  path: string,
  form: FormData,
): Promise<unknown> {
  const session = authManager.getSession();
  const url = `${resolveBaseUrl(session.apiUrl)}${path}`;

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${session.apiToken}`,
      },
      body: form,
    });
  } catch (error) {
    throw new MCPError(
      ErrorCode.API_ERROR,
      `Vikunja REST request failed (${method} ${path}): ${describeRequestError(error)}`,
      { transient: isTransientNetworkError(error) },
    );
  }

  if (!response.ok) {
    let detail = '';
    try {
      detail = redactUpstreamText(await response.text());
    } catch {
      // Body could not be read — fall back to the status line only.
    }
    const httpError = new MCPError(
      ErrorCode.API_ERROR,
      `Vikunja REST request failed (${method} ${path}): HTTP ${response.status} ${
        response.statusText
      }${detail ? ` — ${detail}` : ''}`,
      { statusCode: response.status },
    );
    // Also expose the conventional top-level `.status` (mirrors
    // `.details.statusCode`, which pre-dates this): shared classifiers
    // written against the legacy client's error shape —
    // `isAuthenticationError`/`extractHttpStatus`
    // (src/utils/auth-error-handler.ts, src/utils/http-error-detail.ts) —
    // read `.status`/`.response.status` directly on the error object, not
    // `.details.statusCode`. Without this, a REST-layer 401/403 is invisible
    // to any caller that classifies errors that way (e.g. an
    // `isAuthenticationError`-driven retry predicate).
    Object.assign(httpError, { status: response.status });
    throw httpError;
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
 * Performs an authenticated multipart/form-data request against the Vikunja
 * REST API (file uploads). Shares URL normalization, auth, error contract,
 * and named circuit-breaker protection with `vikunjaRestRequest`, but does
 * NOT retry by default — see `DEFAULT_MULTIPART_RETRY` for why.
 *
 * @param authManager - Active auth manager holding the session credentials
 * @param method - HTTP method (Vikunja's attachment endpoint uses PUT)
 * @param path - API path relative to the configured apiUrl, must start with '/'
 * @param form - The multipart body to send
 * @param options - Optional breaker-name override and retry tuning
 * @returns The parsed JSON response, or null when the response has no body
 * @throws MCPError when the network call fails or the response is not OK
 */
export async function vikunjaRestMultipartRequest<T = unknown>(
  authManager: AuthManager,
  method: 'POST' | 'PUT',
  path: string,
  form: FormData,
  options?: VikunjaRestRequestOptions,
): Promise<T> {
  const effectiveAuthManager = resolveEffectiveAuthManager(authManager, options);
  // `-multipart` suffix is load bearing (#199): without it this derives the
  // SAME name as the JSON helper for sibling paths (`/user/settings/avatar`
  // vs `/user/settings/avatar/upload`, `/tasks/{id}/attachments` for both
  // list and upload), and `createCircuitBreaker` returns whichever breaker
  // was registered first under that name — so an upload preceded by a JSON
  // call in the same group was fired through `vikunjaRestRequestRaw`, which
  // JSON.stringify'd the `FormData` to `{}` and set
  // `Content-Type: application/json`. The server rejected it with a 500
  // ("request Content-Type isn't multipart/form-data") that pointed nowhere
  // near the real cause. The two paths SHOULD trip independently anyway:
  // uploads deliberately don't retry (`DEFAULT_MULTIPART_RETRY`) while JSON
  // calls do, so sharing breaker state between them was never intended.
  const breakerName = options?.breakerName ?? `${deriveRestBreakerName(path)}-multipart`;
  const retryOptions: RetryOptions = {
    ...DEFAULT_MULTIPART_RETRY,
    shouldRetry: defaultRestShouldRetry,
    ...options?.retry,
  };
  const breaker = createCircuitBreaker(vikunjaRestMultipartRequestRaw, breakerName, retryOptions);
  const result = await withRetry(
    () =>
      breaker.fire(effectiveAuthManager, method, path, form).catch((error: unknown) => {
        throw rewordBreakerOpenError(error);
      }),
    retryOptions,
  );
  return result as T;
}

/**
 * Minimal shape of a Vikunja project view as returned by `/projects/{id}/views`.
 */
export interface VikunjaView {
  id: number;
  title: string;
  project_id: number;
  view_kind: string;
  /**
   * The id of this view's "done" bucket. Tasks moved into this bucket are
   * marked done, and tasks marked done are moved here. `models.Bucket` has
   * no `is_done_bucket` field of its own — done-ness is a property of the
   * view, not the bucket — so callers resolve it by comparing a bucket's id
   * against this field.
   */
  done_bucket_id?: number;
}

/**
 * Resolves the first view of a given kind (`list`, `gantt`, `table`, or
 * `kanban`) for a project. Vikunja projects have several views; most
 * per-view operations only make sense against one particular kind, so
 * callers that do not already know the view id can use this to find it.
 * Returns the full view (not just its id) so callers that need extra
 * fields — e.g. `done_bucket_id` — don't have to fetch it again.
 *
 * @param authManager - Active auth manager
 * @param projectId - Project whose view should be resolved
 * @param viewKind - The view kind to look for
 * @returns The project's first view of that kind
 * @throws MCPError when the project has no view of that kind
 */
export async function resolveViewIdByKind(
  authManager: AuthManager,
  projectId: number,
  viewKind: 'list' | 'gantt' | 'table' | 'kanban',
): Promise<VikunjaView> {
  const views = await vikunjaRestRequest<VikunjaView[]>(
    authManager,
    'GET',
    `/projects/${projectId}/views`,
  );
  const view = Array.isArray(views)
    ? views.find((candidate) => candidate.view_kind === viewKind)
    : undefined;
  if (!view) {
    const label = viewKind === 'kanban' ? 'Kanban' : viewKind;
    throw new MCPError(
      ErrorCode.NOT_FOUND,
      viewKind === 'kanban'
        ? `Project ${projectId} has no Kanban view, so it has no buckets`
        : `Project ${projectId} has no ${label} view`,
    );
  }
  return view;
}

/**
 * Resolves the Kanban view of a project.
 *
 * Vikunja projects have several views (list, gantt, table, kanban). Bucket
 * operations only make sense against the Kanban view, so callers that do not
 * already know the view id can use this to find it. Returns the full view
 * (not just its id) so callers that need `done_bucket_id` — e.g. to resolve
 * which bucket is the "done" bucket — don't have to fetch it again.
 *
 * @param authManager - Active auth manager
 * @param projectId - Project whose Kanban view should be resolved
 * @returns The project's Kanban view
 * @throws MCPError when the project has no Kanban view
 */
export async function resolveKanbanView(
  authManager: AuthManager,
  projectId: number,
): Promise<VikunjaView> {
  return resolveViewIdByKind(authManager, projectId, 'kanban');
}

/**
 * Resolves the Kanban view id for a project.
 *
 * @param authManager - Active auth manager
 * @param projectId - Project whose Kanban view should be resolved
 * @returns The numeric id of the project's Kanban view
 * @throws MCPError when the project has no Kanban view
 */
export async function resolveKanbanViewId(
  authManager: AuthManager,
  projectId: number,
): Promise<number> {
  const view = await resolveKanbanView(authManager, projectId);
  return view.id;
}
