/**
 * High-performance batch processor with controlled concurrency
 * Optimizes bulk operations by managing parallel execution with intelligent backpressure
 */

import { logger } from '../logger';

export interface BatchOptions {
  /**
   * Maximum number of concurrent operations (default: 5)
   * Higher values increase throughput but may overwhelm the API
   */
  maxConcurrency: number;

  /**
   * Batch size for each processing chunk (default: 10)
   * Balances memory usage with processing efficiency
   */
  batchSize: number;

  /**
   * Enable performance metrics collection (default: true)
   */
  enableMetrics: boolean;

  /**
   * Delay between batches in milliseconds (default: 0)
   * Useful for rate limiting or API throttling
   */
  batchDelay: number;
}

export interface BatchMetrics {
  totalItems: number;
  totalBatches: number;
  totalDuration: number;
  averageBatchDuration: number;
  successfulOperations: number;
  failedOperations: number;
  operationsPerSecond: number;
  /**
   * Fraction (0-1) of the available concurrency slots that were actually
   * busy: total operation busy time / (maxConcurrency * wall-clock duration).
   * 1 means every slot was occupied for the whole run; a low value means the
   * configured concurrency was never needed (few items, or time spent in
   * `batchDelay` rather than in operations).
   *
   * Previously a placeholder heuristic that always evaluated to exactly
   * `1 / maxConcurrency` regardless of what happened (#296 / LOW-17).
   */
  concurrencyUtilization: number;
}

export interface BatchResult<T> {
  successful: T[];
  failed: Array<{ index: number; error: unknown; originalItem: unknown }>;
  metrics: BatchMetrics;
}

const DEFAULT_OPTIONS: BatchOptions = {
  maxConcurrency: 5,
  batchSize: 10,
  enableMetrics: true,
  batchDelay: 0,
};

export class BatchProcessor {
  private readonly options: BatchOptions;
  private activeOperations = 0;
  private metrics: Partial<BatchMetrics> = {};
  /**
   * ONE semaphore per processor instance, shared by every concurrent
   * `processBatches` call on it.
   *
   * Each call used to build its own semaphore, which made `maxConcurrency` a
   * per-request guarantee only. The bulk-task processors are process-wide
   * module singletons and the oidc-http transport serves many identities from
   * one process, so N simultaneous requests produced N independent batches
   * hitting the same upstream Vikunja at once — reopening the SQLite
   * lock-storm / circuit-breaker cascade that `maxConcurrency: 1` on bulk
   * creates exists to prevent, now across tenants rather than within one
   * caller (issue #288 / HIGH-17).
   *
   * Holding it on the instance makes the limit process-wide for all users of
   * that processor. Waiters are served FIFO per item (not per call), so
   * concurrent requests interleave item by item instead of one starving
   * behind another's entire batch.
   */
  private readonly semaphore: Semaphore;

  constructor(options: Partial<BatchOptions> = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.semaphore = new Semaphore(this.options.maxConcurrency);
  }

