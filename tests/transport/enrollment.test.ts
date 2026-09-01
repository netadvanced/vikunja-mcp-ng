/**
 * Unit tests for the SSO enrollment service (issue #220): the browser half of
 * one-click auto-provisioning. Every Vikunja interaction goes through an
 * injected `vikunjaRestRequest`-shaped function (finding #8 — retry/breaker
 * parity with the rest of the codebase); the vault is a recording stub.
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
 *  - `GET /user` (JWT) -> `{username, email}` — the only identity surface the
 *    API exposes (issuer/subject stay DB-internal), used to pin the enrolled
 *    account to the initiating identity (finding #1).
 *  - `GET /routes` (JWT) -> `{group: {verb: {...}}}`; `PUT /tokens` (JWT,
 *    title/permissions/expires_at all required) -> `{token: "tk_..."}`.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AuthManager } from '../../src/auth/AuthManager';
import {
  EnrollmentService,
  getActiveEnrollmentService,
  setActiveEnrollmentService,
  setupEnrollment,
  type EnrollmentRestRequest,
  type EnrollmentServiceDeps,
} from '../../src/transport/enrollment';
import { EnrollmentTicketStore } from '../../src/transport/enrollmentTickets';
import type { Identity } from '../../src/context/requestContext';
import { setActiveVaultStore, type VaultFileStore } from '../../src/storage/vaultFileStore';
import { ConfigurationError, type EnrollConfig, type HttpConfig } from '../../src/config/types';

const alice: Identity = {
  issuer: 'https://idp.example.test/realms/e',
  sub: 'alice-sub',
  email: 'Alice@example.test',
  preferredUsername: 'alice',
};
const mallory: Identity = {
  issuer: 'https://idp.example.test/realms/e',
  sub: 'mallory-sub',
  email: 'mallory@example.test',
  preferredUsername: 'mallory',
};

const BASE = 'https://mcp.example.test';
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

/** One recorded outbound Vikunja call as seen by the mocked rest layer. */
interface RestCall {
  method: string;
  path: string;
  body: unknown;
  /** The session token of the AuthManager the call was issued with. */
  token: string | undefined;
  options: unknown;
}

interface RestScriptEntry {
  match: (method: string, path: string) => boolean;
  result?: unknown;
  error?: unknown;
}

/** Builds a vikunjaRestRequest-shaped mock scripted per (method, path). */
function scriptedRest(script: RestScriptEntry[]): {
  impl: EnrollmentRestRequest;
  calls: RestCall[];
} {
  const calls: RestCall[] = [];
  const impl = (async (
    authManager: AuthManager,
    method: string,
    path: string,
    body?: unknown,
    options?: unknown,
  ): Promise<unknown> => {
    let token: string | undefined;
    try {
      token = authManager.getSession().apiToken;
    } catch {
      token = undefined;
    }
    calls.push({ method, path, body, token, options });
    const entry = script.find(s => s.match(method, path));
    if (!entry) {
      throw new Error(`unscripted Vikunja call: ${method} ${path}`);
    }
    if (entry.error !== undefined) {
      throw entry.error;
    }
    return entry.result ?? null;
  }) as EnrollmentRestRequest;
  return { impl, calls };
}

const enrolledAlice = { id: 3, username: 'alice', email: 'alice@example.test' };

function happyScript(overrides: Partial<Record<string, RestScriptEntry>> = {}): RestScriptEntry[] {
  return [
    overrides.info ?? { match: (m, p) => m === 'GET' && p === '/info', result: providerInfo },
    overrides.callback ?? {
      match: (m, p) => m === 'POST' && p === '/auth/openid/keycloak/callback',
      result: { token: 'vikunja-user-jwt' },
    },
    overrides.user ?? { match: (m, p) => m === 'GET' && p === '/user', result: enrolledAlice },
    overrides.routes ?? {
      match: (m, p) => m === 'GET' && p === '/routes',
      result: { tasks: { read_all: {}, update: {} }, projects: { read_all: {} } },
    },
    overrides.tokens ?? {
      match: (m, p) => m === 'PUT' && p === '/tokens',
      result: { id: 7, token: 'tk_minted_secret' },
    },
  ];
}

