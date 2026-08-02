# Architecture

The Vikunja MCP project follows MCP SDK best practices:

- **MCP Server**: Built with `@modelcontextprotocol/sdk`
- **Transport**: StdIO for Claude Desktop integration
- **Tools**: Zod-validated parameters with subcommand pattern
- **Authentication**: Session-based with AuthManager
- **Error Handling**: Custom MCPError with proper error codes
- **Type Safety**: Full TypeScript with strict mode

## Component Overview

### AuthManager
Handles session management and authentication state:
- Supports both API tokens and JWT authentication
- Maintains single instance throughout server lifetime
- Automatic token refresh for JWT sessions

### Tool Pattern
Each tool follows a consistent subcommand pattern:
- Main command with subcommands for related operations
- Zod validation for all parameters
- Standardized response formats
- Comprehensive error handling

### Client Management
Uses singleton pattern for Vikunja client:
- Single client instance per session
- Automatic cleanup on disconnect
- Thread-safe authentication state

### Error Hierarchy
- `MCPError` - Base error class with proper error codes
- Tool-specific error handling with helpful messages
- API error translation to user-friendly messages

### Retry Logic
Implements exponential backoff for transient failures:
- Authentication errors: 3 retries with 1s initial delay, doubling each time
- Network errors: 5 retries with 500ms initial delay, 1.5x backoff factor
- Maximum delay capped at 10s for auth errors, 30s for network errors
- Non-retryable errors (validation, not found) fail immediately

### API Version Handling (v1 / v2)

Vikunja exposes two API versions, and this server treats version as a **per-operation property**
rather than a global mode. Mixed-version operation is permanent by design: several functions have
no v2 equivalent at all, so a single global switch could never be correct.

- **v1 transport** (`src/utils/vikunja-rest.ts`) — the permanent backward-compatible floor.
  Minimum supported Vikunja is **2.3.0**, which has no v2 API whatsoever.
- **v2 transport** (`src/utils/vikunja-rest-v2.ts`) — a deliberate sibling, not a branch inside the
  v1 helper, so new logic never executes on the path that must not regress. Shares the retry loop
  and breaker registry from `retry.ts`, but under a distinct `vikunja-rest-v2-` breaker namespace:
  breakers are process-wide and keyed by name, so a shared name would let one API surface's
  failures trip the other's.
- **Routing** (`src/utils/api-version.ts`) — `resolveApiVersion` is the single decision point.
  Synchronous and network-free; it consults the session's cached capability probe and returns `v2`
  only on positive evidence, defaulting to `v1` everywhere else. The `featureFlags.forceV1Api` kill
  switch overrides it entirely.
- **Error convergence** — v2 returns `application/problem+json`; the adapter maps it onto the same
  `MCPError` shape v1 produces, preserving Vikunja's numeric `code` and per-field `errors[]`. Every
  catch block in the codebase is therefore version-blind.

The same convergence principle extends to response bodies as v2 adoption proceeds: v2's pagination
envelope is unwrapped and `$schema` stripped **before a result leaves the transport/strategy
layer**, so formatters, tools, and tests never learn which version ran. See
[API-VERSION-MATRIX.md](API-VERSION-MATRIX.md) for per-function coverage.
- Error messages include retry count for transparency