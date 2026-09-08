/**
 * Shared saved-filter REST access: the single read, and the single error map,
 * that `get`, `delete` and both `update` strategies use.
 *
 * Extracted from `../filters.ts` unchanged. It lives here because the update
 * strategy pair in `./update` needs the same read and the same 403/404 mapping
 * the tool module already had, and duplicating either would let the two drift
 * into reporting a missing filter differently depending on which API version
 * served the call.
 *
 * The read deliberately stays on v1 on both paths. v2 has a `GET
 * /filters/{filter}` too, but it returns a `max_permission` field v1 never
 * had, so routing this read to v2 would change the shape a caller sees for no
 * gain. Reading is not what this wave moves to v2.
 */

import type { AuthManager } from '../../auth/AuthManager';
import { ErrorCode, MCPError } from '../../types';
import { vikunjaRestRequest } from '../../utils/vikunja-rest';
import type { components } from '../../types/generated/vikunja-openapi';

export type SavedFilterApi = components['schemas']['models.SavedFilter'];

/**
 * Fetches a saved filter by id, mapping the API's 403/404 (Vikunja returns
 * 403 for both "doesn't exist" and "no access", per the spec's
 * `models.SavedFilter` responses) to a single honest NOT_FOUND error rather
 * than leaking the ambiguity to the caller as a raw HTTP error.
 */
export async function fetchSavedFilterOrThrow(
  authManager: AuthManager,
  id: number,
): Promise<SavedFilterApi> {
  try {
    return await vikunjaRestRequest<SavedFilterApi>(authManager, 'GET', `/filters/${id}`);
  } catch (error) {
    throw mapNotFound(error, id);
  }
}

/**
 * Maps a 403/404 REST error to NOT_FOUND; re-throws anything else as-is.
 *
 * Both transports feed this. v1's `POST /filters/{id}` and v2's `PATCH
 * /filters/{filter}` report a missing filter differently on the wire (v2
 * answers a problem+json `404` with Vikunja code 11001, "This saved filter
 * does not exist.", verified live on 2.4.0/2.5.0/2.6.0), but P1's error
 * adapter already lands both on an `MCPError` carrying
 * `details.statusCode`, so one status check covers both.
 */
export function mapNotFound(error: unknown, id: number): unknown {
  if (error instanceof MCPError) {
    const statusCode = error.details?.statusCode;
    if (statusCode === 403 || statusCode === 404) {
      return new MCPError(
        ErrorCode.NOT_FOUND,
        `Filter with id ${id} not found (or you do not have access to it)`,
      );
    }
  }
  return error;
}
