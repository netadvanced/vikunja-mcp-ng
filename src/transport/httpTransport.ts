/**
 * Opt-in Streamable HTTP transport bootstrap
 * (docs/OIDC-RESOURCE-SERVER.md §2 "Modes", §3a "Streamable HTTP transport").
 *
 * `stdio` (src/index.ts's existing `StdioServerTransport` path) remains the
 * default and is untouched by this module. `http` mode is opt-in
 * (`transport=http`) and uses the SDK's `StreamableHTTPServerTransport` in
 * **stateless** mode (`sessionIdGenerator` omitted, decision D5): every
 * request is authenticated and isolated purely from its bearer token, with
 * no MCP-level session keyspace to keep aligned with the OIDC `sub`.
 *
 * A fresh `StreamableHTTPServerTransport` **and** a fresh `McpServer` are
 * built per request (via the injected `createMcpServer` factory) and torn
 * down when the response finishes. This is the SDK's required stateless
 * usage: `@modelcontextprotocol/sdk`'s stateless transport refuses to be
 * reused across requests ("Stateless transport cannot be reused across
 * requests. Create a new transport per request." — it would otherwise leak
 * message-id/response state between two different callers), and a single
 * shared `McpServer` cannot back concurrent per-request transports because
 * `server.connect()` binds exactly one transport at a time. Per-request
 * construction is what makes genuinely concurrent, per-identity-isolated
 * requests correct (§3d ALS context-integrity property).
 *
 * This module builds the transport plumbing only; it does NOT validate bearer
 * tokens itself. That is the auth middleware registered on
 * `src/transport/oidcMiddlewareSeam.ts`: the OIDC middleware
 * (src/transport/oidcHttpAuth.ts) in `oidc` auth mode, or the static
 * gateway-token middleware (src/transport/staticTokenAuth.ts,
 * docs/GATEWAY-TOKEN-MODE.md) in `token` auth mode. Per the spec's
 * deny-mixed-mode rule (§2 "Selection rule": "Any missing → hard startup
 * error"), `startHttpTransport` refuses to start whenever no middleware has
 * been registered, and refuses a non-loopback bind that lacks an explicit
 * `Host` allow-list (`bindSafetyProblems`). Never serve unauthenticated HTTP.
 *
 * **Per-request cost (item H2b, profiled 2026-07-21):** re-running
 * `registerTools()` against a fresh `McpServer` on every request — the thing
 * that looks like the obvious "runs every request now" regression this
 * per-request construction introduced — measures at mean ≈0.4–0.6ms / p95
 * <1ms for this server's full ~24-tool surface (`tests/transport/httpTransport-perf.test.ts`,
 * which doubles as a regression guard going forward). That is two to three
 * orders of magnitude below any latency budget worth optimizing for, and the
 * SDK's own stateless example (`@modelcontextprotocol/sdk`'s
 * `examples/server/simpleStatelessStreamableHttp.ts`) does the same
 * rebuild-everything-per-request thing with no caching layer of its own —
 * this is the sanctioned pattern, not a shortcut. Conclusion: **no caching
 * was added.** The only thing that could safely be cached (pre-built Zod
 * schema objects) is exactly the part Zod itself already makes cheap to
 * construct, so caching it would trade a few hundred microseconds for a new
 * way to leak state across "stateless" requests — a bad trade. The
 * genuinely expensive, safely-shared piece (`VikunjaClientFactory`) is
 * already built once at startup and reused across requests (see
 * `src/index.ts`'s `main()` — only `registerTools` itself runs per request).
 */

import * as dns from 'node:dns';
import * as http from 'node:http';
import * as net from 'node:net';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { HttpConfig, OidcConfig } from '../config/types';
import { ConfigurationError } from '../config/types';
import {
  buildProtectedResourceMetadata,
  isProtectedResourceMetadataPath,
} from './resourceMetadata';
import { getOidcAuthMiddleware } from './oidcMiddlewareSeam';
import { formatHostPort } from './hostPort';

export { formatHostPort };
import { getActiveEnrollmentService } from './enrollment';
import { getActiveVaultStore } from '../storage/vaultFileStore';
import { runWithRequestContext, takeAttachedRequestContext } from '../context/requestContext';
import { logger } from '../utils/logger';

