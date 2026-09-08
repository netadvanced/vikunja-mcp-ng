/**
 * The contract both team-update strategies satisfy.
 *
 * `vikunja_teams update` runs one of two genuinely different sequences
 * depending on which Vikunja API serves the session. They are not the same
 * calls with a different URL prefix:
 *
 *   v1   GET /teams/{id} -> POST /teams/{id} carrying the whole merged model
 *   v2   PATCH /api/v2/teams/{id} carrying only the caller's fields
 *
 * Different call count, different request body, and the v1 read exists purely
 * to build that body. That is the "call shape differs" bar the P3 design sets
 * for introducing a strategy pair rather than letting the response normalizer
 * absorb the difference (see the "Strategy + Context per operation" section of
 * docs/superpowers/specs/2026-08-02-vikunja-v2-native-adoption-design.md).
 *
 * Whichever runs, the caller sees the same canonical result: a `models.Team`
 * with its members embedded, in the shape v1 has always produced.
 */

import type { AuthManager } from '../../../auth/AuthManager';
import type { ApiVersion } from '../../../utils/api-version';
import type { TeamWithMembers } from '../types';

export type { Team, TeamMemberUser, TeamWithMembers } from '../types';

/**
 * The caller-supplied deltas for `vikunja_teams update`.
 *
 * Every field is optional and `undefined` means "leave it alone" on both
 * paths. `isPublic: false` is a real request to un-publish and is never
 * conflated with omission — the distinction the whole `UseBool` story below
 * hangs on.
 */
export interface TeamUpdateArgs {
  name?: string;
  description?: string;
  isPublic?: boolean;
}

/** Everything a strategy needs to apply one team update. */
export interface TeamUpdateInput {
  readonly authManager: AuthManager;
  readonly teamId: number;
  readonly args: TeamUpdateArgs;
}

export interface TeamUpdateStrategy {
  /** Which Vikunja API this strategy writes through. Diagnostics and tests. */
  readonly apiVersion: ApiVersion;

  /** Applies the update and resolves with the complete, updated team. */
  execute(input: TeamUpdateInput): Promise<TeamWithMembers>;
}
