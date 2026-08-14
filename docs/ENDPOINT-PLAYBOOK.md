# Endpoint Implementation Playbook

The conventions every new or changed Vikunja API capability follows, agent or
human. This is a working checklist, not an essay — if you're about to write a
new tool, subcommand, or REST call site, read this first.

Companion docs:

- [ROADMAP.md §1](ROADMAP.md) and [§3](ROADMAP.md) — the vision and locked
  decisions this playbook implements. Read those two sections first.
- [API-SPEC.md](API-SPEC.md) — where the vendored OpenAPI spec comes from and
  how to refresh it.
- [API-COVERAGE.md](API-COVERAGE.md) — the endpoint-by-endpoint audit.
- [API_NOTES.md](API_NOTES.md) and [VIKUNJA_API_ISSUES.md](VIKUNJA_API_ISSUES.md)
  — hard-won gotchas. Do not regress what they document.
- [TOOLS.md](TOOLS.md) — the user-facing reference every new subcommand must
  be added to.

## 1. Composite-first design

The OpenAPI spec is a **coverage checklist**, not a tool design. Don't mirror
endpoints 1:1. Design the smallest set of task-level subcommands an AI caller
actually needs, per [ROADMAP.md §1](ROADMAP.md) pillar 1:

- **Ensure-semantics / idempotency.** Prefer create-if-missing and no-op-on-
  retry over raw create/delete primitives where the caller's intent is "make
  this exist" or "make this be gone" rather than "perform this exact API call
  once."
- **Resolve-by-name internally.** Don't make the caller pre-fetch ids they
  shouldn't have to know. Exemplar: `setTaskBucket`
  (`src/tools/tasks/buckets.ts`) — the caller supplies a task id and a bucket
  id; the project id and Kanban view id are resolved internally via
  `vikunjaRestRequest` lookups (`resolveKanbanViewId` in
  `src/utils/vikunja-rest.ts`) rather than demanded as required arguments.
  Composites that resolve a username or a label/project title to an id follow
  the same shape: resolve first, call second, never make the model guess an id.
- **Verify-then-apply.** For mutations with side effects that matter (e.g.
  destructive or hard-to-undo changes), read current state, check it's what
  you expect, then write — don't write blind.
- **Read composites.** Where a caller would otherwise need several round
  trips to answer one question (e.g. "what's the state of this project"),
  offer a single read that assembles the answer in one call instead of
  making the client stitch several together.
- **Primitives stay available.** Plain CRUD subcommands remain for fine-
  grained control — composites are additive, not a replacement for direct
  access.

## 2. Spec-verification workflow

`docs/vikunja-openapi.json` (the vendored v1 spec) is the **only** source of
truth for paths, verbs, and body field names. The v2 spec is vendored alongside
it as `docs/vikunja-openapi-v2.json`. See [API-SPEC.md](API-SPEC.md) for how
both are refreshed (`npm run fetch:api-spec*`) and how the generated types
under `src/types/generated/` are produced.

- **Before coding:** look up the exact path, HTTP verb, and request/response
  body field names in the spec. Do not infer them from memory or from a
  similar-looking endpoint.
- **After coding:** re-check your implementation against the spec once more
  — field names are the most common place for drift (`right` vs
  `permission`, `filter` vs `filter_by`, nested vs flat, etc.).
- **The spec always wins.** The old `node-vikunja` client library (frozen at
  v0.4.0, May 2025, confirmed to have drifted from the real API in multiple
  places) has been fully removed from this project (ROADMAP §3 decision 2) —
  it is no longer a dependency and no call sites remain. Nothing in the repo
  outranks the spec.

## 3. Direct-REST rule

- All HTTP calls go through `vikunjaRestRequest`
  (`src/utils/vikunja-rest.ts`). The migration off `node-vikunja` is
  complete: the library is gone from `package.json` and there are no
  remaining call sites to migrate, so there is nothing to add here beyond
  "use `vikunjaRestRequest`".
