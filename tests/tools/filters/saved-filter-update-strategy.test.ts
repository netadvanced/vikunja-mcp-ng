/**
 * `vikunja_filters update` strategy pair, #184 P3 step 6.
 *
 * v1 has no partial update for a saved filter: `POST /filters/{id}` replaces
 * the resource, so the tool has always read the filter first and written the
 * whole model back. v2 has a real `PATCH /filters/{filter}`, and unlike the
 * task-update case it works on every supported release, so this operation
 * carries no version floor.
 *
 * Every version fact asserted here was probed against the live 2.4.0, 2.5.0
 * and 2.6.0 stacks on 2026-09-05 (see the strategy doc comments): partial
 * field patches apply, the `filters` sub-object merges per key rather than
 * being replaced wholesale, `is_favorite: false` sticks, a no-op answers 304,
 * and a missing filter answers 404.
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';

jest.mock('../../../src/utils/vikunja-rest', () => ({
  vikunjaRestRequest: jest.fn(),
}));
jest.mock('../../../src/utils/vikunja-rest-v2', () => ({
  vikunjaRestV2Request: jest.fn(),
}));
jest.mock('../../../src/utils/logger');

import { registerFiltersTool } from '../../../src/tools/filters';
import { AuthManager } from '../../../src/auth/AuthManager';
import { ConfigurationManager } from '../../../src/config/ConfigurationManager';
import { MCPError, ErrorCode } from '../../../src/types';
import {
  SavedFilterUpdateContext,
  selectSavedFilterUpdateStrategy,
} from '../../../src/tools/filters/update';
import { buildSavedFilterUpdatePayload } from '../../../src/tools/filters/update/V1SavedFilterUpdateStrategy';
import { buildSavedFilterPatchBody } from '../../../src/tools/filters/update/V2SavedFilterUpdateStrategy';
import { vikunjaRestRequest } from '../../../src/utils/vikunja-rest';
import { vikunjaRestV2Request } from '../../../src/utils/vikunja-rest-v2';
import type { MockServer } from '../../types/mocks';

const mockRest = vikunjaRestRequest as jest.Mock;
const mockRestV2 = vikunjaRestV2Request as jest.Mock;

interface RestCall {
  method: string;
  path: string;
  body?: unknown;
}

/** The saved filter both strategies start from, and what a plain read returns. */
const BASE_FILTER = {
  id: 4,
  title: 'Original title',
  description: 'Original description',
  is_favorite: true,
  owner: { id: 1, username: 'alice' },
  created: '2024-01-01T00:00:00Z',
  updated: '2024-01-01T00:00:00Z',
  // The collection options that live beside the query string. v2 merges the
  // `filters` object per key, so these must survive a query-only patch.
  filters: {
    filter: 'done = false',
    s: 'needle',
    sort_by: ['priority'],
    order_by: ['desc'],
    filter_include_nulls: true,
  },
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

/** Records every v1 REST call and answers reads with the current filter. */
function stubV1Rest(readResult: Record<string, unknown> = BASE_FILTER): RestCall[] {
  const calls: RestCall[] = [];
  mockRest.mockImplementation((...args: unknown[]) => {
    const [, method, path, body] = args as [unknown, string, string, unknown];
    calls.push({ method, path, body });
    if (method === 'GET') {
      return Promise.resolve(readResult);
    }
    return Promise.resolve(readResult);
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

/** Registers the tool against one auth manager and returns its handler. */
function handlerFor(authManager: AuthManager): (args: unknown) => Promise<{
  content: { text: string }[];
}> {
  const server = { tool: jest.fn() } as unknown as MockServer;
  registerFiltersTool(server, authManager);
  const call = (server.tool as jest.Mock).mock.calls[0] as unknown[];
  return call[call.length - 1] as (args: unknown) => Promise<{ content: { text: string }[] }>;
}

describe('saved filter update strategy selection', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    ConfigurationManager.reset();
  });

  afterEach(() => {
    delete process.env.VIKUNJA_MCP_FORCE_V1_API;
    ConfigurationManager.reset();
  });

  // The point of the probe: no minVersion floor. 2.4.0's PATCH /filters is
  // sound, unlike its PATCH /tasks, so it gets v2 too.
  it('selects v2 on 2.4.0, the support floor, because its PATCH /filters is sound', () => {
    expect(
      selectSavedFilterUpdateStrategy(authManagerFor({ serverVersion: 'v2.4.0' })).apiVersion,
    ).toBe('v2');
  });

  it('selects v2 on 2.5.0', () => {
    expect(
      new SavedFilterUpdateContext(authManagerFor({ serverVersion: 'v2.5.0' })).apiVersion,
    ).toBe('v2');
  });

  it('selects v2 on 2.6.0', () => {
    expect(
      new SavedFilterUpdateContext(authManagerFor({ serverVersion: 'v2.6.0' })).apiVersion,
    ).toBe('v2');
  });

  it('selects v1 when the kill switch is on, even on 2.6.0', () => {
    process.env.VIKUNJA_MCP_FORCE_V1_API = 'true';
    ConfigurationManager.reset();

    expect(
      new SavedFilterUpdateContext(authManagerFor({ serverVersion: 'v2.6.0' })).apiVersion,
    ).toBe('v1');
  });

  // No floor is set, so an undetected version is not disqualifying on its own;
  // what still selects v1 is a session with no capability snapshot at all.
  it('selects v2 when v2 is present but the server version could not be detected', () => {
    expect(
      new SavedFilterUpdateContext(authManagerFor({ serverVersion: undefined })).apiVersion,
    ).toBe('v2');
  });

  it('selects v1 when the server reports no v2 API', () => {
    expect(
      new SavedFilterUpdateContext(authManagerFor({ hasV2Api: false, serverVersion: 'v2.6.0' }))
        .apiVersion,
    ).toBe('v1');
  });

  it('selects v1 when capability detection has not run for the session', () => {
    expect(
      new SavedFilterUpdateContext(authManagerFor({ withCapabilities: false })).apiVersion,
    ).toBe('v1');
  });

  it('selects v1 for an auth manager that has no getCapabilities at all', () => {
    const bare = { getSession: () => ({}) } as unknown as AuthManager;

    expect(selectSavedFilterUpdateStrategy(bare).apiVersion).toBe('v1');
  });
});

describe('v2 saved filter update strategy', () => {
  let handler: (args: unknown) => Promise<{ content: { text: string }[] }>;

  beforeEach(() => {
    jest.clearAllMocks();
    ConfigurationManager.reset();
    handler = handlerFor(authManagerFor({ serverVersion: 'v2.6.0' }));
  });

  afterEach(() => {
    ConfigurationManager.reset();
  });

  it('applies a field-only update in one PATCH, with no read and no full model', async () => {
    stubV1Rest();
    const patchCalls = stubV2Patch({ ...BASE_FILTER, title: 'Renamed' });

    const result = await handler({ action: 'update', parameters: { id: 4, title: 'Renamed' } });

    expect(mockRest).not.toHaveBeenCalled();
    expect(patchCalls).toEqual([
      { method: 'PATCH', path: '/filters/4', body: { title: 'Renamed' } },
    ]);
    expect(result.content[0]?.text).toContain('updated successfully');
  });

  it('leaves fields the caller did not mention out of the patch body entirely', async () => {
    stubV1Rest();
    const patchCalls = stubV2Patch({ ...BASE_FILTER, description: 'New description' });

    await handler({ action: 'update', parameters: { id: 4, description: 'New description' } });

    expect(patchCalls[0]?.body).toEqual({ description: 'New description' });
    expect(patchCalls[0]?.body).not.toHaveProperty('title');
    expect(patchCalls[0]?.body).not.toHaveProperty('filters');
  });

  /**
   * The reason the v1 fetch-merge can be dropped rather than merely moved:
   * v2 merges the `filters` object key by key, so sending `filter` alone
   * preserves the stored `s`, `sort_by`, `order_by` and
   * `filter_include_nulls` server-side (verified live on all three versions).
   */
  it('sends the query string alone and relies on v2 to preserve the other collection options', async () => {
    stubV1Rest();
    const patchCalls = stubV2Patch(BASE_FILTER);

    await handler({ action: 'update', parameters: { id: 4, filter: 'startDate > now' } });

    expect(patchCalls[0]?.body).toEqual({ filters: { filter: 'start_date > now' } });
  });

  it('rebuilds the filter from structured conditions when supplied instead of a string', async () => {
    stubV1Rest();
    const patchCalls = stubV2Patch(BASE_FILTER);

    await handler({
      action: 'update',
      parameters: {
        id: 4,
        conditions: [
          { field: 'priority', operator: '=', value: 5 },
          { field: 'priority', operator: '=', value: 1 },
        ],
        groupOperator: '||',
      },
    });

    expect(patchCalls[0]?.body).toEqual({
      filters: { filter: '(priority = 5 || priority = 1)' },
    });
  });

  it('sends is_favorite:false rather than dropping a falsy value', async () => {
    stubV1Rest();
    const patchCalls = stubV2Patch({ ...BASE_FILTER, is_favorite: false });

    await handler({ action: 'update', parameters: { id: 4, isFavorite: false } });

    expect(patchCalls[0]?.body).toEqual({ is_favorite: false });
  });

  it('rejects an invalid filter query before any request is made', async () => {
    stubV1Rest();
    stubV2Patch(BASE_FILTER);

    const result = await handler({
      action: 'update',
      parameters: { id: 4, conditions: [{ field: 'done', operator: '>', value: true }] },
    });

    expect(result.content[0]?.text).toContain('Invalid filter');
    expect(mockRestV2).not.toHaveBeenCalled();
  });

  it('re-reads the filter when the server answers 304 because the patch changed nothing', async () => {
    const restCalls = stubV1Rest({ ...BASE_FILTER, title: 'Original title' });
    mockRestV2.mockRejectedValue(
      new MCPError(ErrorCode.API_ERROR, 'HTTP 304 Not Modified', { statusCode: 304 }),
    );

    const result = await handler({
      action: 'update',
      parameters: { id: 4, title: 'Original title' },
    });

    expect(restCalls).toEqual([{ method: 'GET', path: '/filters/4', body: undefined }]);
    expect(result.content[0]?.text).toContain('Original title');
  });

  it('skips the PATCH entirely and reads instead when the caller changed nothing', async () => {
    const restCalls = stubV1Rest();
    stubV2Patch(BASE_FILTER);

    await handler({ action: 'update', parameters: { id: 4, filter: '', conditions: [] } });

    expect(mockRestV2).not.toHaveBeenCalled();
    expect(restCalls).toEqual([{ method: 'GET', path: '/filters/4', body: undefined }]);
  });

  it('maps a 404 from the PATCH to the same NOT_FOUND message the read produces', async () => {
    stubV1Rest();
    mockRestV2.mockRejectedValue(
      new MCPError(
        ErrorCode.API_ERROR,
        'Vikunja REST request failed (PATCH /filters/404): HTTP 404 Not Found',
        { statusCode: 404 },
      ),
    );

    const result = await handler({ action: 'update', parameters: { id: 404, title: 'X' } });

    expect(result.content[0]?.text).toContain(
      'Filter with id 404 not found (or you do not have access to it)',
    );
  });

  it('propagates a real PATCH failure rather than swallowing it as a no-op', async () => {
    stubV1Rest();
    mockRestV2.mockRejectedValue(
      new MCPError(
        ErrorCode.API_ERROR,
        'Vikunja REST request failed (PATCH /filters/4): HTTP 422',
        { statusCode: 422 },
      ),
    );

    const result = await handler({ action: 'update', parameters: { id: 4, title: 'X' } });

    expect(result.content[0]?.text).toContain('HTTP 422');
    expect(mockRest).not.toHaveBeenCalled();
  });

  it('strips v2-only fields so the filter is shaped exactly like a v1 one', async () => {
    stubV1Rest();
    stubV2Patch({ ...BASE_FILTER, title: 'Renamed', max_permission: 2 });

    const result = await handler({ action: 'update', parameters: { id: 4, title: 'Renamed' } });

    expect(result.content[0]?.text).not.toContain('max_permission');
  });
});

/**
 * The two body builders, exercised directly. Both are the point at which the
 * v1/v2 difference becomes concrete (one carries the whole model forward, the
 * other carries only what changed), so the field-by-field behaviour is pinned
 * here rather than inferred from a rendered response.
 */
describe('saved filter request bodies', () => {
  it('carries every untouched field forward on v1, because POST replaces the resource', () => {
    expect(buildSavedFilterUpdatePayload(BASE_FILTER, { title: 'Renamed' })).toEqual({
      title: 'Renamed',
      description: 'Original description',
      is_favorite: true,
      filters: BASE_FILTER.filters,
    });
  });

  it('prefers the caller value over the stored one for every field on v1', () => {
    expect(
      buildSavedFilterUpdatePayload(BASE_FILTER, {
        title: 'Renamed',
        description: 'New description',
        isFavorite: false,
        filterQuery: 'priority >= 4',
      }),
    ).toEqual({
      title: 'Renamed',
      description: 'New description',
      is_favorite: false,
      // The stored collection options survive because v1 spreads them; only
      // the query string is overwritten.
      filters: { ...BASE_FILTER.filters, filter: 'priority >= 4' },
    });
  });

  // A filter the server returned without a title is not a shape the API
  // documents, but `title` is required in the payload, so v1 has always sent
  // an empty string rather than omitting the key and getting a 412.
  it('falls back to an empty title on v1 when neither the caller nor the server has one', () => {
    expect(buildSavedFilterUpdatePayload({ id: 4 }, {})).toEqual({ title: '', filters: {} });
  });

  it('sends nothing at all on v2 when the caller changed nothing', () => {
    expect(buildSavedFilterPatchBody({})).toEqual({});
  });

  it('sends every supplied field and no others on v2', () => {
    expect(
      buildSavedFilterPatchBody({
        title: 'Renamed',
        description: 'New description',
        isFavorite: false,
        filterQuery: 'priority >= 4',
      }),
    ).toEqual({
      title: 'Renamed',
      description: 'New description',
      is_favorite: false,
      filters: { filter: 'priority >= 4' },
    });
  });
});

describe('v1 saved filter update strategy', () => {
  let handler: (args: unknown) => Promise<{ content: { text: string }[] }>;

  beforeEach(() => {
    jest.clearAllMocks();
    ConfigurationManager.reset();
    handler = handlerFor(authManagerFor({ hasV2Api: false }));
  });

  afterEach(() => {
    ConfigurationManager.reset();
  });

  it('keeps the fetch-merge-POST sequence and never touches the v2 transport', async () => {
    const restCalls = stubV1Rest();

    await handler({ action: 'update', parameters: { id: 4, title: 'Renamed' } });

    expect(mockRestV2).not.toHaveBeenCalled();
    expect(restCalls.map((call) => `${call.method} ${call.path}`)).toEqual([
      'GET /filters/4',
      'POST /filters/4',
    ]);
    // The full model goes back, which is why v1 has to read first.
    expect(restCalls[1]?.body).toEqual({
      title: 'Renamed',
      description: 'Original description',
      is_favorite: true,
      filters: BASE_FILTER.filters,
    });
  });

  it('still reads the filter before rejecting invalid conditions, as it always has', async () => {
    const restCalls = stubV1Rest();

    const result = await handler({
      action: 'update',
      parameters: { id: 4, conditions: [{ field: 'done', operator: '>', value: true }] },
    });

    expect(result.content[0]?.text).toContain('Invalid filter');
    expect(restCalls).toEqual([{ method: 'GET', path: '/filters/4', body: undefined }]);
  });

  it('is what the kill switch selects on a v2-capable server', async () => {
    process.env.VIKUNJA_MCP_FORCE_V1_API = 'true';
    ConfigurationManager.reset();
    const forced = handlerFor(authManagerFor({ serverVersion: 'v2.6.0' }));
    const restCalls = stubV1Rest();

    await forced({ action: 'update', parameters: { id: 4, title: 'Renamed' } });

    expect(mockRestV2).not.toHaveBeenCalled();
    expect(restCalls.map((call) => `${call.method} ${call.path}`)).toEqual([
      'GET /filters/4',
      'POST /filters/4',
    ]);

    delete process.env.VIKUNJA_MCP_FORCE_V1_API;
    ConfigurationManager.reset();
  });
});

describe('canonical shape parity between the strategies', () => {
  afterEach(() => {
    ConfigurationManager.reset();
    jest.restoreAllMocks();
  });

  /**
   * The hard constraint: a caller cannot tell which strategy ran. Same
   * arguments, same filter on the server, same rendered response, including
   * the `affectedFields` metadata, which is computed once for both paths.
   */
  it('renders an identical response for the same logical update on v1 and v2', async () => {
    const updatedFilter = { ...BASE_FILTER, title: 'Renamed' };
    jest.spyOn(Date.prototype, 'toISOString').mockReturnValue('2026-09-05T12:00:00.000Z');

    jest.clearAllMocks();
    ConfigurationManager.reset();
    mockRest.mockImplementation((...args: unknown[]) => {
      const [, method] = args as [unknown, string];
      return Promise.resolve(method === 'GET' ? BASE_FILTER : updatedFilter);
    });
    const v1Result = await handlerFor(authManagerFor({ hasV2Api: false }))({
      action: 'update',
      parameters: { id: 4, title: 'Renamed' },
    });

    jest.clearAllMocks();
    ConfigurationManager.reset();
    mockRest.mockResolvedValue(BASE_FILTER);
    mockRestV2.mockResolvedValue({ ...updatedFilter, max_permission: 2 });
    const v2Result = await handlerFor(authManagerFor({ serverVersion: 'v2.6.0' }))({
      action: 'update',
      parameters: { id: 4, title: 'Renamed' },
    });

    expect(v2Result).toEqual(v1Result);
  });

  /**
   * The affectedFields reporting is version-independent by construction, so
   * the LOW-4 rule (present-but-empty arguments are not changes) holds on the
   * v2 path without a second implementation to keep in step.
   */
  it('reports the same affectedFields on v2 as on v1 for present-but-empty arguments', async () => {
    jest.clearAllMocks();
    ConfigurationManager.reset();
    stubV1Rest();
    stubV2Patch({ ...BASE_FILTER, title: 'Renamed' });

    const result = await handlerFor(authManagerFor({ serverVersion: 'v2.6.0' }))({
      action: 'update',
      parameters: { id: 4, title: 'Renamed', filter: '', conditions: [] },
    });

    const markdown = result.content[0]?.text ?? '';
    const affected = markdown.split('**affectedFields:**')[1]?.split('**filter:**')[0] ?? '';
    expect(affected).toContain('title');
    expect(affected).not.toContain('conditions');
  });
});
