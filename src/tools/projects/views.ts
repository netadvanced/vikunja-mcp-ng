/**
 * Project view operations
 *
 * Implements `list-views`, `get-view`, `create-view`, `update-view`,
 * `delete-view`, and the `set-done-bucket` composite, against Vikunja's
 * project view endpoints (`/projects/{project}/views[/{id}]`). legacy client
 * has no support for project views at all, so — like `buckets.ts` — this
 * calls the Vikunja REST API directly via the shared `vikunja-rest` helper.
 *
 * `POST /projects/{project}/views/{id}` replaces the entire ProjectView
 * resource (see docs/ENDPOINT-PLAYBOOK.md §4), so `update-view` and
 * `set-done-bucket` both fetch the current view first and merge requested
 * changes onto it (`buildViewUpdatePayload`) rather than sending a bare
 * partial object — the same fetch-merge-POST pattern as
 * `buildProjectUpdatePayload` in `crud.ts`. That merge is load-bearing for
 * `position` and `filter` in particular: go-vikunja's `ProjectView.Update`
 * writes an explicit `Cols("title", "view_kind", "filter", "position",
 * "bucket_configuration_mode", "bucket_configuration", "default_bucket_id",
 * "done_bucket_id")` list, and an explicit `Cols` column is persisted even
 * when its value is the zero value — so a partial body would silently reset
 * a view's position to 0 and blank its filter.
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
import {
  parseFilterString,
  validateFilterExpression,
  expressionToString,
} from '../../utils/filters';
import type { components } from '../../types/generated/vikunja-openapi';

// Sourced from the vendored OpenAPI spec (docs/vikunja-openapi.json) — see
// docs/API-SPEC.md. All fields are optional per the spec.
type VikunjaProjectView = components['schemas']['models.ProjectView'];
type VikunjaTaskCollection = components['schemas']['models.TaskCollection'];
type VikunjaBucketConfiguration = components['schemas']['models.ProjectViewBucketConfiguration'];

type ViewKind = 'list' | 'gantt' | 'table' | 'kanban';
type BucketConfigurationMode = 'none' | 'manual' | 'filter';

/** One `bucket_configuration` entry as the caller supplies it (flat filter string). */
export interface ViewBucketConfigurationInput {
  /** Column title for the generated bucket. */
  title: string;
  /** Filter query selecting the tasks that land in this bucket. */
  filter?: string;
}

/**
 * Parses, validates, and translates a caller-supplied DSL filter string into
 * the snake_case form Vikunja's API expects — the SAME pipeline
 * `vikunja_filters` and `vikunja_tasks list` route through
 * (`parseFilterString` -> `validateFilterExpression` -> `expressionToString`,
 * see src/utils/filters.ts). Without the last step a DSL field name
 * (`dueDate`) is sent verbatim and Vikunja rejects it, since the real field
 * is `due_date`.
 *
 * @throws {MCPError} VALIDATION_ERROR when the filter fails to parse/validate.
 */
function translateViewFilter(filterStr: string, label: string): string {
  const parseResult = parseFilterString(filterStr);
  if (!parseResult.expression) {
    throw new MCPError(
      ErrorCode.VALIDATION_ERROR,
      `Invalid ${label}: ${parseResult.error?.message || 'Invalid filter syntax'}`,
    );
  }
  const validation = validateFilterExpression(parseResult.expression);
  if (!validation.valid) {
    throw new MCPError(
      ErrorCode.VALIDATION_ERROR,
      `Invalid ${label}: ${validation.errors.join('; ')}`,
    );
  }
  return expressionToString(parseResult.expression);
}

/**
 * Builds the nested `filter` object Vikunja's ProjectView model expects.
 *
 * The wire shape is NOT a bare string: `models.ProjectView.filter` is a
 * `models.TaskCollection` (`{ filter: "<query>" }`) — verified against the
 * vendored spec and against `ProjectView.Filter *TaskCollection` in
 * go-vikunja's `pkg/models/project_view.go`. The existing collection (sort_by,
 * order_by, s, ...) is preserved when one is already set on the view, so
 * changing the query on an update doesn't wipe the rest of the collection.
 */
