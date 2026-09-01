# Configuration Management

The Vikunja MCP server uses a centralized configuration system that replaces scattered `process.env` usage with type-safe, validated configuration management. Settings arrive from four layers: environment profile, optional JSON config file, environment variables, and programmatic injection. All four are validated once, at startup, by a Zod schema (`src/config/types.ts`). This page is the reference for every key, env var, and default; the loader itself lives in `src/config/ConfigurationManager.ts`.

## Quick Start

### Basic Usage

```typescript
import { getConfiguration, getAuthConfig, getRateLimitConfig, isFeatureEnabled } from './config';

// Get complete configuration
const config = await getConfiguration();

// Get specific sections
const authConfig = await getAuthConfig();
const rateLimiting = await getRateLimitConfig();

// Check feature flags
const isEnabled = await isFeatureEnabled('enableServerSideFiltering');
```

### Environment Setup

1. Copy `.env.example` to `.env`
2. Configure your Vikunja connection:
   ```env
   VIKUNJA_URL=https://your-vikunja-instance.com
   VIKUNJA_API_TOKEN=your-api-token-here
   ```
3. Set your environment:
   ```env
   NODE_ENV=development  # or test, production
   ```

## Configuration Architecture

### Configuration Sections

The configuration is organized into the five typed sections below, plus `modules` and the
top-level `readOnly` flag. The two flags are documented separately, in [Module Gating](#module-gating) and
[Global Read-Only Safety Mode](#global-read-only-safety-mode):

#### 1. Authentication (`AuthConfig`)
```typescript
interface AuthConfig {
  vikunjaUrl?: string;     // Vikunja server URL
  vikunjaToken?: string;   // API or JWT token
  mcpMode?: string;        // MCP server mode
}
```

#### 2. Logging (`LoggingConfig`)
```typescript
interface LoggingConfig {
  level: 'error' | 'warn' | 'info' | 'debug';
  debug: boolean;
  environment: Environment;
}
```

#### 3. Rate Limiting (`RateLimitConfig`)
```typescript
interface RateLimitConfig {
  enabled: boolean;
  default: RateLimitSettings;    // Standard tools
  expensive: RateLimitSettings;  // Resource-intensive operations
  bulk: RateLimitSettings;       // Batch operations
  export: RateLimitSettings;     // Export operations
}

interface RateLimitSettings {
  requestsPerMinute: number;
  requestsPerHour: number;
  maxRequestSize: number;
  maxResponseSize: number;
  executionTimeout: number;
}
```

#### 4. Feature Flags (`FeatureFlagsConfig`)
```typescript
interface FeatureFlagsConfig {
  enableServerSideFiltering: boolean;
  enableAdvancedMetrics: boolean;
  enableExperimentalFeatures: boolean;
}
```

#### 5. Templates (`TemplatesConfig`)
```typescript
interface TemplatesConfig {
  persistPath?: string;   // File-backed persistence — see Templates Persistence below
}
```

### Environment Profiles

The system automatically applies environment-specific defaults:

#### Development Profile
- **Logging**: Debug level, verbose output
- **Rate Limiting**: Disabled for easier testing
- **Features**: Experimental features enabled

#### Test Profile
- **Logging**: Error level only to reduce noise
- **Rate Limiting**: Disabled for test performance
- **Features**: Conservative settings for consistent behavior

#### Production Profile
- **Logging**: Info level for operational visibility
- **Rate Limiting**: Full protection enabled
- **Features**: Only stable features enabled

**Caveat on the rate-limiting rows above.** They describe the `rateLimiting` section of
`ApplicationConfig` as resolved by `ConfigurationManager`. The rate limiting middleware
that actually runs (`src/middleware/simplified-rate-limit.ts`) reads `RATE_LIMIT_*` from
`process.env` directly and does **not** consume this section, so setting
`NODE_ENV=development`/`test` does not by itself switch the middleware off. Only
`RATE_LIMIT_ENABLED=false` does. See [RATE_LIMITING.md](RATE_LIMITING.md).

## Configuration Priority

Configuration values are resolved in the following priority order (highest to lowest):

1. **Programmatic Sources** - Direct configuration objects (used by tests / embedders)
2. **Environment Variables** - System environment variables that **always win over the config file**
3. **Config File** - Optional `vikunja-mcp.config.json` (see [Config File](#config-file) below)
4. **Environment Profiles** - Dev/test/production defaults
5. **Schema Defaults** - Fallback values defined in schema

## Config File

Non-sensitive configuration can be layered in from an optional JSON file. It is safe to
commit, safe to mount read-only into a container (e.g. as a Docker `config`), and is
**never** the place for secrets. See [Secrets Management](#secrets-management).

- **Default path**: `vikunja-mcp.config.json` in the process's current working directory.
  If it doesn't exist, it is silently skipped, since the file is entirely optional.
- **Override path**: set `VIKUNJA_MCP_CONFIG=/path/to/file.json`. When this variable is
  set explicitly, a missing or unreadable file is a **hard startup error** (fail fast).
  An explicit path that can't be read is assumed to be a misconfiguration, not something
  to silently ignore.
- **Malformed file**: invalid JSON, or JSON whose top-level value isn't an object, is
  always a hard startup error with a message naming the file path and the parse problem,
  regardless of whether the path was explicit or the default.
- **Shape**: the file mirrors `ApplicationConfig`. Any of `auth` (non-secret fields
  only), `logging`, `rateLimiting`, `featureFlags`, `modules`, `templates`, `transport`,
  `http`, `oidc`, `vault` (path only, never the master key; see
  [Credential vault](#credential-vault-self-service-token-provisioning)) may be present;
  anything omitted falls back to the environment profile / schema default.

Example `vikunja-mcp.config.json`:

```json
{
  "modules": {
    "webhooks": false,
    "batchImport": { "enabled": true }
  },
  "logging": {
    "level": "info"
  },
  "readOnly": false
}
```

## Module Gating

Each Vikunja entity's tools live behind a **module** toggle, resolved once at
tool-registration time (`registerTools` in `src/tools/index.ts`). A disabled module's
tools are never registered with the MCP server. They are invisible to the client, not
merely rejected at call time.

### Module Config Shape

A module's value is a plain boolean today, but the object form is accepted so
per-subcommand granularity can be added later **without a breaking change**:

```json
{ "modules": { "tasks": false } }
```

```json
{ "modules": { "tasks": { "enabled": true } } }
```

The object form already tolerates (and ignores, for now) extra boolean keys, so a future
release can start honoring `{"tasks": {"enabled": true, "delete": false}}` without
requiring any config migration.

### Known Modules

| Module | Default | Notes |
|---|---|---|
| `tasks` | **ON** | Gates the entire task tool family (CRUD, bulk, assignees, comments, reminders, labels, relations) together |
| `projects` | **ON** | |
| `labels` | **ON** | |
| `teams` | **ON** | |
| `users` | **ON** | Also requires JWT authentication; see [Composing with Auth-Type Gating](#composing-with-auth-type-gating) |
| `webhooks` | **ON** | |
| `filters` | **ON** | |
| `templates` | **ON** | |
| `export` | **ON** | Also requires JWT authentication |
| `batchImport` | **ON** | |
| `notifications` | **ON** | Gates `vikunja_notifications` |
| `subscriptions` | **ON** | Gates `vikunja_subscriptions` |
| `reactions` | **ON** | Gates `vikunja_reactions` |
| `admin` | **OFF** ⚠️ | Gates `vikunja_admin` (instance-admin operations: overview, all-projects listing + owner reassignment, user list/create/delete, admin-flag + status toggles). Deny-by-default AND JWT-only; see [Composing with Auth-Type Gating](#composing-with-auth-type-gating). `delete-user` additionally requires an explicit `confirm: true` tool argument. |
| `userDeletion` | **OFF** ⚠️⚠️ | Gates `vikunja_user_deletion` (`request`/`confirm`/`cancel` self-deletion of the **currently authenticated account**). Deny-by-default AND JWT-only; see [Composing with Auth-Type Gating](#composing-with-auth-type-gating). `request` and `confirm` additionally require an explicit `confirm: true` tool argument; both are genuinely irreversible once the emailed confirmation token is used, so do not enable this module unless you specifically want an AI assistant able to delete the connected Vikunja account. `cancel` (the safe undo) does not require `confirm: true`. |
| `tokenManagement` | **OFF** ⚠️ | Gates `vikunja_tokens` (API token list/create/delete for the connected account). Deny-by-default: credential-adjacent. No auth-type restriction at registration time (unlike `admin`/`users`/`export`), but the underlying `/tokens` endpoints may reject API-token sessions server-side; see `src/tools/tokens.ts`. |
| `caldavTokens` | **OFF** ⚠️ | Gates `vikunja_caldav_tokens` (CalDAV token list/create/delete for the connected account). Deny-by-default: credential-adjacent, and a created token's secret is shown only once. Unlike `tokenManagement`, the underlying `/user/settings/token/caldav*` endpoints ARE JWT-only per the vendored OpenAPI spec, so registration composes with the same JWT-only gate as `users`/`export`/`admin`; see [Composing with Auth-Type Gating](#composing-with-auth-type-gating) and `src/tools/caldav-tokens.ts`. |
| `backgrounds` | **OFF** (opt-in) | Gates three `vikunja_projects` subcommands (`remove-background`, `set-unsplash-background`, `search-unsplash`; G7, project backgrounds), **not** a whole tool. Deny-by-default for the opposite reason to `admin`/`userDeletion`/`tokenManagement`: not dangerous, just low-value/cosmetic for a task-management assistant. See [Subcommand-Level Gating: `backgrounds`](#subcommand-level-gating-backgrounds) below. |

Ordinary modules default **ON** (matching pre-existing behavior; this system is
additive, not a breaking change). The four reserved "dangerous" modules default **OFF**
(deny-by-default): `admin`, `tokenManagement`, `caldavTokens`, and `userDeletion` now all
have tools wired to them and ship already gated closed until an operator opts in.
`userDeletion` deserves particular caution: read its row above in full before enabling
it. `backgrounds` is also **OFF** by default, but as an **opt-in cosmetic** module rather
than a dangerous one; see below.

### Subcommand-Level Gating: `backgrounds`

Every module above gates a whole standalone tool at registration time. `backgrounds` is
the one exception: it gates only three subcommands *within* the always-registered
`vikunja_projects` tool (`remove-background`, `set-unsplash-background`,
`search-unsplash`), because bundling low-value cosmetic operations into their own tool
would be worse ergonomics than adding them to the tool that already owns project state.

The same "invisible to the client, not merely rejected at call time" contract still
holds; it is just enforced one level down. `registerProjectsTool`
(`src/tools/projects/index.ts`) builds `vikunja_projects`'s subcommand **enum** itself
conditionally on whether `backgrounds` is enabled: when it isn't (the default), those
three strings are not present in the enum at all, so a call naming one of them fails
MCP schema validation (an unrecognized enum value) rather than reaching any handler
logic. Enable the module and the enum includes them; disable it and they vanish from
the schema again, exactly mirroring what module gating does for a whole tool.

```json
{ "modules": { "backgrounds": true } }
```

```env
VIKUNJA_MCP_MODULE_BACKGROUNDS=true
```

Two of the three subcommands (`set-unsplash-background`, `search-unsplash`) only work
when the connected Vikunja server itself has an Unsplash provider configured
(an admin-side API key). When it doesn't, the server's error is recognized and
rewritten into a friendly, actionable message rather than surfaced as opaque server
text. The binary image bytes (upload, and fetching the actual image/thumbnail) stay
parked: MCP has no content channel for them; see
[docs/ENDPOINT-TAIL-RETRIAGE.md](ENDPOINT-TAIL-RETRIAGE.md) item G7.

### Module Env Var Overrides

Each module has a matching boolean-only env var override (env vars carry the boolean
shorthand only; the object form with future per-subcommand keys is a config-file-only
feature):

```env
VIKUNJA_MCP_MODULE_TASKS=true
VIKUNJA_MCP_MODULE_PROJECTS=true
VIKUNJA_MCP_MODULE_LABELS=true
VIKUNJA_MCP_MODULE_TEAMS=true
VIKUNJA_MCP_MODULE_USERS=true
VIKUNJA_MCP_MODULE_WEBHOOKS=true
VIKUNJA_MCP_MODULE_FILTERS=true
VIKUNJA_MCP_MODULE_TEMPLATES=true
VIKUNJA_MCP_MODULE_EXPORT=true
VIKUNJA_MCP_MODULE_BATCH_IMPORT=true
VIKUNJA_MCP_MODULE_NOTIFICATIONS=true
VIKUNJA_MCP_MODULE_SUBSCRIPTIONS=true
VIKUNJA_MCP_MODULE_REACTIONS=true

# Reserved / dangerous — deny-by-default
VIKUNJA_MCP_MODULE_ADMIN=false
VIKUNJA_MCP_MODULE_USER_DELETION=false
VIKUNJA_MCP_MODULE_TOKEN_MANAGEMENT=false
VIKUNJA_MCP_MODULE_CALDAV_TOKENS=false

# Opt-in cosmetic — deny-by-default (not dangerous, just low-value)
VIKUNJA_MCP_MODULE_BACKGROUNDS=false
```

As with every other setting, these env vars always win over the config file.

### Composing with Auth-Type Gating

Module config can only **narrow** what authentication already allows. It can never
**expand** it. The `users` and `export` tools have always required JWT authentication
(API-token auth excludes them for backward compatibility); `admin` composes with the
same JWT-only gate. Module gating is applied *in addition to*, never instead of, that
check:

```typescript
// `getEffectiveAuthType` resolves the CALLER's auth type: the ALS-bound
// per-identity manager in oidc-http mode, the process-global one in stdio.
const jwtAuthenticated = getEffectiveAuthType(authManager) === 'jwt';
if (jwtAuthenticated && isModuleEnabled(modules.users)) {
  registerUsersTool(server, authManager, clientFactory);
}
// ... and further down:
if (jwtAuthenticated && isModuleEnabled(modules.admin)) {
  registerAdminTool(server, authManager, clientFactory);
}
if (jwtAuthenticated && isModuleEnabled(modules.userDeletion)) {
  registerUserDeletionTool(server, authManager, clientFactory);
}
```

Setting `VIKUNJA_MCP_MODULE_USERS=true` while authenticated with an API token does
**not** register the users tool: there is no config setting that can grant access auth
doesn't already permit. The same is true of `VIKUNJA_MCP_MODULE_ADMIN=true` and
`VIKUNJA_MCP_MODULE_USER_DELETION=true`: with an API-token session, `vikunja_admin` and
`vikunja_user_deletion` both stay unregistered regardless of the config value. Per
docs/VIKUNJA_API_ISSUES.md, every `/user/*` endpoint (including `/user/deletion/*`)
rejects `tk_*` API tokens server-side, so this JWT-only gate is not just a local policy
choice here. `tokenManagement` is the one deny-by-default module that does **not**
compose with the JWT-only gate: `vikunja_tokens` registers for either session type once
its module key is enabled, since the underlying endpoints' auth requirement is a runtime
server behavior rather than something this server enforces at registration time.

`caldavTokens`, by contrast, DOES compose with the JWT-only gate, the same way
`admin` does. `vikunja_caldav_tokens` registers only when both
`VIKUNJA_MCP_MODULE_CALDAV_TOKENS=true` (or the config-file equivalent) AND the
session is JWT-authenticated, because the vendored OpenAPI spec scopes every
`/user/settings/token/caldav*` operation to `JWTKeyAuth` only (no `APIKeyAuth` entry).
Unlike `/tokens`, this is enforced at registration time, not left for the server to
reject at runtime.

**In `oidc-http` mode the JWT gate follows the caller, not the process** (issues
#270/#282). The tool list is built per request, inside that request's identity
scope, so the gate reads the auth type of the credential *that identity* has in
the vault. An identity with no linked credential gets none of these tools at all.
This matters for a mixed deployment: if legacy `VIKUNJA_URL` +
`VIKUNJA_API_TOKEN` env variables are set alongside `oidc-http`, the operator's
own token used to decide the gate for everyone — a JWT there exposed
`vikunja_admin`/`vikunja_user_deletion`/`vikunja_users`/export to every caller
including `tk_*`-vaulted ones, and a `tk_*` there denied them to callers
entitled to them. The per-call checks inside those tools resolve the same way.

**Consequence: the JWT-only tools are effectively `stdio`-only** (issue #322). The
`oidc-http` credential vault stores Vikunja **API tokens** and nothing else — that is the
mode's design (`docs/OIDC-RESOURCE-SERVER.md` §1.2: an OIDC access token is not a Vikunja
credential, so each user links their own long-lived `tk_*` token), and since #322
`vikunja_auth provision` and the vault itself both **reject** a JWT-shaped token with an
explanatory error instead of storing it mislabeled. A Vikunja JWT comes from Vikunja's own
login form, expires within hours, and this server holds no refresh path for it, so it is
not a credential the vault can keep working. Every vaulted identity therefore resolves to
`authType: 'api-token'`, and `vikunja_users`, the four export tools,
`vikunja_caldav_tokens`, `vikunja_admin` and `vikunja_user_deletion` never register in
`oidc-http` mode no matter how the module keys are set. Use those tools from a `stdio`
deployment with a JWT session. (If Vikunja ever issues long-lived, refreshable JWTs — or
accepts OIDC tokens directly, the upstream ask in `docs/OIDC-RESOURCE-SERVER.md` §5 — this
is the decision to revisit.)

## Global Read-Only Safety Mode

A separate, orthogonal safety layer from module gating: instead of hiding a tool from the
MCP client entirely (module gating), read-only mode keeps every tool **visible and
registered**, but rejects any subcommand that writes or destroys data on the connected
Vikunja instance. Read subcommands (`list`, `get`, `status`, ...) keep working normally.
This is useful for a read-only "explore my tasks" session, a demo environment, or any
deployment where an operator wants to guarantee an AI assistant cannot mutate data no
matter what a tool call asks for.

- **Config file key**: `readOnly` (boolean, default `false`) at the top level of
  `vikunja-mcp.config.json`, a peer of `modules`/`logging`/etc., not nested under either.
- **Env override**: `VIKUNJA_MCP_READ_ONLY` (boolean shorthand, `true`/`false`). As with
  every other setting, the env var always wins over the config file.

```json
{ "readOnly": true }
```

```env
VIKUNJA_MCP_READ_ONLY=true
```

### What gets rejected

Rejection happens at dispatch, inside each tool's handler, via a single shared guard
(`assertWriteAllowed` in `src/utils/read-only.ts`) that every tool dispatcher calls once,
right after its existing auth check, instead of 27 copy-pasted `if (readOnly)` checks. The guard
consults one classification table per tool (`subcommand -> read | write | destructive`),
built from the actual Vikunja API semantics of each subcommand (see the module's doc
comment for the full rubric and the rationale behind edge cases like the dual-purpose
`comment` subcommand, `vikunja_batch_import`'s `dryRun`, and the fully-exempt
`vikunja_auth` tool). A rejected call fails with a consistent, clearly-worded error:

```text
server is in read-only mode: 'vikunja_tasks' subcommand 'delete' is a destructive
operation and is rejected. Set 'readOnly' to false in vikunja-mcp.config.json
(or unset VIKUNJA_MCP_READ_ONLY) to allow writes.
```

Notes on scope:

- **`vikunja_auth`** (`connect`/`status`/`refresh`/`disconnect`/`info`) is entirely exempt:
  those subcommands only manage the MCP server's local session, never a Vikunja
  resource, so read-only mode never blocks them.
- **Dynamic classification**: a small number of subcommands classify themselves based on
  the actual call arguments rather than a fixed table entry: `vikunja_tasks`'/
  `vikunja_task_comments`' dual-purpose `comment` subcommand (creates when text is
  supplied, otherwise lists; classified `read` only when no comment text is given) and
  `vikunja_batch_import` (classified `read` only when `dryRun: true`, since a dry run
  never writes).
- Module gating and read-only mode compose independently: a module disabled entirely
  (§ Module Gating above) is invisible regardless of `readOnly`; a module left enabled
  under `readOnly: true` stays visible but write/destructive calls into it are rejected.

### MCP Tool Annotations

The same per-tool classification tables drive the MCP SDK's `ToolAnnotations`
(`readOnlyHint` / `destructiveHint` / `idempotentHint`), registered alongside every tool's
schema so MCP clients can render tool cards accurately and apply their own consent/
confirmation UX for destructive calls. Because a single MCP tool name here fans out to
several subcommands with different semantics, the tool-level hints are derived
conservatively:

- `readOnlyHint` is `true` only when **every** subcommand on that tool is classified
  `read` (today: `vikunja_auth`, `vikunja_export_project`,
  `vikunja_download_user_export` and `vikunja_user_export_status`; see
  `TOOL_CLASSIFICATIONS` in `src/utils/read-only.ts`).
- `destructiveHint` is `true` when **any** subcommand is classified `destructive` (true
  for nearly every CRUD-shaped tool, since almost all of them expose a `delete`-shaped
  operation).
- `idempotentHint` is set `true` only for tools on an explicit, hand-reviewed allowlist
  where every non-read subcommand is genuinely idempotent: currently just
  `vikunja_notifications` (`mark-read`/`mark-all-read` are ensure-semantics: marking an
  already-read notification as read again is a no-op). It is intentionally *not* inferred
  automatically from the read/write/destructive table, since idempotency is a semantic
  judgment call the three-way classification doesn't capture (e.g. `vikunja_teams`'
  `members:toggleAdmin` is a `write`, not a `delete`, but explicitly is **not**
  idempotent, since it flips a flag rather than setting it).

## Templates Persistence

`vikunja_templates` templates are **session-only by default**: they live in the same
in-memory `SimpleFilterStorage` as saved filters, scoped to the connected session, and
are lost when the server process restarts. Set a persist path to make them durable
across restarts.

- **Config key**: `templates.persistPath` in `vikunja-mcp.config.json`.
- **Env var**: `VIKUNJA_MCP_TEMPLATES_FILE=/path/to/templates.json`, which **wins over
  the config file**, same precedence as every other setting (see
  [Configuration Priority](#configuration-priority)).
- **Unset (default)**: templates stay in-memory only; behavior is byte-identical to
  before this feature existed.
- **Set**: the file is loaded once, tolerantly, the first time `vikunja_templates` is
  used after startup. A missing file (first run / fresh volume) or a corrupt/malformed
  file both fall back to an empty template set (logged as a warning for the corrupt
  case), **never** a crash. Every `create` / `update` / `delete` mutation then
  write-throughs the full current template set back to the file, **atomically**: written
  to a temp file in the same directory, then renamed over the target, so a reader never
  observes a half-written file and a crash mid-write can't corrupt the previous good
  state. The parent directory is created automatically if it doesn't exist yet.

This is intentionally a plain JSON file, not a database. SQLite was evaluated for this
work item and parked (native-dependency cost outweighs the need for a single opt-in
file; see `docs/ROADMAP.md`). The path is a single file, which makes it trivial to mount
as a Docker volume:

```yaml
services:
  vikunja-mcp:
    image: ghcr.io/netadvanced/vikunja-mcp-ng:latest
    environment:
      VIKUNJA_URL: "https://vikunja.example.com"
      VIKUNJA_API_TOKEN_FILE: /run/secrets/vikunja_api_token
      VIKUNJA_MCP_TEMPLATES_FILE: /data/templates.json
    volumes:
      - vikunja-mcp-templates:/data
    secrets:
      - source: vikunja_api_token
        target: vikunja_api_token
        mode: 0400

volumes:
  vikunja-mcp-templates:

secrets:
  vikunja_api_token:
    file: ./secrets/vikunja_api_token.txt
```

Or via the config file instead of the env var:

```json
{
  "templates": {
    "persistPath": "/data/templates.json"
  }
}
```

The template file contains no credentials. It's a plain JSON array of template
definitions (project/task shape, no auth data), so, like the rest of the config file, it
doesn't need Docker-secrets treatment; only the volume itself needs to persist across
container recreations.

## Transport Mode (opt-in HTTP) and OIDC resource-server mode

The server's transport defaults to **`stdio`**, the existing single-tenant behavior,
byte-for-byte unchanged. `transport=http` opts into a **Streamable HTTP** transport
(stateless `StreamableHTTPServerTransport` from the MCP SDK) for a hosted, multi-user
deployment sitting behind an OIDC-aware gateway (e.g. IBM MCP Context Forge in front of
Keycloak); see `docs/OIDC-RESOURCE-SERVER.md` for the full design and threat model.

- **Config key**: `transport` in `vikunja-mcp.config.json` (`"stdio"` or `"http"`).
- **Env var**: `VIKUNJA_MCP_TRANSPORT`, which wins over the config file, as usual.
- **Unset (default)**: `stdio`, identical to every prior release.

When `transport=http`, additional settings apply under the `http` config section /
`VIKUNJA_MCP_HTTP_*` env vars:

| Setting | Config key | Env var | Default |
|---|---|---|---|
| Bind host | `http.host` | `VIKUNJA_MCP_HTTP_HOST` | `127.0.0.1` (loopback; fails closed rather than exposing an unauthenticated-looking port to the LAN) |
| Port | `http.port` | `VIKUNJA_MCP_HTTP_PORT` | `8765` |
| Request path | `http.path` | `VIKUNJA_MCP_HTTP_PATH` | `/mcp` |
| Allowed `Host` headers | `http.allowedHosts` | `VIKUNJA_MCP_HTTP_ALLOWED_HOSTS` (comma list) | `<host>:<port>`, used for the SDK transport's built-in DNS-rebinding protection, which is always on in `http` mode |

Two endpoints are always served unauthenticated, outside the MCP path and any
authentication middleware: `GET /healthz` (liveness) and `GET /readyz`. Note that
`/readyz` is currently a stub: it returns `{"status":"ok"}` unconditionally, checking
neither JWKS reachability nor the vault file, so today it tells you nothing `/healthz`
doesn't (see `docs/OIDC-SETUP.md` §11).

**`transport=http` refuses to start without a complete OIDC + vault configuration.** The
server must never serve unauthenticated HTTP, so `http` mode requires ALL of: the `oidc`
config block (below) AND a usable credential vault (a file path and a master key,
below). Any one missing is a hard startup error, never a silent downgrade to
no-auth. `transport=stdio` (the default) never reads any of this.

### OIDC resource-server settings

The server validates an incoming request's bearer token as a **pure OIDC resource
server**: it never runs a login flow and never talks to the identity provider's token
endpoint. It only checks the token's signature, issuer, audience, expiry, and algorithm
against the settings below, all under the `oidc` config section / `VIKUNJA_MCP_OIDC_*`
env vars:

| Setting | Config key | Env var | Notes |
|---|---|---|---|
| Issuer (required) | `oidc.issuer` | `VIKUNJA_MCP_OIDC_ISSUER` | Exact-match trusted issuer, e.g. `https://iam.example.org/realms/foo`; generic, no org-specific values baked in |
| Audience (required) | `oidc.audience` | `VIKUNJA_MCP_OIDC_AUDIENCE` | Required `aud` value(s); comma-separated list accepted, a single value stays a string |
| JWKS URI (required) | `oidc.jwksUri` | `VIKUNJA_MCP_OIDC_JWKS_URI` | The provider's JWKS endpoint (e.g. its `/.well-known/openid-configuration`'s `jwks_uri`) |
| Allowed algorithms | `oidc.allowedAlgs` | `VIKUNJA_MCP_OIDC_ALLOWED_ALGS` | Comma list; validator default `RS256`; `none` is never accepted regardless of this setting |
| Clock skew (seconds) | `oidc.clockSkewSec` | `VIKUNJA_MCP_OIDC_CLOCK_SKEW_SEC` | Validator default `60`; applied to `exp`/`nbf`/`iat` |
| Required scope | `oidc.requiredScope` | `VIKUNJA_MCP_OIDC_REQUIRED_SCOPE` | Optional coarse gate: a validly-authenticated token missing it gets `403`, not `401` |

A validated token's `sub` (subject) is the per-user tenancy key the rest of this section
depends on; see the credential vault below and `docs/OIDC-RESOURCE-SERVER.md` §3b/§3d
for the full validation contract and per-user isolation guarantees.

### Credential vault (self-service token provisioning)

An OIDC access token proves *who* is calling, but Vikunja only accepts its own `tk_*` API
tokens. There is no token exchange between the two. `oidc-http` mode therefore keeps an
**encrypted JSON file** mapping each validated `(issuer, sub)` identity to a Vikunja
`tk_` token, provisioned once per user through the `vikunja_auth provision` subcommand
(see `docs/OIDC-RESOURCE-SERVER.md` §3c for the full design and threat model).

| Setting | Config key | Env var | Notes |
|---|---|---|---|
| Vault file path (required) | `vault.path` | `VIKUNJA_MCP_VAULT_PATH` | Where the encrypted vault file lives. Not secret, just a filesystem location, but must be on a persistent volume so provisioned users survive a restart |
| Vault master key (required, sensitive) | *(never in the config file)* | `VIKUNJA_MCP_VAULT_KEY` / `VIKUNJA_MCP_VAULT_KEY_FILE` | A **32-byte** AES-256-GCM key, encoded as either 64 hex characters (`openssl rand -hex 32`) or base64 (`openssl rand -base64 32`). Rides the `*_FILE` secrets convention below; never write it to the config file |

Each vault record stores an AES-256-GCM-encrypted token (per-record random IV, verified
authentication tag on every decrypt, so a wrong key or a tampered record fails loudly
rather than returning garbage), plus the associated Vikunja URL and
created/updated/last-used timestamps. The raw token is never logged and the tool
responses only ever show a masked prefix.

#### Run exactly one server process per vault file

`oidc-http` mode is designed and tested as a **single process**. Running two or more
server processes against the same `VIKUNJA_MCP_VAULT_PATH` (a scaled-out Compose/Swarm
service, two replicas behind a load balancer, a rolling deploy where old and new
containers overlap) is **not supported** and will lose data silently.

The vault is a single JSON file that each process loads into memory once and rewrites in
full on every mutation, serialized by an in-process mutex. That mutex is per process, so
two processes can interleave their read-modify-write cycles: both load the same file,
both write their whole map back, and the second write erases the first process's
provisioning. The same single-process assumption runs through the rest of `oidc-http`
mode, and none of it is shared state a second process could join:

- **Enrollment tickets** (`/enroll`) live in memory, so a ticket minted by one process
  cannot be redeemed by another and one-click SSO fails at random.
- **Per-identity rate limiting** counts per process, so N replicas mean N times the
  intended ceiling.
- **Circuit-breaker state** and cached clients are per process, so failure handling
  degrades unevenly.

Scale vertically instead. If horizontal scaling is ever needed, it is a design change
(shared credential store, shared ticket store, shared rate-limit backend), not a
configuration option — sticky sessions do not make the vault safe, because provisioning
writes the whole file, not one record.

Self-service commands (all via the `vikunja_auth` tool, oidc-http mode only):

- **`provision`**: `{ apiToken, vikunjaUrl? }`. Validates the token against the live
  Vikunja server (the same round-trip `connect` performs) *before* storing anything;
  the identity is always read from your own validated bearer token, never from an
  argument. `vikunjaUrl` defaults to the server's configured `VIKUNJA_URL` when omitted.
- **`status`**: reports whether *your* identity has a linked token, its masked prefix,
  and when it was last used. Never reveals any other user's status.
- **`deprovision`**: removes your linked token (idempotent). Also the remedy after
  rotating/revoking a Vikunja token: `deprovision` then `provision` the new one.

### One-click SSO enrollment (optional, `enroll` section)

When the Vikunja backend is configured with the **same IdP** as a native OpenID login
provider, the token paste in `provision` can be eliminated entirely: `provision` called
*without* a token returns a short-lived enrollment URL, and the browser flow behind it
(`GET /enroll` → IdP → `GET /enroll/callback`) logs the user into Vikunja via its native
OpenID callback, mints their `tk_*` token, and vaults it automatically. See
`docs/OIDC-SETUP.md` §9a for the full validated design and IdP prerequisites (the MCP
callback URL must be whitelisted on **Vikunja's** OAuth client).

Enabling enrollment adds three hard config requirements (startup error otherwise):
`transport=http`, an `oidc` block, and `http.publicUrl` (`VIKUNJA_MCP_HTTP_PUBLIC_URL`).
Enrollment links and the OAuth `redirect_uri` are built from the public URL. The MCP
access tokens must also carry an `email` (or `preferred_username`) claim: the callback
pins the enrolled Vikunja account to the initiating identity and fails closed without it.

| Setting | Config key | Env var | Notes |
|---|---|---|---|
| Enable enrollment | `enroll.enabled` | `VIKUNJA_MCP_ENROLL_ENABLED` | Default `false`. Manual token provisioning keeps working either way |
| Provider | `enroll.provider` | `VIKUNJA_MCP_ENROLL_PROVIDER` | Vikunja OpenID provider `key`/`name` (from `GET /info`). Optional when the backend has exactly one |
| Vikunja URL | `enroll.vikunjaUrl` | `VIKUNJA_MCP_ENROLL_VIKUNJA_URL` | Vikunja API base for the flow; defaults to the shared `VIKUNJA_URL` |
| Token expiry (days) | `enroll.tokenExpiryDays` | `VIKUNJA_MCP_ENROLL_TOKEN_EXPIRY_DAYS` | Default `365`. Re-running `provision` after expiry mints a fresh token |
| Ticket TTL (seconds) | `enroll.ticketTtlSec` | `VIKUNJA_MCP_ENROLL_TICKET_TTL_SEC` | Default `600`. How long an issued enrollment link stays clickable (single-use) |

In `oidc-http` mode there is no single server-wide token to connect: `connect` is refused
with an error pointing you at `provision`, and `disconnect` is accepted but simply aliases
`deprovision` (it removes the caller's own vault record).

### Hosted deployment example

A generic (no org-specific values) `oidc-http` deployment, config file plus environment:

```json
{
  "transport": "http",
  "http": {
    "host": "127.0.0.1",
    "port": 8765,
    "allowedHosts": ["127.0.0.1:8765"]
  },
  "oidc": {
    "issuer": "https://idp.example.org/realms/example",
    "audience": "vikunja-mcp",
    "jwksUri": "https://idp.example.org/realms/example/protocol/openid-connect/certs"
  },
  "vault": {
    "path": "/var/lib/vikunja-mcp/vault.json"
  }
}
```

```env
VIKUNJA_URL=https://vikunja.example.com/api/v1
VIKUNJA_MCP_CONFIG=/etc/vikunja-mcp/vikunja-mcp.config.json
VIKUNJA_MCP_VAULT_KEY_FILE=/run/secrets/vikunja_mcp_vault_key
```

The gateway (e.g. IBM MCP Context Forge) sits in front of this server, terminates the
per-user OAuth flow against the IdP, and forwards each request with
`Authorization: Bearer <access-token>`. This server never sees the gateway's own
credentials and never talks to the IdP's token endpoint; see
`docs/OIDC-RESOURCE-SERVER.md` §1 for the full topology diagram.

## Bulk Write Concurrency

Bulk task **creates** (`vikunja_tasks bulk-create` / `vikunja_task_bulk
bulk-create`) run **sequentially**, one create at a time, and that is the
default you should keep unless you know your Vikunja's database is not SQLite.

- **Env var**: `VIKUNJA_BULK_WRITE_CONCURRENCY`
- **Default**: `1` (sequential)
- **Accepted values**: a positive integer, capped at `10`
- **Scope**: bulk **create** only. Bulk update (which uses Vikunja's native
  single-request `POST /tasks/bulk`) and bulk delete keep their own fixed
  concurrency; those numbers are ordinary throughput tuning that has never been
  a reported problem, whereas create's `1` exists to work around a specific
  server-side defect and is therefore the only one an operator has a principled
  reason to change.

> **SQLite caveat: read this before raising it.** On a SQLite-backed Vikunja
> (the default deployment), concurrent task creates return HTTP 500 "database is
> locked". The REST layer's 5xx retry then re-enters the still-contended pool
> and the burst of failures trips the shared `vikunja-rest-projects-tasks`
> circuit breaker, after which *every* create fails instantly with "Breaker is
> open" until the reset timeout. Live repro on Vikunja 2.3.0: three 12-task
> bulk-creates at concurrency 8 yielded 2/12, 0/12, 0/12; sequential creates
> yielded 36/36. Vikunja 2.4.0 advertises `concurrent_writes: true` and passed
> the same stress check cleanly, and 2.4.0 is now the supported floor. But
> "passed a handful of runs in one wave" is not yet evidence the fix is durable
> across upstream point releases, so the conservative default stands. Raise it
> only for Postgres/MySQL-backed instances.

An invalid value (non-numeric, fractional, zero, negative) logs a warning and
falls back to the default rather than failing startup; a value above the cap is
clamped to `10` with a warning. Credit: proposed by @joyjit in
democratize-technology/vikunja-mcp#97.

```env
VIKUNJA_BULK_WRITE_CONCURRENCY=1   # default; raise ONLY on non-SQLite backends
```

## Cross-Project Fetch Concurrency

Listing tasks across every accessible project (the "all projects" aggregate
fallback in `vikunja_tasks list`, used when the caller does not target a
single project) fetches each project's tasks concurrently, bounded by a small
pool rather than firing one request per project at once — a user with
hundreds of accessible projects would otherwise trigger hundreds of
simultaneous upstream requests (issue #324).

- **Env var**: `VIKUNJA_CROSS_PROJECT_CONCURRENCY`
- **Default**: `10`
- **Accepted values**: a positive integer, capped at `50`
- **Scope**: read-only — this only bounds how many per-project fetches are
  in flight at once. It does not change `VIKUNJA_MAX_TASKS_LIMIT`'s task-count
  budget, which stays exactly as strict either way.

An invalid value (non-numeric, fractional, zero, negative) logs a warning and
falls back to the default rather than failing startup; a value above the cap
is clamped to `50`.

```env
VIKUNJA_CROSS_PROJECT_CONCURRENCY=10   # default; raise for a large multi-project workspace
```

## Task Loading Limits (`VIKUNJA_MAX_TASKS_LIMIT`)

`VIKUNJA_MAX_TASKS_LIMIT` is a single, shared budget with two call sites:

1. **Post-load memory validation** (`src/utils/memory.ts`,
   `validateTaskCountLimit`): a V8-specific memory estimate that warns, and
   above `1.5x` the limit throws, once a listing's task count is known.
2. **Per-project aggregation while a listing is still loading**
   (`src/utils/filtering/ClientSideFilteringStrategy.ts`): the fallback path
   used for cross-project ("all projects" / no `projectId`) task listings when
   the direct `GET /tasks` strategy is unavailable or fails. This path pages
   through every accessible project's own `GET /projects/{id}/tasks` (issue
   #225: Vikunja clamps `per_page` to `service.maxitemsperpage`, default 50,
   so a single unpaginated call silently dropped everything past the first
   page) and through `GET /projects` itself (a user with more than 50
   projects was previously only ever aggregated over the first 50). Both loops
   are bounded by the SAME `VIKUNJA_MAX_TASKS_LIMIT` value, treated as one
   shared task-count budget across every project fetched during the
   aggregation, **plus** a fixed ceiling of 500 pages per collection
   (`MAX_PAGES_PER_PROJECT`) so a server that keeps returning full pages (or a
   pathological page size) can never page forever.

- **Env var**: `VIKUNJA_MAX_TASKS_LIMIT`
- **Default**: `10000`
- **Accepted values**: a positive integer, capped at `50000`
- **Invalid values**: non-numeric, non-integer, zero, or negative logs a
  warning and falls back to the default; a value above the cap is clamped to
  `50000` with a warning, the same fallback shape as
  `VIKUNJA_BULK_WRITE_CONCURRENCY` above.

**When a bound is hit, the partial result is kept, not discarded.** A
truncated aggregation across projects the user can access is still more
useful than an error, but it is never reported as a plain, complete success.
Hitting either bound (the task budget or the 500-page ceiling, on either the
project list or a project's own task list) sets two fields on the listing's
response metadata:

- `resultComplete: false`: the returned set is a KNOWN subset of what was
  asked for, as opposed to a filter that legitimately matched nothing.
- `warnings: string[]`: human-readable notes on what was skipped (which
  project ids failed outright, which project's task list was cut off at the
  limit, or that the project list itself was cut off), one entry per cause.

`vikunja_tasks list`'s summary line surfaces this directly rather than
burying it in metadata alone: an incomplete listing renders `INCOMPLETE
RESULT — <warnings>` in the `Found N tasks...` line the caller already reads.
This exists because the failure mode being fixed (issues #225/#227) was never
an exception. It was a plausible-looking answer with no error at all. A
caller asking "what is tagged X so I know what to act on" must be able to
tell "nothing matched" from "here is part of the answer".

```env
VIKUNJA_MAX_TASKS_LIMIT=10000   # optional, default 10000, max 50000
```

## Default Response Verbosity

`vikunja_tasks` and `vikunja_projects` responses are shaped by a `Verbosity` level
(`minimal` | `standard` | `detailed` | `complete`, `src/transforms/base.ts`) that controls
how many fields come back: fewer fields for a quick list, more for a deep inspection. Most
callers never think about this: a per-call `verbosity` argument (where a tool exposes one)
always wins, and absent that, the default is `standard`.

- **Env var**: `VIKUNJA_RESPONSE_VERBOSITY` changes the *default* every tool call falls
  back to when it doesn't pass `verbosity` explicitly, without needing a per-call override
  everywhere. This is unrelated to config-file settings; it is read directly from
  `process.env` (`getDefaultVerbosity()` in `src/transforms/base.ts`), not part of
  `ApplicationConfig`, so it has no config-file key and is not subject to the env-vs-file
  precedence rules elsewhere on this page.
- **Accepted values**: `minimal`, `standard`, `detailed`, `complete`, matched
  case-insensitively, surrounding whitespace trimmed.
- **Default / invalid values**: unset, empty, or anything that doesn't match one of the four
  values above silently falls back to `standard`, never a startup error.

```env
VIKUNJA_RESPONSE_VERBOSITY=detailed   # optional, default standard
```

## Secrets Management

**The config file is for non-sensitive settings only.** It's designed to be safe to
commit to source control and safe to mount as a read-only Docker/Swarm `config`, so
credentials must never be written into it. Secrets belong in environment variables.

### The `*_FILE` Convention

Every sensitive environment variable also accepts a `<NAME>_FILE` variant that names a
file whose contents are read at startup and used in place of the plain variable. It's the
same convention the official `postgres`/`mysql` Docker images use
(`POSTGRES_PASSWORD_FILE`, etc.), which plugs directly into Docker/Swarm/Kubernetes
secrets mounted as files.

Currently sensitive variables (audited against every `process.env.*` read under `src/`):

| Variable | `_FILE` variant |
|---|---|
| `VIKUNJA_API_TOKEN` | `VIKUNJA_API_TOKEN_FILE` |
| `VIKUNJA_MCP_VAULT_KEY` (oidc-http mode's credential vault master key) | `VIKUNJA_MCP_VAULT_KEY_FILE` |

Behavior:

- File contents are read once at startup and **trimmed of surrounding whitespace**
  (trailing newlines from `echo`/`printf`-created secret files are common and would
  otherwise silently corrupt the token).
- Setting **both** the plain variable and its `_FILE` variant is a **hard startup
  error**, never a silent precedence choice. This matches the postgres-image
  convention and avoids a class of bug where an operator believes they've moved a
  secret into a file but the plain env var (e.g. left over in a `.env` file) is still
  silently taking priority.
- Neither set: the plain variable's absence is handled exactly as before (e.g. no
  auto-authentication).

```env
# Use a file-mounted secret instead of the plain token
VIKUNJA_API_TOKEN_FILE=/run/secrets/vikunja_token
```

```env
# Hard error at startup — remove one of these
VIKUNJA_API_TOKEN=tk_xxx
VIKUNJA_API_TOKEN_FILE=/run/secrets/vikunja_token
```

### Docker Swarm Example

Config file mounted as a `config` (non-sensitive), token mounted as a `secret`:

```yaml
version: "3.8"

services:
  vikunja-mcp:
    image: ghcr.io/netadvanced/vikunja-mcp-ng:latest
    environment:
      VIKUNJA_URL: "https://vikunja.example.com"
      VIKUNJA_API_TOKEN_FILE: /run/secrets/vikunja_api_token
      VIKUNJA_MCP_CONFIG: /etc/vikunja-mcp/vikunja-mcp.config.json
    configs:
      - source: vikunja_mcp_config
        target: /etc/vikunja-mcp/vikunja-mcp.config.json
        mode: 0444
    secrets:
      - source: vikunja_api_token
        target: vikunja_api_token
        mode: 0400

configs:
  vikunja_mcp_config:
    file: ./vikunja-mcp.config.json

secrets:
  vikunja_api_token:
    file: ./secrets/vikunja_api_token.txt
```

Deploy with:

```bash
docker swarm init  # if not already a swarm manager
docker stack deploy -c docker-compose.yml vikunja-mcp
```

The token file (`./secrets/vikunja_api_token.txt`) should contain only the token,
optionally with a trailing newline, which will be trimmed automatically. It should never
be committed to source control; the config file (`./vikunja-mcp.config.json`) is safe to
commit since it contains no credentials.

## Environment Variables Reference

### Authentication Variables
```env
VIKUNJA_URL=https://vikunja.example.com
VIKUNJA_API_TOKEN=tk_your_token_here     # or VIKUNJA_API_TOKEN_FILE=/path/to/token — see Secrets Management
MCP_MODE=server
```

### Config File Variable
```env
VIKUNJA_MCP_CONFIG=/path/to/vikunja-mcp.config.json   # optional; see Config File
```

### Module Gating Variables
```env
VIKUNJA_MCP_MODULE_TASKS=true               # see Module Gating for the full list and defaults
```

### Global Read-Only Mode Variable
```env
VIKUNJA_MCP_READ_ONLY=true                  # optional, default false; see Global Read-Only Safety Mode
```

### Templates Persistence Variable
```env
VIKUNJA_MCP_TEMPLATES_FILE=/path/to/templates.json   # optional; see Templates Persistence
```

### Bulk Operation Variables
```env
VIKUNJA_BULK_WRITE_CONCURRENCY=1        # optional, default 1 (sequential), max 10; see Bulk Write Concurrency
VIKUNJA_MAX_TASKS_LIMIT=10000           # optional, default 10000, max 50000; see Task Loading Limits
VIKUNJA_CROSS_PROJECT_CONCURRENCY=10    # optional, default 10, max 50; see Cross-Project Fetch Concurrency
```

### Transport Variables
```env
VIKUNJA_MCP_TRANSPORT=stdio                  # stdio (default) | http; see Transport Mode / OIDC section
VIKUNJA_MCP_HTTP_HOST=127.0.0.1              # http mode only; default 127.0.0.1
VIKUNJA_MCP_HTTP_PORT=8765                   # http mode only; default 8765
VIKUNJA_MCP_HTTP_PATH=/mcp                   # http mode only; default /mcp
VIKUNJA_MCP_HTTP_ALLOWED_HOSTS=host:port,other:port   # http mode only; comma list, default <host>:<port>
```

### OIDC Resource-Server Variables (http mode only)

Only consulted when `transport=http`; see `docs/OIDC-RESOURCE-SERVER.md` for
the full design and [`docs/CONTEXT-FORGE.md`](CONTEXT-FORGE.md) for a worked
deployment walkthrough behind IBM MCP Context Forge + Keycloak (or any OIDC
provider).

```env
VIKUNJA_MCP_OIDC_ISSUER=https://idp.example.org/realms/example       # required
VIKUNJA_MCP_OIDC_AUDIENCE=vikunja-mcp                                # required; comma list accepted
VIKUNJA_MCP_OIDC_JWKS_URI=https://idp.example.org/realms/example/protocol/openid-connect/certs  # required
VIKUNJA_MCP_OIDC_ALLOWED_ALGS=RS256                                  # optional; comma list, default RS256, "none" never accepted
VIKUNJA_MCP_OIDC_CLOCK_SKEW_SEC=60                                   # optional; default 60
VIKUNJA_MCP_OIDC_REQUIRED_SCOPE=vikunja                              # optional
```

### Credential Vault Variables (http mode only)

Both must be set for self-service provisioning (`vikunja_auth
provision`/`status`/`deprovision`); with oidc-http mode active the server
refuses to start unless a vault path and master key are configured.

```env
VIKUNJA_MCP_VAULT_PATH=/var/lib/vikunja-mcp/vault.json               # required; not secret, just a path
VIKUNJA_MCP_VAULT_KEY=<32-byte key>                                  # required, sensitive — 64 hex chars (`openssl rand -hex 32`) or base64 (`openssl rand -base64 32`); or VIKUNJA_MCP_VAULT_KEY_FILE
```

### Logging Variables
```env
LOG_LEVEL=info                    # error, warn, info, debug
DEBUG=false                       # true/false
NODE_ENV=production              # development, test, production
```

### Rate Limiting Variables
```env
# Global control
RATE_LIMIT_ENABLED=true

# Default tool limits
RATE_LIMIT_PER_MINUTE=60
RATE_LIMIT_PER_HOUR=1000
MAX_REQUEST_SIZE=1048576          # 1MB in bytes
MAX_RESPONSE_SIZE=10485760        # 10MB in bytes
TOOL_TIMEOUT=30000               # 30 seconds in milliseconds

# Expensive tool limits
EXPENSIVE_RATE_LIMIT_PER_MINUTE=10
EXPENSIVE_RATE_LIMIT_PER_HOUR=100
EXPENSIVE_MAX_REQUEST_SIZE=2097152
EXPENSIVE_MAX_RESPONSE_SIZE=52428800
EXPENSIVE_TOOL_TIMEOUT=120000

# Bulk operation limits
BULK_RATE_LIMIT_PER_MINUTE=5
BULK_RATE_LIMIT_PER_HOUR=50
BULK_MAX_REQUEST_SIZE=5242880
BULK_MAX_RESPONSE_SIZE=104857600
BULK_TOOL_TIMEOUT=300000

# Export operation limits
EXPORT_RATE_LIMIT_PER_MINUTE=2
EXPORT_RATE_LIMIT_PER_HOUR=10
EXPORT_MAX_REQUEST_SIZE=1048576
EXPORT_MAX_RESPONSE_SIZE=1073741824
EXPORT_TOOL_TIMEOUT=600000
```

### Feature Flag Variables
```env
VIKUNJA_ENABLE_SERVER_SIDE_FILTERING=true
```

### Response Verbosity Variable
```env
VIKUNJA_RESPONSE_VERBOSITY=standard   # optional, default standard; see Default Response Verbosity
```

## Usage Patterns

### Application Initialization

```typescript
import { ConfigurationManager, getConfiguration } from './config';

async function initializeApplication() {
  try {
    // Load and validate configuration early
    const config = await getConfiguration();
    
    // Use validated configuration
    if (config.auth.vikunjaUrl && config.auth.vikunjaToken) {
      await connectToVikunja(config.auth.vikunjaUrl, config.auth.vikunjaToken);
    }
    
    // Configure components
    const logger = await createLogger(config.logging);
    const rateLimiter = await createRateLimiter(config.rateLimiting);
    
  } catch (error) {
    console.error('Configuration error:', error);
    process.exit(1);
  }
}
```

### Component Configuration

```typescript
// Before: Direct environment usage
export class RateLimitingMiddleware {
  constructor() {
    this.requestsPerMinute = parseInt(process.env.RATE_LIMIT_PER_MINUTE || '60', 10);
    this.enabled = process.env.RATE_LIMIT_ENABLED !== 'false';
  }
}

// After: Configuration injection
export class RateLimitingMiddleware {
  constructor(private config: RateLimitConfig) {
    // Configuration already validated and typed
  }
  
  static async create(): Promise<RateLimitingMiddleware> {
    const config = await getRateLimitConfig();
    return new RateLimitingMiddleware(config);
  }
}
```

### Feature Flag Checks

```typescript
// Simple boolean check
if (await isFeatureEnabled('enableServerSideFiltering')) {
  return useServerSideStrategy();
} else {
  return useClientSideStrategy();
}

// Configuration-dependent logic
const featureFlags = await getFeatureFlagsConfig();
const strategy = featureFlags.enableServerSideFiltering ? 
  'server-side' : 'client-side';
```

## Testing with Configuration

### Test Configuration Injection

```typescript
import { ConfigurationManager } from '../src/config';

describe('RateLimitingMiddleware', () => {
  beforeEach(() => {
    // Reset singleton for clean test state
    ConfigurationManager.reset();
  });

  it('should respect custom rate limits', async () => {
    // Inject test configuration
    const manager = ConfigurationManager.getInstance({
      sources: {
        rateLimiting: {
          enabled: true,
          default: {
            requestsPerMinute: 5,  // Very low for testing
            requestsPerHour: 50,
            maxRequestSize: 1000,
            maxResponseSize: 10000,
            executionTimeout: 5000,
          }
        }
      }
    });
    
    const config = await manager.getRateLimitConfig();
    expect(config.default.requestsPerMinute).toBe(5);
  });
});
```

### Environment-Specific Testing

```typescript
// Test development profile behavior
it('should disable rate limiting in development', async () => {
  const manager = ConfigurationManager.getInstance({
    environment: Environment.DEVELOPMENT
  });
  
  const config = await manager.getRateLimitConfig();
  expect(config.enabled).toBe(false);
});

// Test validation errors
it('should reject invalid configuration', async () => {
  const manager = ConfigurationManager.getInstance({
    sources: {
      rateLimiting: {
        default: {
          requestsPerMinute: -1  // Invalid negative value
        }
      }
    }
  });
  
  await expect(manager.getConfiguration()).rejects.toThrow(ConfigurationError);
});
```

## Error Handling

### Configuration Errors

The system provides detailed validation errors:

```typescript
try {
  const config = await getConfiguration();
} catch (error) {
  if (error instanceof ConfigurationError) {
    console.error('Configuration validation failed:');
    console.error(`Field: ${error.field}`);
    console.error(`Message: ${error.message}`);
    console.error(`Value: ${error.value}`);
  }
}
```

### Common Error Scenarios

1. **Invalid URL Format**
   ```text
   Configuration error in validation: Configuration validation failed:
     - auth.vikunjaUrl: Invalid url
   ```

2. **Negative Rate Limits**
   ```text
   Configuration error in validation: Configuration validation failed:
     - rateLimiting.default.requestsPerMinute: Number must be greater than 0
   ```

3. **Invalid Log Level**
   ```text
   Configuration error in validation: Configuration validation failed:
     - logging.level: Invalid enum value. Expected 'error' | 'warn' | 'info' | 'debug', received 'verbose'
   ```

## Migration from Legacy Configuration

### Step 1: Update Imports
```typescript
// Before
const maxSize = parseInt(process.env.MAX_REQUEST_SIZE || '1048576', 10);

// After
import { getRateLimitConfig } from './config';
const config = await getRateLimitConfig();
const maxSize = config.default.maxRequestSize;
```

### Step 2: Handle Async Configuration
```typescript
// Before: Synchronous constructor
class Logger {
  constructor() {
    this.level = process.env.LOG_LEVEL || 'info';
  }
}

// After: Async factory
class Logger {
  constructor(private config: LoggingConfig) {}
  
  static async create(): Promise<Logger> {
    const config = await getLoggingConfig();
    return new Logger(config);
  }
}
```

### Step 3: Update Tests
```typescript
// Before: Environment manipulation
beforeEach(() => {
  process.env.RATE_LIMIT_PER_MINUTE = '30';
});

// After: Configuration injection
beforeEach(() => {
  ConfigurationManager.reset();
  ConfigurationManager.getInstance({
    sources: { rateLimiting: { default: { requestsPerMinute: 30 } } }
  });
});
```

## Performance Considerations

### Configuration Caching
- Configuration is loaded once and cached per ConfigurationManager instance
- Subsequent calls to `getConfiguration()` return cached values
- Use `ConfigurationManager.reset()` to clear cache (testing only)

### Memory Usage
- Configuration schemas use minimal memory overhead
- Zod validation occurs only during initial load
- No performance impact on application runtime

### Startup Performance
- Configuration loading adds ~1-5ms to application startup
- All validation errors are caught early in startup process
- Async loading prevents blocking main application logic

## Best Practices

### 1. Load Configuration Early
```typescript
// Good: Load configuration at application startup
async function main() {
  const config = await getConfiguration();
  // Initialize components with configuration
}

// Avoid: Loading configuration in hot paths
async function handleRequest() {
  const config = await getConfiguration(); // Cache hit, but still async
  // Handle request
}
```

### 2. Use Type-Safe Configuration
```typescript
// Good: Use typed configuration sections
const rateLimits = await getRateLimitConfig();
const limit = rateLimits.default.requestsPerMinute; // TypeScript knows this is number

// Avoid: Accessing nested properties without types
const config = await getConfiguration();
const limit = (config as any).rateLimiting.default.requestsPerMinute;
```

### 3. Handle Configuration Errors Gracefully
```typescript
// Good: Specific error handling
try {
  const config = await getConfiguration();
} catch (error) {
  if (error instanceof ConfigurationError) {
    logger.error('Configuration validation failed', { error: error.message });
    process.exit(1);
  }
  throw error; // Re-throw unexpected errors
}

// Avoid: Generic error handling
try {
  const config = await getConfiguration();
} catch (error) {
  console.error('Something went wrong:', error);
}
```

### 4. Test with Configuration Injection
```typescript
// Good: Inject test configuration
const testManager = ConfigurationManager.getInstance({
  sources: { /* test configuration */ }
});

// Avoid: Manipulating process.env in tests
process.env.RATE_LIMIT_PER_MINUTE = '30';
```

## Troubleshooting

### Common Issues

1. **Configuration Not Loading**
   - Check that `getConfiguration()` is awaited
   - Verify environment variables are set correctly
   - Check for validation errors in logs

2. **Environment Variables Not Recognized**
   - Verify variable names match `.env.example`
   - Check for typos in environment variable names
   - Ensure values are in correct format (numbers, booleans)

3. **Test Failures After Migration**
   - Reset ConfigurationManager in test setup
   - Replace environment manipulation with configuration injection
   - Update mocks to use new configuration patterns

### Debug Configuration Loading

```typescript
// Enable detailed configuration logging
const config = await ConfigurationManager.getInstance({
  sources: { logging: { level: 'debug' } }
}).getConfiguration();

// Configuration loading details will be logged
```

Every key documented here is validated once at startup against the Zod schema in `src/config/types.ts`. If this page and that schema ever disagree, trust the schema and file an issue.