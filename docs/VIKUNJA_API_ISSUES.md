# Vikunja API Issues

This document tracks issues discovered with the Vikunja API that should be reported to the maintainer.

## 1. ~~SQL-like Filter Syntax Not Supported~~ RESOLVED

**Update (2025-05-26):** This issue has been resolved. The problem was that we were using the wrong parameter name. The API expects `filter` not `filter_by`. Complex filters with parentheses and boolean operators now work correctly.

**Original Issue:** The Vikunja API documentation suggested support for SQL-like filter syntax, but we were getting 500 Internal Server Error when using this format.

**Resolution:** Use the `filter` parameter instead of `filter_by`:
```bash
# This now works correctly
curl -X GET 'https://your-vikunja-instance.com/api/v1/tasks/all?filter=(priority%20%3E%3D%204%20%26%26%20done%20%3D%20false)' \
  -H 'Authorization: Bearer YOUR_TOKEN'
```

**Impact:** Users can now use complex filters with multiple conditions as documented.

## 2. User Endpoint Authentication Error - WORKAROUND AVAILABLE

**Status:** Partially resolved with JWT authentication workaround (2025-05-28)

**Description:** The `/user` endpoint and ALL user-related endpoints fail with authentication errors despite using a valid API token that works for all other endpoints.

**Affected Endpoints (verified 2025-05-28):**
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

**Root Cause (verified 2025-05-28):** User endpoints require JWT session tokens obtained via username/password login, NOT API tokens. API tokens (prefixed with `tk_`) are only valid for non-user resources. There is no endpoint to exchange an API token for a JWT token, making programmatic access to user data require storing credentials.

**Workaround (implemented 2025-05-28):** The Vikunja MCP server now supports JWT authentication:

1. **Extract JWT from browser session:**
   ```bash
   # In browser DevTools → Application → Local Storage → Find 'token' key
   # Copy the JWT token (starts with eyJ...)
   ```

2. **Use JWT authentication in MCP:**
   ```typescript
   vikunja_auth.connect({
     apiUrl: "https://your-vikunja-instance.com/api/v1",
     apiToken: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
     // Token type is automatically detected!
   })
   ```

3. **Available tools with JWT auth:**
   - `vikunja_users` - Full user management functionality
   - `vikunja_export_project` - Project data export
   - `vikunja_request_user_export` - User data export

**Note:** JWT tokens expire (typically after 24 hours), requiring re-extraction.

**Impact:** 
- Cannot retrieve current user information
- Cannot list or search users for task assignment
- Cannot manage user settings programmatically
- Cannot use data export features
- Batch import cannot assign tasks to users

## 3. Team API — node-vikunja Coverage Gap (worked around via direct REST)

**Description:** node-vikunja's `TeamService` only implements `getTeams`/`createTeam`/`deleteTeam`. `vikunja_teams` covers the rest (`get`, `update`, `members`) by calling the Vikunja REST API directly through `src/utils/vikunja-rest.ts`, per the OpenAPI spec:

- `GET /teams/{id}` — get a team by id.
- `POST /teams/{id}` — update a team (**not** `PUT`; `PUT /teams/{id}` is not a defined route, only `PUT /teams` for create).
- Team members are **embedded** in the `GET /teams/{id}` response as `.members` — there is no standalone `GET /teams/{id}/members` endpoint.
- `PUT /teams/{id}/members` — add a member. The body's `username` field must be the member's real username string (the API deliberately rejects numeric user ids here, to prevent automated/enumerated user-id entry).
- `DELETE /teams/{id}/members/{username}` — remove a member; the path segment is the username, not a numeric id.
- `POST /teams/{id}/members/{username}/admin` — **toggles** the member's admin flag. It takes no request body and cannot set an explicit true/false value; callers that need to know the resulting state should re-check via `members list`.

**Impact:** None once routed correctly — noted here because node-vikunja's own types/methods do not reflect this surface, so any future change to `vikunja_teams` should re-verify against the live OpenAPI spec rather than the client library.

## 4. Bulk Operations Not Implemented

**Description:** The API lacks native bulk operations for tasks, requiring individual API calls for each operation.

**Missing Features:**
- Bulk create tasks
- Bulk update tasks
- Bulk delete tasks

**Impact:** Poor performance when working with multiple tasks, leading to rate limiting issues and slow operations.

## 5. Inconsistent Error Responses

**Description:** Error responses vary in format and detail across different endpoints.

**Examples:**
- Some endpoints return `{"message": "error details"}`
- Others return `{"error": "error details"}`
- Internal errors often lack helpful details

**Impact:** Difficult to provide consistent error handling and user feedback.

## 6. Missing Webhook/Event Support

**Description:** No webhook or event system for real-time updates.

**Impact:** Clients must poll for changes, leading to inefficient resource usage and delayed updates.

