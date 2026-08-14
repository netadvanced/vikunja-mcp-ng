/**
 * Mock OpenID Connect identity provider for the enrollment e2e lane
 * (issue #220, scripts/oidc-e2e.ts).
 *
 * The one-click enrollment flow needs the REAL local Vikunja (docker/e2e) to
 * complete a REAL OpenID login: Vikunja fetches this issuer's discovery
 * document, exchanges the authorization code at its token endpoint with its
 * own client credentials, verifies the RS256 id_token against the JWKS, and
 * auto-creates the user from its claims. This module implements exactly the
 * endpoints go-vikunja 2.4.0 (via go-oidc / golang.org/x/oauth2) touches:
 *
 *   GET  /.well-known/openid-configuration
 *   GET  /authorize   -> 302 redirect_uri?code=...&state=...  (zero-interaction)
 *   POST /token       -> { access_token, id_token, token_type, expires_in }
 *   GET  /jwks
 *   GET  /userinfo    -> claims for the access token (Vikunja falls back here
 *                        for claims missing from the id_token)
 *
 * Dual-host reality: the Vikunja *container* reaches this server as
 * `http://host.docker.internal:<port>` (the `issuer` value — the OIDC `iss`
 * must match what Vikunja is configured with), while the harness on the host
 * reaches it as `http://127.0.0.1:<port>`. That is why it binds 0.0.0.0 and
 * why the harness rewrites the authorize URL's hostname before fetching it
 * (the documented "script the code acquisition" concession — a real browser
 * would resolve one public hostname for both).
 *
 * Test-only fidelity notes: client_id/client_secret are verified (both HTTP
 * Basic and form-body auth styles, since golang.org/x/oauth2 probes both),
 * codes are single-use and bound to their redirect_uri, and the id_token
 * carries the claims Vikunja's getOrCreateUser needs (`email` is mandatory
 * upstream). redirect_uri values are NOT whitelisted — this issuer lives for
 * seconds on a developer machine and signs throwaway keys.
 */

import * as http from 'node:http';
import * as crypto from 'node:crypto';
import { SignJWT, type CryptoKey } from 'jose';
import { generateTestKey, type TestKey } from '../../tests/auth/oidc/helpers';

export interface MockIdpUser {
  sub: string;
  email: string;
  name: string;
  preferredUsername: string;
}

export interface MockOidcIdpOptions {
  /** Fixed host port, published to containers via host.docker.internal. */
  port: number;
  /** Hostname baked into `issuer` (what the Vikunja container is configured with). */
  issuerHost: string;
  clientId: string;
  clientSecret: string;
  /** The test subject every authorize call "logs in" as (zero-interaction SSO). */
  user: MockIdpUser;
}

export interface MockOidcIdp {
  /** `http://<issuerHost>:<port>` — the value Vikunja's provider `authurl` must be. */
  issuer: string;
  /** `http://127.0.0.1:<port>` — how the harness reaches the same server. */
  localBase: string;
  close(): Promise<void>;
}

interface IssuedCode {
  redirectUri: string;
  nonce: string | null;
  used: boolean;
}