function buildViewFilter(
  filterStr: string,
  current?: VikunjaTaskCollection,
): VikunjaTaskCollection {
  return { ...(current ?? {}), filter: translateViewFilter(filterStr, 'filter') };
}

/** Maps the caller's flat bucket-configuration entries onto the wire shape. */
function buildBucketConfiguration(
  entries: ViewBucketConfigurationInput[],
): VikunjaBucketConfiguration[] {
  return entries.map((entry, index) => {
    if (typeof entry?.title !== 'string' || entry.title.trim() === '') {
      throw new MCPError(
        ErrorCode.VALIDATION_ERROR,
        `bucketConfiguration[${index}].title is required and must be a non-empty string`,
      );
    }
    const mapped: VikunjaBucketConfiguration = { title: entry.title.trim() };
    if (entry.filter !== undefined) {
      mapped.filter = {
        filter: translateViewFilter(entry.filter, `bucketConfiguration[${index}].filter`),
      };
    }
    return mapped;
  });
}

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

/** The caller-facing field deltas `buildViewUpdatePayload` can overlay. */
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
 * Builds a project view update payload by merging the current view with
 * requested field changes, so fields the caller didn't mention survive the
 * full-model-replace `POST /projects/{project}/views/{id}` round trip.
 */
export function buildViewUpdatePayload(
  currentView: VikunjaProjectView,
  updates: ViewFieldUpdates,
): VikunjaProjectView {
  return {
    ...currentView,
    ...(updates.title !== undefined && { title: updates.title.trim() }),
    ...(updates.viewKind !== undefined && { view_kind: updates.viewKind }),
    ...(updates.bucketConfigurationMode !== undefined && {
      bucket_configuration_mode: updates.bucketConfigurationMode,
    }),
    ...(updates.bucketConfiguration !== undefined && {
      bucket_configuration: buildBucketConfiguration(updates.bucketConfiguration),
    }),
    // `position` and `filter` are in the handler's explicit `Cols(...)` list
    // (go-vikunja pkg/models/project_view.go `ProjectView.Update`), so they
    // are written even when zero/empty — merging the fetched view forward is
    // what keeps an untouched position from being reset to 0.
    ...(updates.position !== undefined && { position: updates.position }),
    ...(updates.filter !== undefined && {
      filter: buildViewFilter(updates.filter, currentView.filter),
    }),
    ...(updates.doneBucketId !== undefined && { done_bucket_id: updates.doneBucketId }),
    ...(updates.defaultBucketId !== undefined && { default_bucket_id: updates.defaultBucketId }),
  };
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
 * Updates a project view. `POST /projects/{project}/views/{id}` is a
 * full-model-replace endpoint, so the current view is fetched first and
 * merged with the requested changes (see `buildViewUpdatePayload`).
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

  const currentView = await vikunjaRestRequest<VikunjaProjectView>(
    authManager,
    'GET',
    `/projects/${args.id}/views/${args.viewId}`,
  );

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

  const payload = buildViewUpdatePayload(currentView, fieldUpdates);

  const updatedView = await vikunjaRestRequest<VikunjaProjectView>(
    authManager,
    'POST',
    `/projects/${args.id}/views/${args.viewId}`,
    payload,
  );

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
 * project's Kanban view (or use an explicit `viewId`), fetch-merge-POST the
 * `done_bucket_id` change onto it, then verify the response reflects the
 * requested bucket before reporting success.
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

  const currentView = await vikunjaRestRequest<VikunjaProjectView>(
    authManager,
    'GET',
    `/projects/${args.id}/views/${viewId}`,
  );

  const payload = buildViewUpdatePayload(currentView, { doneBucketId: args.bucketId });

  const updatedView = await vikunjaRestRequest<VikunjaProjectView>(
    authManager,
    'POST',
    `/projects/${args.id}/views/${viewId}`,
    payload,
  );

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
