/**
 * Project backgrounds — JSON-only subset (G7, docs/ENDPOINT-TAIL-RETRIAGE.md)
 *
 * Gated behind the opt-in, deny-by-default `backgrounds` module config key
 * (`src/config/types.ts` — see the comment there for why this is "opt-in
 * cosmetic", the deliberate opposite of every other default-on domain
 * module). `registerProjectsTool` (`./index.ts`) only includes these three
 * subcommands in `vikunja_projects`'s subcommand enum when the module is
 * enabled, so — matching every other module's contract — they are genuinely
 * absent from the tool's schema when disabled, not merely rejected at
 * dispatch.
 *
 * Endpoints implemented (verified against docs/vikunja-openapi.json):
 *   - DELETE /projects/{id}/background           -> models.Project
 *   - POST   /projects/{id}/backgrounds/unsplash  -> models.Project
 *   - GET    /backgrounds/unsplash/search         -> background.Image[]
 *
 * Deliberately parked (binary image bytes — no MCP content channel for
 * them; see docs/ENDPOINT-TAIL-RETRIAGE.md and docs/ROADMAP.md §4):
 *   - PUT  /projects/{id}/backgrounds/upload
 *   - GET  /projects/{id}/background (the image bytes themselves)
 *   - GET  /backgrounds/unsplash/image/{image}(/thumb)
 *
 * `POST /projects/{id}/backgrounds/unsplash`'s request body is typed as
 * `background.Image` in the spec (id/url/thumb/blur_hash/info), but the
 * server only needs the photo `id` — the endpoint description confirms it
 * "sets a photo from unsplash as project background" by ID, not by echoing
 * back full image metadata the caller has no independent way to know. So
 * this module only accepts/sends `id`, matching G7's own scoping note
 * ("likely the unsplash photo id").
 *
 * Unsplash search/set only work when the connected Vikunja server has an
 * Unsplash provider configured (an admin-side API key). When it doesn't,
 * the server errors — `wrapUnsplashProviderError` recognizes that shape and
 * rewrites it into a friendly, actionable message instead of surfacing the
 * server's raw error text.
 */

import type { AuthManager } from '../../auth/AuthManager';
import { MCPError, ErrorCode } from '../../types';
import { validateId } from '../../utils/validation';
import { transformApiError } from '../../utils/error-handler';
import { createStandardResponse, formatAorpAsMarkdown } from '../../utils/response-factory';
import { vikunjaRestRequest } from '../../utils/vikunja-rest';
import type { components } from '../../types/generated/vikunja-openapi';

// Sourced from the vendored OpenAPI spec (docs/vikunja-openapi.json).
type VikunjaProject = components['schemas']['models.Project'];
type UnsplashImage = components['schemas']['background.Image'];

export type McpResponse = {
  content: Array<{ type: 'text'; text: string }>;
};

export interface RemoveBackgroundArgs {
  /** Project id to remove the background from. */
  id?: number;
  sessionId?: string;
}

export interface SetUnsplashBackgroundArgs {
  /** Project id to set the background on. */
  id?: number;
  /** The unsplash photo id (`background.Image.id` from `search-unsplash`). */
  unsplashImageId?: string;
  sessionId?: string;
}

export interface SearchUnsplashArgs {
  /** Search term (maps to the API's `s` query param). */
  unsplashQuery?: string;
  /** Page number, 1-based (maps to the API's `p` query param). */
  page?: number;
  sessionId?: string;
}

/**
 * Recognizes the shape of a server error that indicates the Unsplash
 * provider isn't configured (no admin-side API key / feature disabled) so
 * it can be rewritten into a friendly, actionable message rather than
 * surfaced as an opaque server error. Deliberately conservative — only
 * matches error text that clearly mentions unsplash AND a
 * configuration/availability concern, so genuine unrelated failures (a bad
 * project id, a permissions error, an actually-malformed request) are never
 * misreported as a provider-configuration issue.
 */
function isLikelyUnsplashNotConfigured(message: string): boolean {
  return /unsplash/i.test(message) && /(not[\s-]*(en|configur)|disabl|no.*(key|token)|access[\s-]*token)/i.test(message);
}

/**
 * Wraps an error from an unsplash-touching REST call: a recognized
 * "provider not configured" shape gets a friendly explanation (preserving
 * the original server text for debugging); everything else passes through
 * unchanged (already a non-stack-trace `MCPError` courtesy of
 * `vikunjaRestRequest`'s own error contract).
 */
