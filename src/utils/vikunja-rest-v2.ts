/**
 * Vikunja v2 REST transport.
 *
 * A deliberate sibling of `./vikunja-rest` rather than a branch inside it.
 * v1 is the permanent backward-compatible floor (minimum supported Vikunja
 * is 2.3.0, which is v1-only), so v2 support must not put new logic on the
 * code path v1 executes. Shared machinery — the retry loop, the named
 * circuit breaker registry, the retry predicate — is imported, not copied;
 * only URL resolution, breaker naming, request content type, and error
 * parsing differ.
 *
 * See docs/superpowers/specs/2026-07-27-vikunja-v2-transport-design.md.
 */

/**
 * Resolves the v2 API base URL for a session, normalizing whether or not
 * `apiUrl` already carries an `/api/v{n}` suffix (depends on how
 * `VIKUNJA_URL` was configured). Mirrors `resolveBaseUrl` in
 * `./vikunja-rest`, but targets v2 and replaces — rather than preserves —
 * an existing version suffix, matching `resolveV2ProbeUrl` in
 * `./capabilities`.
 */
export function resolveV2BaseUrl(apiUrl: string): string {
  const trimmed = apiUrl.replace(/\/+$/, '');
  const withoutVersion = trimmed.replace(/\/api\/v\d+$/, '');
  return `${withoutVersion}/api/v2`;
}

/**
 * Derives a stable, endpoint-group-scoped circuit breaker name for a v2
 * request path, using the same segment-collapsing rules as
 * `deriveRestBreakerName` in `./vikunja-rest` but under a distinct
 * `vikunja-rest-v2-` prefix.
 *
 * The prefix is load-bearing, not cosmetic. Breakers are process-wide and
 * keyed by name in the shared registry in `./retry`; without it, a v2
 * `PATCH /tasks/{id}` and a v1 `POST /tasks/{id}` would both derive
 * `vikunja-rest-tasks` and silently share one rolling failure window across
 * two different API surfaces.
 */
export function deriveRestV2BreakerName(path: string): string {
  const segments = path.split('/').filter((seg) => seg.length > 0 && !/^\d+$/.test(seg));
  const group = segments.slice(0, 2).join('-') || 'root';
  return `vikunja-rest-v2-${group}`;
}
