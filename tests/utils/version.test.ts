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

import { resolvePackageVersion } from '../../src/utils/version';

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
