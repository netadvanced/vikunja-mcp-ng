/**
 * `vikunja_teams update` strategy pair — #184 P3 step 6.
 *
 * The change under test is narrow and the risk is specific: dropping the
 * read-then-merge on the v2 path removes the client-side guard against
 * `docs/VIKUNJA_API_ISSUES.md` §3a, where go-vikunja writes `is_public` with
 * xorm's `UseBool` and therefore turns an omitted boolean into an explicit
 * `false`. Removing the guard is only safe because v2's `PATCH` does not have
 * the bug at all.
 *
 * Every version fact asserted here was probed against the live 2.4.0, 2.5.0 and
 * 2.6.0 stacks on 2026-09-05 (see the strategy doc comments for the table).
 * Notably: there is no `minVersion` floor for this operation, so the "selects
 * v2 on 2.4.0" test below is the deliberate opposite of task update's
 * "selects v1 on 2.4.0".
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';

jest.mock('../../../src/utils/vikunja-rest', () => ({
  vikunjaRestRequest: jest.fn(),
}));
jest.mock('../../../src/utils/vikunja-rest-v2', () => ({
  vikunjaRestV2Request: jest.fn(),
}));

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { AuthManager } from '../../../src/auth/AuthManager';
import { ConfigurationManager } from '../../../src/config/ConfigurationManager';
import { MCPError, ErrorCode } from '../../../src/types';
import { registerTeamsTool } from '../../../src/tools/teams';
import { TeamUpdateContext, selectTeamUpdateStrategy } from '../../../src/tools/teams/update';
import { buildTeamFieldPatch } from '../../../src/tools/teams/update/fields';
import { vikunjaRestRequest } from '../../../src/utils/vikunja-rest';
import { vikunjaRestV2Request } from '../../../src/utils/vikunja-rest-v2';

const mockRest = vikunjaRestRequest as jest.Mock;
const mockRestV2 = vikunjaRestV2Request as jest.Mock;

interface RestCall {
  method: string;
  path: string;
  body?: unknown;
}

/**
 * The stored team every test starts from: PUBLIC, with a description. Both
 * properties are the ones a partial v1 write used to destroy, so they are the
 * ones every assertion below watches.
 */
const STORED_TEAM = {
  id: 5,
  name: 'Design Guild',
  description: '<p>The design folks</p>',
  is_public: true,
  external_id: '',
  created: '2026-01-01T00:00:00Z',
  updated: '2026-01-01T00:00:00Z',
  members: [{ id: 1, username: 'owner', admin: true }],
};

function authManagerFor(options: {
  hasV2Api?: boolean;
  serverVersion?: string | undefined;
  withCapabilities?: boolean;
}): AuthManager {
  const authManager = new AuthManager();
  authManager.connect('https://vikunja.test', 'tk_test-token');
  if (options.withCapabilities !== false) {
    authManager.setCapabilities({
      features: {},
      hasV2Api: options.hasV2Api ?? true,
      ...(options.serverVersion !== undefined ? { serverVersion: options.serverVersion } : {}),
    });
  }
  return authManager;
}

/** Records every v1 REST call and answers reads with the stored team. */
function stubV1Rest(readResult: Record<string, unknown> = STORED_TEAM): RestCall[] {
  const calls: RestCall[] = [];
  mockRest.mockImplementation((...args: unknown[]) => {
    const [, method, path, body] = args as [unknown, string, string, unknown];
    calls.push({ method, path, body });
    return Promise.resolve(method === 'GET' ? readResult : { ...readResult, ...(body as object) });
  });
  return calls;
}

function stubV2Patch(result: Record<string, unknown>): RestCall[] {
  const calls: RestCall[] = [];
  mockRestV2.mockImplementation((...args: unknown[]) => {
    const [, method, path, body] = args as [unknown, string, string, unknown];
    calls.push({ method, path, body });
    return Promise.resolve(result);
  });
  return calls;
}

/** Registers the real tool and hands back its handler. */
function teamsToolHandler(authManager: AuthManager): (args: unknown) => Promise<{
  content: { text: string }[];
}> {
  const tool = jest.fn();
  registerTeamsTool({ tool } as unknown as McpServer, authManager);
  const call = tool.mock.calls[0] as unknown[];
  return call[call.length - 1] as (args: unknown) => Promise<{ content: { text: string }[] }>;
}

