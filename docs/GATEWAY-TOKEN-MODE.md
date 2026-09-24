# Design: `gateway-token` HTTP auth mode (single-user, static bearer)

**Status:** accepted, implemented (2026-09-24, branch `feat/gateway-token-mode`).
Written 2026-09-24 as a handoff document for an implementer picking this up cold; the
operator's answers to the open questions are recorded in §10, and what the
implementation found along the way is in §10.1.
**Audience:** whoever maintains the mode, plus the operator (§10 records their answers).
**Companions:** [`OIDC-RESOURCE-SERVER.md`](OIDC-RESOURCE-SERVER.md) (the design this
extends), [`CONTEXT-FORGE.md`](CONTEXT-FORGE.md) (the gateway deployment guide this
amends), [`CONFIGURATION.md`](CONFIGURATION.md) (the config surface this adds to).

> **Naming/location note.** This repo keeps design documents as undated
> `docs/SCREAMING-KEBAB.md` (`OIDC-RESOURCE-SERVER.md`, `STORAGE.md`,
> `RATE_LIMITING.md`); only `docs/audits/` uses dated filenames. This file follows the
> design-doc convention rather than inventing a dated one.

---

## 0. Read this first: the premise of the request was stale

The task that produced this document asked for "a Streamable HTTP transport, because
`vikunja-mcp-ng` today speaks stdio only."

**That is no longer true.** A Streamable HTTP transport already exists and shipped in
`0.7.0`:

- `src/transport/httpTransport.ts`: `startHttpTransport()`, a real
  `StreamableHTTPServerTransport` on a single configurable path (`/mcp` by default).
- `src/index.ts`: `main()` branches on `appConfig.transport === 'http'`.
- `src/config/types.ts`: `TransportModeSchema = z.enum(['stdio', 'http'])`,
  `HttpConfigSchema`, `OidcConfigSchema`, `VaultConfigSchema`, `EnrollConfigSchema`.
- `docs/CONTEXT-FORGE.md`: an end-to-end deployment guide for **IBM MCP Context Forge**,
  walked against a real Context Forge + Keycloak + Vikunja deployment on 2026-08-11.
- `tests/transport/`, `tests/oidc/`, `scripts/oidc-e2e.ts`: the test lanes for it.

Legacy HTTP+SSE was never built and remains out of scope here too.

So the remaining gap is **not** the transport. It is the **authentication scheme bolted
to it**: `http` mode is OIDC-or-nothing. `startHttpTransport()` throws
`ConfigurationError` before opening a listener when no middleware is registered on
`src/transport/oidcMiddlewareSeam.ts`, and `src/index.ts` only ever registers one when
`appConfig.oidc` is present. There is no way to run this server over HTTP with a plain
shared secret.

**This document specifies that missing piece**, sized for the actual deployment: one
container, one gateway, one human.

---

## 1. Goal and non-goals

### Goal

Add a second authentication scheme to the **existing** `transport=http` mode (a static
bearer token shared between the gateway and this server, `gateway-token` mode) so the
server can be federated by a Context Forge instance that has no OIDC relationship with
it, using the single process-global Vikunja credential that `stdio` mode already uses.

### Non-goals

- **Legacy HTTP+SSE** (`GET /sse` + `POST /message`, MCP revision 2024-11-05). Explicitly
  rejected by the operator; the SDK's Streamable HTTP transport (revision 2025-03-26+)
  already covers every client in play, and a second deprecated transport doubles the
  auth surface for nothing.
- **Replacing or weakening `oidc-http` mode.** It stays the default and the recommended
  mode for multi-user hosting. Nothing in `src/auth/oidc/`, `src/storage/vaultFileStore.ts`
  or `src/transport/enrollment.ts` changes behaviour.
- **Multi-user anything in token mode.** One token, one identity, one Vikunja credential.
  A deployment that needs per-user isolation uses `oidc-http`, which already does it.
- **Changing `stdio` mode.** The hard invariant from `docs/OIDC-RESOURCE-SERVER.md` §2
  holds: stdio stays byte-for-byte unchanged (`tests/index.test.ts`, the
  "Transport Mode Selection (main()) — H1a opt-in HTTP transport" suite guards the
  branch point).

---

## 2. Motivation and deployment context

The server will be federated behind an **IBM Context Forge** MCP gateway running in the
operator's data centre (`mcpgw` stack, Docker Swarm, VM 103). Context Forge federates
peers over HTTP; a stdio-only peer cannot be registered at all, and an OIDC-only peer
cannot be registered without an IdP relationship that this deployment does not have.

Once the token scheme exists:

- `vikunja-mcp-ng` runs as a container on the gateway's private overlay network
  (`10.123.0.0/24`), listening on `0.0.0.0:8765` **inside that overlay only**.
- Its tools surface publicly through one allowlisted path on `tools.neosark.io`, behind
  Authentik SSO: the gateway's front door, not this server's.
- **The gateway is the only client.** There is no direct public exposure of this server,
  no browser client, and no second consumer.
- Exactly **one human** is served by this instance.

That last fact drives most of §5.

`docs/CONTEXT-FORGE.md`'s existing registration recipe still applies verbatim except for
the auth column: `transport: STREAMABLEHTTP`, upstream URL `http://<service>:8765/mcp`,
health check `/healthz`, and the `TOOL_DESCRIPTION_FORBIDDEN_PATTERNS` note about
silently-dropped tools (`vikunja_filters`, whose description contains `&&` and `||`). In token mode the registration becomes the *simple*
Context Forge case: `authType: bearer` with a **fixed** `authToken`, `oneTimeAuth: false`,
and **no** `passthroughHeaders`. The gateway calls the upstream with its own credential,
which is exactly the behaviour `CONTEXT-FORGE.md` warns against for multi-user OIDC and
is exactly what is wanted here.

---

## 3. Current state (what exists today, by file)

### 3.1 stdio

`src/index.ts` at module load:

- constructs one module-level `McpServer({ name: 'vikunja-mcp-ng', version: resolvePackageVersion(__dirname) })`;
- constructs one `AuthManager`;
- `initializeFactory()` → `createVikunjaClientFactory(authManager)` → `setGlobalClientFactory(...)`,
  exported as `factoryInitializationPromise`, which then calls `registerTools(server, authManager, clientFactory)`;
- reads `VIKUNJA_API_TOKEN` through `readSecretEnv()` (`src/config/secrets.ts`, which
  enforces the `*_FILE` convention and hard-errors when both forms are set);
- if `process.env.VIKUNJA_URL` and that token are both present, calls
  `authManager.connect(url, token)`, the single process-global credential;
