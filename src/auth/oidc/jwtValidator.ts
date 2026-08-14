/**
 * OIDC resource-server JWT validation middleware.
 *
 * Implements docs/OIDC-RESOURCE-SERVER.md §3(b)'s validation contract: strict
 * issuer/audience checking, an explicit `alg` allowlist (default `['RS256']`,
 * rejecting `none` and unexpected HMAC algorithms), bounded clock skew, and a
 * generic 401/403 failure contract that never echoes token material back to
 * the caller and never logs a token at any level.
 *
 * Deliberately transport-agnostic: {@link createOidcJwtValidator} returns a
 * `validate(authorizationHeaderValue) => Promise<Identity>` function with no
 * dependency on Node's `http`, the MCP SDK transport, or any request/response
 * object — so an HTTP transport seam can call it directly, and unit tests
 * need no HTTP server (see tests/auth/oidc/jwtValidator.test.ts).
 */

import type { RemoteJWKSetOptions } from 'jose';
import { ErrorCode, MCPError } from '../../types/errors';
import { logger } from '../../utils/logger';
import type { Identity, JoseDeps, OidcJwksCacheConfig, OidcJwtValidatorConfig } from './types';

const DEFAULT_ALLOWED_ALGS = ['RS256'];
const DEFAULT_CLOCK_SKEW_SEC = 60;

const INVALID_TOKEN_MESSAGE = 'Invalid or expired token';
const INSUFFICIENT_SCOPE_MESSAGE = 'Token lacks required scope';

const BEARER_PATTERN = /^Bearer\s+(\S+)$/i;

export interface OidcJwtValidator {
  /**
   * Validates an `Authorization` header value and returns the caller's
   * identity on success.
   *
   * On any failure, throws an {@link MCPError} carrying the generic,
   * safe-to-return-verbatim message plus `details.statusCode` (401 or 403)
   * and `details.wwwAuthenticateError` (`'invalid_token'` or
   * `'insufficient_scope'`) for the transport to build its HTTP response.
   * The specific failure reason is logged at `warn` — the token itself is
   * never included in that log line.
   */
  validate(authorizationHeader: string | null | undefined): Promise<Identity>;
  /**
   * Forces an immediate JWKS refetch, bypassing the cooldown window. Not
   * required for normal operation — jose's remote JWKS resolver already
   * refetches automatically when it sees an unrecognized `kid` — but useful
   * for an operator reacting to a known key rotation, or for tests.
   */
  reloadJwks(): Promise<void>;
}

/**
 * Builds an {@link OidcJwtValidator} bound to the given config.
 *
 * `deps` is required rather than defaulted to a live `import('jose')` so this
 * function stays synchronous and trivially unit-testable; see
 * src/auth/oidc/joseLoader.ts for how production code obtains `deps`.
 */
export function createOidcJwtValidator(
  config: OidcJwtValidatorConfig,
  deps: JoseDeps,
): OidcJwtValidator {
  if (!config.issuer) {
    throw new Error('createOidcJwtValidator: config.issuer is required');
  }
  if (!config.audience || (Array.isArray(config.audience) && config.audience.length === 0)) {
    throw new Error('createOidcJwtValidator: config.audience is required');
  }
  if (!config.jwksUri) {
    throw new Error('createOidcJwtValidator: config.jwksUri is required');
  }

  const allowedAlgs =
    config.allowedAlgs && config.allowedAlgs.length > 0 ? config.allowedAlgs : DEFAULT_ALLOWED_ALGS;
  const clockTolerance = config.clockSkewSec ?? DEFAULT_CLOCK_SKEW_SEC;

  const jwks = deps.createRemoteJWKSet(new URL(config.jwksUri), buildJwksCacheOptions(config.jwks));

  async function validate(authorizationHeader: string | null | undefined): Promise<Identity> {
    const token = extractBearerToken(authorizationHeader);
    if (!token) {
      logger.warn('OIDC auth rejected: missing or malformed Authorization header');
      throw unauthorized();
    }

    let payload: Awaited<ReturnType<JoseDeps['jwtVerify']>>['payload'];
    try {
      const result = await deps.jwtVerify(token, jwks, {
        issuer: config.issuer,
        audience: config.audience,
        algorithms: allowedAlgs,
        clockTolerance,
        requiredClaims: ['sub'],
      });
      payload = result.payload;
    } catch (err) {
      logger.warn('OIDC auth rejected: %s', describeVerifyFailure(err));
      throw unauthorized();
    }

    const sub = payload.sub;
    if (!sub) {
      logger.warn('OIDC auth rejected: token has an empty sub claim');
      throw unauthorized();
    }

    if (config.requiredScope && !hasRequiredScope(payload, config.requiredScope)) {
      logger.warn('OIDC auth rejected: token missing required scope');
      throw forbidden();
    }

    const identity: Identity = { issuer: config.issuer, sub };
    const preferredUsername = payload['preferred_username'];
    if (typeof preferredUsername === 'string' && preferredUsername.length > 0) {
      identity.preferredUsername = preferredUsername;
    }
    return identity;
  }

  async function reloadJwks(): Promise<void> {
    await jwks.reload();
  }

  return { validate, reloadJwks };
}

function buildJwksCacheOptions(jwksConfig: OidcJwksCacheConfig | undefined): RemoteJWKSetOptions {
  const options: RemoteJWKSetOptions = {};
  if (jwksConfig?.cooldownDurationMs !== undefined) {
    options.cooldownDuration = jwksConfig.cooldownDurationMs;
  }
  if (jwksConfig?.cacheMaxAgeMs !== undefined) {
    options.cacheMaxAge = jwksConfig.cacheMaxAgeMs;
  }
  if (jwksConfig?.timeoutDurationMs !== undefined) {
    options.timeoutDuration = jwksConfig.timeoutDurationMs;
  }
  return options;
}

function extractBearerToken(header: string | null | undefined): string | undefined {
  if (!header || typeof header !== 'string') {
    return undefined;
  }
  return BEARER_PATTERN.exec(header.trim())?.[1];
}

function hasRequiredScope(payload: Record<string, unknown>, requiredScope: string): boolean {
  const raw = payload['scope'] ?? payload['scp'];
  if (typeof raw === 'string') {
    return raw.split(/\s+/).includes(requiredScope);
  }
  if (Array.isArray(raw)) {
    return raw.includes(requiredScope);
  }
  return false;
}

/**
 * Describes a `jose` verification failure for the (token-free) warn log.
 * `jose`'s own error names/messages describe claim mismatches (e.g. `exp`,
 * `aud`, `iss`, unsupported `alg`) — they never include the token or key
 * material, so surfacing them directly here does not risk a leak.
 */
function describeVerifyFailure(err: unknown): string {
  if (err instanceof Error) {
    return `${err.name}: ${err.message}`;
  }
  return 'token verification failed';
}

function unauthorized(): MCPError {
  return new MCPError(ErrorCode.AUTH_FAILED, INVALID_TOKEN_MESSAGE, {
    statusCode: 401,
    wwwAuthenticateError: 'invalid_token',
  });
}

function forbidden(): MCPError {
  return new MCPError(ErrorCode.PERMISSION_DENIED, INSUFFICIENT_SCOPE_MESSAGE, {
    statusCode: 403,
    wwwAuthenticateError: 'insufficient_scope',
  });
}
