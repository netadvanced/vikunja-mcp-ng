/**
 * Tests for the opt-in Streamable HTTP transport bootstrap
 * (src/transport/httpTransport.ts).
 *
 * These are deliberately near-integration tests: a real `McpServer`, a real
 * SDK `StreamableHTTPServerTransport`, and a real `http.Server` bound to an
 * OS-assigned loopback port (port 0). This is the most faithful way to
 * verify the refuse-to-start gate, the health endpoints, the auth-seam
 * routing, and DNS-rebinding Host-header protection actually behave as
 * specified (docs/OIDC-RESOURCE-SERVER.md §3a) rather than merely mocking
 * past them.
 */

import { EventEmitter } from 'node:events';
import * as http from 'node:http';
import * as net from 'node:net';
import * as os from 'node:os';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { z } from 'zod';
import { logger } from '../../src/utils/logger';
import {
  startHttpTransport,
  resolveAllowedHosts,
  bindSafetyProblems,
  formatHostPort,
  readBodyWithinCap,
  resolveBindTarget,
  type HttpTransportHandle,
} from '../../src/transport/httpTransport';
import { setupStaticTokenAuth } from '../../src/transport/staticTokenAuth';
import {
  setOidcAuthMiddleware,
  type HttpRequestWithAuth,
} from '../../src/transport/oidcMiddlewareSeam';
import { EnrollmentService, setActiveEnrollmentService } from '../../src/transport/enrollment';
import { EnrollmentTicketStore } from '../../src/transport/enrollmentTickets';
import { setActiveVaultStore, type VaultFileStore } from '../../src/storage/vaultFileStore';
import { ConfigurationError } from '../../src/config/types';
import type { HttpConfig } from '../../src/config/types';
import { AuthManager } from '../../src/auth/AuthManager';
import {
  attachRequestContext,
  getCurrentIdentity,
  getEffectiveAuthType,
  type Identity,
} from '../../src/context/requestContext';

// Fixed, incrementing ports rather than OS-assigned port 0: the default
// `allowedHosts` derivation (`resolveAllowedHosts`) is `host:port` from
// *configured* port, so a real client's Host header must match it exactly.
// A deterministic port keeps that match correct without a listen-then-relisten
// dance to discover an OS-assigned port ahead of construction time.
let nextTestPort = 19870;
function allocatePort(): number {
  return nextTestPort++;
}

function baseHttpConfig(overrides: Partial<HttpConfig> = {}): HttpConfig {
  return {
    host: '127.0.0.1',
    port: allocatePort(),
    path: '/mcp',
    authMode: 'oidc',
    ...overrides,
  };
}

function newServer(): McpServer {
  return new McpServer({ name: 'test-server', version: '0.0.0' });
}

function getPort(handle: HttpTransportHandle): number {
  const address = handle.httpServer.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Expected an AddressInfo (TCP) address');
  }
  return address.port;
}

interface RawResponse {
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function request(
  port: number,
  options: {
    method?: string;
    path?: string;
    headers?: Record<string, string>;
    body?: string | Buffer;
  } = {},
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method: options.method ?? 'GET',
        path: options.path ?? '/mcp',
        headers: options.headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf-8'),
          });
        });
      },
    );
    req.on('error', reject);
    if (options.body !== undefined) {
      req.write(options.body);
    }
    req.end();
  });
}

