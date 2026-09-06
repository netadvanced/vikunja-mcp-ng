/**
 * Session capability/version detection: the input to every v1-or-v2 routing
 * decision this server makes.
 *
 * This module only builds a read-only `VikunjaCapabilities` snapshot: the raw
 * `GET /info` payload plus a one-time `GET /api/v2/openapi.json` probe,
 * cached on the session so per-request routing can consult it without an
 * extra round trip.
 *
 * That snapshot is load-bearing. Since #184 P3, `resolveApiVersion`
 * (`./api-version`) routes real operations on `hasV2Api` and, for the
 * operations that carry a `minVersion` floor, on `serverVersion`. Project,
 * view, label, team, saved-filter and task update all pick their strategy
 * from it, and `vikunja_auth` reports it as `activeApiVersion`. A change to
 * what this probe concludes is a change to which API those operations write
 * through, so treat a false positive here as a correctness bug rather than a
 * reporting one.
 *
 * The v2 probe is intentionally isolated from `vikunjaRestRequest`: that
 * helper always resolves paths against the v1 base URL
 * (`resolveBaseUrl`/`/api/v1`), builds circuit-breaker names assuming a v1
 * endpoint group, and retries — none of which is wanted for a single
 * best-effort, non-authenticated probe of a sibling `/api/v2` path. The
 * probe must also never throw or block `connect`/`info`/`status`: any
 * response that is not a recognizable OpenAPI document, and any network
 * error (including our own timeout abort), is treated identically as
 * "assume v1-only".
 */

import type { AuthManager } from '../auth/AuthManager';
import type { VikunjaCapabilities } from '../types/vikunja';
import { logger } from './logger';
import { resolveV2BaseUrl } from './vikunja-v2-url';

/** Bounds how long the one-time v2 probe can delay connect/info/status. */
const V2_PROBE_TIMEOUT_MS = 3000;

/**
 * Derives the `/api/v2/openapi.json` URL for a session's configured
 * `apiUrl`, regardless of whether that URL already carries an `/api/v{n}`
 * suffix. Composed from `resolveV2BaseUrl` (`./vikunja-v2-url`), the same
 * normalization the v2 transport (`./vikunja-rest-v2`) uses for its base
 * URL — imported from the shared, dependency-free module rather than from
 * the transport itself, so this probe doesn't pull in the transport's
 * circuit-breaker/retry machinery it deliberately avoids (see module doc
 * comment above).
 */
export function resolveV2ProbeUrl(apiUrl: string): string {
  return `${resolveV2BaseUrl(apiUrl)}/openapi.json`;
}

/**
 * True for a content type that can carry a JSON document.
 *
 * Deliberately not an equality check against `application/json`: Vikunja
 * serves `/api/v2/openapi.json` as `application/openapi+json` (verified live
 * on 2.4.0, 2.5.0 and 2.6.0 on 2026-09-05), so an equality check would
 * reject every genuinely v2-capable server. Any `+json` structured suffix is
 * accepted, and parameters (`; charset=utf-8`) are stripped first.
 */
function isJsonContentType(contentType: string): boolean {
  const essence = contentType.replace(/;.*$/, '').trim().toLowerCase();
  return essence === 'application/json' || essence.endsWith('+json');
}

/**
 * True for a parsed body that looks like an OpenAPI document: an object with
 * a top-level string `openapi`. The real document's top-level keys are
 * `{components, info, openapi, paths, security, servers}` with
 * `openapi: "3.1.0"`, so this key is a reliable discriminator against the
 * JSON a proxy or SPA catch-all might answer with instead.
 */
function looksLikeOpenApiDocument(body: unknown): boolean {
  if (typeof body !== 'object' || body === null) {
    return false;
  }
  return typeof (body as { openapi?: unknown }).openapi === 'string';
}

/**
 * One-time, best-effort probe for v2 API support. Resolves `false` — never
 * rejects — on any non-2xx status, network error, or timeout. Callers are
 * expected to cache the result (see {@link getOrDetectCapabilities}) rather
 * than probing on every call.
 *
 * A 2xx alone is NOT enough. A reverse proxy or SPA catch-all that answers
 * every unmatched path with `200` + `index.html` would otherwise report v2
 * support on a v1-only server. That was harmless while the result only fed
 * `vikunja_auth`'s status report, and stops being harmless the moment an
 * operation routes on it (issue #184 P3), so the probe also requires a JSON
 * content type and an actual OpenAPI document in the body.
 */
export async function probeV2Api(apiUrl: string): Promise<boolean> {
  const url = resolveV2ProbeUrl(apiUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), V2_PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(url, { method: 'GET', signal: controller.signal });
    if (!response.ok) {
      logger.debug('v2 API probe for %s returned HTTP %d; assuming v1-only', url, response.status);
      return false;
    }

    const contentType = response.headers.get('content-type') ?? '';
    if (!isJsonContentType(contentType)) {
      logger.debug(
        'v2 API probe for %s returned 200 with content type "%s", not a JSON document; assuming v1-only',
        url,
        contentType,
      );
      return false;
    }

    const body: unknown = await response.json();
    if (!looksLikeOpenApiDocument(body)) {
      logger.debug(
        'v2 API probe for %s returned JSON without a top-level "openapi" key; assuming v1-only',
        url,
      );
      return false;
    }

    return true;
  } catch (error) {
    logger.debug(
      'v2 API probe failed for %s: %s',
      url,
      error instanceof Error ? error.message : String(error),
    );
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Assembles a {@link VikunjaCapabilities} snapshot from an already-fetched
 * `GET /info` payload and a known v2-probe result. Pure/synchronous so it
 * can be reused both for the initial detection and for later refreshes that
 * reuse a cached probe result (see {@link getOrDetectCapabilities}).
 */
export function buildCapabilities(
  info: Record<string, unknown> | undefined,
  hasV2Api: boolean,
): VikunjaCapabilities {
  const version = info?.version;
  return {
    ...(typeof version === 'string' ? { serverVersion: version } : {}),
    features: info ?? {},
    hasV2Api,
  };
}

/**
 * Runs the v2 probe and builds a fresh {@link VikunjaCapabilities} snapshot.
 * Never throws — a failed probe just yields `hasV2Api: false`.
 */
export async function detectCapabilities(
  apiUrl: string,
  info: Record<string, unknown> | undefined,
): Promise<VikunjaCapabilities> {
  const hasV2Api = await probeV2Api(apiUrl);
  return buildCapabilities(info, hasV2Api);
}

/**
 * Returns this session's cached capabilities, refreshing the info-derived
 * fields (`serverVersion`/`features`) from a freshly-fetched `/info`
 * payload when the caller has one, while reusing the cached `hasV2Api`
 * probe result rather than re-probing. Probes (and caches) from scratch
 * only when no capabilities have been cached for this session yet — per the
 * "one-time probe" requirement, `GET /api/v2/openapi.json` is fetched at
 * most once per session.
 */
export async function getOrDetectCapabilities(
  authManager: AuthManager,
  info: Record<string, unknown> | undefined,
): Promise<VikunjaCapabilities> {
  const existing = authManager.getCapabilities();
  if (existing) {
    const refreshed = buildCapabilities(info, existing.hasV2Api);
    authManager.setCapabilities(refreshed);
    return refreshed;
  }

  const { apiUrl } = authManager.getSession();
  const detected = await detectCapabilities(apiUrl, info);
  authManager.setCapabilities(detected);
  return detected;
}
