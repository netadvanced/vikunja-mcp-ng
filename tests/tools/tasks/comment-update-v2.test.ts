/**
 * `vikunja_task_comments update` on Vikunja's v2 API — #184 P3 step 6.
 *
 * Every version fact asserted here was probed against the live 2.4.0, 2.5.0
 * and 2.6.0 stacks on 2026-09-06:
 *
 *   | Behaviour                              | 2.4.0 | 2.5.0 | 2.6.0 |
 *   |----------------------------------------|-------|-------|-------|
 *   | `PATCH .../comments/{id}` applies      | 200   | 200   | 200   |
 *   | `author`/`created` survive the patch   | yes   | yes   | yes   |
 *   | `?format=markdown` honoured on `PATCH` | no    | no    | no    |
 *   | `?format=markdown` honoured on `GET`   | yes   | yes   | yes   |
 *   | no-op patch                            | 304   | 304   | 304   |
 *
 * There is no version at which the route misbehaves, so unlike task update
 * this operation carries no `minVersion` floor and 2.4.0 gets v2 too.
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';

jest.mock('../../../src/utils/logger');
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
  CommentOperationsService,
  selectCommentUpdateApiVersion,
} from '../../../src/tools/tasks/comments/CommentOperationsService';
import { vikunjaRestRequest } from '../../../src/utils/vikunja-rest';
import { vikunjaRestV2Request } from '../../../src/utils/vikunja-rest-v2';

const mockRest = vikunjaRestRequest as jest.Mock;
const mockRestV2 = vikunjaRestV2Request as jest.Mock;

interface RestCall {
  method: string;
  path: string;
  body?: unknown;
}

const AUTHOR = {
  id: 1,
  username: 'e2e-test',
  email: 'e2e-test@vikunja-mcp.local',
  created: '2026-09-01T23:40:41Z',
  updated: '2026-09-01T23:40:41Z',
};

/** What v2's `PATCH` answers: the full, correct comment. */
const V2_PATCH_RESPONSE = {
  id: 45,
  comment: '<p>patched <em>italic</em> body</p>',
  author: AUTHOR,
  reactions: null,
  created: '2026-09-05T22:22:27Z',
  updated: '2026-09-05T22:22:28Z',
};

/**
 * What v1's `POST` answers. `author: null` and the zero `created` are not a
 * mistake in this fixture: v1 really echoes them, on every supported version,
 * while leaving the stored row intact.
 */
const V1_POST_RESPONSE = {
  id: 45,
  comment: '<p>patched <em>italic</em> body</p>',
  author: null,
  reactions: null,
  created: '0001-01-01T00:00:00Z',
  updated: '2026-09-05T22:22:28Z',
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

function recordCalls(mock: jest.Mock, result: unknown): RestCall[] {
  const calls: RestCall[] = [];
  mock.mockImplementation((...args: unknown[]) => {
    const [, method, path, body] = args as [unknown, string, string, unknown];
    calls.push({ method, path, body });
    return Promise.resolve(result);
  });
  return calls;
}

/** The error shape the v2 transport produces for an empty `304`. */
function notModifiedError(): MCPError {
  return new MCPError(
    ErrorCode.API_ERROR,
    'Vikunja REST request failed (PATCH /tasks/123/comments/45): HTTP 304 Not Modified',
    { statusCode: 304 },
  );
}

describe('comment update API version selection', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    ConfigurationManager.reset();
  });

  afterEach(() => {
    delete process.env.VIKUNJA_MCP_FORCE_V1_API;
    ConfigurationManager.reset();
  });

  // The point of the item: no minVersion floor, so the floor release gets v2
  // as well. Copying task update's 2.5.0 here would have been cargo cult.
  it.each(['v2.4.0', 'v2.5.0', 'v2.6.0'])('selects v2 on %s', (serverVersion) => {
    expect(selectCommentUpdateApiVersion(authManagerFor({ serverVersion }))).toBe('v2');
  });

  it('selects v2 even when the server version could not be detected, since no floor applies', () => {
    expect(selectCommentUpdateApiVersion(authManagerFor({ serverVersion: undefined }))).toBe('v2');
  });

  it('selects v1 when the kill switch is on, even on 2.6.0', () => {
    process.env.VIKUNJA_MCP_FORCE_V1_API = 'true';
    ConfigurationManager.reset();

    expect(selectCommentUpdateApiVersion(authManagerFor({ serverVersion: 'v2.6.0' }))).toBe('v1');
  });

  it('selects v1 when the server reports no v2 API', () => {
    expect(
      selectCommentUpdateApiVersion(authManagerFor({ hasV2Api: false, serverVersion: 'v2.6.0' })),
    ).toBe('v1');
  });

  it('selects v1 when capability detection has not run for the session', () => {
    expect(selectCommentUpdateApiVersion(authManagerFor({ withCapabilities: false }))).toBe('v1');
  });

  // Callers hold auth-manager-shaped objects that predate capability
  // detection (tests/tools/task-subresource-tools-read-only.test.ts builds
  // exactly one); an update must degrade to v1 rather than throw.
  it('selects v1 for an auth manager that has no getCapabilities at all', () => {
    const bare = { getSession: () => ({}) } as unknown as AuthManager;

    expect(selectCommentUpdateApiVersion(bare)).toBe('v1');
  });
});

