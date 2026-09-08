/**
 * Picks the team-update strategy for the current session.
 *
 * There is no version floor here, and that is a measured claim rather than an
 * omission. `PATCH /api/v2/teams/{id}` was probed on 2026-09-05 against the
 * live 2.4.0, 2.5.0 and 2.6.0 stacks: on all three a name-only patch returns
 * 200, leaves `is_public` and the description untouched, and a description-only
 * patch is accepted rather than rejected by the server's required-name
 * validator. Nothing about this route is broken on the floor, so it uses plain
 * `resolveApiVersion`. Copying task update's `minVersion: '2.5.0'` would have
 * pinned every 2.4.0 server to v1 for no reason: that floor exists for the
 * subscription-422, which is specific to tasks.
 *
 * `resolveApiVersion` still encodes the rest of the policy: the `forceV1Api`
 * kill switch means v1 on every version, a server with no v2 API means v1, and
 * a session that has not been through capability detection means v1 rather than
 * an optimistic guess.
 */

import type { AuthManager } from '../../../auth/AuthManager';
import { resolveApiVersion } from '../../../utils/api-version';
import { V1TeamUpdateStrategy } from './V1TeamUpdateStrategy';
import { V2TeamUpdateStrategy } from './V2TeamUpdateStrategy';
import type { TeamUpdateInput, TeamUpdateStrategy, TeamWithMembers } from './types';

/**
 * Chooses the strategy for a session.
 *
 * The `getCapabilities` guard is not paranoia about `AuthManager`: sessions
 * reach this from callers holding a narrower auth-manager-shaped object (the
 * same reason `pagination.ts` and `TaskUpdateContext` guard it), and an update
 * must fall back to the always-correct v1 path rather than throw when
 * capability detection is not part of that object at all.
 */
export function selectTeamUpdateStrategy(authManager: AuthManager): TeamUpdateStrategy {
  if (typeof authManager.getCapabilities !== 'function') {
    return new V1TeamUpdateStrategy();
  }

  return resolveApiVersion(authManager) === 'v2'
    ? new V2TeamUpdateStrategy()
    : new V1TeamUpdateStrategy();
}

/**
 * Runs one team update through the strategy this session resolves to.
 *
 * Mirrors `TaskUpdateContext` and `FilteringContext`: the strategy is chosen
 * once at construction and the caller never learns which one it got.
 */
export class TeamUpdateContext {
  private readonly strategy: TeamUpdateStrategy;

  constructor(authManager: AuthManager) {
    this.strategy = selectTeamUpdateStrategy(authManager);
  }

  /** Which API the selected strategy writes through. Diagnostics and tests. */
  get apiVersion(): TeamUpdateStrategy['apiVersion'] {
    return this.strategy.apiVersion;
  }

  async execute(input: TeamUpdateInput): Promise<TeamWithMembers> {
    return this.strategy.execute(input);
  }
}
