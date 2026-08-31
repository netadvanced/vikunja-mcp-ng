/**
 * Unit tests for the OIDC HTTP-auth wiring (src/transport/oidcHttpAuth.ts):
 * the seam middleware that turns a bearer token into a per-identity
 * `RequestContext` (or a generic 401/403), and the `setupOidcHttpAuth`
 * orchestration that registers it. End-to-end behaviour over the real
 * transport is covered separately in tests/oidc/http-e2e.test.ts.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import * as jose from 'jose';
import {
  createOidcHttpAuthMiddleware,
  setupOidcHttpAuth,
  type OidcHttpAuthDeps,
} from '../../src/transport/oidcHttpAuth';
import { setActiveVaultStore } from '../../src/storage/vaultFileStore';
import {
  getOidcAuthMiddleware,
  setOidcAuthMiddleware,
  type HttpRequestWithAuth,
} from '../../src/transport/oidcMiddlewareSeam';
import {
  getCurrentIdentity,
  runWithRequestContext,
  takeAttachedRequestContext,
  type Identity,
} from '../../src/context/requestContext';
import type { VikunjaCredential, VikunjaCredentialSource } from '../../src/auth/CredentialSource';
import { ErrorCode, MCPError } from '../../src/types/errors';
import type { Identity as ValidatorIdentity } from '../../src/auth/oidc/types';

const IDENTITY: ValidatorIdentity = { issuer: 'https://idp.example.test/realms/t', sub: 'user-1' };

function fakeRequest(authorization?: string | string[]): HttpRequestWithAuth {
  const headers: Record<string, string | string[]> = {};
  if (authorization !== undefined) {
    headers.authorization = authorization;
  }
  return { headers } as unknown as HttpRequestWithAuth;
}

interface CapturedResponse {
  res: ServerResponse;
  statusCode?: number;
  headers?: Record<string, string>;
  body?: string;
  headersSent: boolean;
}

function fakeResponse(headersSent = false): CapturedResponse {
  const captured: CapturedResponse = { res: undefined as unknown as ServerResponse, headersSent };
  const res = {
    get headersSent() {
      return captured.headersSent;
    },
    writeHead(statusCode: number, headers: Record<string, string>) {
      captured.statusCode = statusCode;
      captured.headers = headers;
      captured.headersSent = true;
      return this;
    },
    end(body?: string) {
      captured.body = body;
      return this;
    },
  } as unknown as ServerResponse;
  captured.res = res;
  return captured;
}

/** A validator stub with a controllable `validate`. */
function validatorReturning(identity: ValidatorIdentity): OidcHttpAuthDeps['validator'] {
  return { validate: jest.fn().mockResolvedValue(identity) };
}
function validatorThrowing(error: unknown): OidcHttpAuthDeps['validator'] {
  return { validate: jest.fn().mockRejectedValue(error) };
}

class StubCredentialSource implements VikunjaCredentialSource {
  constructor(private readonly credential: VikunjaCredential | null) {}
  getCredential(): VikunjaCredential | null {
    return this.credential;
  }
}