describe('CommentOperationsService.updateComment on v2', () => {
  let authManager: AuthManager;

  beforeEach(() => {
    jest.clearAllMocks();
    ConfigurationManager.reset();
    authManager = authManagerFor({ serverVersion: 'v2.6.0' });
  });

  afterEach(() => {
    ConfigurationManager.reset();
  });

  it('sends one PATCH with only the comment field and no v1 call at all', async () => {
    const v2Calls = recordCalls(mockRestV2, V2_PATCH_RESPONSE);

    await CommentOperationsService.updateComment(authManager, 123, 45, 'Updated text');

    expect(v2Calls).toEqual([
      { method: 'PATCH', path: '/tasks/123/comments/45', body: { comment: 'Updated text' } },
    ]);
    expect(mockRest).not.toHaveBeenCalled();
  });

  // The read/write asymmetry, pinned. `format` is declared on v2's GET/POST/PUT
  // and not on PATCH, and a live `PATCH ...?format=markdown` returned HTML with
  // a 200 on all three versions. Sending it would be a silent no-op that reads
  // like an intention.
  it('does not ask for markdown on the patch', async () => {
    const v2Calls = recordCalls(mockRestV2, V2_PATCH_RESPONSE);

    await CommentOperationsService.updateComment(authManager, 123, 45, 'Updated text');

    expect(v2Calls[0]?.path).not.toContain('format');
  });

  it('returns the same field set the v1 path returns, with v2-only fields dropped', async () => {
    recordCalls(mockRestV2, { ...V2_PATCH_RESPONSE, max_permission: 2, $schema: 'ignored' });

    const updated = await CommentOperationsService.updateComment(authManager, 123, 45, 'Updated');

    expect(updated).toEqual({
      task_id: 123,
      id: 45,
      comment: '<p>patched <em>italic</em> body</p>',
      author: AUTHOR,
      created: '2026-09-05T22:22:27Z',
      updated: '2026-09-05T22:22:28Z',
    });
  });

  // Fields the caller never mentioned survive the patch — the merge-patch
  // property this step exists to gain, verified live by re-reading after a
  // one-field PATCH.
  it('carries through the author and creation time the patch preserved', async () => {
    recordCalls(mockRestV2, V2_PATCH_RESPONSE);

    const updated = await CommentOperationsService.updateComment(authManager, 123, 45, 'Updated');

    expect(updated.author).toEqual(AUTHOR);
    expect(updated.created).toBe('2026-09-05T22:22:27Z');
  });

  it('re-reads over v1 when the patch would change nothing and the server answers 304', async () => {
    mockRestV2.mockRejectedValue(notModifiedError());
    const v1Calls = recordCalls(mockRest, V2_PATCH_RESPONSE);

    const updated = await CommentOperationsService.updateComment(
      authManager,
      123,
      45,
      '<p>patched <em>italic</em> body</p>',
    );

    expect(v1Calls).toEqual([{ method: 'GET', path: '/tasks/123/comments/45', body: undefined }]);
    expect(updated.comment).toBe('<p>patched <em>italic</em> body</p>');
    expect(updated.task_id).toBe(123);
  });

  // The 304 re-read must not request markdown, or a no-op update would answer
  // in a different format from a real one.
  it('does not ask for markdown on the 304 re-read', async () => {
    mockRestV2.mockRejectedValue(notModifiedError());
    const v1Calls = recordCalls(mockRest, V2_PATCH_RESPONSE);

    await CommentOperationsService.updateComment(authManager, 123, 45, 'same');

    expect(v1Calls[0]?.path).not.toContain('format');
  });

  it('propagates any other v2 failure untouched', async () => {
    const notFound = new MCPError(
      ErrorCode.API_ERROR,
      'Vikunja REST request failed (PATCH /tasks/123/comments/45): HTTP 404 Not Found — Not Found: This task comment does not exist',
      { statusCode: 404 },
    );
    mockRestV2.mockRejectedValue(notFound);

    await expect(
      CommentOperationsService.updateComment(authManager, 123, 45, 'Updated'),
    ).rejects.toBe(notFound);
    expect(mockRest).not.toHaveBeenCalled();
  });
});

