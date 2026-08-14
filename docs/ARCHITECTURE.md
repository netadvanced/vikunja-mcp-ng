# Architecture

How `vikunja-mcp-ng` is put together: a stdio MCP server that registers one
tool per Vikunja domain and issues every API call itself over plain REST
against a vendored OpenAPI spec. This page is the map of the moving parts; for
the tool surface itself see [TOOLS.md](TOOLS.md), for the conventions new
endpoint work follows see [ENDPOINT-PLAYBOOK.md](ENDPOINT-PLAYBOOK.md), and for
every configuration knob see [CONFIGURATION.md](CONFIGURATION.md).

## At a Glance

- **MCP Server**: Built with `@modelcontextprotocol/sdk` (entry point `src/index.ts`)
- **Transport**: StdIO for Claude Desktop integration (`StdioServerTransport`)
- **Tool Registry**: `src/tools/index.ts` — conditional registration gated by module config and auth type
- **Tools**: Zod-validated parameters with subcommand pattern, one module per entity in `src/tools/[entity]/`
- **Authentication**: Session-based with AuthManager (`src/auth/AuthManager.ts`)
- **HTTP**: All Vikunja calls go through `vikunjaRestRequest` (`src/utils/vikunja-rest.ts`) against the vendored OpenAPI spec (`docs/vikunja-openapi.json`)
- **Error Handling**: Custom MCPError with proper error codes
- **Type Safety**: Full TypeScript with strict mode

## Component Overview

### AuthManager
Handles session management and authentication state (`src/auth/AuthManager.ts`):
- Supports both API tokens (`tk_*`) and JWT authentication, auto-detected from the token format
- Maintains single instance throughout server lifetime
- Holds one in-memory session (`connect`/`disconnect`); nothing is persisted across restarts
- **No** automatic token refresh: this server authenticates with a static Bearer token
  and holds no refresh-token cookie, so an expired JWT must be replaced by reconnecting
  (`vikunja_auth refresh` reports this rather than attempting a refresh)

### Client Management
The legacy typed API-client library was retired (see [ROADMAP.md §3](ROADMAP.md) decision 2);
`VikunjaClientFactory` (`src/client/VikunjaClientFactory.ts`) now only owns the session's
`AuthManager` and hands it to the direct-REST transport:
- A thread-safe `ClientContext` singleton (`src/client.ts`, mutex-guarded) holds the active factory
- The `clientFactory` parameter on `register*Tool(server, authManager, clientFactory?)` is kept for
  call-site compatibility; `cleanup()` is a no-op since there is no cached client to release
- `vikunja_auth disconnect` clears both the session and the global factory

### Tool Pattern
Each tool is one Vikunja domain, registered once in `src/tools/index.ts`:
- A single `subcommand` Zod enum (`action` on the older `vikunja_filters`) routes to a handler
- Zod validation for all parameters, so bad arguments fail at the protocol boundary
- Every response is markdown text built by `src/utils/simple-response.ts` — see
  [TOOLS.md](TOOLS.md)'s Response Format section
- Registration is gated by module config and, for the credential-adjacent and
  irreversible tools, by auth type as well (see
  [CONFIGURATION.md#module-gating](CONFIGURATION.md#module-gating))

### Safety Layers
- **Read-only mode** (`src/utils/read-only.ts`): `TOOL_CLASSIFICATIONS` marks every
  subcommand read / write / destructive. `assertWriteAllowed` rejects writes when the
  global read-only mode is on, `getToolAnnotations` publishes the same facts as MCP tool
  annotations, and `withReadOnlyNote` states it in the tool description
- **Rate limiting** (`src/middleware/simplified-rate-limit.ts`, applied via
  `applyRateLimiting` in `src/middleware/direct-middleware.ts`): per-tool-category limits;
  currently wired on `vikunja_auth`
- **Credential masking** (`src/utils/security.ts`): tokens and URLs are masked in logs and
  error messages

### Storage
- `src/storage/SimpleFilterStorage.ts` — session-isolated, mutex-guarded in-memory filter storage
- `src/storage/templateFileStore.ts` — opt-in file persistence for templates (see
  [CONFIGURATION.md#templates-persistence](CONFIGURATION.md#templates-persistence)); templates are otherwise session-only

### Error Hierarchy
- `MCPError` - Base error class with proper error codes
- Tool-specific error handling with helpful messages
- API error translation to user-friendly messages

### Retry Logic
`src/utils/retry.ts` — opossum circuit breakers (registered per endpoint group by
`vikunjaRestRequest`) plus exponential backoff for transient failures (`RETRY_CONFIG`):
- `AUTH_ERRORS`: 3 retries, 1s initial delay, 2x backoff, capped at 10s
- `NETWORK_ERRORS`: 5 retries, 500ms initial delay, 1.5x backoff, capped at 30s
- `TASK_OPERATIONS`: 3 retries, 1s initial delay, 2x backoff, capped at 15s
- `BULK_OPERATIONS`: 2 retries, 2s initial delay, 1.5x backoff, capped at 20s
- Each preset names its own circuit breaker, so one tripping does not take the others down
- Non-retryable errors (validation, not found) fail immediately
- The retry count is logged at debug level; bulk assignee operations also surface it in
  their partial-failure message