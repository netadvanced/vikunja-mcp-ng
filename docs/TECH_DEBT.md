# Technical Debt

The open, verified technical-debt register for `vikunja-mcp-ng`: what is genuinely still wrong in
the tree, what it would cost to fix, and what has been checked and closed. Every item below was
re-verified against current `src/` and `tests/` on **2026-08-03**, then extended on **2026-08-31**
from a frozen-tag audit at `audit-final-20260831` (`e2a8dbff`) — an item that cannot be
reproduced from the working tree is marked resolved and kept only as a record, never left standing
as if it were still true. Architecture context lives in [ARCHITECTURE.md](ARCHITECTURE.md); the
forward-looking plan lives in [ROADMAP.md](ROADMAP.md), which is where *new capability* is tracked
rather than here.

The 2026-08-31 items (`AUDIT-001` … `AUDIT-008`) are confirmed against that tag, not against
whatever `main` has moved to since. Re-verify the cited `file:line` on this branch before
treating one as still open. Full evidence pack, suspected-not-promoted, and decision-log drops:
[AUDIT-2026-08-31.md](audits/AUDIT-2026-08-31.md). Fixes and process tooling are **held**.

## AUDIT-001 — `vikunja_tasks list` reports complete from one clamped page

**Still open. Highest-value class on this register: success with a wrong answer.** Same family as
#225/#244, but those closed the **fallback** aggregation path. The **primary** success path was
not.

### Current State

| Fact | Value (verified at `e2a8dbff`) |
|---|---|
| Default pagination | `FilterExecutor` sets `per_page=1000`, `page=1` when the caller omits them (`src/tools/tasks/filtering/FilterExecutor.ts:232-241`) |
| Cross-project | One `GET /tasks` (`src/utils/filtering/RestCrossProjectFilteringStrategy.ts:90-113`). No further pages. No `resultComplete: false`. |
| Filtered single-project | One `GET /projects/{id}/tasks` (`src/utils/filtering/ServerSideFilteringStrategy.ts:46-88`) |
| Unfiltered single-project | `ClientSideFilteringStrategy` auto-paginates and **is clean** |
| Upstream clamp | Vikunja `service.maxitemsperpage`, default 50 (`pkg/web/handler/read_all.go`) |

**Scenario.** `vikunja_tasks list` with no `page`/`perPage` (typical agent call). Vikunja returns
the first 50 rows. The tool says `Found 50 tasks` with `success: true`. Matching tasks on later
pages never appear.

Multi-group `filter` + `done` makes it worse: `done` is not folded into the server filter string
and is only applied after that truncated page (`FilterValidator.ts:279-281`,
`FilterExecutor.ts:148-154`).

Same class, smaller surface (kept here so they are not re-filed separately):

- `vikunja_notifications list` + `unreadOnly` filters client-side over one `GET /notifications`
  page (`src/tools/notifications.ts:159-172`).
- `list-comments` is an unpaged `GET /tasks/{id}/comments`
  (`src/tools/tasks/comments/CommentOperationsService.ts:62-68`).

### Decision and Timing

Fix before any further “list completeness” work. The fallback already has `resultComplete` /
`warnings`; the primary path should grow the same signal **and** actually page. Do not “fix” this
by lowering `per_page` without paging — that just makes the lie smaller.

## AUDIT-002 — templates persist file mixes oidc-http tenants

**Still open when `templates.persistPath` / `VIKUNJA_MCP_TEMPLATES_FILE` is set.** In-memory
buckets are correctly `(issuer\|sub)`-keyed. The file is not.

Hydrate (`src/tools/templates.ts:99-104`) loads every `PersistedTemplateRecord` into the current
session. Persist (`:124-136`) writes this session’s list over the whole file. Records have no
identity field (`src/storage/templateFileStore.ts`).

**Scenario (oidc-http + persist on).** A creates a template → file = A. B’s first list hydrates
A’s templates into B. B persists → A’s durable set is gone or merged under B.

`docs/OIDC-RESOURCE-SERVER.md` isolation matrix requires “persistence file rows keyed
distinctly”. That row is unimplemented; `tests/oidc/isolation.test.ts` does not cover persist.

Default (in-memory only) is unaffected. If persist stays stdio/single-tenant, say so in
CONFIGURATION.md and fail closed in `oidc-http` rather than leaking.

## AUDIT-003 — JWT-only tool gates still read the process-global `AuthManager`

**Still open in oidc-http.** `resolveEffectiveAuthManager` makes REST ALS-correct. Registration
(`src/tools/index.ts:215`) and per-call JWT gates (`users.ts:236`, `export.ts:212`,
`admin.ts:140`, `user-deletion.ts:101`) still consult the **closure** manager.