## Recommendations for Vikunja Maintainers

1. **Fix SQL-like filter syntax** or update documentation to reflect actual capabilities
2. **Standardize authentication** across all endpoints
3. **Complete team API** implementation
4. **Add native bulk operations** for better performance
5. **Standardize error response format** across all endpoints
6. **Consider adding webhook support** for real-time updates

---

## 7. Task Reminder Field Inconsistency (node-vikunja drift, not the real API)

**Description:** node-vikunja's typed model for task reminders (`{ id, reminder_date }`) does not
match Vikunja's actual API contract (`models.TaskReminder`, per the OpenAPI spec), which is
`{ reminder, relative_period?, relative_to? }` — **both** on write and on read. There is no `id`
field on either side.

**Issue Details:**
- Creating/updating a reminder: the API expects the field name `reminder` (an absolute ISO 8601
  date string), with optional `relative_period` / `relative_to` for relative reminders.
- Retrieving a task: the API returns reminders in the same shape — `reminder` (never
  `reminder_date`), and no `id`.
- The node-vikunja library's type definitions describe neither correctly: it types reminders as
  `{ id: number, reminder_date: string }`, which matches nothing the server actually sends or
  accepts.

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

**Impact:** Code written against node-vikunja's types (or against a mistaken assumption that GET
responses use `reminder_date`/`id`) will silently write zero-value reminders and can never
successfully identify a reminder to delete — every removal-by-id attempt returns "not found"
against a real server.

**Workaround:** The MCP server reads and writes the actual `reminder` field on both directions
(never `reminder_date`), casting through `unknown` past node-vikunja's drifted `Task` type where
necessary. Since the API exposes no reminder id, `remove-reminder` identifies the reminder to
delete by its exact `reminder` date string and/or its zero-based position (`reminderIndex`) in
the array returned by `list-reminders` — never by an id.

## 8. Webhook Events Endpoint Missing or Requires Special Permissions

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

## 9. API Response Field Naming Convention

**Description:** The Vikunja API uses snake_case field naming convention in responses (e.g., `due_date`, `start_date`, `percent_done`), which matches the node-vikunja Task interface definition.

**Note:** This is not an issue but a clarification for developers who might expect camelCase fields. The API consistently uses snake_case for all task fields.

**Example Task Response:**
```json
{
  "id": 1,
  "title": "Example Task",
  "due_date": "2024-12-31T23:59:59Z",
  "start_date": "2024-01-01T00:00:00Z", 
  "percent_done": 50,
  "hex_color": "#FF0000",
  "repeat_after": 86400,
  "done_at": null,
  "created_by": {...}
}
```

**Impact:** Ensure your code uses snake_case field names when accessing task properties from API responses.

**Workaround:** The MCP server now uses a hardcoded list of common webhook events when the API endpoint is unavailable:
- task.created, task.updated, task.deleted, task.assigned, task.comment.created
- project.created, project.updated, project.deleted, project.shared
- team.created, team.deleted

## 9. Filter Parameter Ignored (Issue verified 2025-05-28)

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

**MCP Server Workaround:** The vikunja-mcp server now implements comprehensive client-side filtering:
- Parses filter strings using the same syntax as Vikunja
- Evaluates filters against the fetched task list
- Supports all fields, operators, and complex expressions
- Adds `clientSideFiltering: true` to response metadata
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

*Last updated: 2025-05-28*
## 8. Project Archive/Unarchive Validation Error

**Status:** Workaround implemented (2025-05-28)

**Description:** The project archive and unarchive operations fail with "Struct is invalid. Invalid Data" error when only sending the `is_archived` field.

**Affected Endpoints:**
- `PUT /projects/{id}` - When archiving/unarchiving projects

**Reproduction:**
```bash
# This fails with "Struct is invalid" error
curl -X PUT 'https://your-vikunja-instance.com/api/v1/projects/1' \
  -H 'Authorization: Bearer YOUR_TOKEN' \
  -H 'Content-Type: application/json' \
  -d '{"is_archived": true}'
```

**Workaround:** Include the project title (and potentially other required fields) in the update request:
```bash
# This works
curl -X PUT 'https://your-vikunja-instance.com/api/v1/projects/1' \
  -H 'Authorization: Bearer YOUR_TOKEN' \
  -H 'Content-Type: application/json' \
  -d '{"title": "Project Title", "is_archived": true}'
```

**Impact:** The MCP server now includes the project title when archiving/unarchiving to work around this validation requirement.

## 11. Bucket `position: 0` Is Indistinguishable From Omitted (issue #173)

**Status:** Workaround implemented (2026-07-25, `src/tools/projects/kanban-setup.ts`)