describe('team update strategy selection', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    ConfigurationManager.reset();
  });

  afterEach(() => {
    delete process.env.VIKUNJA_MCP_FORCE_V1_API;
    ConfigurationManager.reset();
  });

  // The point of this test is the contrast with task update, which pins a
  // 2.5.0 floor. PATCH /api/v2/teams/{id} was probed on the live 2.4.0 stack:
  // a name-only patch returned 200 and left is_public true, so there is no
  // floor to declare and the floor version is not special-cased.
  it('selects v2 on 2.4.0 — this route has no minVersion floor', () => {
    expect(selectTeamUpdateStrategy(authManagerFor({ serverVersion: 'v2.4.0' })).apiVersion).toBe(
      'v2',
    );
  });

  it('selects v2 on 2.5.0', () => {
    expect(selectTeamUpdateStrategy(authManagerFor({ serverVersion: 'v2.5.0' })).apiVersion).toBe(
      'v2',
    );
  });

  it('selects v2 on 2.6.0', () => {
    expect(new TeamUpdateContext(authManagerFor({ serverVersion: 'v2.6.0' })).apiVersion).toBe(
      'v2',
    );
  });

  it('selects v1 when the kill switch is on, even on 2.6.0', () => {
    process.env.VIKUNJA_MCP_FORCE_V1_API = 'true';
    ConfigurationManager.reset();

    expect(new TeamUpdateContext(authManagerFor({ serverVersion: 'v2.6.0' })).apiVersion).toBe(
      'v1',
    );
  });

  it('selects v1 when the server reports no v2 API', () => {
    expect(
      new TeamUpdateContext(authManagerFor({ hasV2Api: false, serverVersion: 'v2.6.0' }))
        .apiVersion,
    ).toBe('v1');
  });

  it('selects v1 when capability detection has not run for the session', () => {
    expect(new TeamUpdateContext(authManagerFor({ withCapabilities: false })).apiVersion).toBe(
      'v1',
    );
  });

  // Callers hold auth-manager-shaped objects that predate capability
  // detection; an update must degrade to the always-correct v1 path rather
  // than throw on a missing method.
  it('selects v1 for an auth manager that has no getCapabilities at all', () => {
    const bare = { getSession: () => ({}) } as unknown as AuthManager;

    expect(selectTeamUpdateStrategy(bare).apiVersion).toBe('v1');
  });

  // No minVersion is asked for, so an undetected version is not itself a
  // reason to stay on v1 here: a server that answers the v2 OpenAPI probe can
  // serve this route on every supported release.
  it('selects v2 when v2 is present but the version string is missing', () => {
    expect(new TeamUpdateContext(authManagerFor({ serverVersion: undefined })).apiVersion).toBe(
      'v2',
    );
  });
});

describe('v2 team update strategy', () => {
  let authManager: AuthManager;

  beforeEach(() => {
    jest.clearAllMocks();
    ConfigurationManager.reset();
    authManager = authManagerFor({ serverVersion: 'v2.6.0' });
  });

  afterEach(() => {
    ConfigurationManager.reset();
  });

  /**
   * The regression this whole item has to not cause, and the same one
   * `scripts/battle/scenarios/team-rename-keeps-visibility.json` guards live:
   * a rename must not un-publish a public team. v1 achieves that by sending
   * `is_public` back; v2 achieves it by never mentioning the column, so the
   * assertion is that the patch body contains ONLY the name.
   */
  it('renames without touching is_public — the field is absent from the patch body', async () => {
    const restCalls = stubV1Rest();
    const patchCalls = stubV2Patch({ ...STORED_TEAM, name: 'Design Chapter' });

    const result = await teamsToolHandler(authManager)({
      subcommand: 'update',
      id: 5,
      name: 'Design Chapter',
    });

    expect(patchCalls).toEqual([
      { method: 'PATCH', path: '/teams/5', body: { name: 'Design Chapter' } },
    ]);
    expect(Object.keys(patchCalls[0]?.body as object)).toEqual(['name']);
    // The whole point: no fetch-merge. Two calls become one.
    expect(restCalls).toHaveLength(0);
    expect(result.content[0]?.text).toContain('Team "Design Chapter" updated successfully');
  });

  it('patches a description alone, which the v1 route rejects for want of a name', async () => {
    stubV1Rest();
    const patchCalls = stubV2Patch({ ...STORED_TEAM, description: '<p>Rewritten</p>' });

    await teamsToolHandler(authManager)({
      subcommand: 'update',
      id: 5,
      description: '<p>Rewritten</p>',
    });

    expect(patchCalls).toEqual([
      { method: 'PATCH', path: '/teams/5', body: { description: '<p>Rewritten</p>' } },
    ]);
  });

  it('sends an explicit is_public: false, which is never conflated with omission', async () => {
    stubV1Rest();
    const patchCalls = stubV2Patch({ ...STORED_TEAM, is_public: false });

    await teamsToolHandler(authManager)({ subcommand: 'update', id: 5, isPublic: false });

    expect(patchCalls[0]?.body).toEqual({ is_public: false });
  });

  it('carries every supplied field in one patch', async () => {
    stubV1Rest();
    const patchCalls = stubV2Patch(STORED_TEAM);

    await teamsToolHandler(authManager)({
      subcommand: 'update',
      id: 5,
      name: 'Renamed',
      description: '<p>New</p>',
      isPublic: false,
    });

    expect(patchCalls[0]?.body).toEqual({
      name: 'Renamed',
      description: '<p>New</p>',
      is_public: false,
    });
  });

  it('strips max_permission so the payload cannot reveal which strategy ran', async () => {
    stubV1Rest();
    stubV2Patch({ ...STORED_TEAM, name: 'Renamed', max_permission: 2 });

    const result = await teamsToolHandler(authManager)({
      subcommand: 'update',
      id: 5,
      name: 'Renamed',
    });

    expect(result.content[0]?.text).not.toContain('max_permission');
    expect(result.content[0]?.text).toContain('Renamed');
  });

  it('re-reads the team when the server answers 304 because the patch changed nothing', async () => {
    const restCalls = stubV1Rest();
    mockRestV2.mockRejectedValue(
      new MCPError(ErrorCode.API_ERROR, 'HTTP 304 Not Modified', { statusCode: 304 }),
    );

    const result = await teamsToolHandler(authManager)({
      subcommand: 'update',
      id: 5,
      name: 'Design Guild',
    });

    expect(restCalls.map((call) => `${call.method} ${call.path}`)).toEqual(['GET /teams/5']);
    expect(result.content[0]?.text).toContain('Team "Design Guild" updated successfully');
  });

  it('propagates a real PATCH failure rather than swallowing it as a no-op', async () => {
    stubV1Rest();
    mockRestV2.mockRejectedValue(
      new MCPError(ErrorCode.API_ERROR, 'Vikunja REST request failed (PATCH /teams/5): HTTP 403', {
        statusCode: 403,
      }),
    );

    await expect(
      teamsToolHandler(authManager)({ subcommand: 'update', id: 5, name: 'Renamed' }),
    ).rejects.toThrow(/HTTP 403/);
  });

  it('still reports only the caller’s deltas as affectedFields', async () => {
    stubV1Rest();
    stubV2Patch({ ...STORED_TEAM, name: 'Renamed' });

    const result = await teamsToolHandler(authManager)({
      subcommand: 'update',
      id: 5,
      name: 'Renamed',
    });

    const affected = /\*\*affectedFields:\*\* \[([^\]]*)\]/.exec(result.content[0]?.text ?? '');
    expect(affected?.[1]).toContain('"name"');
    // The team body carries is_public; the metadata must not claim we wrote it.
    expect(affected?.[1]).not.toContain('is_public');
  });
});

