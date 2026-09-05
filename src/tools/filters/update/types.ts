/**
 * The contract both saved-filter update strategies satisfy.
 *
 * `vikunja_filters update` runs one of two genuinely different call shapes
 * depending on which API version serves the session, which is the spec's bar
 * for introducing a strategy at all (a mere URL-prefix or envelope difference
 * is the normalizer's job, not a strategy's):
 *
 *   v1: `GET /filters/{id}` -> merge -> `POST /filters/{id}` with the whole
 *       model, because `POST` replaces every field it is given. Two calls, and
 *       a read-modify-write window between them.
 *   v2: one `PATCH /filters/{filter}` carrying only the changed fields.
 *
 * Whichever runs, the caller sees the same canonical result: a
 * `models.SavedFilter` with the update applied, in the shape v1 has always
 * produced.
 */

import type { AuthManager } from '../../../auth/AuthManager';
import type { ApiVersion } from '../../../utils/api-version';
import type { ConditionInput } from '../query';
import type { SavedFilterApi } from '../saved-filter-api';

export type { SavedFilterApi };

/**
 * Caller-supplied fields for `vikunja_filters update`, after Zod parsing and
 * with the tool's `id` argument removed.
 *
 * Every property is explicitly `| undefined` because the project compiles with
 * `exactOptionalPropertyTypes`, and a Zod-parsed optional field is exactly
 * that union rather than an absent key.
 */
export interface SavedFilterUpdateParams {
  title?: string | undefined;
  description?: string | undefined;
  filter?: string | undefined;
  conditions?: ConditionInput[] | undefined;
  groupOperator?: '&&' | '||' | undefined;
  isFavorite?: boolean | undefined;
}

/** The keys `update` reports back in the response's `affectedFields`. */
export type SavedFilterUpdateField =
  'title' | 'description' | 'filter' | 'conditions' | 'isFavorite';

/**
 * The caller's request after the filter-query pipeline has run: tool-surface
 * names, and a query string already translated to the API's snake_case DSL.
 *
 * This is the one shape both strategies map from, so the two paths cannot
 * disagree about what "the caller asked for" means.
 */
export interface SavedFilterUpdateFields {
  readonly title?: string;
  readonly description?: string;
  readonly isFavorite?: boolean;
  /** Already parsed, validated and translated. See `../query`. */
  readonly filterQuery?: string;
}

/**
 * Everything a strategy needs to apply one update.
 *
 * The raw `params` are passed rather than pre-resolved fields so that each
 * strategy decides *when* the filter-query pipeline runs. That ordering is
 * caller-visible on v1: a semantically invalid `conditions` array has always
 * been rejected only after the current filter was read, and this refactor
 * keeps that sequence exactly. v2 has no such read, so it validates first.
 */
export interface SavedFilterUpdateInput {
  readonly authManager: AuthManager;
  readonly filterId: number;
  readonly params: SavedFilterUpdateParams;
}

export interface SavedFilterUpdateStrategy {
  /** Which Vikunja API this strategy writes through. Diagnostics only. */
  readonly apiVersion: ApiVersion;

  /** Applies the update and resolves with the complete, updated filter. */
  execute(input: SavedFilterUpdateInput): Promise<SavedFilterApi>;
}
