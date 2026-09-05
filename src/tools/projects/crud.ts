/**
 * Project CRUD Operations Module
 * Handles basic Create, Read, Update, Delete operations for projects
 *
 * Migrated off the legacy client (Wave D domain migration, tracking issue #28)
 * onto `vikunjaRestRequest` + types generated from the vendored OpenAPI spec.
 *
 * Every update-shaped write here (updateProject/archiveProject/
 * unarchiveProject, plus moveProject in ./hierarchy) goes through
 * `ProjectUpdateContext` (./update), which picks a v1 or a v2 strategy per
 * session — #184 P3 step 6. On v1 the write is still the full-model-replace
 * `POST /projects/{id}` with the caller's changes merged onto the fetched
 * project, because omitting a field there clears it (docs/ENDPOINT-PLAYBOOK.md
 * §4, docs/API_NOTES.md "Project Operations"). On v2 it is a single
 * `PATCH /api/v2/projects/{id}` carrying only the named fields, which was
 * probed live to preserve both of the things that merge guards. See
 * ./update/V2ProjectUpdateStrategy for the evidence.
 *
 * Endpoints (verified against docs/vikunja-openapi.json):
 *   - GET  /projects       list
 *   - PUT  /projects       create
 *   - GET  /projects/{id}  get
 *   - POST /projects/{id}  update (full-model-replace, v1 path)
 *   - PATCH /api/v2/projects/{id} update (partial, v2 path)
 *   - DELETE /projects/{id} delete
 */

import type { AuthManager } from '../../auth/AuthManager';
import { MCPError, ErrorCode, type CreateProjectRequest } from '../../types';
import { transformApiError } from '../../utils/error-handler';
import { vikunjaRestRequest } from '../../utils/vikunja-rest';
import {
  validateId,
  validateHexColor,
  validateProjectData,
  calculateProjectDepth,
} from './validation';
import { createProjectResponse, createProjectListResponse } from './response-formatter';
import { formatAorpAsMarkdown } from '../../utils/response-factory';
import {
  ProjectUpdateContext,
  buildProjectUpdatePayload,
  type ProjectUpdateFields,
  type VikunjaProject,
} from './update';

// Sourced from the vendored OpenAPI spec (docs/vikunja-openapi.json) — see
// docs/API-SPEC.md. All fields are optional per the spec.
export type { VikunjaProject };

// The v1 merge moved into ./update/V1ProjectUpdateStrategy when the strategy
// pair landed, and is re-exported here because docs/API_NOTES.md and
// docs/VIKUNJA_API_ISSUES.md §16 both name this module as its home.
export { buildProjectUpdatePayload };

// MCP response type
export type McpResponse = {
  content: Array<{
    type: 'text';
    text: string;
  }>;
};

/**
 * Arguments for listing projects
 */
export interface ListProjectsArgs {
  page?: number;
  perPage?: number;
  search?: string;
  isArchived?: boolean;
  verbosity?: string;
  useOptimizedFormat?: boolean;
  useAorp?: boolean;
}

/**
 * Arguments for getting a project
 */
export interface GetProjectArgs {
  id: number;
  verbosity?: string;
  useOptimizedFormat?: boolean;
  useAorp?: boolean;
}

/**
 * Arguments for creating a project
 */
export interface CreateProjectArgs {
  title: string;
  description?: string;
  parentProjectId?: number;
  isArchived?: boolean;
  hexColor?: string;
  /** Mark the new project as a favorite for the calling user. */
  isFavorite?: boolean;
  verbosity?: string;
  useOptimizedFormat?: boolean;
  useAorp?: boolean;
}

/**
 * Arguments for updating a project
 */
export interface UpdateProjectArgs {
  id: number;
  title?: string;
  description?: string;
  parentProjectId?: number;
  isArchived?: boolean;
  hexColor?: string;
  /** Favorite/unfavorite the project for the calling user. */
  isFavorite?: boolean;
  verbosity?: string;
  useOptimizedFormat?: boolean;
  useAorp?: boolean;
}

