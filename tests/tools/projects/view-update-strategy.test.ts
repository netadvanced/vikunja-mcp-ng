/**
 * Project view update strategy pair — #184 P3 step 6.
 *
 * `update-view` and the `set-done-bucket` composite become a single v2 `PATCH`
 * on every supported server, while v1 keeps the fetch-merge-`POST` sequence it
 * has always used. These tests pin both halves plus the routing rule between
 * them.
 *
 * Every version fact asserted here was probed against the live 2.4.0, 2.5.0
 * and 2.6.0 stacks on 2026-09-05, and all three behaved identically: a partial
 * `PATCH` applied, untouched fields survived, a nested `filter` patch left the
 * rest of the task collection alone, and a patch that would change nothing
 * answered `304` with no body. That is why there is no `minVersion` floor here
 * and why a 2.4.0 server is asserted to pick v2.
 *
 * What is deliberately NOT here: anything about Kanban buckets moving to v2.
 * v2 registers no `PATCH` on a bucket at all, so bucket updates stay on v1
 * permanently. `done_bucket_id` is a field of the *view*, which is the only
 * reason `set-done-bucket` appears in this file.
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';

jest.mock('../../../src/utils/vikunja-rest', () => ({
  vikunjaRestRequest: jest.fn(),
  resolveKanbanViewId: jest.fn(),
}));
jest.mock('../../../src/utils/vikunja-rest-v2', () => ({
  vikunjaRestV2Request: jest.fn(),
}));

import { AuthManager } from '../../../src/auth/AuthManager';
import { ConfigurationManager } from '../../../src/config/ConfigurationManager';
import { MCPError, ErrorCode } from '../../../src/types';
import { updateView, setDoneBucket } from '../../../src/tools/projects/views';
import {
  ViewUpdateContext,
  selectViewUpdateStrategy,
  buildViewFieldPatch,
} from '../../../src/tools/projects/view-update';
import { vikunjaRestRequest, resolveKanbanViewId } from '../../../src/utils/vikunja-rest';
import { vikunjaRestV2Request } from '../../../src/utils/vikunja-rest-v2';

const mockRest = vikunjaRestRequest as jest.Mock;
const mockRestV2 = vikunjaRestV2Request as jest.Mock;
const mockResolveKanbanViewId = resolveKanbanViewId as jest.Mock;

interface RestCall {
  method: string;
  path: string;
  body?: unknown;
}

/**
 * The view both strategies start from. `position` and the extra keys of the
 * task collection are the fields that a naive partial write would destroy on
 * v1, so they are what "untouched fields survive" is asserted about.
 */
