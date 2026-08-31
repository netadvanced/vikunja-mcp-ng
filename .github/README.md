# Vikunja MCP Server

**Give your AI assistant real hands on your Vikunja instance** — create and triage tasks, manage projects and Kanban boards, assign teammates, and more, through natural conversation.

[![npm](https://img.shields.io/npm/v/vikunja-mcp-ng.svg)](https://www.npmjs.com/package/vikunja-mcp-ng)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](../LICENSE)
[![node: 22+](https://img.shields.io/badge/node-22%2B-brightgreen.svg)](../package.json)
[![MCP](https://img.shields.io/badge/MCP-server-purple.svg)](https://modelcontextprotocol.io)

> 👋 **Why this fork exists:** we rely on this project and noticed the [upstream repo](https://github.com/democratize-technology/vikunja-mcp) had gone quiet, with a growing backlog of open PRs and issues. So we've taken over active maintenance here — triaging and resolving most of that backlog (tracked in [this issue](https://github.com/netadvanced/vikunja-mcp-ng/issues/19)). Full credit to the original authors for the foundation. If they'd like to pick it back up, we'll gladly hand the reins back — or work together.

> ℹ️ **Two READMEs, on purpose.** This file is the repository home page; the root [`README.md`](../README.md) is the page npmjs.com renders. npm requires the package README to be `README.md` at the tarball root and offers no way to point elsewhere, while GitHub prefers `.github/README.md` — so each audience gets a page aimed at it, with no publish-time file juggling. See [#207](https://github.com/netadvanced/vikunja-mcp-ng/issues/207).

---

## What this gives your AI assistant

This server exposes Vikunja as **27 tools** (~150 subcommands) — a session tool, 22 available by default or by auth type, and 4 sensitive ones that are off until an operator opts in. Each covers one entity with a consistent `subcommand` pattern — not a 1:1 REST proxy, but composite operations built for how an AI actually works: resolve a username instead of demanding a user ID, verify that tricky writes actually stuck instead of trusting a `200`, and explicit confirmation gates on destructive operations. Your assistant reasons in natural language; the server turns that into correct Vikunja API calls and reports partial failures honestly instead of pretending success.

## Where the project is right now

| | Version | Notes |
|---|---|---|
| npm `latest` | **0.6.2** | Stable, single-user `stdio` server |
| npm `beta` | **0.7.0-beta.1** | Adds opt-in **OIDC resource-server mode**: Streamable HTTP transport, per-user identity, MCP auth discovery, one-click SSO enrollment. `stdio` is unchanged and still the default |

OIDC mode shipped in `0.7.0-beta.0`/`0.7.0-beta.1`. It has been field-tested against a real gateway + identity provider + Vikunja, but has not yet seen sustained production use — see the [OIDC setup manual](../docs/OIDC-SETUP.md) and the [resource-server design and threat model](../docs/OIDC-RESOURCE-SERVER.md).

**Vikunja compatibility:** aligned and tested against **2.4.0**, minimum supported **2.3.0** (the v1 API floor). Vikunja **2.5.0 has been released upstream but is not yet supported or tested here** — nothing in `src/` targets it. The v1 API is what this server speaks; **v2 adoption is [issue #184](https://github.com/netadvanced/vikunja-mcp-ng/issues/184), on the 0.8.0 milestone, and has not started.** Node 22+ only.

## See it in action

> **You:** "Move 'Fix login redirect bug' to In Review and show me the board."

```typescript
vikunja_tasks({ subcommand: "set-bucket", id: 342, bucketId: 43 })
```

`projectId`/`viewId` auto-resolve from the task — no need to know which view is the Kanban one. The task card slides from *Backlog* into *In Review* on the Kanban board, instantly visible to anyone else looking at the board.

More end-to-end scenarios — daily triage, team sharing, project planning, staying informed, bulk imports, admin ops — each paired with the exact tool call and the resulting Vikunja UI state, live in [`docs/samples/`](../docs/samples/).

## Quick Start

Install and configuration instructions for consumers (npx, global install, Docker, Docker Desktop MCP Toolkit) live on the [npm-facing README](../README.md). From source:

```bash
git clone https://github.com/netadvanced/vikunja-mcp-ng.git
cd vikunja-mcp-ng
npm ci
npm run build
```

```json
{
  "mcpServers": {
    "vikunja": {
      "command": "node",
      "args": ["/path/to/vikunja-mcp-ng/dist/index.js"],
      "env": {
        "VIKUNJA_URL": "https://your-vikunja-instance.com",
        "VIKUNJA_API_TOKEN": "your-api-token"
      }
    }
  }
}
```

Full install options, JWT vs. API-token auth, module gating, transport selection, and every environment variable live in the [Configuration guide](../docs/CONFIGURATION.md).

## Capabilities

| Group | Tools | Covers |
|---|---|---|
| **Tasks** | `vikunja_tasks`, `vikunja_task_bulk`, `vikunja_task_assignees`, `vikunja_task_comments`, `vikunja_task_labels`, `vikunja_task_relations`, `vikunja_task_reminders` | CRUD, filtering, bulk ops, Kanban placement, subtasks, duplication, mark-read, comments, relations |
| **Projects** | `vikunja_projects` | CRUD, hierarchy, views, Kanban buckets, one-call Kanban board setup (`setup-kanban`), sharing, duplication, opt-in backgrounds |
| **Organize** | `vikunja_labels`, `vikunja_filters`, `vikunja_templates` | Labels, saved filters, reusable task templates |
| **Collaborate** | `vikunja_teams`, `vikunja_users`\*, `vikunja_notifications`, `vikunja_subscriptions`, `vikunja_reactions` | Team membership, user search, avatar settings, notifications, watch/react |
| **Automate & move data** | `vikunja_webhooks`, `vikunja_batch_import`, `vikunja_export_project`\* | Webhooks (per-project and account-wide), CSV/JSON import, project export |

\* JWT authentication only. User data export also has request/status/download tools (`vikunja_request_user_export`, `vikunja_user_export_status`, `vikunja_download_user_export`), all JWT-only. (`vikunja_webhooks`' account-wide `scope: 'user'` is JWT-only too; its default `scope: 'project'` works with either auth type.)

A session tool, `vikunja_auth` (connect / status / info / refresh / disconnect), rounds out the always-on surface. Four more tools — `vikunja_tokens`, `vikunja_caldav_tokens`, `vikunja_admin`, and `vikunja_user_deletion` — are **disabled by default** and need an explicit operator opt-in; `vikunja_projects` has three opt-in cosmetic subcommands (project backgrounds) behind their own toggle. Which module each lives behind, what enabling it exposes, and the extra JWT requirement on the most sensitive ones: [Configuration guide § Known modules](../docs/CONFIGURATION.md#known-modules).

Full subcommand-by-subcommand reference: [`docs/TOOLS.md`](../docs/TOOLS.md).

## Safety by design

Every entity is a toggle you can disable in config, the four sensitive tools ship off until an operator opts in, and a global read-only mode can reject every write/destructive subcommand while reads keep working. Full details: [Configuration guide](../docs/CONFIGURATION.md#module-gating).

## Working on this project

```bash
npm ci
npm run lint && npm run typecheck && npm run test:coverage   # the pre-commit gate
```

### Local Vikunja stacks

Each supported version runs as its own persistent stack, on its own port, all at once — so you can test against several versions simultaneously and two agents can work in parallel without disturbing each other:

| Target | API port |
|---|---|
| `2.4.0-postgres` | 8240 |
| `2.3.0-postgres` | 8230 |
| `2.4.0-sqlite` | 9240 |
| `2.3.0-sqlite` | 9230 |

```bash
npm run e2e:up:all    # bring every target up
npm run e2e:status    # what's running, on which port, which version
npm run e2e:down      # stop containers, KEEP data (tokens stay valid)
npm run e2e:reset     # destroy volumes — the only thing that rotates a token
```

Credentials are stable for the life of a stack and land in `docker/e2e/.env.<version>-<db>`. Full details in [Local testing](../docs/LOCAL-TESTING.md).

### Test lanes

| Command | What it does |
|---|---|
| `npm run test:coverage` | Unit suite behind the coverage gate |
| `npm run test:mcp` | Direct-REST checks against a local stack |
| `npm run test:e2e:mcp` | Full MCP-tool-layer harness — spawns the built server and drives it over stdio |
| `npm run test:e2e:oidc` | OIDC `http`-mode harness — token validation, vault, per-identity isolation, against a mock issuer |
| `npm run test:matrix` | Both harnesses across a version/DB target, writing a verdict file |
| `npm run battle` | Spawns a **real AI agent** against the tool surface and grades correctness + ergonomics. Manual, costs real money — read [Battle testing](../docs/BATTLE-TESTING.md) first |

Select a target with `VIKUNJA_E2E_TARGET=2.3.0-postgres npm run test:e2e:mcp`.

Mocked unit tests cannot catch a whole class of bug here — several real defects were found only by the live lanes. Run `test:e2e:mcp` after merges that touch tool behaviour.

## Documentation

- [Architecture](../docs/ARCHITECTURE.md) · [Roadmap](../docs/ROADMAP.md) · [API coverage](../docs/API-COVERAGE.md)
- [Endpoint playbook](../docs/ENDPOINT-PLAYBOOK.md) — conventions for adding new coverage
- [Local testing](../docs/LOCAL-TESTING.md) · [Battle testing](../docs/BATTLE-TESTING.md)
- [Releasing](../docs/RELEASING.md) — versioning policy and the release checklist · [CHANGELOG](../CHANGELOG.md)
- [Docker Desktop MCP Toolkit how-to](../docs/DOCKER-DESKTOP-MCP.md)
- [OIDC setup manual](../docs/OIDC-SETUP.md) — install and configure the hosted, multi-user OIDC resource-server mode (any OIDC provider; Keycloak as reference)
- [IBM MCP Context Forge deployment guide](../docs/CONTEXT-FORGE.md) — running it behind Context Forge as the MCP gateway · [OIDC resource-server reference](../docs/OIDC-RESOURCE-SERVER.md)

## License

MIT — see [LICENSE](../LICENSE).
