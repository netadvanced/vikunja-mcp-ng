/**
 * Picks the project-update strategy for the current session.
 *
 * There is no version floor here, and that is a probed result rather than an
 * oversight. Task update carries `minVersion: '2.5.0'` because v2's `PATCH`
 * 422s on 2.4.0 for any subscribed task; that bug is task-specific.
 * `PATCH /api/v2/projects/{id}` answered 200 and applied the change on 2.4.0,
 * 2.5.0 and 2.6.0 alike (probed 2026-09-06, table in
 * `./V2ProjectUpdateStrategy`), so plain `resolveApiVersion` is correct and
 * copying the task floor would have pinned two of the three supported
 * versions to v1 for no reason.
 *
 * `resolveApiVersion` already encodes the rest of the policy: the `forceV1Api`
 * kill switch means v1 on every version, a session that never went through
 * capability detection means v1, and a probe that found no v2 API means v1.
 *
 * An undetected *server version* is deliberately not on that list. With no
 * `minVersion` to compare it against, the version is never read, so a session
 * whose `GET /info` yielded no version string still resolves to v2 as long as
 * the probe found a v2 API. That is what `resolveApiVersion` does and what
 * `tests/utils/api-version.test.ts` pins. Only the floored operations, task
 * update being the one today, treat "version unknown" as "not new enough".
 */

import type { AuthManager } from '../../../auth/AuthManager';
import { resolveApiVersion } from '../../../utils/api-version';
import { V1ProjectUpdateStrategy } from './V1ProjectUpdateStrategy';
import { V2ProjectUpdateStrategy } from './V2ProjectUpdateStrategy';
import type { ProjectUpdateInput, ProjectUpdateStrategy, VikunjaProject } from './types';

/**
 * Chooses the strategy for a session.
 *
 * The `getCapabilities` guard is not paranoia about `AuthManager`: the
 * projects tool is reached from callers holding a narrower auth-manager-shaped
 * object (the same reason `pagination.ts`, `ClientSideFilteringStrategy` and
 * `selectTaskUpdateStrategy` guard it), and an update must fall back to the
 * always-correct v1 path rather than throw when capability detection is not
 * part of that object at all.
 */
export function selectProjectUpdateStrategy(authManager: AuthManager): ProjectUpdateStrategy {
  if (typeof authManager.getCapabilities !== 'function') {
    return new V1ProjectUpdateStrategy();
  }

  return resolveApiVersion(authManager) === 'v2'
    ? new V2ProjectUpdateStrategy()
    : new V1ProjectUpdateStrategy();
}

/**
 * Runs one project update through the strategy this session resolves to.
 *
 * Mirrors `TaskUpdateContext` and `FilteringContext`: the strategy is chosen
 * once at construction and the caller never learns which one it got.
 */
export class ProjectUpdateContext {
  private readonly strategy: ProjectUpdateStrategy;

  constructor(authManager: AuthManager) {
    this.strategy = selectProjectUpdateStrategy(authManager);
  }

  /** Which API the selected strategy writes through. Diagnostics and tests. */
  get apiVersion(): ProjectUpdateStrategy['apiVersion'] {
    return this.strategy.apiVersion;
  }

  async execute(input: ProjectUpdateInput): Promise<VikunjaProject> {
    return this.strategy.execute(input);
  }
}