describe('v1 team update strategy (kill switch, no v2, undetected session)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    ConfigurationManager.reset();
  });

  afterEach(() => {
    delete process.env.VIKUNJA_MCP_FORCE_V1_API;
    ConfigurationManager.reset();
  });

  /**
   * The floor, unchanged: read the team, POST the whole merged model back. The
   * assertion that matters is `is_public: true` in the write body — without it
   * `UseBool` writes the column as false and the team is silently un-published.
   */
  it('reads then POSTs the whole merged model, carrying is_public and name', async () => {
    process.env.VIKUNJA_MCP_FORCE_V1_API = 'true';
    ConfigurationManager.reset();
    const restCalls = stubV1Rest();
    stubV2Patch(STORED_TEAM);

    const result = await teamsToolHandler(authManagerFor({ serverVersion: 'v2.6.0' }))({
      subcommand: 'update',
      id: 5,
      description: '<p>Rewritten</p>',
    });

    expect(mockRestV2).not.toHaveBeenCalled();
    expect(restCalls.map((call) => `${call.method} ${call.path}`)).toEqual([
      'GET /teams/5',
      'POST /teams/5',
    ]);
    expect(restCalls[1]?.body).toEqual({ ...STORED_TEAM, description: '<p>Rewritten</p>' });
    expect(result.content[0]?.text).toContain('updated successfully');
  });

  it('produces the same canonical team shape as the v2 path', async () => {
    const patched = { ...STORED_TEAM, name: 'Renamed' };

    stubV1Rest();
    stubV2Patch(patched);
    const viaV2 = await teamsToolHandler(authManagerFor({ serverVersion: 'v2.6.0' }))({
      subcommand: 'update',
      id: 5,
      name: 'Renamed',
    });

    jest.clearAllMocks();
    process.env.VIKUNJA_MCP_FORCE_V1_API = 'true';
    ConfigurationManager.reset();
    stubV1Rest();
    const viaV1 = await teamsToolHandler(authManagerFor({ serverVersion: 'v2.6.0' }))({
      subcommand: 'update',
      id: 5,
      name: 'Renamed',
    });

    // Everything but the response's own clock reading has to match.
    const withoutTimestamp = (text: string): string =>
      text.replace(/\*\*timestamp:\*\* \S+/, '**timestamp:** <fixed>');
    expect(withoutTimestamp(viaV1.content[0]?.text ?? '')).toEqual(
      withoutTimestamp(viaV2.content[0]?.text ?? ''),
    );
  });
});

describe('buildTeamFieldPatch', () => {
  it('maps the tool’s camelCase onto the wire’s snake_case', () => {
    expect(buildTeamFieldPatch({ name: 'n', description: 'd', isPublic: true })).toEqual({
      name: 'n',
      description: 'd',
      is_public: true,
    });
  });

  it('omits what the caller did not mention', () => {
    expect(buildTeamFieldPatch({ name: 'n' })).toEqual({ name: 'n' });
  });

  it('keeps an explicit false rather than treating it as absent', () => {
    expect(buildTeamFieldPatch({ isPublic: false })).toEqual({ is_public: false });
  });

  it('keeps an empty description, which is a request to clear it', () => {
    expect(buildTeamFieldPatch({ description: '' })).toEqual({ description: '' });
  });
});