If env auto-connects a JWT onto the global manager, JWT-only tools appear for every caller,
including `tk_*` vault users. The inverse fails closed. The OIDC doc’s “env token ignored on the
wire” is true for REST, false for the auth surface.

## AUDIT-004 — bulk `BatchProcessor` singletons do not serialize across requests

**Still open.** `processors.create|update|delete`
(`src/tools/tasks/bulk-operations-simplified.ts:72-125`) are process singletons. Each
`processBatches` constructs its own `Semaphore`. Intra-call create concurrency is still 1; N
concurrent oidc-http `bulk-create`s ⇒ N concurrent creates — the SQLite lock → breaker cascade
#116 was written to prevent, now cross-request.

## AUDIT-005 — `auth-share` emits a live JWT in the MCP response

**Still open.** `src/tools/projects/sharing.ts:514-540` puts `authResult` (includes
`auth.Token.token`) into the tool body. Tests assert this
(`tests/tools/projects/sharing.test.ts:416-427`). Not a deny-by-default mint tool; webhook create
already redacts the equivalent secret.

Structural sibling (promote only the JWT emission as the defect; this is the pipe): thrown
`error.message` never passes logger redaction, and `SecureErrorHandler.sanitize`
(`src/utils/error-handler.ts:25-42`) has no bare-`eyJ` rule.

## AUDIT-006 — `vikunja_templates instantiate` reports success on partial work

**Still open.** `src/tools/templates.ts:536-598`: task create failures and label-attach failures
are `logger.warn` only. Message is always `Project "…" created from template "…"`.
`createStandardResponse` defaults `success: true`. `failedTasks` lives in `data` only.
`createdTasks: 0` still looks like success. Violates ROADMAP §1 pillar 4.

## AUDIT-007 — `list-members` maps a failed teams fetch to “0 teams”

**Still open.** `src/tools/projects/sharing-access.ts:759-812`: users rejection hard-fails; teams
rejection becomes `teams = []` with no error field. Summary claims `0 direct team(s)` and
`success: true`. Shares at least set `linkShares.available: false`.

## AUDIT-008 — confirmed, lower priority (do not re-discover)

See [AUDIT-2026-08-31.md](audits/AUDIT-2026-08-31.md) §AUDIT-008 for file:line. Short list: process-global
webhook `eventCache`; unmasked OIDC `sub` in logs; `FilterStorageManager` cleanup vs in-flight
`getStorage`; `normalizedKeyCache` maxSize unenforced; client-side filter budget overshoot when
`autoPaginate` is false.

**Explicitly not on this register:** shared circuit breakers (ROADMAP 16c / OIDC D3, accepted);
briefing-known items (#237 expand/401 chain, create-not-retried, percentDone scale, date-only
update gap, dead `src/transforms/task.ts`).

## ARCH-003 — AORP Markdown Helper: marked.js Migration Opportunity

**Still open, and still test-only.** `tests/utils/markdown.ts` remains a hand-rolled `markdown-it`
token walker, and `marked` is not a dependency of this project (`grep '"marked"' package.json
package-lock.json` returns nothing). Nothing here touches shipped runtime code, which is why it has
never blocked a release — and also why it keeps losing to work that does.

### Current State

| Fact | Value (verified 2026-08-03) |
|---|---|
| File | `tests/utils/markdown.ts`, 329 lines |
| Parser | `markdown-it` ^14.3.0 + `@types/markdown-it` (devDependencies) |
| Dedicated tests | 55, across `tests/utils/markdown.test.ts`, `tests/utils/aorp-helpers.test.ts`, `tests/aorp-helpers.test.ts` |
| Consumers | 23 test files (`grep -rl "utils/markdown" tests/ \| wc -l`) |

**The original entry's provenance did not survive the fork.** It cited "commit b401fbe" and a
330-line / 16-test / 6-file state; that commit is not reachable in this repository's history, and
the counts have drifted. Corrected above from the working tree rather than carried forward.

### Identified Improvements

**1. Manual AST token walking (~208 lines) — high priority.** Custom token traversal in
`getHeadings()` (line 51), `getSectionContent()` (line 137) and `getSectionListItems()` (line 182);
all three are still present and unchanged in shape. The recommendation is marked.js's `walkTokens`
API. Estimated effort: 8 hours.