- `main()` then does `await server.connect(new StdioServerTransport())`.

No ALS scope is ever opened in stdio mode (`src/context/requestContext.ts` documents this
as an invariant, not an accident).

### 3.2 http (as shipped: OIDC only)

`main()` in `src/index.ts`:

```
if (appConfig.transport === 'http') {
  if (appConfig.oidc) {
    await setupOidcHttpAuth(appConfig.oidc, appConfig.vault, appConfig.http);
    setupEnrollment(appConfig.enroll, appConfig.http, appConfig.auth.vikunjaUrl);
  }
  await startHttpTransport(() => { ...fresh McpServer + registerTools... },
                           appConfig.http, appConfig.oidc);
}
```

`startHttpTransport()` (`src/transport/httpTransport.ts`):

- calls `getOidcAuthMiddleware()` (`src/transport/oidcMiddlewareSeam.ts`) and **throws
  `ConfigurationError` synchronously, before `listen()`**, when nothing is registered.
  This is the deny-mixed-mode rule: never serve unauthenticated HTTP.
- `resolveAllowedHosts(httpConfig)` → `http.allowedHosts` when set, else
  `[`${host}:${port}`]`.
- routes, in order: `GET /healthz` → `200 {status:'ok'}`; `GET /readyz` → vault-degraded
  + JWKS-reachability checks (`isJwksReachable`, 3 s timeout, 5 s cache, single-flight);
  RFC 9728 protected-resource metadata (only when `oidc.issuer` is set); `/enroll*`
  (only when an enrollment service is registered, with its own `Host` allowlist check
  returning `403 {error:'forbidden_host'}`); then `pathname !== httpConfig.path` → `404`.
- on the MCP path: `await ctx.authMiddleware(req, res)`; a `false` return means the
  middleware already wrote 401/403.
- then, **per request**, `new StreamableHTTPServerTransport({ enableDnsRebindingProtection: true, allowedHosts })`
  with `sessionIdGenerator` deliberately omitted (**stateless**, decision D5), plus a
  fresh `McpServer` from the injected `McpServerFactory`, `server.connect(transport)`,
  `transport.handleRequest(req, res)`, then `mcpServer.close()` and `transport.close()`.
  The per-request `registerTools()` cost is profiled at mean ≈0.4–0.6 ms / p95 <1 ms in
  `tests/transport/httpTransport-perf.test.ts`.
- if the middleware attached a `RequestContext`
  (`takeAttachedRequestContext(req)` / `attachRequestContext`, `src/context/requestContext.ts`),
  the whole factory-plus-handle sequence runs inside `runWithRequestContext(...)` so ALS
  resolves per-identity credentials. **A middleware that attaches nothing runs with no
  scope, exactly as stdio does**: the seam is deliberately transport-agnostic and its
  own doc comment says so. That is the hook this design uses.

### 3.3 The auth seam

`src/transport/oidcMiddlewareSeam.ts` exports:

```ts
export type OidcAuthMiddleware = (req: HttpRequestWithAuth, res: ServerResponse) => Promise<boolean>;
export function setOidcAuthMiddleware(m: OidcAuthMiddleware | undefined): void;
export function getOidcAuthMiddleware(): OidcAuthMiddleware | undefined;
```

It is already scheme-neutral in everything but its name. `src/transport/oidcHttpAuth.ts`'s
`createOidcHttpAuthMiddleware(deps)` / `setupOidcHttpAuth(...)` is the one registrant today.

### 3.4 Config

`src/config/ConfigurationManager.ts` maps env → config
(`assignEnvValue(result, 'transport', process.env.VIKUNJA_MCP_TRANSPORT, false)`,
`VIKUNJA_MCP_HTTP_{HOST,PORT,PATH,PUBLIC_URL,ALLOWED_HOSTS}`, `VIKUNJA_MCP_OIDC_*`,
`VIKUNJA_MCP_VAULT_PATH`, `VIKUNJA_MCP_ENROLL_*`), Zod-validates against
`ApplicationConfigSchema`, and caches. Layering is `defaults → vikunja-mcp.config.json → env (env wins)`.
`ApplicationConfigSchema` already carries a `.superRefine(...)` cross-field block (for
`enroll.enabled`), the pattern to copy.
`SENSITIVE_ENV_VARS` in `src/config/secrets.ts` is `['VIKUNJA_API_TOKEN', 'VIKUNJA_MCP_VAULT_KEY']`.

### 3.5 Docker

The root `Dockerfile` is stdio-shaped and says so in a comment:
`# No EXPOSE — this is a stdio MCP server, not a network listener.` The OIDC work never
updated it. This is a real gap for a containerised gateway deployment (§6).

---

## 4. The design

### 4.1 What to carry over from `mcp-swiss-ng`, and what not to

Reference implementation read: `/Users/pierre/Projects/mcp-swiss`:
`src/http-server.ts` (`startHttpServer`, `tokenMatches`, `publicBindProblems`,
`defaultAllowedHosts`, `isLoopbackBind`), `src/index.ts` (`main()`'s `config.http`
branch), `src/config.ts` (`parseArgs`), `Dockerfile`, README §"Remote access (Streamable HTTP)".

