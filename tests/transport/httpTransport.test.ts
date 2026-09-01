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

import * as http from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  startHttpTransport,
  resolveAllowedHosts,
  type HttpTransportHandle,
} from '../../src/transport/httpTransport';
import {
  setOidcAuthMiddleware,
  type HttpRequestWithAuth,
} from '../../src/transport/oidcMiddlewareSeam';
import { EnrollmentService, setActiveEnrollmentService } from '../../src/transport/enrollment';
import { EnrollmentTicketStore } from '../../src/transport/enrollmentTickets';
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
  options: { method?: string; path?: string; headers?: Record<string, string>; body?: string } = {},
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

    afterEach(async () => {
      if (handle) {
        await handle.close();
      }
    });

    it('starts and serves /healthz unauthenticated even when the middleware would reject', async () => {
      setOidcAuthMiddleware(async () => false);
      handle = await startHttpTransport(newServer, baseHttpConfig());
      const port = getPort(handle);

      const res = await request(port, { path: '/healthz' });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ status: 'ok' });
    });

    it('starts and serves /readyz unauthenticated even when the middleware would reject', async () => {
      setOidcAuthMiddleware(async () => false);
      handle = await startHttpTransport(newServer, baseHttpConfig());
      const port = getPort(handle);

      const res = await request(port, { path: '/readyz' });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ status: 'ok' });
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