/**
 * Arguments for deleting a project
 */
export interface DeleteProjectArgs {
  id: number;
  verbosity?: string;
  useOptimizedFormat?: boolean;
  useAorp?: boolean;
}

/**
 * Arguments for archiving/unarchiving a project
 */
export interface ArchiveProjectArgs {
  id: number;
  verbosity?: string;
  useOptimizedFormat?: boolean;
  useAorp?: boolean;
}

/**
 * Re-throws a REST-layer 404 (`vikunjaRestRequest` throws `MCPError` with
 * `details.statusCode`, not the bare `.statusCode` property the legacy client's
 * errors carried, so the shared `handleStatusCodeError`/`wrapToolError` 404
 * detection no longer fires) as the same friendly "Project with ID X not
 * found" message the legacy-client-backed implementation produced — the same
 * translation `rethrowProjectNotFound` in `sharing.ts` established for this
 * domain in an earlier Wave D PR. Everything else (MCPError or not) is
 * rethrown/wrapped unchanged.
 */
function rethrowProjectNotFound(error: unknown, id: number, context: string): never {
  if (error instanceof MCPError) {
    if (error.details?.statusCode === 404) {
      throw new MCPError(ErrorCode.NOT_FOUND, `Project with ID ${id} not found`);
    }
    throw error;
  }
  throw transformApiError(error, context);
}

// Safety valve for fetchAllProjects' pagination loop below: bounds the
// number of `GET /projects` round trips so a misbehaving server (one that
// never returns a short final page) can't turn hierarchy validation into an
// unbounded loop. 50 pages * 200/page = 10,000 projects, comfortably beyond
// any real instance's hierarchy depth/breadth.
const FETCH_ALL_PROJECTS_PAGE_SIZE = 200;
const FETCH_ALL_PROJECTS_MAX_PAGES = 50;

/**
 * Fetches every project the caller can see, for hierarchy validation
 * (depth/parent checks). Failures are swallowed by callers that treat this
 * as best-effort — see the original legacy-client-backed behavior this
 * preserves.
 *
 * FIXED (was: docs/API-COVERAGE.md Issues table, LOW — "pagination
 * honesty"): this used to make a single `GET /projects?per_page=1000` call,
 * silently truncating hierarchy/breadcrumb/move-cycle validation on
 * instances with more than 1000 projects. It now walks `page` until a page
 * comes back shorter than `per_page` (the standard "last page" signal for
 * this API — see docs/API_NOTES.md), so instances of any size are covered,
 * bounded by `FETCH_ALL_PROJECTS_MAX_PAGES` as a DoS/safety valve against a
 * server that never returns a short final page.
 */
async function fetchAllProjects(authManager: AuthManager): Promise<VikunjaProject[]> {
  const all: VikunjaProject[] = [];
  for (let page = 1; page <= FETCH_ALL_PROJECTS_MAX_PAGES; page++) {
    const response = await vikunjaRestRequest<VikunjaProject[]>(
      authManager,
      'GET',
      `/projects?per_page=${FETCH_ALL_PROJECTS_PAGE_SIZE}&page=${page}`,
    );
    const batch = Array.isArray(response) ? response : [];
    all.push(...batch);
    if (batch.length < FETCH_ALL_PROJECTS_PAGE_SIZE) {
      break;
    }
  }
  return all;
}

/**
 * Lists projects with pagination and filtering
 */
