#!/usr/bin/env npx tsx
/**
 * OIDC `oidc-http` transport-mode e2e lane (item H2b, docs/OIDC-RESOURCE-SERVER.md).
 *
 * Sibling to `scripts/mcp-e2e.ts` (which drives the `stdio` transport over a
 * real MCP `Client`). This script instead:
 *
 *   1. Builds the project (`npm run build`).
 *   2. Starts an in-process, loopback-only **mock OIDC issuer**: a real RSA
 *      keypair + a tiny HTTP server serving its JWKS document (reusing the
 *      exact same signing/JWKS helpers the unit/integration test suites use
 *      — `tests/auth/oidc/helpers.ts` — per design decision D9, "e2e identity
 *      provider = mock OIDC issuer as the CI default").
 *   3. Spawns `dist/index.js` as a REAL child process in `oidc-http` mode
 *      (`VIKUNJA_MCP_TRANSPORT=http`), configured to validate bearer tokens
 *      against that mock issuer, with a fresh, temporary, real (AES-256-GCM)
 *      credential vault file — and pointed at the REAL local Vikunja stack
 *      (`docker/e2e`, `npm run e2e:up`) for actual Vikunja credentials, the
 *      same way `docker/e2e/bootstrap.sh` obtains one.
 *   4. Drives the spawned server with real HTTP requests (JSON-RPC over the
 *      Streamable HTTP transport) exercising the full provisioning lifecycle:
 *        (a) unauthenticated request -> 401
 *        (b) authenticated, unprovisioned identity -> structured
 *            AUTH_REQUIRED "provision" prompt
 *        (c) `vikunja_auth provision` with the stack's real test token
 *        (d) a REAL end-to-end tool call (`vikunja_projects list`) as the
 *            now-provisioned identity, hitting the real local Vikunja
 *        (e) `vikunja_auth deprovision`, then re-checking status confirms
 *            the identity is unprovisioned again
 *
 * Requires the local e2e stack running (`VIKUNJA_VERSION=2.4.0 npm run
 * e2e:up`) — see docs/LOCAL-TESTING.md. Nothing here touches the network
 * beyond 127.0.0.1: the mock issuer, the spawned server, and the target
 * Vikunja stack are all loopback-only.
 *
 * Usage:
 *   npx tsx scripts/oidc-e2e.ts
 *   npm run test:e2e:oidc   (see package.json)
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  generateTestKey,
  signTestToken,
  startMockJwksServer,
  type MockJwksServer,
  type TestKey,
} from '../tests/auth/oidc/helpers';
import { startMockOidcIdp, type MockOidcIdp } from './lib/mock-oidc-idp';
import { resolveTarget } from './lib/e2e-target';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const DIST_ENTRY = path.join(REPO_ROOT, 'dist', 'index.js');
const BOOTSTRAP = path.join(REPO_ROOT, 'docker', 'e2e', 'bootstrap.sh');

// Deliberately NOT `process.env.VIKUNJA_URL` — same safety rationale as
// scripts/mcp-e2e.ts: never silently point a data-mutating harness at a
// developer's real, ambient Vikunja instance. The fallback asks the target
// resolver (issue #205's single source of truth) for the standard target's
// localhost URL instead of hardcoding a stale port.
const E2E_TARGET = resolveTarget(process.env.VIKUNJA_E2E_TARGET || undefined);
const VIKUNJA_URL = process.env.MCP_E2E_VIKUNJA_URL || E2E_TARGET.apiUrl;

// One-click SSO enrollment lane (issue #220). Default ON; export
// MCP_E2E_SKIP_ENROLL=1 to run only the classic provisioning steps (e.g. on
// a machine where docker compose is unavailable mid-run). The client
// id/secret constants mirror docker/e2e/docker-compose.oidc.yml.
const RUN_ENROLLMENT = process.env.MCP_E2E_SKIP_ENROLL !== '1';
const OIDC_IDP_PORT = E2E_TARGET.port + 4000;
const TEST_USERNAME = 'e2e-test';
const TEST_PASSWORD = 'VikunjaMcpE2E-2026!';
const TOKEN_TITLE = 'vikunja-mcp-oidc-e2e-harness';

const ISSUER = 'https://idp.example.test/realms/oidc-e2e';
const AUDIENCE = 'vikunja-mcp-ng';

function assertLocalUrl(url: string): void {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    throw new Error(`MCP_E2E_VIKUNJA_URL is not a valid URL: ${url}`);
  }
  if (host !== 'localhost' && host !== '127.0.0.1' && host !== '::1') {
    throw new Error(
      `Refusing to run: target host "${host}" (from ${url}) is not localhost/127.0.0.1. ` +
        'This harness must only ever run against the disposable local e2e stack (npm run e2e:up).',
    );
  }
}

let failures = 0;
function log(msg: string): void {
  // eslint-disable-next-line no-console
  console.log(`[oidc-e2e] ${msg}`);
}
function pass(name: string): void {
  log(`PASS - ${name}`);
}
function fail(name: string, detail: string): void {
  failures += 1;
  log(`FAIL - ${name}: ${detail}`);
}
async function step(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    pass(name);
  } catch (error) {
    fail(name, error instanceof Error ? error.message : String(error));
  }
}

// ----------------------------------------------------------------------------
// Real Vikunja credentials (same login + PUT /tokens flow as
// docker/e2e/bootstrap.sh and scripts/mcp-e2e.ts)
// ----------------------------------------------------------------------------

async function login(): Promise<string> {
  const res = await fetch(`${VIKUNJA_URL}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: TEST_USERNAME, password: TEST_PASSWORD }),
  });
  if (!res.ok) {
    throw new Error(
      `POST /login failed: ${res.status} ${await res.text()} -- is the e2e stack up? Run 'npm run e2e:up'.`,
    );
  }
  const body = (await res.json()) as { token: string };
  return body.token;
}

async function mintApiToken(jwt: string): Promise<string | null> {
  const routesRes = await fetch(`${VIKUNJA_URL}/routes`, {
    headers: { Authorization: `Bearer ${jwt}` },
  });
  if (!routesRes.ok) {
    return null;
  }
  const routes = (await routesRes.json()) as Record<string, Record<string, unknown>>;
  const permissions: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(routes)) {
    permissions[key] = Object.keys(value);
  }
  const expiresAt = new Date(Date.now() + 10 * 365 * 24 * 3600 * 1000).toISOString();
  const res = await fetch(`${VIKUNJA_URL}/tokens`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: TOKEN_TITLE, permissions, expires_at: expiresAt }),
  });
  if (res.status !== 200 && res.status !== 201) {
    return null;
  }
  const body = (await res.json()) as { token: string | null };
  return body.token ?? null;
}

async function getRealVikunjaApiToken(): Promise<string> {
  if (process.env.MCP_E2E_VIKUNJA_API_TOKEN) {
    log('Using MCP_E2E_VIKUNJA_API_TOKEN from the environment.');
    return process.env.MCP_E2E_VIKUNJA_API_TOKEN;
  }
  log(`Logging in to the real local Vikunja stack as '${TEST_USERNAME}'...`);
  const jwt = await login();
  const token = await mintApiToken(jwt);
  if (token) {
    log('Obtained a real tk_* API token from the local stack.');
    return token;
  }
  log('Falling back to the JWT itself as the real Vikunja credential.');
  return jwt;
}

// ----------------------------------------------------------------------------
// Minimal JSON-RPC-over-Streamable-HTTP client (mirrors
// tests/oidc/http-e2e.test.ts's proven raw-request approach — stateless mode
// needs no session/initialize continuity between calls).
// ----------------------------------------------------------------------------

interface RpcToolResult {
  statusCode: number;
  isError?: boolean;
  text: string;
}

async function callTool(
  port: number,
  id: number,
  name: string,
  args: Record<string, unknown>,
  token: string | undefined,
): Promise<RpcToolResult> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };
  if (token !== undefined) {
    headers.Authorization = `Bearer ${token}`;
  }
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  });
  const statusCode = res.status;
  const contentType = res.headers.get('content-type') ?? '';
  const bodyText = await res.text();

  if (statusCode >= 400) {
    return { statusCode, text: bodyText };
  }

  let messages: Array<{ result?: { isError?: boolean; content?: Array<{ text?: string }> } }>;
  if (contentType.includes('text/event-stream')) {
    messages = bodyText
      .split('\n')
      .filter(line => line.startsWith('data:'))
      .map(line => JSON.parse(line.slice('data:'.length).trim()));
  } else if (bodyText.trim().length === 0) {
    messages = [];
  } else {
    messages = [JSON.parse(bodyText)];
  }
  const withResult = messages.find(m => m.result !== undefined);
  if (!withResult?.result) {
    return { statusCode, text: bodyText };
  }
  const text = withResult.result.content?.map(c => c.text ?? '').join('\n') ?? '';
  return { statusCode, isError: withResult.result.isError, text };
}

async function waitForHealthz(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (res.ok) {
        return;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(
    `Server did not become healthy within ${timeoutMs}ms: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}

// ----------------------------------------------------------------------------
// Enrollment-lane plumbing (issue #220)
// ----------------------------------------------------------------------------

/**
 * (Re)runs docker/e2e/bootstrap.sh for the resolved target, with or without
 * the OpenID overlay (docker-compose.oidc.yml). The overlay recreates the
 * Vikunja container with one provider pointing at the harness's mock IdP;
 * running WITHOUT the flag afterwards restores the plain container so other
 * lanes never depend on an issuer that no longer exists.
 */
