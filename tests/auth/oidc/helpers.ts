/**
 * Test-only helpers for the OIDC JWT validator suite: local keypair
 * generation, JWT signing, and a loopback-only mock JWKS HTTP server.
 * Nothing here touches the network beyond 127.0.0.1 — no live network calls.
 */
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey, type JWK } from 'jose';

export interface TestKey {
  kid: string;
  publicKey: CryptoKey;
  privateKey: CryptoKey;
  jwk: JWK;
}

export async function generateTestKey(kid: string): Promise<TestKey> {
  const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
  const jwk = await exportJWK(publicKey);
  jwk.kid = kid;
  jwk.alg = 'RS256';
  jwk.use = 'sig';
  return { kid, publicKey, privateKey, jwk };
}

export interface SignTestTokenOptions {
  kid?: string;
  alg?: string;
  issuer?: string;
  audience?: string | string[];
  /** Set to omit the `sub` claim entirely (for the "missing sub" test case). */
  omitSub?: boolean;
  sub?: string;
  issuedAt?: number;
  expiresAt?: number;
  notBefore?: number;
  extraClaims?: Record<string, unknown>;
  extraHeader?: Record<string, unknown>;
}

const DEFAULT_ISSUER = 'https://idp.example.test/realms/test';
const DEFAULT_AUDIENCE = 'vikunja-mcp-ng';

export async function signTestToken(
  privateKey: CryptoKey,
  options: SignTestTokenOptions = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload: Record<string, unknown> = { ...options.extraClaims };
  if (!options.omitSub) {
    payload.sub = options.sub ?? 'user-123';
  }

  const builder = new SignJWT(payload)
    .setProtectedHeader({
      alg: options.alg ?? 'RS256',
      typ: 'JWT',
      ...(options.kid !== undefined ? { kid: options.kid } : {}),
      ...options.extraHeader,
    })
    .setIssuer(options.issuer ?? DEFAULT_ISSUER)
    .setAudience(options.audience ?? DEFAULT_AUDIENCE)
    .setIssuedAt(options.issuedAt ?? now)
    .setExpirationTime(options.expiresAt ?? now + 3600);

  if (options.notBefore !== undefined) {
    builder.setNotBefore(options.notBefore);
  }

  return builder.sign(privateKey);
}

/** Builds an unsigned-looking `alg: none` JWT by hand (jose refuses to produce one). */
export function buildAlgNoneToken(claims: Record<string, unknown>): string {
  const header = base64url({ alg: 'none', typ: 'JWT' });
  const payload = base64url(claims);
  return `${header}.${payload}.`;
}

function base64url(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}

export interface MockJwksServer {
  url: string;
  requestCount: () => number;
  setKeys: (jwks: JWK[]) => void;
  close: () => Promise<void>;
}

/** Starts a loopback-only HTTP server serving a mutable JWKS document, so tests can exercise rotation. */
export async function startMockJwksServer(initialKeys: JWK[]): Promise<MockJwksServer> {
  let keys = initialKeys;
  let count = 0;

  const server = http.createServer((_req, res) => {
    count += 1;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ keys }));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${address.port}/jwks`,
    requestCount: () => count,
    setKeys: (newKeys: JWK[]) => {
      keys = newKeys;
    },
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}
