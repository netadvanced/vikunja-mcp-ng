/**
 * RFC 9728 Protected Resource Metadata helpers — the discovery half of the
 * MCP authorization spec (2025-06-18 revision, "Authorization Server
 * Location"). Browser-based MCP clients (e.g. claude.ai custom connectors)
 * that connect DIRECTLY to this server fetch
 * `GET /.well-known/oauth-protected-resource` to auto-discover which IdP
 * (`authorization_servers`) protects this resource, instead of being
 * hand-configured with the issuer URL.
 *
 * Two things are derived here:
 *
 *  - The **canonical resource URL** (`resource`): the configured
 *    `http.publicUrl` (`VIKUNJA_MCP_HTTP_PUBLIC_URL`) verbatim when set —
 *    the recommended setup behind a reverse proxy, where the bind host/port
 *    say nothing about the public origin — otherwise derived from the
 *    request's `Host` header (scheme from `X-Forwarded-Proto`, default
 *    `http`) plus the configured MCP path.
 *  - The **resource-metadata URL** advertised on 401 challenges
 *    (`WWW-Authenticate: Bearer ..., resource_metadata="..."`, RFC 9728
 *    §5.1): the resource URL's origin + the well-known path.
 *
 * Serving happens in `src/transport/httpTransport.ts` (unauthenticated,
 * GET-only, read-only — like `/healthz`); the 401 challenge addition lives
 * in `src/transport/oidcHttpAuth.ts`.
 */

import type { IncomingMessage } from 'node:http';
import type { HttpConfig } from '../config/types';

/** RFC 9728 §3 well-known path for protected resource metadata. */
export const WELL_KNOWN_PROTECTED_RESOURCE_PATH = '/.well-known/oauth-protected-resource';

/** The RFC 9728 metadata document this server serves. */
export interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers: string[];
  bearer_methods_supported: string[];
}

/**
 * Resolve the canonical MCP resource URL. `http.publicUrl` wins verbatim when
 * configured; otherwise derive `scheme://host + path` from the request
 * (`Host` header, `X-Forwarded-Proto` scheme) with the configured bind
 * `host:port` as the last-resort host (also used when no request is in hand,
 * e.g. at startup).
 */
export function resolveResourceUrl(
  httpConfig: HttpConfig,
  req?: Pick<IncomingMessage, 'headers'>,
): string {
  if (httpConfig.publicUrl) {
    return httpConfig.publicUrl;
  }
  const hostHeader = req?.headers.host;
  const host =
    typeof hostHeader === 'string' && hostHeader.length > 0
      ? hostHeader
      : `${httpConfig.host}:${httpConfig.port}`;
  const forwardedProto = req?.headers['x-forwarded-proto'];
  const protoRaw = Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto;
  const protoCandidate = protoRaw?.split(',')[0]?.trim();
  const proto = protoCandidate !== undefined && protoCandidate.length > 0 ? protoCandidate : 'http';
  return `${proto}://${host}${httpConfig.path}`;
}

/**
 * The RFC 9728 §5.1 `resource_metadata` URL for the 401 `WWW-Authenticate`
 * challenge: the resource URL's origin + the well-known path. Throws when the
 * derived host cannot form a valid URL (an unparsable `Host` header) — the
 * caller omits the parameter in that case rather than advertising garbage.
 */
export function resolveResourceMetadataUrl(
  httpConfig: HttpConfig,
  req?: Pick<IncomingMessage, 'headers'>,
): string {
  const origin = new URL(resolveResourceUrl(httpConfig, req)).origin;
  return `${origin}${WELL_KNOWN_PROTECTED_RESOURCE_PATH}`;
}

/** Build the metadata document served on the well-known endpoint. */
export function buildProtectedResourceMetadata(
  httpConfig: HttpConfig,
  issuer: string,
  req?: Pick<IncomingMessage, 'headers'>,
): ProtectedResourceMetadata {
  return {
    resource: resolveResourceUrl(httpConfig, req),
    authorization_servers: [issuer],
    bearer_methods_supported: ['header'],
  };
}

/**
 * Does `pathname` address this server's protected-resource metadata? Both the
 * bare well-known path and the path-suffixed variant (RFC 9728 §3.1 —
 * `/.well-known/oauth-protected-resource/mcp` for a resource at `/mcp`) are
 * served, since path-aware clients insert the well-known segment before the
 * resource's path component.
 */
export function isProtectedResourceMetadataPath(pathname: string, mcpPath: string): boolean {
  return (
    pathname === WELL_KNOWN_PROTECTED_RESOURCE_PATH ||
    pathname === `${WELL_KNOWN_PROTECTED_RESOURCE_PATH}${mcpPath}`
  );
}
