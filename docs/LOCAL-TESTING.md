# Local End-to-End Testing

This document describes the disposable local Vikunja stack in `docker/e2e/`,
used to run `scripts/test-mcp.ts` (`npm run test:mcp`) against a real Vikunja
server instead of mocks. The stack supports two DB backends — Postgres
(default) and SQLite (the `-sqlite` targets, item F2 / tracking issue #28) —
see "DB backend variant" below.

**Production safety.** This stack — and `npm run test:mcp` in general — is
for a throwaway local Vikunja instance only. Never point `VIKUNJA_URL` /
`VIKUNJA_API_TOKEN` at a production Vikunja instance, and never run this
(or any automated test run) against one. `test:mcp` creates and deletes
projects, tasks, and labels, and the bootstrap script creates a
known-password test user — none of that is safe against real data.

## What's in `docker/e2e/`

- `docker-compose.yml` — a multi-service stack, namespaced under a
  per-target compose project name (`vikunja-e2e-<version>-<db>`,
  interpolated from `E2E_PROJECT`, default `vikunja-e2e-2.4.0-postgres`) so
  it can't collide with anything else running on the machine. Uses
  non-default host ports, all *derived* from the version (see "Targets"
  below): the default target publishes **8240** for Vikunja (`VIKUNJA_URL`
  points here, same for both DB backends) and **18240** for Postgres
  (optional, for ad-hoc `psql` debugging only, postgres backend only).
  Two DB-backend variants are defined as Compose *profiles* —
  `postgres` (`db` + `files-init` + `vikunja`, the pre-existing default) and
  `sqlite` (`sqlite-db-init` + `files-init` + `vikunja-sqlite`, added by item
  F2) — see the comment block at the top of the file for the full profile
  design and why it's profiles rather than a merged overlay file. All
  services have healthchecks and their data lives in named volumes
  (`vikunja-mcp-e2e-db`, `vikunja-mcp-e2e-sqlite-db`, `vikunja-mcp-e2e-files`)
  so the stack survives a restart. Only one profile is ever active at a
  time; both variants publish the same host port.
- `bootstrap.sh` — waits for the stack to become healthy, creates a test
  user via the Vikunja container CLI, logs in to get a JWT, and uses that
  JWT to mint a long-lived `tk_*` API token (falling back to the JWT itself
  if token creation fails). Writes the target's own credentials file,
  `docker/e2e/.env.<version>-<db>` (gitignored), and prints
  `export VIKUNJA_URL=...` / `export VIKUNJA_API_TOKEN=...` lines.
  Safe to re-run against an already-bootstrapped stack (idempotent: it logs
  in with the existing test user instead of re-creating it, and reuses the
  stored token if it still authenticates — see "Credentials are stable"
  below). Reads `VIKUNJA_E2E_TARGET` (default `2.4.0-postgres`) to select
  which version, Compose profile/service, and ports to bring up and
  bootstrap against.
- `stacks.sh` — the lifecycle helper behind `npm run e2e:up:all` /
  `e2e:down` / `e2e:reset` / `e2e:status`. Resolves each `<version>-<db>`
  target via `scripts/lib/e2e-target.ts`, then calls `bootstrap.sh` (`up`)
  or `docker compose ... down` (with `-v` only on `reset`).

## DB backend variant (postgres | sqlite)

By default the stack behaves exactly as it always has: Vikunja backed by a
real Postgres service. Pick a `-sqlite` target instead to run Vikunja
against its own embedded SQLite database (a file in the
`vikunja-mcp-e2e-sqlite-db` named volume, no separate DB service at all):

```bash
VIKUNJA_E2E_TARGET=2.4.0-sqlite npm run e2e:up
```

(`npm run e2e:up` selects everything — version, DB backend, ports, env file
— from `VIKUNJA_E2E_TARGET` alone; a bare `VIKUNJA_DB=` / `VIKUNJA_VERSION=`
is ignored there. `npm run test:matrix` still takes `VIKUNJA_VERSION` /
`VIKUNJA_DB` and derives the target from them — see "Version-matrix
testing" below.)

This exists because SQLite and Postgres have different concurrency
characteristics under concurrent writes — SQLite serializes writers with a
file lock, Postgres uses MVCC — so a whole class of bug (concurrent-write
lock contention, e.g. netadvanced/vikunja-mcp-ng#116: `bulk-create`'s
`maxConcurrency: 8` write fan-out 500ing with "database is locked" on
SQLite, then tripping the shared circuit breaker into a full create-endpoint
outage) was **structurally invisible** to every local/matrix run before this
variant existed, because this stack only ever ran Postgres. Running the
same harnesses against the `sqlite` variant surfaces that class of bug
instead of silently passing.

`npm run e2e:down` always stops *both* profiles (`--profile postgres
--profile sqlite down`, see `docker/e2e/stacks.sh`) but deliberately keeps
the volumes — see "Stopping vs resetting" below. `npm run e2e:reset` is the
same command plus `-v`, so it reliably removes all three named volumes
regardless of which variant was last up — there is no "leftover sqlite
volume" case to worry about after a `reset`.

`scripts/mcp-e2e.ts` includes one check explicitly written to catch this
class of bug: a 12-task `bulk-create` stress check, labeled
`(sqlite-sensitive, see #116)` in its output. It's expected to pass 12/12 on
Postgres and on a SQLite stack whose `bulk-create` write concurrency has
been fixed (e.g. serialized); on an *unfixed* SQLite stack it is expected to
intermittently under-create (partial success, e.g. 11/12) with
`"database is locked"` visible in `docker compose -f docker/e2e/docker-compose.yml
-p vikunja-e2e-2.4.0-sqlite logs vikunja-sqlite` (each target is its own
Compose project — see "Targets" below) even
though the HTTP response body only ever says `"Internal Server Error"`. A
`FAIL` on this one check against a `-sqlite` target is expected and
documented, not a harness bug — see the PR that introduced this check for
recorded before/after evidence.

## Targets: one persistent stack per Vikunja version

Since issue #205 there is no single "the stack". Each **target** —
`<version>-<db>` — is its own Compose project with its own volumes and its
own ports, so several versions run **at the same time** and one agent's work
cannot disturb another's:

| Target | API port | Notes |
|---|---|---|
| `2.4.0-postgres` | **8240** | the default; aligned/tested version |
| `2.3.0-postgres` | **8230** | the v1 floor (minimum supported) |
| `2.4.0-sqlite` | 9240 | SQLite-only failure classes |
| `2.3.0-sqlite` | 9230 | |

Ports are **derived, never hand-assigned**: `8000 + (major×100 + minor×10 +
patch)` for Postgres, `9000 + …` for SQLite, so Vikunja 2.4.1 lands on 8241
with no edit anywhere. The formula and the target list live in
`scripts/lib/e2e-target.ts`, which both the shell scripts and the TypeScript
harnesses consult — never hardcode a port.

```bash
npm run e2e:up                                   # default target (2.4.0-postgres, port 8240)
VIKUNJA_E2E_TARGET=2.3.0-postgres npm run e2e:up # the floor, port 8230
npm run e2e:up:all                               # every standard target at once
npm run e2e:status                               # what's up, on which port, running which version
```

Each target writes its own credentials file,
`docker/e2e/.env.<version>-<db>` (gitignored — these hold live tokens).

### Credentials are stable

`bootstrap.sh` is idempotent about tokens: if the target's env file holds a
token that still authenticates, it is **reused**. A token therefore survives
`npm run e2e:down` and only ever changes when someone deliberately runs
`npm run e2e:reset`.

This matters because it used to be otherwise: `e2e:down` ran `down -v`,
destroying the volumes, so the next `e2e:up` produced a fresh database, a
fresh user, and a fresh token — silently invalidating the credential any
other process was holding.

### Two users, deliberately

| User | Purpose |
|---|---|
| `e2e-test` | The shared identity every harness authenticates as, and the owner of the stored token. **Nothing may mutate its user-level state.** |
| `e2e-mutable` | For tests that change identity-scoped state — API tokens, user settings, avatar provider. Breaking this user cannot break anyone else's run. |

Both are provisioned by `bootstrap.sh`. The JWT lane in
`scripts/mcp-e2e.ts` authenticates as `e2e-mutable` precisely because it
changes the avatar provider.

### Running several harnesses at once

Concurrent runs against the **same** target are safe:

- Each `test:e2e:mcp` run uses a unique fixture prefix
  (`mcp-e2e-<runId>-`) and only ever sweeps its own. The root-prefix sweep,
  which collects strays from crashed runs, is opt-in via `--sweep-all` —
  running it while another run is live will delete that run's data.
- The battle harness behaves the same way (`--sweep-all`).
- `dist/` is rebuilt only when it is stale, under a lock, so two runs cannot
  wipe the server binary out from under each other.

## Running `test:mcp` against it

Either eval the printed exports directly:

```bash
eval "$(npm run e2e:up | grep '^export ')"
npm run test:mcp
```

or, once the target's credentials file exists (e.g. from a prior
`npm run e2e:up`), source it — one file per target, so pick the one matching
the stack you want to hit:

```bash
set -a && source docker/e2e/.env.2.4.0-postgres && set +a
npm run test:mcp
```

### Pointing a manual MCP client (e.g. Claude Desktop/Code) at the stack

Configure the server with the same two environment variables, e.g. in an
MCP client config:

```json
{
  "mcpServers": {
    "vikunja-e2e": {
      "command": "node",
      "args": ["/path/to/vikunja-mcp/dist/index.js"],
      "env": {
        "VIKUNJA_URL": "http://localhost:8240",
        "VIKUNJA_API_TOKEN": "tk_..."
      }
    }
  }
}
```

Then follow [docs/MCP-TEST-CHECKLIST.md](MCP-TEST-CHECKLIST.md) for the manual walkthrough.

## Inspecting the stack by hand (web UI)

The `vikunja/vikunja` image serves the built frontend and the API from the
same process on the same port, so once `npm run e2e:up` reports the stack
healthy you can just open it in a browser:

- **Web UI:** http://localhost:8240/ (default target; 8230 for the 2.3.0 floor)
- **API base:** http://localhost:8240/api/v1
- **Login:** the bootstrap-created test user — username `e2e-test`, password
  as set in `TEST_PASSWORD` at the top of `docker/e2e/bootstrap.sh` (a fixed,
  throwaway, local-only credential; it's never randomized, so the value in
  that script is always current and correct — check there rather than
  trusting a copy of it in this doc going stale).

This is a real login against the local instance, independent of the
`tk_*` API token in `docker/e2e/.env.<version>-<db>` — useful for eyeballing whatever
`test:mcp` (or a manual MCP client session) just created/changed in the
`MCP-Test` project, or any other project, while the automated run's output
is still on screen.

## Stopping vs resetting

```bash
npm run e2e:down     # stop containers, KEEP volumes — tokens stay valid
npm run e2e:reset    # destroy volumes — this ROTATES the target's API token
```

`down` deliberately does **not** pass `-v`. Destroying volumes recreates the
database, the user, and therefore the API token, which is exactly how a
concurrent worktree lost its credential mid-session. Rotation must be a
deliberate `reset`, never a side effect of stopping a stack.

Both accept explicit targets (`npm run e2e:down 2.3.0-postgres`); with no
argument they apply to every standard target.

Leaving the stacks up between sessions is now the expected state — that is
what makes them a stable fixture rather than something every run rebuilds.

## How the bootstrap works, in detail

1. `docker compose ... up -d --wait` — waits for `db`'s `pg_isready`
   healthcheck and, once `db` is healthy and the one-shot `files-init`
   container has chowned the files volume to uid 1000 (the vikunja image
   runs as uid 1000 with no shell, so it can't fix that itself — see the
   comment in `docker-compose.yml`), for `vikunja`'s own `healthcheck`
   subcommand (`vikunja healthcheck`; the image is `FROM scratch`, so
   there's no curl/wget to probe `/health` with).
2. Attempts `POST /login` with the fixed test credentials
   (`e2e-test` / a fixed password, see `bootstrap.sh`). If that succeeds,
   the user already exists from a previous run and creation is skipped.
3. Otherwise, runs `vikunja user create -u e2e-test -e ... -p ...` via
   `docker compose exec` (the CLI baked into the same container image),
   then logs in.
4. Calls `GET /routes` with the JWT to discover every permission group and
   action the running server exposes, then `PUT /tokens` with a permissions
   object granting all of them and a 10-year expiry, producing a `tk_*`
   API token. If that call fails for any reason, falls back to using the
   JWT itself as `VIKUNJA_API_TOKEN` (the MCP server auto-detects JWT vs.
   API-token by the `eyJ`/`tk_` prefix — see `src/auth/AuthManager.ts`).

## Version pinning and refresh

**Policy: minimum supported Vikunja is 2.3.0 (the v1-floor); aligned/tested
default is 2.4.0.** Some workarounds in `src/` (see e.g.
`src/tools/projects/sharing.ts`'s by-id-share-GET workaround) exist
specifically for upstream bugs still present at 2.3.0 but fixed by 2.4.0 —
those stay until 2.3.0 support is actually dropped, not merely because the
default pin moved past the fix. Both versions are worth running locally
(see "Version-matrix testing" below): 2.4.0 as the everyday default, 2.3.0
as the periodic v1-floor regression check.

The stack pins `vikunja/vikunja:2.4.0` by default — see the comment block
at the top of `docker/e2e/docker-compose.yml` for the full reasoning and
history (aligned 2026-07-20, tracking issue #28 item A1, after a clean
`test:matrix` pass on both DB backends with zero tolerated drifts). The
vendored OpenAPI spec at `docs/vikunja-openapi.json` is fetched directly
from this same pinned container's own `/api/v1/docs.json` (`npm run
fetch:api-spec:container`, see `[docs/API-SPEC.md](API-SPEC.md)`) — its `info.version`
matches the pin exactly (`v2.4.0`, confirmed byte-for-byte, no ahead-of-tag
drift), unlike the previous approach of fetching from `try.vikunja.io`
(`npm run fetch:api-spec`), which always runs `unstable` and is confirmed
to run ahead of any tagged release (the prior 2.3.0-era vendored spec
reported `v2.3.0-1019-g95b7e673`, i.e. 1019 commits past the tag). Use
`npm run fetch:api-spec:container` as the default refresh path; reach for
`npm run fetch:api-spec` only if you deliberately want to preview
upstream's `unstable` build.

To refresh the pin when a newer stable Vikunja release ships:

1. Check available tags: `curl -s https://hub.docker.com/v2/repositories/vikunja/vikunja/tags?page_size=100`
   (or the [releases page](https://github.com/go-vikunja/vikunja/releases)).
2. Bump the tag in `docker/e2e/docker-compose.yml` and its comment block,
   and the `DEFAULT_TARGET` / `standardTargets()` values in
   `scripts/lib/e2e-target.ts` (the resolver every script and harness reads
   the version, ports, and env-file name from).
3. Bring the stack up on the new tag and refresh `docs/vikunja-openapi.json`
   from it (`VIKUNJA_E2E_TARGET=X.Y.Z-postgres npm run e2e:up && npm run
   fetch:api-spec:container && npm run generate:api-types`), if you also
   want to re-check spec/tool alignment. Note `fetch:api-spec:container`
   hits the **8240** default-target port (see `package.json`), so refresh
   from the target that owns that port.
4. `npm run e2e:reset && npm run e2e:up && npm run test:mcp` and re-triage
   any new failures using the same (a)/(b)/(c) categories as any other
   real-server run (script staleness / real server drift / environment
   issue — see the PR that introduced this stack for the categorization
   convention).

## Known limitation: `test:mcp` doesn't call the MCP tool layer

`scripts/test-mcp.ts` talks directly to the Vikunja REST API over `fetch()`
using the same request shapes the MCP tools use — it does not spawn the
MCP server or drive it over the MCP stdio/JSON-RPC protocol, and it never
calls anything under `src/tools/`. (It even has a leftover
`validateMCPResponse()` helper for validating an `{content: [...]}`-shaped
MCP tool response that is never called anywhere in the file.) A clean
`test:mcp` run confirms the real Vikunja server behaves the way the
scripted REST calls assume; it does **not** confirm that `src/tools/*.ts`
sends those exact requests. Cross-check against [docs/API-COVERAGE.md](API-COVERAGE.md)
(which *is* audited against the actual tool source) for tool-level
correctness, and treat a clean `test:mcp` run as necessary but not
sufficient evidence that the MCP tools themselves are correct. The harness
below (`test:e2e:mcp`) closes that gap.

## True MCP-layer e2e harness (`npm run test:e2e:mcp`)

`scripts/mcp-e2e.ts` is the harness that actually exercises `src/tools/*.ts`
end to end, addressing the limitation above. Unlike `test:mcp`, it:

1. Runs `npm run build`.
2. Spawns `dist/index.js` as a real child process over stdio.
3. Connects to it with `@modelcontextprotocol/sdk`'s `Client` +
   `StdioClientTransport` — the same transport a real MCP client (Claude
   Desktop, Claude Code, etc.) uses.
4. Drives the server exclusively through `client.callTool()`. Every
   assertion in the run is against the actual tool response text (ids,
   titles, field values it round-trips), not just absence of an error.

Run it against the local stack:

```bash
npm run e2e:up   # if not already running
npm run test:e2e:mcp
```

It requires no environment variables — the target's local API URL comes
from the resolver (`scripts/lib/e2e-target.ts`; default target
`2.4.0-postgres`, i.e. `http://localhost:8240/api/v1`, selectable with
`VIKUNJA_E2E_TARGET`), and credentials come from that target's
`docker/e2e/.env.<version>-<db>` when it exists (the stable token — see
"Credentials are stable" above). If it doesn't, the harness mints its own
the same way `docker/e2e/bootstrap.sh` does (log in as `e2e-test`, mint a
fresh `tk_*` API token via `PUT /tokens`, tolerating the 201 the real
server returns where the spec documents 200), so a missing credentials file
never blocks a run.

### Coverage

`list-tools` (asserting the expected tool set, including the tools that
should be *absent* under API-token auth and default module config —
`vikunja_users`/`vikunja_export_*` are JWT-only, `vikunja_tokens`/
`vikunja_admin` are deny-by-default "dangerous" modules), then a
representative flow through the real tools: auth status/info/connect,
projects create/get/update/list, tasks create/update/list (both
project-scoped and the cross-project `GET /tasks` aggregation path),
labels create + apply to a task, assignees (resolved via project-user
search, then assign/list), comments create/list/get/update/delete,
reminders add/list/remove, Kanban list-views/list-buckets/set-bucket,
notifications list, and saved filters create/list/delete.

### Safety: never touches a real Vikunja instance

The harness deliberately does **not** read the ambient `VIKUNJA_URL` /
`VIKUNJA_API_TOKEN` environment variables that the MCP server itself (and
`scripts/test-mcp.ts`) honor. A developer's shell commonly has those
exported for day-to-day use of the server against a real Vikunja account
(direnv, a personal MCP client config, etc.) — during this harness's own
development, an early version *did* fall back to `process.env.VIKUNJA_URL`
when unset, and because the developer's shell already exported it for
unrelated reasons, a full run silently created, searched, and deleted data
against a real production Vikunja account instead of the disposable local
stack (fully cleaned up automatically by the harness's own teardown, but
the near-miss is exactly why this exists). To make that class of mistake
structurally impossible:

- The target URL always comes from the local-only target resolver (or that
  target's own credentials file) and is only overridable via the
  harness-specific `MCP_E2E_VIKUNJA_URL`/`VIKUNJA_E2E_TARGET` — never
  the ambient `VIKUNJA_URL` — and is then required to resolve to
  `localhost`/`127.0.0.1`/`::1` or the process aborts immediately, before
  building or spawning anything.
- The API token is always freshly minted against that (now
  guaranteed-local) server; the ambient `VIKUNJA_API_TOKEN` is never
  consulted. `MCP_E2E_VIKUNJA_API_TOKEN` (again, a distinct name) can
  supply one explicitly, but only against the same localhost-checked URL.
- The spawned child process's env is built from a copy of `process.env`
  with `VIKUNJA_URL`/`VIKUNJA_API_TOKEN`/`VIKUNJA_API_TOKEN_FILE` stripped
  before overlaying the harness's own verified-local values, so no ambient
  credential can leak through to the server under test even indirectly.

### Idempotency / re-runnability

All test data is created under projects/labels/saved-filters named with the
`mcp-e2e-` prefix. Every run sweeps for and deletes any leftover
`mcp-e2e-*` data at startup (cleanup-by-name-prefix), so a prior failed or
interrupted run never blocks a fresh one, and also deletes everything it
creates in a `finally` block at the end — so the Vikunja UI is left clean
for a human to inspect between runs.

### Findings categorization

Every mismatch the harness finds is reported as one of:

- **harness** — a problem with the harness script itself (e.g. couldn't
  parse a response it should have been able to).
- **tool-bug** — the MCP tool layer sends or parses something wrong against
  the real server. Fixed inline when trivial and clearly in-scope (with a
  regression test), otherwise documented for follow-up.
- **server-drift** — the real server's behavior differs from the documented
  spec / this repo's implementation is correct but the pinned local Vikunja
  version's behavior isn't (e.g. an endpoint 500s regardless of what's sent
  — reproduced with a raw, tool-independent request to confirm it isn't
  this codebase's fault before filing it here).

A **known, version-gated tolerance** of the last category: `GET
/tasks/{id}/assignees` returns HTTP 500 unconditionally on Vikunja versions
below 2.4.0 (fixed upstream on `go-vikunja/vikunja`'s `main` via PR #2791,
confirmed shipped in the 2.4.0 tagged release during the 2.4.0-alignment
work, tracking issue #28 item A1). The harness detects the server version
via `GET /info` at startup and only tolerates this exact signature when the
detected version is `< 2.4.0`; on 2.4.0+ it's a hard failure like any other
regression. It still *runs* this check on every version — never globally
skipped — reported as `⚠ list task assignees (server-drift, tolerated:
...)` instead of `✗ ...` only below 2.4.0: recorded as a `server-drift`
finding and excluded from the pass/fail counts and exit code there, but a
genuine `✓ list task assignees` pass on 2.4.0+ (confirmed in
`e2e-verdicts/vikunja-2.4.0-{postgres,sqlite}.md`). See
`detectServerVersion()`/`versionLessThan()`/`driftTolerated()` in
`scripts/mcp-e2e.ts` for the implementation. If this ever 500s on a 2.4.0+
server, that's a new, real regression, not the same known gap — the
tolerance won't mask it.

## Version-matrix testing (`npm run test:matrix`)

`scripts/test-matrix.ts` is the one-command runner that ties the two
harnesses above together against a *chosen* Vikunja server version **and**
DB backend, so re-validating this project against a newly-released Vikunja
tag, a different DB backend, or re-confirming it against the current
defaults, is a single command instead of a manual sequence of
stack-recreation and harness-invocation steps. The matrix is version × db
(item F2 / tracking issue #28 added the db dimension — see "DB backend
variant" above).

```bash
npm run test:matrix                                          # 2.4.0 / postgres (defaults, aligned/tested)
VIKUNJA_VERSION=2.3.0 npm run test:matrix                     # the v1-floor regression check
VIKUNJA_DB=sqlite npm run test:matrix                         # default version, sqlite backend
VIKUNJA_VERSION=2.3.0 VIKUNJA_DB=sqlite npm run test:matrix   # both dimensions
```

For the chosen `VIKUNJA_VERSION` (default `2.4.0`, matching the compose
file's own default — see "Version pinning and refresh" above) and
`VIKUNJA_DB` (default `postgres` — see "DB backend variant" above), it:

1. **Ensures that target's stack is up.** Since issue #205 it **never tears
   anything down**: `<version>-<db>` names a target with its own Compose
   project, ports, and volumes (see "Targets" above), so a matrix run can
   no longer re-pin a shared stack out from under a concurrent worktree. It
   just runs `VIKUNJA_E2E_TARGET=<version>-<db> npm run e2e:up`, which is
   idempotent and reuses the target's stable token if it's already up (see
   `ensureStack()` in `scripts/test-matrix.ts`). If the target isn't
   running at all, that same call brings it up fresh.
2. **Runs both harnesses against it**: `npm run test:mcp` (the ~23-check
   direct-REST suite) and `npm run test:e2e:mcp` (the ~50+-check MCP-tool
   -layer suite, including the `bulk-create` stress check labeled
   `sqlite-sensitive` — see "DB backend variant" above), streaming their
   output live and also capturing it.
3. **Reads the actual server version from `GET /api/v1/info`** rather than
   trusting the `VIKUNJA_VERSION` input — if the requested tag doesn't
   exist on Docker Hub (or the server otherwise comes up reporting
   something else), the run fails loudly with that mismatch instead of
   silently mislabeling results.
4. **Writes a verdict file** to `e2e-verdicts/vikunja-<server-version>-<db>.md`
   (gitignored — see "Verdict files aren't committed" below) with a
   `# vikunja-mcp-ng <our-version> vs Vikunja <server-version> (<db>): PASS/FAIL`
   header, the full per-check list from both harnesses (parsed from their
   own `✓`/`✗`/`⊘`/`⚠` stdout lines — see "Findings categorization" above
   for what those mean), and a closing verdict paragraph. The overall
   verdict is `PASS` only if *both* harnesses exit 0 with zero non-tolerated
   (`✗`) failures; `⚠ server-drift` entries don't block a `PASS`. Historical
   note: prior to the 2.4.0 alignment, a `sqlite`-backend run against 2.3.0
   was *expected* to occasionally `FAIL` (or under-create, 11/12) on the
   `bulk-create` stress check per #116's SQLite lock-storm-under-circuit-
   breaker issue. As of the 2.4.0 alignment (tracking issue #28 item A1),
   this check passed 12/12 across 5 repeated runs against `2.4.0`/sqlite —
   see "Vikunja 2.4.0 and `concurrent_writes`" below. This project's
   client-side write-serialization is retained regardless, as
   defense-in-depth for the documented v1-floor (2.3.0, where the fix isn't
   present) — see the comment on the `create` `BatchProcessor` in
   `src/tools/tasks/bulk-operations-simplified.ts`.
5. **Exits 0 on `PASS`, 1 on `FAIL`** — usable as a plain shell gate even
   without CI (GitHub Actions are disabled repo-wide by explicit owner
   decision; this is why this entire workflow is a local script rather
   than a workflow file).

### Safety

Exactly like `test:e2e:mcp` (see above), this script never reads the
ambient `VIKUNJA_URL` / `VIKUNJA_API_TOKEN` env vars — every child process
it spawns (`npm run e2e:up`, `npm run test:mcp`,
`npm run test:e2e:mcp`) gets a copy of `process.env` with those (plus
`VIKUNJA_API_TOKEN_FILE`) stripped first. `test:mcp` needs *some*
credentials (unlike `test:e2e:mcp`, it doesn't mint its own), so this
script reads them explicitly out of `docker/e2e/.env` after bootstrapping
and hands them to that one child process only, asserting the URL resolves
to `localhost`/`127.0.0.1`/`::1` first. **Known gap:** that path is the
pre-#205 one — `bootstrap.sh` now writes `docker/e2e/.env.<version>-<db>`,
so `test:matrix` fails on a checkout with no leftover `docker/e2e/.env`
until `scripts/test-matrix.ts` is pointed at the target's env file. This
matters concretely in this
repo: this directory has a real, production-pointed `.envrc` that a
developer's shell may already have loaded via direnv — never read `.env`
or `.envrc` directly, and never trust that ambient env vars are safe
defaults.

### Verdict files aren't committed

`e2e-verdicts/` is gitignored, the same convention as `coverage/` — a
verdict file is a point-in-time run artifact tied to whatever commit and
Vikunja version produced it, not something that stays accurate sitting in
the tree. Regenerate with `npm run test:matrix` rather than trusting a
stale committed one; paste or attach the freshly-generated file's contents
in a PR description when a run needs to be shown to a reviewer.

### Vikunja 2.4.0 and `concurrent_writes`

As part of the 2.4.0 alignment (tracking issue #28, item A1), `GET
/api/v1/info` on a 2.4.0 server was observed to advertise a new field not
present in the documented 2.3.0 response: `"concurrent_writes": true`. The
`bulk-create` stress check (`npm run test:e2e:mcp`, labeled
`sqlite-sensitive, see #116`) was re-run **5 times** against a fresh
`VIKUNJA_VERSION=2.4.0 VIKUNJA_DB=sqlite` stack to rule out a lucky single
run: **12/12 concurrent creates succeeded on all 5 runs**, zero
under-creates, zero circuit-breaker trips. This is consistent with upstream
having genuinely fixed (or now at least reliably supporting) the SQLite
write-concurrency issue tracked in #116.

**This does not change this project's own behavior.** The client-side
serialization in `src/tools/tasks/bulk-operations-simplified.ts` (the
`create` `BatchProcessor`'s `maxConcurrency: 1`) is retained regardless, as
defense-in-depth — this project's documented minimum supported Vikunja
version is still 2.3.0 (which does not advertise `concurrent_writes` and
does exhibit the lock-storm), a deployer's server may not be running
2.4.0+ at all, and serializing creates is cheap in the common case. See
that file's comment for the exact revisit condition.

### When a new Vikunja release ships

1. `curl -s https://hub.docker.com/v2/repositories/vikunja/vikunja/tags?page_size=100`
   (or the [releases page](https://github.com/go-vikunja/vikunja/releases))
   to confirm the new tag exists.
2. `VIKUNJA_VERSION=X.Y.Z npm run test:matrix` — inspect the verdict; a
   `FAIL` needs triage (script staleness / real tool bug / new server-drift
   to document and tolerate the same way the assignees case above is
   tolerated) before going further.
3. If it passes (or once triaged failures are addressed), refresh the
   vendored spec from the newly-pinned container if you also want to
   re-check spec/tool alignment: `VIKUNJA_E2E_TARGET=X.Y.Z-postgres npm run
   e2e:up && npm run fetch:api-spec:container && npm run generate:api-types`
   (`fetch:api-spec:container` reads port 8240 — see step 3 of "Version
   pinning and refresh" above; see
   [docs/API-SPEC.md](API-SPEC.md) for why the container, not `try.vikunja.io`, is the
   source of truth).
4. Bump the *default* pin in `docker/e2e/docker-compose.yml` (the
   `${VIKUNJA_VERSION:-2.4.0}` fallback, the `${E2E_PROJECT:-…}` /
   `${E2E_PORT:-…}` fallbacks, and the matching comment block) — and
   `DEFAULT_TARGET` / `standardTargets()` in `scripts/lib/e2e-target.ts` —
   then re-run `npm run test:matrix` with no override to confirm the new
   default is green.
5. Cut a **minor** release aligned to the new Vikunja version, per
   [docs/RELEASING.md](RELEASING.md) §3's Docker compatibility-tag scheme (`X.Y.Z`,
   `X.Y.Z-vikunja<A.B.C>`, `latest`) — changing the base Vikunja version
   this project targets is always at least a minor bump (see
   [docs/RELEASING.md](RELEASING.md) §1).

## OIDC `oidc-http` transport e2e lane (`npm run test:e2e:oidc`)

`scripts/oidc-e2e.ts` is the e2e lane for the opt-in `oidc-http` transport
mode (`docs/OIDC-RESOURCE-SERVER.md`, tracking issue #28 item H2b) — sibling
to `test:e2e:mcp` above, but for the multi-user HTTP+OIDC deployment shape
instead of the default `stdio` transport. It:

1. Runs `npm run build`.
2. Starts an in-process, loopback-only **mock OIDC issuer**: a real RSA
   keypair plus a tiny HTTP server serving its JWKS document, reusing the
   exact same signing/JWKS helpers the unit test suites use
   (`tests/auth/oidc/helpers.ts`) — per the design's decision D9 ("e2e
   identity provider = mock OIDC issuer as the CI default").
3. Spawns `dist/index.js` as a real child process in `oidc-http` mode
   (`VIKUNJA_MCP_TRANSPORT=http`), pointed at that mock issuer, with a fresh
   temporary credential vault file, and — for real Vikunja credentials —
   pointed at the local e2e stack the same way `docker/e2e/bootstrap.sh`
   does (log in as `e2e-test`, mint a real `tk_*` token via `PUT /tokens`).
4. Drives the spawned server with real HTTP requests exercising the full
   provisioning lifecycle: unauthenticated request (401) → authenticated but
   unprovisioned identity (provision prompt) → `vikunja_auth provision` with
   the stack's real token → a real tool call as the provisioned identity →
   `vikunja_auth deprovision`.

Run it against the local stack:

```bash
VIKUNJA_VERSION=2.4.0 npm run e2e:up   # if not already running
npm run test:e2e:oidc
```

Like `test:e2e:mcp`, it never reads the ambient `VIKUNJA_URL` /
`VIKUNJA_API_TOKEN` — only the harness-specific `MCP_E2E_VIKUNJA_URL` /
`MCP_E2E_VIKUNJA_API_TOKEN` overrides, and only after verifying the target
resolves to localhost.

**Known current failure (step "(d) real end-to-end tool call"):** this lane
currently fails at the "list projects as the provisioned identity" step, and
this is a genuine finding, not a harness bug — see the inline comment above
that step in `scripts/oidc-e2e.ts` for the full root-cause writeup. Short
version: most tool handlers (`vikunja_projects` among them) gate on, and
make their real REST calls through, the process-global `AuthManager`
captured at `registerTools()` time — never the ALS-resolved, per-identity
`AuthManager` that `getAuthManagerFromContext()` (`src/client.ts`) correctly
returns per docs/OIDC-RESOURCE-SERVER.md §3d (D6). `tests/oidc/isolation.test.ts`
doesn't catch this because it tests `getAuthManagerFromContext()` directly,
not through a real tool handler. This needs a dedicated fix across the tool
surface before `oidc-http` mode is safe for real multi-user traffic beyond
the authentication boundary itself (which the threat-model suite,
`tests/oidc/threat-model.test.ts`, does verify holds).

## Sample-page screenshot capture (`npm run capture:samples`)

`scripts/capture-sample-screenshots.ts` drives the real Vikunja *web UI*
(not just the API) with [Playwright](https://playwright.dev/) to capture
the screenshots embedded in `docs/samples/*.md` — the worked-example pages
linked from the main README. Unlike `test:mcp` / `test:e2e:mcp`, its output
isn't pass/fail assertions; it's PNGs written to `docs/samples/assets/` and
the corresponding `![...]  (assets/...)` embeds spliced into the sample
pages in place of `` `[SCREENSHOT: ...]` `` placeholder lines.

Playwright itself (the `playwright` npm package and its bundled Chromium)
is a devDependency, used only by this script — nothing under `src/` depends
on it, and it's not part of the published package (see `files` in
`package.json`).

Run it against the local stack:

**Known gap:** unlike `test:e2e:mcp`, this script has not been migrated to
the target resolver — it still defaults to the pre-#205 port `33456`
(`scripts/capture-sample-screenshots.ts`), which no target publishes any
more, so point it at the stack explicitly until that's fixed:

```bash
npm run e2e:up                    # if not already running
npx playwright install chromium   # first run only, or after bumping playwright

CAPTURE_SCREENSHOTS_VIKUNJA_URL=http://localhost:8240/api/v1 \
CAPTURE_SCREENSHOTS_VIKUNJA_WEB_URL=http://localhost:8240 \
npm run capture:samples
```

Either way it refuses to run against anything that doesn't resolve to
`localhost`/`127.0.0.1`/`::1`. It logs in as the
bootstrap-created `e2e-test` user via the real login form, and creates a
second CLI user (`sample-alice`, via the container's `vikunja user`
subcommand — there's no `/admin/users` API on the pinned stack version) to
demonstrate multi-user flows (sharing, assignment notifications).

### Idempotency / re-runnability

All seeded data — projects, labels, teams, and saved filters — is named
with a `sample-` prefix. Every run sweeps for and deletes any leftover
`sample-*` data (and the `sample-alice` CLI user) at startup, and deletes
everything it created in a `finally` block at the end, so the Vikunja UI is
left clean for a human to inspect between runs, the same convention
`test:e2e:mcp` uses for `mcp-e2e-*` data.

### When a described shot can't be honestly captured

A couple of the placeholders in `docs/samples/*.md` describe UI states this
script can't produce faithfully:

- **Mid-drag/mid-transition animations** (e.g. kanban-flow.md's card-move
  step) — Playwright can't capture an in-progress CSS transition frame on
  demand. The script performs the real move via the same REST endpoint the
  MCP tool uses, then captures the completed state, with a short note
  appended under the image explaining the substitution.
- **UI elements the pinned Vikunja version doesn't have** (e.g.
  stay-informed.md's "subscribe bell icon in the project header" — this
  version only exposes subscribe state via the project's "..." menu) — the
  script captures the nearest honest equivalent and notes the substitution.
- **The admin panel** (all three placeholders in admin-ops.md) — still not
  implemented as of the pinned `vikunja/vikunja:2.4.0` (re-verified during
  the 2.4.0 alignment, tracking issue #28 item A1): `GET /admin/overview`
  still 404s under a JWT (confirmed genuinely "not found", not an auth
  rejection — an API-token-authenticated request 401s earlier instead,
  since admin routes are JWT-only, but a JWT-authenticated request reaches
  routing and gets a plain 404), and no `admin` group appears in `GET
  /routes`. The vendored OpenAPI spec still documents `/admin/*` paths
  (unchanged from the previous vendored spec — see "Version pinning and
  refresh" above), so this remains a documented spec/served-API gap, not
  test drift. Rather than fabricate a screenshot of a UI that isn't
  actually running, the script replaces those three placeholders with an
  explanatory note instead of an image. Re-run the script once the pin
  moves to a release that ships the admin panel.

### A note on `POST /notifications/{id}`

While building the "mark one read" capture, sending an empty body (as
`docs/vikunja-openapi.json` documents — "no request body") verifiably did
**not** persist a read state on the pinned server version, even after
repeated calls; sniffing the real frontend's own request showed it sends
`{"read": true}` explicitly, which does persist. The capture script does
the same. This is a capture-script-only workaround, not a change to
`src/tools/notifications.ts` (out of scope for the item that added this
script) — worth checking if `vikunja_notifications`'s `mark-read`
subcommand is ever reported as silently not sticking against a real
server.
