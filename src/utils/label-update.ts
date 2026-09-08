/**
 * Label update: a v1 strategy and a v2 strategy, selected per session.
 *
 * Step 6 of the P3 v2 adoption spec
 * (docs/superpowers/specs/2026-08-02-vikunja-v2-native-adoption-design.md),
 * tracking issue netadvanced/vikunja-mcp-ng#184.
 *
 * ## Why a strategy pair, when labels looked like the entity that needed none
 *
 * The expectation going in was that labels differ from tasks only in the URL
 * prefix and the response envelope, so a version-selected URL plus the
 * transport's normalizer would do and a pair would be over-engineering. Probing
 * the running 2.4.0, 2.5.0 and 2.6.0 stacks on 2026-09-05 showed the opposite,
 * for a reason the vendored spec hides:
 *
 * | Call | 2.4.0 | 2.5.0 | 2.6.0 |
 * |------|-------|-------|-------|
 * | `PUT /api/v1/labels/{id}` (what the tool used to send, and what `docs/vikunja-openapi.json` declares) | 405 | 405 | 405 |
 * | `POST /api/v1/labels/{id}` (what the server actually routes; `Allow: OPTIONS, DELETE, GET, POST`) | 200, full replace | 200, full replace | 200, full replace |
 * | `PATCH /api/v2/labels/{id}` | 200, true partial | 200, true partial | 200, true partial |
 *
 * Two consequences:
 *
 * 1. The v1 route in the vendored v1 spec does not exist on any supported
 *    server, so `vikunja_labels update` answered `HTTP 405 Method Not Allowed`
 *    on every version. Routing to v2 alone would have left the kill switch and
 *    the undetected-version fallback pointing at a dead route, so the v1 verb is
 *    corrected here too.
 * 2. The v1 route that does exist is a **full model replace**, despite the old
 *    comment in `src/tools/labels.ts` claiming otherwise. `POST /labels/{id}`
 *    with `{"hex_color":"ff0000"}` returned a label whose `title` and
 *    `description` were both `""` (verified live on 2.6.0). A partial update on
 *    v1 therefore has to read the label and send the merged model back, which is
 *    a genuinely different call shape from v2's single `PATCH` — exactly the
 *    condition the spec sets for introducing a strategy.
 *
 * ## No `minVersion` floor
 *
 * `PATCH /api/v2/labels/{id}` applied the change and preserved every unmentioned
 * field on all three supported versions, so this selects v2 wherever the session
 * has v2 at all. The task-update floor of 2.5.0 comes from the subscription-422
 * bug, which is task-specific and does not exist here. `resolveApiVersion`
 * carries the rest of the policy: kill switch on means v1, and a session whose
 * capabilities were never detected, or whose probe found no v2 API, means v1.
 * An undetected server *version* does not, because with no `minVersion` here
 * the version is never compared against anything. Only the floored operations
 * read "version unknown" as "not new enough".
 *
 * ## Response shape
 *
 * The v2 `PATCH` response is `models.Label` with the same keys v1 returns: no
 * `max_permission`, and no `$schema` on the 200 body (only the problem+json
 * error bodies carry one, and the transport's normalizer would strip it either
 * way). So there is nothing to strip at this boundary and both strategies return
 * the same canonical shape.
 *
 * `?format=markdown` is deliberately not requested. v2 ignores it on `PATCH`,
 * and the owner decision of 2026-09-05 is that update responses keep today's
 * format rather than paying a re-read for cosmetic consistency with reads.
 */

import type { AuthManager } from '../auth/AuthManager';
import { MCPError } from '../types/errors';
import { resolveApiVersion } from './api-version';
import { vikunjaRestRequest } from './vikunja-rest';
import { vikunjaRestV2Request } from './vikunja-rest-v2';
import type { components } from '../types/generated/vikunja-openapi';

/** `models.Label` per the OpenAPI spec. */
type VikunjaLabel = components['schemas']['models.Label'];

/**
 * The writable half of a label: the only fields `vikunja_labels update` can
 * change, and the only ones either strategy ever sends.
 */
export type LabelUpdatePayload = Pick<VikunjaLabel, 'title' | 'description' | 'hex_color'>;

export interface LabelUpdateInput {
  authManager: AuthManager;
  labelId: number;
  /** Only the fields the caller actually asked to change. */
  updates: LabelUpdatePayload;
}

export interface LabelUpdateStrategy {
  readonly apiVersion: 'v1' | 'v2';
  execute(input: LabelUpdateInput): Promise<VikunjaLabel>;
}

