/**
 * Picks the project-view update strategy for the current session.
 *
 * There is no version floor. `resolveApiVersion` is called with no
 * `minVersion` because v2's `PATCH /projects/{project}/views/{view}` behaved
 * identically on every supported release when it was probed live on
 * 2026-09-05:
 *
 *   | Version | partial PATCH | untouched fields | no-op patch |
 *   |---------|---------------|------------------|-------------|
 *   | 2.4.0   | 200, applied  | preserved        | 304         |
 *   | 2.5.0   | 200, applied  | preserved        | 304         |
 *   | 2.6.0   | 200, applied  | preserved        | 304         |
 *
 * Task update carries a 2.5.0 floor because 2.4.0's `PATCH /tasks/{id}` 422s
 * on any task with a subscription. That bug is task-specific and does not
 * apply here, so copying the floor would keep 2.4.0 on the slower path for no
 * reason.
 *
 * `resolveApiVersion` encodes the rest of the policy: the kill switch means v1
 * on every version, and an undetected server version means v1 rather than an
 * optimistic guess.
 */

import type { AuthManager } from '../../../auth/AuthManager';
import { resolveApiVersion } from '../../../utils/api-version';
import { V1ViewUpdateStrategy } from './V1ViewUpdateStrategy';
import { V2ViewUpdateStrategy } from './V2ViewUpdateStrategy';
import type { ViewUpdateInput, ViewUpdateStrategy, VikunjaProjectView } from './types';

/**
 * Chooses the strategy for a session.
 *
 * The `getCapabilities` guard mirrors `selectTaskUpdateStrategy`: sessions
 * reach this from callers holding a narrower auth-manager-shaped object, and
 * an update must fall back to the always-correct v1 path rather than throw
 * when capability detection is not part of that object at all.
 */
export function selectViewUpdateStrategy(authManager: AuthManager): ViewUpdateStrategy {
  if (typeof authManager.getCapabilities !== 'function') {
    return new V1ViewUpdateStrategy();
  }

  return resolveApiVersion(authManager) === 'v2'
    ? new V2ViewUpdateStrategy()
    : new V1ViewUpdateStrategy();
}

/**
 * Runs one project view update through the strategy this session resolves to.
 *
 * Mirrors `TaskUpdateContext`: the strategy is chosen once at construction and
 * the caller never learns which one it got.
 */
export class ViewUpdateContext {
  private readonly strategy: ViewUpdateStrategy;

  constructor(authManager: AuthManager) {
    this.strategy = selectViewUpdateStrategy(authManager);
  }

  /** Which API the selected strategy writes through. Diagnostics and tests. */
  get apiVersion(): ViewUpdateStrategy['apiVersion'] {
    return this.strategy.apiVersion;
  }

  async execute(input: ViewUpdateInput): Promise<VikunjaProjectView> {
    return this.strategy.execute(input);
  }
}
