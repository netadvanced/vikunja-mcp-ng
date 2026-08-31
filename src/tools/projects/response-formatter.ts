/**
 * Project Response Formatter Module
 * Handles AORP response creation and formatting for project operations
 */

import { createAorpResponse } from '../../utils/response-factory';
import { getDefaultVerbosity } from '../../transforms/base';
import type { ResponseMetadata } from '../../types/responses';
import type { ResponseData } from '../../utils/simple-response';
import type { AorpFactoryResult, AorpVerbosityLevel } from '../../types';
import type { components } from '../../types/generated/vikunja-openapi';

// Sourced from the vendored OpenAPI spec (docs/vikunja-openapi.json) — see
// docs/API-SPEC.md, replacing the legacy client's `Project` type (Wave D domain
// migration, tracking issue #28).
type Project = components['schemas']['models.Project'];

/**
 * Project tree node interface
 */
interface ProjectTreeNode extends Project {
  children: ProjectTreeNode[];
  depth: number;
}

/**
 * Creates an AORP response for project operations
 */
export function createProjectResponse(
  operation: string,
  message: string,
  _data: unknown,
  _metadata: Partial<ResponseMetadata> = {},
  _verbosity?: string,
  _useOptimizedFormat?: boolean,
  _useAorp?: boolean,
): AorpFactoryResult {
  // An explicit per-call verbosity always takes precedence over the
  // VIKUNJA_RESPONSE_VERBOSITY environment default.
  const selectedVerbosity = _verbosity ?? getDefaultVerbosity();

  // Cast data to ResponseData for type compatibility
  const responseData = _data as ResponseData;

  // Use simple response format. `_metadata` must be forwarded here — it is
  // the ONLY place any of the extra metadata built by call sites (pagination
  // hasMore/nextPage, moved-project parent ids, hierarchy depth/truncation,
  // share info, etc.) reaches the actual response payload. Previously only
  // `verbosity` was threaded through and every other key in `_metadata` was
  // silently discarded (#280) — `formatSuccessMessage` renders whatever
  // lands in `metadata` via `formatObjectData`, so this is also what makes
  // it visible in the rendered markdown, the same way the buckets/views/
  // sharing-access formatters (which call `createStandardResponse` with
  // their metadata directly) already surface theirs.
  const simpleAorpResult = createAorpResponse(operation, message, responseData, {
    success: true,
    metadata: {
      ..._metadata,
      verbosity: selectedVerbosity,
    },
  });

  // Add transformation property for compatibility with AorpFactoryResult
  const mockOptimizedResponse = {
    success: true,
    operation,
    message,
    data: responseData,
    metadata: {
      timestamp: new Date().toISOString(),
    },
  };

  return {
    response: simpleAorpResult,
    transformation: {
      originalResponse: mockOptimizedResponse,
      context: {
        operation,
        success: true,
        dataSize: JSON.stringify(responseData).length,
        processingTime: 0,
        verbosity: selectedVerbosity,
        verbosityLevel: 'simple' as AorpVerbosityLevel,
        complexityFactors: {
          dataSize: JSON.stringify(responseData).length >= 1024,
          hasWarnings: false,
          hasErrors: false,
          isBulkOperation: false,
          isPartialSuccess: false,
          custom: {},
        },
      },
      metrics: {
        aorpProcessingTime: 0,
        totalTime: 0,
      },
    },
  };
}

/**
 * Creates a success response for project operations
 */
export function createProjectSuccessResponse(
  operation: string,
  data: unknown,
  options: {
    message?: string;
    verbosity?: string;
    useOptimizedFormat?: boolean;
    useAorp?: boolean;
    metadata?: Partial<ResponseMetadata>;
  } = {},
): AorpFactoryResult {
  const {
    message = `${operation} operation completed successfully`,
    verbosity,
    useOptimizedFormat,
    useAorp,
    metadata = {},
  } = options;

  return createProjectResponse(
    operation,
    message,
    data,
    metadata,
    verbosity,
    useOptimizedFormat,
    useAorp,
  );
}