| mcp-swiss-ng behaviour | Carry over? | Decision for this repo |
|---|---|---|
| `--http` flag / `MCP_TRANSPORT=http` | **Renamed** | `VIKUNJA_MCP_TRANSPORT=http` already exists and is the only switch. This repo has **no CLI flag parser at all**: `src/index.ts` reads config, never `process.argv`. Do not add one; adding `--http`/`--port`/`--host` would introduce a fourth config layer outside `ConfigurationManager`'s documented `defaults → file → env` precedence. |
| `--port`/`PORT` default 3000 | **Renamed** | `VIKUNJA_MCP_HTTP_PORT`, default **8765** (shipped, documented in `CONFIGURATION.md` and `CONTEXT-FORGE.md`). Do not change it to 3000. |
| `--host`/`HOST` default `127.0.0.1` | **Yes, already** | `HttpConfigSchema.host` defaults to `127.0.0.1` for the same fail-closed reason. |
| `MCP_AUTH_TOKEN` bearer check on `/mcp` | **Yes, renamed** | `VIKUNJA_MCP_HTTP_AUTH_TOKEN` / `..._FILE`, added to `SENSITIVE_ENV_VARS`. The `MCP_*` prefix would be the only non-`VIKUNJA_MCP_*` variable in the server's surface. |
| `tokenMatches()`: sha256 both sides, then `timingSafeEqual` | **Yes, verbatim in spirit** | Hashing first is what stops `timingSafeEqual`'s length-mismatch throw/early-return from leaking the secret's length. Reimplement in `src/transport/staticTokenAuth.ts` with the same comment. |
| `MCP_ALLOWED_HOSTS` Host allowlist | **Yes, already** | `VIKUNJA_MCP_HTTP_ALLOWED_HOSTS` → `resolveAllowedHosts()` → the SDK's `enableDnsRebindingProtection`. Already always-on in `http` mode. |
| Refuse-to-start on a non-loopback bind without token **and** allowlist (`publicBindProblems`) | **Yes, this is the main import** | §4.4. This repo's existing refuse-to-start rule only covers "no middleware registered"; it does not cover "bound to `0.0.0.0` with a default `allowedHosts` of `0.0.0.0:8765`", which is a real hole once a non-OIDC scheme exists. |
| Per-session server instances keyed by `Mcp-Session-Id` | **No** | Decision **D5** (`OIDC-RESOURCE-SERVER.md`) locked this transport as **stateless**; its revisit condition is "a future feature needs server-initiated push". Nothing here does. Going stateful means re-running the §3d per-identity isolation matrix and maintaining a second tenancy keyspace. Keep `sessionIdGenerator` omitted. |
| Idle (30 min) + absolute (8 h) session expiry, `openStreams` sweeper | **No** | Consequence of the above: there are no sessions to expire. |
| Max-session cap → `429` | **No** | Same. The equivalent backpressure here is the existing per-identity limiter (`src/middleware/simplified-rate-limit.ts`) plus the shared circuit breakers (`src/utils/retry.ts`, decision D3). |
| Request-body size cap → `413` | **Yes, but not by copying the code** | mcp-swiss-ng can cap cheaply because it pre-reads the body itself (`readJsonBody`, `MAX_BODY_BYTES = 1_000_000`) and passes the parsed value to `handleRequest(req, res, body)`. This repo's `httpTransport.ts` hands the raw `req` to `transport.handleRequest(req, res)` and lets the SDK parse. **Implementer must first check whether `@modelcontextprotocol/sdk` ^1.29.0's `StreamableHTTPServerTransportOptions` already exposes a body-size limit and use it if so**; only if it does not, add a `Content-Length` precheck plus a streaming byte counter in front of `handleRequest`. Do not restructure the transport to pre-read bodies just to get a cap. Reuse the existing `rateLimiting.default.maxRequestSize` default (1048576) rather than inventing a new number. |
| `GET /health` | **No, name collision** | This repo already serves `GET /healthz` (liveness) and `GET /readyz` (readiness), both unauthenticated and both documented in `CONTEXT-FORGE.md` and `OIDC-SETUP.md` §11 as the gateway's probe targets. Adding `/health` would create a third spelling. Keep `/healthz`. |
| `exposeSessionCount` on a loopback bind only | **No** | No sessions to count. |
| `MCP_CORS_ORIGIN` | **No (recommend against)** | The only client is a server-side gateway; there is no browser origin. CORS headers on an endpoint reachable only from an overlay network buy nothing and add a misconfiguration path (`Access-Control-Allow-Origin: *` on a token-authenticated endpoint is a foot-gun). If the operator later wants a browser client, add it then, as `VIKUNJA_MCP_HTTP_CORS_ORIGIN`, defaulting to unset. Confirmed not needed (§10, decision 6); not built. |
| `SIGINT`/`SIGTERM` → `close()` + `closeAllConnections()` | **Yes** | `HttpTransportHandle.close()` already exists but nothing calls it; `main()` returns and leaves the listener running with no signal handling. In a Swarm container a clean `SIGTERM` shutdown is worth the four lines. Small, separable, do it in the same PR. |

### 4.2 Config surface

All new keys go through `ApplicationConfigSchema` / `ConfigurationManager` like everything
else, with no ad-hoc `process.env` reads in the transport.

| Concern | Config key | Env var | Default |
|---|---|---|---|
| HTTP auth scheme | `http.authMode` | `VIKUNJA_MCP_HTTP_AUTH_MODE` | `oidc` |
| Static bearer token | *(never in the config file)* | `VIKUNJA_MCP_HTTP_AUTH_TOKEN` / `VIKUNJA_MCP_HTTP_AUTH_TOKEN_FILE` | none |

`HttpAuthModeSchema = z.enum(['oidc', 'token']).default('oidc')`.

**Explicit, not inferred.** Do not "use token mode if `oidc` is absent": that is exactly
the silent downgrade `OIDC-RESOURCE-SERVER.md` §2's selection rule forbids. An operator
who fat-fingers `VIKUNJA_MCP_OIDC_ISSUER` must get a startup error, not a quietly weaker
server.

The token is a secret, so it rides `readSecretEnv()` and gets added to
`SENSITIVE_ENV_VARS` (`src/config/secrets.ts`), which gives it the `*_FILE` Docker-secrets
convention and the both-forms-set hard error for free. Like the vault key, it is **never**
a config-file key.

Cross-field validation, in the existing `.superRefine` block in `src/config/types.ts`:

- `http.authMode === 'token'` and `transport !== 'http'` → error (meaningless under stdio).
- `http.authMode === 'token'` and `oidc` present → error. Refuse the ambiguity rather than
  picking a winner.
- `http.authMode === 'token'` and `enroll.enabled` → error (enrollment mints per-identity
  vault records; there are no identities here). Note the existing `enroll` refinement
  already requires `oidc`, so this is belt-and-braces.
- `http.authMode === 'token'` and `vault.path` set → error (implemented as an error,
  not a warning). There is no vault in token mode; a configured-but-ignored vault path is how
  an operator loses data they thought was being written.

The token's *presence* is checked at startup, not in the schema (it is read from env via
`readSecretEnv`, not through Zod); see §4.4.

### 4.3 Transport lifecycle and the middleware

New file `src/transport/staticTokenAuth.ts`, sibling to `oidcHttpAuth.ts`:

```ts
export function createStaticTokenAuthMiddleware(deps: { token: string }): OidcAuthMiddleware;
export function setupStaticTokenAuth(token: string): void;  // wraps setOidcAuthMiddleware
```

The middleware:

1. reads `req.headers.authorization`, strips a case-insensitive `Bearer ` prefix;
2. compares via the sha256-then-`timingSafeEqual` helper;
3. on mismatch or absence: write `401 {"error":"invalid_token"}` with a bare
   `WWW-Authenticate: Bearer` header, and return `false`. The body and headers are
   byte-identical for every token-mode failure (as in §4.6). This is deliberately
   **not** the OIDC middleware's response, which adds an `error_description` and a
   parameterised challenge (`src/transport/oidcHttpAuth.ts`): a static token has no
   expiry or scope to describe, so any extra field could only leak which check failed.
   **Never** say which check failed (`tests/oidc/threat-model.test.ts` is the
   precedent);