const BASE_VIEW = {
  id: 11,
  title: 'Kanban',
  project_id: 5,
  view_kind: 'kanban' as const,
  position: 4242,
  bucket_configuration_mode: 'manual' as const,
  filter: {
    s: '',
    sort_by: null,
    order_by: null,
    filter: 'done = false',
    filter_include_nulls: false,
  },
  default_bucket_id: 100,
  done_bucket_id: 101,
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

/** Records every v1 REST call and answers reads with the given view. */
function stubV1Rest(readResult: Record<string, unknown> = BASE_VIEW): RestCall[] {
  const calls: RestCall[] = [];
  mockRest.mockImplementation((...args: unknown[]) => {
    const [, method, path, body] = args as [unknown, string, string, unknown];
    calls.push({ method, path, body });
    if (method === 'GET') {
      return Promise.resolve(readResult);
    }
    // v1's write answers with the payload it was handed, which is what the
    // real full-model-replace endpoint returns.
    return Promise.resolve(body);
  });
  return calls;
}

/** Records every v2 REST call and answers with the given view. */
function stubV2Rest(patchResult: Record<string, unknown>): RestCall[] {
  const calls: RestCall[] = [];
  mockRestV2.mockImplementation((...args: unknown[]) => {
    const [, method, path, body] = args as [unknown, string, string, unknown];
    calls.push({ method, path, body });
    return Promise.resolve(patchResult);
  });
  return calls;
}

function notModified(): MCPError {
  return new MCPError(
    ErrorCode.API_ERROR,
    'Vikunja REST request failed (PATCH /projects/5/views/11): HTTP 304 Not Modified',
    { statusCode: 304 },
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.VIKUNJA_MCP_FORCE_V1_API;
  ConfigurationManager.reset();
});

afterEach(() => {
  delete process.env.VIKUNJA_MCP_FORCE_V1_API;
  ConfigurationManager.reset();
});

describe('selectViewUpdateStrategy', () => {
  it('picks v2 on a v2-capable server', () => {
    expect(selectViewUpdateStrategy(authManagerFor({})).apiVersion).toBe('v2');
  });

  /**
   * The judgement call of this item. Task update carries a 2.5.0 floor because
   * 2.4.0's task `PATCH` 422s on a subscribed task. The view route has no such
   * defect on any supported release, so it must not inherit the floor.
   */
  it('picks v2 on the 2.4.0 support floor: this route needs no minVersion', () => {
    expect(selectViewUpdateStrategy(authManagerFor({ serverVersion: 'v2.4.0' })).apiVersion).toBe(
      'v2',
    );
  });

  it('picks v2 on 2.5.0 and 2.6.0', () => {
    expect(selectViewUpdateStrategy(authManagerFor({ serverVersion: 'v2.5.0' })).apiVersion).toBe(
      'v2',
    );
    expect(selectViewUpdateStrategy(authManagerFor({ serverVersion: 'v2.6.0' })).apiVersion).toBe(
      'v2',
    );
  });

  it('falls back to v1 when the server version could not be detected', () => {
    expect(selectViewUpdateStrategy(authManagerFor({ withCapabilities: false })).apiVersion).toBe(
      'v1',
    );
  });

  it('falls back to v1 when the server reports no v2 API', () => {
    expect(selectViewUpdateStrategy(authManagerFor({ hasV2Api: false })).apiVersion).toBe('v1');
  });

  it('falls back to v1 with the forceV1Api kill switch set', () => {
    process.env.VIKUNJA_MCP_FORCE_V1_API = 'true';
    ConfigurationManager.reset();

    expect(selectViewUpdateStrategy(authManagerFor({ serverVersion: 'v2.6.0' })).apiVersion).toBe(
      'v1',
    );
  });

  /**
   * Callers reach this holding a narrower auth-manager-shaped object; an
   * update must degrade to v1 rather than throw when capability detection is
   * not part of it at all.
   */
  it('falls back to v1 when the auth manager cannot report capabilities', () => {
    const bare = { getSession: () => ({}) } as unknown as AuthManager;

    expect(selectViewUpdateStrategy(bare).apiVersion).toBe('v1');
    expect(new ViewUpdateContext(bare).apiVersion).toBe('v1');
  });
});

describe('updateView on v2', () => {
  it('sends one PATCH carrying only the named fields, and no read', async () => {
    const v1Calls = stubV1Rest();
    const v2Calls = stubV2Rest({ ...BASE_VIEW, title: 'Renamed' });

    await updateView({ id: 5, viewId: 11, title: 'Renamed' }, authManagerFor({}));

    expect(v2Calls).toEqual([
      { method: 'PATCH', path: '/projects/5/views/11', body: { title: 'Renamed' } },
    ]);
    expect(v1Calls).toEqual([]);
  });

  /**
   * The reason the v1 merge exists is that v1 wipes what it is not sent. v2
   * merges server-side, so the contract this asserts is the *absence* of the
   * untouched fields from the request body: they survive because they are
   * never mentioned.
   */
  it('leaves fields the caller did not mention out of the patch entirely', async () => {
    stubV1Rest();
    const v2Calls = stubV2Rest(BASE_VIEW);

    await updateView({ id: 5, viewId: 11, title: 'Renamed' }, authManagerFor({}));

    expect(Object.keys(v2Calls[0]?.body as object)).toEqual(['title']);
  });

  it('sends position 0 rather than dropping it as falsy', async () => {
    stubV1Rest();
    const v2Calls = stubV2Rest(BASE_VIEW);

    await updateView({ id: 5, viewId: 11, position: 0 }, authManagerFor({}));

    expect(v2Calls[0]?.body).toEqual({ position: 0 });
  });

  /**
   * A merge patch recurses into nested objects, so the rest of the task
   * collection survives without being sent (verified live on all three
   * versions). The DSL translation still has to happen client-side.
   */
  it('patches the filter query alone, translated, without the surrounding collection', async () => {
    stubV1Rest();
    const v2Calls = stubV2Rest(BASE_VIEW);

    await updateView({ id: 5, viewId: 11, filter: 'dueDate > now' }, authManagerFor({}));

    expect(v2Calls[0]?.body).toEqual({ filter: { filter: 'due_date > now' } });
  });

  it('maps bucket configuration entries onto the wire shape', async () => {
    stubV1Rest();
    const v2Calls = stubV2Rest(BASE_VIEW);

    await updateView(
      {
        id: 5,
        viewId: 11,
        bucketConfigurationMode: 'filter',
        bucketConfiguration: [{ title: 'Open', filter: 'done = false' }],
      },
      authManagerFor({}),
    );

    expect(v2Calls[0]?.body).toEqual({
      bucket_configuration_mode: 'filter',
      bucket_configuration: [{ title: 'Open', filter: { filter: 'done = false' } }],
    });
  });

  /**
   * A no-op patch answers 304 with no body, which the transport surfaces as an
   * MCPError. The view still has to be reported, so the strategy reads it.
   */
  it('answers a 304 with a fresh read rather than an error', async () => {
    const v1Calls = stubV1Rest();
    mockRestV2.mockRejectedValue(notModified());

    const result = await updateView({ id: 5, viewId: 11, title: 'Kanban' }, authManagerFor({}));

    expect(v1Calls).toEqual([{ method: 'GET', path: '/projects/5/views/11', body: undefined }]);
    expect(result.content[0]?.text).toContain('Kanban');
  });

  it('propagates a failure that is not a 304', async () => {
    stubV1Rest();
    mockRestV2.mockRejectedValue(
      new MCPError(ErrorCode.API_ERROR, 'This project view does not exist.', { statusCode: 404 }),
    );

    await expect(
      updateView({ id: 5, viewId: 11, title: 'Renamed' }, authManagerFor({})),
    ).rejects.toThrow('This project view does not exist.');
  });
});

describe('updateView on v1', () => {
  /**
   * Moved, not rewritten: the v1 sequence has to stay byte-identical, because
   * on a server without a usable v2 route this fetch-merge-POST *is* the
   * correct implementation.
   */
  it('reads the view, merges, and POSTs the whole model', async () => {
    const v1Calls = stubV1Rest();

    await updateView({ id: 5, viewId: 11, title: 'Renamed' }, authManagerFor({ hasV2Api: false }));

    expect(v1Calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      'GET /projects/5/views/11',
      'POST /projects/5/views/11',
    ]);
    expect(v1Calls[1]?.body).toEqual({ ...BASE_VIEW, title: 'Renamed' });
    expect(mockRestV2).not.toHaveBeenCalled();
  });

  it('keeps the untouched position and the rest of the filter collection in the payload', async () => {
    const v1Calls = stubV1Rest();

    await updateView(
      { id: 5, viewId: 11, filter: 'dueDate > now' },
      authManagerFor({ hasV2Api: false }),
    );

    const payload = v1Calls[1]?.body as typeof BASE_VIEW;
    expect(payload.position).toBe(4242);
    expect(payload.filter).toEqual({ ...BASE_VIEW.filter, filter: 'due_date > now' });
  });
});

