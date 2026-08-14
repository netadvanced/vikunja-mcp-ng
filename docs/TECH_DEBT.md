# Technical Debt

The open, verified technical-debt register for `vikunja-mcp-ng`: what is genuinely still wrong in
the tree, what it would cost to fix, and what has been checked and closed. Every item below was
re-verified against current `src/` and `tests/` on **2026-08-03** — an item that cannot be
reproduced from the working tree is marked resolved and kept only as a record, never left standing
as if it were still true. Architecture context lives in [ARCHITECTURE.md](ARCHITECTURE.md); the
forward-looking plan lives in [ROADMAP.md](ROADMAP.md), which is where *new capability* is tracked
rather than here.

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

*Last updated 2026-08-03 (audit pass: every item re-verified against the working tree — one
resolved, one corrected, one re-scoped). Previous update: November 20, 2024, pre-fork.*
