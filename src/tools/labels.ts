/**
 * Labels Tool
 * Handles label operations for Vikunja
 *
 * Migrated off the legacy client (Wave D domain migration, tracking issue #28)
 * onto `vikunjaRestRequest` + types generated from the vendored OpenAPI
 * spec. See docs/ENDPOINT-PLAYBOOK.md §6.
 *
 * Endpoints (verified against docs/vikunja-openapi.json, then re-verified
 * against the running 2.4.0/2.5.0/2.6.0 servers on 2026-09-05):
 *   - GET    /labels       list
 *   - PUT    /labels       create
 *   - GET    /labels/{id}  get
 *   - DELETE /labels/{id}  delete
 *
 * `update` is the exception and no longer lives here: it needs a v1/v2 pair
 * (`src/utils/label-update.ts`, #184 P3 step 6). Two live findings drove that,
 * both of which contradict the vendored v1 spec:
 *
 *   - `PUT /labels/{id}`, which this file used to send and which
 *     `docs/vikunja-openapi.json` declares, answers `405 Method Not Allowed` on
 *     every supported version. The route the server routes is
 *     `POST /labels/{id}` (`Allow: OPTIONS, DELETE, GET, POST`).
 *   - That `POST` is a full model replace, not the partial update the old
 *     comment here claimed: sending only `hex_color` blanked `title` and
 *     `description`. So the v1 path reads the label and sends the merged model.
 *
 * v2's `PATCH /labels/{id}` is a true partial update on all three versions, so
 * a v2-capable session sends one call instead of two.
 *
 * `ensure` is a composite, not a distinct REST endpoint: it get-or-creates a
 * label by title (GET /labels?s=<title>, filtered client-side for a
 * case-insensitive exact-title match; PUT /labels to create when none is
 * found) so "attach a label by name" collapses from list→match→create into a
 * single idempotent call. See netadvanced/vikunja-mcp#28 friction #4
 * (existing-label-reuse cost both models 2x the optimal call count with no
 * create-or-reuse primitive).
 *
 * The get-or-create logic itself lives in the shared `ensureLabelByTitle`
 * helper (src/utils/label-ensure.ts) — `vikunja_task_labels apply-label` also
 * calls it (via its `labelTitles` field) so attaching a label by name is a
 * single call on the tool agents already reach for, instead of requiring a
 * separate `ensure` call followed by a second `apply-label` call. `ensure`
 * remains here for the get-or-create-without-attaching use case.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AuthManager } from '../auth/AuthManager';
import type { VikunjaClientFactory } from '../client/VikunjaClientFactory';
import { getAuthManagerFromContext, hasRequestContext } from '../client';
import { MCPError, ErrorCode, createStandardResponse } from '../types';
import { validateAndConvertId } from '../utils/validation';
import { wrapToolError } from '../utils/error-handler';
import { vikunjaRestRequest } from '../utils/vikunja-rest';
import { formatAorpAsMarkdown } from '../utils/response-factory';
import { assertWriteAllowed, getToolAnnotations, withReadOnlyNote } from '../utils/read-only';
import { ensureLabelByTitle } from '../utils/label-ensure';
import { LabelUpdateContext, type LabelUpdatePayload } from '../utils/label-update';
import type { components } from '../types/generated/vikunja-openapi';
// `ResponseData.labels` (src/utils/simple-response.ts) is still typed
// against this simplified local shape (`title: string`, not optional) — the
// REST-sourced `VikunjaLabel[]` below is cast to it at the one call site
// that populates that field (list) since the API always returns a title in
// practice even though the spec marks it optional.
import type { Label as ResponseLabel } from '../types/vikunja';

// Sourced from the vendored OpenAPI spec (docs/vikunja-openapi.json) — see
// docs/API-SPEC.md, replacing the legacy client's `Label` type.
type VikunjaLabel = components['schemas']['models.Label'];

// Use shared validateAndConvertId from utils/validation

/**
 * Re-throws a REST-layer 404 (`vikunjaRestRequest` throws `MCPError` with
 * `details.statusCode`, not a bare `.statusCode` property) as a friendly
 * "Label with ID X not found" — matching the message the legacy-client-backed
 * implementation produced via its own thrown `.statusCode`-bearing errors.
 * Everything else is rethrown/wrapped unchanged by the caller's
 * `wrapToolError` fallback.
 */