describe('httpTransport', () => {
  afterEach(() => {
    setOidcAuthMiddleware(undefined);
  });

  describe('resolveAllowedHosts', () => {
    it('defaults to the bind host:port pair when unconfigured', () => {
      expect(resolveAllowedHosts(baseHttpConfig({ host: '127.0.0.1', port: 8765 }))).toEqual([
        '127.0.0.1:8765',
      ]);
    });

    it('uses the explicitly configured allowedHosts list', () => {
      expect(
        resolveAllowedHosts(baseHttpConfig({ allowedHosts: ['gateway.example.org:8765'] })),
      ).toEqual(['gateway.example.org:8765']);
    });

    it('falls back to the default when allowedHosts is an empty array', () => {
      expect(
        resolveAllowedHosts(baseHttpConfig({ host: '0.0.0.0', port: 9000, allowedHosts: [] })),
      ).toEqual(['0.0.0.0:9000']);
    });
  });

  describe('refuse-to-start (deny-mixed-mode rule)', () => {
    it('refuses to start when no OIDC middleware is registered', async () => {
      const mcpServer = newServer();

      await expect(startHttpTransport(() => mcpServer, baseHttpConfig())).rejects.toThrow(
        ConfigurationError,
      );
    });

    it('the refusal error references the OIDC middleware requirement and H1b', async () => {
      const mcpServer = newServer();

      await expect(startHttpTransport(() => mcpServer, baseHttpConfig())).rejects.toThrow(
        /OIDC authentication middleware/i,
      );
    });

    it('does not open a TCP listener when refusing to start', async () => {
      const mcpServer = newServer();
      const listenSpy = jest.spyOn(http.Server.prototype, 'listen');

      await expect(startHttpTransport(() => mcpServer, baseHttpConfig())).rejects.toThrow();
      expect(listenSpy).not.toHaveBeenCalled();

      listenSpy.mockRestore();
    });
  });

  describe('with OIDC middleware registered', () => {
    let handle: HttpTransportHandle;
    const healthyVault = { isDegraded: () => false } as unknown as VaultFileStore;

    afterEach(async () => {
      if (handle) {
        await handle.close();
      }
      setActiveVaultStore(undefined);
      jest.restoreAllMocks();
    });

    it('starts and serves /healthz unauthenticated even when the middleware would reject', async () => {
      setOidcAuthMiddleware(async () => false);
      handle = await startHttpTransport(newServer, baseHttpConfig());
      const port = getPort(handle);

      const res = await request(port, { path: '/healthz' });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ status: 'ok' });
    });

    it('serves /readyz unauthenticated, reporting ready when the vault loads clean and no JWKS is configured', async () => {
      setOidcAuthMiddleware(async () => false);
      setActiveVaultStore(healthyVault);
      handle = await startHttpTransport(newServer, baseHttpConfig());
      const port = getPort(handle);

      const res = await request(port, { path: '/readyz' });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ status: 'ok' });
    });

    it('reports /readyz not ready when no vault is active (§3a: vault file openable)', async () => {
      setOidcAuthMiddleware(async () => false);
      handle = await startHttpTransport(newServer, baseHttpConfig());
      const port = getPort(handle);

      const res = await request(port, { path: '/readyz' });

      expect(res.statusCode).toBe(503);
      expect(JSON.parse(res.body)).toEqual({
        status: 'not_ready',
        checks: { vault: 'degraded', jwks: 'ok' },
      });
    });

    it('reports /readyz not ready when the vault load is degraded (issue #266)', async () => {
      setOidcAuthMiddleware(async () => false);
      setActiveVaultStore({ isDegraded: () => true } as unknown as VaultFileStore);
      handle = await startHttpTransport(newServer, baseHttpConfig());
      const port = getPort(handle);

      const res = await request(port, { path: '/readyz' });

      expect(res.statusCode).toBe(503);
      expect(JSON.parse(res.body)).toEqual({
        status: 'not_ready',
        checks: { vault: 'degraded', jwks: 'ok' },
      });
    });

    it('reports /readyz not ready when the configured JWKS endpoint is unreachable (§3a: JWKS reachability)', async () => {
      setOidcAuthMiddleware(async () => false);
      setActiveVaultStore(healthyVault);
      jest.spyOn(global, 'fetch').mockRejectedValue(new Error('network unreachable'));
      handle = await startHttpTransport(newServer, baseHttpConfig(), {
        issuer: 'https://idp.example.test',
        jwksUri: 'https://idp.example.test/jwks',
      });
      const port = getPort(handle);

      const res = await request(port, { path: '/readyz' });

      expect(res.statusCode).toBe(503);
      expect(JSON.parse(res.body)).toEqual({
        status: 'not_ready',
        checks: { vault: 'ok', jwks: 'unreachable' },
      });
    });

    it('reports /readyz ready when the vault loads clean and the JWKS endpoint answers', async () => {
      setOidcAuthMiddleware(async () => false);
      setActiveVaultStore(healthyVault);
      jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true } as Response);
      handle = await startHttpTransport(newServer, baseHttpConfig(), {
        issuer: 'https://idp.example.test',
        jwksUri: 'https://idp.example.test/jwks',
      });
      const port = getPort(handle);

      const res = await request(port, { path: '/readyz' });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ status: 'ok' });
    });

    // Issue #373: /readyz is unauthenticated, so without a cache each hit
    // fanned out a fresh live request to the IdP's JWKS endpoint —
    // amplification against the IdP plus self-inflicted cost on this server.
    it('caches the JWKS reachability result across repeated /readyz calls (#373)', async () => {
      setOidcAuthMiddleware(async () => false);
      setActiveVaultStore(healthyVault);
      const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true } as Response);
      handle = await startHttpTransport(newServer, baseHttpConfig(), {
        issuer: 'https://idp.example.test',
        jwksUri: 'https://idp.example.test/jwks',
      });
      const port = getPort(handle);

      await request(port, { path: '/readyz' });
      await request(port, { path: '/readyz' });
      const res = await request(port, { path: '/readyz' });

      expect(res.statusCode).toBe(200);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    // Fable review follow-up on #373: the settled-result cache alone still
    // let every request that arrived WHILE a fetch was in flight fire its
    // own independent fetch — exactly the scenario (a slow/timing-out IdP)
    // where throttling matters most. Concurrent callers must coalesce onto
    // the same in-flight request instead.
    it('coalesces concurrent /readyz calls onto a single in-flight JWKS fetch (#373)', async () => {
      setOidcAuthMiddleware(async () => false);
      setActiveVaultStore(healthyVault);
      let resolveFetch: (() => void) | undefined;
      const fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveFetch = () => resolve({ ok: true } as Response);
          }),
      );
      handle = await startHttpTransport(newServer, baseHttpConfig(), {
        issuer: 'https://idp.example.test',
        jwksUri: 'https://idp.example.test/jwks',
      });
      const port = getPort(handle);

      const concurrent = Promise.all([
        request(port, { path: '/readyz' }),
        request(port, { path: '/readyz' }),
        request(port, { path: '/readyz' }),
      ]);
      try {
        // Give all three real loopback requests time to reach the
        // (still-pending) fetch call before resolving it. `finally` below
        // guarantees resolveFetch still runs if this assertion fails, so a
        // flake here doesn't leave three sockets hanging into teardown.
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(fetchSpy).toHaveBeenCalledTimes(1);
      } finally {
        resolveFetch?.();
      }
      const results = await concurrent;

      for (const res of results) {
        expect(res.statusCode).toBe(200);
      }
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('re-fetches JWKS reachability once the cache entry expires (#373)', async () => {
      setOidcAuthMiddleware(async () => false);
      setActiveVaultStore(healthyVault);
      const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true } as Response);
      const nowSpy = jest.spyOn(Date, 'now');
      nowSpy.mockReturnValue(1_000_000);
      handle = await startHttpTransport(newServer, baseHttpConfig(), {
        issuer: 'https://idp.example.test',
        jwksUri: 'https://idp.example.test/jwks',
      });
      const port = getPort(handle);

      await request(port, { path: '/readyz' });
      nowSpy.mockReturnValue(1_000_000 + 5001);
      const res = await request(port, { path: '/readyz' });

      expect(res.statusCode).toBe(200);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      nowSpy.mockRestore();
    });

    it('ignores a query string when matching routes', async () => {
      setOidcAuthMiddleware(async () => false);
      handle = await startHttpTransport(newServer, baseHttpConfig());
      const port = getPort(handle);

      const res = await request(port, { path: '/healthz?probe=1' });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ status: 'ok' });
    });

    it('404s on a path other than the configured MCP path', async () => {
      setOidcAuthMiddleware(async () => true);
      handle = await startHttpTransport(newServer, baseHttpConfig());
      const port = getPort(handle);

      const res = await request(port, { path: '/not-mcp' });

      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.body)).toEqual({ error: 'not_found' });
    });

    it('routes an authorized request through to the real SDK transport', async () => {
      let sawAuth: HttpRequestWithAuth['auth'];
      setOidcAuthMiddleware(async (req) => {
        req.auth = { token: 'x', clientId: 'test-client', scopes: [] };
        sawAuth = req.auth;
        return true;
      });
      handle = await startHttpTransport(newServer, baseHttpConfig());
      const port = getPort(handle);

      // Deliberately malformed JSON: proves the request reached the real
      // transport (which returns a JSON-RPC parse-error 400), rather than
      // being intercepted by the auth seam (401) or the path router (404).
      const res = await request(port, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: '{not valid json',
      });

      expect(res.statusCode).toBe(400);
      expect(sawAuth).toEqual({ token: 'x', clientId: 'test-client', scopes: [] });
    });

    it('does not invoke the transport when the middleware already responded (returns false)', async () => {
      setOidcAuthMiddleware(async (_req, res) => {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'custom_forbidden' }));
        return false;
      });
      handle = await startHttpTransport(newServer, baseHttpConfig());
      const port = getPort(handle);

      const res = await request(port, { method: 'POST' });

      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body)).toEqual({ error: 'custom_forbidden' });
    });

    it('returns 401 invalid_token when the middleware throws', async () => {
      setOidcAuthMiddleware(async () => {
        throw new Error('boom');
      });
      handle = await startHttpTransport(newServer, baseHttpConfig());
      const port = getPort(handle);

      const res = await request(port, { method: 'POST' });

      expect(res.statusCode).toBe(401);
      expect(JSON.parse(res.body)).toEqual({ error: 'invalid_token' });
    });

    it('rejects a request with a Host header outside allowedHosts (DNS-rebinding protection)', async () => {
      setOidcAuthMiddleware(async () => true);
      handle = await startHttpTransport(
        newServer,
        baseHttpConfig({ allowedHosts: ['127.0.0.1:1'] }), // intentionally wrong port
      );
      const port = getPort(handle);

      const res = await request(port, {
        method: 'POST',
        headers: { Host: `evil.example.com:${port}` },
      });

      expect(res.statusCode).toBe(403);
    });

    it('builds the per-request MCP server INSIDE the identity ALS scope (#270)', async () => {
      // Tool registration decides which JWT-only tools exist for this caller
      // (src/tools/index.ts). Built outside the scope, that gate could only
      // ever see the process-global manager — the deny-by-default bypass
      // #270 describes. The factory must therefore observe the caller's
      // identity and its per-identity AuthManager.
      const identity: Identity = { issuer: 'https://idp.example/realm', sub: 'caller-1' };
      const identityManager = new AuthManager();
      identityManager.connect('https://vikunja.example/api/v1', 'tk_caller-token-1234567890');
      // The mixed deployment shape: a legacy env credential (a JWT) on the
      // process-global manager alongside oidc-http.
      const globalManager = new AuthManager();
      globalManager.connect(
        'https://vikunja.example/api/v1',
        'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJvcCJ9.sig',
      );

      const observed: Array<{ sub?: string; authType?: string }> = [];
      setOidcAuthMiddleware(async (req) => {
        attachRequestContext(req, { identity, authManager: identityManager });
        return true;
      });
      handle = await startHttpTransport(() => {
        observed.push({
          sub: getCurrentIdentity()?.sub,
          authType: getEffectiveAuthType(globalManager),
        });
        return newServer();
      }, baseHttpConfig());
      const port = getPort(handle);

      await request(port, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
      });

      expect(observed).toEqual([{ sub: 'caller-1', authType: 'api-token' }]);
    });

    it('runs the server factory with no ALS scope when the middleware attaches nothing (stdio-shaped seam)', async () => {
      const observed: Array<string | undefined> = [];
      setOidcAuthMiddleware(async () => true);
      handle = await startHttpTransport(() => {
        observed.push(getCurrentIdentity()?.sub);
        return newServer();
      }, baseHttpConfig());
      const port = getPort(handle);

      await request(port, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
      });

      expect(observed).toEqual([undefined]);
    });

    describe('SSO enrollment endpoint routing (issue #220)', () => {
      afterEach(() => {
        setActiveEnrollmentService(undefined);
      });

      it('404s on /enroll paths when no enrollment service is registered (feature off)', async () => {
        setOidcAuthMiddleware(async () => false);
        handle = await startHttpTransport(newServer, baseHttpConfig());
        const port = getPort(handle);

        for (const path of ['/enroll?ticket=x', '/enroll/callback?code=c&state=s']) {
          const res = await request(port, { path });
          expect(res.statusCode).toBe(404);
        }
      });

      it('serves /enroll and /enroll/callback WITHOUT invoking the bearer-auth middleware', async () => {
        // Middleware would reject everything — the browser hitting /enroll
        // holds no MCP bearer token, so these paths must be routed before it.
        let middlewareCalls = 0;
        setOidcAuthMiddleware(async () => {
          middlewareCalls += 1;
          return false;
        });

        const tickets = new EnrollmentTicketStore();
        const service = new EnrollmentService({
          tickets,
          vault: { provision: async () => undefined },
          vikunjaUrl: 'http://127.0.0.1:1/api/v1',
          publicBaseUrl: 'http://127.0.0.1:9',
          tokenExpiryDays: 1,
        });
        setActiveEnrollmentService(service);

        handle = await startHttpTransport(newServer, baseHttpConfig());
        const port = getPort(handle);

        // Invalid ticket -> the service's own 400 page, not the middleware's 401.
        const res = await request(port, { path: '/enroll?ticket=bogus' });
        expect(res.statusCode).toBe(400);
        expect(res.headers['content-type']).toContain('text/html');

        const callback = await request(port, { path: '/enroll/callback?code=c&state=bogus' });
        expect(callback.statusCode).toBe(400);

        expect(middlewareCalls).toBe(0);
      });

      it('rejects enrollment requests with a Host outside allowedHosts (finding #11, DNS-rebinding parity)', async () => {
        setOidcAuthMiddleware(async () => false);
        const service = new EnrollmentService({
          tickets: new EnrollmentTicketStore(),
          vault: { provision: async () => undefined },
          vikunjaUrl: 'http://127.0.0.1:1/api/v1',
          publicBaseUrl: 'http://127.0.0.1:9',
          tokenExpiryDays: 1,
        });
        setActiveEnrollmentService(service);

        handle = await startHttpTransport(newServer, baseHttpConfig());
        const port = getPort(handle);

        const forged = await request(port, {
          path: '/enroll?ticket=bogus',
          headers: { Host: 'evil.example' },
        });
        expect(forged.statusCode).toBe(403);

        // The legitimate Host (the default allowedHosts derivation) still works.
        const legit = await request(port, { path: '/enroll?ticket=bogus' });
        expect(legit.statusCode).toBe(400);
      });
    });

    describe('RFC 9728 protected resource metadata discovery', () => {
      const ISSUER = 'https://idp.example.test/realms/e2e';

      it('serves GET /.well-known/oauth-protected-resource unauthenticated', async () => {
        // Middleware rejects everything — discovery must still work, since a
        // client fetches it precisely because it has no token yet.
        setOidcAuthMiddleware(async () => false);
        handle = await startHttpTransport(newServer, baseHttpConfig(), { issuer: ISSUER });
        const port = getPort(handle);

        const res = await request(port, { path: '/.well-known/oauth-protected-resource' });

        expect(res.statusCode).toBe(200);
        expect(res.headers['content-type']).toContain('application/json');
        expect(JSON.parse(res.body)).toEqual({
          resource: `http://127.0.0.1:${port}/mcp`,
          authorization_servers: [ISSUER],
          bearer_methods_supported: ['header'],
        });
      });

      it('serves the path-suffixed variant /.well-known/oauth-protected-resource/mcp', async () => {
        setOidcAuthMiddleware(async () => false);
        handle = await startHttpTransport(newServer, baseHttpConfig(), { issuer: ISSUER });
        const port = getPort(handle);

        const res = await request(port, { path: '/.well-known/oauth-protected-resource/mcp' });

        expect(res.statusCode).toBe(200);
        expect(JSON.parse(res.body)).toEqual({
          resource: `http://127.0.0.1:${port}/mcp`,
          authorization_servers: [ISSUER],
          bearer_methods_supported: ['header'],
        });
      });

      it('uses the configured publicUrl verbatim as the canonical resource', async () => {
        setOidcAuthMiddleware(async () => false);
        handle = await startHttpTransport(
          newServer,
          baseHttpConfig({ publicUrl: 'https://mcp-vikunja.example.ch/mcp' }),
          { issuer: ISSUER },
        );
        const port = getPort(handle);

        const res = await request(port, { path: '/.well-known/oauth-protected-resource' });

        expect(res.statusCode).toBe(200);
        expect(JSON.parse(res.body).resource).toBe('https://mcp-vikunja.example.ch/mcp');
      });

      // #292 LOW-19: an untrusted Host header must not be reflected into
      // the discovery document when publicUrl is unset.
      it('does not reflect a spoofed Host header into the served resource URL', async () => {
        setOidcAuthMiddleware(async () => false);
        handle = await startHttpTransport(newServer, baseHttpConfig(), { issuer: ISSUER });
        const port = getPort(handle);

        const res = await request(port, {
          path: '/.well-known/oauth-protected-resource',
          headers: { host: 'evil.attacker.example' },
        });

        expect(res.statusCode).toBe(200);
        // Falls back to the configured bind host:port, not the spoofed Host.
        expect(JSON.parse(res.body).resource).toBe(`http://127.0.0.1:${port}/mcp`);
      });

      it('is GET-only: a POST gets 405 with an Allow: GET header', async () => {
        setOidcAuthMiddleware(async () => false);
        handle = await startHttpTransport(newServer, baseHttpConfig(), { issuer: ISSUER });
        const port = getPort(handle);

        const res = await request(port, {
          method: 'POST',
          path: '/.well-known/oauth-protected-resource',
        });

        expect(res.statusCode).toBe(405);
        expect(res.headers['allow']).toBe('GET');
      });

      it('404s on the well-known path when no OIDC issuer is configured', async () => {
        setOidcAuthMiddleware(async () => false);
        handle = await startHttpTransport(newServer, baseHttpConfig());
        const port = getPort(handle);

        const res = await request(port, { path: '/.well-known/oauth-protected-resource' });

        expect(res.statusCode).toBe(404);
      });
    });

    it('close() shuts the listener down', async () => {
      setOidcAuthMiddleware(async () => true);
      handle = await startHttpTransport(newServer, baseHttpConfig());

      expect(handle.httpServer.listening).toBe(true);
      await handle.close();
      expect(handle.httpServer.listening).toBe(false);

      // Prevent the afterEach hook from closing an already-closed server.
      handle = undefined as unknown as HttpTransportHandle;
    });
  });
});