describe('set-done-bucket', () => {
  it('patches done_bucket_id on the view through v2, never a bucket route', async () => {
    stubV1Rest();
    const v2Calls = stubV2Rest({ ...BASE_VIEW, done_bucket_id: 102 });

    await setDoneBucket({ id: 5, viewId: 11, bucketId: 102 }, authManagerFor({}));

    expect(v2Calls).toEqual([
      { method: 'PATCH', path: '/projects/5/views/11', body: { done_bucket_id: 102 } },
    ]);
    // v2 has no PATCH on a bucket at all, so nothing here may address one.
    expect(v2Calls.every((call) => !call.path.includes('/buckets'))).toBe(true);
  });

  it('resolves the Kanban view when no view id is given', async () => {
    stubV1Rest();
    mockResolveKanbanViewId.mockResolvedValue(11);
    const v2Calls = stubV2Rest({ ...BASE_VIEW, done_bucket_id: 102 });

    await setDoneBucket({ id: 5, bucketId: 102 }, authManagerFor({}));

    expect(mockResolveKanbanViewId).toHaveBeenCalled();
    expect(v2Calls[0]?.path).toBe('/projects/5/views/11');
  });

  /**
   * Setting the done bucket to the bucket that already holds the role changes
   * nothing, so the live server answers 304. The re-read then satisfies the
   * verify-then-report check, because the view really does hold that value.
   */
  it('still verifies and reports success when the patch was a 304 no-op', async () => {
    stubV1Rest({ ...BASE_VIEW, done_bucket_id: 101 });
    mockRestV2.mockRejectedValue(notModified());

    const result = await setDoneBucket({ id: 5, viewId: 11, bucketId: 101 }, authManagerFor({}));

    expect(result.content[0]?.text).toContain('Bucket 101 set as the done bucket');
  });

  it('raises rather than claiming success when the server reports another bucket', async () => {
    stubV1Rest();
    stubV2Rest({ ...BASE_VIEW, done_bucket_id: 999 });

    await expect(
      setDoneBucket({ id: 5, viewId: 11, bucketId: 102 }, authManagerFor({})),
    ).rejects.toThrow(/expected done_bucket_id 102, server reports 999/);
  });

  it('keeps the v1 fetch-merge-POST sequence with the kill switch set', async () => {
    process.env.VIKUNJA_MCP_FORCE_V1_API = 'true';
    ConfigurationManager.reset();
    const v1Calls = stubV1Rest();

    await setDoneBucket(
      { id: 5, viewId: 11, bucketId: 101 },
      authManagerFor({ serverVersion: 'v2.6.0' }),
    );

    expect(v1Calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      'GET /projects/5/views/11',
      'POST /projects/5/views/11',
    ]);
    expect(mockRestV2).not.toHaveBeenCalled();
  });
});

