/**
 * Central per-identity rate limiting for the whole tool surface.
 *
 * Issue #263 (CRIT-2): of the ~24 tools this server registers, exactly one —
 * `vikunja_auth` — had its handler wrapped in the rate-limit middleware. Every
 * other tool was unmetered per identity, which in `oidc-http` mode (one process,
 * many Vikunja accounts) means one caller could saturate the shared upstream
 * and trip the shared circuit breakers for every other tenant. That mattered
 * doubly because decision 16(c) in docs/ROADMAP.md accepts sharing circuit
 * breakers across users *on the stated grounds* that "per-user rate limits
 * handle noisy neighbors independently" — a compensation that did not exist.
 *
 * Rather than edit 27 registration call sites (and rely on nobody forgetting
 * the wrapper on the 28th), this wraps the `McpServer` handed to
 * `registerTools()` once: every `server.tool(...)` call made through it gets
 * its handler wrapped, keyed by the tool name that same call already passes.
 * A tool that is registered through it is therefore metered, by construction.
 *
 * `registerTools()` (`src/tools/index.ts`) only applies this wrapper in
 * `oidc-http` transport mode — the scenario this module's whole rationale
 * above depends on (one process, many identities). The default `stdio`
 * deployment has exactly one identity per process, so there is no noisy
 * neighbour for a rate limit to contain, and the OIDC epic's hard invariant
 * requires `stdio` to stay byte-for-byte its pre-epic behavior. This module
 * itself stays mode-agnostic (it wraps whatever server it's given); the
 * mode check lives at the call site.
 *
 * The wrapper is a `Proxy`, not a mutation of the caller's server: the
 * `McpServer` passed in is left exactly as it was (`src/index.ts` keeps using
 * it for `connect()`), and nothing here depends on registration happening only
 * once — `src/transport/httpTransport.ts` builds and registers a fresh server
 * on every HTTP request.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { withRateLimit, isRateLimited } from './simplified-rate-limit';

/** The handler shape `withRateLimit` operates on, erased to `unknown`. */
type AnyHandler = (...args: unknown[]) => Promise<unknown>;

/**
 * Return a view of `server` whose `tool()` method rate-limits every handler
 * registered through it. All other members are forwarded to the real server
 * unchanged.
 */
export function withRateLimitedTools(server: McpServer): McpServer {
  const rateLimitedTool = (...args: unknown[]): unknown => {
    // Every `server.tool(...)` overload takes the tool name first and the
    // handler last; the description/schema/annotations in between vary.
    const toolName = typeof args[0] === 'string' ? args[0] : 'unknown_tool';
    const handlerIndex = args.length - 1;
    const handler = args[handlerIndex];

    // `isRateLimited` keeps this idempotent: a handler that a tool module
    // already wrapped itself (`src/tools/auth.ts` via
    // `applyRateLimiting`) is passed through untouched instead of being
    // charged twice per call and given two nested deadlines.
    if (typeof handler === 'function' && !isRateLimited(handler)) {
      args[handlerIndex] = withRateLimit(toolName, handler as AnyHandler);
    }

    const register = server.tool.bind(server) as (...a: unknown[]) => unknown;
    return register(...args);
  };

  return new Proxy(server, {
    get(target, property, receiver): unknown {
      if (property === 'tool') {
        return rateLimitedTool;
      }
      const value: unknown = Reflect.get(target, property, receiver);
      // Bind methods back to the real server: `McpServer` reads private
      // fields off `this`, which a bare proxy receiver cannot satisfy.
      return typeof value === 'function' ? (value as AnyHandler).bind(target) : value;
    },
  });
}
