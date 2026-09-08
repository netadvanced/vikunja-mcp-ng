# Architecture

How `vikunja-mcp-ng` is put together: a stdio MCP server that registers one
tool per Vikunja domain and issues every API call itself over plain REST
against a vendored OpenAPI spec. This page is the map of the moving parts; for
the tool surface itself see [TOOLS.md](TOOLS.md), for the conventions new
endpoint work follows see [ENDPOINT-PLAYBOOK.md](ENDPOINT-PLAYBOOK.md), and for
every configuration knob see [CONFIGURATION.md](CONFIGURATION.md).

**This page predates the OIDC resource-server epic and describes `stdio` mode only** —
still accurate for that mode (the default, one-process-one-identity deployment), but it
does not cover the opt-in `oidc-http` transport: a stateless multi-tenant mode with
per-request JWT validation, an `AsyncLocalStorage`-scoped identity per call, and an
encrypted credential vault (`src/storage/vaultFileStore.ts`) instead of one process-wide
`AuthManager` session. See [OIDC-RESOURCE-SERVER.md](OIDC-RESOURCE-SERVER.md) for that
mode's architecture and [OIDC-SETUP.md](OIDC-SETUP.md) for the operator/user setup story.

## At a Glance

- **MCP Server**: Built with `@modelcontextprotocol/sdk` (entry point `src/index.ts`)
- **Transport**: StdIO for Claude Desktop integration (`StdioServerTransport`), or an opt-in Streamable-HTTP/OIDC resource-server mode (`VIKUNJA_MCP_TRANSPORT=http`) — see the note above
- **Tool Registry**: `src/tools/index.ts`, with conditional registration gated by module config and auth type
- **Tools**: Zod-validated parameters with subcommand pattern, one module per entity in `src/tools/[entity]/`
- **Authentication**: Session-based with AuthManager (`src/auth/AuthManager.ts`) in `stdio` mode; per-request identity resolved from a JWT + the credential vault in `oidc-http` mode
- **HTTP**: All Vikunja calls go through `vikunjaRestRequest` (`src/utils/vikunja-rest.ts`) against the vendored OpenAPI spec (`docs/vikunja-openapi.json`)
- **Error Handling**: Custom MCPError with proper error codes
- **Type Safety**: Full TypeScript with strict mode

## Component Overview

### AuthManager
Handles session management and authentication state (`src/auth/AuthManager.ts`) —
**this section describes `stdio` mode**; `oidc-http` mode resolves a per-request
`AuthManager` from the credential vault instead (see the note under the page title):
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
- Every response is markdown text built by `src/utils/simple-response.ts`; see
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
  error messages. Redaction is centrally wired into `Logger.log`
  (`src/utils/logger.ts`), so every call site is covered without remembering
  to sanitize its own arguments. It works as a structural key-name pass
  (`sanitizeLogArgs`) plus a textual backstop over the rendered line
  (`redactSecretsInText`) for credentials interpolated into a message
  literal, both applied only after the log-level gate so a suppressed level
  costs nothing. See [SECURITY_IMPLEMENTATION.md](SECURITY_IMPLEMENTATION.md)
  for the full redaction-coverage writeup (what key-name matching alone
  cannot see: URL paths, URL userinfo, sensitive query values).