/**
 * Builds a fully-registered `McpServer` for a single request. Called once per
 * MCP request (stateless mode requires a fresh server + transport per call);
 * production passes a factory that runs `registerTools` against the process's
 * `AuthManager`/`VikunjaClientFactory` (see `src/index.ts`).
 */
export type McpServerFactory = () => McpServer | Promise<McpServer>;

/**
 * Optional knobs for `startHttpTransport` that do not belong in `HttpConfig`
 * because they come from elsewhere in the application config or state.
 */
export interface HttpTransportOptions {
  /**
   * Request-body cap on the MCP path, in bytes; larger bodies get `413`.
   * `src/index.ts` passes `rateLimiting.default.maxRequestSize`. The SDK's
   * `StreamableHTTPServerTransport` (1.30.0) has no size option of its own,
   * so this server reads the body itself (`readBodyWithinCap`).
   */
  maxBodyBytes?: number;
  /**
   * gateway-token mode `/readyz`: whether the process-global Vikunja
   * credential is configured. Must not call Vikunja (an unauthenticated
   * probe must never trigger outbound requests, issue #373). When omitted in
   * token mode, readiness fails closed.
   */
  isCredentialConfigured?: () => boolean;
  /** Resolves the bind host for the loopback check. Defaults to the system resolver. */
  lookupHost?: HostLookup;
}

/** Default request-body cap: `rateLimiting.default.maxRequestSize`'s default (1 MiB). */
export const DEFAULT_MAX_BODY_BYTES = 1048576;

/** Handle returned by `startHttpTransport`, letting callers (and tests) shut the listener down cleanly. */
export interface HttpTransportHandle {
  readonly httpServer: http.Server;
  close(): Promise<void>;
}

/**
 * Resolve the effective `allowedHosts` list used for the SDK transport's
 * DNS-rebinding protection. When `http.allowedHosts` isn't explicitly
 * configured, defaults to the bind `host:port` pair (IPv6 literals bracketed,
 * `[::1]:8765`, the form clients send in `Host`) so the default loopback
 * binding gets working protection out of the box (§3a "Host binding /
 * DNS-rebinding stance").
 */
export function resolveAllowedHosts(httpConfig: HttpConfig): string[] {
  if (httpConfig.allowedHosts && httpConfig.allowedHosts.length > 0) {
    return httpConfig.allowedHosts;
  }
  return [formatHostPort(httpConfig.host, httpConfig.port)];
}

/** Resolves a host name to every address it maps to (the shape of `dns.promises.lookup` with `all: true`). */
export type HostLookup = (host: string) => Promise<Array<{ address: string }>>;

const lookupAllAddresses: HostLookup = (host) => dns.promises.lookup(host, { all: true });

const LOOPBACK_ADDRESSES = new net.BlockList();
LOOPBACK_ADDRESSES.addSubnet('127.0.0.0', 8, 'ipv4');
LOOPBACK_ADDRESSES.addAddress('::1', 'ipv6');

function isLoopbackAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 0) {
    return false;
  }
  // BlockList matches IPv4-mapped IPv6 (`::ffff:127.0.0.1`) against the IPv4 subnet.
  return LOOPBACK_ADDRESSES.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

/** How long the bind host lookup may take before startup fails (§4.4). */
export const BIND_LOOKUP_TIMEOUT_MS = 5000;

/** Where the listener binds, and whether that address only accepts local connections. */
export interface BindTarget {
  /** The IP literal handed to `listen()`, or `http.host` itself when it is already one. */
  listenAddress: string;
  /** Every address the host maps to is loopback (127.0.0.0/8, `::1`, `::ffff:127.x.x.x`). */
  loopback: boolean;
}