function wrapUnsplashError(error: unknown, action: string): never {
  if (error instanceof MCPError) {
    if (isLikelyUnsplashNotConfigured(error.message)) {
      throw new MCPError(
        ErrorCode.API_ERROR,
        `${action} unavailable: this Vikunja server does not appear to have an Unsplash ` +
          `background provider configured. Ask your Vikunja administrator to set up an ` +
          `Unsplash API key (or confirm Unsplash backgrounds are enabled) on the server. ` +
          `(Server said: ${error.message})`,
      );
    }
    throw error;
  }
  throw transformApiError(error, action);
}

/**
 * Removes a project's background, regardless of which provider set it.
 * Per the spec, this does not error if the project has no background set.
 */
export async function removeProjectBackground(
  args: RemoveBackgroundArgs,
  authManager: AuthManager,
): Promise<McpResponse> {
  if (!args.id) {
    throw new MCPError(ErrorCode.VALIDATION_ERROR, 'Project id is required for remove-background operation');
  }
  validateId(args.id, 'id');

  let project: VikunjaProject;
  try {
    project = await vikunjaRestRequest<VikunjaProject>(
      authManager,
      'DELETE',
      `/projects/${args.id}/background`,
    );
  } catch (error) {
    if (error instanceof MCPError) {
      throw error;
    }
    throw transformApiError(error, 'Failed to remove project background');
  }

  const response = createStandardResponse(
    'remove-background',
    `Background removed from project ${args.id}`,
    { project },
    { timestamp: new Date().toISOString() },
    args.sessionId,
  );

  return { content: [{ type: 'text' as const, text: formatAorpAsMarkdown(response) }] };
}

/**
 * Sets an unsplash photo (by its unsplash photo id, from `search-unsplash`)
 * as a project's background.
 */
export async function setUnsplashBackground(
  args: SetUnsplashBackgroundArgs,
  authManager: AuthManager,
): Promise<McpResponse> {
  if (!args.id) {
    throw new MCPError(ErrorCode.VALIDATION_ERROR, 'Project id is required for set-unsplash-background operation');
  }
  validateId(args.id, 'id');
  if (!args.unsplashImageId || args.unsplashImageId.trim() === '') {
    throw new MCPError(
      ErrorCode.VALIDATION_ERROR,
      'unsplashImageId is required for set-unsplash-background operation',
    );
  }

  const body: UnsplashImage = { id: args.unsplashImageId };

  let project: VikunjaProject;
  try {
    project = await vikunjaRestRequest<VikunjaProject>(
      authManager,
      'POST',
      `/projects/${args.id}/backgrounds/unsplash`,
      body,
    );
  } catch (error) {
    wrapUnsplashError(error, 'Setting the unsplash background');
  }

  const response = createStandardResponse(
    'set-unsplash-background',
    `Project ${args.id} background set to unsplash photo ${args.unsplashImageId}`,
    { project, unsplashImageId: args.unsplashImageId },
    { timestamp: new Date().toISOString() },
    args.sessionId,
  );

  return { content: [{ type: 'text' as const, text: formatAorpAsMarkdown(response) }] };
}

/**
 * Searches unsplash for candidate background photos. Only works when the
 * connected Vikunja server has an Unsplash provider configured — see
 * `wrapUnsplashError`.
 */
export async function searchUnsplashBackgrounds(
  args: SearchUnsplashArgs,
  authManager: AuthManager,
): Promise<McpResponse> {
  if (args.page !== undefined) {
    validateId(args.page, 'page');
  }

  const params = new URLSearchParams();
  if (args.unsplashQuery !== undefined && args.unsplashQuery.trim() !== '') {
    params.set('s', args.unsplashQuery);
  }
  if (args.page !== undefined) {
    params.set('p', String(args.page));
  }
  const query = params.toString();

  let photos: UnsplashImage[];
  try {
    const result = await vikunjaRestRequest<UnsplashImage[]>(
      authManager,
      'GET',
      `/backgrounds/unsplash/search${query ? `?${query}` : ''}`,
    );
    photos = Array.isArray(result) ? result : [];
  } catch (error) {
    wrapUnsplashError(error, 'Searching unsplash backgrounds');
  }

  const photoWord = photos.length === 1 ? 'photo' : 'photos';
  const response = createStandardResponse(
    'search-unsplash',
    `Found ${photos.length} unsplash ${photoWord}`,
    { photos },
    { timestamp: new Date().toISOString() },
    args.sessionId,
  );

  return { content: [{ type: 'text' as const, text: formatAorpAsMarkdown(response) }] };
}
