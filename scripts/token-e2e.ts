#!/usr/bin/env npx tsx
/**
 * gateway-token HTTP auth mode e2e lane (docs/GATEWAY-TOKEN-MODE.md §7.3).
 *
 * Sibling to `scripts/oidc-e2e.ts`. This script:
 *
 *   1. Builds the project (`npm run build`).
 *   2. Gets a real Vikunja API token from the local e2e stack (same login +
 *      PUT /tokens flow as `docker/e2e/bootstrap.sh`).
 *   3. Spawns `dist/index.js` as a REAL child process with
 *      `VIKUNJA_MCP_TRANSPORT=http`, `VIKUNJA_MCP_HTTP_AUTH_MODE=token`, a
 *      freshly generated gateway token, a loopback bind, and
 *      `VIKUNJA_URL`/`VIKUNJA_API_TOKEN` pointing at the local stack.
 *   4. Drives it over real HTTP: 401s, initialize, tools/list, a real
 *      `vikunja_projects list`, the token-mode `vikunja_auth status`
 *      explanation, health/readiness, the absent OIDC endpoints, the Host
 *      allow-list, the body cap, and a clean SIGTERM shutdown.
 *
 * Requires the local e2e stack (`npm run e2e:up`, docs/LOCAL-TESTING.md).
 * Everything is loopback-only; nothing here may touch a real Vikunja.
 *
 * Usage:
 *   npm run test:e2e:token
 *   VIKUNJA_E2E_TARGET=2.4.0-postgres npm run test:e2e:token
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as http from 'node:http';
import * as net from 'node:net';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveTarget } from './lib/e2e-target';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const DIST_ENTRY = path.join(REPO_ROOT, 'dist', 'index.js');

// Deliberately NOT `process.env.VIKUNJA_URL`: never point this harness at an
// ambient, real Vikunja instance (same rationale as scripts/mcp-e2e.ts).
const E2E_TARGET = resolveTarget(process.env.VIKUNJA_E2E_TARGET || undefined);
const VIKUNJA_URL = process.env.MCP_E2E_VIKUNJA_URL || E2E_TARGET.apiUrl;
const TEST_USERNAME = 'e2e-test';
const TEST_PASSWORD = 'VikunjaMcpE2E-2026!';
const TOKEN_TITLE = 'vikunja-mcp-token-e2e-harness';
const BODY_CAP = 1048576;

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
  console.log(`[token-e2e] ${msg}`);
}
async function step(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    log(`PASS - ${name}`);
  } catch (error) {
    failures += 1;
    log(`FAIL - ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// ----------------------------------------------------------------------------
// Real Vikunja credential (login + PUT /tokens, as docker/e2e/bootstrap.sh)
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
  return ((await res.json()) as { token: string }).token;
}

async function mintApiToken(jwt: string): Promise<string> {
  const routesRes = await fetch(`${VIKUNJA_URL}/routes`, {
    headers: { Authorization: `Bearer ${jwt}` },
  });
  if (!routesRes.ok) {
    throw new Error(`GET /routes failed: ${routesRes.status}`);
  }
  const routes = (await routesRes.json()) as Record<string, Record<string, unknown>>;
  const permissions: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(routes)) {
    permissions[key] = Object.keys(value);
  }
  const expiresAt = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
  const res = await fetch(`${VIKUNJA_URL}/tokens`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: TOKEN_TITLE, permissions, expires_at: expiresAt }),
  });
  if (res.status !== 200 && res.status !== 201) {
    throw new Error(`PUT /tokens failed: ${res.status} ${await res.text()}`);
  }
  const token = ((await res.json()) as { token: string | null }).token;
  if (!token) {
    throw new Error('PUT /tokens returned no token');
  }
  return token;
}

// ----------------------------------------------------------------------------
// Raw HTTP (node:http, so the Host header and body framing are controllable)
// ----------------------------------------------------------------------------

interface RawResponse {
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function rawRequest(
  port: number,
  options: { method?: string; path?: string; headers?: Record<string, string>; body?: string },
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method: options.method ?? 'GET',
        path: options.path ?? '/mcp',
        headers: options.headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          resolve({
            statusCode: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf-8'),
          }),
        );
      },
    );
    req.on('error', reject);
    req.end(options.body);
  });
}

function mcpHeaders(bearer: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };
  if (bearer !== undefined) {
    headers.Authorization = `Bearer ${bearer}`;
  }
  return headers;
}

interface RpcResult {
  isError?: boolean;
  content?: Array<{ text?: string }>;
  tools?: Array<{ name: string }>;
  serverInfo?: { name: string; version: string };
  protocolVersion?: string;
}

/** POST one JSON-RPC message and return the `result` (SSE or JSON framing). */
async function rpc(
  port: number,
  bearer: string,
  id: number,
  method: string,
  params: Record<string, unknown>,
): Promise<RpcResult> {
  const res = await rawRequest(port, {
    method: 'POST',
    headers: mcpHeaders(bearer),
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  if (res.statusCode !== 200) {
    throw new Error(`${method}: HTTP ${res.statusCode}: ${res.body}`);
  }
  const contentType = String(res.headers['content-type'] ?? '');
  const messages: Array<{ result?: RpcResult; error?: unknown }> = contentType.includes(
    'text/event-stream',
  )
    ? res.body
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => JSON.parse(line.slice('data:'.length).trim()))
    : [JSON.parse(res.body)];
  const withResult = messages.find((message) => message.result !== undefined);
  if (!withResult?.result) {
    throw new Error(`${method}: no result in response: ${res.body}`);
  }
  return withResult.result;
}

function toolText(result: RpcResult): string {
  return result.content?.map((c) => c.text ?? '').join('\n') ?? '';
}

/**
 * An OS-assigned free loopback port. A random port in a fixed range can land
 * on one of the e2e stacks' published ports (8xxx/9xxx) and silently talk to
 * a Vikunja container instead of the spawned server.
 */
function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      probe.close(() => {
        if (address === null || typeof address === 'string') {
          reject(new Error('could not determine a free port'));
        } else {
          resolve(address.port);
        }
      });
    });
  });
}

