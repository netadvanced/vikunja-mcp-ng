/**
 * The https mode of the shared mock JWKS server (tests/auth/oidc/helpers.ts).
 *
 * `oidc.jwksUri` must be `https://` (src/config/types.ts), so the real-process
 * e2e lane (scripts/oidc-e2e.ts) serves its mock JWKS over TLS with a
 * throwaway self-signed certificate and points the spawned server at it via
 * NODE_EXTRA_CA_CERTS. These tests pin the helper half of that contract.
 */

import * as fs from 'node:fs';
import * as https from 'node:https';
import {
  generateSelfSignedCert,
  generateTestKey,
  startMockJwksServer,
  type MockJwksServer,
  type SelfSignedCert,
} from './helpers';

function getJson(url: string, ca?: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, ca === undefined ? {} : { ca }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8'))));
    });
    req.on('error', reject);
  });
}

describe('mock JWKS server over https', () => {
  let cert: SelfSignedCert;
  let server: MockJwksServer | undefined;

  beforeAll(() => {
    cert = generateSelfSignedCert();
  });

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  afterAll(() => {
    cert.cleanup();
  });

  it('generates a PEM key pair and writes the certificate to a file a child can trust', () => {
    expect(cert.key).toContain('PRIVATE KEY');
    expect(cert.cert).toContain('BEGIN CERTIFICATE');
    expect(fs.readFileSync(cert.certPath, 'utf-8')).toBe(cert.cert);
  });

  it('serves the JWKS on an https://127.0.0.1 URL when given TLS material', async () => {
    const key = await generateTestKey('tls-kid');
    server = await startMockJwksServer([key.jwk], { tls: cert });

    expect(server.url).toMatch(/^https:\/\/127\.0\.0\.1:\d+\/jwks$/);
    const body = (await getJson(server.url, cert.cert)) as { keys: Array<{ kid: string }> };
    expect(body.keys.map((k) => k.kid)).toEqual(['tls-kid']);
    expect(server.requestCount()).toBe(1);
  });

  it('is rejected by a client that does not trust the throwaway certificate', async () => {
    const key = await generateTestKey('tls-kid-2');
    server = await startMockJwksServer([key.jwk], { tls: cert });

    await expect(getJson(server.url)).rejects.toThrow(/self[- ]signed/i);
  });

  it('removes its temporary files on cleanup', () => {
    const throwaway = generateSelfSignedCert();
    expect(fs.existsSync(throwaway.certPath)).toBe(true);

    throwaway.cleanup();

    expect(fs.existsSync(throwaway.certPath)).toBe(false);
  });

  it('keeps plain http as the default for the in-process unit tests', async () => {
    const key = await generateTestKey('plain-kid');
    server = await startMockJwksServer([key.jwk]);

    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/jwks$/);
  });
});
