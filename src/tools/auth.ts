/**
 * Authentication Tool
 * Handles authentication operations for Vikunja
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AuthManager } from '../auth/AuthManager';
import type { VikunjaClientFactory } from '../client/VikunjaClientFactory';
import { MCPError, ErrorCode } from '../types/errors';
import { clearGlobalClientFactory } from '../client';
import { logger } from '../utils/logger';
import { applyRateLimiting } from '../middleware/direct-middleware';
import { createSecureConnectionMessage } from '../utils/security';
import { wrapAuthError } from '../utils/error-handler';
import { createStandardResponse } from '../utils/response-factory';
import { formatMcpResponse } from '../utils/simple-response';

interface AuthArgs {
  subcommand: 'connect' | 'status' | 'refresh' | 'disconnect';
  apiUrl?: string | undefined;
  apiToken?: string | undefined;
}

export function registerAuthTool(server: McpServer, authManager: AuthManager, _clientFactory?: VikunjaClientFactory): void {
  server.tool(
    'vikunja_auth',
    'Manage authentication with Vikunja API (connect, status, refresh, disconnect)',
    {
      subcommand: z.enum(['connect', 'status', 'refresh', 'disconnect']),
      apiUrl: z.string().url().optional(),
      apiToken: z.string().optional(),
    },
    applyRateLimiting('vikunja_auth', async (args: AuthArgs) => {
      try {
        switch (args.subcommand) {
          case 'connect': {
            if (!args.apiUrl || !args.apiToken) {
              throw new MCPError(
                ErrorCode.VALIDATION_ERROR,
                'apiUrl and apiToken are required for connect',
              );
            }

            const secureMessage = createSecureConnectionMessage(args.apiUrl, args.apiToken);
            logger.debug('Auth connect attempt: %s', secureMessage);

            // Check if already authenticated
            const currentStatus = authManager.getStatus();
            if (currentStatus.authenticated && currentStatus.apiUrl === args.apiUrl) {
              const response = createStandardResponse(
                'auth-connect',
                'Already connected to Vikunja',
                { authenticated: true },
                { apiUrl: args.apiUrl },
              );
              return {
                content: formatMcpResponse(response),
              };
            }

            // Auto-detect auth type will be handled by AuthManager
            logger.info('Attempting to connect to Vikunja');
            authManager.connect(args.apiUrl, args.apiToken);
            const detectedAuthType = authManager.getAuthType();
            logger.info('Successfully connected to Vikunja - authType: %s', detectedAuthType);

            const response = createStandardResponse(
              'auth-connect',
              'Successfully connected to Vikunja',
              { authenticated: true },
              { apiUrl: args.apiUrl, authType: authManager.getAuthType() },
            );
            return {
              content: formatMcpResponse(response),
            };
          }

          case 'status': {
            const status = authManager.getStatus();
            const response = createStandardResponse(
              'auth-status',
              status.authenticated ? 'Authentication status retrieved' : 'Not authenticated',
              status,
              status.authenticated ? { apiUrl: status.apiUrl } : undefined,
            );
            return {
              content: formatMcpResponse(response),
            };
          }

          case 'refresh': {
            // authManager.getAuthType() throws AUTH_REQUIRED when there is
            // no active session, which wrapAuthError below turns into a
            // clear "not authenticated" error.
            const authType = authManager.getAuthType();

            if (authType === 'jwt') {
              // Vikunja JWTs are short-lived (unlike API tokens) and the
              // spec documents POST /user/token/refresh to renew one. That
              // endpoint exchanges a refresh-token cookie set at login for
              // a new JWT -- but this server authenticates every request
              // with a single static Bearer token supplied via
              // vikunja_auth.connect and never establishes a cookie-based
              // session, so it has no refresh-token cookie to send. The
              // endpoint is therefore not usable from this server: calling
              // it would just fail with 401 "invalid or expired refresh
              // token". Report that accurately instead of attempting (and
              // silently failing) the call or claiming refresh isn't
              // needed.
              const response = createStandardResponse(
                'auth-refresh',
                'JWT tokens expire and this server cannot refresh them automatically. Vikunja\'s POST /user/token/refresh endpoint requires a refresh-token cookie issued at login, but this server authenticates with a static Bearer token and holds no such cookie. When your JWT expires, obtain a new one (e.g. by logging in to Vikunja again) and call vikunja_auth connect with the new token.',
                { refreshed: false, authType: 'jwt', tokenExpires: true },
                {
                  reason:
                    'JWT refresh requires a refresh-token cookie this static-Bearer-token server does not have',
                },
              );
              return {
                content: formatMcpResponse(response),
              };
            }

            // API tokens (tk_*) are documented as long-lived and have no
            // refresh mechanism in the API, so this message remains accurate.
            const response = createStandardResponse(
              'auth-refresh',
              'Token refresh not required for API tokens (tk_*) - they are long-lived and do not expire.',
              { refreshed: false, authType: 'api-token', tokenExpires: false },
              { reason: 'API tokens do not expire' },
            );
            return {
              content: formatMcpResponse(response),
            };
          }

          case 'disconnect': {
            authManager.disconnect();
            await clearGlobalClientFactory();
            const response = createStandardResponse(
              'auth-disconnect',
              'Successfully disconnected from Vikunja',
              { authenticated: false },
              { previouslyConnected: true },
            );
            return {
              content: formatMcpResponse(response),
            };
          }

          default:
            throw new MCPError(
              ErrorCode.VALIDATION_ERROR,
              `Unknown subcommand: ${args.subcommand as string}`,
            );
        }
      } catch (error) {
        throw wrapAuthError(error, args.subcommand);
      }
    })
  );
}