describe('canonical shape parity between the strategies', () => {
  /**
   * The hard constraint: a caller cannot tell which strategy ran. Same logical
   * update, same view on the server, same rendered response.
   */
  it('renders an identical response whichever strategy runs', async () => {
    const updatedView = { ...BASE_VIEW, title: 'Renamed' };
    const timestamp = '2026-09-05T12:00:00.000Z';
    jest.spyOn(Date.prototype, 'toISOString').mockReturnValue(timestamp);

    jest.clearAllMocks();
    stubV1Rest(BASE_VIEW);
    const v1Result = await updateView(
      { id: 5, viewId: 11, title: 'Renamed' },
      authManagerFor({ hasV2Api: false }),
    );

    jest.clearAllMocks();
    stubV1Rest(BASE_VIEW);
    stubV2Rest(updatedView);
    const v2Result = await updateView(
      { id: 5, viewId: 11, title: 'Renamed' },
      authManagerFor({ serverVersion: 'v2.6.0' }),
    );

    expect(v2Result).toEqual(v1Result);

    jest.restoreAllMocks();
  });
});

describe('buildViewFieldPatch', () => {
  it('names only the fields the caller supplied', () => {
    expect(buildViewFieldPatch({})).toEqual({});
    expect(buildViewFieldPatch({ title: '  Trimmed  ', defaultBucketId: 7 })).toEqual({
      title: 'Trimmed',
      default_bucket_id: 7,
    });
  });

  it('merges a filter onto a supplied collection, and stands alone without one', () => {
    expect(buildViewFieldPatch({ filter: 'done = true' }, { s: 'needle' }).filter).toEqual({
      s: 'needle',
      filter: 'done = true',
    });
    expect(buildViewFieldPatch({ filter: 'done = true' }).filter).toEqual({
      filter: 'done = true',
    });
  });

  it('rejects an unparseable filter rather than sending it', () => {
    expect(() => buildViewFieldPatch({ filter: 'due_date >' })).toThrow(MCPError);
  });
});
