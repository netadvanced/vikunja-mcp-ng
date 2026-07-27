# Vikunja v2 transport, error adapter, and routing — design

**Date:** 2026-07-27
**Issue:** [#184](https://github.com/netadvanced/vikunja-mcp-ng/issues/184) — 0.7.0 milestone
**Scope:** phases P1 (v2 transport + error adapter) and P2 (routing + kill switch) only.
P3 (per-endpoint fast paths), P4 (proof), and P5 (docs/release) are separate specs.

## Problem

Vikunja v1 has no partial-update route. `POST /tasks/{id}` and `POST /tasks/bulk` overwrite
unlisted fields — assignees in particular — by design, because Go cannot distinguish "absent"
from "zero". Upstream closed [go-vikunja/vikunja#3222](https://github.com/go-vikunja/vikunja/issues/3222)
as NOT_PLANNED with the explicit answer: *"The new v2 api has a patch route that can be used
when assignees should be preserved."*

Every fetch-merge-POST and snapshot/restore workaround in this codebase exists solely because of
that gap — `src/tools/tasks/crud/TaskUpdateService.ts:109-111` (full-model merge POST) and
`src/tools/tasks/bulk-operations-simplified.ts:245-256`/`:300-312` (assignee snapshot then
restore) are the two load-bearing examples.

v2 offers `PATCH` for the routes we care about. This spec builds the transport, error handling,
and routing needed to use it — **without changing the behaviour of any existing operation**.
Retiring the workarounds is P3 and depends on this foundation.

## Non-goals

- **v1 is never removed.** Minimum supported Vikunja stays 2.3.0 (v1-only). Every v2 path needs a
  working v1 fallback and both stay tested, permanently.
- No tool-surface change, no new tools, no caller-visible schema change.
- No per-endpoint migration in this phase. Nothing in `src/tools/` calls the v2 path when this
  phase lands, except `vikunja_auth` reporting which path *would* be used.
- Admin, bots, time-entries, and avatar-provider v2 routes are out of scope entirely.

## Existing groundwork (already on `main`, unchanged by this spec)

- **#147** — vendored spec `docs/vikunja-openapi-v2.json` (OpenAPI 3.1.0, Vikunja 2.4.0) and
  generated types `src/types/generated/vikunja-openapi-v2.d.ts`. Not wired into runtime.
  `VikunjaErrorModel` (`:5674`) and `ErrorDetail` (`:3238`) are already generated and unconsumed.
- **#149** — per-session capability detection `src/utils/capabilities.ts`: `GET /info` plus a
  one-time best-effort `GET /api/v2/openapi.json` probe producing
  `VikunjaCapabilities { serverVersion?, features, hasV2Api }`, cached on the session via
  `AuthManager.setCapabilities`, cleared on `disconnect()`. **No tool branches on `hasV2Api`
  today.**

## Architecture

Three units, each independently testable, plus two small edits to existing files.

### 1. `src/utils/vikunja-rest-v2.ts` (new) — v2 transport

A parallel module to `src/utils/vikunja-rest.ts`. It mirrors that module's *shape*, not its code,
and the v1 module is not modified. This is deliberate: v1 is the permanent backward-compatible
floor, and threading an `apiVersion` branch through the functions v1 executes would put new,
unproven logic on the path that must never regress. The cost is some duplicated URL-normalization
and retry wiring; the benefit is that v1's behaviour is structurally guaranteed unchanged.

Shared machinery is reused, not copied: `createCircuitBreaker`, `withRetry`, `isRetryableError`,
and `rewordBreakerOpenError` all come from `src/utils/retry.ts`, which needs no changes.
`defaultRestShouldRetry` (already exported) is imported from the v1 module — the retry policy
(5xx/429 and transient network failures, never 4xx) is API-version-independent and must stay
identical across both paths.

**The one permitted edit to `vikunja-rest.ts`** is adding `export` to `isTransientNetworkError`
(`:117`), currently module-private. The v2 transport needs the same transient-network
classification, and sharing one function is strictly better than duplicating
`TRANSIENT_NETWORK_CODES` into a second file where the two copies could drift. This is purely
additive — no behavioural change, no signature change, no other line touched.

**Exports:**

- `resolveV2BaseUrl(apiUrl: string): string` — strips trailing slashes and any existing
  `/api/v{n}` suffix, then appends `/api/v2`. Same normalization approach as
  `capabilities.ts:resolveV2ProbeUrl` (`:35-39`), which is already proven against real
  `VIKUNJA_URL` configurations both with and without the version suffix.

- `deriveRestV2BreakerName(path: string): string` — identical segment-collapsing logic to
  `deriveRestBreakerName` (drop numeric id segments, keep the first two remaining segments), but
  prefixed `vikunja-rest-v2-`.

  **This prefix is load-bearing.** Breakers are process-wide and keyed by name in a shared
  registry (`retry.ts:14-66`); a name collision makes one endpoint's failures trip another's
  breaker. Without the distinct prefix, a v2 `PATCH /tasks/{id}` and a v1 `POST /tasks/{id}` both
  derive `vikunja-rest-tasks` and would silently share a rolling failure window across two
  different API surfaces — exactly the failure mode the per-path derivation exists to prevent.

- `vikunjaRestV2Request<T>(authManager, method, path, body?, options?): Promise<T>` — the public
  entry point. Same structure as `vikunjaRestRequest` (`vikunja-rest.ts:262-284`): derive breaker
  name, merge `DEFAULT_JSON_RETRY` with `defaultRestShouldRetry` and caller overrides, fire
  through the named breaker inside `withRetry`, reword a breaker-open error.

  `options` is a `VikunjaRestV2RequestOptions` extending the exported `VikunjaRestRequestOptions`
  (`breakerName`, `retry`) with `patchFormat?: 'merge' | 'json-patch'`.

- A private `vikunjaRestV2RequestRaw` — a stable top-level function reference, never a call-site
  closure, for the reason documented at `retry.ts:216-229` (the wave0 anonymous-breaker bug: a
  breaker re-fires the first closure ever registered under its name).

**Request content type.** For `PATCH`, `application/merge-patch+json` by default,
`application/json-patch+json` when `patchFormat: 'json-patch'`. Every other method sends
`application/json`. The helper stays generic over both formats even though nothing selects
`json-patch` in this phase: v2 accepts both on all 14 PATCH routes, merge-patch fits our argument
shapes, and JSON Patch is the only way to express true array operations (add/remove a single
assignee) — a capability P3 may want per endpoint. Supporting it now costs one parameter; adding
it later would mean reworking the transport's request construction.

### 2. `parseVikunjaV2Error` (in the same module) — problem+json → MCPError

v2 returns `application/problem+json` (`VikunjaErrorModel`) instead of v1's `web.HTTPError`.
There is no problem+json handling anywhere in `src/` today — v1 reads the error body as plain
text, truncates it to 500 chars, and folds it into the message string
(`vikunja-rest.ts:204-229`).

On a non-2xx v2 response:

1. If the response `Content-Type` includes `application/problem+json`, parse the body as
   `VikunjaErrorModel` and build an `MCPError` with:
   - `details.statusCode` = the HTTP status. **Not** the model's `status` field — the two should
     agree, but the breaker's `errorFilter` and `defaultRestShouldRetry` key off the real
     transport status, and a server bug in the body must not be able to change retry behaviour.
   - `details.vikunjaError` = `{ code, errors }`, preserving Vikunja's numeric `code`
     (`VikunjaErrorModel.code`, generated at `:5685`) and the `errors[]` detail list
     (`ErrorDetail { location, message, value }`, `:3238`). No code in `src/` reads
     `details.vikunjaError` today (`src/types/errors.ts` types it `unknown`; every existing write
     site is fire-and-forget) — the numeric code is preserved for future consumers and diagnostic
     fidelity, not because anything currently keys on it.
   - message = `title` plus `detail` when present, with the `errors[]` field locations appended so
     a validation failure names the offending field.
   - a top-level `.status` via `Object.assign`, mirroring `vikunja-rest.ts:227` — shared
     classifiers (`isAuthenticationError`, `extractHttpStatus`) read `.status`, not
     `.details.statusCode`, and a v2 401/403 must be visible to them.
2. Otherwise — wrong content type, malformed JSON, or an unreadable body — fall back to the v1
   message shape (`HTTP {status} {statusText} — {truncated body}`) with `details.statusCode` set.
   This is not hypothetical: a reverse proxy or gateway between the client and Vikunja can return
   a plain-text 502/504 that never reaches Vikunja's error rendering.

Network-layer failures (fetch itself rejects) reuse the v1 contract exactly: `MCPError` with
`details.transient` set from the transient-network-code check, so `defaultRestShouldRetry` can see
transience after wrapping discards the original `.code` (`vikunja-rest.ts:107-133`).

The breaker's 4xx exclusion (`isClientErrorExcludedFromBreaker`, `retry.ts:142-147`) needs no
change — it reads the status generically via `extractHttpStatus` and so applies to v2 errors
unmodified, preserving the #166 behaviour.

### 3. `resolveApiVersion(authManager): 'v1' | 'v2'` — the single routing decision point

Synchronous, no network call, no per-call probing. Four branches, in order:

1. Kill switch enabled → `'v1'`
2. No capability snapshot cached for this session (`getCapabilities()` returns undefined) → `'v1'`
3. `capabilities.hasV2Api === false` → `'v1'`
4. `capabilities.hasV2Api === true` → `'v2'`

`hasV2Api` alone gates the decision; there is no `serverVersion` floor check. The probe already
performs a real `GET /api/v2/openapi.json` and trusts only a 2xx response, which is a stronger and
more direct signal than parsing a version string, and it keeps one source of truth.

Branch 2 matters: capabilities are populated during `connect`/`info` and cleared on `disconnect`,
so an uninitialized or torn-down session must fall back to v1 rather than assume v2.

### 4. Kill switch — `featureFlags.forceV1Api`

A new boolean on `FeatureFlagsConfigSchema` (`src/config/types.ts:87-91`), default `false`,
alongside `enableServerSideFiltering`.

`featureFlags` is the right home rather than a top-level key like `readOnly`:
`enableServerSideFiltering` is the same shape — a toggle that forces the conservative fallback
path instead of the optimized one — and the group already has config-file, env-override, and
environment-profile wiring. `forceV1Api` is deliberately **not** added to `ENVIRONMENT_PROFILES`;
it defaults to `false` in every environment via the schema default, so no environment silently
disables v2.

- **Config file key:** `featureFlags.forceV1Api` in `vikunja-mcp.config.json`.
- **Env override:** `VIKUNJA_MCP_FORCE_V1_API`, wired in `loadFromEnvironmentVariables` next to
  `enableServerSideFiltering` (`ConfigurationManager.ts:390-398`). Env always wins over the config
  file, per the existing layering (`ConfigurationManager.ts:143-144`).
- **Accessor:** a new synchronous `ConfigurationManager.isV1Forced(): boolean` reading
  `loadConfiguration().featureFlags.forceV1Api`, following the `isReadOnly()` precedent
  (`ConfigurationManager.ts:220-228`) rather than the async `isFeatureEnabled`. The rationale is
  the same one documented there: `loadConfiguration()` is synchronous and cached after the first
  call, and `resolveApiVersion` will sit on a per-request path in P3 where an async config read
  would be an unnecessary await.

### 5. `vikunja_auth` reporting

`src/tools/auth.ts` gains `activeApiVersion` (computed via `resolveApiVersion`) in three places:

- `status` (`:184-194`) — already surfaces `serverVersion`/`hasV2Api` via `AuthManager.getStatus()`.
- `info` (`:262-296`) — already surfaces both explicitly.
- `connect` (`:130-179`) — currently reports `serverVersion` but omits `hasV2Api`, even though it
  is the subcommand that triggers first detection. Add both `hasV2Api` and `activeApiVersion`.

This is the only caller of `resolveApiVersion` in this phase, and it makes the routing decision
observable — including the kill switch's effect — before any operation depends on it.

## Data flow

```
tool call
  └─> (P3: resolveApiVersion(authManager))          ← not wired in this phase
        ├─ 'v1' ─> vikunjaRestRequest      ─> /api/v1 ─> breaker "vikunja-rest-{group}"
        └─ 'v2' ─> vikunjaRestV2Request    ─> /api/v2 ─> breaker "vikunja-rest-v2-{group}"
                     │
                     ├─ 2xx      ─> parsed JSON
                     ├─ non-2xx  ─> parseVikunjaV2Error ─> MCPError
                     │                 {statusCode, vikunjaError:{code, errors}, .status}
                     └─ fetch rejects ─> MCPError { transient }

resolveApiVersion:
  forceV1Api? ─yes─> v1
  no capabilities cached? ─yes─> v1
  hasV2Api === true? ─yes─> v2 ─else─> v1
```

## Error handling

Both transports converge on the same `MCPError` contract, so downstream code — retry predicates,
the circuit breaker's `errorFilter`, `SecureErrorHandler`, and every tool's catch block — is
unchanged and version-blind. The v2 adapter's job is to lose nothing in translation: the numeric
Vikunja `code`, the HTTP status (in both `.details.statusCode` and `.status`), and the per-field
`errors[]` details all survive.

One deliberate asymmetry: `wrapIfRestOrigin` (`error-handler.ts:165-171`) matches the literal
prefix `Vikunja REST request failed (`. The v2 transport uses the **same** message prefix so that
existing wrapping behaviour applies identically to both paths.

## Testing

Unit tests must hold coverage at the ratchet (92 lines / 83 branches / 82 functions / 92
statements). Per the repo's defensive-programming rule, every fallback path below has a test that
actually triggers it.

- **URL resolution** — `apiUrl` with and without a trailing slash, with `/api/v1` already
  appended, with `/api/v2` already appended, and bare.
- **Breaker naming** — parity with the v1 derivation for the same paths, plus an explicit test
  asserting `deriveRestV2BreakerName(p) !== deriveRestBreakerName(p)` for a shared path such as
  `/tasks/7`. This is the regression guard for the collision described above.
- **Content type** — `PATCH` defaults to `merge-patch+json`; `patchFormat: 'json-patch'` sends
  `json-patch+json`; `POST`/`GET` send `application/json`.
- **Error adapter** — a well-formed `problem+json` body (asserting `code`, `errors[]`,
  `statusCode`, and `.status` all survive); a `problem+json` content type with a malformed
  non-JSON body; a plain-text 502 with no problem+json content type; an unreadable body. The last
  three exercise the fallback.
- **Retry/breaker semantics** — a 500 retries, a 404 does not, a 4xx does not count toward the
  breaker.
- **`resolveApiVersion`** — all four branches, including kill-switch-on-while-`hasV2Api`-true.
- **`vikunja_auth`** — `connect`/`status`/`info` report `activeApiVersion`, and report `v1` when
  the kill switch is on despite a v2-capable server.

**Live check (required).** Mocked tests provably miss this class of bug — the 0.6.1 lesson. Against
a real Vikunja 2.4.0, confirm that an actual error response round-trips through
`parseVikunjaV2Error` with its numeric `code` intact, and that a real v2 request succeeds against
the resolved base URL. A hand-written problem+json fixture is not sufficient evidence that the
adapter matches what the server actually sends.

## Acceptance criteria

- `vikunjaRestV2Request` performs authenticated v2 requests with breaker and retry protection
  equivalent to v1, under distinct breaker names.
- A `problem+json` error becomes an `MCPError` preserving the numeric code, HTTP status (both
  fields), and `errors[]` details; a non-problem+json error body degrades to the v1 message shape.
- `resolveApiVersion` returns `v2` only for a session with a cached `hasV2Api: true` and the kill
  switch off; `v1` in every other case.
- `vikunja_auth connect`/`status`/`info` report the active version, and report `v1` when the kill
  switch is set against a v2-capable server.
- `src/utils/vikunja-rest.ts` has no behavioural change — the only permitted edit is adding
  `export` to `isTransientNetworkError`; all existing tests pass untouched.
- No tool routes through v2 yet — behaviour of every existing operation is byte-identical.
- `npm run lint`, `npm run typecheck`, and `npm run test:coverage` (at the ratchet) all green,
  plus the live check above.

## Follow-on (not this spec)

P3 wires `resolveApiVersion` into individual operations, each with a v1 fallback and both paths
tested, starting with `vikunja_tasks update` and `vikunja_task_bulk bulk-update` — the two that
retire the workarounds motivating the milestone. Buckets stay on v1 permanently for now: v2 has no
`PATCH` for `/projects/{project}/views/{view}/buckets/{bucket}`.

### Response shape: question answered, and the answer is "yes" (verified live, 2026-07-27)

This spec deferred one open question to P3: whether v2 response bodies differ enough in shape to
need normalization before reaching the formatters. The live check against a real Vikunja 2.4.0
stack answered it — **they do**, and P3 cannot skip this.

`GET /api/v2/projects` returns a **pagination envelope**, where v1 returns a bare array:

```json
{
  "$schema": "http://<host>/api/v2/schemas/PaginatedProject.json",
  "items": [ { "id": 1, "title": "Inbox", ... } ],
  "total": 28, "page": 1, "per_page": 50, "total_pages": 1
}
```

Consequences for P3:

- Every **list** endpoint switched to v2 needs the envelope unwrapped (`.items`) before the result
  reaches a formatter, or the tool returns an object where callers expect an array. This is a
  caller-visible break, not a cosmetic difference.
- The envelope is also an *opportunity*: `total`/`total_pages` are data v1 never returned, and the
  hybrid-filtering and memory-protection paths currently estimate what this states outright.
- `$schema` is present on responses generally and should be stripped, not passed through.
- Single-entity responses (e.g. `GET /tasks/{id}`) were not exercised here; verify each shape
  per-endpoint rather than assuming the envelope is universal.

Two further live-verified details worth carrying forward:

- `GET /info` reports `version` as **`v2.4.0`** — with a leading `v`. Any future semver floor check
  (see the probe note below) must strip it; a naive `>=` string compare against `2.4.0` fails.
- The problem+json adapter matches real server output. A `GET /api/v2/tasks/999999999` returned
  `code: 4002` with `errors: []`, which round-tripped intact into
  `details.vikunjaError` — confirming the adapter was not built against a fictional shape.

### The v2 probe's false-positive risk (raised 2026-07-27, deliberately not addressed here)

`probeV2Api` (`src/utils/capabilities.ts`) trusts `response.ok` alone. A reverse proxy or SPA
catch-all returning `200` + `index.html` for unknown paths yields `hasV2Api: true` on a v1-only
server. That is harmless while the result only feeds a status report, but becomes load-bearing the
moment P3 routes operations on it — with the kill switch as the sole mitigation.

Decision: **left as-is for this phase**, because nothing routes on it yet. P3 must tighten it
before wiring the first operation — by checking the response content type or parsing for an
`openapi` key, and/or by adding the `serverVersion` floor check this spec originally rejected.
That original decision ("`hasV2Api` alone is sufficient, the probe is a stronger signal than a
version string") was made before the false-positive path was identified; it does not survive the
probe being trusted for routing.
