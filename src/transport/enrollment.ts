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
 *     `GET /enroll?ticket=...`.
 *  2. `GET /enroll` validates the ticket, discovers the Vikunja OpenID
 *     provider from Vikunja's unauthenticated `GET /info`
 *     (`auth.openid_connect.providers[]`: `key`, `auth_url` — the IdP's
 *     authorization endpoint — `client_id`, `scope`), and 302-redirects the
 *     browser to the IdP with Vikunja's OWN `client_id` (the ID token's
 *     audience is verified against it upstream), `redirect_uri =
 *     <publicOrigin>/enroll/callback`, and `state = <ticket>`.
 *  3. `GET /enroll/callback?code&state` consumes the ticket (single-use,
 *     CSRF-safe — the identity comes ONLY from the server-side ticket
 *     record, never from the browser), POSTs the code to Vikunja's native
 *     `POST /auth/openid/{key}/callback` with `{code, redirect_url, scope}`
 *     — Vikunja replays that `redirect_url` string verbatim as the OAuth
 *     `redirect_uri` in its own token exchange, so it must be byte-identical
 *     to step 2's — receives the user's (10-minute, 2.x) Vikunja JWT,
 *     enumerates `GET /routes`, mints a `tk_*` token via `PUT /tokens`
 *     (JWT-only upstream), vaults it under the identity, discards the JWT,
 *     and renders a minimal "connected" page.
 *
 * Both endpoints are unauthenticated at the HTTP layer by necessity (a
 * browser holds no MCP bearer token); the ticket IS the authentication.
 * Failure pages are generic — logged detail stays server-side, and neither
 * the JWT nor the minted token ever appears in a response body.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Identity } from '../context/requestContext';
import { EnrollmentTicketStore } from './enrollmentTickets';
import { resolveResourceUrl } from './resourceMetadata';
import { getActiveVaultStore } from '../storage/vaultFileStore';
import { ConfigurationError, type EnrollConfig, type HttpConfig } from '../config/types';
import { logger } from '../utils/logger';

/** Browser-facing paths served by {@link EnrollmentService.handleRequest}. */
export const ENROLL_PATH = '/enroll';
export const ENROLL_CALLBACK_PATH = '/enroll/callback';

/** Default OIDC scope when the provider config leaves it empty (Vikunja's own default). */
const DEFAULT_SCOPE = 'openid profile email';

/** The vault surface enrollment needs — `VaultFileStore.provision`'s shape. */
export interface EnrollmentVault {
  provision(identity: Identity, vikunjaUrl: string, apiToken: string): Promise<void>;
}

export interface EnrollmentServiceDeps {
  tickets: EnrollmentTicketStore;
  vault: EnrollmentVault;
  /** Vikunja API base URL (`.../api/v1`) the flow talks to. */
  vikunjaUrl: string;
  /**
   * Canonical public origin of THIS server (e.g. `https://mcp.example.ch`).
   * Both the enrollment URL and the OAuth `redirect_uri` are built from it —
   * one fixed value, so the authorize hop and the Vikunja callback replay
   * are byte-identical by construction.
   */
  publicOrigin: string;
  /** Vikunja OpenID provider `key`/`name` to use; optional when the backend has exactly one. */
  providerName?: string | undefined;
  /** Expiry of the auto-minted `tk_*` token, in days. */
  tokenExpiryDays: number;
  /** Injectable for tests; defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
}

/** One provider entry from Vikunja `GET /info` (`auth.openid_connect.providers[]`). */
interface VikunjaOpenIdProvider {
  name?: string;
  key?: string;
  auth_url?: string;
  client_id?: string;
  scope?: string;
}

interface VikunjaInfoAuth {
  auth?: {
    openid_connect?: {
      enabled?: boolean;
      providers?: VikunjaOpenIdProvider[] | null;
    };
  };
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
  if (res.headersSent) {
    return;
  }
  res.writeHead(statusCode, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': String(Buffer.byteLength(html)),
    'Cache-Control': 'no-store',
  });
  res.end(html);
}

