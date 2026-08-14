import { loadJose } from '../../../src/auth/oidc/joseLoader';

describe('loadJose', () => {
  it('is exported as a callable factory', () => {
    // Deliberately not invoked: it performs a genuine dynamic `import('jose')`,
    // which is the correct, supported interop for a CommonJS module consuming
    // an ESM-only package at real Node runtime, but which Jest's CommonJS test
    // environment cannot execute without globally enabling
    // --experimental-vm-modules (see src/auth/oidc/joseLoader.ts's header
    // comment for why that tradeoff was rejected for this one dependency).
    // createOidcJwtValidator takes its jose functions as an injected `JoseDeps`
    // instead, so its own tests (tests/auth/oidc/jwtValidator.test.ts) inject
    // jose's statically-imported exports directly and never call this.
    expect(typeof loadJose).toBe('function');
  });
});
