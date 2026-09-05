/**
 * Team update against Vikunja's v1 API: read the team, merge the caller's
 * deltas over it, `POST` the whole model back.
 *
 * This is the permanent floor, moved rather than rewritten. The merge is not a
 * convenience, it is load-bearing, and three separate server-side facts make it
 * so (verified in go-vikunja source, v2.3.0, and recorded as
 * `docs/VIKUNJA_API_ISSUES.md` §3a):
 *
 *  - `pkg/web/handler/update.go:37` binds the request body into an EMPTY struct
 *    (`c.EmptyStruct()`); nothing is merged from the stored row, so the body we
 *    send is the whole model the server sees.
 *  - `pkg/models/teams.go:388` writes with
 *    `s.ID(t.ID).UseBool("is_public").Update(t)`. xorm skips zero-valued columns
 *    on a struct update, but `UseBool` forces `is_public` to be written EVEN
 *    WHEN FALSE, so a partial body that omitted it silently flipped a public
 *    team to private.
 *  - `pkg/models/teams.go:37` marks `Name` `valid:"required,..."` and
 *    `Team.Update` (`teams.go:378`) returns `ErrTeamNameCannotBeEmpty` when it
 *    is empty, so a description-only partial body was rejected outright with
 *    HTTP 400.
 *
 * The API only routes team updates through `POST /teams/{id}`; `PUT` is
 * reserved for team creation (`PUT /teams`) and 404s/405s here.
 */

import { vikunjaRestRequest } from '../../../utils/vikunja-rest';
import { buildTeamFieldPatch } from './fields';
import type { TeamUpdateArgs, TeamUpdateInput, TeamUpdateStrategy, TeamWithMembers } from './types';

/**
 * Builds a team update payload by merging the team's current server-side state
 * with the caller's requested changes.
 *
 * Spreading the whole fetched team, rather than copying a hand-maintained
 * allow-list of fields, is deliberate: an allow-list silently drops fields the
 * server adds in later versions. Mirrors `buildProjectUpdatePayload`
 * (`src/tools/projects/crud.ts`).
 */
export function buildTeamUpdatePayload(
  currentTeam: TeamWithMembers,
  updates: TeamUpdateArgs,
): TeamWithMembers {
  return {
    ...currentTeam,
    ...buildTeamFieldPatch(updates),
  };
}

export class V1TeamUpdateStrategy implements TeamUpdateStrategy {
  readonly apiVersion = 'v1' as const;

  async execute(input: TeamUpdateInput): Promise<TeamWithMembers> {
    const { authManager, teamId, args } = input;

    const currentTeam = await vikunjaRestRequest<TeamWithMembers>(
      authManager,
      'GET',
      `/teams/${teamId}`,
    );

    return vikunjaRestRequest<TeamWithMembers>(
      authManager,
      'POST',
      `/teams/${teamId}`,
      buildTeamUpdatePayload(currentTeam, args),
    );
  }
}
