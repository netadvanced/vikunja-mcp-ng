/**
 * `vikunja_labels update` strategy pair — #184 P3 step 6.
 *
 * Every version fact asserted here was probed against the live 2.4.0, 2.5.0
 * and 2.6.0 stacks on 2026-09-05, and two of them contradict the vendored v1
 * OpenAPI spec:
 *
 *   - `PUT /api/v1/labels/{id}` (what the spec declares and the tool used to
 *     send) answers 405 on every supported version. The server routes
 *     `POST /api/v1/labels/{id}`.
 *   - That `POST` is a full model replace. Sending only `hex_color` came back
 *     with `title` and `description` blanked.
 *
 * So the v1 path has to read before it writes, the v2 path is a single
 * `PATCH`, and the call shapes genuinely differ. There is no `minVersion`
 * floor: v2 `PATCH` applied the change and preserved unmentioned fields on all
 * three versions.
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';

jest.mock('../../src/utils/vikunja-rest', () => ({
  vikunjaRestRequest: jest.fn(),
}));
jest.mock('../../src/utils/vikunja-rest-v2', () => ({
  vikunjaRestV2Request: jest.fn(),
}));

import { AuthManager } from '../../src/auth/AuthManager';
import { ConfigurationManager } from '../../src/config/ConfigurationManager';
import { MCPError, ErrorCode } from '../../src/types';
import {
  LabelUpdateContext,
  selectLabelUpdateStrategy,
  mergeLabelForReplace,
  V1LabelUpdateStrategy,
  V2LabelUpdateStrategy,
} from '../../src/utils/label-update';
import { vikunjaRestRequest } from '../../src/utils/vikunja-rest';
import { vikunjaRestV2Request } from '../../src/utils/vikunja-rest-v2';

const mockRest = vikunjaRestRequest as jest.Mock;
const mockRestV2 = vikunjaRestV2Request as jest.Mock;

interface RestCall {
  method: string;
  path: string;
  body?: unknown;
}

/** The label both strategies start from, and what a plain read returns. */
const BASE_LABEL = {
  id: 5,
  title: 'Original title',
  description: 'Original description',
  hex_color: 'aabbcc',
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

/** Records every v1 REST call; reads answer with the label, writes echo the body. */
function stubV1Rest(readResult: Record<string, unknown> = BASE_LABEL): RestCall[] {
  const calls: RestCall[] = [];
  mockRest.mockImplementation((...args: unknown[]) => {
    const [, method, path, body] = args as [unknown, string, string, unknown];
    calls.push({ method, path, body });
    if (method === 'GET') {
      return Promise.resolve(readResult);
    }
    return Promise.resolve({ ...readResult, ...(body as Record<string, unknown>) });
  });
  return calls;
}

function stubV2Patch(result: unknown): RestCall[] {
  const calls: RestCall[] = [];
  mockRestV2.mockImplementation((...args: unknown[]) => {
    const [, method, path, body] = args as [unknown, string, string, unknown];
    calls.push({ method, path, body });
    return Promise.resolve(result);
  });
  return calls;
}

describe('label update strategy selection', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    ConfigurationManager.reset();
  });

  afterEach(() => {
    delete process.env.VIKUNJA_MCP_FORCE_V1_API;
    ConfigurationManager.reset();
  });

  // No minVersion floor: v2 PATCH /labels/{id} behaved identically on all
  // three supported versions, so 2.4.0 gets v2 too. The 2.5.0 floor on task
  // update comes from the subscription-422, which does not exist here.
  it.each(['v2.4.0', 'v2.5.0', 'v2.6.0'])('selects v2 on %s', (serverVersion) => {
    expect(selectLabelUpdateStrategy(authManagerFor({ serverVersion })).apiVersion).toBe('v2');
  });

  it('selects v1 when the kill switch is on, even on 2.6.0', () => {
    process.env.VIKUNJA_MCP_FORCE_V1_API = 'true';
    ConfigurationManager.reset();

    expect(new LabelUpdateContext(authManagerFor({ serverVersion: 'v2.6.0' })).apiVersion).toBe(
      'v1',
    );
  });

  it('selects v1 when the server reports no v2 API', () => {
    expect(
      new LabelUpdateContext(authManagerFor({ hasV2Api: false, serverVersion: 'v2.6.0' }))
        .apiVersion,
    ).toBe('v1');
  });

  it('selects v1 when capability detection has not run for the session', () => {
    expect(new LabelUpdateContext(authManagerFor({ withCapabilities: false })).apiVersion).toBe(
      'v1',
    );
  });

  // Unlike task update, an undetected server version is not itself a reason to
  // stay on v1 here: with no floor to compare against, the capability probe is
  // the whole test.
  it('still selects v2 when the version is unknown but v2 was probed', () => {
    expect(new LabelUpdateContext(authManagerFor({ serverVersion: undefined })).apiVersion).toBe(
      'v2',
    );
  });

  it('selects v1 for an auth manager that has no getCapabilities at all', () => {
    const bare = { getSession: () => ({}) } as unknown as AuthManager;

    expect(selectLabelUpdateStrategy(bare).apiVersion).toBe('v1');
  });
});

