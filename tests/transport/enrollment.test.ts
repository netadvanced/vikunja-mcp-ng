/**
 * Unit tests for the SSO enrollment service (issue #220): the browser half of
 * one-click auto-provisioning. Every Vikunja/IdP interaction is exercised
 * through an injected `fetch` mock; the vault is a recording stub.
 *
 * Wire facts these tests encode (validated against go-vikunja/vikunja
 * v2.4.0 source — see docs/OIDC-SETUP.md §9a):
 *  - Provider discovery: unauthenticated `GET /info` ->
 *    `auth.openid_connect.{enabled, providers[]}` with `key`, `auth_url`,
 *    `client_id`, `scope`.
 *  - `POST /auth/openid/{key}/callback` body `{code, redirect_url, scope}` ->
 *    `{token: <jwt>}`; the `redirect_url` string is replayed verbatim by
 *    Vikunja as the OAuth `redirect_uri` in its token exchange, so it must be
 *    byte-identical to the one used on the authorize hop.
 *  - `GET /routes` (JWT) -> `{group: {verb: {...}}}`; `PUT /tokens` (JWT,
 *    title/permissions/expires_at all required) -> 201 `{token: "tk_..."}`.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  EnrollmentService,
  getActiveEnrollmentService,
  setActiveEnrollmentService,
  setupEnrollment,
  type EnrollmentServiceDeps,
} from '../../src/transport/enrollment';
import { EnrollmentTicketStore } from '../../src/transport/enrollmentTickets';
import type { Identity } from '../../src/context/requestContext';
import { setActiveVaultStore, type VaultFileStore } from '../../src/storage/vaultFileStore';
import { ConfigurationError, type EnrollConfig, type HttpConfig } from '../../src/config/types';

const alice: Identity = { issuer: 'https://idp.example.test/realms/e', sub: 'alice' };

const ORIGIN = 'https://mcp.example.test';
const VIKUNJA_URL = 'http://vikunja.internal:3456/api/v1';

interface FakeRes {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  headersSent: boolean;
}

function fakeRes(): FakeRes & ServerResponse {
  const res = {
    statusCode: 0,
    headers: {} as Record<string, string>,
    body: '',
    headersSent: false,
    writeHead(code: number, headers?: Record<string, string>) {
      res.statusCode = code;
      res.headers = { ...(headers ?? {}) };
      res.headersSent = true;
      return res;
    },
    end(payload?: string) {
      res.body = payload ?? '';
    },
  };
  return res as unknown as FakeRes & ServerResponse;
}

function fakeReq(method: string, url: string): IncomingMessage {
  return { method, url, headers: {} } as unknown as IncomingMessage;
}

const providerInfo = {
  version: 'v2.4.0',
  auth: {
    openid_connect: {
      enabled: true,
      providers: [
        {
          name: 'Keycloak',
          key: 'keycloak',
          auth_url: 'https://idp.example.test/realms/e/protocol/openid-connect/auth',
          client_id: 'vikunja-client',
          scope: 'openid profile email',
        },
      ],
    },
  },
};

/** Builds a fetch mock scripted per (method, url-suffix) with json responses. */
function scriptedFetch(
  script: Array<{
    match: (method: string, url: string) => boolean;
    status?: number;
    json?: unknown;
    capture?: (init?: RequestInit) => void;
  }>,
): { impl: typeof fetch; unmatched: string[] } {
  const unmatched: string[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const entry = script.find(s => s.match(method, url));
    if (!entry) {
      unmatched.push(`${method} ${url}`);
      return new Response('{}', { status: 599 });
    }
    entry.capture?.(init);
    return new Response(JSON.stringify(entry.json ?? {}), {
      status: entry.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
  return { impl, unmatched };
}

function makeService(
  overrides: Partial<EnrollmentServiceDeps> = {},
): { service: EnrollmentService; tickets: EnrollmentTicketStore; provisioned: unknown[] } {
  const tickets = new EnrollmentTicketStore();
  const provisioned: unknown[] = [];
  const deps: EnrollmentServiceDeps = {
    tickets,
    vault: {
      provision: async (identity: Identity, vikunjaUrl: string, apiToken: string) => {
        provisioned.push({ identity, vikunjaUrl, apiToken });
      },
    },
    vikunjaUrl: VIKUNJA_URL,
    publicOrigin: ORIGIN,
    tokenExpiryDays: 365,
    fetchImpl: scriptedFetch([{ match: () => true, json: providerInfo }]).impl,
    ...overrides,
  };
  return { service: new EnrollmentService(deps), tickets, provisioned };
}

describe('EnrollmentService.createEnrollmentUrl', () => {
  it('returns an /enroll URL on the public origin carrying a ticket bound to the identity', () => {
    const { service, tickets } = makeService();
    const url = service.createEnrollmentUrl(alice);
    const parsed = new URL(url);
    expect(parsed.origin).toBe(ORIGIN);
    expect(parsed.pathname).toBe('/enroll');
    const ticket = parsed.searchParams.get('ticket');
    expect(ticket).toBeTruthy();
    expect(tickets.peek(ticket as string)).toEqual(alice);
  });
});

describe('EnrollmentService.handleRequest routing', () => {
  it('ignores unrelated paths (returns false, writes nothing)', async () => {
    const { service } = makeService();
    const res = fakeRes();
    expect(await service.handleRequest(fakeReq('GET', '/mcp'), res)).toBe(false);
    expect(await service.handleRequest(fakeReq('GET', '/healthz'), res)).toBe(false);
    expect(res.headersSent).toBe(false);
  });

  it('rejects non-GET methods on enrollment paths with 405', async () => {
    const { service } = makeService();
    const res = fakeRes();
    expect(await service.handleRequest(fakeReq('POST', '/enroll?ticket=x'), res)).toBe(true);
    expect(res.statusCode).toBe(405);
  });
});

describe('GET /enroll', () => {
  it('redirects a valid ticket to the IdP authorize endpoint with the verified parameters', async () => {
    const { service } = makeService();
    const enrollUrl = new URL(service.createEnrollmentUrl(alice));
    const ticket = enrollUrl.searchParams.get('ticket') as string;

    const res = fakeRes();
    expect(
      await service.handleRequest(fakeReq('GET', `/enroll?ticket=${ticket}`), res),
    ).toBe(true);

    expect(res.statusCode).toBe(302);
    const location = new URL(res.headers['Location']);
    expect(location.origin + location.pathname).toBe(
      'https://idp.example.test/realms/e/protocol/openid-connect/auth',
    );
    expect(location.searchParams.get('response_type')).toBe('code');
    // The code must be minted for Vikunja's OWN client (aud check upstream).
    expect(location.searchParams.get('client_id')).toBe('vikunja-client');
    expect(location.searchParams.get('redirect_uri')).toBe(`${ORIGIN}/enroll/callback`);
    expect(location.searchParams.get('scope')).toBe('openid profile email');
    expect(location.searchParams.get('state')).toBe(ticket);
  });

  it('does not consume the ticket on /enroll (the IdP hop may be retried)', async () => {
    const { service, tickets } = makeService();
    const ticket = new URL(service.createEnrollmentUrl(alice)).searchParams.get(
      'ticket',
    ) as string;
    await service.handleRequest(fakeReq('GET', `/enroll?ticket=${ticket}`), fakeRes());
    expect(tickets.peek(ticket)).toEqual(alice);
  });

  it('rejects a missing or unknown ticket with 400', async () => {
    const { service } = makeService();
    for (const path of ['/enroll', '/enroll?ticket=forged']) {
      const res = fakeRes();
      await service.handleRequest(fakeReq('GET', path), res);
      expect(res.statusCode).toBe(400);
      expect(res.body).toMatch(/invalid or expired/i);
    }
  });

  it('fails cleanly when the backend has OpenID disabled', async () => {
    const { service } = makeService({
      fetchImpl: scriptedFetch([
        {
          match: (m, u) => m === 'GET' && u.endsWith('/info'),
          json: { auth: { openid_connect: { enabled: false, providers: null } } },
        },
      ]).impl,
    });
    const ticket = new URL(service.createEnrollmentUrl(alice)).searchParams.get(
      'ticket',
    ) as string;
    const res = fakeRes();
    await service.handleRequest(fakeReq('GET', `/enroll?ticket=${ticket}`), res);
    expect(res.statusCode).toBe(502);
    expect(res.body).toMatch(/OpenID/i);
  });

  it('fails cleanly when /info itself is unreachable', async () => {
    const failingFetch = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const { service } = makeService({ fetchImpl: failingFetch });
    const ticket = new URL(service.createEnrollmentUrl(alice)).searchParams.get(
      'ticket',
    ) as string;
    const res = fakeRes();
    await service.handleRequest(fakeReq('GET', `/enroll?ticket=${ticket}`), res);
    expect(res.statusCode).toBe(502);
  });

  it('selects the configured provider by key and errors on an unknown one', async () => {
    const twoProviders = {
      auth: {
        openid_connect: {
          enabled: true,
          providers: [
            providerInfo.auth.openid_connect.providers[0],
            {
              name: 'Other',
              key: 'other',
              auth_url: 'https://other.example.test/auth',
              client_id: 'other-client',
              scope: 'openid',
            },
          ],
        },
      },
    };
    const fetchImpl = scriptedFetch([
      { match: (m, u) => m === 'GET' && u.endsWith('/info'), json: twoProviders },
    ]).impl;

    const named = makeService({ fetchImpl, providerName: 'other' });
    let ticket = new URL(named.service.createEnrollmentUrl(alice)).searchParams.get(
      'ticket',
    ) as string;
    let res = fakeRes();
    await named.service.handleRequest(fakeReq('GET', `/enroll?ticket=${ticket}`), res);
    expect(res.statusCode).toBe(302);
    expect(res.headers['Location']).toContain('other.example.test');

    const missing = makeService({ fetchImpl, providerName: 'nope' });
    ticket = new URL(missing.service.createEnrollmentUrl(alice)).searchParams.get(
      'ticket',
    ) as string;
    res = fakeRes();
    await missing.service.handleRequest(fakeReq('GET', `/enroll?ticket=${ticket}`), res);
    expect(res.statusCode).toBe(502);
    expect(res.body).toMatch(/nope/);

    // Several providers with none configured: ambiguous -> clean error.
    const ambiguous = makeService({ fetchImpl });
    ticket = new URL(ambiguous.service.createEnrollmentUrl(alice)).searchParams.get(
      'ticket',
    ) as string;
    res = fakeRes();
    await ambiguous.service.handleRequest(fakeReq('GET', `/enroll?ticket=${ticket}`), res);
    expect(res.statusCode).toBe(502);
  });
});

describe('GET /enroll/callback', () => {
  function happyPathFetch(captures: {
    callbackBody?: unknown;
    tokenBody?: unknown;
    routesAuth?: string | null;
    tokensAuth?: string | null;
  }): typeof fetch {
    return scriptedFetch([
      { match: (m, u) => m === 'GET' && u.endsWith('/info'), json: providerInfo },
      {
        match: (m, u) => m === 'POST' && u.endsWith('/auth/openid/keycloak/callback'),
        json: { token: 'vikunja-user-jwt' },
        capture: init => {
          captures.callbackBody = JSON.parse(String(init?.body));
        },
      },
      {
        match: (m, u) => m === 'GET' && u.endsWith('/routes'),
        json: { tasks: { read_all: {}, update: {} }, projects: { read_all: {} } },
        capture: init => {
          captures.routesAuth = new Headers(init?.headers).get('Authorization');
        },
      },
      {
        match: (m, u) => m === 'PUT' && u.endsWith('/tokens'),
        status: 201,
        json: { id: 7, token: 'tk_minted_secret' },
        capture: init => {
          captures.tokenBody = JSON.parse(String(init?.body));
          captures.tokensAuth = new Headers(init?.headers).get('Authorization');
        },
      },
    ]).impl;
  }

  async function runCallback(
    overrides: Partial<EnrollmentServiceDeps>,
    query?: string,
  ): Promise<{ res: FakeRes; provisioned: unknown[]; ticket: string }> {
    const built = makeService(overrides);
    const ticket = new URL(built.service.createEnrollmentUrl(alice)).searchParams.get(
      'ticket',
    ) as string;
    const res = fakeRes();
    await built.service.handleRequest(
      fakeReq('GET', `/enroll/callback?${query ?? `code=authcode-1&state=${ticket}`}`),
      res,
    );
    return { res, provisioned: built.provisioned, ticket };
  }

  it('drives the full verified chain: Vikunja callback -> routes -> token mint -> vault', async () => {
    const captures: Record<string, unknown> = {};
    const { res, provisioned } = await runCallback({
      fetchImpl: happyPathFetch(captures),
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Type']).toContain('text/html');
    expect(res.body).toMatch(/connected/i);
    expect(res.body).toMatch(/return to your chat/i);

    // The Vikunja openid callback body — redirect_url must be byte-identical
    // to the authorize hop's redirect_uri (Vikunja replays it in the token
    // exchange), and scope rides along per openid.Callback.
    expect(captures.callbackBody).toEqual({
      code: 'authcode-1',
      redirect_url: `${ORIGIN}/enroll/callback`,
      scope: 'openid profile email',
    });

    // Both JWT-authenticated calls used the callback's JWT.
    expect(captures.routesAuth).toBe('Bearer vikunja-user-jwt');
    expect(captures.tokensAuth).toBe('Bearer vikunja-user-jwt');

    // PUT /tokens: title/permissions/expires_at are all required upstream;
    // permissions is the full GET /routes enumeration.
    const tokenBody = captures.tokenBody as {
      title: string;
      permissions: Record<string, string[]>;
      expires_at: string;
    };
    expect(tokenBody.title).toMatch(/vikunja-mcp/);
    expect(tokenBody.permissions).toEqual({
      tasks: ['read_all', 'update'],
      projects: ['read_all'],
    });
    expect(new Date(tokenBody.expires_at).getTime()).toBeGreaterThan(Date.now());

    expect(provisioned).toEqual([
      { identity: alice, vikunjaUrl: VIKUNJA_URL, apiToken: 'tk_minted_secret' },
    ]);
    // The minted token and the JWT must never leak into the browser page.
    expect(res.body).not.toContain('tk_minted_secret');
    expect(res.body).not.toContain('vikunja-user-jwt');
  });

  it('consumes the ticket: a replayed callback is rejected', async () => {
    const captures: Record<string, unknown> = {};
    const built = makeService({ fetchImpl: happyPathFetch(captures) });
    const ticket = new URL(built.service.createEnrollmentUrl(alice)).searchParams.get(
      'ticket',
    ) as string;

    const first = fakeRes();
    await built.service.handleRequest(
      fakeReq('GET', `/enroll/callback?code=authcode-1&state=${ticket}`),
      first,
    );
    expect(first.statusCode).toBe(200);

    const replay = fakeRes();
    await built.service.handleRequest(
      fakeReq('GET', `/enroll/callback?code=authcode-2&state=${ticket}`),
      replay,
    );
    expect(replay.statusCode).toBe(400);
    expect(built.provisioned).toHaveLength(1);
  });

  it('surfaces an IdP error redirect cleanly without touching Vikunja', async () => {
    const { res, provisioned } = await runCallback({}, 'error=access_denied&state=whatever');
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('access_denied');
    expect(provisioned).toHaveLength(0);
  });

  it('escapes IdP-controlled error text in the HTML page', async () => {
    const { res } = await runCallback({}, 'error=%3Cscript%3Ealert(1)%3C%2Fscript%3E');
    expect(res.body).not.toContain('<script>alert(1)</script>');
  });

  it('rejects a callback with missing code or state', async () => {
    for (const query of ['code=x', 'state=y', '']) {
      const { res, provisioned } = await runCallback({}, query);
      expect(res.statusCode).toBe(400);
      expect(provisioned).toHaveLength(0);
    }
  });

  it('rejects a forged/expired state with 400 and never calls Vikunja', async () => {
    const script = scriptedFetch([]);
    const { res, provisioned } = await runCallback(
      { fetchImpl: script.impl },
      'code=authcode-1&state=forged',
    );
    expect(res.statusCode).toBe(400);
    expect(provisioned).toHaveLength(0);
    expect(script.unmatched).toHaveLength(0); // no outbound call at all
  });

  it('fails with 502 when Vikunja rejects the code (e.g. TOTP 412), leaving the vault untouched', async () => {
    const fetchImpl = scriptedFetch([
      { match: (m, u) => m === 'GET' && u.endsWith('/info'), json: providerInfo },
      {
        match: (m, u) => m === 'POST' && u.endsWith('/callback'),
        status: 412,
        json: { message: 'Invalid totp passcode.' },
      },
    ]).impl;
    const { res, provisioned } = await runCallback({ fetchImpl });
    expect(res.statusCode).toBe(502);
    expect(provisioned).toHaveLength(0);
  });

  it('fails with 502 when the callback response has no token field', async () => {
    const fetchImpl = scriptedFetch([
      { match: (m, u) => m === 'GET' && u.endsWith('/info'), json: providerInfo },
      { match: (m, u) => m === 'POST' && u.endsWith('/callback'), json: {} },
    ]).impl;
    const { res, provisioned } = await runCallback({ fetchImpl });
    expect(res.statusCode).toBe(502);
    expect(provisioned).toHaveLength(0);
  });

  it('fails with 502 when GET /routes or PUT /tokens fails, leaving the vault untouched', async () => {
    const routesFail = scriptedFetch([
      { match: (m, u) => m === 'GET' && u.endsWith('/info'), json: providerInfo },
      { match: (m, u) => m === 'POST' && u.endsWith('/callback'), json: { token: 'jwt' } },
      { match: (m, u) => m === 'GET' && u.endsWith('/routes'), status: 401, json: {} },
    ]).impl;
    let result = await runCallback({ fetchImpl: routesFail });
    expect(result.res.statusCode).toBe(502);
    expect(result.provisioned).toHaveLength(0);

    const mintFail = scriptedFetch([
      { match: (m, u) => m === 'GET' && u.endsWith('/info'), json: providerInfo },
      { match: (m, u) => m === 'POST' && u.endsWith('/callback'), json: { token: 'jwt' } },
      { match: (m, u) => m === 'GET' && u.endsWith('/routes'), json: { tasks: { read_all: {} } } },
      { match: (m, u) => m === 'PUT' && u.endsWith('/tokens'), status: 400, json: {} },
    ]).impl;
    result = await runCallback({ fetchImpl: mintFail });
    expect(result.res.statusCode).toBe(502);
    expect(result.provisioned).toHaveLength(0);

    const noToken = scriptedFetch([
      { match: (m, u) => m === 'GET' && u.endsWith('/info'), json: providerInfo },
      { match: (m, u) => m === 'POST' && u.endsWith('/callback'), json: { token: 'jwt' } },
      { match: (m, u) => m === 'GET' && u.endsWith('/routes'), json: { tasks: { read_all: {} } } },
      { match: (m, u) => m === 'PUT' && u.endsWith('/tokens'), status: 201, json: { id: 1 } },
    ]).impl;
    result = await runCallback({ fetchImpl: noToken });
    expect(result.res.statusCode).toBe(502);
    expect(result.provisioned).toHaveLength(0);
  });

  it('accepts 200 as well as 201 from PUT /tokens (spec says 200, server says 201)', async () => {
    const fetchImpl = scriptedFetch([
      { match: (m, u) => m === 'GET' && u.endsWith('/info'), json: providerInfo },
      { match: (m, u) => m === 'POST' && u.endsWith('/callback'), json: { token: 'jwt' } },
      { match: (m, u) => m === 'GET' && u.endsWith('/routes'), json: { tasks: { read_all: {} } } },
      { match: (m, u) => m === 'PUT' && u.endsWith('/tokens'), status: 200, json: { token: 'tk_ok' } },
    ]).impl;
    const { res, provisioned } = await runCallback({ fetchImpl });
    expect(res.statusCode).toBe(200);
    expect(provisioned).toHaveLength(1);
  });

  it('reports a vault write failure as a 500 without leaking internals', async () => {
    const captures: Record<string, unknown> = {};
    const { res } = await (async () => {
      const built = makeService({
        fetchImpl: happyPathFetch(captures),
        vault: {
          provision: async () => {
            throw new Error('disk full at /var/secret/vault.json');
          },
        },
      });
      const ticket = new URL(built.service.createEnrollmentUrl(alice)).searchParams.get(
        'ticket',
      ) as string;
      const res = fakeRes();
      await built.service.handleRequest(
        fakeReq('GET', `/enroll/callback?code=c&state=${ticket}`),
        res,
      );
      return { res };
    })();
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain('/var/secret/vault.json');
  });
});

describe('setupEnrollment (production wiring)', () => {
  const httpConfig: HttpConfig = {
    host: '127.0.0.1',
    port: 8765,
    path: '/mcp',
    publicUrl: 'https://mcp.example.test/mcp',
  };
  const enrollConfig = (overrides: Partial<EnrollConfig> = {}): EnrollConfig => ({
    enabled: true,
    tokenExpiryDays: 365,
    ticketTtlSec: 600,
    ...overrides,
  });
  const fakeVault = { provision: jest.fn() } as unknown as VaultFileStore;

  afterEach(() => {
    setActiveEnrollmentService(undefined);
    setActiveVaultStore(undefined);
  });

  it('registers nothing when enrollment is disabled', () => {
    setActiveVaultStore(fakeVault);
    setupEnrollment(enrollConfig({ enabled: false }), httpConfig, VIKUNJA_URL);
    expect(getActiveEnrollmentService()).toBeUndefined();
  });

  it('fails loud when enabled without an active vault (setup-order bug)', () => {
    expect(() => setupEnrollment(enrollConfig(), httpConfig, VIKUNJA_URL)).toThrow(
      ConfigurationError,
    );
  });

  it('fails loud when enabled with no resolvable Vikunja URL', () => {
    setActiveVaultStore(fakeVault);
    expect(() => setupEnrollment(enrollConfig(), httpConfig, undefined)).toThrow(
      ConfigurationError,
    );
  });

  it('registers a service issuing URLs on the publicUrl origin (config URL wins over fallback)', () => {
    setActiveVaultStore(fakeVault);
    setupEnrollment(
      enrollConfig({ vikunjaUrl: 'https://vikunja.example.test/api/v1' }),
      httpConfig,
      'http://fallback.example/api/v1',
    );
    const service = getActiveEnrollmentService();
    expect(service).toBeDefined();
    const url = new URL((service as EnrollmentService).createEnrollmentUrl(alice));
    expect(url.origin).toBe('https://mcp.example.test');
    expect(url.pathname).toBe('/enroll');
  });

  it('derives the public origin from the bind address when no publicUrl is set', () => {
    setActiveVaultStore(fakeVault);
    setupEnrollment(enrollConfig(), { host: '127.0.0.1', port: 9123, path: '/mcp' }, VIKUNJA_URL);
    const url = new URL(
      (getActiveEnrollmentService() as EnrollmentService).createEnrollmentUrl(alice),
    );
    expect(url.origin).toBe('http://127.0.0.1:9123');
  });
});
