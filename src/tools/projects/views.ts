/**
 * Project view operations
 *
 * Implements `list-views`, `get-view`, `create-view`, `update-view`,
 * `delete-view`, and the `set-done-bucket` composite, against Vikunja's
 * project view endpoints (`/projects/{project}/views[/{id}]`). legacy client
 * has no support for project views at all, so — like `buckets.ts` — this
 * calls the Vikunja REST API directly via the shared `vikunja-rest` helper.
 *
 * `update-view` and `set-done-bucket` are the two write paths that change an
 * existing view, and both run through `ViewUpdateContext` (see
 * ./view-update/), which picks between two genuinely different call shapes:
 *
 *   v1: GET the view, merge the caller's fields into the whole model, POST it
 *       back. The merge is load-bearing, because go-vikunja's
 *       `ProjectView.Update` writes an explicit `Cols(...)` allowlist and
 *       persists every named column even at its zero value, so a bare partial
 *       body would reset a view's position to 0 and blank its filter.
 *   v2: one PATCH carrying only the changed fields. The server does that merge
 *       itself, which removes the read and the read-modify-write race.
 *
 * Kanban buckets stay on v1 permanently and are not touched here: v2 has no
 * `PATCH` on a bucket at all. `done_bucket_id` and `default_bucket_id` are
 * fields of the *view*, which is why `set-done-bucket` is a view update rather
 * than a bucket update (docs/API_NOTES.md, "Setting the Done Bucket").
 *
 * `create-view` is unrelated to all of that and stays on v1's
 * `PUT /projects/{project}/views`.
 *
 * Fields the create/update surface forwards, and the two it deliberately
 * refuses: `position` and `filter` are honored by BOTH endpoints (the create
 * handler inserts the whole struct before `calculateDefaultPosition` fills
 * in a zero position), and `bucket_configuration` is what makes
 * `bucketConfigurationMode: 'filter'` mean anything.
 * `doneBucketId`/`defaultBucketId` are honored by `update-view` only —
 * `create-view` REJECTS them with a pointer to `update-view` /
 * `set-done-bucket` rather than dropping them silently, because a brand-new
 * view owns no buckets yet (see `createView`).
 */

import type { AuthManager } from '../../auth/AuthManager';
import { MCPError, ErrorCode } from '../../types';
import { validateId } from '../../utils/validation';
import { createStandardResponse, formatAorpAsMarkdown } from '../../utils/response-factory';
import { vikunjaRestRequest, resolveKanbanViewId } from '../../utils/vikunja-rest';
import { ViewUpdateContext, buildViewFilter, buildBucketConfiguration } from './view-update';
import type {
  VikunjaProjectView,
  ViewKind,
  BucketConfigurationMode,
  ViewBucketConfigurationInput,
  ViewFieldUpdates,
} from './view-update';

// Re-exported so the field mapping and its types keep a single import path for
// existing callers and tests, even though they now live with the strategies.
export { buildViewUpdatePayload } from './view-update';
export type { ViewBucketConfigurationInput, ViewFieldUpdates } from './view-update';

export interface ListViewsArgs {
  /** Project whose views should be listed. */
  id?: number;
  /** Session id for response tracking. */
  sessionId?: string;
}

export interface GetViewArgs {
  /** Project the view belongs to. */
  id?: number;
  /** Id of the view to fetch. */
  viewId?: number;
  /** Session id for response tracking. */
  sessionId?: string;
}

