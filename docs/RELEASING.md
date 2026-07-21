# Releasing

This is the ruleset for cutting a release of `vikunja-mcp-ng`. It assumes you're comfortable
with git but haven't necessarily tagged or published an npm package before — every step is
spelled out.

Companion reading: [docs/ROADMAP.md](ROADMAP.md) for where the project stands,
[CHANGELOG.md](../CHANGELOG.md) for what's already shipped,
[docs/LOCAL-TESTING.md](LOCAL-TESTING.md) for the version-matrix/e2e harnesses referenced in the
pre-tag checklist (§3, Step 5), and [docs/BATTLE-TESTING.md](BATTLE-TESTING.md) for the agent
battle-testing harness also referenced there.

## The short version

Releases are **deliberate, batch-time acts**, not something that happens automatically on every
merged PR. Someone decides "it's time to cut a release," picks patch or minor, runs
`release:prepare`, and — after the PR merges and the **mandatory pre-tag checklist** (§3, Step 5)
is green — runs `release:tag`, which triggers the rest. Version numbers change in exactly one kind
of PR: a release PR. Nowhere else.

```
decide scope → release:prepare → review PR → merge → pre-tag checklist → release:tag → (workflow publishes)
```

## 1. SemVer policy (pre-1.0)

This project is pre-1.0 (`0.x.y`), so we don't get to lean on strict SemVer's "breaking changes
require a major bump" — major stays at `0` until we declare the project stable (see §4). Instead
we use the common pre-1.0 convention:

| Bump | When | Example from this project |
|---|---|---|
| **patch** (`0.3.0` → `0.3.1`) | Bug fixes, doc corrections, dependency bumps, internal refactors — nothing a caller has to change for | `0.3.0 → 0.3.1`: response-formatting fixes (no tool signatures changed, output shape corrected) |
| **minor** (`0.3.x` → `0.4.0`) | New capability *or* a breaking change to tool inputs/outputs/config. Pre-1.0, minor absorbs both — there's no separate "major" lane to reach for | `0.3.x → 0.4.0`: next capability batch (new subcommands, new tools, or a config-shape change that requires updating `vikunja-mcp.config.json`) |
| **major** (`0.x.y` → `1.0.0`) | Reserved for the deliberate declaration that the project is stable. Not a size threshold — a status change | `1.0.0`: declared-stable criteria — see §4 |

Rule of thumb: **if existing users have to change anything to keep working (config keys, tool
argument shapes, removed subcommands, Node version floor), it's at least a minor bump, even
pre-1.0.** If they don't have to change anything, it's a patch.

When a batch of changes mixes both, the release takes the higher bump (one breaking-ish change in
a batch of ten bugfixes still makes it a minor).

## 2. Tags explained

A **tag** is a fixed, named pointer to one specific commit — unlike a branch, it doesn't move.
This project uses **annotated tags** (`git tag -a`, not lightweight `git tag`), which store a
message, an author, and a date, and can be verified independently of the commit they point at.

- Tag format: `vX.Y.Z` (e.g. `v0.3.1`), always on `main`, always on the commit that has that
  version in `package.json`.
- No release branches. `main` is the only place work lands and the only place tags are cut from.
- The tag's annotation message is the changelog section for that version — `git show v0.3.1` shows
  you exactly what shipped, no separate lookup needed.
- Pushing a tag matching `v*` is what triggers the release workflow immediately — see §6.

## 3. Release checklist

Run through this top to bottom. Steps 1–3 happen on a branch and go through a normal PR review.
Steps 4–7 happen on `main` after that PR is merged.

### Step 1 — Decide scope

Look at what's merged since the last tag (`git log v<last>..main --oneline`, or just read the
`[Unreleased]` section of `CHANGELOG.md` if it's been kept current). Decide **patch** or **minor**
per the table in §1. This is a judgment call — `release:prepare` doesn't decide it for you.

### Step 2 — Run `release:prepare`

```bash
npm run release:prepare -- patch   # or: npm run release:prepare -- minor
```

This script (`scripts/release-prepare.sh`):

- Refuses to run on a dirty tree or on `main` itself — it creates its own branch
  (`release/vX.Y.Z`) off an up-to-date `main`.
- Runs the full gate suite (lint, typecheck, tests, coverage) *before* touching anything —
  a release never starts from red.
- Bumps `package.json` (and `package-lock.json`) with `npm version <patch|minor> --no-git-tag-version`
  — no tag yet, that's step 5.
- Generates a draft changelog section from conventional commits (`feat:`, `fix:`, `chore:`,
  `docs:`, …) since the last tag, and inserts it into `CHANGELOG.md` under `[Unreleased]`.
