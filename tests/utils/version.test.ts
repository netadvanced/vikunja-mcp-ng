/**
 * Tests for src/utils/version.ts — resolves the runtime package version from
 * package.json instead of a hardcoded constant (issue #186).
 */
import * as path from 'path';

const mockReadFileSync = jest.fn();
const mockLoggerWarn = jest.fn();

jest.mock('fs', () => ({
  readFileSync: mockReadFileSync,
}));

jest.mock('../../src/utils/logger', () => ({
  logger: { warn: mockLoggerWarn },
}));

import { compareVersions, resolvePackageVersion, serverAtLeast } from '../../src/utils/version';

describe('resolvePackageVersion', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns the version field from package.json one level up from baseDir', () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({ version: '0.6.1' }));

    const result = resolvePackageVersion('/app/dist');

    expect(result).toBe('0.6.1');
    expect(mockReadFileSync).toHaveBeenCalledWith(
      path.join('/app/dist', '..', 'package.json'),
      'utf-8',
    );
  });

  it('falls back to 0.0.0 and logs a warning when package.json cannot be read', () => {
    mockReadFileSync.mockImplementation(() => {
      throw new Error('ENOENT: no such file or directory');
    });

    const result = resolvePackageVersion('/app/dist');

    expect(result).toBe('0.0.0');
    expect(mockLoggerWarn).toHaveBeenCalledTimes(1);
  });

  it('falls back to 0.0.0 and logs a warning when package.json contains invalid JSON', () => {
    mockReadFileSync.mockReturnValue('{ not valid json');

    const result = resolvePackageVersion('/app/dist');

    expect(result).toBe('0.0.0');
    expect(mockLoggerWarn).toHaveBeenCalledTimes(1);
  });

  it('falls back to 0.0.0 and logs a warning when the version field is missing', () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({ name: 'vikunja-mcp-ng' }));

    const result = resolvePackageVersion('/app/dist');

    expect(result).toBe('0.0.0');
    expect(mockLoggerWarn).toHaveBeenCalledTimes(1);
  });

  it('falls back to 0.0.0 and logs a warning when the version field is not a string', () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({ version: 123 }));

    const result = resolvePackageVersion('/app/dist');

    expect(result).toBe('0.0.0');
    expect(mockLoggerWarn).toHaveBeenCalledTimes(1);
  });

  it('never throws even when readFileSync throws a non-Error value', () => {
    mockReadFileSync.mockImplementation(() => {
      // eslint-disable-next-line @typescript-eslint/no-throw-literal
      throw 'not an Error instance';
    });

    expect(() => resolvePackageVersion('/app/dist')).not.toThrow();
  });
});

/**
 * Server-version comparison, the mechanism behind `resolveApiVersion`'s
 * per-operation `minVersion` floor (issue #184 P3). These moved here from
 * scripts/lib/e2e-fixtures.ts, which now re-exports them.
 */
describe('compareVersions', () => {
  it('orders by major, minor, then patch', () => {
    expect(compareVersions('2.4.0', '2.5.0')).toBeLessThan(0);
    expect(compareVersions('2.6.0', '2.5.9')).toBeGreaterThan(0);
    expect(compareVersions('3.0.0', '2.9.9')).toBeGreaterThan(0);
    expect(compareVersions('2.5.1', '2.5.0')).toBeGreaterThan(0);
  });

  it('returns 0 for equal versions', () => {
    expect(compareVersions('2.5.0', '2.5.0')).toBe(0);
  });

  // `GET /info` reports `v2.6.0` on every supported release, so a comparison
  // that does not strip the prefix reads the whole string as unparseable.
  it('tolerates a leading v on either side', () => {
    expect(compareVersions('v2.6.0', '2.6.0')).toBe(0);
    expect(compareVersions('v2.4.0', 'v2.5.0')).toBeLessThan(0);
    expect(compareVersions('2.6.0', 'v2.5.0')).toBeGreaterThan(0);
  });

  it('treats missing components as 0', () => {
    expect(compareVersions('2.6', '2.6.0')).toBe(0);
    expect(compareVersions('2', '2.0.0')).toBe(0);
    expect(compareVersions('2.6', '2.6.1')).toBeLessThan(0);
    // The short side on the right too, so neither index fallback goes
    // untested.
    expect(compareVersions('2.6.1', '2.6')).toBeGreaterThan(0);
  });

  it('treats non-numeric components as 0 rather than throwing', () => {
    expect(compareVersions('2.5.0-rc1', '2.5.0')).toBe(0);
    expect(compareVersions('unknown', '2.5.0')).toBeLessThan(0);
    expect(compareVersions('', '0.0.0')).toBe(0);
  });
});

describe('serverAtLeast', () => {
  it('is true at and above the minimum', () => {
    expect(serverAtLeast('v2.5.0', '2.5.0')).toBe(true);
    expect(serverAtLeast('v2.6.0', '2.5.0')).toBe(true);
  });

  it('is false below the minimum', () => {
    expect(serverAtLeast('v2.4.0', '2.5.0')).toBe(false);
  });

  // "We could not tell" must never be read as "new enough".
  it('is false for an undetected version', () => {
    expect(serverAtLeast(null, '2.5.0')).toBe(false);
    expect(serverAtLeast(undefined, '2.5.0')).toBe(false);
    expect(serverAtLeast('', '2.5.0')).toBe(false);
  });
});
