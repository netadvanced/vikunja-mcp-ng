/**
 * Per-request identity context.
 *
 * Spec: docs/OIDC-RESOURCE-SERVER.md §3d (D6) — `oidc-http` mode is
 * multi-user; every piece of state that today assumes "one process = one
 * user" must be re-keyed by the validated caller's identity, `(issuer,
 * sub)`. The mechanism that makes this tractable without threading an
 * `authManager`/identity parameter through every tool call stack is a single
 * `AsyncLocalStorage` scope opened once per request (by the JWT middleware,
 * around `transport.handleRequest`) and read back through a handful of
 * accessors — this module.
 *
 * `stdio` mode NEVER opens an ALS scope. Every accessor here degrades to
 * `undefined`/a legacy fallback when called outside one, which is exactly
 * how `stdio` behaves: the ALS machinery isn't merely "unused", it is never
 * constructed differently at all — `getStore()` on a store nobody ever
 * `.run()`s into simply returns `undefined`. This is the invariant the spec
 * calls out as needing a regression test (§3d): stdio's behaviour must be
 * byte-for-byte unchanged, not "unchanged so far as we've noticed".
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { AuthManager } from '../auth/AuthManager';

/**
 * The validated caller identity. Keyed as a pair (not `sub` alone) per D11:
 * single-issuer ships first, but pair-keying means a second issuer/realm
 * that happens to mint a colliding `sub` can never collide with another's
 * state — adding a second issuer later is an allowlist change, not a
 * data-model migration.
 */
export interface Identity {
  readonly issuer: string;
  readonly sub: string;
  /**
   * Optional claims threaded through from the validated bearer token
   * (never a tenancy key — `identityKey` stays `(issuer, sub)`). The
   * SSO-enrollment callback uses them to pin the enrolled Vikunja account
   * to the initiating identity (issue #220, finding #1).
   */
  readonly email?: string;
  readonly preferredUsername?: string;
}

/** Per-request context bound in ALS for the lifetime of one JSON-RPC call. */
export interface RequestContext {
  readonly identity: Identity;
  readonly authManager: AuthManager;
}

const requestContextStorage = new AsyncLocalStorage<RequestContext>();

/**
 * Stable string key for an identity: `"<issuer>|<sub>"`. Matches the vault's
 * on-disk record key from §3c (`"<issuer>|<sub>"`) exactly, and is reused
 * everywhere global state is re-keyed by identity (rate-limiter buckets,
 * filter/template storage session ids) so every re-keyed store shares one
 * canonical tenancy key.
 */
export function identityKey(identity: Identity): string {
  return `${identity.issuer}|${identity.sub}`;
}

/**
 * Run `fn` with `context` bound in ALS for the duration of the call
 * (including through any awaited async work `fn` kicks off). This is the
 * only way a `RequestContext` ever becomes visible to `getRequestContext()`
 * — `stdio` mode never calls this, so it never opens an ALS scope at all.
 */
export function runWithRequestContext<T>(context: RequestContext, fn: () => T): T {
  return requestContextStorage.run(context, fn);
}

/**
 * The active request context, or `undefined` when called outside any ALS
 * scope — always the case in `stdio` mode.
 */
export function getRequestContext(): RequestContext | undefined {
  return requestContextStorage.getStore();
}

/** Convenience: the active identity, or `undefined` outside an ALS scope. */
export function getCurrentIdentity(): Identity | undefined {
  return requestContextStorage.getStore()?.identity;
}