export async function listProjects(
  args: ListProjectsArgs,
  authManager: AuthManager,
): Promise<McpResponse> {
  const {
    page = 1,
    perPage = 50,
    search,
    isArchived,
    verbosity,
    useOptimizedFormat,
    useAorp,
  } = args;

  try {
    const params = new URLSearchParams();
    params.set('page', String(page));
    params.set('per_page', String(perPage));
    if (search !== undefined) {
      params.set('s', search);
    }
    if (isArchived !== undefined) {
      params.set('is_archived', String(isArchived));
    }

    const response = await vikunjaRestRequest<VikunjaProject[]>(
      authManager,
      'GET',
      `/projects?${params.toString()}`,
    );

    // GET /projects returns a bare array — there is no {data, total} envelope
    // (see docs/API_NOTES.md). Total item/page counts are therefore unknown;
    // createProjectListResponse derives `hasMore` honestly from the page size
    // instead of fabricating a total. That pagination metadata (hasMore/
    // nextPage/prevPage) now actually reaches the rendered response — see
    // createProjectResponse in response-formatter.ts (#280).
    const responseArray = Array.isArray(response) ? response : [response];

    // Build options object, only including defined properties to satisfy exactOptionalPropertyTypes
    const options: { verbosity?: string; useOptimizedFormat?: boolean; useAorp?: boolean } = {};

    if (verbosity !== undefined) {
      options.verbosity = verbosity;
    }

    if (useOptimizedFormat !== undefined) {
      options.useOptimizedFormat = useOptimizedFormat;
    }

    if (useAorp !== undefined) {
      options.useAorp = useAorp;
    }

    const result = createProjectListResponse(responseArray, page, perPage, options);

    return {
      content: [
        {
          type: 'text' as const,
          text: formatAorpAsMarkdown(result.response),
        },
      ],
    };
  } catch (error) {
    if (error instanceof MCPError) {
      throw error;
    }
    throw transformApiError(error, 'Failed to list projects');
  }
}

/**
 * Gets a single project by ID
 */
export async function getProject(
  args: GetProjectArgs,
  authManager: AuthManager,
): Promise<McpResponse> {
  const { id, verbosity, useOptimizedFormat, useAorp } = args;

  try {
    validateId(id, 'project id');

    const project = await vikunjaRestRequest<VikunjaProject>(authManager, 'GET', `/projects/${id}`);

    const result = createProjectResponse(
      'get_project',
      `Retrieved project: ${project.title}`,
      { project },
      {},
      verbosity,
      useOptimizedFormat,
      useAorp,
    );

    return {
      content: [
        {
          type: 'text' as const,
          text: formatAorpAsMarkdown(result.response),
        },
      ],
    };
  } catch (error) {
    if (error instanceof MCPError && error.code === ErrorCode.VALIDATION_ERROR) {
      throw error;
    }
    rethrowProjectNotFound(error, id, 'Failed to get project');
  }
}

/**
 * Creates a new project
 */
