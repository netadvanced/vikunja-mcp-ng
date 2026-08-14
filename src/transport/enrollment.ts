/**
 * One-click SSO enrollment for oidc-http mode (issue #220,
 * docs/OIDC-SETUP.md §9a).
 *
 * This module is the browser half of auto-provisioning: it turns a single
 * IdP authorization hop into a vaulted, per-user Vikunja `tk_*` token, so a
 * fresh SSO user never pastes a credential into their chat.
 *
 * Flow (each wire fact validated against the go-vikunja/vikunja v2.4.0
 * source — see the design section in docs/OIDC-SETUP.md §9a for citations):
 *
 *  1. `vikunja_auth provision` (no token) calls {@link createEnrollmentUrl}:
 *     a single-use, TTL-bound ticket is minted for the caller's validated
 *     identity ({@link EnrollmentTicketStore}) and embedded in
 *     `GET <base>/enroll?ticket=...`.
 *  2. `GET /enroll` validates the ticket, discovers the Vikunja OpenID
 *     provider from Vikunja's unauthenticated `GET /info`
 *     (`auth.openid_connect.providers[]`: `key`, `auth_url` — the IdP's
 *     authorization endpoint — `client_id`, `scope`), and 302-redirects the
 *     browser to the IdP with Vikunja's OWN `client_id` (the ID token's
 *     audience is verified against it upstream), `redirect_uri =
 *     <base>/enroll/callback`, and `state = <ticket>`.
 *  3. `GET /enroll/callback?code&state` validates the ticket bound to
 *     `state`, POSTs the code to Vikunja's native
 *     `POST /auth/openid/{key}/callback` with `{code, redirect_url, scope}`
 *     — Vikunja replays that `redirect_url` string verbatim as the OAuth
 *     `redirect_uri` in its own token exchange, so it must be byte-identical
 *     to step 2's — and receives the enrolled user's (10-minute, 2.x)
 *     Vikunja JWT. Only a SUCCESSFUL exchange consumes the ticket (single
 *     use); a transient upstream failure leaves the link redeemable
 *     (finding #4). The service then **pins the enrolled account to the
 *     initiating identity** (finding #1): `GET /user` with the fresh JWT
 *     must report the SAME person as the ticket's identity claims
 *     (email, else preferred_username; fail closed when unverifiable) —
 *     otherwise a forwarded enrollment link would vault the *browser
 *     user's* token under the *link creator's* identity. On a match it
 *     enumerates `GET /routes`, mints a `tk_*` token via `PUT /tokens`
 *     (JWT-only upstream; mint is non-retried to avoid double-minting),
 *     vaults it under the identity, discards the JWT, and renders a minimal
 *     "connected" page.
 *
 * Both endpoints are unauthenticated at the HTTP layer by necessity (a
 * browser holds no MCP bearer token); the ticket IS the authentication.
 * Failure pages are generic — logged detail stays server-side, and neither
 * the JWT nor the minted token ever appears in a response body.
 *
 * All Vikunja traffic goes through {@link vikunjaRestRequest} (finding #8):
 * the same retry/circuit-breaker path as every tool call, with throwaway
 * per-flow `AuthManager`s and `ignoreRequestContext` (the out-of-session
 * pattern `vikunja_auth provision`'s verify probe established).
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { AuthManager } from '../auth/AuthManager';
import type { Identity } from '../context/requestContext';
import { EnrollmentTicketStore } from './enrollmentTickets';
import { getActiveVaultStore } from '../storage/vaultFileStore';
import { ConfigurationError, type EnrollConfig, type HttpConfig } from '../config/types';
import { vikunjaRestRequest, type VikunjaRestRequestOptions } from '../utils/vikunja-rest';
import { logger } from '../utils/logger';

/** Default OIDC scope when the provider config leaves it empty (Vikunja's own default). */
const DEFAULT_SCOPE = 'openid profile email';

