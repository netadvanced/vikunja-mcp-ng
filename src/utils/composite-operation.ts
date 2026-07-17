/**
 * CompositeOperation — a lightweight saga helper for sequencing multi-step
 * Vikunja operations (e.g. create task -> attach file -> update task) with
 * optional, per-step compensation.
 *
 * This is deliberately **NOT** a transaction system. Vikunja's REST API has
 * no multi-step isolation or atomicity primitive:
 *   - There is no isolation: concurrent readers/writers can observe
 *     intermediate state while a composite operation is mid-flight.
 *   - Side effects from intermediate writes (webhooks, notifications,
 *     activity-feed entries, etc.) fire immediately and are NOT undone by a
 *     later rollback — "rollback" here means "best-effort compensating
 *     actions run against the live API", not "as if it never happened".
 *   - Compensation is only as good as the `compensate()` function supplied
 *     for a step. A step with no `compensate()` simply cannot be undone.
 *
 * Two modes, chosen per invocation (opt-in atomicity — see rule (a) below):
 *   - **best-effort** (default): if a step fails, execution stops and
 *     already-succeeded steps are left exactly as they are. The trace
 *     reports a partial success, matching the batch-import precedent used
 *     elsewhere in this codebase (`bulkUpdateTasks` et al.).
 *   - **atomic** (`{ atomic: true }` on the constructor and/or `run()`):
 *     if a step fails, every previously-succeeded step's `compensate()` is
 *     invoked in **reverse** order, attempting to undo it.
 *
 * Design rules baked into this implementation (locked in issue #28):
 *   (a) atomic rollback is opt-in per invocation; default is best-effort.
 *   (b) destructive steps (`destructive: true`, e.g. deletes) must be
 *       registered last — Vikunja has no undelete, so a compensatable step
 *       registered *after* a destructive one is rejected at `addStep()`
 *       time (or merely warned about, depending on
 *       `destructiveOrderPolicy`).
 *   (c) a step may define `captureBefore()` to snapshot state ahead of a
 *       mutating `execute()`, so the existing fetch-merge-POST pattern's
 *       snapshot slots in naturally as the restore source for
 *       `compensate()`.
 *   (d) concurrent-edit guard: `compensate()` receives `expectedUpdated`
 *       (the `updated` timestamp implied by this step's own `execute()`
 *       result, when present). A `compensate()` implementation that fetches
 *       the live resource before restoring it should compare the
 *       resource's current `updated` field against `expectedUpdated` and,
 *       if they differ, return `{ skipped: 'concurrent-edit', guidance }`
 *       instead of clobbering someone else's intervening change. This is
 *       surfaced in the trace as `compensation-skipped-concurrent-edit`.
 *   (e) this is not ACID — see the module doc above.
 *
 * This module is intentionally domain-agnostic: it knows nothing about
 * Vikunja's REST shapes. Wiring it into actual tools (create -> attach ->
 * update flows, etc.) is deferred to a later wave; this module ships with
 * exhaustive unit tests plus one integration-style test that simulates a
 * realistic 3-step composite against mocks.
 */

import { logger } from './logger';

/** Per-step lifecycle status recorded in the trace. */
export type StepStatus =
  | 'succeeded'
  | 'failed'
  | 'compensated'
  | 'compensation-failed'
  | 'compensation-skipped-concurrent-edit'
  | 'skipped';

/** Raised synchronously by `addStep()` when destructive ordering (rule b) is violated in `'error'` policy, or when a duplicate step name is registered. */
export class CompositeOperationValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CompositeOperationValidationError';
  }
}

/** Context passed to `execute()` and `captureBefore()`. */
export interface StepRunContext {
  /** Results of previously-succeeded steps, keyed by step name. */
  readonly results: ReadonlyMap<string, unknown>;
}

/** Signal a compensate() implementation can return to report a concurrent-edit skip instead of throwing. */
export interface CompensationSkipped {
  skipped: 'concurrent-edit';
  /** Human-readable explanation of why compensation was skipped and what the caller should check. */
  guidance: string;
}

/** Return value of a `compensate()` call. `undefined` means "compensated successfully". */
export type CompensationOutcome = CompensationSkipped | undefined;

