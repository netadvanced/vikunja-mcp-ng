/**
 * Unit tests for the shared fsync helper behind both atomic-write paths
 * (`writeVaultFileAtomic`, `writeTemplatesFileAtomic`) — issue #293 /
 * LOW-10. The helper is tiny, but its whole point is the failure path: the
 * descriptor must be closed even when the flush itself fails, or a busy
 * server leaks a descriptor per failed write until it hits EMFILE.
 */
import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import * as path from 'path';
import * as os from 'os';
// Plain `require`, not `import * as fs`: with esModuleInterop, TS's
// `__importStar` helper freezes the namespace object, which breaks
// `jest.spyOn(fs, ...)` ("Cannot redefine property").
// eslint-disable-next-line @typescript-eslint/no-var-requires
const fs = require('fs') as typeof import('fs');
import { fsyncPath } from '../../src/storage/fsync';

describe('fsyncPath', () => {
  let tmpDir: string;
  let filePath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fsync-helper-'));
    filePath = path.join(tmpDir, 'file.json');
    fs.writeFileSync(filePath, '{}', 'utf-8');
  });

  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('flushes a file and closes the descriptor it opened', () => {
    const fsyncSpy = jest.spyOn(fs, 'fsyncSync');
    const closeSpy = jest.spyOn(fs, 'closeSync');

    fsyncPath(filePath, 'r+');

    expect(fsyncSpy).toHaveBeenCalledTimes(1);
    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(closeSpy).toHaveBeenCalledWith(fsyncSpy.mock.calls[0]![0]);
  });

  it('flushes a directory', () => {
    const fsyncSpy = jest.spyOn(fs, 'fsyncSync');
    fsyncPath(tmpDir, 'r');
    expect(fsyncSpy).toHaveBeenCalledTimes(1);
  });

  it('closes the descriptor and rethrows when the flush fails', () => {
    const closeSpy = jest.spyOn(fs, 'closeSync');
    jest.spyOn(fs, 'fsyncSync').mockImplementation(() => {
      throw new Error('simulated EIO');
    });

    expect(() => fsyncPath(filePath, 'r+')).toThrow('simulated EIO');
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it('propagates an open failure without attempting a close', () => {
    const closeSpy = jest.spyOn(fs, 'closeSync');

    expect(() => fsyncPath(path.join(tmpDir, 'missing.json'), 'r+')).toThrow(/ENOENT/);
    expect(closeSpy).not.toHaveBeenCalled();
  });
});
