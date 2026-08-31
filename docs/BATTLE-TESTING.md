# Agent Battle-Testing Harness

`npm run battle` spawns a real, headless AI agent against this repo's own MCP
server and measures how hard the tool surface is to use. It is part 2 of the
testing plan — part 1 is the version-matrix runner in
[docs/LOCAL-TESTING.md](LOCAL-TESTING.md) — and shipped as wave item T2 of
tracking issue [netadvanced/vikunja-mcp-ng#28](https://github.com/netadvanced/vikunja-mcp-ng/issues/28).

This harness answers a different question than `npm run test:mcp` /
`npm run test:e2e:mcp` / `npm run test:matrix`. Those prove the tools work
correctly against a real Vikunja server. This harness measures something
else: **how well an actual AI agent copes with the tool surface** when
handed a natural-language task and nothing else — no test-writer holding
its hand, no known-good call sequence. It's a UX benchmark for the tool
descriptions, argument shapes, and error messages themselves.

It spawns a real, headless `claude -p` session whose only tools are this
repo's own MCP server build (plus the one built-in tool needed to discover
it — see "Why `ToolSearch` is granted" below) and grades the run two ways:

1. **DID IT WORK** — verified with direct Vikunja REST calls
   (`scripts/battle/lib/verify.ts`), never the agent's own self-report.
2. **HOW HARD** — parsed from the full JSONL transcript
   (`scripts/battle/lib/transcript-parser.ts` +
   `scripts/battle/lib/friction.ts`): tool-call count vs. a hand-estimated
   optimum, validation/argument errors, retries, wrong-tool attempts, tool
   discovery overhead, tokens, wall time, cost.

## Cost warning: deliberate, manual runs only

**Every invocation other than `--list` spends real money against the
configured Anthropic account.** This harness is **never** wired into CI, a
pre-commit hook, `npm test`, or any other automatic trigger — it only runs
when a human deliberately types the command. Nothing in this repository
calls `scripts/battle/run-scenario.ts` on your behalf.

Rough costs observed while building this harness (Claude Code 2.1.214,
2026-07):

| What | Model | Cost |
|---|---|---|
| Cheapest scenario (`single-task-smoke`) | haiku | ~$0.07 |
| Cheapest scenario (`single-task-smoke`) | sonnet | typically a few times the haiku cost |
| Full scenario library (13 scenarios), one model | sonnet | expect several dollars — run scenarios individually first if you're cost-sensitive |

Always start with `npm run battle -- --list` (free) and a single cheap
scenario before running `--all`.

## Quick start

```bash
# See what's available (no agent spawned, free).
npm run battle -- --list

# Run one scenario with the cheapest available model -- good for a first try.
npm run battle -- --scenario single-task-smoke --model haiku

# Run one scenario with the default model.
npm run battle -- --scenario q3-offsite-kanban

# Run the whole library (reads the cost warning above first).
npm run battle -- --all --model haiku

# Keep the created Vikunja data around after the run for manual inspection
# (normally cleaned up automatically -- see "Safety" below).
npm run battle -- --scenario subtask-breakdown --keep
```

Requires:

- The local e2e stack up and healthy: `npm run e2e:up` (see
  [docs/LOCAL-TESTING.md](LOCAL-TESTING.md)). The runner resolves the target's API URL through
  `scripts/lib/e2e-target.ts` (default target `2.4.0-postgres`, i.e.
  `http://localhost:8240/api/v1`; pick another with `VIKUNJA_E2E_TARGET`)
  and mints its own credential the same way `docker/e2e/bootstrap.sh` /
  `scripts/mcp-e2e.ts` do — it does not need the target's
  `docker/e2e/.env.<version>-<db>` file to exist.
- The `claude` CLI on `PATH`, logged in (this harness invokes it exactly
  like a human running `claude -p ...` at their own terminal).

Output goes to `battle-results/<run-id>/` (gitignored — regenerate, don't
commit):

```text
battle-results/<run-id>/
  <scenario-id>/
    prompt.txt          the exact prompt sent (after {{prefix}} substitution)
    mcp-config.json     the generated --mcp-config file for this run
    transcript.jsonl    full stream-json transcript
    stderr.log          claude CLI's stderr, if any
    verdict.json        { verification, friction } for this scenario
  friction-report.md    aggregated, cross-scenario markdown report
```