### Storage
- `src/storage/SimpleFilterStorage.ts`: session-isolated, mutex-guarded in-memory filter storage
- `src/storage/templateFileStore.ts`: opt-in file persistence for templates (see
  [CONFIGURATION.md#templates-persistence](CONFIGURATION.md#templates-persistence)); templates are otherwise session-only

### Error Hierarchy
- `MCPError` - Base error class with proper error codes
- Tool-specific error handling with helpful messages
- API error translation to user-friendly messages

### Retry Logic
`src/utils/retry.ts`: opossum circuit breakers (registered per endpoint group by
`vikunjaRestRequest`) plus exponential backoff for transient failures (`RETRY_CONFIG`):
- `AUTH_ERRORS`: 3 retries, 1s initial delay, 2x backoff, capped at 10s
- `NETWORK_ERRORS`: 5 retries, 500ms initial delay, 1.5x backoff, capped at 30s
- `TASK_OPERATIONS`: 3 retries, 1s initial delay, 2x backoff, capped at 15s
- `BULK_OPERATIONS`: 2 retries, 2s initial delay, 1.5x backoff, capped at 20s
- Each preset names its own circuit breaker, so one tripping does not take the others down
- Non-retryable errors (validation, not found) fail immediately
- The retry count is logged at debug level; bulk assignee operations also surface it in
  their partial-failure message
- **Creates never retry an ambiguous failure.** Vikunja's v1 API uses `PUT` as its create verb,
  so `vikunjaRestRequest` gives every `PUT` the `shouldRetryNonIdempotentWrite` predicate: it
  retries only HTTP 429 and connection failures that prove the request was never delivered
  (refused / unresolved / handshake timeout). A 5xx or a mid-flight reset is ambiguous: the
  write may have committed with the response lost, and resending it would silently create a
  duplicate. Idempotent methods keep the standard 5xx/429/transient-network policy; a call site
  that knows a given `PUT` is safe to repeat can override `options.retry.shouldRetry`.
  See [API_NOTES.md](API_NOTES.md#create-retries-and-idempotency) for how this
  connects to the create/update verb inversion itself.

### API Version Handling (v1 / v2)

Vikunja exposes two API versions, and this server treats version as a **per-operation property**
rather than a global mode. There is no "the server is in v2 mode": each operation resolves its own
version, and any operation can be on a different version from its neighbour. Mixed-version
operation is permanent by design, not a transitional state, so a single global switch could never
be correct.

**Three distinct reasons keep an operation on v1**, and only the third is version-shaped:

1. **No v2 equivalent exists at all**, on any version. `vikunja_admin list-users` and the two
   Unsplash background functions. Permanently v1.
2. **v2 offers nothing over v1** for that operation. Bulk task update routes into the same
   server-side model code and wipes assignees identically; `expand` has the same value set on both.
   v1 by default, not by necessity.
3. **v2 is broken on some supported versions and fine on others.** `vikunja_tasks update` is v1 on
   2.4.0 and v2 from 2.5.0. This is what `minVersion` exists for, and it resolves itself as the
   support window rolls forward.

The moving parts:

- **v1 transport** (`src/utils/vikunja-rest.ts`): the permanent floor. Every operation is served
  by v1 unless a v2 path explicitly takes it over, and several never can.
- **v2 transport** (`src/utils/vikunja-rest-v2.ts`): a deliberate sibling, not a branch inside the
  v1 helper, so new logic never executes on the path that must not regress. Shares the retry loop
  and breaker registry from `retry.ts`, but under a distinct `vikunja-rest-v2-` breaker namespace:
  breakers are process-wide and keyed by name, so a shared name would let one API surface's
  failures trip the other's. Sends RFC 7386 merge-patch by default on `PATCH`.
- **Shared transport rules** (`src/utils/vikunja-rest-shared.ts`): the protections both transports
  must apply identically, so they cannot drift: upstream error text redaction before a body reaches
  an `MCPError`, and the execution abort signal that bounds a request's lifetime.
- **Routing** (`src/utils/api-version.ts`): `resolveApiVersion` is the single decision point.
  Synchronous and network-free; it consults the session's cached capability probe and returns `v2`
  only on positive evidence, defaulting to `v1` everywhere else. It accepts a per-operation
  `minVersion`, so an operation can declare its own server floor and keep v1 below it. An
  *undetected* server version resolves to v1: "we could not tell" is not evidence a server is new
  enough. The `featureFlags.forceV1Api` kill switch overrides all of it.
- **Capability probe** (`src/utils/capabilities.ts`): `probeV2Api` validates that
  `/api/v2/openapi.json` is a real OpenAPI document (content type plus a top-level `openapi` key)
  rather than trusting an HTTP 200, so a reverse proxy or SPA catch-all cannot fake v2 support on a
  v1-only server.

#### The strategy pair

Where an operation's v1 and v2 forms are genuinely different algorithms, not the same call with a
different URL, the two live as separate strategies behind a context. This mirrors the existing
`FilteringContext` pattern in `src/utils/filtering/`:

```
TaskUpdateContext
  ├─ V1TaskUpdateStrategy   GET (fetch) → POST (full model) → assignees → labels
  └─ V2TaskUpdateStrategy   labels → PATCH (fields + assignees inline)
                            selected only when the server is >= 2.5.0
```

Both satisfy one interface and return the same canonical shape. The point is to keep v1 frozen (it
is the permanent floor) while letting v2 be genuinely different: different call counts, different
ordering, different bodies. Interleaving them in one function with `if (v2)` branches guarantees
drift, and every new v2 optimisation makes it worse.

Not every operation needs a pair. Where the only difference is the URL prefix and the envelope, the
normalizer alone suffices, and a plain version dispatcher is enough. `vikunja_task_comments update`
is that case: v1's update already replaced only the comment text, so there was no fetch-merge to
retire.

Live pairs today: `src/tools/tasks/crud/update/`, `src/tools/projects/update/`,
`src/tools/projects/view-update/`, `src/tools/filters/update/`, `src/tools/teams/update/`, and
`src/utils/label-update.ts`.

#### The normalization boundary

This is the load-bearing decision, and it is what makes mixed-mode cheap. Every v2 response is
normalized to the canonical internal shape **before it leaves the transport or strategy layer**:

- the pagination envelope is unwrapped to the bare array callers expect
  (`src/utils/vikunja-v2-normalize.ts`), with `total`/`page`/`per_page`/`total_pages` kept in a
  `WeakMap` side table rather than changing the return type
- `$schema` is stripped
- v2-only fields the tool surface does not carry, chiefly `max_permission`, are stripped at the
  strategy boundary. Projects are the exception worth knowing about: **both** versions return
  `max_permission` there and disagree on the value, so it is stripped on the v1 path too, which is
  the one place this milestone changed a response schema (see
  `src/tools/projects/update/canonical.ts`)
- the search parameter is spelled `q` inside the v2 query builder, never `s`. v2 silently ignores
  an unknown `s` and answers 200 with an unfiltered list, so a mis-ported name degrades to "no
  filter applied" rather than an error
- errors converge on `MCPError`: v2's `application/problem+json` is adapted to the same shape v1
  produces, preserving Vikunja's numeric `code` and per-field `errors[]`

Downstream, formatters, tool handlers and tests never learn which version ran. That principle was
established for errors first, which is why every catch block in the codebase is already
version-blind, and response bodies get the same treatment.

**One content difference is deliberately visible.** A rich-text field read over v2 comes back as
GitHub-flavoured markdown where v1 returns HTML, because v2 honours `?format=markdown`. It ignores
that parameter on `PATCH`, so an update response still carries HTML. Reads take markdown because
that is where an LLM consumes descriptions; adding a re-read after every update to make the two
agree would cost back the round trip `PATCH` exists to save. See
[API-VERSION-MATRIX.md](API-VERSION-MATRIX.md) for per-function coverage and the full note.
