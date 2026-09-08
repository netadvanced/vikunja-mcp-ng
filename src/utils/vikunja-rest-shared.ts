/**
 * The parts of the Vikunja REST transports that must behave IDENTICALLY on v1
 * (`./vikunja-rest`) and v2 (`./vikunja-rest-v2`).
 *
 * The two transports are deliberate siblings rather than one module with a
 * version branch — see `./vikunja-rest-v2`'s doc comment for why v2 support
 * must not add logic to the path v1 executes. That split has a cost: a
 * protection added to one is silently absent from the other, and nothing
 * fails until an operation actually routes through the other transport.
 *
 * All three pieces below were exactly that. Credential redaction of upstream text
 * (audit #292 MED-18) and the tool-execution deadline's cancellation error
 * (LOW-20, #296) were added to v1 while nothing routed through v2, so v2 grew
 * up without either. #184 P3 made that live: task reads, task listings and
 * task update now select v2 against a v2-capable server. Per-identity auth
 * resolution was the same story one round later: v1 has resolved the caller's
 * effective `AuthManager` out of the ALS request context since the OIDC work,
 * and v2 was reading the passed manager directly, which is wrong in
 * `oidc-http` mode and invisible to every test we run in `stdio` mode. They
 * live here so there is one definition of each and the next transport cannot
 * forget them.
 *
 * A fourth of the same class is not here, because the two transports cannot
 * share one function for it: `deriveRestBreakerName` / `deriveRestV2BreakerName`
 * must both strip the query string before collapsing segments (v1's #254
 * fix), but they emit different prefixes. The v2 copy was taken before that
 * strip existed and shipped into P3 that way. See the v2 helper's doc comment.
 */

import { MCPError, ErrorCode } from '../types';
import { redactSecretsInText } from './security';
import { resolveIdentityAuthManager } from '../context/requestContext';
import type { AuthManager } from '../auth/AuthManager';

/**
 * How much of an upstream error body is scanned for credentials before it is
 * truncated for display. Redaction has to run on more text than we keep,
 * otherwise a secret straddling the 500-character display cut would have its
 * tail removed and its head kept, leaving a partial credential that no pattern
 * matches any more. Scanning 4 KiB is cheap and covers every realistic
 * Vikunja/proxy error body.
 */
export const ERROR_BODY_SCAN_LIMIT = 4096;

/** How much of the (already redacted) error body is shown to the caller. */
export const ERROR_BODY_DISPLAY_LIMIT = 500;

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
export function redactUpstreamText(text: string, limit = ERROR_BODY_DISPLAY_LIMIT): string {
  return redactSecretsInText(text.slice(0, ERROR_BODY_SCAN_LIMIT)).slice(0, limit);
}

/**
 * Same treatment for the message of a failure thrown by `fetch` itself, which
 * embeds the request URL and can therefore carry userinfo credentials.
 */
export function describeRequestError(error: unknown): string {
  return redactUpstreamText(
    error instanceof Error ? error.message : String(error),
    ERROR_BODY_SCAN_LIMIT,
  );
}

/**
 * The error raised when the tool-execution deadline aborted a request that
 * was already in flight.
 *
 * Two properties matter and are load-bearing:
 * - The message deliberately avoids every substring `isRetryableError` /
 *   `isTransientError` (src/utils/retry.ts) treat as grounds to retry
 *   ('timeout', 'timed out', 'connection', 'network', 'rate limit', ...).
 *   Re-firing a request the caller has already given up on is precisely the
 *   "may still commit" hazard LOW-20 is about.
 * - `cancelled: true` tells the shared circuit breaker's `errorFilter`
 *   (`isClientErrorExcludedFromBreaker`) that this failure says nothing
 *   about upstream Vikunja's health, so one tenant's slow calls cannot
 *   trip a breaker that every other tenant in the process shares.
 */
export function buildCancelledRequestError(method: string, path: string): MCPError {
  return new MCPError(
    ErrorCode.TIMEOUT_ERROR,
    `Vikunja REST request cancelled (${method} ${path}): the tool execution deadline ` +
      'elapsed before the server responded. The request was aborted; whether the server ' +
      'had already applied it is unknown, so re-check before retrying.',
    { cancelled: true, transient: false },
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
export function resolveEffectiveAuthManager(
  authManager: AuthManager,
  // Structural rather than `VikunjaRestRequestOptions`, which lives in the v1
  // transport: importing that type here would make the shared module depend on
  // one of its own consumers. Both transports' option types satisfy this.
  options?: { ignoreRequestContext?: boolean },
): AuthManager {
  if (options?.ignoreRequestContext) {
    return authManager;
  }
  // Same one rule the capability/auth-type gates use (#270/#282) — see
  // `resolveIdentityAuthManager`'s doc comment.
  return resolveIdentityAuthManager(authManager);
}