- Commits everything as `release: vX.Y.Z`.
- Prints the next step: push the branch and open a PR.

### Step 3 — Review and curate the changelog, open the PR

The generated changelog section is a **draft**, grouped mechanically by commit prefix. Read it,
merge duplicate lines, cut noise (`chore: fix typo`), rewrite anything terse into something a user
would understand, and make sure entries are in the right Keep a Changelog category (Added /
Changed / Fixed / Removed / Security). This is the one manual step in the whole pipeline — commit
messages are written for git history, changelog entries are written for readers.

```bash
git push -u origin release/vX.Y.Z
gh pr create --repo netadvanced/vikunja-mcp-ng --base main \
  --title "release: vX.Y.Z" --body "See CHANGELOG.md"
```

### Step 4 — Merge the release PR

Ordinary PR review and merge, same gates as any other PR. Nothing special except that this PR is
the *only* kind allowed to touch the version field.

### Step 5 — Pre-tag verification checklist (mandatory)

**Do not run `release:tag` (Step 6) until every box below is checked.** Pushing a `vX.Y.Z` tag
immediately triggers the live, OIDC-authenticated publish workflow (§6) — there is no dry-run and
no "undo" for an npm publish. This checklist exists because the release-verification steps below
were, until now, only ever *practiced*, never written down; treat it as the actual gate, not a
suggestion.

- [ ] **Full local gates, clean.** `npm run lint && npm run typecheck && npm run test:coverage` —
      all three green on the exact commit you're about to tag (this should already be true, since
      the release PR that merged in Step 4 required it, but re-confirm on `main` after the merge,
      not just on the branch before it).
