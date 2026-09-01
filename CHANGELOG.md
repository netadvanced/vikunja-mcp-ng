# Changelog

All notable changes to `vikunja-mcp-ng` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/) with
pre-1.0 semantics. See [docs/RELEASING.md](docs/RELEASING.md) for what that means in practice.

## [Unreleased]

**A second independent-review pass on the beta.3 audit fixes themselves.** Two more
non-Claude models (Grok and Codex, via `cursor-agent`) re-reviewed the same
`v0.7.0-beta.1..beta.3` diffs after #297 shipped, specifically looking for seams *between*
the 36 independently-fixed findings rather than bugs within any one of them. Six more
confirmed defects surfaced this way; every one is fixed and independently re-verified
against the merged tree below.

### Security

- **The credential vault reported every credential as an API token, even when a JWT had
  been stored.** `VaultFileStore.getCredential` hardcoded `authType: 'api-token'`, so in
  `oidc-http` mode the JWT-only tool gate (`vikunja_users`, the export tools, `vikunja_admin`,
  `vikunja_user_deletion`, `vikunja_caldav_tokens`) could never see a `jwt` auth type and those
  tools were silently unreachable even for an operator who deliberately provisioned one.
  `vikunja_auth provision` also accepted a JWT-shaped token without validating its format.
  Resolved by making the vault an enforced API-token-only store: `provision` now rejects a
  JWT outright with an actionable error (a Vikunja JWT expires within hours and this server
  has no refresh path for it), so the `api-token` label is true by construction. A record
  written before this guard existed, or still in the pre-AAD `keyVersion: 1` format (#262),
  now surfaces `needsMigration`/`migrationNotice` in `vikunja_auth status`, plus a
  deterministic startup log naming how many vault-wide records still need re-provisioning.
  (#322)
- **A secret-bearing webhook `target_url` was never redacted in tool responses.**
  `redactWebhookCredentials` only stripped `secret` and `basic_auth_password`; a provider
  webhook URL that embeds a credential in its path (Slack/Discord/Teams-style) passed
  through unredacted into every `list`/`get`/`create`/`update` response, even though the
  same file's logging path already treated these URLs as secret-bearing. Now masked with
  the same high-entropy-path-segment detection already used for log redaction; the raw URL
  is still sent on the wire when creating or updating. (#327)

### Fixed: oidc-http availability

- **Three of the four `vikunja_export_project`/user-export tools always failed with
  `AUTH_REQUIRED` in `oidc-http` mode**, even for a correctly JWT-authenticated caller.
  `vikunja_request_user_export`, `vikunja_download_user_export`, and
  `vikunja_user_export_status` checked the closure/process-global `AuthManager` (never
  connected in `oidc-http`, where per-caller credentials live behind the request-scoped
  context) instead of resolving the calling identity's own manager the way
  `vikunja_export_project` already did. All four now resolve consistently; a latent bug in
  `vikunja_export_project` itself (it computed the correct per-request manager but still
  passed the closure one to the actual export call) was caught and fixed alongside. `stdio`
  behavior is unchanged. (#329)

### Fixed: answers that were wrong, partial, or quietly ignored

- **Both the JSON and CSV batch-import parsers silently dropped invalid rows under
  `skipErrors: true`**, with no record of what was dropped or why — a JSON/CSV import could
  report "imported N tasks" with zero visibility into how many rows never made it past
  parsing. Both parsers now report every skipped row (index + reason), and
  `vikunja_batch_import`'s response surfaces them alongside the task-creation failures it
  already tracked. (#323)
- **A label whose *title* happened to look numeric (`"123"`, `"1e2"`) was resolved as a
  label *id* instead of by title**, silently matching the wrong label (or none at all).
  Only a value that arrives as a genuine `number` is now treated as a pre-resolved id; a
  numeric-looking *string* always tries title resolution first, falling back to
  numeric-as-id only when no label has that exact title. (#324)
- **`vikunja_webhooks get` never paginated**, so a webhook whose id landed past the
  server's default first page (`service.maxitemsperpage`, default 50) was reported
  `NOT_FOUND` even though it exists. `get` now walks every page for `scope: 'project'`
  (`scope: 'user'` has no page/per_page support at all, so it is unaffected). (#332)

### Changed

- **Cross-project task aggregation no longer fires one request per accessible project at
  once.** `loadTasksAcrossProjects`'s `Promise.all` over every project's task fetch had no
  concurrency cap, so a user with hundreds of accessible projects could trigger hundreds of
  simultaneous upstream requests and an equally large peak of in-flight per-project result
  arrays, independent of `VIKUNJA_MAX_TASKS_LIMIT`. Now bounded by a small concurrency pool
  (default 10 in flight, tunable via `VIKUNJA_CROSS_PROJECT_CONCURRENCY`, capped at 50). The
  existing per-project budget accounting (#290 MED-19) is unaffected — this only bounds
  fan-out, not the task-count budget. (#324)
- **The credential vault's `eventCache` (webhook event-type cache) no longer grows without
  bound.** A distinct entry accumulated forever per `(identity, scope)` pair the process had
  ever seen in `oidc-http` mode; it is now a bounded LRU (cap 10,000, evict-then-insert),
  mirroring the pattern already used for the redaction path's `normalizedKeyCache`. (#327)

## [0.7.0-beta.3] - 2026-09-01

**A security and reliability hardening pass, not a feature release.** Two independent code
reviews (tag `audit-final-20260831`) found 36 confirmed defects across credential handling,
multi-tenant isolation, silent data loss, and listings or filters that answered wrong and
called it success. All 36 are fixed here, closed and independently re-verified against the
merged tree, tracked in #297. Five more issues surfaced while fixing them, or were pulled in
deliberately once the queue was already open, and are fixed or documented alongside. Nothing
in this release changes what you send this server or how you read its responses; every entry
below is either a defect that is now closed or a response that is now honest where it used
to overstate itself. 2.6.0 alignment (#237, #254) is deliberately not part of this release;
see that issue for why bundling it here was rejected.

### Security

- **The credential vault's AES-GCM encryption now actually authenticates what it
  encrypts.** Only `ciphertext`/`iv`/`authTag` were covered by the GCM auth tag; the
  plaintext `vikunjaUrl` field and the record's identity key were not bound to it. Someone
  who could write the vault file, the exact threat the encryption exists to survive, could
  retarget `vikunjaUrl` to a host they control (the victim's next request then decrypts
  their real `tk_*` token straight to that host) or splice one identity's ciphertext under
  another identity's key so it decrypts transparently as theirs. Records now bind
  `identityKey(identity) + vikunjaUrl` as GCM AAD under a bumped `keyVersion`;
  older `keyVersion 1` records still decrypt (no AAD, with a one-time re-provision warning)
  rather than breaking outright. (#262)
- **A rejected error's raw text could leak into a different oidc-http request's
  response.** The shared error sanitizer used a stateful global (`/g`) regex; JavaScript's
  own `lastIndex` bookkeeping on that pattern meant one request's error text could surface
  in the *next* request's response, a cross-tenant information leak. Reproduced live.
  Fixed by removing the shared mutable state. Alongside it: thrown error text and REST
  error-body passthrough now go through the same secret-redaction pass the logger already
  applied, closing a gap where a bare JWT or credential embedded in an error could reach a
  client unredacted even though the log stream was already protected. (#292 MED-8, MED-18;
  #287)
- **Per-identity rate limiting in `oidc-http` mode now covers the whole tool surface, and
  its windows actually rotate.** Three defects, one guarantee. (1) Of the roughly two
  dozen tools this server registers, only `vikunja_auth` was wrapped in the rate-limit
  middleware, so in `oidc-http` mode (one process, many accounts) every other tool was
  unmetered per identity. Every tool registered in that mode now goes through a
  rate-limiting view of the MCP server, so being registered is what makes a tool metered.
  (2) Where the middleware was wired it did not work: the counter store was never given
  its window length, so no window ever expired and "60 requests per minute" was really 60
  per process lifetime, and the 61st call ever made returned a misleading 429 until the
  server restarted. (3) The hourly limit was counted in one place and read from another,
  so it could never trip. This matters beyond one user's own budget: `docs/ROADMAP.md`
  decision 16(c) accepts sharing circuit breakers across accounts specifically because
  per-user rate limits are supposed to contain a noisy neighbour, and until now they did
  not. `vikunja_task_bulk` also moves to the bulk budget, where it belongs.
  **`stdio`, the default deployment, is unaffected**: caught during this release's own
  pre-tag checklist, the fix as first landed applied to every transport, which would have
  put a real per-minute ceiling on ordinary local use for the first time, one process
  there always serves exactly one identity, so there is no noisy neighbour to contain, and
  the OIDC epic's own invariant requires `stdio` to stay byte-for-byte its pre-epic
  behavior. The wrapper now only engages when `VIKUNJA_MCP_TRANSPORT=http` is set; `stdio`
  remains exactly as unmetered across this whole tool surface as it always was, aside from
  `vikunja_auth`'s own pre-existing, unrelated wrapping. Two smaller fixes on the same
  middleware: `clearSession(sessionId)` now actually scopes to the given id instead of
  wiping every identity's counters and both shared breakers, and a tool call that hits its
  execution deadline now actually cancels the in-flight request instead of leaving an
  uncleared timer running behind a caller who was told it timed out. (#263; #296 LOW-18,
  LOW-20)
- **JWT-only tools (`vikunja_admin`, `vikunja_users`, `vikunja_export`, user deletion) now
  gate on the caller's own resolved identity, not a process-global auth manager.** In a
  mixed-credential oidc-http deployment (legacy `VIKUNJA_URL`/`VIKUNJA_API_TOKEN` env vars
  set alongside oidc-http mode), the old gate could register dangerous tools for every
  caller regardless of their own credential type, or hide them from a caller who should
  have had access. Registration and every per-call gate, plus `vikunja_auth`
  `info`/`refresh`'s capability probe, now resolve the same per-identity manager the REST
  layer already used correctly. Two smaller auth fixes rode along: `vikunja_auth connect`
  against an already-connected URL now actually compares and stores a newly supplied
  token instead of silently no-op'ing (which broke the tool's own documented refresh
  flow), and `vikunja_users search` no longer drops every result's display name (it was
  reading `name` from a `settings` shape that `GET /users` doesn't return). (#270, #282;
  #276; #281)

### Fixed: data loss and duplicate writes

- **Bulk-updating assignees had three independent ways to silently wipe them.** The
  workaround that exists specifically to survive a server-side assignee-wipe bug had its
  own bugs: a failed pre-update snapshot read let that task's assignees be wiped with no
  warning; an honesty-check that could throw after the destructive write but before the
  restore step let the fallback re-fetch and preserve the already-wiped state; and the
  per-task path added new assignees then deleted old ones without excluding the overlap,
  so re-assigning to an overlapping set could drop a shared member. All three closed.
  Alongside it: the `BatchProcessor` singletons behind every bulk operation were
  process-wide but built a fresh concurrency semaphore per call, so the "at most one
  concurrent create" guarantee held only within a single request, not across concurrent
  oidc-http callers, reopening the SQLite lock cascade this server already fixed once for
  a single caller, now cross-tenant. The semaphore is now shared per processor, live
  concurrency serializes correctly, and its previously-meaningless utilization metric now
  reflects real busy time. (#267; #288, #296 LOW-17)
- **Templates persisted to disk could silently vanish, or overwrite another identity's
  saved templates.** Three related bugs, closed together because the first is what turned
  the second into a guarantee. `FilterStorageManager` never bumped a session's last-access
  time on lookup, so an active session could be evicted by the idle sweep; on return it
  got a fresh empty store, `list` reported "0 templates" while the file still had them,
  and the very next `create` overwrote the disk file with that near-empty set, destroying
  everything. Separately, the persisted record shape carried no identity field at all: in
  OIDC mode, one identity's first touch hydrated every identity's templates into their
  session, and each write persisted only that session's set over the whole file, so
  concurrent identities could silently erase each other's saved templates. Records are now
  identity-scoped end to end, with a write mutex against concurrent persists, and the
  eviction race is fixed at its source (`getStorage` now bumps last-access on every
  lookup, not just writes). A fourth fix in the same area: `vikunja_templates instantiate`
  now reports failure when any task or label attach fails during instantiation, instead of
  always reporting success while burying the failures in a field nothing surfaces. (#264,
  #293 MED-11; #265; #271)
- **The credential vault could destroy every other user's stored token, or silently drift
  out of sync with disk.** A transiently unreadable vault file (permissions, a bad edit)
  was cached as an empty map forever; the next successful provision then wrote that
  near-empty map back, permanently deleting every other identity's credential with only a
  startup log line as a trace. The vault now refuses to write back while a load is known
  incomplete. Two related fixes: `provision`/`deprovision` now mutate the in-memory cache
  only after the write to disk succeeds, so a thrown write error can no longer leave memory
  and disk permanently disagreeing about who is (de)provisioned; and `vikunja_auth status`
  now reports `provisioned` based on whether a record actually decrypts, not merely
  whether it's present in the map, so a record that can no longer be decrypted (a
  master-key mismatch) is no longer reported as a working connection. Vault and template
  atomic writes now also `fsync` before and after rename, so a "successful" write survives
  a power loss. (#266; #277; #278; #293 LOW-10)
- **An aborted batch import discarded the record of what it had already created, and
  reported the whole thing as a plain success.** With `skipErrors` unset, a mid-batch
  failure re-threw and discarded the partial result, the response never mentioned the
  tasks that had already landed, and unlike every other tool here batch-import converted
  the failure into success-shaped content instead of an actual error, so a client checking
  `isError` saw a clean success. The natural next move, retrying the whole import, then
  duplicated everything that already succeeded. Aborts now surface as a real error carrying
  the partial-result summary. (#269)

### Fixed: multi-tenant isolation

- **Several process-wide caches and one identity delimiter were shared or ambiguous
  across tenants.** The webhook event-validation cache was shared across identities that
  might be provisioned against entirely different Vikunja servers; it's now keyed by
  identity. OIDC identity values (`sub`, the derived `identityKey`) appeared unmasked in
  logs even though the redaction layer already protected secrets; they're now masked the
  same way. The `issuer|sub` identity-key delimiter was unescaped (safe today with one
  allowlisted issuer, a latent collision risk with a second); it's now escaped. A
  credential-shape heuristic in the log sanitizer was flagging harmless strings like
  version numbers and REST paths as credentials; it's narrower now without weakening real
  detection. A security cache advertised a 10,000-entry cap it never enforced, a slow
  memory leak in long-running processes; the cap is now real (LRU eviction). And the
  protected-resource discovery metadata endpoint reflected an unvalidated `Host` /
  `X-Forwarded-Proto` when `http.publicUrl` was unset; it now validates against the
  existing DNS-rebinding allowlist. (#292 MED-9, MED-15, LOW-11, LOW-13, LOW-14, LOW-19)
  `docs/CONFIGURATION.md` and `docs/OIDC-RESOURCE-SERVER.md` now also state explicitly
  that `oidc-http` mode with vault persistence is single-process; a cross-process
  last-writer-wins race was confirmed but is out of scope for a topology this project
  doesn't claim to support (#292 MED-16).

### Fixed: answers that were wrong, partial, or quietly ignored

- **Listings silently truncated at Vikunja's page clamp and called it the whole
  answer.** Both server-driven filtering strategies (cross-project and single-project)
  issued one request each and never checked whether the page came back full; Vikunja
  clamps `per_page` server-side (default 50), so "list all my tasks" on a 193-task account
  quietly returned 50 with no signal 143 were missing. Both strategies now paginate through
  and set `resultComplete: false` when a caller-supplied page limit stops early. The same
  pattern recurred in `vikunja_notifications list`, `list-comments`, and (spot-checked and
  fixed where confirmed) `list-assignees`/`list-attachments`/`list-labels`/`list-teams`; all
  now carry the same completeness signal. A compounding bug in the same code: a filter
  mixing a server-side group with a `done` condition never folded `done` into the
  server-side filter at all, so it silently post-filtered an already-truncated page; `done`
  is now part of the server-side filter expression. Three smaller listing-honesty fixes
  from the same pass: a client-side aggregation branch could drop tasks near the collection
  budget without flagging truncation, `orderBy`/`filterTimezone`/`filterIncludeNulls` could
  be silently dropped by the cross-project fallback on any failure cause, and a
  single-project listing that silently ignores cross-project-only params now says so.
  (#268; #289; #290 MED-6, MED-7, LOW-3)
- **A live-verified fix, not a guess: `vikunja_notifications mark-read` was not actually
  marking anything read.** Confirmed against two independent Vikunja 2.4.0 stacks
  (postgres and a freshly provisioned sqlite instance, ruling out stale state on one
  container): sending the toggle with the empty body the API spec documents never
  persisted the change, no matter how many times it was called. Sniffing Vikunja's own
  frontend showed it sends an explicit `{"read": true}` body instead, which does persist.
  `mark-read` now sends that, keeps its existing retry-once fallback for defense, and
  surfaces a warning in its response rather than a silent success if confirmation still
  fails after both attempts. A related bug in the same tool: Vikunja's zero-time
  `read_at` sentinel could make `unreadOnly` filtering and mark-read idempotency both
  behave wrong, since the code checked `read_at` truthiness instead of the response's own
  `read` boolean; also confirmed live and fixed. (#314; #289 HIGH-18, #286)
- **The filter parser silently collapsed a mixed `&&`/`||` expression into one
  operator, and re-serialization could corrupt values on the way back out.**
  `priority = 5 && done = false || priority = 4`, the natural way to write this without
  parentheses, parsed into a single group whose operator got overwritten by whichever
  logical operator was seen last, silently changing the query's meaning. Unparenthesized
  mixed operators are now a teaching error instead. Two adjacent bugs: quoted string values
  lost their quotes on re-serialization (breaking the round-trip for any value containing a
  space), and a quoted `in`/`not in` value containing a comma was silently re-split into
  extra values; both now respect quote boundaries. The client-side date evaluator also
  treated Vikunja's zero-date sentinel as a real `dueDate` (already handled correctly for
  the other three date fields), so an "overdue" filter falling back to client-side
  evaluation could match every task with no due date at all; fixed to match. A last,
  narrower fix in the same area: the client-side collection budget could overshoot when
  `autoPaginate` is false, because concurrent per-project fetches weren't coordinated
  against the shared budget; they now check and decrement it atomically. (#272; #290 MED-4,
  MED-5, MED-19; #285)
- **The "potentially dangerous content" guard rejected ordinary text, inconsistently.**
  A SQL-injection-shaped pattern (`on\w+[^&]*=`, meant to catch encoded `onclick=`-style
  attacks) had no anchor to any encoding marker, so it matched any word containing "on"
  followed anywhere later by an `=` sign, rejecting real text like
  `13,75 V = 13 j d'autonomie, 12 V = 44 j` on `create`/`create-subtask`/
  `bulk-create-subtasks` while `update` silently accepted the identical string, because
  `update` never sanitized at all. The unanchored pattern is removed (real event-handler
  and `javascript:` content is still caught by the existing, correctly-anchored patterns);
  `update` now sanitizes consistently with every other write path; and a rejection now
  names the field and the specific rule that matched, instead of a bare "String contains
  potentially dangerous content". `bulk-create-subtasks` also no longer fails an entire
  batch because one item's validation failed; that item is now reported as a failed result
  alongside its valid siblings, consistent with how this codebase's other bulk operations
  already report partial success. The identical false-positive tolerance also existed in
  `vikunja_users upload-avatar`'s base64 handling (only a zero-length decode was rejected,
  so genuinely malformed base64 still decoded to garbage bytes and got uploaded); fixed the
  same way as the equivalent `attach.ts` fix below. (#226; #300)
- **A handful of write paths tolerated corrupted or unverified input without checking.**
  `vikunja_tasks attach` tolerated malformed base64 the same way `upload-avatar` did above;
  it now validates the base64 shape before decoding rather than only catching a
  zero-length result. `create-subtask`/`bulk-create-subtasks` treated an HTTP 200 on a
  label/assignee attach `PUT` as proof the attach happened, with no read-back to confirm;
  `create-subtask`'s path now verifies. Updating `repeatMode` without also sending
  `repeatAfter` could inflate a task's recurrence interval by roughly 52 billion seconds,
  because the existing (already-in-seconds) value was being re-multiplied by a converter
  expecting a day/week/year count; fixed to convert back before re-applying the multiplier.
  `setup-kanban`'s bucket-reuse fallback could silently repurpose a fresh project's
  done-bucket into an ordinary column, so Vikunja auto-completed every task placed there;
  the done-bucket is now excluded from that fallback. And `vikunja_projects list` computed
  honest pagination and hierarchy metadata and then discarded it before it reached the
  response; it's now wired through. (#295 MED-12; #295 LOW-22; #274; #273; #280)
- **Project sharing had four correctness gaps, plus one honesty gap in `list-members`.**
  A numeric permission of `right: 0` (read-only) was schema-valid but rejected at seven
  dispatch sites with a falsy check, so downgrading a share to read-only failed with a
  misleading error. `get-share`/`delete-share` and the `atomic: true` verification read on
  `share-with-user`/`share-with-team` both read an unpaginated shares list, so a share
  beyond the first page could read as not-found (silently no-op'ing a delete) or cause a
  successful grant to be wrongly revoked; both now paginate through. Link-share creation
  now strips `password` from its response, since the field is documented write-only after
  creation. Separately, `list-members` was coercing a failed teams-read to a silent "0
  direct team(s)" instead of surfacing the failure, the same honest-failure gap
  `link-shares` already avoided; it now reports an explicit error field. Two smaller
  hierarchy fixes: a project fetch failure was being treated as "parent not found" instead
  of "couldn't check", and `get-tree` now reports when it truncates at `maxDepth` instead
  of silently dropping the rest of the subtree. (#291 MED-1, MED-2, MED-3, MED-17; #279;
  #291 LOW-1, LOW-2)
- **Batch import had four correctness bugs beyond the abort-handling fix above.** The CSV
  parser split on newlines before quote-aware parsing ran, so an RFC 4180 multiline quoted
  field produced a spurious extra task; quotes are now parsed before the split. A
  nonexistent assignee username was misdiagnosed as an API authentication problem (an
  empty user-search result looks identical to both cases); the two are now distinguished.
  Imported reminders were silently dropped with a warning claiming they "cannot be added
  after task creation", which is both false and backwards, since this codebase's own
  `add-reminder` proves otherwise; reminders are now included in the create body. And label
  resolution during import read only the first page of `GET /labels`, misreporting
  existing labels beyond page 1 as not found; it now paginates. Three smaller CSV/JSON
  parity fixes rode along: `skipErrors` was silently ignored for JSON imports while CSV
  honored it, numeric CSV coercions used `parseInt` and silently truncated decimals the
  JSON path would reject, and CSV `done` only recognized the literal string `"true"`. (#275;
  #283; #284; #294 MED-10, MED-14, LOW-7, LOW-8)
- **Two response-formatting bugs could mask a real failure as a success.** An
  assignee-verification failure rendered under a success header, because the underlying
  `response.success = false` was never copied into the metadata the formatter actually
  reads; it's wired through now. And `vikunja_filters update` reported `filter` as changed
  in `affectedFields` even when the supplied value was empty and nothing actually changed,
  a truthiness-versus-undefined mismatch between the merge logic and the reporting logic;
  the two are now aligned. `add-reminder` also now normalizes a date-only value through
  `normalizeDateForApi`, the same as every other create-family path. (#295 MED-13; #295
  LOW-4; #295 LOW-5)

### Chores

- Two dead storage-layer modules (`FilterSerializer.ts` and a diverged, unimported
  `FilterValidator.ts` variant) removed, per this project's own "if code cannot be tested,
  it must be removed" rule. Two smaller hardening fixes rode along in the same pass: the
  multipart raw-request path now carries the same retry predicate the JSON raw path
  already had (latent until now, since retries are off by default), and a circuit-breaker
  name-collision fallback no longer risks returning a mismatched action under a third
  anonymous operation collision. Separately, `joseLoader` no longer caches a *rejected*
  JWT-library import forever; a transient startup failure now retries on next use instead
  of permanently breaking JWT validation until restart. (#293 LOW-9; #296 LOW-15, LOW-16;
  #296 LOW-21)

### Documentation

- **OIDC enrollment identity-pinning's real matching behavior, and an operational
  footgun, are now documented.** On Vikunja 2.4.0, `GET /user` omits `email` entirely, so
  the email-first match path is dead code in practice; matching is effectively
  username-only today, and `docs/OIDC-SETUP.md` now says so plainly. Separately, if a
  local Vikunja account already holds the username an SSO login would auto-create,
  Vikunja silently assigns the new account a random username instead of failing or
  merging, which then 403s the legitimate user's own enrollment; the operational rule
  (don't pre-create local accounts sharing a username with one that will later SSO-enroll)
  and a troubleshooting entry are now documented. Both are real, open findings from a
  production deployment; a real code fix is deliberately deferred rather than rushed into
  this release, and stays tracked in #223 and #224.

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
