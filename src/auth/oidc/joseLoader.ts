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

// See file header: only a genuine ESM dynamic import exercises this function;
// Jest cannot run one without --experimental-vm-modules, so no test calls it.
/* istanbul ignore next */
export function loadJose(): Promise<JoseDeps> {
  if (!cachedDeps) {
    cachedDeps = import('jose');
  }
  return cachedDeps;
}
