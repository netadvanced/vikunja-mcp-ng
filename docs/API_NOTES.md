# Vikunja API Implementation Notes

Implementation details and API quirks discovered while building and testing
against real Vikunja servers — the "why it's written that way" companion to
[docs/API-COVERAGE.md](API-COVERAGE.md)'s per-endpoint status. Read this before
touching endpoint code; the procedure itself is in
[docs/ENDPOINT-PLAYBOOK.md](ENDPOINT-PLAYBOOK.md).

## Known API Issues

### User Endpoint Authentication

The `/user` endpoint fails with authentication errors despite using a token that works for every other endpoint.

**Symptoms:**
- Error: "missing, malformed, expired or otherwise invalid token provided"
- Occurs only on user-scoped endpoints (`/user`, `/users`, `/user/settings`, …)
- The same token works for projects, tasks, teams, and the rest

**Root cause:** user-scoped endpoints accept JWT session tokens, not `tk_*`
API tokens — see [docs/VIKUNJA_API_ISSUES.md](VIKUNJA_API_ISSUES.md) #2 for the
full write-up. It is not a per-instance misconfiguration or a server bug to
report to the operator.

**Current workaround:**
- Connect with a JWT (`eyJ…`) instead of a `tk_*` token; `vikunja_auth connect`
  auto-detects the token type and registers the JWT-only tools accordingly
- The MCP server detects a 401/403 on these endpoints structurally
  (`details.statusCode` in `src/tools/users.ts`) and returns an actionable
  "reconnect with a JWT" message rather than a raw API error

## API Quirks and Gotchas

### Task Object Properties

1. **`project_id` (wire) vs `projectId` (tool argument)**: the API itself is
   snake_case only — `models.Task` in the vendored spec
   (`docs/vikunja-openapi.json`) has `project_id` and **no** `projectId`
   property, in either direction. The camelCase `projectId` you see in this
   server is purely the MCP tool-argument name (`src/tools/tasks/index.ts`),
   mapped to the wire field where it has to be (`SORT_FIELD_ALIASES` in
   `src/tools/tasks/constants.ts`, `FILTER_FIELD_TO_API_FIELD` in
   `src/utils/filters.ts`). The older claim that "the API returns both for
   backwards compatibility" came from the removed `node-vikunja` client's own
   types and was never true of the server: always read `project_id` off a
   response.

2. **Priority Range**: Tasks support priority values from 0-5 (inclusive)
   - Not 0-10 as might be expected
   - 0 = lowest priority
   - 5 = highest priority

3. **Recurring Tasks**: Tasks can repeat at regular intervals
   - **API Implementation**: 
     - `repeat_after`: Time in seconds between repetitions (0 = no repeat)
     - `repeat_mode`: Integer enum (0 = default, 1 = monthly, 2 = from current date)
   - **MCP Server Interface**: For ease of use, the MCP server accepts:
     - `repeatAfter`: Number of units (days, weeks, months, years)
     - `repeatMode`: String literals ("day", "week", "month", "year")
     - The server automatically converts these to the correct API format
   - When a recurring task is marked done, Vikunja automatically creates the next occurrence
   - Example: `repeatAfter: 7, repeatMode: "day"` = weekly task (converted to `repeat_after: 604800, repeat_mode: 0`)

### Date Handling

- All date fields must be valid ISO 8601 format
- Example: `2024-05-24T10:00:00Z`
- Invalid dates will cause validation errors
- Timezone information is preserved

### ID Validation

- All IDs must be positive integers
- Zero or negative values are rejected

### Project Operations

1. **Full-Model-Replace Update Endpoint**: `POST /projects/{id}` replaces the
   entire project — any field omitted from the request body is cleared
   server-side. `updateProject`, `archiveProject`, `unarchiveProject`, and
   `moveProject` all build their payload by merging the desired changes onto
   the *current* project (fetched first) via `buildProjectUpdatePayload`
   rather than sending a bare partial object. `moveProject` is the one
   exception to "merge preserves untouched fields": an omitted
   `parentProjectId` means *move to root*, so `parent_project_id` is always
   set explicitly (to the new parent, or `0` for root) rather than left
   untouched like the other fields.

