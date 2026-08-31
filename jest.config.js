/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src', '<rootDir>/tests'],
  testMatch: ['**/__tests__/**/*.ts', '**/?(*.)+(spec|test).ts'],
  // NOTE: the `--localstorage-file` warning suppressor is NOT wired up here
  // as a `setupFiles` entry — it runs too late (see
  // tests/setup/suppress-webstorage-warning.js for why). It's loaded via
  // `NODE_OPTIONS="--require ..."` in package.json's test scripts instead.
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.d.ts', '!src/**/__tests__/**'],
  // `jose` ships ESM-only; transpile it through babel-jest so CJS test
  // runs can import it (OIDC resource-server mode, feat/oidc-mode).
  transform: {
    '^.+\\.tsx?$': 'ts-jest',
    '^.+\\.jsx?$': [
      'babel-jest',
      { plugins: ['@babel/plugin-transform-modules-commonjs'] },
    ],
  },
  transformIgnorePatterns: ['/node_modules/(?!(jose)/)'],
  coverageThreshold: {
    global: {
      // Ratcheted gate — see CLAUDE.md "Coverage Thresholds" for policy.
      // Raise these in lockstep with honest coverage growth; never lower
      // except by explicit owner decision.
      // Raised 2026-08-31 (was 83/82/92/92, set 2026-07-27) after 17 merged
      // PRs lifted coverage on every axis: honest numbers are
      // 85.65 branches / 84.56 functions / 93.8 lines / 93.7 statements.
      // Same per-axis buffer preserved as the prior raise (~1.19 branches /
      // ~1.09 functions / ~1.14 lines / ~0.80 statements below honest).
      branches: 84.46,
      functions: 83.47,
      lines: 92.66,
      statements: 92.9,
    },
  },
  // --- "A worker process has failed to exit gracefully" (T4 investigation, 2026-07-21) ---
  // This cosmetic warning appears on default (parallel, multi-worker) runs of
  // this suite but is a known jest-worker teardown-race artifact here, not a
  // real leak:
  //   - `--detectOpenHandles` reports zero open handles — nothing to fix.
  //   - The warning never appears with `--runInBand` or `--maxWorkers=1`,
  //     i.e. it's specific to the parallel worker-pool teardown path itself,
  //     not to anything a specific test does.
  // This mirrors a prior investigation with the same conclusion. Do not chase
  // this further without new evidence (e.g. `--detectOpenHandles` starts
  // reporting an actual handle) — this is a documented dead end, not an
  // unfixed bug.
};
