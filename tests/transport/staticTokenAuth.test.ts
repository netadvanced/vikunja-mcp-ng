/**
 * Tests for the gateway-token HTTP auth middleware
 * (src/transport/staticTokenAuth.ts, docs/GATEWAY-TOKEN-MODE.md §4.3, §7.1).
 *
 * The single most important property here is isolation by construction: a
 * request that passes the static token check must NOT carry a
 * `RequestContext`, so no ALS scope opens and every downstream accessor falls
 * back to the process-global `AuthManager`, exactly as in stdio mode.
 */

import type { ServerResponse } from 'node:http';
import {
  createStaticTokenAuthMiddleware,
  setupStaticTokenAuth,
  tokenMatches,
  MIN_GATEWAY_TOKEN_LENGTH,
} from '../../src/transport/staticTokenAuth';
import {
  getOidcAuthMiddleware,
  setOidcAuthMiddleware,
  type HttpRequestWithAuth,
} from '../../src/transport/oidcMiddlewareSeam';
import { takeAttachedRequestContext } from '../../src/context/requestContext';
import { ConfigurationError } from '../../src/config/types';
import { logger } from '../../src/utils/logger';

const TOKEN = 'gw_0123456789abcdef0123456789abcdef';

interface FakeResponse {
  res: ServerResponse;
  statusCode: number | undefined;
  headers: Record<string, string | number>;
  body: string | undefined;
  touched: boolean;
}

function fakeResponse(): FakeResponse {
  const state: FakeResponse = {
    res: undefined as unknown as ServerResponse,
    statusCode: undefined,
    headers: {},
    body: undefined,
    touched: false,
  };
  const res = {
    headersSent: false,
    setHeader(name: string, value: string | number) {
      state.touched = true;
      state.headers[name.toLowerCase()] = value;
    },
    writeHead(status: number, headers: Record<string, string | number> = {}) {
      state.touched = true;
      state.statusCode = status;
      for (const [name, value] of Object.entries(headers)) {
        state.headers[name.toLowerCase()] = value;
      }
    },
    end(payload?: string) {
      state.touched = true;
      state.body = payload;
    },
  };
  state.res = res as unknown as ServerResponse;
  return state;
}

function fakeRequest(authorization?: string): HttpRequestWithAuth {
  const headers: Record<string, string> = {};
  if (authorization !== undefined) {
    headers.authorization = authorization;
  }
  return { headers } as unknown as HttpRequestWithAuth;
}

async function run(authorization?: string): Promise<{ ok: boolean; out: FakeResponse; req: HttpRequestWithAuth }> {
  const middleware = createStaticTokenAuthMiddleware({ token: TOKEN });
  const req = fakeRequest(authorization);
  const out = fakeResponse();
  const ok = await middleware(req, out.res);
  return { ok, out, req };
}

