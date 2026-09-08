/**
 * The one place the caller's arguments become Vikunja field names.
 *
 * Both strategies feed off this, so the two paths cannot drift into disagreeing
 * about what `isPublic: false` means or which fields an update is allowed to
 * touch. v1 spreads the result over the whole stored model; v2 sends it as the
 * merge patch. Mirrors `buildTaskFieldPatch` in
 * `src/tools/tasks/crud/update/analysis.ts`.
 */

import type { TeamUpdateArgs } from './types';

/**
 * The three `models.Team` columns `vikunja_teams update` can write, spelled the
 * way the wire spells them.
 *
 * Declared as its own type rather than `Partial<Team>` so the v1 merge cannot
 * accidentally widen a field it never sets: `Partial<Team>` would pull in
 * `members` and friends, and the merged payload's type would then disagree with
 * the fetched team it is built from.
 */
export interface TeamFieldPatch {
  name?: string;
  description?: string;
  is_public?: boolean;
}

/**
 * Maps the caller's deltas onto Vikunja's field names.
 *
 * The tests are on `undefined`, never on truthiness: `description: ''` clears a
 * description and `isPublic: false` un-publishes a team, and both are real
 * requests that an omission must not be confused with.
 */
export function buildTeamFieldPatch(args: TeamUpdateArgs): TeamFieldPatch {
  return {
    ...(args.name !== undefined && { name: args.name }),
    ...(args.description !== undefined && { description: args.description }),
    ...(args.isPublic !== undefined && { is_public: args.isPublic }),
  };
}
