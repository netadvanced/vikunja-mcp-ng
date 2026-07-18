/**
 * Tests for the opt-in `backgrounds` module's subcommand-level gating on
 * `vikunja_projects` (G7, docs/ENDPOINT-TAIL-RETRIAGE.md).
 *
 * Unlike every other module (which gates a whole standalone tool at
 * registration time), `backgrounds` gates three subcommands *within* the
 * always-registered `vikunja_projects` tool. These tests assert that the
 * disabled subcommands are genuinely absent from the tool's zod subcommand
 * enum (not merely rejected by handler logic) — matching the "invisible to
 * the client" contract every other module gets — and that
 * `resolveBackgroundsEnabled` fails safe to disabled.
 */
import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import type { AuthManager } from '../../../src/auth/AuthManager';
import { registerProjectsTool, resolveBackgroundsEnabled } from '../../../src/tools/projects/index';
import type { MockAuthManager, MockServer } from '../../types/mocks';
import { circuitBreakerRegistry } from '../../../src/utils/retry';
import { ConfigurationManager } from '../../../src/config';
import { logger } from '../../../src/utils/logger';

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

const BACKGROUND_SUBCOMMANDS = ['remove-background', 'set-unsplash-background', 'search-unsplash'];

function makeMockServer(): MockServer {
  return {
    tool: jest.fn() as jest.MockedFunction<
      (name: string, description: string, schema: any, annotations: any, handler: any) => void
    >,
  } as MockServer;
}

function makeMockAuthManager(): MockAuthManager {
  return {
    isAuthenticated: jest.fn().mockReturnValue(true),
    getSession: jest.fn().mockReturnValue({
      apiUrl: 'https://vikunja.example.com',
      apiToken: 'test-token',
    }),
    setSession: jest.fn(),
    clearSession: jest.fn(),
    connect: jest.fn(),
    getStatus: jest.fn(),
    isConnected: jest.fn(),
    disconnect: jest.fn(),
  } as MockAuthManager;
}

/** Extracts the subcommand enum's allowed values from the captured schema. */
function subcommandValuesFrom(mockServer: MockServer): string[] {
  const call = mockServer.tool.mock.calls[0];
  const schema = call?.[2] as { subcommand: { options: string[] } };
  return schema.subcommand.options;
}

function descriptionFrom(mockServer: MockServer): string {
  const call = mockServer.tool.mock.calls[0];
  return call?.[1] as string;
}