/**
 * Creates a project list response with pagination metadata
 *
 * GET /projects returns a bare array with no total-count metadata in the
 * response body (the server does not report total items or total pages),
 * so this cannot honestly claim to know `totalPages`/`totalItems`. Instead
 * `hasMore` is derived from whether a full page was returned: if fewer than
 * `perPage` items came back, this is the last page.
 */
export function createProjectListResponse(
  projects: unknown[],
  currentPage: number,
  perPage: number,
  options: {
    verbosity?: string;
    useOptimizedFormat?: boolean;
    useAorp?: boolean;
  } = {},
): AorpFactoryResult {
  const hasMore = perPage > 0 && projects.length >= perPage;
  const metadata: Partial<ResponseMetadata> = {
    pagination: {
      page: currentPage,
      perPage,
      hasMore,
      nextPage: hasMore ? currentPage + 1 : undefined,
      prevPage: currentPage > 1 ? currentPage - 1 : undefined,
    },
  };

  const projectWord = projects.length === 1 ? 'project' : 'projects';
  const message = `Retrieved ${projects.length} ${projectWord}`;

  return createProjectSuccessResponse('list_projects', projects, {
    message,
    ...options,
    metadata,
  });
}

/**
 * Creates a project tree response with hierarchy metadata.
 *
 * `truncation` (issue #291, LOW-2) reports whether `buildProjectTree`
 * (src/tools/projects/hierarchy.ts) dropped any subtree purely because it
 * reached the caller's `maxDepth` — previously such subtrees vanished with
 * no signal at all, indistinguishable from "this project genuinely has no
 * deeper children". When `truncated` is true, both the metadata and the
 * message body say so explicitly, and a caller can re-run with a larger
 * `maxDepth` to see the rest.
 */
export function createProjectTreeResponse(
  treeData: unknown,
  depth: number,
  totalNodes: number,
  options: {
    verbosity?: string;
    useOptimizedFormat?: boolean;
    useAorp?: boolean;
  } = {},
  truncation: { maxDepth: number; truncated: boolean; truncatedCount: number } = {
    maxDepth: 10,
    truncated: false,
    truncatedCount: 0,
  },
): AorpFactoryResult {
  const { maxDepth, truncated, truncatedCount } = truncation;
  const metadata: Partial<ResponseMetadata> = {
    hierarchy: {
      depth,
      totalNodes,
      // The ACTUAL maxDepth this call used, not a hardcoded constant — this
      // used to always read 10 regardless of what the caller requested.
      maxDepth,
      ...(truncated && { truncated, truncatedCount }),
    },
    totalProjects: totalNodes,
  };

  const tree = treeData as ProjectTreeNode[];
  const truncationNote = truncated
    ? ` (truncated: ${truncatedCount} subtree(s) beyond maxDepth ${maxDepth} were omitted — re-run with a larger maxDepth to see them)`
    : '';
  return createProjectSuccessResponse(
    'get-project-tree',
    { tree: tree.length === 1 ? tree[0] : tree },
    {
      message: `Retrieved project tree with ${totalNodes} nodes at depth ${depth}${truncationNote}`,
      ...options,
      metadata,
    },
  );
}

/**
 * Creates a breadcrumb response for project hierarchy navigation
 */
export function createBreadcrumbResponse(
  breadcrumb: Project[],
  options: {
    verbosity?: string;
    useOptimizedFormat?: boolean;
    useAorp?: boolean;
  } = {},
): AorpFactoryResult {
  const metadata: Partial<ResponseMetadata> = {
    navigation: {
      breadcrumbLength: breadcrumb.length,
      hasPath: breadcrumb.length > 0,
    },
    path: breadcrumb.map((p: Project) => p.title).join(' > ') || 'Root',
    depth: breadcrumb.length,
  };

  return createProjectSuccessResponse(
    'get-project-breadcrumb',
    { breadcrumb },
    {
      message: `Retrieved breadcrumb path with ${breadcrumb.length} items`,
      ...options,
      metadata,
    },
  );
}
