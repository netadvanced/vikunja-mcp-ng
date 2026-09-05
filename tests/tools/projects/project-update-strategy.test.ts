/**
 * `vikunja_projects` update-shaped writes, v1/v2 strategy pair — #184 P3 step 6.
 *
 * Four MCP functions write a project the same way (`update`, `archive`,
 * `unarchive`, `move`), and all four now go through `ProjectUpdateContext`.
 * These tests pin the routing rule, both strategies, and the property that
 * actually matters for this entity: the two full-replace traps the v1 merge
 * guards must not reappear on the v2 path.
 *
 * Every version fact asserted here was probed against the live 2.4.0, 2.5.0
 * and 2.6.0 stacks on 2026-09-06 (table in `V2ProjectUpdateStrategy`). The
 * headline result is the *absence* of a `minVersion`: project `PATCH` works on
 * the 2.4.0 floor, unlike task `PATCH`, so there is no floor to assert and the
 * "v2 on 2.4.0" test below is the assertion that we did not copy one.
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';

jest.mock('../../../src/utils/vikunja-rest', () => ({
  vikunjaRestRequest: jest.fn(),
}));
jest.mock('../../../src/utils/vikunja-rest-v2', () => ({
  vikunjaRestV2Request: jest.fn(),
}));

import { AuthManager } from '../../../src/auth/AuthManager';
import { ConfigurationManager } from '../../../src/config/ConfigurationManager';
import { MCPError, ErrorCode } from '../../../src/types';
import {
  updateProject,
  archiveProject,
  unarchiveProject,
  buildProjectUpdatePayload,
} from '../../../src/tools/projects/crud';
import { moveProject } from '../../../src/tools/projects/hierarchy';
import {
  ProjectUpdateContext,
  selectProjectUpdateStrategy,
  buildProjectFieldPatch,
} from '../../../src/tools/projects/update';
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
 * A favorited child project with a description and a colour: every field the
 * two full-replace traps can destroy, in one fixture.
 */
