/**
 * Team shapes shared by `src/tools/teams.ts` and the update strategies under
 * `./update`.
 *
 * They live here rather than in the tool module so a strategy can depend on
 * them without importing its own caller, the same reason
 * `src/tools/tasks/crud/update/types.ts` holds `VikunjaTask`.
 */

import type { components } from '../../types/generated/vikunja-openapi';

/**
 * Sourced from the vendored OpenAPI spec (docs/vikunja-openapi.json) — see
 * docs/API-SPEC.md, replacing the legacy client's `Team` type (Wave D domain
 * migration, tracking issue #28).
 */
export type Team = components['schemas']['models.Team'];

/**
 * A team member as embedded in the `members` array of a `GET /teams/{id}`
 * response (server-side `models.TeamUser`): the member's public user fields
 * plus their team-admin flag. `team_id` is not exposed by the API.
 */
export interface TeamMemberUser {
  id: number;
  name?: string;
  username: string;
  email?: string;
  admin: boolean;
  created?: string;
  updated?: string;
}

/**
 * The team shape every read and write of a single team actually returns: a
 * `Team` with its members embedded. The generated `Team` type does not model
 * that field, so it is declared here per the OpenAPI spec / server
 * `models.Team` struct.
 *
 * Verified live on 2.4.0, 2.5.0 and 2.6.0 (2026-09-05): v1 `GET /teams/{id}`,
 * v1 `POST /teams/{id}` and v2 `PATCH /api/v2/teams/{id}` all answer with the
 * same key set, `members` included, which is what lets the two update
 * strategies share one return type.
 *
 * (An intersection, not `extends`, because `Team`'s inherited index signature
 * rejects an array-typed `members` property on a plain interface extension.)
 */
export type TeamWithMembers = Team & { members?: TeamMemberUser[] };