describe('staticTokenAuth', () => {
  afterEach(() => {
    setOidcAuthMiddleware(undefined);
    jest.restoreAllMocks();
  });

  describe('tokenMatches', () => {
    it('matches an identical token', () => {
      expect(tokenMatches(TOKEN, TOKEN)).toBe(true);
    });

    it('rejects a same-length and a different-length token without throwing', () => {
      const sameLength = TOKEN.slice(0, -1) + (TOKEN.endsWith('f') ? 'e' : 'f');
      expect(sameLength).toHaveLength(TOKEN.length);
      expect(tokenMatches(sameLength, TOKEN)).toBe(false);
      expect(tokenMatches('short', TOKEN)).toBe(false);
      expect(tokenMatches(TOKEN + 'x', TOKEN)).toBe(false);
    });
  });

  describe('correct token', () => {
    it('returns true, leaves the response untouched and attaches NO RequestContext', async () => {
      const { ok, out, req } = await run(`Bearer ${TOKEN}`);

      expect(ok).toBe(true);
      expect(out.touched).toBe(false);
      // Isolation by construction (§4.3): nothing for the transport to open
      // an ALS scope around, so the process-global AuthManager is used.
      expect(takeAttachedRequestContext(req)).toBeUndefined();
      expect(req.auth).toBeUndefined();
    });

    it('accepts a lower-case "bearer " scheme', async () => {
      const { ok } = await run(`bearer ${TOKEN}`);
      expect(ok).toBe(true);
    });

    it('accepts leading and trailing whitespace around the header value', async () => {
      const { ok } = await run(`   Bearer ${TOKEN}  `);
      expect(ok).toBe(true);
    });
  });

  describe('rejections', () => {
    const cases: Array<[string, string | undefined]> = [
      ['missing header', undefined],
      ['empty header', ''],
      ['Basic credentials', `Basic ${Buffer.from(`user:${TOKEN}`).toString('base64')}`],
      ['bare token without the Bearer prefix', TOKEN],
      ['Bearer with no token', 'Bearer '],
      ['wrong token of the same length', `Bearer ${'x'.repeat(TOKEN.length)}`],
      ['wrong token of a different length', 'Bearer nope'],
      ['a prefix of the right token', `Bearer ${TOKEN.slice(0, 16)}`],
    ];

    it.each(cases)('%s → 401 invalid_token with WWW-Authenticate: Bearer', async (_name, header) => {
      const { ok, out, req } = await run(header);

      expect(ok).toBe(false);
      expect(out.statusCode).toBe(401);
      expect(out.headers['www-authenticate']).toBe('Bearer');
      expect(out.body).toBe('{"error":"invalid_token"}');
      expect(takeAttachedRequestContext(req)).toBeUndefined();
    });

    it('same-length and different-length wrong tokens produce byte-identical 401 bodies', async () => {
      const sameLength = await run(`Bearer ${'x'.repeat(TOKEN.length)}`);
      const differentLength = await run('Bearer nope');
      const missing = await run(undefined);

      expect(sameLength.out.body).toBe(differentLength.out.body);
      expect(missing.out.body).toBe(differentLength.out.body);
      expect(sameLength.out.headers).toEqual(differentLength.out.headers);
    });

    it('never echoes the expected token, any prefix of it, or a reason in the 401', async () => {
      for (const header of [undefined, 'Basic abc', TOKEN, `Bearer ${TOKEN.slice(0, 8)}`]) {
        const { out } = await run(header);
        const wire = `${out.body ?? ''}\n${JSON.stringify(out.headers)}`;
        expect(wire).not.toContain(TOKEN.slice(0, 8));
        expect(wire).not.toMatch(/missing|mismatch|prefix|basic|reason/i);
      }
    });

    it('logs the failure reason server-side at warn, without the token', async () => {
      const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);

      await run(`Bearer ${TOKEN.slice(0, 20)}`);

      expect(warn).toHaveBeenCalledTimes(1);
      const logged = JSON.stringify(warn.mock.calls[0]);
      expect(logged).toMatch(/Gateway request rejected \(static token check\)/);
      expect(logged).not.toContain(TOKEN.slice(0, 8));
    });

    it('does not write twice when headers were already sent', async () => {
      const middleware = createStaticTokenAuthMiddleware({ token: TOKEN });
      const out = fakeResponse();
      (out.res as unknown as { headersSent: boolean }).headersSent = true;

      const ok = await middleware(fakeRequest(undefined), out.res);

      expect(ok).toBe(false);
      expect(out.touched).toBe(false);
    });
  });

  describe('setupStaticTokenAuth', () => {
    it('registers the middleware on the transport auth seam', async () => {
      expect(getOidcAuthMiddleware()).toBeUndefined();

      setupStaticTokenAuth(TOKEN);

      const registered = getOidcAuthMiddleware();
      expect(registered).toBeDefined();
      const out = fakeResponse();
      await expect(registered!(fakeRequest(`Bearer ${TOKEN}`), out.res)).resolves.toBe(true);
    });

    it('refuses a missing token with a ConfigurationError naming VIKUNJA_MCP_HTTP_AUTH_TOKEN', () => {
      expect(() => setupStaticTokenAuth(undefined)).toThrow(ConfigurationError);
      expect(() => setupStaticTokenAuth(undefined)).toThrow(/VIKUNJA_MCP_HTTP_AUTH_TOKEN/);
      expect(() => setupStaticTokenAuth('')).toThrow(/VIKUNJA_MCP_HTTP_AUTH_TOKEN/);
      expect(getOidcAuthMiddleware()).toBeUndefined();
    });

    it(`refuses a token shorter than ${MIN_GATEWAY_TOKEN_LENGTH} characters`, () => {
      const short = 'a'.repeat(MIN_GATEWAY_TOKEN_LENGTH - 1);

      expect(() => setupStaticTokenAuth(short)).toThrow(ConfigurationError);
      expect(() => setupStaticTokenAuth(short)).toThrow(new RegExp(`${MIN_GATEWAY_TOKEN_LENGTH}`));
      expect(getOidcAuthMiddleware()).toBeUndefined();
    });

    it('never puts the rejected token value into the error message', () => {
      const short = 'secret-but-short';
      expect(() => setupStaticTokenAuth(short)).toThrow(
        expect.objectContaining({ message: expect.not.stringContaining(short) }),
      );
    });

    it('accepts a token of exactly the minimum length', () => {
      expect(() => setupStaticTokenAuth('a'.repeat(MIN_GATEWAY_TOKEN_LENGTH))).not.toThrow();
      expect(getOidcAuthMiddleware()).toBeDefined();
    });
  });
});
