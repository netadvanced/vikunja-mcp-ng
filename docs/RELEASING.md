# Releasing

The ruleset for cutting a release of `vikunja-mcp-ng`. It assumes you're comfortable with git but
haven't necessarily tagged or published an npm package before. Every step is spelled out. An
operator should be able to execute a release from this document alone.

Companion reading: [docs/ROADMAP.md](ROADMAP.md) for where the project stands,
[CHANGELOG.md](../CHANGELOG.md) for what's already shipped,
[docs/LOCAL-TESTING.md](LOCAL-TESTING.md) for the version-matrix/e2e harnesses referenced in the
pre-tag checklist, and [docs/BATTLE-TESTING.md](BATTLE-TESTING.md) for the agent battle-testing
harness also referenced there.

## 1. Policy

- **Pre-1.0 SemVer.** This project is `0.x.y`; major stays at `0` until the project is declared
  stable: a milestone this document deliberately does not yet define criteria for. We use the
  common pre-1.0 convention:

  | Bump | When |
  |---|---|
  | **patch** (`0.5.0 → 0.5.1`) | Bug fixes, doc corrections, dependency bumps, internal refactors: nothing a caller has to change for. |
  | **minor** (`0.5.x → 0.6.0`) | New capability *or* a breaking change to tool inputs/outputs/config. Pre-1.0, minor absorbs both: there's no separate major lane to reach for. Also the bump for any change to the base Vikunja version this project targets (§3). |
  | **major** (`0.x.y → 1.0.0`) | Reserved for the deliberate declaration that the project is stable: a status change, not a size threshold. |

  Rule of thumb: **if existing users have to change anything to keep working (config keys, tool
  argument shapes, removed subcommands, Node version floor), it's at least a minor bump, even
  pre-1.0.** A batch that mixes patch- and minor-level changes takes the higher bump.

- **Prereleases ship on their own channel, never on `latest`.** A version carrying a semver
  prerelease suffix (`0.7.0-beta.1`) is published under the identifier in that suffix as its
  dist-tag: `beta` on npm, `:beta` on GHCR, and marked as a pre-release on GitHub. `latest` keeps
  pointing at the newest *stable* version on both registries, so `npm install vikunja-mcp-ng` and
  `docker pull …:latest` are unaffected and testers opt in deliberately with
  `npm install vikunja-mcp-ng@beta`. This matters more than it looks: npm applies `latest` to
  whatever it is handed unless `--tag` says otherwise: **it does not infer a channel from the
  version string**. So a prerelease published without care becomes the default install for every
  user. The workflow derives the channel from the tag itself (§2, Step 6) precisely so that nobody
  has to remember this at publish time.

  Use a beta line when a feature is complete and tested but wants real-world exposure before it
  becomes what everyone gets by default. Promote it with an ordinary `minor` bump once it holds:
  `0.7.0-beta.3 → 0.7.0`.

- **Releases are deliberate, batch-time acts**, never something that happens automatically on a
  merged PR. Someone decides "it's time to cut a release," picks patch or minor, and runs the flow
  in §2. Version numbers in `package.json` change in exactly one kind of PR, a release PR,
  and nowhere else.

