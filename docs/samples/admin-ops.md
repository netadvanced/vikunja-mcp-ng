# Sample: Admin & ops

Scenario from the [samples index](README.md): instance-administrator visibility and control — but only once an operator has deliberately opted in, since this is the one tool family that touches every user and project on the instance, not just the connected account's own data.

**Setup for this walkthrough:** the connected session is a **JWT** session (`vikunja_admin` is JWT-only — an API-token session never sees this tool, regardless of config) belonging to an instance admin, and the operator has set `"admin": true` in `vikunja-mcp.config.json` (it ships **off** by default).

---

### 0. This tool doesn't exist until you turn it on

Before the config change, asking the assistant "how many users does this instance have?" gets a "no tool available for that" response — `vikunja_admin` is simply never registered with the MCP client, not merely rejected at call time. Turning it on:

```json
{
  "modules": {
    "admin": true
  }
}
```

in `vikunja-mcp.config.json` (or `VIKUNJA_MCP_MODULE_ADMIN=true` as an env var — env always wins over the file). See [CONFIGURATION.md#module-gating](../CONFIGURATION.md#module-gating). Restarting the server after this change is required — module gating is resolved once at tool-registration time.

---

### 1. Instance overview

**User says:**
> "How many users and projects does this instance actually have?"

**Tool call:**
```typescript
vikunja_admin({ subcommand: "overview" })
```
`GET /admin/overview` — instance-wide counts (users, projects, tasks, teams, shares) plus license info, in one call.

**Resulting Vikunja UI state:**
No change — this is a read. The numbers match Vikunja's own admin panel (Settings → Admin Panel → Overview, if the instance's frontend exposes one) exactly, since both read the same endpoint.

_Screenshot unavailable: this capture has not been re-run since the e2e stack was pinned to `vikunja/vikunja:2.3.0`, a version that did not implement the admin panel API or UI at all -- `GET /admin/overview` 404d and no `admin` group appeared in `GET /routes`. The pin has since moved to `2.4.0`, which is now also the minimum supported Vikunja (see [docs/LOCAL-TESTING.md](../LOCAL-TESTING.md#version-pinning-and-refresh)) and which does ship these operations. Re-run `scripts/capture-sample-screenshots.ts` against the current stack to fill this in._


---

### 2. List every user on the instance

**User says:**
> "List every user, including ones I don't manage projects with."

**Tool call:**
```typescript
vikunja_admin({ subcommand: "list-users" })
```
`GET /admin/users` — unlike `vikunja_users.search`, this surfaces admin-only fields (`is_admin`, `status`) and every account on the instance, not just ones discoverable via the normal user-search endpoint.

**Resulting Vikunja UI state:**
No change — this is a read, matching the admin panel's user list including accounts that have never shared a project with the connected account.

_Screenshot unavailable: this capture has not been re-run since the e2e stack was pinned to `vikunja/vikunja:2.3.0`, a version that did not implement the admin panel API or UI at all -- `GET /admin/overview` 404d and no `admin` group appeared in `GET /routes`. The pin has since moved to `2.4.0`, which is now also the minimum supported Vikunja (see [docs/LOCAL-TESTING.md](../LOCAL-TESTING.md#version-pinning-and-refresh)) and which does ship these operations. Re-run `scripts/capture-sample-screenshots.ts` against the current stack to fill this in._


---

### 3. A destructive operation that requires saying so explicitly

**User says:**
> "Delete the test account we no longer need — user id 42."

**Tool call:**
```typescript
vikunja_admin({ subcommand: "delete-user", userId: 42, confirm: true })
```
Deliberately **not** a one-shot "delete-user" call without friction: the tool throws instead of proceeding if `confirm: true` is omitted, precisely so an AI assistant can't be talked into an irreversible instance-wide deletion by an ambiguous prompt. `mode: "now"` (shown here implicitly as the omission of `mode: "scheduled"`) is immediate and irreversible; the default `mode: "scheduled"` instead triggers Vikunja's own email-confirmation self-deletion flow.

**Resulting Vikunja UI state:**
The user disappears from the admin panel's user list; any projects they solely owned become orphaned or inaccessible per Vikunja's own deletion semantics (not something this tool can compensate for — no undelete exists).

_Screenshot unavailable: this capture has not been re-run since the e2e stack was pinned to `vikunja/vikunja:2.3.0`, a version that did not implement the admin panel API or UI at all -- `GET /admin/overview` 404d and no `admin` group appeared in `GET /routes`. The pin has since moved to `2.4.0`, which is now also the minimum supported Vikunja (see [docs/LOCAL-TESTING.md](../LOCAL-TESTING.md#version-pinning-and-refresh)) and which does ship these operations. Re-run `scripts/capture-sample-screenshots.ts` against the current stack to fill this in._


---

## Secrets in production: Docker Swarm `_FILE` mounts

None of the above changes how credentials are supplied — the config file
above (`vikunja-mcp.config.json`) is safe to commit and mount read-only,
because it contains no secrets. The actual JWT/token lives in an env var,
with a Swarm-secret-friendly file variant:

```yaml
services:
  vikunja-mcp:
    image: ghcr.io/netadvanced/vikunja-mcp-ng:latest
    environment:
      VIKUNJA_URL: "https://vikunja.example.com/api/v1"
      VIKUNJA_API_TOKEN_FILE: /run/secrets/vikunja_api_token
      VIKUNJA_MCP_CONFIG: /etc/vikunja-mcp/vikunja-mcp.config.json
    configs:
      - source: vikunja_mcp_config
        target: /etc/vikunja-mcp/vikunja-mcp.config.json
    secrets:
      - source: vikunja_api_token
        target: vikunja_api_token
```

Setting both `VIKUNJA_API_TOKEN` and `VIKUNJA_API_TOKEN_FILE` is a hard
startup error, never a silent precedence choice — see
[CONFIGURATION.md#secrets-management](../CONFIGURATION.md#secrets-management)
for the full Swarm example.

## Try it on the local stack

See [docs/LOCAL-TESTING.md](../LOCAL-TESTING.md) to bring up
`docker/e2e/docker-compose.yml`. The bootstrap script provisions an API
token by default; to exercise `vikunja_admin` you'll additionally need a JWT
for an admin account (log in via the Vikunja UI at `http://localhost:33456`
and use the JWT from the browser's session storage) and `"admin": true` in
your local `vikunja-mcp.config.json`.
