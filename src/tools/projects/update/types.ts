/**
 * The contract both project-update strategies satisfy.
 *
 * Four MCP functions write a project this way — `update`, `archive`,
 * `unarchive` and `move` — and all four are the same operation with a
 * different field bag, so they share one contract rather than four
 * near-copies (see the "Strategy + Context per operation" section of
 * docs/superpowers/specs/2026-08-02-vikunja-v2-native-adoption-design.md).
 *
 * Whichever strategy runs, the caller sees the same canonical result: a
 * `models.Project` with the update applied, in the shape v1 has always
 * produced.
 */

import type { AuthManager } from '../../../auth/AuthManager';
import type { ApiVersion } from '../../../utils/api-version';
import type { components } from '../../../types/generated/vikunja-openapi';

/** `models.Project` per the OpenAPI spec — the canonical internal shape. */
export type VikunjaProject = components['schemas']['models.Project'];

/**
 * The caller-supplied changes, in the tool surface's camelCase vocabulary.
 *
 * Every field is optional and `undefined` means "leave it alone", with one
 * deliberate exception the callers own rather than this type: `move` always
 * supplies `parentProjectId` (`0` for root), because an omitted parent there
 * means *move to root* rather than *keep the current parent*. See
 * `moveProject` in `../hierarchy`.
 */
export interface ProjectUpdateFields {
  title?: string;
  description?: string;
  parentProjectId?: number;
  isArchived?: boolean;
  hexColor?: string;
  /**
   * Favorite/unfavorite for the calling user. `false` means "unfavorite", not
   * "unset" — which is exactly the ambiguity that makes this field the
   * trickiest one on the v1 path. See `../../../docs/VIKUNJA_API_ISSUES.md`
   * §16 and the comment in `./V1ProjectUpdateStrategy`.
   */
  isFavorite?: boolean;
}

/**
 * Everything a strategy needs to apply one project update.
 *
 * `currentProject` is read once by the caller, before dispatch, on both
 * paths. That read is not the merge's overhead: every call site needs it
 * anyway — `update` to resolve the parent for hierarchy validation, `archive`
 * and `unarchive` to answer "already in that state", `move` to report the old
 * parent — so passing it in costs nothing and lets the v1 strategy build its
 * full-model body without a second fetch.
 *
 * The v2 strategy deliberately ignores it for the request body. It never
 * echoes fields the caller did not name, so two concurrent v2 updates cannot
 * overwrite each other's untouched fields the way two v1 full-model POSTs
 * can.
 */
export interface ProjectUpdateInput {
  readonly authManager: AuthManager;
  readonly projectId: number;
  readonly fields: ProjectUpdateFields;
  /** The project as it was immediately before the update. */
  readonly currentProject: VikunjaProject;
}

export interface ProjectUpdateStrategy {
  /** Which Vikunja API this strategy writes through. Diagnostics only. */
  readonly apiVersion: ApiVersion;

  /** Applies the update and resolves with the complete, updated project. */
  execute(input: ProjectUpdateInput): Promise<VikunjaProject>;
}