describe('CommentOperationsService.updateComment on v1', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    ConfigurationManager.reset();
  });

  afterEach(() => {
    delete process.env.VIKUNJA_MCP_FORCE_V1_API;
    ConfigurationManager.reset();
  });

  it('keeps the unchanged POST when the kill switch is on', async () => {
    process.env.VIKUNJA_MCP_FORCE_V1_API = 'true';
    ConfigurationManager.reset();
    const v1Calls = recordCalls(mockRest, V1_POST_RESPONSE);

    await CommentOperationsService.updateComment(
      authManagerFor({ serverVersion: 'v2.6.0' }),
      123,
      45,
      'Updated text',
    );

    expect(v1Calls).toEqual([
      { method: 'POST', path: '/tasks/123/comments/45', body: { comment: 'Updated text' } },
    ]);
    expect(mockRestV2).not.toHaveBeenCalled();
  });

  it('keeps the unchanged POST for a session that never ran capability detection', async () => {
    const v1Calls = recordCalls(mockRest, V1_POST_RESPONSE);

    await CommentOperationsService.updateComment(
      authManagerFor({ withCapabilities: false }),
      123,
      45,
      'Updated text',
    );

    expect(v1Calls).toEqual([
      { method: 'POST', path: '/tasks/123/comments/45', body: { comment: 'Updated text' } },
    ]);
    expect(mockRestV2).not.toHaveBeenCalled();
  });

  // Both paths produce the same object shape. The values differ only where v1's
  // response is itself wrong: it echoes a null author and a zero creation time
  // that its own stored row does not have.
  it('produces the same field set as the v2 path', async () => {
    recordCalls(mockRest, V1_POST_RESPONSE);

    const updated = await CommentOperationsService.updateComment(
      authManagerFor({ withCapabilities: false }),
      123,
      45,
      'Updated text',
    );

    recordCalls(mockRestV2, V2_PATCH_RESPONSE);
    const viaV2 = await CommentOperationsService.updateComment(
      authManagerFor({ serverVersion: 'v2.6.0' }),
      123,
      45,
      'Updated text',
    );

    expect(Object.keys(updated).sort()).toEqual(Object.keys(viaV2).sort());
  });
});