describe('mergeLabelForReplace', () => {
  it('lays the update over the current label', () => {
    expect(mergeLabelForReplace(BASE_LABEL, { title: 'New' })).toEqual({
      title: 'New',
      description: 'Original description',
      hex_color: 'aabbcc',
    });
  });

  it('treats an empty description as a value, not an omission', () => {
    expect(mergeLabelForReplace(BASE_LABEL, { description: '' })).toEqual({
      title: 'Original title',
      description: '',
      hex_color: 'aabbcc',
    });
  });

  it('omits fields absent from both the update and the current label', () => {
    expect(
      mergeLabelForReplace({ id: 5, title: 'Only a title' }, { hex_color: '#00ff00' }),
    ).toEqual({
      title: 'Only a title',
      hex_color: '#00ff00',
    });
  });

  // models.Label marks every writable field optional, so a label the API
  // returned without one must not turn into an explicit `undefined` in the
  // replace body, which would blank it.
  it('sends nothing for a field neither side has', () => {
    expect(mergeLabelForReplace({ id: 5 }, { description: 'Only a description' })).toEqual({
      description: 'Only a description',
    });
  });

  it('never echoes server-owned fields back', () => {
    const merged = mergeLabelForReplace(
      { ...BASE_LABEL, created: '2026-01-01T00:00:00Z', created_by: { id: 1 } },
      { title: 'New' },
    );

    expect(Object.keys(merged).sort()).toEqual(['description', 'hex_color', 'title']);
  });
});

describe('v1 label update strategy', () => {
  let authManager: AuthManager;

  beforeEach(() => {
    jest.clearAllMocks();
    ConfigurationManager.reset();
    authManager = authManagerFor({ hasV2Api: false });
  });

  /**
   * The route correction. `PUT /labels/{id}` is 405 on every supported server
   * despite what docs/vikunja-openapi.json says, so this pins the verb the
   * server actually routes.
   */
  it('reads the label, then POSTs the merged model back', async () => {
    const calls = stubV1Rest();

    await new V1LabelUpdateStrategy().execute({
      authManager,
      labelId: 5,
      updates: { title: 'Renamed' },
    });

    expect(calls).toEqual([
      { method: 'GET', path: '/labels/5', body: undefined },
      {
        method: 'POST',
        path: '/labels/5',
        body: { title: 'Renamed', description: 'Original description', hex_color: 'aabbcc' },
      },
    ]);
  });

  // v1's POST is a full replace: without the read, a hex-only update comes
  // back with an empty title. Verified live on 2.6.0.
  it('carries unmentioned fields through so the replace does not blank them', async () => {
    const calls = stubV1Rest();

    const label = await new V1LabelUpdateStrategy().execute({
      authManager,
      labelId: 5,
      updates: { hex_color: '#00ff00' },
    });

    expect(calls[1]?.body).toEqual({
      title: 'Original title',
      description: 'Original description',
      hex_color: '#00ff00',
    });
    expect(label.title).toBe('Original title');
  });

  it('never touches the v2 transport', async () => {
    stubV1Rest();

    await new V1LabelUpdateStrategy().execute({
      authManager,
      labelId: 5,
      updates: { title: 'Renamed' },
    });

    expect(mockRestV2).not.toHaveBeenCalled();
  });
});

