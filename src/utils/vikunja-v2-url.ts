/**
 * Shared v2 base-URL normalization.
 *
 * Used by both the v2 transport (`./vikunja-rest-v2`) and the v2 capability
 * probe (`./capabilities`), which independently needed the exact same logic:
 * normalize whether or not `apiUrl` already carries an `/api/v{n}` suffix
 * (depends on how `VIKUNJA_URL` was configured), and replace — rather than
 * preserve — any existing version suffix.
 *
 * Deliberately its own dependency-free module rather than living in either
 * consumer: `capabilities.ts` intentionally avoids depending on the v2
 * transport's request-execution machinery (circuit breaker, retry, `fetch`
 * wiring — see that module's doc comment), so having it import from
 * `./vikunja-rest-v2` just for this one pure string helper would pull that
 * whole dependency graph along for the ride. A standalone module lets both
 * sides import a single pure function with no coupling either way.
 */
export function resolveV2BaseUrl(apiUrl: string): string {
  const trimmed = apiUrl.replace(/\/+$/, '');
  const withoutVersion = trimmed.replace(/\/api\/v\d+$/, '');
  return `${withoutVersion}/api/v2`;
}
