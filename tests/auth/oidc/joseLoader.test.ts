import { loadJose } from '../../../src/auth/oidc/joseLoader';
import type { JoseDeps } from '../../../src/auth/oidc/types';

describe('loadJose', () => {
  it('is exported as a callable factory', () => {
    // The DEFAULT importer (`import('jose')`) is deliberately not exercised
    // here: it is a genuine dynamic import, which is the correct, supported
    // interop for a CommonJS module consuming an ESM-only package at real
    // Node runtime, but which Jest's CommonJS test environment cannot
    // execute without globally enabling --experimental-vm-modules (see
    // src/auth/oidc/joseLoader.ts's header comment for why that tradeoff was
    // rejected for this one dependency). `createOidcJwtValidator` takes its
    // jose functions as an injected `JoseDeps` instead, so its own tests
    // (tests/auth/oidc/jwtValidator.test.ts) inject jose's
    // statically-imported exports directly and never call this.
    expect(typeof loadJose).toBe('function');
  });

  // LOW-21 (#296) regression coverage: the caching logic is unit-testable
  // via the injected `importer` param, without touching the real dynamic
  // `import('jose')`. `cachedDeps` is module-level state, so each test
  // re-imports the module fresh via `jest.isolateModules` to avoid one
  // test's cache leaking into the next.
  const fakeDeps = {} as JoseDeps;

  it('caches a SUCCESSFUL import: the importer runs only once across repeated calls', async () => {
    let isolatedLoadJose!: typeof loadJose;
    jest.isolateModules(() => {
      ({ loadJose: isolatedLoadJose } = jest.requireActual('../../../src/auth/oidc/joseLoader'));
    });
    const importer = jest.fn().mockResolvedValue(fakeDeps);

    await expect(isolatedLoadJose(importer)).resolves.toBe(fakeDeps);
    await expect(isolatedLoadJose(importer)).resolves.toBe(fakeDeps);

    expect(importer).toHaveBeenCalledTimes(1);
  });

  it('does NOT cache a rejected import: a later call retries instead of replaying the failure', async () => {
    let isolatedLoadJose!: typeof loadJose;
    jest.isolateModules(() => {
      ({ loadJose: isolatedLoadJose } = jest.requireActual('../../../src/auth/oidc/joseLoader'));
    });
    const importer = jest
      .fn()
      .mockRejectedValueOnce(new Error('transient startup failure'))
      .mockResolvedValueOnce(fakeDeps);

    await expect(isolatedLoadJose(importer)).rejects.toThrow('transient startup failure');
    // Before the fix, this second call would return the SAME rejected
    // promise from the first call, never re-invoking `importer`.
    await expect(isolatedLoadJose(importer)).resolves.toBe(fakeDeps);

    expect(importer).toHaveBeenCalledTimes(2);
  });

  it('caches the recovered import after a retry succeeds', async () => {
    let isolatedLoadJose!: typeof loadJose;
    jest.isolateModules(() => {
      ({ loadJose: isolatedLoadJose } = jest.requireActual('../../../src/auth/oidc/joseLoader'));
    });
    const importer = jest
      .fn()
      .mockRejectedValueOnce(new Error('transient startup failure'))
      .mockResolvedValueOnce(fakeDeps);

    await expect(isolatedLoadJose(importer)).rejects.toThrow('transient startup failure');
    await expect(isolatedLoadJose(importer)).resolves.toBe(fakeDeps);
    // A third call must reuse the now-cached success, not call importer again.
    await expect(isolatedLoadJose(importer)).resolves.toBe(fakeDeps);

    expect(importer).toHaveBeenCalledTimes(2);
  });
});