describe('v2 label update strategy', () => {
  let authManager: AuthManager;

  beforeEach(() => {
    jest.clearAllMocks();
    ConfigurationManager.reset();
    authManager = authManagerFor({ serverVersion: 'v2.6.0' });
  });

  it('sends one PATCH carrying only the changed fields', async () => {
    const patched = { ...BASE_LABEL, title: 'Renamed' };
    const calls = stubV2Patch(patched);
    stubV1Rest();

    const label = await new V2LabelUpdateStrategy().execute({
      authManager,
      labelId: 5,
      updates: { title: 'Renamed' },
    });

    expect(calls).toEqual([{ method: 'PATCH', path: '/labels/5', body: { title: 'Renamed' } }]);
    expect(label).toEqual(patched);
  });

  // The payoff: no read before the write, so the two-call v1 sequence becomes
  // one call and the read-modify-write race disappears.
  it('does not read the label first', async () => {
    stubV2Patch({ ...BASE_LABEL, hex_color: '#00ff00' });
    stubV1Rest();

    await new V2LabelUpdateStrategy().execute({
      authManager,
      labelId: 5,
      updates: { hex_color: '#00ff00' },
    });

    expect(mockRest).not.toHaveBeenCalled();
  });

  it('returns the PATCH response as the canonical result, with no trailing re-read', async () => {
    stubV2Patch({ ...BASE_LABEL, title: 'Renamed' });
    const v1Calls = stubV1Rest();

    const label = await new V2LabelUpdateStrategy().execute({
      authManager,
      labelId: 5,
      updates: { title: 'Renamed' },
    });

    expect(v1Calls).toEqual([]);
    expect(label).toEqual({ ...BASE_LABEL, title: 'Renamed' });
  });

  // A patch that would change nothing answers 304 with an empty body, which
  // the transport surfaces as an MCPError because 304 is not response.ok.
  // Confirmed live on 2.6.0. The caller still expects a label back.
  it('reads the label when the server answers 304 Not Modified', async () => {
    mockRestV2.mockRejectedValue(
      new MCPError(ErrorCode.API_ERROR, 'HTTP 304 Not Modified', { statusCode: 304 }),
    );
    const v1Calls = stubV1Rest();

    const label = await new V2LabelUpdateStrategy().execute({
      authManager,
      labelId: 5,
      updates: { title: BASE_LABEL.title },
    });

    expect(v1Calls).toEqual([{ method: 'GET', path: '/labels/5', body: undefined }]);
    expect(label).toEqual(BASE_LABEL);
  });

  it('rethrows any other error rather than falling back to a read', async () => {
    mockRestV2.mockRejectedValue(
      new MCPError(ErrorCode.API_ERROR, 'HTTP 403 Forbidden', { statusCode: 403 }),
    );
    const v1Calls = stubV1Rest();

    await expect(
      new V2LabelUpdateStrategy().execute({
        authManager,
        labelId: 5,
        updates: { title: 'Renamed' },
      }),
    ).rejects.toThrow('HTTP 403');
    expect(v1Calls).toEqual([]);
  });

  it('rethrows a non-MCPError unchanged', async () => {
    mockRestV2.mockRejectedValue(new Error('socket hang up'));
    stubV1Rest();

    await expect(
      new V2LabelUpdateStrategy().execute({
        authManager,
        labelId: 5,
        updates: { title: 'Renamed' },
      }),
    ).rejects.toThrow('socket hang up');
  });
});

describe('label update context', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    ConfigurationManager.reset();
  });

  afterEach(() => {
    delete process.env.VIKUNJA_MCP_FORCE_V1_API;
    ConfigurationManager.reset();
  });

  // Both paths must hand the caller the same thing, so nothing downstream can
  // tell which strategy ran.
  it('returns the same canonical label whichever strategy runs', async () => {
    const expected = { ...BASE_LABEL, title: 'Renamed' };

    stubV1Rest(expected);
    const viaV1 = await new LabelUpdateContext(authManagerFor({ hasV2Api: false })).execute({
      authManager: authManagerFor({ hasV2Api: false }),
      labelId: 5,
      updates: { title: 'Renamed' },
    });

    jest.clearAllMocks();
    stubV2Patch(expected);
    const viaV2 = await new LabelUpdateContext(authManagerFor({ serverVersion: 'v2.6.0' })).execute(
      {
        authManager: authManagerFor({ serverVersion: 'v2.6.0' }),
        labelId: 5,
        updates: { title: 'Renamed' },
      },
    );

    expect(viaV2).toEqual(viaV1);
  });

  it('routes through v1 when the kill switch is on', async () => {
    process.env.VIKUNJA_MCP_FORCE_V1_API = 'true';
    ConfigurationManager.reset();
    const authManager = authManagerFor({ serverVersion: 'v2.6.0' });
    const calls = stubV1Rest();
    stubV2Patch(BASE_LABEL);

    await new LabelUpdateContext(authManager).execute({
      authManager,
      labelId: 5,
      updates: { title: 'Renamed' },
    });

    expect(calls.map((call) => call.method)).toEqual(['GET', 'POST']);
    expect(mockRestV2).not.toHaveBeenCalled();
  });
});