/**
 * gateway-token mode (docs/GATEWAY-TOKEN-MODE.md §4.3 to §4.6, §7.1): a
 * static bearer shared with the gateway, no ALS scope, mode-aware /readyz,
 * the non-loopback bind-safety rule, and the request-body cap.
 */
describe('httpTransport: gateway-token mode', () => {
  const TOKEN = `gw_${'a1'.repeat(20)}`;
  let handle: HttpTransportHandle | undefined;

  const INITIALIZE_BODY = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'token-mode-test', version: '0.0.0' },
    },
  });

  function tokenConfig(overrides: Partial<HttpConfig> = {}): HttpConfig {
    return baseHttpConfig({ authMode: 'token', ...overrides });
  }

  function mcpHeaders(authorization?: string): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    };
    if (authorization !== undefined) {
      headers.Authorization = authorization;
    }
    return headers;
  }

  function chunkedRequest(
    port: number,
    headers: Record<string, string>,
    chunks: string[],
  ): Promise<RawResponse> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port, method: 'POST', path: '/mcp', headers },
        (res) => {
          const received: Buffer[] = [];
          res.on('data', (chunk) => received.push(chunk));
          res.on('end', () => {
            resolve({
              statusCode: res.statusCode ?? 0,
              headers: res.headers,
              body: Buffer.concat(received).toString('utf-8'),
            });
          });
        },
      );
      // The server may close the socket once it has answered 413; that is
      // the point of the cap, not a test failure.
      req.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code !== 'ECONNRESET' && error.code !== 'EPIPE') {
          reject(error);
        }
      });
      for (const chunk of chunks) {
        req.write(chunk);
      }
      req.end();
    });
  }

  afterEach(async () => {
    if (handle) {
      await handle.close();
      handle = undefined;
    }
    setOidcAuthMiddleware(undefined);
    setActiveVaultStore(undefined);
    setActiveEnrollmentService(undefined);
    jest.restoreAllMocks();
  });

  describe('MCP path', () => {
    it('a POST /mcp with the right bearer reaches the MCP layer (initialize succeeds)', async () => {
      setupStaticTokenAuth(TOKEN);
      handle = await startHttpTransport(newServer, tokenConfig(), undefined, {
        isCredentialConfigured: () => true,
      });
      const port = getPort(handle);

      const res = await request(port, {
        method: 'POST',
        headers: mcpHeaders(`Bearer ${TOKEN}`),
        body: INITIALIZE_BODY,
      });

      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('"serverInfo"');
      expect(res.body).toContain('"test-server"');
    });

    it('opens no ALS scope for the request: the server factory sees no identity', async () => {
      setupStaticTokenAuth(TOKEN);
      const observed: Array<string | undefined> = [];
      handle = await startHttpTransport(() => {
        observed.push(getCurrentIdentity()?.sub);
        return newServer();
      }, tokenConfig());
      const port = getPort(handle);

      await request(port, {
        method: 'POST',
        headers: mcpHeaders(`Bearer ${TOKEN}`),
        body: INITIALIZE_BODY,
      });

      expect(observed).toEqual([undefined]);
    });

    it('rejects a missing and a wrong bearer with byte-identical 401 bodies', async () => {
      setupStaticTokenAuth(TOKEN);
      handle = await startHttpTransport(newServer, tokenConfig());
      const port = getPort(handle);

      const missing = await request(port, {
        method: 'POST',
        headers: mcpHeaders(),
        body: INITIALIZE_BODY,
      });
      const wrong = await request(port, {
        method: 'POST',
        headers: mcpHeaders(`Bearer ${'z'.repeat(TOKEN.length)}`),
        body: INITIALIZE_BODY,
      });

      expect(missing.statusCode).toBe(401);
      expect(wrong.statusCode).toBe(401);
      expect(missing.headers['www-authenticate']).toBe('Bearer');
      expect(wrong.headers['www-authenticate']).toBe('Bearer');
      expect(wrong.body).toBe(missing.body);
      expect(missing.body).toBe('{"error":"invalid_token"}');
      expect(missing.body).not.toContain(TOKEN);
    });

    it('rejects a Host header outside the allowlist with 403', async () => {
      setupStaticTokenAuth(TOKEN);
      handle = await startHttpTransport(newServer, tokenConfig());
      const port = getPort(handle);

      const res = await request(port, {
        method: 'POST',
        headers: { ...mcpHeaders(`Bearer ${TOKEN}`), Host: `evil.example.com:${port}` },
        body: INITIALIZE_BODY,
      });

      expect(res.statusCode).toBe(403);
    });
  });

  describe('health and readiness', () => {
    it('/healthz is 200 without any Authorization header', async () => {
      setupStaticTokenAuth(TOKEN);
      handle = await startHttpTransport(newServer, tokenConfig());

      const res = await request(getPort(handle), { path: '/healthz' });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ status: 'ok' });
    });

    it('/readyz is 200 when the Vikunja credential is configured, with no vault at all', async () => {
      setupStaticTokenAuth(TOKEN);
      const fetchSpy = jest.spyOn(global, 'fetch');
      handle = await startHttpTransport(newServer, tokenConfig(), undefined, {
        isCredentialConfigured: () => true,
      });

      const res = await request(getPort(handle), { path: '/readyz' });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ status: 'ok' });
      // Never an outbound call from an unauthenticated probe (#373).
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('/readyz is 503 with checks.credential=missing when no Vikunja credential is configured', async () => {
      setupStaticTokenAuth(TOKEN);
      handle = await startHttpTransport(newServer, tokenConfig(), undefined, {
        isCredentialConfigured: () => false,
      });

      const res = await request(getPort(handle), { path: '/readyz' });

      expect(res.statusCode).toBe(503);
      expect(JSON.parse(res.body)).toEqual({
        status: 'not_ready',
        checks: { credential: 'missing' },
      });
    });

    it('/readyz fails closed (503) in token mode when no credential check was supplied', async () => {
      setupStaticTokenAuth(TOKEN);
      handle = await startHttpTransport(newServer, tokenConfig());

      const res = await request(getPort(handle), { path: '/readyz' });

      expect(res.statusCode).toBe(503);
      expect(JSON.parse(res.body)).toEqual({
        status: 'not_ready',
        checks: { credential: 'missing' },
      });
    });

    it('oidc-mode /readyz is unchanged: the credential check is ignored, the vault still decides', async () => {
      setOidcAuthMiddleware(async () => false);
      setActiveVaultStore({ isDegraded: () => false } as unknown as VaultFileStore);
      handle = await startHttpTransport(newServer, baseHttpConfig(), undefined, {
        isCredentialConfigured: () => false,
      });

      const res = await request(getPort(handle), { path: '/readyz' });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ status: 'ok' });
    });
  });

  describe('OIDC-only endpoints are absent', () => {
    it('/.well-known/oauth-protected-resource is 404', async () => {
      setupStaticTokenAuth(TOKEN);
      handle = await startHttpTransport(newServer, tokenConfig());
      const port = getPort(handle);

      for (const wellKnown of [
        '/.well-known/oauth-protected-resource',
        '/.well-known/oauth-protected-resource/mcp',
      ]) {
        const res = await request(port, { path: wellKnown });
        expect(res.statusCode).toBe(404);
      }
    });

    it('/enroll is 404', async () => {
      setupStaticTokenAuth(TOKEN);
      handle = await startHttpTransport(newServer, tokenConfig());
      const port = getPort(handle);

      for (const enrollPath of ['/enroll', '/enroll/callback']) {
        const res = await request(port, { path: enrollPath });
        expect(res.statusCode).toBe(404);
        expect(JSON.parse(res.body)).toEqual({ error: 'not_found' });
      }
    });
  });

  describe('request-body cap', () => {
    it('answers 413 when Content-Length exceeds the cap, without building an MCP server', async () => {
      setupStaticTokenAuth(TOKEN);
      const factory = jest.fn(newServer);
      handle = await startHttpTransport(factory, tokenConfig(), undefined, { maxBodyBytes: 1024 });

      const res = await request(getPort(handle), {
        method: 'POST',
        headers: { ...mcpHeaders(`Bearer ${TOKEN}`), 'Content-Length': '1025' },
        body: 'x'.repeat(1025),
      });

      expect(res.statusCode).toBe(413);
      expect(JSON.parse(res.body)).toEqual({ error: 'payload_too_large' });
      expect(factory).not.toHaveBeenCalled();
    });

    it('answers 413 when a chunked body (no Content-Length) grows past the cap', async () => {
      setupStaticTokenAuth(TOKEN);
      jest.spyOn(console, 'error').mockImplementation(() => undefined);
      handle = await startHttpTransport(newServer, tokenConfig(), undefined, {
        maxBodyBytes: 1024,
      });

      const res = await chunkedRequest(getPort(handle), mcpHeaders(`Bearer ${TOKEN}`), [
        'x'.repeat(600),
        'x'.repeat(600),
        'x'.repeat(600),
      ]);

      expect(res.statusCode).toBe(413);
      expect(JSON.parse(res.body)).toEqual({ error: 'payload_too_large' });
    });

    it('never dispatches a valid over-cap chunked message, even when it arrives in one read', async () => {
      // Earlier review finding: the tool must never run for a body the
      // caller was told is too large, even if the connection is never torn
      // down. Simulate that worst case (destroy does nothing).
      setupStaticTokenAuth(TOKEN);
      jest.spyOn(console, 'error').mockImplementation(() => undefined);
      jest.spyOn(http.IncomingMessage.prototype, 'destroy').mockImplementation(function (
        this: http.IncomingMessage,
      ) {
        return this;
      });
      const handler = jest.fn(async () => ({ content: [{ type: 'text' as const, text: 'ran' }] }));
      handle = await startHttpTransport(
        () => {
          const server = newServer();
          server.tool('probe_write', {}, handler);
          return server;
        },
        tokenConfig(),
        undefined,
        { maxBodyBytes: 1024 },
      );
      const call = JSON.stringify({
        jsonrpc: '2.0',
        id: 7,
        method: 'tools/call',
        params: { name: 'probe_write', arguments: {} },
      });
      // Valid JSON: trailing whitespace pads it past the cap.
      const padded = call + ' '.repeat(2048);

      const res = await chunkedRequest(getPort(handle), mcpHeaders(`Bearer ${TOKEN}`), [padded]);
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(res.statusCode).toBe(413);
      expect(handler).not.toHaveBeenCalled();
    });

    it('still logs (and answers 500) when handleRequest fails for any other reason', async () => {
      setupStaticTokenAuth(TOKEN);
      const errorSpy = jest.spyOn(logger, 'error').mockImplementation(() => undefined);
      jest
        .spyOn(StreamableHTTPServerTransport.prototype, 'handleRequest')
        .mockRejectedValue(new Error('boom'));
      handle = await startHttpTransport(newServer, tokenConfig());

      const res = await request(getPort(handle), {
        method: 'POST',
        headers: mcpHeaders(`Bearer ${TOKEN}`),
        body: INITIALIZE_BODY,
      });

      expect(res.statusCode).toBe(500);
      expect(JSON.parse(res.body)).toEqual({ error: 'internal_error' });
      expect(errorSpy).toHaveBeenCalledWith(
        'Unhandled error while handling HTTP MCP request:',
        expect.objectContaining({ message: 'boom' }),
      );
    });

    it('lets a chunked body under the cap through intact to the SDK', async () => {
      setupStaticTokenAuth(TOKEN);
      handle = await startHttpTransport(newServer, tokenConfig(), undefined, {
        maxBodyBytes: 4096,
      });
      const half = Math.floor(INITIALIZE_BODY.length / 2);

      const res = await chunkedRequest(getPort(handle), mcpHeaders(`Bearer ${TOKEN}`), [
        INITIALIZE_BODY.slice(0, half),
        INITIALIZE_BODY.slice(half),
      ]);

      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('"serverInfo"');
    });

    /**
     * Raw-socket POST: sends `head` (request line + headers, no body), then
     * keeps trickling one body byte every 50 ms until the server closes the
     * socket or `giveUpMs` passes. Reports what came back and when.
     */
    function trickle(
      port: number,
      head: string,
      giveUpMs = 2000,
    ): Promise<{ response: string; closedAfterMs: number | undefined }> {
      return new Promise((resolve) => {
        const started = Date.now();
        let response = '';
        let timer: NodeJS.Timeout | undefined;
        const socket = net.connect(port, '127.0.0.1', () => {
          socket.write(head);
          timer = setInterval(() => {
            if (!socket.destroyed) socket.write('x');
          }, 50);
        });
        const giveUp = setTimeout(() => {
          clearInterval(timer);
          socket.destroy();
          resolve({ response, closedAfterMs: undefined });
        }, giveUpMs);
        socket.on('data', (chunk: Buffer) => {
          response += chunk.toString('utf-8');
        });
        socket.on('error', () => undefined);
        socket.on('close', () => {
          clearInterval(timer);
          clearTimeout(giveUp);
          resolve({ response, closedAfterMs: Date.now() - started });
        });
      });
    }

    function rawHead(port: number, extraHeaders: string): string {
      return (
        `POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAuthorization: Bearer ${TOKEN}\r\n` +
        'Content-Type: application/json\r\nAccept: application/json, text/event-stream\r\n' +
        `${extraHeaders}\r\n`
      );
    }

    it('closes the connection after a Content-Length 413 while the client is still sending', async () => {
      // Review finding 1: the claim was that the socket stays open until
      // requestTimeout. Measured on Node 22 and 25 it does not; this pins it.
      setupStaticTokenAuth(TOKEN);
      const factory = jest.fn(newServer);
      handle = await startHttpTransport(factory, tokenConfig(), undefined, { maxBodyBytes: 1024 });
      const port = getPort(handle);

      const { response, closedAfterMs } = await trickle(
        port,
        rawHead(port, 'Content-Length: 1000000000\r\n'),
      );

      expect(response).toMatch(/^HTTP\/1\.1 413 /);
      expect(response).toContain('{"error":"payload_too_large"}');
      expect(closedAfterMs).toBeDefined();
      expect(closedAfterMs).toBeLessThan(1000);
      expect(factory).not.toHaveBeenCalled();
    });

    it('closes the connection after a chunked 413 while the client is still sending', async () => {
      setupStaticTokenAuth(TOKEN);
      const factory = jest.fn(newServer);
      handle = await startHttpTransport(factory, tokenConfig(), undefined, { maxBodyBytes: 1024 });
      const port = getPort(handle);

      const { response, closedAfterMs } = await trickle(
        port,
        rawHead(port, 'Transfer-Encoding: chunked\r\n') + `800\r\n${'x'.repeat(0x800)}\r\n`,
      );

      expect(response).toMatch(/^HTTP\/1\.1 413 /);
      expect(response).toContain('{"error":"payload_too_large"}');
      expect(closedAfterMs).toBeDefined();
      expect(closedAfterMs).toBeLessThan(1000);
      expect(factory).not.toHaveBeenCalled();
    });

    it('builds no MCP server when the client hangs up mid-body', async () => {
      setupStaticTokenAuth(TOKEN);
      const factory = jest.fn(newServer);
      handle = await startHttpTransport(factory, tokenConfig(), undefined, { maxBodyBytes: 1024 });
      const port = getPort(handle);

      await new Promise<void>((resolve) => {
        const socket = net.connect(port, '127.0.0.1', () => {
          socket.write(rawHead(port, 'Content-Length: 100\r\n') + 'x'.repeat(10));
          setTimeout(() => socket.destroy(), 50);
        });
        socket.on('close', () => resolve());
      });
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(factory).not.toHaveBeenCalled();
    });

    it('does not wait on a body whose client left while authentication was running', async () => {
      // Verifier finding: once the request is destroyed, no data, end or
      // close event ever comes again, so a reader attached after that would
      // wait forever (the listeners stay on the request).
      let seen: http.IncomingMessage | undefined;
      setOidcAuthMiddleware(async (req) => {
        seen = req;
        await new Promise<void>((resolve) => {
          const poll = setInterval(() => {
            if (req.destroyed) {
              clearInterval(poll);
              resolve();
            }
          }, 5);
        });
        return true;
      });
      const factory = jest.fn(newServer);
      handle = await startHttpTransport(factory, tokenConfig(), undefined, { maxBodyBytes: 1024 });
      const port = getPort(handle);

      await new Promise<void>((resolve) => {
        const socket = net.connect(port, '127.0.0.1', () => {
          socket.write(rawHead(port, 'Content-Length: 5\r\n') + 'hello');
          setTimeout(() => socket.destroy(), 50);
        });
        socket.on('close', () => resolve());
      });
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(seen?.listenerCount('data')).toBe(0);
      expect(factory).not.toHaveBeenCalled();
    });

    it('accepts a JSON body that starts with a UTF-8 byte order mark', async () => {
      setupStaticTokenAuth(TOKEN);
      handle = await startHttpTransport(newServer, tokenConfig(), undefined, {
        maxBodyBytes: 4096,
      });

      const res = await request(getPort(handle), {
        method: 'POST',
        headers: mcpHeaders(`Bearer ${TOKEN}`),
        body: `\uFEFF${INITIALIZE_BODY}`,
      });

      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('"serverInfo"');
    });

    it('caps the body no matter how the SDK reads it (no data listener ever attached)', async () => {
      // Review finding 2: the old counter only started when the SDK attached
      // a `data` listener. A reader that uses async iteration (as a web
      // stream adapter might) never does, so the cap silently disappeared.
      setupStaticTokenAuth(TOKEN);
      const sdkRead = jest
        .spyOn(StreamableHTTPServerTransport.prototype, 'handleRequest')
        .mockImplementation(async (req, res) => {
          let bytes = 0;
          for await (const chunk of req) {
            bytes += (chunk as Buffer).length;
          }
          if (!res.headersSent) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ bytes }));
          }
        });
      handle = await startHttpTransport(newServer, tokenConfig(), undefined, {
        maxBodyBytes: 1024,
      });

      const res = await chunkedRequest(getPort(handle), mcpHeaders(`Bearer ${TOKEN}`), [
        'x'.repeat(600),
        'x'.repeat(600),
        'x'.repeat(600),
      ]);

      expect(res.statusCode).toBe(413);
      expect(JSON.parse(res.body)).toEqual({ error: 'payload_too_large' });
      expect(sdkRead).not.toHaveBeenCalled();
    });

    it('never hands a chunked over-cap request to the SDK, so nothing is printed to stderr', async () => {
      setupStaticTokenAuth(TOKEN);
      const factory = jest.fn(newServer);
      handle = await startHttpTransport(factory, tokenConfig(), undefined, { maxBodyBytes: 1024 });
      // After startup: the logger writes its own INFO lines to console.error too.
      const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);

      const res = await chunkedRequest(getPort(handle), mcpHeaders(`Bearer ${TOKEN}`), [
        INITIALIZE_BODY + ' '.repeat(2048),
      ]);
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(res.statusCode).toBe(413);
      expect(factory).not.toHaveBeenCalled();
      expect(consoleError).not.toHaveBeenCalled();
    });

    it('answers an under-cap body that is not JSON with the SDK parse error', async () => {
      setupStaticTokenAuth(TOKEN);
      handle = await startHttpTransport(newServer, tokenConfig(), undefined, {
        maxBodyBytes: 1024,
      });

      const res = await request(getPort(handle), {
        method: 'POST',
        headers: mcpHeaders(`Bearer ${TOKEN}`),
        body: '{not json',
      });

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body)).toMatchObject({ jsonrpc: '2.0', error: { code: -32700 } });
    });

    it('still checks Accept before parsing the body, as the SDK does', async () => {
      setupStaticTokenAuth(TOKEN);
      handle = await startHttpTransport(newServer, tokenConfig(), undefined, {
        maxBodyBytes: 1024,
      });

      const res = await request(getPort(handle), {
        method: 'POST',
        headers: { ...mcpHeaders(`Bearer ${TOKEN}`), Accept: 'application/json' },
        body: '{not json',
      });

      expect(res.statusCode).toBe(406);
    });

    /**
     * What the SDK answers on its own, reading the body itself (no
     * `parsedBody`), as this server did before the pre-read. Used as the
     * reference the pre-read path must match.
     */
    async function sdkBaseline(
      createServer: () => McpServer,
      headers: Record<string, string>,
      body: string | Buffer,
    ): Promise<RawResponse> {
      const baseline = http.createServer((req, res) => {
        void (async (): Promise<void> => {
          const transport = new StreamableHTTPServerTransport({});
          const server = createServer();
          await server.connect(transport as unknown as Transport);
          await transport.handleRequest(req, res);
          await server.close();
        })();
      });
      await new Promise<void>((resolve) => baseline.listen(0, '127.0.0.1', resolve));
      try {
        const address = baseline.address() as net.AddressInfo;
        return await request(address.port, { method: 'POST', headers, body });
      } finally {
        await new Promise<void>((resolve) => baseline.close(() => resolve()));
      }
    }

    it('rejects a POST whose Content-Type is not JSON exactly as the SDK does without parsedBody', async () => {
      // Confirming-review question: does handing the SDK a parsedBody skip
      // its Content-Type check? In SDK 1.30.0 handlePostRequest checks
      // Accept, then Content-Type, and only then looks at parsedBody.
      setupStaticTokenAuth(TOKEN);
      const factory = jest.fn(newServer);
      handle = await startHttpTransport(factory, tokenConfig(), undefined, { maxBodyBytes: 4096 });
      const headers = { ...mcpHeaders(`Bearer ${TOKEN}`), 'Content-Type': 'text/plain' };

      const ours = await request(getPort(handle), {
        method: 'POST',
        headers,
        body: INITIALIZE_BODY,
      });
      const reference = await sdkBaseline(newServer, headers, INITIALIZE_BODY);

      expect(reference.statusCode).toBe(415);
      expect(ours.statusCode).toBe(reference.statusCode);
      expect(JSON.parse(ours.body)).toEqual(JSON.parse(reference.body));
      expect(ours.body).toContain('Content-Type must be application/json');
    });

    describe('body decoding matches the SDK reading the body itself', () => {
      function echoServer(): McpServer {
        const server = newServer();
        server.tool('echo', { text: z.string() }, async ({ text }) => ({
          content: [{ type: 'text' as const, text }],
        }));
        return server;
      }

      function toolsCall(textBytes: Buffer): Buffer {
        const [before, after] = JSON.stringify({
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: { name: 'echo', arguments: { text: 'SLOT' } },
        }).split('SLOT');
        return Buffer.concat([Buffer.from(before ?? ''), textBytes, Buffer.from(after ?? '')]);
      }

      // Non-fatal UTF-8 decoding (invalid bytes become U+FFFD) and BOM
      // stripping, the WHATWG "UTF-8 decode" that Request.json() uses too.
      it.each([
        ['invalid UTF-8 bytes', toolsCall(Buffer.from([0x61, 0xff, 0xfe, 0xc3, 0x62]))],
        ['a Latin-1 encoded character', toolsCall(Buffer.from('café', 'latin1'))],
        [
          'a leading BOM',
          Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), toolsCall(Buffer.from('ok'))]),
        ],
      ])('%s', async (_label, body) => {
        setupStaticTokenAuth(TOKEN);
        handle = await startHttpTransport(echoServer, tokenConfig(), undefined, {
          maxBodyBytes: 4096,
        });
        const headers = mcpHeaders(`Bearer ${TOKEN}`);

        const ours = await request(getPort(handle), { method: 'POST', headers, body });
        const reference = await sdkBaseline(echoServer, headers, body);

        expect(ours.statusCode).toBe(reference.statusCode);
        expect(ours.body).toBe(reference.body);
      });

      it.each([
        ['a UTF-16LE body', Buffer.from(toolsCall(Buffer.from('ok')).toString('utf-8'), 'utf16le')],
        ['text that is not JSON', Buffer.from('{not json')],
      ])('%s: same status and JSON-RPC code, different message text', async (_label, body) => {
        // Documented difference: with parsedBody the SDK reports a string it
        // cannot validate as "Invalid JSON-RPC message"; reading the body
        // itself it said "Invalid JSON". Status and code are what clients act on.
        setupStaticTokenAuth(TOKEN);
        handle = await startHttpTransport(echoServer, tokenConfig(), undefined, {
          maxBodyBytes: 4096,
        });
        const headers = mcpHeaders(`Bearer ${TOKEN}`);

        const ours = await request(getPort(handle), { method: 'POST', headers, body });
        const reference = await sdkBaseline(echoServer, headers, body);

        expect(reference.statusCode).toBe(400);
        expect(ours.statusCode).toBe(400);
        expect(JSON.parse(reference.body)).toMatchObject({
          error: { code: -32700, message: 'Parse error: Invalid JSON' },
        });
        expect(JSON.parse(ours.body)).toMatchObject({
          error: { code: -32700, message: 'Parse error: Invalid JSON-RPC message' },
        });
      });

      it('replaces invalid bytes with U+FFFD rather than rejecting the call', async () => {
        setupStaticTokenAuth(TOKEN);
        handle = await startHttpTransport(echoServer, tokenConfig(), undefined, {
          maxBodyBytes: 4096,
        });

        const res = await request(getPort(handle), {
          method: 'POST',
          headers: mcpHeaders(`Bearer ${TOKEN}`),
          body: toolsCall(Buffer.from([0x61, 0xff, 0x62])),
        });

        expect(res.statusCode).toBe(200);
        expect(res.body).toContain('"text":"a�b"');
      });
    });

    it.each([
      'Content-Length: abc',
      'Content-Length: 5\r\nContent-Length: 6',
      'Content-Length: 5\r\nContent-Length: 5',
      'Content-Length: 5, 5',
      'Content-Length: -1',
      'Content-Length: 1e3',
      'Content-Length: +5',
      'Content-Length: ',
      'Content-Length: 5\r\nTransfer-Encoding: chunked',
    ])(
      'Node rejects a malformed Content-Length (%j) with 400 before this server runs',
      async (header) => {
        // readBodyWithinCap compares Number(content-length) with the cap; NaN
        // would fall through to the byte counter. This pins that such a
        // header never reaches it: llhttp answers 400 first.
        const middleware = jest.fn(async () => true);
        setOidcAuthMiddleware(middleware);
        handle = await startHttpTransport(newServer, tokenConfig(), undefined, {
          maxBodyBytes: 1024,
        });
        const port = getPort(handle);

        const response = await new Promise<string>((resolve) => {
          let received = '';
          const socket = net.connect(port, '127.0.0.1', () => {
            socket.write(rawHead(port, `${header}\r\n`) + 'hello');
          });
          socket.on('data', (chunk: Buffer) => {
            received += chunk.toString('utf-8');
          });
          socket.on('error', () => undefined);
          socket.on('close', () => resolve(received));
        });

        expect(response).toMatch(/^HTTP\/1\.1 400 /);
        expect(middleware).not.toHaveBeenCalled();
      },
    );

    it('answers every complete body even when authentication is slow (end always precedes close)', async () => {
      // Confirming-review question: could `close` beat `end` on a complete
      // body and turn a good request into a silent abort? Not observed on
      // Node 22 or 25; this pins it on real sockets with a delayed reader.
      setOidcAuthMiddleware(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return true;
      });
      handle = await startHttpTransport(newServer, tokenConfig(), undefined, {
        maxBodyBytes: 4096,
      });
      const port = getPort(handle);

      const statuses = await Promise.all(
        Array.from({ length: 40 }, () =>
          request(port, {
            method: 'POST',
            headers: { ...mcpHeaders(), Connection: 'close' },
            body: INITIALIZE_BODY,
          }).then((res) => res.statusCode),
        ),
      );

      expect(statuses).toEqual(Array.from({ length: 40 }, () => 200));
    });

    it('passes GET to the SDK without a parsed body', async () => {
      setupStaticTokenAuth(TOKEN);
      const sdkHandle = jest.spyOn(StreamableHTTPServerTransport.prototype, 'handleRequest');
      handle = await startHttpTransport(newServer, tokenConfig());
      const port = getPort(handle);

      // A GET may open a long-lived SSE stream: read the status line only.
      const statusCode = await new Promise<number>((resolve, reject) => {
        const req = http.request(
          {
            host: '127.0.0.1',
            port,
            method: 'GET',
            path: '/mcp',
            headers: mcpHeaders(`Bearer ${TOKEN}`),
          },
          (res) => {
            resolve(res.statusCode ?? 0);
            req.destroy();
          },
        );
        req.on('error', reject);
        req.end();
      });

      expect(statusCode).not.toBe(413);
      expect(sdkHandle).toHaveBeenCalledTimes(1);
      expect(sdkHandle.mock.calls[0]?.[2]).toBeUndefined();
    });

    it('defaults the cap to 1 MiB (rateLimiting.default.maxRequestSize)', async () => {
      setupStaticTokenAuth(TOKEN);
      handle = await startHttpTransport(newServer, tokenConfig());
      const port = getPort(handle);

      const over = await request(port, {
        method: 'POST',
        headers: mcpHeaders(`Bearer ${TOKEN}`),
        body: 'x'.repeat(1048577),
      });

      expect(over.statusCode).toBe(413);
    });

    it('does not apply the cap before authentication: an unauthenticated oversize POST is a 401', async () => {
      setupStaticTokenAuth(TOKEN);
      handle = await startHttpTransport(newServer, tokenConfig(), undefined, { maxBodyBytes: 16 });

      const res = await request(getPort(handle), {
        method: 'POST',
        headers: mcpHeaders(),
        body: 'x'.repeat(64),
      });

      expect(res.statusCode).toBe(401);
    });
  });
});