/**
 * Placeholder credential for the unauthenticated Vikunja calls (`GET /info`,
 * the openid callback) — both are public routes that ignore the
 * Authorization header, but `vikunjaRestRequest` requires a connected
 * session to run.
 */
const ANONYMOUS_TOKEN = 'enrollment-unauthenticated';

/** The vault surface enrollment needs — `VaultFileStore.provision`'s shape. */
export interface EnrollmentVault {
  provision(identity: Identity, vikunjaUrl: string, apiToken: string): Promise<void>;
}

/** `vikunjaRestRequest`'s shape — injectable so unit tests script the wire. */
export type EnrollmentRestRequest = (
  authManager: AuthManager,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
  options?: VikunjaRestRequestOptions,
) => Promise<unknown>;

export interface EnrollmentServiceDeps {
  tickets: EnrollmentTicketStore;
  vault: EnrollmentVault;
  /** Vikunja API base URL (`.../api/v1`) the flow talks to. */
  vikunjaUrl: string;
  /**
   * Canonical public base URL of THIS server (origin + optional path
   * prefix, no trailing slash — e.g. `https://mcp.example.ch` or
   * `https://gw.example.ch/vikunja-mcp`), derived from the REQUIRED
   * `http.publicUrl` (finding #2). Both the enrollment URL and the OAuth
   * `redirect_uri` are built from this one fixed value, so the authorize
   * hop and the Vikunja callback replay are byte-identical by construction.
   */
  publicBaseUrl: string;
  /** Vikunja OpenID provider `key`/`name` to use; optional when the backend has exactly one. */
  providerName?: string | undefined;
  /** Expiry of the auto-minted `tk_*` token, in days. */
  tokenExpiryDays: number;
  /** Injectable for tests; defaults to the real {@link vikunjaRestRequest}. */
  restRequest?: EnrollmentRestRequest;
}

/** One provider entry from Vikunja `GET /info` (`auth.openid_connect.providers[]`). */
interface VikunjaOpenIdProvider {
  name?: string;
  key?: string;
  auth_url?: string;
  client_id?: string;
  scope?: string;
}

/** A provider entry that passed {@link isUsableProvider} — all wire-critical fields present. */
interface UsableProvider extends VikunjaOpenIdProvider {
  key: string;
  auth_url: string;
  client_id: string;
}

interface VikunjaInfoAuth {
  auth?: {
    openid_connect?: {
      enabled?: boolean;
      providers?: VikunjaOpenIdProvider[] | null;
    };
  };
}

/** `GET /user` — the identity surface Vikunja's API exposes (issuer/subject stay DB-internal). */
interface VikunjaUserResponse {
  username?: string;
  email?: string;
}

/**
 * A flow failure with a browser-safe message. `userMessage` is rendered
 * (escaped) on the error page; anything sensitive belongs in the log call at
 * the throw site, never here.
 */
class EnrollmentFlowError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly userMessage: string,
  ) {
    super(userMessage);
    this.name = 'EnrollmentFlowError';
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Minimal, self-contained HTML page (no external assets — it may render behind strict CSPs). */
function renderPage(title: string, message: string): string {
  return [
    '<!doctype html><html><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(title)}</title>`,
    '<style>body{font-family:system-ui,sans-serif;display:flex;min-height:100vh;margin:0;',
    'align-items:center;justify-content:center;background:#f6f7f9;color:#1c2430}',
    'main{max-width:26rem;padding:2.5rem;background:#fff;border-radius:12px;',
    'box-shadow:0 2px 12px rgba(0,0,0,.08);text-align:center}h1{font-size:1.25rem}</style>',
    `</head><body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></main>`,
    '</body></html>',
  ].join('');
}

function sendHtml(res: ServerResponse, statusCode: number, html: string): void {
  res.writeHead(statusCode, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': String(Buffer.byteLength(html)),
    'Cache-Control': 'no-store',
  });
  res.end(html);
}