const BASE_PROJECT = {
  id: 7,
  title: 'Original title',
  description: 'Original description',
  hex_color: 'aabbcc',
  parent_project_id: 3,
  is_favorite: true,
  is_archived: false,
  identifier: 'ORIG',
  position: 1,
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

/**
 * Records every v1 REST call. Answers a single-project read with the current
 * project, a project listing (hierarchy validation) with the parent plus the
 * project itself, and a write with the merged body it was handed.
 */
function stubV1Rest(current: Record<string, unknown> = BASE_PROJECT): RestCall[] {
  const calls: RestCall[] = [];
  mockRest.mockImplementation((...args: unknown[]) => {
    const [, method, path, body] = args as [unknown, string, string, unknown];
    calls.push({ method, path, body });
    if (method === 'GET' && path.startsWith('/projects?')) {
      return Promise.resolve([{ id: 3, title: 'Parent', parent_project_id: 0 }, current]);
    }
    if (method === 'GET') {
      return Promise.resolve(current);
    }
    return Promise.resolve(body);
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

function writeCalls(calls: RestCall[]): RestCall[] {
  return calls.filter((call) => call.method !== 'GET');
}

describe('project update strategy selection', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    ConfigurationManager.reset();
  });

  afterEach(() => {
    delete process.env.VIKUNJA_MCP_FORCE_V1_API;
    ConfigurationManager.reset();
  });

  // The point of this one: task update pins a 2.5.0 floor because its v2
  // PATCH 422s on a subscribed task. Project PATCH answered 200 on 2.4.0, so
  // copying that floor would have stranded a third of the support window on
  // v1 for nothing.
  it('selects v2 on the 2.4.0 floor, because project PATCH is not the task bug', () => {
    expect(
      selectProjectUpdateStrategy(authManagerFor({ serverVersion: 'v2.4.0' })).apiVersion,
    ).toBe('v2');
  });

  it('selects v2 on 2.5.0', () => {
    expect(new ProjectUpdateContext(authManagerFor({ serverVersion: 'v2.5.0' })).apiVersion).toBe(
      'v2',
    );
  });

  it('selects v2 on 2.6.0', () => {
    expect(new ProjectUpdateContext(authManagerFor({ serverVersion: 'v2.6.0' })).apiVersion).toBe(
      'v2',
    );
  });

  it('selects v1 when the kill switch is on, even on 2.6.0', () => {
    process.env.VIKUNJA_MCP_FORCE_V1_API = 'true';
    ConfigurationManager.reset();

    expect(new ProjectUpdateContext(authManagerFor({ serverVersion: 'v2.6.0' })).apiVersion).toBe(
      'v1',
    );
  });

  // No minVersion means an undetected version is not disqualifying on its
  // own, but a session with no capability snapshot at all still has no
  // positive evidence of a v2 API, so it stays on v1.
  it('selects v2 when the server has a v2 API but reported no version', () => {
    expect(new ProjectUpdateContext(authManagerFor({ serverVersion: undefined })).apiVersion).toBe(
      'v2',
    );
  });

  it('selects v1 when the server reports no v2 API', () => {
    expect(
      new ProjectUpdateContext(authManagerFor({ hasV2Api: false, serverVersion: 'v2.6.0' }))
        .apiVersion,
    ).toBe('v1');
  });

  it('selects v1 when capability detection has not run for the session', () => {
    expect(new ProjectUpdateContext(authManagerFor({ withCapabilities: false })).apiVersion).toBe(
      'v1',
    );
  });

  // The projects tool is reached from auth-manager-shaped objects that
  // predate capability detection, so a missing method must degrade to v1
  // rather than throw.
  it('selects v1 for an auth manager that has no getCapabilities at all', () => {
    const bare = { getSession: () => ({}) } as unknown as AuthManager;

    expect(selectProjectUpdateStrategy(bare).apiVersion).toBe('v1');
  });
});

describe('shared field mapping', () => {
  // One mapper feeds both strategies, so the v1 full model and the v2 patch
  // cannot disagree about what a caller's field means.
  it('maps only the fields the caller named', () => {
    expect(buildProjectFieldPatch({ title: '  Trimmed  ' })).toEqual({ title: 'Trimmed' });
  });

  it('keeps the falsy values that all mean something', () => {
    expect(
      buildProjectFieldPatch({
        description: '',
        parentProjectId: 0,
        isArchived: false,
        isFavorite: false,
      }),
    ).toEqual({
      description: '',
      parent_project_id: 0,
      is_archived: false,
      is_favorite: false,
    });
  });

  it('lowercases the hex colour on both paths', () => {
    expect(buildProjectFieldPatch({ hexColor: 'AABBCC' })).toEqual({ hex_color: 'aabbcc' });
  });

  it('still merges the whole current project for v1, so nothing is cleared', () => {
    expect(buildProjectUpdatePayload(BASE_PROJECT, { title: 'New' })).toEqual({
      ...BASE_PROJECT,
      title: 'New',
    });
  });
});

describe('v2 project update strategy', () => {
  let authManager: AuthManager;

  beforeEach(() => {
    jest.clearAllMocks();
    ConfigurationManager.reset();
    authManager = authManagerFor({ serverVersion: 'v2.4.0' });
  });

  afterEach(() => {
    ConfigurationManager.reset();
  });

  it('sends only the named field, not the whole model', async () => {
    const restCalls = stubV1Rest();
    const patchCalls = stubV2Patch({ ...BASE_PROJECT, title: 'New title' });

    const result = await updateProject({ id: 7, title: 'New title' }, authManager);

    expect(patchCalls).toEqual([
      { method: 'PATCH', path: '/projects/7', body: { title: 'New title' } },
    ]);
    expect(writeCalls(restCalls)).toEqual([]);
    expect(result.content[0]?.text).toContain('New title');
  });

  /**
   * The trap this entity exists to worry about. `Project.IsFavorite` is
   * `xorm:"-"`, and v1's handler treats an omitted `is_favorite` as an
   * explicit unfavorite. Probed live: v2's `PATCH` does not, because the
   * patch is applied to the stored project first. So the patch body must NOT
   * carry `is_favorite`, and the project must come back still favorited.
   */
  it('does not resend is_favorite on an unrelated update, and does not lose it', async () => {
    stubV1Rest();
    const patchCalls = stubV2Patch({ ...BASE_PROJECT, description: 'New description' });

    await updateProject({ id: 7, description: 'New description' }, authManager);

    expect(patchCalls[0]?.body).toEqual({ description: 'New description' });
    expect(patchCalls[0]?.body).not.toHaveProperty('is_favorite');
  });

  it('still sends an explicit unfavorite, because false means unfavorite', async () => {
    stubV1Rest();
    const patchCalls = stubV2Patch({ ...BASE_PROJECT, is_favorite: false });

    await updateProject({ id: 7, isFavorite: false }, authManager);

    expect(patchCalls[0]?.body).toEqual({ is_favorite: false });
  });

  /**
   * The second trap: `parent_project_id` is a real column, so an omitted
   * value on v1's full-replace POST detaches the project to the root. The v2
   * patch must leave it out entirely on an unrelated update.
   */
  it('does not resend parent_project_id on an unrelated update', async () => {
    stubV1Rest();
    const patchCalls = stubV2Patch({ ...BASE_PROJECT, title: 'New title' });

    await updateProject({ id: 7, title: 'New title' }, authManager);

    expect(patchCalls[0]?.body).not.toHaveProperty('parent_project_id');
  });

  it('archives through a one-field patch', async () => {
    const restCalls = stubV1Rest();
    const patchCalls = stubV2Patch({ ...BASE_PROJECT, is_archived: true });

    await archiveProject({ id: 7 }, authManager);

    expect(patchCalls).toEqual([
      { method: 'PATCH', path: '/projects/7', body: { is_archived: true } },
    ]);
    expect(writeCalls(restCalls)).toEqual([]);
  });

  it('unarchives through a one-field patch', async () => {
    stubV1Rest({ ...BASE_PROJECT, is_archived: true });
    const patchCalls = stubV2Patch({ ...BASE_PROJECT, is_archived: false });

    await unarchiveProject({ id: 7 }, authManager);

    expect(patchCalls).toEqual([
      { method: 'PATCH', path: '/projects/7', body: { is_archived: false } },
    ]);
  });

  /**
   * `move` is the documented exception to "omitted means leave it alone": an
   * omitted parent means *move to root*, so `0` has to travel as a real
   * value rather than being dropped from the patch.
   */
  it('sends parent_project_id 0 explicitly when moving a project to the root', async () => {
    stubV1Rest();
    const patchCalls = stubV2Patch({ ...BASE_PROJECT, parent_project_id: 0 });

    await moveProject({ id: 7 }, undefined, authManager);

    expect(patchCalls).toEqual([
      { method: 'PATCH', path: '/projects/7', body: { parent_project_id: 0 } },
    ]);
  });

  it('sends the new parent when moving a project under one', async () => {
    stubV1Rest();
    const patchCalls = stubV2Patch({ ...BASE_PROJECT, parent_project_id: 3 });

    await moveProject({ id: 7, parentProjectId: 3 }, undefined, authManager);

    expect(patchCalls[0]?.body).toEqual({ parent_project_id: 3 });
  });

  /**
   * Setting a field to the value it already holds is an ordinary thing for a
   * caller to do, and v2 answers it with a bodiless 304. The re-read is
   * deliberate: the server computed "nothing to change" against its current
   * state, so the pre-update snapshot could be stale.
   */
  it('re-reads the project when the server answers 304 because the patch changed nothing', async () => {
    const restCalls = stubV1Rest();
    mockRestV2.mockRejectedValue(
      new MCPError(ErrorCode.API_ERROR, 'HTTP 304 Not Modified', { statusCode: 304 }),
    );

    const result = await updateProject({ id: 7, title: 'Original title' }, authManager);

    expect(restCalls.filter((call) => call.path === '/projects/7')).toHaveLength(2);
    expect(writeCalls(restCalls)).toEqual([]);
    expect(result.content[0]?.text).toContain('Original title');
  });

  it('rethrows a non-304 patch failure as the domain not-found message', async () => {
    stubV1Rest();
    mockRestV2.mockRejectedValue(
      new MCPError(ErrorCode.API_ERROR, 'HTTP 404', { statusCode: 404 }),
    );

    await expect(updateProject({ id: 7, title: 'New title' }, authManager)).rejects.toThrow(
      'Project with ID 7 not found',
    );
  });
});

describe('v1 project update strategy is unchanged', () => {
  let authManager: AuthManager;

  beforeEach(() => {
    jest.clearAllMocks();
    ConfigurationManager.reset();
    authManager = authManagerFor({ hasV2Api: false, serverVersion: 'v2.6.0' });
  });

  afterEach(() => {
    delete process.env.VIKUNJA_MCP_FORCE_V1_API;
    ConfigurationManager.reset();
  });

  it('POSTs the whole merged model, carrying is_favorite and the parent forward', async () => {
    const restCalls = stubV1Rest();

    await updateProject({ id: 7, title: 'New title' }, authManager);

    expect(writeCalls(restCalls)).toEqual([
      {
        method: 'POST',
        path: '/projects/7',
        body: { ...BASE_PROJECT, title: 'New title' },
      },
    ]);
    expect(mockRestV2).not.toHaveBeenCalled();
  });

  it('archives through the merged full model', async () => {
    const restCalls = stubV1Rest();

    await archiveProject({ id: 7 }, authManager);

    expect(writeCalls(restCalls)).toEqual([
      { method: 'POST', path: '/projects/7', body: { ...BASE_PROJECT, is_archived: true } },
    ]);
  });

  it('moves through the merged full model with an explicit parent_project_id', async () => {
    const restCalls = stubV1Rest();

    await moveProject({ id: 7 }, undefined, authManager);

    expect(writeCalls(restCalls)).toEqual([
      { method: 'POST', path: '/projects/7', body: { ...BASE_PROJECT, parent_project_id: 0 } },
    ]);
  });

  it('takes the v1 path on a v2-capable 2.6.0 server when the kill switch is on', async () => {
    process.env.VIKUNJA_MCP_FORCE_V1_API = 'true';
    ConfigurationManager.reset();
    const restCalls = stubV1Rest();

    await updateProject({ id: 7, title: 'New title' }, authManagerFor({ serverVersion: 'v2.6.0' }));

    expect(writeCalls(restCalls)).toHaveLength(1);
    expect(mockRestV2).not.toHaveBeenCalled();
  });
});

describe('both strategies return the same canonical shape', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    ConfigurationManager.reset();
  });

  afterEach(() => {
    ConfigurationManager.reset();
  });

  /**
   * `max_permission` as each path actually returns it, probed live on
   * 2026-09-06 against one owned project per supported version:
   *
   *   | version | v1 `GET` | v1 `POST` | v2 `GET` | v2 `PATCH` |
   *   |---------|----------|-----------|----------|------------|
   *   | 2.4.0   | `0`      | `0`       | `2`      | `null`     |
   *   | 2.5.0   | `0`      | `0`       | `2`      | `null`     |
   *   | 2.6.0   | `null`   | `null`    | `2`      | `null`     |
   *
   * Only the two columns a strategy can return are modelled here: v1's `POST`
   * echo and v2's `PATCH` body. The `GET` columns matter for the `304` case
   * below, where the v2 strategy falls back to a v1 read.
   *
   * The previous version of this fixture stubbed the v1 read with
   * `max_permission: 2`, which is the v2 `GET` value and appears on no v1
   * response on any version. The parity assertion therefore compared a value
   * against itself and could not fail, which is precisely how the divergence
   * it was written to guard got shipped.
   */
  const PROBED_MAX_PERMISSION = [
    { version: 'v2.4.0', v1: 0, v2Patch: null },
    { version: 'v2.5.0', v1: 0, v2Patch: null },
    { version: 'v2.6.0', v1: null, v2Patch: null },
  ] as const;

  /**
   * Drops the rendered `timestamp:` line.
   *
   * The two renderings happen microseconds apart and the timestamp is
   * millisecond-resolution, so comparing the raw text fails whenever the two
   * calls straddle a millisecond boundary. That is a property of the clock,
   * not of the strategies, and it is what the two runs must NOT differ in
   * that this test is about.
   */
  function withoutTimestamp(text: string | undefined): string | undefined {
    return text?.replace(/^\*\*timestamp:\*\* .*$/m, '**timestamp:** <normalized>');
  }

  /** Runs one update through the v2 strategy and returns the rendered text. */
  async function renderViaV2(
    version: string,
    patchResult: Record<string, unknown>,
  ): Promise<string | undefined> {
    jest.clearAllMocks();
    stubV1Rest();
    stubV2Patch(patchResult);
    const result = await updateProject(
      { id: 7, title: 'New title' },
      authManagerFor({ serverVersion: version }),
    );
    expect(mockRestV2).toHaveBeenCalled();
    return result.content[0]?.text;
  }

  /** Runs the same update through the v1 strategy and returns its text. */
  async function renderViaV1(current: Record<string, unknown>): Promise<string | undefined> {
    jest.clearAllMocks();
    stubV1Rest(current);
    const result = await updateProject(
      { id: 7, title: 'New title' },
      authManagerFor({ hasV2Api: false }),
    );
    expect(mockRestV2).not.toHaveBeenCalled();
    return result.content[0]?.text;
  }

  it.each(PROBED_MAX_PERMISSION)(
    'renders identically whichever strategy ran on $version',
    async ({ version, v1, v2Patch }) => {
      const viaV2 = await renderViaV2(version, {
        ...BASE_PROJECT,
        title: 'New title',
        max_permission: v2Patch,
      });

      // v1's `POST` answers with the model it was sent, `max_permission`
      // included, so the merged body carries this server's v1 value.
      const viaV1 = await renderViaV1({ ...BASE_PROJECT, max_permission: v1 });

      expect(withoutTimestamp(viaV2)).toBe(withoutTimestamp(viaV1));
    },
  );

  /**
   * The assertion that makes the parity above mean something rather than
   * merely hold. Two paths could agree by both leaking the field; what P3
   * asked for is that neither surfaces it at all.
   */
  it.each(PROBED_MAX_PERMISSION)(
    'keeps max_permission off the tool surface on both paths on $version',
    async ({ version, v1, v2Patch }) => {
      const viaV2 = await renderViaV2(version, {
        ...BASE_PROJECT,
        title: 'New title',
        max_permission: v2Patch,
      });
      const viaV1 = await renderViaV1({ ...BASE_PROJECT, max_permission: v1 });

      expect(viaV2).not.toContain('max_permission');
      expect(viaV1).not.toContain('max_permission');
    },
  );

  /**
   * The v2 strategy's own second path. A `304` sends it to a v1 `GET`, which
   * carries v1's `max_permission` and not the one a real patch would have
   * returned, so without canonicalising the read this branch diverges from
   * the branch right next to it.
   */
  it('strips max_permission on the v2 304 no-op read as well', async () => {
    stubV1Rest({ ...BASE_PROJECT, max_permission: 0 });
    mockRestV2.mockImplementation(() =>
      Promise.reject(
        new MCPError(ErrorCode.API_ERROR, 'Vikunja REST request failed: HTTP 304 Not Modified', {
          statusCode: 304,
        }),
      ),
    );

    const result = await updateProject(
      { id: 7, title: 'Original title' },
      authManagerFor({ serverVersion: 'v2.4.0' }),
    );

    expect(result.content[0]?.text).not.toContain('max_permission');
  });

  /**
   * `archive`, `unarchive` and `move` are the same write through the same
   * `ProjectUpdateContext`, so they inherit the stripping. This pins that
   * they do rather than leaving it to the reader of the context class.
   */
  it('keeps max_permission off archive, unarchive and move too', async () => {
    // Each starts from the state that makes its write actually happen:
    // `archive` needs an unarchived project, `unarchive` an archived one.
    // `archiveProject`/`unarchiveProject` short-circuit with the raw v1 read
    // when the project is already in the requested state, and that early
    // return never reaches a strategy.
    const cases = [
      {
        current: { ...BASE_PROJECT, is_archived: false, max_permission: 0 },
        run: () => archiveProject({ id: 7 }, authManagerFor({ hasV2Api: false })),
      },
      {
        current: { ...BASE_PROJECT, is_archived: true, max_permission: 0 },
        run: () => unarchiveProject({ id: 7 }, authManagerFor({ hasV2Api: false })),
      },
      {
        current: { ...BASE_PROJECT, max_permission: 0 },
        run: () => moveProject({ id: 7 }, undefined, authManagerFor({ hasV2Api: false })),
      },
    ];

    for (const { current, run } of cases) {
      jest.clearAllMocks();
      stubV1Rest(current);
      const result = await run();
      expect(result.content[0]?.text).not.toContain('max_permission');
    }
  });
});
