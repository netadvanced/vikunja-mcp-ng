# API Version Matrix — which Vikunja API version serves each MCP function

> **Status: PLANNED, not shipped.** As of this writing **no MCP function routes through v2** —
> the v2 transport, error adapter, routing decision, and kill switch exist (0.7.0 P1+P2) but are
> wired to nothing except `vikunja_auth`'s reporting. The **Planned path** column below describes
> the P3 target, not current behaviour. Rows flip as P3 lands, per the maintenance rule at the
> bottom.

## Why this document exists

Vikunja's v2 API is **not a superset of v1**. It adds partial updates (`PATCH`), markdown rendering,
pagination envelopes, and a uniform error model — and it drops capabilities v1 has. Some MCP
functions therefore stay on v1 permanently, and a few could use v2 but deliberately do not.

This table answers, per MCP function: *can v1 serve it, can v2 serve it, which do we use, and why*.
It is the document to check when a v2 quirk is suspected, without reading code.

For endpoint-level implementation coverage (which of Vikunja's 169 v1 operations this server
implements at all), see **[API-COVERAGE.md](API-COVERAGE.md)** — a different axis for a different
question. For known server-side bugs and their workarounds, see
**[VIKUNJA_API_ISSUES.md](VIKUNJA_API_ISSUES.md)**.

## How to read this

**`v1` / `v2` columns** — whether that API version can serve the function at all:

| | Meaning |
|:--:|---|
| ✅ | Every call the function makes has an equivalent in this version |
| ⚠️ | Partial — some calls have an equivalent, some do not (see Why) |
| ❌ | No equivalent; this version cannot serve the function |
| — | Function makes no Vikunja API call (local/composite only) |

**`Planned path`** — which version this server will actually use:

| Value | Meaning |
|---|---|
| **v2 →v1** | Uses v2 when the server supports it, automatically falls back to v1. The normal case |
| **v1 only** | No v2 equivalent exists. Permanent — not a migration backlog item |
| **v1 pinned** | v2 *could* serve it, but we deliberately use v1. The **Why** column gives the reason and, where applicable, the condition under which this would be revisited |
| **v1 (later)** | A v2 equivalent exists, but migrating this function is not scheduled in P3. Not a problem — just not yet done |
| **local** | No Vikunja API call |

`v1 pinned` is the row type worth scanning for: it means the capability exists in v2 but something —
a server bug, a missing partial-update route, an unverified behaviour change — makes v1 the honest
choice today. Distinguish it from `v1 (later)`, which is merely unscheduled work.

## Version selection is per-operation, not global

There is no "the server is in v2 mode". Each operation independently resolves its version from the
session's cached capability probe, and any operation can be on a different version from its
neighbour. This is permanent by design: several functions below have no v2 path at all, so a global
switch could never be correct.

Regardless of which version runs, **callers see identical output**. v2's pagination envelope is
unwrapped, `$schema` stripped, and errors normalized to the same `MCPError` shape v1 produces,
before any result leaves the internal strategy layer. The version in use is observable only via
`vikunja_auth status` (`activeApiVersion`).

