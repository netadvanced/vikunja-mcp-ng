# Local End-to-End Testing

This document describes the disposable local Vikunja stack in `docker/e2e/`,
used to run `scripts/test-mcp.ts` (`npm run test:mcp`) against a real Vikunja
server instead of mocks. The stack supports two DB backends: Postgres
(default) and SQLite (the `-sqlite` targets, item F2 / tracking issue #28).
See "DB backend variant" below.

**Production safety.** This stack, and `npm run test:mcp` in general, is
for a throwaway local Vikunja instance only. Never point `VIKUNJA_URL` /
`VIKUNJA_API_TOKEN` at a production Vikunja instance, and never run this
(or any automated test run) against one. `test:mcp` creates and deletes
projects, tasks, and labels, and the bootstrap script creates a
known-password test user. None of that is safe against real data.

## What's in `docker/e2e/`

- `docker-compose.yml`: a multi-service stack, namespaced under a
  per-target compose project name (`vikunja-e2e-<version>-<db>`,
  interpolated from `E2E_PROJECT`; the resolver-less fallback is
  `vikunja-e2e-2.4.0-postgres`, see that file's comment for why) so
  it can't collide with anything else running on the machine. Uses
  non-default host ports, all *derived* from the version (see "Targets"
  below): the default target publishes **8260** for Vikunja (`VIKUNJA_URL`
  points here, same for both DB backends). A *dedicated*-Postgres target also
  publishes its own database port (**18240** for the 2.4.0 floor lane) for
  ad-hoc `psql` debugging; the shared-Postgres lanes use the one server on
  15432 instead (see "One shared Postgres server" below).
  Two DB-backend variants are defined as Compose *profiles*:
  `postgres` (`db` + `files-init` + `vikunja`, the pre-existing default) and
  `sqlite` (`sqlite-db-init` + `files-init` + `vikunja-sqlite`, added by item
  F2). See the comment block at the top of the file for the full profile
  design and why it's profiles rather than a merged overlay file. All
  services have healthchecks and their data lives in named volumes
  (`vikunja-mcp-e2e-db`, `vikunja-mcp-e2e-sqlite-db`, `vikunja-mcp-e2e-files`)
  so the stack survives a restart. Only one profile is ever active at a
  time; both variants publish the same host port.
- `bootstrap.sh`: waits for the stack to become healthy, creates a test
  user via the Vikunja container CLI, logs in to get a JWT, and uses that
  JWT to mint a long-lived `tk_*` API token (falling back to the JWT itself
  if token creation fails). Writes the target's own credentials file,
  `docker/e2e/.env.<version>-<db>` (gitignored), and prints
  `export VIKUNJA_URL=...` / `export VIKUNJA_API_TOKEN=...` lines.
  Safe to re-run against an already-bootstrapped stack (idempotent: it logs
  in with the existing test user instead of re-creating it, and reuses the
  stored token if it still authenticates; see "Credentials are stable"
  below). Reads `VIKUNJA_E2E_TARGET` (default `2.6.0-postgres`) to select
  which version, Compose profile/service, and ports to bring up and
  bootstrap against. Also provisions the three e2e users and, for a
  shared-Postgres target, creates that target's database on demand.
- `stacks.sh`: the lifecycle helper behind `npm run e2e:up:all` /
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

(`npm run e2e:up` selects everything (version, DB backend, ports, env file)
from `VIKUNJA_E2E_TARGET` alone; a bare `VIKUNJA_DB=` / `VIKUNJA_VERSION=`
is ignored there. `npm run test:matrix` still takes `VIKUNJA_VERSION` /
`VIKUNJA_DB` and derives the target from them; see "Version-matrix
testing" below.)

This exists because SQLite and Postgres have different concurrency
characteristics under concurrent writes: SQLite serializes writers with a
file lock, Postgres uses MVCC. So a whole class of bug (concurrent-write
lock contention, e.g. netadvanced/vikunja-mcp-ng#116: `bulk-create`'s
`maxConcurrency: 8` write fan-out 500ing with "database is locked" on
SQLite, then tripping the shared circuit breaker into a full create-endpoint
outage) was **structurally invisible** to every local/matrix run before this
variant existed, because this stack only ever ran Postgres. Running the
same harnesses against the `sqlite` variant surfaces that class of bug
instead of silently passing.

`npm run e2e:down` always stops *both* profiles (`--profile postgres
--profile sqlite down`, see `docker/e2e/stacks.sh`) but deliberately keeps
the volumes; see "Stopping vs resetting" below. `npm run e2e:reset` is the
same command plus `-v`, so it reliably removes all three named volumes
regardless of which variant was last up. There is no "leftover sqlite
volume" case to worry about after a `reset`.

`scripts/mcp-e2e.ts` includes one check explicitly written to catch this
class of bug: a 12-task `bulk-create` stress check, labeled
`(sqlite-sensitive, see #116)` in its output. It's expected to pass 12/12 on
Postgres and on a SQLite stack whose `bulk-create` write concurrency has
been fixed (e.g. serialized); on an *unfixed* SQLite stack it is expected to
intermittently under-create (partial success, e.g. 11/12) with
`"database is locked"` visible in `docker compose -f docker/e2e/docker-compose.yml
-p vikunja-e2e-2.4.0-sqlite logs vikunja-sqlite` (each target is its own
Compose project; see "Targets" below) even
though the HTTP response body only ever says `"Internal Server Error"`. A
`FAIL` on this one check against a `-sqlite` target is expected and
documented, not a harness bug. See the PR that introduced this check for
recorded before/after evidence.

## Targets: one persistent stack per Vikunja version

Since issue #205 there is no single "the stack". Each **target**
(`<version>-<db>`) is its own Compose project with its own volumes and its
own ports, so several versions run **at the same time** and one agent's work
cannot disturb another's:

| Target | API port | Notes |
|---|---|---|
| `2.6.0-postgres` | **8260** | the default; aligned/tested |
| `2.6.0-sqlite` | 9260 | aligned, SQLite-only failure classes |
| `2.4.0-postgres` | 8240 | the floor lane (minimum supported) |
| `2.4.0-sqlite` | 9240 | floor, SQLite-only failure classes |

Aligned moved to `2.6.0` on 2026-09-02 (issue #254) and the floor stayed at `2.4.0`, so the
floor lane is back and the standard set is four stacks. The pin lives in `DEFAULT_TARGET` and
`FLOOR_VERSION` in `scripts/lib/e2e-target.ts` — those two constants, nowhere else.

**2.5.0 is deliberately not a lane.** It resolves like any other version
(`VIKUNJA_E2E_TARGET=2.5.0-postgres npm run e2e:up`, port 8250) and was stood up ad hoc to
bisect the v2 PATCH-on-subscribed-task fix to it, but it is not in `standardTargets()` and
`npm run e2e:up:all` does not include it. Support for 2.5.0 rests on a source diff plus its two
tested neighbours; adding a fifth target would claim test coverage that does not exist.

The **resolver is unchanged** for older versions too: `2.3.0-postgres` still resolves to port
8230 and can still be stood up by hand if you ever need to look at the old floor. It is simply
not a supported target any more.

Ports are **derived, never hand-assigned**: `8000 + (major×100 + minor×10 +
patch)` for Postgres, `9000 + …` for SQLite, so Vikunja 2.4.1 lands on 8241
with no edit anywhere. The formula and the target list live in
`scripts/lib/e2e-target.ts`, which both the shell scripts and the TypeScript
harnesses consult. Never hardcode a port.

```bash
npm run e2e:up                                   # default target (2.6.0-postgres, port 8260)
VIKUNJA_E2E_TARGET=2.4.0-postgres npm run e2e:up # the floor lane, port 8240
npm run e2e:up:all                               # every standard target at once
npm run e2e:status                               # what's up, on which port, running which version
```

Each target writes its own credentials file,
`docker/e2e/.env.<version>-<db>` (gitignored, since these hold live tokens).

### One shared Postgres server, one database per target

Per-target isolation originally meant a **whole Postgres container** per
postgres target. Three supported versions is then three Postgres containers
idling for no benefit, since the databases never talk to each other.

So there is now one long-lived `postgres:16-alpine`
(`docker/e2e/docker-compose.shared-db-server.yml`, its own Compose project
`vikunja-e2e-shared-db`, host port **15432**), and each participating target
gets its own **database** inside it — `vikunja_2_5_0`, `vikunja_2_6_0`, and so
on, created on demand by `bootstrap.sh`. Everything else about a target is
unchanged: still its own Compose project, its own derived ports, its own
credentials file.

Which arrangement a target uses is decided in one place,
`DEDICATED_DB_VERSIONS` in `scripts/lib/e2e-target.ts`:

| Target | Database |
|---|---|
| `2.3.0-postgres`, `2.4.0-postgres` | **dedicated** Postgres container, as before |
| every other `*-postgres` | a database inside the shared server |
| every `*-sqlite` | an embedded file, no database service at all |

The two legacy lanes are grandfathered on purpose, not preferred:
`2.4.0-postgres` is a running stack whose stable API token other worktrees
hold, and moving its data would rotate that credential for nothing. A future
release needs no edit — anything outside that set is shared by default.

Two consequences worth knowing:

- `npm run e2e:down` leaves the shared server running. It belongs to no
  single target, and stopping it would take every other shared lane down
  too. Remove it deliberately:
  `docker compose -f docker/e2e/docker-compose.shared-db-server.yml down -v`.
- `npm run e2e:reset <target>` **drops that target's database** as well as
  its volumes. A shared lane's data lives in a database, not a volume, so
  `down -v` alone would leave a "reset" stack fully intact.

Mechanically it is the same opt-in overlay idiom as the OIDC lane:
`docker-compose.shared-db.yml` is passed as a second `-f` only for a shared
target, and adds a third service block (`vikunja-shared`, profile
`postgres-shared`) alongside the existing `vikunja` and `vikunja-sqlite`. A
third block rather than re-pointing `vikunja` at the shared server because
Compose merges `depends_on` maps by key and cannot *delete* the dedicated
`db` entry — the same constraint that already forced a separate sqlite block.

### Credentials are stable

`bootstrap.sh` is idempotent about tokens: if the target's env file holds a
token that still authenticates, it is **reused**. A token therefore survives
`npm run e2e:down` and only ever changes when someone deliberately runs
`npm run e2e:reset`.

This matters because it used to be otherwise: `e2e:down` ran `down -v`,
destroying the volumes, so the next `e2e:up` produced a fresh database, a
fresh user, and a fresh token, silently invalidating the credential any
other process was holding.

### Three users, deliberately

| User | Purpose |
|---|---|
| `e2e-test` | The shared identity every harness authenticates as, and the owner of the stored token. **Nothing may mutate its user-level state.** |
| `e2e-mutable` | For tests that change identity-scoped state: API tokens, user settings, avatar provider. Breaking this user cannot break anyone else's run. |
| `e2e-other` | A stranger. Owns projects, teams and tasks that `e2e-test` must **not** be able to read. |

All three are provisioned by `bootstrap.sh`. The JWT lane in
`scripts/mcp-e2e.ts` authenticates as `e2e-mutable` precisely because it
changes the avatar provider.

`e2e-other` was added for the Vikunja 2.6.0 alignment (issue #254, item B2)
and is worth understanding, because it closes a structural blind spot rather
than adding a test. Every harness used to authenticate as one user who owned
everything it touched, so an entire class of behaviour was unreachable: a
team you cannot read, a task that stops being readable mid-flow, a project
someone else shares with you and then un-shares. 2.6.0 tightened exactly that
class. Without a second identity we could have shipped "aligned to 2.6.0",
fully green, and broken every user who is not an admin of everything.

It is deliberately **not** `e2e-mutable`. That user exists to have its
identity state burned by avatar and token tests; a permissions fixture must
not be perturbable by an avatar test.

The revocation path (`revokeProjectUser` in `scripts/lib/e2e-fixtures.ts`) is
what makes "this is now unreadable to you" reproducible in-process. Note it
takes the **username** in the path, not the numeric id the OpenAPI spec
declares — see `docs/VIKUNJA_API_ISSUES.md` #24.

### A narrow-scoped `tk_*` token, and why

`bootstrap.sh` mints the harness token by asking `GET /routes` for every
permission the server has and granting all of them. From 2.6.0 Vikunja checks
`expand` values against the token's scopes — which a token holding every
scope can never trip.

So `scripts/mcp-e2e.ts` mints a second token per run (`mintScopedToken`,
`scripts/lib/e2e-fixtures.ts`) that holds everything **except**
`tasks_comments` and `reactions`, and runs a third server session under it.
It is minted per run rather than stored on purpose: the token is defined by
what it omits, so a stale one that silently gained a scope later added to
`GET /routes` would turn the whole lane into a false green.

### Version-conditional expectations

Several 2.6.0 changes are tightenings: the older server accepts the call and
silently does something useless or leaks something it should not, the newer
one refuses. A harness that runs on both cannot assert one outcome.

`serverAtLeast(detectedServerVersion, '2.6.0')` (`scripts/lib/e2e-fixtures.ts`)
is the gate, and the checks assert **different expected values per version**
rather than tolerating a failure on one of them:

| Behaviour | 2.4.0 | 2.6.0 |
|---|---|---|
| Bucket/webhook write on an archived project | accepted | `412` code `3008` |
| `GET /tasks/{id}/assignees` | includes `email` | omits it |
| `GET /projects/{id}/teams` with an unreadable team | full team leaked | scrubbed (blank name) |
| Attaching a team you cannot read | accepted | `403` |
| `unrelate` when the other task is unreadable | accepted | `403` |
| Narrow token + `expand=comments` | accepted | `401`, surfaced not degraded |

This is **not** a revival of the removed `versionLessThan`/`driftTolerated`
pair. Those meant "tolerate a known regression"; this means "the correct
expected value depends on the version", which is an ordinary assertion with a
computed expectation. An undetected server version deliberately evaluates as
*not* new enough, so a missing `GET /info` can never be mistaken for the new
behaviour.

One check is deliberately *not* gated: `set-position` with a view from
another project is refused on every version, because this client refuses it
itself (`assertViewBelongsToProject`) — 2.4.0 would otherwise accept it and
silently order the task in a view nobody looks at.

### Running several harnesses at once

Concurrent runs against the **same** target are safe:

- Each `test:e2e:mcp` run uses a unique fixture prefix
  (`mcp-e2e-<runId>-`) and only ever sweeps its own. The root-prefix sweep,
  which collects strays from crashed runs, is opt-in via `--sweep-all`;
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
`npm run e2e:up`), source it: one file per target, so pick the one matching
the stack you want to hit:

```bash
set -a && source docker/e2e/.env.2.6.0-postgres && set +a
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

- **Web UI:** http://localhost:8240/ (default target; 9240 for the sqlite backend)
- **API base:** http://localhost:8240/api/v1
- **Login:** the bootstrap-created test user: username `e2e-test`, password
  as set in `TEST_PASSWORD` at the top of `docker/e2e/bootstrap.sh` (a fixed,
  throwaway, local-only credential; it's never randomized, so the value in
  that script is always current and correct; check there rather than
  trusting a copy of it in this doc going stale).

This is a real login against the local instance, independent of the
`tk_*` API token in `docker/e2e/.env.<version>-<db>`, useful for eyeballing whatever
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

Both accept explicit targets (`npm run e2e:down 2.4.0-sqlite`); with no
argument they apply to every standard target.

Leaving the stacks up between sessions is now the expected state: that is
what makes them a stable fixture rather than something every run rebuilds.

## How the bootstrap works, in detail

1. `docker compose ... up -d --wait`: waits for `db`'s `pg_isready`
   healthcheck and, once `db` is healthy and the one-shot `files-init`
   container has chowned the files volume to uid 1000 (the vikunja image
   runs as uid 1000 with no shell, so it can't fix that itself; see the
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
   API-token by the `eyJ`/`tk_` prefix; see `src/auth/AuthManager.ts`).

## Version pinning and refresh

**Policy: minimum supported Vikunja is 2.4.0 (the v1-floor); the
aligned/tested default is 2.6.0 since 2026-09-02. The two no longer
coincide, so the floor lane is live again.**

The floor was `2.3.0` until 2026-08-31. It rose because nine operations this
server ships as `✅ Implemented` (the eight `/admin/*` operations behind
`vikunja_admin`, plus `GET /projects/{project}/tasks/by-index/{index}`,
i.e. `vikunja_tasks get-by-index`) **do not exist on a released Vikunja 2.3.0
at all**; the 169-operation denominator they were counted in came from a
`try.vikunja.io` *unstable* build 1019 commits past the `v2.3.0` tag, not
from the tag. Raising the floor makes the compatibility claim true rather
than bolting a caveat onto a false one. Secondary reason: upstream moves
fast and this project needs to keep up. See `docs/ROADMAP.md` §3 decision 27.

Aligned moved 2.4.0 -> 2.6.0 on 2026-09-02 (issue #254) after a live probe
pass and a clean four-lane `test:matrix` run. The floor deliberately did NOT
move with it: nothing in 2.6.0 makes 2.4.0 unsupportable, and 2.6.0 is weeks
old, so a self-hoster on 2.4.0 or 2.5.0 is the normal case rather than a
straggler. Several 2.6.0 changes are permission *tightenings* that the two
lanes must therefore assert differently — see "Version-conditional
expectations" below.

Practical consequences:

- The **floor lane is back**: four standard targets, and the floor row in
  `docs/RELEASING.md`'s pre-tag checklist is live again.
- Some workarounds in `src/` (e.g. `src/tools/projects/sharing.ts`'s
  by-id-share-GET workaround) exist for upstream bugs fixed in 2.4.0. Their
  documented removal condition, "when the minimum supported version is raised
  to ≥ 2.4.0", **has now fired**, but removing them is a behaviour change
  needing live re-verification, so it is deliberately a separate change from
  the policy raise. Do not treat a stale "still needed at the 2.3.0 floor"
  comment as current; check the dated note next to it.

The pin is `DEFAULT_TARGET` in `scripts/lib/e2e-target.ts`, not a literal in
the compose file; see the comment block at the top of
`docker/e2e/docker-compose.yml` for why its own fallbacks deliberately stay
on the 2.4.0 dedicated-Postgres target. The vendored OpenAPI spec at
`docs/vikunja-openapi.json` is fetched directly from the aligned version's
container `/api/v1/docs.json` (`npm run fetch:api-spec:container`, see
`[docs/API-SPEC.md](API-SPEC.md)`). Its `info.version`
matches the pin exactly (`v2.6.0`, confirmed byte-for-byte, no ahead-of-tag
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
2. Bump `DEFAULT_TARGET` in `scripts/lib/e2e-target.ts` — that one constant.
   Everything else derives from it: ports, project names, env-file names, and
   `standardTargets()`. Decide deliberately whether `FLOOR_VERSION` moves with
   it (it usually should not: the floor is a support promise, not a
   convenience). A new version is `shared`-Postgres by default; nothing needs
   adding to `DEDICATED_DB_VERSIONS`.
3. Bring the stack up on the new tag and refresh `docs/vikunja-openapi.json`
   from it (`VIKUNJA_E2E_TARGET=X.Y.Z-postgres npm run e2e:up && npm run
   fetch:api-spec:container && npm run generate:api-types`), if you also
   want to re-check spec/tool alignment. `fetch:api-spec:container` resolves
   the port through the target resolver and refuses to write if that port
   answers with a different version than the target's, so it can no longer
   silently re-vendor the old version's spec.
4. `npm run e2e:reset && npm run e2e:up && npm run test:mcp` and re-triage
   any new failures using the same (a)/(b)/(c) categories as any other
   real-server run (script staleness / real server drift / environment
   issue; see the PR that introduced this stack for the categorization
   convention).

## Known limitation: `test:mcp` doesn't call the MCP tool layer

`scripts/test-mcp.ts` talks directly to the Vikunja REST API over `fetch()`
using the same request shapes the MCP tools use. It does not spawn the
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
   `StdioClientTransport`, the same transport a real MCP client (Claude
   Desktop, Claude Code, etc.) uses.
4. Drives the server exclusively through `client.callTool()`. Every
   assertion in the run is against the actual tool response text (ids,
   titles, field values it round-trips), not just absence of an error.

Run it against the local stack:

```bash
npm run e2e:up   # if not already running
npm run test:e2e:mcp
```

It requires no environment variables. The target's local API URL comes
from the resolver (`scripts/lib/e2e-target.ts`; default target
`2.6.0-postgres`, i.e. `http://localhost:8260/api/v1`, selectable with
`VIKUNJA_E2E_TARGET`), and credentials come from that target's
`docker/e2e/.env.<version>-<db>` when it exists (the stable token; see
"Credentials are stable" above). If it doesn't, the harness mints its own
the same way `docker/e2e/bootstrap.sh` does (log in as `e2e-test`, mint a
fresh `tk_*` API token via `PUT /tokens`, tolerating the 201 the real
server returns where the spec documents 200), so a missing credentials file
never blocks a run.

### Coverage

`list-tools` (asserting the expected tool set, including the tools that
should be *absent* under API-token auth and default module config:
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
(direnv, a personal MCP client config, etc.). During this harness's own
development, an early version *did* fall back to `process.env.VIKUNJA_URL`
when unset, and because the developer's shell already exported it for
unrelated reasons, a full run silently created, searched, and deleted data
against a real production Vikunja account instead of the disposable local
stack (fully cleaned up automatically by the harness's own teardown, but
the near-miss is exactly why this exists). To make that class of mistake
structurally impossible:

- The target URL always comes from the local-only target resolver (or that
  target's own credentials file) and is only overridable via the
  harness-specific `MCP_E2E_VIKUNJA_URL`/`VIKUNJA_E2E_TARGET`, never
  the ambient `VIKUNJA_URL`, and is then required to resolve to
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
creates in a `finally` block at the end, so the Vikunja UI is left clean
for a human to inspect between runs.

### Findings categorization

Every mismatch the harness finds is reported as one of:

- **harness**: a problem with the harness script itself (e.g. couldn't
  parse a response it should have been able to).
- **tool-bug**: the MCP tool layer sends or parses something wrong against
  the real server. Fixed inline when trivial and clearly in-scope (with a
  regression test), otherwise documented for follow-up.
- **server-drift**: the real server's behavior differs from the documented
  spec / this repo's implementation is correct but the pinned local Vikunja
  version's behavior isn't (e.g. an endpoint 500s regardless of what's sent;
  reproduced with a raw, tool-independent request to confirm it isn't
  this codebase's fault before filing it here).

A **known, version-gated tolerance** of the last category: `GET
/tasks/{id}/assignees` returns HTTP 500 unconditionally on Vikunja versions
below 2.4.0 (fixed upstream on `go-vikunja/vikunja`'s `main` via PR #2791,
confirmed shipped in the 2.4.0 tagged release during the 2.4.0-alignment
work, tracking issue #28 item A1). The harness detects the server version
via `GET /info` at startup and only tolerates this exact signature when the
detected version is `< 2.4.0`; on 2.4.0+ it's a hard failure like any other
regression. It still *runs* this check on every version, never globally
skipped, reported as `⚠ list task assignees (server-drift, tolerated:
...)` instead of `✗ ...` only below 2.4.0: recorded as a `server-drift`
finding and excluded from the pass/fail counts and exit code there, but a
genuine `✓ list task assignees` pass on 2.4.0+ (confirmed in
`e2e-verdicts/vikunja-2.4.0-{postgres,sqlite}.md`). See
`detectServerVersion()`/`versionLessThan()`/`driftTolerated()` in
`scripts/mcp-e2e.ts` for the implementation. If this ever 500s on a 2.4.0+
server, that's a new, real regression, not the same known gap. The
tolerance won't mask it.

## Version-matrix testing (`npm run test:matrix`)

`scripts/test-matrix.ts` is the one-command runner that ties the two
harnesses above together against a *chosen* Vikunja server version **and**
DB backend, so re-validating this project against a newly-released Vikunja
tag, a different DB backend, or re-confirming it against the current
defaults, is a single command instead of a manual sequence of
stack-recreation and harness-invocation steps. The matrix is version × db
(item F2 / tracking issue #28 added the db dimension; see "DB backend
variant" above).

```bash
npm run test:matrix                                          # aligned (2.6.0) / postgres
VIKUNJA_DB=sqlite npm run test:matrix                         # aligned, sqlite backend
VIKUNJA_VERSION=2.4.0 npm run test:matrix                     # the floor lane
VIKUNJA_VERSION=2.4.0 VIKUNJA_DB=sqlite npm run test:matrix   # floor, sqlite
```

For the chosen `VIKUNJA_VERSION` (defaults to `DEFAULT_TARGET`'s version —
derived from the resolver, never a literal, so it cannot keep testing the old
aligned version after the pin moves) and
`VIKUNJA_DB` (default `postgres`; see "DB backend variant" above), it:

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
   `sqlite-sensitive`; see "DB backend variant" above), streaming their
   output live and also capturing it.
3. **Reads the actual server version from `GET /api/v1/info`** rather than
   trusting the `VIKUNJA_VERSION` input. If the requested tag doesn't
   exist on Docker Hub (or the server otherwise comes up reporting
   something else), the run fails loudly with that mismatch instead of
   silently mislabeling results.
4. **Writes a verdict file** to `e2e-verdicts/vikunja-<server-version>-<db>.md`
   (gitignored; see "Verdict files aren't committed" below) with a
   `# vikunja-mcp-ng <our-version> vs Vikunja <server-version> (<db>): PASS/FAIL`
   header, the full per-check list from both harnesses (parsed from their
   own `✓`/`✗`/`⊘`/`⚠` stdout lines; see "Findings categorization" above
   for what those mean), and a closing verdict paragraph. The overall
   verdict is `PASS` only if *both* harnesses exit 0 with zero non-tolerated
   (`✗`) failures; `⚠ server-drift` entries don't block a `PASS`. Historical
   note: prior to the 2.4.0 alignment, a `sqlite`-backend run against 2.3.0
   was *expected* to occasionally `FAIL` (or under-create, 11/12) on the
   `bulk-create` stress check per #116's SQLite lock-storm-under-circuit-
   breaker issue. As of the 2.4.0 alignment (tracking issue #28 item A1),
   this check passed 12/12 across 5 repeated runs against `2.4.0`/sqlite;
   see "Vikunja 2.4.0 and `concurrent_writes`" below. This project's
   client-side write-serialization is retained regardless. Its revisit
   condition is a conjunction ("floor ≥ 2.4.0 **and** durable multi-run
   evidence across upstream point releases") and only the first arm has
   fired with the 2026-08-31 floor raise; see the comment on the `create`
   `BatchProcessor` in `src/tools/tasks/bulk-operations-simplified.ts`.
5. **Exits 0 on `PASS`, 1 on `FAIL`**: usable as a plain shell gate even
   without CI (GitHub Actions are disabled repo-wide by explicit owner
   decision; this is why this entire workflow is a local script rather
   than a workflow file).

### Safety

Exactly like `test:e2e:mcp` (see above), this script never reads the
ambient `VIKUNJA_URL` / `VIKUNJA_API_TOKEN` env vars; every child process
it spawns (`npm run e2e:up`, `npm run test:mcp`,
`npm run test:e2e:mcp`) gets a copy of `process.env` with those (plus
`VIKUNJA_API_TOKEN_FILE`) stripped first. `test:mcp` needs *some*
credentials (unlike `test:e2e:mcp`, it doesn't mint its own), so this
script reads them explicitly out of `docker/e2e/.env` after bootstrapping
and hands them to that one child process only, asserting the URL resolves
to `localhost`/`127.0.0.1`/`::1` first. **Known gap:** that path is the
pre-#205 one: `bootstrap.sh` now writes `docker/e2e/.env.<version>-<db>`,
so `test:matrix` fails on a checkout with no leftover `docker/e2e/.env`
until `scripts/test-matrix.ts` is pointed at the target's env file. This
matters concretely in this
repo: this directory has a real, production-pointed `.envrc` that a
developer's shell may already have loaded via direnv. Never read `.env`
or `.envrc` directly, and never trust that ambient env vars are safe
defaults.

### Verdict files aren't committed

`e2e-verdicts/` is gitignored, the same convention as `coverage/`: a
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
defense-in-depth. Its revisit condition is a conjunction: floor raised to
≥ 2.4.0 **and** multi-run evidence, beyond one wave's handful of runs, that
the upstream fix is durable across point releases. The 2026-08-31 floor
raise fired the first arm only; the second is still unmet, and serializing
creates is cheap in the common case. See that file's comment for the exact
wording.

### When a new Vikunja release ships

1. `curl -s https://hub.docker.com/v2/repositories/vikunja/vikunja/tags?page_size=100`
   (or the [releases page](https://github.com/go-vikunja/vikunja/releases))
   to confirm the new tag exists. What is *in* it should already be on issue
   #250; see "Upstream watch" below, which watches upstream `main` weekly so
   a release is never the first news.
2. `VIKUNJA_VERSION=X.Y.Z npm run test:matrix`: inspect the verdict; a
   `FAIL` needs triage (script staleness / real tool bug / new server-drift
   to document and tolerate the same way the assignees case above is
   tolerated) before going further.
3. If it passes (or once triaged failures are addressed), refresh the
   vendored spec from the newly-pinned container if you also want to
   re-check spec/tool alignment: `VIKUNJA_E2E_TARGET=X.Y.Z-postgres npm run
   e2e:up && npm run fetch:api-spec:container && npm run generate:api-types`
   (`fetch:api-spec:container` reads port 8240; see step 3 of "Version
   pinning and refresh" above; see
   [docs/API-SPEC.md](API-SPEC.md) for why the container, not `try.vikunja.io`, is the
   source of truth).
4. Bump the *default* pin in `docker/e2e/docker-compose.yml` (the
   `${VIKUNJA_VERSION:-2.4.0}` fallback, the `${E2E_PROJECT:-…}` /
   `${E2E_PORT:-…}` fallbacks, and the matching comment block), and
   `DEFAULT_TARGET` / `standardTargets()` in `scripts/lib/e2e-target.ts`,
   then re-run `npm run test:matrix` with no override to confirm the new
   default is green.
5. Cut a **minor** release aligned to the new Vikunja version, per
   [docs/RELEASING.md](RELEASING.md) §3's Docker compatibility-tag scheme (`X.Y.Z`,
   `X.Y.Z-vikunja<A.B.C>`, `latest`); changing the base Vikunja version
   this project targets is always at least a minor bump (see
   [docs/RELEASING.md](RELEASING.md) §1).

## Upstream watch (`npm run watch:upstream`)

The section above starts at "a new Vikunja release ships". This is how you
find out that something is coming *before* there is a tag to react to.

`scripts/upstream-watch.ts` (judgement in `scripts/lib/upstream-watch.ts`,
unit-tested there) reads `go-vikunja/vikunja`'s `main` branch over the public
GitHub REST API, filters the commits down to what can plausibly change what
this client observes, and emits a digest as JSON and markdown.
`.github/workflows/upstream-watch.yml` runs it weekly (Mondays 06:17 UTC) and
appends the digest to tracking issue
[#250](https://github.com/netadvanced/vikunja-mcp-ng/issues/250). It never
talks to a Vikunja server, never touches a local clone, and is not PR CI:
nothing a contributor pushes triggers it.

### Why not just diff `swagger.json`

Because the spec is the one place the interesting changes *don't* show up.
Across 2.4.0 → 2.6.0 the vendored v1 OpenAPI surface moved by exactly **one**
operation (`DELETE /notifications`), while a review of the same delta against
what a client like ours actually does classified roughly **17 breaking**
changes. The signal lives in handler enforcement the spec never describes:
`pkg/models/**`, `pkg/routes/**`, `pkg/web/**`, `pkg/migration/**`,
`pkg/modules/auth/**`, `pkg/user/**`, and any `*_permissions.go` /
`*_rights.go` file wherever it moves to. So `pkg/swagger/**` and
`*swagger.json` are on the **irrelevant** list on purpose, as are
`*_test.go`, `frontend/`, and `docs/`, which churn several times a day and
would drown the digest. Both lists live in `RELEVANT_UPSTREAM_PATHS` /
`IRRELEVANT_UPSTREAM_PATHS` and are the only place to tune this. Adding a
rule is cheap (more noise); removing one is what makes a 2.6.0-shaped
surprise possible again. See issue #237 for the analysis this filter came
out of.

### Running it locally

```bash
# Free, read-only, stores nothing: scan the last 7 days, markdown to stdout.
npm run watch:upstream -- --lookback-days 7
```

Auth is optional but strongly recommended: the script makes one API call per
commit examined, and unauthenticated GitHub REST allows 60 requests an hour.
Export `GITHUB_TOKEN` (or `GH_TOKEN`); any read-only token will do; the
workflow passes the default `GITHUB_TOKEN`, which needs no configuration.
No repository secret is required for any of this.

Useful flags (`scripts/upstream-watch.ts` carries the full list):
`--lookback-days N` (ignore the watermark, scan a fixed window),
`--json-out` / `--md-out` (write the digest to files instead of stdout),
`--state-file` (read the stored watermark from a file), `--max-commits`,
`--repo` / `--branch`.

### Exit-code contract

The caller has to be able to tell three outcomes apart, so it does:

| Code | Meaning | What the workflow does |
|---|---|---|
| `0` | Ran fine, **nothing relevant** | Posts **nothing**. Deliberate: a tracker that says "nothing to report" every week gets muted, and then it is worse than nothing. |
| `10` | Ran fine, **findings to report** | Appends the digest to issue #250 and advances the watermark. |
| anything else (`1`) | **The run failed** | Fails the job, posts nothing, and leaves the watermark where it was so next week re-examines the same window. |

If you wrap this in anything of your own, treat `10` as success. A naive
`if [ $? -ne 0 ]` reads every findings run as a failure.

### Running the workflow by hand

Actions → **Upstream watch** → *Run workflow*. Two inputs:

- **`lookback_days`**: ignore the stored watermark and scan this many days
  back. Leave empty to use the watermark. Use it to re-examine a window you
  think was missed.
- **`dry_run`**: produce the digest but post nothing and do not advance the
  watermark. The digest still lands in the job summary and as the
  `upstream-watch-digest` artifact (30-day retention), so this is the safe
  way to see what a run *would* say.

### The watermark, and how to fix it by hand

The watermark is a single HTML comment in the **body of issue #250**:

```html
<!-- upstream-watch:watermark sha=<commit-sha> date=<ISO-8601> -->
```

Not an Actions cache (evicted after 7 days unread, so a weekly job would sit
exactly on the eviction boundary and lose it silently) and not a committed
file (this repo forbids direct commits to `main`). The issue body is written
with the `issues: write` permission the job already needs, is human-readable,
and lives next to the output it explains.

It is advanced **only after** the digest has actually been posted, so a
failed post re-examines its window next week. Worst case is a duplicate
section; a silently lost week is not.

To correct it, edit issue #250's body in the browser and change the `sha=` /
`date=` values, or delete the line entirely. With no watermark line present a
run is bounded to a fixed first-run lookback
(`DEFAULT_FIRST_RUN_LOOKBACK_DAYS`, 14 days) rather than dumping the whole
history. A window larger than `MAX_COMMITS_PER_RUN` (300) is processed
oldest-first and the remainder is deferred to the next run, which the digest
says out loud.

### Agent triage is opt-in, and is off today

The workflow has an agent-triage stage that maps each relevant commit onto
our call sites and classifies it. It runs only when an `ANTHROPIC_API_KEY`
repository secret is present. **No such secret is configured today**, and
that is fine: the deterministic half still runs, still produces the digest,
and still posts it. The digest footer says in so many words that triage was
skipped for that run. The absence of the key changes nothing else about the
run.

### ⚠️ The trap: GitHub silently disables scheduled workflows

**GitHub disables `schedule` triggers in a repository after 60 days without
activity.** It does not fail the workflow, it does not open an issue, and it
sends nothing beyond one email to the repo admin. A weekly watcher simply
stops running, and a stopped watcher looks exactly like a quiet upstream,
which is the failure this whole thing exists to prevent.

How to notice:

- Issue #250 is the tell. If **no new comment and no watermark change** has
  appeared for more than about three weeks, assume the schedule is off before
  assuming upstream is quiet. The watermark's `date=` is the timestamp to
  read.
- Actions → **Upstream watch** shows a banner when the schedule has been
  disabled; re-enable it there, then use *Run workflow* with a
  `lookback_days` covering the gap so the missed window is examined rather
  than skipped.
- This repository is low-traffic by design (no PR CI), so 60 quiet days is
  genuinely reachable. Any push to a branch resets the clock.

## OIDC `oidc-http` transport e2e lane (`npm run test:e2e:oidc`)

`scripts/oidc-e2e.ts` is the e2e lane for the opt-in `oidc-http` transport
mode (`docs/OIDC-RESOURCE-SERVER.md`, tracking issue #28 item H2b), sibling
to `test:e2e:mcp` above, but for the multi-user HTTP+OIDC deployment shape
instead of the default `stdio` transport. It:

1. Runs `npm run build`.
2. Starts an in-process, loopback-only **mock OIDC issuer**: a real RSA
   keypair plus a tiny HTTP server serving its JWKS document, reusing the
   exact same signing/JWKS helpers the unit test suites use
   (`tests/auth/oidc/helpers.ts`), per the design's decision D9 ("e2e
   identity provider = mock OIDC issuer as the CI default").
3. Spawns `dist/index.js` as a real child process in `oidc-http` mode
   (`VIKUNJA_MCP_TRANSPORT=http`), pointed at that mock issuer, with a fresh
   temporary credential vault file, and, for real Vikunja credentials,
   pointed at the local e2e stack the same way `docker/e2e/bootstrap.sh`
   does (log in as `e2e-test`, mint a real `tk_*` token via `PUT /tokens`).
4. Drives the spawned server with real HTTP requests exercising the full
   provisioning lifecycle: unauthenticated request (401) → authenticated but
   unprovisioned identity (provision prompt) → `vikunja_auth provision` with
   the stack's real token → real tool calls as the provisioned identity
   (steps (d)–(d3): `vikunja_projects list`, plus `vikunja_tasks list` and
   `vikunja_templates list`, which exercise the session-storage read path) →
   a second identity provisioned and calling tools concurrently (step (d4))
   → `vikunja_auth deprovision`.
5. **By default, also runs the one-click SSO enrollment lane** (issue #220,
   steps `(f0)`–`(f6)`, see [docs/CONFIGURATION.md](CONFIGURATION.md#one-click-sso-enrollment-optional-enroll-section)
   for what enrollment is). Before step 2 above, it reconfigures the e2e
   target's Vikunja container via the `docker-compose.oidc.yml` overlay
   (`VIKUNJA_E2E_OIDC=1` passed to `docker/e2e/bootstrap.sh`) to add one
   OpenID provider pointing at this lane's own mock IdP, then exercises the
   real chain end to end: MCP `/enroll` → mock-IdP authorize → MCP
   `/enroll/callback` → Vikunja's real `POST /auth/openid/{key}/callback`
   (real token exchange, real first-login account auto-creation) → real
   `GET /routes` → real `PUT /tokens` → vault, plus a replayed-callback
   rejection (`f5`, single-use ticket) and a forwarded-link identity-pinning
   check (`f6`, a different validated identity cannot claim another user's
   IdP session). A `finally` block always restores the e2e target to its
   plain (no-OpenID) container afterward, even on failure, so no other
   lane or session is left pointed at a provider whose mock IdP no longer
   exists. Set `MCP_E2E_SKIP_ENROLL=1` to skip this lane and its container
   reconfiguration entirely, running only the classic provisioning steps
   (a)–(e) above, useful when iterating on those steps alone, since the
   enrollment lane's container swap adds real time to every run.

Run it against the local stack:

```bash
VIKUNJA_VERSION=2.4.0 npm run e2e:up   # if not already running
npm run test:e2e:oidc
```

Like `test:e2e:mcp`, it never reads the ambient `VIKUNJA_URL` /
`VIKUNJA_API_TOKEN`, only the harness-specific `MCP_E2E_VIKUNJA_URL` /
`MCP_E2E_VIKUNJA_API_TOKEN` overrides, and only after verifying the target
resolves to localhost.

**Historical note (step "(d) real end-to-end tool call"): found broken by
this lane, since fixed.** When this lane first ran, it failed at the "list
projects as the provisioned identity" step, and that was a genuine finding,
not a harness bug: tool handlers made their real REST calls through the
process-global `AuthManager` captured at `registerTools()` time, never the
ALS-resolved per-identity one, so a provisioned user's calls went out under
the wrong credential. `tests/oidc/isolation.test.ts` hadn't caught it
because it tested `getAuthManagerFromContext()` directly rather than through
a real tool handler. The fix is central (`resolveEffectiveAuthManager` in
`src/utils/vikunja-rest.ts` substitutes the ALS-bound manager at request
time), with a follow-up for the session-storage reads that bypassed ALS the
same way (`vikunja_tasks list`, `vikunja_templates`, attachment downloads).
Both are guarded by the "Credential threading" and "Session-storage reads
that bypass ALS resolution" suites in `tests/oidc/isolation.test.ts`, and
this lane's steps (d)–(d4) exercise them live, including two identities
calling tools concurrently. All steps (a)–(e) pass; see the §3d row #1
amendment in `docs/OIDC-RESOURCE-SERVER.md` for the full history.

## Sample-page screenshot capture (`npm run capture:samples`)

`scripts/capture-sample-screenshots.ts` drives the real Vikunja *web UI*
(not just the API) with [Playwright](https://playwright.dev/) to capture
the screenshots embedded in `docs/samples/*.md`, the worked-example pages
linked from the main README. Unlike `test:mcp` / `test:e2e:mcp`, its output
isn't pass/fail assertions; it's PNGs written to `docs/samples/assets/` and
the corresponding `![...]  (assets/...)` embeds spliced into the sample
pages in place of `` `[SCREENSHOT: ...]` `` placeholder lines.

Playwright itself (the `playwright` npm package and its bundled Chromium)
is a devDependency, used only by this script. Nothing under `src/` depends
on it, and it's not part of the published package (see `files` in
`package.json`).

Run it against the local stack:

**Known gap:** unlike `test:e2e:mcp`, this script has not been migrated to
the target resolver. It still defaults to the pre-#205 port `33456`
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
subcommand; there's no `/admin/users` API on the pinned stack version) to
demonstrate multi-user flows (sharing, assignment notifications).

### Idempotency / re-runnability

All seeded data (projects, labels, teams, and saved filters) is named
with a `sample-` prefix. Every run sweeps for and deletes any leftover
`sample-*` data (and the `sample-alice` CLI user) at startup, and deletes
everything it created in a `finally` block at the end, so the Vikunja UI is
left clean for a human to inspect between runs, the same convention
`test:e2e:mcp` uses for `mcp-e2e-*` data.

### When a described shot can't be honestly captured

A couple of the placeholders in `docs/samples/*.md` describe UI states this
script can't produce faithfully:

- **Mid-drag/mid-transition animations** (e.g. kanban-flow.md's card-move
  step): Playwright can't capture an in-progress CSS transition frame on
  demand. The script performs the real move via the same REST endpoint the
  MCP tool uses, then captures the completed state, with a short note
  appended under the image explaining the substitution.
- **UI elements the pinned Vikunja version doesn't have** (e.g.
  stay-informed.md's "subscribe bell icon in the project header"; this
  version only exposes subscribe state via the project's "..." menu). The
  script captures the nearest honest equivalent and notes the substitution.
- **The admin panel** (all three placeholders in admin-ops.md): still not
  implemented as of the pinned `vikunja/vikunja:2.4.0` (re-verified during
  the 2.4.0 alignment, tracking issue #28 item A1): `GET /admin/overview`
  still 404s under a JWT (confirmed genuinely "not found", not an auth
  rejection; an API-token-authenticated request 401s earlier instead,
  since admin routes are JWT-only, but a JWT-authenticated request reaches
  routing and gets a plain 404), and no `admin` group appears in `GET
  /routes`. The vendored OpenAPI spec still documents `/admin/*` paths
  (unchanged from the previous vendored spec; see "Version pinning and
  refresh" above), so this remains a documented spec/served-API gap, not
  test drift. Rather than fabricate a screenshot of a UI that isn't
  actually running, the script replaces those three placeholders with an
  explanatory note instead of an image. Re-run the script once the pin
  moves to a release that ships the admin panel.

### A note on `POST /notifications/{id}`

While building the "mark one read" capture, sending an empty body (as
`docs/vikunja-openapi.json` documents, "no request body") verifiably did
**not** persist a read state on the pinned server version, even after
repeated calls; sniffing the real frontend's own request showed it sends
`{"read": true}` explicitly, which does persist. The capture script does
the same.

**Update (issue #314, 2026-09-01):** this was indeed reported — re-verified
live against two more 2.4.0 stacks (a 4-day-old postgres instance and a
fresh sqlite instance), reproducing identically on both, so it is general
server behavior rather than one stack's accumulated state. `src/tools/
notifications.ts`'s `ensureNotificationRead` now sends the same explicit
`{ read: true }` body this capture script always used. See
`docs/VIKUNJA_API_ISSUES.md` item #21 for the full writeup.