export class EnrollmentService {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly deps: EnrollmentServiceDeps) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
  }

  /** The URL `vikunja_auth provision` hands an unprovisioned identity. */
  createEnrollmentUrl(identity: Identity): string {
    const ticket = this.deps.tickets.issue(identity);
    const url = new URL(ENROLL_PATH, this.deps.publicOrigin);
    url.searchParams.set('ticket', ticket);
    return url.toString();
  }

  /**
   * Serve `GET /enroll` / `GET /enroll/callback`. Returns `false` (writing
   * nothing) for any other path so the transport's routing falls through.
   */
  async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const rawUrl = req.url ?? '/';
    const url = new URL(rawUrl, this.deps.publicOrigin);
    if (url.pathname !== ENROLL_PATH && url.pathname !== ENROLL_CALLBACK_PATH) {
      return false;
    }
    if (req.method !== 'GET') {
      sendHtml(res, 405, renderPage('Method not allowed', 'Enrollment endpoints are GET-only.'));
      return true;
    }
    try {
      if (url.pathname === ENROLL_PATH) {
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
    const authorize = new URL(provider.auth_url as string);
    authorize.searchParams.set('response_type', 'code');
    authorize.searchParams.set('client_id', provider.client_id ?? '');
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

    // Single-use redemption; the identity comes ONLY from the server-side
    // ticket record (never from the browser request) — D7's identity rule.
    const identity = this.deps.tickets.consume(state);
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

  /** `<publicOrigin>/enroll/callback` — the one string used on BOTH hops. */
  private redirectUri(): string {
    return new URL(ENROLL_CALLBACK_PATH, this.deps.publicOrigin).toString();
  }

  private scopeOf(provider: VikunjaOpenIdProvider): string {
    return provider.scope !== undefined && provider.scope.trim().length > 0
      ? provider.scope
      : DEFAULT_SCOPE;
  }

  /**
   * Discover the enrollment provider from Vikunja's unauthenticated
   * `GET /info`. Every failure mode maps to a clean, generic 502 — the
   * backend's OpenID configuration is an operator concern, not the user's.
   */
  private async discoverProvider(): Promise<VikunjaOpenIdProvider> {
    let info: VikunjaInfoAuth;
    try {
      const res = await this.fetchImpl(`${this.deps.vikunjaUrl}/info`);
      if (!res.ok) {
        throw new Error(`GET /info responded ${res.status}`);
      }
      info = (await res.json()) as VikunjaInfoAuth;
    } catch (error) {
      logger.error('Enrollment: could not reach Vikunja /info', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw new EnrollmentFlowError(
        502,
        'The Vikunja server could not be reached. Please try again later.',
      );
    }

    const openid = info.auth?.openid_connect;
    const providers = (openid?.providers ?? []).filter(
      (p) => typeof p.auth_url === 'string' && p.auth_url.length > 0,
    );
    if (openid?.enabled !== true || providers.length === 0) {
      throw new EnrollmentFlowError(
        502,
        'The Vikunja server has no OpenID login provider configured, so one-click ' +
          'enrollment is unavailable. Link a token manually with vikunja_auth ' +
          'provision instead (see the setup docs).',
      );
    }

    const wanted = this.deps.providerName;
    if (wanted !== undefined) {
      const match = providers.find((p) => p.key === wanted || p.name === wanted);
      if (!match) {
        logger.error('Enrollment: configured provider not present on the backend', {
          wanted,
          available: providers.map((p) => p.key),
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
        available: providers.map((p) => p.key),
      });
      throw new EnrollmentFlowError(
        502,
        'The Vikunja server has several OpenID providers; the MCP operator must set ' +
          'VIKUNJA_MCP_ENROLL_PROVIDER to choose one.',
      );
    }
    return providers[0] as VikunjaOpenIdProvider;
  }

  /** `POST /auth/openid/{key}/callback` -> the user's Vikunja JWT. */
  private async exchangeCodeForJwt(provider: VikunjaOpenIdProvider, code: string): Promise<string> {
    const key = provider.key ?? '';
    let response: Response;
    try {
      response = await this.fetchImpl(
        `${this.deps.vikunjaUrl}/auth/openid/${encodeURIComponent(key)}/callback`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            code,
            redirect_url: this.redirectUri(),
            scope: this.scopeOf(provider),
          }),
        },
      );
    } catch (error) {
      logger.error('Enrollment: Vikunja openid callback unreachable', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw new EnrollmentFlowError(
        502,
        'The Vikunja server could not be reached to complete the login.',
      );
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      logger.error('Enrollment: Vikunja rejected the openid callback', {
        status: response.status,
        detail: detail.slice(0, 500),
      });
      throw new EnrollmentFlowError(
        502,
        'Vikunja did not accept the login. Please return to your chat and try again.',
      );
    }
    const body = (await response.json().catch(() => ({}))) as { token?: unknown };
    if (typeof body.token !== 'string' || body.token.length === 0) {
      logger.error('Enrollment: Vikunja openid callback returned no token');
      throw new EnrollmentFlowError(502, 'Vikunja did not return a login token.');
    }
    return body.token;
  }

  /**
   * Enumerate `GET /routes` and mint a full-permission `tk_*` token via
   * `PUT /tokens` (both JWT-authenticated; `PUT /tokens` is JWT-only
   * upstream). Vikunja has no wildcard permission — "everything" is the
   * complete routes map, exactly how the e2e bootstrap mints its token.
   */
  private async mintApiToken(jwt: string): Promise<string> {
    const authHeaders = { Authorization: `Bearer ${jwt}` };

    let routesResponse: Response;
    try {
      routesResponse = await this.fetchImpl(`${this.deps.vikunjaUrl}/routes`, {
        headers: authHeaders,
      });
    } catch (error) {
      logger.error('Enrollment: GET /routes unreachable', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw new EnrollmentFlowError(502, 'Vikunja could not be reached to create your token.');
    }
    if (!routesResponse.ok) {
      logger.error('Enrollment: GET /routes failed', { status: routesResponse.status });
      throw new EnrollmentFlowError(502, 'Vikunja refused to enumerate token permissions.');
    }
    const routes = (await routesResponse.json().catch(() => ({}))) as Record<
      string,
      Record<string, unknown>
    >;
    const permissions: Record<string, string[]> = {};
    for (const [group, verbs] of Object.entries(routes)) {
      permissions[group] = Object.keys(verbs);
    }

    const expiresAt = new Date(
      Date.now() + this.deps.tokenExpiryDays * 24 * 3600 * 1000,
    ).toISOString();
    let mintResponse: Response;
    try {
      mintResponse = await this.fetchImpl(`${this.deps.vikunjaUrl}/tokens`, {
        method: 'PUT',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: `vikunja-mcp enrollment ${new Date().toISOString().slice(0, 10)}`,
          permissions,
          expires_at: expiresAt,
        }),
      });
    } catch (error) {
      logger.error('Enrollment: PUT /tokens unreachable', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw new EnrollmentFlowError(502, 'Vikunja could not be reached to create your token.');
    }
    // The OpenAPI spec documents 200; the real server responds 201. Accept both.
    if (mintResponse.status !== 200 && mintResponse.status !== 201) {
      const detail = await mintResponse.text().catch(() => '');
      logger.error('Enrollment: PUT /tokens failed', {
        status: mintResponse.status,
        detail: detail.slice(0, 500),
      });
      throw new EnrollmentFlowError(502, 'Vikunja refused to create an API token.');
    }
    const minted = (await mintResponse.json().catch(() => ({}))) as { token?: unknown };
    if (typeof minted.token !== 'string' || minted.token.length === 0) {
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
 * without a vault or without a resolvable Vikunja URL — a deployment that
 * advertises one-click enrollment but cannot complete it must not start.
 *
 * The public origin for enrollment URLs and the OAuth `redirect_uri` is
 * resolved ONCE here from `http.publicUrl` (recommended behind a gateway)
 * or the bind address — a single fixed value keeps the authorize hop's
 * `redirect_uri` and the Vikunja callback's `redirect_url` byte-identical
 * by construction (Vikunja replays the latter in its IdP token exchange).
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
  const publicOrigin = new URL(resolveResourceUrl(http)).origin;
  const service = new EnrollmentService({
    tickets: new EnrollmentTicketStore(enroll.ticketTtlSec * 1000),
    vault,
    vikunjaUrl,
    publicOrigin,
    providerName: enroll.provider,
    tokenExpiryDays: enroll.tokenExpiryDays,
  });
  setActiveEnrollmentService(service);
  logger.info('SSO enrollment enabled (one-click auto-provisioning)', {
    publicOrigin,
    provider: enroll.provider ?? '(auto)',
  });
}