  /**
   * Process items in optimized batches with controlled concurrency
   */
  async processBatches<TInput, TOutput>(
    items: TInput[],
    processor: (item: TInput, index: number) => Promise<TOutput>,
    options: Partial<BatchOptions> = {},
  ): Promise<BatchResult<TOutput>> {
    const opts = { ...this.options, ...options };
    const startTime = Date.now();

    // A per-call `maxConcurrency` override retunes the SHARED limit rather
    // than escaping it. In practice the only override in this codebase is
    // bulk-create's `VIKUNJA_BULK_WRITE_CONCURRENCY`, which is a process-wide
    // env var, so the value is stable across callers; if two callers ever
    // disagreed, the most recent one wins and the limit still binds everyone.
    this.semaphore.setLimit(opts.maxConcurrency);

    // Busy time summed across operations, for the utilization metric below.
    const stats = { busyTimeMs: 0 };

    if (opts.enableMetrics) {
      this.metrics = {
        totalItems: items.length,
        totalBatches: Math.ceil(items.length / opts.batchSize),
        successfulOperations: 0,
        failedOperations: 0,
      };
    }

    const successful: TOutput[] = [];
    const failed: Array<{ index: number; error: unknown; originalItem: TInput }> = [];
    const batchDurations: number[] = [];

    // Split items into batches
    const batches = this.createBatches(items, opts.batchSize);

    logger.debug('Starting batch processing', {
      totalItems: items.length,
      batchCount: batches.length,
      batchSize: opts.batchSize,
      maxConcurrency: opts.maxConcurrency,
    });

    for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
      const batch = batches[batchIndex];
      if (!batch) {
        throw new Error(`Batch at index ${batchIndex} is undefined`);
      }
      const batchStartTime = Date.now();

      // Process batch with controlled concurrency
      const batchResults = await this.processBatchConcurrently(
        batch,
        processor,
        batchIndex * opts.batchSize, // base index for this batch
        stats,
      );

      // Collect results
      for (const result of batchResults) {
        if (result.status === 'fulfilled') {
          successful.push(result.value);
          if (opts.enableMetrics)
            this.metrics.successfulOperations = (this.metrics.successfulOperations || 0) + 1;
        } else {
          failed.push(result.error);
          if (opts.enableMetrics)
            this.metrics.failedOperations = (this.metrics.failedOperations || 0) + 1;
        }
      }

      const batchDuration = Date.now() - batchStartTime;
      batchDurations.push(batchDuration);

      logger.debug('Batch completed', {
        batchIndex,
        batchSize: batch.length,
        duration: batchDuration,
        successful: batchResults.filter((r) => r.status === 'fulfilled').length,
        failed: batchResults.filter((r) => r.status === 'rejected').length,
      });

      // Apply inter-batch delay if configured
      if (opts.batchDelay > 0 && batchIndex < batches.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, opts.batchDelay));
      }
    }

    const totalDuration = Date.now() - startTime;

    // Calculate final metrics
    const finalMetrics: BatchMetrics = {
      totalItems: items.length,
      totalBatches: batches.length,
      totalDuration,
      averageBatchDuration:
        batchDurations.length > 0
          ? batchDurations.reduce((a, b) => a + b, 0) / batchDurations.length
          : 0,
      successfulOperations: successful.length,
      failedOperations: failed.length,
      operationsPerSecond:
        totalDuration > 0 ? (successful.length + failed.length) / (totalDuration / 1000) : 0,
      concurrencyUtilization: calculateConcurrencyUtilization(
        stats.busyTimeMs,
        totalDuration,
        opts.maxConcurrency,
      ),
    };

    if (opts.enableMetrics) {
      logger.info('Batch processing completed', finalMetrics);
    }

    return {
      successful,
      failed,
      metrics: finalMetrics,
    };
  }

  /**
   * Process a single batch with controlled concurrency using semaphore pattern
   */
  private async processBatchConcurrently<TInput, TOutput>(
    batch: Array<{ item: TInput; originalIndex: number }>,
    processor: (item: TInput, index: number) => Promise<TOutput>,
    _baseIndex: number,
    stats: { busyTimeMs: number },
  ): Promise<
    Array<
      | { status: 'fulfilled'; value: TOutput }
      | { status: 'rejected'; error: { index: number; error: unknown; originalItem: TInput } }
    >
  > {
    const promises = batch.map(async ({ item, originalIndex }) => {
      // The instance-wide semaphore, NOT a per-call one: see the field's doc
      // comment (issue #288).
      await this.semaphore.acquire();
      this.activeOperations++;
      const operationStart = Date.now();

      try {
        const result = await processor(item, originalIndex);
        return { status: 'fulfilled' as const, value: result };
      } catch (error) {
        return {
          status: 'rejected' as const,
          error: { index: originalIndex, error, originalItem: item },
        };
      } finally {
        stats.busyTimeMs += Date.now() - operationStart;
        this.activeOperations--;
        this.semaphore.release();
      }
    });

    return Promise.all(promises);
  }

  /**
   * Split items into batches with original indices preserved
   */
  private createBatches<T>(
    items: T[],
    batchSize: number,
  ): Array<Array<{ item: T; originalIndex: number }>> {
    const batches: Array<Array<{ item: T; originalIndex: number }>> = [];

    for (let i = 0; i < items.length; i += batchSize) {
      const batchItems = items.slice(i, i + batchSize).map((item, localIndex) => ({
        item,
        originalIndex: i + localIndex,
      }));
      batches.push(batchItems);
    }

    return batches;
  }

  /**
   * Get current processing statistics
   */
  getMetrics(): Partial<BatchMetrics> & { activeOperations: number } {
    return {
      ...this.metrics,
      activeOperations: this.activeOperations,
    };
  }
}

