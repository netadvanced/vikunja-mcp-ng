/**
 * Project update against Vikunja's v1 API: merge the caller's fields onto the
 * current project and `POST` the whole model back.
 *
 * This is the permanent floor, not a fallback, and it was moved here rather
 * than rewritten. `POST /api/v1/projects/{id}` replaces the entire model, so
 * anything absent from the body is cleared, and two separate server-side
 * mechanisms make that worse than it sounds:
 *
 * 1. **`parent_project_id`** is a normal column, so an omitted value reads as
 *    `0` and detaches the project to the root.
 * 2. **`is_favorite`** never reaches xorm's column layer at all —
 *    `Project.IsFavorite` is tagged `xorm:"-"`, and `UpdateProject` calls
 *    `removeFromFavorite` whenever the bound value is `false` and the project
 *    was previously a favorite. An omitted `is_favorite` binds to Go's zero
 *    value, indistinguishable from an explicit unfavorite, so every unrelated
 *    partial update silently unfavorited the project. Different mechanism
 *    from the team `UseBool` trap, same symptom, same fix. See
 *    docs/API_NOTES.md "Project Operations" and
 *    docs/VIKUNJA_API_ISSUES.md §16.
 *
 * Carrying the fetched project's own values forward closes both. That is what
 * the merge is for, and it stays for as long as v1 does.
 */

import { vikunjaRestRequest } from '../../../utils/vikunja-rest';
import { buildProjectFieldPatch } from './analysis';
import { toCanonicalProject } from './canonical';
import type {
  ProjectUpdateFields,
  ProjectUpdateInput,
  ProjectUpdateStrategy,
  VikunjaProject,
} from './types';

/**
 * Builds a project update payload by merging current project state with
 * requested field changes. Vikunja's v1 update endpoint replaces the whole
 * model, so omitted fields would otherwise be cleared.
 */
export function buildProjectUpdatePayload(
  currentProject: VikunjaProject,
  updates: ProjectUpdateFields,
): VikunjaProject {
  return {
    ...currentProject,
    ...buildProjectFieldPatch(updates),
  };
}

export class V1ProjectUpdateStrategy implements ProjectUpdateStrategy {
  readonly apiVersion = 'v1' as const;

  async execute(input: ProjectUpdateInput): Promise<VikunjaProject> {
    const { authManager, projectId, fields, currentProject } = input;

    const updated = await vikunjaRestRequest<VikunjaProject>(
      authManager,
      'POST',
      `/projects/${projectId}`,
      buildProjectUpdatePayload(currentProject, fields),
    );

    // v1 answers with `max_permission` too, and with a different value from
    // v2's. See ./canonical for the probed table and why both strategies
    // strip it rather than only the v2 one.
    return toCanonicalProject(updated);
  }
}