export interface CreateViewArgs {
  /** Project the new view should belong to. */
  id?: number;
  /** Title of the new view. */
  title?: string;
  /** Kind of view to create (`list`, `gantt`, `table`, or `kanban`). */
  viewKind?: ViewKind;
  /** Bucket configuration mode. Only meaningful for kanban-style views. */
  bucketConfigurationMode?: BucketConfigurationMode;
  /**
   * Ordered `bucket_configuration` entries — required for the board to have
   * any columns when `bucketConfigurationMode` is `filter`.
   */
  bucketConfiguration?: ViewBucketConfigurationInput[];
  /**
   * Sort position among the project's views. Views are listed ordered by
   * this ascending. Omitted (or `0`) means "let Vikunja assign the default"
   * — `calculateDefaultPosition` turns a zero into `viewId * 2^16`.
   */
  position?: number;
  /** Filter query restricting which tasks this view shows. */
  filter?: string;
  /**
   * NOT settable at create time — accepted only so the call can be REJECTED
   * with a pointer to `update-view` / `set-done-bucket` instead of silently
   * dropping it. See `createView`.
   */
  doneBucketId?: number;
  /** NOT settable at create time — see `doneBucketId`. */
  defaultBucketId?: number;
  /** Session id for response tracking. */
  sessionId?: string;
}

export interface UpdateViewArgs {
  /** Project the view belongs to. */
  id?: number;
  /** Id of the view to update. */
  viewId?: number;
  /** New title, if changing. */
  title?: string;
  /** New view kind, if changing. */
  viewKind?: ViewKind;
  /** New bucket configuration mode, if changing. */
  bucketConfigurationMode?: BucketConfigurationMode;
  /** New ordered `bucket_configuration` entries, if changing. */
  bucketConfiguration?: ViewBucketConfigurationInput[];
  /** New sort position among the project's views, if changing. */
  position?: number;
  /** New filter query for the view, if changing. */
  filter?: string;
  /** New done-bucket id, if changing. Also settable via `set-done-bucket`. */
  doneBucketId?: number;
  /** New default-bucket id, if changing. */
  defaultBucketId?: number;
  /** Session id for response tracking. */
  sessionId?: string;
}

export interface DeleteViewArgs {
  /** Project the view belongs to. */
  id?: number;
  /** Id of the view to delete. */
  viewId?: number;
  /** Session id for response tracking. */
  sessionId?: string;
}

export interface SetDoneBucketArgs {
  /** Project whose Kanban view's done bucket should be set. */
  id?: number;
  /** Optional Kanban view id. Auto-resolved from the project when omitted. */
  viewId?: number;
  /** Id of the bucket that should become the done bucket. */
  bucketId?: number;
  /** Session id for response tracking. */
  sessionId?: string;
}

function viewSummary(view: VikunjaProjectView): Record<string, unknown> {
  return {
    id: view.id,
    title: view.title,
    viewKind: view.view_kind,
    position: view.position,
    bucketConfigurationMode: view.bucket_configuration_mode,
    bucketConfiguration: view.bucket_configuration,
    filter: view.filter?.filter,
    defaultBucketId: view.default_bucket_id,
    doneBucketId: view.done_bucket_id,
  };
}

/**
 * Lists the views of a project.
 */
export async function listViews(
  args: ListViewsArgs,
  authManager: AuthManager,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  if (!args.id) {
    throw new MCPError(
      ErrorCode.VALIDATION_ERROR,
      'Project id is required for list-views operation',
    );
  }
  validateId(args.id, 'id');

  const views = await vikunjaRestRequest<VikunjaProjectView[]>(
    authManager,
    'GET',
    `/projects/${args.id}/views`,
  );
  const viewList = Array.isArray(views) ? views : [];

  const response = createStandardResponse(
    'list-views',
    `Found ${viewList.length} views for project ${args.id}`,
    {
      projectId: args.id,
      views: viewList.map(viewSummary),
    },
    {
      timestamp: new Date().toISOString(),
      count: viewList.length,
    },
    args.sessionId,
  );

  return {
    content: [{ type: 'text' as const, text: formatAorpAsMarkdown(response) }],
  };
}

/**
 * Gets a single project view by id.
 */