function runBootstrap(withOidcOverlay: boolean): void {
  log(
    withOidcOverlay
      ? 'Reconfiguring the e2e stack WITH the OpenID overlay (mock IdP provider)...'
      : 'Restoring the e2e stack to its plain (no-OpenID) configuration...',
  );
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    VIKUNJA_E2E_TARGET: E2E_TARGET.id,
    E2E_OIDC_IDP_PORT: String(OIDC_IDP_PORT),
  };
  if (withOidcOverlay) {
    env.VIKUNJA_E2E_OIDC = '1';
  } else {
    delete env.VIKUNJA_E2E_OIDC;
  }
  const result = spawnSync(BOOTSTRAP, [], { cwd: REPO_ROOT, env, stdio: 'inherit' });
  if (result.status !== 0) {
    throw new Error(
      `docker/e2e/bootstrap.sh exited ${result.status} (oidc overlay: ${withOidcOverlay})`,
    );
  }
}

/** Fetch helper that follows exactly one manual redirect hop and returns it. */
async function expectRedirect(url: string): Promise<string> {
  const res = await fetch(url, { redirect: 'manual' });
  if (res.status !== 302) {
    throw new Error(`expected 302 from ${url}, got ${res.status}: ${await res.text()}`);
  }
  const location = res.headers.get('location');
  if (!location) {
    throw new Error(`302 from ${url} had no Location header`);
  }
  return location;
}

