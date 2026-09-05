/**
 * The contract both project-view update strategies satisfy.
 *
 * `update-view` and the `set-done-bucket` composite run one of two genuinely
 * different algorithms depending on which Vikunja API the session resolves to.
 * They are not the same request with a different URL prefix: v1 must read the
 * view, merge the caller's fields into the whole model and `POST` it back,
 * while v2 sends one `PATCH` carrying only the changed fields. Different call
 * count, different request body, so they live behind this interface rather
 * than as an `if (v2)` branch inside `updateView` (see the "Strategy + Context
 * per operation" section of
 * docs/superpowers/specs/2026-08-02-vikunja-v2-native-adoption-design.md).
 *
 * Whichever runs, the caller sees the same canonical result: a
 * `models.ProjectView` with the update applied, in the shape v1 has always
 * produced.
 */

import type { AuthManager } from '../../../auth/AuthManager';
import type { ApiVersion } from '../../../utils/api-version';
import type { components } from '../../../types/generated/vikunja-openapi';

// Sourced from the vendored OpenAPI spec (docs/vikunja-openapi.json) — see
// docs/API-SPEC.md. All fields are optional per the spec.
export type VikunjaProjectView = components['schemas']['models.ProjectView'];
export type VikunjaTaskCollection = components['schemas']['models.TaskCollection'];
export type VikunjaBucketConfiguration =
  components['schemas']['models.ProjectViewBucketConfiguration'];

export type ViewKind = 'list' | 'gantt' | 'table' | 'kanban';
export type BucketConfigurationMode = 'none' | 'manual' | 'filter';

/** One `bucket_configuration` entry as the caller supplies it (flat filter string). */
export interface ViewBucketConfigurationInput {
  /** Column title for the generated bucket. */
  title: string;
  /** Filter query selecting the tasks that land in this bucket. */
  filter?: string;
}

/** The caller-facing field deltas a strategy can apply to a view. */
export interface ViewFieldUpdates {
  title?: string;
  viewKind?: ViewKind;
  bucketConfigurationMode?: BucketConfigurationMode;
  bucketConfiguration?: ViewBucketConfigurationInput[];
  position?: number;
  filter?: string;
  doneBucketId?: number;
  defaultBucketId?: number;
}

/**
 * Everything a strategy needs to apply one view update.
 *
 * There is no `currentView` here, unlike `TaskUpdateInput`. Nothing outside
 * the strategy needs the pre-update view: `update-view` derives its
 * `affectedFields` from the caller's arguments, not from a diff. So the read
 * belongs to whichever strategy actually needs one, which is v1 only, and the
 * v2 path really does get down to a single request.
 */
export interface ViewUpdateInput {
  readonly authManager: AuthManager;
  readonly projectId: number;
  readonly viewId: number;
  readonly updates: ViewFieldUpdates;
}

export interface ViewUpdateStrategy {
  /** Which Vikunja API this strategy writes through. Diagnostics only. */
  readonly apiVersion: ApiVersion;

  /** Applies the update and resolves with the complete, updated view. */
  execute(input: ViewUpdateInput): Promise<VikunjaProjectView>;
}