function isUsableProvider(p: VikunjaOpenIdProvider): p is UsableProvider {
  return (
    typeof p.auth_url === 'string' &&
    p.auth_url.length > 0 &&
    typeof p.key === 'string' &&
    p.key.length > 0 &&
    typeof p.client_id === 'string' &&
    p.client_id.length > 0
  );
}

export class EnrollmentService {
  private readonly restRequest: EnrollmentRestRequest;
  /** Path prefix of {@link EnrollmentServiceDeps.publicBaseUrl} ('' when none). */
  private readonly basePath: string;

  constructor(private readonly deps: EnrollmentServiceDeps) {
    this.restRequest = deps.restRequest ?? (vikunjaRestRequest as EnrollmentRestRequest);
    this.basePath = new URL(deps.publicBaseUrl).pathname.replace(/\/+$/, '');
  }

  /** The Vikunja API base this flow enrolls against (surfaced by `vikunja_auth provision`, finding #3). */
  get vikunjaUrl(): string {
    return this.deps.vikunjaUrl;
  }

  /** The URL `vikunja_auth provision` hands an unprovisioned identity. */
  createEnrollmentUrl(identity: Identity): string {
    const ticket = this.deps.tickets.issue(identity);
    const url = new URL(`${this.deps.publicBaseUrl}/enroll`);
    url.searchParams.set('ticket', ticket);
    return url.toString();
  }

