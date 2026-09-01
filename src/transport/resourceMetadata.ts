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
 *
 * #292 LOW-19: when `publicUrl` isn't configured, the derived `host`/`proto`
 * used to be taken from the request verbatim — an unauthenticated caller (this
 * endpoint is served before the JWT middleware, by design, since a client
 * fetches it precisely when it has no token yet) could set an arbitrary
 * `Host`/`X-Forwarded-Proto` and have it reflected straight back in the
 * discovery document. The content is non-secret (this is only ever the
 * server's own resource URL, no credentials), so the impact is limited to
 * spoofed discovery metadata rather than any data disclosure - but there's no
 * reason to trust it either. `allowedHosts` (the same DNS-rebinding allowlist
 * the SDK transport and the enrollment endpoints already enforce, see
 * `resolveAllowedHosts` in `src/transport/httpTransport.ts`) is now checked
 * here too: an unrecognized `Host` header falls back to the configured bind
 * `host:port`, exactly as if no request were in hand at all, and
 * `X-Forwarded-Proto` is only trusted alongside a `Host` that passed the
 * allowlist (a forwarded-proto claim is meaningless from an untrusted host
 * anyway). Passing `undefined` for `allowedHosts` keeps the legacy
 * trust-the-request behaviour for callers that have not been threaded
 * through yet (there should be none left in this codebase after #292).
 */
export function resolveResourceUrl(
  httpConfig: HttpConfig,
  req?: Pick<IncomingMessage, 'headers'>,
  allowedHosts?: readonly string[]
): string {
  if (httpConfig.publicUrl) {
    return httpConfig.publicUrl;
  }
  const hostHeader = req?.headers.host;
  const hostHeaderTrusted =
    typeof hostHeader === 'string' &&
    hostHeader.length > 0 &&
    (allowedHosts === undefined || allowedHosts.includes(hostHeader));
  const host = hostHeaderTrusted ? hostHeader : `${httpConfig.host}:${httpConfig.port}`;
  const forwardedProto = hostHeaderTrusted ? req?.headers['x-forwarded-proto'] : undefined;
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
  allowedHosts?: readonly string[]
): string {
  const origin = new URL(resolveResourceUrl(httpConfig, req, allowedHosts)).origin;
  return `${origin}${WELL_KNOWN_PROTECTED_RESOURCE_PATH}`;
}

/** Build the metadata document served on the well-known endpoint. */
export function buildProtectedResourceMetadata(
  httpConfig: HttpConfig,
  issuer: string,
  req?: Pick<IncomingMessage, 'headers'>,
  allowedHosts?: readonly string[]
): ProtectedResourceMetadata {
  return {
    resource: resolveResourceUrl(httpConfig, req, allowedHosts),
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
