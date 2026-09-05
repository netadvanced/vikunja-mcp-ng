/**
 * Picks the task-update strategy for the current session.
 *
 * The rule is a single version floor, and it is the whole reason `#184` needed
 * a per-operation `minVersion` at all. Re-probed live on 2026-09-05:
 *
 *   | Version | assigning auto-subscribes | v2 PATCH on a subscribed task |
 *   |---------|--------------------------|-------------------------------|
 *   | 2.4.0   | yes                      | 422, body.subscription.entity |
 *   | 2.5.0   | yes                      | 200, applied and preserved    |
 *   | 2.6.0   | yes (creator too)        | 200, applied and preserved    |
 *
 * On 2.4.0 a bare task patches fine and then 422s forever once it gains an
 * assignee, which is precisely the operation this milestone set out to
 * improve. So the floor is 2.5.0, and 2.4.0 keeps the v1 strategy — not as a
 * degraded fallback, but because fetch-merge-POST is the correct way to update
 * a task on a server with no working partial-update route for it.
 *
 * `resolveApiVersion` already encodes the rest of the policy: kill switch on
 * means v1 on every version, and an undetected server version means v1 rather
 * than an optimistic guess.
 */

import type { AuthManager } from '../../../../auth/AuthManager';
import { resolveApiVersion } from '../../../../utils/api-version';
import { V1TaskUpdateStrategy } from './V1TaskUpdateStrategy';
import { V2TaskUpdateStrategy } from './V2TaskUpdateStrategy';
import type { TaskUpdateInput, TaskUpdateStrategy, VikunjaTask } from './types';

/**
 * The oldest Vikunja release whose v2 `PATCH /tasks/{id}` can be trusted with
 * a task that carries a subscription. Below it, this operation stays on v1.
 */
export const TASK_UPDATE_V2_MIN_VERSION = '2.5.0';

/**
 * Chooses the strategy for a session.
 *
 * The `getCapabilities` guard is not paranoia about `AuthManager`: sessions
 * reach this from callers holding a narrower auth-manager-shaped object (the
 * same reason `pagination.ts` and `ClientSideFilteringStrategy` guard it), and
 * an update must fall back to the always-correct v1 path rather than throw
 * when capability detection is not part of that object at all.
 */
export function selectTaskUpdateStrategy(authManager: AuthManager): TaskUpdateStrategy {
  if (typeof authManager.getCapabilities !== 'function') {
    return new V1TaskUpdateStrategy();
  }

  const version = resolveApiVersion(authManager, { minVersion: TASK_UPDATE_V2_MIN_VERSION });
  return version === 'v2' ? new V2TaskUpdateStrategy() : new V1TaskUpdateStrategy();
}

/**
 * Runs one task update through the strategy this session resolves to.
 *
 * Mirrors `FilteringContext` in `src/utils/filtering/`: the strategy is chosen
 * once at construction and the caller never learns which one it got.
 */
export class TaskUpdateContext {
  private readonly strategy: TaskUpdateStrategy;

  constructor(authManager: AuthManager) {
    this.strategy = selectTaskUpdateStrategy(authManager);
  }

  /** Which API the selected strategy writes through. Diagnostics and tests. */
  get apiVersion(): TaskUpdateStrategy['apiVersion'] {
    return this.strategy.apiVersion;
  }

  async execute(input: TaskUpdateInput): Promise<VikunjaTask> {
    return this.strategy.execute(input);
  }
}