/**
 * Vikunja answers `304 Not Modified` with an empty body when a merge patch
 * would leave the label exactly as it is, including the trivial case of writing
 * a field the value it already holds. Confirmed live on 2.6.0. Our transport
 * surfaces it as an `MCPError` because 304 is not `response.ok`.
 */
const NOT_MODIFIED = 304;

function isNotModified(error: unknown): boolean {
  return error instanceof MCPError && error.details?.statusCode === NOT_MODIFIED;
}

/**
 * Builds the full model v1's replace-semantics `POST` needs: the caller's
 * changed fields laid over the label as it currently stands.
 *
 * Only the three writable fields are carried. The rest of `models.Label` (`id`,
 * `created`, `updated`, `created_by`) is server-owned, and echoing it back would
 * invite the server to take our copy of it as authoritative.
 *
 * A field absent from both the update and the current label stays absent rather
 * than being sent as `undefined`, so the request body is the same one a
 * hand-written full replace would carry.
 */
export function mergeLabelForReplace(
  current: VikunjaLabel,
  updates: LabelUpdatePayload,
): LabelUpdatePayload {
  const merged: LabelUpdatePayload = {};
  const title = updates.title ?? current.title;
  const description = updates.description ?? current.description;
  const hexColor = updates.hex_color ?? current.hex_color;
  if (title !== undefined) merged.title = title;
  if (description !== undefined) merged.description = description;
  if (hexColor !== undefined) merged.hex_color = hexColor;
  return merged;
}

/**
 * Read the label, merge, replace.
 *
 * The read is not a courtesy: without it, `POST /labels/{id}` blanks every field
 * the caller did not mention (verified live, see the module comment). It is the
 * same shape as the v1 task update path, and it is what makes a partial label
 * update honest on a server where v2 is unavailable or switched off.
 */
export class V1LabelUpdateStrategy implements LabelUpdateStrategy {
  readonly apiVersion = 'v1' as const;

  async execute({ authManager, labelId, updates }: LabelUpdateInput): Promise<VikunjaLabel> {
    const current = await vikunjaRestRequest<VikunjaLabel>(
      authManager,
      'GET',
      `/labels/${labelId}`,
    );
    return vikunjaRestRequest<VikunjaLabel>(
      authManager,
      'POST',
      `/labels/${labelId}`,
      mergeLabelForReplace(current, updates),
    );
  }
}

/**
 * One merge patch. The response is the updated label, so nothing is re-read.
 *
 * The single exception is a patch the server considers a no-op, which it answers
 * `304` with no body. The caller still expects a label back, so that one branch
 * reads it. The read stays on v1: it is the same call the `get` subcommand
 * makes, which keeps the returned shape identical whichever branch produced it.
 */
export class V2LabelUpdateStrategy implements LabelUpdateStrategy {
  readonly apiVersion = 'v2' as const;

  async execute({ authManager, labelId, updates }: LabelUpdateInput): Promise<VikunjaLabel> {
    try {
      return await vikunjaRestV2Request<VikunjaLabel>(
        authManager,
        'PATCH',
        `/labels/${labelId}`,
        updates,
      );
    } catch (error) {
      if (isNotModified(error)) {
        return vikunjaRestRequest<VikunjaLabel>(authManager, 'GET', `/labels/${labelId}`);
      }
      throw error;
    }
  }
}

/**
 * Chooses the strategy for a session.
 *
 * The `getCapabilities` guard mirrors `selectTaskUpdateStrategy`: callers reach
 * this holding narrower auth-manager-shaped objects, and an update must fall
 * back to the always-available v1 path rather than throw when capability
 * detection is not part of that object at all.
 */
export function selectLabelUpdateStrategy(authManager: AuthManager): LabelUpdateStrategy {
  if (typeof authManager.getCapabilities !== 'function') {
    return new V1LabelUpdateStrategy();
  }
  return resolveApiVersion(authManager) === 'v2'
    ? new V2LabelUpdateStrategy()
    : new V1LabelUpdateStrategy();
}

/**
 * Runs one label update through the strategy this session resolves to.
 *
 * Mirrors `TaskUpdateContext`: the strategy is chosen once at construction and
 * the caller never learns which one it got.
 */
export class LabelUpdateContext {
  private readonly strategy: LabelUpdateStrategy;

  constructor(authManager: AuthManager) {
    this.strategy = selectLabelUpdateStrategy(authManager);
  }

  /** Which API the selected strategy writes through. Diagnostics and tests. */
  get apiVersion(): LabelUpdateStrategy['apiVersion'] {
    return this.strategy.apiVersion;
  }

  async execute(input: LabelUpdateInput): Promise<VikunjaLabel> {
    return this.strategy.execute(input);
  }
}