function makeService(overrides: Partial<EnrollmentServiceDeps> = {}): {
  service: EnrollmentService;
  tickets: EnrollmentTicketStore;
  provisioned: unknown[];
} {
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
    publicBaseUrl: BASE,
    tokenExpiryDays: 365,
    restRequest: scriptedRest(happyScript()).impl,
    ...overrides,
  };
  return { service: new EnrollmentService(deps), tickets, provisioned };
}

describe('EnrollmentService.createEnrollmentUrl', () => {
  it('returns an /enroll URL under the public base carrying a ticket bound to the identity', () => {
    const { service, tickets } = makeService();
    const url = service.createEnrollmentUrl(alice);
    const parsed = new URL(url);
    expect(parsed.origin).toBe(BASE);
    expect(parsed.pathname).toBe('/enroll');
    const ticket = parsed.searchParams.get('ticket');
    expect(ticket).toBeTruthy();
    expect(tickets.peek(ticket as string)).toEqual(alice);
  });

  it('preserves a path-prefixed public base (finding #2)', () => {
    const { service } = makeService({ publicBaseUrl: 'https://mcp.example.test/prefix' });
    const parsed = new URL(service.createEnrollmentUrl(alice));
    expect(parsed.pathname).toBe('/prefix/enroll');
  });

  it('exposes the enrollment Vikunja target (finding #3 support)', () => {
    const { service } = makeService();
    expect(service.vikunjaUrl).toBe(VIKUNJA_URL);
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

  it('ignores malformed or non-origin-form request targets instead of erroring (finding #6)', async () => {
    const { service } = makeService();
    for (const target of ['http://evil.example/enroll', '//evil.example/enroll', '*', 'enroll']) {
      const res = fakeRes();
      expect(await service.handleRequest(fakeReq('GET', target), res)).toBe(false);
      expect(res.headersSent).toBe(false);
    }
  });

  it('serves the prefixed paths — and only those — when the public base has a path (finding #2)', async () => {
    const { service } = makeService({ publicBaseUrl: 'https://mcp.example.test/prefix' });
    const unprefixed = fakeRes();
    expect(await service.handleRequest(fakeReq('GET', '/enroll?ticket=x'), unprefixed)).toBe(false);
    expect(unprefixed.headersSent).toBe(false);

    const prefixed = fakeRes();
    expect(await service.handleRequest(fakeReq('GET', '/prefix/enroll?ticket=x'), prefixed)).toBe(
      true,
    );
    expect(prefixed.statusCode).toBe(400); // invalid ticket, but routed
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
    const ticket = new URL(service.createEnrollmentUrl(alice)).searchParams.get('ticket') as string;

    const res = fakeRes();
    expect(await service.handleRequest(fakeReq('GET', `/enroll?ticket=${ticket}`), res)).toBe(true);

    expect(res.statusCode).toBe(302);
    const location = new URL(res.headers['Location']);
    expect(location.origin + location.pathname).toBe(
      'https://idp.example.test/realms/e/protocol/openid-connect/auth',
    );
    expect(location.searchParams.get('response_type')).toBe('code');
    // The code must be minted for Vikunja's OWN client (aud check upstream).
    expect(location.searchParams.get('client_id')).toBe('vikunja-client');
    expect(location.searchParams.get('redirect_uri')).toBe(`${BASE}/enroll/callback`);
    expect(location.searchParams.get('scope')).toBe('openid profile email');
    expect(location.searchParams.get('state')).toBe(ticket);
  });

  it('does not consume the ticket on /enroll (the IdP hop may be retried)', async () => {
    const { service, tickets } = makeService();
    const ticket = new URL(service.createEnrollmentUrl(alice)).searchParams.get('ticket') as string;
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
      restRequest: scriptedRest([
        {
          match: (m, p) => m === 'GET' && p === '/info',
          result: { auth: { openid_connect: { enabled: false, providers: null } } },
        },
      ]).impl,
    });
    const ticket = new URL(service.createEnrollmentUrl(alice)).searchParams.get('ticket') as string;
    const res = fakeRes();
    await service.handleRequest(fakeReq('GET', `/enroll?ticket=${ticket}`), res);
    expect(res.statusCode).toBe(502);
    expect(res.body).toMatch(/OpenID/i);
  });

  it('fails cleanly when /info itself is unreachable', async () => {
    const { service } = makeService({
      restRequest: scriptedRest([
        { match: (m, p) => m === 'GET' && p === '/info', error: new Error('ECONNREFUSED') },
      ]).impl,
    });
    const ticket = new URL(service.createEnrollmentUrl(alice)).searchParams.get('ticket') as string;
    const res = fakeRes();
    await service.handleRequest(fakeReq('GET', `/enroll?ticket=${ticket}`), res);
    expect(res.statusCode).toBe(502);
  });

  it('treats a provider missing client_id or key as unusable (finding #12 — no silent empty fallbacks)', async () => {
    for (const broken of [
      { name: 'NoClient', key: 'noclient', auth_url: 'https://idp.example.test/auth' },
      { name: 'NoKey', auth_url: 'https://idp.example.test/auth', client_id: 'c' },
    ]) {
      const { service } = makeService({
        restRequest: scriptedRest([
          {
            match: (m, p) => m === 'GET' && p === '/info',
            result: { auth: { openid_connect: { enabled: true, providers: [broken] } } },
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
    }
  });

  it('selects the configured provider by key and errors on an unknown or ambiguous one', async () => {
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
    const restRequest = scriptedRest([
      { match: (m, p) => m === 'GET' && p === '/info', result: twoProviders },
    ]).impl;

    const named = makeService({ restRequest, providerName: 'other' });
    let ticket = new URL(named.service.createEnrollmentUrl(alice)).searchParams.get(
      'ticket',
    ) as string;
    let res = fakeRes();
    await named.service.handleRequest(fakeReq('GET', `/enroll?ticket=${ticket}`), res);
    expect(res.statusCode).toBe(302);
    expect(res.headers['Location']).toContain('other.example.test');

    const missing = makeService({ restRequest, providerName: 'nope' });
    ticket = new URL(missing.service.createEnrollmentUrl(alice)).searchParams.get(
      'ticket',
    ) as string;
    res = fakeRes();
    await missing.service.handleRequest(fakeReq('GET', `/enroll?ticket=${ticket}`), res);
    expect(res.statusCode).toBe(502);
    expect(res.body).toMatch(/nope/);

    const ambiguous = makeService({ restRequest });
    ticket = new URL(ambiguous.service.createEnrollmentUrl(alice)).searchParams.get(
      'ticket',
    ) as string;
    res = fakeRes();
    await ambiguous.service.handleRequest(fakeReq('GET', `/enroll?ticket=${ticket}`), res);
    expect(res.statusCode).toBe(502);
  });
});

describe('GET /enroll/callback', () => {
  async function runCallback(
    overrides: Partial<EnrollmentServiceDeps>,
    query?: string,
    identity: Identity = alice,
  ): Promise<{
    res: FakeRes;
    provisioned: unknown[];
    ticket: string;
    tickets: EnrollmentTicketStore;
    service: EnrollmentService;
  }> {
    const built = makeService(overrides);
    const ticket = new URL(built.service.createEnrollmentUrl(identity)).searchParams.get(
      'ticket',
    ) as string;
    const res = fakeRes();
    await built.service.handleRequest(
      fakeReq('GET', `/enroll/callback?${query ?? `code=authcode-1&state=${ticket}`}`),
      res,
    );
    return { res, provisioned: built.provisioned, ticket, tickets: built.tickets, service: built.service };
  }

  it('drives the full verified chain: Vikunja callback -> identity check -> routes -> token mint -> vault', async () => {
    const scripted = scriptedRest(happyScript());
    const { res, provisioned } = await runCallback({ restRequest: scripted.impl });

    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Type']).toContain('text/html');
    expect(res.body).toMatch(/connected/i);
    expect(res.body).toMatch(/return to your chat/i);

    const byPath = (p: string): RestCall[] => scripted.calls.filter(c => c.path === p);

    // The Vikunja openid callback body — redirect_url must be byte-identical
    // to the authorize hop's redirect_uri (Vikunja replays it in the token
    // exchange), and scope rides along per openid.Callback.
    expect(byPath('/auth/openid/keycloak/callback')[0]?.body).toEqual({
      code: 'authcode-1',
      redirect_url: `${BASE}/enroll/callback`,
      scope: 'openid profile email',
    });

    // Every JWT-authenticated call used the callback's JWT.
    expect(byPath('/user')[0]?.token).toBe('vikunja-user-jwt');
    expect(byPath('/routes')[0]?.token).toBe('vikunja-user-jwt');
    expect(byPath('/tokens')[0]?.token).toBe('vikunja-user-jwt');

    // PUT /tokens: title/permissions/expires_at are all required upstream;
    // permissions is the full GET /routes enumeration. The mint itself is
    // non-retried (a retried ambiguous failure could double-mint).
    const mint = byPath('/tokens')[0] as RestCall;
    const tokenBody = mint.body as {
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
    expect((mint.options as { retry?: { maxRetries?: number } })?.retry?.maxRetries).toBe(0);

    expect(provisioned).toEqual([
      { identity: alice, vikunjaUrl: VIKUNJA_URL, apiToken: 'tk_minted_secret' },
    ]);
    // The minted token and the JWT must never leak into the browser page.
    expect(res.body).not.toContain('tk_minted_secret');
    expect(res.body).not.toContain('vikunja-user-jwt');
  });

  describe('enrolled-account/identity pinning (finding #1 — forwarded-link attack)', () => {
    it("attacker's ticket + victim's SSO session: Vikunja reports the victim's account -> 403, nothing vaulted", async () => {
      // Mallory ran provision and sent HER enrollment link to Alice, whose
      // active IdP session completed the hop — Vikunja's JWT belongs to
      // Alice. Linking it under Mallory's identity must be refused.
      const { res, provisioned } = await runCallback(
        { restRequest: scriptedRest(happyScript()).impl }, // /user -> alice's account
        undefined,
        mallory, // ticket identity
      );
      expect(res.statusCode).toBe(403);
      expect(res.body).toMatch(/different .*account|does not match|another account/i);
      expect(provisioned).toHaveLength(0);
    });

    it("victim's ticket + attacker's SSO session: Vikunja reports the attacker's account -> 403, nothing vaulted", async () => {
      const { res, provisioned } = await runCallback(
        {
          restRequest: scriptedRest(
            happyScript({
              user: {
                match: (m, p) => m === 'GET' && p === '/user',
                result: { id: 9, username: 'mallory', email: 'mallory@example.test' },
              },
            }),
          ).impl,
        },
        undefined,
        alice,
      );
      expect(res.statusCode).toBe(403);
      expect(provisioned).toHaveLength(0);
    });

    it('matches on email case-insensitively', async () => {
      // alice.email is 'Alice@example.test'; Vikunja stores lower-case.
      const { res, provisioned } = await runCallback({
        restRequest: scriptedRest(happyScript()).impl,
      });
      expect(res.statusCode).toBe(200);
      expect(provisioned).toHaveLength(1);
    });

    it('falls back to preferred_username/username matching when the MCP token has no email claim', async () => {
      const noEmail: Identity = {
        issuer: alice.issuer,
        sub: alice.sub,
        preferredUsername: 'alice',
      };
      const { res, provisioned } = await runCallback(
        { restRequest: scriptedRest(happyScript()).impl },
        undefined,
        noEmail,
      );
      expect(res.statusCode).toBe(200);
      expect(provisioned).toHaveLength(1);
    });

    it('fails CLOSED when the MCP token carries neither email nor preferred_username', async () => {
      const bare: Identity = { issuer: alice.issuer, sub: alice.sub };
      const { res, provisioned } = await runCallback(
        { restRequest: scriptedRest(happyScript()).impl },
        undefined,
        bare,
      );
      expect(res.statusCode).toBe(403);
      expect(res.body).toMatch(/verify/i);
      expect(provisioned).toHaveLength(0);
    });

    it('fails CLOSED when GET /user fails or returns no identity surface', async () => {
      const { res, provisioned } = await runCallback({
        restRequest: scriptedRest(
          happyScript({
            user: { match: (m, p) => m === 'GET' && p === '/user', error: new Error('HTTP 500') },
          }),
        ).impl,
      });
      expect(res.statusCode).toBe(502);
      expect(provisioned).toHaveLength(0);
    });
  });

  describe('username-squatting mismatch (issue #224)', () => {
    // Mallory's Vikunja account already owns username "mallory", so when
    // Alice's IdP presents preferred_username "mallory" during her own SSO
    // enrollment, Vikunja auto-creates her account under a random username
    // instead. Alice's ticket carries no email claim (2.4.0's realistic
    // shape per issue #223), so the mismatch falls all the way through to
    // the username fallback, which also fails.
    const aliceNoEmail: Identity = {
      issuer: alice.issuer,
      sub: alice.sub,
      preferredUsername: 'mallory',
    };
    const randomUsernameAccount = {
      id: 77,
      username: 'quickly-touched-buzzard',
      email: 'quickly-touched-buzzard@example.test',
    };

    it('detects a live username collision via GET /users?s= and surfaces a squatting-specific 403', async () => {
      const scripted = scriptedRest([
        ...happyScript({
          user: { match: (m, p) => m === 'GET' && p === '/user', result: randomUsernameAccount },
        }),
        {
          match: (m, p) => m === 'GET' && p === '/users?s=mallory',
          result: [{ id: 42, username: 'mallory' }],
        },
      ]);
      const { res, provisioned } = await runCallback(
        { restRequest: scripted.impl },
        undefined,
        aliceNoEmail,
      );

      expect(res.statusCode).toBe(403);
      expect(res.body).toMatch(/squatting/i);
      expect(res.body).toContain('mallory');
      expect(provisioned).toHaveLength(0);

      const search = scripted.calls.find(c => c.path === '/users?s=mallory');
      expect(search?.token).toBe('vikunja-user-jwt');
    });

    it('does not flag squatting when the /users search finds no OTHER account holding the username', async () => {
      const scripted = scriptedRest([
        ...happyScript({
          user: { match: (m, p) => m === 'GET' && p === '/user', result: randomUsernameAccount },
        }),
        {
          match: (m, p) => m === 'GET' && p === '/users?s=mallory',
          result: [],
        },
      ]);
      const { res, provisioned } = await runCallback(
        { restRequest: scripted.impl },
        undefined,
        aliceNoEmail,
      );

      expect(res.statusCode).toBe(403);
      expect(res.body).not.toMatch(/squatting/i);
      expect(res.body).toMatch(/does not match|another account/i);
      expect(provisioned).toHaveLength(0);
    });

    it('falls back to the generic mismatch message (not a 502) when the squatting-detection search itself fails', async () => {
      const scripted = scriptedRest([
        ...happyScript({
          user: { match: (m, p) => m === 'GET' && p === '/user', result: randomUsernameAccount },
        }),
        {
          match: (m, p) => m === 'GET' && p === '/users?s=mallory',
          error: new Error('network blip'),
        },
      ]);
      const { res, provisioned } = await runCallback(
        { restRequest: scripted.impl },
        undefined,
        aliceNoEmail,
      );

      expect(res.statusCode).toBe(403);
      expect(res.body).not.toMatch(/squatting/i);
      expect(provisioned).toHaveLength(0);
    });

    it('treats a non-array /users search response as inconclusive rather than crashing', async () => {
      const scripted = scriptedRest([
        ...happyScript({
          user: { match: (m, p) => m === 'GET' && p === '/user', result: randomUsernameAccount },
        }),
        {
          match: (m, p) => m === 'GET' && p === '/users?s=mallory',
          result: { unexpected: 'shape' },
        },
      ]);
      const { res, provisioned } = await runCallback(
        { restRequest: scripted.impl },
        undefined,
        aliceNoEmail,
      );

      expect(res.statusCode).toBe(403);
      expect(res.body).not.toMatch(/squatting/i);
      expect(provisioned).toHaveLength(0);
    });

    it('never calls GET /users when the identity carries no preferred_username to search for', async () => {
      const bareEmailOnly: Identity = {
        issuer: alice.issuer,
        sub: alice.sub,
        email: 'alice@example.test',
      };
      const scripted = scriptedRest(
        happyScript({
          user: {
            match: (m, p) => m === 'GET' && p === '/user',
            result: { id: 9, username: 'someone-else', email: 'someone-else@example.test' },
          },
        }),
      );
      const { res, provisioned } = await runCallback(
        { restRequest: scripted.impl },
        undefined,
        bareEmailOnly,
      );

      expect(res.statusCode).toBe(403);
      expect(res.body).not.toMatch(/squatting/i);
      expect(scripted.calls.some(c => c.path.startsWith('/users?s='))).toBe(false);
      expect(provisioned).toHaveLength(0);
    });
  });

  describe('ticket redemption timing (finding #4)', () => {
    it('a failed code exchange does NOT burn the ticket — the link stays redeemable', async () => {
      const failing = scriptedRest(
        happyScript({
          callback: {
            match: (m, p) => m === 'POST' && p.endsWith('/callback'),
            error: new Error('HTTP 412 Invalid totp passcode.'),
          },
        }),
      );
      const { res, provisioned, ticket, tickets } = await runCallback({
        restRequest: failing.impl,
      });
      expect(res.statusCode).toBe(502);
      expect(provisioned).toHaveLength(0);
      // Transient upstream failure must not force the user back to their chat
      // for a fresh link.
      expect(tickets.peek(ticket)).toEqual(alice);
    });

    it('a successful exchange consumes the ticket: a replayed callback is rejected', async () => {
      const { res, ticket, service, provisioned } = await runCallback({
        restRequest: scriptedRest(happyScript()).impl,
      });
      expect(res.statusCode).toBe(200);

      const replay = fakeRes();
      await service.handleRequest(
        fakeReq('GET', `/enroll/callback?code=authcode-2&state=${ticket}`),
        replay,
      );
      expect(replay.statusCode).toBe(400);
      expect(provisioned).toHaveLength(1);
    });
  });

  it('surfaces an IdP error redirect cleanly without touching Vikunja', async () => {
    const scripted = scriptedRest([]);
    const { res, provisioned } = await runCallback(
      { restRequest: scripted.impl },
      'error=access_denied&state=whatever',
    );
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('access_denied');
    expect(provisioned).toHaveLength(0);
    expect(scripted.calls).toHaveLength(0);
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
    const scripted = scriptedRest([]);
    const { res, provisioned } = await runCallback(
      { restRequest: scripted.impl },
      'code=authcode-1&state=forged',
    );
    expect(res.statusCode).toBe(400);
    expect(provisioned).toHaveLength(0);
    expect(scripted.calls).toHaveLength(0);
  });

  it('fails with 502 when the callback response has no token field', async () => {
    const { res, provisioned } = await runCallback({
      restRequest: scriptedRest(
        happyScript({
          callback: { match: (m, p) => m === 'POST' && p.endsWith('/callback'), result: {} },
        }),
      ).impl,
    });
    expect(res.statusCode).toBe(502);
    expect(provisioned).toHaveLength(0);
  });

  it('skips malformed GET /routes groups (null/primitive values) instead of crashing (finding #5)', async () => {
    const scripted = scriptedRest(
      happyScript({
        routes: {
          match: (m, p) => m === 'GET' && p === '/routes',
          result: { tasks: { read_all: {} }, broken: null, worse: 'GET', num: 7 },
        },
      }),
    );
    const { res, provisioned } = await runCallback({ restRequest: scripted.impl });
    expect(res.statusCode).toBe(200);
    expect(provisioned).toHaveLength(1);
    const mint = scripted.calls.find(c => c.path === '/tokens') as RestCall;
    expect((mint.body as { permissions: unknown }).permissions).toEqual({
      tasks: ['read_all'],
    });
  });

  it('fails with 502 rather than minting a zero-permission token when /routes yields nothing usable (finding #5)', async () => {
    const scripted = scriptedRest(
      happyScript({
        routes: {
          match: (m, p) => m === 'GET' && p === '/routes',
          result: { broken: null, worse: 'GET' },
        },
      }),
    );
    const { res, provisioned } = await runCallback({ restRequest: scripted.impl });
    expect(res.statusCode).toBe(502);
    expect(provisioned).toHaveLength(0);
    expect(scripted.calls.some(c => c.path === '/tokens')).toBe(false);
  });

  it('fails with 502 when GET /routes or PUT /tokens fails, leaving the vault untouched', async () => {
    let result = await runCallback({
      restRequest: scriptedRest(
        happyScript({
          routes: { match: (m, p) => m === 'GET' && p === '/routes', error: new Error('HTTP 401') },
        }),
      ).impl,
    });
    expect(result.res.statusCode).toBe(502);
    expect(result.provisioned).toHaveLength(0);

    result = await runCallback({
      restRequest: scriptedRest(
        happyScript({
          tokens: { match: (m, p) => m === 'PUT' && p === '/tokens', error: new Error('HTTP 400') },
        }),
      ).impl,
    });
    expect(result.res.statusCode).toBe(502);
    expect(result.provisioned).toHaveLength(0);

    result = await runCallback({
      restRequest: scriptedRest(
        happyScript({
          tokens: { match: (m, p) => m === 'PUT' && p === '/tokens', result: { id: 1 } },
        }),
      ).impl,
    });
    expect(result.res.statusCode).toBe(502);
    expect(result.provisioned).toHaveLength(0);
  });

  it('reports a vault write failure as a 500 without leaking internals', async () => {
    const { res } = await runCallback({
      restRequest: scriptedRest(happyScript()).impl,
      vault: {
        provision: async () => {
          throw new Error('disk full at /var/secret/vault.json');
        },
      },
    });
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

  it('fails loud when enabled without http.publicUrl (finding #2 — no bind-address links)', () => {
    setActiveVaultStore(fakeVault);
    expect(() =>
      setupEnrollment(enrollConfig(), { host: '127.0.0.1', port: 9123, path: '/mcp' }, VIKUNJA_URL),
    ).toThrow(/publicUrl|VIKUNJA_MCP_HTTP_PUBLIC_URL/);
  });

  it('registers a service issuing URLs on the publicUrl base (config URL wins over fallback)', () => {
    setActiveVaultStore(fakeVault);
    setupEnrollment(
      enrollConfig({ vikunjaUrl: 'https://vikunja.example.test/api/v1' }),
      httpConfig,
      'http://fallback.example/api/v1',
    );
    const service = getActiveEnrollmentService() as EnrollmentService;
    expect(service).toBeDefined();
    expect(service.vikunjaUrl).toBe('https://vikunja.example.test/api/v1');
    const url = new URL(service.createEnrollmentUrl(alice));
    expect(url.origin).toBe('https://mcp.example.test');
    expect(url.pathname).toBe('/enroll');
  });

  it('preserves a path prefix from publicUrl (strips only the trailing MCP path, finding #2)', () => {
    setActiveVaultStore(fakeVault);
    setupEnrollment(
      enrollConfig(),
      {
        host: '127.0.0.1',
        port: 8765,
        path: '/mcp',
        publicUrl: 'https://gateway.example.test/vikunja-mcp/mcp',
      },
      VIKUNJA_URL,
    );
    const url = new URL(
      (getActiveEnrollmentService() as EnrollmentService).createEnrollmentUrl(alice),
    );
    expect(url.origin).toBe('https://gateway.example.test');
    expect(url.pathname).toBe('/vikunja-mcp/enroll');
  });
});
