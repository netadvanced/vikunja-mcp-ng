# Vikunja v2 native adoption (P3) — design

**Date:** 2026-08-02
**Issue:** [#184](https://github.com/netadvanced/vikunja-mcp-ng/issues/184) — 0.7.0 milestone
**Scope:** P3 — routing real operations through v2, optimised for how v2 actually works.
**Predecessor:** `2026-07-27-vikunja-v2-transport-design.md` (P1+P2: transport, error adapter,
routing, kill switch — complete, merged behaviour-neutral).

## The reframing

P1+P2 treated v2 as "v1 with `PATCH`". Live investigation against a real 2.4.0 server disproved
that. v2 is a **different API that happens to expose most of the same resources**: different
response envelopes, different REST verb conventions, different query parameters, a different error
model, capabilities v1 lacks, and capabilities v1 has that it dropped.

So the goal is not "migrate to v2". It is **per-operation version selection with a canonical
internal shape** — each operation runs whichever version serves it best, and nothing downstream
can tell which ran.

This matters because mixed-mode is unavoidable, not a transitional state:

- `vikunja_admin list-users` has no v2 equivalent (see gaps below) — **permanently v1**.
- Unsplash backgrounds are absent from v2 entirely — **permanently v1**.
- Kanban buckets have no v2 `PATCH` (verified live: 405) — v1 for partial bucket updates.
- Token/session bootstrapping still points at `/api/v1/*` in v2's own spec.

A design that treats v1 as a temporary fallback would have to special-case all of these forever.
A design that treats version as a per-operation property does not.

## What is actually different (all verified live against 2.4.0 unless noted)

### v2-only capabilities worth having

| Capability | Detail |
|---|---|
| `PATCH` partial updates | 14 routes (7 in scope). v1 has 4, all admin-only. Removes fetch-merge-POST and the assignee snapshot/restore |
| `GET /projects/{id}/tasks` | **v1 has no such endpoint.** v1 must resolve a view first (`src/tools/projects/buckets.ts:505-544`). Removes a discovery call |
| `?format=markdown` | GFM markdown for every rich-text field (task/project/label/team/filter descriptions, comments). v1 is always HTML. For an MCP server feeding an LLM this is the single largest quality win |
| `problem+json` | One uniform error schema across 185/186 operations, with `errors[]` field details, `type`, `instance`. v1 mixes two schemas (163 `web.HTTPError` vs 184 `models.Message`) inconsistently |
| Envelope totals | `total`/`total_pages` typed and in-body. v1 has them only as undocumented `x-pagination-*` headers, unmodelled in its spec and unread by this codebase |
| `max_permission` | Requester's permission level, per entity. No v1 equivalent |
| ETag → 304 | On most single-entity `GET`s. v1 emits none |
| Inline assignees on write | `PATCH`/`POST` accept `assignees` in the body and apply them. Labels do **not** (verified) |
| Extra `expand` values | `comment_count`, `time_entries_count`, `is_unread` — cheap counts without fetching sub-collections |

### Corrections to earlier assumptions

Two things assumed during P1+P2 planning turned out to be wrong, and the design must not rest
on them:

- **`expand` is not a v2 feature.** v1 already supports `expand=subtasks|buckets|reactions|comments`
  on `/tasks`. We simply never used it. That is a missed optimisation on the **v1** path, tracked
  here as its own work item rather than sold as a v2 benefit.
- **Single-entity reads are not an N+1 win.** v1's `models.Task` already embeds `assignees`,
  `labels`, `attachments`, `related_tasks`, `reminders`. Only `max_permission` is genuinely new.

### Traps that will cause silent breakage

| Trap | Consequence if missed |
|---|---|
| Search param `s` → `q` | Filtering/search silently returns everything or nothing |
| Verb convention rewrite | v1 `PUT`=create/`POST`=update; v2 `POST`=create/`PATCH`=partial/`PUT`=replace. `/tasks/bulk` is `POST` in v1, `PUT` in v2 (a 405 in testing) |
| Response envelope | A list endpoint returns an object, not an array — breaks every caller expecting `[]` |
| `If-Match` is **not** enforced | Verified: a stale ETag was honoured, request succeeded. There is no optimistic-locking guarantee — do not build lost-update protection on it |
| `subscription` 422 | See below |

### The 2.4.0 `PATCH` blocker

`PATCH /api/v2/tasks/{id}` returns **422** (`body.subscription.entity="task"`, expected integer)
for any task carrying a subscription — and **assigning a user auto-subscribes them**, so the exact
case this milestone exists to fix is the one the route refuses.

Adding `subscription: null` to the merge-patch body makes it succeed, applies the change, and
preserves assignees. RFC 6902 json-patch hits the identical 422, so `patchFormat` cannot route
around it.

**Decision: ship the workaround, version-gated and pinned by test.** The server ignoring
`subscription: null` today is incidental; a future version honouring merge-patch null semantics
would silently unsubscribe users. Therefore:

- Applied only when the detected server version is in the affected range, never unconditionally.
- Pinned by a test that **fails if a PATCH ever removes a subscription** — so the day the semantics
  change, CI says so instead of users losing notifications silently.
- Filed upstream, with the gate removed once a fixed version is the floor.

## Architecture

### Strategy + Context per operation

Mirrors the existing, proven pattern in `src/utils/filtering/` (`FilteringContext` selecting
`TaskFilteringStrategy` implementations). For each operation with a meaningful v1/v2 divergence:

```
TaskUpdateContext
  ├─ V1TaskUpdateStrategy   GET (fetch) → POST (full model) → assignees → labels   [4 calls]
  └─ V2TaskUpdateStrategy   PATCH (inline assignees, subscription:null) → labels   [2 calls]
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
`openapi` key, rather than trusting the status code. A `serverVersion` floor check is the secondary
guard — note `/info` reports `v2.4.0` with a **leading `v`**, so a naive semver compare fails.

## Sequencing

Ordered so that each step's risk is retired before anything depends on it.

1. **Probe hardening** — nothing may route on a probe that can false-positive.
2. **Response normalization + envelope handling**, with the canonical-shape contract and its tests.
   No behaviour change yet; this is the boundary everything else relies on.
3. **Reads**: `GET /projects/{id}/tasks` (drops the view-resolution call), list endpoints, and
   `format=markdown`. Lower risk than writes and delivers the biggest caller-visible quality win.
4. **Task update** — the milestone's payoff: `PATCH` + inline assignees + the gated `subscription:
   null` workaround and its regression test. Retires the fetch-merge-POST race.
5. **`vikunja_task_bulk`** — retires the assignee snapshot/restore (`bulk-operations-simplified.ts`).
6. **Remaining PATCH routes**: projects, views, labels, filters, comments, teams.
7. **`expand` on both paths** — independent of v2; fixes a v1 gap we have had all along.

Steps 3–6 each: v2 strategy + v1 strategy + both tested + battle-harness call-count delta recorded.

## Non-goals

- Removing v1. Minimum supported Vikunja stays **2.3.0** (v1-only).
- Tool-surface change. Pagination totals, `max_permission`, and ETag caching are deliberately
  **not** surfaced to callers in P3 — that is a separate decision with its own migration story.
- v2-only resources (time entries, bots, sessions, OAuth) — new features, not this milestone.
- Optimistic concurrency via `If-Match` — the server does not enforce it.

## Acceptance criteria

- Against 2.4.0: partial updates no longer read-modify-write; assignees survive an update that does
  not mention them, with no snapshot/restore; measured call-count reductions recorded against
  `optimalCallCount` per `docs/BATTLE-TESTING.md` (an optimum is derived from tool schemas, never
  set to an observed actual).
- Against 2.3.0: every behaviour identical to 0.6.1 — the v1 floor fully intact.
- Kill switch on against a v2-capable server behaves identically to a v1-only server.
- No tool-surface change; no caller-visible schema change.
- `docs/API-VERSION-MATRIX.md` (see below) accurate for every MCP function.
- Full gates green plus both live lanes (`test:matrix` at 2.4.0 and 2.3.0).

## Public documentation

Two audiences, two documents:

- **`docs/API-VERSION-MATRIX.md`** (new, caller-facing) — one row per MCP function: which API
  versions can serve it, which this server actually uses, and *why* when that is not v2. This is
  the document that answers "is this function affected by a v2 quirk?" without reading code.
- **`docs/VIKUNJA_API_ISSUES.md`** (existing) — gains the 2.4.0 `PATCH`/subscription 422 with its
  workaround, expiry condition, and upstream reference.

`docs/API-COVERAGE.md` is intentionally **not** the home for this: it is an endpoint-level audit
(169 v1 operations × implementation status) with a strict maintenance rule, denominated on v1. The
version matrix is a different axis for a different reader.

Maintenance rule for the matrix, mirroring `API-COVERAGE.md`'s: **a row changes in the same PR that
changes the behaviour it describes** — never as a later reconciliation pass.
