# Vikunja MCP Server

**Give your AI assistant real hands on your Vikunja instance** — create and triage tasks, manage projects and Kanban boards, assign teammates, and more, through natural conversation.

[![npm](https://img.shields.io/npm/v/vikunja-mcp-ng.svg)](https://www.npmjs.com/package/vikunja-mcp-ng)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/netadvanced/vikunja-mcp-ng/blob/main/LICENSE)
[![node: 22+](https://img.shields.io/badge/node-22%2B-brightgreen.svg)](https://github.com/netadvanced/vikunja-mcp-ng/blob/main/package.json)
[![MCP](https://img.shields.io/badge/MCP-server-purple.svg)](https://modelcontextprotocol.io)

This server exposes Vikunja as **27 tools** (~150 subcommands), each covering one entity (tasks, projects, labels, teams…) with a consistent `subcommand` pattern — not a 1:1 REST proxy, but composite operations built for how an AI actually works: resolve a username instead of demanding a user ID, verify that tricky writes actually stuck instead of trusting a `200`, and require explicit confirmation on destructive operations. Your assistant reasons in natural language; the server turns that into correct Vikunja API calls and reports partial failures honestly instead of pretending success.

## Requirements

- **Node.js 22+** (Node 20 reached end-of-life in April 2026)
- A Vikunja instance (see the compatibility matrix below)
- An API token (`tk_…`) or JWT from that instance

### Compatibility

| Vikunja | Status |
|---|---|
| **2.4.0** | Aligned and tested — the version CI and the e2e stacks run against |
| **2.3.0** | Minimum supported; the floor for the v1 API |
| 2.5.0 | Released upstream, **not yet supported or tested here** — no code in this server targets it yet |
| < 2.3.0 | Not supported |

The server talks to Vikunja's **v1 API**. Vikunja's v2 API is tracked as [issue #184](https://github.com/netadvanced/vikunja-mcp-ng/issues/184) and is not started.

## Quick start

No install step needed — point your MCP client at `npx`:

```json
{
  "mcpServers": {
    "vikunja": {
      "command": "npx",
      "args": ["-y", "vikunja-mcp-ng"],
      "env": {
        "VIKUNJA_URL": "https://your-vikunja-instance.com",
        "VIKUNJA_API_TOKEN": "your-api-token"
      }
    }
  }
}
```

Use the bare instance URL for `VIKUNJA_URL` — the server appends the API path itself (`/api/v1`); an explicit `/api/v1` suffix still works too.

Or install globally (`npm install -g vikunja-mcp-ng`) and use `"command": "vikunja-mcp-ng"` with no args.

Everything else — JWT vs. API-token auth, module gating, read-only mode, secrets handling, rate limits, and every environment variable — is in the [Configuration guide](https://github.com/netadvanced/vikunja-mcp-ng/blob/main/docs/CONFIGURATION.md).

### Docker

Multi-architecture images (`linux/amd64` + `linux/arm64`) are published to GHCR on every release, with `X.Y.Z`, `latest`, and `X.Y.Z-vikunja<A.B.C>` compatibility tags:

```bash
docker pull ghcr.io/netadvanced/vikunja-mcp-ng:latest
```

```json
{
  "mcpServers": {
    "vikunja": {
      "command": "docker",
      "args": [
        "run", "-i", "--rm",
        "-e", "VIKUNJA_URL",
        "-e", "VIKUNJA_API_TOKEN",
        "ghcr.io/netadvanced/vikunja-mcp-ng:latest"
      ],
      "env": {
        "VIKUNJA_URL": "https://your-vikunja-instance.com",
        "VIKUNJA_API_TOKEN": "your-api-token"
      }
    }
  }
}
```

Using Docker Desktop's MCP Toolkit rather than a bare `docker run`? There's a tested, step-by-step path in the [Docker Desktop guide](https://github.com/netadvanced/vikunja-mcp-ng/blob/main/docs/DOCKER-DESKTOP-MCP.md).

## Two release lines

| npm tag | Version | What you get |
|---|---|---|
| `latest` | **0.6.2** | The stable, single-user **stdio** server — what the quick start above installs |
| `beta` | **0.7.0-beta.1** | Everything in stable, plus opt-in **OIDC resource-server mode** |

**OIDC resource-server mode** turns the server into a hosted, multi-user deployment: a Streamable HTTP transport, per-user identity from a validated OIDC access token, MCP authorization discovery, and one-click SSO enrollment so each user links their own Vikunja token once. It is opt-in and off by default — installing the beta changes nothing until you enable it, and the `stdio` transport behaves exactly as it does on stable.

```bash
npm install -g vikunja-mcp-ng@beta      # or: npx -y vikunja-mcp-ng@beta
```

It is **beta**: the authentication boundary, the credential vault, and per-identity isolation have been exercised against a real gateway, identity provider, and Vikunja, but it has not yet seen sustained production use. Pilot it, and read the [OIDC setup manual](https://github.com/netadvanced/vikunja-mcp-ng/blob/main/docs/OIDC-SETUP.md) (design and threat model: [OIDC resource-server reference](https://github.com/netadvanced/vikunja-mcp-ng/blob/main/docs/OIDC-RESOURCE-SERVER.md)) before enabling it.

## What it looks like in use

> **You:** "Move 'Fix login redirect bug' to In Review and show me the board."

```typescript
vikunja_tasks({ subcommand: "set-bucket", id: 342, bucketId: 43 })
```

`projectId`/`viewId` resolve from the task itself — no need to know which view is the Kanban one. The card slides from *Backlog* into *In Review*, instantly visible to anyone else watching the board.

Setting up a whole board is one call too:

```typescript
vikunja_projects({
  subcommand: "setup-kanban",
  title: "Q3 Offsite",
  columns: ["To Do", "Doing", "Done"],
  tasks: [{ title: "Book venue", column: "To Do", priority: 4 }]
})
```

Omit `columns` entirely and it becomes a plain "create a project with its tasks" call, touching no Kanban structure at all.

## Capabilities

| Group | Tools | Covers |
|---|---|---|
| **Tasks** | `vikunja_tasks`, `vikunja_task_bulk`, `vikunja_task_assignees`, `vikunja_task_comments`, `vikunja_task_labels`, `vikunja_task_relations`, `vikunja_task_reminders` | CRUD, filtering, bulk ops, Kanban placement, subtasks, duplication, comments, relations, reminders |
| **Projects** | `vikunja_projects` | CRUD, hierarchy, views, Kanban buckets, one-call board setup (`setup-kanban`), sharing, duplication |
| **Organize** | `vikunja_labels`, `vikunja_filters`, `vikunja_templates` | Labels (including attach-by-title), saved filters, reusable task templates |
| **Collaborate** | `vikunja_teams`, `vikunja_users`\*, `vikunja_notifications`, `vikunja_subscriptions`, `vikunja_reactions` | Team membership, user search, avatar settings, notifications, watch/react |
| **Automate & move data** | `vikunja_webhooks`, `vikunja_batch_import`, `vikunja_export_project`\* | Webhooks, CSV/JSON import, project export |

\* JWT authentication only, along with the three user-data-export tools.

A session tool, `vikunja_auth` (connect / status / info / refresh / disconnect), rounds out the always-on surface. Four further tools — `vikunja_tokens`, `vikunja_caldav_tokens`, `vikunja_admin`, `vikunja_user_deletion` — are **disabled by default** and require an operator to opt in explicitly.

Full subcommand-by-subcommand reference: [`docs/TOOLS.md`](https://github.com/netadvanced/vikunja-mcp-ng/blob/main/docs/TOOLS.md).

## Safety by design

Every entity group is a toggle you can disable in config. The four sensitive tools ship off until an operator opts in — `vikunja_admin`, `vikunja_caldav_tokens`, and `vikunja_user_deletion` additionally require an active JWT session. A global **read-only mode** rejects every write and destructive subcommand while reads keep working.

Writes are careful about the ambiguous cases too: a create that fails without a clear answer is not retried, so a flaky network cannot leave you with two copies of the same task.

Details, plus auth, secrets handling, and rate limits: [Configuration guide](https://github.com/netadvanced/vikunja-mcp-ng/blob/main/docs/CONFIGURATION.md).

## Links

- [Sample walkthroughs](https://github.com/netadvanced/vikunja-mcp-ng/tree/main/docs/samples) — real conversations paired with the tool calls and UI results behind them
- [Full tool reference](https://github.com/netadvanced/vikunja-mcp-ng/blob/main/docs/TOOLS.md)
- [Configuration guide](https://github.com/netadvanced/vikunja-mcp-ng/blob/main/docs/CONFIGURATION.md)
- [OIDC setup manual](https://github.com/netadvanced/vikunja-mcp-ng/blob/main/docs/OIDC-SETUP.md) — the hosted, multi-user mode on the `beta` tag
- [Changelog](https://github.com/netadvanced/vikunja-mcp-ng/blob/main/CHANGELOG.md)
- [Source, issues, and contributing](https://github.com/netadvanced/vikunja-mcp-ng)

## License

MIT — see [LICENSE](https://github.com/netadvanced/vikunja-mcp-ng/blob/main/LICENSE).