describe('vikunja_projects backgrounds module gating (G7)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFetch.mockReset();
    circuitBreakerRegistry.clear();
    ConfigurationManager.reset();
    delete process.env.VIKUNJA_MCP_MODULE_BACKGROUNDS;
    delete process.env.VIKUNJA_MCP_CONFIG;
  });

  afterEach(() => {
    ConfigurationManager.reset();
    delete process.env.VIKUNJA_MCP_MODULE_BACKGROUNDS;
    delete process.env.VIKUNJA_MCP_CONFIG;
  });

  it('excludes the three background subcommands from the enum by default (explicit override omitted)', () => {
    const mockServer = makeMockServer();
    registerProjectsTool(mockServer, makeMockAuthManager() as unknown as AuthManager);

    const values = subcommandValuesFrom(mockServer);
    for (const sub of BACKGROUND_SUBCOMMANDS) {
      expect(values).not.toContain(sub);
    }
    // Ordinary subcommands remain present.
    expect(values).toContain('list');
    expect(values).toContain('duplicate');
  });

  it('excludes the background subcommands when explicitly overridden to false', () => {
    const mockServer = makeMockServer();
    registerProjectsTool(mockServer, makeMockAuthManager() as unknown as AuthManager, undefined, false);

    const values = subcommandValuesFrom(mockServer);
    for (const sub of BACKGROUND_SUBCOMMANDS) {
      expect(values).not.toContain(sub);
    }
  });

  it('includes the three background subcommands when explicitly overridden to true', () => {
    const mockServer = makeMockServer();
    registerProjectsTool(mockServer, makeMockAuthManager() as unknown as AuthManager, undefined, true);

    const values = subcommandValuesFrom(mockServer);
    for (const sub of BACKGROUND_SUBCOMMANDS) {
      expect(values).toContain(sub);
    }
  });

  it('mentions the opt-in backgrounds module in the tool description only when enabled', () => {
    const disabledServer = makeMockServer();
    registerProjectsTool(disabledServer, makeMockAuthManager() as unknown as AuthManager, undefined, false);
    expect(descriptionFrom(disabledServer)).not.toContain('backgrounds module');

    const enabledServer = makeMockServer();
    registerProjectsTool(enabledServer, makeMockAuthManager() as unknown as AuthManager, undefined, true);
    expect(descriptionFrom(enabledServer)).toContain('backgrounds module');
  });

  it('dispatches remove-background/set-unsplash-background/search-unsplash when enabled', async () => {
    const mockServer = makeMockServer();
    const authManager = makeMockAuthManager();
    registerProjectsTool(mockServer, authManager as unknown as AuthManager, undefined, true);
    const handler = mockServer.tool.mock.calls[0]?.[mockServer.tool.mock.calls[0].length - 1] as (
      args: Record<string, unknown>,
    ) => Promise<{ content: Array<{ text: string }> }>;

    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: jest.fn(async () => JSON.stringify({ id: 5, title: 'Project 5' })),
    } as unknown as Response);
    const removeResult = await handler({ subcommand: 'remove-background', id: 5 });
    expect(removeResult.content[0].text).toContain('Background removed from project 5');

    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: jest.fn(async () => JSON.stringify({ id: 5, title: 'Project 5' })),
    } as unknown as Response);
    const setResult = await handler({ subcommand: 'set-unsplash-background', id: 5, unsplashImageId: 'p1' });
    expect(setResult.content[0].text).toContain('background set to unsplash photo p1');

    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: jest.fn(async () => JSON.stringify([{ id: 'p1' }])),
    } as unknown as Response);
    const searchResult = await handler({ subcommand: 'search-unsplash', unsplashQuery: 'x' });
    expect(searchResult.content[0].text).toContain('Found 1 unsplash photo');
  });

  it('rejects with a validation error for set-unsplash-background missing unsplashImageId even when enabled', async () => {
    const mockServer = makeMockServer();
    const authManager = makeMockAuthManager();
    registerProjectsTool(mockServer, authManager as unknown as AuthManager, undefined, true);
    const handler = mockServer.tool.mock.calls[0]?.[mockServer.tool.mock.calls[0].length - 1] as (
      args: Record<string, unknown>,
    ) => Promise<unknown>;

    await expect(handler({ subcommand: 'set-unsplash-background', id: 5 })).rejects.toThrow(
      /unsplashImageId is required/,
    );
  });

  describe('resolveBackgroundsEnabled', () => {
    it('returns the override when provided, without consulting configuration', () => {
      expect(resolveBackgroundsEnabled(true)).toBe(true);
      expect(resolveBackgroundsEnabled(false)).toBe(false);
    });

    it('resolves false by default from configuration', () => {
      expect(resolveBackgroundsEnabled()).toBe(false);
    });

    it('resolves true when the env var override is set', () => {
      process.env.VIKUNJA_MCP_MODULE_BACKGROUNDS = 'true';
      expect(resolveBackgroundsEnabled()).toBe(true);
    });

    it('fails safe to false (and logs) when configuration loading throws', () => {
      const errorSpy = jest.spyOn(logger, 'error').mockImplementation(() => undefined);
      jest.spyOn(ConfigurationManager, 'getInstance').mockImplementation(() => {
        throw new Error('boom');
      });

      expect(resolveBackgroundsEnabled()).toBe(false);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Failed to load module gating configuration'),
        expect.anything(),
      );

      errorSpy.mockRestore();
      jest.restoreAllMocks();
    });
  });
});
