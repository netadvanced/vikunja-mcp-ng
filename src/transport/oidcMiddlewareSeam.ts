/**
 * Seam for the OIDC JWT-validation middleware (item H1b — JWT validation
 * middleware, docs/OIDC-RESOURCE-SERVER.md §3b, a parallel wave-H1 work
 * item).
 *
 * This item (H1a) builds the Streamable HTTP transport plumbing only; it
 * does not validate bearer tokens itself. Per the spec's deny-mixed-mode rule
 * (§2 "Selection rule"), `transport=http` must never serve unauthenticated
 * HTTP — so `getOidcAuthMiddleware()` returning `undefined` (nothing
 * registered yet) makes `src/transport/httpTransport.ts` refuse to start the
 * HTTP listener.
 *
 * **H1b has landed**: the real JWT-validation middleware described in §3b —
 * `jose`'s `createRemoteJWKSet` + `jwtVerify`, validating
 * `iss`/`aud`/`alg` allowlist/`exp`/`nbf`/clock-skew/`sub` — lives in
 * `src/auth/oidc/jwtValidator.ts`, and `src/transport/oidcHttpAuth.ts`
 * registers it here via `setOidcAuthMiddleware()` during server startup,
 * before `startHttpTransport()` is invoked. This module stays a pure seam
 * (types + get/set) rather than importing that implementation directly, so
 * `httpTransport.ts` never has to know which auth scheme registered it.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';

/** Node request shape the SDK's `StreamableHTTPServerTransport.handleRequest` expects. */
export type HttpRequestWithAuth = IncomingMessage & { auth?: AuthInfo };

/**
 * An OIDC authentication middleware validates the incoming request's bearer
 * token and either:
 *  - attaches `{ issuer, sub, claims }`-derived `AuthInfo` to `req.auth` and
 *    returns `true` (the caller should proceed to `transport.handleRequest`), or
 *  - writes the appropriate `401`/`403` response itself and returns `false`
 *    (the caller MUST NOT proceed — the response is already complete).
 */
export type OidcAuthMiddleware = (
  req: HttpRequestWithAuth,
  res: ServerResponse
) => Promise<boolean>;

let registeredMiddleware: OidcAuthMiddleware | undefined;

/**
 * Register the OIDC authentication middleware. Called once during server
 * startup (by H1b's wiring) before HTTP transport mode is started. Passing
 * `undefined` clears the registration (used by tests).
 */
export function setOidcAuthMiddleware(middleware: OidcAuthMiddleware | undefined): void {
  registeredMiddleware = middleware;
}

/**
 * Returns the registered OIDC authentication middleware, or `undefined` if
 * none has been registered yet (the H1a/pre-H1b state). Callers in `http`
 * transport mode MUST refuse to start when this returns `undefined` —
 * never serve unauthenticated HTTP.
 */
export function getOidcAuthMiddleware(): OidcAuthMiddleware | undefined {
  return registeredMiddleware;
}
