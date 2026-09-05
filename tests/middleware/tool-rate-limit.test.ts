/**
 * Tests for the central tool-surface rate-limiting wrapper (#263 CRIT-2).
 *
 * The defect: only `vikunja_auth` was wrapped, so every other tool was
 * unmetered per identity — while docs/ROADMAP.md decision 16(c) justifies
 * sharing circuit breakers across tenants precisely on the grounds that
 * per-user rate limits exist to contain a noisy neighbour.
 *
 * Found while re-verifying this fix live before the v0.7.0-beta.3 release:
 * the wrapper had no transport-mode gate, so it also applied to the default
 * `stdio` deployment (one process, one identity — no noisy neighbour to
 * contain), a real behavior change to the deployment `docs/ROADMAP.md`'s
 * OIDC epic entry requires to stay byte-for-byte unchanged. `registerTools`
 * now only applies the wrapper in `oidc-http` mode; the tests below cover
 * both sides of that gate.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { withRateLimitedTools } from '../../src/middleware/tool-rate-limit';
import {
  withRateLimit,
  isRateLimited,
  secureRateLimitMiddleware,
  TOOL_CATEGORIES,
} from '../../src/middleware/simplified-rate-limit';
import { registerTools } from '../../src/tools';
import { AuthManager } from '../../src/auth/AuthManager';
import { ErrorCode } from '../../src/types/errors';
import { ConfigurationManager } from '../../src/config';

type ToolCall = [string, ...unknown[]];

function fakeServer(): { server: McpServer; calls: ToolCall[]; connected: string[] } {
  const calls: ToolCall[] = [];
  const connected: string[] = [];
  const server = {
    tool: (...args: unknown[]) => {
      calls.push(args as ToolCall);
      return { name: args[0] };
    },
    connect: function connect(this: unknown, label: string) {
      connected.push(label);
      return this;
    },
    someValue: 42,
  } as unknown as McpServer;
  return { server, calls, connected };
}

describe('withRateLimitedTools', () => {
  afterEach(async () => {
    await secureRateLimitMiddleware.clearAll();
  });

  it('wraps the handler of every tool registered through it', async () => {
    const { server, calls } = fakeServer();
    const metered = withRateLimitedTools(server);

    const handler = jest.fn().mockResolvedValue('ok');
    metered.tool('vikunja_tasks', 'description', {}, handler as never);

    expect(calls).toHaveLength(1);
    const registered = calls[0]?.[3];
    expect(typeof registered).toBe('function');
    expect(registered).not.toBe(handler);
    expect(isRateLimited(registered)).toBe(true);

    // The wrapper still delegates to the original handler.
    await expect((registered as () => Promise<unknown>)()).resolves.toBe('ok');
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('actually enforces the limit for a non-auth tool', async () => {
    const { server, calls } = fakeServer();
    const metered = withRateLimitedTools(server);

    const handler = jest.fn().mockResolvedValue('ok');
    metered.tool('vikunja_batch_import', 'description', {}, handler as never);

    const wrapped = calls[0]?.[3] as (args: unknown) => Promise<unknown>;

    // The 'bulk' category default is 5 requests per minute.
    for (let i = 0; i < 5; i++) {
      await expect(wrapped({})).resolves.toBe('ok');
    }
    await expect(wrapped({})).rejects.toEqual(
      expect.objectContaining({ code: ErrorCode.RATE_LIMIT_EXCEEDED }),
    );
    expect(handler).toHaveBeenCalledTimes(5);
  });

  it('does not double-wrap a handler a tool module already rate-limited', () => {
    const { server, calls } = fakeServer();
    const metered = withRateLimitedTools(server);

    const alreadyWrapped = withRateLimit('vikunja_auth', jest.fn().mockResolvedValue('ok'));
    metered.tool('vikunja_auth', 'description', {}, alreadyWrapped as never);

    expect(calls[0]?.[3]).toBe(alreadyWrapped);
  });

  it('passes non-function trailing arguments through untouched', () => {
    const { server, calls } = fakeServer();
    const metered = withRateLimitedTools(server);

    (metered.tool as unknown as (...a: unknown[]) => unknown)('vikunja_tasks', { notAHandler: 1 });

    expect(calls[0]).toEqual(['vikunja_tasks', { notAHandler: 1 }]);
  });

  it('falls back to a placeholder tool name when the first argument is not a string', async () => {
    const { server, calls } = fakeServer();
    const metered = withRateLimitedTools(server);

    const handler = jest.fn().mockResolvedValue('ok');
    (metered.tool as unknown as (...a: unknown[]) => unknown)(123, handler);

    const wrapped = calls[0]?.[1] as () => Promise<unknown>;
    expect(isRateLimited(wrapped)).toBe(true);
    await expect(wrapped()).resolves.toBe('ok');
  });

  it('forwards every other member to the real server', () => {
    const { server, connected } = fakeServer();
    const metered = withRateLimitedTools(server);

    (metered as unknown as { connect: (label: string) => unknown }).connect('stdio');
    expect(connected).toEqual(['stdio']);
    expect((metered as unknown as { someValue: number }).someValue).toBe(42);
  });

  it('leaves the wrapped server itself unmodified', () => {
    const { server } = fakeServer();
    const originalTool = server.tool;

    withRateLimitedTools(server);

    expect(server.tool).toBe(originalTool);
  });
});

describe('registerTools wires the whole tool surface through the limiter (#263)', () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    ConfigurationManager.reset();
  });

  afterEach(async () => {
    process.env = originalEnv;
    ConfigurationManager.reset();
    await secureRateLimitMiddleware.clearAll();
  });

  function registerAndCollect(): ToolCall[] {
    const calls: ToolCall[] = [];
    const server = {
      tool: (...args: unknown[]) => {
        calls.push(args as ToolCall);
      },
    } as unknown as McpServer;

    const authManager = new AuthManager();
    authManager.connect('https://vikunja.example/api/v1', 'tk_test-token-1234567890');

    registerTools(server, authManager, { test: 'factory' } as never);
    return calls;
  }

  it('in oidc-http mode, registers no tool with a bare, unmetered handler', () => {
    process.env.VIKUNJA_MCP_TRANSPORT = 'http';
    ConfigurationManager.reset();
    const calls = registerAndCollect();

    expect(calls.length).toBeGreaterThan(10);

    const unmetered = calls
      .filter((call) => typeof call[call.length - 1] === 'function')
      .filter((call) => !isRateLimited(call[call.length - 1]))
      .map((call) => call[0]);

    expect(unmetered).toEqual([]);
  });

  it('in the default stdio mode, registers no tool with the #263 wrapper — the OIDC epic\'s byte-for-byte invariant', () => {
    // No VIKUNJA_MCP_TRANSPORT set: `transport` defaults to 'stdio'
    // (src/config/types.ts). One process serves exactly one identity here,
    // so there is no noisy neighbour for a rate limit to contain, and this
    // is the deployment mode docs/ROADMAP.md's OIDC epic entry requires to
    // stay byte-for-byte its pre-epic behavior. `vikunja_auth` is the sole,
    // deliberate exception: its own rate-limit wrapping (`applyRateLimiting`
    // in src/tools/auth.ts, via src/middleware/direct-middleware.ts)
    // predates this entire OIDC epic and #263, applies regardless of
    // transport, and is intentionally untouched by this gate.
    const calls = registerAndCollect();

    expect(calls.length).toBeGreaterThan(10);

    const metered = calls
      .filter((call) => typeof call[call.length - 1] === 'function')
      .filter((call) => isRateLimited(call[call.length - 1]))
      .map((call) => call[0]);

    expect(metered).toEqual(['vikunja_auth']);
  });

  it('an explicit transport=stdio behaves identically to the default', () => {
    process.env.VIKUNJA_MCP_TRANSPORT = 'stdio';
    ConfigurationManager.reset();
    const calls = registerAndCollect();

    const metered = calls
      .filter((call) => typeof call[call.length - 1] === 'function')
      .filter((call) => isRateLimited(call[call.length - 1]))
      .map((call) => call[0]);

    expect(metered).toEqual(['vikunja_auth']);
  });

  it('categorises every registered tool explicitly', () => {
    process.env.VIKUNJA_MCP_TRANSPORT = 'http';
    ConfigurationManager.reset();
    const calls = registerAndCollect();

    // Silently defaulting an unknown tool to the 'default' budget is how
    // `vikunja_task_bulk` ended up with the same allowance as a single-task
    // read; every registered name must be a deliberate entry in the table.
    const uncategorised = calls
      .map((call) => call[0])
      .filter((name) => TOOL_CATEGORIES[name] === undefined);

    expect(uncategorised).toEqual([]);
  });
});