4. on match: attach **nothing** (no `RequestContext`, no `req.auth`) and return `true`.

Attaching nothing is the whole trick. `httpTransport.ts` already does:

```ts
const requestContext = takeAttachedRequestContext(req);
... requestContext ? await runWithRequestContext(requestContext, serveRequest) : await serveRequest();
```

so with no context attached, no ALS scope opens, and every downstream accessor
(`resolveIdentityAuthManager`, `getEffectiveAuthType`, `getEffectiveSessionId`,
`resolveEffectiveAuthManager` in `src/utils/vikunja-rest.ts`) falls back to the
process-global `AuthManager`: **the exact code path stdio uses**. Token mode is
therefore "stdio's credential model, reached over HTTP", with zero new isolation surface
to get wrong. No changes to `src/context/requestContext.ts` are needed or wanted.

Wiring in `src/index.ts`'s `main()`, inside the existing `transport === 'http'` branch:

```
if (appConfig.http.authMode === 'token') {
  setupStaticTokenAuth(<token from readSecretEnv>);   // no vault, no enrollment
} else if (appConfig.oidc) {
  await setupOidcHttpAuth(...); setupEnrollment(...);
}
await startHttpTransport(factory, appConfig.http, appConfig.oidc);
```

`startHttpTransport`'s existing "no middleware → `ConfigurationError`" guard stays exactly
as it is and now covers both schemes. Its error message mentions OIDC specifically and
should be generalised.

`startHttpTransport`'s third argument stays `appConfig.oidc` (i.e. `undefined` in token
mode), which already makes the RFC 9728 protected-resource metadata endpoints 404.
`isProtectedResourceMetadataPath` is only consulted when `ctx.oidcIssuer !== undefined`.
Correct: there is no authorization server to advertise.

The per-request `McpServer` factory is unchanged. It still runs `registerTools()` per
request; in token mode `registerTools` sees the process-global `AuthManager`, so the
JWT-only tool gate (`users`/`export`/`admin`/`caldavTokens`) resolves from
`VIKUNJA_API_TOKEN`'s detected type, same as stdio.

### 4.4 The refuse-to-start rule

