# Vikunja MCP Server

Lets an AI assistant work in your Vikunja instance: create and triage tasks, move cards on Kanban boards, manage projects, labels and teams.

[![npm](https://img.shields.io/npm/v/vikunja-mcp-ng.svg)](https://www.npmjs.com/package/vikunja-mcp-ng)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/netadvanced/vikunja-mcp-ng/blob/main/LICENSE)
[![node: 22+](https://img.shields.io/badge/node-22%2B-brightgreen.svg)](https://github.com/netadvanced/vikunja-mcp-ng/blob/main/package.json)
[![MCP](https://img.shields.io/badge/MCP-server-purple.svg)](https://modelcontextprotocol.io)

Vikunja is exposed as 27 tools (~150 subcommands), one per entity, each taking a `subcommand`. It is not a 1:1 REST proxy. The operations are composed for the way an assistant actually works: a username resolves to a user ID on its own, writes that Vikunja reports loosely are read back and checked, and destructive subcommands need an explicit confirmation. Partial failures are reported as partial failures.

## Quick start

Point your MCP client at `npx`. Nothing to install first.

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

`VIKUNJA_URL` takes the bare instance URL; the server appends `/api/v1` itself. An explicit `/api/v1` suffix also works. The token is an API token (`tk_…`) or a JWT from that instance.

You can also install it globally with `npm install -g vikunja-mcp-ng` and set `"command": "vikunja-mcp-ng"` with no args.

JWT versus API-token auth, module gating, read-only mode, secrets handling, rate limits and every environment variable are covered in the [Configuration guide](https://github.com/netadvanced/vikunja-mcp-ng/blob/main/docs/CONFIGURATION.md).

## Requirements

Node.js 22 or newer. Node 20 reached end of life in April 2026.

| Vikunja | Status |
|---|---|
| 2.4.0 | Supported. This is both the minimum and the version the e2e stacks and live test lanes run against |
| 2.5.0, 2.6.0 | Released upstream, not supported and not tested here. No code in this server targets them |
| below 2.4.0 | Not supported |

The minimum rose from 2.3.0 to 2.4.0 in the `0.7.0-beta` line. Nine operations this server ships as implemented, the eight `vikunja_admin` operations and `vikunja_tasks get-by-index`, do not exist on a released 2.3.0, so the older claim was not true in practice. On Vikunja 2.3.0, either upgrade Vikunja or pin `vikunja-mcp-ng@0.6.2`.

The server speaks Vikunja's v1 API. v2 adoption is tracked in [issue #184](https://github.com/netadvanced/vikunja-mcp-ng/issues/184) and has not started.

## Docker

Multi-architecture images (`linux/amd64` and `linux/arm64`) go to GHCR on every release, tagged `X.Y.Z`, the npm dist-tag it was published under, and `X.Y.Z-vikunja<A.B.C>` for the Vikunja version it is aligned with.

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

For Docker Desktop's MCP Toolkit rather than a bare `docker run`, there is a step-by-step path in the [Docker Desktop guide](https://github.com/netadvanced/vikunja-mcp-ng/blob/main/docs/DOCKER-DESKTOP-MCP.md).

## Release lines

| npm tag | Version | What you get |
|---|---|---|
| `latest` | 0.6.2 | The single-user stdio server, which is what the quick start above installs |
| `beta` | 0.7.0-beta.4 | The same, plus an opt-in OIDC resource-server mode |

OIDC resource-server mode makes the server a hosted, multi-user deployment: a Streamable HTTP transport, per-user identity taken from a validated OIDC access token, MCP authorization discovery, and an enrollment flow where each user links their own Vikunja token once. It is off by default. Installing the beta changes nothing until you turn it on, and the stdio transport behaves as it does on stable.

```bash
npm install -g vikunja-mcp-ng@beta      # or: npx -y vikunja-mcp-ng@beta
```

It is beta. The authentication boundary, the credential vault and per-identity isolation have been exercised against a real gateway, identity provider and Vikunja, but none of it has seen sustained production use yet. Read the [OIDC setup manual](https://github.com/netadvanced/vikunja-mcp-ng/blob/main/docs/OIDC-SETUP.md) before enabling it; the design and threat model are in the [OIDC resource-server reference](https://github.com/netadvanced/vikunja-mcp-ng/blob/main/docs/OIDC-RESOURCE-SERVER.md).

## What it looks like in use

> You: "Move 'Fix login redirect bug' to In Review and show me the board."

```typescript
vikunja_tasks({ subcommand: "set-bucket", id: 342, bucketId: 43 })
```

`projectId` and `viewId` resolve from the task itself, so nobody needs to know which view is the Kanban one. The card moves from *Backlog* to *In Review*, visible to anyone else watching the board.

Setting up a board is one call as well:

```typescript
vikunja_projects({
  subcommand: "setup-kanban",
  title: "Q3 Offsite",
  columns: ["To Do", "Doing", "Done"],
  tasks: [{ title: "Book venue", column: "To Do", priority: 4 }]
})
```

Leave `columns` out and it becomes a plain "create a project with its tasks" call that touches no Kanban structure.

## Tools

| Group | Tools | Covers |
|---|---|---|
| Tasks | `vikunja_tasks`, `vikunja_task_bulk`, `vikunja_task_assignees`, `vikunja_task_comments`, `vikunja_task_labels`, `vikunja_task_relations`, `vikunja_task_reminders` | CRUD, filtering, bulk ops, Kanban placement, subtasks, duplication, comments, relations, reminders |
| Projects | `vikunja_projects` | CRUD, hierarchy, views, Kanban buckets, one-call board setup (`setup-kanban`), sharing, duplication |
| Organize | `vikunja_labels`, `vikunja_filters`, `vikunja_templates` | Labels including attach-by-title, saved filters, reusable task templates |
| Collaborate | `vikunja_teams`, `vikunja_users`\*, `vikunja_notifications`, `vikunja_subscriptions`, `vikunja_reactions` | Team membership, user search, avatar settings, notifications, watch and react |
| Automate and move data | `vikunja_webhooks`, `vikunja_batch_import`, `vikunja_export_project`\* | Webhooks, CSV/JSON import, project export |

\* JWT authentication only, as are the three user-data-export tools.

A session tool, `vikunja_auth` (connect, status, info, refresh, disconnect), completes the always-on surface. Four others, `vikunja_tokens`, `vikunja_caldav_tokens`, `vikunja_admin` and `vikunja_user_deletion`, are disabled until an operator opts in.

Subcommand-by-subcommand reference: [`docs/TOOLS.md`](https://github.com/netadvanced/vikunja-mcp-ng/blob/main/docs/TOOLS.md).

## Safety

Every entity group is a toggle you can switch off in config. The four sensitive tools ship disabled, and `vikunja_admin`, `vikunja_caldav_tokens` and `vikunja_user_deletion` additionally require an active JWT session. Read-only mode rejects every write and destructive subcommand while reads keep working.

Ambiguous writes are handled conservatively. A create that fails without a clear answer is not retried, so a flaky network will not leave you with two copies of a task.

Details, along with auth, secrets handling and rate limits, are in the [Configuration guide](https://github.com/netadvanced/vikunja-mcp-ng/blob/main/docs/CONFIGURATION.md).

## Links

- [Sample walkthroughs](https://github.com/netadvanced/vikunja-mcp-ng/tree/main/docs/samples), real conversations paired with the tool calls and the resulting UI state
- [Tool reference](https://github.com/netadvanced/vikunja-mcp-ng/blob/main/docs/TOOLS.md)
- [Configuration guide](https://github.com/netadvanced/vikunja-mcp-ng/blob/main/docs/CONFIGURATION.md)
- [OIDC setup manual](https://github.com/netadvanced/vikunja-mcp-ng/blob/main/docs/OIDC-SETUP.md)
- [Changelog](https://github.com/netadvanced/vikunja-mcp-ng/blob/main/CHANGELOG.md)
- [Source, issues and contributing](https://github.com/netadvanced/vikunja-mcp-ng)

## License

MIT. See [LICENSE](https://github.com/netadvanced/vikunja-mcp-ng/blob/main/LICENSE).
