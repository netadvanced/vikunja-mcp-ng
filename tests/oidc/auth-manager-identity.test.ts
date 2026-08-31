/**
 * Per-identity auth gating (issues #270 / #282, red-team pass #297).
 *
 * The credential *threading* fix (`resolveEffectiveAuthManager`,
 * src/utils/vikunja-rest.ts) made every REST call use the ALS-bound
 * per-identity `AuthManager`. But the auth-*type* decisions did not follow:
 * tool registration (src/tools/index.ts) and the per-call JWT gates in
 * users/export/admin/user-deletion still read the process-global closure
 * manager. In the mixed deployment shape an operator can trivially produce —
 * legacy `VIKUNJA_URL` + `VIKUNJA_API_TOKEN` env credentials (auto-connected
 * in src/index.ts) *and* `VIKUNJA_MCP_TRANSPORT=http` with OIDC — the
 * process-global manager is authenticated with the operator's own token, so
 * its auth type decided the deny-by-default gate for EVERY caller:
 *
 *  - operator env token is a JWT  -> `vikunja_admin` / `vikunja_user_deletion`
 *    / `vikunja_users` / `vikunja_export_project` register for, and their
 *    JWT gate passes for, an identity whose own vaulted credential is only a
 *    scoped `tk_*` API token (deny-by-default violation);
 *  - operator env token is `tk_*` -> the inverse: a JWT-vaulted identity is
 *    denied tools it is entitled to (fails closed, an availability bug).
 *
 * These tests pin BOTH directions to the caller's resolved identity.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { AuthManager } from '../../src/auth/AuthManager';
import { ConfigurationManager } from '../../src/config';
import { registerTools } from '../../src/tools';
import { registerUsersTool } from '../../src/tools/users';
import { registerExportTool } from '../../src/tools/export';
import { registerAdminTool } from '../../src/tools/admin';
import { registerUserDeletionTool } from '../../src/tools/user-deletion';
import { registerAuthTool } from '../../src/tools/auth';
import { VikunjaClientFactory } from '../../src/client/VikunjaClientFactory';
import { runWithRequestContext, type Identity } from '../../src/context/requestContext';
import { MCPError, ErrorCode } from '../../src/types/errors';

const identityJwt: Identity = { issuer: 'https://idp.example/realm', sub: 'jwt-user' };
const identityToken: Identity = { issuer: 'https://idp.example/realm', sub: 'tk-user' };

const OPERATOR_JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJvcGVyYXRvciJ9.operator-signature';
const IDENTITY_JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJjYWxsZXIifQ.caller-signature';

const MODULE_ENV_VARS = [
  'VIKUNJA_MCP_MODULE_ADMIN',
  'VIKUNJA_MCP_MODULE_USER_DELETION',
  'VIKUNJA_MCP_MODULE_CALDAV_TOKENS',
  'VIKUNJA_MCP_MODULE_TOKEN_MANAGEMENT',
];

/** An `AuthManager` holding a credential, as the OIDC middleware builds per request. */
function managerWith(token: string): AuthManager {
  const authManager = new AuthManager();
  authManager.connect('https://vikunja.example/api/v1', token);
  return authManager;
}

/** Collects the tool names a `registerTools()` pass actually exposes. */
function collectingServer(names: string[]): McpServer {
  return {
    tool: (...toolArgs: unknown[]) => {
      names.push(toolArgs[0] as string);
      return undefined;
    },
  } as unknown as McpServer;
}