export async function createProject(
  args: CreateProjectArgs,
  authManager: AuthManager,
): Promise<McpResponse> {
  const {
    title,
    description,
    parentProjectId,
    isArchived,
    hexColor,
    isFavorite,
    verbosity,
    useOptimizedFormat,
    useAorp,
  } = args;

  try {
    // Validate input data, filter out undefined values for exactOptionalPropertyTypes
    const validationData: { title?: string; hexColor?: string; parentProjectId?: number } = {};

    if (title !== undefined) {
      validationData.title = title;
    }

    if (hexColor !== undefined) {
      validationData.hexColor = hexColor;
    }

    if (parentProjectId !== undefined) {
      validationData.parentProjectId = parentProjectId;
    }

    validateProjectData(validationData);

    // Get all projects to validate hierarchy if parent is specified
    let allProjects: VikunjaProject[] = [];
    // Tracks whether fetchAllProjects actually succeeded. An empty
    // `allProjects` from a FAILED fetch is not the same signal as "the
    // fetch succeeded and genuinely returned no projects" — conflating the
    // two used to make validateProjectData's existence check report
    // "Parent project not found" even when the real problem was the list
    // fetch itself failing (LOW-1, issue #291). `allProjects` is only
    // passed to the existence check below when the fetch actually
    // succeeded; on failure `undefined` skips that check (validateId's
    // numeric-range check still runs), leaving Vikunja's own create call to
    // surface the real error if the parent truly doesn't exist.
    let allProjectsFetchFailed = false;
    if (parentProjectId) {
      try {
        allProjects = await fetchAllProjects(authManager);
      } catch {
        allProjectsFetchFailed = true;
      }

      validateProjectData({ parentProjectId }, allProjectsFetchFailed ? undefined : allProjects);

      // Check depth constraints
      if (allProjects.length > 0) {
        const depth = calculateProjectDepth(parentProjectId, allProjects);
        if (depth >= 10) {
          // MAX_PROJECT_DEPTH
          throw new MCPError(ErrorCode.VALIDATION_ERROR, 'Maximum allowed depth is 10 levels');
        }
      }
    }

    // Normalize hex color if provided
    let normalizedColor = hexColor;
    if (hexColor) {
      normalizedColor = hexColor.toLowerCase();
    }

    // Build projectData object, only including defined properties to satisfy exactOptionalPropertyTypes
    const projectData: CreateProjectRequest = {
      title: title.trim(),
    };

    if (description !== undefined) {
      projectData.description = description?.trim() || '';
    }

    if (isArchived !== undefined) {
      projectData.is_archived = isArchived;
    }

    if (parentProjectId !== undefined) {
      projectData.parent_project_id = parentProjectId;
    }

    if (normalizedColor !== undefined) {
      projectData.hex_color = normalizedColor;
    }

    // `!== undefined`, never a truthiness check: `isFavorite: false` is a
    // real value and is forwarded as such. `CreateProject` (go-vikunja
    // pkg/models/project.go) adds the favorites row when the flag is true.
    if (isFavorite !== undefined) {
      projectData.is_favorite = isFavorite;
    }

    const createdProject = await vikunjaRestRequest<VikunjaProject>(
      authManager,
      'PUT',
      '/projects',
      projectData,
    );

    const result = createProjectResponse(
      'create_project',
      `Project "${createdProject.title}" created successfully`,
      { project: createdProject },
      {},
      verbosity,
      useOptimizedFormat,
      useAorp,
    );

    return {
      content: [
        {
          type: 'text' as const,
          text: formatAorpAsMarkdown(result.response),
        },
      ],
    };
  } catch (error) {
    if (error instanceof MCPError) {
      throw error;
    }
    throw transformApiError(error, 'Failed to create project');
  }
}

/**
 * Updates an existing project
 */