describe('createOidcHttpAuthMiddleware', () => {
  it('valid token, no credential: returns true, attaches an unauthenticated per-identity context', async () => {
    const middleware = createOidcHttpAuthMiddleware({
      validator: validatorReturning(IDENTITY),
      credentialSource: new StubCredentialSource(null),
    });
    const req = fakeRequest('Bearer good-token');
    const { res } = fakeResponse();

    const ok = await middleware(req, res);

    expect(ok).toBe(true);
    const ctx = takeAttachedRequestContext(req);
    expect(ctx?.identity).toEqual({ issuer: IDENTITY.issuer, sub: IDENTITY.sub });
    expect(ctx?.authManager.isAuthenticated()).toBe(false);
    expect(req.auth).toEqual({ token: 'oidc', clientId: 'user-1', scopes: [] });
  });

  it('valid token, credential present: context AuthManager is connected with that credential', async () => {
    const credential: VikunjaCredential = {
      apiUrl: 'https://vikunja.example/api/v1',
      apiToken: 'tk_user1-abcdefgh',
      authType: 'api-token',
    };
    const middleware = createOidcHttpAuthMiddleware({
      validator: validatorReturning(IDENTITY),
      credentialSource: new StubCredentialSource(credential),
    });
    const req = fakeRequest('Bearer good-token');
    const { res } = fakeResponse();

    const ok = await middleware(req, res);

    expect(ok).toBe(true);
    const ctx = takeAttachedRequestContext(req);
    expect(ctx?.authManager.isAuthenticated()).toBe(true);
    expect(ctx?.authManager.getSession().apiToken).toBe('tk_user1-abcdefgh');
  });

  it('carries the enrollment-matching claims (email, preferredUsername) into the context identity when present', async () => {
    // Issue #220 finding #1: the SSO-enrollment callback pins the enrolled
    // Vikunja account to the initiating identity via these claims, so the
    // middleware must thread them through (tenancy keying stays (issuer, sub)).
    const middleware = createOidcHttpAuthMiddleware({
      validator: validatorReturning({
        ...IDENTITY,
        preferredUsername: 'alice',
        email: 'alice@example.test',
      }),
      credentialSource: new StubCredentialSource(null),
    });
    const req = fakeRequest('Bearer good-token');
    const { res } = fakeResponse();

    await middleware(req, res);

    expect(takeAttachedRequestContext(req)?.identity).toEqual({
      issuer: IDENTITY.issuer,
      sub: IDENTITY.sub,
      preferredUsername: 'alice',
      email: 'alice@example.test',
    });
  });

  it('omits the optional claims from the context identity when the token lacks them', async () => {
    const middleware = createOidcHttpAuthMiddleware({
      validator: validatorReturning({ ...IDENTITY }),
      credentialSource: new StubCredentialSource(null),
    });
    const req = fakeRequest('Bearer good-token');
    const { res } = fakeResponse();

    await middleware(req, res);

    expect(takeAttachedRequestContext(req)?.identity).toEqual({
      issuer: IDENTITY.issuer,
      sub: IDENTITY.sub,
    });
  });

  it('passes the raw Authorization header string straight to the validator', async () => {
    const validator = validatorReturning(IDENTITY);
    const middleware = createOidcHttpAuthMiddleware({
      validator,
      credentialSource: new StubCredentialSource(null),
    });

    await middleware(fakeRequest('Bearer the-token'), fakeResponse().res);

    expect(validator.validate).toHaveBeenCalledWith('Bearer the-token');
  });

  it('passes undefined to the validator when no Authorization header is present', async () => {
    const validator = validatorReturning(IDENTITY);
    const middleware = createOidcHttpAuthMiddleware({
      validator,
      credentialSource: new StubCredentialSource(null),
    });

    await middleware(fakeRequest(undefined), fakeResponse().res);

    expect(validator.validate).toHaveBeenCalledWith(undefined);
  });

  it('invalid_token: writes 401 + WWW-Authenticate and returns false', async () => {
    const middleware = createOidcHttpAuthMiddleware({
      validator: validatorThrowing(
        new MCPError(ErrorCode.AUTH_FAILED, 'Invalid or expired token', {
          statusCode: 401,
          wwwAuthenticateError: 'invalid_token',
        })
      ),
      credentialSource: new StubCredentialSource(null),
    });
    const req = fakeRequest();
    const captured = fakeResponse();

    const ok = await middleware(req, captured.res);

    expect(ok).toBe(false);
    expect(captured.statusCode).toBe(401);
    expect(captured.headers?.['WWW-Authenticate']).toContain('Bearer');
    expect(captured.headers?.['WWW-Authenticate']).toContain('invalid_token');
    expect(JSON.parse(captured.body ?? '{}')).toMatchObject({ error: 'invalid_token' });
    expect(takeAttachedRequestContext(req)).toBeUndefined();
  });

  it('insufficient_scope: writes 403 insufficient_scope and returns false', async () => {
    const middleware = createOidcHttpAuthMiddleware({
      validator: validatorThrowing(
        new MCPError(ErrorCode.PERMISSION_DENIED, 'Token lacks required scope', {
          statusCode: 403,
          wwwAuthenticateError: 'insufficient_scope',
        })
      ),
      credentialSource: new StubCredentialSource(null),
    });
    const captured = fakeResponse();

    const ok = await middleware(fakeRequest('Bearer x'), captured.res);

    expect(ok).toBe(false);
    expect(captured.statusCode).toBe(403);
    expect(captured.headers?.['WWW-Authenticate']).toContain('insufficient_scope');
    expect(JSON.parse(captured.body ?? '{}')).toMatchObject({ error: 'insufficient_scope' });
  });

  it('a non-MCPError failure falls back to a generic 401 invalid_token', async () => {
    const middleware = createOidcHttpAuthMiddleware({
      validator: validatorThrowing(new Error('boom')),
      credentialSource: new StubCredentialSource(null),
    });
    const captured = fakeResponse();

    const ok = await middleware(fakeRequest('Bearer x'), captured.res);

    expect(ok).toBe(false);
    expect(captured.statusCode).toBe(401);
    expect(JSON.parse(captured.body ?? '{}')).toMatchObject({ error: 'invalid_token' });
  });

  it('does not double-write when the response was already sent', async () => {
    const middleware = createOidcHttpAuthMiddleware({
      validator: validatorThrowing(new Error('boom')),
      credentialSource: new StubCredentialSource(null),
    });
    const captured = fakeResponse(true); // headersSent already

    const ok = await middleware(fakeRequest('Bearer x'), captured.res);

    expect(ok).toBe(false);
    expect(captured.statusCode).toBeUndefined();
    expect(captured.body).toBeUndefined();
  });

  describe('resource_metadata on the WWW-Authenticate challenge (RFC 9728 §5.1)', () => {
    const failingDeps = (): Pick<OidcHttpAuthDeps, 'validator' | 'credentialSource'> => ({
      validator: validatorThrowing(
        new MCPError(ErrorCode.AUTH_FAILED, 'Invalid or expired token', {
          statusCode: 401,
          wwwAuthenticateError: 'invalid_token',
        })
      ),
      credentialSource: new StubCredentialSource(null),
    });

    it('appends resource_metadata to the 401 challenge when a resolver is provided', async () => {
      const middleware = createOidcHttpAuthMiddleware({
        ...failingDeps(),
        resourceMetadataUrl: () =>
          'https://mcp-vikunja.example.ch/.well-known/oauth-protected-resource',
      });
      const captured = fakeResponse();

      await middleware(fakeRequest('Bearer bad'), captured.res);

      expect(captured.headers?.['WWW-Authenticate']).toBe(
        'Bearer error="invalid_token", error_description="Invalid or expired token", ' +
          'resource_metadata="https://mcp-vikunja.example.ch/.well-known/oauth-protected-resource"'
      );
    });

    it('resolves the metadata URL from the failing request itself', async () => {
      const resolver = jest.fn(
        (req: HttpRequestWithAuth) =>
          `http://${String(req.headers.host)}/.well-known/oauth-protected-resource`
      );
      const middleware = createOidcHttpAuthMiddleware({ ...failingDeps(), resourceMetadataUrl: resolver });
      const req = fakeRequest('Bearer bad');
      (req.headers as Record<string, string>).host = 'gw.example:8765';
      const captured = fakeResponse();

      await middleware(req, captured.res);

      expect(resolver).toHaveBeenCalledWith(req);
      expect(captured.headers?.['WWW-Authenticate']).toContain(
        'resource_metadata="http://gw.example:8765/.well-known/oauth-protected-resource"'
      );
    });

    it('omits resource_metadata (keeping the plain challenge) when no resolver is provided', async () => {
      const middleware = createOidcHttpAuthMiddleware(failingDeps());
      const captured = fakeResponse();

      await middleware(fakeRequest('Bearer bad'), captured.res);

      expect(captured.headers?.['WWW-Authenticate']).toBe(
        'Bearer error="invalid_token", error_description="Invalid or expired token"'
      );
    });

    it('omits resource_metadata when the resolver throws (unparsable Host header)', async () => {
      const middleware = createOidcHttpAuthMiddleware({
        ...failingDeps(),
        resourceMetadataUrl: () => {
          throw new Error('Invalid URL');
        },
      });
      const captured = fakeResponse();

      await middleware(fakeRequest('Bearer bad'), captured.res);

      expect(captured.statusCode).toBe(401);
      expect(captured.headers?.['WWW-Authenticate']).toBe(
        'Bearer error="invalid_token", error_description="Invalid or expired token"'
      );
    });
  });

  it('the attached context flows through ALS to getCurrentIdentity', async () => {
    const middleware = createOidcHttpAuthMiddleware({
      validator: validatorReturning(IDENTITY),
      credentialSource: new StubCredentialSource(null),
    });
    const req = fakeRequest('Bearer good-token');
    await middleware(req, fakeResponse().res);
    const ctx = takeAttachedRequestContext(req);

    const seen = runWithRequestContext(ctx as NonNullable<typeof ctx>, () => getCurrentIdentity());
    expect(seen).toEqual<Identity>({ issuer: IDENTITY.issuer, sub: IDENTITY.sub });
  });
});

