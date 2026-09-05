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
 * Both pieces below were exactly that. Credential redaction of upstream text
 * (audit #292 MED-18) and the tool-execution deadline's cancellation error
 * (LOW-20, #296) were added to v1 while nothing routed through v2, so v2 grew
 * up without either. #184 P3 made that live: task reads, task listings and
 * task update now select v2 against a v2-capable server. They live here so
 * there is one definition of each and the next transport cannot forget them.
 */

import { MCPError, ErrorCode } from '../types';
import { redactSecretsInText } from './security';

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
