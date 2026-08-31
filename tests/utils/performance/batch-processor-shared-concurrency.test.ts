/**
 * Cross-request concurrency guarantee for `BatchProcessor` (issue #288 /
 * HIGH-17, plus the `concurrencyUtilization` metric from #296 / LOW-17).
 *
 * `processBatches` used to build a fresh `Semaphore` per call, so a
 * processor's `maxConcurrency` only ever constrained ONE call. The bulk-task
 * processors are process-wide module singletons, and under the oidc-http
 * transport a single process serves many identities concurrently: N
 * simultaneous bulk-create calls produced N independent create batches
 * against the same upstream Vikunja, which is exactly the SQLite
 * lock-storm/breaker-cascade shape the `maxConcurrency: 1` default exists to
 * prevent (democratize-technology/vikunja-mcp#116).
 *
 * The semaphore now lives on the processor instance, so the limit holds
 * across every caller of that processor for the life of the process.
 */

import { describe, it, expect } from '@jest/globals';
import { BatchProcessor } from '../../../src/utils/performance/batch-processor';

jest.mock('../../../src/utils/logger');

/** Records the high-water mark of simultaneously in-flight operations. */
function makeConcurrencyProbe(): {
  run: (delayMs?: number) => Promise<void>;
  peak: () => number;
} {
  let active = 0;
  let peak = 0;
  return {
    run: async (delayMs = 5) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      active--;
    },
    peak: () => peak,
  };
}

describe('BatchProcessor shared concurrency (issue #288)', () => {
  it('holds maxConcurrency 1 across concurrent processBatches calls, not just within one', async () => {
    const processor = new BatchProcessor({
      maxConcurrency: 1,
      batchSize: 10,
      enableMetrics: false,
      batchDelay: 0,
    });
    const probe = makeConcurrencyProbe();

    // Three "requests" from three different identities, all in flight at once.
    await Promise.all([
      processor.processBatches([1, 2, 3], async () => probe.run()),
      processor.processBatches([4, 5, 6], async () => probe.run()),
      processor.processBatches([7, 8, 9], async () => probe.run()),
    ]);

    expect(probe.peak()).toBe(1);
  });

  it('holds a higher shared limit across concurrent calls too', async () => {
    const processor = new BatchProcessor({
      maxConcurrency: 3,
      batchSize: 10,
      enableMetrics: false,
      batchDelay: 0,
    });
    const probe = makeConcurrencyProbe();

    await Promise.all(
      Array.from({ length: 4 }, () =>
        processor.processBatches([1, 2, 3, 4, 5], async () => probe.run()),
      ),
    );

    expect(probe.peak()).toBeLessThanOrEqual(3);
    // Sanity: the limit is a ceiling, not an accidental serialization.
    expect(probe.peak()).toBeGreaterThan(1);
  });

  it('keeps separate processor instances independent', async () => {
    const options = {
      maxConcurrency: 1,
      batchSize: 10,
      enableMetrics: false,
      batchDelay: 0,
    };
    const a = new BatchProcessor(options);
    const b = new BatchProcessor(options);
    const probe = makeConcurrencyProbe();

    await Promise.all([
      a.processBatches([1, 2], async () => probe.run()),
      b.processBatches([3, 4], async () => probe.run()),
    ]);

    // Two independent processors (e.g. `create` and `delete`) must not
    // serialize against each other.
    expect(probe.peak()).toBe(2);
  });

  it('applies a per-call maxConcurrency override to the shared limit', async () => {
    const processor = new BatchProcessor({
      maxConcurrency: 1,
      batchSize: 10,
      enableMetrics: false,
      batchDelay: 0,
    });
    const probe = makeConcurrencyProbe();

    await Promise.all([
      processor.processBatches([1, 2, 3, 4], async () => probe.run(), { maxConcurrency: 2 }),
      processor.processBatches([5, 6, 7, 8], async () => probe.run(), { maxConcurrency: 2 }),
    ]);

    expect(probe.peak()).toBe(2);
  });

  it('releases its permits when an operation throws', async () => {
    const processor = new BatchProcessor({
      maxConcurrency: 1,
      batchSize: 10,
      enableMetrics: false,
      batchDelay: 0,
    });

    const failing = await processor.processBatches([1, 2, 3], async () => {
      await Promise.resolve();
      throw new Error('boom');
    });
    expect(failing.failed).toHaveLength(3);

    // A leaked permit would hang this call forever.
    const probe = makeConcurrencyProbe();
    const after = await processor.processBatches([4, 5], async () => probe.run(1));
    expect(after.successful).toHaveLength(2);
    expect(probe.peak()).toBe(1);
  });
});

describe('BatchProcessor concurrencyUtilization (issue #296 / LOW-17)', () => {
  it('reports near-full utilization when every slot is kept busy', async () => {
    const processor = new BatchProcessor({
      maxConcurrency: 2,
      batchSize: 10,
      enableMetrics: true,
      batchDelay: 0,
    });

    const result = await processor.processBatches([1, 2, 3, 4, 5, 6], async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    expect(result.metrics.concurrencyUtilization).toBeGreaterThan(0.5);
    expect(result.metrics.concurrencyUtilization).toBeLessThanOrEqual(1);
  });

  it('reports low utilization when most concurrency slots sit idle', async () => {
    const processor = new BatchProcessor({
      maxConcurrency: 8,
      batchSize: 10,
      enableMetrics: true,
      batchDelay: 0,
    });

    // One slow item against eight available slots: seven idle.
    const result = await processor.processBatches([1], async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    expect(result.metrics.concurrencyUtilization).toBeLessThan(0.5);
  });

  it('is not the old constant 1/maxConcurrency placeholder', async () => {
    const busy = new BatchProcessor({
      maxConcurrency: 4,
      batchSize: 10,
      enableMetrics: true,
      batchDelay: 0,
    });
    const idle = new BatchProcessor({
      maxConcurrency: 4,
      batchSize: 10,
      enableMetrics: true,
      batchDelay: 0,
    });

    const busyResult = await busy.processBatches([1, 2, 3, 4, 5, 6, 7, 8], async () => {
      await new Promise((resolve) => setTimeout(resolve, 15));
    });
    const idleResult = await idle.processBatches([1], async () => {
      await new Promise((resolve) => setTimeout(resolve, 15));
    });

    // The old heuristic returned 1/maxConcurrency (0.25 here) for both.
    expect(busyResult.metrics.concurrencyUtilization).toBeGreaterThan(
      idleResult.metrics.concurrencyUtilization,
    );
  });
});
