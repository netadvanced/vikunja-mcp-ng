/**
 * Picks the saved-filter update strategy for the current session.
 *
 * There is **no version floor here**, and that is a probed result rather than
 * an omission. `PATCH /api/v2/filters/{filter}` was exercised against the live
 * 2.4.0, 2.5.0 and 2.6.0 stacks on 2026-09-05 and behaved identically on all
 * three: partial field patches apply, the `filters` sub-object merges per key,
 * `is_favorite: false` sticks, an invalid query string is rejected with the
 * same error v1 gives, a no-op answers `304`, and a missing filter answers
 * `404`. Nothing about this route resembles the task-update case, where 2.4.0
 * `422`s on any subscribed task and forced `minVersion: '2.5.0'`; copying that
 * floor here would keep 2.4.0 on the slower two-call path for no reason.
 *
 * `resolveApiVersion` still encodes the rest of the policy: kill switch on
 * means v1 on every version, no v2 API means v1, and a session that never went
 * through capability detection means v1 rather than an optimistic guess.
 */

import type { AuthManager } from '../../../auth/AuthManager';
import { resolveApiVersion } from '../../../utils/api-version';
import { V1SavedFilterUpdateStrategy } from './V1SavedFilterUpdateStrategy';
import { V2SavedFilterUpdateStrategy } from './V2SavedFilterUpdateStrategy';
import type { SavedFilterApi, SavedFilterUpdateInput, SavedFilterUpdateStrategy } from './types';

/**
 * Chooses the strategy for a session.
 *
 * The `getCapabilities` guard mirrors `selectTaskUpdateStrategy`: sessions
 * reach this from callers holding a narrower auth-manager-shaped object, and
 * an update must fall back to the always-correct v1 path rather than throw
 * when capability detection is not part of that object at all.
 */
export function selectSavedFilterUpdateStrategy(
  authManager: AuthManager,
): SavedFilterUpdateStrategy {
  if (typeof authManager.getCapabilities !== 'function') {
    return new V1SavedFilterUpdateStrategy();
  }

  return resolveApiVersion(authManager) === 'v2'
    ? new V2SavedFilterUpdateStrategy()
    : new V1SavedFilterUpdateStrategy();
}

/**
 * Runs one saved-filter update through the strategy this session resolves to.
 *
 * Mirrors `TaskUpdateContext`: the strategy is chosen once at construction and
 * the caller never learns which one it got.
 */
export class SavedFilterUpdateContext {
  private readonly strategy: SavedFilterUpdateStrategy;

  constructor(authManager: AuthManager) {
    this.strategy = selectSavedFilterUpdateStrategy(authManager);
  }

  /** Which API the selected strategy writes through. Diagnostics and tests. */
  get apiVersion(): SavedFilterUpdateStrategy['apiVersion'] {
    return this.strategy.apiVersion;
  }

  async execute(input: SavedFilterUpdateInput): Promise<SavedFilterApi> {
    return this.strategy.execute(input);
  }
}