  /**
   * Serve `GET <base>/enroll` / `GET <base>/enroll/callback`. Returns `false`
   * (writing nothing) for any other path — including malformed or
   * non-origin-form request targets (finding #6: those must fall through to
   * the transport's plain 404, never become a 500 + error-log line).
   */
  async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const rawUrl = req.url ?? '';
    // Only origin-form targets ('/path?query') are enrollment candidates;
    // absolute-form ('http://...'), protocol-relative ('//...') and
    // asterisk-form targets are not ours to answer.
    if (!rawUrl.startsWith('/') || rawUrl.startsWith('//')) {
      return false;
    }
    let url: URL;
    try {
      url = new URL(rawUrl, this.deps.publicBaseUrl);
    } catch {
      return false;
    }
    const isEnroll = url.pathname === `${this.basePath}/enroll`;
    const isCallback = url.pathname === `${this.basePath}/enroll/callback`;
    if (!isEnroll && !isCallback) {
      return false;
    }
    if (req.method !== 'GET') {
      sendHtml(res, 405, renderPage('Method not allowed', 'Enrollment endpoints are GET-only.'));
      return true;
    }
    try {
      if (isEnroll) {
        await this.handleEnrollStart(url, res);
      } else {
        await this.handleEnrollCallback(url, res);
      }
    } catch (error) {
      if (error instanceof EnrollmentFlowError) {
        sendHtml(res, error.statusCode, renderPage('Enrollment failed', error.userMessage));
      } else {
        logger.error('Unexpected enrollment failure', {
          error: error instanceof Error ? error.message : String(error),
        });
        sendHtml(
          res,
          500,
          renderPage(
            'Enrollment failed',
            'Something went wrong on the server. Please return to your chat and try again.',
          ),
        );
      }
    }
    return true;
  }

  private async handleEnrollStart(url: URL, res: ServerResponse): Promise<void> {
    const ticket = url.searchParams.get('ticket');
    if (!ticket || this.deps.tickets.peek(ticket) === null) {
      throw new EnrollmentFlowError(
        400,
        'This enrollment link is invalid or expired. Return to your chat and run ' +
          'vikunja_auth provision again to get a fresh one.',
      );
    }

    const provider = await this.discoverProvider();
    const authorize = new URL(provider.auth_url);
    authorize.searchParams.set('response_type', 'code');
    authorize.searchParams.set('client_id', provider.client_id);
    authorize.searchParams.set('redirect_uri', this.redirectUri());
    authorize.searchParams.set('scope', this.scopeOf(provider));
    authorize.searchParams.set('state', ticket);

    res.writeHead(302, { Location: authorize.toString(), 'Cache-Control': 'no-store' });
    res.end();
  }

  private async handleEnrollCallback(url: URL, res: ServerResponse): Promise<void> {
    const idpError = url.searchParams.get('error');
    if (idpError !== null) {
      throw new EnrollmentFlowError(
        400,
        `The identity provider reported an error (${idpError}). ` +
          'Return to your chat and run vikunja_auth provision again.',
      );
    }
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    if (!code || !state) {
      throw new EnrollmentFlowError(400, 'Missing code or state on the enrollment callback.');
    }

    // Peek — do NOT consume yet (finding #4): a transient failure in the
    // upstream hops below must leave the link redeemable, not force the user
    // back to their chat for a fresh one. The identity comes ONLY from the
    // server-side ticket record (never from the browser request) — D7.
    const identity = this.deps.tickets.peek(state);
    if (identity === null) {
      throw new EnrollmentFlowError(
        400,
        'This enrollment link is invalid, expired, or already used. Return to your ' +
          'chat and run vikunja_auth provision again.',
      );
    }

    const provider = await this.discoverProvider();

    // Vikunja's native openid callback: exchanges the code with the IdP
    // itself (its own client credentials, and the redirect_url below replayed
    // verbatim as redirect_uri), auto-creating the account on first login.
    const jwt = await this.exchangeCodeForJwt(provider, code);

    // The exchange succeeded — the code is spent at the IdP, so NOW the
    // ticket is consumed (single-use; a concurrent redemption of the same
    // state loses this race and gets the invalid-link error).
    if (this.deps.tickets.consume(state) === null) {
      throw new EnrollmentFlowError(
        400,
        'This enrollment link was already used. Return to your chat and run ' +
          'vikunja_auth provision again.',
      );
    }

    // Finding #1 — pin the enrolled Vikunja account to the initiating
    // identity before anything is minted or stored. Without this, a
    // forwarded enrollment link would vault the BROWSER user's token under
    // the LINK CREATOR's identity (cross-account capture in either
    // direction).
    await this.verifyEnrolledAccount(jwt, identity);

    // The 2.x callback JWT lives ~10 minutes — mint immediately, then drop it.
    const apiToken = await this.mintApiToken(jwt);

    try {
      await this.deps.vault.provision(identity, this.deps.vikunjaUrl, apiToken);
    } catch (error) {
      logger.error('Enrollment: vault write failed after token mint', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw new EnrollmentFlowError(
        500,
        'Your Vikunja token was created but could not be stored. Please return to ' +
          'your chat and run vikunja_auth provision again.',
      );
    }

    logger.info('Enrollment complete: minted and vaulted a Vikunja API token', {
      sub: identity.sub,
    });
    sendHtml(
      res,
      200,
      renderPage(
        'Connected',
        'Your Vikunja account is now linked. You can close this tab and return to your chat.',
      ),
    );
  }

  /** `<publicBaseUrl>/enroll/callback` — the one string used on BOTH hops. */
  private redirectUri(): string {
    return `${this.deps.publicBaseUrl}/enroll/callback`;
  }

  private scopeOf(provider: VikunjaOpenIdProvider): string {
    return provider.scope !== undefined && provider.scope.trim().length > 0
      ? provider.scope
      : DEFAULT_SCOPE;
  }

  /** A throwaway per-call session manager (the out-of-session pattern — see module doc). */
  private manager(token: string): AuthManager {
    const authManager = new AuthManager();
    authManager.connect(this.deps.vikunjaUrl, token, 'jwt');
    return authManager;
  }

  /**
   * Discover the enrollment provider from Vikunja's unauthenticated
   * `GET /info`. Every failure mode maps to a clean, generic 502 — the
   * backend's OpenID configuration is an operator concern, not the user's.
   * Providers missing any wire-critical field (`auth_url`, `key`,
   * `client_id`) are treated as unusable rather than silently defaulted
   * (finding #12).
   */
  private async discoverProvider(): Promise<UsableProvider> {
    let info: VikunjaInfoAuth;
    try {
      info = (await this.restRequest(this.manager(ANONYMOUS_TOKEN), 'GET', '/info', undefined, {
        ignoreRequestContext: true,
      })) as VikunjaInfoAuth;
    } catch (error) {
      logger.error('Enrollment: could not reach Vikunja /info', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw new EnrollmentFlowError(
        502,
        'The Vikunja server could not be reached. Please try again later.',
      );
    }

    const openid = info?.auth?.openid_connect;
    const providers = (openid?.providers ?? []).filter(isUsableProvider);
    if (openid?.enabled !== true || providers.length === 0) {
      throw new EnrollmentFlowError(
        502,
        'The Vikunja server has no usable OpenID login provider configured, so ' +
          'one-click enrollment is unavailable. Link a token manually with ' +
          'vikunja_auth provision instead (see the setup docs).',
      );
    }

    const wanted = this.deps.providerName;
    if (wanted !== undefined) {
      const match = providers.find(p => p.key === wanted || p.name === wanted);
      if (!match) {
        logger.error('Enrollment: configured provider not present on the backend', {
          wanted,
          available: providers.map(p => p.key),
        });
        throw new EnrollmentFlowError(
          502,
          `The configured OpenID provider "${wanted}" is not available on the Vikunja server.`,
        );
      }
      return match;
    }
    if (providers.length > 1) {
      logger.error('Enrollment: several OpenID providers but none configured', {
        available: providers.map(p => p.key),
      });
      throw new EnrollmentFlowError(
        502,
        'The Vikunja server has several OpenID providers; the MCP operator must set ' +
          'VIKUNJA_MCP_ENROLL_PROVIDER to choose one.',
      );
    }
    return providers[0] as UsableProvider;
  }

  /** `POST /auth/openid/{key}/callback` -> the enrolled user's Vikunja JWT. */
  private async exchangeCodeForJwt(provider: UsableProvider, code: string): Promise<string> {
    let body: { token?: unknown };
    try {
      body = (await this.restRequest(
        this.manager(ANONYMOUS_TOKEN),
        'POST',
        `/auth/openid/${encodeURIComponent(provider.key)}/callback`,
        {
          code,
          redirect_url: this.redirectUri(),
          scope: this.scopeOf(provider),
        },
        { ignoreRequestContext: true },
      )) as { token?: unknown };
    } catch (error) {
      logger.error('Enrollment: Vikunja rejected (or could not complete) the openid callback', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw new EnrollmentFlowError(
        502,
        'Vikunja did not accept the login. Please return to your chat and try again.',
      );
    }
    if (typeof body?.token !== 'string' || body.token.length === 0) {
      logger.error('Enrollment: Vikunja openid callback returned no token');
      throw new EnrollmentFlowError(502, 'Vikunja did not return a login token.');
    }
    return body.token;
  }

  /**
   * Finding #1: require that the account Vikunja just authenticated
   * (`GET /user` under the fresh JWT) belongs to the identity that initiated
   * the enrollment. The API's only identity surface is username/email
   * (Vikunja's `issuer`/`subject` columns are not exposed), and under the
   * documented same-IdP precondition Vikunja's openid users get
   * `username = preferred_username` and `email = email` from the SAME
   * claims the MCP bearer token carries — so the match is: `email` claim
   * (case-insensitive) first, `preferred_username` vs username as the
   * fallback, and FAIL CLOSED when the MCP token carries neither.
   */
  private async verifyEnrolledAccount(jwt: string, identity: Identity): Promise<void> {
    let enrolled: VikunjaUserResponse;
    try {
      enrolled = (await this.restRequest(this.manager(jwt), 'GET', '/user', undefined, {
        ignoreRequestContext: true,
      })) as VikunjaUserResponse;
    } catch (error) {
      logger.error('Enrollment: could not fetch the enrolled account for identity pinning', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw new EnrollmentFlowError(
        502,
        'Vikunja could not confirm which account was logged in. Please try again.',
      );
    }

    const wantEmail = identity.email?.trim().toLowerCase();
    const wantUsername = identity.preferredUsername;
    if (wantEmail === undefined && wantUsername === undefined) {
      logger.error(
        'Enrollment: MCP access token carries neither email nor preferred_username — ' +
          'cannot pin the enrolled account to the caller; failing closed',
        { sub: identity.sub },
      );
      throw new EnrollmentFlowError(
        403,
        'Your login token does not carry the claims needed to verify the enrolled ' +
          'account belongs to you (email or preferred_username). Ask the operator to ' +
          'add those claims, or link a token manually with vikunja_auth provision.',
      );
    }

    const emailMatches =
      wantEmail !== undefined &&
      typeof enrolled?.email === 'string' &&
      enrolled.email.trim().toLowerCase() === wantEmail;
    const usernameMatches =
      wantUsername !== undefined &&
      typeof enrolled?.username === 'string' &&
      enrolled.username === wantUsername;

    if (!emailMatches && !usernameMatches) {
      logger.error(
        'Enrollment: the account Vikunja authenticated does not match the identity ' +
          'that requested this enrollment link — refusing to link (forwarded-link protection)',
        { sub: identity.sub, enrolledUsername: enrolled?.username },
      );
      throw new EnrollmentFlowError(
        403,
        'The signed-in account does not match the person this enrollment link was ' +
          'issued to — it looks like the link was opened by another account. Nothing ' +
          'was linked. Return to your chat and run vikunja_auth provision yourself.',
      );
    }
  }

  /**
   * Enumerate `GET /routes` and mint a full-permission `tk_*` token via
   * `PUT /tokens` (both JWT-authenticated; `PUT /tokens` is JWT-only
   * upstream). Vikunja has no wildcard permission — "everything" is the
   * complete routes map, exactly how the e2e bootstrap mints its token.
   * Malformed route groups (null/primitive values) are skipped (finding #5),
   * and an unusable map fails loudly rather than minting a zero-permission
   * token.
   */
  private async mintApiToken(jwt: string): Promise<string> {
    const jwtManager = this.manager(jwt);

    let routes: Record<string, unknown>;
    try {
      routes = (await this.restRequest(jwtManager, 'GET', '/routes', undefined, {
        ignoreRequestContext: true,
      })) as Record<string, unknown>;
    } catch (error) {
      logger.error('Enrollment: GET /routes failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw new EnrollmentFlowError(502, 'Vikunja refused to enumerate token permissions.');
    }
    const permissions: Record<string, string[]> = {};
    for (const [group, verbs] of Object.entries(routes ?? {})) {
      if (typeof verbs === 'object' && verbs !== null && !Array.isArray(verbs)) {
        permissions[group] = Object.keys(verbs);
      }
    }
    if (Object.keys(permissions).length === 0) {
      logger.error('Enrollment: GET /routes yielded no usable permission groups');
      throw new EnrollmentFlowError(502, 'Vikunja returned no usable token permissions.');
    }

    const expiresAt = new Date(
      Date.now() + this.deps.tokenExpiryDays * 24 * 3600 * 1000,
    ).toISOString();
    let minted: { token?: unknown };
    try {
      minted = (await this.restRequest(
        jwtManager,
        'PUT',
        '/tokens',
        {
          title: `vikunja-mcp enrollment ${new Date().toISOString().slice(0, 10)}`,
          permissions,
          expires_at: expiresAt,
        },
        // No retries on the mint itself: a retried ambiguous failure could
        // create a second (orphaned) full-permission token.
        { ignoreRequestContext: true, retry: { maxRetries: 0 } },
      )) as { token?: unknown };
    } catch (error) {
      logger.error('Enrollment: PUT /tokens failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw new EnrollmentFlowError(502, 'Vikunja refused to create an API token.');
    }
    if (typeof minted?.token !== 'string' || minted.token.length === 0) {
      logger.error('Enrollment: PUT /tokens returned no token value');
      throw new EnrollmentFlowError(502, 'Vikunja did not return the created token.');
    }
    return minted.token;
  }
}

// ---------------------------------------------------------------------------
// Active-service seam — mirrors oidcMiddlewareSeam.ts / vaultFileStore.ts's
// module-scope registration pattern: production wiring registers exactly one
// EnrollmentService at startup; the HTTP transport (browser endpoints) and
// the vikunja_auth tool (enrollment-URL issuing) both read it back here.
// ---------------------------------------------------------------------------

let activeEnrollmentService: EnrollmentService | undefined;

/** Registers the process's enrollment service. `undefined` clears it (tests). */
export function setActiveEnrollmentService(service: EnrollmentService | undefined): void {
  activeEnrollmentService = service;
}

/** The registered enrollment service, or `undefined` when enrollment is disabled/not in oidc-http mode. */
export function getActiveEnrollmentService(): EnrollmentService | undefined {
  return activeEnrollmentService;
}

/**
 * Production wiring, called from `src/index.ts` AFTER `setupOidcHttpAuth`
 * (which registers the active vault store this feature writes through). A
 * no-op when `enroll.enabled` is false; fails loud (`ConfigurationError`,
 * matching the §2 "any missing → hard startup error" posture) when enabled
 * without a vault, without a resolvable Vikunja URL, or — finding #2 —
 * without `http.publicUrl`: enrollment URLs and the OAuth `redirect_uri`
 * must be the deployment's real public address (an IdP-whitelisted,
 * browser-reachable URL), never a derived bind address.
 *
 * The public base preserves any path prefix on `publicUrl`: only the
 * trailing MCP path segment (`http.path`) is stripped, so
 * `https://gw.example/vikunja-mcp/mcp` serves enrollment at
 * `https://gw.example/vikunja-mcp/enroll`.
 */
export function setupEnrollment(
  enroll: EnrollConfig,
  http: HttpConfig,
  fallbackVikunjaUrl: string | undefined,
): void {
  if (!enroll.enabled) {
    return;
  }
  const vault = getActiveVaultStore();
  if (!vault) {
    throw new ConfigurationError(
      'enroll.enabled',
      'SSO enrollment requires the oidc-http credential vault to be initialized first ' +
        '(setupOidcHttpAuth). This is a wiring bug or enrollment was enabled outside ' +
        'oidc-http mode.',
    );
  }
  const vikunjaUrl = enroll.vikunjaUrl ?? fallbackVikunjaUrl;
  if (!vikunjaUrl) {
    throw new ConfigurationError(
      'enroll.vikunjaUrl',
      'SSO enrollment needs a Vikunja API base URL. Set VIKUNJA_MCP_ENROLL_VIKUNJA_URL ' +
        'or the shared VIKUNJA_URL.',
    );
  }
  if (!http.publicUrl) {
    throw new ConfigurationError(
      'http.publicUrl',
      'SSO enrollment requires the canonical public MCP URL. Set ' +
        'VIKUNJA_MCP_HTTP_PUBLIC_URL (http.publicUrl) — enrollment links and the OAuth ' +
        'redirect_uri are built from it and must be browser-reachable and ' +
        'IdP-whitelisted, which a bind address never is.',
    );
  }
  const parsed = new URL(http.publicUrl);
  let basePath = parsed.pathname;
  if (basePath.endsWith(http.path)) {
    basePath = basePath.slice(0, basePath.length - http.path.length);
  }
  basePath = basePath.replace(/\/+$/, '');
  const publicBaseUrl = `${parsed.origin}${basePath}`;

  const service = new EnrollmentService({
    tickets: new EnrollmentTicketStore(enroll.ticketTtlSec * 1000),
    vault,
    vikunjaUrl,
    publicBaseUrl,
    providerName: enroll.provider,
    tokenExpiryDays: enroll.tokenExpiryDays,
  });
  setActiveEnrollmentService(service);
  logger.info('SSO enrollment enabled (one-click auto-provisioning)', {
    publicBaseUrl,
    provider: enroll.provider ?? '(auto)',
  });
}
