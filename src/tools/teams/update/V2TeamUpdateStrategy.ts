/**
 * Team update against Vikunja's v2 API: one `PATCH` carrying only what the
 * caller asked to change.
 *
 * The interesting part is what this deletes. v1 has to read the team purely to
 * rebuild a full model it can safely `POST` back, because the v1 handler binds
 * into an empty struct and `pkg/models/teams.go` writes `is_public` with xorm's
 * `UseBool` — so any omitted boolean is written as an explicit `false` and a
 * rename silently un-publishes a public team (`docs/VIKUNJA_API_ISSUES.md`
 * §3a). That is the exact hazard `team-rename-keeps-visibility.json` guards.
 *
 * **v2's `PATCH` does not have it.** Probed live on 2026-09-05 against all
 * three supported versions, sqlite lanes, on a team stored with
 * `is_public: true` and a description:
 *
 *   | Version | PATCH {name} | is_public after | description after |
 *   |---------|--------------|-----------------|-------------------|
 *   | 2.4.0   | 200          | true            | preserved         |
 *   | 2.5.0   | 200          | true            | preserved         |
 *   | 2.6.0   | 200          | true            | preserved         |
 *
 * A description-only `PATCH` also returns 200 on all three rather than tripping
 * the required-name validator, and `is_public: false` / `is_public: true` are
 * both applied when sent explicitly, so omission and an explicit `false` stay
 * distinguishable. All three reasons the merge existed are gone on this path,
 * and the read goes with them: two calls become one.
 *
 * That is also why there is no `minVersion` floor here. Unlike task update,
 * whose v2 `PATCH` 422s on 2.4.0 for any subscribed task, nothing about the
 * teams route is broken on the floor, so plain `resolveApiVersion` is correct.
 *
 * Not done here, on purpose:
 *
 * - No `?format=markdown`. v2 ignores it on `PATCH` (confirmed live for this
 *   route: a description written as HTML came back as HTML), and the owner
 *   decision of 2026-09-05 is that update responses keep today's format rather
 *   than paying a re-read to make them cosmetically consistent with reads.
 * - No `If-Match`. v2 accepts the header and ignores it; there is no optimistic
 *   locking to build on.
 */

import { MCPError } from '../../../types';
import { vikunjaRestRequest } from '../../../utils/vikunja-rest';
import { vikunjaRestV2Request } from '../../../utils/vikunja-rest-v2';
import { buildTeamFieldPatch } from './fields';
import type { AuthManager } from '../../../auth/AuthManager';
import type { TeamUpdateInput, TeamUpdateStrategy, TeamWithMembers } from './types';

/**
 * Fields v2 adds to a team that v1 has never returned, and that must not reach
 * a caller: the P3 spec's non-goals put `max_permission` out of scope for this
 * milestone's tool surface, and leaking it would be a caller-visible tell of
 * which strategy ran.
 *
 * Live on 2.4.0/2.5.0/2.6.0 the `PATCH` response does not actually carry it
 * (only `GET /api/v2/teams/{id}` does), so this is a boundary guarantee rather
 * than a fix for something observed. It is cheap and it is what keeps the
 * canonical-shape claim true if a later release starts populating it on writes.
 * (`$schema`, the other v2 addition, is already removed by the transport's
 * response normalizer.)
 */
type V2OnlyTeamFields = { max_permission?: unknown };

/**
 * Vikunja answers `304 Not Modified`, with no body, when a merge patch would
 * leave the team exactly as it is — including setting a field to the value it
 * already holds. Confirmed live on all three supported versions.
 */
const NOT_MODIFIED = 304;

/**
 * Removes v2-only fields so the returned team is comparable with the one the v1
 * strategy produces.
 */
function toCanonicalTeam(team: TeamWithMembers): TeamWithMembers {
  const canonical: TeamWithMembers & V2OnlyTeamFields = { ...team };
  delete canonical.max_permission;
  return canonical;
}

function isNotModified(error: unknown): boolean {
  return error instanceof MCPError && error.details?.statusCode === NOT_MODIFIED;
}

export class V2TeamUpdateStrategy implements TeamUpdateStrategy {
  readonly apiVersion = 'v2' as const;

  async execute(input: TeamUpdateInput): Promise<TeamWithMembers> {
    const { authManager, teamId, args } = input;

    try {
      const patched = await vikunjaRestV2Request<TeamWithMembers>(
        authManager,
        'PATCH',
        `/teams/${teamId}`,
        buildTeamFieldPatch(args),
      );
      return toCanonicalTeam(patched);
    } catch (error) {
      if (isNotModified(error)) {
        return this.readTeam(authManager, teamId);
      }
      throw error;
    }
  }

  /**
   * The no-op fallback read. A `304` means the update asked for nothing the
   * team does not already have, but the caller is still owed the current team,
   * and v1 has no equivalent of a bodyless success to reproduce.
   *
   * It stays on v1 deliberately: that is the same call the v1 strategy makes,
   * so the team the caller gets back is shaped identically whichever branch
   * produced it, with no v2-only fields to strip.
   */
  private async readTeam(authManager: AuthManager, teamId: number): Promise<TeamWithMembers> {
    return vikunjaRestRequest<TeamWithMembers>(authManager, 'GET', `/teams/${teamId}`);
  }
}