2. **List Pagination Has No Total Count**: `GET /projects` returns a bare
   array (`models.Project[]` in the vendored spec) — there is no
   `{data, total}` envelope on the v1 API. Total item and page counts are not
   knowable from the response body, so `vikunja_projects list` reports
   `hasMore` (derived from whether a full page came back) instead of a
   fabricated `totalPages`/`totalItems`. (Vikunja's **v2** list endpoints do
   wrap results in `{items, total, ...}`, but no call site routes to `/api/v2`
   — see "Session Capability Detection" below.)

3. **Kanban "Done" Bucket**: `models.Bucket` has no `is_done_bucket` field —
   the done bucket is designated by `done_bucket_id` on the `ProjectView`
   (`GET /projects/{id}/views`), not on the bucket itself. `list-buckets`
   resolves `isDoneBucket` by comparing each bucket's id against the
   Kanban view's `done_bucket_id`. When an explicit `viewId` is passed
   (skipping view auto-resolution), that view's `done_bucket_id` isn't
   fetched — `isDoneBucket` falls back to `false` in that case rather than
   spending an extra request on it.

4. **`id` vs `projectId` on `vikunja_projects`**: the flat args schema has
   both `id` (used by CRUD/hierarchy/Kanban-bucket/view/duplicate/backgrounds
   subcommands) and `projectId` (used by the sharing-domain subcommands —
   `create-share`, `share-with-user`, `list-project-users`, etc.) as sibling
   fields, which is a first-guess footgun: an agent reaching for `projectId`
   on e.g. `list-buckets` gets `Project ID is required`. `registerProjectsTool`
   (`src/tools/projects/index.ts`) now accepts `projectId` as an alias for
   `id` on every subcommand in the `id`-domain group (`PROJECT_ID_ALIAS_SUBCOMMANDS`),
   applied once up front before the switch dispatch; an explicit `id` always
   wins when both are supplied. The sharing-domain subcommands are
   deliberately excluded from this alias — they already use `projectId` for
   this purpose.

### Project Sharing

Project sharing allows creating public or private links to share projects with external users.

