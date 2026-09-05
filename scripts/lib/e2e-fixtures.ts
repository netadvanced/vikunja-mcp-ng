/**
 * Shared e2e fixtures for things a single all-powerful user cannot express
 * (issue #254, items B1-B3).
 *
 * WHY THIS EXISTS. `docker/e2e/bootstrap.sh` mints its API token by asking
 * `GET /routes` for every permission the server has and granting all of
 * them, and every harness authenticates as one user who owns everything it
 * touches. That fixture is blind to an entire class of behaviour:
 *
 *   - a token that is MISSING a scope (Vikunja 2.6.0 checks `expand` values
 *     against the token's scopes; a full-scope token never trips it);
 *   - a resource the caller CANNOT read (2.6.0 scrubs unreadable teams out
 *     of `GET /projects/{id}/teams`, refuses to attach one, and refuses to
 *     delete a relation whose other task is unreadable).
 *
 * Both need a second credential, so both live here rather than being
 * reinvented per harness.
 *
 * VERSION-CONDITIONAL EXPECTATIONS (B3) are the third piece. Several of
 * these behaviours are a *tightening*: the old version returns 200 and
 * silently does the wrong thing, the new one refuses. A harness that runs
 * against both therefore needs to assert different outcomes per version.
 * `serverAtLeast` is that gate. It is deliberately NOT a revival of the
 * removed `versionLessThan`/`driftTolerated` pair: this is not "tolerate a
 * known regression", it is "the correct expected value depends on the
 * version", which is an ordinary assertion with a computed expectation.
 */

/**
 * Compares two plain `X.Y.Z` version strings. Returns a negative number when
 * `a` sorts before `b`, 0 when equal, positive when after. Leading `v` is
 * accepted on either side (`GET /info` reports `v2.6.0`).
 *
 * Non-numeric or missing components sort as 0, so `2.6` compares equal to
 * `2.6.0` rather than throwing — a server reporting something unexpected
 * must not crash a harness whose real job is elsewhere.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string): number[] =>
    v
      .replace(/^v/, '')
      .split('.')
      .map((part) => {
        const n = Number.parseInt(part, 10);
        return Number.isFinite(n) ? n : 0;
      });
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * True when the detected server version is `min` or newer.
 *
 * An UNDETECTED version (`null`) returns `false` — "we could not tell" must
 * never be read as "new enough", or a harness silently asserts the new
 * behaviour against an old server and reports a failure that is really a
 * missing `GET /info`.
 */
export function serverAtLeast(detected: string | null, min: string): boolean {
  if (!detected) return false;
  return compareVersions(detected, min) >= 0;
}

/** The first Vikunja release that checks `expand` values against token scopes. */
export const EXPAND_SCOPE_CHECK_VERSION = '2.6.0';

/**
 * Permission groups (as `GET /routes` names them) deliberately left OUT of
 * the narrow token. Both are reachable through `GET /tasks?expand=...`,
 * which is exactly the surface 2.6.0 started scope-checking.
 */
export const NARROW_TOKEN_OMITTED_GROUPS = ['tasks_comments', 'reactions'] as const;

/** `expand` values that need one of the omitted groups, and so must fail. */
export const EXPAND_VALUES_NEEDING_OMITTED_SCOPE = ['comments', 'reactions'] as const;

/** `expand` values the narrow token still has the scope for, and so must succeed. */
export const EXPAND_VALUES_WITHIN_NARROW_SCOPE = ['subtasks'] as const;

interface RoutesResponse {
  [group: string]: Record<string, unknown>;
}

/**
 * Mints a `tk_*` API token holding every permission the server exposes
 * EXCEPT the groups in `omitGroups` (default {@link NARROW_TOKEN_OMITTED_GROUPS}).
 *
 * Same `GET /routes` -> `PUT /tokens` flow bootstrap.sh uses, minus those
 * groups — so the resulting token differs from the harness's normal one in
 * exactly one respect, which is what makes a failure attributable.
 */