/**
 * The `AuthManager` whose identity governs THIS call: the ALS-bound
 * per-identity manager when a request context is open (`oidc-http` mode),
 * otherwise the passed process-global/closure manager (`stdio` mode, which
 * never opens a scope, so behaviour there is byte-for-byte unchanged).
 *
 * This is the single rule the REST layer already applies to pick which
 * credential goes on the wire (`resolveEffectiveAuthManager`,
 * src/utils/vikunja-rest.ts). Issues #270/#282: the auth-*type* decisions
 * did not follow it — tool registration (src/tools/index.ts) and the
 * per-call JWT gates in users/export/admin/user-deletion read the
 * process-global closure manager instead. Under a mixed deployment (legacy
 * `VIKUNJA_URL`/`VIKUNJA_API_TOKEN` env credentials auto-connected in
 * src/index.ts *and* `oidc-http` transport) the operator's own token then
 * decided a deny-by-default gate for every caller: a JWT env token exposed
 * `vikunja_admin`/`vikunja_user_deletion`/`vikunja_users`/export to
 * identities whose own vaulted credential is a scoped `tk_*` token, and a
 * `tk_*` env token denied them to identities entitled to them. Every such
 * decision must resolve through here so one rule governs credential AND
 * capability.
 */
export function resolveIdentityAuthManager(fallbackAuthManager: AuthManager): AuthManager {
  return requestContextStorage.getStore()?.authManager ?? fallbackAuthManager;
}

/**
 * The caller's effective auth type for this request, or `undefined` when the
 * effective manager (see {@link resolveIdentityAuthManager}) holds no session
 * — an unprovisioned OIDC identity in `oidc-http` mode, or a not-yet-
 * connected `stdio` session. Deliberately returns `undefined` rather than
 * throwing so registration-time gates can fail closed without a try/catch.
 */
export function getEffectiveAuthType(
  fallbackAuthManager: AuthManager,
): 'api-token' | 'jwt' | undefined {
  const effective = resolveIdentityAuthManager(fallbackAuthManager);
  return effective.isAuthenticated() ? effective.getAuthType() : undefined;
}

/**
 * Symbol used to stash a request-scoped `RequestContext` on an arbitrary
 * carrier object (the Node `IncomingMessage` in `oidc-http` mode) between the
 * two halves of the HTTP auth flow.
 *
 * The transport's auth seam is a boolean-returning middleware
 * (`OidcAuthMiddleware`, src/transport/oidcMiddlewareSeam.ts) that runs and
 * returns *before* `transport.handleRequest` executes — so it cannot itself
 * hold open the ALS scope that must wrap the actual request handling. Instead
 * the middleware {@link attachRequestContext}es the built context onto the
 * request, and `src/transport/httpTransport.ts` reads it back with
 * {@link takeAttachedRequestContext} and opens the ALS scope
 * ({@link runWithRequestContext}) around `handleRequest`. Keeping this handoff
 * here (rather than in the transport or the OIDC wiring) keeps every ALS
 * concern in one module.
 */
const ATTACHED_CONTEXT = Symbol('vikunjaRequestContext');

/** Stash a `RequestContext` on a carrier (the HTTP request) for later ALS scoping. */
export function attachRequestContext(carrier: object, context: RequestContext): void {
  (carrier as Record<symbol, unknown>)[ATTACHED_CONTEXT] = context;
}

/** Read back a `RequestContext` stashed by {@link attachRequestContext}, if any. */
export function takeAttachedRequestContext(
  carrier: object | undefined,
): RequestContext | undefined {
  if (!carrier) {
    return undefined;
  }
  return (carrier as Record<symbol, unknown>)[ATTACHED_CONTEXT] as RequestContext | undefined;
}

/**
 * Effective session id for keying `SimpleFilterStorage`-backed state (the
 * tasks tool's own session-scoped storage, and `vikunja_templates` —
 * isolation-table rows #3/#4 in docs/OIDC-RESOURCE-SERVER.md §3d).
 *
 * Inside an ALS scope (`oidc-http` mode) this is the identity key, so two
 * concurrent identities can never share a bucket. Outside one (`stdio`
 * mode, always) it falls back to the pre-existing
 * `${apiUrl}:${apiToken.substring(0,8)}` (or `'anonymous'`) derivation,
 * unchanged — single-tenant behaviour is not merely preserved, the code
 * path that computes it is untouched.
 */
export function getEffectiveSessionId(authManager: AuthManager): string {
  const identity = getCurrentIdentity();
  if (identity) {
    return identityKey(identity);
  }
  const session = authManager.getSession();
  return session.apiToken ? `${session.apiUrl}:${session.apiToken.substring(0, 8)}` : 'anonymous';
}