export async function getView(
  args: GetViewArgs,
  authManager: AuthManager,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  if (!args.id) {
    throw new MCPError(ErrorCode.VALIDATION_ERROR, 'Project id is required for get-view operation');
  }
  if (args.viewId === undefined || args.viewId === null) {
    throw new MCPError(ErrorCode.VALIDATION_ERROR, 'View id is required for get-view operation');
  }
  validateId(args.id, 'id');
  validateId(args.viewId, 'viewId');

  const view = await vikunjaRestRequest<VikunjaProjectView>(
    authManager,
    'GET',
    `/projects/${args.id}/views/${args.viewId}`,
  );

  const response = createStandardResponse(
    'get-view',
    `Retrieved view ${args.viewId} of project ${args.id}`,
    { projectId: args.id, view: viewSummary(view) },
    { timestamp: new Date().toISOString() },
    args.sessionId,
  );

  return {
    content: [{ type: 'text' as const, text: formatAorpAsMarkdown(response) }],
  };
}

/**
 * Creates a new view on a project.
 */
export async function createView(
  args: CreateViewArgs,
  authManager: AuthManager,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  if (!args.id) {
    throw new MCPError(
      ErrorCode.VALIDATION_ERROR,
      'Project id is required for create-view operation',
    );
  }
  if (!args.title || args.title.trim() === '') {
    throw new MCPError(ErrorCode.VALIDATION_ERROR, 'title is required for create-view operation');
  }
  if (!args.viewKind) {
    throw new MCPError(
      ErrorCode.VALIDATION_ERROR,
      'viewKind is required for create-view operation',
    );
  }
  validateId(args.id, 'id');

  // Reject-loudly, never silently drop: a bucket belongs to exactly ONE view
  // (`models.Bucket.project_view_id`), so at create-view time this view has
  // no buckets yet and any id the caller could pass necessarily belongs to a
  // DIFFERENT view. Worse, go-vikunja's `createProjectView`
  // (pkg/models/project_view.go) overwrites both ids with the auto-created
  // To-Do/Done buckets for a kanban view in `manual` mode — so the value
  // would be stored dangling or thrown away. Point at the tools that can
  // actually do it instead.
  const createTimeBucketFields: string[] = [];
  if (args.doneBucketId !== undefined) createTimeBucketFields.push('doneBucketId');
  if (args.defaultBucketId !== undefined) createTimeBucketFields.push('defaultBucketId');
  if (createTimeBucketFields.length > 0) {
    throw new MCPError(
      ErrorCode.VALIDATION_ERROR,
      `${createTimeBucketFields.join(' and ')} cannot be set by create-view: buckets belong to a ` +
        'single view and none exist yet for a view that is being created, so any bucket id here ' +
        'would point at another view (and Vikunja overwrites both ids anyway when it ' +
        'auto-creates the To-Do/Doing/Done buckets of a manual kanban view). Create the view ' +
        'first, then set them with vikunja_projects update-view (defaultBucketId/doneBucketId) ' +
        'or vikunja_projects set-done-bucket — bucket ids come from vikunja_projects ' +
        'list-buckets for the new view.',
    );
  }

  const body: VikunjaProjectView = {
    title: args.title.trim(),
    view_kind: args.viewKind,
  };
  const affectedFields = ['title', 'view_kind'];
  if (args.bucketConfigurationMode !== undefined) {
    body.bucket_configuration_mode = args.bucketConfigurationMode;
    affectedFields.push('bucket_configuration_mode');
  }
  if (args.bucketConfiguration !== undefined) {
    body.bucket_configuration = buildBucketConfiguration(args.bucketConfiguration);
    affectedFields.push('bucket_configuration');
  }
  // `!== undefined`, not a truthiness check: `position: 0` is a real,
  // meaningful value (it asks Vikunja for the default position) and must
  // reach the wire rather than being dropped by a falsy guard.
  if (args.position !== undefined) {
    body.position = args.position;
    affectedFields.push('position');
  }
  if (args.filter !== undefined) {
    body.filter = buildViewFilter(args.filter);
    affectedFields.push('filter');
  }

  const view = await vikunjaRestRequest<VikunjaProjectView>(
    authManager,
    'PUT',
    `/projects/${args.id}/views`,
    body,
  );

  const response = createStandardResponse(
    'create-view',
    `View "${view.title ?? args.title}" created on project ${args.id}`,
    { projectId: args.id, view: viewSummary(view) },
    {
      timestamp: new Date().toISOString(),
      affectedFields,
    },
    args.sessionId,
  );

  return {
    content: [{ type: 'text' as const, text: formatAorpAsMarkdown(response) }],
  };
}