/**
 * How much of the available concurrency was actually used: the total time
 * operations spent running, over the time all slots could have been running
 * for. 1.0 means every slot stayed busy for the whole run.
 *
 * Replaces a heuristic that reduced algebraically to a constant
 * `1 / maxConcurrency` and therefore measured nothing (#296 / LOW-17).
 */
function calculateConcurrencyUtilization(
  busyTimeMs: number,
  totalDurationMs: number,
  maxConcurrency: number,
): number {
  const capacity = totalDurationMs * Math.max(1, maxConcurrency);
  if (capacity <= 0) return 0;
  return Math.min(1, busyTimeMs / capacity);
}

/**
 * Semaphore for controlling concurrency.
 *
 * Tracks permits IN USE against a mutable limit rather than a countdown, so
 * the limit can be retuned while operations are in flight (see
 * `BatchProcessor.processBatches`' per-call `maxConcurrency` override) without
 * losing or inventing permits. Waiters are released FIFO.
 */
class Semaphore {
  private limit: number;
  private inUse = 0;
  private waitQueue: Array<() => void> = [];

  constructor(limit: number) {
    this.limit = Math.max(1, limit);
  }

  /** Retune the ceiling; raising it immediately admits queued waiters. */
  setLimit(limit: number): void {
    const next = Math.max(1, limit);
    if (next === this.limit) return;
    this.limit = next;
    this.drain();
  }

  async acquire(): Promise<void> {
    if (this.inUse < this.limit) {
      this.inUse++;
      return;
    }

    return new Promise<void>((resolve) => {
      this.waitQueue.push(resolve);
    });
  }

  release(): void {
    // Guard against an underflow leaving a permanently negative count if a
    // caller ever released more than it acquired.
    this.inUse = Math.max(0, this.inUse - 1);
    this.drain();
  }

  /** Admit as many queued waiters as the current limit allows. */
  private drain(): void {
    while (this.inUse < this.limit && this.waitQueue.length > 0) {
      const resolve = this.waitQueue.shift();
      if (!resolve) return;
      this.inUse++;
      resolve();
    }
  }
}

// Export convenience functions for common patterns
export const createOptimizedBatchProcessor = (options?: Partial<BatchOptions>): BatchProcessor =>
  new BatchProcessor(options);

export const HIGH_THROUGHPUT_CONFIG: Partial<BatchOptions> = {
  maxConcurrency: 8,
  batchSize: 15,
  enableMetrics: true,
  batchDelay: 0,
};

export const RATE_LIMITED_CONFIG: Partial<BatchOptions> = {
  maxConcurrency: 3,
  batchSize: 5,
  enableMetrics: true,
  batchDelay: 100,
};

export const MEMORY_OPTIMIZED_CONFIG: Partial<BatchOptions> = {
  maxConcurrency: 4,
  batchSize: 8,
  enableMetrics: true,
  batchDelay: 50,
};
