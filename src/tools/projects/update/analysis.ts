/**
 * The one place a caller's project-update fields become Vikunja wire fields.
 *
 * Both strategies feed off this function, so the v1 full-model body and the
 * v2 merge patch cannot drift: v1 spreads the result over the current
 * project, v2 sends it as-is. Normalisation that used to live inline in
 * `buildProjectUpdatePayload` (trimming the title and description, lowercasing
 * the hex colour) lives here for the same reason.
 */

import type { ProjectUpdateFields, VikunjaProject } from './types';

/**
 * Maps the supplied fields, and only the supplied fields, onto their wire
 * names.
 *
 * Every check is `!== undefined` rather than truthiness, because the falsy
 * values are all meaningful here: `''` clears a description, `false`
 * unarchives or unfavorites, and `0` on `parent_project_id` moves a project
 * to the root.
 */
export function buildProjectFieldPatch(fields: ProjectUpdateFields): Partial<VikunjaProject> {
  return {
    ...(fields.title !== undefined && { title: fields.title.trim() }),
    ...(fields.description !== undefined && { description: fields.description.trim() }),
    ...(fields.parentProjectId !== undefined && { parent_project_id: fields.parentProjectId }),
    ...(fields.isArchived !== undefined && { is_archived: fields.isArchived }),
    ...(fields.hexColor !== undefined && { hex_color: fields.hexColor.toLowerCase() }),
    ...(fields.isFavorite !== undefined && { is_favorite: fields.isFavorite }),
  };
}