/**
 * Updates a project view.
 *
 * The request the server actually sees depends on which API this session
 * resolves to: a v2 `PATCH` with just the caller's fields, or v1's
 * fetch-merge-`POST`. `ViewUpdateContext` owns that choice; everything below
 * is the same on both paths, including the `affectedFields` metadata, which is
 * derived from the caller's arguments rather than from a diff.
 */
export async function updateView(
  args: UpdateViewArgs,
  authManager: AuthManager,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  if (!args.id) {
    throw new MCPError(
      ErrorCode.VALIDATION_ERROR,
      'Project id is required for update-view operation',
    );
  }
  if (args.viewId === undefined || args.viewId === null) {
    throw new MCPError(ErrorCode.VALIDATION_ERROR, 'View id is required for update-view operation');
  }
  validateId(args.id, 'id');
  validateId(args.viewId, 'viewId');

  const hasUpdateFields =
    args.title !== undefined ||
    args.viewKind !== undefined ||
    args.bucketConfigurationMode !== undefined ||
    args.bucketConfiguration !== undefined ||
    args.position !== undefined ||
    args.filter !== undefined ||
    args.doneBucketId !== undefined ||
    args.defaultBucketId !== undefined;
  if (!hasUpdateFields) {
    throw new MCPError(
      ErrorCode.VALIDATION_ERROR,
      'No fields to update provided for update-view operation',
    );
  }
  if (args.doneBucketId !== undefined) validateId(args.doneBucketId, 'doneBucketId');
  if (args.defaultBucketId !== undefined) validateId(args.defaultBucketId, 'defaultBucketId');

  const fieldUpdates: ViewFieldUpdates = {};
  if (args.title !== undefined) fieldUpdates.title = args.title;
  if (args.viewKind !== undefined) fieldUpdates.viewKind = args.viewKind;
  if (args.bucketConfigurationMode !== undefined) {
    fieldUpdates.bucketConfigurationMode = args.bucketConfigurationMode;
  }
  if (args.bucketConfiguration !== undefined) {
    fieldUpdates.bucketConfiguration = args.bucketConfiguration;
  }
  // `!== undefined` on purpose — `position: 0` must reach the wire.
  if (args.position !== undefined) fieldUpdates.position = args.position;
  if (args.filter !== undefined) fieldUpdates.filter = args.filter;
  if (args.doneBucketId !== undefined) fieldUpdates.doneBucketId = args.doneBucketId;
  if (args.defaultBucketId !== undefined) fieldUpdates.defaultBucketId = args.defaultBucketId;

  const updatedView = await new ViewUpdateContext(authManager).execute({
    authManager,
    projectId: args.id,
    viewId: args.viewId,
    updates: fieldUpdates,
  });

  const response = createStandardResponse(
    'update-view',
    `View ${args.viewId} of project ${args.id} updated`,
    { projectId: args.id, view: viewSummary(updatedView) },
    {
      timestamp: new Date().toISOString(),
      affectedFields: Object.keys(fieldUpdates),
    },
    args.sessionId,
  );

  return {
    content: [{ type: 'text' as const, text: formatAorpAsMarkdown(response) }],
  };
}

/**
 * Deletes a project view.
 */
