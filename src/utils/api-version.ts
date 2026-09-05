/**
 * The single decision point for whether an operation runs against Vikunja's
 * v1 or v2 API.
 *
 * v1 is the permanent backward-compatible floor: the minimum supported
 * Vikunja is 2.3.0, which has no v2 API at all, and self-hosters lag. So
 * every branch here defaults to v1 and only opts into v2 on positive
 * evidence — a cached capability probe that actually got a 2xx from
 * `GET /api/v2/openapi.json` (see ./capabilities).
 *
 * Deliberately synchronous and free of network calls: capabilities are
 * detected once per session and cached on it, and this sits on a
 * per-request path.
 */

import type { AuthManager } from '../auth/AuthManager';
import { ConfigurationManager } from '../config/ConfigurationManager';

export type ApiVersion = 'v1' | 'v2';

/**
 * Resolves which API version this session should use.
 *
 * Returns `'v2'` only when the kill switch is off AND the session has a
 * cached capability snapshot reporting v2 support; `'v1'` otherwise,
 * including for sessions that have not been through capability detection.
 */
export function resolveApiVersion(authManager: AuthManager): ApiVersion {
  if (ConfigurationManager.getInstance().isV1Forced()) {
    return 'v1';
  }

  const capabilities = authManager.getCapabilities();
  if (capabilities === undefined) {
    return 'v1';
  }

  return capabilities.hasV2Api ? 'v2' : 'v1';
}