function rethrowLabelNotFound(error: unknown, id: number): never {
  if (error instanceof MCPError && error.details?.statusCode === 404) {
    throw new MCPError(ErrorCode.NOT_FOUND, `Label with ID ${id} not found`);
  }
  throw error;
}

export function registerLabelsTool(
  server: McpServer,
  authManager: AuthManager,
  _clientFactory?: VikunjaClientFactory,
): void {
  server.tool(
    'vikunja_labels',
    withReadOnlyNote(
      'vikunja_labels',
      'Manage task labels with full CRUD operations for organizing and categorizing tasks. ' +
        'To attach a label by name in one call, pass `labelTitles` to vikunja_task_labels ' +
        'apply-label instead — it get-or-creates each title and attaches it, no separate lookup ' +
        'needed. Use subcommand "ensure" here only when you want to get-or-create a label by title ' +
        '(idempotent, one call) WITHOUT attaching it to a task.',
    ),
    {
      // Operation type
      subcommand: z.enum(['list', 'get', 'create', 'update', 'delete', 'ensure']),

      // Common parameters
      id: z.number().int().positive().optional(),

      // List parameters
      page: z.number().int().positive().optional(),
      perPage: z.number().int().positive().max(100).optional(),
      search: z.string().optional(),

      // Create/Update parameters
      title: z.string().min(1).optional(),
      description: z.string().optional(),
      hexColor: z
        .string()
        .regex(/^#[0-9A-Fa-f]{6}$/, 'Invalid hex color format')
        .optional(),
    },
    getToolAnnotations('vikunja_labels'),
    async (args) => {
      // Closure-gate precedence fix: defer to the per-request context when
      // bound (see hasRequestContext's doc comment, src/client.ts).
      if (hasRequestContext()) {
        await getAuthManagerFromContext();
      } else if (!authManager.isAuthenticated()) {
        throw new MCPError(
          ErrorCode.AUTH_REQUIRED,
          'Authentication required. Please use vikunja_auth.connect first.',
        );
      }

      const subcommand = args.subcommand;

      assertWriteAllowed('vikunja_labels', subcommand);

      try {
        switch (subcommand) {
          case 'list': {
            const params = new URLSearchParams();
            if (args.page) params.set('page', String(args.page));
            if (args.perPage) params.set('per_page', String(args.perPage));
            if (args.search) params.set('s', args.search);
            const query = params.toString();

            const labelsResult = await vikunjaRestRequest<VikunjaLabel[]>(
              authManager,
              'GET',
              `/labels${query ? `?${query}` : ''}`,
            );
            // Handle null/undefined response from API
            const labels = labelsResult ?? [];

            const paramsMetadata: Record<string, string | number> = {};
            if (args.page) paramsMetadata.page = args.page;
            if (args.perPage) paramsMetadata.per_page = args.perPage;
            if (args.search) paramsMetadata.s = args.search;

            const response = createStandardResponse(
              'list-labels',
              `Retrieved ${labels.length} label${labels.length !== 1 ? 's' : ''}`,
              { labels: labels as unknown as ResponseLabel[] },
              { count: labels.length, params: paramsMetadata },
            );

            return {
              content: [
                {
                  type: 'text' as const,
                  text: formatAorpAsMarkdown(response),
                },
              ],
            };
          }

          case 'get': {
            if (args.id === undefined) {
              throw new MCPError(ErrorCode.VALIDATION_ERROR, 'Label ID is required');
            }
            validateAndConvertId(args.id, 'id');

            let label: VikunjaLabel;
            try {
              label = await vikunjaRestRequest<VikunjaLabel>(
                authManager,
                'GET',
                `/labels/${args.id}`,
              );
            } catch (error) {
              rethrowLabelNotFound(error, args.id);
            }

            const response = createStandardResponse(
              'get-label',
              `Retrieved label "${label.title}"`,
              { label },
            );

            return {
              content: [
                {
                  type: 'text' as const,
                  text: formatAorpAsMarkdown(response),
                },
              ],
            };
          }

          case 'create': {
            if (!args.title) {
              throw new MCPError(ErrorCode.VALIDATION_ERROR, 'Title is required');
            }

            const labelData: VikunjaLabel = {
              title: args.title,
            };
            if (args.description) labelData.description = args.description;
            if (args.hexColor) labelData.hex_color = args.hexColor;

            const label = await vikunjaRestRequest<VikunjaLabel>(
              authManager,
              'PUT',
              '/labels',
              labelData,
            );

            const response = createStandardResponse(
              'create-label',
              `Label "${label.title}" created successfully`,
              { label },
              { affectedFields: Object.keys(labelData).filter((key) => typeof key === 'string') },
            );

            return {
              content: [
                {
                  type: 'text' as const,
                  text: formatAorpAsMarkdown(response),
                },
              ],
            };
          }

          case 'update': {
            if (args.id === undefined) {
              throw new MCPError(ErrorCode.VALIDATION_ERROR, 'Label ID is required');
            }
            validateAndConvertId(args.id, 'id');

            if (!args.title && args.description === undefined && !args.hexColor) {
              throw new MCPError(
                ErrorCode.VALIDATION_ERROR,
                'At least one field to update is required',
              );
            }

            // One mapping, both strategies. The v1 path lays this over the
            // label's current state before replacing it; the v2 path sends it
            // as the merge patch body unchanged.
            const updates: LabelUpdatePayload = {};
            if (args.title) updates.title = args.title;
            if (args.description !== undefined) updates.description = args.description;
            if (args.hexColor) updates.hex_color = args.hexColor;

            let label: VikunjaLabel;
            try {
              label = await new LabelUpdateContext(authManager).execute({
                authManager,
                labelId: args.id,
                updates,
              });
            } catch (error) {
              rethrowLabelNotFound(error, args.id);
            }

            const response = createStandardResponse(
              'update-label',
              `Label "${label.title}" updated successfully`,
              { label },
              { affectedFields: Object.keys(updates).filter((key) => typeof key === 'string') },
            );

            return {
              content: [
                {
                  type: 'text' as const,
                  text: formatAorpAsMarkdown(response),
                },
              ],
            };
          }

          case 'delete': {
            if (args.id === undefined) {
              throw new MCPError(ErrorCode.VALIDATION_ERROR, 'Label ID is required');
            }
            validateAndConvertId(args.id, 'id');

            let result: unknown;
            try {
              result = await vikunjaRestRequest(authManager, 'DELETE', `/labels/${args.id}`);
            } catch (error) {
              rethrowLabelNotFound(error, args.id);
            }

            const response = createStandardResponse('delete-label', `Label deleted successfully`, {
              result,
            });

            return {
              content: [
                {
                  type: 'text' as const,
                  text: formatAorpAsMarkdown(response),
                },
              ],
            };
          }

          case 'ensure': {
            if (!args.title) {
              throw new MCPError(ErrorCode.VALIDATION_ERROR, 'Title is required');
            }

            const result = await ensureLabelByTitle(authManager, args.title, {
              ...(args.description ? { description: args.description } : {}),
              ...(args.hexColor ? { hexColor: args.hexColor } : {}),
            });

            const response = result.created
              ? createStandardResponse(
                  'ensure-label',
                  `Label "${result.label.title}" did not exist, created it`,
                  { label: result.label },
                  {
                    // Mirrors the `create` subcommand's affectedFields: the
                    // keys actually sent in the PUT body when creating.
                    affectedFields: [
                      'title',
                      ...(args.description ? ['description'] : []),
                      ...(args.hexColor ? ['hex_color'] : []),
                    ],
                    reused: false,
                  },
                )
              : createStandardResponse(
                  'ensure-label',
                  `Label "${result.label.title}" already exists (reused)`,
                  { label: result.label },
                  { affectedFields: [], reused: true },
                );

            return {
              content: [
                {
                  type: 'text' as const,
                  text: formatAorpAsMarkdown(response),
                },
              ],
            };
          }

          default:
            throw new MCPError(
              ErrorCode.VALIDATION_ERROR,
              `Invalid subcommand: ${String(subcommand)}`,
            );
        }
      } catch (error) {
        throw wrapToolError(error, 'vikunja_labels', `${subcommand} label`, args.id);
      }
    },
  );
}
