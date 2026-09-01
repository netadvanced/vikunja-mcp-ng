# Vikunja MCP Server

Lets an AI assistant work in your Vikunja instance: create and triage tasks, move cards on Kanban boards, manage projects, labels and teams.

[![npm](https://img.shields.io/npm/v/vikunja-mcp-ng.svg)](https://www.npmjs.com/package/vikunja-mcp-ng)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](../LICENSE)
[![node: 22+](https://img.shields.io/badge/node-22%2B-brightgreen.svg)](../package.json)
[![MCP](https://img.shields.io/badge/MCP-server-purple.svg)](https://modelcontextprotocol.io)

> **Why this fork exists.** We rely on this project and noticed the [upstream repo](https://github.com/democratize-technology/vikunja-mcp) had gone quiet, with a growing backlog of open PRs and issues. We took over active maintenance here and worked through most of that backlog ([tracker](https://github.com/netadvanced/vikunja-mcp-ng/issues/19)). Credit to the original authors for the foundation. If they want to pick it back up, we will gladly hand the reins back or work together.

> **Two READMEs, on purpose.** This file is the repository home page. The root [`README.md`](../README.md) is the page npmjs.com renders. npm requires the package README to sit at the tarball root and offers no way to point elsewhere, while GitHub prefers `.github/README.md`, so each audience gets its own page with no publish-time file juggling. See [#207](https://github.com/netadvanced/vikunja-mcp-ng/issues/207).

**Installing it?** The npx, global-install and Docker instructions are on the [npm-facing README](../README.md). This page is for working on the project.

## What it exposes

Vikunja is exposed as 27 tools (~150 subcommands): a session tool, 22 available by default or by auth type, and 4 sensitive ones that stay off until an operator opts in. Each tool covers one entity and takes a `subcommand`.

It is not a 1:1 REST proxy. The operations are composed for the way an assistant actually works: a username resolves to a user ID on its own, writes that Vikunja reports loosely are read back and checked, and destructive subcommands need an explicit confirmation. Partial failures are reported as partial failures.

Every entity is a toggle an operator can switch off, the sensitive tools need an explicit opt-in and mostly a JWT session on top, and a global read-only mode rejects writes while reads keep working. The mechanism and the per-module detail are in [Configuration § Module gating](../docs/CONFIGURATION.md#module-gating) and [§ Known modules](../docs/CONFIGURATION.md#known-modules).

Worked examples, each paired with the exact tool call and the resulting Vikunja UI state, are in [`docs/samples/`](../docs/samples/). The flat parameter reference is [`docs/TOOLS.md`](../docs/TOOLS.md).

## Where the project is

| | Version | Notes |
|---|---|---|
| npm `latest` | 0.6.2 | Single-user `stdio` server |
| npm `beta` | 0.7.0-beta.4 | Adds opt-in OIDC resource-server mode: Streamable HTTP transport, per-user identity, MCP auth discovery, SSO enrollment. `stdio` is unchanged and still the default |

OIDC mode has been exercised against a real gateway, identity provider and Vikunja, but has not seen sustained production use. See the [OIDC setup manual](../docs/OIDC-SETUP.md) and the [resource-server design and threat model](../docs/OIDC-RESOURCE-SERVER.md).

**Vikunja compatibility.** Aligned and tested against 2.4.0, which is also the minimum supported version, so floor and aligned currently coincide. The floor rose from 2.3.0 in the `0.7.0-beta` line because nine operations shipped here as implemented, the eight `vikunja_admin` operations and `vikunja_tasks get-by-index`, do not exist on a released 2.3.0. On 2.3.0, upgrade Vikunja or pin `vikunja-mcp-ng@0.6.2`.

Vikunja 2.5.0 and 2.6.0 have both been released upstream. Neither is supported or tested here and nothing in `src/` targets them; [issue #237](https://github.com/netadvanced/vikunja-mcp-ng/issues/237) carries the alignment analysis and the exposures it found. No timeline is set.

This server speaks the v1 API. v2 adoption is [issue #184](https://github.com/netadvanced/vikunja-mcp-ng/issues/184) on the 0.8.0 milestone, and has not started. Node 22+ only.

## Working on it

```bash
git clone https://github.com/netadvanced/vikunja-mcp-ng.git
cd vikunja-mcp-ng
npm ci
npm run build
```

```bash
npm run lint && npm run typecheck && npm run test:coverage   # the pre-commit gate
```

To point a client at your build, use `"command": "node"` with `"args": ["/path/to/vikunja-mcp-ng/dist/index.js"]` and the same `VIKUNJA_URL` / `VIKUNJA_API_TOKEN` environment as the [npm README](../README.md) shows. Transport selection, module gating and every environment variable are in the [Configuration guide](../docs/CONFIGURATION.md).

### Local Vikunja stacks

Each supported version runs as its own persistent stack on its own port, all at once, so you can test several versions side by side and two people can work in parallel without disturbing each other.

| Target | API port |
|---|---|
| `2.4.0-postgres` | 8240 |
| `2.4.0-sqlite` | 9240 |

Ports are derived from the version (`8000 + MMP` for postgres, `9000 + MMP` for sqlite), so any other version resolves without editing a table. `2.3.0-postgres` still works out to 8230 if you need to look at the old floor; it is simply no longer a supported target.

```bash
npm run e2e:up:all    # bring every target up
npm run e2e:status    # what is running, on which port, which version
npm run e2e:down      # stop containers, keep data (tokens stay valid)
npm run e2e:reset     # destroy volumes, the only thing that rotates a token
```

Credentials are stable for the life of a stack and land in `docker/e2e/.env.<version>-<db>`. Details in [Local testing](../docs/LOCAL-TESTING.md).

### Test lanes

| Command | What it does |
|---|---|
| `npm run test:coverage` | Unit suite behind the coverage gate |
| `npm run test:mcp` | Direct-REST checks against a local stack |
| `npm run test:e2e:mcp` | Full MCP-tool-layer harness. Spawns the built server and drives it over stdio |
| `npm run test:e2e:oidc` | OIDC `http`-mode harness: token validation, vault, per-identity isolation, against a mock issuer |
| `npm run test:matrix` | Both harnesses across a version/DB target, writing a verdict file |
| `npm run battle` | Spawns a real AI agent against the tool surface and grades correctness and ergonomics. Manual, and it costs real money. Read [Battle testing](../docs/BATTLE-TESTING.md) first |

Pick a target with `VIKUNJA_E2E_TARGET=2.4.0-sqlite npm run test:e2e:mcp`.

Mocked unit tests cannot catch a whole class of bug here, and several real defects were found only by the live lanes. Run `test:e2e:mcp` after merges that touch tool behaviour.

Two conventions worth knowing before you open a PR. Coverage figures, tool counts and API-coverage numbers are re-derived from the source rather than carried forward, and the commands used are recorded next to them. Decisions in [ROADMAP.md](../docs/ROADMAP.md) are written with the condition they depend on, so a later reader can tell when one has expired instead of guessing.

## Documentation

- [Architecture](../docs/ARCHITECTURE.md) · [Roadmap and decision log](../docs/ROADMAP.md) · [API coverage](../docs/API-COVERAGE.md)
- [Endpoint playbook](../docs/ENDPOINT-PLAYBOOK.md), the conventions for adding new coverage
- [Local testing](../docs/LOCAL-TESTING.md) · [Battle testing](../docs/BATTLE-TESTING.md)
- [Upstream watch](../docs/LOCAL-TESTING.md#upstream-watch-npm-run-watchupstream), the weekly `go-vikunja/vikunja` `main` watcher, its exit-code contract and the watermark in issue #250
- [Releasing](../docs/RELEASING.md), versioning policy and the release checklist · [CHANGELOG](../CHANGELOG.md)
- [OIDC setup manual](../docs/OIDC-SETUP.md), for the hosted multi-user mode (any OIDC provider, Keycloak as the reference)
- [OIDC resource-server reference](../docs/OIDC-RESOURCE-SERVER.md) · [IBM MCP Context Forge deployment](../docs/CONTEXT-FORGE.md)
- [Docker Desktop MCP Toolkit how-to](../docs/DOCKER-DESKTOP-MCP.md)

## License

MIT. See [LICENSE](../LICENSE).