export async function updateProject(
  args: UpdateProjectArgs,
  authManager: AuthManager,
): Promise<McpResponse> {
  const {
    id,
    title,
    description,
    parentProjectId,
    isArchived,
    hexColor,
    isFavorite,
    verbosity,
    useOptimizedFormat,
    useAorp,
  } = args;

  try {
    validateId(id, 'project id');

    // Check if at least one field to update is provided
    const hasUpdateFields =
      title !== undefined ||
      description !== undefined ||
      parentProjectId !== undefined ||
      isArchived !== undefined ||
      hexColor !== undefined ||
      isFavorite !== undefined;

    if (!hasUpdateFields) {
      throw new MCPError(ErrorCode.VALIDATION_ERROR, 'No fields to update provided');
    }

    // Validate hex color early if provided
    if (hexColor !== undefined) {
      validateHexColor(hexColor);
    }

    // Get current project
    const currentProject = await vikunjaRestRequest<VikunjaProject>(
      authManager,
      'GET',
      `/projects/${id}`,
    );

    // Get all projects for hierarchy validation. See the matching comment
    // in createProject: an empty `allProjects` from a FAILED fetch must not
    // be treated as "confirmed no projects exist" by the existence check
    // below (LOW-1, issue #291) — that would misreport "Parent project not
    // found" on every update that merely re-asserts the CURRENT parent
    // (resolvedParentProjectId), for a project whose parent may well exist.
    let allProjects: VikunjaProject[] = [];
    let allProjectsFetchFailed = false;
    if (parentProjectId !== undefined || (currentProject && currentProject.parent_project_id)) {
      try {
        allProjects = await fetchAllProjects(authManager);
      } catch {
        allProjectsFetchFailed = true;
      }
    }

    // Validate update data, filter out undefined values for exactOptionalPropertyTypes
    const validationUpdateData: { title?: string; hexColor?: string; parentProjectId?: number } =
      {};

    if (title !== undefined) {
      validationUpdateData.title = title;
    }

    if (hexColor !== undefined) {
      validationUpdateData.hexColor = hexColor;
    }

    const resolvedParentProjectId =
      parentProjectId ??
      (currentProject && typeof currentProject.parent_project_id === 'number'
        ? currentProject.parent_project_id
        : undefined);
    if (resolvedParentProjectId !== undefined) {
      validationUpdateData.parentProjectId = resolvedParentProjectId;
    }

    validateProjectData(validationUpdateData, allProjectsFetchFailed ? undefined : allProjects);

    // Check depth constraints if parentProjectId is being updated
    if (parentProjectId !== undefined && allProjects.length > 0) {
      const depth = calculateProjectDepth(parentProjectId, allProjects);
      if (depth >= 10) {
        // MAX_PROJECT_DEPTH
        throw new MCPError(ErrorCode.VALIDATION_ERROR, 'Maximum allowed depth is 10 levels');
      }
    }

    // Only the fields the caller named. Whether that becomes a v1 full-model
    // merge or a v2 merge patch is the strategy's business, not this
    // function's. Detaching from a parent still requires an explicit
    // parentProjectId change (or the move subcommand) on both paths, since
    // an omitted parent means "leave it alone" here. See issue #45.
    const fieldUpdates: ProjectUpdateFields = {};
    if (title !== undefined) fieldUpdates.title = title;
    if (description !== undefined) fieldUpdates.description = description;
    if (parentProjectId !== undefined) fieldUpdates.parentProjectId = parentProjectId;
    if (isArchived !== undefined) fieldUpdates.isArchived = isArchived;
    if (hexColor !== undefined) fieldUpdates.hexColor = hexColor;
    // `!== undefined`: `isFavorite: false` means "unfavorite", not "unset".
    if (isFavorite !== undefined) fieldUpdates.isFavorite = isFavorite;

    const updatedProject = await new ProjectUpdateContext(authManager).execute({
      authManager,
      projectId: id,
      fields: fieldUpdates,
      currentProject,
    });

    const result = createProjectResponse(
      'update_project',
      `Project "${updatedProject.title}" updated successfully`,
      { project: updatedProject },
      {},
      verbosity,
      useOptimizedFormat,
      useAorp,
    );

    return {
      content: [
        {
          type: 'text' as const,
          text: formatAorpAsMarkdown(result.response),
        },
      ],
    };
  } catch (error) {
    if (error instanceof MCPError && error.code === ErrorCode.VALIDATION_ERROR) {
      throw error;
    }
    rethrowProjectNotFound(error, id, 'Failed to update project');
  }
}

/**
 * Deletes a project
 */
export async function deleteProject(
  args: DeleteProjectArgs,
  authManager: AuthManager,
): Promise<McpResponse> {
  const { id, verbosity, useOptimizedFormat, useAorp } = args;

  try {
    validateId(id, 'project id');

    // Get project details before deletion
    const project = await vikunjaRestRequest<VikunjaProject>(authManager, 'GET', `/projects/${id}`);

    await vikunjaRestRequest(authManager, 'DELETE', `/projects/${id}`);

    const result = createProjectResponse(
      'delete_project',
      `Deleted project: ${project.title}`,
      { deleted: true, projectId: id, projectTitle: project.title },
      {},
      verbosity,
      useOptimizedFormat,
      useAorp,
    );

    return {
      content: [
        {
          type: 'text' as const,
          text: formatAorpAsMarkdown(result.response),
        },
      ],
    };
  } catch (error) {
    if (error instanceof MCPError && error.code === ErrorCode.VALIDATION_ERROR) {
      throw error;
    }
    rethrowProjectNotFound(error, id, 'Failed to delete project');
  }
}

