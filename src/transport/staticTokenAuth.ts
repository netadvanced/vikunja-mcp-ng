/**
 * gateway-token HTTP auth (docs/GATEWAY-TOKEN-MODE.md §4.3, §5).
 *
 * The second scheme registered on the transport auth seam
 * (`src/transport/oidcMiddlewareSeam.ts`), sibling to the OIDC middleware in
 * `src/transport/oidcHttpAuth.ts`. It checks one static bearer token shared
 * between the gateway and this server (`VIKUNJA_MCP_HTTP_AUTH_TOKEN[_FILE]`).
 *
 * The token authenticates the gateway, not a person. On success the
 * middleware attaches nothing: no `RequestContext`, no `req.auth`. So
 * `src/transport/httpTransport.ts` opens no ALS scope, and every downstream
 * accessor falls back to the process-global `AuthManager` that stdio mode
 * uses. Token mode is stdio's credential model reached over HTTP, with no
 * per-identity state that could leak between callers.
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import { ConfigurationError } from '../config/types';
import { logger } from '../utils/logger';
import {
  setOidcAuthMiddleware,
  type HttpRequestWithAuth,
  type OidcAuthMiddleware,
} from './oidcMiddlewareSeam';

/**
 * Shortest gateway token accepted at startup. A token like `x` is not a
 * defensible credential on a network-reachable listener.
 */
export const MIN_GATEWAY_TOKEN_LENGTH = 32;

const BEARER_PATTERN = /^Bearer +(.+)$/i;

/**
 * Constant-time token comparison. Hash both sides first: comparing the raw
 * buffers returns early on a length mismatch (and `timingSafeEqual` throws
 * on one), which would leak the expected token's length.
 */
export function tokenMatches(presented: string, expected: string): boolean {
  const presentedHash = createHash('sha256').update(presented).digest();
  const expectedHash = createHash('sha256').update(expected).digest();
  return timingSafeEqual(presentedHash, expectedHash);
}

/**
 * The same opaque `401` for every failure, byte for byte. Which check failed
 * is logged server-side only, never sent (tests/oidc/threat-model.test.ts is
 * the precedent).
 */
function writeUnauthorized(res: ServerResponse): void {
  if (res.headersSent) {
    return;
  }
  const payload = JSON.stringify({ error: 'invalid_token' });
  res.writeHead(401, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'WWW-Authenticate': 'Bearer',
  });
  res.end(payload);
}

/**
 * Builds the gateway-token middleware for the transport auth seam. Returns
 * `true` for the right bearer (and touches nothing), otherwise writes the
 * `401` itself and returns `false`.
 */
export function createStaticTokenAuthMiddleware(deps: { token: string }): OidcAuthMiddleware {
  const { token } = deps;
  return (req: HttpRequestWithAuth, res: ServerResponse): Promise<boolean> => {
    const header = req.headers.authorization;
    let reason: string;
    if (header === undefined || header.trim() === '') {
      reason = 'no Authorization header';
    } else {
      const match = BEARER_PATTERN.exec(header.trim());
      if (match === null) {
        reason = 'Authorization header does not use the Bearer scheme';
      } else if (tokenMatches(match[1] as string, token)) {
        return Promise.resolve(true);
      } else {
        reason = 'bearer token does not match';
      }
    }
    logger.warn(`Gateway request rejected (static token check): ${reason}`);
    writeUnauthorized(res);
    return Promise.resolve(false);
  };
}

/**
 * Validates the configured gateway token and registers the middleware on the
 * transport auth seam. Called by `src/index.ts`'s `main()` before
 * `startHttpTransport`, so a missing or weak token fails startup before any
 * port is bound. The token value never appears in an error message. The
 * error field is `http.authMode`, not the variable name: the log sanitizer
 * would mask the text after a sensitive-looking `NAME:` prefix.
 *
 * Surrounding whitespace is trimmed whatever the source: the `_FILE` form is
 * already trimmed, and an env injection with a trailing newline would
 * otherwise start fine and then reject every request with a bare 401.
 */
export function setupStaticTokenAuth(rawToken: string | undefined): void {
  const token = rawToken?.trim();
  if (token === undefined || token === '') {
    throw new ConfigurationError(
      'http.authMode',
      'Gateway-token mode (VIKUNJA_MCP_HTTP_AUTH_MODE set to token) requires the shared ' +
        'gateway token. Set ' +
        'VIKUNJA_MCP_HTTP_AUTH_TOKEN (or VIKUNJA_MCP_HTTP_AUTH_TOKEN_FILE) to a random ' +
        `value of at least ${MIN_GATEWAY_TOKEN_LENGTH} characters, e.g. the output of ` +
        '`openssl rand -hex 32`.',
    );
  }
  if (token.length < MIN_GATEWAY_TOKEN_LENGTH) {
    throw new ConfigurationError(
      'http.authMode',
      `VIKUNJA_MCP_HTTP_AUTH_TOKEN is too short; the minimum is ${MIN_GATEWAY_TOKEN_LENGTH} ` +
        'characters. Generate one with `openssl rand -hex 32`.',
    );
  }
  setOidcAuthMiddleware(createStaticTokenAuthMiddleware({ token }));
}