const IPV6_LOOPBACK_AVAILABLE = Object.values(os.networkInterfaces())
  .flat()
  .some((iface) => iface?.address === '::1');

describe('httpTransport: IPv6 bind hosts', () => {
  let handle: HttpTransportHandle | undefined;

  afterEach(async () => {
    if (handle) {
      await handle.close();
      handle = undefined;
    }
    setOidcAuthMiddleware(undefined);
    jest.restoreAllMocks();
  });

  it('formatHostPort brackets IPv6 literals and leaves IPv4 and names alone', () => {
    expect(formatHostPort('::1', 8765)).toBe('[::1]:8765');
    expect(formatHostPort('::', 8765)).toBe('[::]:8765');
    expect(formatHostPort('127.0.0.1', 8765)).toBe('127.0.0.1:8765');
    expect(formatHostPort('vikunja-mcp', 8765)).toBe('vikunja-mcp:8765');
  });

  it('defaults the allow-list to the bracketed form clients send in Host for a ::1 bind', () => {
    expect(resolveAllowedHosts(baseHttpConfig({ host: '::1', port: 8765 }))).toEqual([
      '[::1]:8765',
    ]);
  });

  it('does not widen the default list (no localhost, no IPv4 alias)', () => {
    expect(resolveAllowedHosts(baseHttpConfig({ host: '::1', port: 8765 }))).toHaveLength(1);
    expect(resolveAllowedHosts(baseHttpConfig({ host: '127.0.0.1', port: 8765 }))).toEqual([
      '127.0.0.1:8765',
    ]);
  });

  (IPV6_LOOPBACK_AVAILABLE ? it : it.skip)(
    'a real listener bound to ::1 accepts a POST /mcp with Host: [::1]:<port> and logs the bracketed address',
    async () => {
      const token = `gw_${'f6'.repeat(20)}`;
      setupStaticTokenAuth(token);
      const infoSpy = jest.spyOn(logger, 'info').mockImplementation(() => undefined);
      const config = baseHttpConfig({ host: '::1', authMode: 'token' });
      handle = await startHttpTransport(newServer, config);

      const res = await new Promise<RawResponse>((resolve, reject) => {
        const req = http.request(
          {
            host: '::1',
            port: config.port,
            method: 'POST',
            path: '/mcp',
            headers: {
              'Content-Type': 'application/json',
              Accept: 'application/json, text/event-stream',
              Authorization: `Bearer ${token}`,
            },
          },
          (response) => {
            const chunks: Buffer[] = [];
            response.on('data', (chunk: Buffer) => chunks.push(chunk));
            response.on('end', () =>
              resolve({
                statusCode: response.statusCode ?? 0,
                headers: response.headers,
                body: Buffer.concat(chunks).toString('utf-8'),
              }),
            );
          },
        );
        req.on('error', reject);
        // Node sends the bracketed form itself; asserted, not assumed.
        expect(req.getHeader('host')).toBe(`[::1]:${config.port}`);
        req.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: {
              protocolVersion: '2025-03-26',
              capabilities: {},
              clientInfo: { name: 'ipv6-test', version: '0.0.0' },
            },
          }),
        );
      });

      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('"serverInfo"');
      expect(infoSpy).toHaveBeenCalledWith(
        `Vikunja MCP HTTP transport listening on [::1]:${config.port}/mcp`,
      );
    },
  );
});

