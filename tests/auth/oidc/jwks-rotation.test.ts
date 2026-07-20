/**
 * JWKS caching and rotation behavior for the OIDC validator's underlying
 * `jose.createRemoteJWKSet` resolver. Runs entirely against a loopback mock
 * JWKS server (tests/auth/oidc/helpers.ts) — no live network involved.
 */
import * as jose from 'jose';
import { createOidcJwtValidator } from '../../../src/auth/oidc/jwtValidator';
import type { JoseDeps, OidcJwtValidatorConfig } from '../../../src/auth/oidc/types';
import {
  generateTestKey,
  signTestToken,
  startMockJwksServer,
  type MockJwksServer,
  type TestKey,
} from './helpers';

const deps: JoseDeps = { jwtVerify: jose.jwtVerify, createRemoteJWKSet: jose.createRemoteJWKSet };
const ISSUER = 'https://idp.example.test/realms/test';
const AUDIENCE = 'vikunja-mcp-ng';

describe('OIDC JWKS caching and rotation', () => {
  let keyA: TestKey;
  let keyB: TestKey;
  let mockJwks: MockJwksServer;
  let baseConfig: OidcJwtValidatorConfig;

  beforeAll(async () => {
    keyA = await generateTestKey('kid-a');
    keyB = await generateTestKey('kid-b');
  });

  beforeEach(async () => {
    mockJwks = await startMockJwksServer([keyA.jwk]);
    baseConfig = { issuer: ISSUER, audience: AUDIENCE, jwksUri: mockJwks.url };
  });

  afterEach(async () => {
    await mockJwks.close();
  });

  it('fetches the JWKS once and reuses it across repeated valid requests for the same kid', async () => {
    const validator = createOidcJwtValidator(baseConfig, deps);
    const token = await signTestToken(keyA.privateKey, { kid: keyA.kid });

    await validator.validate(`Bearer ${token}`);
    await validator.validate(`Bearer ${token}`);
    await validator.validate(`Bearer ${token}`);

    expect(mockJwks.requestCount()).toBe(1);
  });

  it('automatically refetches and picks up a rotated key once the cooldown allows it', async () => {
    const validator = createOidcJwtValidator(
      { ...baseConfig, jwks: { cooldownDurationMs: 0 } },
      deps,
    );
    const tokenA = await signTestToken(keyA.privateKey, { kid: keyA.kid });
    await validator.validate(`Bearer ${tokenA}`);
    expect(mockJwks.requestCount()).toBe(1);

    // Rotate: the server now only serves the new key (as a real rotation would).
    mockJwks.setKeys([keyB.jwk]);
    const tokenB = await signTestToken(keyB.privateKey, { kid: keyB.kid });

    const identity = await validator.validate(`Bearer ${tokenB}`);

    expect(identity.sub).toBe('user-123');
    expect(mockJwks.requestCount()).toBe(2);
  });

  it('rejects an unknown kid outright when it appears before rotation completes on the server', async () => {
    const validator = createOidcJwtValidator(
      { ...baseConfig, jwks: { cooldownDurationMs: 0 } },
      deps,
    );
    // keyB is not yet published by the server at all.
    const tokenB = await signTestToken(keyB.privateKey, { kid: keyB.kid });

    await expect(validator.validate(`Bearer ${tokenB}`)).rejects.toMatchObject({
      code: 'AUTH_FAILED',
    });
  });

  it('does not hammer the JWKS endpoint with a fetch per request while cooling down', async () => {
    // Default cooldown (~30s) — no override.
    const validator = createOidcJwtValidator(baseConfig, deps);
    const tokenA = await signTestToken(keyA.privateKey, { kid: keyA.kid });
    await validator.validate(`Bearer ${tokenA}`);
    expect(mockJwks.requestCount()).toBe(1);

    // keyB isn't published yet; repeated attempts within the cooldown window
    // must not each trigger their own HTTP fetch.
    const tokenB = await signTestToken(keyB.privateKey, { kid: keyB.kid });
    await validator.validate(`Bearer ${tokenB}`).catch(() => undefined);
    await validator.validate(`Bearer ${tokenB}`).catch(() => undefined);
    await validator.validate(`Bearer ${tokenB}`).catch(() => undefined);

    expect(mockJwks.requestCount()).toBe(1);
  });

  it('reloadJwks() bypasses the cooldown on demand', async () => {
    const validator = createOidcJwtValidator(baseConfig, deps);
    const tokenA = await signTestToken(keyA.privateKey, { kid: keyA.kid });
    await validator.validate(`Bearer ${tokenA}`);
    expect(mockJwks.requestCount()).toBe(1);

    mockJwks.setKeys([keyB.jwk]);
    await validator.reloadJwks();
    expect(mockJwks.requestCount()).toBe(2);

    const tokenB = await signTestToken(keyB.privateKey, { kid: keyB.kid });
    const identity = await validator.validate(`Bearer ${tokenB}`);
    expect(identity.sub).toBe('user-123');
  });
});