Port `publicBindProblems()` from mcp-swiss-ng (`src/http-server.ts`) as
`bindSafetyProblems()` in `src/transport/httpTransport.ts`, evaluated **before**
`httpServer.listen()`, throwing `ConfigurationError` (the repo's existing startup-failure
type; `src/index.ts`'s top-level `main().catch()` already logs and `process.exit(1)`s).

Rules, in `http` mode, regardless of `authMode`:

- bind host is loopback → no extra requirements. An IP literal counts when it is in
  `127.0.0.0/8`, `::1` or `::ffff:127.0.0.0/104`. A name such as `localhost` is resolved
  first (`listen()` binds whatever it resolves to) and counts only when **every** address
  it resolves to is loopback; a name that does not resolve does not count;
- bind host is anything else → **both** of:
  - an auth credential is configured (`http.authMode === 'oidc'` with a complete `oidc`
    block, **or** `authMode === 'token'` with a non-empty token), **and**
  - `http.allowedHosts` is **explicitly** set and non-empty.

The second half matters more than it looks. `resolveAllowedHosts()` currently defaults to
`[`${host}:${port}`]`, so a `0.0.0.0` bind today yields an allowlist of literally
`0.0.0.0:8765`, a `Host` header no real client sends, which means either the deployment
is broken or someone will "fix" it by widening the list blindly. Demanding an explicit
list on a non-loopback bind turns that into a startup error with a message that says what
to set. The message should name the variables, the way mcp-swiss-ng's does:

> Refusing to listen on 0.0.0.0: VIKUNJA_MCP_HTTP_ALLOWED_HOSTS is not set. A server
> reachable from outside this container needs a Host allow-list and an auth credential.
> Set VIKUNJA_MCP_HTTP_ALLOWED_HOSTS=vikunja-mcp:8765 (the Host header the gateway
> actually sends), or bind to 127.0.0.1.

A minimum token length (e.g. 32 chars) should also be enforced at startup; `authToken=x`
is not a defensible configuration on a network-reachable bind.

### 4.5 Health and readiness: the one real behaviour change

`/healthz` is unconditional and unchanged.

`/readyz` **breaks in token mode as currently written**:

```ts
const vault = getActiveVaultStore();
const vaultOk = vault !== undefined && !vault.isDegraded();
```

Token mode never provisions a vault, so `getActiveVaultStore()` returns `undefined` and
`/readyz` would return `503 {checks:{vault:'degraded'}}` forever, and Context Forge
registrations that probe readiness would never go healthy. Fix: make the checks
mode-aware.

- `authMode === 'oidc'`: unchanged (vault + JWKS).
- `authMode === 'token'`: JWKS is irrelevant (`isJwksReachable(undefined, …)` already
  returns `true`), the vault is irrelevant. Report `200` when a Vikunja credential is
  configured (`authManager.isAuthenticated()`), `503 {checks:{credential:'missing'}}`
  otherwise. Do **not** make `/readyz` call Vikunja: it is unauthenticated and would
  become a free outbound-request amplifier, the exact problem issue #373 fixed for JWKS.

### 4.6 Errors

| Condition | Response |
|---|---|
| Missing/wrong bearer on the MCP path | `401 {"error":"invalid_token"}` + `WWW-Authenticate: Bearer`, reason logged at `warn` server-side only |
| `Host` header not in the allowlist | `403`, from the SDK's DNS-rebinding protection on the MCP path (`Invalid Host header`), and `403 {"error":"forbidden_host"}` from the transport's own check on non-MCP paths |
| Unknown path | `404 {"error":"not_found"}` (existing) |
| Body over the cap | `413` (§4.1) |
| Unhandled handler throw | `500 {"error":"internal_error"}` (existing) |

No new error taxonomy. Tool-level errors are unchanged: they are `MCPError`/AORP
payloads inside a `200`, as in stdio.

---

## 5. The credential question, and the recommendation

**The question.** `mcp-swiss-ng` is a stateless public-data server: its bearer token is
pure access control, and there is no downstream credential at all. `vikunja-mcp-ng` is
stateful against a Vikunja instance and must present a real Vikunja credential (`tk_*`
API token or `eyJ*` JWT) on every upstream call. So a bearer token on `/mcp` raises a
question `mcp-swiss-ng` never had to answer: **does that token carry a Vikunja identity,
and if not, whose Vikunja credential gets used?**

Three options, for the record.

**(A) Static gateway token + single process-global Vikunja credential.**
`VIKUNJA_MCP_HTTP_AUTH_TOKEN` authenticates *the gateway*, full stop. It carries no
identity. The Vikunja credential is the existing `VIKUNJA_URL` + `VIKUNJA_API_TOKEN[_FILE]`
pair that `src/index.ts` already auto-connects. No ALS scope, no vault, no per-request
identity. Every request runs as one Vikunja user.

**(B) The bearer token *is* the Vikunja token** (pass-through: client sends its `tk_*`
as the MCP bearer, server connects with it per request).
Tempting because it needs no vault, but it is the worst of the three. It would mean
accepting an arbitrary caller-supplied credential and forwarding it upstream, i.e. this
server becomes a credential-laundering proxy for anyone who reaches the port; it destroys
the constant-time comparison (there is no expected value to compare against, so the check
degenerates to "does Vikunja accept it"); it makes every `401` a live Vikunja round-trip
(an unauthenticated DoS amplifier against the upstream); and it would require opening a
per-request ALS scope with a synthesised identity, reintroducing exactly the isolation
surface D5/D6 were designed to bound. It also contradicts `OIDC-RESOURCE-SERVER.md`'s
central sentence (*a token that authenticates a person is not a Vikunja credential*) by
conflating the two in the other direction.

**(C) Multiple static tokens, each mapped to a vaulted Vikunja credential.**
A poor-man's multi-tenancy: token → identity → vault lookup. This is `oidc-http` mode with
a hand-rolled, non-expiring, non-revocable IdP. If the deployment ever needs more than one
user, the correct answer is to configure `oidc-http` against a real issuer (the code is
already written, tested and documented), not to grow a second identity system.

### Recommendation: **(A)**, unambiguously.

One deployed instance serves exactly one user via the gateway. The simplest correct
answer is the right one here, and it is worth saying plainly: **token mode is stdio's
credential model reached over HTTP.** Concretely:

1. `VIKUNJA_MCP_HTTP_AUTH_TOKEN` is a **transport-level shared secret between the gateway
   and this container**. It is not a user identity and must never be treated as one. The
   code enforces this structurally by attaching no `RequestContext` (§4.3), so there is
   no identity for anything downstream to read even if someone later tries.
2. The Vikunja credential is `VIKUNJA_URL` + `VIKUNJA_API_TOKEN[_FILE]`, exactly as in
   stdio. In token mode these are **required**, not optional: `main()` must refuse to
   start `http`+`token` without an authenticated `AuthManager`, because every request
   would otherwise return `AUTH_REQUIRED` and the failure would look like a gateway
   problem. (Note the inversion versus `oidc-http`, where `CONTEXT-FORGE.md` says
   *"Do not set `VIKUNJA_API_TOKEN`"*. Both docs must state the rule for their own mode.)
3. `vikunja_auth provision` / `status` / `deprovision` are vault operations and have no
   meaning here. They must return a clear structured error in token mode ("no credential
   vault in this mode; the server's credential is configured by the operator"), not throw
   and not silently no-op. `vikunja_auth connect` and `disconnect` are disabled in the
   same way, because they would repoint or clear the one server-wide credential for every
   caller (§10, decision 5).
4. **Safe default: refuse.** Absent explicit configuration, `http` mode stays OIDC-only
   and a non-loopback bind stays refused (§4.4). Token mode is opt-in twice over
   (`VIKUNJA_MCP_TRANSPORT=http` **and** `VIKUNJA_MCP_HTTP_AUTH_MODE=token`) and still
   refuses without a token of adequate length and an explicit `allowedHosts` list.
5. **Document the blast radius in one sentence**, in both `CONFIGURATION.md` and
   `CONTEXT-FORGE.md`: *anyone holding the static token can do anything the configured
   Vikunja token can do*. That is acceptable precisely because the token's only holder is
   a gateway on a private overlay, and the instance serves one person. It stops being
   acceptable the moment a second user appears, at which point the migration is to
   `oidc-http`, not to option (C).
6. **Strongly recommend pairing token mode with `VIKUNJA_MCP_READ_ONLY=true`** in the
   deployment docs unless the operator explicitly wants writes. `src/utils/read-only.ts`
   already rejects every write/destructive subcommand at dispatch, and it is the cheapest
   way to bound the blast radius above.

---

## 6. Files expected to change

**New**

| Path | Contents |
|---|---|
| `src/transport/staticTokenAuth.ts` | `createStaticTokenAuthMiddleware`, `setupStaticTokenAuth`, the sha256+`timingSafeEqual` comparison helper |
| `tests/transport/staticTokenAuth.test.ts` | Unit tests, mirroring `tests/transport/oidcHttpAuth.test.ts` |
| `tests/transport/staticTokenAuth-threat-model.test.ts` | Negative/abuse cases (§7), or add a `describe` block to the file above; mirror the shape of `tests/oidc/threat-model.test.ts` |
| `scripts/token-e2e.ts` | Real-process e2e lane, sibling of `scripts/oidc-e2e.ts` |
| `docs/GATEWAY-TOKEN-MODE.md` | This document (already written) |

**Modified**

| Path | Change |
|---|---|
| `src/config/types.ts` | `HttpAuthModeSchema`; `authMode` on `HttpConfigSchema`; new `.superRefine` rules (§4.2) |
| `src/config/ConfigurationManager.ts` | `assignEnvValue(http, 'authMode', process.env.VIKUNJA_MCP_HTTP_AUTH_MODE, false)`; include `authMode` in the `transport === 'http'` summary log at ~line 771 |
| `src/config/secrets.ts` | Add `VIKUNJA_MCP_HTTP_AUTH_TOKEN` to `SENSITIVE_ENV_VARS` |
| `src/index.ts` | `main()` branch on `http.authMode`; read the token via `readSecretEnv`; require an authenticated `AuthManager` in token mode; `SIGINT`/`SIGTERM` → `handle.close()` |
| `src/transport/httpTransport.ts` | `bindSafetyProblems()` + the pre-`listen()` check; generalise the "no middleware" error message; mode-aware `/readyz`; body-size cap (§4.1) |
| `src/transport/oidcMiddlewareSeam.ts` | Doc-comment only: record that a second, non-OIDC scheme now registers here. Consider `TransportAuthMiddleware` as an exported alias; **do not rename the existing exports** (`tests/transport/oidcMiddlewareSeam.test.ts` and `oidcHttpAuth.ts` depend on them and the churn buys nothing) |
| `Dockerfile` | Replace the `# No EXPOSE — this is a stdio MCP server` comment; add `EXPOSE 8765` and an http-mode `docker run` example |
| `docker-compose.example.yml` | Add (or add a sibling for) an http/token-mode service with a `/healthz` healthcheck |
| `package.json` | `"test:e2e:token": "tsx scripts/token-e2e.ts"` |
| `docs/CONFIGURATION.md` | §"Transport Mode (opt-in HTTP)…" (~line 531): new `authMode` subsection + correct the "requires ALL of the `oidc` block AND a vault" sentence, which becomes mode-conditional. §"Transport Variables" (~line 978): the two new env vars |
| `docs/CONTEXT-FORGE.md` | New section: single-user token registration (`authType: bearer`, fixed `authToken`, `oneTimeAuth: false`, **no** `passthroughHeaders`), and a one-line "which mode do I want?" chooser at the top |
| `docs/OIDC-RESOURCE-SERVER.md` | Append an amendment under §2 "Modes": a Mode C row, and restate the selection rule as *never serve unauthenticated HTTP* rather than *always OIDC*. Do not rewrite the locked decision log; add a dated amendment, matching how the 2026-08-11 and 2026-09-01 amendments were recorded |
| `README.md` | §Docker / §Safety: one paragraph plus a link here |
| `CHANGELOG.md` | `[Unreleased]` entry (§8) |
| `jest.config.js` | Only if honest coverage rises: raise the ratchet in lockstep (§7) |

---

## 7. Testing requirements

Nothing ships until `npm run lint && npm run test:coverage && npm run typecheck` is green
(CLAUDE.md, "Pre-Commit Requirements"). `typecheck` covers both `tsconfig.json` and
`tsconfig.scripts.json`, so `scripts/token-e2e.ts` is type-gated too.

### 7.1 Unit lane (jest, `npm run test`)

`tests/transport/staticTokenAuth.test.ts` must cover:

- correct token → `true`, response untouched, **no `RequestContext` attached**
  (assert `takeAttachedRequestContext(req) === undefined`; this is the isolation-by-
  construction property from §4.3 and is the single most important assertion in the file);
- missing header, empty header, `Basic …`, bare token without the `Bearer ` prefix,
  `bearer ` lower-case (must be accepted), leading/trailing whitespace;
- wrong token of the **same** length and of a **different** length → both `401`, and the
  `401` body is byte-identical in both cases;
- `WWW-Authenticate: Bearer` present on every `401`;
- the response body never contains the expected token, any prefix of it, or a reason code.

`tests/transport/httpTransport.test.ts` (extend):

- token-mode middleware registered → listener starts, `POST /mcp` with the right bearer
  reaches the MCP layer;
- `bindSafetyProblems()`: loopback bind with no token → starts; `0.0.0.0` with a token but
  no explicit `allowedHosts` → `ConfigurationError`, no listener opened; `0.0.0.0` with
  neither → `ConfigurationError` naming both; `0.0.0.0` with both → starts;
- token shorter than the minimum → `ConfigurationError`;
- `/healthz` unauthenticated → `200`;
- `/readyz` in token mode with a connected `AuthManager` → `200`; without → `503` with
  `checks.credential`;
- `/readyz` in **oidc** mode still behaves exactly as before (regression);
- `/.well-known/oauth-protected-resource…` → `404` in token mode;
- `/enroll` → `404` in token mode;
- body over the cap → `413`.

`tests/config/ConfigurationManager.test.ts` (extend): env→config mapping for
`VIKUNJA_MCP_HTTP_AUTH_MODE`; each `.superRefine` rejection (`token`+`stdio`,
`token`+`oidc`, `token`+`enroll.enabled`, `token`+`vault.path`); config-file value
overridden by env.

`tests/index.test.ts` (extend the existing
`"Transport Mode Selection (main()) — H1a opt-in HTTP transport"` suite): `http`+`token`
registers the static middleware and **not** `setupOidcHttpAuth`/`setupEnrollment`;
`http`+`token` without a Vikunja credential refuses to start; and (non-negotiable) the
existing stdio-invariant assertions still pass untouched.

`tests/oidc/isolation.test.ts`: add one case proving that with no ALS scope open (token
mode) `resolveIdentityAuthManager()` returns the process-global manager, i.e. token mode
cannot accidentally read another identity's state because there are none.

### 7.2 Coverage gate

`jest.config.js` thresholds are a **ratchet**: branches 86.56 / functions 85.03 /
lines 94.31 / statements 94.47, sitting ~1 point under honest coverage. New code must not
drag honest coverage down, and if it rises, raise the thresholds in the same PR with the
same buffer and a dated comment: that is the documented practice in the file. CLAUDE.md's
**defensive-programming rule** applies in full: every `|| ''`, every `?? undefined`, every
early return in the new middleware needs a test that actually reaches it, or it comes out.

### 7.3 e2e lane

`scripts/token-e2e.ts` + `"test:e2e:token"`, modelled directly on `scripts/oidc-e2e.ts`
(read it before writing this: it is the template for spawning `dist/index.js` as a real
child process and driving it over real HTTP):

1. `npm run build`;
2. spawn `dist/index.js` with `VIKUNJA_MCP_TRANSPORT=http`,
   `VIKUNJA_MCP_HTTP_AUTH_MODE=token`, a generated token, loopback bind, and
   `VIKUNJA_URL`/`VIKUNJA_API_TOKEN` pointing at the local stack (`npm run e2e:up`,
   `docs/LOCAL-TESTING.md`);
3. unauthenticated `POST /mcp` → `401`;
4. wrong token → `401`, identical body;
5. correct token → `initialize` succeeds, `tools/list` returns the expected surface;
6. a **real** tool call (`vikunja_projects list`) hits the real local Vikunja and returns
   real data, the step that proves the process-global credential is actually on the wire;
7. `vikunja_auth status` returns the token-mode explanation, not a vault lookup;
8. `GET /healthz` → `200`, `GET /readyz` → `200`;
9. clean `SIGTERM` shutdown.

Everything loopback-only, same as `oidc-e2e.ts`: nothing may touch a real Vikunja
instance (`docs/LOCAL-TESTING.md` §"Safety: never touches a real Vikunja instance").

### 7.4 Version matrix

`npm run test:matrix` runs six targets (three versions × two DB backends) derived from
`SUPPORTED_VERSIONS = ['2.4.0','2.5.0','2.6.0']` in `scripts/lib/e2e-target.ts`
(`DEFAULT_TARGET = '2.6.0-postgres'`, `FLOOR_VERSION = '2.4.0'`). This change is a
transport/auth concern and touches nothing version-dependent, so **no new matrix lane is
required**, but the reviewer should confirm the matrix is still green, and
`test:e2e:token` should be run at least against `DEFAULT_TARGET` and once against
`FLOOR_VERSION`.

### 7.5 Ship gate

Before this can ship: §7.1 and §7.2 fully green; §7.3 run by hand and its output pasted
into the PR; §7.4 confirmed green; the §9 acceptance list executed command by command.

---

## 8. Documentation and release steps

1. **Branch.** Feature branch off `dev`, never a direct `main` commit (CLAUDE.md,
   "Repository Configuration"). Feature work targets the **`dev`/beta channel**;
   `main` only takes `patch`/`minor` (`docs/RELEASING.md` §1, `scripts/release-prepare.sh`
   header).
2. **Docs in the same PR.** The repo requires documentation updates on every PR. The list
   is §6's "Modified" rows for `docs/`, `README.md`, `Dockerfile`,
   `docker-compose.example.yml`.
3. **CHANGELOG.md.** Add under `[Unreleased]`. Conventional-commit subjects matter:
   `scripts/release-prepare.sh` drafts the changelog section *from* the commits, so use
   `feat(transport): …`, `docs(transport): …`, `test(transport): …`.
4. **Do not bump the version by hand.** `scripts/release-prepare.sh prerelease` (on `dev`,
   `--preid` defaults to `beta`) does the `npm version` bump, the changelog draft and the
   `release/vX.Y.Z` branch, after running the full gate suite. `npm run test:release-prepare`
   covers the script's own helpers. Then curate the changelog, open the release PR, merge,
   run `scripts/release-tag.sh`, and let the tag-triggered workflow
   (`.github/workflows/release.yml`) publish; the npm dist-tag and GHCR channel are read
   off the tag's version string. Full ladder: `docs/RELEASING.md` §2, including the
   mandatory Step 4 pre-tag verification checklist.
5. **`server.json`** is version-synced by the release tooling
   (`scripts/lib/sync-server-json.test.sh` guards it); check it after the bump rather than
   editing it by hand.
6. **`package.json` `files`** currently publishes `docs/CONFIGURATION.md`, `docs/TOOLS.md`
   and `docs/DOCKER-DESKTOP-MCP.md` to npm. Decide whether `GATEWAY-TOKEN-MODE.md` joins
   that list; the analogous `CONTEXT-FORGE.md` and `OIDC-SETUP.md` are not in it, so the
   default answer is no.

---

## 9. Acceptance criteria

Mechanically checkable. Each line is a command plus the expected result.

**Build and gates**
1. `npm run lint` → exit 0.
2. `npm run typecheck` → exit 0 (both tsconfigs).
3. `npm run test:coverage` → exit 0, thresholds not lowered relative to the current
   86.56 / 85.03 / 94.31 / 94.47.

**Default-path invariance**
4. `git diff` on `src/context/requestContext.ts` → empty.
5. `jest tests/index.test.ts -t "stdio"` → all pass, with no edits to those assertions
   in the diff.
6. `npm run test:e2e:mcp` (stdio lane) → same verdict as before the change.

**Refuse-to-start**
7. `VIKUNJA_MCP_TRANSPORT=http VIKUNJA_MCP_HTTP_AUTH_MODE=token node dist/index.js` with
   no token → exit 1, stderr names `VIKUNJA_MCP_HTTP_AUTH_TOKEN`, **no port bound**
   (verify with `ss`/`lsof`).
8. Same plus a token, `VIKUNJA_MCP_HTTP_HOST=0.0.0.0`, no `VIKUNJA_MCP_HTTP_ALLOWED_HOSTS`
   → exit 1, stderr names `VIKUNJA_MCP_HTTP_ALLOWED_HOSTS`, no port bound.
9. Same plus an explicit `VIKUNJA_MCP_HTTP_ALLOWED_HOSTS` → listener starts.
10. `VIKUNJA_MCP_HTTP_AUTH_MODE=token` with `VIKUNJA_MCP_OIDC_ISSUER` also set → exit 1
    with a config-validation error naming the conflict.
11. `VIKUNJA_MCP_HTTP_AUTH_MODE=token` with `VIKUNJA_MCP_TRANSPORT=stdio` → exit 1.
12. `VIKUNJA_MCP_HTTP_AUTH_MODE=token` with no `VIKUNJA_API_TOKEN` → exit 1.

**Wire behaviour** (server running in token mode on loopback)
13. `curl -si localhost:8765/mcp -X POST …` with no `Authorization` → `401`, header
    `WWW-Authenticate: Bearer`.
14. Same with a wrong token → `401`, body byte-identical to #13.
15. Same with the right token → a valid JSON-RPC `initialize` result.
16. `tools/call` `vikunja_projects list` with the right token → real data from the local
    e2e Vikunja.
17. `curl -s localhost:8765/healthz` → `200 {"status":"ok"}` with no `Authorization`.
18. `curl -s localhost:8765/readyz` → `200`; with `VIKUNJA_API_TOKEN` cleared → `503`
    with a `checks` breakdown.
19. `curl -s localhost:8765/.well-known/oauth-protected-resource` → `404`.
20. `curl -s localhost:8765/enroll` → `404`.
21. A request with a `Host` header outside the allowlist → `403`.
22. A `POST /mcp` body over the cap → `413`.
23. Response to any `401` contains neither the configured token nor a failure reason
    (`grep` the body).

**No regression to `oidc-http`**
24. `npm run test:e2e:oidc` → same verdict as before the change.
25. `jest tests/oidc tests/transport` → all pass.

**Gateway reality**
26. Registering the running container in the operator's Context Forge reports
    `"reachable": true` and an **empty** `skippedTools` array, and a tool call routed
    through the gateway returns real Vikunja data.

---

## 10. Resolved decisions (2026-09-24)

The operator answered the open questions before implementation started:

1. **Is this work needed?** Yes. Build gateway-token mode as specified (option A, §5).
2. **Token rotation:** a single token value, no list. A Swarm service update is already a
   restart.
3. **Read-only:** not forced in code. `CONFIGURATION.md` and `CONTEXT-FORGE.md` strongly
   recommend `VIKUNJA_MCP_READ_ONLY=true` for the gateway deployment.
4. **Module gating:** no changes to the defaults.
5. **`vikunja_auth connect` in token mode:** disabled, like `provision`, `status` and
   `deprovision`. They return a structured `NOT_IMPLEMENTED` error explaining that the
   server's Vikunja credential is configured by the operator in this mode. `disconnect`
   is disabled too: it would clear the process-global credential and the global client
   factory for every caller. `info` and `refresh` only read the operator's credential and
   stay available.
6. **CORS:** not needed (no browser client). Not built.
7. **Vikunja credential type:** the operator's choice. `CONTEXT-FORGE.md` documents the
   consequence: a `tk_*` token hides the JWT-only tools from the gateway's catalog, an
   `eyJ*` JWT shows them but expires within hours.

### 10.1 Implementation notes

- **Body-size cap (§4.1).** `@modelcontextprotocol/sdk` 1.30.0 (the installed version)
  has no body-size option on `StreamableHTTPServerTransportOptions`; its web-standard
  transport reads the body with an unbounded `req.json()`. So after authentication the
  server reads the body itself (`readBodyWithinCap`): a declared `Content-Length` over
  the cap is refused without reading, and otherwise every byte is counted as it arrives,
  whatever the framing, until the body ends or the count passes the cap. Over the cap,
  the answer is `413 {"error":"payload_too_large"}` with `Connection: close`, the MCP
  server is never built and the SDK never sees the request. Under the cap, a POST body
  is handed to the SDK as `handleRequest(req, res, parsedBody)`, the SDK's documented
  pre-parsed body argument, so the SDK never reads the stream. Text that is not JSON is
  passed as the raw string, which the SDK answers with `400` / `-32700` after its own
  `Accept` and `Content-Type` checks, as before. GET and DELETE carry no JSON-RPC body
  and get no `parsedBody`.

  This replaces the first implementation, which hooked a byte counter onto the SDK's
  own `data` listener (via `newListener`) and dropped any message the SDK still parsed
  after a `413`. Independent review pointed out that the cap then depended on how the
  SDK happens to read the body: a reader that uses async iteration or a web stream never
  attaches `data`, and the cap silently disappears. A unit test now stubs the SDK with
  such a reader and requires the `413`. §4.1 advised against pre-reading only to avoid
  restructuring for its own sake; robustness is a reason. The pre-read also removed the
  `ERR_HTTP_HEADERS_SENT` line `@hono/node-server` printed to stderr for every over-cap
  chunked request, since the SDK no longer runs for one.

  The same review suspected a Content-Length `413` left the socket open until
  `requestTimeout`. Measured with a raw socket that declares 1 GB and keeps trickling,
  on Node 22.23 (`node:22-alpine`) and 25.9: the `413` arrives and Node closes the
  socket within 10 ms, because of `Connection: close`. Duplicate, list-valued, negative
  or non-numeric `Content-Length`, and `Content-Length` together with
  `Transfer-Encoding`, are all rejected with `400` by Node's parser before this server
  sees the request. Tests pin the socket close for both framings.
- **Bind safety (§4.4) applies to oidc mode too.** The documented OIDC examples bind
  `127.0.0.1` or set an explicit allow-list, so none of them breaks. An oidc deployment
  binding `0.0.0.0` without `VIKUNJA_MCP_HTTP_ALLOWED_HOSTS` now fails at startup instead
  of answering every request with `403`; the CHANGELOG calls this out.
- **Loopback is decided by address, not by spelling.** `localhost` used to count as
  loopback because of its name. If `/etc/hosts` (or a container `extra_hosts`) maps it to
  a routable address, `listen()` binds that address while bind safety skipped the
  allow-list; this was reproduced in a `node:22-alpine` container with `localhost` mapped
  to its own `172.17.0.x` address (found in independent review). `bindSafetyProblems()`
  is now async and resolves the bind host (`dns.lookup` with `all: true`) before
  `listen()`; IP literals are still classified without DNS.
- **"Loopback bind with no token → starts" (§7.1)** is read as "bind safety adds no
  requirement on loopback". A listener still never starts without an auth middleware.
- **§9 item 18's second half** (`/readyz` → `503` with `VIKUNJA_API_TOKEN` cleared) cannot
  happen in a running server: item 12 refuses to start without the credential, and
  `disconnect` is disabled. The `503 {checks:{credential:'missing'}}` path is covered by
  unit tests instead.
- **Startup order in token mode:** the gateway token is checked before the Vikunja
  credential, so item 7 names `VIKUNJA_MCP_HTTP_AUTH_TOKEN` even when both are missing.
- `startHttpTransport` takes an optional 4th `options` argument (`maxBodyBytes`,
  `isCredentialConfigured`) rather than reading application config itself.
- **Token plus an incomplete OIDC block (§9 item 10).** Zod skips `superRefine` when the
  `oidc` block itself fails to parse, so with only `VIKUNJA_MCP_OIDC_ISSUER` set the
  conflict was hidden behind "oidc.audience: Invalid input". `ConfigurationManager`
  now also reports the conflict from the raw config in that case (once, deduplicated).
- **Startup messages and the log sanitizer.** `src/utils/security.ts` masks the value of
  any `NAME=value` or `NAME: value` pair whose name looks sensitive, which turned
  "`VIKUNJA_MCP_HTTP_AUTH_MODE=token` requires..." into "[REDACTED] [REDACTED]". The
  messages therefore say "VIKUNJA_MCP_HTTP_AUTH_MODE set to token", and the token-mode
  startup errors use `http.authMode` as their `ConfigurationError` field.
- The default loopback allow-list is only `127.0.0.1:<port>` (unchanged), so a local
  `curl localhost:8765/mcp` gets `403 Invalid Host header`; use `127.0.0.1`.

## 11. Future: Context Forge per-user credentials

Verified against IBM Context Forge v1.0.10, which the operator runs:

- Context Forge 1.0.6+ can resolve **per-user credentials from HashiCorp Vault** for
  `bearer`, `basic` and `authheaders` gateways (PR IBM/mcp-context-forge#5651). It reads
  `{mount}/data/{prefix}/{team}/{server-hash}/{email}`, field `headers`, as a
  `{header: value}` dict. Enabled by `OAUTH_TOKEN_BACKEND=vault`, `VAULT_ADDR` and
  `VAULT_TOKEN`, optionally `VAULT_KV_MOUNT` and `VAULT_KV_PATH_PREFIX`.
- Context Forge only **reads** these records. It has no UI or API to write them; an
  external system must `vault kv put` them.
- In `tool_service.py` the per-user headers **replace** the gateway-wide static auth
  (`headers = vault_headers or decode_auth(...)`); they are not merged. A per-user record
  would therefore have to carry the gateway bearer too.
- Only **tool invocation** uses the per-user lookup. Discovery (`tools/list`) uses the
  static gateway auth.
- A Vault outage **fails closed**: the tool call is refused, with no fallback to the
  shared credentials.

Conclusion: a possible later mode where the gateway bearer authenticates Context Forge
and a separate per-request header (for example `X-Vikunja-Token`) carries each user's
Vikunja token. Not built now. Revisit if a second user appears and a HashiCorp Vault is
available.
