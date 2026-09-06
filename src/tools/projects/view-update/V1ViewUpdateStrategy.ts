/**
 * Project view update against Vikunja's v1 API: fetch, merge, `POST` the whole
 * model.
 *
 *   GET  /projects/{project}/views/{view}
 *   -> POST /projects/{project}/views/{view}   (full model)
 *
 * This is the permanent floor, not a fallback, and it was moved here
 * unchanged rather than rewritten. The fetch is load-bearing on v1:
 * `ProjectView.Update` (go-vikunja pkg/models/project_view.go) writes an
 * explicit `Cols("title", "view_kind", "filter", "position",
 * "bucket_configuration_mode", "bucket_configuration", "default_bucket_id",
 * "done_bucket_id")` list, and a `Cols` column is persisted even when its
 * value is the zero value — so a bare partial body would silently reset a
 * view's position to 0 and blank its filter. See docs/API_NOTES.md "Project
 * Views" and docs/VIKUNJA_API_ISSUES.md #15.
 *
 * That read-modify-write is also the race the v2 strategy retires: two
 * concurrent v1 updates each POST a whole model built from their own snapshot,
 * so the later one restores whatever the earlier one changed.
 */

import { vikunjaRestRequest } from '../../../utils/vikunja-rest';
import { buildViewUpdatePayload } from './mapping';
import type { ViewUpdateInput, ViewUpdateStrategy, VikunjaProjectView } from './types';

export class V1ViewUpdateStrategy implements ViewUpdateStrategy {
  readonly apiVersion = 'v1' as const;

  async execute(input: ViewUpdateInput): Promise<VikunjaProjectView> {
    const { authManager, projectId, viewId, updates } = input;
    const path = `/projects/${projectId}/views/${viewId}`;

    const currentView = await vikunjaRestRequest<VikunjaProjectView>(authManager, 'GET', path);
    const payload = buildViewUpdatePayload(currentView, updates);

    return vikunjaRestRequest<VikunjaProjectView>(authManager, 'POST', path, payload);
  }
}
