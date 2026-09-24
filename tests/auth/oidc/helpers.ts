/**
 * Test-only helpers for the OIDC JWT validator suite: local keypair
 * generation, JWT signing, and a loopback-only mock JWKS HTTP server.
 * Nothing here touches the network beyond 127.0.0.1 — no live network calls.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as https from 'node:https';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
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
  /** Set to omit the `exp` claim entirely (for the "missing exp" test case). */
  omitExpiresAt?: boolean;
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
    .setIssuedAt(options.issuedAt ?? now);

  if (!options.omitExpiresAt) {
    builder.setExpirationTime(options.expiresAt ?? now + 3600);
  }

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

/** A throwaway self-signed certificate for `127.0.0.1`, on disk in a temp dir. */
export interface SelfSignedCert {
  key: string;
  cert: string;
  /** PEM file a child process can trust via NODE_EXTRA_CA_CERTS. */
  certPath: string;
  cleanup: () => void;
}

/**
 * Generates a one-day, self-signed EC certificate for `IP:127.0.0.1` with the
 * `openssl` CLI (Node has no built-in X.509 creation). Test-only and ephemeral:
 * the key lives in a fresh temp dir and is never committed.
 */
export function generateSelfSignedCert(): SelfSignedCert {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vikunja-mcp-test-tls-'));
  const keyPath = path.join(dir, 'key.pem');
  const certPath = path.join(dir, 'cert.pem');
  const result = spawnSync(
    'openssl',
    [
      'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
      '-keyout', keyPath, '-out', certPath, '-days', '1',
      '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1',
    ],
    { encoding: 'utf-8' },
  );
  if (result.status !== 0) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw new Error(
      `openssl could not create a test certificate (is the openssl CLI installed?): ${
        result.error?.message ?? result.stderr
      }`,
    );
  }
  return {
    key: fs.readFileSync(keyPath, 'utf-8'),
    cert: fs.readFileSync(certPath, 'utf-8'),
    certPath,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

/**
 * Starts a loopback-only server serving a mutable JWKS document, so tests can
 * exercise rotation. Plain http by default (in-process unit tests call the
 * validator directly). Pass `tls` to serve https, which a spawned server needs:
 * its config only accepts an `https://` jwksUri.
 */
export async function startMockJwksServer(
  initialKeys: JWK[],
  options: { tls?: Pick<SelfSignedCert, 'key' | 'cert'> } = {},
): Promise<MockJwksServer> {
  let keys = initialKeys;
  let count = 0;

  const handler: http.RequestListener = (_req, res) => {
    count += 1;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ keys }));
  };
  const server = options.tls
    ? https.createServer({ key: options.tls.key, cert: options.tls.cert }, handler)
    : http.createServer(handler);

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;

  return {
    url: `${options.tls ? 'https' : 'http'}://127.0.0.1:${address.port}/jwks`,
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
