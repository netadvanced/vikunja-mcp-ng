/**
 * Tests for the `VIKUNJA_BULK_WRITE_CONCURRENCY` override on bulk task creates.
 *
 * Bulk create runs sequentially by default (maxConcurrency 1) because
 * concurrent creates trigger a "database is locked" storm on SQLite-backed
 * Vikunja instances, which then trips the shared circuit breaker — see the long
 * comment on `processors.create` in
 * src/tools/tasks/bulk-operations-simplified.ts. The override lets an operator
 * whose backend is NOT SQLite trade that safety for throughput. Proposed by
 * @joyjit in democratize-technology/vikunja-mcp#97.
 *
 * Covered: unset (default), valid value, invalid values (non-numeric, zero,
 * negative, blank), over-cap value, and that the resolved value actually
 * reaches the batch processor rather than only being computed.
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import {
  getBulkWriteConcurrency,
  bulkCreateTasks,
} from '../../../src/tools/tasks/bulk-operations-simplified';
import { AuthManager } from '../../../src/auth/AuthManager';
import { BatchProcessor } from '../../../src/utils/performance/batch-processor';
import { vikunjaRestRequest } from '../../../src/utils/vikunja-rest';

jest.mock('../../../src/utils/logger');
jest.mock('../../../src/utils/vikunja-rest', () => ({
  vikunjaRestRequest: jest.fn(),
}));

const ENV_VAR = 'VIKUNJA_BULK_WRITE_CONCURRENCY';

describe('getBulkWriteConcurrency', () => {
  const original = process.env[ENV_VAR];

  afterEach(() => {
    if (original === undefined) {
      delete process.env[ENV_VAR];
    } else {
      process.env[ENV_VAR] = original;
    }
  });

  it('defaults to 1 (sequential) when the variable is unset', () => {
    delete process.env[ENV_VAR];
    expect(getBulkWriteConcurrency()).toBe(1);
  });

  it('defaults to 1 when the variable is blank', () => {
    process.env[ENV_VAR] = '   ';
    expect(getBulkWriteConcurrency()).toBe(1);
  });

  it('honours a valid positive integer', () => {
    process.env[ENV_VAR] = '4';
    expect(getBulkWriteConcurrency()).toBe(4);
  });

  it('tolerates surrounding whitespace', () => {
    process.env[ENV_VAR] = ' 3 ';
    expect(getBulkWriteConcurrency()).toBe(3);
  });

  it('falls back to the default for a non-numeric value instead of throwing', () => {
    process.env[ENV_VAR] = 'lots';
    expect(getBulkWriteConcurrency()).toBe(1);
  });

  it('falls back to the default for a fractional value', () => {
    process.env[ENV_VAR] = '2.5';
    expect(getBulkWriteConcurrency()).toBe(1);
  });

  it('falls back to the default for zero', () => {
    process.env[ENV_VAR] = '0';
    expect(getBulkWriteConcurrency()).toBe(1);
  });

  it('falls back to the default for a negative value', () => {
    process.env[ENV_VAR] = '-2';
    expect(getBulkWriteConcurrency()).toBe(1);
  });

  it('caps an absurdly high value at 10', () => {
    process.env[ENV_VAR] = '5000';
    expect(getBulkWriteConcurrency()).toBe(10);
  });
});

describe('bulkCreateTasks concurrency wiring', () => {
  const mockRest = vikunjaRestRequest as jest.Mock;
  const original = process.env[ENV_VAR];
  let authManager: AuthManager;
  let processSpy: jest.SpiedFunction<typeof BatchProcessor.prototype.processBatches>;

  beforeEach(() => {
    jest.clearAllMocks();
    authManager = new AuthManager();
    authManager.connect('https://vikunja.test', 'tk_test-token');
    mockRest.mockImplementation(async (_auth: unknown, method: string, path: string) => {
      if (method === 'PUT' && /^\/projects\/\d+\/tasks$/.test(path)) {
        return { id: 1, title: 'A' };
      }
      if (method === 'GET' && /^\/tasks\/\d+$/.test(path)) {
        return { id: 1, title: 'A' };
      }
      throw new Error(`mockRest: unhandled ${method} ${path}`);
    });
    processSpy = jest.spyOn(BatchProcessor.prototype, 'processBatches');
  });

  afterEach(() => {
    processSpy.mockRestore();
    if (original === undefined) {
      delete process.env[ENV_VAR];
    } else {
      process.env[ENV_VAR] = original;
    }
  });

  it('passes maxConcurrency 1 to the batch processor by default', async () => {
    delete process.env[ENV_VAR];

    await bulkCreateTasks({ projectId: 1, tasks: [{ title: 'A' }] }, authManager);

    expect(processSpy).toHaveBeenCalledWith(expect.anything(), expect.any(Function), {
      maxConcurrency: 1,
    });
  });

  it('passes the overridden maxConcurrency to the batch processor', async () => {
    process.env[ENV_VAR] = '5';

    await bulkCreateTasks({ projectId: 1, tasks: [{ title: 'A' }] }, authManager);

    expect(processSpy).toHaveBeenCalledWith(expect.anything(), expect.any(Function), {
      maxConcurrency: 5,
    });
  });

  it('falls back to 1 (and does not crash) when the override is invalid', async () => {
    process.env[ENV_VAR] = 'not-a-number';

    const result = await bulkCreateTasks({ projectId: 1, tasks: [{ title: 'A' }] }, authManager);

    expect(processSpy).toHaveBeenCalledWith(expect.anything(), expect.any(Function), {
      maxConcurrency: 1,
    });
    expect(result.content[0].text).toContain('## ✅ Success');
  });
});