describe('per-identity auth gating (oidc-http)', () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    // Dangerous modules are deny-by-default; enable them so the ONLY thing
    // left deciding registration is the auth-type gate under test.
    for (const key of MODULE_ENV_VARS) {
      process.env[key] = 'true';
    }
    ConfigurationManager.reset();
  });

  afterEach(() => {
    process.env = originalEnv;
    ConfigurationManager.reset();
    jest.restoreAllMocks();
  });

  describe('tool registration (#270)', () => {
    const JWT_ONLY_TOOLS = [
      'vikunja_users',
      'vikunja_export_project',
      'vikunja_request_user_export',
      'vikunja_download_user_export',
      'vikunja_user_export_status',
      'vikunja_caldav_tokens',
      'vikunja_admin',
      'vikunja_user_deletion',
    ];

    it('does not register JWT-only tools for a tk_*-vaulted identity even when the process-global env credential is a JWT', () => {
      const globalManager = managerWith(OPERATOR_JWT);
      expect(globalManager.getAuthType()).toBe('jwt');

      const names: string[] = [];
      runWithRequestContext(
        {
          identity: identityToken,
          authManager: managerWith('tk_caller-token-1234567890'),
        },
        () =>
          registerTools(
            collectingServer(names),
            globalManager,
            new VikunjaClientFactory(globalManager),
          ),
      );

      for (const tool of JWT_ONLY_TOOLS) {
        expect(names).not.toContain(tool);
      }
      // Sanity: ordinary tools still registered, so this is a targeted gate,
      // not a wholesale registration failure.
      expect(names).toContain('vikunja_tasks');
      expect(names).toContain('vikunja_auth');
    });

    it('registers JWT-only tools for a JWT-vaulted identity even when the process-global env credential is a tk_* token', () => {
      const globalManager = managerWith('tk_operator-token-1234567890');
      expect(globalManager.getAuthType()).toBe('api-token');

      const names: string[] = [];
      runWithRequestContext({ identity: identityJwt, authManager: managerWith(IDENTITY_JWT) }, () =>
        registerTools(
          collectingServer(names),
          globalManager,
          new VikunjaClientFactory(globalManager),
        ),
      );

      for (const tool of JWT_ONLY_TOOLS) {
        expect(names).toContain(tool);
      }
    });

    it('registers no JWT-only tool for an authenticated identity with no vaulted credential', () => {
      const globalManager = managerWith(OPERATOR_JWT);

      const names: string[] = [];
      runWithRequestContext(
        // Unprovisioned identity: the middleware binds an unauthenticated
        // per-identity manager (src/transport/oidcHttpAuth.ts).
        { identity: identityToken, authManager: new AuthManager() },
        () =>
          registerTools(
            collectingServer(names),
            globalManager,
            new VikunjaClientFactory(globalManager),
          ),
      );

      for (const tool of JWT_ONLY_TOOLS) {
        expect(names).not.toContain(tool);
      }
    });

    it('stdio regression: with no ALS scope, the process-global manager still decides registration', () => {
      const names: string[] = [];
      const globalManager = managerWith(OPERATOR_JWT);
      registerTools(
        collectingServer(names),
        globalManager,
        new VikunjaClientFactory(globalManager),
      );

      for (const tool of JWT_ONLY_TOOLS) {
        expect(names).toContain(tool);
      }

      const apiTokenNames: string[] = [];
      const apiTokenManager = managerWith('tk_operator-token-1234567890');
      registerTools(
        collectingServer(apiTokenNames),
        apiTokenManager,
        new VikunjaClientFactory(apiTokenManager),
      );
      for (const tool of JWT_ONLY_TOOLS) {
        expect(apiTokenNames).not.toContain(tool);
      }
    });
  });

  describe('per-call JWT gates (#282)', () => {
    type Handler = (args: Record<string, unknown>) => Promise<unknown>;

    let handlers: Record<string, Handler>;
    let globalManager: AuthManager;
    let fetchSpy: jest.SpiedFunction<typeof fetch>;

    beforeEach(() => {
      handlers = {};
      const captureServer = {
        tool: (...toolArgs: unknown[]) => {
          handlers[toolArgs[0] as string] = toolArgs[toolArgs.length - 1] as Handler;
          return undefined;
        },
      } as unknown as McpServer;

      // The mixed deployment: the process-global manager carries the
      // operator's JWT env credential.
      globalManager = managerWith(OPERATOR_JWT);
      const factory = new VikunjaClientFactory(globalManager);
      registerUsersTool(captureServer, globalManager, factory);
      registerExportTool(captureServer, globalManager, factory);
      registerAdminTool(captureServer, globalManager, factory);
      registerUserDeletionTool(captureServer, globalManager, factory);

      fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(
        async () =>
          ({
            ok: true,
            status: 200,
            statusText: 'OK',
            text: async () => JSON.stringify({ id: 1, username: 'anyone' }),
          }) as unknown as Response,
      );
    });

    afterEach(() => {
      fetchSpy.mockRestore();
    });

    const cases: Array<{ tool: string; args: Record<string, unknown> }> = [
      { tool: 'vikunja_users', args: { subcommand: 'current' } },
      { tool: 'vikunja_export_project', args: { projectId: 1 } },
      { tool: 'vikunja_admin', args: { subcommand: 'overview' } },
      { tool: 'vikunja_user_deletion', args: { subcommand: 'cancel' } },
    ];

    it.each(cases)(
      '$tool denies a tk_*-vaulted identity despite the JWT process-global credential',
      async ({ tool, args }) => {
        await expect(
          runWithRequestContext(
            {
              identity: identityToken,
              authManager: managerWith('tk_caller-token-1234567890'),
            },
            () => handlers[tool]?.(args) as Promise<unknown>,
          ),
        ).rejects.toMatchObject({ code: ErrorCode.PERMISSION_DENIED });

        // Fail closed means fail *before* the wire.
        expect(fetchSpy).not.toHaveBeenCalled();
      },
    );

    it('vikunja_users allows a JWT-vaulted identity when the process-global credential is only a tk_* token', async () => {
      const apiTokenGlobal = managerWith('tk_operator-token-1234567890');
      const localHandlers: Record<string, Handler> = {};
      registerUsersTool(
        {
          tool: (...toolArgs: unknown[]) => {
            localHandlers[toolArgs[0] as string] = toolArgs[toolArgs.length - 1] as Handler;
            return undefined;
          },
        } as unknown as McpServer,
        apiTokenGlobal,
        new VikunjaClientFactory(apiTokenGlobal),
      );

      await expect(
        runWithRequestContext(
          { identity: identityJwt, authManager: managerWith(IDENTITY_JWT) },
          () => localHandlers['vikunja_users']?.({ subcommand: 'current' }) as Promise<unknown>,
        ),
      ).resolves.toBeDefined();
      expect(fetchSpy).toHaveBeenCalled();
    });
  });

  describe('vikunja_auth capability detection and refresh (#282)', () => {
    type Handler = (args: Record<string, unknown>) => Promise<unknown>;
    let authHandler: Handler;
    let globalManager: AuthManager;
    let fetchSpy: jest.SpiedFunction<typeof fetch>;

    beforeEach(() => {
      globalManager = managerWith(OPERATOR_JWT);
      const captureServer = {
        tool: (...toolArgs: unknown[]) => {
          authHandler = toolArgs[toolArgs.length - 1] as Handler;
          return undefined;
        },
      } as unknown as McpServer;
      registerAuthTool(captureServer, globalManager);

      fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(
        async () =>
          ({
            ok: true,
            status: 200,
            statusText: 'OK',
            text: async () => JSON.stringify({ version: '2.4.0' }),
          }) as unknown as Response,
      );
    });

    afterEach(() => {
      fetchSpy.mockRestore();
    });

    it('info caches capabilities on the calling identity, never on the process-global session', async () => {
      const identityManager = managerWith('tk_caller-token-1234567890');

      await runWithRequestContext({ identity: identityToken, authManager: identityManager }, () =>
        authHandler({ subcommand: 'info' }),
      );

      expect(identityManager.getCapabilities()).toBeDefined();
      expect(globalManager.getCapabilities()).toBeUndefined();
    });

    it('refresh reports the calling identity auth type, not the process-global one', async () => {
      const result = (await runWithRequestContext(
        { identity: identityToken, authManager: managerWith('tk_caller-token-1234567890') },
        () => authHandler({ subcommand: 'refresh' }),
      )) as { content: Array<{ text: string }> };

      const text = result.content.map((entry) => entry.text).join('\n');
      expect(text).toContain('api-token');
      expect(text).not.toContain('"authType": "jwt"');
    });

    it('refresh surfaces the provisioning prompt for an unprovisioned identity', async () => {
      await expect(
        runWithRequestContext({ identity: identityToken, authManager: new AuthManager() }, () =>
          authHandler({ subcommand: 'refresh' }),
        ),
      ).rejects.toBeInstanceOf(MCPError);
    });
  });
});