```typescript
// Current shape (~208 lines of manual traversal):
for (let i = 0; i < tokens.length; i++) {
  const token = tokens[i];
  if (token.type === 'heading_open') {
    // manual lookahead for inline content, close token, nesting depth
  }
}

// Target shape:
marked.use({
  walkTokens: (token) => {
    if (token.type === 'heading') {
      headings.push({ level: token.depth, text: token.text });
    }
  },
});
```

**2. Regex-based metadata extraction (~70 lines) — medium priority.** Brittle regex parsing in
`getOperationMetadata()` (line 257); the `keyValuePattern` regex is still at line 268 and is still
applied twice against two different section shapes. The recommendation is a structured
frontmatter/metadata parser. Estimated effort: 4 hours.

```typescript
// Current: hand-rolled key/value scraping plus manual sanitisation
const keyValuePattern = /\*?\*?([A-Za-z\s_]+)\*?\*?:\s*(.+)/g;

// Target: a real frontmatter/structured-metadata parser, e.g. remark-frontmatter
```

### Cost and Benefit

| Improvement | Code reduction | Claimed performance gain | Claimed maintenance saving |
|---|---|---|---|
| AST walking | 208 lines | 10x faster | $15,000/year |
| Metadata parsing | 70 lines | Better reliability | $7,500/year |
| **Total** | **278 lines** | **Significant** | **$22,500/year** |

**Read that table as a claim, not a measurement.** The dollar figures and the "10x faster" number
come from the pre-fork November 2024 audit and have never been reproduced in this repository. The
*code* findings above re-verify line by line; the *economics* do not, and should not be quoted as if
they did — this is a test helper inside a suite that runs end to end in roughly 18 seconds.

### Migration Plan

Estimated 2–3 weeks, low risk, backward compatible.

1. **marked.js integration.** Add `marked` (+ types), replace the AST walking with `walkTokens`,
   port the helper methods, then run the existing suite — minimal test changes expected.
2. **Structured metadata parsing.** Replace `getOperationMetadata()`'s regex scraping, add explicit
   error handling for malformed markdown, update the helper's doc comment.
3. **Validation.** Benchmark the before/after (which is also how the "10x" claim finally gets
   confirmed or dropped), and verify backward compatibility across all 23 consumer test files.

### Decision and Timing

**Proceed when there is slack, not before.** The case for is unchanged: a production-ready
foundation already exists, the migration path is low-risk and incremental, and it aligns with the
project's anti-wheel-reinvention principle. The case against is scheduling only — this is test
infrastructure that currently works.

**Nothing actually gates this work.** The original entry said to "complete ARCH-002 (snapshot tests)
first", but no such work item exists: the only `ARCH-002` marker in the codebase is in
`src/middleware/simplified-rate-limit.ts` ("ARCH-002: Fixed unbounded memory leak with TTL-based
cleanup"), a different item that is already done. Treat this migration as ungated.

**Implementation notes.** `markdown-it` was a sound original choice; the argument for marked.js is
its `walkTokens` API specifically, not parser quality. All existing tests should pass with minimal
changes, and the `unified`/`remark` ecosystem is the natural direction if the helper ever needs more
than heading/section extraction.

## Additional Items (Low Priority)

**Unused imports in test files — still open.** `npm run lint` covers `src` only; running the same
config over the test tree (`npx eslint tests --ext .ts --config eslint.config.mjs`) reports 698
problems, a spread of them `@typescript-eslint/no-unused-vars`. The scoping is deliberate, not an
oversight, but the debt is real the moment `tests/` is brought under the lint gate.

**Standardize error handling patterns — largely landed, remaining scope unclear.**
`src/utils/error-handler.ts` is the centralized path CLAUDE.md documents and is referenced by 31
modules under `src/`, alongside `src/utils/auth-error-handler.ts` and `src/utils/http-error-detail.ts`.
Whether anything specific is still non-standard was not recoverable from this entry's original
one-line description; it needs a concrete definition or deletion, and is kept open only so that call
gets made deliberately.

## Resolved

**TypeScript strict-mode warnings in middleware — resolved, verified 2026-08-03.** `tsconfig.json`
sets `"strict": true`, `npm run typecheck` (both projects) is clean, `npx eslint src/middleware`
reports nothing, and there are zero `@ts-ignore` / `@ts-expect-error` escapes anywhere in `src/`.
Nothing remains to address; kept here as a record so the item is not re-filed from memory.

---

*Last updated 2026-08-31 (AUDIT-001…008 added from frozen-tag audit at `e2a8dbff`; evidence in
[AUDIT-2026-08-31.md](audits/AUDIT-2026-08-31.md); fixes held). Previous full re-verification: 2026-08-03.
Previous update: November 20, 2024, pre-fork.*