describe('httpTransport: bind safety (docs/GATEWAY-TOKEN-MODE.md §4.4)', () => {
  afterEach(() => {
    setOidcAuthMiddleware(undefined);
    jest.restoreAllMocks();
  });

  /** A DNS stand-in: every name resolves to the given addresses, and no literal ever reaches it. */
  function resolvesTo(...addresses: string[]): jest.Mock {
    return jest.fn(async () =>
      addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })),
    );
  }

  it('classifies loopback literals without DNS, and listens on the literal itself', async () => {
    const lookup = resolvesTo('10.0.0.1');
    for (const host of ['127.0.0.1', '127.9.8.7', '::1', '0:0:0:0:0:0:0:1', '::ffff:127.0.0.1']) {
      await expect(resolveBindTarget(host, lookup)).resolves.toEqual({
        listenAddress: host,
        loopback: true,
      });
    }
    for (const host of ['0.0.0.0', '::', '::ffff:0.0.0.0', '10.123.0.7', '::ffff:10.0.0.1']) {
      await expect(resolveBindTarget(host, lookup)).resolves.toEqual({
        listenAddress: host,
        loopback: false,
      });
    }
    expect(lookup).not.toHaveBeenCalled();
  });

  it('treats a name as loopback only when every address it resolves to is loopback', async () => {
    await expect(resolveBindTarget('localhost', resolvesTo('127.0.0.1', '::1'))).resolves.toEqual({
      listenAddress: '127.0.0.1',
      loopback: true,
    });
    // Review finding: /etc/hosts (or a container extra_hosts) can map
    // `localhost` to a routable address, and listen() binds that address.
    await expect(resolveBindTarget('localhost', resolvesTo('172.17.0.4'))).resolves.toEqual({
      listenAddress: '172.17.0.4',
      loopback: false,
    });
    await expect(
      resolveBindTarget('localhost', resolvesTo('127.0.0.1', '10.0.0.1')),
    ).resolves.toMatchObject({ loopback: false });
    await expect(resolveBindTarget('localhost', resolvesTo('not-an-ip'))).resolves.toMatchObject({
      loopback: false,
    });
  });

  it('listens on the first resolved address, the one listen(name) would have picked', async () => {
    await expect(resolveBindTarget('localhost', resolvesTo('::1', '127.0.0.1'))).resolves.toEqual({
      listenAddress: '::1',
      loopback: true,
    });
  });

  it('fails closed with a ConfigurationError when the bind host does not resolve', async () => {
    const lookup = jest.fn(async () => {
      throw Object.assign(new Error('getaddrinfo ENOTFOUND nowhere.invalid'), {
        code: 'ENOTFOUND',
      });
    });
    const attempt = resolveBindTarget('nowhere.invalid', lookup);
    await expect(attempt).rejects.toThrow(ConfigurationError);
    await expect(attempt).rejects.toThrow(
      /Could not resolve the bind host nowhere\.invalid: getaddrinfo ENOTFOUND/,
    );
  });

  it('fails closed when a name resolves to nothing', async () => {
    await expect(resolveBindTarget('localhost', resolvesTo())).rejects.toThrow(
      /Could not resolve the bind host localhost: no addresses/,
    );
  });

  it('fails closed instead of hanging when the resolver never answers', async () => {
    const lookup = jest.fn(() => new Promise<Array<{ address: string }>>(() => undefined));
    const started = Date.now();

    await expect(resolveBindTarget('slow.example', lookup, 30)).rejects.toThrow(
      /Could not resolve the bind host slow\.example: no answer within 30 ms/,
    );
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('resolves localhost with the real resolver on this machine', async () => {
    // Every mainstream /etc/hosts maps localhost to loopback; this pins the
    // default lookup wiring (all addresses, not just the first).
    await expect(resolveBindTarget('localhost')).resolves.toMatchObject({ loopback: true });
  });

  it('a loopback bind has no extra requirements, even with no auth and no allowedHosts', () => {
    expect(bindSafetyProblems(baseHttpConfig(), false, true)).toEqual([]);
  });

  it('a localhost bind that resolves off-box needs the allow-list and auth like any other', () => {
    const problems = bindSafetyProblems(baseHttpConfig({ host: 'localhost' }), false, false);
    expect(problems).toHaveLength(2);
    expect(problems.join(' ')).toMatch(/VIKUNJA_MCP_HTTP_ALLOWED_HOSTS/);
  });

  it('startHttpTransport refuses a localhost bind that resolves off-box, before listen()', async () => {
    setupStaticTokenAuth(`gw_${'d4'.repeat(20)}`);
    const listenSpy = jest.spyOn(http.Server.prototype, 'listen');

    const attempt = startHttpTransport(
      newServer,
      baseHttpConfig({ host: 'localhost', authMode: 'token' }),
      undefined,
      { lookupHost: resolvesTo('172.17.0.4') },
    );

    await expect(attempt).rejects.toThrow(
      /Refusing to listen on localhost: .*VIKUNJA_MCP_HTTP_ALLOWED_HOSTS is not set/,
    );
    expect(listenSpy).not.toHaveBeenCalled();
  });

  it('startHttpTransport refuses a bind host that does not resolve, before listen()', async () => {
    setupStaticTokenAuth(`gw_${'d5'.repeat(20)}`);
    const listenSpy = jest.spyOn(http.Server.prototype, 'listen');
    const lookup = jest.fn(async () => {
      throw new Error('getaddrinfo ENOTFOUND nowhere.invalid');
    });

    await expect(
      startHttpTransport(
        newServer,
        baseHttpConfig({ host: 'nowhere.invalid', authMode: 'token' }),
        undefined,
        { lookupHost: lookup },
      ),
    ).rejects.toThrow(ConfigurationError);
    expect(listenSpy).not.toHaveBeenCalled();
  });

  it('checks and binds the same address: a loopback name is resolved once and listen() gets the address', async () => {
    // Confirming-review finding: listen(port, name) resolved the name a
    // second time, so the check and the bind could disagree.
    setupStaticTokenAuth(`gw_${'e5'.repeat(20)}`);
    const infoSpy = jest.spyOn(logger, 'info').mockImplementation(() => undefined);
    const listenSpy = jest.spyOn(http.Server.prototype, 'listen');
    const lookup = resolvesTo('127.0.0.1', '::1');
    const config = baseHttpConfig({ host: 'localhost', authMode: 'token' });

    const handle = await startHttpTransport(newServer, config, undefined, { lookupHost: lookup });
    try {
      expect(lookup).toHaveBeenCalledTimes(1);
      expect(listenSpy).toHaveBeenCalledWith(config.port, '127.0.0.1', expect.any(Function));
      expect(infoSpy).toHaveBeenCalledWith(
        `Vikunja MCP HTTP transport listening on 127.0.0.1:${config.port}/mcp (http.host localhost)`,
      );
      // The default allow-list keeps the name clients send in Host.
      expect(resolveAllowedHosts(config)).toEqual([`localhost:${config.port}`]);
    } finally {
      await handle.close();
    }
  });

  it('a real localhost bind answers a client that sends Host: localhost:<port>', async () => {
    const token = `gw_${'e6'.repeat(20)}`;
    setupStaticTokenAuth(token);
    jest.spyOn(logger, 'info').mockImplementation(() => undefined);
    const config = baseHttpConfig({ host: 'localhost', authMode: 'token' });

    const handle = await startHttpTransport(newServer, config);
    try {
      const address = handle.httpServer.address() as net.AddressInfo;
      const res = await new Promise<number>((resolve, reject) => {
        const req = http.request(
          {
            host: 'localhost',
            port: address.port,
            method: 'POST',
            path: '/mcp',
            headers: {
              'Content-Type': 'application/json',
              Accept: 'application/json, text/event-stream',
              Authorization: `Bearer ${token}`,
            },
          },
          (response) => {
            response.resume();
            resolve(response.statusCode ?? 0);
          },
        );
        req.on('error', reject);
        expect(req.getHeader('host')).toBe(`localhost:${config.port}`);
        req.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: {
              protocolVersion: '2025-03-26',
              capabilities: {},
              clientInfo: { name: 'localhost-test', version: '0.0.0' },
            },
          }),
        );
      });
      expect(res).toBe(200);
    } finally {
      await handle.close();
    }
  });

  it('a non-loopback bind with auth but no explicit allowedHosts names VIKUNJA_MCP_HTTP_ALLOWED_HOSTS', () => {
    const problems = bindSafetyProblems(baseHttpConfig({ host: '0.0.0.0' }), true, false);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/VIKUNJA_MCP_HTTP_ALLOWED_HOSTS/);
  });

  it('an explicitly empty allowedHosts list counts as not set', () => {
    const problems = bindSafetyProblems(
      baseHttpConfig({ host: '0.0.0.0', allowedHosts: [] }),
      true,
      false,
    );
    expect(problems).toHaveLength(1);
  });

  it('a non-loopback bind with neither names both the allow-list and the auth credential', () => {
    const problems = bindSafetyProblems(baseHttpConfig({ host: '0.0.0.0' }), false, false);
    expect(problems).toHaveLength(2);
    expect(problems.join(' ')).toMatch(/VIKUNJA_MCP_HTTP_ALLOWED_HOSTS/);
    expect(problems.join(' ')).toMatch(/VIKUNJA_MCP_HTTP_AUTH_TOKEN/);
  });

  it('a non-loopback bind with both has no problems', () => {
    expect(
      bindSafetyProblems(
        baseHttpConfig({ host: '0.0.0.0', allowedHosts: ['vikunja-mcp:8765'] }),
        true,
        false,
      ),
    ).toEqual([]);
  });

  it('startHttpTransport refuses 0.0.0.0 with a token but no allowedHosts, before listen()', async () => {
    setupStaticTokenAuth(`gw_${'b2'.repeat(20)}`);
    const listenSpy = jest.spyOn(http.Server.prototype, 'listen');

    const attempt = startHttpTransport(
      newServer,
      baseHttpConfig({ host: '0.0.0.0', authMode: 'token' }),
    );

    await expect(attempt).rejects.toThrow(ConfigurationError);
    await expect(attempt).rejects.toThrow(
      /Refusing to listen on 0\.0\.0\.0: .*VIKUNJA_MCP_HTTP_ALLOWED_HOSTS is not set/,
    );
    expect(listenSpy).not.toHaveBeenCalled();
  });

  it('startHttpTransport refuses 0.0.0.0 with neither, naming both, before listen()', async () => {
    const listenSpy = jest.spyOn(http.Server.prototype, 'listen');

    const attempt = startHttpTransport(newServer, baseHttpConfig({ host: '0.0.0.0' }));

    await expect(attempt).rejects.toThrow(ConfigurationError);
    await expect(attempt).rejects.toThrow(/VIKUNJA_MCP_HTTP_ALLOWED_HOSTS/);
    await expect(attempt).rejects.toThrow(/VIKUNJA_MCP_HTTP_AUTH_TOKEN/);
    expect(listenSpy).not.toHaveBeenCalled();
  });

  it('with an allow-list but no auth, the refusal points at the auth scheme, not the allow-list', async () => {
    const listenSpy = jest.spyOn(http.Server.prototype, 'listen');

    const attempt = startHttpTransport(
      newServer,
      baseHttpConfig({ host: '0.0.0.0', allowedHosts: ['vikunja-mcp:8765'] }),
    );

    await expect(attempt).rejects.toThrow(/no HTTP auth credential is configured/);
    await expect(attempt).rejects.toThrow(/Configure an auth scheme, or bind to 127\.0\.0\.1/);
    await expect(attempt).rejects.not.toThrow(/Set VIKUNJA_MCP_HTTP_ALLOWED_HOSTS=/);
    expect(listenSpy).not.toHaveBeenCalled();
  });

  it('applies to oidc mode too: an OIDC middleware on 0.0.0.0 without allowedHosts is refused', async () => {
    setOidcAuthMiddleware(async () => true);
    const listenSpy = jest.spyOn(http.Server.prototype, 'listen');

    await expect(
      startHttpTransport(newServer, baseHttpConfig({ host: '0.0.0.0' })),
    ).rejects.toThrow(/VIKUNJA_MCP_HTTP_ALLOWED_HOSTS/);
    expect(listenSpy).not.toHaveBeenCalled();
  });

  it('startHttpTransport starts on 0.0.0.0 with a token and an explicit allowedHosts list', async () => {
    setupStaticTokenAuth(`gw_${'c3'.repeat(20)}`);
    // Stub the bind itself: the assertion is that the listener is reached
    // with the requested host, without opening a wildcard socket on the
    // developer machine.
    const listenSpy = jest.spyOn(http.Server.prototype, 'listen').mockImplementation(function (
      this: http.Server,
      ...args: unknown[]
    ) {
      const callback = args.find((arg) => typeof arg === 'function') as () => void;
      callback();
      return this;
    });

    const handle = await startHttpTransport(
      newServer,
      baseHttpConfig({ host: '0.0.0.0', authMode: 'token', allowedHosts: ['vikunja-mcp:8765'] }),
    );

    expect(listenSpy).toHaveBeenCalledWith(expect.any(Number), '0.0.0.0', expect.any(Function));
    expect(handle.httpServer).toBeInstanceOf(http.Server);
  });

  it('the no-middleware refusal names both auth schemes', async () => {
    await expect(startHttpTransport(newServer, baseHttpConfig())).rejects.toThrow(
      /VIKUNJA_MCP_HTTP_AUTH_MODE set to token/,
    );
  });
});