function lookupWithin(
  host: string,
  lookup: HostLookup,
  timeoutMs: number,
): Promise<Array<{ address: string }>> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer within ${timeoutMs} ms`)), timeoutMs);
  });
  // Called inside a promise so a lookup that throws synchronously still
  // settles the race and clears the timer.
  const answer = Promise.resolve().then(() => lookup(host));
  return Promise.race([answer, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Resolves `http.host` once, for both the bind-safety check and `listen()`
 * (docs/GATEWAY-TOKEN-MODE.md §4.4). An IP literal is used as is, without
 * DNS. A name such as `localhost` is looked up (all addresses) and counts as
 * loopback only when every address is loopback, because `/etc/hosts` may map
 * it to a routable address. The listener then binds the first address, the
 * one `listen(port, name)` would have picked itself, so the address that was
 * checked is the address that is bound: nothing is resolved a second time.
 * A lookup that fails, returns nothing or takes longer than `timeoutMs`
 * stops startup with a `ConfigurationError` instead of guessing.
 */
export async function resolveBindTarget(
  host: string,
  lookup: HostLookup = lookupAllAddresses,
  timeoutMs: number = BIND_LOOKUP_TIMEOUT_MS,
): Promise<BindTarget> {
  if (net.isIP(host) !== 0) {
    return { listenAddress: host, loopback: isLoopbackAddress(host) };
  }
  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookupWithin(host, lookup, timeoutMs);
  } catch (error) {
    throw unresolvedBindHost(host, error instanceof Error ? error.message : String(error));
  }
  const [first] = addresses;
  if (first === undefined) {
    throw unresolvedBindHost(host, 'no addresses');
  }
  return {
    listenAddress: first.address,
    loopback: addresses.every(({ address }) => isLoopbackAddress(address)),
  };
}

function unresolvedBindHost(host: string, reason: string): ConfigurationError {
  return new ConfigurationError(
    'http.host',
    `Could not resolve the bind host ${host}: ${reason}. Set VIKUNJA_MCP_HTTP_HOST to an ` +
      'IP address (127.0.0.1 for loopback) or a name this machine can resolve.',
  );
}

/**
 * Reasons a bind must not start (docs/GATEWAY-TOKEN-MODE.md §4.4), in every
 * auth mode. A loopback bind has no extra requirements. Anything else is
 * reachable from outside this container and needs both an auth credential
 * and an explicit `Host` allow-list: without the list, `resolveAllowedHosts`
 * falls back to the bind address itself (e.g. `0.0.0.0:8765`), a `Host`
 * header no real client sends. `loopback` comes from `resolveBindTarget`.
 * Returns an empty list when the bind is safe.
 */
export function bindSafetyProblems(
  httpConfig: HttpConfig,
  authConfigured: boolean,
  loopback: boolean,
): string[] {
  if (loopback) {
    return [];
  }
  const problems: string[] = [];
  if (!authConfigured) {
    problems.push(
      'no HTTP auth credential is configured (set VIKUNJA_MCP_HTTP_AUTH_MODE to token with ' +
        'VIKUNJA_MCP_HTTP_AUTH_TOKEN, or the VIKUNJA_MCP_OIDC_* settings)',
    );
  }
  if (!httpConfig.allowedHosts || httpConfig.allowedHosts.length === 0) {
    problems.push('VIKUNJA_MCP_HTTP_ALLOWED_HOSTS is not set');
  }
  return problems;
}

function sendJson(
  res: http.ServerResponse,
  statusCode: number,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): void {
  if (res.headersSent) {
    return;
  }
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    ...extraHeaders,
  });
  res.end(payload);
}

/**
 * Start the opt-in Streamable HTTP transport.
 *
 * Throws `ConfigurationError` (before any listener is opened) when the bind
 * is unsafe (`bindSafetyProblems`) or when no authentication middleware is
 * registered on the seam. This server must never serve unauthenticated
 * HTTP: without a middleware registered via `setOidcAuthMiddleware()` (by
 * src/transport/oidcHttpAuth.ts or src/transport/staticTokenAuth.ts), `http`
 * mode is structurally unable to start.
 */
export async function startHttpTransport(
  createMcpServer: McpServerFactory,
  httpConfig: HttpConfig,
  oidc?: Pick<OidcConfig, 'issuer' | 'jwksUri'>,
  options: HttpTransportOptions = {},
): Promise<HttpTransportHandle> {
  const authMiddleware = getOidcAuthMiddleware();

  const bindTarget = await resolveBindTarget(httpConfig.host, options.lookupHost);
  const bindProblems = bindSafetyProblems(
    httpConfig,
    authMiddleware !== undefined,
    bindTarget.loopback,
  );
  if (bindProblems.length > 0) {
    const allowListMissing = !httpConfig.allowedHosts || httpConfig.allowedHosts.length === 0;
    const fix = allowListMissing
      ? `Set VIKUNJA_MCP_HTTP_ALLOWED_HOSTS=vikunja-mcp:${httpConfig.port} (the Host ` +
        'header the gateway actually sends)'
      : 'Configure an auth scheme';
    throw new ConfigurationError(
      'http.host',
      `Refusing to listen on ${httpConfig.host}: ${bindProblems.join('; ')}. A server ` +
        'reachable from outside this container needs a Host allow-list and an auth ' +
        `credential. ${fix}, or bind to 127.0.0.1.`,
    );
  }

  if (!authMiddleware) {
    throw new ConfigurationError(
      'transport',
      'transport=http requires an authentication middleware: the OIDC ' +
        'authentication middleware (VIKUNJA_MCP_OIDC_*, docs/OIDC-RESOURCE-SERVER.md ' +
        '§3b) or the static gateway token (VIKUNJA_MCP_HTTP_AUTH_MODE set to token, with ' +
        'VIKUNJA_MCP_HTTP_AUTH_TOKEN, docs/GATEWAY-TOKEN-MODE.md). Refusing to start ' +
        'an HTTP listener without one: this server must never serve unauthenticated ' +
        'HTTP (deny-mixed-mode rule, §2 "Selection rule").',
    );
  }

  const allowedHosts = resolveAllowedHosts(httpConfig);
  const requestPath = httpConfig.path;
  const jwksReachabilityCache: JwksReachabilityCache = { settled: null, pending: null };

  const httpServer = http.createServer((req, res) => {
    handleIncomingRequest(req, res, {
      createMcpServer,
      allowedHosts,
      authMiddleware,
      requestPath,
      httpConfig,
      oidcIssuer: oidc?.issuer,
      jwksUri: oidc?.jwksUri,
      jwksReachabilityCache,
      maxBodyBytes: options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
      isCredentialConfigured: options.isCredentialConfigured ?? ((): boolean => false),
    }).catch((error) => {
      logger.error('Unhandled error while handling HTTP MCP request:', error);
      sendJson(res, 500, { error: 'internal_error' });
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      reject(error);
    };
    httpServer.once('error', onError);
    // The resolved address, never the name: resolving again here could bind
    // something other than what the check above approved.
    httpServer.listen(httpConfig.port, bindTarget.listenAddress, () => {
      httpServer.removeListener('error', onError);
      resolve();
    });
  });

  const boundTo = formatHostPort(bindTarget.listenAddress, httpConfig.port);
  const configuredAs =
    bindTarget.listenAddress === httpConfig.host ? '' : ` (http.host ${httpConfig.host})`;
  logger.info(`Vikunja MCP HTTP transport listening on ${boundTo}${requestPath}${configuredAs}`);

  return {
    httpServer,
    close: async (): Promise<void> => {
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });
    },
  };
}

/** How long `/readyz` waits for the JWKS endpoint before calling it unreachable. */
const JWKS_REACHABILITY_TIMEOUT_MS = 3000;

/**
 * How long a `/readyz` JWKS reachability result stays cached (issue #373).
 * `/readyz` is served before the JWT middleware, so it's reachable by an
 * unauthenticated caller; without a cache, every hit fanned out a fresh live
 * request to the IdP's JWKS endpoint with no throttling — amplification
 * against the IdP plus self-inflicted socket/timeout cost on this server. 5s
 * still means any real outage shows up within one or two probe cycles for a
 * typical readiness-probe cadence (Kubernetes' own default is 10s).
 */
const JWKS_REACHABILITY_CACHE_TTL_MS = 5000;

interface JwksReachabilityCacheEntry {
  result: boolean;
  expiresAt: number;
}

/**
 * Mutable box scoped to one `startHttpTransport` listener (not a module
 * global), so separate server instances — and separate tests — never share
 * cached state. Holds a settled result once a fetch completes, and/or the
 * in-flight promise while one is pending.
 */
interface JwksReachabilityCache {
  settled: JwksReachabilityCacheEntry | null;
  pending: Promise<boolean> | null;
}

/**
 * `/readyz`'s JWKS half of the §3a "Health/readiness" contract: a plain GET
 * against the configured JWKS endpoint, independent of `jose`'s own
 * `createRemoteJWKSet` cache inside the auth middleware — a readiness probe
 * should reflect whether the endpoint answers RIGHT NOW, not whether a
 * previously-cached key set is still in memory. `undefined` (no OIDC
 * configured) has nothing to check, so it reports reachable.
 *
 * Concurrent callers that arrive while a check is already in flight await
 * the SAME promise rather than each starting their own fetch. Without this,
 * the settled-result cache alone still let every request that landed during
 * the fetch's own round trip fire an independent outbound request — exactly
 * the scenario (a slow or timing-out IdP, up to `JWKS_REACHABILITY_TIMEOUT_MS`
 * per attempt) where the throttling this cache exists for matters most.
 */
async function isJwksReachable(
  jwksUri: string | undefined,
  cache: JwksReachabilityCache,
): Promise<boolean> {
  if (!jwksUri) return true;
  const now = Date.now();
  if (cache.settled !== null && cache.settled.expiresAt > now) {
    return cache.settled.result;
  }
  if (cache.pending !== null) {
    return cache.pending;
  }
  const pending = (async (): Promise<boolean> => {
    let result: boolean;
    try {
      const response = await fetch(jwksUri, {
        method: 'GET',
        signal: AbortSignal.timeout(JWKS_REACHABILITY_TIMEOUT_MS),
      });
      result = response.ok;
    } catch {
      result = false;
    }
    cache.settled = { result, expiresAt: Date.now() + JWKS_REACHABILITY_CACHE_TTL_MS };
    cache.pending = null;
    return result;
  })();
  cache.pending = pending;
  return pending;
}

interface RequestHandlerContext {
  createMcpServer: McpServerFactory;
  allowedHosts: string[];
  authMiddleware: NonNullable<ReturnType<typeof getOidcAuthMiddleware>>;
  requestPath: string;
  httpConfig: HttpConfig;
  oidcIssuer: string | undefined;
  jwksUri: string | undefined;
  jwksReachabilityCache: JwksReachabilityCache;
  maxBodyBytes: number;
  isCredentialConfigured: () => boolean;
}

/** Outcome of reading a request body under the cap. */
type BodyReadResult =
  { status: 'ok'; body: Buffer } | { status: 'too_large' } | { status: 'aborted' };

/**
 * Request-body cap for the MCP path (docs/GATEWAY-TOKEN-MODE.md §4.1).
 * Reads the whole body before the SDK sees the request, counting every
 * byte whatever the framing, and stops at the cap. A declared
 * `Content-Length` over the cap is refused without reading at all. The
 * caller hands the SDK the parsed body (`handleRequest`'s `parsedBody`
 * argument), so the SDK never reads the stream and the cap does not depend
 * on how it would have. `aborted` means the client went away mid-body.
 *
 * Settles exactly once, and removes its listeners when it does. `end`
 * decides `ok`; a `close` or `error` before it is an abort. On a complete
 * body Node emits `close` only after `end` (the request auto-destroys once
 * it ends; checked on Node 22 and 25). The one way `close` comes first with
 * every byte sent is Node destroying the request itself, for example on a
 * client half-close, and then the socket is gone and no answer could be
 * delivered anyway. Exported for tests.
 */
export function readBodyWithinCap(
  req: http.IncomingMessage,
  maxBodyBytes: number,
): Promise<BodyReadResult> {
  const declaredLength = req.headers['content-length'];
  if (declaredLength !== undefined && Number(declaredLength) > maxBodyBytes) {
    return Promise.resolve({ status: 'too_large' });
  }
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let received = 0;
    let settled = false;
    const settle = (result: BodyReadResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      req.removeListener('error', onAbort);
      req.removeListener('close', onAbort);
      resolve(result);
    };
    const onData = (chunk: Buffer): void => {
      received += chunk.length;
      if (received > maxBodyBytes) {
        settle({ status: 'too_large' });
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = (): void => settle({ status: 'ok', body: Buffer.concat(chunks) });
    const onAbort = (): void => settle({ status: 'aborted' });
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onAbort);
    req.on('close', onAbort);
    // A request destroyed before this point (the client left while
    // authentication ran) emits no further events. Checked after the
    // listeners are attached, so no `close` can fall between the check and
    // the listener that would have seen it.
    if (req.destroyed) {
      settle({ status: 'aborted' });
    }
  });
}

/**
 * The body as the SDK's `parsedBody`. Text that is not JSON is passed as
 * the raw string, which the SDK rejects as `400` / `-32700` after its own
 * `Accept` and `Content-Type` checks, the same order it uses when it reads
 * the body itself.
 */
function parseJsonBody(body: Buffer): unknown {
  // TextDecoder strips a leading byte order mark, as the SDK's `req.json()` does.
  const text = new TextDecoder().decode(body);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

async function handleIncomingRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: RequestHandlerContext,
): Promise<void> {
  const rawUrl = req.url ?? '/';
  const queryIndex = rawUrl.indexOf('?');
  const pathname = queryIndex === -1 ? rawUrl : rawUrl.slice(0, queryIndex);

  // Health/readiness sit outside the MCP path and the JWT middleware
  // entirely (§3a "Health/readiness") — liveness never touches the vault or
  // Vikunja, so it stays reachable even for an unauthenticated caller.
  if (req.method === 'GET' && pathname === '/healthz') {
    sendJson(res, 200, { status: 'ok' });
    return;
  }
  if (req.method === 'GET' && pathname === '/readyz') {
    // gateway-token mode has no vault and no JWKS: it is ready when the
    // operator's process-global Vikunja credential is configured. Never
    // calls Vikunja from here (unauthenticated probe, issue #373).
    if (ctx.httpConfig.authMode === 'token') {
      if (ctx.isCredentialConfigured()) {
        sendJson(res, 200, { status: 'ok' });
      } else {
        sendJson(res, 503, { status: 'not_ready', checks: { credential: 'missing' } });
      }
      return;
    }
    const vault = getActiveVaultStore();
    // A vault degraded load (#266 — unreadable/malformed file) means writes
    // are refused and reads may be silently incomplete; §3a is explicit that
    // this deserves operator visibility here rather than looking ready.
    // Missing vault entirely is treated the same way: oidc-http mode always
    // provisions one before the listener opens, so its absence at request
    // time is itself a not-ready signal, not a "nothing to check" no-op.
    const vaultOk = vault !== undefined && !vault.isDegraded();
    const jwksOk = await isJwksReachable(ctx.jwksUri, ctx.jwksReachabilityCache);
    if (vaultOk && jwksOk) {
      sendJson(res, 200, { status: 'ok' });
    } else {
      sendJson(res, 503, {
        status: 'not_ready',
        checks: { vault: vaultOk ? 'ok' : 'degraded', jwks: jwksOk ? 'ok' : 'unreachable' },
      });
    }
    return;
  }

  // RFC 9728 Protected Resource Metadata (MCP authorization spec, 2025-06-18
  // revision): unauthenticated, GET-only, read-only, side-effect-free — like
  // /healthz, it sits before the MCP path and the JWT middleware, because a
  // client fetches it precisely when it does NOT have a token yet. Both the
  // bare well-known path and the path-suffixed variant (`.../mcp` for our
  // `/mcp` resource) are served. Only available when an OIDC issuer is
  // configured — there is nothing truthful to advertise otherwise.
  if (ctx.oidcIssuer !== undefined && isProtectedResourceMetadataPath(pathname, ctx.requestPath)) {
    if (req.method !== 'GET') {
      sendJson(res, 405, { error: 'method_not_allowed' }, { Allow: 'GET' });
      return;
    }
    sendJson(
      res,
      200,
      buildProtectedResourceMetadata(ctx.httpConfig, ctx.oidcIssuer, req, ctx.allowedHosts),
    );
    return;
  }

  // One-click SSO enrollment endpoints (issue #220, docs/OIDC-SETUP.md §9a):
  // `GET /enroll` + `GET /enroll/callback`. Like the metadata endpoints
  // above, they sit BEFORE the bearer-token middleware by necessity — the
  // user's browser holds no MCP bearer token; the short-lived, single-use,
  // identity-bound enrollment ticket (minted by an *authenticated*
  // `vikunja_auth provision` call) is the authentication on this path. Only
  // routed when production wiring registered an enrollment service
  // (`setActiveEnrollmentService`, src/transport/enrollment.ts) — otherwise
  // these paths fall through to the 404 below, indistinguishable from any
  // other unknown path.
  const enrollmentService = getActiveEnrollmentService();
  if (enrollmentService && enrollmentService.servesPath(pathname)) {
    // Defense-in-depth Host allowlisting (finding #11): the SDK transport
    // enforces `allowedHosts` on the MCP path; the enrollment endpoints get
    // the same check so a DNS-rebinding page against a non-loopback bind
    // cannot drive them either.
    const hostHeader = req.headers.host;
    if (typeof hostHeader !== 'string' || !ctx.allowedHosts.includes(hostHeader)) {
      sendJson(res, 403, { error: 'forbidden_host' });
      return;
    }
    if (await enrollmentService.handleRequest(req, res)) {
      return;
    }
  }

  if (pathname !== ctx.requestPath) {
    sendJson(res, 404, { error: 'not_found' });
    return;
  }

  let authorized: boolean;
  try {
    authorized = await ctx.authMiddleware(req, res);
  } catch (error) {
    logger.warn('HTTP authentication middleware threw unexpectedly:', error);
    sendJson(res, 401, { error: 'invalid_token' });
    return;
  }

  if (!authorized) {
    // Middleware already wrote the 401/403 response; nothing more to do.
    return;
  }

  // Only authenticated callers get this far, so an unauthenticated caller
  // always sees 401, never 413.
  const bodyRead = await readBodyWithinCap(req, ctx.maxBodyBytes);
  if (bodyRead.status === 'too_large') {
    // `Connection: close` makes Node close the socket once the 413 is
    // written, even while the client is still sending (measured on Node 22
    // and 25; the tests pin it).
    sendJson(res, 413, { error: 'payload_too_large' }, { Connection: 'close' });
    return;
  }
  if (bodyRead.status === 'aborted') {
    return;
  }
  // Only POST carries JSON-RPC messages; the SDK reads no body for GET or DELETE.
  const parsedBody = req.method === 'POST' ? parseJsonBody(bodyRead.body) : undefined;

  // Fresh transport + server per request (stateless mode requires it — see
  // the module header). `sessionIdGenerator` is deliberately omitted (not
  // set to `undefined`) to satisfy `exactOptionalPropertyTypes`.
  const transport = new StreamableHTTPServerTransport({
    enableDnsRebindingProtection: true,
    allowedHosts: ctx.allowedHosts,
  });

  // If the auth middleware attached a per-identity `RequestContext` (the
  // OIDC HTTP-auth middleware does — src/transport/oidcHttpAuth.ts), open the
  // ALS scope around BOTH building this request's server and handling the
  // request, so every tool call, and every await it spawns, resolves
  // credentials/rate-limit/storage keys for *this* caller
  // (docs/OIDC-RESOURCE-SERVER.md §3d, D6). The seam's boolean-returning
  // middleware cannot hold the scope open itself — it returns before this
  // point — so the scope is opened here, the one place that actually drives
  // `handleRequest`. A middleware that attaches nothing (a generic seam, or a
  // test stub) runs with no scope, exactly as before — keeping the seam
  // transport-agnostic.
  //
  // The server factory is deliberately INSIDE the scope (#270): it runs
  // `registerTools`, whose JWT-only gate must reflect the calling identity's
  // vaulted credential, not the process-global one. Built outside the scope
  // (as it was), an operator's legacy `VIKUNJA_API_TOKEN` env credential
  // decided the deny-by-default tool list for every caller.
  const requestContext = takeAttachedRequestContext(req);
  const serveRequest = async (): Promise<void> => {
    const mcpServer = await ctx.createMcpServer();
    try {
      // Cast through `Transport`: the SDK's own `StreamableHTTPServerTransport`
      // does not perfectly satisfy its own `Transport` interface under
      // `exactOptionalPropertyTypes: true` — a pre-existing SDK type quirk, not
      // a functional mismatch (see other `as unknown as` casts in this codebase
      // for the same accommodation pattern).
      await mcpServer.connect(transport as unknown as Transport);
      await transport.handleRequest(req, res, parsedBody);
    } finally {
      // Tear down this request's server. `handleRequest` has already fully
      // written the response (including any SSE stream) by the time it
      // resolves, so closing here never truncates a reply.
      await mcpServer.close().catch(() => undefined);
    }
  };

  try {
    if (requestContext) {
      await runWithRequestContext(requestContext, serveRequest);
    } else {
      await serveRequest();
    }
  } finally {
    await transport.close().catch(() => undefined);
  }
}
