/**
 * The project-update strategy pair and the context that selects between them.
 * See ./ProjectUpdateContext for the version rule and ./types for the
 * contract.
 *
 * Only the selection surface and the v1 payload builder are re-exported. The
 * strategies themselves are reached through the context, so exporting them
 * from the barrel would be an invitation to bypass the routing decision.
 * `buildProjectUpdatePayload` is the exception: it is v1's merge, it is named
 * by docs/API_NOTES.md and docs/VIKUNJA_API_ISSUES.md §16 as the fix for the
 * `is_favorite` trap, and it is worth reading and testing directly.
 */

export { ProjectUpdateContext, selectProjectUpdateStrategy } from './ProjectUpdateContext';
export { buildProjectUpdatePayload } from './V1ProjectUpdateStrategy';
export { buildProjectFieldPatch } from './analysis';
export type {
  ProjectUpdateFields,
  ProjectUpdateInput,
  ProjectUpdateStrategy,
  VikunjaProject,
} from './types';