export async function mintScopedToken(
  apiUrl: string,
  jwt: string,
  options: { title: string; omitGroups?: readonly string[] },
): Promise<string> {
  const omit = new Set(options.omitGroups ?? NARROW_TOKEN_OMITTED_GROUPS);
  const routesRes = await fetch(`${apiUrl}/routes`, {
    headers: { Authorization: `Bearer ${jwt}` },
  });
  if (!routesRes.ok) {
    throw new Error(`GET /routes failed (${routesRes.status}) — cannot mint a scoped token.`);
  }
  const routes = (await routesRes.json()) as RoutesResponse;

  const permissions: Record<string, string[]> = {};
  for (const [group, actions] of Object.entries(routes)) {
    if (omit.has(group)) continue;
    permissions[group] = Object.keys(actions);
  }
  if (Object.keys(permissions).length === 0) {
    throw new Error('Scoped token would grant nothing — refusing to mint it.');
  }

  const expiresAt = new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString();
  const res = await fetch(`${apiUrl}/tokens`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: options.title, permissions, expires_at: expiresAt }),
  });
  // The spec documents 200; the real server answers 201. Accept both.
  if (res.status !== 200 && res.status !== 201) {
    throw new Error(`PUT /tokens failed (${res.status}): ${await res.text()}`);
  }
  const body = (await res.json()) as { token?: string };
  if (!body.token) throw new Error('PUT /tokens returned no token.');
  return body.token;
}

/**
 * The second, deliberately-not-us identity. Provisioned by
 * `docker/e2e/bootstrap.sh` alongside `e2e-test` and `e2e-mutable`.
 *
 * Distinct from `e2e-mutable` on purpose: that one exists so tests may burn
 * IDENTITY-scoped state (tokens, settings, avatar). This one exists to own
 * projects, teams and tasks that `e2e-test` must NOT be able to read, which
 * is a different job and must not be perturbed by an avatar test.
 */
export const OTHER_USERNAME = 'e2e-other';

/** Shared throwaway password for every provisioned e2e identity. */
export const E2E_PASSWORD = 'VikunjaMcpE2E-2026!';

/** Logs in and returns a JWT. Throws with the server's own body on failure. */
export async function loginFor(apiUrl: string, username: string, password = E2E_PASSWORD): Promise<string> {
  const res = await fetch(`${apiUrl}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) {
    throw new Error(
      `POST /login as '${username}' failed: ${res.status} ${await res.text()} — ` +
        "is the stack bootstrapped? Run 'npm run e2e:up'.",
    );
  }
  return ((await res.json()) as { token: string }).token;
}

/**
 * Grants `username` access to a project.
 *
 * Note the body shape: `{ username, permission }`, NOT `{ user_id, right }`.
 * The latter is what the field names elsewhere in the API suggest and it
 * fails with `1005 The user does not exist.`
 */
export async function shareProjectWithUser(
  apiUrl: string,
  jwt: string,
  projectId: number,
  username: string,
  permission = 2,
): Promise<void> {
  const res = await fetch(`${apiUrl}/projects/${projectId}/users`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, permission }),
  });
  if (res.status !== 200 && res.status !== 201) {
    throw new Error(`Sharing project ${projectId} with ${username} failed: ${res.status} ${await res.text()}`);
  }
}

/**
 * Revokes a user's access to a project — the access-revocation path (B2)
 * that makes "this resource is now unreadable to you" reproducible without
 * a second stack.
 *
 * The path segment is the USERNAME. The vendored spec declares this
 * parameter as `userID: integer`, and passing a numeric id really does
 * answer `404 {"code":1005,"message":"The user does not exist."}` — verified
 * on 2.6.0. The spec is wrong; see docs/VIKUNJA_API_ISSUES.md.
 */
export async function revokeProjectUser(
  apiUrl: string,
  jwt: string,
  projectId: number,
  username: string,
): Promise<void> {
  const res = await fetch(`${apiUrl}/projects/${projectId}/users/${encodeURIComponent(username)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${jwt}` },
  });
  if (!res.ok) {
    throw new Error(`Revoking ${username} from project ${projectId} failed: ${res.status} ${await res.text()}`);
  }
}