- `VikunjaClientFactory` (`src/client/VikunjaClientFactory.ts`) no longer
  creates a typed client; it only carries the session's `AuthManager`, which
  is what `vikunjaRestRequest` needs. The `clientFactory` parameter on
  `register*Tool(server, authManager, clientFactory?)` is retained purely for
  call-site compatibility.
- Type new REST calls against the types generated from the vendored OpenAPI
  spec (`src/types/generated/vikunja-openapi.d.ts` — auto-generated, do not
  hand-edit; see [API-SPEC.md](API-SPEC.md)).

## 4. Full-model-replace warning

Several Vikunja update endpoints (notably `POST /projects/{id}`) **replace
the entire resource** — any field you omit from the body is cleared
server-side, not left untouched. Before wiring an update endpoint, check the
spec for whether it's a full-replace (`PUT`/`POST` with a full model schema)
or a genuine partial-update (`PATCH`, or an endpoint documented as
merge-semantics).

**Pattern: fetch → merge → POST.** Exemplar: `buildProjectUpdatePayload`
(`src/tools/projects/crud.ts`) — fetches the current resource, spreads it,
then overlays only the fields the caller actually supplied, so untouched
fields survive the round trip. `updateProject`, `archiveProject`,
`unarchiveProject`, and `moveProject` all build their payload this way.
Watch for exceptions where "omitted" has real meaning: `moveProject` always
sets `parent_project_id` explicitly (to the new parent, or `0` for root)
because an omitted value there means "move to root," not "leave untouched"
— merge-preserves-untouched-fields is the default, but check whether your
endpoint has a field like this before assuming it applies uniformly.

## 5. Non-atomicity rules

Vikunja has no transactions. Never let a composite's response *imply*
atomicity it doesn't have.

- **Partial-success reporting is the default.** Multi-step composites must
  report which steps succeeded and which failed, explicitly, in the
  response — not swallow a mid-sequence failure into a generic error
  (batch-import precedent).
- **`CompositeOperation` saga helper** (`src/utils/composite-operation.ts`)
  provides opt-in best-effort rollback for composites that want it: steps
  with optional compensations, reverse-order rollback on
  failure, full trace reporting (completed / compensated /
  compensation-failed + manual-fix guidance). Rules baked into it — follow
  them even in code that doesn't use the helper directly:
  - Destructive steps go **last** — Vikunja has no undelete.
  - Update-rollback restores the before-snapshot the fetch-merge-POST
    pattern already captured (§4) — don't fetch twice.
  - Guard on the resource's `updated` timestamp before compensating: if it
    changed since your snapshot, warn and don't clobber a concurrent edit.
  - Rollback is **opt-in per call** (`atomic: true`). Best-effort
    partial-success stays the default.
  - This is not real ACID: no isolation, and side effects (webhooks) fire on
    intermediate writes even if a later step fails and triggers rollback.
    Tool descriptions for any composite offering `atomic: true` must say so.
  - Prefer idempotent forward-recovery (ensure-semantics, §1) over rollback
    wherever "retry to completion" is a better UX than "undo and report
    failure."

## 6. Testing bar

The ratcheted gate lives in `jest.config.js` — currently **83 branches / 82
functions / 92 lines / 92 statements** (see root `CLAUDE.md` for the
never-lower policy). But the bar that actually catches bugs is stricter than
the number:

- **Assert on the outgoing payload, not just the return value.** A mock that
  only checks the tool's return value can pass while the actual request body
  sent to the API is wrong. This is exactly how the `moveProject`
  data-wipe bug (fixed in the Wave B projects PR) shipped: `moveProject` sent
  a bare `{ parent_project_id }` as the *entire* body of a full-model-replace
  endpoint, silently clearing `title`/`description`/`hex_color`/etc. on every
  move — and the tests only checked the resolved response, never asserted the
  request body. Now that every call goes through `vikunjaRestRequest`, every
  write test needs an assertion shaped like this:

  ```ts
  expect(vikunjaRestRequest).toHaveBeenCalledWith(authManager, 'POST', '/projects/1', {
    // ...the full expected payload, not just the field you changed
  });
  ```