/** Context passed to `compensate()`. */
export interface CompensationContext<TResult = unknown, TBefore = unknown> {
  /** The value this step's own `execute()` returned. */
  result: TResult;
  /** The snapshot captured by this step's `captureBefore()`, if any. */
  before: TBefore | undefined;
  /**
   * Concurrency guard value: the `updated` timestamp implied by this step's
   * own write, extracted from `result.updated` when `result` is an object
   * with a string `updated` property, else `undefined`. See rule (d).
   */
  expectedUpdated: string | undefined;
  /** The error that triggered the rollback (from whichever step failed). */
  triggeringError: unknown;
}

/** A single named step in a composite operation. */
export interface CompositeStep<TResult = unknown, TBefore = unknown> {
  /** Unique (within the operation) human-readable step name, used in traces and guidance text. */
  name: string;
  /** Flags this step as a destructive/irreversible operation (e.g. a delete). See rule (b). */
  destructive?: boolean;
  /** Optional pre-execute snapshot hook; its result is threaded into `compensate()` as `before`. */
  captureBefore?: (ctx: StepRunContext) => Promise<TBefore> | TBefore;
  /** Performs the step's work. Throwing aborts the run and (in atomic mode) triggers rollback. */
  execute: (ctx: StepRunContext) => Promise<TResult> | TResult;
  /** Optional compensating action, invoked only in atomic mode after a later step fails. */
  compensate?: (ctx: CompensationContext<TResult, TBefore>) => Promise<CompensationOutcome> | CompensationOutcome;
}

/** Trace entry for a single step, always present for every registered step regardless of whether it ran. */
export interface StepTrace {
  name: string;
  status: StepStatus;
  destructive: boolean;
  /** The error thrown by `execute()`, present when `status === 'failed'`. */
  error?: unknown;
  /** The error thrown by `compensate()`, present when `status === 'compensation-failed'`. */
  compensationError?: unknown;
  /** Human-readable guidance, present whenever this step's outcome needs a human's attention. */
  guidance?: string;
}

/** Full result of a `run()` call. */
export interface CompositeOperationResult {
  /** True only when every registered step succeeded. */
  ok: boolean;
  /** Whether atomic rollback was in effect for this run. */
  atomic: boolean;
  /** Per-step trace, one entry per registered step, in registration order. */
  steps: StepTrace[];
  /** The error that stopped the run, if any. */
  error?: unknown;
  /**
   * True when the run left the system in a state that needs a human to look
   * at it: a best-effort partial success, an atomic rollback that hit
   * `compensation-failed` or `compensation-skipped-concurrent-edit`, or a
   * succeeded step with no `compensate()` that atomic mode could not touch.
   */
  manualFixRequired: boolean;
  /** Aggregate human-readable guidance summarizing what was and wasn't rolled back, present whenever `manualFixRequired` is true. */
  guidance?: string;
}

export interface CompositeOperationOptions {
  /** Opt into atomic rollback for this run. Default: `false` (best-effort). See rule (a). */
  atomic?: boolean;
  /**
   * How to enforce rule (b) (destructive steps must be last) when
   * `addStep()` sees a compensatable step registered after a destructive
   * one. `'error'` (default) throws `CompositeOperationValidationError`;
   * `'warn'` logs via the shared logger and allows the registration.
   */
  destructiveOrderPolicy?: 'error' | 'warn';
}

function hasStringUpdatedField(value: unknown): value is { updated: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'updated' in value &&
    typeof (value as { updated?: unknown }).updated === 'string'
  );
}

function extractExpectedUpdated(result: unknown): string | undefined {
  return hasStringUpdatedField(result) ? result.updated : undefined;
}

function isCompensationSkipped(outcome: CompensationOutcome): outcome is CompensationSkipped {
  return typeof outcome === 'object' && outcome !== null && outcome.skipped === 'concurrent-edit';
}

/**
 * Internal, type-erased representation of a registered step. `addStep()`
 * captures each step's `TResult`/`TBefore` generics in closures over typed
 * local variables so the erasure to `unknown` never needs an `any` cast.
 */
interface ErasedStep {
  name: string;
  destructive: boolean;
  captureBefore?: (ctx: StepRunContext) => Promise<unknown>;
  execute: (ctx: StepRunContext) => Promise<unknown>;
  compensate?: (ctx: CompensationContext) => Promise<CompensationOutcome> | CompensationOutcome;
}