export async function deleteView(
  args: DeleteViewArgs,
  authManager: AuthManager,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  if (!args.id) {
    throw new MCPError(
      ErrorCode.VALIDATION_ERROR,
      'Project id is required for delete-view operation',
    );
  }
  if (args.viewId === undefined || args.viewId === null) {
    throw new MCPError(ErrorCode.VALIDATION_ERROR, 'View id is required for delete-view operation');
  }
  validateId(args.id, 'id');
  validateId(args.viewId, 'viewId');

  await vikunjaRestRequest(authManager, 'DELETE', `/projects/${args.id}/views/${args.viewId}`);

  const response = createStandardResponse(
    'delete-view',
    `View ${args.viewId} of project ${args.id} deleted`,
    { deleted: true, projectId: args.id, viewId: args.viewId },
    { timestamp: new Date().toISOString() },
    args.sessionId,
  );

  return {
    content: [{ type: 'text' as const, text: formatAorpAsMarkdown(response) }],
  };
}

/**
 * Composite: sets a Kanban view's done bucket.
 *
 * `models.Bucket` has no `is_done_bucket` field of its own (see
 * docs/API_NOTES.md "Kanban 'Done' Bucket") — the done bucket is a property
 * of the ProjectView (`done_bucket_id`), not the bucket. This is the only
 * way to *set* it (list-buckets can only read it). Steps: resolve the
 * project's Kanban view (or use an explicit `viewId`), write the
 * `done_bucket_id` change onto it through `ViewUpdateContext`, then verify the
 * response reflects the requested bucket before reporting success.
 *
 * Because the done bucket lives on the view, this is a view update and gets
 * v2's `PATCH` like any other. It is not a bucket update: v2 has no bucket
 * `PATCH`, and `buckets.ts` stays on v1 permanently.
 *
 * The verify step also covers v2's `304`: a patch that sets `done_bucket_id`
 * to the value it already holds changes nothing, and the strategy answers it
 * with a fresh read of the view, whose `done_bucket_id` is by definition the
 * requested one.
 */
export async function setDoneBucket(
  args: SetDoneBucketArgs,
  authManager: AuthManager,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  if (!args.id) {
    throw new MCPError(
      ErrorCode.VALIDATION_ERROR,
      'Project id is required for set-done-bucket operation',
    );
  }
  if (args.bucketId === undefined || args.bucketId === null) {
    throw new MCPError(
      ErrorCode.VALIDATION_ERROR,
      'bucketId is required for set-done-bucket operation',
    );
  }
  validateId(args.id, 'id');
  validateId(args.bucketId, 'bucketId');
  if (args.viewId !== undefined) validateId(args.viewId, 'viewId');

  const viewId =
    args.viewId !== undefined ? args.viewId : await resolveKanbanViewId(authManager, args.id);

  const updatedView = await new ViewUpdateContext(authManager).execute({
    authManager,
    projectId: args.id,
    viewId,
    updates: { doneBucketId: args.bucketId },
  });

  // Verify-then-report: the response's done_bucket_id must reflect the
  // requested bucket before this is reported as a success (ENDPOINT-PLAYBOOK
  // §1 "verify-then-apply").
  if (updatedView.done_bucket_id !== args.bucketId) {
    throw new MCPError(
      ErrorCode.API_ERROR,
      `Failed to set done bucket on view ${viewId} of project ${args.id}: expected done_bucket_id ${args.bucketId}, server reports ${String(
        updatedView.done_bucket_id,
      )}`,
    );
  }

  const response = createStandardResponse(
    'set-done-bucket',
    `Bucket ${args.bucketId} set as the done bucket for view ${viewId} of project ${args.id}`,
    { projectId: args.id, viewId, doneBucketId: args.bucketId, view: viewSummary(updatedView) },
    {
      timestamp: new Date().toISOString(),
      affectedFields: ['done_bucket_id'],
    },
    args.sessionId,
  );

  return {
    content: [{ type: 'text' as const, text: formatAorpAsMarkdown(response) }],
  };
}