## Safety model

This mirrors the pattern in `scripts/mcp-e2e.ts` / `scripts/test-matrix.ts`
(see those files' headers for the fuller rationale) — copied deliberately
rather than re-derived, since it protects against a real, previously-seen
incident class (a harness inheriting ambient Vikunja credentials and
running against a real account instead of the disposable stack):

- The target URL always comes from the local-only target resolver
  (`scripts/lib/e2e-target.ts`, default `http://localhost:8240/api/v1`),
  only overridable via the harness-specific `BATTLE_VIKUNJA_URL` /
  `VIKUNJA_E2E_TARGET` (never the ambient `VIKUNJA_URL`), and
  `assertLocalUrl` aborts the whole run before
  anything else happens if that URL doesn't resolve to
  localhost/127.0.0.1/`::1`. This repo directory has a real, production
  `.envrc` — the harness never reads `.env`/`.envrc`.
- The credential handed to the agent's MCP server child process is always
  freshly minted against that (now guaranteed-local) stack via
  login + `PUT /tokens`, exactly like `docker/e2e/bootstrap.sh`. The
  ambient `VIKUNJA_API_TOKEN` is never consulted, and the generated
  `--mcp-config` hardcodes both the URL and the token in that config
  server's `env`, so even if the `claude` process itself inherited some
  ambient credential, the MCP server child it spawns still gets ours.
- Every scenario's Vikunja data is tagged with a unique
  `battle-<runid>-<scenario-id>-` title prefix. The runner sweeps by prefix
  **before and after every scenario**. The bare `battle-` sweep that catches
  leftovers from a previous crashed run under a different run id is **opt-in
  via `--sweep-all`** (issue #205): it would delete a concurrently-running
  harness's data, so it only runs when you ask for it. Pass `--keep` to skip
  the after-sweep for
  one scenario when you want to inspect the result in the Vikunja UI --
  clean it up yourself afterward, or just let the next run's sweep catch it.
- The stack itself is never brought up, torn down, or version-switched by
  this harness — unlike `scripts/test-matrix.ts`, it assumes the stack is
  already up (`npm run e2e:up`) and only ever talks to it over HTTP.

## Why `ToolSearch` is granted

The runner passes `--tools ToolSearch` (not `--tools ''`). This was not the
first thing tried — with zero built-in tools granted, a live smoke-test run
showed the agent could see `vikunja-battle`'s tools were configured
(`mcp_servers: [{name: "vikunja-battle", status: ...}]` in the transcript's
`init` line) but had literally no mechanism to ever load an individual
tool's schema and call it: this environment's MCP tools are **deferred
tools**, discovered via the built-in `ToolSearch` tool, and without
`ToolSearch` itself the agent just hallucinated fake tool-call-shaped text
instead of ever touching Vikunja. Granting exactly `ToolSearch` (and no
other built-in: no `Bash`, `Read`, `Write`, etc.) fixes that while keeping
every actual unit of work confined to `vikunja_*` calls.

This has a real consequence for how the friction numbers should be read:
`ToolSearch` calls are tracked separately
(`FrictionReport.toolSearchCallCount`), not folded into `toolCallCount` or
`wrongToolAttemptCount` — discovering a tool isn't a mistake, it's required
plumbing in this environment. But the count itself is still a genuine
ergonomics signal worth reporting: the harness's own first live smoke run
(see "Live smoke test evidence" in the PR this shipped in) needed **8**
`ToolSearch` calls to do **3** actual `vikunja_*` calls — a haiku-model
agent visibly floundering on the `select:name1,name2` query syntax before
landing on the right incantation. If a future Claude Code release changes
how MCP tools are exposed (no longer deferred, or a different discovery
mechanism), re-run the smoke test and update this section plus
`scripts/battle/run-scenario.ts`'s `--tools` value accordingly — don't
assume this behavior is permanent; re-verify with
`claude -p --help` and a throwaway smoke run the way this section was
originally derived (see git history / the PR description for the exact
transcript that revealed it).

## The scenario library

`scripts/battle/scenarios/*.json`, each validated against `ScenarioSchema`
(`scripts/battle/types.ts`) at load time. Currently 14 scenarios:

| id | optimal | probes |
|---|---|---|
| `q3-offsite-kanban` | 1 | Pierre's canonical example: a single sentence hiding a multi-step composite (project + 3-column Kanban + 10 tasks + priorities + due dates). `optimalCallCount` dropped from 15 to 1 once the `setup-kanban` composite (issue #173) shipped — see `setup-kanban-composite` below |
| `setup-kanban-composite` | 1 | added alongside issue #173's `setup-kanban` composite: a q3-offsite-kanban-style prompt (new project, 4-column board, 8 tasks distributed across columns, priorities, due dates) specifically probing whether the agent reaches for the one-call composite instead of hand-rolling create -> create-bucket (xN) -> bulk-create -> set-bucket/bulk-set-bucket (xN) |
| `filter-high-priority-search` | 3 | the Vikunja filter query language ([docs/API_NOTES.md](API_NOTES.md)'s filter notes) |
| `share-project-by-user` | 3 | project link-sharing discoverability |
| `subtask-breakdown` | 3 | subtask creation (Vikunja has no first-class subtask resource — it's a task relation under the hood). Re-baselined 2026-07-25 from 5 to 3: `bulk-create-subtasks` reaches the same end state in one call instead of one `create-subtask` call per subtask — see "Re-baselining `optimalCallCount`" below |
| `bulk-create-subtasks` | 3 | bulk-create-subtasks composite discoverability vs. one `create-subtask` call per subtask |
| `bulk-priority-bump` | 3 | bulk-edit discoverability vs. one-call-per-task |
| `bulk-set-bucket` | 1 | bulk-set-bucket composite discoverability vs. moving each task into its Kanban column one at a time. Re-baselined 2026-07-25 from 9 to 1: this scenario's prompt is a verbatim match for `setup-kanban` (PR #175) — see "Re-baselining `optimalCallCount`" below |
| `labels-due-date-combo` | 1 | label creation + application + due dates combined in one ask, now solved by `setup-kanban`'s columns-less form (issue #185): `title` + `tasks` (each carrying `labels`/`dueDate`), no `columns` — one call, zero Kanban structure touched. PR #179 briefly re-baselined this to 1 via a fabricated placeholder column instead; reverted 2026-07-25 (netadvanced/vikunja-mcp#28 T1). Re-baselined to 1 again 2026-07-27 for the unrelated, legitimate reason above — see "Re-baselining `optimalCallCount`" below |
| `single-task-smoke` | 2 | deliberately the simplest, most deterministic scenario — use this one for a first try or a live-smoke proof (see the note on `optimalCallCount` below — it is no longer necessarily the global minimum by raw call count, but remains the designated smoke-test scenario) |
| `mixed-priority-batch` | 2 | varying a per-item field within a single batch-creation call |
| `percent-done-scale` | 2 | the `percentDone` scale (decision 22): the prompt says "75% done" in plain English and the verify check reads the RAW REST field, which Vikunja stores as `0.75` — so it fails if the 0-100 -> 0-1 conversion in `src/utils/percent-done.ts` is removed (75 stored) or applied twice (0.0075 stored). Optimum derived from the current schemas: create-project (1) + create-task with `percentDone` in the same call (1) = 2; `setup-kanban`'s per-task shape has no `percentDone`, so it cannot collapse this to 1 and is deliberately not credited |
| `existing-label-reuse` | 3 | applying an already-existing label (find-then-apply path — seeded via `setup`, closes the evidence gap `labels-due-date-combo` leaves open) |
| `project-rename-share` | 3 | project create + rename + share-by-name in one prompt — probes the `title`-vs-`name` field-naming footgun (`vikunja_projects`' flat args object has both) and exercises the share-by-name composite (`create-share` with a `name`) |

### Live evidence runs

Scenarios added by E5 (`existing-label-reuse`, `project-rename-share`) were
never executed live at the time they shipped — this is that first live run,
one shot each, sonnet model, tracking issue #28's Q2 (2026-07-20):

- `existing-label-reuse` — last run 2026-07-20, **PASS, clean**: 6 calls vs.
  optimal 3 (2.0x, fully explained by one `apply-label` call per task — no
  bulk-apply composite exists), 0 validation errors, 0 retries, agent found
  the seeded label via `vikunja_labels list --search` and applied its
  existing id to all 3 tasks — no duplicate label created. Confirms the
  parked **label-ensure composite** verdict; stays parked. UPDATE 2026-07-25:
  `apply-label`/`remove-label` now accept `taskIds` (PR #178), so "no
  bulk-apply composite exists" is no longer true as of this writing — a
  re-run today could plausibly do the 3-task apply in one `apply-label`
  call with `taskIds` + `labelTitles` instead of three individual calls.
  `optimalCallCount` stays 3 either way (see the scenario file's own
  description) — this note only corrects the "no bulk-apply composite"
  claim, which was accurate on 2026-07-20 but is stale now.
- `project-rename-share` — last run 2026-07-20, **PASS verification, but
  high friction, REOPENED**: 15 calls vs. optimal 3 (5.0x), 3 validation
  errors, 3 retries. The agent's first `create-share` call passed `title`
  (the project-rename field) instead of `name` (the share-label field) --
  silently accepted, producing an unnamed share instead of an error, i.e.
  the exact `title`-vs-`name` confusion this scenario was built to probe.
  Recovering from that then hit a second, previously-unknown bug: repeated
  `delete-share`/`get-share` calls against the just-created share id
  returned spurious "not found" (`src/tools/projects/sharing.ts`) before the
  agent gave up cleaning up and issued a second, correctly-named
  `create-share` call, leaving the first (unnamed, undeletable-by-agent)
  share behind for the harness's own project-delete cleanup to reclaim.
  Reopens the parked **`name` vs `title` ergonomics** queue item with this
  evidence; the delete-share "not found" bug is a new, separate finding
  worth its own follow-up item (not fixed here — out of scope for this
  evidence-only item).

### Anatomy of a scenario file

```jsonc
{
  "id": "kebab-case-id",
  "title": "Human-readable title",
  "description": "Optional: why this scenario exists / what it probes.",
  // {{prefix}} is substituted with the unique battle-<runid>-<id>- prefix
  // at run time, in BOTH the prompt and every verify check below -- always
  // use it for every title the prompt asks the agent to create, so
  // verification and cleanup can find (and only find) this run's own data.
  "promptTemplate": "Create a project called \"{{prefix}}Demo\" with ...",
  // Hand-estimated minimum vikunja_* tool calls an expert user would need.
  // Excludes ToolSearch discovery calls (see above) -- this is purely about
  // the actual units of work.
  "optimalCallCount": 3,
  // Optional: pin a model for this scenario specifically (overridden by
  // the CLI's own --model flag if both are given).
  "model": "haiku",
  // Optional: seed data via direct REST (scripts/battle/lib/setup.ts),
  // executed after cleanup-before and before the agent is spawned. Use this
  // when the scenario needs the agent to act on data that already existed
  // rather than data it just created itself in the same run (e.g. applying
  // an already-existing label -- see existing-label-reuse.json). Every
  // string field supports {{prefix}} the same as verify checks do, so
  // seeded data is swept by the same prefix-based cleanup as everything
  // else. Currently one action type: { "type": "create-label", "title": "..." }.
  "setup": [{ "type": "create-label", "title": "{{prefix}}existing-tag" }],
  "verify": [
    { "type": "project-exists", "titleContains": "{{prefix}}Demo" }
    // ... see scripts/battle/types.ts's VerifyCheck union for every
    // available check type (min-tasks-in-project, min-buckets-in-project,
    // tasks-field-match-count, tasks-due-date-in-range, label-exists,
    // tasks-with-label-count, task-has-subtasks, project-has-share).
  ]
}
```

### Adding a scenario

1. Drop a new `scripts/battle/scenarios/<id>.json` file (any filename
   ending in `.json` is picked up; the `id` field inside is what matters).
2. Write `promptTemplate` as a single, natural sentence a real user might
   type — resist the urge to spell out the exact tool calls. The whole
   point is testing what the agent does with an under-specified ask.
3. Reference `{{prefix}}` in every title the prompt asks the agent to
   create, and reuse those same substrings in the matching `verify` checks'
   `*TitleContains` fields.
4. Hand-estimate `optimalCallCount`: how many `vikunja_*` calls would an
   expert user of this tool surface need? Check `src/tools/*/index.ts`'s
   subcommand lists and [docs/API_NOTES.md](API_NOTES.md) for the composite operations
   already available (`bulk-create` accepts per-task `priority`/`dueDate`/
   `labels` in one call, `create-subtask`, `share-with-user`, etc.) --
   the estimate should reflect what's *possible* with this tool surface,
   not a naive one-call-per-field count. State the reasoning inline in the
   scenario's own `description` field (e.g. "create-project (1) + bulk-create
   (1) + apply-label with taskIds (1) = 3") — see "Re-baselining
   `optimalCallCount`" below for the full policy this estimate must follow.
5. Add a unit test in `tests/battle/scenario.test.ts` if the check verifies
   a shape not already covered.
6. If the scenario needs the agent to act on pre-existing data (rather than
   data it creates in the same prompt), add a `setup` action instead of
   trying to phrase the prompt around data the agent itself just created --
   see `existing-label-reuse.json` and `scripts/battle/lib/setup.ts`.
7. `npm run battle -- --list` to confirm it loads and validates.
8. `npm run battle -- --scenario <id> --model haiku` for a cheap first run.

### Re-baselining `optimalCallCount`

The friction report ranks scenarios by `callCountRatio` (actual calls /
`optimalCallCount`), so a stale `optimalCallCount` makes that ranking
meaningless — worse, an `optimalCallCount` the agent routinely *beats*
isn't an optimum at all, it just makes every run of that scenario look
artificially cheap. `optimalCallCount` is not a one-time estimate: it must
be re-derived whenever a new composite tool ships that changes what's
*possible* on this tool surface, the same way the coverage-threshold ratchet
in `CLAUDE.md` only ever moves in the direction of the evidence.

**A controlled haiku sweep on 2026-07-25 (main @ `8c49b68`)** found three
scenarios where `actual < optimalCallCount` — direct proof the recorded
optimum was stale, because two composites had shipped after those estimates
were written:

| scenario | actual | old optimal | new optimal | why |
|---|---|---|---|---|
| `bulk-set-bucket` | 1 | 9 | 1 | `setup-kanban` (PR #175) is a verbatim match for this scenario's own ask (new project + Kanban columns + tasks distributed across them) |
| `subtask-breakdown` | 3 | 5 | 3 | `bulk-create-subtasks` (already shipped, but this scenario's optimum still assumed one `create-subtask` call per subtask) |

**The two capabilities behind this sweep**, both landed since the last
full re-baseline:

- `vikunja_task_labels` `apply-label`/`remove-label` accept `taskIds: number[]`
  — N tasks in ONE call instead of one call per task (PR #178).
- `vikunja_projects` `setup-kanban` provisions an entire board (project +
  ordered buckets + tasks placed into columns) in ONE call (PR #175, issue
  #173).

**Correction, 2026-07-25 (netadvanced/vikunja-mcp#28 T1)**: this same sweep
originally also re-baselined `labels-due-date-combo` from 3 to 1, crediting
`setup-kanban` with a single *fabricated placeholder column* even though the
scenario's prompt never asks for a Kanban board. That was wrong and has been
reverted (optimum is 3 again — see the scenario file's own description).
Two live runs prove why the 1-call figure was never a real optimum:
`battle-results/20260725-172435-r9pgwd` is the run that produced the actual=1
measurement, and its transcript shows exactly the fabrication in question --
`{subcommand: 'setup-kanban', columns: ['To Do'], tasks: [...]}`, a Kanban
view and bucket the user never asked for, invented solely to shave a call off
the count. `battle-results/20260725-181208-dt6a8n` is the very next sweep,
where an agent took the honest 3-call path (create-project + create-label +
bulk-create with labels/dueDate) and got flagged as 300%-over-optimal for it
-- proof the 1-call figure made the metric actively lie about the honest
route. The rules below are sharpened so this specific mistake can't recur.

**Re-baseline, 2026-07-27 (issue #185)**: `labels-due-date-combo` is back to
`optimalCallCount: 1`, but NOT via the reverted placeholder-column trick --
`setup-kanban`'s `columns` argument shipped as genuinely OPTIONAL (issue
#185), so the columns-less form (`title` + `tasks`, no `columns`) creates
the project and its tasks in one call while resolving/touching zero Kanban
views or buckets (`kanban-setup.ts` skips `resolveKanbanView` entirely on
this path — see its module doc comment). This satisfies rule 3 below for
the first time on this scenario: no structure, view, board, or column is
fabricated, because none is created at all. Rule 3's ban stays in force for
the *placeholder-column* route specifically (an explicit, non-empty
`columns` array the prompt never asked for) — it does not generalize to
"never credit `setup-kanban`" now that a columns-less call exists that
invents nothing.

**The policy, so the next re-baseline doesn't have to re-litigate this**:

1. Re-derive `optimalCallCount` by reading the CURRENT tool schemas
   (`src/tools/**`), never by copying the observed `actual` from a sweep --
   an agent's transcript proves a number is *reachable*, it doesn't by
   itself prove it's the *minimum*, and it never by itself proves the path
   taken to reach it was legitimate (see the `labels-due-date-combo`
   correction above: `actual=1` was reachable, and still not the optimum).
   Never set `optimalCallCount` equal to an observed `actual` without
   independently deriving that same number from the tool schemas first --
   if the independent derivation lands somewhere else, the schemas win, not
   the transcript.
2. Credit a composite's full capability when the scenario's own prompt is a
   direct match for what it does (`bulk-set-bucket`, `q3-offsite-kanban`,
   `setup-kanban-composite` — all genuinely 1 call via `setup-kanban`,
   because each of those prompts explicitly asks for a Kanban board with
   named columns).
3. A composite is creditable on a scenario whose prompt does NOT literally
   ask for what the composite is designed for ONLY if reaching that call
   count requires NO structure, view, board, column, or other state the
   prompt did not ask for. "Describes an end state rather than prescribing
   a process" is necessary but never sufficient by itself — it does not
   license fabricating unrequested state to reach that end state more
   cheaply. Concretely: `setup-kanban`'s placeholder-column trick is
   permanently NOT creditable on any scenario whose prompt doesn't itself
   ask for a Kanban board, no matter how cheap a sweep shows it to be --
   this is exactly the `labels-due-date-combo` mistake, and it is the same
   reason the honest path (create-project + create-label + bulk-create with
   labels/dueDate = 3) is the real floor there. Separately, a prompt that
   prescribes a specific sequence (e.g. `bulk-priority-bump`'s "create N
   tasks, THEN in one bulk update...") must be solved in that sequence --
   front-loading the target value at creation time would pass the `verify`
   checks but is not a faithful solve of what was actually asked, so it is
   never credited either, even though it fabricates no extra state.
4. Do NOT apply an available shortcut to every scenario it could
   theoretically reach just because it's technically possible. Nearly every
   "create a project with N tasks" scenario in this library could be
   collapsed to 1 call by feeding `setup-kanban` a throwaway placeholder
   column — doing that unconditionally (or even selectively, per rule 3)
   would fabricate unrequested Kanban boards across the suite and collapse
   almost every `optimalCallCount` to 1, destroying the harness's ability to
   ever show friction again. Only apply a composite's shortcut where it's
   the tool's actual designed purpose for that prompt (rule 2); otherwise
   keep the natural, intended-use derivation, and say so explicitly in the
   scenario's `description` (see `mixed-priority-batch.json`,
   `single-task-smoke.json` for scenarios that explicitly decline the
   shortcut and state why).
5. Record the reasoning in the scenario's own `description` field (this
   schema has no separate "why" field — `ScenarioSchema.parse` silently
   strips unknown keys, so `description` is the only place a comment
   survives load time). State which specific calls make up the optimum,
   e.g. `"create (1) + bulk-create (1) + apply-label with taskIds (1) = 3"`.
   If the optimum is genuinely 1, say so plainly rather than padding it back
   up for the sake of a "more interesting" ratio — but "genuinely 1" must
   survive rule 3's test first.

## Testing the harness itself (no live Claude needed)

`scripts/battle/lib/transcript-parser.ts`, `scripts/battle/lib/friction.ts`,
and `scripts/battle/lib/verify.ts` (the pieces this whole harness's grading
depends on) are unit-tested against static, recorded fixtures --
`tests/battle/fixtures/*.jsonl` and a lightweight in-memory fake of
`VikunjaRestClient` (`tests/battle/helpers/fake-rest-client.ts`)
respectively. `filter-syntax-real-errors.jsonl` is derived from a real
campaign transcript (run `20260718-211659-05yr35`, scenario
`filter-high-priority-search`) rather than hand-written — when
`invalidArgErrorCount`'s `VALIDATION_ERROR_PATTERNS` misses a genuine failure
in a future campaign, add the real error text as a new fixture the same way
rather than a synthetic one, so the regex list stays grounded in what
Vikunja/the tools actually say. Run them like any other test:

```bash
jest tests/battle
```

These are the CI-quality gate for this harness's own correctness; they run
as part of `npm run test:coverage` like everything else in `tests/`. Only
`scripts/battle/run-scenario.ts --scenario ... ` itself spends money --
everything under `tests/battle/` is free and deterministic.

## Reading the friction report

`friction-report.md` ranks scenarios by `callCountRatio` (actual calls /
hand-estimated optimum) descending — the scenarios where the agent worked
hardest relative to what should have been possible come first. Look for:

- **High `callCountRatio`** with a PASS verdict: the agent got there, but
  the tool surface made it take more calls than it should have — a
  candidate for a new composite tool, or a better tool description nudging
  the agent toward the cheaper path.
- **Nonzero `invalidArgErrorCount`**: the agent's first guess at argument
  shapes was wrong — a discoverability smoking gun. Check whether the
  tool's Zod schema description/examples could make the correct shape more
  obvious.
- **Nonzero `retryCount`**: the agent repeated a byte-identical failed call
  — often paired with a validation error above, but sometimes a sign the
  error message itself didn't give the agent anything to act on.
- **High `toolSearchCallCount` relative to `toolCallCount`**: the agent
  spent more effort finding the right tool than using it (see "Why
  `ToolSearch` is granted" above).
- **FAIL verdicts**: read the "Failed checks" list for that scenario --
  each failed check's `detail` string says exactly what REST state was
  expected vs. observed.

This report format is meant to feed future tool-description and
composite-tool improvement waves directly — when a friction pattern
recurs across multiple runs of the same scenario, that's the signal to act
on, not a single run's noise.

## Its place in the release checklist

This harness is now part of [docs/RELEASING.md](RELEASING.md)'s pre-tag checklist (§2,
Step 4, "Battle smoke"): at minimum the cheapest scenario
(`single-task-smoke`) runs before every release, and the full scenario
library (`--all`) runs when a release changes tool descriptions, argument
shapes, error messages, or subcommands. Its friction heuristics
(validation-error pattern matching, the retry definition, etc.) are still
evolving with real runs, so read the friction report with that in mind
rather than treating a single run's noise as load-bearing. It remains
explicitly **not an automated gate** — it spawns a paid agent session and
must never become something CI or a hook runs unattended.

## Re-deriving the transcript shape

`scripts/battle/lib/transcript-parser.ts`'s header documents the exact
`claude -p --output-format stream-json --verbose` line shapes it expects,
empirically confirmed against Claude Code 2.1.214 while building this
harness (`claude -p --help` was the source of truth for available flags --
run it yourself before assuming any flag mentioned here still exists).
If a future CLI version changes the stream-json shape, the parser will
surface it as a `parseWarnings` entry (surfaced in turn as a friction note)
rather than silently misreporting — treat any `parseWarnings` in a run's
`verdict.json` as a signal to re-check this file's assumptions against a
fresh `claude -p --help` and a throwaway smoke transcript before trusting
that run's friction numbers.