describe('setupOidcHttpAuth', () => {
  const originalVaultKey = process.env.VIKUNJA_MCP_VAULT_KEY;
  let vaultPath: string;

  beforeEach(() => {
    // A valid 32-byte base64 master key (D4) — setupOidcHttpAuth fails loud
    // without one (the vault half of the "any missing -> hard startup
    // error" selection rule, §2), so every test in this suite needs one.
    process.env.VIKUNJA_MCP_VAULT_KEY = crypto.randomBytes(32).toString('base64');
    vaultPath = path.join(os.tmpdir(), `oidc-http-auth-test-vault-${Date.now()}-${Math.random()}.json`);
  });

  afterEach(() => {
    setOidcAuthMiddleware(undefined);
    setActiveVaultStore(undefined);
    if (originalVaultKey === undefined) {
      delete process.env.VIKUNJA_MCP_VAULT_KEY;
    } else {
      process.env.VIKUNJA_MCP_VAULT_KEY = originalVaultKey;
    }
  });

  const joseDeps = { jwtVerify: jose.jwtVerify, createRemoteJWKSet: jose.createRemoteJWKSet };

  it('builds a validator from config and registers a middleware on the seam', async () => {
    expect(getOidcAuthMiddleware()).toBeUndefined();

    await setupOidcHttpAuth(
      {
        issuer: 'https://idp.example.test/realms/t',
        audience: 'vikunja-mcp-ng',
        jwksUri: 'https://idp.example.test/realms/t/certs',
      },
      { path: vaultPath },
      undefined,
      async () => joseDeps
    );

    expect(getOidcAuthMiddleware()).toBeInstanceOf(Function);
  });

  it('passes optional tuning (allowedAlgs / clockSkewSec / requiredScope) through without error', async () => {
    await setupOidcHttpAuth(
      {
        issuer: 'https://idp.example.test/realms/t',
        audience: ['aud-1', 'aud-2'],
        jwksUri: 'https://idp.example.test/realms/t/certs',
        allowedAlgs: ['RS256', 'ES256'],
        clockSkewSec: 30,
        requiredScope: 'vikunja',
      },
      { path: vaultPath },
      undefined,
      async () => joseDeps
    );

    expect(getOidcAuthMiddleware()).toBeInstanceOf(Function);
  });

  it('wires the resource-metadata resolver when an http config is provided (RFC 9728)', async () => {
    await setupOidcHttpAuth(
      {
        issuer: 'https://idp.example.test/realms/t',
        audience: 'vikunja-mcp-ng',
        jwksUri: 'https://idp.example.test/realms/t/certs',
      },
      { path: vaultPath },
      { host: '127.0.0.1', port: 8765, path: '/mcp', publicUrl: 'https://mcp-vikunja.example.ch/mcp' },
      async () => joseDeps
    );

    const middleware = getOidcAuthMiddleware();
    expect(middleware).toBeInstanceOf(Function);

    // A malformed bearer fails validation before any JWKS fetch, so the 401
    // challenge is produced offline — and must advertise the metadata URL.
    const captured = fakeResponse();
    const ok = await middleware!(fakeRequest('Bearer not-a-jwt'), captured.res);
    expect(ok).toBe(false);
    expect(captured.statusCode).toBe(401);
    expect(captured.headers?.['WWW-Authenticate']).toContain(
      'resource_metadata="https://mcp-vikunja.example.ch/.well-known/oauth-protected-resource"'
    );
  });

  // #292 LOW-19: without a configured publicUrl, the resource-metadata
  // resolver derives the origin from the request's Host header - it must
  // not reflect a Host outside the allowedHosts allowlist.
  it('does not reflect a spoofed Host header into the 401 resource_metadata URL', async () => {
    await setupOidcHttpAuth(
      {
        issuer: 'https://idp.example.test/realms/t',
        audience: 'vikunja-mcp-ng',
        jwksUri: 'https://idp.example.test/realms/t/certs',
      },
      { path: vaultPath },
      { host: '127.0.0.1', port: 8765, path: '/mcp' },
      async () => joseDeps
    );

    const middleware = getOidcAuthMiddleware();
    expect(middleware).toBeInstanceOf(Function);

    const captured = fakeResponse();
    const spoofedReq = {
      headers: { authorization: 'Bearer not-a-jwt', host: 'evil.attacker.example' },
    } as unknown as HttpRequestWithAuth;
    const ok = await middleware!(spoofedReq, captured.res);
    expect(ok).toBe(false);
    expect(captured.statusCode).toBe(401);
    // Falls back to the configured bind host:port, not the spoofed Host.
    expect(captured.headers?.['WWW-Authenticate']).toContain(
      'resource_metadata="http://127.0.0.1:8765/.well-known/oauth-protected-resource"'
    );
    expect(captured.headers?.['WWW-Authenticate']).not.toContain('evil.attacker.example');
  });

  it('throws a clear ConfigurationError when no vault master key is configured', async () => {
    delete process.env.VIKUNJA_MCP_VAULT_KEY;

    await expect(
      setupOidcHttpAuth(
        {
          issuer: 'https://idp.example.test/realms/t',
          audience: 'vikunja-mcp-ng',
          jwksUri: 'https://idp.example.test/realms/t/certs',
        },
        { path: vaultPath },
        undefined,
        async () => joseDeps
      )
    ).rejects.toThrow(/vault master key/);
  });

  it('throws a clear ConfigurationError when no vault path is configured', async () => {
    await expect(
      setupOidcHttpAuth(
        {
          issuer: 'https://idp.example.test/realms/t',
          audience: 'vikunja-mcp-ng',
          jwksUri: 'https://idp.example.test/realms/t/certs',
        },
        {},
        undefined,
        async () => joseDeps
      )
    ).rejects.toThrow(/vault file path/);
  });
});