/**
 * Archives a project
 */
export async function archiveProject(
  args: ArchiveProjectArgs,
  authManager: AuthManager,
): Promise<McpResponse> {
  const { id, verbosity, useOptimizedFormat, useAorp } = args;

  try {
    validateId(id, 'project id');

    // Get current project first
    const currentProject = await vikunjaRestRequest<VikunjaProject>(
      authManager,
      'GET',
      `/projects/${id}`,
    );

    // Check if project is already archived
    if (currentProject.is_archived) {
      const result = createProjectResponse(
        'archive_project',
        `Project "${currentProject.title}" is already archived`,
        { project: currentProject },
        {},
        verbosity,
        useOptimizedFormat,
        useAorp,
      );

      return {
        content: [
          {
            type: 'text' as const,
            text: formatAorpAsMarkdown(result.response),
          },
        ],
      };
    }

    // Archive the project. On v1 this merges so parent/other fields are not
    // wiped; on v2 it is a one-field merge patch. Either way nothing but
    // is_archived changes.
    const project = await new ProjectUpdateContext(authManager).execute({
      authManager,
      projectId: id,
      fields: { isArchived: true },
      currentProject,
    });

    const result = createProjectResponse(
      'archive_project',
      `Project "${project.title}" archived successfully`,
      { project },
      {},
      verbosity,
      useOptimizedFormat,
      useAorp,
    );

    return {
      content: [
        {
          type: 'text' as const,
          text: formatAorpAsMarkdown(result.response),
        },
      ],
    };
  } catch (error) {
    if (error instanceof MCPError && error.code === ErrorCode.VALIDATION_ERROR) {
      throw error;
    }
    rethrowProjectNotFound(error, id, 'Failed to archive project');
  }
}

/**
 * Unarchives a project
 */
export async function unarchiveProject(
  args: ArchiveProjectArgs,
  authManager: AuthManager,
): Promise<McpResponse> {
  const { id, verbosity, useOptimizedFormat, useAorp } = args;

  try {
    validateId(id, 'project id');

    // Get current project first
    const currentProject = await vikunjaRestRequest<VikunjaProject>(
      authManager,
      'GET',
      `/projects/${id}`,
    );

    // Check if project is already active (not archived)
    if (!currentProject.is_archived) {
      const result = createProjectResponse(
        'unarchive_project',
        `Project "${currentProject.title}" is already active (not archived)`,
        { project: currentProject },
        {},
        verbosity,
        useOptimizedFormat,
        useAorp,
      );

      return {
        content: [
          {
            type: 'text' as const,
            text: formatAorpAsMarkdown(result.response),
          },
        ],
      };
    }

    // Unarchive the project. Same shape as archiveProject above: v1 merges,
    // v2 patches the single field.
    const project = await new ProjectUpdateContext(authManager).execute({
      authManager,
      projectId: id,
      fields: { isArchived: false },
      currentProject,
    });

    const result = createProjectResponse(
      'unarchive_project',
      `Project "${project.title}" unarchived successfully`,
      { project },
      {},
      verbosity,
      useOptimizedFormat,
      useAorp,
    );

    return {
      content: [
        {
          type: 'text' as const,
          text: formatAorpAsMarkdown(result.response),
        },
      ],
    };
  } catch (error) {
    if (error instanceof MCPError && error.code === ErrorCode.VALIDATION_ERROR) {
      throw error;
    }
    rethrowProjectNotFound(error, id, 'Failed to unarchive project');
  }
}

// Internal helper re-exported for hierarchy.ts (fetches the full,
// fully-paginated project list for depth/parent validation — see
// fetchAllProjects' own doc comment for the pagination-honesty fix).
export { fetchAllProjects };