The `featureFlags.forceV1Api` config key (env: `VIKUNJA_MCP_FORCE_V1_API`) forces every function to
the v1 column — see [CONFIGURATION.md](CONFIGURATION.md#forcing-the-v1-api).

## Summary

**183 MCP functions** across 27 tools. Derived from the vendored specs and the tool sources; verb
changes were matched on resource + intent, so a v1→v2 verb rename is **not** counted as a gap.

| Planned path | Count | |
|---|--:|---|
| **v2 →v1** | 19 | P3 targets — v2 when available, v1 fallback |
| **v1 (later)** | 149 | v2 equivalent exists; migration not scheduled in P3 |
| **v1 pinned** | 3 | v2 exists but offers no benefit — see rows for reasons |
| **v1 only** | 3 | No v2 equivalent. Permanent |
| **local** | 9 | No Vikunja API call |
| **Total** | **183** | |

Counts are recounted from the row markers, never hand-adjusted:
`grep -cF '| **v2 →v1** |' docs/API-VERSION-MATRIX.md` (and equivalents), applied to the sections
below the summary.

The three permanent `v1 only` functions:

| MCP function | Why |
|---|---|
| `vikunja_admin list-users` | v2 has no `GET /admin/users` (POST-only). Its `GET /users` is a *search* returning `User`, which omits `is_admin`, `status`, `issuer`, `subject`, `auth_provider` — the fields that make the listing useful |
| `vikunja_projects search-unsplash` | v2 has no Unsplash endpoints at all |
| `vikunja_projects set-unsplash-background` | Same. Note generic `remove-background` **does** exist in v2 |

## Tasks

`vikunja_tasks`, `vikunja_task_bulk`, `vikunja_task_assignees`, `vikunja_task_labels`,
`vikunja_task_comments`, `vikunja_task_relations`, `vikunja_task_reminders` — 56 functions, all with
full v2 equivalents.

| MCP function | v1 call(s) | v2 call(s) | Planned | Notes |
|---|---|---|---|---|
| `vikunja_tasks update` | `GET /tasks/{id}`; `POST /tasks/{id}`; `GET /tasks/{id}` | `GET`; `PATCH /tasks/{id}`; `GET` | **v2 (≥2.5.0) →v1** | Milestone payoff: PATCH + inline assignees replaces fetch-merge-POST. Carries a per-operation minimum server version of **2.5.0**: the subscription-422 (`VIKUNJA_API_ISSUES.md` #25) is fixed from 2.5.0 and unfixed on 2.4.0, so 2.4.0 stays on v1. No workaround is used (re-probed 2026-09-05) |
| `vikunja_tasks get` | `GET /tasks/{id}` | `GET /tasks/{id}` | **v2 →v1** | |
| `vikunja_tasks list` | `GET /tasks` or `GET /projects/{id}/tasks` | same | **v2 →v1** | v1's project-scoped route is undocumented; v2 documents it |
| `vikunja_tasks create` | `PUT /projects/{id}/tasks` | `POST /projects/{project}/tasks` | **v2 →v1** | v2 accepts `assignees` inline (labels still need a separate call) |
| `vikunja_tasks delete` | `GET /tasks/{id}` (best-effort); `DELETE` | same | v1 (later) | Context-fetch failure swallowed; delete proceeds |
| `vikunja_tasks add-reminder` | `GET /tasks/{id}`; `POST /tasks/{id}` | `GET`; `PUT /tasks/{id}` | v1 (later) | Reminders are a task field — no dedicated endpoint in either version |
| `vikunja_tasks list-reminders` | `GET /tasks/{id}` | `GET /tasks/{id}` | v1 (later) | |
| `vikunja_tasks remove-reminder` | `GET /tasks/{id}`; `POST /tasks/{id}` | `GET`; `PUT /tasks/{id}` | v1 (later) | |
| `vikunja_tasks apply-label` | `GET /tasks/{task}/labels`; `PUT /tasks/{task}/labels` | `GET`; `POST` | v1 (later) | `labelTitles` path also hits global `GET`/`PUT /labels` |
| `vikunja_tasks list-labels` | `GET /tasks/{task}/labels` | same | v1 (later) | |
| `vikunja_tasks remove-label` | `DELETE /tasks/{task}/labels/{label}` | same | v1 (later) | |
| `vikunja_tasks assign` | `PUT /tasks/{id}/assignees` | `POST /tasks/{id}/assignees` | v1 (later) | Per-assignee loop |
| `vikunja_tasks unassign` | `DELETE /tasks/{id}/assignees/{userID}` | same | v1 (later) | |
| `vikunja_tasks list-assignees` | `GET /tasks/{id}/assignees` | same | v1 (later) | |
| `vikunja_tasks comment` | `PUT /tasks/{id}/comments`; `GET` | `POST`; `GET` | v1 (later) | Dual-purpose: creates if text given, else lists |
| `vikunja_tasks attach` | `PUT /tasks/{id}/attachments` (multipart) | `POST /tasks/{task}/attachments` | v1 (later) | |
| `vikunja_tasks list-attachments` | `GET /tasks/{id}/attachments` | same | v1 (later) | |
| `vikunja_tasks get-attachment-info` | `GET /tasks/{id}/attachments` (filtered client-side) | same | v1 (later) | No single-attachment metadata endpoint in either version |
| `vikunja_tasks delete-attachment` | `DELETE /tasks/{id}/attachments/{attachmentID}` | same | v1 (later) | |
| `vikunja_tasks download-attachment` | `GET /tasks/{id}/attachments/{id}` (not invoked) | same | v1 (later) | No MCP binary channel; returns URL + auth guidance |
| `vikunja_tasks relate` | `PUT /tasks/{id}/relations`; `GET /tasks/{id}` | `POST`; `GET` | v1 (later) | |
| `vikunja_tasks unrelate` | `DELETE /tasks/{id}/relations/{kind}/{otherID}`; `GET` | same | v1 (later) | |
| `vikunja_tasks relations` | `GET /tasks/{id}` | same | v1 (later) | |
| `vikunja_tasks create-subtask` | 8-call composite (resolve → create → label/assign → relate → bucket → verify) | same shape, v2 verbs | v1 (later) | |
| `vikunja_tasks bulk-create-subtasks` | Per-subtask repeat of the above | same | v1 (later) | |
| `vikunja_tasks list-subtasks` | `GET /tasks/{id}` | same | v1 (later) | |
| `vikunja_tasks duplicate` | `PUT /tasks/{id}/duplicate` | `POST /tasks/{id}/duplicate` | v1 (later) | |
| `vikunja_tasks get-by-index` | `GET /projects/{project}/tasks/by-index/{index}` | same | v1 (later) | Verb unchanged |
| `vikunja_tasks mark-read` | `POST /tasks/{id}/read` | `PUT /tasks/{id}/read` | v1 (later) | |
| `vikunja_tasks set-bucket` | `GET /tasks/{id}`; `GET .../views`; `POST .../buckets/{bucket}/tasks` | `GET`; `GET`; `PUT` | v1 (later) | Resolution GETs conditional |
| `vikunja_tasks set-position` | `GET /tasks/{id}`; `GET .../views`; `POST /tasks/{id}/position` | `GET`; `GET`; `PUT` | v1 (later) | |
| `vikunja_tasks bulk-create` | `PUT /projects/{id}/tasks`; `POST .../labels/bulk`; `PUT .../assignees`; `GET` | v2 verbs | v1 (later) | Label/assignee calls conditional per item |
| `vikunja_tasks bulk-update` | `GET /tasks/{id}`; `POST /tasks/bulk`; `POST .../assignees/bulk` | `GET`; `PUT /tasks/bulk`; `PUT` | **v2 →v1** | Verb change only. Does **not** retire the assignee snapshot/restore: v2 `PUT /tasks/bulk` wipes assignees exactly as v1 does (re-probed live on 2.6.0, 2026-09-05), because both route into the same `models.BulkTask.Update()` chain |
| `vikunja_tasks bulk-delete` | `GET /tasks/{id}`; `DELETE /tasks/{id}` | same | v1 (later) | |
| `vikunja_tasks bulk-set-bucket` | `GET /tasks/{id}`; `GET .../views`; `POST .../buckets/{bucket}/tasks` | `GET`; `GET`; `PUT` | v1 (later) | |
| `vikunja_task_bulk bulk-create` | As `vikunja_tasks bulk-create` | same | v1 (later) | |
| `vikunja_task_bulk bulk-update` | As `vikunja_tasks bulk-update` | same | **v2 →v1** | Verb change only. Does **not** retire the assignee snapshot/restore: v2 `PUT /tasks/bulk` wipes assignees exactly as v1 does (re-probed live on 2.6.0, 2026-09-05), because both route into the same `models.BulkTask.Update()` chain |
| `vikunja_task_bulk bulk-delete` | As `vikunja_tasks bulk-delete` | same | v1 (later) | |
| `vikunja_task_bulk bulk-set-bucket` | As `vikunja_tasks bulk-set-bucket` | same | v1 (later) | |
| `vikunja_task_assignees assign` | `PUT /tasks/{id}/assignees` | `POST /tasks/{id}/assignees` | v1 (later) | |
| `vikunja_task_assignees unassign` | `DELETE /tasks/{id}/assignees/{userID}` | same | v1 (later) | |
| `vikunja_task_assignees list-assignees` | `GET /tasks/{id}/assignees` | same | v1 (later) | |
| `vikunja_task_labels apply-label` | `GET /tasks/{task}/labels`; `PUT` | `GET`; `POST` | v1 (later) | |
| `vikunja_task_labels list-labels` | `GET /tasks/{task}/labels` | same | v1 (later) | |
| `vikunja_task_labels remove-label` | `DELETE /tasks/{task}/labels/{label}` | same | v1 (later) | |
| `vikunja_task_comments comment` | `PUT /tasks/{id}/comments`; `GET` | `POST`; `GET` | v1 (later) | |
| `vikunja_task_comments list` | `GET /tasks/{id}/comments` | same | v1 (later) | |
| `vikunja_task_comments get` | `GET /tasks/{id}/comments/{commentID}` | same | v1 (later) | |
| `vikunja_task_comments update` | `POST /tasks/{id}/comments/{commentID}` | `PATCH /tasks/{task}/comments/{commentid}` | **v2 →v1** | True partial update |
| `vikunja_task_comments delete` | `DELETE /tasks/{id}/comments/{commentID}` | same | v1 (later) | |
| `vikunja_task_relations relate` | `PUT /tasks/{id}/relations`; `GET` | `POST`; `GET` | v1 (later) | |
| `vikunja_task_relations unrelate` | `DELETE .../relations/{kind}/{otherID}`; `GET` | same | v1 (later) | |
| `vikunja_task_relations relations` | `GET /tasks/{id}` | same | v1 (later) | |
| `vikunja_task_reminders add-reminder` | `GET /tasks/{id}`; `POST /tasks/{id}` | `GET`; `PUT` | v1 (later) | |
| `vikunja_task_reminders list-reminders` | `GET /tasks/{id}` | same | v1 (later) | |
| `vikunja_task_reminders remove-reminder` | `GET /tasks/{id}`; `POST /tasks/{id}` | `GET`; `PUT` | v1 (later) | |

## Projects

`vikunja_projects` — 44 functions. Two have no v2 path (Unsplash); the rest are full.

| MCP function | v1 call(s) | v2 call(s) | Planned | Notes |
|---|---|---|---|---|
| `vikunja_projects update` | `GET /projects/{id}`; `POST /projects/{id}` | `GET`; `PATCH /projects/{id}` | **v2 →v1** | PATCH removes the fetch-merge |
| `vikunja_projects archive` | `GET /projects/{id}`; `POST /projects/{id}` | `GET`; `PATCH` | **v2 →v1** | |
| `vikunja_projects unarchive` | `GET /projects/{id}`; `POST /projects/{id}` | `GET`; `PATCH` | **v2 →v1** | |
| `vikunja_projects move` | `GET /projects` (fetch-all); `POST /projects/{id}` | `GET`; `PATCH` | **v2 →v1** | |
| `vikunja_projects update-view` | `GET .../views/{view}`; `POST .../views/{view}` | `GET`; `PATCH .../views/{view}` | **v2 →v1** | |
| `vikunja_projects set-done-bucket` | `[GET views]`; `GET .../views/{view}`; `POST .../views/{view}` | `GET`; `GET`; `PATCH` | **v2 →v1** | |
| `vikunja_projects get` | `GET /projects/{id}` | same | **v2 →v1** | |
| `vikunja_projects list` | `GET /projects` | same | **v2 →v1** | |
| `vikunja_projects create` | `PUT /projects` | `POST /projects` | v1 (later) | |
| `vikunja_projects delete` | `GET /projects/{id}`; `DELETE` | same | v1 (later) | |
| `vikunja_projects duplicate` | `PUT /projects/{id}/duplicate` | `POST /projects/{id}/duplicate` | v1 (later) | |
| `vikunja_projects get-tree` | `GET /projects` (fetch-all) | same | v1 (later) | |
| `vikunja_projects get-children` | `GET /projects/{id}`; `GET /projects` | same | v1 (later) | |
| `vikunja_projects get-breadcrumb` | `GET /projects` (fetch-all) | same | v1 (later) | |
| `vikunja_projects create-view` | `PUT .../views` | `POST .../views` | v1 (later) | |
| `vikunja_projects get-view` | `GET .../views/{view}` | same | v1 (later) | |
| `vikunja_projects list-views` | `GET .../views` | same | v1 (later) | |
| `vikunja_projects delete-view` | `DELETE .../views/{view}` | same | v1 (later) | |
| `vikunja_projects list-view-tasks` | `[GET views]`; `GET .../views/{view}/tasks` | same | v1 (later) | **Must stay view-scoped.** v2's `GET /projects/{project}/tasks` has no `view` param, so it cannot reproduce bucket/view ordering |
| `vikunja_projects create-bucket` | `[GET views]`; `PUT .../buckets` | `[GET]`; `POST .../buckets` | v1 (later) | |
| `vikunja_projects list-buckets` | `[GET views]`; `GET .../buckets` | same | v1 (later) | |
| `vikunja_projects update-bucket` | `[GET views]`; `GET .../buckets`; `POST .../buckets/{bucket}` | `[GET]`; `GET`; `PUT .../buckets/{bucket}` | **v1 pinned** | v2 has **no `PATCH`** for buckets (verified live: 405), so the fetch-merge stays either way. No benefit to switching |
| `vikunja_projects delete-bucket` | `[GET views]`; `GET .../buckets`; `DELETE .../buckets/{bucket}` | same | v1 (later) | |
| `vikunja_projects setup-kanban` | Large composite (project, views, buckets, tasks, labels, bucket assignment) | same shape, v2 verbs | v1 (later) | Every constituent call has a v2 equivalent |
| `vikunja_projects add-project-user` | `PUT /projects/{id}/users` | `POST /projects/{project}/users` | v1 (later) | |
| `vikunja_projects add-project-team` | `PUT /projects/{id}/teams` | `POST /projects/{project}/teams` | v1 (later) | |
| `vikunja_projects list-project-users` | `GET /projects/{id}/users` | same | v1 (later) | |
| `vikunja_projects list-project-teams` | `GET /projects/{id}/teams` | same | v1 (later) | |
| `vikunja_projects list-members` | `GET .../users`; `GET .../teams`; `GET .../shares` | same | v1 (later) | Composite |
| `vikunja_projects remove-project-user` | `DELETE /projects/{id}/users/{userID}` | same | v1 (later) | |
| `vikunja_projects remove-project-team` | `DELETE /projects/{id}/teams/{teamID}` | same | v1 (later) | |
| `vikunja_projects update-project-user-permission` | `POST /projects/{id}/users/{userID}` | `PUT /projects/{project}/users/{user}` | **v1 pinned** | v2 has no `PATCH` here either — `PUT` is the only update verb. No partial-update benefit |
| `vikunja_projects update-project-team-permission` | `POST /projects/{id}/teams/{teamID}` | `PUT /projects/{project}/teams/{team}` | **v1 pinned** | Same — no `PATCH`, no benefit |
| `vikunja_projects search-project-users` | `GET /projects/{id}/projectusers` | `GET /projects/{project}/users/search` | v1 (later) | Renamed, not removed |
| `vikunja_projects share-with-user` | `GET /users`; `PUT .../users`; `GET .../users` | `GET`; `POST`; `GET` | v1 (later) | Search param `s`→`q` |
| `vikunja_projects share-with-team` | `GET /teams`; `PUT .../teams`; `GET .../teams` | `GET`; `POST`; `GET` | v1 (later) | |
| `vikunja_projects create-share` | `GET /projects/{id}`; `PUT .../shares` | `GET`; `POST .../shares` | v1 (later) | |
| `vikunja_projects list-shares` | `GET /projects/{id}`; `GET .../shares` | same | v1 (later) | |
| `vikunja_projects get-share` | `GET .../shares` (list; by-id 404s on 2.3.0) | `GET .../shares/{share}` | v1 (later) | **Verified: this is a server-version fix, not a v2 fix.** By-id returns 404 on 2.3.0 and 200 on 2.4.0 — on *both* API versions. The list-route workaround stays while the floor is 2.3.0, and drops for both versions when the floor rises |
| `vikunja_projects delete-share` | `GET .../shares`; `DELETE .../shares/{share}` | same | v1 (later) | |
| `vikunja_projects auth-share` | `POST /shares/{hash}/auth` | `POST /shares/{share}/auth` | v1 (later) | |
| `vikunja_projects remove-background` | `DELETE /projects/{id}/background` | same | v1 (later) | Generic removal — unaffected by the Unsplash gap |
| `vikunja_projects search-unsplash` | `GET /backgrounds/unsplash/search` | ❌ — | **v1 only** | v2 has no Unsplash endpoints |
| `vikunja_projects set-unsplash-background` | `POST /projects/{id}/backgrounds/unsplash` | ❌ — | **v1 only** | v2 has no Unsplash endpoints |

## Labels, teams, filters, webhooks, subscriptions, notifications, reactions

42 functions, all with full v2 equivalents.

| MCP function | v1 call(s) | v2 call(s) | Planned | Notes |
|---|---|---|---|---|
| `vikunja_labels update` | `PUT /labels/{id}` | `PATCH /labels/{id}` | **v2 →v1** | v2 splits PATCH (partial) / PUT (replace); PATCH matches actual semantics |
| `vikunja_labels create` | `PUT /labels` | `POST /labels` | v1 (later) | |
| `vikunja_labels get` | `GET /labels/{id}` | same | v1 (later) | |
| `vikunja_labels list` | `GET /labels` | same | v1 (later) | |
| `vikunja_labels delete` | `DELETE /labels/{id}` | same | v1 (later) | |
| `vikunja_labels ensure` | `GET /labels?s=`; `PUT /labels` (conditional) | `GET ?q=`; `POST` | v1 (later) | Search param `s`→`q` |
| `vikunja_filters update` | `GET /filters/{id}`; `POST /filters/{id}` (replace) | `GET`; `PATCH /filters/{filter}` | **v2 →v1** | |
| `vikunja_filters create` | `PUT /filters` | `POST /filters` | v1 (later) | |
| `vikunja_filters get` | `GET /filters/{id}` | same | v1 (later) | |
| `vikunja_filters list` | `GET /projects`; `GET /filters/{id}` per entry | same | v1 (later) | N+1 in both — no list-all-filters endpoint |
| `vikunja_filters delete` | `GET /filters/{id}`; `DELETE` | same | v1 (later) | |
| `vikunja_filters build` | (local only) | — | **local** | Pure `FilterBuilder` |
| `vikunja_filters validate` | (local only) | — | **local** | Pure parse/validate |
| `vikunja_teams update` | `POST /teams/{id}` | `PATCH /teams/{id}` | **v2 →v1** | |
| `vikunja_teams create` | `PUT /teams` | `POST /teams` | v1 (later) | |
| `vikunja_teams get` | `GET /teams/{id}` | same | v1 (later) | |
| `vikunja_teams list` | `GET /teams` | same | v1 (later) | |
| `vikunja_teams delete` | `DELETE /teams/{id}` | same | v1 (later) | |
| `vikunja_teams members add` | `PUT /teams/{id}/members` | `POST /teams/{team}/members` | v1 (later) | |
| `vikunja_teams members list` | `GET /teams/{id}` (embedded) | same | v1 (later) | No dedicated members-list endpoint |
| `vikunja_teams members remove` | `DELETE /teams/{id}/members/{username}` | same | v1 (later) | |
| `vikunja_teams members toggleAdmin` | `POST /teams/{id}/members/{username}/admin` | same | v1 (later) | Pure toggle, no body, both versions |
| `vikunja_webhooks create (project)` | `PUT /projects/{id}/webhooks` | `POST` | v1 (later) | |
| `vikunja_webhooks create (user)` | `PUT /user/settings/webhooks` | `POST` | v1 (later) | **JWT-only on both versions** (verified) |
| `vikunja_webhooks list (project)` | `GET /projects/{id}/webhooks` | same | v1 (later) | |
| `vikunja_webhooks list (user)` | `GET /user/settings/webhooks` | same | v1 (later) | **JWT-only on both versions** (verified: 401 under `tk_*`) |
| `vikunja_webhooks get (project)` | `GET /projects/{id}/webhooks` (list+find) | same | v1 (later) | No single-webhook GET in either version |
| `vikunja_webhooks get (user)` | `GET /user/settings/webhooks` (list+find) | same | v1 (later) | |
| `vikunja_webhooks update (project)` | `POST .../webhooks/{id}` (events-only) | `PUT .../webhooks/{webhook}` | v1 (later) | v2 uses `PUT`, not `PATCH`, for this partial update |
| `vikunja_webhooks update (user)` | `POST /user/settings/webhooks/{id}` | `PUT` | v1 (later) | Same `PUT`-not-`PATCH` quirk |
| `vikunja_webhooks delete (project)` | `DELETE /projects/{id}/webhooks/{id}` | same | v1 (later) | |
| `vikunja_webhooks delete (user)` | `DELETE /user/settings/webhooks/{id}` | same | v1 (later) | |
| `vikunja_webhooks list-events (project)` | `GET /webhooks/events` | same | v1 (later) | |
| `vikunja_webhooks list-events (user)` | `GET /user/settings/webhooks/events` | same | v1 (later) | |
| `vikunja_subscriptions subscribe` | `PUT /subscriptions/{entity}/{id}` | `POST` | v1 (later) | |
| `vikunja_subscriptions unsubscribe` | `DELETE /subscriptions/{entity}/{id}` | same | v1 (later) | |
| `vikunja_notifications list` | `GET /notifications` | same | v1 (later) | v2 adds `q` search and a `.atom` feed (unused) |
| `vikunja_notifications mark-read` | `POST /notifications/{id}` (toggle, up to 2 calls) | `PUT /notifications/{id}` (sets state) | **v2 →v1** | v2 sets state explicitly — removes the toggle workaround and a possible second call |
| `vikunja_notifications mark-all-read` | `POST /notifications` | same | v1 (later) | |
| `vikunja_reactions add` | `PUT /{kind}/{id}/reactions` | `POST` | v1 (later) | |
| `vikunja_reactions list` | `GET /{kind}/{id}/reactions` | same | v1 (later) | |
| `vikunja_reactions remove` | `POST /{kind}/{id}/reactions/delete` | same | v1 (later) | Delete-via-POST in both |

## Users, admin, auth, tokens, export, templates, batch import

41 functions. One has no v2 path (`admin list-users`); several make no API call.

| MCP function | v1 call(s) | v2 call(s) | Planned | Notes |
|---|---|---|---|---|
| `vikunja_admin list-users` | `GET /admin/users` | ❌ — | **v1 only** | v2 `/admin/users` is POST-only; `GET /users` search omits the admin fields |
| `vikunja_admin create-user` | `POST /admin/users` | same | v1 (later) | |
| `vikunja_admin delete-user` | `DELETE /admin/users/{id}` | same | v1 (later) | |
| `vikunja_admin list-projects` | `GET /admin/projects` | same | v1 (later) | Search param `s`→`q` |
| `vikunja_admin overview` | `GET /admin/overview` | same | v1 (later) | |
| `vikunja_admin set-project-owner` | `PATCH /admin/projects/{id}/owner` | same | v1 (later) | Already `PATCH` in v1 |
| `vikunja_admin set-user-admin` | `PATCH /admin/users/{id}/admin` | same | v1 (later) | |
| `vikunja_admin set-user-status` | `PATCH /admin/users/{id}/status` | same | v1 (later) | |
| `vikunja_auth connect` | `GET /info`; `GET /user` or `GET /projects?per_page=1` | same | v1 (later) | Also probes `GET /api/v2/openapi.json` for capability detection |
| `vikunja_auth info` | `GET /info` | same | v1 (later) | |
| `vikunja_auth status` | (local only) | — | **local** | Reads cached session state; reports `activeApiVersion` |
| `vikunja_auth refresh` | (local only) | — | **local** | Describes but never calls `POST /user/token/refresh` |
| `vikunja_auth disconnect` | (local only) | — | **local** | |
| `vikunja_users current` | `GET /user` | same | v1 (later) | |
| `vikunja_users settings` | `GET /user` | same | v1 (later) | |
| `vikunja_users update-settings` | `POST /user/settings/general`; `GET /user` | `PUT`; `GET` | v1 (later) | |
| `vikunja_users search` | `GET /users?s=` | `GET /users?q=` | v1 (later) | Param rename; response lacks admin fields in both |
| `vikunja_users timezones` | `GET /user/timezones` | same | v1 (later) | |
| `vikunja_users get-avatar` | `GET /user/settings/avatar` | `GET /user/settings/avatar/provider` | v1 (later) | v2 splits provider-get from the image endpoint |
| `vikunja_users set-avatar` | `POST /user/settings/avatar` | `PUT`/`PATCH /user/settings/avatar/provider` | v1 (later) | |
| `vikunja_users upload-avatar` | `PUT /user/settings/avatar/upload` | `PUT /user/settings/avatar` | v1 (later) | v2 folds provider-set into the upload |
| `vikunja_tokens create` | `PUT /tokens` | `POST /tokens` | v1 (later) | |
| `vikunja_tokens list` | `GET /tokens` | same | v1 (later) | Param `s`→`q`; v2 adds `owner_id` filter |
| `vikunja_tokens delete` | `DELETE /tokens/{tokenID}` | `DELETE /tokens/{id}` | v1 (later) | |
| `vikunja_caldav_tokens create` | `PUT /user/settings/token/caldav` | `POST` | v1 (later) | |
| `vikunja_caldav_tokens list` | `GET /user/settings/token/caldav` | same | v1 (later) | |
| `vikunja_caldav_tokens delete` | `DELETE /user/settings/token/caldav/{id}` | same | v1 (later) | |
| `vikunja_user_deletion request` | `POST /user/deletion/request` | same | v1 (later) | |
| `vikunja_user_deletion confirm` | `POST /user/deletion/confirm` | same | v1 (later) | |
| `vikunja_user_deletion cancel` | `POST /user/deletion/cancel` | same | v1 (later) | |
| `vikunja_request_user_export` | `POST /user/export/request` | same | v1 (later) | |
| `vikunja_user_export_status` | `GET /user/export` | same | v1 (later) | |
| `vikunja_download_user_export` | `POST /user/export/download` | same | v1 (later) | Never returns file bytes in either version |
| `vikunja_export_project` | `GET /projects/{id}`; `GET /projects/{id}/tasks`; `GET /labels/{id}`; `GET /projects` | same | v1 (later) | v1's project-tasks route is undocumented; v2 documents it |
| `vikunja_batch_import` | `GET /labels`; `GET /users?s=`; `PUT .../tasks`; `POST .../labels/bulk`; `GET`; `PUT .../assignees` | v2 verbs, `?q=` | v1 (later) | Composite. `dryRun` makes no call |
| `vikunja_templates create` | `GET /projects/{id}`; `GET /projects/{id}/tasks` | same | v1 (later) | Template itself saved to local storage |
| `vikunja_templates instantiate` | `PUT /projects`; `PUT .../tasks`; `POST .../labels/bulk` | `POST`; `POST`; `PUT` | v1 (later) | |
| `vikunja_templates get` | (local storage only) | — | **local** | |
| `vikunja_templates list` | (local storage only) | — | **local** | |
| `vikunja_templates update` | (local storage only) | — | **local** | |
| `vikunja_templates delete` | (local storage only) | — | **local** | |

## Verified behaviours that the specs get wrong

Live-tested against local 2.4.0 and 2.3.0 stacks. Recorded because the vendored specs are
misleading on each point, and a future reader would otherwise re-derive the wrong conclusion.

| Claim | Reality |
|---|---|
| v2 relaxes webhook auth to accept API tokens (v2's spec has no per-path `security` override, v1's restricts to `JWTKeyAuth`) | **False — the specs are wrong in both directions.** Verified under a `tk_*` token on 2.4.0: *project*-scoped webhooks (list, events, create) are **accepted** by both v1 and v2 (200/201) despite v1's spec marking them JWT-only; *user*-scoped webhooks are **rejected** (401) by both. Behaviour is identical across versions — v2's missing override is a spec-generation gap, not a relaxation |
| v2 fixes the link-share by-id 404 | **Not a v2 fix — a server-version fix.** `GET /projects/{p}/shares/{s}` returns 404 on 2.3.0 and 200 on 2.4.0, on **both** API versions. The list-route workaround is gated on server version, not API version, and stays while the supported floor is 2.3.0 |

(On a 2.3.0 stack every `/api/v2/*` request 404s, since that release has no v2 API at all — expected,
and the reason `hasV2Api` gates everything.)

## Cross-cutting v2 differences

These affect many rows and are handled centrally rather than per-function:

| Difference | Handling |
|---|---|
| List responses wrapped in `{$schema, items, total, page, per_page, total_pages}` | Envelope unwrapped at the strategy boundary; callers still receive an array |
| Search parameter renamed `s` → `q` | Translated inside the v2 strategy |
| REST verb convention rewritten (v1 `PUT`=create/`POST`=update; v2 `POST`=create/`PATCH`=partial/`PUT`=replace) | Per-row above; most "missing endpoint" appearances are actually verb changes |
| Errors are `application/problem+json` | Adapted to `MCPError`, preserving Vikunja's numeric `code` and per-field `errors[]` |
| `ETag` on most single-entity `GET`s | Not yet used. `If-Match` is **not** enforced by the server (verified), so it provides no lost-update protection |
| `?format=markdown` available for rich text | Planned for P3 reads |

## Maintenance rule

A row changes **in the same PR that changes the behaviour it describes** — never as a later
reconciliation pass. When a function moves from `v1 only` to `v2 →v1` because upstream shipped an
endpoint, or from `v2 →v1` to `v1 pinned` because a v2 bug was found, that edit belongs in the PR
that makes it true.

Verdicts here were derived from the vendored specs (`docs/vikunja-openapi.json`,
`docs/vikunja-openapi-v2.json`) and confirmed against a live Vikunja 2.4.0 stack where noted. When
the vendored specs are refreshed for a new Vikunja release, re-derive rather than assume.
