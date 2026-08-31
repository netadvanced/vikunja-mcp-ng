/**
 * Per-execution cancellation context.
 *
 * The rate-limit middleware (`src/middleware/simplified-rate-limit.ts`) puts
 * a deadline on every tool call. Before #263/LOW-20 that deadline was a bare
 * `setTimeout` racing the handler: the timer was never cleared (so a 30s —
 * or, for the `export` category, 10-minute — timer stayed armed long after a
 * fast call had returned) and, worse, losing the race did nothing to the
 * handler. The caller got `TIMEOUT_ERROR` while the underlying request kept
 * running against Vikunja and could still commit a write the caller had
 * already been told did not happen.
 *
 * This module is the cancellation half of the fix. The middleware creates one
 * `AbortController` per tool execution and runs the handler inside
 * `runWithExecutionSignal`; anything downstream can pick the signal back up
 * with `getExecutionAbortSignal()` and actually stop work when the deadline
 * elapses. `src/utils/vikunja-rest.ts` does exactly that: it hands the signal
 * to `fetch`, so an expired deadline aborts the in-flight HTTP request rather
 * than orphaning it.
 *
 * Same shape and the same degradation rules as `src/context/requestContext.ts`:
 * an `AsyncLocalStorage` scope that simply reads back `undefined` when nobody
 * opened one. Code paths reached outside a rate-limited tool call (direct
 * library use, tests) therefore behave exactly as they did before — no signal,
 * no `signal` key on the `fetch` options, no behavior change.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

const executionSignalStorage = new AsyncLocalStorage<AbortSignal>();

/**
 * Run `fn` with `signal` bound as the ambient execution-cancellation signal.
 * Returns whatever `fn` returns (typically the handler's pending promise).
 */
export function runWithExecutionSignal<T>(signal: AbortSignal, fn: () => T): T {
  return executionSignalStorage.run(signal, fn);
}

/**
 * The cancellation signal for the tool execution currently in flight, or
 * `undefined` when running outside one. Callers MUST treat `undefined` as
 * "no deadline applies" rather than as an error.
 */
export function getExecutionAbortSignal(): AbortSignal | undefined {
  return executionSignalStorage.getStore();
}