- [ ] **Version-matrix regression, both DBs, on the version this release aligns to.** Run
      `VIKUNJA_VERSION=<aligned> npm run test:matrix` for **both** `VIKUNJA_DB=postgres` and
      `VIKUNJA_DB=sqlite` against the Vikunja version this release is aligned to (§7) — see
      [docs/LOCAL-TESTING.md](LOCAL-TESTING.md#version-matrix-testing-npm-run-testmatrix) for what
      the matrix runner does and how to read a verdict file. `<aligned>` is whatever
      `docker/e2e/docker-compose.yml`'s default pin currently is (see LOCAL-TESTING.md's "Version
      pinning and refresh"); omit `VIKUNJA_VERSION` to use that default explicitly.
  - [ ] `VIKUNJA_VERSION=<aligned> VIKUNJA_DB=postgres npm run test:matrix` — PASS.
  - [ ] `VIKUNJA_VERSION=<aligned> VIKUNJA_DB=sqlite npm run test:matrix` — PASS.
  - [ ] **Minimum-supported-version floor regression:** `VIKUNJA_VERSION=2.3.0 npm run test:matrix`
        (postgres is sufficient for the floor check unless the release touches DB-concurrency
        behavior, in which case run both backends) — this is the documented minimum supported
        Vikunja version (currently `2.3.0`, see
        [docs/LOCAL-TESTING.md](LOCAL-TESTING.md#version-pinning-and-refresh)), and it is
        deliberately *not* the aligned/default version, so it never gets exercised by accident.
        A `FAIL` here needs the same triage as any other matrix failure (script staleness vs. real
        tool bug vs. new server-drift) before proceeding.
- [ ] **Live MCP harness expectations, read honestly, not assumed.** The matrix run above already
      executes both `npm run test:mcp` and `npm run test:e2e:mcp` per version/DB combination, but
      confirm you're reading the results against the *current* tolerances rather than stale
      memory of a previous release: open `scripts/mcp-e2e.ts` and check what is currently
      version-gated (as of this writing, one documented tolerance —
      `GET /tasks/{id}/assignees` 500s unconditionally below Vikunja 2.4.0, tolerated only on
      servers `< 2.4.0` and a hard failure on 2.4.0+; see `driftTolerated()` /
      `versionLessThan()` in that file and
      [docs/LOCAL-TESTING.md](LOCAL-TESTING.md#true-mcp-layer-e2e-harness-npm-run-teste2emcp)'s
      "Findings categorization" section). Any `✗` (hard failure) blocks the release; any `⚠
      server-drift` must match a tolerance actually present in `scripts/mcp-e2e.ts` today, not
      one you remember from an earlier version of this checklist — if the script's tolerances
      have changed since this paragraph was last edited, trust the script and update this
      paragraph in the same PR.
- [ ] **Battle smoke (cheapest scenario, manual, deliberate).** Run at least
      `npm run battle -- --scenario single-task-smoke --model haiku` (or the sonnet default) per
      [docs/BATTLE-TESTING.md](BATTLE-TESTING.md) — this is the harness that measures tool-surface
      ergonomics with a real agent, not just server correctness. **This costs real money and is
      never automated** (see BATTLE-TESTING.md's cost warning); a single cheap scenario is the
      floor for every release. If this release changes tool descriptions, argument shapes, error
      messages, or adds/removes subcommands, run the **full scenario library**
      (`npm run battle -- --all`) instead of just the smoke scenario, and read the friction report
      for regressions before tagging.
- [ ] **Changelog curation review, final pass.** Re-read the `CHANGELOG.md` section for this
      version one more time on `main` post-merge (not just during Step 3's PR review) — this is
      the text that becomes the annotated tag's message (§2) and the GitHub release notes (Step 7).
      Confirm it accurately reflects what's actually in this commit, is in the right Keep a
      Changelog categories, and (per §7) leads with the Vikunja alignment line if this release
      changes the base Vikunja version.

Only once every box above is checked, proceed to Step 6.

### Step 6 — Run `release:tag` (on `main`, after merge)

```bash
git checkout main && git pull
npm run release:tag
```

This script (`scripts/release-tag.sh`) reads the version out of `package.json`, verifies no tag
`vX.Y.Z` already exists, creates an **annotated** tag on `HEAD` whose message is the matching
`CHANGELOG.md` section, and pushes the tag. **Pushing this tag immediately triggers the live
release workflow** (§6) — this is the point of no return for this release; it's why Step 5 comes
first.

### Step 7 — the tag-triggered workflow does the rest (manual fallback: `release:publish`)

Pushing the tag in Step 6 is what actually kicks off the release: `.github/workflows/release.yml`
triggers on any `v*` tag push and, on the tagged commit, re-runs the full gates then publishes to
npm via **OIDC trusted publishing** (no tokens or repository secrets — npmjs.com is configured to
trust this exact repo + workflow filename, and npm's provenance attestation is generated
automatically), builds and pushes the Docker image (`ghcr.io/netadvanced/vikunja-mcp-ng:X.Y.Z`,
`:latest`, and the `:X.Y.Z-vikunja<A.B.C>` compatibility tag, §7), and runs `gh release create
vX.Y.Z` using the `CHANGELOG.md` section as the release notes. This is the normal path — nothing
further to run by hand once the tag lands, other than watching the workflow run go green.

`scripts/release-publish.sh` (`npm run release:publish`) is the **documented manual fallback**,
kept fully equivalent (minus provenance) for the case where Actions is unavailable:

```bash
git checkout vX.Y.Z   # or just stay on main right after tagging
npm run release:publish
```

This script re-runs the full gates, then does the same three things by hand: `npm publish
--access public`, build-and-tag the Docker image (push only with `--push`), and `gh release
create vX.Y.Z`.

## 4. What "1.0.0" means

`1.0.0` is deferred until the project is declared stable — that's an explicit owner decision, not
a metric threshold crossed automatically. At minimum it implies: the tool surface (subcommand
shapes, config schema) is not expected to change without a deprecation window, general per-PR
GitHub Actions CI is live (today only the tag-triggered release workflow runs Actions, §6; regular
PR/branch CI remains off by explicit owner decision, tracked in `docs/ROADMAP.md` §3b), and the
owner says so in a release PR. Until then, every `0.x` release may contain breaking changes in a
minor bump per §1 — that's the pre-1.0 deal.

## 5. Who does what

- **Owner**: decides *when* to release and *what scope* (step 1). Reviews and curates the
  changelog (step 3). Approves and merges the release PR (step 4). Decided to install the
  tag-triggered GitHub Actions workflow (§6, 2026-07-20) and owns any further change to it.
- **Agents / anyone with repo access**: can execute the mechanical steps (2, 6, 7) and run the
  verification checklist (5) once the owner has signed off on scope — these are scripts and
  documented checks, not judgment calls. An agent should still surface the generated changelog for
  owner review rather than merging it unseen, and should report the checklist results (matrix
  verdicts, harness output, battle-smoke result) rather than just asserting "done".

## 6. Automation status

- **Local scripts**: `scripts/release-{prepare,tag,publish}.sh` — usable standalone at any time,
  no CI dependency. `release:publish` in particular is the documented manual fallback for Step 7
  if Actions is ever unavailable (see below).
- **Installed and active**: `.github/workflows/release.yml` — a tag-triggered
  (`on: push: tags: ['v*']`) GitHub Actions workflow, installed 2026-07-20 by explicit owner
  decision (see the header comment in that file). It is the **only** Actions workflow in this
  repository — the previously-inherited `ci.yml`/`security.yml` were removed when it was
  installed, so "only releases run CI" is enforced structurally, not just by convention. It runs
  the full gate suite, then does Step 7's publish work automatically: `npm publish` via OIDC
  trusted publishing (no npm token, no repository secret — npmjs.com trusts this exact
  repo + workflow filename, and provenance attestation is generated automatically), the Docker
  build/push (using the built-in `GITHUB_TOKEN` for GHCR), and `gh release create`. Everyday PRs
  and branch pushes are unaffected: the workflow only ever triggers on a `v*` tag push. General
  per-PR CI remains off by separate, still-standing owner decision — see `docs/ROADMAP.md` §3b —
  this workflow's install did not change that.

## 7. Vikunja compatibility

Docker images carry a **Vikunja compatibility tag** in addition to the semver tags, so a deployer
can pick an image that matches their Vikunja server version:

```
ghcr.io/netadvanced/vikunja-mcp-ng:X.Y.Z                  (this exact release)
ghcr.io/netadvanced/vikunja-mcp-ng:X.Y.Z-vikunja<A.B.C>   (this exact release, spelling out
                                                            what Vikunja version it's aligned to)
ghcr.io/netadvanced/vikunja-mcp-ng:latest                 (newest release)
```

e.g. release `0.3.1` aligned to Vikunja `2.3.0` produces `:0.3.1` and `:0.3.1-vikunja2.3.0`.

This follows the same convention as images like `node:20-alpine`: the leading component is always
*our* version, and the trailing component is a suffix that qualifies it, never a standalone
identifier. Alignment info only ever appears as a suffix on our own version, so a tag can never be
misread as "this image *is* Vikunja 2.3.0" — it's always unambiguous that `2.3.0` here describes
compatibility, not identity. We deliberately do not publish a standalone `:vikunja-<ver>`-style
tag (an earlier revision of this scheme did): that tag floated, re-pointing at whichever release
was newest for a given server version, which is exactly the version-number ambiguity this scheme
exists to eliminate. `X.Y.Z-vikunja<A.B.C>` names one exact release, same as the bare `X.Y.Z` tag
— if you want "newest", use `:latest`.

**Single source of truth**: `scripts/lib/vikunja-compat-version.sh` derives the compat version
from the vendored OpenAPI spec's `info.version` field (`docs/vikunja-openapi.json`) — the same
spec our generated TypeScript types are built from — normalized from its `git describe` form
(`v2.3.0-1019-g95b7e673`) down to the base release (`2.3.0`). It cross-checks that against the
Vikunja image pin in `docker/e2e/docker-compose.yml` and prints a loud warning (not a hard
failure) if they've drifted apart. Nothing else hand-types this version: `scripts/release-publish.sh`
and `.github/workflows/release.yml` both call this script rather than embedding the
number.

The image also carries this as OCI labels so the alignment survives a retag even without the tag
name: `org.opencontainers.image.version=<X.Y.Z>` and `io.vikunja.compat=<2.3.0>`.

**Release rule**: if a release changes the base Vikunja version this project targets (a
`docs/vikunja-openapi.json` refresh or an `e2e` pin bump that moves the base version), that's at
least a **minor** release per §1 — the tool contract is now validated against a different server
baseline — and its changelog entry and release notes should lead with *"now aligned to Vikunja
X.Y.Z"* so deployers notice. Every release's notes state the Vikunja version it's aligned to,
whether or not it changed.

Before cutting that release, actually validate against the new server version rather than just
bumping the pin: `VIKUNJA_VERSION=X.Y.Z npm run test:matrix` (see
[docs/LOCAL-TESTING.md](LOCAL-TESTING.md#version-matrix-testing-npm-run-testmatrix)) runs both
local e2e harnesses against it in one command and writes a pass/fail verdict, refresh the vendored
spec from the pinned container if needed (`VIKUNJA_VERSION=X.Y.Z npm run e2e:up && npm run
fetch:api-spec:container && npm run generate:api-types` — see
[docs/API-SPEC.md](API-SPEC.md#where-the-spec-comes-from) for why the container, not
`try.vikunja.io`/`npm run fetch:api-spec`, is the source of truth here: the container's own spec
matches its tag exactly, `try.vikunja.io` always runs `unstable`, ahead of any tag), *then* bump
the default `e2e` pin and proceed with the release scope/checklist above.

## 8. The one rule that matters most

**`main` is always releasable.** Every PR — release or otherwise — must land with lint, typecheck,
and the full test suite (with coverage gate) green. A release should never require "wait, let me
also fix this failing test first" — if it does, that fix is its own PR that lands *before* the
release PR, not folded into it. And version numbers in `package.json` change in release PRs only —
never as a side effect of a feature or fix PR.