**Description:** `models.Bucket.position` is a plain (non-pointer) `float64` on the wire. A client explicitly sending `"position": 0` is byte-for-byte indistinguishable, server-side, from a client that omitted `position` entirely. When Vikunja cannot tell the two apart, it substitutes its own id-derived default (`bucket.id * 65536`) instead of honoring "first in the ordering".

**Reproduction (live-verified against Vikunja 2.4.0):** `PUT` three buckets with `position: 0`, `position: 1`, `position: 2` respectively, then read them back via `GET /projects/{id}/views/{id}/buckets`:
```
sent position 0 -> server stored 8585216 (= bucket id 131 * 65536, its own default)
sent position 1 -> stored 1 (honored)
sent position 2 -> stored 2 (honored)
```
Resulting board order: Col-1, Col-2, &lt;default buckets&gt;, Col-0 — the column meant to be FIRST landed dead LAST.

**Workaround:** Never send a literal `position: 0`. `setupKanban`'s `bucketPositionForIndex` helper pins every bucket position to a **1-based**, 65536-spaced value (`(index + 1) * 65536`) — matching the `id * 65536` lane spacing Vikunja itself uses — so every value this composite sends is guaranteed non-zero and therefore always honored.

**Impact:** Any code that programmatically sets `Bucket.position` (not just `setup-kanban`) must avoid a literal `0` for the first item in an ordered sequence. This is easy to reintroduce by "simplifying" a 1-based position helper back to a 0-based `index * step` — see the comment on `bucketPositionForIndex` for why that would silently regress this fix.

## 12. v2 `PATCH /tasks/{id}` returns 422 for any subscribed task (Vikunja 2.4.0)

**Verified live** against a clean Vikunja `2.4.0` e2e stack, 2026-07-27.

`PATCH /api/v2/tasks/{id}` rejects any task that carries a `subscription`:

```
PATCH /api/v2/tasks/{id}    Content-Type: application/merge-patch+json
{"priority": 7}

→ 422 Unprocessable Entity
{"title":"Unprocessable Entity","status":422,"detail":"validation failed",
 "errors":[{"location":"body.subscription.entity","message":"expected integer","value":"task"}]}
```

The server round-trips the task's `subscription` object through validation, where
`subscription.entity` serializes as the string `"task"` while the v2 schema declares it an integer.
Server-side bug, not a client error.

**Why this bites hard:** assigning a user **auto-subscribes** them. A bare task has no subscription
and patches fine; the moment it gains an assignee, every later v2 `PATCH` 422s. That is exactly the
operation v2 adoption was meant to improve — updating a task without clobbering its assignees.

Measured on one task, in order:

| Step | Result |
|---|---|
| Fresh task, `PATCH {priority: 3}` | **200**, applied |
| Assign a user | `subscription` object appears |
| `PATCH {priority: 7}` | **422**, unchanged |
| `PATCH {priority: 9, subscription: null}` | **200** — applied, **assignees preserved** |
| `PATCH [{op:"replace",path:"/priority",...}]` (RFC 6902) | **422** — identical error |

**Workaround:** include `subscription: null` in the merge-patch body. The change applies, assignees
are preserved with no fetch-merge or snapshot/restore, and the subscription itself survives (the
server ignores the field). JSON Patch is **not** an alternative — it hits the same 422.

**This workaround has an expiry, and that matters.** The server ignoring `subscription: null` today
is incidental. A future Vikunja that honours merge-patch null semantics would interpret it as
"delete this field" and **silently unsubscribe users**. So it must be:

- applied only for affected server versions, never unconditionally, and
- pinned by a test that fails if a `PATCH` ever removes a subscription — so the semantics changing
  surfaces in CI rather than as quietly lost notifications.

**Impact:** blocks the v2 fast path for `vikunja_tasks update` until worked around or fixed upstream.
See [API-VERSION-MATRIX.md](API-VERSION-MATRIX.md) for which functions this affects.

**Related v2 findings from the same session** (not bugs, but behaviour a client must handle):

- v2 list endpoints wrap results in `{$schema, items, total, page, per_page, total_pages}`; v1
  returns a bare array. Callers expecting an array break unless the envelope is unwrapped.
- `GET /info` reports the version as `v2.4.0` — **with a leading `v`**, so a naive semver compare
  against `2.4.0` fails.
- `If-Match` is **not enforced**: a `PATCH` with a deliberately stale ETag succeeded (HTTP 200)
  rather than returning 412. v2's ETags are usable for cache validation (`If-None-Match` → 304
  works) but provide **no** optimistic-locking guarantee — do not build lost-update protection on
  them.
- `GET /projects/{project}/tasks` (new in v2) has no `view` parameter, so it cannot reproduce a
  view's bucket ordering. View-scoped listing must keep using
  `/projects/{project}/views/{view}/tasks`.

*These issues were discovered during development of the Vikunja MCP Server*