describe('readBodyWithinCap', () => {
  type FakeRequest = EventEmitter & { headers: http.IncomingHttpHeaders; destroyed: boolean };

  function fakeRequest(): FakeRequest {
    return Object.assign(new EventEmitter(), { headers: {}, destroyed: false });
  }

  function read(req: FakeRequest, cap = 1024): ReturnType<typeof readBodyWithinCap> {
    return readBodyWithinCap(req as unknown as http.IncomingMessage, cap);
  }

  /** Resolves to 'pending' when `promise` has not settled within `ms`. */
  function settledWithin<T>(promise: Promise<T>, ms = 200): Promise<T | 'pending'> {
    return Promise.race([
      promise,
      new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), ms)),
    ]);
  }

  function listenerTotal(req: FakeRequest): number {
    return ['data', 'end', 'error', 'close'].reduce(
      (total, event) => total + req.listenerCount(event),
      0,
    );
  }

  it('settles as aborted when the request is destroyed while the listeners are being attached', async () => {
    // Confirming-review finding: a `close` that lands after the destroyed
    // check but before the close listener exists is never seen again, and
    // the read would wait forever. Modelled here by a request that is
    // destroyed (and emits close) as soon as the data listener attaches.
    const req = fakeRequest();
    const attach = req.on.bind(req);
    req.on = ((event: string, listener: (...args: unknown[]) => void) => {
      attach(event, listener);
      if (event === 'data') {
        req.destroyed = true;
        req.emit('close');
      }
      return req;
    }) as FakeRequest['on'];

    await expect(settledWithin(read(req))).resolves.toEqual({ status: 'aborted' });
    expect(listenerTotal(req)).toBe(0);
  });

  it('settles as aborted, without listening, when the request is already destroyed', async () => {
    const req = fakeRequest();
    req.destroyed = true;

    await expect(settledWithin(read(req))).resolves.toEqual({ status: 'aborted' });
    expect(listenerTotal(req)).toBe(0);
  });

  it('settles once: a close or error after end does not change the result', async () => {
    const req = fakeRequest();
    const result = read(req);

    req.emit('data', Buffer.from('ab'));
    req.emit('end');
    req.emit('close');
    req.emit('data', Buffer.from('late'));

    await expect(result).resolves.toEqual({ status: 'ok', body: Buffer.from('ab') });
    expect(listenerTotal(req)).toBe(0);
  });

  it('counts a close before end as an abort', async () => {
    // Never observed on a complete body (Node emits close after end). The
    // one way it happens is Node destroying the request, e.g. on a client
    // half-close, and then the socket is gone and no answer can be sent.
    const req = fakeRequest();
    const result = read(req);

    req.emit('data', Buffer.from('ab'));
    req.emit('close');
    req.emit('end');

    await expect(result).resolves.toEqual({ status: 'aborted' });
    expect(listenerTotal(req)).toBe(0);
  });

  it('stops at the cap and ignores whatever follows', async () => {
    const req = fakeRequest();
    const result = read(req, 4);

    req.emit('data', Buffer.from('abc'));
    req.emit('data', Buffer.from('de'));
    req.emit('end');

    await expect(result).resolves.toEqual({ status: 'too_large' });
    expect(listenerTotal(req)).toBe(0);
  });

  it('treats a stream error as an abort', async () => {
    const req = fakeRequest();
    const result = read(req);

    req.emit('error', new Error('aborted'));

    await expect(result).resolves.toEqual({ status: 'aborted' });
    expect(listenerTotal(req)).toBe(0);
  });
});
