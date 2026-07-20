/**
 * Types for the OIDC resource-server JWT validation middleware.
 *
 * See docs/OIDC-RESOURCE-SERVER.md §3(b) for the full design this implements.
 * This module is deliberately generic: no organization-specific issuer/audience
 * values or IdP assumptions live here, only the shape of the config a caller
 * (e.g. the HTTP transport bootstrap) must supply.
 */

import type { createRemoteJWKSet, jwtVerify } from 'jose';

/**
 * A validated OIDC caller identity, derived exclusively from a cryptographically
 * verified bearer token. Never trust any of these fields from an unverified
 * source (e.g. a tool argument) — see docs/OIDC-RESOURCE-SERVER.md §3(d), D7.
 */
export interface Identity {
  /** The exact, configured issuer the token was verified against (the `iss` claim). */
  issuer: string;
  /** The `sub` claim — the stable per-issuer tenancy key. Always present and non-empty. */
  sub: string;
  /** The `preferred_username` claim, when the token carries one. Display-only — never a tenancy key. */
  preferredUsername?: string;
}

/** Tuning knobs for the underlying `jose` remote JWKS cache (`createRemoteJWKSet`). */
export interface OidcJwksCacheConfig {
  /** Minimum time between HTTP fetches of the JWKS, in ms. jose default: 30000. */
  cooldownDurationMs?: number;
  /** Maximum time a cached JWKS is trusted without a background refetch, in ms. jose default: 600000. */
  cacheMaxAgeMs?: number;
  /** Timeout for the JWKS HTTP fetch itself, in ms. jose default: 5000. */
  timeoutDurationMs?: number;
}

/**
 * Configuration consumed by {@link createOidcJwtValidator}. Every value here is
 * expected to already be fully resolved by the caller (config loading, secrets,
 * and any issuer-discovery step are out of this module's scope) — this module
 * performs no network discovery and reads no environment variables itself.
 *
 * Field names intentionally mirror docs/OIDC-RESOURCE-SERVER.md §2.1's
 * `oidc.issuer` / `oidc.audience` / etc. config keys.
 */
export interface OidcJwtValidatorConfig {
  /** Exact-match trusted issuer (`oidc.issuer`). Compared with a plain string equality — no prefix matching. */
  issuer: string;
  /** Required audience value(s) (`oidc.audience`). A token must carry at least one of these in its `aud` claim. */
  audience: string | string[];
  /** JWKS endpoint URL to fetch signing keys from (`oidc.jwksUri`). */
  jwksUri: string;
  /**
   * Allowed JWS `alg` values (`oidc.allowedAlgs`). Defaults to `['RS256']`.
   * `none` is never accepted (jose does not implement it as a verifiable alg).
   * Do not add `HS*` algorithms unless the deployment has a specific, understood
   * reason to accept HMAC-signed tokens against key material published as public keys.
   */
  allowedAlgs?: string[];
  /** Bounded clock skew tolerance, in seconds, applied to `exp`/`nbf`/`iat` (`oidc.clockSkewSec`). Defaults to 60. */
  clockSkewSec?: number;
  /** Optional coarse scope gate (`oidc.requiredScope`). When set, a validly-authenticated token missing this scope is a 403, not a 401. */
  requiredScope?: string;
  /** Optional tuning for the underlying JWKS cache. */
  jwks?: OidcJwksCacheConfig;
}

export type JoseJwtVerify = typeof jwtVerify;
export type JoseCreateRemoteJWKSet = typeof createRemoteJWKSet;

/**
 * The subset of the `jose` module this middleware needs. Callers inject this
 * explicitly (rather than the middleware importing `jose` itself) so that:
 *
 * - Production code obtains it via {@link loadJose} (a real dynamic `import('jose')`,
 *   since `jose` ships ESM-only and this project compiles to CommonJS).
 * - Tests inject `jose`'s own statically-imported exports directly, which keeps
 *   the validator's unit tests fast, deterministic, and free of any dependency
 *   on Jest's (unsupported, in this project's CommonJS test setup) ability to
 *   execute a genuine dynamic `import()` of a live ES module.
 */
export interface JoseDeps {
  jwtVerify: JoseJwtVerify;
  createRemoteJWKSet: JoseCreateRemoteJWKSet;
}
