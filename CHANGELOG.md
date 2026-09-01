# Changelog

All notable changes to `vikunja-mcp-ng` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/) with
pre-1.0 semantics. See [docs/RELEASING.md](docs/RELEASING.md) for what that means in practice.

## [Unreleased]

### Fixed

- **Per-identity rate limiting now covers the whole tool surface, and its windows
  actually rotate.** Three defects, one guarantee. (1) Of the roughly two dozen tools this
  server registers, only `vikunja_auth` was wrapped in the rate-limit middleware, so in
  `oidc-http` mode (one process, many accounts) every other tool was unmetered per
  identity. Every tool now registers through a rate-limiting view of the MCP server, so
  being registered is what makes a tool metered. (2) Where the middleware was wired it did
  not work: the counter store was never given its window length, so no window ever expired
  and "60 requests per minute" was really 60 per process lifetime — the 61st call ever made
  returned a misleading 429 until the server restarted. (3) The hourly limit was counted in
  one place and read from another, so it could never trip. This matters beyond one user's
  own budget: `docs/ROADMAP.md` decision 16(c) accepts sharing circuit breakers across
  accounts specifically because per-user rate limits are supposed to contain a noisy
  neighbour, and until now they did not. `vikunja_task_bulk` also moves to the bulk budget,
  where it belongs. (#263)
- **"Reset this user's rate limits" no longer resets everyone's.** `clearSession(sessionId)`
  ignored the id it was given and cleared every identity's counters plus both shared circuit
  breakers. It has no callers today, which is exactly why it is fixed now rather than after
  something starts calling it. (#296, LOW-18)
- **A tool call that hits its execution deadline now actually cancels the work.** The
  deadline was a timer that was never cleared (so a fast call left one armed for up to the
  full timeout, ten minutes for exports) and that did nothing to the operation it timed out
  — the caller was told the call timed out while the request kept running and could still
  commit a write. The deadline now aborts the in-flight HTTP request, reports honestly that
  the outcome is unknown and should be re-checked rather than blindly retried, and does not
  count against the shared circuit breakers. (#296, LOW-20)


## [0.7.0-beta.3] - 2026-09-01

_Draft generated from conventional commits by scripts/release-prepare.sh — curate before merging._

### Fixed

- stop false-positiving on free-text descriptions, make create/update consistent
- send explicit read:true instead of the non-functional empty-body toggle
- validate base64 shape before decoding upload-avatar fileContent
- allowlist the Host header used in discovery metadata (#292 LOW-19)
- escape the issuer|sub delimiter in identityKey (#292 LOW-11)
- enforce the normalized-key cache's advertised max size (#292 LOW-14)
- stop flagging REST paths and version strings as credentials (#292 LOW-13)
- mask OIDC identity values in logs (#292 MED-15)
- key event-validation cache by identity, not globally (#292 MED-9)
- report instantiate as failed when a task or label fails
- scope persisted templates to their owning identity
- scope templates by namespace, not a name-prefix convention
- fix idle-eviction race that silently drops persisted templates
- coordinate concurrent per-project budget checks when autoPaginate is false (audit #290 MED-19, verified)
- preserve quoting on re-serialization for values needing it (audit #290 MED-4)
- respect quote boundaries when splitting in/not-in comma lists (audit #290 MED-4/5, MED-5 part)
- treat dueDate zero-date sentinel as unset, same as startDate/endDate/doneAt (#285)
- reject unparenthesized mixed && / || instead of silently collapsing (#272)
- paginate list and fix zero-time read_at handling (#289 HIGH-18, #286 HIGH-15)
- flag possible truncation on list-assignees/attachments/labels/teams (#289 HIGH-18 spot-check)
- paginate list-comments (#289 HIGH-18)
- warn when cross-project-only listing params are ignored (#290 LOW-3)
- thread orderBy/filterTimezone/filterIncludeNulls through the cross-project fallback (#290 MED-7)
- flag truncation on the first-page-short budget-cut branch (#290 MED-6)
- paginate cross-project and server-side task listing (#268)
- retry the jose import after a transient load failure
- fix breaker name-collision fallback for a third anonymous op
- add the missing preRequest marker to the multipart error path
- stop re-multiplying repeat_after on a repeatMode-only update
- make per-identity rate limiting real across the tool surface
- redact credentials on the thrown-error and REST-response surface
- surface an aborted import as an error with its partial-result summary (#269)
- reject non-integer CSV numerics and recognize common done spellings (LOW-7, LOW-8 from #294)
- honor skipErrors for JSON imports like CSV already does (MED-14 from #294)
- parse CSV quotes before splitting rows, fixing multiline fields (#275)
- include reminders in the task creation body instead of dropping them (#284)
- stop misdiagnosing "search found nobody" as an auth failure (#283)
- paginate label lookup during import (MED-10 from #294)
- paginate share-with-user/team's atomic verification read
- keep per-index error detail when every bulk-create task fails
- strip password from create-share response
- paginate the share-by-id list lookup
- resolve JWT gating, connect reconnects and user names per caller
- share one semaphore per BatchProcessor so concurrency binds across requests
- report get-tree truncation at maxDepth (#291 LOW-2)
- stop rejecting right:0 (read-only) at dispatch time
- surface teams-read failure honestly in list-members
- fsync atomic writes so a provision survives power loss
- never repurpose the kanban view's done-bucket in setup-kanban (#273)
- stop misreporting parent-not-found on a failed fetch (#291 LOW-1)
- close three silent-data-loss paths in bulk-update assignee snapshot/restore
- report real decrypt health in status and write lastUsedAt
- verify label/assignee attach PUTs with a post-attach read
- only mutate the in-memory map after the write succeeds
- normalize add-reminder's date through normalizeDateForApi
- refuse to write the vault back after an incomplete load
- align affectedFields reporting with the merge logic
- carry response.success through to formatted metadata
- validate base64 shape before decoding fileContent
- bind AES-GCM records to identity and vikunjaUrl via AAD
- wire _metadata into project response payloads (#280)

### Documentation

- clarify enrollment identity-pinning matching behavior (#223, #224)
- record the live-verified label/assignee attach contract (#295 LOW-22)
- state that oidc-http mode is single-process per vault file

### Chores

- keep the fsync durability tests under writeTemplatesFileAtomic
- remove dead storage-layer filter modules
- match paginated GET /labels in the tool-level mock (MED-10 from #294)

## [0.7.0-beta.2] - 2026-09-01

**A correctness pass over the whole write surface, and one breaking change.** Nearly every
entry below shares a single shape: the tool reported success while what you asked for did
not happen. A field you sent was silently dropped. A partial update wiped settings you never
mentioned. A filter written the documented way matched nothing. A listing returned page one
of four and called it the answer. Every instance found is now either honoured properly or
refused with an error naming the field and what to use instead. The three that
destroyed or duplicated your data are called out first, under **Fixed: data loss and
duplicate writes**.
The breaking change riding along: **`percentDone` is a whole percentage 0-100**, not a 0-1
fraction. And one change that is about your server rather than your calls: **the minimum
supported Vikunja is now 2.4.0**. 2.3.0 is no longer supported.

### Changed

- **BREAKING: `percentDone` is now a whole percentage 0-100 (integers only), everywhere
  on the tool surface.** It was a fraction 0-1, which is Vikunja's own wire contract for
  `models.Task.percent_done`. It still is on the wire; this server now converts in both
  directions at its boundary (`src/utils/percent-done.ts`) instead of making agents
  memorize it.

  **Migration: what you send now versus before:**

  | You mean | Send now | Used to send |
  |---|---|---|
  | 0% | `percentDone: 0` | `percentDone: 0` |
  | half done | `percentDone: 50` | `percentDone: 0.5` |
  | 75% | `percentDone: 75` | `percentDone: 0.75` |
  | fully done | `percentDone: 100` | `percentDone: 1` |

  A fraction is now a validation error naming the scale (*"percentDone must be a whole
  number between 0 and 100 — use 50 for 50%"*), so `0.5` and `0.75` fail loudly. **The one
  silent change is `percentDone: 1`**, which is still valid and now means **1%, not 100%**.
  Audit any caller that used `1` for "done" and change it to `100`.

  **Why now:** the fraction leaked an implementation detail agents had to memorize (a real
  Claude session recorded the 0-1 scale in its list of "gotchas", a memory that dies with
  the session and transfers to no other MCP client), Vikunja's own human-facing scale is
  0-100, two independent upstream contributors
  (democratize-technology/vikunja-mcp#94, #82) assumed 0-100, and the integer requirement
  is a safety property: under 0-1, an agent writing `percentDone: 1` meaning "done"
  silently wrote 1% with no error. Cheap on `0.7.0-beta`, expensive after issue #183
  declares the tool surface stable at 1.0. Full reasoning and revisit condition:
  decision 22 in [docs/ROADMAP.md](docs/ROADMAP.md) §3.

  **Scope: one scale, no exceptions:** `vikunja_tasks` `create`/`update`/`bulk-create`/
  `create-subtask`/`bulk-create-subtasks`, `vikunja_task_bulk` `bulk-create` and
  `bulk-update`'s raw `percent_done` field, `vikunja_projects setup-kanban`'s per-task
  shape, `vikunja_batch_import` (JSON and CSV), and `percentDone` inside a filter string,
  including saved filters, which are stored on the Vikunja server in its own scale and
  converted back to 0-100 when read, so `get` → edit → `update` round-trips instead of
  rescaling twice.

- **A field this server cannot honour is now refused, never quietly ignored.** Zod strips
  undeclared object keys by default, so a per-task field an agent invented (or reached for
  from a sibling shape) used to vanish with no error while the call reported success. The
  four closed nested array-of-object shapes (`vikunja_projects setup-kanban`'s `tasks[]`,
  `vikunja_tasks`' `tasks[]` and `subtasks[]`, `vikunja_task_bulk`'s `tasks[]`) are now
  strict: an unrecognized key fails the call with an error naming it, listing what the shape
  accepts, and pointing at the tool that owns the field. Top-level tool shapes stay
  deliberately permissive: they are shared across subcommands and legitimately tolerate
  `id`/`projectId` aliases and parameters carried between calls. Confirmed live: a battle
  run asked for a task "75% done", the model sent one `setup-kanban` call carrying
  `percentDone: 75`, and the task was created at 0% with a success response. The same
  reasoning produced the individual rejections listed under **Added** below
  (`position` on task create, `doneBucketId`/`defaultBucketId` on `create-view`,
  `targetUrl`/`secret`/`basicAuth*` on webhook `update`, `labelTitles` on `remove-label`,
  changed `title`/`description`/`parentProjectId`/`hexColor` on `setup-kanban`'s reuse path).

- **BREAKING: the minimum supported Vikunja is now 2.4.0. Vikunja 2.3.0 is no longer
  supported.** If your Vikunja instance runs 2.3.0, either upgrade Vikunja to 2.4.0+ or pin
  this package to `vikunja-mcp-ng@0.6.2`, the last release that claimed a 2.3.0 floor. There
  is no runtime version check. Nothing new will start refusing to talk to your server; what
  changes is what this project tests, fixes and claims.

  **Why:** the 2.3.0 claim was not true. Nine operations this server ships as implemented
  **do not exist on a released Vikunja 2.3.0 at all**: the eight `vikunja_admin` operations
  (`overview`, `list-projects`, `set-project-owner`, `list-users`, `create-user`,
  `delete-user`, `set-user-admin`, `set-user-status`) and `vikunja_tasks get-by-index`
  (`GET /projects/{project}/tasks/by-index/{index}`). They looked in range because the API-coverage
  denominator (169 operations) was measured against `v2.3.0-1019-g95b7e673`, a `try.vikunja.io`
  *unstable* build 1019 commits past the tag; the released 2.3.0 has 160. Raising the floor
  makes the compatibility claim true, rather than annotating a false one with a caveat.
  Secondary reason: upstream Vikunja moves fast and this project needs to keep up.

  Aligned/tested stays **2.4.0**, so floor and aligned now coincide. That's a deliberate
  transient, not a target state; they separate again when the aligned version moves (issue #237). Full
  reasoning and revisit condition: decision 27 in [docs/ROADMAP.md](docs/ROADMAP.md) §3.

### Fixed: data loss and duplicate writes

- **`vikunja_users update-settings` was erasing every setting you did not mention.**
  `POST /user/settings/general` is a full-model replace: the handler binds the request body
  into a fresh `v1.UserSettings` and assigns *every* field of it onto the user
  unconditionally, then saves with `forceOverride: true`. Anything absent from the body was
  written back as its Go zero value. This tool sent a partial body, so a call changing only
  the timezone also silently wiped the user's **name, language, week start, default project,
  both discoverability flags and both reminder preferences**, on every call. (It also
  returned HTTP 400 outright whenever `overdue_tasks_reminders_time` was omitted, which is
  tagged `valid:"time,required"`, so the single most likely outcome was a confusing failure
  and the second most likely was quiet destruction.) `update-settings` now reads the current
  settings, merges your explicit changes over the whole model, and posts that back, the same
  fetch → merge → POST shape as projects and teams. Guards are `!== undefined` throughout, so
  `false`, `0` and `''` are real values rather than "not supplied".

- **`vikunja_teams update` no longer silently makes a public team private.**
  `POST /teams/{id}` is a full-model replace with no server-side merge: Vikunja binds the
  request body into an **empty** struct (`pkg/web/handler/update.go:37`), and
  `Team.Update` writes with `s.ID(t.ID).UseBool("is_public").Update(t)`
  (`pkg/models/teams.go:388`). `UseBool` forces `is_public` to be written **even when
  false**, so every update that omitted it flipped a public team to private, with no error
  and nothing in the response to notice. The tool sent a partial body, so _any_ update that
  did not explicitly re-send `isPublic` destroyed it. It now reads the team first and merges
  the caller's explicit changes over the whole stored model before posting it back
  (`buildTeamUpdatePayload`, the teams sibling of `buildProjectUpdatePayload`, using the
  fetch → merge → POST pattern of [docs/ENDPOINT-PLAYBOOK.md](docs/ENDPOINT-PLAYBOOK.md)
  §4). Consequences: omitting `isPublic` preserves the stored value; passing
  `isPublic: false` explicitly still sets it to false (omission and an explicit `false` are
  never conflated); and a **description-only update no longer fails with HTTP 400**: `name`
  carries a server-side `required` validator (`pkg/models/teams.go:37`,
  `ErrTeamNameCannotBeEmpty` at `:378`) and the merged payload always carries it. Costs one
  extra `GET /teams/{id}` per update, and makes a team update non-atomic against a
  concurrent edit. That's the same trade-off projects have always carried. Team **membership**
  writes were checked and are not affected (member add is a create, remove sends no body,
  and the admin toggle re-reads the row server-side and writes with `Cols("admin")`). See
  [docs/VIKUNJA_API_ISSUES.md §3a](docs/VIKUNJA_API_ISSUES.md). Surfaced by the teams work
  @safrano9999 opened in democratize-technology/vikunja-mcp.

- **Creates are no longer retried after an ambiguous failure.** A `PUT` whose response was lost
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

### Security

- **Credentials could reach the log stream.** `sanitizeLogData` existed in
  `src/utils/security.ts` but was referenced nowhere outside that file (written and never
  wired in), while a dozen call sites log raw tool `args`, several of which carry secrets.
  ERROR level is on by default, so failure paths emitted them. Redaction is now applied once
  at the choke point, inside `Logger.log` and *after* the level gate, so it covers every
  level and every call site and costs nothing for a level that will not be emitted. Beyond
  key-name matching it now also catches what key names structurally cannot see: a secret
  embedded in a URL **path** (the motivating case: Slack-style webhook URLs), URL userinfo,
  sensitive query parameters, JWTs, `tk_*` tokens, authorization header values, PEM private
  keys, and `name=value` pairs in free text, applied as a backstop over the rendered line so
  a credential interpolated into a message literal is caught too. `Error` instances are
  unwrapped rather than reduced to `{}` (`message`/`stack` are non-enumerable), and a cycle
  detection bug that reported a merely *repeated* object as `[Circular Reference]` is fixed.
  Wiring `sanitizeLogData` in verbatim would have broken logging outright: it turns an
  `Error` into `{}` and any string over 1000 characters into `[SANITIZATION_FAILED]`. So a
  logging-specific `sanitizeForLogging` was written instead. **Operator-visible change:** some
  fields, notably `user`, now render as `[REDACTED]`.

- **A newly created webhook echoed its own secret back.** Vikunja blanks `secret` on every
  read path but returns the bound struct from `create`/`update`, so the HMAC signing key the
  caller had just supplied came back in the tool response. Both `secret` and
  `basic_auth_password` are now redacted on this side too, matching the server's own read
  behaviour. `vikunja_webhooks` also stopped logging raw `args`. The secret and the target
  URL are logged only as presence booleans, and `basicAuthUser` is excluded as well so that
  its presence never hints at the credential beside it.

### Fixed: answers that were wrong, partial, or quietly ignored

- **A label filter written the documented way matched nothing** (#227). Verified live against
  Vikunja 2.4.0: the `labels` filter field matches on label **ids** and rejects a title
  outright (`GET /tasks?filter=labels in HU` → HTTP 400 code 4019), while `labels in 100`
  returns 200. The documented DSL spelling uses titles, so every title-based label filter
  failed server-side; the client-side fallback then coerced the title with `Number('HU')` →
  `NaN`, compared it against label ids, and matched nothing, reporting `Found 0 tasks` as a
  clean success. Label titles are now resolved to ids once, in `FilterValidator`, feeding both
  the wire string and the client-side evaluator (numeric values cost no lookup). A `labels`
  condition where **no** title resolves is now an error naming the unresolved titles; one that
  partially resolves keeps the resolvable half and warns; and a failed *lookup* (a 403 from a
  scope-limited token, a network error) is reported as an error rather than as "no such
  label". The evaluator also matches by title, case-insensitively, so the fallback is correct
  on its own. The issue's hypothesis that list responses return `"labels": null` is **not**
  what 2.4.0 does: labels are fully populated by both `GET /projects/{id}/tasks` and
  `GET /tasks`. So the fallback was fixed rather than removed.

- **A date-filtered listing never actually filtered server-side** (#225). Vikunja rejects
  `created >= '2026-08-16 00:00:00'` with the same 4019, so the single-call `GET /tasks`
  strategy failed every time and silently degraded to per-project aggregation. Date-field
  literals in a filter string are now normalized to RFC3339 by the same `normalizeDateForApi`
  the create paths use (extended to cover `YYYY-MM-DD HH:MM[:SS]`); relative literals such as
  `now+7d` pass through untouched.

- **A filtered listing could return part of the answer and report it as the whole answer**
  (#225). Vikunja clamps `per_page` to `service.maxitemsperpage` (default **50**), so a
  193-task project contributed 50 tasks to a cross-project aggregate. Unreported, and found
  while fixing the above, `GET /projects?per_page=1000` was clamped identically, so a user
  with more than 50 projects only ever had the first 50 searched. Both collections are now
  paginated through, bounded by the existing `VIKUNJA_MAX_TASKS_LIMIT` as a shared budget plus
  a 500-page-per-collection ceiling; an explicit caller `page`/`perPage` still returns exactly
  that page. Anything that truncates the aggregate, skips an unreadable project, or drops part
  of the project list now sets the new `resultComplete: false` response metadata and explains
  itself in the new `warnings` list; `vikunja_tasks list` renders `INCOMPLETE RESULT` or
  `PARTIAL FILTER` in the **summary line**, not buried in metadata. Fallback notes carry the
  server's own reason (the 4019 text, for instance) instead of a generic "failed", which is
  what made both of these bugs undiagnosable from the response.

- **A date-only `dueDate` failed on four create paths.** `create-subtask`,
  `bulk-create-subtasks`, `vikunja_batch_import` and `vikunja_templates instantiate` sent
  `dueDate`/`startDate`/`endDate` to `PUT /projects/{id}/tasks` raw, while `vikunja_tasks
  create` had normalized them since #167. Verified live on 2.4.0: a bare `2026-09-01` on that
  endpoint returns **HTTP 400 code 2004**, it is not silently dropped. All four now route
  through the same `normalizeDateForApi` helper; there's no second coercion implementation. (Note
  that `vikunja_tasks update` still has this gap; it was out of scope here.)

- **Task progress was displayed as the raw fraction next to a `%` sign.** A half-done task
  rendered as `**Progress:** 0.5%` and a finished one as `1%`. It now renders on the same
  0-100 scale the tool surface accepts (nearest whole percent; a sub-percent value stored by
  another Vikunja client is rounded, halves up).

- **`vikunja_batch_import` wrote `percentDone` to the wire unconverted.** Its schema has
  always validated the field as 0-100, but the value was passed straight through to
  `percent_done`, so importing a task at 75% stored `75`, 75x out of range and silently
  accepted by Vikunja.

- **A `percentDone` filter matched nothing, silently.** `percentDone > 50` was sent to the
  server as `percent_done > 50`, compared against a column whose values never exceed `1`.
  Both the server-side filter string and the client-side evaluator now rescale.

- **`vikunja_task_bulk bulk-create` dropped four schema-declared fields on the floor.** Its
  hand-rolled per-task remap built an anonymous snake_case object (`due_date`, `repeat_after`,
  `repeat_mode`) that nothing downstream read, and never copied `percentDone` at all. The
  remap is now a typed `toBulkCreateTaskData`, so future drift is a compile error.

- **An unrecognized CSV column in `vikunja_batch_import` was dropped without a word**, while
  the identical payload as JSON was rejected (`importedTaskSchema` is `.strict()`). As a
  result, the import reported every row created while the data was not there. The CSV path now rejects the
  column, naming it and listing the supported ones; `skipErrors: true` still opts out and
  imports anyway.

### Added

- **Task fields that were declared but never sent, or never offered at all.**
  `done` on `create`: Vikunja's `createTask` inserts the whole task struct, and
  `setTaskInBucketInViews` even routes a done task into the Kanban view's Done bucket, so
  "create this task, already done" now does what it says instead of creating an open task.
  **Caveat:** `done_at` is stamped only by `updateDone`, which create never calls, so a task
  created done carries no completion timestamp and will not match a `doneAt` filter. Create
  it open and update it to done if you need that timestamp. `hexColor` (`#RRGGBB`, or `''`
  to clear) on `create` and `update`; note that Vikunja's `NormalizeHex` strips the leading
  `#` and truncates to six characters, so the value reads back as `4287f5`, not `#4287f5`.
  `labelTitles` on `apply-label` via `vikunja_tasks`: `applyLabels` had always read it and
  `vikunja_task_labels` had always declared it, but the `vikunja_tasks` shape had not, so
  titles sent alongside ids vanished and a titles-only call failed insisting no titles were
  given; `remove-label` takes ids only and now rejects `labelTitles` loudly rather than
  ignoring it. `repeatAfter`/`repeatMode`, plus `done` and `hexColor`, on `create-subtask`;
  and `percentDone`/`startDate`/`endDate`, long declared on the schema and never read by the
  subtask composites, are now forwarded.

- **Task fields that only worked on update now work on create too.** `percentDone` is
  accepted by `vikunja_tasks create` and by `bulk-create` (both flavours), mapped to
  `models.Task.percent_done`, and `percent_done` joins the `bulk-update` field allowlist;
  previously bulk-update rejected a value single `update` accepted. `bucketId` (with the
  optional `viewId`) is honoured on `create` as a post-create move through the same
  view/bucket resolution `set-bucket` uses, instead of being accepted by the schema and
  silently dropped; if the move fails the error names the created task id and the task is
  **not** deleted. `position` on `create` is now rejected with a pointer to `set-position`
  rather than silently ignored: task position is per-view state owned by a dedicated
  endpoint that has no meaningful default for a brand-new task.

- **Project and project-view write fields.** `isFavorite` on project `create`/`update`
  (`models.Project.is_favorite`; `false` explicitly un-favorites, omission leaves it alone).
  `position` on `create-view`/`update-view`: previously declared, echoed back from the
  server's response, and a no-op, so a caller reordering views got a success message implying
  it had worked. `filter` on `create-view`/`update-view`, routed through the same
  parse/validate/translate pipeline as `vikunja_tasks list` and merged onto any existing
  collection so changing the query does not wipe the view's sort order; the wire shape is the
  nested `models.TaskCollection` (`{filter: {filter: "…"}}`), not a bare string.
  `bucketConfiguration` on `create-view`/`update-view`: without it,
  `bucketConfigurationMode: 'filter'` produced a board with no columns at all. `hexColor` on
  `setup-kanban`'s new-project path, matching `create`/`update`. All of these ride the
  existing fetch → merge → POST builders, which is load-bearing twice over: the view update
  handler names an explicit `Cols(...)` list that persists zero values (so a partial body
  would reset a view's position to 0 and blank its filter), and `UpdateProject` **deletes**
  the favorites row whenever `is_favorite` arrives false. That's a second instance of the
  `UseBool`-shaped hazard from [docs/VIKUNJA_API_ISSUES.md §3a](docs/VIKUNJA_API_ISSUES.md),
  by a different mechanism.
  `create-view` now **rejects** `doneBucketId`/`defaultBucketId`: a bucket belongs to exactly
  one view, so a brand-new view owns none and any id passed here necessarily points at
  another view; `createProjectView` overwrites both ids anyway when it auto-creates a
  manual Kanban view's buckets. The error points at `update-view` / `set-done-bucket`.

- **HTTP Basic Auth credentials on webhook creation.** `basicAuthUser`/`basicAuthPassword`
  are documented create-time write fields on `models.Webhook` that this tool never declared,
  so a webhook whose receiving endpoint sits behind Basic Auth could not be created at all.
  They are create-only, exactly like `targetUrl`/`secret`, because `Webhook.Update` is a
  hard-coded `Cols("events")` single-column write. `basicAuthPassword` is never logged (only
  a `hasBasicAuthPassword` boolean), never echoed in a response, and never appears in a
  thrown error.

- **`vikunja_webhooks update` now rejects `targetUrl`, `secret`, `basicAuthUser` and
  `basicAuthPassword`** instead of accepting them and reporting success.
  `Webhook.Update` is `s.Where("id = ?", w.ID).Cols("events").Update(w)` for both scopes:
  neither a full-model replace nor a partial update, but a hard-coded single-column write, so
  **no payload shape makes any other field stick**. An agent repointing a webhook at a new URL
  or rotating its secret was told it had worked while nothing changed. `events` is the only
  changeable field; to change anything else, delete the webhook and create a replacement. The
  success message no longer implies more than `events` changed.

- **Three user settings that were silently stripped.** `defaultProjectId` (0 clears it),
  `discoverableByEmail` and `discoverableByName` are documented write fields on
  `models.UserGeneralSettings` that `vikunja_users update-settings` never declared, so an
  agent asking to change them got silence instead of a change.

- **`vikunja_teams` can set `is_public`** on `create` and `update` via a new `isPublic`
  field: `models.Team.is_public` ("defines whether the team should be publicly
  discoverable when sharing a project") was in the vendored 2.4.0 spec and passed through
  on reads, but was never sent on writes. On `update` it is safe to omit; see the
  read-then-merge fix under **Fixed: data loss and duplicate writes** above, which landed
  alongside it.

- **`setup-kanban` no longer ignores `title`/`description`/`parentProjectId`/`hexColor` on
  the reuse path.** When `id` is supplied the composite reuses the project as-is and never
  writes to it, so those fields were accepted and dropped. `hexColor` is now rejected
  outright with a pointer at `vikunja_projects update`; the other three are rejected **only
  when the value would actually change something**: a value matching what is stored stays a
  harmless silent no-op, and the extra `GET` happens only when one of the three is supplied,
  so the common "reuse by id alone" call costs no additional round trip. Comparison is
  trimmed for `title`/`description` (an absent description reads as `''`) and normalizes a
  missing or explicit `0` parent to "no parent".

- **`VIKUNJA_BULK_WRITE_CONCURRENCY`**: opt-in override for bulk-**create** concurrency,
  default unchanged at `1` (sequential), validated as a positive integer and capped at 10;
  an invalid value warns and falls back instead of failing startup. **Raising this on a
  SQLite-backed Vikunja reintroduces the "database is locked" storm and the circuit-breaker
  cascade the sequential default exists to prevent.** It is for Postgres/MySQL-backed
  instances only. Scoped to creates: bulk update and delete keep their fixed concurrency,
  which is ordinary throughput tuning rather than a defect workaround. See
  [docs/CONFIGURATION.md](docs/CONFIGURATION.md#bulk-write-concurrency). Proposed by
  @joyjit in democratize-technology/vikunja-mcp#97.

### Internal

- **A weekly upstream watch** (`npm run watch:upstream`,
  `.github/workflows/upstream-watch.yml`) now scans `go-vikunja/vikunja`'s `main` branch for
  commits that can plausibly change what this client observes, and appends a digest to its
  tracking issue. It deliberately **ignores `swagger.json`**: across 2.4.0 → 2.6.0 the spec
  moved by one operation while roughly 17 changes broke a client like ours, all of it in
  handler enforcement the spec never describes. A run that finds nothing posts nothing.
  Documented in [docs/LOCAL-TESTING.md](docs/LOCAL-TESTING.md#upstream-watch-npm-run-watchupstream),
  including the exit-code contract, the watermark, and the fact that GitHub disables
  scheduled workflows after 60 days of repository inactivity.
- The agent battle-testing library grew from 13 scenarios to **21**, covering the ground this
  release changed: team rename-keeps-visibility and create-with-admin-member, task position,
  `percentDone` on update / bulk-update / as a filter threshold, and bulk-update partial
  failure. New check types (`team-exists`, `team-absent`, `task-absent-from-project`,
  `task-first-in-list-view`, a `max` bound on `tasks-with-label-count`) and a `create-team`
  setup action back them. Cleanup now sweeps teams too: a team is global to the instance, so
  nothing else would ever reclaim one. `percent-done-scale`'s optimal call count was
  re-derived 2 → 1 now that `setup-kanban` can express `percentDone`.

### Documentation

- Currency passes across both READMEs, `docs/CONFIGURATION.md`, `docs/LOCAL-TESTING.md`,
  `docs/API_NOTES.md`, `docs/VIKUNJA_API_ISSUES.md` and `docs/ARCHITECTURE.md`.
  `VIKUNJA_RESPONSE_VERBOSITY` and the SSO-enrollment lane inside `npm run test:e2e:oidc`
  were undocumented and now are; the team admin-toggle route's spec/handler mismatch is
  settled (its swagger annotation says `userID path int`, the handler binds
  `TeamMember.Username` via a `param:"user"` tag, so it is keyed by **username**), generalized
  into a rule: where the spec and the handler disagree, the handler wins. The compatibility
  matrix now records that Vikunja **2.5.0 and 2.6.0 are released upstream and neither
  supported nor tested here**, with 2.4.0 as both the floor and the aligned, tested target
  (the floor raise itself is under **Changed**, above).

## [0.7.0-beta.1] - 2026-08-14

**One-click SSO enrollment** (#220, #221): in oidc-http mode, a user whose Vikunja backend shares the MCP server's IdP no longer handles API tokens at all. `vikunja_auth provision` without a token now returns a personal enrollment link; one click walks the user's existing SSO session through Vikunja's native OpenID login, mints their API token server-side, and stores it encrypted in the vault under their identity. Manual token provisioning remains available for non-SSO backends.

### Added

- `/enroll` + `/enroll/callback` endpoints on the HTTP transport (served ahead of bearer auth; Host-allowlist enforced), backed by single-use, TTL-bound, identity-bound enrollment tickets
- New `enroll` config block (`VIKUNJA_MCP_ENROLL_*`): enabled flag, target Vikunja URL, provider key, token expiry (default 365d); `VIKUNJA_MCP_HTTP_PUBLIC_URL` is required when enrollment is enabled and the server fails loud at startup otherwise (including under stdio transport)
- Enrollment e2e lane: mock OIDC IdP + opt-in docker overlay run the full real chain against Vikunja 2.4.0: code exchange, first-login account auto-creation, token mint, vault write

### Security

- **Enrollment is identity-pinned**: the callback verifies the IdP-authenticated browser user matches the ticket's identity (email/username claims, fail-closed) before vaulting. A forwarded enrollment link completed by another user's SSO session is refused (proven live in the e2e lane). Access tokens must carry an `email` or `preferred_username` claim for enrollment.
- Adversarial review of the feature (12 confirmed findings) fixed pre-release: deferred ticket consumption (transient upstream failures no longer burn links), `/routes` response hardening (no garbage-permission tokens), malformed-URL handling, explicit `vikunjaUrl` mismatch rejection, already-linked short-circuit (no orphaned tokens), ticket-cap ordering, and all Vikunja calls routed through the shared retry/circuit-breaker layer

### Documentation

- OIDC-SETUP §9a: validated enrollment design with the Vikunja 2.4.0 ground truth (callback semantics, redirect-URI handling, provider config as a map); CONFIGURATION.md + TOOLS.md updated

## [0.7.0-beta.0] - 2026-08-14

**Public beta of the multi-user OIDC resource-server mode.** Published on the npm `beta` dist-tag and GHCR `:beta`; `latest` stays on 0.6.2. Everything below is inert unless `VIKUNJA_MCP_TRANSPORT=http`; stdio deployments are unaffected.

### Added

- **OIDC resource-server mode over Streamable HTTP**: opt-in HTTP transport (`VIKUNJA_MCP_TRANSPORT=http`) that validates per-user OIDC access tokens (issuer/JWKS/audience/algorithms, configurable clock skew and required scope) and gives every identity its own isolated request context and session storage
- **Encrypted per-user credential vault** with `vikunja_auth` provision/deprovision: each user's Vikunja API token is stored encrypted at rest (`VIKUNJA_MCP_VAULT_PATH` / `VIKUNJA_MCP_VAULT_KEY`) and resolved per request, with no shared service credential
- **MCP authorization-spec discovery (RFC 9728)**: `GET /.well-known/oauth-protected-resource` (and `/mcp` path variant), `resource_metadata` hint on 401 challenges, and optional `VIKUNJA_MCP_HTTP_PUBLIC_URL` for the canonical resource URL behind a reverse proxy. This lets browser MCP clients (e.g. claude.ai custom connectors) auto-discover the IdP
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

- Release pipeline is prerelease-aware (#214): `-beta.x` tags publish to the npm `beta` dist-tag, GHCR `:beta`, and a GitHub prerelease; `latest` is untouched
- Release images build arm64 on native runners (no QEMU) with idempotent, re-dispatchable publishing
- Cleared five Dependabot advisories in the transitive tree (#213); `npm audit` clean

## [0.6.2] - 2026-07-28

A correctness release, and a good argument for testing the parts of a surface you can only refuse.
Closing a long-standing coverage hole (the JWT-only tools that no test session had ever been
authenticated to reach) surfaced a real bug on the first run: **file uploads were being sent as
JSON**, so attaching a file to a task failed with an opaque server error in any session that had
already listed attachments. Also here: the version this server reports to its clients is correct
again after four minors of drift, and `setup-kanban` no longer requires a Kanban board.

Released as a patch by owner discretion despite the additive `columns` capability below, on the
same pre-1.0 basis as `0.5.2` (see [docs/RELEASING.md](docs/RELEASING.md) §3); nothing in this
release requires a caller to change anything.

### Added

- `vikunja_projects setup-kanban` now treats `columns` as **optional** (#185). Omit it and the call
  is a plain "create a project and its tasks" composite: no Kanban view, bucket, or placement step
  runs, or is even touched, and it costs strictly fewer API calls than the board form. Supplying
  `columns` behaves exactly as before. This makes the one-call project+tasks path an honest one:
  agents were already reaching for `setup-kanban` for non-Kanban work because nothing else offered
  it. A task naming a `column` when no `columns` were given is rejected up front, before anything
  is created.

### Fixed

- **Multipart uploads were sent as JSON when a JSON call had already hit the same endpoint group**
  (#199). Circuit breakers are cached by name, and the cached breaker was returned without checking
  it wrapped the same operation, so `/tasks/{id}/attachments` (list, JSON) followed by
  `/tasks/{id}/attachments` (upload, multipart) fired the upload through the JSON helper, sending
  `Content-Type: application/json` with the form body serialised to `{}`. Vikunja rejected it as an
  opaque HTTP 500. Affected `vikunja_tasks attach` and `vikunja_users upload-avatar`; both are
  order-dependent, which is why the failure never reproduced in isolation.
- A related latent bug in the same mechanism: `withNamedRetry` registered each caller's closure
  under a shared breaker name, so a second call under that name silently re-ran the **first**
  caller's operation and returned its result. No shipped code path used those helpers, but the trap
  is now closed.
- The MCP `initialize` handshake reported version `0.3.0` (#186), hardcoded, and stale since
  `0.4.0`. It is now derived from `package.json`, and a live check fails the build if the two ever
  drift again. `server.json`'s registry manifest is kept in sync by the release script.
- `npm run build` never cleaned `dist/` (#187), so a deleted source file left its compiled output
  behind indefinitely. Published packages were never affected (CI builds from a clean checkout);
  local installs running from `dist/` were.

### Changed

- In-range dependency refresh (#189), including `@modelcontextprotocol/sdk` 1.29.0 → 1.30.0. No
  security driver: `npm audit` was already clean. Major upgrades (`zod` 4, `typescript` 7,
  `eslint` 10, `uuid` 14) are deliberately deferred, each needing its own evaluation.

### Internal

- The MCP e2e harness now runs a **second, JWT-authenticated session** (#198) covering the tools
  that are gated off under API-token auth. Previously the entire JWT-only surface was verified only
  by confirming we correctly refuse it: one permanently skipped check and one spec-documented 401
  mislabelled as tolerated server drift. Both are now real assertions, and the full supported matrix
  (Vikunja 2.4.0 and 2.3.0 × PostgreSQL and SQLite) runs with **zero skipped checks**; the only
  remaining tolerance is an upstream server bug that exists solely below 2.4.0.
- The battle-testing sweeper now removes prefixed tasks that an agent created inside a pre-existing
  project (#188), which previously survived cleanup forever.
- Test coverage recovered on the filtering evaluators and orchestrator, and two modules that had
  been listed as untested were found to be unreachable and deleted instead (#182).

## [0.6.1] - 2026-07-25

An agent-ergonomics release built from battle-harness evidence. Setting up a Kanban board, the one
flow weaker agents still fumbled after 0.6.0, now takes a single tool call instead of roughly
thirty-eight (measured: haiku pass-rate 2/3 → 3/3 on the `q3-offsite-kanban` scenario, zero
validation errors). Applying a label to N tasks is likewise one call instead of N. Two real bugs in
the new composite were caught by running it against a live Vikunja server rather than against mocks,
and the changelog tooling that quietly dropped a commit from every release draft is fixed.

### Added

- **Provision a whole Kanban board in one call.** `vikunja_projects` gains `setup-kanban`: it
  creates (or reuses) the project, ensures the Kanban view exists, creates the requested columns in
  order, bulk-creates the tasks, and places each one in its column, resolving view and bucket ids
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
  zero-based index, but Vikunja's `position` is a non-pointer float64: an explicit `0` is
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
  and `docs/BATTLE-TESTING.md` gained a testable re-baselining rule: an optimum must be reachable
  without fabricating structure the prompt never asked for, and may never be set equal to an
  observed call count without independent derivation (#179, #180).

> **On the version number.** `setup-kanban` is a new capability, which
> [docs/RELEASING.md](docs/RELEASING.md) §1 would normally make a *minor* bump. This ships as a
> patch by owner discretion: the work is scoped as the ergonomics/bugfix follow-up to 0.6.0, and
> `0.7.0` is reserved for the Vikunja v2 API migration. Nothing a caller relies on changed: every
> addition is additive and the single-task/`parentTaskId` forms behave exactly as before. Same
> latitude as the [0.5.2](#052---2026-07-22) exception.

## [0.6.0] - 2026-07-24

A reliability and agent-ergonomics milestone on the Vikunja 2.4.0-aligned baseline (minimum
supported 2.3.0). Two silent-failure bugs that could bite *any* client are fixed: a circuit-breaker
cascade that let one bad request poison an entire session, and date-only due dates being silently
lost. Alongside that is a batch of changes that make weaker AI agents far more reliable against the tool
surface (measured: haiku scenario pass-rate 7/15 → 14/15). **Breaking:** the minimum Node.js is now
22 LTS.

### Added

- **Attach labels by name in one call.** `vikunja_task_labels` `apply-label` now accepts
  `labelTitles`: labels are get-or-created and attached in a single call instead of the old
  list → match → create dance. Backed by a new `ensure` subcommand on `vikunja_labels`
  (idempotent get-or-create by title) and a shared `ensureLabelByTitle` helper (#159, #162).
- **Per-session API-version / capability detection.** `vikunja_auth` `status`/`info` now report the
  connected server version and whether the Vikunja v2 API is available, cached per session. No
  behavior change yet; it's the seam the upcoming v2 fast-paths will consult (#149).
- **Multi-architecture Docker images.** Releases now publish `linux/amd64` *and* `linux/arm64`
  (Apple Silicon, ARM servers), with SLSA build provenance (#146).

### Changed

- **BREAKING: minimum Node.js is now 22 LTS** (was 20). Node 20 is no longer supported (#152).
- **Clearer Kanban/bucket guidance.** Argument descriptions and error messages across
  `vikunja_tasks` and `vikunja_projects` bucket operations now state exactly which id each expects
  (project `id` vs `viewId` vs `bucketId`) and how to obtain it, cutting the validation errors
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

- `@hono/node-server` overridden to `^2.0.5`, clearing GHSA-frvp-7c67-39w9 (#153).
- `fast-uri` bumped to `3.1.4`, clearing GHSA-v2hh-gcrm-f6hx (#151). `npm audit` reports zero
  vulnerabilities.

### Internal

- Vendored the Vikunja **v2 OpenAPI spec** and generated types, in preparation for the v2 API
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
milestone); this release only laid the groundwork and did not yet claim it. (v2 API fast-paths
turned out not to be part of 0.6.0 either: 0.6.0 only vendored the v2 spec/types; the actual
migration is tracked for a later release, see 0.6.0's Internal notes.)

### Added

- **Bucket position.** `vikunja_projects` create-bucket / update-bucket now accept an optional
  `position` argument to control kanban bucket ordering. Contributed by @angusmaul (#122).

### Changed

- **Vikunja 2.4.0 groundwork.** The e2e/version-matrix default pin moved `2.3.0` → `2.4.0`, the
  vendored OpenAPI spec was refreshed directly from the pinned 2.4.0 container and types
  regenerated (the only surface change: five creation endpoints corrected `200` → `201`), and the
  known `GET /tasks/{id}/assignees` server-drift tolerance is now version-gated: a hard failure on
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

First release published via npm Trusted Publishing (OIDC) from the tag-triggered GitHub Actions workflow, with no tokens and provenance attestation. Docker images now also publish to ghcr.io automatically.

### Fixed

- Bulk-create now serializes its task-creation writes. On SQLite-backed Vikunja, 8 concurrent creates triggered "database is locked" 500s whose retries amplified the contention and tripped the circuit breaker, turning a lock storm into a full endpoint outage (live repro: 2/12, 0/12, 0/12 created across three 12-task calls). Contributed by @angusmaul (#116), independently verified (#119) and live-proven on a real SQLite stack before merge

### Added

- SQLite variant for the local e2e stack (`VIKUNJA_DB=postgres|sqlite`), a DB dimension in the version matrix, and a SQLite-sensitive 12-task bulk-create stress check, so the class of bug #116 exposed can no longer hide behind our Postgres-only test stack (#120)

### Chores

- Tag-triggered release workflow installed with OIDC Trusted Publishing; inherited never-run CI workflows removed, leaving exactly one workflow, running only on version tags (#123)

## [0.5.0] - 2026-07-19

The agent-ergonomics release. A full battle-testing campaign (8 scenarios, REST-verified, run against a real local Vikunja) measured where AI agents actually struggle with the tool surface. Every change in this release is backed by that evidence, and two changes we *thought* we needed were dropped because the evidence said otherwise.

### Added

- `bulk-set-bucket` (on `vikunja_tasks` and `vikunja_task_bulk`): distribute many tasks across Kanban buckets with one call. View/bucket resolution happens once, writes are sequential with honest per-task failure reporting (#114)
- `bulk-create-subtasks` on `vikunja_tasks`: create and relate multiple subtasks under a parent in one call, saga-compensated per subtask (#114)
- Battle harness: two new scenarios (existing-label reuse, project-rename-share probe) and a broadened validation-error classifier built from real campaign transcripts (#111)

### Fixed

- `vikunja_tasks update` no longer silently drops `bucketId`. It now routes through the shared bucket-placement logic and reports `bucketId` in `affectedFields` only when actually applied. This was the top friction in the campaign: agents lost their Kanban placement and burned 40% extra calls recovering (#112)
- `vikunja_filters build` now emits filter strings in the same camelCase the filter validator accepts (it previously emitted server-side snake_case, actively steering agents into validation errors); filter fields also accept snake_case aliases (`due_date`, `percent_done`, …) with normalization (#113)
- `vikunja_projects` id-domain subcommands (list-buckets, views, duplicate, backgrounds, …) accept `projectId` as an alias for `id`, since the campaign showed agents reach for `projectId` first (#112)
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
- `vikunja_webhooks` account-wide `scope: 'user'` covering `/user/settings/webhooks*`: list/create/update/delete/list-events (#101)
- `vikunja_projects` opt-in cosmetic backgrounds module (`remove-background`, `set-unsplash-background`, `search-unsplash`) behind a new default-off `backgrounds` key (#102)
- `vikunja_tasks` `duplicate` and `mark-read` subcommands (#103)
- Agent battle-testing harness: `npm run battle` spawns a headless AI agent against the tool surface and grades correctness (direct REST verification) and ergonomics (transcript friction metrics) (#96)
- Version-matrix e2e testing: `VIKUNJA_VERSION`-parameterized local stack and one-command `npm run test:matrix` verdict runner (#94)

### Fixed

- Bulk-update now uses Vikunja's native `POST /tasks/bulk` `{task_ids, fields, values}` contract: one request instead of N concurrent per-task writes, eliminating silent task loss under SQLite lock contention; per-task merge kept as fallback. Contributed by @angusmaul (#89), with follow-ups for server-derived success counts, surfaced assignee-restore failures (#95), and a single bulk-replace assignee restore per task (#103)
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

- List responses no longer silently render an empty body for collections over 10 items. The
  hidden cutoff in `formatSuccessMessage` is replaced with a token-safe 50-item render cap, with
  an explicit "Showing 50 of N" notice beyond that (#85, via #87).
- List rendering no longer alternates between a rich heading layout and a plain line depending on
  item shape, which produced broken-looking interleaved lists. All list items now render
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
API-contract bugs, and became `vikunja-mcp-ng`, a direct-REST, composite-first, Docker-distributed
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

- **Renamed the project and package to `vikunja-mcp-ng`**: package name, bin name, MCP server
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
  every subsequent wave: 130 suites / 2,900 tests / 0 failing as of this release.
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
