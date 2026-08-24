# Changelog

All notable changes to `vikunja-mcp-ng` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/) with
pre-1.0 semantics — see [docs/RELEASING.md](docs/RELEASING.md) for what that means in practice.

## [Unreleased]

### Added

- **One-click SSO enrollment for oidc-http mode** (#220): when the Vikunja backend uses the same
  IdP as a native OpenID login provider, `vikunja_auth provision` called **without** a token now
  returns a short-lived, single-use enrollment URL instead of an error. The new browser endpoints
  on the HTTP transport (`GET /enroll`, `GET /enroll/callback` — CSRF-protected via a
  server-side ticket bound to the initiating `iss|sub`) drive one IdP authorization hop, forward
  the code to Vikunja's native `POST /auth/openid/{provider}/callback`, mint a scoped `tk_*`
  token via `GET /routes` + `PUT /tokens` with the user's own (10-minute) Vikunja JWT, vault it
  under the identity, and discard the JWT — zero credential pasting, full per-user isolation.
  Opt-in via `VIKUNJA_MCP_ENROLL_ENABLED` (plus `VIKUNJA_MCP_ENROLL_PROVIDER`,
  `VIKUNJA_MCP_ENROLL_VIKUNJA_URL`, `VIKUNJA_MCP_ENROLL_TOKEN_EXPIRY_DAYS`,
  `VIKUNJA_MCP_ENROLL_TICKET_TTL_SEC`); manual token provisioning keeps working unchanged, and a
  backend without an OpenID provider gets a clean error pointing at the manual path. Design
  validated against the go-vikunja v2.4.0 source and proven end-to-end in the extended
  `test:e2e:oidc` lane (opt-in `docker/e2e/docker-compose.oidc.yml` overlay + a full mock OIDC
  IdP; the Vikunja-callback → JWT → token-mint → vault chain runs against the real local 2.4.0
  stack, including first-login account auto-creation). The callback **pins the enrolled account
  to the initiating identity** (`GET /user` under the fresh JWT must match the caller's
  `email`/`preferred_username` claims, failing closed — forwarded enrollment links cannot
  capture another account's token), tickets are only consumed once the code exchange succeeds,
  an already-linked identity gets "already linked" instead of a second minted token, and
  enabling enrollment hard-requires `transport=http` + `oidc` + `VIKUNJA_MCP_HTTP_PUBLIC_URL`
  (links/redirect_uri are built from the public URL, path prefixes preserved). See
  `docs/OIDC-SETUP.md` §9a.

### Security

- Refreshed the dependency tree to clear five advisories, all reached transitively through
  `@modelcontextprotocol/sdk`: `fast-uri` 3.1.4 → 3.1.5 (host confusion via backslash authority,
  high) and `hono` 4.12.32 → 4.13.1 (four advisories, the notable one being `memo()` retaining SSR
  output across requests). Neither package is called by this server on the stdio path, but both ship
  in the runtime tree, so they are worth keeping current. Dev-scope `js-yaml` moved to 4.3.1 and
  `brace-expansion` to its patched lines. `npm audit` is clean at zero, runtime and dev alike.
  The `fast-uri` and `js-yaml` overrides now name the patched floor rather than the older one they
  were pinned to, so a fresh install without the lockfile cannot silently land back on a
  vulnerable version.

### Fixed

- **Creates are no longer retried after an ambiguous failure** — a `PUT` whose response was lost
  (proxy timeout, load-balancer reset, gateway 5xx raised after the row was already persisted)
  used to be resent by the REST helper's default retry loop, silently producing a duplicate task,
  project, label, comment, or webhook. `vikunjaRestRequest` now recognizes `PUT` as Vikunja's
  create verb and gates it with `shouldRetryNonIdempotentWrite`: retries happen only for failures
  that prove nothing was created (HTTP 429 from the rate limiter, or a connection that was
  refused / never resolved / never completed its handshake). Idempotent methods (`GET`, `POST`
  updates, `DELETE`) keep the previous 5xx/429/transient-network retry behaviour unchanged, and a
  caller that knows a specific `PUT` is safe to repeat can opt back in via
  `options.retry.shouldRetry`. The hazard was flagged publicly by @safrano9999 in
  democratize-technology/vikunja-mcp#98.












## [0.7.0-beta.1] - 2026-08-14

**One-click SSO enrollment** (#220, #221): in oidc-http mode, a user whose Vikunja backend shares the MCP server's IdP no longer handles API tokens at all. `vikunja_auth provision` without a token now returns a personal enrollment link; one click walks the user's existing SSO session through Vikunja's native OpenID login, mints their API token server-side, and stores it encrypted in the vault under their identity. Manual token provisioning remains available for non-SSO backends.

### Added

- `/enroll` + `/enroll/callback` endpoints on the HTTP transport (served ahead of bearer auth; Host-allowlist enforced), backed by single-use, TTL-bound, identity-bound enrollment tickets
- New `enroll` config block (`VIKUNJA_MCP_ENROLL_*`): enabled flag, target Vikunja URL, provider key, token expiry (default 365d); `VIKUNJA_MCP_HTTP_PUBLIC_URL` is required when enrollment is enabled and the server fails loud at startup otherwise (including under stdio transport)
- Enrollment e2e lane: mock OIDC IdP + opt-in docker overlay run the full real chain against Vikunja 2.4.0 — code exchange, first-login account auto-creation, token mint, vault write

### Security

- **Enrollment is identity-pinned**: the callback verifies the IdP-authenticated browser user matches the ticket's identity (email/username claims, fail-closed) before vaulting — a forwarded enrollment link completed by another user's SSO session is refused (proven live in the e2e lane). Access tokens must carry an `email` or `preferred_username` claim for enrollment.
- Adversarial review of the feature (12 confirmed findings) fixed pre-release: deferred ticket consumption (transient upstream failures no longer burn links), `/routes` response hardening (no garbage-permission tokens), malformed-URL handling, explicit `vikunjaUrl` mismatch rejection, already-linked short-circuit (no orphaned tokens), ticket-cap ordering, and all Vikunja calls routed through the shared retry/circuit-breaker layer

### Documentation

- OIDC-SETUP §9a: validated enrollment design with the Vikunja 2.4.0 ground truth (callback semantics, redirect-URI handling, provider config as a map); CONFIGURATION.md + TOOLS.md updated

## [0.7.0-beta.0] - 2026-08-14

**Public beta of the multi-user OIDC resource-server mode.** Published on the npm `beta` dist-tag and GHCR `:beta`; `latest` stays on 0.6.2. Everything below is inert unless `VIKUNJA_MCP_TRANSPORT=http` — stdio deployments are unaffected.

### Added

- **OIDC resource-server mode over Streamable HTTP**: opt-in HTTP transport (`VIKUNJA_MCP_TRANSPORT=http`) that validates per-user OIDC access tokens (issuer/JWKS/audience/algorithms, configurable clock skew and required scope) and gives every identity its own isolated request context and session storage
- **Encrypted per-user credential vault** with `vikunja_auth` provision/deprovision: each user's Vikunja API token is stored encrypted at rest (`VIKUNJA_MCP_VAULT_PATH` / `VIKUNJA_MCP_VAULT_KEY`) and resolved per request — no shared service credential
- **MCP authorization-spec discovery (RFC 9728)**: `GET /.well-known/oauth-protected-resource` (and `/mcp` path variant), `resource_metadata` hint on 401 challenges, and optional `VIKUNJA_MCP_HTTP_PUBLIC_URL` for the canonical resource URL behind a reverse proxy — lets browser MCP clients (e.g. claude.ai custom connectors) auto-discover the IdP
- Mock-issuer OIDC e2e lane (`npm run test:e2e:oidc`) plus threat-model tests
- Local e2e harness: one persistent stack per Vikunja version with stable tokens and safe concurrent runs

### Fixed

- Per-identity credential and session-storage resolution threaded end to end (two identity-bleed risks caught by review closed before release)
- `vikunja_auth` tool description no longer claims `disconnect` is unavailable in oidc-http mode (it acts as an alias of `deprovision`)

### Documentation

- New `docs/OIDC-SETUP.md`: full install and configuration manual (any OIDC provider; Keycloak as reference), with a verification ladder and troubleshooting by symptom
- `docs/CONTEXT-FORGE.md` + `docs/OIDC-RESOURCE-SERVER.md`: deployment behind IBM MCP Context Forge and the as-shipped design reference, corrected against a live production-cluster PoC (real Keycloak + gateway, per-user isolation verified)
- README split: npm-facing README at the root, GitHub-facing one under `.github/`

### Chores

- Release pipeline is prerelease-aware (#214): `-beta.x` tags publish to the npm `beta` dist-tag, GHCR `:beta`, and a GitHub prerelease — `latest` is untouched
- Release images build arm64 on native runners (no QEMU) with idempotent, re-dispatchable publishing
- Cleared five Dependabot advisories in the transitive tree (#213); `npm audit` clean

## [0.6.2] - 2026-07-28

A correctness release, and a good argument for testing the parts of a surface you can only refuse.
Closing a long-standing coverage hole — the JWT-only tools that no test session had ever been
authenticated to reach — surfaced a real bug on the first run: **file uploads were being sent as
JSON**, so attaching a file to a task failed with an opaque server error in any session that had
already listed attachments. Also here: the version this server reports to its clients is correct
again after four minors of drift, and `setup-kanban` no longer requires a Kanban board.

Released as a patch by owner discretion despite the additive `columns` capability below, on the
same pre-1.0 basis as `0.5.2` (see [docs/RELEASING.md](docs/RELEASING.md) §3) — nothing in this
release requires a caller to change anything.

### Added

- `vikunja_projects setup-kanban` now treats `columns` as **optional** (#185). Omit it and the call
  is a plain "create a project and its tasks" composite — no Kanban view, bucket, or placement step
  runs, or is even touched, and it costs strictly fewer API calls than the board form. Supplying
  `columns` behaves exactly as before. This makes the one-call project+tasks path an honest one:
  agents were already reaching for `setup-kanban` for non-Kanban work because nothing else offered
  it. A task naming a `column` when no `columns` were given is rejected up front, before anything
  is created.

### Fixed

- **Multipart uploads were sent as JSON when a JSON call had already hit the same endpoint group**
  (#199). Circuit breakers are cached by name, and the cached breaker was returned without checking
  it wrapped the same operation — so `/tasks/{id}/attachments` (list, JSON) followed by
  `/tasks/{id}/attachments` (upload, multipart) fired the upload through the JSON helper, sending
  `Content-Type: application/json` with the form body serialised to `{}`. Vikunja rejected it as an
  opaque HTTP 500. Affected `vikunja_tasks attach` and `vikunja_users upload-avatar`; both are
  order-dependent, which is why the failure never reproduced in isolation.
- A related latent bug in the same mechanism: `withNamedRetry` registered each caller's closure
  under a shared breaker name, so a second call under that name silently re-ran the **first**
  caller's operation and returned its result. No shipped code path used those helpers, but the trap
  is now closed.
- The MCP `initialize` handshake reported version `0.3.0` (#186) — hardcoded, and stale since
  `0.4.0`. It is now derived from `package.json`, and a live check fails the build if the two ever
  drift again. `server.json`'s registry manifest is kept in sync by the release script.
- `npm run build` never cleaned `dist/` (#187), so a deleted source file left its compiled output
  behind indefinitely. Published packages were never affected (CI builds from a clean checkout);
  local installs running from `dist/` were.

### Changed

- In-range dependency refresh (#189), including `@modelcontextprotocol/sdk` 1.29.0 → 1.30.0. No
  security driver — `npm audit` was already clean. Major upgrades (`zod` 4, `typescript` 7,
  `eslint` 10, `uuid` 14) are deliberately deferred, each needing its own evaluation.

### Internal

- The MCP e2e harness now runs a **second, JWT-authenticated session** (#198) covering the tools
  that are gated off under API-token auth. Previously the entire JWT-only surface was verified only
  by confirming we correctly refuse it — one permanently skipped check and one spec-documented 401
  mislabelled as tolerated server drift. Both are now real assertions, and the full supported matrix
  (Vikunja 2.4.0 and 2.3.0 × PostgreSQL and SQLite) runs with **zero skipped checks**; the only
  remaining tolerance is an upstream server bug that exists solely below 2.4.0.
- The battle-testing sweeper now removes prefixed tasks that an agent created inside a pre-existing
  project (#188), which previously survived cleanup forever.
- Test coverage recovered on the filtering evaluators and orchestrator, and two modules that had
  been listed as untested were found to be unreachable and deleted instead (#182).

## [0.6.1] - 2026-07-25

An agent-ergonomics release built from battle-harness evidence. Setting up a Kanban board — the one
flow weaker agents still fumbled after 0.6.0 — now takes a single tool call instead of roughly
thirty-eight (measured: haiku pass-rate 2/3 → 3/3 on the `q3-offsite-kanban` scenario, zero
validation errors). Applying a label to N tasks is likewise one call instead of N. Two real bugs in
the new composite were caught by running it against a live Vikunja server rather than against mocks,
and the changelog tooling that quietly dropped a commit from every release draft is fixed.

### Added

- **Provision a whole Kanban board in one call.** `vikunja_projects` gains `setup-kanban`: it
  creates (or reuses) the project, ensures the Kanban view exists, creates the requested columns in
  order, bulk-creates the tasks, and places each one in its column — resolving view and bucket ids
  internally so the caller never juggles them. Re-running it against an existing project reuses the
  view and columns instead of duplicating them (#173, #175).
- **Apply or remove a label across many tasks at once.** `vikunja_task_labels` `apply-label` /
  `remove-label` now accept `taskIds` alongside the single-task `id`; label titles are resolved
  get-or-create *once* per call and reused across every task, with honest per-task reporting of
  partial failures (#178).
- **`id` is accepted as an alias for `parentTaskId`** on `create-subtask` and
  `bulk-create-subtasks`, matching the alias handling the project subcommands already had.
  Supplying both with conflicting values is rejected rather than silently resolved (#178).

### Fixed

- **Kanban columns came back in the wrong order.** `setup-kanban` pinned bucket positions to their
  zero-based index, but Vikunja's `position` is a non-pointer float64 — an explicit `0` is
  indistinguishable on the wire from an omitted value, so the server substituted its own id-derived
  default and the *first* requested column sorted **last**. Positions are now non-zero and
  65536-spaced, matching Vikunja's own lane spacing so callers can still slot buckets between
  columns afterwards (#177).
- **A typo'd column name no longer half-builds a board.** `setup-kanban` validates every task's
  column against the requested column list up front and rejects the call before creating anything,
  instead of creating the task and then failing to place it. Genuine partial failures now surface
  the project id in the standard extractable form, so a caller keeps the handle on a project that
  really was created (#176).
- **Changelog drafts silently dropped the oldest commit of every release.** `git log
  --pretty=format:%s` emits no trailing newline, so the generator's `while read` loop discarded its
  final line. Unclassifiable commits are now reported loudly under their own heading with a stderr
  warning, rather than vanishing (#174).

### Changed

- Battle-harness accounting made trustworthy: `optimalCallCount` re-derived for all 13 scenarios
  against the current tool surface, a `buckets-in-order` verify type added (the old verifiers
  checked bucket names and contents but never their order, which is how the ordering bug shipped),
  and `docs/BATTLE-TESTING.md` gained a testable re-baselining rule — an optimum must be reachable
  without fabricating structure the prompt never asked for, and may never be set equal to an
  observed call count without independent derivation (#179, #180).

> **On the version number.** `setup-kanban` is a new capability, which
> [docs/RELEASING.md](docs/RELEASING.md) §1 would normally make a *minor* bump. This ships as a
> patch by owner discretion — the work is scoped as the ergonomics/bugfix follow-up to 0.6.0, and
> `0.7.0` is reserved for the Vikunja v2 API migration. Nothing a caller relies on changed: every
> addition is additive and the single-task/`parentTaskId` forms behave exactly as before. Same
> latitude as the [0.5.2](#052---2026-07-22) exception.

## [0.6.0] - 2026-07-24

A reliability and agent-ergonomics milestone on the Vikunja 2.4.0-aligned baseline (minimum
supported 2.3.0). Two silent-failure bugs that could bite *any* client are fixed — a circuit-breaker
cascade that let one bad request poison an entire session, and date-only due dates being silently
lost — alongside a batch of changes that make weaker AI agents far more reliable against the tool
surface (measured: haiku scenario pass-rate 7/15 → 14/15). **Breaking:** the minimum Node.js is now
22 LTS.

### Added

- **Attach labels by name in one call.** `vikunja_task_labels` `apply-label` now accepts
  `labelTitles` — labels are get-or-created and attached in a single call instead of the old
  list → match → create dance. Backed by a new `ensure` subcommand on `vikunja_labels`
  (idempotent get-or-create by title) and a shared `ensureLabelByTitle` helper (#159, #162).
- **Per-session API-version / capability detection.** `vikunja_auth` `status`/`info` now report the
  connected server version and whether the Vikunja v2 API is available, cached per session. No
  behavior change yet — it's the seam the upcoming v2 fast-paths will consult (#149).
- **Multi-architecture Docker images** — releases now publish `linux/amd64` *and* `linux/arm64`
  (Apple Silicon, ARM servers), with SLSA build provenance (#146).

### Changed

- **BREAKING — minimum Node.js is now 22 LTS** (was 20). Node 20 is no longer supported (#152).
- **Clearer Kanban/bucket guidance.** Argument descriptions and error messages across
  `vikunja_tasks` and `vikunja_projects` bucket operations now state exactly which id each expects
  (project `id` vs `viewId` vs `bucketId`) and how to obtain it — cutting the validation errors
  weaker agents hit (#161).
- **Filter discoverability.** The `vikunja_tasks` `filter` parameter and `vikunja_filters` gained
  copy-pasteable syntax examples (operators, `&&`/`||`, date literals) (#158).

### Fixed

- **Circuit-breaker cascade (reliability).** A single client-side `4xx` (e.g. a malformed
  bulk-create) no longer trips the circuit breaker. Previously one bad request opened the breaker
  and *every* subsequent write failed with "Breaker is open" for the rest of the session; the
  open-circuit message is also reworded so callers know it's a transient condition to retry, not an
  auth failure to reconnect through (#163).
- **Silent date data-loss.** Date-only due / start / end dates (`YYYY-MM-DD`) were rejected by
  Vikunja (which requires RFC3339) and silently lost. They are now coerced to RFC3339 across
  single-create, bulk-create, and bulk-update; bulk-create additionally now forwards
  `startDate`/`endDate` at all (they were previously dropped entirely) (#164, #167, #168). This was
  also a root trigger of the circuit-breaker cascade above.
- **403 misclassification.** Removing a label that isn't attached (or an absent assignee) returns
  Vikunja's `403`, which was misread as an auth error and retried 3× with a misleading message.
  These paths now reconcile against actual state and report an accurate, idempotent outcome (#154,
  #155, #157).

### Security

- `@hono/node-server` overridden to `^2.0.5` — clears GHSA-frvp-7c67-39w9 (#153).
- `fast-uri` bumped to `3.1.4` — clears GHSA-v2hh-gcrm-f6hx (#151). `npm audit` reports zero
  vulnerabilities.

### Internal

- Vendored the Vikunja **v2 OpenAPI spec** and generated types — preparation for the v2 API
  migration (0.7.0); not wired into runtime yet (#147).
- Battle-testing: added `bulk-set-bucket` / `bulk-create-subtasks` scenarios and fixed the
  kanban bucket-count verification (read from the view's tasks endpoint) (#148, #150); locked in
  subresource 4xx-not-retried / 5xx-retried behavior with tests (#156).
- Release notes now link npm + GHCR package pages; documented the post-1.0 maintenance-branch
  policy (#145, #144).

## [0.5.2] - 2026-07-22

A maintenance patch: sharing and filter bug fixes, a dependency security bump, and the
under-the-hood groundwork for Vikunja 2.4.0. The announced, hardened *"optimised for Vikunja 2.4"*
alignment shipped as **[0.6.0](#060---2026-07-24)** (a reliability and agent-ergonomics
milestone) — this release only laid the groundwork and did not yet claim it. (v2 API fast-paths
turned out not to be part of 0.6.0 either — 0.6.0 only vendored the v2 spec/types; the actual
migration is tracked for a later release, see 0.6.0's Internal notes.)

### Added

- **Bucket position** — `vikunja_projects` create-bucket / update-bucket now accept an optional
  `position` argument to control kanban bucket ordering. Contributed by @angusmaul (#122).

### Changed

- **Vikunja 2.4.0 groundwork.** The e2e/version-matrix default pin moved `2.3.0` → `2.4.0`, the
  vendored OpenAPI spec was refreshed directly from the pinned 2.4.0 container and types
  regenerated (the only surface change: five creation endpoints corrected `200` → `201`), and the
  known `GET /tasks/{id}/assignees` server-drift tolerance is now version-gated — a hard failure on
  2.4.0+, where the upstream 500 is fixed. Minimum supported Vikunja remains **2.3.0**.

### Fixed

- **Sharing:** creating a link share now rejects a `name`/`title` mix-up instead of silently
  producing an unnamed share, and a `GET`-by-id on a just-created share no longer 404s (worked
  around an upstream link-share hash-vs-id bug by routing through the list endpoint) (#133).
- **Filters:** raw filter strings are now always re-serialized through the server-boundary field
  translation, so client-facing field names round-trip correctly instead of being rejected by the
  server's parser (#129).

### Removed

- Dropped the unused `better-sqlite3` dependency (declared but never imported).

### Security

- Overrode transitive `js-yaml` to `>=4.2.1`, clearing GHSA-52cp-r559-cp3m (a dev-scope
  quadratic-CPU advisory). `npm audit` reports zero vulnerabilities.

### Internal

- Docs: ground-up rewrite of `RELEASING.md` (including the mandatory pre-tag checklist) and a full
  audit refresh of `ROADMAP.md`; 2.4.0 API-coverage re-audit (no new endpoint surface); OIDC
  resource-server design doc added for a future OIDC mode.
- Test/CI: fixed the `spyOn`/`mockRestore` root cause and silenced localStorage teardown noise;
  bumped the release-workflow actions to current majors.

## [0.5.1] - 2026-07-20

First release published via npm Trusted Publishing (OIDC) from the tag-triggered GitHub Actions workflow — no tokens, with provenance attestation. Docker images now also publish to ghcr.io automatically.

### Fixed

- Bulk-create now serializes its task-creation writes. On SQLite-backed Vikunja, 8 concurrent creates triggered "database is locked" 500s whose retries amplified the contention and tripped the circuit breaker — turning a lock storm into a full endpoint outage (live repro: 2/12, 0/12, 0/12 created across three 12-task calls). Contributed by @angusmaul (#116), independently verified (#119) and live-proven on a real SQLite stack before merge

### Added

- SQLite variant for the local e2e stack (`VIKUNJA_DB=postgres|sqlite`), a DB dimension in the version matrix, and a SQLite-sensitive 12-task bulk-create stress check — the class of bug #116 exposed can no longer hide behind our Postgres-only test stack (#120)

### Chores

- Tag-triggered release workflow installed with OIDC Trusted Publishing; inherited never-run CI workflows removed — exactly one workflow, running only on version tags (#123)

## [0.5.0] - 2026-07-19

The agent-ergonomics release. A full battle-testing campaign (8 scenarios, REST-verified, run against a real local Vikunja) measured where AI agents actually struggle with the tool surface — every change in this release is backed by that evidence, and two changes we *thought* we needed were dropped because the evidence said otherwise.

### Added

- `bulk-set-bucket` (on `vikunja_tasks` and `vikunja_task_bulk`): distribute many tasks across Kanban buckets with one call — view/bucket resolution happens once, writes are sequential with honest per-task failure reporting (#114)
- `bulk-create-subtasks` on `vikunja_tasks`: create and relate multiple subtasks under a parent in one call, saga-compensated per subtask (#114)
- Battle harness: two new scenarios (existing-label reuse, project-rename-share probe) and a broadened validation-error classifier built from real campaign transcripts (#111)

### Fixed

- `vikunja_tasks update` no longer silently drops `bucketId` — it now routes through the shared bucket-placement logic and reports `bucketId` in `affectedFields` only when actually applied. This was the top friction in the campaign: agents lost their Kanban placement and burned 40% extra calls recovering (#112)
- `vikunja_filters build` now emits filter strings in the same camelCase the filter validator accepts (it previously emitted server-side snake_case, actively steering agents into validation errors); filter fields also accept snake_case aliases (`due_date`, `percent_done`, …) with normalization (#113)
- `vikunja_projects` id-domain subcommands (list-buckets, views, duplicate, backgrounds, …) accept `projectId` as an alias for `id` — the campaign showed agents reach for `projectId` first (#112)
- Residual API-coverage issues closed: batch-import no longer fires an empty user search; project-hierarchy fetches paginate honestly instead of a 1000-item cap; share listing accepts a search param; webhooks and user-search accept pagination params; export avoids a recursive refetch (6 fixed, 1 verified already-fixed) (#115)

### Chores

- Coverage ratchet raised to 89/89/80/78 (statements/lines/branches/functions)

## [0.4.1] - 2026-07-18

README-only patch so the npm package page reflects the published state: adds the "From npm" Quick Start (`npx -y vikunja-mcp-ng`), the npm version badge, and the post-rename repository links. No code changes.

## [0.4.0] - 2026-07-18

A capability batch: 20 newly implemented API operations (API coverage now 123/169, 73%), a native single-request bulk-update, and two new local test harnesses. No breaking changes; four new tool surfaces are disabled by default and opt-in via module config.

### Added

- `vikunja_caldav_tokens` tool (list/create/delete) behind a new deny-by-default `caldavTokens` module key, and a `vikunja_user_export_status` tool completing the user-export request/status/download trio (#98)
- `vikunja_users` avatar subcommands: `get-avatar`, `set-avatar` (provider validated against the server's accepted values), `upload-avatar` (multipart) (#99)
- `vikunja_user_deletion` tool (request/confirm/cancel) wired to the reserved deny-by-default `userDeletion` module key, with explicit `confirm: true` gates and secret masking (#100)
- `vikunja_webhooks` account-wide `scope: 'user'` covering `/user/settings/webhooks*` — list/create/update/delete/list-events (#101)
- `vikunja_projects` opt-in cosmetic backgrounds module (`remove-background`, `set-unsplash-background`, `search-unsplash`) behind a new default-off `backgrounds` key (#102)
- `vikunja_tasks` `duplicate` and `mark-read` subcommands (#103)
- Agent battle-testing harness: `npm run battle` spawns a headless AI agent against the tool surface and grades correctness (direct REST verification) and ergonomics (transcript friction metrics) (#96)
- Version-matrix e2e testing: `VIKUNJA_VERSION`-parameterized local stack and one-command `npm run test:matrix` verdict runner (#94)

### Fixed

- Bulk-update now uses Vikunja's native `POST /tasks/bulk` `{task_ids, fields, values}` contract — one request instead of N concurrent per-task writes, eliminating silent task loss under SQLite lock contention; per-task merge kept as fallback. Contributed by @angusmaul (#89), with follow-ups for server-derived success counts, surfaced assignee-restore failures (#95), and a single bulk-replace assignee restore per task (#103)
- Concurrent per-user assignee write loops serialized across six call sites (same SQLite lock-contention class); task-listing `sort` fields now validated against an allowlist with camelCase normalization instead of being silently ignored (#97)
- MCP e2e harness absence checks now model MCP SDK >=1.22 `{isError: true}` results instead of expecting thrown errors

### Documentation

- README factual pass: tool count corrected to 27, unshipped claims removed, safety wording aligned with actual behavior (#104)
- Endpoint-tail re-triage of all 64 not-implemented operations under the direct-REST architecture: 20 IMPLEMENT / 36 PARKED / 8 NEVER, with per-op rationale (#93)
- API coverage recounted after the endpoint-tail wave: 123 implemented / 44 not implemented; server-behavior notes replaced with Go-source-verified mechanisms

### Chores

- Coverage ratchet raised to 89/89/80/77 (statements/lines/branches/functions)

## [0.3.1] - 2026-07-18

A small patch release: a response-formatting bugfix plus the release engineering machinery
this very release was cut with, and two late chores/docs polish items. No tool signatures or
config shapes changed. Aligned to Vikunja 2.3.0 (unchanged from 0.3.0).

### Added

- Release engineering machinery: SemVer policy documentation, a Keep a Changelog
  `CHANGELOG.md`, and three dependency-free scripts (`release-prepare`/`release-tag`/
  `release-publish`) implementing the checklist in `docs/RELEASING.md`. A tag-triggered GitHub
  Actions publish workflow ships as an example file only
  (`docs/github-workflow-release.yml.example`), pending the owner's decision to enable Actions
  repo-wide (#88).
- Docker images now carry a Vikunja compatibility tag derived from the vendored OpenAPI spec's
  version, plus matching OCI labels (`org.opencontainers.image.version`, `io.vikunja.compat`),
  so a deployer can pick an image aligned to their Vikunja server version (#88).

### Fixed

- List responses no longer silently render an empty body for collections over 10 items — the
  hidden cutoff in `formatSuccessMessage` is replaced with a token-safe 50-item render cap, with
  an explicit "Showing 50 of N" notice beyond that (#85, via #87).
- List rendering no longer alternates between a rich heading layout and a plain line depending on
  item shape, which produced broken-looking interleaved lists — all list items now render
  consistently as numbered lines with sub-bullet detail; single-item ("get") responses keep their
  heading layout (#86, via #87).

### Documentation

- Rewrote README as a minimal landing page (pitch, badges, fork notice, one hero example, quick
  start, capabilities table), leaning on `docs/TOOLS.md` and `docs/samples/` for depth. From-source
  install is now primary; the npm package name isn't secured yet and isn't advertised (#90).

### Chores

- Revised the Docker Vikunja-compatibility tag introduced in #88 from a standalone floating
  `vikunja-<ver>` tag to a per-release suffix on our own version (`X.Y.Z-vikunja<A.B.C>`,
  `node:20-alpine`-style), eliminating the version-number ambiguity of the earlier scheme (#91).

## [0.3.0] - 2026-07-18

This release is the fork's coming-out story: `netadvanced/vikunja-mcp` started from
`democratize-technology/vikunja-mcp` at `0.2.2` with a failing test suite and a set of confirmed
API-contract bugs, and became `vikunja-mcp-ng` — a direct-REST, composite-first, Docker-distributed
MCP server with roughly triple the capability surface it started with. **Aligned to Vikunja
2.3.0** (see [docs/RELEASING.md](docs/RELEASING.md) "Vikunja compatibility" for what that means
and how it's tracked). See [docs/ROADMAP.md](docs/ROADMAP.md) for the full wave-by-wave account
this entry summarizes.

### Added

- Real saved filters, project sharing (link shares plus direct user/team sharing), project
  views/Kanban bucket CRUD, and project duplication (#55, #57, #58, #59).
- Notifications, subscriptions, and reactions tools (#56).
- Task extras: direct `GET /tasks` as the primary listing strategy, position/by-index access, and
  subtask composites (#64, #77).
- Attachments (read-side), API tokens, admin operations, and server info tools (#62, #63).
- A local Docker e2e stack and an MCP-layer end-to-end harness that drives the real stdio server
  via the SDK client and asserts on the wire protocol (#65, #67).
- Opt-in JSON file persistence for `vikunja_templates`, configurable via `templates.persistPath` /
  `VIKUNJA_MCP_TEMPLATES_FILE` (#78).
- Global read-only / write-off-by-default mode, layered on top of per-module config gating (#81).
- MCP tool annotations (`readOnlyHint` / `destructiveHint` / `idempotentHint`) so capable hosts can
  auto-approve reads and gate destructive calls (#81).
- Docker distribution: multi-stage `Dockerfile`, compose example, `docs/DOCKER-DESKTOP-MCP.md`.
- `docs/ENDPOINT-PLAYBOOK.md`, `docs/ROADMAP.md`, and a scenario-driven README with a
  `docs/samples/` walkthrough page per scenario.

### Changed

- **Renamed the project and package to `vikunja-mcp-ng`** — package name, bin name, MCP server
  identity, and `server.json` all updated (#74).
- All HTTP now goes through a single REST helper (`vikunjaRestRequest`) on TypeScript types
  generated from a vendored OpenAPI spec (`docs/vikunja-openapi.json`), with `opossum`-backed retry
  and named circuit breakers (#49, #52).
- Introduced layered module configuration (defaults → `vikunja-mcp.config.json` → env, env wins)
  with deny-by-default gating for dangerous modules (admin, user deletion, token management), plus
  `*_FILE` env-var variants for Docker Swarm / Kubernetes secrets (#51).
- Added `CompositeOperation`, an opt-in best-effort saga helper with compensations and trace
  reporting for multi-call composite tools (#50).
- Coverage thresholds ratcheted upward four times in step with real, measured coverage growth
  (#48, #60, #66, #82).

### Fixed

- Test suite repaired from 190 failing tests to fully green (#31–#46), then held there through
  every subsequent wave — 130 suites / 2,900 tests / 0 failing as of this release.
- 16 confirmed API-contract bugs, including: team management being entirely non-functional (5
  bugs), project *move* silently wiping unrelated fields, share creation sending field names the
  API ignored, reminder removal that could never succeed, relation counts always reading zero, and
  user settings read from the wrong response nesting level (#31–#41).
- Two security-validation regressions caught in the same audit sweep (#31–#41).

### Removed

- **`node-vikunja` dependency removed entirely.** The client library this project originally
  depended on was frozen upstream (last release May 2025) with confirmed drift from the live API.
  Migrated per-domain across Wave D (tasks core, task sub-resources, projects/labels/teams/users,
  composites) and dropped from `package.json` in the final removal PR (#73). Verified zero-hit via
  `grep -rn node-vikunja src/ package.json package-lock.json`.

## [0.2.2] - fork point

Fork point from [`democratize-technology/vikunja-mcp`](https://github.com/democratize-technology/vikunja-mcp)
at `0.2.2`. Everything above `[0.3.0]` in this file describes work done on the fork
(`netadvanced/vikunja-mcp`, now `vikunja-mcp-ng`); history prior to the fork point lives in the
upstream project.

<!--
v0.3.0 predates this fork's first `v*` tag (v0.3.1), so it has no tag to compare from and keeps
a commits/main link. From v0.3.1 onward, releases are tagged and use standard
compare-between-tags links.
-->
[Unreleased]: https://github.com/netadvanced/vikunja-mcp-ng/compare/v0.3.1...main
[0.3.1]: https://github.com/netadvanced/vikunja-mcp-ng/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/netadvanced/vikunja-mcp-ng/commits/main/
[0.2.2]: https://github.com/democratize-technology/vikunja-mcp/releases/tag/0.2.2