/**
 * The mock IdP is configured into Vikunja as `host.docker.internal` (what the
 * CONTAINER resolves); the harness on the host reaches the same server on
 * 127.0.0.1. A real browser would resolve one public hostname for both — this
 * rewrite is the harness's stand-in for that hop.
 */
function toHostLocal(idpUrl: string): string {
  const url = new URL(idpUrl);
  url.hostname = '127.0.0.1';
  return url.toString();
}

// ----------------------------------------------------------------------------
// Main
// ----------------------------------------------------------------------------

async function main(): Promise<void> {
  assertLocalUrl(VIKUNJA_URL);

  log('Building the project (npm run build)...');
  const build = spawnSync('npm', ['run', 'build'], { cwd: REPO_ROOT, stdio: 'inherit' });
  if (build.status !== 0) {
    throw new Error('Build failed; aborting oidc-e2e run.');
  }

  // Enrollment lane setup happens BEFORE any Vikunja call: the overlay
  // recreates the Vikunja container, and its OpenID provider init needs the
  // mock IdP to already be answering discovery when first exercised.
  let idp: MockOidcIdp | undefined;
  const carolSub = `oidc-e2e-carol-${Date.now()}`;
  if (RUN_ENROLLMENT) {
    log(`Starting the mock OIDC IdP on 0.0.0.0:${OIDC_IDP_PORT} (issuer host.docker.internal)...`);
    idp = await startMockOidcIdp({
      port: OIDC_IDP_PORT,
      issuerHost: 'host.docker.internal',
      clientId: 'vikunja-e2e',
      clientSecret: 'vikunja-e2e-oidc-secret',
      user: {
        sub: carolSub,
        email: `${carolSub}@e2e.local`,
        name: 'Carol Enrollment',
        preferredUsername: carolSub,
      },
    });
    runBootstrap(true);
  }

  const realApiToken = await getRealVikunjaApiToken();

  log('Starting the in-process mock OIDC issuer (RSA keypair + loopback JWKS server)...');
  const key: TestKey = await generateTestKey('oidc-e2e-key-1');
  const jwks: MockJwksServer = await startMockJwksServer([key.jwk]);

  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vikunja-oidc-e2e-vault-'));
  const vaultPath = path.join(vaultDir, 'vault.json');
  const vaultKey = crypto.randomBytes(32).toString('hex');
  const port = 8877 + Math.floor(Math.random() * 500);

  log(`Spawning dist/index.js in oidc-http mode on 127.0.0.1:${port}...`);
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  delete childEnv.VIKUNJA_API_TOKEN;
  delete childEnv.VIKUNJA_API_TOKEN_FILE;
  Object.assign(childEnv, {
    VIKUNJA_URL,
    VIKUNJA_MCP_TRANSPORT: 'http',
    VIKUNJA_MCP_HTTP_HOST: '127.0.0.1',
    VIKUNJA_MCP_HTTP_PORT: String(port),
    VIKUNJA_MCP_HTTP_PATH: '/mcp',
    VIKUNJA_MCP_OIDC_ISSUER: ISSUER,
    VIKUNJA_MCP_OIDC_AUDIENCE: AUDIENCE,
    VIKUNJA_MCP_OIDC_JWKS_URI: jwks.url,
    VIKUNJA_MCP_VAULT_PATH: vaultPath,
    VIKUNJA_MCP_VAULT_KEY: vaultKey,
  });
  if (RUN_ENROLLMENT) {
    // One-click SSO enrollment (issue #220): the /enroll endpoints + the
    // provision-without-token path. Provider selection is left on auto —
    // the overlay configures exactly one.
    childEnv.VIKUNJA_MCP_ENROLL_ENABLED = 'true';
  }

  let child: ChildProcess | undefined;
  try {
    child = spawn('node', [DIST_ENTRY], { cwd: REPO_ROOT, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    const serverLogs: string[] = [];
    child.stdout?.on('data', d => serverLogs.push(String(d)));
    child.stderr?.on('data', d => serverLogs.push(String(d)));

    await waitForHealthz(port, 15_000);
    log('Server is healthy.');

    const aliceSub = `oidc-e2e-alice-${Date.now()}`;
    const aliceToken = await signTestToken(key.privateKey, {
      kid: key.kid,
      issuer: ISSUER,
      audience: AUDIENCE,
      sub: aliceSub,
    });

    await step('(a0) RFC 9728 protected-resource metadata is discoverable unauthenticated', async () => {
      // Both the bare well-known path and the path-suffixed variant a
      // path-aware client uses for a resource at /mcp.
      for (const wellKnownPath of [
        '/.well-known/oauth-protected-resource',
        '/.well-known/oauth-protected-resource/mcp',
      ]) {
        const res = await fetch(`http://127.0.0.1:${port}${wellKnownPath}`);
        if (res.status !== 200) {
          throw new Error(`GET ${wellKnownPath} expected 200, got ${res.status}`);
        }
        const doc = (await res.json()) as {
          resource?: string;
          authorization_servers?: string[];
          bearer_methods_supported?: string[];
        };
        if (doc.authorization_servers?.[0] !== ISSUER) {
          throw new Error(
            `${wellKnownPath}: authorization_servers should be ["${ISSUER}"], got ${JSON.stringify(doc.authorization_servers)}`,
          );
        }
        if (doc.resource !== `http://127.0.0.1:${port}/mcp`) {
          throw new Error(`${wellKnownPath}: unexpected resource ${JSON.stringify(doc.resource)}`);
        }
        if (!doc.bearer_methods_supported?.includes('header')) {
          throw new Error(
            `${wellKnownPath}: bearer_methods_supported should include "header", got ${JSON.stringify(doc.bearer_methods_supported)}`,
          );
        }
      }
    });

    await step('(a) unauthenticated request is rejected with 401', async () => {
      const result = await callTool(port, 1, 'vikunja_auth', { subcommand: 'status' }, undefined);
      if (result.statusCode !== 401) {
        throw new Error(`expected 401, got ${result.statusCode}: ${result.text}`);
      }
    });

    await step('(a2) the 401 challenge advertises resource_metadata (RFC 9728 §5.1)', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 100, method: 'tools/call', params: {} }),
      });
      if (res.status !== 401) {
        throw new Error(`expected 401, got ${res.status}`);
      }
      const challenge = res.headers.get('www-authenticate') ?? '';
      const expected = `resource_metadata="http://127.0.0.1:${port}/.well-known/oauth-protected-resource"`;
      if (!challenge.includes(expected)) {
        throw new Error(`WWW-Authenticate missing ${expected}; got: ${challenge}`);
      }
    });

    await step('(b) authenticated but unprovisioned identity gets the provision prompt', async () => {
      const result = await callTool(port, 2, 'vikunja_auth', { subcommand: 'status' }, aliceToken);
      if (result.statusCode !== 200) {
        throw new Error(`expected 200 (auth ok, tool reports unlinked), got ${result.statusCode}`);
      }
      if (!result.text.includes('No Vikunja API token linked yet')) {
        throw new Error(`expected an unlinked status, got: ${result.text}`);
      }
    });

    await step('(c) vikunja_auth provision links the real local-stack token', async () => {
      const result = await callTool(
        port,
        3,
        'vikunja_auth',
        { subcommand: 'provision', apiToken: realApiToken },
        aliceToken,
      );
      if (result.statusCode !== 200 || result.isError) {
        throw new Error(`provision failed: HTTP ${result.statusCode}, isError=${result.isError}: ${result.text}`);
      }
      if (!result.text.includes('linked')) {
        throw new Error(`expected a "linked" confirmation, got: ${result.text}`);
      }
      if (result.text.includes(realApiToken)) {
        throw new Error('provision response echoed the raw token — must be masked');
      }
    });

    // FIXED (integration, 2026-07-21) — this step is the payoff of the
    // credential-threading fix (docs/OIDC-RESOURCE-SERVER.md §3d row #1). The
    // bug this lane originally surfaced: tool handlers captured the CLOSURE
    // `AuthManager` at `registerTools()` time and passed it straight into
    // `vikunjaRestRequest()`, so a provisioned identity's real tool calls used
    // the process-global manager, not their own vaulted credential. The fix
    // resolves the EFFECTIVE auth manager centrally in
    // `src/utils/vikunja-rest.ts` (`resolveEffectiveAuthManager`): when an ALS
    // RequestContext is bound, its per-identity manager wins. So this call now
    // hits the real local Vikunja under Alice's OWN vaulted token and
    // succeeds. Guarded end-to-end by tests/oidc/isolation.test.ts's
    // "Credential threading" class (which drives a real registered tool and
    // asserts the Authorization header on the wire).
    await step('(d) real end-to-end tool call as the provisioned identity (list projects)', async () => {
      const result = await callTool(port, 4, 'vikunja_projects', { subcommand: 'list' }, aliceToken);
      if (result.statusCode !== 200 || result.isError) {
        throw new Error(`list projects failed: HTTP ${result.statusCode}, isError=${result.isError}: ${result.text}`);
      }
    });

    // (d2) A separate residual bug from the same isolation-table rows #3/#4:
    // `getSessionStorage()` in tasks/index.ts and templates.ts (and
    // `downloadAttachment()` in tasks/attachments.ts) called
    // `authManager.getSession()` directly on the closure-captured manager —
    // never authenticated in oidc-http mode — instead of resolving the
    // ALS-bound one, so these specific subcommands threw AUTH_REQUIRED for a
    // fully provisioned identity even though (d) above already worked (list
    // projects doesn't touch session storage). Fixed by threading the same
    // `hasRequestContext() ? await getAuthManagerFromContext() : authManager`
    // resolution into those three functions. Guarded by
    // tests/oidc/isolation.test.ts's "Session-storage reads that bypass ALS
    // resolution" class; exercised live here against the real local stack.
    await step('(d2) vikunja_tasks list — previously broken (session-storage path)', async () => {
      const result = await callTool(port, 7, 'vikunja_tasks', { subcommand: 'list' }, aliceToken);
      if (result.statusCode !== 200 || result.isError) {
        throw new Error(`tasks list failed: HTTP ${result.statusCode}, isError=${result.isError}: ${result.text}`);
      }
    });

    await step('(d3) vikunja_templates list — previously broken (session-storage path)', async () => {
      const result = await callTool(port, 8, 'vikunja_templates', { subcommand: 'list' }, aliceToken);
      if (result.statusCode !== 200 || result.isError) {
        throw new Error(`templates list failed: HTTP ${result.statusCode}, isError=${result.isError}: ${result.text}`);
      }
    });

    // (d4) A second, concurrently-authenticated identity — proving the fix
    // holds under genuinely concurrent real HTTP requests through the real
    // spawned server, not just sequential calls. Bob provisions with the
    // SAME underlying real Vikunja token as Alice (this local stack only
    // seeds one test account) — this step is NOT re-proving Vikunja-side
    // credential distinctness (tests/oidc/isolation.test.ts's "Credential
    // threading" class already proves that precisely, with two distinct
    // mocked tokens and Authorization-header assertions); it's proving that
    // two different OIDC identities hitting the real server at the same time
    // don't error out or bleed ALS context into each other at the ledger
    // this script can observe: real HTTP status codes.
    await step('(d4) a second identity, provisioned concurrently, calls tools at the same time as Alice', async () => {
      const bobSub = `oidc-e2e-bob-${Date.now()}`;
      const bobToken = await signTestToken(key.privateKey, {
        kid: key.kid,
        issuer: ISSUER,
        audience: AUDIENCE,
        sub: bobSub,
      });

      // Provision must complete before Bob's own tool calls can succeed —
      // this is a real precondition (a user always links their token before
      // using it), not an artifact of the test. Only the calls that are
      // genuinely independent of each other run concurrently below.
      const bobProvision = await callTool(
        port,
        9,
        'vikunja_auth',
        { subcommand: 'provision', apiToken: realApiToken },
        bobToken,
      );
      if (bobProvision.statusCode !== 200 || bobProvision.isError) {
        throw new Error(
          `bob provision failed: HTTP ${bobProvision.statusCode}, isError=${bobProvision.isError}: ${bobProvision.text}`,
        );
      }

      const [aliceList, bobList, aliceTemplates, bobTemplates] = await Promise.all([
        callTool(port, 10, 'vikunja_tasks', { subcommand: 'list' }, aliceToken),
        callTool(port, 11, 'vikunja_tasks', { subcommand: 'list' }, bobToken),
        callTool(port, 12, 'vikunja_templates', { subcommand: 'list' }, aliceToken),
        callTool(port, 13, 'vikunja_templates', { subcommand: 'list' }, bobToken),
      ]);

      for (const [label, result] of [
        ['alice tasks list', aliceList],
        ['bob tasks list', bobList],
        ['alice templates list', aliceTemplates],
        ['bob templates list', bobTemplates],
      ] as const) {
        if (result.statusCode !== 200 || result.isError) {
          throw new Error(
            `${label} failed under concurrent load: HTTP ${result.statusCode}, isError=${result.isError}: ${result.text}`,
          );
        }
      }
    });

    // ---- One-click SSO enrollment lane (issue #220) --------------------
    // The chain proven here runs against the REAL local Vikunja 2.4.0: MCP
    // /enroll -> mock-IdP authorize (scripted browser hop) -> MCP
    // /enroll/callback -> Vikunja POST /auth/openid/{key}/callback (real
    // token exchange with the mock IdP, real first-login account
    // auto-creation) -> real GET /routes -> real PUT /tokens -> vault.
    if (RUN_ENROLLMENT) {
      const carolToken = await signTestToken(key.privateKey, {
        kid: key.kid,
        issuer: ISSUER,
        audience: AUDIENCE,
        sub: carolSub,
      });
      let enrollmentUrl = '';
      let callbackUrl = '';

      await step('(f0) the reconfigured Vikunja advertises the mock OpenID provider on /info', async () => {
        const res = await fetch(`${VIKUNJA_URL}/info`);
        const info = (await res.json()) as {
          auth?: { openid_connect?: { enabled?: boolean; providers?: Array<{ key?: string }> | null } };
        };
        const openid = info.auth?.openid_connect;
        if (openid?.enabled !== true || !openid.providers?.length) {
          throw new Error(`Vikunja /info has no OpenID provider: ${JSON.stringify(openid)}`);
        }
      });

      await step('(f1) provision WITHOUT a token returns a one-click enrollment URL', async () => {
        const result = await callTool(port, 20, 'vikunja_auth', { subcommand: 'provision' }, carolToken);
        if (result.statusCode !== 200 || result.isError) {
          throw new Error(`expected an enrollment URL, got HTTP ${result.statusCode}, isError=${result.isError}: ${result.text}`);
        }
        const match = result.text.match(/https?:\/\/[^\s"'\\)\]]+\/enroll\?ticket=[A-Za-z0-9_-]+/);
        if (!match) {
          throw new Error(`no enrollment URL in the provision response: ${result.text}`);
        }
        enrollmentUrl = match[0];
      });

      await step('(f2) GET /enroll redirects to the IdP authorize endpoint (state = ticket)', async () => {
        const location = await expectRedirect(enrollmentUrl);
        const authorize = new URL(location);
        if (!authorize.host.startsWith('host.docker.internal')) {
          throw new Error(`authorize URL not on the configured provider: ${location}`);
        }
        if (authorize.searchParams.get('client_id') !== 'vikunja-e2e') {
          throw new Error(`authorize URL must carry Vikunja's client_id: ${location}`);
        }
        const expectedState = new URL(enrollmentUrl).searchParams.get('ticket');
        if (authorize.searchParams.get('state') !== expectedState) {
          throw new Error('authorize state does not match the enrollment ticket');
        }
        // The scripted stand-in for the browser's IdP hop (SSO session ->
        // zero-interaction code issuance).
        callbackUrl = await expectRedirect(toHostLocal(location));
        if (!callbackUrl.includes('/enroll/callback?')) {
          throw new Error(`IdP did not redirect back to the enrollment callback: ${callbackUrl}`);
        }
      });

      await step('(f3) the callback completes the real Vikunja chain and renders the connected page', async () => {
        const res = await fetch(callbackUrl);
        const body = await res.text();
        if (res.status !== 200 || !/connected/i.test(body)) {
          throw new Error(`callback failed: HTTP ${res.status}: ${body.slice(0, 400)}`);
        }
        if (/tk_[0-9a-f]{10,}/.test(body)) {
          throw new Error('the connected page leaked a token');
        }
      });

      await step('(f4) the enrolled identity is provisioned and its auto-created account works end-to-end', async () => {
        const status = await callTool(port, 21, 'vikunja_auth', { subcommand: 'status' }, carolToken);
        if (!status.text.includes('Vikunja API token linked')) {
          throw new Error(`expected a linked status after enrollment, got: ${status.text}`);
        }
        const projects = await callTool(port, 22, 'vikunja_projects', { subcommand: 'list' }, carolToken);
        if (projects.statusCode !== 200 || projects.isError) {
          throw new Error(`projects list as the enrolled user failed: HTTP ${projects.statusCode}: ${projects.text}`);
        }
        const tasks = await callTool(port, 23, 'vikunja_tasks', { subcommand: 'list' }, carolToken);
        if (tasks.statusCode !== 200 || tasks.isError) {
          throw new Error(`tasks list as the enrolled user failed: HTTP ${tasks.statusCode}: ${tasks.text}`);
        }
      });

      await step('(f5) a replayed enrollment callback is rejected (single-use ticket)', async () => {
        const res = await fetch(callbackUrl);
        if (res.status !== 400) {
          throw new Error(`expected 400 on replay, got ${res.status}`);
        }
      });
    }

    await step('(e) vikunja_auth deprovision unlinks the identity', async () => {
      const result = await callTool(port, 5, 'vikunja_auth', { subcommand: 'deprovision' }, aliceToken);
      if (result.statusCode !== 200 || result.isError) {
        throw new Error(`deprovision failed: HTTP ${result.statusCode}: ${result.text}`);
      }
      const statusResult = await callTool(port, 6, 'vikunja_auth', { subcommand: 'status' }, aliceToken);
      if (!statusResult.text.includes('No Vikunja API token linked yet')) {
        throw new Error(`expected unlinked status after deprovision, got: ${statusResult.text}`);
      }
    });

    if (failures > 0) {
      log('---- spawned server logs (for debugging failures) ----');
      // eslint-disable-next-line no-console
      console.log(serverLogs.join(''));
    }
  } finally {
    if (child && !child.killed) {
      child.kill('SIGTERM');
    }
    await jwks.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
    if (idp) {
      // Restore the plain stack FIRST (the container is recreated without the
      // OpenID provider), then stop the issuer it pointed at — other lanes
      // must never see a provider whose IdP is gone.
      try {
        runBootstrap(false);
      } catch (error) {
        log(`WARNING: failed to restore the plain e2e stack: ${String(error)}`);
        failures += 1;
      }
      await idp.close();
    }
  }

  log(`Done. ${failures === 0 ? 'All steps passed.' : `${failures} step(s) FAILED.`}`);
  if (failures > 0) {
    process.exitCode = 1;
  }
}

main().catch(error => {
  // eslint-disable-next-line no-console
  console.error('[oidc-e2e] Unhandled error:', error);
  process.exitCode = 1;
});
