import * as jose from 'jose';
import { createOidcJwtValidator } from '../../../src/auth/oidc/jwtValidator';
import type { JoseDeps, OidcJwtValidatorConfig } from '../../../src/auth/oidc/types';
import { ErrorCode, MCPError } from '../../../src/types/errors';
import {
  buildAlgNoneToken,
  generateTestKey,
  signTestToken,
  startMockJwksServer,
  type MockJwksServer,
  type TestKey,
} from './helpers';

const deps: JoseDeps = { jwtVerify: jose.jwtVerify, createRemoteJWKSet: jose.createRemoteJWKSet };

const ISSUER = 'https://idp.example.test/realms/test';
const AUDIENCE = 'vikunja-mcp-ng';

describe('createOidcJwtValidator', () => {
  let key: TestKey;
  let otherKey: TestKey;
  let mockJwks: MockJwksServer;
  let baseConfig: OidcJwtValidatorConfig;

  beforeAll(async () => {
    key = await generateTestKey('kid-1');
    otherKey = await generateTestKey('kid-other');
  });

  beforeEach(async () => {
    mockJwks = await startMockJwksServer([key.jwk]);
    baseConfig = {
      issuer: ISSUER,
      audience: AUDIENCE,
      jwksUri: mockJwks.url,
    };
  });

  afterEach(async () => {
    await mockJwks.close();
  });

  describe('config validation', () => {
    it('throws synchronously when issuer is missing', () => {
      expect(() => createOidcJwtValidator({ ...baseConfig, issuer: '' }, deps)).toThrow(
        /issuer is required/,
      );
    });

    it('throws synchronously when audience is missing', () => {
      expect(() => createOidcJwtValidator({ ...baseConfig, audience: '' }, deps)).toThrow(
        /audience is required/,
      );
    });

    it('throws synchronously when audience is an empty array', () => {
      expect(() => createOidcJwtValidator({ ...baseConfig, audience: [] }, deps)).toThrow(
        /audience is required/,
      );
    });

    it('throws synchronously when jwksUri is missing', () => {
      expect(() => createOidcJwtValidator({ ...baseConfig, jwksUri: '' }, deps)).toThrow(
        /jwksUri is required/,
      );
    });
  });

  describe('happy path', () => {
    it('validates a well-formed token and returns the identity', async () => {
      const validator = createOidcJwtValidator(baseConfig, deps);
      const token = await signTestToken(key.privateKey, { kid: key.kid, sub: 'user-abc' });

      const identity = await validator.validate(`Bearer ${token}`);

      expect(identity).toEqual({ issuer: ISSUER, sub: 'user-abc' });
    });

    it('extracts preferred_username when present', async () => {
      const validator = createOidcJwtValidator(baseConfig, deps);
      const token = await signTestToken(key.privateKey, {
        kid: key.kid,
        sub: 'user-abc',
        extraClaims: { preferred_username: 'alice' },
      });

      const identity = await validator.validate(`Bearer ${token}`);

      expect(identity).toEqual({ issuer: ISSUER, sub: 'user-abc', preferredUsername: 'alice' });
    });

    it('omits preferredUsername when the claim is absent', async () => {
      const validator = createOidcJwtValidator(baseConfig, deps);
      const token = await signTestToken(key.privateKey, { kid: key.kid, sub: 'user-abc' });

      const identity = await validator.validate(`Bearer ${token}`);

      expect(identity).not.toHaveProperty('preferredUsername');
    });

    it('ignores a non-string preferred_username claim', async () => {
      const validator = createOidcJwtValidator(baseConfig, deps);
      const token = await signTestToken(key.privateKey, {
        kid: key.kid,
        sub: 'user-abc',
        extraClaims: { preferred_username: 12345 },
      });

      const identity = await validator.validate(`Bearer ${token}`);

      expect(identity).not.toHaveProperty('preferredUsername');
    });

    it('accepts an audience array claim containing the configured audience', async () => {
      const validator = createOidcJwtValidator(baseConfig, deps);
      const token = await signTestToken(key.privateKey, {
        kid: key.kid,
        audience: ['some-other-client', AUDIENCE],
      });

      await expect(validator.validate(`Bearer ${token}`)).resolves.toMatchObject({
        sub: 'user-123',
      });
    });

    it('accepts case-insensitive Bearer scheme and extra whitespace', async () => {
      const validator = createOidcJwtValidator(baseConfig, deps);
      const token = await signTestToken(key.privateKey, { kid: key.kid });

      await expect(validator.validate(`  bearer   ${token}  `)).resolves.toMatchObject({
        sub: 'user-123',
      });
    });
  });

  describe('Authorization header failures (never leak reason to caller)', () => {
    it.each([
      ['undefined header', undefined],
      ['null header', null],
      ['empty string', ''],
      ['no scheme', 'not-a-bearer-token'],
      ['wrong scheme', 'Basic dXNlcjpwYXNz'],
      ['Bearer with no token', 'Bearer '],
      ['Bearer with only whitespace', 'Bearer    '],
    ])('rejects %s with a generic 401', async (_label, header) => {
      const validator = createOidcJwtValidator(baseConfig, deps);

      await expectGeneric401(validator.validate(header));
    });

    it('rejects a malformed (non-JWT) bearer token', async () => {
      const validator = createOidcJwtValidator(baseConfig, deps);

      await expectGeneric401(validator.validate('Bearer this.is-not.a-jwt-signature-thats-valid'));
    });

    it('rejects a token that is not even 3 dot-separated parts', async () => {
      const validator = createOidcJwtValidator(baseConfig, deps);

      await expectGeneric401(validator.validate('Bearer garbage'));
    });
  });

  describe('validation contract failures', () => {
    it('rejects an expired token', async () => {
      const validator = createOidcJwtValidator(baseConfig, deps);
      const now = Math.floor(Date.now() / 1000);
      const token = await signTestToken(key.privateKey, {
        kid: key.kid,
        issuedAt: now - 7200,
        expiresAt: now - 3600,
      });

      await expectGeneric401(validator.validate(`Bearer ${token}`));
    });

    it('rejects a token for the wrong audience', async () => {
      const validator = createOidcJwtValidator(baseConfig, deps);
      const token = await signTestToken(key.privateKey, {
        kid: key.kid,
        audience: 'someone-elses-client',
      });

      await expectGeneric401(validator.validate(`Bearer ${token}`));
    });

    it('rejects a token from the wrong issuer', async () => {
      const validator = createOidcJwtValidator(baseConfig, deps);
      const token = await signTestToken(key.privateKey, {
        kid: key.kid,
        issuer: 'https://attacker.example/realm',
      });

      await expectGeneric401(validator.validate(`Bearer ${token}`));
    });

    it('rejects a token whose issuer is a superstring/prefix match of the configured issuer', async () => {
      const validator = createOidcJwtValidator(baseConfig, deps);
      const token = await signTestToken(key.privateKey, {
        kid: key.kid,
        issuer: `${ISSUER}.evil.example`,
      });

      await expectGeneric401(validator.validate(`Bearer ${token}`));
    });

    it('rejects a token missing the sub claim', async () => {
      const validator = createOidcJwtValidator(baseConfig, deps);
      const token = await signTestToken(key.privateKey, { kid: key.kid, omitSub: true });

      await expectGeneric401(validator.validate(`Bearer ${token}`));
    });

    it('rejects a token with an empty-string sub claim', async () => {
      const validator = createOidcJwtValidator(baseConfig, deps);
      const token = await signTestToken(key.privateKey, { kid: key.kid, sub: '' });

      await expectGeneric401(validator.validate(`Bearer ${token}`));
    });

    it('rejects a token signed by a key not present in the JWKS', async () => {
      const validator = createOidcJwtValidator(baseConfig, deps);
      const token = await signTestToken(otherKey.privateKey, { kid: 'unknown-kid' });

      await expectGeneric401(validator.validate(`Bearer ${token}`));
    });
  });

  describe('algorithm confusion defences', () => {
    it('rejects an HS256-signed token even when "signed" with the RSA public key material as an HMAC secret', async () => {
      const validator = createOidcJwtValidator(baseConfig, deps);
      const jwk = await jose.exportJWK(key.publicKey);
      const hmacSecret = new TextEncoder().encode(JSON.stringify(jwk));
      const token = await new jose.SignJWT({ sub: 'user-123' })
        .setProtectedHeader({ alg: 'HS256', kid: key.kid })
        .setIssuer(ISSUER)
        .setAudience(AUDIENCE)
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(hmacSecret);

      await expectGeneric401(validator.validate(`Bearer ${token}`));
    });

    it('rejects an alg:none token', async () => {
      const validator = createOidcJwtValidator(baseConfig, deps);
      const now = Math.floor(Date.now() / 1000);
      const token = buildAlgNoneToken({
        sub: 'user-123',
        iss: ISSUER,
        aud: AUDIENCE,
        iat: now,
        exp: now + 3600,
      });

      await expectGeneric401(validator.validate(`Bearer ${token}`));
    });

    it('rejects HS256 even if the deployment explicitly widened allowedAlgs to include it, when the JWKS has no matching HMAC key', async () => {
      const validator = createOidcJwtValidator(
        { ...baseConfig, allowedAlgs: ['RS256', 'HS256'] },
        deps,
      );
      const hmacSecret = new TextEncoder().encode('shared-secret-not-in-jwks');
      const token = await new jose.SignJWT({ sub: 'user-123' })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuer(ISSUER)
        .setAudience(AUDIENCE)
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(hmacSecret);

      await expectGeneric401(validator.validate(`Bearer ${token}`));
    });
  });

  describe('clock skew boundary (default 60s tolerance)', () => {
    it('accepts a token that expired 30s ago (within the default 60s tolerance)', async () => {
      const validator = createOidcJwtValidator(baseConfig, deps);
      const now = Math.floor(Date.now() / 1000);
      const token = await signTestToken(key.privateKey, {
        kid: key.kid,
        issuedAt: now - 100,
        expiresAt: now - 30,
      });

      await expect(validator.validate(`Bearer ${token}`)).resolves.toMatchObject({
        sub: 'user-123',
      });
    });

    it('rejects a token that expired 90s ago (beyond the default 60s tolerance)', async () => {
      const validator = createOidcJwtValidator(baseConfig, deps);
      const now = Math.floor(Date.now() / 1000);
      const token = await signTestToken(key.privateKey, {
        kid: key.kid,
        issuedAt: now - 200,
        expiresAt: now - 90,
      });

      await expectGeneric401(validator.validate(`Bearer ${token}`));
    });

    it('honors a configured custom clockSkewSec', async () => {
      const validator = createOidcJwtValidator({ ...baseConfig, clockSkewSec: 5 }, deps);
      const now = Math.floor(Date.now() / 1000);
      const token = await signTestToken(key.privateKey, {
        kid: key.kid,
        issuedAt: now - 100,
        expiresAt: now - 30,
      });

      await expectGeneric401(validator.validate(`Bearer ${token}`));
    });

    it('rejects a token not valid yet (nbf in the future beyond tolerance)', async () => {
      const validator = createOidcJwtValidator(baseConfig, deps);
      const now = Math.floor(Date.now() / 1000);
      const token = await signTestToken(key.privateKey, { kid: key.kid, notBefore: now + 300 });

      await expectGeneric401(validator.validate(`Bearer ${token}`));
    });
  });

  describe('required scope (403, not 401)', () => {
    it('accepts a token carrying the required scope as a space-delimited string', async () => {
      const validator = createOidcJwtValidator(
        { ...baseConfig, requiredScope: 'tasks:read' },
        deps,
      );
      const token = await signTestToken(key.privateKey, {
        kid: key.kid,
        extraClaims: { scope: 'tasks:read tasks:write' },
      });

      await expect(validator.validate(`Bearer ${token}`)).resolves.toMatchObject({
        sub: 'user-123',
      });
    });

    it('accepts a token carrying the required scope in an scp array claim', async () => {
      const validator = createOidcJwtValidator(
        { ...baseConfig, requiredScope: 'tasks:read' },
        deps,
      );
      const token = await signTestToken(key.privateKey, {
        kid: key.kid,
        extraClaims: { scp: ['tasks:write', 'tasks:read'] },
      });

      await expect(validator.validate(`Bearer ${token}`)).resolves.toMatchObject({
        sub: 'user-123',
      });
    });

    it('rejects with 403 (not 401) a validly-authenticated token missing the required scope', async () => {
      const validator = createOidcJwtValidator(
        { ...baseConfig, requiredScope: 'tasks:read' },
        deps,
      );
      const token = await signTestToken(key.privateKey, {
        kid: key.kid,
        extraClaims: { scope: 'tasks:write' },
      });

      const err = await validator.validate(`Bearer ${token}`).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(MCPError);
      const mcpErr = err as MCPError;
      expect(mcpErr.code).toBe(ErrorCode.PERMISSION_DENIED);
      expect(mcpErr.details?.statusCode).toBe(403);
      expect(mcpErr.details?.wwwAuthenticateError).toBe('insufficient_scope');
      expect(mcpErr.message).not.toMatch(/tasks:write/);
    });

    it('rejects with 403 when neither scope nor scp claims are present', async () => {
      const validator = createOidcJwtValidator(
        { ...baseConfig, requiredScope: 'tasks:read' },
        deps,
      );
      const token = await signTestToken(key.privateKey, { kid: key.kid });

      const err = await validator.validate(`Bearer ${token}`).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(MCPError);
      expect((err as MCPError).details?.statusCode).toBe(403);
    });
  });

  describe('error shape / no token or claim leakage', () => {
    it('never includes the raw token in the thrown error', async () => {
      const validator = createOidcJwtValidator(baseConfig, deps);
      const token = await signTestToken(key.privateKey, {
        kid: key.kid,
        issuer: 'https://attacker.example',
      });

      const err = (await validator
        .validate(`Bearer ${token}`)
        .catch((e: unknown) => e)) as MCPError;

      expect(err.message).not.toContain(token);
      expect(JSON.stringify(err.toJSON())).not.toContain(token);
    });

    it('uses the same generic message for every 401 cause', async () => {
      const validator = createOidcJwtValidator(baseConfig, deps);
      const expired = await signTestToken(key.privateKey, {
        kid: key.kid,
        issuedAt: Math.floor(Date.now() / 1000) - 7200,
        expiresAt: Math.floor(Date.now() / 1000) - 3600,
      });
      const wrongAud = await signTestToken(key.privateKey, { kid: key.kid, audience: 'nope' });

      const err1 = (await validator
        .validate(`Bearer ${expired}`)
        .catch((e: unknown) => e)) as MCPError;
      const err2 = (await validator
        .validate(`Bearer ${wrongAud}`)
        .catch((e: unknown) => e)) as MCPError;
      const err3 = (await validator.validate(undefined).catch((e: unknown) => e)) as MCPError;

      expect(err1.message).toBe(err2.message);
      expect(err2.message).toBe(err3.message);
    });
  });

  describe('jwks cache option plumbing', () => {
    it('accepts a custom cacheMaxAgeMs without altering validation behavior', async () => {
      const validator = createOidcJwtValidator(
        { ...baseConfig, jwks: { cacheMaxAgeMs: 120_000 } },
        deps,
      );
      const token = await signTestToken(key.privateKey, { kid: key.kid });

      await expect(validator.validate(`Bearer ${token}`)).resolves.toMatchObject({
        sub: 'user-123',
      });
    });

    it('accepts a custom timeoutDurationMs without altering validation behavior', async () => {
      const validator = createOidcJwtValidator(
        { ...baseConfig, jwks: { timeoutDurationMs: 2_000 } },
        deps,
      );
      const token = await signTestToken(key.privateKey, { kid: key.kid });

      await expect(validator.validate(`Bearer ${token}`)).resolves.toMatchObject({
        sub: 'user-123',
      });
    });

    it('accepts all three jwks cache overrides together', async () => {
      const validator = createOidcJwtValidator(
        {
          ...baseConfig,
          jwks: { cooldownDurationMs: 1_000, cacheMaxAgeMs: 120_000, timeoutDurationMs: 2_000 },
        },
        deps,
      );
      const token = await signTestToken(key.privateKey, { kid: key.kid });

      await expect(validator.validate(`Bearer ${token}`)).resolves.toMatchObject({
        sub: 'user-123',
      });
    });
  });

  describe('non-Error verification failures', () => {
    it('still returns the generic 401 when the injected jwtVerify throws a non-Error value', async () => {
      const throwingDeps: JoseDeps = {
        ...deps,
        jwtVerify: jest.fn().mockRejectedValue('a plain string rejection, not an Error instance'),
      };
      const validator = createOidcJwtValidator(baseConfig, throwingDeps);

      await expectGeneric401(validator.validate('Bearer irrelevant-since-jwtVerify-is-mocked'));
    });
  });

  describe('reloadJwks', () => {
    it('forces a JWKS refetch', async () => {
      const validator = createOidcJwtValidator(baseConfig, deps);
      const token = await signTestToken(key.privateKey, { kid: key.kid });
      await validator.validate(`Bearer ${token}`);
      const countBefore = mockJwks.requestCount();

      await validator.reloadJwks();

      expect(mockJwks.requestCount()).toBeGreaterThan(countBefore);
    });
  });
});

async function expectGeneric401(pending: Promise<unknown>): Promise<void> {
  const err = await pending.catch((e: unknown) => e);
  expect(err).toBeInstanceOf(MCPError);
  const mcpErr = err as MCPError;
  expect(mcpErr.code).toBe(ErrorCode.AUTH_FAILED);
  expect(mcpErr.details?.statusCode).toBe(401);
  expect(mcpErr.details?.wwwAuthenticateError).toBe('invalid_token');
  expect(mcpErr.message).toBe('Invalid or expired token');
}
