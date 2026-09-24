#!/usr/bin/env node

/**
 * Vikunja MCP Server
 * Main entry point for the Model Context Protocol server
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import dotenv from 'dotenv';

import { AuthManager } from './auth/AuthManager';
import { registerTools } from './tools';
import { logger } from './utils/logger';
import { createSecureConnectionMessage, createSecureLogConfig } from './utils/security';
import {
  createVikunjaClientFactory,
  setGlobalClientFactory,
  type VikunjaClientFactory,
} from './client';
import { readSecretEnv } from './config/secrets';
import { ConfigurationManager } from './config/ConfigurationManager';
import { ConfigurationError } from './config/types';
import { startHttpTransport, type HttpTransportHandle } from './transport/httpTransport';
import { setupOidcHttpAuth } from './transport/oidcHttpAuth';
import { setupStaticTokenAuth } from './transport/staticTokenAuth';
import { setupEnrollment } from './transport/enrollment';
import { resolvePackageVersion } from './utils/version';

dotenv.config({ quiet: true });

const server = new McpServer({
  name: 'vikunja-mcp-ng',
  version: resolvePackageVersion(__dirname),
});

const authManager = new AuthManager();

let clientFactory: VikunjaClientFactory | null = null;

async function initializeFactory(): Promise<void> {
  try {
    clientFactory = await createVikunjaClientFactory(authManager);
    if (clientFactory) {
      await setGlobalClientFactory(clientFactory);
    }
  } catch (error) {
    logger.warn('Failed to initialize client factory during startup:', error);
    // Factory will be initialized on first authentication
  }
}

// Initialize factory during module load for both production and test environments
// This ensures the factory is available for tests
export const factoryInitializationPromise = initializeFactory()
  .then(() => {
    try {
      if (clientFactory) {
        registerTools(server, authManager, clientFactory);
      } else {
        registerTools(server, authManager, undefined);
      }
    } catch (error) {
      logger.error('Failed to initialize:', error);
      // Fall back to legacy registration for backwards compatibility
      registerTools(server, authManager, undefined);
    }
  })
  .catch((error) => {
    logger.warn('Failed to initialize client factory during module load:', error);
    registerTools(server, authManager, undefined);
  });

// Resolve VIKUNJA_API_TOKEN, honoring the VIKUNJA_API_TOKEN_FILE Docker-secrets
// convention. Setting both the plain variable and its _FILE variant is a hard
// startup error (see src/config/secrets.ts) rather than a silent precedence choice.
let vikunjaApiToken: string | undefined;
try {
  vikunjaApiToken = readSecretEnv('VIKUNJA_API_TOKEN');
} catch (error) {
  logger.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

if (process.env.VIKUNJA_URL && vikunjaApiToken) {
  const connectionMessage = createSecureConnectionMessage(process.env.VIKUNJA_URL, vikunjaApiToken);
  logger.info(`Auto-authenticating: ${connectionMessage}`);
  authManager.connect(process.env.VIKUNJA_URL, vikunjaApiToken);
  const detectedAuthType = authManager.getAuthType();
  logger.info(`Using detected auth type: ${detectedAuthType}`);
}

/**
 * Close the HTTP listener on SIGINT/SIGTERM (a Swarm `docker stop` sends
 * SIGTERM) and exit 0 instead of being killed by the signal. This is not a
 * drain: `closeAllConnections()` also cuts in-flight requests and any open
 * stream, so shutdown cannot hang. Requests here are short stateless calls.
 */