function formBody(req: http.IncomingMessage): Promise<URLSearchParams> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c as Buffer));
    req.on('end', () => resolve(new URLSearchParams(Buffer.concat(chunks).toString('utf-8'))));
    req.on('error', reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

export async function startMockOidcIdp(options: MockOidcIdpOptions): Promise<MockOidcIdp> {
  const issuer = `http://${options.issuerHost}:${options.port}`;
  const key: TestKey = await generateTestKey('oidc-e2e-idp-key');
  const codes = new Map<string, IssuedCode>();
  const accessTokens = new Set<string>();

  function clientAuthOk(req: http.IncomingMessage, params: URLSearchParams): boolean {
    const header = req.headers.authorization;
    if (typeof header === 'string' && header.startsWith('Basic ')) {
      const decoded = Buffer.from(header.slice('Basic '.length), 'base64').toString('utf-8');
      // Both halves are URL-encoded per RFC 6749 §2.3.1 (go's oauth2 does this).
      const sep = decoded.indexOf(':');
      const id = decodeURIComponent(decoded.slice(0, sep));
      const secret = decodeURIComponent(decoded.slice(sep + 1));
      return id === options.clientId && secret === options.clientSecret;
    }
    return (
      params.get('client_id') === options.clientId &&
      params.get('client_secret') === options.clientSecret
    );
  }

  async function mintIdToken(nonce: string | null): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({
      sub: options.user.sub,
      email: options.user.email,
      email_verified: true,
      name: options.user.name,
      preferred_username: options.user.preferredUsername,
      ...(nonce !== null ? { nonce } : {}),
    })
      .setProtectedHeader({ alg: 'RS256', typ: 'JWT', kid: key.kid })
      .setIssuer(issuer)
      .setAudience(options.clientId)
      .setIssuedAt(now)
      .setExpirationTime(now + 600)
      .sign(key.privateKey as CryptoKey);
  }

  const server = http.createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', issuer);

      if (req.method === 'GET' && url.pathname === '/.well-known/openid-configuration') {
        sendJson(res, 200, {
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          jwks_uri: `${issuer}/jwks`,
          userinfo_endpoint: `${issuer}/userinfo`,
          response_types_supported: ['code'],
          subject_types_supported: ['public'],
          id_token_signing_alg_values_supported: ['RS256'],
          token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
          scopes_supported: ['openid', 'profile', 'email'],
        });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/jwks') {
        sendJson(res, 200, { keys: [key.jwk] });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/authorize') {
        if (url.searchParams.get('client_id') !== options.clientId) {
          sendJson(res, 400, { error: 'unauthorized_client' });
          return;
        }
        const redirectUri = url.searchParams.get('redirect_uri');
        const state = url.searchParams.get('state');
        if (!redirectUri || !state) {
          sendJson(res, 400, { error: 'invalid_request' });
          return;
        }
        const code = crypto.randomBytes(16).toString('base64url');
        codes.set(code, {
          redirectUri,
          nonce: url.searchParams.get('nonce'),
          used: false,
        });
        const target = new URL(redirectUri);
        target.searchParams.set('code', code);
        target.searchParams.set('state', state);
        res.writeHead(302, { Location: target.toString() });
        res.end();
        return;
      }

      if (req.method === 'POST' && url.pathname === '/token') {
        const params = await formBody(req);
        if (!clientAuthOk(req, params)) {
          sendJson(res, 401, { error: 'invalid_client' });
          return;
        }
        if (params.get('grant_type') !== 'authorization_code') {
          sendJson(res, 400, { error: 'unsupported_grant_type' });
          return;
        }
        const code = params.get('code');
        const issued = code !== null ? codes.get(code) : undefined;
        if (!issued || issued.used || issued.redirectUri !== params.get('redirect_uri')) {
          sendJson(res, 400, { error: 'invalid_grant' });
          return;
        }
        issued.used = true;
        const accessToken = `at-${crypto.randomBytes(16).toString('base64url')}`;
        accessTokens.add(accessToken);
        sendJson(res, 200, {
          access_token: accessToken,
          token_type: 'Bearer',
          expires_in: 3600,
          id_token: await mintIdToken(issued.nonce),
        });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/userinfo') {
        const auth = req.headers.authorization ?? '';
        const token = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : '';
        if (!accessTokens.has(token)) {
          sendJson(res, 401, { error: 'invalid_token' });
          return;
        }
        sendJson(res, 200, {
          sub: options.user.sub,
          email: options.user.email,
          email_verified: true,
          name: options.user.name,
          preferred_username: options.user.preferredUsername,
        });
        return;
      }

      sendJson(res, 404, { error: 'not_found' });
    })().catch(() => {
      if (!res.headersSent) {
        sendJson(res, 500, { error: 'server_error' });
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    // 0.0.0.0: the Vikunja container must reach this via host-gateway.
    server.listen(options.port, '0.0.0.0', () => resolve());
  });

  return {
    issuer,
    localBase: `http://127.0.0.1:${options.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => server.close(err => (err ? reject(err) : resolve()))),
  };
}