- **Curated changelog from conventional commits.** `CHANGELOG.md` follows [Keep a
  Changelog](https://keepachangelog.com/en/1.0.0/). Each release's section starts as a mechanical
  draft generated from conventional commit prefixes (`feat:`, `fix:`, `chore:`, `docs:`, …) since
  the last tag, then gets hand-curated (§2, Step 2) into something a user would actually want to
  read. This is the one manual, judgment-driven step in an otherwise scripted pipeline. The
  annotated release tag's message and the GitHub release notes are both generated directly from
  this section, so what you write there is what ships in three places at once.

- **`main` is always releasable.** Every PR (release or otherwise) lands with lint, typecheck,
  and the full coverage-gated test suite green. A release should never require "let me also fix
  this failing test first"; that fix is its own PR that lands *before* the release PR.

## 2. Release flow

```text
release-prepare.sh <patch|minor|preminor|prerelease> → curate CHANGELOG → open release PR
  → merge → pre-tag checklist → release:tag → tag-triggered workflow publishes
```

Steps 1–3 happen on a branch and go through normal PR review. Steps 4–6 happen on `main` after
that PR merges. Steps 1, 2, 4, and 5 are things an operator (human or agent, once scope is
decided) does by hand; step 6 is fully automated by `.github/workflows/release.yml` once the tag
lands.

### Step 1: Decide scope and run `release:prepare`

Look at what's merged since the last tag (`git log v<last>..main --oneline`, or the `[Unreleased]`
section of `CHANGELOG.md` if it's current) and decide **patch** or **minor** per §1. This is a
judgment call the script doesn't make for you. Then:

```bash
npm run release:prepare -- patch   # or: npm run release:prepare -- minor
```

For a beta line, use the `pre*` scopes (`--preid` defaults to `beta`):

```bash
npm run release:prepare -- preminor     # 0.6.2        → 0.7.0-beta.0   start the line
npm run release:prepare -- prerelease   # 0.7.0-beta.0 → 0.7.0-beta.1   advance it
npm run release:prepare -- minor        # 0.7.0-beta.3 → 0.7.0          promote to stable
```

That last transition is worth reading twice: **`minor` applied to a prerelease of `0.7.0` yields
`0.7.0`, not `0.8.0`**: semver treats a prerelease as *before* the version it is a prerelease of,
so promoting is a `minor` bump, not a further one. (`patch` on a beta does the same thing.) The
script does not compute any of this itself; it asks `npm version` against a throwaway copy of
`package.json`, so its prediction and the real bump can never disagree.

`scripts/release-prepare.sh`:

- **Must be run from a clean, up-to-date `main`**: it refuses a dirty tree, refuses any other
  branch, and refuses when local `main` differs from `origin/main`. It then creates its own
  `release/vX.Y.Z` branch for you. (Corrected 2026-08-03: this used to read "refuses to run on
  `main` itself", which is the opposite of what the script checks.)
- Runs the full gate suite (lint, typecheck, tests, coverage) before touching anything: a release
  never starts from red.
- Bumps `package.json`/`package-lock.json` via `npm version <patch|minor> --no-git-tag-version`:
  no git tag yet, that's Step 5.
- Syncs `server.json`'s two version fields (the MCP registry manifest) to the bumped version and
  asserts they match, so the published manifest can't drift from `package.json` (#186).
- Generates a draft changelog section from conventional commits since the last tag and inserts it
  into `CHANGELOG.md` under `[Unreleased]`.
- Commits everything as `release: vX.Y.Z` and prints the next steps. It never pushes and never
  opens a PR; that's the operator's job next, so a human reviews the generated changelog first.

### Step 2: Curate the changelog, open the PR

The generated section is a mechanical draft grouped by commit prefix. Read it, merge duplicate
lines, cut noise (`chore: fix typo`), rewrite terse entries into something a reader would
understand, and confirm entries sit in the right Keep a Changelog category (Added / Changed /
Fixed / Removed / Security). If this release changes the base Vikunja version the project targets,
lead the section with *"now aligned to Vikunja X.Y.Z"* (§3).

```bash
git push -u origin release/vX.Y.Z
gh pr create --repo netadvanced/vikunja-mcp-ng --base main \
  --title "release: vX.Y.Z" --body "See CHANGELOG.md"
```

### Step 3: Merge the release PR

Ordinary review and merge, same gates as any other PR, nothing special except this PR is the
*only* kind allowed to touch the version field.

### Step 4: Pre-tag verification checklist (mandatory)

**Do not run `release:tag` (Step 5) until every box below is checked.** Pushing a `vX.Y.Z` tag
immediately triggers the live, OIDC-authenticated publish workflow (Step 6): there is no dry-run
and no undo for an npm publish.

- [ ] **Full local gates, clean.** `npm run lint && npm run typecheck && npm run test:coverage`:
      all three green on the exact commit you're about to tag. This should already be true from
      Step 3's merge gate, but re-confirm on `main` post-merge, not just on the branch beforehand.
- [ ] **Version-matrix regression, both DBs, on the version this release aligns to.** Run
      `VIKUNJA_VERSION=<aligned> npm run test:matrix` for both `VIKUNJA_DB=postgres` and
      `VIKUNJA_DB=sqlite`; see
      [docs/LOCAL-TESTING.md](LOCAL-TESTING.md#version-matrix-testing-npm-run-testmatrix) for what
      the runner does and how to read a verdict file. `<aligned>` is whatever
      `docker/e2e/docker-compose.yml`'s default pin currently is (currently `2.4.0`; see
      LOCAL-TESTING.md's "Version pinning and refresh"); omit `VIKUNJA_VERSION` to use that
      default explicitly.
  - [ ] `VIKUNJA_VERSION=<aligned> VIKUNJA_DB=postgres npm run test:matrix`: PASS.
  - [ ] `VIKUNJA_VERSION=<aligned> VIKUNJA_DB=sqlite npm run test:matrix`: PASS.
  - [ ] **Minimum-supported-version floor regression: NOT APPLICABLE while floor == aligned.**
        The floor rose to `2.4.0` on 2026-08-31 (docs/ROADMAP.md §3 decision 27), which is also
        the aligned/default version, so the two runs above **are** the floor run. Do not run a
        separate floor lane: pointing it at `2.4.0` re-runs work already done, and pointing it at
        `2.3.0` verifies a version this project no longer supports (and where nine shipped
        operations do not exist at all). This box is deliberately left in place rather than
        deleted: the safeguard it describes, a floor version *deliberately different from the
        default so it never gets exercised by accident*, is real and returns the moment the
        aligned version moves past `2.4.0` (issue #237 proposes 2.6.0). When that happens,
        restore this as a live checkbox and set `FLOOR_VERSION` in `scripts/lib/e2e-target.ts` +
        `MIN_SUPPORTED_VIKUNJA` in `scripts/lib/vikunja-compat-version.sh` accordingly.
- [ ] **Live MCP harness expectations, read honestly, not assumed.** The matrix run above already
      executes both `npm run test:mcp` and `npm run test:e2e:mcp` per version/DB combination, but
      confirm you're reading the results against the *current* tolerances, not stale memory of a
      previous release: open `scripts/mcp-e2e.ts` and check what is currently tolerated. **As of
      2026-08-31 there are zero `driftTolerated()` call sites**: the last one (`GET
      /tasks/{id}/assignees` 500s below Vikunja 2.4.0) was removed with the floor raise, since a
      server below the floor is unsupported and its bugs should fail loudly. The mechanism is
      retained for the next such regression. Any `✗` (hard failure) blocks the release; any `⚠
      server-drift` must match a tolerance actually present in `scripts/mcp-e2e.ts` today; if the
      script's tolerances have changed since this paragraph was last edited, trust the script and
      update this paragraph in the same PR.
- [ ] **Battle smoke (cheapest scenario, manual, deliberate).** Run at least
      `npm run battle -- --scenario single-task-smoke --model haiku` (or the sonnet default) per
      [docs/BATTLE-TESTING.md](BATTLE-TESTING.md), the harness that measures tool-surface
      ergonomics with a real agent, not just server correctness. **This costs real money and is
      never automated** (see BATTLE-TESTING.md's cost warning); one cheap scenario is the floor
      for every release. If this release changes tool descriptions, argument shapes, error
      messages, or adds/removes subcommands, run the full scenario library
      (`npm run battle -- --all`) instead and read the friction report for regressions before
      tagging.
- [ ] **Changelog curation, final pass.** Re-read the `CHANGELOG.md` section for this version once
      more on `main` post-merge (not just during Step 2's PR review): this text becomes the
      annotated tag's message and the GitHub release notes (Step 6). Confirm it's accurate, in the
      right Keep a Changelog categories, and leads with the Vikunja alignment line if applicable
      (§3).

Only once every box above is checked, proceed to Step 5.

### Step 5: Run `release:tag` (on `main`, after merge)

```bash
git checkout main && git pull
npm run release:tag
```

`scripts/release-tag.sh` reads the version out of `package.json`, verifies no tag `vX.Y.Z` already
exists, creates an **annotated** tag (`git tag -a`, not lightweight) on `HEAD` whose message is the
matching `CHANGELOG.md` section, and pushes it. A tag is a fixed pointer to one commit, always on
`main`. There are no release branches. **Pushing this tag immediately triggers the live release
workflow** (Step 6): this is the point of no return; it's why Step 4 comes first.

### Step 6: The tag-triggered workflow does the rest

Pushing the tag is what actually kicks off the release. `.github/workflows/release.yml` triggers
on any `v*` tag push and, on the tagged commit:

1. **`npm` job**: re-runs the full gate suite (lint, typecheck, tests, coverage, build) on the
   tagged commit; the release never publishes from an environment that hasn't re-verified green.
2. Verifies the tag matches `package.json`'s version, then derives the compat and min-supported
   Vikunja versions from `scripts/lib/vikunja-compat-version.sh` (§3).
3. Publishes to npm via **OIDC Trusted Publishing** (`npm publish --access public --tag <channel>`),
   no npm token and no repository secret involved; npmjs.com is configured to trust this exact repo +
   workflow filename, and provenance attestation is generated automatically.
4. **`image` job (matrix, one runner per architecture)**: builds `linux/amd64` on `ubuntu-latest`
   and `linux/arm64` on a **native `ubuntu-24.04-arm` runner** (free for public repos), each
   pushing *by digest only*, with the OCI labels `org.opencontainers.image.version`,
   `io.vikunja.compat`, and `io.vikunja.min-supported`.
5. **`manifest` job**: assembles the two digests into one multi-arch manifest list and applies
   every tag to it: `:X.Y.Z`, `:<channel>`, `:X.Y.Z-vikunja<aligned>`, and (when the floor differs)
   `:X.Y.Z-vikunja<floor>`, all aliases on a single digest (§3).
6. **`release` job**: runs `gh release create vX.Y.Z` with the `CHANGELOG.md` section as the
   notes, plus an auto-appended **Artifacts** footer (npm link and the tag→digest table), which is
   why it can only run after the manifest exists. Prereleases additionally get `--prerelease`, so
   they never claim the repository's "Latest" badge.

**The channel is derived from the tag, in one place.** The `npm` job's first step reads the version
out of the tag and resolves `<channel>` from it: a bare `0.7.0` gives `latest` (identical to every
release cut before this existed), while `0.7.0-beta.1` gives `beta` and `0.7.0-rc.2` gives `rc`:
the first dot-separated field of the semver prerelease suffix. That single value then drives the npm
dist-tag, the moving GHCR tag, and whether the GitHub release is flagged as a pre-release, so those
three can never disagree with each other. Tagging is the only decision; there is no separate "is
this a beta?" switch to forget.

**Every publishing step is idempotent, and the workflow has a manual re-run entry point.** `npm
publish` is skipped when the version is already on the registry, image tags are overwritten with
identical content, and `gh release create` is skipped when the release exists. So a run that dies
partway can be resumed with `workflow_dispatch` (input: an existing tag, e.g. `v0.6.2`) instead of
needing a new version. This is not theoretical: emulated (QEMU) arm64 builds hung until the 6-hour
job limit *after* npm publish had already succeeded, so `0.6.1` and `0.6.2` both reached npm with no
image and no GitHub release; both were recovered by re-dispatch on 2026-07-28 once the native-runner
rebuild (#204) landed. If a tag's npm version is live but its GHCR tags or GitHub release are
missing, re-dispatch first; do not cut a new version.

This is the **only** Actions workflow in this repository. Everyday PRs and branch pushes never
trigger it; general per-PR CI remains off by separate, still-standing owner decision (see
`docs/ROADMAP.md` §3b). Nothing further to run by hand once the tag lands, other than watching the
workflow run go green and, given the above, confirming all four artifact classes actually exist
(npm version, `:X.Y.Z` + compat image tags, GitHub release). If Actions is ever unavailable, see the
Appendix for the manual fallback.

## 3. Vikunja alignment workflow

How this project tracks new upstream Vikunja releases, proven end-to-end aligning to 2.4.0
(tracking issue #28, item A1):

1. A new upstream Vikunja version ships.
2. Validate the tool surface against it before touching any pins:
   `VIKUNJA_VERSION=<new> npm run test:matrix` for both `VIKUNJA_DB=postgres` and `sqlite`, **and**
   the minimum-supported floor to confirm the floor still holds; see
   [docs/LOCAL-TESTING.md](LOCAL-TESTING.md#version-matrix-testing-npm-run-testmatrix). The floor
   is currently `2.4.0`, i.e. the same as the aligned version, so that second run collapses into
   the first; it becomes a distinct `VIKUNJA_VERSION=<floor> npm run test:matrix` again as soon
   as this step moves the aligned version past the floor.
3. Refresh the vendored spec from the pinned container and regenerate types:
   `VIKUNJA_E2E_TARGET=<new>-postgres npm run e2e:up && npm run fetch:api-spec:container && npm run
   generate:api-types`. Use the container spec, not `npm run fetch:api-spec` (which hits
   `try.vikunja.io`'s `unstable` build, always ahead of any tag); see
   [docs/API-SPEC.md](API-SPEC.md#where-the-spec-comes-from).
   **Two mechanical traps since the per-version e2e stacks landed** (#206, verified 2026-08-03).
   First, `npm run e2e:up` selects its stack from `VIKUNJA_E2E_TARGET` (`<version>-<db>`), **not**
   from `VIKUNJA_VERSION`: `docker/e2e/bootstrap.sh` derives and re-exports `VIKUNJA_VERSION` from
   the resolved target, so setting it yourself is silently ignored and you get the default
   `2.4.0-postgres` stack. (`npm run test:matrix` is the exception: it still reads
   `VIKUNJA_VERSION`/`VIKUNJA_DB` and translates them into a target, so Step 4's commands are
   unaffected.) Second, each target gets its **own port** (`8000 + MMP` for postgres, so `2.4.0` →
   8240, `2.5.0` → 8250; see `scripts/lib/e2e-target.ts`), while `fetch:api-spec:container` curls a
   hardcoded `localhost:8240`. Fetching a *new* version's spec therefore needs that script's port
   updated in the same alignment PR, or you will vendor the old stack's spec and notice nothing.
4. Audit the coverage delta: diff the refreshed spec against `docs/API-COVERAGE.md` for new,
   removed, or changed endpoints and update that doc's counts accordingly.
5. Bump the default `e2e` pin in `docker/e2e/docker-compose.yml` (and `docker/e2e/bootstrap.sh`'s
   matching default) to the new version.
6. Open an alignment PR containing the spec/type refresh, the coverage audit update, and the pin
   bump.
7. Ship it as a **minor** release (§1): a change to the base Vikunja version is a change to the
   server baseline the tool contract is validated against, never a patch. Lead the changelog entry
   with *"now aligned to Vikunja X.Y.Z"*.

> **Owner-discretion exception (pre-1.0).** The "alignment ⇒ minor" rule above governs the release
> that *announces* alignment to users, the one whose changelog leads with *"now aligned to Vikunja
> X.Y.Z"*. Pre-1.0, the owner may let the mechanical **groundwork** for an alignment (the pin bump,
> spec/type refresh, drift-gating) ride along in a patch release *without* claiming the alignment
> headline, deferring the announced-and-hardened alignment milestone to a later minor. This was
> exercised for `0.5.2` (2026-07-22): it carried the 2.4.0 groundwork plus additive/non-breaking
> fixes as a patch, while `0.6.0` (shipped 2026-07-24) was reserved as the deliberate *"optimised
> for Vikunja 2.4"* reliability/agent-ergonomics milestone. **Verified/corrected, 2026-07-24:** at
> the time this note was first written, `0.6.0` was also expected to carry the v2 API fast-paths;
> in practice `0.6.0` only vendored the v2 spec/types (prep, not wired into runtime; see its
> CHANGELOG "Internal" section) and the fast-path migration itself was deferred to a later release
> (0.7.0; see `docs/ROADMAP.md` §2/§6). The exception mechanism still worked exactly as designed;
> only the boundary of what rode along in which release shifted, which is itself the kind of
> owner-discretion latitude this note exists to describe. Use sparingly and only when nothing a
> caller relies on changes; the default remains a minor.
>
> **Exercised twice more since, both for additive capability rather than alignment groundwork
> (recorded 2026-08-03).** `0.6.1` (2026-07-25) shipped the new `setup-kanban` composite and the
> multi-task label subcommands as a **patch**, and `0.6.2` (2026-07-28) shipped `setup-kanban`'s
> optional `columns` the same way. Each release's own CHANGELOG carries the reasoning inline
> ("nothing a caller relies on changed: every addition is additive"), with `0.7.0` deliberately
> reserved for the v2 API migration. Three exercises in, the honest summary of the pre-1.0
> convention is: *new capability defaults to minor, but purely additive capability may ride a patch
> when the owner is holding the next minor for a named milestone*, and the changelog must say so
> where users will read it, as all three did.

**Compat tag semantics.** Every release's Docker image carries a `-vikunja<A.B.C>` suffix on its own
version, never a standalone tag: `X.Y.Z-vikunja<A.B.C>` (e.g. `0.5.2` → `:0.5.2-vikunja2.4.0`), the
same convention as `node:20-alpine`. This is deliberate: an earlier scheme published a standalone
floating `:vikunja-<ver>` tag that re-pointed at whichever release was newest for a server version;
exactly the ambiguity this scheme exists to avoid. **The image is tagged once per Vikunja version
the release's matrix actually validated**: currently both the aligned version and the min-supported
floor, so you get `:X.Y.Z-vikunja<aligned>` and `:X.Y.Z-vikunja<floor>` as aliases on the *same
image digest* (the image is server-version-agnostic; the suffixes advertise the tested range, not
separate builds). `scripts/lib/vikunja-compat-version.sh` is the single source of truth for both:
the aligned version is derived from the vendored spec's `info.version`, the floor from its
`MIN_SUPPORTED_VIKUNJA` constant (`--min-supported`); it also cross-checks the aligned value against
the `e2e` pin and warns (doesn't fail) on drift. The image also carries these as OCI labels
(`org.opencontainers.image.version`, `io.vikunja.compat`, `io.vikunja.min-supported`) so the tested
range survives a retag.

**Minimum-supported vs. aligned**: the project supports a floor version in addition to the
current aligned/default version. **They currently coincide (floor `2.4.0`, aligned `2.4.0`)**,
so a release publishes one compat alias, not two: `release.yml` compares `MIN` against `COMPAT`
and omits the duplicate `:X.Y.Z-vikunja<min>` tag and its release-notes row when they match. See
[docs/LOCAL-TESTING.md](LOCAL-TESTING.md#version-pinning-and-refresh) for the policy and what
keeps a workaround alive past the point its target bug is fixed upstream.

## 4. Appendix: manual fallback

`scripts/release-publish.sh` (`npm run release:publish`) is the documented fallback for the rare
case where GitHub Actions is unavailable and a release can't wait. It is **disaster-recovery
only**: the tag-triggered workflow (§2, Step 6) is the normal path for every release.

```bash
git checkout vX.Y.Z   # or stay on main right after scripts/release-tag.sh
npm run release:publish            # add --push to also push the Docker image
```

It re-verifies HEAD is the tagged commit, re-runs the full gate suite, then does by hand what the
workflow does automatically: `npm publish --access public`, build-and-tag the Docker image
(pushed only with `--push`), and `gh release create vX.Y.Z` from the `CHANGELOG.md` section.

Unlike the tag-triggered workflow, this path does **not** use OIDC Trusted Publishing: `npm
publish` here authenticates as whatever account is logged in locally, which for an account with
2FA set to "auth and writes" (the norm for a security-conscious npm org) means an **interactive
npm web-auth prompt (security-key/WebAuthn confirmation) in a browser** during the publish step.
It is not headless and cannot run unattended in CI; another reason it's a fallback, not the
primary path.
