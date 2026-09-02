# Vikunja API Issues

This document tracks issues discovered with the Vikunja API that should be reported to the maintainer.

**How to read this file.** Item numbers are **stable anchors**: source comments
and tests cite them by number (`VIKUNJA_API_ISSUES.md #2`, `#7`, `#8`), so
numbers are never reused or reshuffled; resolved items keep their number and get
a status line. Each item carries a **Status** and the Vikunja version the claim
was last checked against. This project supports and tests the trailing THREE
released versions (policy since 2026-09-02, decision 29) — currently
**2.4.0** (floor), **2.5.0**, **2.6.0** (aligned/tested default); see
`SUPPORTED_VERSIONS` in `scripts/lib/e2e-target.ts`, the single source of
truth. The floor rose from 2.3.0 on 2026-08-31, so an item verified only
against 2.3.0 now describes a version below the floor, and anything only ever
verified on 0.22.x is doubly so. Both should be re-checked before being relied
on. Note that "verified against go-vikunja source, pinned v2.3.0" lines below
record *where a handler was read*, not a compatibility claim; handler source
rarely moves, so those stay as provenance.

**2.6.0 status (updated 2026-09-02, issue #254).** All three of 2.4.0, 2.5.0
and 2.6.0 now run as full `test:matrix` lanes on both DB backends, so an item
verified on any of them is verified on a tested version. An item that has only
ever been checked on 2.4.0 says nothing about 2.6.0 and vice versa — several
of the entries added in this pass exist precisely because they answer
differently.

| # | Issue | Status |
|---|---|---|
| 1 | SQL-like filter syntax "unsupported" | ✅ Resolved (wrong param name) |
| 2 | User endpoints reject `tk_*` API tokens | ⚠️ Open upstream, JWT workaround shipped |
| 3 | Team API surface (client-library gap) | ✅ Resolved via direct REST |
| 4 | Bulk operations | ✅ Mostly resolved, native `POST /tasks/bulk` exists and is used |
| 5 | Inconsistent error responses | ⚠️ Open upstream (cosmetic) |
| 6 | "No webhook support" | ✅ Obsolete: Vikunja has webhooks; we implement them |
| 7 | Task reminder field drift | ✅ Resolved (was client-library drift, not the API) |
| 8 | `/webhooks/events` can 401 | ⚠️ Open upstream, fallback shipped |
| 9 | snake_case field naming | ℹ️ Clarification, not a bug |
| 10 | `filter` param ignored | ❓ Unverified on supported versions (only ever seen on 0.22.1) |
| 11 | Bucket `position: 0` indistinguishable from omitted | ⚠️ Open upstream, workaround shipped |
| 12 | Project archive/unarchive validation | ✅ Resolved (endpoint is full-model-replace) |
| 13 | `POST /user/settings/general` forced full-replace | ✅ Resolved (fetch-merge workaround shipped) |
| 14 | `Webhook.Update` only ever writes `events` | ℹ️ By design upstream, client now rejects the no-op fields |
| 15 | Project view update writes a `Cols(...)` allowlist, not a true full replace | ✅ Resolved (fetch-merge workaround shipped) |
| 16 | Project `is_favorite` reset by omission (separate mechanism from #3a) | ✅ Resolved (fetch-merge workaround shipped) |
| 17 | `labels` filter matches ids, not titles | ✅ Resolved (title-to-id resolution shipped) |
| 18 | `per_page` silently clamped to `service.maxitemsperpage` (default 50) | ℹ️ By design upstream, client now paginates instead of over-requesting |
| 19 | Date-only field values 400 on create, not silently dropped | ℹ️ Clarification, corrects a stale in-repo comment |
| 20 | Label/assignee attach: 2xx is not proof, but every shape we send errors loudly | ℹ️ Clarification, disproves the LOW-22 audit suspicion |
| 21 | Notification `read_at` is the zero-time sentinel for unread, not `null` | ✅ Resolved, confirmed live against 2.4.0 |
| 22 | 2.6.0 refuses an out-of-scope `expand` with a 401 indistinguishable from a bad token | ⚠️ Open upstream, inference-based guidance shipped |
| 23 | `models.Project.max_permission` returns `null` while the spec declares it a non-nullable integer | ⚠️ Open upstream (spec bug), no client impact |
| 24 | `DELETE /projects/{projectID}/users/{userID}` takes a USERNAME, not the documented integer id | ⚠️ Open upstream (spec bug), fixture uses the username |

## 1. SQL-Like Filter Syntax Not Supported

**Status:** ✅ Resolved (2025-05-26); never an API bug. The request used the
wrong parameter name: the API expects `filter`, not `filter_by`. Complex
filters with parentheses and boolean operators work correctly with the right
parameter.

**Original issue:** the Vikunja API documentation suggested support for SQL-like filter syntax, but this format returned 500 Internal Server Error.

**Resolution:** use the `filter` parameter instead of `filter_by`:

```bash
# This now works correctly
curl -X GET 'https://your-vikunja-instance.com/api/v1/tasks/all?filter=(priority%20%3E%3D%204%20%26%26%20done%20%3D%20false)' \
  -H 'Authorization: Bearer YOUR_TOKEN'
```

**Impact:** Users can now use complex filters with multiple conditions as documented.

## 2. User Endpoints Reject API Tokens

**Status:** ⚠️ Open upstream; JWT workaround shipped (2025-05-28) and still the
supported answer. This is the most-cited item in the code base: `src/tools/auth.ts`,
`src/tools/tokens.ts`, `src/tools/caldav-tokens.ts` and `src/tools/user-deletion.ts`
all gate or explain themselves by it, and `vikunja_auth connect` verifies API-token
sessions against `GET /projects?per_page=1` rather than `GET /user` precisely because
of it.

**Description:** the `/user` endpoint and every other user-scoped endpoint fails with an authentication error despite using a valid API token that works for all other endpoints.

**Affected endpoints (verified 2025-05-28):**
- `/user` - Get current user
- `/users` - List all users
- `/users/{id}` - Get user by ID
- `/users?s=query` - Search users
- `/user/settings` - User settings
- `/user/timezones` - Available timezones
- `/user/tokens` - API tokens
- `/user/avatar` - User avatar
- `/user/export/request` - Request data export
- `/user/export/download` - Download data export

**Reproduction:**

```bash
# All of these fail with "missing, malformed, expired or otherwise invalid token provided"
curl -X GET 'https://your-vikunja-instance.com/api/v1/user' \
  -H 'Authorization: Bearer VALID_TOKEN'

curl -X GET 'https://your-vikunja-instance.com/api/v1/users' \
  -H 'Authorization: Bearer VALID_TOKEN'

curl -X GET 'https://your-vikunja-instance.com/api/v1/user/settings' \
  -H 'Authorization: Bearer VALID_TOKEN'

# Same token works for other endpoints
curl -X GET 'https://your-vikunja-instance.com/api/v1/tasks/all' \
  -H 'Authorization: Bearer SAME_VALID_TOKEN'

curl -X GET 'https://your-vikunja-instance.com/api/v1/projects' \
  -H 'Authorization: Bearer SAME_VALID_TOKEN'
```

**Expected:** User endpoints should accept the same API token authentication as other endpoints.

**Actual:** Returns 401 authentication error despite valid token.

**Root cause (verified 2025-05-28):** user endpoints require JWT session tokens obtained via username/password login, **not** API tokens. API tokens (prefixed with `tk_`) are only valid for non-user resources. There is no endpoint to exchange an API token for a JWT token, making programmatic access to user data require storing credentials.

**Workaround (implemented 2025-05-28):** The Vikunja MCP server now supports JWT authentication:

1. **Extract JWT from browser session:**

   ```bash
   # In browser DevTools → Application → Local Storage → Find 'token' key
   # Copy the JWT token (starts with eyJ...)
   ```

2. **Use JWT authentication in MCP:**

   ```typescript
   vikunja_auth.connect({
     // Bare instance URL — the server resolves the API path itself
     apiUrl: 'https://your-vikunja-instance.com',
     apiToken: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
     // Token type is auto-detected from the token format
   });
   ```

3. **Tools that only register under a JWT session:** `vikunja_users`,
   `vikunja_export_project`, `vikunja_request_user_export`,
   `vikunja_download_user_export`, `vikunja_user_export_status`,
   `vikunja_caldav_tokens`, `vikunja_admin`, `vikunja_user_deletion`, several
   of which are additionally deny-by-default module keys. See
   [docs/CONFIGURATION.md](CONFIGURATION.md) for the gating rules and
   `src/tools/index.ts` for the registration logic.

**Note:** JWT tokens expire (typically after 24 hours), requiring re-extraction.

**Impact:**
- Cannot retrieve current user information
- Cannot list or search users for task assignment
- Cannot manage user settings programmatically
- Cannot use data export features
- Batch import cannot assign tasks to users

## 3. Team API Contract Notes

**Status:** ✅ Resolved (checked against the vendored `v2.4.0` spec). The
original gap was in the `node-vikunja` client library, which has since been
removed entirely. **All** `vikunja_teams` subcommands now go through
`vikunjaRestRequest` (`src/utils/vikunja-rest.ts`). The endpoint contract notes
below are kept because they remain non-obvious and are easy to get wrong:

- `GET /teams/{id}`: get a team by id.
- `POST /teams/{id}`: update a team (**not** `PUT`; `PUT /teams/{id}` is not a defined route, only `PUT /teams` for create).
- Team members are **embedded** in the `GET /teams/{id}` response as `.members`; there is no standalone `GET /teams/{id}/members` endpoint.
- `PUT /teams/{id}/members`: add a member. The body's `username` field must be the member's real username string (the API deliberately rejects numeric user ids here, to prevent automated/enumerated user-id entry).
- `DELETE /teams/{id}/members/{username}`: remove a member; the path segment is the username, not a numeric id.
- `POST /teams/{id}/members/{userID}/admin`: **toggles** the member's admin flag. It takes no request body and cannot set an explicit true/false value; callers that need to know the resulting state should re-check via `members list`. **Spec/handler mismatch, settled by reading the handler (2026-08-24):** the vendored spec's `@Param userID path int true "User ID"` annotation is simply wrong. In go-vikunja's source (v2.3.0): the route is registered as `a.POST("/teams/:team/members/:user/admin", teamMemberHandler.UpdateWeb)` (`pkg/routes/routes.go`), and `TeamMember.Username` carries the struct tag `` `param:"user"` `` (`pkg/models/teams.go:78`); echo's binder wires the `:user` path segment straight into the *username* field, never a numeric id. `TeamMember.Update` (`pkg/models/team_members.go:151`) then resolves it with `user2.GetUserByUsername(s, tm.Username)`. `src/tools/teams.ts` sending the username there was correct all along; no live call was needed to settle it, and the previous "unresolved, only a live call can settle this" framing here undersold how conclusive the source is.

**Impact:** None once routed correctly. **Generalizable lesson:** when the vendored OpenAPI spec and the Go handler disagree, **the handler wins**. The spec is documentation, not a contract Vikunja's own router obeys. Before trusting a `@Param` annotation (especially one typed `int` for what could plausibly be a resolve-by-name path), check the route registration and the target struct's binding tags in `~/Projects/vikunja` (read-only, pinned at v2.3.0) rather than guessing from spec text, and never from a client library's types.

### 3a. `POST /teams/{id}` full-replace hazards (worked around)

**Status:** ⚠️ Open server-side, ✅ **worked around client-side** via
read-then-merge in `vikunja_teams update`. Verified in go-vikunja source
(v2.3.0), not just observed:

- `pkg/web/handler/update.go:37` binds the request body into an **empty** model
  (`c.EmptyStruct()`); there is no server-side read-then-merge. So the payload a
  client sends is the entire model the server sees.
- `pkg/models/teams.go:388` writes with
  `s.ID(t.ID).UseBool("is_public").Update(t)`. xorm skips zero-valued non-bool
  columns (so an omitted `description` is _not_ cleared), but `UseBool` forces
  `is_public` to be written **even when false**, therefore **any team update
  that omits `is_public` resets a public team to private.**
- `Team.Name` (`pkg/models/teams.go:37`) carries
  `valid:"required,runelength(1|250)"`, and `Team.Update`
  (`pkg/models/teams.go:378`) returns `ErrTeamNameCannotBeEmpty{}` when it is
  empty, so the request is rejected with HTTP 400 "Invalid model" when `name`
  is omitted.

**Generalizable lesson: `UseBool` on a full-replace endpoint is the tell.**
xorm's struct-based `Update` normally *skips* zero-valued columns, which is
exactly why an omitted `description` was always harmless here; the same
zero-skip silently protects every other non-bool field on this endpoint
today. `UseBool(colName)` (and its cousins `Cols()`/`AllCols()`) is the
explicit escape hatch that forces one named column to be written regardless
of its zero value. That combination (a handler with no server-side merge,
plus a `UseBool`/`Cols` override on a specific column) is what actually
causes the hazard, and it hides in plain sight for non-bool fields for years
because they degrade gracefully (silently ignored) while the forced column
degrades catastrophically (silently wiped). Before wiring up *any* new
Vikunja write endpoint, grep the corresponding go-vikunja model's `Update`
method for `UseBool`/`Cols`/`AllCols`; if present, a fetch→merge→POST (or an
explicit allowlist that always carries that column forward) is mandatory,
not optional.

**Impact (now):** none for callers. `vikunja_teams update` `GET`s the team,
spreads the whole returned model, overlays only the fields the caller actually
supplied, and `POST`s the merged model back, so a description-only update
preserves `name`, `is_public`, and every other server-returned field, and no
longer 400s. Callers pass only what they want to change. An explicit
`isPublic: false` still sets it to false: omission and an explicit `false` are
distinguished, never conflated. **Cost:** one extra `GET /teams/{id}` per
update, and a team update is consequently non-atomic: a concurrent edit
between the read and the write is overwritten by the merged snapshot (the same
trade-off `buildProjectUpdatePayload` has always carried for projects).

**Implementation:** `buildTeamUpdatePayload` (`src/tools/teams.ts`) is the teams
sibling of `buildProjectUpdatePayload` (`src/tools/projects/crud.ts`), the
fetch → merge → POST pattern `docs/ENDPOINT-PLAYBOOK.md` §4 prescribes. The
spread is deliberate over a hand-maintained allow-list, which would silently
drop fields a newer server adds.

**Not affected: checked, same-shaped but genuinely safe.** The team-membership
writes. `PUT /teams/{id}/members` is a *create* (`TeamMember.Create`,
`pkg/models/team_members.go:41`), `DELETE /teams/{id}/members/{username}` sends
no body, and `POST /teams/{id}/members/{username}/admin`
(`TeamMember.Update`, `pkg/models/team_members.go:149`) re-reads the membership
row server-side and writes with `Cols("admin")`, so nothing is replaced.

## 4. Bulk Operations

**Status:** ✅ Mostly resolved (spec-verified against vendored `v2.4.0`). The
original "the API has no bulk operations at all" claim was incorrect. Vikunja
exposes three native bulk endpoints:

- `POST /tasks/bulk` (`models.BulkTask`: `{task_ids, fields, values}`), used
  by `vikunja_tasks bulk-update` for scalar fields since PR #89, one request
  for the whole batch.
- `POST /tasks/{taskID}/labels/bulk`, used by task create/update via
  `setTaskLabels` (`src/utils/label-bulk.ts`).
- `POST /tasks/{taskID}/assignees/bulk`: **replace** semantics; used only to
  restore a complete assignee snapshot after a bulk update, never as a general
  assign flow (see `docs/ENDPOINT-TAIL-RETRIAGE.md`).

**Still genuinely missing:** bulk **create** and bulk **delete**. Those remain
client-side loops issuing one API call per task
(`src/tools/tasks/bulk-operations-simplified.ts`), and creates are run
sequentially on purpose to avoid SQLite "database is locked" 500s. This was observed at
the old 2.3.0 floor, and is retained past the 2.4.0 floor raise pending durable
multi-release evidence that upstream's `concurrent_writes` fix holds.

**Impact:** Bulk create/delete of large batches is still O(n) round trips, so
rate-limit and batch-size guidance still applies (`MAX_BULK_OPERATION_TASKS =
100`, `src/tools/tasks/constants.ts`).

## 5. Inconsistent Error Responses

**Status:** ⚠️ Open upstream, but fully absorbed on our side: `vikunjaRestRequest`
(`src/utils/vikunja-rest.ts`) normalizes whatever the server returns into an
`MCPError` carrying `details.statusCode`, so no call site parses raw error
bodies.

**Description:** Error responses vary in format and detail across different endpoints.

**Examples:**
- Some endpoints return `{"message": "error details"}`
- Others return `{"error": "error details"}`
- Internal errors often lack helpful details

**Impact:** Difficult to provide consistent error handling and user feedback.

## 6. Missing Webhook/Event Support

**Status:** ✅ Obsolete: the premise is false on supported versions. Vikunja
ships a full webhook surface, and this server implements it: project webhooks
(`GET`/`PUT /projects/{id}/webhooks`, `POST`/`DELETE
/projects/{id}/webhooks/{webhookID}`), user webhooks (`/user/settings/webhooks*`,
shipped as G4) and the event catalogue (`GET /webhooks/events`), all exposed
through `vikunja_webhooks` (`src/tools/webhooks.ts`).

The item is kept (rather than deleted) because item numbers are stable anchors.
The remaining real gap is a *push/streaming* channel **into MCP**. Webhooks
deliver to an HTTP endpoint, which an stdio MCP server cannot receive, so MCP
clients still poll. See also #8 for the `/webhooks/events` auth quirk.

## 7. Task Reminder Field Shape

**Status:** ✅ Resolved; never an API bug. The drift was in the removed
`node-vikunja` client's types; current code reads/writes the real
`models.TaskReminder` shape directly (`src/types/vikunja.ts`, covered by
`tests/tools/tasks-reminders-type-safety.test.ts`). Kept because the *correct*
contract below is still non-obvious, and because the "identify a reminder
without an id" consequence still governs `remove-reminder`'s design.

**Description:** the removed `node-vikunja` client's typed model for task reminders (`{ id, reminder_date }`) did not
match Vikunja's actual API contract (`models.TaskReminder`, per the OpenAPI spec), which is
`{ reminder, relative_period?, relative_to? }`, **both** on write and on read. There is no `id`
field on either side.

**Issue Details:**
- Creating/updating a reminder: the API expects the field name `reminder` (an absolute ISO 8601
  date string), with optional `relative_period` / `relative_to` for relative reminders.
- Retrieving a task: the API returns reminders in the same shape: `reminder` (never
  `reminder_date`), and no `id`.
- The old client library's type definitions described neither correctly: it typed reminders as
  `{ id: number, reminder_date: string }`, which matches nothing the server actually sends or
  accepts. (Verified against the vendored `v2.4.0` spec: `models.TaskReminder` has
  `reminder`, `relative_period`, `relative_to`, and no `id`.)

**Example (actual API shape, both directions):**

```javascript
// Creating/updating a reminder
{
  reminders: [
    { reminder: '2025-05-29T10:00:00Z' }
  ]
}

// Response from API — same shape, no id
{
  reminders: [
    { reminder: '2025-05-29T10:00:00Z' }
  ]
}
```

**Impact:** Code written against the old client's types (or against a mistaken assumption that GET
responses use `reminder_date`/`id`) will silently write zero-value reminders and can never
successfully identify a reminder to delete: every removal-by-id attempt returns "not found"
against a real server.

**Current behaviour:** the MCP server reads and writes the actual `reminder` field in both
directions (never `reminder_date`), now straight off the spec-generated types rather than casting
past a drifted library type. Since the API exposes no reminder id, `remove-reminder` identifies the reminder to
delete by its exact `reminder` date string and/or its zero-based position (`reminderIndex`) in
the array returned by `list-reminders`, never by an id.

## 8. Webhook Events Endpoint Rejects API Tokens

**Description:** The `/api/v1/webhooks/events` endpoint returns 401 Unauthorized errors even with valid API tokens.

**Issue Details:**
- The endpoint is supposed to return a list of valid webhook event types
- Returns 401 error with message "missing, malformed, expired or otherwise invalid token provided"
- Same token works for other endpoints but not for webhook operations
- Webhook CRUD operations also fail with similar authentication errors

**Example:**

```bash
# This fails with 401 Unauthorized
curl -X GET 'https://your-vikunja-instance.com/api/v1/webhooks/events' \
  -H 'Authorization: Bearer VALID_TOKEN'

# Same token works for other endpoints
curl -X GET 'https://your-vikunja-instance.com/api/v1/tasks/all' \
  -H 'Authorization: Bearer SAME_VALID_TOKEN'
```

**Impact:** Webhook functionality may not be available depending on server configuration or API token permissions.

**Workaround:** when `GET /webhooks/events` fails, `vikunja_webhooks` falls back
to a hardcoded list of known event types rather than erroring
(`DEFAULT_WEBHOOK_EVENTS`, `src/tools/webhooks.ts`, used for both the project
and user webhook scopes, with a 5-minute cache); the 401 is treated as
terminal and not retried, since retrying only adds latency
(`src/utils/vikunja-rest.ts`).

**Status:** ⚠️ Still assumed open upstream. The fallback and its
"don't retry a 401 here" behaviour are covered by
`tests/utils/vikunja-rest.test.ts`; whether a modern server (2.4.0, the floor)
still 401s on this endpoint with a `tk_*` token has not been re-verified live.

## 9. API Response Field Naming Convention

**Status:** ℹ️ Not a bug; a clarification, still accurate against the vendored
`v2.4.0` spec.

**Description:** The Vikunja API uses snake_case field naming in responses
(e.g. `due_date`, `start_date`, `percent_done`). MCP tool *arguments* in this
server are camelCase (`dueDate`, `percentDone`); the translation happens at the
server boundary (`FILTER_FIELD_TO_API_FIELD` in `src/utils/filters.ts`,
`SORT_FIELD_ALIASES` in `src/tools/tasks/constants.ts`). Do not expect the API
to accept or return the camelCase spelling.

`percent_done` differs in **scale** as well as spelling: the API stores a
fraction 0-1 (`0.5` = 50%), while this server's `percentDone` argument is a
whole percentage 0-100 (integers only). That conversion also happens at the
boundary (`src/utils/percent-done.ts`, decision 22 in
[ROADMAP.md](ROADMAP.md) §3), so the example response below shows the wire
value, not what the tool takes or reports.

**Note:** This is not an issue but a clarification for developers who might expect camelCase fields. The API consistently uses snake_case for all task fields.

**Example Task Response:**

```json
{
  "id": 1,
  "title": "Example Task",
  "due_date": "2024-12-31T23:59:59Z",
  "start_date": "2024-01-01T00:00:00Z", 
  "percent_done": 0.5,
  "hex_color": "#FF0000",
  "repeat_after": 86400,
  "done_at": null,
  "created_by": {...}
}
```

**Impact:** Ensure your code uses snake_case field names when accessing task properties from API responses.

## 10. Filter Parameter Ignored

**Status:** ❓ **Unverified on any supported version.** This was only ever
observed on Vikunja **v0.22.1**, which is far below this project's supported
floor and aligned/tested default (both 2.4.0). Nothing in the current
code base asserts that server-side filtering is broken. `vikunja_tasks list`
uses `HybridFilteringStrategy`, which *tries the server first* and only falls
back to client-side evaluation when that call fails, and the e2e suite
exercises real server-side filter expressions (`scripts/mcp-e2e.ts`, including a
negative control). Re-verify against a live 2.4.0 server before citing
this item; it may be entirely historical.

*(Numbering note: this item was previously also labelled "9", colliding with the
field-naming item above. It is #10 from 2026-08-03 onward; no source comment
referenced the old number.)*

**Description:** The `filter` parameter is completely ignored by the API, returning all tasks regardless of filter criteria.

**Affected Endpoints:**
- `/tasks/all?filter=...` - Returns all tasks
- `/projects/{id}/tasks?filter=...` - Returns all project tasks

**Reproduction:**

```bash
# These all return the same results (all tasks) despite different filters:
curl -X GET 'https://your-vikunja-instance.com/api/v1/tasks/all?filter=done%20%3D%20false' \
  -H 'Authorization: Bearer VALID_TOKEN'

curl -X GET 'https://your-vikunja-instance.com/api/v1/tasks/all?filter=priority%20%3E%3D%204' \
  -H 'Authorization: Bearer VALID_TOKEN'

curl -X GET 'https://your-vikunja-instance.com/api/v1/tasks/all?filter=(done%20%3D%20false%20%26%26%20priority%20%3E%3D%203)' \
  -H 'Authorization: Bearer VALID_TOKEN'
```

**Expected:** Tasks should be filtered according to the filter criteria.

**Actual:** All tasks are returned regardless of filter parameter.

**Verified on:** Vikunja v0.22.1

**Impact:** 
- Cannot filter tasks server-side
- Must retrieve all tasks and filter client-side (performance impact)
- Large task lists cause unnecessary data transfer

**MCP Server Workaround:** the server implements client-side filtering as a
*fallback*, not as the default path. `HybridFilteringStrategy`
(`src/utils/filtering/`) attempts server-side filtering first and only falls
back when that request fails, tagging the response with
`clientSideFiltering` / `serverSideFilteringAttempted` and an explanatory
`filteringNote` (`src/tools/tasks/types/filters.ts`):
- Parses filter strings using the same syntax as Vikunja
- Evaluates filters against the fetched task list
- Supports all fields, operators, and complex expressions
- Works transparently - users can use filters normally

**Supported Client-Side Filter Features:**
- **Fields**: done, priority, percentDone, dueDate, created, updated, title, description, assignees, labels
- **Operators**: =, !=, >, >=, <, <=, like, in, not in
- **Logical**: &&, ||, parentheses for grouping
- **Date Math**: now, now+7d, now-1w, etc.
- **Complex Expressions**: (done = false && priority >= 4) || (dueDate < now+7d)

**Performance Considerations:**
- Small projects (<100 tasks): Negligible impact
- Medium projects (100-1000 tasks): Minor delay for initial fetch
- Large projects (1000+ tasks): Noticeable delay, consider pagination

## 11. Bucket `position: 0` Is Indistinguishable From Omitted

**Status:** ⚠️ Open upstream (issue #173); workaround shipped 2026-07-25 in
`src/tools/projects/kanban-setup.ts`. Live-verified against Vikunja 2.4.0.

**Description:** `models.Bucket.position` is a plain (non-pointer) `float64` on the wire. A client explicitly sending `"position": 0` is byte-for-byte indistinguishable, server-side, from a client that omitted `position` entirely. When Vikunja cannot tell the two apart, it substitutes its own id-derived default (`bucket.id * 65536`) instead of honoring "first in the ordering".

**Reproduction:** `PUT` three buckets with `position: 0`, `position: 1`, `position: 2` respectively, then read them back via `GET /projects/{id}/views/{id}/buckets`:

```text
sent position 0 -> server stored 8585216 (= bucket id 131 * 65536, its own default)
sent position 1 -> stored 1 (honored)
sent position 2 -> stored 2 (honored)
```

Resulting board order: `Col-1`, `Col-2`, `<default buckets>`, `Col-0`. The column meant to be **first** landed dead last.

**Workaround:** Never send a literal `position: 0`. `setupKanban`'s `bucketPositionForIndex` helper pins every bucket position to a **1-based**, 65536-spaced value (`(index + 1) * 65536`), matching the `id * 65536` lane spacing Vikunja itself uses, so every value this composite sends is guaranteed non-zero and therefore always honored.

**Impact:** Any code that programmatically sets `Bucket.position` (not just `setup-kanban`) must avoid a literal `0` for the first item in an ordered sequence. This is easy to reintroduce by "simplifying" a 1-based position helper back to a 0-based `index * step`; see the comment on `bucketPositionForIndex` for why that would silently regress this fix.

## 12. Project Archive/Unarchive Validation Error

**Status:** ✅ Resolved; this was not a validation bug but the endpoint's
documented full-model-replace semantics, since handled properly.
*(Numbering note: this item was originally mislabelled "8", colliding with the
webhook-events item. It is #12 from 2026-08-03 onward.)*

**Original symptom (2025-05-28):** archiving/unarchiving failed with
"Struct is invalid. Invalid Data" when the request body carried only
`is_archived`. The original write-up also named the wrong verb: there is no
`PUT /projects/{id}` in the spec at all; the project update endpoint is
**`POST /projects/{id}`**.

**Actual cause:** `POST /projects/{id}` **replaces the entire project model**.
Any field omitted from the body is cleared server-side, and required fields
(notably `title`, `minLength: 1`) must be present. Sending a bare
`{is_archived: true}` was therefore both invalid and destructive.

**Resolution:** `archiveProject`/`unarchiveProject` (like `updateProject` and
`moveProject`) fetch the current project and merge the change onto it via
`buildProjectUpdatePayload` (`src/tools/projects/crud.ts`) before POSTing,
not just "include the title". See
[docs/API_NOTES.md](API_NOTES.md) "Project Operations" for the full
full-model-replace convention, which applies equally to project views and
Kanban buckets.

## 13. `POST /user/settings/general` Forced Full-Replace

**Status:** ✅ Resolved client-side (2026-08-31), verified against go-vikunja
source (v2.3.0). Same family as #3a's team `UseBool` trap and #16's project
favorites trap, but its own distinct mechanism: no zero-value skip is
involved at all here.

**Root cause:** `UpdateGeneralUserSettings`
(`pkg/routes/api/v1/user_settings.go:175-235`) binds the request body into an
**empty** `UserSettings{}` struct, then unconditionally copies every field
onto the loaded user record (`Name`, `EmailRemindersEnabled`,
`DiscoverableByEmail`, `DiscoverableByName`, `OverdueTasksRemindersEnabled`,
`DefaultProjectID`, `WeekStart`, `Language`, `Timezone`,
`OverdueTasksRemindersTime`, `FrontendSettings`), and calls
`user2.UpdateUser(s, user, true)`, where the third argument is
`forceOverride`. There is no server-side merge and no zero-value protection
of any kind: a partial body silently resets name, language, timezone, week
start, default project, both discoverability flags and reminder preferences
to their zero values on every call. `UserSettings.OverdueTasksRemindersTime`
additionally carries `valid:"time,required"`
(`pkg/routes/api/v1/user_settings.go:52`), so omitting it 400s the request
outright; a caller can't even avoid the wipe by leaving that one field out.

**Impact (before the fix):** any `vikunja_users update-settings` call that
didn't resend the caller's entire settings block silently wiped the rest.

**Resolution:** `vikunja_users update-settings` (`src/tools/users.ts`)
fetches the current settings first and merges only the caller-supplied
fields onto them before POSTing, the same fetch-merge-POST shape as
projects, teams, and views, and always carries
`overdue_tasks_reminders_time` forward from the fetched settings so the
required-field 400 can never be triggered by omission.

## 14. `Webhook.Update` Can Only Ever Change `events`

**Status:** ℹ️ By design upstream, not a bug, but easy to assume otherwise
from the endpoint's name and its shared shape with the "full-replace"
endpoints elsewhere in this file. Client-side guard shipped 2026-08-31.

**Description:** `Webhook.Update` (`pkg/models/webhooks.go:261-273`) is
neither a full-model replace nor a partial merge; it is a hard-coded
single-column write: `s.Where("id = ?", w.ID).Cols("events").Update(w)`. The
handler's own doc comment states the constraint explicitly: "Change a
webhook target's events. You cannot change other values of a webhook."
`targetUrl` and `secret` are fixed permanently at creation; no server-side
code path will ever persist a change to them via this endpoint, so, unlike
every other item in this file, a client-side fetch-merge cannot "fix" this,
because the server itself discards those fields on write regardless of what
is sent.

**Impact (before the fix):** `vikunja_webhooks update` accepted `targetUrl`/
`secret` arguments and reported success, silently implying they had changed
when only `events` ever did.

**Resolution:** `vikunja_webhooks update` (`src/tools/webhooks.ts`) rejects
`targetUrl`/`secret` outright with a message pointing at delete-and-recreate,
and its success message no longer implies more than `events` was updated.

## 15. Project View Update Writes a `Cols(...)` Allowlist, Not a True Full Replace

**Status:** ✅ Resolved client-side (2026-08-31); mechanism corrected from an
earlier ("just like the project/team full-replace endpoints") characterization
in `docs/API_NOTES.md`.

**Root cause:** `ProjectView.Update` (`pkg/models/project_view.go:412-439`)
writes with an explicit
`Cols("title", "view_kind", "filter", "position", "bucket_configuration_mode",
"bucket_configuration", "default_bucket_id", "done_bucket_id")` rather than a
bare `.Update(pv)` that would rely on xorm's zero-value column skip.
`Cols(...)` is the same forcing mechanism as `UseBool` (see §3a): it
overrides the zero-value skip for every column it names, applied here to a
whole list of columns instead of one boolean. A partial body therefore resets
a view's `position` to `0` and blanks its `filter` (and any other
listed-but-omitted field) rather than leaving them untouched.

**Impact (before the fix):** a targeted `update-view` call touching only
e.g. `title` would reset the view's `position` and `filter`.

**Resolution:** `update-view` and the `set-done-bucket` composite
(`src/tools/projects/views.ts`) fetch the current view first and merge
requested changes onto it (`buildViewUpdatePayload`) before POSTing,
functionally the same shape as a true full-replace fix, even though the
underlying server-side hazard is a `Cols(...)` allowlist rather than a bare
struct write.

## 16. Project `is_favorite` Reset By Omission: a Second Mechanism, Not `UseBool`

**Status:** ✅ Resolved client-side (2026-08-31). Same *symptom* as §3a's team
`is_public` trap (an omitted boolean acts like an explicit `false`) but a
genuinely different *mechanism*: do not treat this as "another `UseBool`
column," it isn't one.

**Root cause:** `Project.IsFavorite` is tagged `xorm:"-"`
(`pkg/models/project.go:69`), so it is not a persisted column at all, and
cannot be affected by `UseBool`/`Cols` in the way #3a and #15 describe.
Instead, `UpdateProject` (`pkg/models/project.go:1003` onward) reads the
project's current favorite state via `isFavorite(...)` and then calls
`addToFavorites`/`removeFromFavorite` as a side effect
(`pkg/models/project.go:1083-1096`) whenever the incoming
`project.IsFavorite` differs from the stored state. Specifically,
`removeFromFavorite` fires whenever the bound value is `false` and the
project was previously a favorite. Because the update handler binds the
request body into a fresh struct, an update that simply omits `is_favorite`
binds it to Go's zero value (`false`), which is indistinguishable from an
explicit unfavorite request.

**Impact (before the fix):** any `vikunja_projects update` call that didn't
explicitly resend `isFavorite: true` silently unfavorited a favorited
project.

**Resolution:** `buildProjectUpdatePayload` (`src/tools/projects/crud.ts`)
fetches the current project and carries its `isFavorite` value forward
unless the caller explicitly supplies a different one, the same
fetch-merge-POST pattern used for #3a, closing both mechanisms with one
merge despite their different root causes.

## 17. `labels` Filter Matches Label IDs, Not Titles

**Status:** ✅ Resolved client-side (2026-08-31), title-to-id resolution
verified live against 2.4.0.

**Description:** the Vikunja filter DSL documents filtering by label the way
every other filterable field works (a human-readable value), but the
`labels` filter field actually matches on the label's numeric **id**.
`filter=labels in 'HU'` (a label title) returns HTTP 400, code 4019:
`"The task filter value 'HU' for field 'labels' is invalid."`, while
`filter=labels in 100` (a real label id) works correctly.

**Impact (before the fix, issue #227):** any filter written the "obvious"
way, with a label title, either 400'd server-side or, worse, silently
matched zero tasks when the client-side fallback ran `Number('HU')`,
producing `NaN`, which cannot equal any label id
(`src/tools/tasks/filtering/evaluators.ts:93-101`).

**Resolution:** `resolveLabelTitlesInExpression`
(`src/tools/tasks/filtering/FilterValidator.ts`) resolves label titles to ids
once per filter evaluation (fetching the caller's labels and matching
case-insensitively), feeding the resolved ids into both the server-bound
filter string and the client-side fallback evaluator. An unresolvable label
title now raises a named error rather than silently returning zero results.

**Correction to a hypothesis in the original issue:** #227 also hypothesized
that list endpoints return `labels: null` even for tasks that have labels,
which would have made label filtering impossible to fix client-side at all.
**This was checked and found wrong, live against 2.4.0.** List endpoints do
populate the `labels` array correctly; `labels: null` means the task
genuinely has none. Anyone revisiting a "label filter matches nothing"
report should suspect the id/title mismatch above before the response shape.

## 18. `per_page` Silently Clamped to `service.maxitemsperpage` (Default 50)

**Status:** ℹ️ By design upstream, not a bug, but the silence (no error, no
response metadata) makes it easy to build a client that thinks it requested
everything and got everything. Client-side handling shipped 2026-08-31.

**Description:** Vikunja's generic `ReadAllWeb` list handler
(`pkg/web/handler/read_all.go:83-91`) clamps any requested `per_page` down to
`service.maxitemsperpage` (default **50**, `pkg/config/config.go:349`) with
no error and no response signal beyond a short page. Both `GET /projects`
and `GET /projects/{id}/tasks` route through this same handler
(`a.GET("/projects/:project/tasks", taskCollectionHandler.ReadAllWeb)`,
`pkg/routes/routes.go:512`), so both are affected identically.

**Impact (before the fix):** `fetchAllProjects`
(`src/tools/projects/crud.ts`, used for hierarchy/breadcrumb/move-cycle
validation) made a single `per_page=1000` call and silently covered only the
first 50 projects on any instance with more. The equivalent per-project task
aggregation used by filtering had the same bug for `GET
/projects/{id}/tasks`, discovered and fixed in the same pass (#244), and
unrelated to that PR's own primary scope (filter correctness), but found
because both call sites make the same assumption about `per_page`.

**Resolution:** both call sites now paginate. `fetchAllProjects` walks
`page` in `FETCH_ALL_PROJECTS_PAGE_SIZE`-sized (200) chunks until a short
page signals the end (bounded by `FETCH_ALL_PROJECTS_MAX_PAGES` = 50 as a
safety valve), and the task-aggregation path in
`src/utils/filtering/ClientSideFilteringStrategy.ts` paginates per project up
to `MAX_PAGES_PER_PROJECT` (500) or a shared `VIKUNJA_MAX_TASKS_LIMIT`
task-count budget, whichever is hit first, surfacing `resultComplete: false`
and a `warnings` entry when either bound truncates the result rather than
silently reporting a partial list as complete.

**2026-08-31 follow-up (issue #268 / audit CRIT-7): two more call sites had
the SAME bug, unpaginated.** `RestCrossProjectFilteringStrategy` (the
primary cross-project `GET /tasks` path) and `ServerSideFilteringStrategy`
(single-project `GET /projects/{id}/tasks` with a server-side filter) each
issued exactly one request with a large `per_page` and never checked
whether the page came back full. Both now paginate via the shared
`src/utils/filtering/pagination.ts` helper — a lighter algorithm than
`ClientSideFilteringStrategy`'s self-referential one: it compares each
page's length against the server's cached `max_items_per_page` (or the
documented default of 50 when that isn't cached yet) rather than spending
an extra probe request, so the common small-result-set case still costs
exactly one request. Same `resultComplete`/`warnings` signal on truncation.

**Also confirmed LIVE against a real Vikunja 2.4.0 instance (issue #289 /
audit HIGH-18) that the clamp is not limited to the `/tasks` and
`/projects/{id}/tasks` handlers documented above:**
- `GET /notifications` (`vikunja_notifications list`) is clamped the same
  way, confirmed via the response's own `X-Pagination-*` headers.
- `GET /tasks/{taskID}/comments` is clamped too, even though the OpenAPI
  spec documents NO `page`/`per_page` parameters for this endpoint at all
  (only `order_by`) — verified live: 60 comments added to one task, an
  unpaged `GET` returned exactly 50 with `X-Pagination-Total-Pages: 2`, and
  `?page=2` (undocumented but functional) returned the remaining 10. Both
  now paginate via the same shared helper.
- `GET /tasks/{taskID}/assignees`, `GET /tasks/{id}/attachments`, `GET
  /tasks/{id}/labels`, and `GET /teams` were spot-checked (not live-verified
  per-endpoint) and given the lighter "at minimum" fix from the same
  helper (`describePossibleTruncation`): they stay single-request, but now
  set `resultComplete: false` with a warning when an unpinned page comes
  back at or above the (known or assumed) page cap, rather than staying
  silent.

## 19. Date-Only Field Values 400 on Create, Not Silently Dropped

**Status:** ℹ️ Clarification, verified live against 2.4.0 (2026-08-31);
corrects a stale characterization still present in this repo's own code
comments.

**Description:** a bare date-only value (e.g. `2026-09-01`, without a time
component) sent for `due_date`/`start_date`/`end_date` on a task-create
endpoint (verified on `PUT /projects/{id}/tasks`) is rejected with HTTP 400,
code **2004** (`ErrCodeInvalidModel`, `pkg/models/error.go:202`): "Invalid
model provided." It does not silently drop the field while accepting the
rest of the payload.

**Why this needed stating explicitly:** `normalizeDateForApi`'s own doc
comment in this repo (`src/tools/tasks/validation.ts:29-32`) still says
Vikunja "SILENTLY DROPS a bare date-only value", a characterization that
predates this live verification (issues #167/#163 for the create-path fix,
#225 for the related filter-literal 400 under code 4019) and is now known
inaccurate for create endpoints specifically. The 400-not-drop behavior is
what `src/tools/tasks/subtasks.ts:207-213`'s comment correctly describes.
Both comments live in the same code path family; only the older one is
stale. `vikunja_tasks update`'s date fields are NOT yet covered by the same
coercion (tracked separately, see tracking issue #28); that gap is a real
open item, distinct from this clarification.

**Resolution:** `normalizeDateForApi` (`src/tools/tasks/validation.ts`)
coerces date-only and SQL-ish space-separated date strings to RFC3339 before
they reach the wire, applied on `create-subtask`, `bulk-create-subtasks`,
`vikunja_batch_import` and template `instantiate`.

## 20. Label/Assignee Attach: A 2xx Is Not Proof, But Every Shape We Send Errors Loudly

**Status:** ℹ️ Clarification, verified live against 2.4.0/sqlite (2026-09-01).
Disproves the concrete exploit claimed by audit finding LOW-22 (issue #295)
while confirming the failure *mode* it describes.

**The suspicion:** `create-subtask` / `bulk-create` treat an HTTP 2xx on the
label/assignee attach `PUT` as proof the attach happened, with no read-back.
If Vikunja could accept-and-ignore such a call, a task would be reported as
created-with-labels while carrying none.

**What the live probe found.** Every call shape this codebase actually sends
is validated server-side and fails loudly, so a 2xx does mean the write
landed:

| Call | Result |
|---|---|
| `PUT /tasks/{id}/labels` `{label_id: N}`, valid | 201, echoes `{label_id, created}`, read-back confirms |
| `PUT /tasks/{id}/labels`, label already on task | **400** code 8001 "This label already exists on the task." |
| `PUT /tasks/{id}/labels`, nonexistent label | **404** code 8002 "This label does not exist." |
| `PUT /tasks/{id}/assignees` `{user_id: N}`, valid | 201, echoes `{user_id, created}`, read-back confirms |
| `PUT /tasks/{id}/assignees`, user already assigned | **400** code 4021 "This user is already assigned to that task." |
| `PUT /tasks/{id}/assignees`, nonexistent user | **404** code 1005 "The user does not exist." |
| `PUT /tasks/{id}/assignees`, user without project access | **403** code 7003 "This user does not have access to the project." |
| `POST /tasks/{id}/labels/bulk` `{labels:[{id}]}` | 201, read-back confirms the exact set |
| `POST /tasks/{id}/labels/bulk` with a bogus label id | **404** code 8002 |

**But the failure mode is real, on shapes we do not send.** Two calls answer
2xx and persist nothing:

- `POST /tasks/{id}/labels/bulk` with the **legacy `label_ids` body** answers
  **201** with `{"labels": null}` and writes nothing. This is the drift
  already documented on `setTaskLabels` (`src/utils/label-bulk.ts`) — the
  reason that helper sends `{labels:[{id}]}` — and it is the historical proof
  that a 201 here is not self-evidently a success.
- `PUT /tasks/{id}/labels` with an **empty body** answers **201** with
  `{"label_id": 0}`.

**Conclusion:** LOW-22 is not currently exploitable, so no read-back was
added (an extra GET per subtask for a gap that cannot be reproduced is not a
trade worth making). The standing rule this evidence supports is the one
already in force: **verify the request body shape against the vendored
OpenAPI spec, never against a client library's types** — body-shape drift, not
a missing read-back, is what turns these endpoints into silent no-ops.

**Note on the assignee duplicate (400 code 4021):** this one is not just
documentation. It is the server-side half of issue #267(c) — bulk-update's
per-task assignee path used to re-add every requested id without excluding
those already assigned, so an overlapping set aborted the update mid-flight.
Fixed by reconciling as a set difference.

## 21. `GET /notifications`'s `read_at` Is the Zero-Time Sentinel for Unread, Not `null`

**Status:** ✅ Confirmed live against 2.4.0 (2026-08-31, issue #286 / audit
HIGH-15), previously only suspected. Client-side handling shipped the same
day.

**Description:** `notifications.DatabaseNotification` (the `GET
/notifications` list response schema) declares `read_at` as a plain
`string`, and a genuinely unread notification serializes it as the Go
zero-time string `"0001-01-01T00:00:00Z"`, not `null` or an absent field —
verified by creating a fresh notification, reading it back over the API, and
cross-checking the underlying DB row (`read_at` NULL in Postgres, but
`"0001-01-01T00:00:00Z"` over the wire). This is the same sentinel pattern
already documented and handled for task date fields (`start_date`/
`end_date`/`done_at`/`due_date` — see `src/tools/tasks/filtering/
evaluators.ts`), just not previously known to apply to notifications.

**Impact (before the fix):** `vikunja_notifications list`'s `unreadOnly:
true` filter did `allNotifications.filter((n) => !n.read_at)` — a bare
truthiness check that is always `false` for ANY non-empty string, sentinel
or real, so it filtered out EVERY notification, reporting "0 unread" no
matter how many actually were. Separately, `POST /notifications/{id}`'s
mark-read idempotency retry (`ensureNotificationRead`) checked the same way
and so could never detect "the toggle actually landed on unread," making the
retry dead code against a real server.

**A separate server-side quirk, observed while verifying this and tracked
separately as issue #314 — now confirmed and fixed client-side (2026-09-01):**
repeated `POST /notifications/{id}` calls against the live 2.4.0 instance
used for the original verification never actually flipped the DB's
`read_at` away from NULL, regardless of call count — every response's own
`read` field came back `false`.

Issue #314 re-verified this independently against two more live 2.4.0
stacks: a 4-day-old postgres instance (same backend as the original
observation, ruling out "it was just stale by then") and a freshly
provisioned sqlite instance with almost no accumulated state (ruling out
"it's specific to that one long-running container"). **It reproduces
identically on both**, so this is general Vikunja 2.4.0 server behavior,
not an artifact of one stack's accumulated state.

Root cause identified: `POST /notifications/{id}` sent with an empty body —
the shape `docs/vikunja-openapi.json` documents ("no request body")  — never
persists the read toggle on either backend, no matter how many times it is
called. Sending an explicit `{"read": true}` body instead **does** persist
correctly, confirmed by a follow-up `GET` on both stacks. This matches what
the real Vikunja frontend itself sends (found independently while building
a docs screenshot-capture script — see `docs/LOCAL-TESTING.md`, "A note on
`POST /notifications/{id}`").

**Resolution:** `isNotificationUnread` (`src/tools/notifications.ts`) checks
`!readAt || readAt.startsWith('0001-')`, matching the existing task-date
sentinel pattern, used for `unreadOnly` filtering.
`ensureNotificationRead` now sends `{ read: true }` explicitly on every
`POST /notifications/{id}` call rather than the documented-but-non-functional
empty body, and checks the response's own explicit `read` boolean (present
on `POST /notifications/{id}`'s response shape, `models.DatabaseNotifications`,
though NOT on the plain `GET /notifications` list shape) rather than
`read_at` truthiness. The retry-once-if-not-confirmed step is kept as a
defensive fallback; if both attempts still fail to confirm `read: true`,
`mark-read` now surfaces a warning in its response instead of silently
reporting success (issue #314's suggested next step).

## 22. An Out-of-Scope `expand` Returns a 401 Indistinguishable From a Bad Token

**Status:** ⚠️ Open upstream. Verified live against **2.6.0** (and confirmed
absent on 2.4.0) on 2026-09-02, issue #254 probe C2. Client-side guidance
shipped; see `describeLikelyExpandScopeFailure` in `src/utils/vikunja-rest.ts`.

Vikunja 2.6.0 fixed a real security bug: API-token permission checks looked
only at URL and method, so `expand=comments` pulled in data from scopes the
token never had. The fix rejects the request — but the rejection it sends is:

```
HTTP 401
{"code":11,"message":"missing, malformed, expired or otherwise invalid token provided"}
```

which is **byte-for-byte identical** to what an expired or revoked token
gets. Error code 11 is the generic invalid-token code. Measured with one
token that deliberately omitted `tasks_comments` and `reactions`:

| Request | 2.4.0 | 2.6.0 |
|---|---|---|
| `GET /tasks` | 200 | 200 |
| `GET /tasks?expand=comments` | 200 | **401 code 11** |
| `GET /tasks?expand=reactions` | 200 | **401 code 11** |
| `GET /tasks?expand=subtasks` | 200 | 200 |

A client therefore cannot tell "your token lacks a scope" from "your token is
dead", and the two call for opposite responses: re-authenticating fixes one
and is useless for the other. **What upstream could change:** send `403` for
the scope case, or keep 401 but use a distinct error code naming the missing
permission group. Either would make this mechanically classifiable.

What we do instead: infer it from the request (a scope-checked `expand` value
was requested, on a `tk_*` session, and the answer was 401) and say plainly
in the error that it is the LIKELY cause, with the "token really is expired"
branch named second and a one-line experiment that separates them — the same
request without `expand`. The inference also sets `details.insufficientScope`,
which keeps the failure out of the shared circuit breaker and stops the
cross-project listing strategy from silently falling back (the fallback drops
`expand` entirely, so falling back turned the refusal into a successful
listing quietly missing the expanded data).

## 23. `Project.max_permission` Returns `null` Where the Spec Says Integer

**Status:** ⚠️ Open upstream, spec bug only. Verified live on 2026-09-02
against 2.4.0 and 2.6.0 (issue #254, item A2). No client impact here.

`models.Project.max_permission` is declared `$ref: models.Permission`, i.e. a
non-nullable integer enum of 0/1/2. On 2.6.0 the three single-project
responses — `GET /projects/{id}`, `POST /projects/{id}` (update) and
`PUT /projects` (create) — return `null` for it. On 2.4.0 the same three
returned `0`. The list endpoint `GET /projects` returned `null` on both.

The change is a correction, not a regression: `0` is `PermissionRead`, and
these responses were emitting an unassigned zero value that read as a real
"read-only" grant. `null` is the honest encoding. The bug is that the spec
was not updated to match, so a generated client types the field as a plain
integer and a strict deserializer would reject the response.

No impact on this project: nothing in `src/` reads `max_permission`, and the
generated type already marks it optional. Recorded so a future reader who
starts consuming the field knows it is nullable regardless of what the
vendored spec says.

## 24. `DELETE /projects/{projectID}/users/{userID}` Wants a Username

**Status:** ⚠️ Open upstream, spec bug. Verified live on 2.6.0, 2026-09-02
(issue #254, item B2). Used by the e2e access-revocation fixture.

The vendored spec declares the path parameter as `userID`, `type: integer`,
"User ID". Passing the numeric user id answers:

```
HTTP 404
{"code":1005,"message":"The user does not exist."}
```

for a user who demonstrably does exist and is listed by
`GET /projects/{id}/users` with that exact id. Passing the **username** in
the same position succeeds with 200 and really does revoke access.

Note the companion `PUT /projects/{id}/users` has the same shape mismatch in
the other direction: its body is `{ "username": ..., "permission": ... }`,
not the `{ "user_id": ..., "right": ... }` the surrounding field naming leads
you to try — that combination also answers `1005 The user does not exist.`
Both are encoded once in `shareProjectWithUser`/`revokeProjectUser`
(`scripts/lib/e2e-fixtures.ts`) so nobody has to rediscover them.

## Recommendations for Vikunja Maintainers

Trimmed to what is **still open** upstream (the filter-syntax, team-API, bulk
and webhook asks have all been resolved or were mistaken; see #1, #3, #4, #6):

1. **Standardize authentication** across all endpoints. `tk_*` API tokens
   being rejected by every `/user/*` endpoint (#2) is the single biggest
   friction point for programmatic clients, since there is no way to exchange
   an API token for a JWT.
2. **Standardize the error response format** across all endpoints (#5).
3. **Make `/webhooks/events` reachable with an API token** (#8), or document
   the JWT requirement in the spec.
4. **Make `Bucket.position` a pointer / nullable field** (#11) so an explicit
   `0` is distinguishable from an omitted value.
5. **Correct the spec's `POST /teams/{id}/members/{userID}/admin` path
   parameter** (#3): it is confirmed a username, not a numeric id (the
   handler binds it via `TeamMember.Username`'s `param:"user"` tag).

---

*These issues were discovered during development of the Vikunja MCP Server.*

*Last reviewed: 2026-08-03; every item re-checked against current `src/`, the
vendored `v2.4.0` OpenAPI spec and `docs/API-COVERAGE.md`; duplicate item
numbers resolved, resolved/obsolete items relabelled, and per-item status +
verified-against version added.*

*Updated 2026-08-31: item #3's admin-toggle path-parameter question settled
(not just observed) by reading the go-vikunja route registration and
`TeamMember.Username`'s `param:"user"` binding tag directly (generalized as
"the handler wins over the spec"), and §3a gained a standalone
`UseBool`-on-full-replace lesson so it reads as a pattern to watch for, not
just an incident report. Noted that Vikunja 2.5.0 and 2.6.0 exist upstream
but are unverified here.*

*Updated 2026-08-31 (second pass, same day): added items #13-#19, each
verified against go-vikunja source (`~/Projects/vikunja`, pinned v2.3.0) with
file:line citations, not just observed behavior: `POST /user/settings/general`
forced full-replace (#13), `Webhook.Update`'s hard-coded `events`-only write
(#14), the project-view update's `Cols(...)` allowlist mechanism corrected
from an earlier "full replace" characterization (#15), project `is_favorite`
as a second, mechanistically distinct reset-by-omission trap alongside §3a's
`UseBool` case (#16), the `labels` filter id-vs-title mismatch plus a
correction of #227's wrong "labels: null" hypothesis (#17), the `per_page`
clamp to `service.maxitemsperpage` affecting both `GET /projects` and `GET
/projects/{id}/tasks` (#18), and a correction of a stale "silently drops"
comment for date-only field values, which actually 400 (code 2004) on create
endpoints (#19).*

*Updated 2026-08-31 (third pass, same day, issues #268/#289/#286): item #18
gained a follow-up confirming the SAME `per_page` clamp also silently
truncated `RestCrossProjectFilteringStrategy`'s primary `GET /tasks` path,
`ServerSideFilteringStrategy`'s single-project+filter path, `vikunja_
notifications list`, and (confirmed live, despite the endpoint's own OpenAPI
spec documenting no pagination parameters at all) `GET
/tasks/{taskID}/comments` — all now paginate via a shared helper. Added item
#21: `GET /notifications`'s `read_at` returns the Go zero-time sentinel
string for an unread notification rather than `null`, confirmed live
against 2.4.0, which broke both `unreadOnly` filtering and the mark-read
idempotency retry's truthiness check.*

*Updated 2026-09-02 (Vikunja 2.6.0 alignment, issue #254): added items #22,
#23 and #24, all probed live against a 2.6.0 stack with a 2.4.0 control
running beside it. The header's version paragraph was rewritten — 2.6.0 is
now a tested lane, 2.5.0 still is not. Two of the 2.6.0 behaviour changes
recorded elsewhere rather than here, because they are the server working as
intended rather than API defects: `GET /tasks/{id}/assignees` no longer
returns `email` (it did on 2.4.0), and writes to an archived project's
buckets, webhooks and views now answer `412` code `3008` whose message only
mentions tasks. Both are covered by version-gated e2e checks in
`scripts/mcp-e2e.ts` and, for the second, by a teaching paragraph appended at
the REST layer. Also confirmed here: the v2 `PATCH`-on-subscribed-task `422`
(`expected integer at body.subscription.entity`) reproduces on 2.4.0 and is
FIXED on 2.5.0 and 2.6.0 — so the `subscription: null` workaround #184 plans
to carry is needed only for the floor, and its removal condition is "the
floor moves past 2.4.0", not "2.6.0 is fine".*

*Updated 2026-09-01: added item #20, the label/assignee attach contract,
probed live against the 2.4.0/sqlite stack while triaging audit finding
LOW-22 (issue #295). The same session re-confirmed on 2.4.0 that a
scalar-only `POST /tasks/bulk` (`fields:["priority"]`) still empties the
task's assignee list, and that `POST /tasks/{id}/assignees/bulk` restores it
— the mechanism the snapshot/restore workaround in
`src/tools/tasks/bulk-operations-simplified.ts` depends on (issue #267).*