1. **Share Properties (request body, `POST /projects/{id}/shares`)**:
   - `permission`: Permission level (0=Read, 1=Write, 2=Admin) — the tool-level
     `right` argument (`'read'|'write'|'admin'|0|1|2`) is mapped to this field
   - `password`: Optional password protection
   - `name`: User-defined label for managing shares — the tool-level argument
     is also called `name` (not `label`)
   - `project_id` is taken from the URL path, not the body
   - There is **no** `expires`, `password_enabled`, or `shares` field on
     `models.LinkSharing` — the removed `node-vikunja` client's bundled type
     included them, but the real API (and the tool's `CreateShareRequest`)
     does not. `expires`
     as a per-share expiration and `shares` as a share count are not
     supported by the API at all. Whether a share is password-protected
     (`sharing_type`) is derived server-side from whether `password` was set.
   - `hash`: Unique identifier for the share link (response-only)
   - `sharing_url`: Full URL for accessing the share (server-generated,
     response-only)

2. **Share Authentication**:
   - Public shares can be accessed without authentication
   - Password-protected shares require calling `auth-share` first
   - Authentication returns a token for accessing the shared project
   - The token should be used for subsequent API calls to the shared project

3. **Limitations**:
   - No update method for shares - must delete and recreate to modify
   - Passwords cannot be retrieved after creation
   - Share permissions are fixed at creation time

### Project Views

1. **Full-Model-Replace Update Endpoint**: `POST /projects/{project}/views/{id}`
   replaces the entire `models.ProjectView`, the same convention as the
   project update endpoint (see "Project Operations" above). `update-view`
   and the `set-done-bucket` composite both fetch the current view first and
   merge requested changes onto it (`buildViewUpdatePayload` in
   `src/tools/projects/views.ts`) rather than sending a bare partial object.

2. **Setting the Done Bucket**: `models.Bucket` has no `is_done_bucket`
   field — the done bucket is `done_bucket_id` on the `ProjectView`
   (see "Kanban 'Done' Bucket" above, which covers *reading* it via
   `list-buckets`). `set-done-bucket` is the only way to *set* it: resolve
   the Kanban view (auto-resolved from the project, or an explicit
   `viewId`), fetch-merge-POST the `done_bucket_id` change, then verify the
   response actually reflects the requested bucket before reporting
   success — a mismatch (e.g. a stale `updated` snapshot on a concurrently
   edited view) raises an `API_ERROR` rather than silently claiming success.

3. **Per-View Task Listing Shape**: `GET /projects/{id}/views/{view}/tasks`
   (`list-view-tasks`) declares a flat `models.Task[]` response schema for
   every view kind, but the endpoint's own spec description says a Kanban
   view instead returns "a list of buckets containing the tasks" — i.e. the
   real response for a Kanban view is bucket-shaped (each item carrying a
   nested `tasks` array), not task-shaped. This can't be confirmed against
   a live server from spec text alone, so `list-view-tasks` passes the
   response through unmodified rather than guessing a shape and silently
   coercing it — callers should check for a `tasks` field on each returned
   item to tell which shape they got back.

### Kanban Buckets

1. **Full-Model-Replace Update Endpoint**: `POST
   /projects/{projectID}/views/{view}/buckets/{bucketID}` replaces the
   entire `models.Bucket` (title has `minLength: 1` in the spec — an empty
   body would be rejected). `update-bucket` fetches the bucket list first
   (which doubles as `bucketTitle` resolution, see below) and merges
   requested changes onto the matched bucket before POSTing.

2. **Resolve-by-Title**: `update-bucket` and `delete-bucket` accept either a
   numeric `bucketId` or a `bucketTitle` string — the same
   resolve-by-name-internally shape as `setTaskBucket`
   (`src/tools/tasks/buckets.ts`). `bucketId` wins when both are supplied.
   Resolution failure (no bucket with that id/title in the view) raises
   `NOT_FOUND`, not a generic validation error.

3. **`limit` Can Legitimately Be `0`**: Unlike most numeric ids in this
   codebase, a bucket's `limit` field means "unlimited" at `0`, so bucket
   create/update validate it as a non-negative integer rather than using
   the shared `validateId` helper (which rejects `0`).

4. **`vikunja_tasks update`'s `bucketId` Is Not a `models.Task` Field**:
   moving a task into a bucket is a dedicated action endpoint (`POST
   /projects/{project}/views/{view}/buckets/{bucket}/tasks`), not a field on
   the full-model task update payload — `models.Task.bucket_id` exists in the
   spec but is documented as populated only "when the task is accessed via a
   view with buckets", so it can't be diffed the way `due_date`/`priority`
   are. `TaskUpdateService.updateTask` therefore calls the shared
   `moveTaskToBucket` helper (`src/tools/tasks/buckets.ts`, factored out of
   `setTaskBucket`) as a side effect after the core POST, rather than folding
   `bucket_id` into `buildUpdateData`'s merge. It runs after any same-call
   `projectId` move, so bucket resolution (when `projectId`/`viewId` are
   omitted) sees the task's new project, not its old one. `bucketId` is
   reported in `affectedFields` unconditionally like `labels`/`assignees` —
   if the move itself fails, the whole `update` call throws before that
   response is ever returned, so the field list stays honest. Before this
   fix, `update`'s schema accepted `bucketId` but nothing read it, so it was
   silently dropped (battle-tested friction — see tracking issue #28, item
   E1).

### Team Operations

1. **Full-Model-Replace Update Endpoint, With a Bool-Specific Trap**: `POST
   /teams/{id}` follows the same full-model-replace convention as projects,
   views, and buckets above, but is more dangerous: go-vikunja writes
   `is_public` with xorm's `UseBool`, which forces that one column to be
   written even when `false` — bypassing the zero-value skip that made
   omitting other fields (like `description`) look harmless. An update that
   omitted `is_public` therefore silently un-published a public team.
   `vikunja_teams update` fetches the team first and merges requested
   changes onto it via `buildTeamUpdatePayload` (`src/tools/teams.ts`), the
   same fetch-merge-POST shape `buildProjectUpdatePayload` uses for projects.
   Full write-up, verified against the go-vikunja source, is in
   [docs/VIKUNJA_API_ISSUES.md](VIKUNJA_API_ISSUES.md) §3a — including the
   generalized "watch for `UseBool` on any full-replace endpoint" lesson, and
   why team **membership** writes (add/remove/admin-toggle) are a different,
   unaffected shape and should not be "fixed" the same way.

2. **Member Addressing Is By Username, Not Id**: the vendored spec annotates
   the admin-toggle route's path segment as `@Param userID path int true "User
   ID"`, but the actual go-vikunja route binds that segment to the member's
   *username* (`TeamMember.Username` carries a `param:"user"` struct tag) —
   see [docs/VIKUNJA_API_ISSUES.md](VIKUNJA_API_ISSUES.md) #3 for the route
   registration and struct-tag citations. The general rule this establishes:
   **when the vendored OpenAPI spec and the Go handler disagree, the handler
   wins** — verify against the handler source, not the spec text.

## Operation Patterns

### Assignee Management

The update operation uses diff-based logic for efficiency:
1. Get current assignees
2. Calculate additions and removals
3. Remove users no longer assigned — one `DELETE /tasks/{taskID}/assignees/{userID}` each
4. Add new users — one `PUT /tasks/{taskID}/assignees` (body `{user_id}`) each

This minimizes work compared to replacing the whole list. Note the adds are
deliberately **not** batched through `POST /tasks/{taskID}/assignees/bulk`:
that endpoint has *replace* semantics and would silently unassign everyone
else (upstream issue #15). Both loops run sequentially on purpose
(`src/tools/tasks/assignees/AssigneeOperationsService.ts`). The one place the
bulk endpoint *is* used is restoring a complete assignee snapshot after a
`POST /tasks/bulk` update, where replacing the whole list is exactly the intent.

### Multi-Step Operations

**Warning**: Operations are not atomic. For example, when creating a task with labels:
1. Task is created first
2. Labels are assigned in a separate call
3. If label assignment fails, the task already exists

This creates a race condition in task creation.

### Create Retries and Idempotency

Vikunja's v1 API inverts the verbs most REST APIs use: `PUT` is the **create**
verb and `POST` is the **update** verb (see "Full-Model-Replace Update
Endpoint" under "Project Operations" above for the update side). That
inversion matters beyond naming: it means the HTTP method alone tells
`vikunjaRestRequest` whether a write is safe to retry. A 5xx response, or a
connection reset mid-flight, does not prove a create failed — the row may
already be persisted server-side with only the response lost — so blindly
retrying it would silently create a duplicate task/project/label/comment.
`shouldRetryNonIdempotentWrite` (`src/utils/vikunja-rest.ts`) therefore
retries a `PUT` only on HTTP 429 or a connection failure that *proves* the
request bytes never reached the server (refused / unresolved / handshake
timeout); every other method keeps the standard 5xx/429/transient-network
retry policy. The full rationale, the retry-preset table, and the "revisit if
Vikunja ever gains an idempotency key" escape hatch live in
[docs/ARCHITECTURE.md](ARCHITECTURE.md)'s "Retry Logic" section — this entry
exists mainly so the create/update verb inversion sits next to this file's
other verb- and field-mapping notes.

## MCP-Specific Limitations

1. **File Attachments — upload works, download can't return bytes**:
   - **Uploading is implemented.** `vikunja_tasks attach`
     (`src/tools/tasks/attach.ts`) posts `multipart/form-data` to
     `PUT /tasks/{id}/attachments` via `vikunjaRestMultipartRequest`, taking
     either a server-readable `filePath` or base64 `fileContent`.
     `list-attachments`, `get-attachment-info` and `delete-attachment`
     (`src/tools/tasks/attachments.ts`) are implemented too.
   - **Downloading the bytes is not, and won't be.** MCP has no binary/file
     delivery channel, so `download-attachment` returns the direct download
     URL plus the auth header the caller needs to fetch it themselves —
     the same honest shape as `vikunja_download_user_export`. The same
     limitation is why avatar/background *image* endpoints stay parked
     ([docs/ENDPOINT-TAIL-RETRIAGE.md](ENDPOINT-TAIL-RETRIAGE.md)).
   - Historical note: this section previously claimed `attach` returned
     `NOT_IMPLEMENTED`. It hasn't since the multipart upload path landed;
     `ErrorCode.NOT_IMPLEMENTED` now appears at exactly one site in `src/`
     (an unknown-action guard in `src/tools/filters.ts`).

2. **Response Format Inconsistency**: Different operations return data in slightly different formats
   - Largely addressed by the shared AORP response factory
     (`src/utils/response-factory.ts`, `createStandardResponse`), which newer
     surfaces go through; older handlers still hand-build their payloads.

## Error Handling Patterns

### Error Types

- `AUTH_REQUIRED`: User needs to authenticate first
- `VALIDATION_ERROR`: Input validation failed
- `API_ERROR`: Vikunja API returned an error
- `NOT_IMPLEMENTED`: Feature not available in MCP context
- `INTERNAL_ERROR`: Unexpected errors

### Network Errors

- Rate limiting returns status 429
- Connection errors have code ECONNREFUSED
- Always wrap in meaningful error messages

## Testing Discoveries

1. **Mock Isolation**: all HTTP goes through `vikunjaRestRequest` /
   `vikunjaRestMultipartRequest` (`src/utils/vikunja-rest.ts`), so that module
   is what tests mock. No test mocks `node-vikunja` any more — the dependency
   is gone from `package.json`; the remaining mentions in `tests/` are
   migration comments only.
2. **Type Safety**: some tests use `any` for mocks; typed mocks derived from
   `src/types/generated/vikunja-openapi.d.ts` are preferred for new tests
3. **Edge Cases**: Empty arrays and undefined fields must be handled gracefully

## Bulk Operations

### Performance Characteristics

1. **Bulk Create**: Creates multiple tasks in a single project
   - Maximum: 100 tasks per operation (enforced)
   - Creates tasks sequentially (not parallel)
   - Handles partial failures gracefully
   - Automatic cleanup if label/assignee assignment fails

2. **Bulk Update**: Updates the same field across multiple tasks
   - **Scalar fields go through Vikunja's native `POST /tasks/bulk`**
     (`models.BulkTask` — `{task_ids, fields, values}`) as **one** request
     (landed in PR #89). Allowlist: `done`, `priority`, `due_date`,
     `start_date`, `end_date`, `project_id`, `repeat_after`, `repeat_mode`.
   - The server wipes assignees on a bulk update regardless of `fields`, so
     the tool snapshots and restores them around the call; restore failures
     are surfaced as `assigneeRestoreFailures`, not swallowed.
   - `assignees` / `labels` as the bulk field, and the fallback for servers
     that don't honor `fields`/`values`, still use the per-task
     `GET`+merge+`POST` path — O(n) API calls there.
   - See [docs/API-COVERAGE.md](API-COVERAGE.md)'s `POST /tasks/bulk` row for the full
     verified contract.

3. **Bulk Delete**: Deletes multiple tasks
   - Fetches task details before deletion for response
   - Deletes tasks individually
   - Handles partial failures
   - Recommended: Process in batches of 20 or fewer

### Implementation Notes

- Vikunja exposes exactly three native bulk endpoints: `POST /tasks/bulk`
  (used by `bulk-update` for scalar fields), `POST /tasks/{id}/labels/bulk`
  (used by create/update via `setTaskLabels`) and
  `POST /tasks/{id}/assignees/bulk` (replace-semantics — used *only* for the
  post-bulk-update assignee restore, never for a general assign flow).
- There is **no** native bulk *create* or bulk *delete*; those two remain
  client-side loops making individual API calls.
- `bulk-create` runs **sequentially** on purpose (`maxConcurrency: 1`):
  concurrent creates 500 with "database is locked" on SQLite-backed servers
  at the 2.3.0 floor. Vikunja 2.4.0 advertises `concurrent_writes: true`, but
  sequential is retained as defense-in-depth for the supported floor.
- Consider rate limiting when processing large batches.

## Future Considerations

1. **Transaction Support**: Consider implementing rollback mechanisms for multi-step operations
2. **Native Batch Operations**: bulk *update* is already native (`POST /tasks/bulk`); a native bulk *create* / *delete* would remove the remaining per-task loops
3. **Caching**: Authentication tokens could be cached more efficiently
4. **Response Streaming**: Large result sets might benefit from streaming
5. **Parallel Processing**: Bulk operations could be parallelized with rate limiting

## Session Capability Detection (v2 Groundwork)

Tracked as netadvanced/vikunja-mcp#28, "api-version-detect".

`src/utils/capabilities.ts` caches a per-session `VikunjaCapabilities` snapshot
(`{ serverVersion, features, hasV2Api }`) — the `GET /info` payload already
fetched by `vikunja_auth.connect`'s verification step, plus a one-time
best-effort `GET /api/v2/openapi.json` probe — surfaced read-only via
`vikunja_auth`'s `status` and `info` subcommands. **No tool currently branches
on `hasV2Api` or issues any `/api/v2/*` request** — this is only a seam future
v2 fast-paths can consult without an extra round trip.

Ground truth confirmed live against the e2e harness's `2.4.0` Vikunja stack
(`npm run e2e:up`, `VIKUNJA_VERSION=2.4.0` default): `GET /api/v2/openapi.json`
already returns `200` with a real OpenAPI schema on that version —
`curl http://localhost:33456/api/v2/openapi.json` — so `hasV2Api: true` is the
*correct* detection result there, not "v2 doesn't exist yet." A v2 schema
being publishable does not mean this server's v1 request paths are ready to
be replaced by it; do not treat `hasV2Api: true` as a green light to start
routing calls at `/api/v2/*` without separately verifying each endpoint's
shape against the vendored v2 OpenAPI spec, the same way `docs/API_NOTES.md`
already requires for v1.

**Version note (2026-08-24):** Vikunja 2.5.0 has since been released
upstream. It is neither this project's floor (2.3.0) nor its aligned/tested
default (2.4.0, above) — nothing in `src/` targets it, and no claim in this
file has been re-verified against it. Treat 2.5-specific behavior as unknown
rather than assuming it matches 2.4.0, until it gets the same
live-verification treatment 2.4.0 received here.

## Filter Implementation Notes

### SQL-Like Filter Syntax

The Vikunja API supports SQL-like filter syntax as documented. Filters should be passed using the `filter` parameter (not `filter_by`).

**Supported Features:**
- Complex filters with parentheses: `(priority >= 4 && done = false)`
- Boolean operators: `&&`, `||`, `AND`, `OR`
- Comparison operators: `=`, `!=`, `>`, `>=`, `<`, `<=`
- Like operator: `~` or `LIKE`
- In operator: `IN`, `NOT IN`

**Implementation:**
- Filters are passed to the API via the `filter` parameter
- **Update (2026-07-20):** the caller-supplied filter string is no longer
  passed through verbatim. `FilterValidator.validateAndParseFilter` parses
  every filter string with `parseFilterString` and always re-serializes the
  resulting expression through `expressionToString` before it reaches the
  API - this is what translates the filter DSL's canonical camelCase field
  names (`dueDate`, `percentDone`, `startDate`, `endDate`, `doneAt`,
  `project`) to the API's snake_case Task JSON fields (`due_date`,
  `percent_done`, `start_date`, `end_date`, `done_at`, `project_id`) via
  `FILTER_FIELD_TO_API_FIELD`. Previously this translation only happened
  when the `done` argument was also supplied (folded into the same
  expression); a bare camelCase filter string with no `done` argument
  reached the server untranslated, which the server either rejected
  (silently tripping `HybridFilteringStrategy`'s client-side fallback) or
  ignored outright.
- Re-serializing can change the filter string's surface syntax versus what
  the caller wrote - it always parenthesizes any group with more than one
  condition, always double-quotes `like` values (accepting single- or
  double-quoted input), and normalizes `in`/`not in` array spacing
  (`1,2` -> `1, 2`) - but never its semantics. See
  `tests/tools/tasks-filter-sql-syntax.test.ts` and the round-trip property
  tests in `tests/utils/filters.test.ts`.
- The API still handles all filter parsing and validation of the
  (now-translated) string; this MCP server does not evaluate filters beyond
  what's needed to parse and re-serialize them, except as an explicit
  client-side fallback when server-side filtering fails.

## Related Documents

- [docs/VIKUNJA_API_ISSUES.md](VIKUNJA_API_ISSUES.md) — upstream API bugs/quirks worth reporting, with per-issue status.
- [docs/API-COVERAGE.md](API-COVERAGE.md) — authoritative per-endpoint implementation status and the verified request/response contracts.
- [docs/ENDPOINT-TAIL-RETRIAGE.md](ENDPOINT-TAIL-RETRIAGE.md) — why the remaining 44 unimplemented operations are parked or ruled out, each with a reopening trigger.
- [docs/ENDPOINT-PLAYBOOK.md](ENDPOINT-PLAYBOOK.md) — the procedure to follow before touching endpoint code.

---

*Last updated: 2026-08-03 — re-verified against current `src/` and the vendored `v2.4.0` spec: corrected the `project_id`/`projectId` note, the file-attachment limitation (upload ships; only byte delivery is blocked), and the bulk-operations section (`POST /tasks/bulk` is native and used); removed `node-vikunja` framing left over from the direct-REST migration.*

*Updated 2026-08-31: added "Team Operations" (full-model-replace + the
`UseBool` public/private trap, and the spec-vs-handler member-addressing
mismatch — both cross-linked to `docs/VIKUNJA_API_ISSUES.md`), added "Create
Retries and Idempotency" cross-linking `docs/ARCHITECTURE.md`'s Retry Logic
section, and noted Vikunja 2.5.0 exists upstream but is unverified against
this codebase.*
