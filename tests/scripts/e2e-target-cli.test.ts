import { resolveTargetArg } from '../../scripts/lib/e2e-target-cli';
import { DEFAULT_TARGET, resolveTarget } from '../../scripts/lib/e2e-target';

describe('resolveTargetArg', () => {
  it('prefers a non-empty positional over the env var', () => {
    expect(resolveTargetArg('2.4.0-sqlite', '2.3.0-postgres')).toBe('2.4.0-sqlite');
  });

  it('falls back to the env var when no positional is given', () => {
    expect(resolveTargetArg(undefined, '2.3.0-postgres')).toBe('2.3.0-postgres');
  });

  it('falls back to DEFAULT_TARGET when neither positional nor env var is given', () => {
    expect(resolveTargetArg(undefined, undefined)).toBe(DEFAULT_TARGET);
  });

  // Regression test for #218: bootstrap.sh always passes a positional arg
  // via `--shell "${VIKUNJA_E2E_TARGET:-}"`, so an unset env var reaches
  // this CLI as an empty-string positional, not a missing one. `??` doesn't
  // treat '' as absent, so a bare `npm run e2e:up` used to fail outright.
  it('treats an empty-string positional as absent and falls back to the env var', () => {
    expect(resolveTargetArg('', '2.3.0-postgres')).toBe('2.3.0-postgres');
  });

  it('treats an empty-string positional and an empty-string env var as absent and falls back to DEFAULT_TARGET', () => {
    expect(resolveTargetArg('', '')).toBe(DEFAULT_TARGET);
  });

  it('treats an empty-string positional as absent and falls back to DEFAULT_TARGET when the env var is also unset', () => {
    expect(resolveTargetArg('', undefined)).toBe(DEFAULT_TARGET);
  });

  it('produces a target id that resolveTarget() accepts, matching the bootstrap.sh empty-env-var scenario', () => {
    const id = resolveTargetArg('', '');
    expect(() => resolveTarget(id)).not.toThrow();
    expect(resolveTarget(id).id).toBe(DEFAULT_TARGET);
  });

  it('defaults the env var argument to process.env.VIKUNJA_E2E_TARGET', () => {
    const original = process.env.VIKUNJA_E2E_TARGET;
    try {
      process.env.VIKUNJA_E2E_TARGET = '2.3.0-sqlite';
      expect(resolveTargetArg(undefined)).toBe('2.3.0-sqlite');
    } finally {
      if (original === undefined) {
        delete process.env.VIKUNJA_E2E_TARGET;
      } else {
        process.env.VIKUNJA_E2E_TARGET = original;
      }
    }
  });
});
