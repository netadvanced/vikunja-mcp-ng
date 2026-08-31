/**
 * Cross-request write serialization for the bulk task processors
 * (issue #288 / HIGH-17).
 *
 * `processors.create|update|delete` in
 * src/tools/tasks/bulk-operations-simplified.ts are process-wide module
 * singletons. Under `VIKUNJA_MCP_TRANSPORT=http` the server is stateless and
 * concurrent: `src/transport/httpTransport.ts` hands every incoming request
 * straight to `handleIncomingRequest` from a plain `http.createServer`
 * callback, with a fresh MCP server and transport per request and no queue,
 * mutex or per-process serialization anywhere in the path. So N identities
 * calling `vikunja_tasks bulk-create` at the same moment really do run N
 * `processBatches` calls concurrently in one process against one upstream
 * Vikunja — the reachability precondition #288 needed confirming.
 *
 * The batch processor's `maxConcurrency` used to be built per call, so the
 * sequential-creates guarantee (democratize-technology/vikunja-mcp#116, the
 * SQLite "database is locked" storm that trips the shared circuit breaker)
 * only held inside one request. These tests drive the real tool functions
 * concurrently and assert the guarantee now holds across requests.
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import {
  bulkCreateTasks,
  bulkDeleteTasks,
} from '../../../src/tools/tasks/bulk-operations-simplified';
import { AuthManager } from '../../../src/auth/AuthManager';
import { vikunjaRestRequest } from '../../../src/utils/vikunja-rest';

jest.mock('../../../src/utils/logger');
jest.mock('../../../src/utils/vikunja-rest', () => ({
  vikunjaRestRequest: jest.fn(),
}));

const mockRest = vikunjaRestRequest as jest.Mock;

/** Two different tenants of the same process, as in oidc-http mode. */
function identity(url: string, token: string): AuthManager {
  const auth = new AuthManager();
  auth.connect(url, token);
  return auth;
}

describe('bulk write serialization across concurrent requests (issue #288)', () => {
  let inFlightCreates = 0;
  let peakCreates = 0;
  let nextId = 1;

  beforeEach(() => {
    jest.clearAllMocks();
    inFlightCreates = 0;
    peakCreates = 0;
    nextId = 1;

    mockRest.mockImplementation(async (_auth: unknown, method: string, path: string) => {
      if (method === 'PUT' && /^\/projects\/\d+\/tasks$/.test(path)) {
        inFlightCreates++;
        peakCreates = Math.max(peakCreates, inFlightCreates);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlightCreates--;
        return { id: nextId++, title: 'created' };
      }
      if (method === 'GET' && /^\/tasks\/\d+$/.test(path)) {
        return { id: 1, title: 'created' };
      }
      if (method === 'DELETE' && /^\/tasks\/\d+$/.test(path)) {
        inFlightCreates++;
        peakCreates = Math.max(peakCreates, inFlightCreates);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlightCreates--;
        return undefined;
      }
      throw new Error(`mockRest: unhandled ${method} ${path}`);
    });
  });

  it('never runs two task creates at once, even from three different identities', async () => {
    const tasks = (prefix: string) =>
      Array.from({ length: 4 }, (_, i) => ({ title: `${prefix}-${i}` }));

    const results = await Promise.all([
      bulkCreateTasks(
        { projectId: 1, tasks: tasks('alice') },
        identity('https://vikunja.test', 'tk_alice'),
      ),
      bulkCreateTasks(
        { projectId: 2, tasks: tasks('bob') },
        identity('https://vikunja.test', 'tk_bob'),
      ),
      bulkCreateTasks(
        { projectId: 3, tasks: tasks('carol') },
        identity('https://vikunja.test', 'tk_carol'),
      ),
    ]);

    // The guarantee: one create in flight at a time, process-wide.
    expect(peakCreates).toBe(1);
    // ...and all three requests still complete successfully.
    for (const result of results) {
      expect(result.content[0].text).toContain('## ✅ Success');
    }
    const createCalls = mockRest.mock.calls.filter(
      (call) => call[1] === 'PUT' && /^\/projects\/\d+\/tasks$/.test(String(call[2])),
    );
    expect(createCalls).toHaveLength(12);
  });

  it('caps concurrent deletes at the delete processor limit across requests', async () => {
    const auth = identity('https://vikunja.test', 'tk_alice');
    const other = identity('https://vikunja.test', 'tk_bob');

    await Promise.all([
      bulkDeleteTasks({ taskIds: [1, 2, 3, 4, 5] }, auth),
      bulkDeleteTasks({ taskIds: [6, 7, 8, 9, 10] }, other),
    ]);

    // processors.delete is configured with maxConcurrency 3; without a shared
    // semaphore two concurrent requests reached 6.
    expect(peakCreates).toBeLessThanOrEqual(3);
  });

  it('still lets a single request use its full configured concurrency', async () => {
    // Guard against "fixed by accidentally serializing everything": the
    // delete processor is allowed 3 at a time and should actually use them.
    await bulkDeleteTasks({ taskIds: [1, 2, 3, 4, 5, 6] }, identity('https://v.test', 'tk_a'));

    expect(peakCreates).toBeGreaterThan(1);
  });
});
