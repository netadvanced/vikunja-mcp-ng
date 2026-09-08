/**
 * The single decision point for whether an operation runs against Vikunja's
 * v1 or v2 API.
 *
 * v1 is a per-operation floor, not a version-level one. Every supported
 * Vikunja release (the trailing three: 2.4.0, 2.5.0, 2.6.0) has a v2 API, so
 * "the minimum version has none" is no longer a reason to stay on v1. Three
 * distinct reasons keep an operation on v1 instead, and only the third is
 * version-shaped:
 *
 *   1. No v2 equivalent exists on any version (`vikunja_admin list-users`,
 *      the Unsplash background functions). Permanently v1.
 *   2. v2 offers nothing over v1 for that operation (bulk update runs the
 *      same shared server-side model code). v1 by default, not by necessity.
 *   3. v2 is broken on some supported versions and fine on others (task
 *      update: v1 on 2.4.0, v2 from 2.5.0). That is what `minVersion` below
 *      exists for, and it resolves itself as the support window rolls
 *      forward.
 *
 * So every branch here defaults to v1 and only opts into v2 on positive
 * evidence — a cached capability probe that actually got an OpenAPI document
 * from `GET /api/v2/openapi.json` (see ./capabilities), plus, when the caller
 * asks for one, a detected server version at or above the operation's floor.
 *
 * Deliberately synchronous and free of network calls: capabilities are
 * detected once per session and cached on it, and this sits on a
 * per-request path.
 */

import type { AuthManager } from '../auth/AuthManager';
import { ConfigurationManager } from '../config/ConfigurationManager';
import { serverAtLeast } from './version';

export type ApiVersion = 'v1' | 'v2';

export interface ResolveApiVersionOptions {
  /**
   * The lowest server version at which this operation may use v2, as a plain
   * `X.Y.Z` string (a leading `v` is tolerated but not needed here; the
   * DETECTED version is what carries one, and the comparison strips it).
   *
   * Omit it for operations that can use v2 on any v2-capable server. Supply
   * it for operations whose v2 route is broken below a known release, for
   * example task update, which must stay on v1 on 2.4.0.
   *
   * A server whose version could not be detected resolves to v1 whenever
   * this is set. "We could not tell" is not evidence that a server is new
   * enough.
   */
  minVersion?: string;
}

/**
 * Resolves which API version this session should use for one operation.
 *
 * Returns `'v2'` only when the kill switch is off, the session has a cached
 * capability snapshot reporting v2 support, and (when `minVersion` is given)
 * the detected server version is at or above it. Returns `'v1'` otherwise,
 * including for sessions that have not been through capability detection.
 */
export function resolveApiVersion(
  authManager: AuthManager,
  options: ResolveApiVersionOptions = {},
): ApiVersion {
  if (ConfigurationManager.getInstance().isV1Forced()) {
    return 'v1';
  }

  const capabilities = authManager.getCapabilities();
  if (capabilities === undefined) {
    return 'v1';
  }

  if (!capabilities.hasV2Api) {
    return 'v1';
  }

  const { minVersion } = options;
  if (minVersion !== undefined && !serverAtLeast(capabilities.serverVersion, minVersion)) {
    return 'v1';
  }

  return 'v2';
}