/**
 * Collects named steps and runs them in order, with optional atomic
 * rollback on failure. See the module doc comment for the full design.
 */
export class CompositeOperation {
  private readonly steps: ErasedStep[] = [];
  private readonly defaultAtomic: boolean;
  private readonly destructiveOrderPolicy: 'error' | 'warn';
  private lastDestructiveStepName: string | undefined;

  constructor(options: CompositeOperationOptions = {}) {
    this.defaultAtomic = options.atomic ?? false;
    this.destructiveOrderPolicy = options.destructiveOrderPolicy ?? 'error';
  }

  /**
   * Registers a step. Enforces rule (b): once a destructive step has been
   * registered, no further step may declare a `compensate()` — such a step
   * would be rolled back "past" an irreversible delete, which cannot be
   * made whole again.
   */
  addStep<TResult, TBefore>(step: CompositeStep<TResult, TBefore>): this {
    if (this.steps.some((existing) => existing.name === step.name)) {
      throw new CompositeOperationValidationError(
        `Duplicate step name "${step.name}": step names must be unique within a CompositeOperation.`,
      );
    }

    if (this.lastDestructiveStepName !== undefined && step.compensate) {
      const message =
        `Step "${step.name}" defines compensate() but is registered after destructive step ` +
        `"${this.lastDestructiveStepName}". Destructive steps (deletes) must be sequenced last — ` +
        `Vikunja has no undelete, so a compensatable step after a destructive one cannot be made safe.`;
      if (this.destructiveOrderPolicy === 'error') {
        throw new CompositeOperationValidationError(message);
      }
      logger.warn(message);
    }

    if (step.destructive) {
      this.lastDestructiveStepName = step.name;
    }

    const captureBeforeFn = step.captureBefore;
    const executeFn = step.execute;
    const compensateFn = step.compensate;

    const erased: ErasedStep = {
      name: step.name,
      destructive: !!step.destructive,
      execute: (ctx: StepRunContext): Promise<unknown> => Promise.resolve(executeFn(ctx)),
    };
    if (captureBeforeFn) {
      erased.captureBefore = (ctx: StepRunContext): Promise<unknown> => Promise.resolve(captureBeforeFn(ctx));
    }
    if (compensateFn) {
      erased.compensate = (ctx: CompensationContext): Promise<CompensationOutcome> | CompensationOutcome =>
        compensateFn(ctx as CompensationContext<TResult, TBefore>);
    }

    this.steps.push(erased);
    return this;
  }

  /** Registered steps, in registration order. Exposed for introspection/tests. */
  getSteps(): ReadonlyArray<ErasedStep> {
    return this.steps;
  }

