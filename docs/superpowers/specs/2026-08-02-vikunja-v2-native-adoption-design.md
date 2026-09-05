# Vikunja v2 native adoption (P3) — design

**Date:** 2026-08-02
**Issue:** [#184](https://github.com/netadvanced/vikunja-mcp-ng/issues/184) — 0.7.0 milestone
**Scope:** P3 — routing real operations through v2, optimised for how v2 actually works.
**Predecessor:** `2026-07-27-vikunja-v2-transport-design.md` (P1+P2: transport, error adapter,
routing, kill switch — complete, merged behaviour-neutral).

**Amended 2026-09-05** after re-probing every live finding against the current support window
(2.4.0 floor, 2.5.0, 2.6.0 aligned default) instead of the single 2.4.0 server the original draft
measured. Four load-bearing claims changed. They are called out inline below and summarised here so
nobody implements from a stale premise:

1. The v2 `PATCH`/subscription 422 is **fixed from 2.5.0**. The `subscription: null` workaround is
   withdrawn; task update routes to v1 on 2.4.0 and to v2 from 2.5.0.
2. `GET /projects/{id}/tasks` is **not v2-only**. v1 serves it on all three supported versions, so
   it removes no discovery call and is not a reason to prefer v2.
3. The "extra" `expand` values (`comment_count`, `time_entries_count`, `is_unread`) are **not
   v2-only**. v1 accepts and populates them identically across the window.
4. v2 `PUT /tasks/bulk` **wipes assignees exactly as v1 does**, so it does not retire the assignee
   snapshot/restore.

## The reframing

P1+P2 treated v2 as "v1 with `PATCH`". Live investigation against real servers disproved that
(originally 2.4.0 on 2026-07-27, re-verified across 2.4.0, 2.5.0 and 2.6.0 on 2026-09-05). v2 is a **different API that happens to expose most of the same resources**: different
response envelopes, different REST verb conventions, different query parameters, a different error
model, capabilities v1 lacks, and capabilities v1 has that it dropped.

So the goal is not "migrate to v2". It is **per-operation version selection with a canonical
internal shape** — each operation runs whichever version serves it best, and nothing downstream
can tell which ran.

This matters because mixed-mode is unavoidable, not a transitional state:

- `vikunja_admin list-users` has no v2 equivalent (see gaps below) — **permanently v1**.
- Unsplash backgrounds are absent from v2 entirely — **permanently v1**.
- Kanban buckets have no v2 `PATCH` (v2 registers only `GET`/`POST` on the bucket collection and
  `PUT`/`DELETE` on a single bucket) — v1 for partial bucket updates.
- Bulk task update gains nothing from v2 and keeps its v1 workaround either way (see step 5).
- Token/session bootstrapping still points at `/api/v1/*` in v2's own spec.

A design that treats v1 as a temporary fallback would have to special-case all of these forever.
A design that treats version as a per-operation property does not.

## What is actually different

Every row below was re-verified live on **2.6.0** on 2026-09-05, and on 2.4.0 and 2.5.0 wherever the
behaviour could plausibly differ across the support window. Each row states what was found and where.
Where the vendored OpenAPI spec and the live server disagree, the server is recorded as the truth and
the disagreement is called out.

### v2-only capabilities worth having

| Capability | Detail |
|---|---|
| `PATCH` partial updates | 14 routes (7 in scope). v1 has 4, all admin-only. Removes fetch-merge-POST for **single-task** update, on servers >= 2.5.0. It does **not** remove the assignee snapshot/restore, which belongs to the bulk path and survives on both API versions (corrected 2026-09-05, see step 5) |
| `GET /projects/{id}/tasks` | ~~v2-only~~ **Not a v2 capability.** v1 serves `GET /api/v1/projects/{id}/tasks` on 2.4.0, 2.5.0 and 2.6.0, returning a bare array. The vendored v1 spec declares only `PUT` on that path, which is a spec bug, not a missing route. The view resolution in `src/tools/projects/buckets.ts` belongs to `list-view-tasks`, a genuinely view-ordered operation, and is not a workaround for a missing endpoint. No discovery call is saved |
| `?format=markdown` | GFM markdown for every rich-text field (task/project/label/team/filter descriptions, comments). v1 is always HTML. Verified on 2.4.0, 2.5.0 and 2.6.0, so it is available across the whole window, not just on the aligned default. 29 v2 operations declare it; an unsupported value answers 422. **`PATCH` is not one of them**: the parameter is declared on `GET`/`POST`/`PUT` only, and a live `PATCH ...?format=markdown` returns HTML regardless. For an MCP server feeding an LLM this is still the single largest quality win, but see the read/write asymmetry note below |
| `problem+json` | One uniform error schema across 185/186 operations, with `errors[]` field details, `type`, `instance`. v1 mixes two schemas (163 `web.HTTPError` vs 184 `models.Message`) inconsistently |
| Envelope totals | `total`/`total_pages` typed and in-body. v1 has them only as undocumented `x-pagination-*` headers, unmodelled in its spec and unread by this codebase |
| `max_permission` | Requester's permission level, per entity. Populated as an integer on v2 **single-entity** reads (`2` for an owned project on all three versions). **`null` in the v2 list envelope** on all three versions, so it cannot be used to avoid a per-entity read. v1 returns `0` on 2.4.0/2.5.0 and `null` on 2.6.0 (see `VIKUNJA_API_ISSUES.md` #23) |
| ETag → 304 | On most single-entity `GET`s. Verified on 2.6.0: `If-None-Match` with a current ETag returns 304, and the ETag changes on mutation. v1 emits none. Cache validation only, never locking (see the `If-Match` trap) |
| Inline assignees on write | `PATCH`/`POST` accept `assignees` in the body and apply them. Labels do **not** (verified) |
| ~~Extra `expand` values~~ | **Withdrawn.** `comment_count`, `time_entries_count` and `is_unread` are accepted and populated identically by **v1** on 2.4.0, 2.5.0 and 2.6.0 (`comment_count` returns the real count on both paths; the other two emit no field on either path). This is not a v2 capability. See the `expand` correction below |

### Corrections to earlier assumptions

Two things assumed during P1+P2 planning turned out to be wrong, and the design must not rest
on them:

- **`expand` is not a v2 feature, and this is broader than first written.** v1 supports the *full*
  v2 value set, not just `subtasks|buckets|reactions|comments`: `comment_count`,
  `time_entries_count` and `is_unread` are accepted and populated by v1 too, verified on 2.4.0,
  2.5.0 and 2.6.0. So `expand` yields **no** v2 advantage whatsoever. Two live details the
  implementation needs: v1 validates the value (`412` for an unknown one, versus v2's `422`), and v1
  accepts `expand` on `/tasks`, `/tasks/{id}` and `/projects/{id}/tasks` but **rejects it on
  `/tasks/all` with `400 code 2004`**, which is the endpoint this codebase reaches for by default.
  Using `expand` on the v1 path therefore also means moving off `/tasks/all`.
- **Single-entity reads are not an N+1 win.** v1's `models.Task` already embeds `assignees`,
  `labels`, `attachments`, `related_tasks`, `reminders`. Only `max_permission` is genuinely new.

### Traps that will cause silent breakage

| Trap | Consequence if missed |
|---|---|
| Search param `s` → `q` | Confirmed on 2.6.0, and the failure mode is the dangerous one: v2 **silently ignores** an unknown `s`. `GET /api/v2/tasks?q=patched` returned 3 results, `?s=patched` returned all 28. No error, just an unfiltered result set presented as a search. v1 accepts both `s` and `q` |
| Verb convention rewrite | Confirmed on 2.6.0: v2 `POST /projects` creates (201) while `PUT /projects` is 405; `PUT /tasks/{id}` replaces (200). `/tasks/bulk` is `POST` in v1 and `PUT` in v2, and `POST /api/v2/tasks/bulk` really does answer 405. **Correction:** only the verb differs. The request body is `{task_ids, fields, values}` on *both* versions. The `{field, value}` shape the original draft implied for v1 is node-vikunja's stale type, not v1's contract (see `bulk-operations-simplified.ts`); sending it produces a 422 on v2 and a silently-unapplied update on v1 |
| Response envelope | A list endpoint returns an object, not an array — breaks every caller expecting `[]`. Key set confirmed byte-for-byte on 2.4.0, 2.5.0 and 2.6.0: `{$schema, items, total, page, per_page, total_pages}` |
| `If-Match` is **not** enforced | Re-confirmed on 2.6.0 and stronger than first recorded: a `PATCH` carrying a **stale** ETag returned 200, and so did one carrying a garbage `"deadbeef"` value. The header is accepted and ignored. `If-None-Match` → 304 does work, so ETags are usable for cache validation only. Do not build lost-update protection on them |
| Unknown query params are ignored | Not just `s`. `GET /api/v2/projects/{id}/tasks?view=1` returns 200 and ignores `view`. Nothing in v2 tells a caller it sent a parameter the route does not implement, so a mis-ported parameter name degrades to "no filter applied" rather than an error |
| Markdown on reads but not writes | `?format=markdown` is honoured on `GET`, ignored on `PATCH`. An update response therefore carries HTML while a read of the same task carries markdown, unless the strategy boundary normalises it |
| `subscription` 422 | 2.4.0 only. See below |

### The 2.4.0 `PATCH` blocker, and why it is a routing question

**Re-probed 2026-09-05 across all three supported versions. This section's original decision is
reversed.**

| Version | Creator auto-subscribes on create? | Assigning a user auto-subscribes? | `PATCH /api/v2/tasks/{id}` on a subscribed task |
|---|---|---|---|
| 2.4.0 | No | Yes | **422** `body.subscription.entity` "expected integer", value `"task"` |
| 2.5.0 | No | Yes | **200**, applied, assignees and subscription preserved |
| 2.6.0 | **Yes** | Yes | **200**, applied, assignees and subscription preserved |

So the blocker is real, it is exactly as described, and it exists **only on the floor**. On 2.4.0 it
still bites hard: a bare task patches fine, and the moment it gains an assignee every later v2
`PATCH` 422s, which is precisely the operation this milestone exists to improve.

Note the 2.6.0 row's first column. From 2.6.0 the *creator* auto-subscribes too, so on that version
essentially every task this server creates carries a subscription from birth. That would have made
2.4.0's bug near-universal rather than assignee-triggered. It is only harmless because 2.6.0 is also
a version where the bug is gone.

**Decision: route by version, do not work around the bug.** `vikunja_tasks update` runs v1 on 2.4.0
and v2 from 2.5.0 upward. The previously-specified `subscription: null` merge-patch workaround is
withdrawn in full, and with it the version gate on the workaround, its expiry condition, the test
pinning the upstream bug, and the upstream filing.

The reasoning is that v1 is not a fallback here. On a 2.4.0 server, fetch-merge-`POST` is simply the
correct implementation of "update a task", because that server has no working partial-update route
for the tasks this server actually manages. Shipping a body field whose only justification is that
the server currently ignores it means carrying a silent-unsubscribe hazard, plus a test asserting an
upstream defect still exists, for the sole benefit of one call fewer on the oldest supported
version. Routing costs nothing at the call sites, because the strategy boundary already hides which
version ran.

The workaround does work, for the record: on 2.4.0, `PATCH {"title": ..., "subscription": null}`
returns 200, applies the change, preserves assignees, and leaves the subscription intact. It is
withdrawn on judgement, not because it fails.

#### What this needs that P1+P2 did not build

`resolveApiVersion` (`src/utils/api-version.ts`) is **capability-aware but not version-aware**. It
returns v2 on "kill switch off AND `hasV2Api`", with no way for a caller to say "v2, but only from
2.5.0". Every operation would therefore get v2 on a 2.4.0 server, including task update.

P3 must extend it to accept a **per-operation minimum server version**, so an operation declares its
own floor and everything below it keeps v1:

```
resolveApiVersion(authManager)                        // any v2-capable server
resolveApiVersion(authManager, { minVersion: '2.5.0' }) // task update: v1 on 2.4.0
```

Two constraints on that work:

- It depends on the detected `serverVersion`, which `GET /info` reports **with a leading `v`**
  (`v2.6.0`), so the comparison must strip it. `compareVersions`/`serverAtLeast` in
  `scripts/lib/e2e-fixtures.ts` already handle exactly this and are the reference behaviour, though
  they live in the harness rather than in `src/`.
- An **undetected** version must resolve to v1, never to v2. "We could not tell" is not evidence
  that a server is new enough, and this is the same rule `serverAtLeast` applies.

This lands with probe hardening in step 1, since both are about the routing decision being
trustworthy before anything routes on it.

## Architecture

### Strategy + Context per operation

Mirrors the existing, proven pattern in `src/utils/filtering/` (`FilteringContext` selecting
`TaskFilteringStrategy` implementations). For each operation with a meaningful v1/v2 divergence:

```
TaskUpdateContext
  ├─ V1TaskUpdateStrategy   GET (fetch) → POST (full model) → assignees → labels   [4 calls]
  └─ V2TaskUpdateStrategy   PATCH (inline assignees) → labels                    [2 calls]
                            selected only when the server is >= 2.5.0
```

The context selects via `resolveApiVersion` (P2, already shipped). Both strategies satisfy one
interface and return **the same canonical shape**.

Why this rather than an inline `if (v2)` branch: the two are not the same algorithm with different
URLs — different call counts, different ordering, different bodies. Interleaving them in one
function guarantees drift, and every new v2 optimisation makes it worse. Separate strategies keep
v1 frozen (it is the permanent floor) and let v2 be genuinely different.

Not every operation needs a strategy pair. Where the only difference is the URL prefix and the
envelope, the normalizer alone suffices — introduce a strategy only where the **call shape**
differs.

### Normalization at the strategy boundary

This is the load-bearing decision, and it is what makes mixed-mode cheap.

Every v2 response is normalized to the canonical internal shape **before it leaves the strategy**:

- unwrap the pagination envelope to the bare array callers expect, capturing `total`/`total_pages`
  as out-of-band metadata rather than changing the returned type
- strip `$schema`
- map `s` → `q` inside the v2 strategy only

Downstream — formatters, tool handlers, tests — never learns which version ran. That is not a new
principle: **P1 already established it for errors**, where both transports converge on `MCPError`
and every catch block in the codebase is version-blind today. This extends the same treatment to
response bodies.

The payoff is precisely the concern that motivated this design: a permanently-v1 operation
(`admin list-users`) sitting beside v2 operations costs nothing at the call sites, because the
shape difference dies at the boundary.

### Probe hardening (prerequisite, must land first)

`probeV2Api` currently sets `hasV2Api: true` on `response.ok` alone. A reverse proxy or SPA
catch-all returning `200` + `index.html` therefore reports v2 support on a v1-only server. Harmless
while the result only feeds a status report; **load-bearing the moment any operation routes on it**,
with the kill switch as the only mitigation.

Tighten before wiring the first operation: verify the response content type and parse for an
`openapi` key, rather than trusting the status code. Both checks were validated against 2.6.0 on
2026-09-05, with one detail that will bite a naive implementation: the server answers
`Content-Type: application/openapi+json`, **not** `application/json`, so an equality check against
`application/json` rejects a genuinely v2-capable server. The body's top-level keys are
`{components, info, openapi, paths, security, servers}` with `openapi: "3.1.0"`, so the `openapi`
key check is sound.

A `serverVersion` floor check is the secondary guard, and per the section above it is no longer only
a guard: it is the mechanism `resolveApiVersion`'s per-operation `minVersion` runs on. `/info`
reports `v2.6.0` with a **leading `v`** on all three supported versions (confirmed 2026-09-05), so a
naive semver compare fails and an undetected version must resolve to v1.

## Sequencing

Ordered so that each step's risk is retired before anything depends on it.

1. **Probe hardening** — nothing may route on a probe that can false-positive.
2. **Response normalization + envelope handling**, with the canonical-shape contract and its tests.
   No behaviour change yet; this is the boundary everything else relies on.
3. **Reads**: list endpoints and `format=markdown`. Lower risk than writes and delivers the biggest
   caller-visible quality win. **Scope reduced 2026-09-05:** `GET /projects/{id}/tasks` is dropped
   from this step's rationale, since v1 already serves it and no discovery call is saved. Routing
   project-task reads to v2 is still worth doing for `format=markdown`, but that is the whole
   justification now, not the endpoint itself. Note the read/write asymmetry: `PATCH` ignores
   `format`, so either the update path re-reads to get markdown, or the canonical shape tolerates
   both and callers are told which they have. Decide that explicitly here rather than in step 4.
4. **Task update** — the milestone's payoff: `PATCH` + inline assignees, selected only on servers
   >= 2.5.0 and falling to the v1 strategy on 2.4.0. Retires the fetch-merge-POST race on every
   version where v2 can be trusted to do it. No `subscription: null`, no bug-pinning test. Depends
   on the `minVersion` support added in step 1.
5. **`vikunja_task_bulk`** — **premise corrected 2026-09-05, and this step may not be worth doing.**
   v2 `PUT /tasks/bulk` wipes assignees exactly as v1's `POST /tasks/bulk` does (verified live on
   2.6.0: a task with one assignee and one label kept the label, lost the assignee, on both
   versions). That is expected, and `bulk-operations-simplified.ts` already predicts it from
   upstream source: `updateSingleTask()` calls `updateTaskAssignees()` *before* the `fields`
   allowlist gate, so a scalar-only payload decodes `assignees` to `nil` and trips the full-delete
   branch. v2 routes into the identical `models.BulkTask.Update()` chain, and `bulk_task.go`
   registers only `PUT`, so there is no v2 `PATCH` for bulk either. **The assignee snapshot/restore
   stays**, on both paths, with no removal condition. What remains of this step is the verb change
   and nothing else, so it should be sequenced last or dropped.
6. **Remaining PATCH routes**: projects, views, labels, filters, comments, teams.
7. **`expand`** — independent of v2 and **v1-only work in practice**, since v1 supports the entire
   value set including the three the draft called v2-only. It fixes a gap we have had all along;
   it is not a v2 adoption item. The real work is moving off `/tasks/all`, which rejects `expand`
   outright, onto `/tasks` or `/projects/{id}/tasks`, which accept it.

Steps 3–6 each: v2 strategy + v1 strategy + both tested + battle-harness call-count delta recorded.

## Non-goals

- Removing v1. **Restated 2026-09-05.** The support window is the trailing three releases, today
  **2.4.0** (floor), **2.5.0**, **2.6.0** (aligned default), per `SUPPORTED_VERSIONS` in
  `scripts/lib/e2e-target.ts`. Every supported version has a v2 API, so the original argument for
  keeping v1 (that the minimum version has none) no longer holds and must not be repeated.

  v1 remains the floor **per operation**, not per version. Three distinct reasons keep an operation
  on v1, and only the third is version-shaped:

  1. **No v2 equivalent exists at all**, on any version: `vikunja_admin list-users`, the two
     Unsplash background functions. Permanently v1.
  2. **v2 offers nothing over v1** for that operation: bulk update (identical shared model code,
     identical assignee wipe), `expand` (identical value set). v1 by default, not by necessity.
  3. **v2 is broken on some supported versions and fine on others**: task update, v1 on 2.4.0 and
     v2 from 2.5.0. This is what `minVersion` exists for, and it resolves itself as the window
     rolls forward.

  Note `src/utils/api-version.ts`'s own doc comment still says the minimum supported Vikunja is
  2.3.0 and has no v2 API. That is now wrong on both counts and should be corrected by whichever
  step first touches that file.
- Tool-surface change. Pagination totals, `max_permission`, and ETag caching are deliberately
  **not** surfaced to callers in P3 — that is a separate decision with its own migration story.
- v2-only resources (time entries, bots, sessions, OAuth) — new features, not this milestone.
- Optimistic concurrency via `If-Match` — the server does not enforce it.

## Acceptance criteria

- Against **2.5.0 and 2.6.0**: partial updates no longer read-modify-write; assignees survive an
  update that does not mention them; measured call-count reductions recorded against
  `optimalCallCount` per `docs/BATTLE-TESTING.md` (an optimum is derived from tool schemas, never
  set to an observed actual). Restated 2026-09-05: 2.4.0 cannot meet this, because task update
  deliberately stays on v1 there.
- Against **2.4.0** (the floor): every behaviour identical to 0.6.1, with task update on the v1
  strategy and no `subscription: null` anywhere in the codebase. The v1 floor fully intact.
- The assignee snapshot/restore in `bulk-operations-simplified.ts` is still present and still
  covered on **every** supported version. Its removal is not an acceptance criterion of this
  milestone and would be a regression.
- `resolveApiVersion` honours a per-operation `minVersion`, tolerates the leading `v` in the
  reported version, and resolves an undetected version to v1.
- Kill switch on against a v2-capable server behaves identically to a v1-only server.
- No tool-surface change; no caller-visible schema change.
- `docs/API-VERSION-MATRIX.md` (see below) accurate for every MCP function.
- Full gates green plus the live lanes across the whole support window (`test:matrix` covers six
  targets: 2.4.0, 2.5.0 and 2.6.0 against both DB backends). Restated 2026-09-05: 2.3.0 is out of
  the window and is not a lane.

## Public documentation

Two audiences, two documents:

- **`docs/API-VERSION-MATRIX.md`** (new, caller-facing) — one row per MCP function: which API
  versions can serve it, which this server actually uses, and *why* when that is not v2. This is
  the document that answers "is this function affected by a v2 quirk?" without reading code.
- **`docs/VIKUNJA_API_ISSUES.md`** (existing) — already carries the 2.4.0 `PATCH`/subscription 422
  as item #25. Updated 2026-09-05 to record the re-verification and to drop the withdrawn
  workaround prescription; there is no expiry condition and no upstream filing, because the fix
  already shipped in 2.5.0.

`docs/API-COVERAGE.md` is intentionally **not** the home for this: it is an endpoint-level audit
(169 v1 operations × implementation status) with a strict maintenance rule, denominated on v1. The
version matrix is a different axis for a different reader.

Maintenance rule for the matrix, mirroring `API-COVERAGE.md`'s: **a row changes in the same PR that
changes the behaviour it describes** — never as a later reconciliation pass.
