/**
 * `vikunja_tasks update` strategy pair — #184 P3 step 4.
 *
 * The milestone's payoff, and its highest-risk change: from 2.5.0 upward a
 * task update becomes a single v2 `PATCH` carrying the changed fields and the
 * assignees together, while 2.4.0 keeps the v1 fetch-merge-POST sequence
 * unchanged. These tests pin both halves plus the routing rule between them.
 *
 * Every version fact asserted here was re-probed against the live 2.4.0,
 * 2.5.0 and 2.6.0 stacks on 2026-09-05 (see the strategy doc comments for the
 * table). What is deliberately NOT here: any test pinning 2.4.0's
 * `subscription` 422 or a `subscription: null` workaround. That workaround is
 * withdrawn — routing around the bug is the design, so there is no upstream
 * defect to assert.
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
import { updateTask } from '../../../src/tools/tasks/crud/TaskUpdateService';
import {
  TaskUpdateContext,
  selectTaskUpdateStrategy,
  TASK_UPDATE_V2_MIN_VERSION,
} from '../../../src/tools/tasks/crud/update';
import { buildTaskPatchBody } from '../../../src/tools/tasks/crud/update/V2TaskUpdateStrategy';
import { vikunjaRestRequest } from '../../../src/utils/vikunja-rest';
import { vikunjaRestV2Request } from '../../../src/utils/vikunja-rest-v2';

const mockRest = vikunjaRestRequest as jest.Mock;
const mockRestV2 = vikunjaRestV2Request as jest.Mock;

interface RestCall {
  method: string;
  path: string;
  body?: unknown;
}

/** The task both strategies start from, and what a plain read returns. */
const BASE_TASK = {
  id: 42,
  title: 'Original title',
  description: 'Original description',
  done: false,
  percent_done: 0,
  priority: 0,
  project_id: 7,
  hex_color: '',
  repeat_after: 0,
  repeat_mode: 0 as const,
  assignees: [{ id: 9, username: 'kept-assignee' }],
  labels: [{ id: 3, title: 'kept-label' }],
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

/** Records every v1 REST call and answers reads with the current task. */
function stubV1Rest(readResult: Record<string, unknown> = BASE_TASK): RestCall[] {
  const calls: RestCall[] = [];
  mockRest.mockImplementation((...args: unknown[]) => {
    const [, method, path, body] = args as [unknown, string, string, unknown];
    calls.push({ method, path, body });
    if (method === 'GET') {
      return Promise.resolve(readResult);
    }
    return Promise.resolve({});
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

describe('task update strategy selection', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    ConfigurationManager.reset();
  });

  afterEach(() => {
    delete process.env.VIKUNJA_MCP_FORCE_V1_API;
    ConfigurationManager.reset();
  });

  it('declares 2.5.0 as the floor, the first release whose v2 PATCH survives a subscription', () => {
    expect(TASK_UPDATE_V2_MIN_VERSION).toBe('2.5.0');
  });

  it('selects v1 on 2.4.0, where v2 PATCH 422s on any assigned task', () => {
    expect(selectTaskUpdateStrategy(authManagerFor({ serverVersion: 'v2.4.0' })).apiVersion).toBe(
      'v1',
    );
  });

  it('selects v2 on 2.5.0', () => {
    expect(selectTaskUpdateStrategy(authManagerFor({ serverVersion: 'v2.5.0' })).apiVersion).toBe(
      'v2',
    );
  });

  it('selects v2 on 2.6.0', () => {
    expect(new TaskUpdateContext(authManagerFor({ serverVersion: 'v2.6.0' })).apiVersion).toBe(
      'v2',
    );
  });

  it('selects v1 when the kill switch is on, even on 2.6.0', () => {
    process.env.VIKUNJA_MCP_FORCE_V1_API = 'true';
    ConfigurationManager.reset();

    expect(new TaskUpdateContext(authManagerFor({ serverVersion: 'v2.6.0' })).apiVersion).toBe(
      'v1',
    );
  });

  it('selects v1 when the server version could not be detected', () => {
    expect(new TaskUpdateContext(authManagerFor({ serverVersion: undefined })).apiVersion).toBe(
      'v1',
    );
  });

  it('selects v1 when the server reports no v2 API', () => {
    expect(
      new TaskUpdateContext(authManagerFor({ hasV2Api: false, serverVersion: 'v2.6.0' }))
        .apiVersion,
    ).toBe('v1');
  });

  it('selects v1 when capability detection has not run for the session', () => {
    expect(new TaskUpdateContext(authManagerFor({ withCapabilities: false })).apiVersion).toBe(
      'v1',
    );
  });

  // Callers hold auth-manager-shaped objects that predate capability
  // detection; an update must degrade to the always-correct v1 path rather
  // than throw on a missing method.
  it('selects v1 for an auth manager that has no getCapabilities at all', () => {
    const bare = { getSession: () => ({}) } as unknown as AuthManager;

    expect(selectTaskUpdateStrategy(bare).apiVersion).toBe('v1');
  });
});

describe('v2 task update strategy (server >= 2.5.0)', () => {
  let authManager: AuthManager;

  beforeEach(() => {
    jest.clearAllMocks();
    ConfigurationManager.reset();
    authManager = authManagerFor({ serverVersion: 'v2.5.0' });
  });

  afterEach(() => {
    ConfigurationManager.reset();
  });

  /**
   * The payoff. Before this step, changing a title read the task, POSTed the
   * whole model back and read it again; touching assignees added a snapshot
   * read plus one call per user. Now it is one read for the diff and one
   * PATCH.
   */
  it('applies a field-only update in one read and one PATCH, leaving assignees alone', async () => {
    const restCalls = stubV1Rest();
    const patchCalls = stubV2Patch({ ...BASE_TASK, title: 'New title' });

    const result = await updateTask({ id: 42, title: 'New title' }, authManager);

    expect(restCalls).toEqual([{ method: 'GET', path: '/tasks/42', body: undefined }]);
    expect(patchCalls).toEqual([
      { method: 'PATCH', path: '/tasks/42', body: { title: 'New title' } },
    ]);
    // No snapshot, no per-user restore, no trailing re-read.
    expect(restCalls.filter((call) => call.path.includes('assignees'))).toHaveLength(0);
    expect(result.content[0]?.text).toContain('kept-assignee');
  });

  it('sends assignees inline in the PATCH body instead of one call per user', async () => {
    stubV1Rest();
    const patchCalls = stubV2Patch({ ...BASE_TASK, assignees: [{ id: 4 }, { id: 5 }] });

    await updateTask({ id: 42, assignees: [4, 5] }, authManager);

    expect(patchCalls).toEqual([
      { method: 'PATCH', path: '/tasks/42', body: { assignees: [{ id: 4 }, { id: 5 }] } },
    ]);
    expect(mockRest).toHaveBeenCalledTimes(1); // the diff read only
  });

  it('treats an empty assignee list as "clear them", not as "leave them alone"', () => {
    expect(buildTaskPatchBody({ assignees: [] })).toEqual({ assignees: [] });
  });

  it('omits assignees from the patch body when the caller did not mention them', () => {
    expect(buildTaskPatchBody({ title: 'x' })).toEqual({ title: 'x' });
  });

  it('writes labels before the PATCH so the response already carries them', async () => {
    const order: string[] = [];
    mockRest.mockImplementation((...args: unknown[]) => {
      const [, method, path] = args as [unknown, string, string];
      order.push(`v1 ${method} ${path}`);
      return Promise.resolve(method === 'GET' ? BASE_TASK : {});
    });
    mockRestV2.mockImplementation((...args: unknown[]) => {
      const [, method, path] = args as [unknown, string, string];
      order.push(`v2 ${method} ${path}`);
      return Promise.resolve({ ...BASE_TASK, labels: [{ id: 8, title: 'new-label' }] });
    });

    const result = await updateTask({ id: 42, title: 'New title', labels: [8] }, authManager);

    expect(order).toEqual([
      'v1 GET /tasks/42',
      'v1 POST /tasks/42/labels/bulk',
      'v2 PATCH /tasks/42',
    ]);
    expect(result.content[0]?.text).toContain('new-label');
  });

  it('re-reads the task when the server answers 304 because the patch changed nothing', async () => {
    const restCalls = stubV1Rest({ ...BASE_TASK, title: 'Original title' });
    mockRestV2.mockRejectedValue(
      new MCPError(ErrorCode.API_ERROR, 'HTTP 304 Not Modified', { statusCode: 304 }),
    );

    const result = await updateTask({ id: 42, title: 'Original title' }, authManager);

    expect(restCalls.map((call) => `${call.method} ${call.path}`)).toEqual([
      'GET /tasks/42',
      'GET /tasks/42',
    ]);
    expect(result.content[0]?.text).toContain('Original title');
  });

  it('propagates a real PATCH failure rather than swallowing it as a no-op', async () => {
    stubV1Rest();
    mockRestV2.mockRejectedValue(
      new MCPError(ErrorCode.API_ERROR, 'Vikunja REST request failed (PATCH /tasks/42): HTTP 422', {
        statusCode: 422,
      }),
    );

    await expect(updateTask({ id: 42, title: 'New title' }, authManager)).rejects.toThrow(
      /HTTP 422/,
    );
  });

  it('skips the PATCH entirely when only relationships were supplied', async () => {
    const restCalls = stubV1Rest();
    stubV2Patch(BASE_TASK);

    await updateTask({ id: 42, labels: [8] }, authManager);

    expect(mockRestV2).not.toHaveBeenCalled();
    expect(restCalls.map((call) => `${call.method} ${call.path}`)).toEqual([
      'GET /tasks/42',
      'POST /tasks/42/labels/bulk',
      'GET /tasks/42',
    ]);
  });

  it('strips v2-only fields so the task is shaped exactly like a v1 one', async () => {
    stubV1Rest();
    stubV2Patch({ ...BASE_TASK, title: 'New title', max_permission: 2 });

    const result = await updateTask({ id: 42, title: 'New title' }, authManager);

    expect(result.content[0]?.text).not.toContain('max_permission');
  });

  it('still moves the task into a Kanban bucket, after the field write', async () => {
    const restCalls = stubV1Rest();
    stubV2Patch({ ...BASE_TASK, title: 'New title' });

    await updateTask(
      { id: 42, title: 'New title', bucketId: 5, viewId: 11, projectId: 7 },
      authManager,
    );

    expect(restCalls.map((call) => `${call.method} ${call.path}`)).toEqual([
      'GET /tasks/42',
      'POST /projects/7/views/11/buckets/5/tasks',
    ]);
  });

  it('verifies a project move against the PATCH response, with no extra read', async () => {
    stubV1Rest();
    stubV2Patch({ ...BASE_TASK, project_id: 7 });

    await expect(updateTask({ id: 42, projectId: 12 }, authManager)).rejects.toThrow(
      /task remains in project 7/,
    );
  });

  it('converts percentDone to the 0-1 wire fraction in the patch body', async () => {
    stubV1Rest();
    const patchCalls = stubV2Patch({ ...BASE_TASK, percent_done: 0.6 });

    await updateTask({ id: 42, percentDone: 60 }, authManager);

    expect(patchCalls[0]?.body).toEqual({ percent_done: 0.6 });
  });

  it('sends only the supplied fields, never the whole model', async () => {
    stubV1Rest();
    const patchCalls = stubV2Patch({ ...BASE_TASK, done: true });

    await updateTask({ id: 42, done: true }, authManager);

    expect(patchCalls[0]?.body).toEqual({ done: true });
    expect(patchCalls[0]?.body).not.toHaveProperty('description');
  });
});

describe('v1 task update strategy (2.4.0 floor)', () => {
  let authManager: AuthManager;

  beforeEach(() => {
    jest.clearAllMocks();
    ConfigurationManager.reset();
    authManager = authManagerFor({ serverVersion: 'v2.4.0' });
  });

  afterEach(() => {
    ConfigurationManager.reset();
  });

  it('keeps the fetch-merge-POST sequence and never touches the v2 transport', async () => {
    const restCalls = stubV1Rest();

    await updateTask({ id: 42, title: 'New title' }, authManager);

    expect(mockRestV2).not.toHaveBeenCalled();
    expect(restCalls.map((call) => `${call.method} ${call.path}`)).toEqual([
      'GET /tasks/42',
      'POST /tasks/42',
      'GET /tasks/42',
    ]);
    // The full model goes back, which is why v1 has to read first.
    expect(restCalls[1]?.body).toMatchObject({
      id: 42,
      title: 'New title',
      description: 'Original description',
      project_id: 7,
    });
  });

  it('still snapshots and diffs assignees one user at a time', async () => {
    const restCalls = stubV1Rest();

    await updateTask({ id: 42, assignees: [4] }, authManager);

    expect(restCalls.map((call) => `${call.method} ${call.path}`)).toEqual([
      'GET /tasks/42',
      'POST /tasks/42',
      'GET /tasks/42', // assignee snapshot
      'PUT /tasks/42/assignees',
      'DELETE /tasks/42/assignees/9',
      'GET /tasks/42',
    ]);
  });
});

describe('canonical shape parity between the strategies', () => {
  afterEach(() => {
    ConfigurationManager.reset();
  });

  /**
   * The hard constraint: a caller cannot tell which strategy ran. Same
   * logical update, same task on the server, same rendered response.
   */
  it('renders an identical response for the same logical update on 2.4.0 and 2.5.0', async () => {
    const updatedTask = { ...BASE_TASK, title: 'New title' };
    const timestamp = '2026-09-05T12:00:00.000Z';
    jest.spyOn(Date.prototype, 'toISOString').mockReturnValue(timestamp);

    jest.clearAllMocks();
    ConfigurationManager.reset();
    // v1 reads the task twice: once before the write (the diff snapshot) and
    // once after it (the result), so the two reads must differ.
    let v1Reads = 0;
    mockRest.mockImplementation((...args: unknown[]) => {
      const [, method] = args as [unknown, string];
      if (method !== 'GET') return Promise.resolve({});
      v1Reads += 1;
      return Promise.resolve(v1Reads === 1 ? BASE_TASK : updatedTask);
    });
    const v1Result = await updateTask(
      { id: 42, title: 'New title' },
      authManagerFor({ serverVersion: 'v2.4.0' }),
    );

    jest.clearAllMocks();
    ConfigurationManager.reset();
    mockRest.mockResolvedValue(BASE_TASK);
    mockRestV2.mockResolvedValue({ ...updatedTask, max_permission: 2 });
    const v2Result = await updateTask(
      { id: 42, title: 'New title' },
      authManagerFor({ serverVersion: 'v2.5.0' }),
    );

    expect(v2Result).toEqual(v1Result);

    jest.restoreAllMocks();
  });
});