  /**
   * Executes all registered steps in order. On failure, stops execution
   * immediately; in atomic mode, compensates every previously-succeeded
   * step in reverse order. Always returns a full trace covering every
   * registered step (never throws — failures are reported in the result).
   */
  async run(options: CompositeOperationOptions = {}): Promise<CompositeOperationResult> {
    const atomic = options.atomic ?? this.defaultAtomic;
    const results = new Map<string, unknown>();
    const beforeSnapshots = new Map<string, unknown>();
    const traces: StepTrace[] = this.steps.map((step) => ({
      name: step.name,
      status: 'skipped' as StepStatus,
      destructive: step.destructive,
    }));
    const succeeded: Array<{ index: number; step: ErasedStep }> = [];
    let failureError: unknown;
    let failedIndex = -1;
    let failedStepName = '';

    for (const [index, step] of this.steps.entries()) {
      const ctx: StepRunContext = { results };
      try {
        if (step.captureBefore) {
          const before = await step.captureBefore(ctx);
          beforeSnapshots.set(step.name, before);
        }
        const result = await step.execute(ctx);
        results.set(step.name, result);
        traces[index] = { name: step.name, status: 'succeeded', destructive: step.destructive };
        succeeded.push({ index, step });
      } catch (err) {
        traces[index] = { name: step.name, status: 'failed', destructive: step.destructive, error: err };
        failureError = err;
        failedIndex = index;
        failedStepName = step.name;
        break;
      }
    }

    if (failedIndex === -1) {
      return { ok: true, atomic, steps: traces, manualFixRequired: false };
    }

    if (!atomic) {
      const manualFixRequired = succeeded.length > 0;
      const guidance = manualFixRequired
        ? this.buildGuidance(traces, failedStepName, failedIndex, atomic)
        : undefined;
      return {
        ok: false,
        atomic,
        steps: traces,
        error: failureError,
        manualFixRequired,
        ...(guidance !== undefined ? { guidance } : {}),
      };
    }

    for (const { index, step } of [...succeeded].reverse()) {
      if (!step.compensate) {
        const guidance = step.destructive
          ? `Step "${step.name}" performed a destructive operation with no compensate() defined. ` +
            `Vikunja has no undelete — this cannot be automatically rolled back. Manually verify whether recovery is needed.`
          : `Step "${step.name}" succeeded but defines no compensate(), so it was left as-is. Manually verify/undo if needed.`;
        traces[index] = { name: step.name, status: 'succeeded', destructive: step.destructive, guidance };
        continue;
      }

      const resultValue = results.get(step.name);
      const before = beforeSnapshots.get(step.name);
      const compensationContext: CompensationContext = {
        result: resultValue,
        before,
        expectedUpdated: extractExpectedUpdated(resultValue),
        triggeringError: failureError,
      };

      try {
        const outcome = await step.compensate(compensationContext);
        if (isCompensationSkipped(outcome)) {
          traces[index] = {
            name: step.name,
            status: 'compensation-skipped-concurrent-edit',
            destructive: step.destructive,
            guidance: outcome.guidance,
          };
        } else {
          traces[index] = { name: step.name, status: 'compensated', destructive: step.destructive };
        }
      } catch (compErr) {
        traces[index] = {
          name: step.name,
          status: 'compensation-failed',
          destructive: step.destructive,
          compensationError: compErr,
          guidance:
            `Compensation for step "${step.name}" FAILED — this step's effects were NOT rolled back. ` +
            `Manually inspect and, if necessary, manually undo step "${step.name}" (compensation error: ` +
            `${describeError(compErr)}).`,
        };
      }
    }

    const manualFixRequired = traces.some(
      (t) =>
        t.status === 'compensation-failed' ||
        t.status === 'compensation-skipped-concurrent-edit' ||
        (t.status === 'succeeded' && t.guidance !== undefined),
    );

    const aggregateGuidance = manualFixRequired
      ? this.buildGuidance(traces, failedStepName, failedIndex, atomic)
      : undefined;

    return {
      ok: false,
      atomic,
      steps: traces,
      error: failureError,
      manualFixRequired,
      ...(aggregateGuidance !== undefined ? { guidance: aggregateGuidance } : {}),
    };
  }

  private buildGuidance(traces: StepTrace[], failedStepName: string, failedIndex: number, atomic: boolean): string {
    const lines: string[] = [
      `Composite operation failed at step "${failedStepName}" (step ${failedIndex + 1} of ${traces.length}), ` +
        `running in ${atomic ? 'atomic' : 'best-effort'} mode.`,
    ];

    for (const trace of traces) {
      switch (trace.status) {
        case 'succeeded':
          lines.push(
            trace.guidance
              ? `  - "${trace.name}": succeeded, NOT rolled back. ${trace.guidance}`
              : `  - "${trace.name}": succeeded and left in place.`,
          );
          break;
        case 'compensated':
          lines.push(`  - "${trace.name}": succeeded, then rolled back successfully.`);
          break;
        case 'compensation-failed':
          // guidance is always set alongside this status (see the catch block in run())
          lines.push(`  - "${trace.name}": succeeded, rollback FAILED. ${trace.guidance}`);
          break;
        case 'compensation-skipped-concurrent-edit':
          // guidance is always set alongside this status (CompensationSkipped.guidance is required)
          lines.push(`  - "${trace.name}": succeeded, rollback skipped (concurrent edit detected). ${trace.guidance}`);
          break;
        case 'failed':
          lines.push(`  - "${trace.name}": failed with the triggering error.`);
          break;
        case 'skipped':
          lines.push(`  - "${trace.name}": never attempted.`);
          break;
      }
    }

    return lines.join('\n');
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