async function waitForHealthz(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`);
      // Match this server's exact liveness body, not just any 200.
      if (res.ok && (await res.text()) === '{"status":"ok"}') {
        return;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(
    `Server did not become healthy within ${timeoutMs}ms: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve({ code: child.exitCode, signal: child.signalCode });
      return;
    }
    const timer = setTimeout(() => reject(new Error(`no exit within ${timeoutMs}ms`)), timeoutMs);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

// ----------------------------------------------------------------------------

async function main(): Promise<void> {
  assertLocalUrl(VIKUNJA_URL);
  log(`Target: ${E2E_TARGET.id} (${VIKUNJA_URL})`);

  log('Building the project (npm run build)...');
  const build = spawnSync('npm', ['run', 'build'], { cwd: REPO_ROOT, stdio: 'inherit' });
  if (build.status !== 0) {
    throw new Error('Build failed; aborting token-e2e run.');
  }

  log(`Logging in to the local stack as '${TEST_USERNAME}' and minting a tk_* token...`);
  const vikunjaToken = await mintApiToken(await login());
  const gatewayToken = crypto.randomBytes(32).toString('hex');
  const port = await findFreePort();

  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  for (const name of Object.keys(childEnv)) {
    if (name.startsWith('VIKUNJA_')) {
      delete childEnv[name];
    }
  }
  Object.assign(childEnv, {
    VIKUNJA_URL,
    VIKUNJA_API_TOKEN: vikunjaToken,
    VIKUNJA_MCP_TRANSPORT: 'http',
    VIKUNJA_MCP_HTTP_AUTH_MODE: 'token',
    VIKUNJA_MCP_HTTP_AUTH_TOKEN: gatewayToken,
    VIKUNJA_MCP_HTTP_HOST: '127.0.0.1',
    VIKUNJA_MCP_HTTP_PORT: String(port),
  });

  log(`Spawning dist/index.js in gateway-token mode on 127.0.0.1:${port}...`);
  let child: ChildProcess | undefined;
  const serverLogs: string[] = [];
  try {
    child = spawn('node', [DIST_ENTRY], {
      cwd: REPO_ROOT,
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.on('data', (d) => serverLogs.push(String(d)));
    child.stderr?.on('data', (d) => serverLogs.push(String(d)));

    await waitForHealthz(port, 15_000);
    log('Server is healthy.');

    const initialize = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'token-e2e', version: '0.0.0' },
      },
    };

    let unauthenticatedBody = '';
    await step('unauthenticated POST /mcp is 401 with WWW-Authenticate: Bearer', async () => {
      const res = await rawRequest(port, {
        method: 'POST',
        headers: mcpHeaders(undefined),
        body: JSON.stringify(initialize),
      });
      if (res.statusCode !== 401) {
        throw new Error(`expected 401, got ${res.statusCode}: ${res.body}`);
      }
      if (res.headers['www-authenticate'] !== 'Bearer') {
        throw new Error(`WWW-Authenticate was ${String(res.headers['www-authenticate'])}`);
      }
      unauthenticatedBody = res.body;
      log(`  401 body: ${res.body}`);
    });

    await step('wrong token is 401 with a byte-identical body, no token or reason in it', async () => {
      const res = await rawRequest(port, {
        method: 'POST',
        headers: mcpHeaders(crypto.randomBytes(32).toString('hex')),
        body: JSON.stringify(initialize),
      });
      if (res.statusCode !== 401) {
        throw new Error(`expected 401, got ${res.statusCode}`);
      }
      if (res.body !== unauthenticatedBody) {
        throw new Error(`body differs: ${res.body} vs ${unauthenticatedBody}`);
      }
      if (res.body.includes(gatewayToken.slice(0, 8)) || /missing|mismatch|reason/i.test(res.body)) {
        throw new Error(`401 body leaks detail: ${res.body}`);
      }
    });

    await step('correct token: initialize succeeds', async () => {
      const result = await rpc(port, gatewayToken, 1, 'initialize', initialize.params);
      if (result.serverInfo?.name !== 'vikunja-mcp-ng') {
        throw new Error(`unexpected serverInfo: ${JSON.stringify(result.serverInfo)}`);
      }
      log(`  serverInfo: ${JSON.stringify(result.serverInfo)}, protocol ${result.protocolVersion}`);
    });

    await step('tools/list returns the expected surface for a tk_* credential', async () => {
      const result = await rpc(port, gatewayToken, 2, 'tools/list', {});
      const names = (result.tools ?? []).map((tool) => tool.name).sort();
      for (const expected of ['vikunja_auth', 'vikunja_projects', 'vikunja_tasks', 'vikunja_labels']) {
        if (!names.includes(expected)) {
          throw new Error(`missing ${expected} in ${names.join(', ')}`);
        }
      }
      // tk_* credential: the JWT-only gate hides users/export (src/tools/index.ts).
      for (const jwtOnly of ['vikunja_users', 'vikunja_export']) {
        if (names.includes(jwtOnly)) {
          throw new Error(`${jwtOnly} should be hidden for a tk_* credential`);
        }
      }
      log(`  ${names.length} tools: ${names.join(', ')}`);
    });

    await step('a real vikunja_projects list call returns real data from the local stack', async () => {
      const result = await rpc(port, gatewayToken, 3, 'tools/call', {
        name: 'vikunja_projects',
        arguments: { subcommand: 'list' },
      });
      const text = toolText(result);
      if (result.isError) {
        throw new Error(`tool error: ${text}`);
      }
      if (!/project/i.test(text)) {
        throw new Error(`no project data in: ${text.slice(0, 300)}`);
      }
      log(`  first 200 chars: ${text.slice(0, 200).replace(/\n/g, ' | ')}`);
    });

    await step('vikunja_auth status returns the gateway-token-mode explanation', async () => {
      const result = await rpc(port, gatewayToken, 4, 'tools/call', {
        name: 'vikunja_auth',
        arguments: { subcommand: 'status' },
      });
      const text = toolText(result);
      if (!result.isError || !text.includes('gateway-token mode')) {
        throw new Error(`unexpected status result (isError=${String(result.isError)}): ${text}`);
      }
      log(`  ${text.slice(0, 220).replace(/\n/g, ' | ')}`);
    });

    await step('vikunja_auth connect cannot repoint the server credential', async () => {
      const result = await rpc(port, gatewayToken, 5, 'tools/call', {
        name: 'vikunja_auth',
        arguments: {
          subcommand: 'connect',
          apiUrl: 'http://127.0.0.1:1/api/v1',
          apiToken: 'tk_not-a-real-token-000000000',
        },
      });
      if (!result.isError || !toolText(result).includes('gateway-token mode')) {
        throw new Error(`connect was not refused: ${toolText(result)}`);
      }
      const again = await rpc(port, gatewayToken, 6, 'tools/call', {
        name: 'vikunja_projects',
        arguments: { subcommand: 'list' },
      });
      if (again.isError) {
        throw new Error(`credential changed after connect: ${toolText(again)}`);
      }
    });

    await step('GET /healthz and /readyz are 200 without Authorization', async () => {
      for (const probe of ['/healthz', '/readyz']) {
        const res = await rawRequest(port, { path: probe });
        if (res.statusCode !== 200) {
          throw new Error(`${probe}: ${res.statusCode} ${res.body}`);
        }
        log(`  ${probe}: ${res.statusCode} ${res.body}`);
      }
    });

    await step('OIDC-only endpoints are 404 (protected-resource metadata, /enroll)', async () => {
      for (const absent of ['/.well-known/oauth-protected-resource', '/enroll']) {
        const res = await rawRequest(port, { path: absent });
        if (res.statusCode !== 404) {
          throw new Error(`${absent}: expected 404, got ${res.statusCode}`);
        }
      }
    });

    await step('a Host header outside the allow-list is 403', async () => {
      const res = await rawRequest(port, {
        method: 'POST',
        headers: { ...mcpHeaders(gatewayToken), Host: `evil.example.com:${port}` },
        body: JSON.stringify(initialize),
      });
      if (res.statusCode !== 403) {
        throw new Error(`expected 403, got ${res.statusCode}: ${res.body}`);
      }
    });

    await step(`a POST /mcp body over the ${BODY_CAP}-byte cap is 413`, async () => {
      const res = await rawRequest(port, {
        method: 'POST',
        headers: mcpHeaders(gatewayToken),
        body: 'x'.repeat(BODY_CAP + 1),
      });
      if (res.statusCode !== 413) {
        throw new Error(`expected 413, got ${res.statusCode}: ${res.body}`);
      }
    });

    await step('SIGTERM shuts down cleanly (exit 0, port released)', async () => {
      const running = child as ChildProcess;
      running.kill('SIGTERM');
      const { code, signal } = await waitForExit(running, 10_000);
      if (code !== 0) {
        throw new Error(`exit code ${String(code)}, signal ${String(signal)}`);
      }
      const stillListening = await fetch(`http://127.0.0.1:${port}/healthz`).then(
        () => true,
        () => false,
      );
      if (stillListening) {
        throw new Error('port still answering after shutdown');
      }
    });

    if (failures > 0) {
      log('---- spawned server logs (for debugging failures) ----');
      // eslint-disable-next-line no-console
      console.log(serverLogs.join(''));
    }
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
    }
  }

  log(`Done. ${failures === 0 ? 'All steps passed.' : `${failures} step(s) FAILED.`}`);
  if (failures > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error('[token-e2e] Unhandled error:', error);
  process.exitCode = 1;
});
