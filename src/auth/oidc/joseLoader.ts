/**
 * Loads the `jose` package for production use.
 *
 * `jose@6` ships ESM-only (no CommonJS build); this project compiles to
 * CommonJS (see tsconfig.json's `module: "NodeNext"` with no `"type": "module"`
 * in package.json). A dynamic `import()` is the interop path the Node.js docs
 * themselves recommend for a CommonJS module consuming an ESM-only package,
 * and it works unmodified on every Node 20+ runtime this project targets —
 * unlike newer `require(esm)` semantics, it needs no engine-version caveats.
 *
 * This function is intentionally the *only* place that dynamic import lives.
 * Jest's CommonJS-mode test runner cannot execute a genuine dynamic `import()`
 * of a real ES module without globally enabling `--experimental-vm-modules`
 * (which, in turn, requires re-plumbing the whole suite's module handling and
 * was rejected as disproportionate for a single dependency — see the PR
 * description). So {@link createOidcJwtValidator} takes its `jose` functions
 * as an explicit, fully unit-testable dependency instead of importing them
 * itself; tests inject `jose`'s own statically-imported exports (which do
 * load fine under Jest, see tests/auth/oidc/jwtValidator.test.ts) and never
 * exercise this function. Only real Node execution (and the manual/e2e OIDC
 * lane) exercises this path, hence the coverage exclusion below.
 */

import type { JoseDeps } from './types';

let cachedDeps: Promise<JoseDeps> | undefined;

/**
 * The real dynamic import, factored out so {@link loadJose}'s caching logic
 * (the part that matters for the LOW-21 fix below) can be unit-tested with
 * an injected stub, even though this inner function itself still requires a
 * genuine Node runtime to exercise — see the file header.
 */
// See file header: only a genuine ESM dynamic import exercises this function;
// Jest cannot run one without --experimental-vm-modules, so no test calls it.
/* istanbul ignore next */
function importJose(): Promise<JoseDeps> {
  return import('jose');
}

/**
 * Loads (and caches) the `jose` package.
 *
 * LOW-21 (#296): a *rejected* import promise used to be cached forever — a
 * transient failure on the first call (e.g. the process starting before the
 * filesystem/network was fully ready) permanently broke JWT validation for
 * the rest of the process's life, since every later call returned the same
 * already-rejected promise instead of trying again. On rejection we now
 * clear `cachedDeps` before re-throwing, so the NEXT call retries the import
 * instead of replaying the stale failure. A successful import is still
 * cached forever, same as before.
 */
export function loadJose(importer: () => Promise<JoseDeps> = importJose): Promise<JoseDeps> {
  if (!cachedDeps) {
    cachedDeps = importer().catch((error: unknown) => {
      cachedDeps = undefined;
      throw error;
    });
  }
  return cachedDeps;
}