function installShutdownHandlers(handle: HttpTransportHandle): void {
  let closing = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (closing) {
      return;
    }
    closing = true;
    logger.info(`Received ${signal}, closing the HTTP listener`);
    const closed = handle.close();
    handle.httpServer.closeAllConnections();
    closed.then(
      () => process.exit(0),
      (error: unknown) => {
        logger.error('Failed to close the HTTP listener cleanly:', error);
        process.exit(1);
      },
    );
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

/**
 * Transport mode selection (docs/OIDC-RESOURCE-SERVER.md §2 "Modes").
 *
 * `stdio` is the default and MUST remain byte-for-byte behaviorally
 * unchanged — this is the epic's hard invariant (see
 * tests/index.test.ts's "stdio transport invariant" suite). By the time
 * `main()` runs, `factoryInitializationPromise` has already resolved, and
 * `registerTools()` (called from within it) has already loaded and cached
 * the application config via `ConfigurationManager.loadConfiguration()`
 * (see `resolveModulesConfig()` in `src/tools/index.ts`) — so calling
 * `loadConfiguration()` again here is a cache hit with no additional side
 * effects (no repeated "Configuration loaded successfully" log) in the
 * default, happy-path case.
 *
 * `http` mode is new and opt-in (`transport=http` / `VIKUNJA_MCP_TRANSPORT`)
 * and starts the Streamable HTTP transport instead of stdio — see
 * `src/transport/httpTransport.ts`. Its auth scheme is `http.authMode`:
 * `oidc` (default, per-user) or `token` (single-user gateway mode,
 * docs/GATEWAY-TOKEN-MODE.md). Without an auth middleware registered on the
 * seam, it refuses to start rather than serve unauthenticated HTTP.
 */
async function main(): Promise<void> {
  await factoryInitializationPromise;

  const appConfig = ConfigurationManager.getInstance().loadConfiguration();

  if (appConfig.transport === 'http') {
    if (appConfig.http.authMode === 'token') {
      // gateway-token mode (docs/GATEWAY-TOKEN-MODE.md §4.3, §5): a static
      // bearer authenticates the gateway, and every request runs as the
      // process-global Vikunja credential above, exactly as in stdio. No
      // vault, no enrollment. Both secrets are required up front: without
      // the Vikunja credential every tool call would fail with
      // AUTH_REQUIRED, which looks like a gateway problem.
      setupStaticTokenAuth(readSecretEnv('VIKUNJA_MCP_HTTP_AUTH_TOKEN'));
      if (!authManager.isAuthenticated()) {
        throw new ConfigurationError(
          'http.authMode',
          'Gateway-token mode (VIKUNJA_MCP_HTTP_AUTH_MODE set to token) serves the single ' +
            'Vikunja credential the operator configures, and none is set. Set VIKUNJA_URL ' +
            'and VIKUNJA_API_TOKEN (or VIKUNJA_API_TOKEN_FILE).',
        );
      }
    } else if (appConfig.oidc) {
      // Build and register the OIDC JWT-validation middleware on the
      // transport auth seam BEFORE starting the listener
      // (docs/OIDC-RESOURCE-SERVER.md §3b). When no `oidc` config is present
      // we deliberately skip this, and `startHttpTransport` then refuses to
      // start rather than serve unauthenticated HTTP (deny-mixed-mode, §2
      // "Selection rule").
      await setupOidcHttpAuth(appConfig.oidc, appConfig.vault, appConfig.http);
      // One-click SSO enrollment (issue #220): opt-in, and only meaningful
      // once the vault exists — hence strictly after setupOidcHttpAuth. A
      // no-op when `enroll.enabled` is false.
      setupEnrollment(appConfig.enroll, appConfig.http, appConfig.auth.vikunjaUrl);
    }
    // Stateless HTTP mode builds a fresh, fully-registered `McpServer` per
    // request (the SDK's stateless transport cannot be reused across
    // requests; a shared server cannot back concurrent per-request
    // transports — see src/transport/httpTransport.ts). The module-level
    // `server` above stays the stdio-mode server and is left unconnected here.
    const handle = await startHttpTransport(
      () => {
        const requestServer = new McpServer({
          name: 'vikunja-mcp-ng',
          version: resolvePackageVersion(__dirname),
        });
        registerTools(requestServer, authManager, clientFactory ?? undefined);
        return requestServer;
      },
      appConfig.http,
      appConfig.oidc,
      {
        maxBodyBytes: appConfig.rateLimiting.default.maxRequestSize,
        isCredentialConfigured: () => authManager.isAuthenticated(),
      },
    );
    installShutdownHandlers(handle);
    logger.info('Vikunja MCP server started (http transport)');
    return;
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);

  logger.info('Vikunja MCP server started');

  const config = createSecureLogConfig({
    mode: process.env.MCP_MODE,
    debug: process.env.DEBUG,
    hasAuth: !!process.env.VIKUNJA_URL && !!vikunjaApiToken,
    url: process.env.VIKUNJA_URL,
    token: vikunjaApiToken,
  });

  logger.debug('Configuration loaded', config);
}

// Exported for direct invocation in tests (mode selection, refuse-to-start,
// and the stdio invariant regression tests — see tests/index.test.ts). Not
// otherwise part of this module's public API.
export { main };

// Only start the server if not in test environment
if (process.env.NODE_ENV !== 'test' && !process.env.JEST_WORKER_ID) {
  main().catch((error) => {
    logger.error('Failed to start server:', error);
    process.exit(1);
  });
}

// Essential exports only - eliminated 80+ lines of unnecessary barrel exports
// Use direct imports instead of centralized re-exports for better tree-shaking

// Core types that are commonly imported by external code
export { MCPError, ErrorCode } from './types/errors';
export type { TaskResponseData, FilterExpression, Task } from './types';
export type { ParseResult } from './types/filters';
export type { AorpBuilderConfig, AorpFactoryResult } from './types';

// Core utilities that are widely used across the codebase
export { logger } from './utils/logger';
export { isAuthenticationError } from './utils/auth-error-handler';
export { withRetry, RETRY_CONFIG } from './utils/retry';
export { transformApiError, handleFetchError, handleStatusCodeError } from './utils/error-handler';
export { parseFilterString } from './utils/filters';
export { validateTaskCountLimit } from './utils/memory';
export {
  createStandardResponse,
  createAorpErrorResponse as createErrorResponse,
} from './utils/response-factory';

// Additional exports for task modules
export type { SimpleResponse } from './utils/simple-response';

// Session utilities for external usage
export { getAuthManagerFromContext, clearGlobalClientFactory } from './client';
