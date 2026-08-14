# Vikunja MCP Server

**Give your AI assistant real hands on your Vikunja instance** — create and triage tasks, manage projects and Kanban boards, assign teammates, and more, through natural conversation.

[![npm](https://img.shields.io/npm/v/vikunja-mcp-ng.svg)](https://www.npmjs.com/package/vikunja-mcp-ng)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/netadvanced/vikunja-mcp-ng/blob/main/LICENSE)
[![node: 22+](https://img.shields.io/badge/node-22%2B-brightgreen.svg)](https://github.com/netadvanced/vikunja-mcp-ng/blob/main/package.json)
[![MCP](https://img.shields.io/badge/MCP-server-purple.svg)](https://modelcontextprotocol.io)

This server exposes Vikunja as **27 tools**, each covering one entity (tasks, projects, labels, teams…) with a consistent `subcommand` pattern — not a 1:1 REST proxy, but composite operations built for how an AI actually works: resolve a username instead of demanding a user ID, verify that tricky writes actually stuck instead of trusting a `200`, and require explicit confirmation on destructive operations. Your assistant reasons in natural language; the server turns that into correct Vikunja API calls and reports partial failures honestly instead of pretending success.

## Requirements

- **Node.js 22+** (Node 20 reached end-of-life in April 2026)
- A Vikunja instance, **2.3.0 or newer** — tested against 2.4.0, with 2.3.0 as the supported floor
- An API token (`tk_…`) or JWT from that instance

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

Use the bare instance URL for `VIKUNJA_URL` — the server resolves the right API path itself (today that's always `/api/v1`; an explicit `/api/v1` suffix still works too). The bare form is also the future-proof choice: it's the same URL the server will use to pick between v1 and v2 automatically once v2 support lands.

Or install globally (`npm install -g vikunja-mcp-ng`) and use `"command": "vikunja-mcp-ng"` with no args.

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

Details, plus auth, secrets handling, and rate limits: [Configuration guide](https://github.com/netadvanced/vikunja-mcp-ng/blob/main/docs/CONFIGURATION.md).

## Links

- [Sample walkthroughs](https://github.com/netadvanced/vikunja-mcp-ng/tree/main/docs/samples) — real conversations paired with the tool calls and UI results behind them
- [Full tool reference](https://github.com/netadvanced/vikunja-mcp-ng/blob/main/docs/TOOLS.md)
- [Configuration guide](https://github.com/netadvanced/vikunja-mcp-ng/blob/main/docs/CONFIGURATION.md)
- [Changelog](https://github.com/netadvanced/vikunja-mcp-ng/blob/main/CHANGELOG.md)
- [Source, issues, and contributing](https://github.com/netadvanced/vikunja-mcp-ng)

## License

MIT — see [LICENSE](https://github.com/netadvanced/vikunja-mcp-ng/blob/main/LICENSE).