- **Mock the *real* API shape, not a convenient one.** The users-settings
  nesting bug (Wave B `waveB-users-settings-nesting` PR) is the cautionary
  tale: `GET /user` actually returns settings nested under a `settings`
  sub-object, but the test mock returned them flat, matching the (wrong)
  code under test — the mock and the bug agreed with each other, so nothing
  failed. Build mocks from the OpenAPI spec's response schema, not from what
  makes the current implementation pass.
- Both rules apply doubly to test files that predate the `node-vikunja`
  removal: their mocks may still be shaped like that library's drifted types
  even though the library itself is gone. Re-derive them from the spec when
  you touch them, don't carry them forward unchanged.

## 7. Subcommand / tool naming conventions

- Tools are `vikunja_<domain>`, domain in plural where the domain is a
  resource collection (`vikunja_tasks`, `vikunja_projects`, `vikunja_teams`).
- Every tool follows the subcommand pattern: a `subcommand` (or, in the older
  `vikunja_filters`, `action`) Zod enum routes to a handler — see root
  `CLAUDE.md`'s Tool Design Pattern. New tools use `subcommand`.
- Subcommand names are kebab-case verbs/verb-phrases matching what the
  caller is trying to do, not the HTTP verb: `set-bucket`, `apply-label`,
  `bulk-update`, `list-reminders`. Prefer `<verb>-<noun>` (`add-reminder`)
  over a bare verb when the tool has more than one thing that verb could
  apply to. (`toggleAdmin` on `vikunja_teams` predates this convention —
  match new work to kebab-case, not that exception.)
- Composite/ensure operations are named for the outcome, not the mechanism.
  The shipped examples: `vikunja_labels ensure` (get-or-create, not
  `find-or-create`), `vikunja_projects share-with-user` /`share-with-team`
  (resolve-username-then-grant, not `resolve-and-share`), and
  `vikunja_projects setup-kanban` (the outcome, not `create-project-and-
  buckets-and-tasks`).
- Honesty in descriptions: if a tool or subcommand can't fully do what its
  name implies (no binary delivery, no persistence across restarts, no real
  atomicity), the Zod tool description says so in plain language — see
  `vikunja_filters` and `vikunja_templates` for the current examples, and
  the `vikunja_export_project` / `vikunja_request_user_export` descriptions
  (`src/tools/export.ts`) for the house style on how bluntly to state a
  limitation.

## 8. Registration boilerplate every tool needs

A new tool is not done when its handler works. Every currently registered
tool (verify against `src/tools/index.ts`) wires up all four of these:

- **`withReadOnlyNote(toolName, description)`** wraps the tool description,
  and **`getToolAnnotations(toolName)`** is passed as the annotations
  argument to `server.tool(...)` — both from `src/utils/read-only.ts`.
- **`assertWriteAllowed(toolName, subcommand)`** runs inside the handler,
  after the auth check and before any write, so global read-only mode
  rejects the call (see
  [CONFIGURATION.md#global-read-only-safety-mode](CONFIGURATION.md#global-read-only-safety-mode)).
- **Classify every new subcommand** in `TOOL_CLASSIFICATIONS`
  (`src/utils/read-only.ts`) as read / write / destructive — an unclassified
  subcommand gets the wrong annotations and the wrong read-only treatment.
- **Register in `src/tools/index.ts` behind a module key** from
  `ModulesConfigSchema` (`src/config/types.ts`), adding the key if the tool
  is a new domain. Anything credential-adjacent or irreversible goes in
  `DANGEROUS_MODULE_KEYS` (deny-by-default) and, if its endpoints are
  JWT-only per the spec, is additionally gated on
  `authManager.getAuthType() === 'jwt'` — module config can only narrow what
  auth already allows, never widen it. Then document it in
  [TOOLS.md](TOOLS.md) and [CONFIGURATION.md](CONFIGURATION.md#known-modules).
