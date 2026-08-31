/**
 * Unit tests for the templates file-backed persistence primitives
 * (N3-templates-persistence). See src/tools/templates-persistence.test.ts
 * for the higher-level integration coverage (real storage, real tool
 * handler, simulated restarts).
 */
import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import * as path from 'path';
import * as os from 'os';
// Plain `require`, not `import * as fs`: with esModuleInterop, TS's
// `__importStar` helper freezes the resulting namespace object, which
// breaks `jest.spyOn(fs, ...)` ("Cannot redefine property") in the atomic-
// write test below. `require` returns the real, unfrozen CJS exports.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const fs = require('fs') as typeof import('fs');
import {
  resolveTemplatesPersistPath,
  loadTemplatesFile,
  writeTemplatesFileAtomic,
  persistIdentityTemplateRecords,
  type PersistedTemplateRecord,
} from '../../src/storage/templateFileStore';

describe('resolveTemplatesPersistPath', () => {
  const originalEnvValue = process.env.VIKUNJA_MCP_TEMPLATES_FILE;

  afterEach(() => {
    if (originalEnvValue === undefined) {
      delete process.env.VIKUNJA_MCP_TEMPLATES_FILE;
    } else {
      process.env.VIKUNJA_MCP_TEMPLATES_FILE = originalEnvValue;
    }
  });

  it('returns undefined when neither env var nor config path is set', () => {
    delete process.env.VIKUNJA_MCP_TEMPLATES_FILE;
    expect(resolveTemplatesPersistPath(undefined)).toBeUndefined();
  });

  it('returns the configured path when only the config value is set', () => {
    delete process.env.VIKUNJA_MCP_TEMPLATES_FILE;
    expect(resolveTemplatesPersistPath('/data/templates.json')).toBe('/data/templates.json');
  });

  it('returns the env var when only the env var is set', () => {
    process.env.VIKUNJA_MCP_TEMPLATES_FILE = '/env/templates.json';
    expect(resolveTemplatesPersistPath(undefined)).toBe('/env/templates.json');
  });

  it('prefers the env var over the config value when both are set', () => {
    process.env.VIKUNJA_MCP_TEMPLATES_FILE = '/env/templates.json';
    expect(resolveTemplatesPersistPath('/config/templates.json')).toBe('/env/templates.json');
  });

  it('treats a blank env var as unset and falls back to the config value', () => {
    process.env.VIKUNJA_MCP_TEMPLATES_FILE = '   ';
    expect(resolveTemplatesPersistPath('/config/templates.json')).toBe('/config/templates.json');
  });

  it('treats a blank config value as unset', () => {
    delete process.env.VIKUNJA_MCP_TEMPLATES_FILE;
    expect(resolveTemplatesPersistPath('   ')).toBeUndefined();
  });
});

describe('loadTemplatesFile', () => {
  let tmpDir: string;
  let filePath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'templateFileStore-'));
    filePath = path.join(tmpDir, 'templates.json');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns an empty array when the file does not exist', () => {
    expect(fs.existsSync(filePath)).toBe(false);
    expect(loadTemplatesFile(filePath)).toEqual([]);
  });

  it('returns an empty array and logs a warning for invalid JSON', () => {
    fs.writeFileSync(filePath, '{ not valid json', 'utf-8');
    expect(loadTemplatesFile(filePath)).toEqual([]);
  });

  it('returns an empty array and logs a warning when the JSON is not an array', () => {
    fs.writeFileSync(filePath, JSON.stringify({ foo: 'bar' }), 'utf-8');
    expect(loadTemplatesFile(filePath)).toEqual([]);
  });

  it('drops malformed entries but keeps well-formed ones', () => {
    const entries = [
      { id: 'template_1', name: 'template_1', data: '{}', identity: 'identity-a' },
      { id: 'template_2' }, // missing name/data/identity
      'not an object',
      42,
      null,
      { id: 'template_3', name: 'template_3', data: '{"a":1}', identity: 'identity-a' },
    ];
    fs.writeFileSync(filePath, JSON.stringify(entries), 'utf-8');

    const result = loadTemplatesFile(filePath);
    expect(result).toEqual([
      { id: 'template_1', name: 'template_1', data: '{}', identity: 'identity-a' },
      { id: 'template_3', name: 'template_3', data: '{"a":1}', identity: 'identity-a' },
    ]);
  });

  it('drops a record with no identity field as malformed (#265 / CRIT-4: pre-migration data cannot be safely attributed to a tenant)', () => {
    const entries = [
      { id: 'template_1', name: 'template_1', data: '{}' }, // no identity — legacy shape
      { id: 'template_2', name: 'template_2', data: '{}', identity: 'identity-a' },
    ];
    fs.writeFileSync(filePath, JSON.stringify(entries), 'utf-8');

    const result = loadTemplatesFile(filePath);
    expect(result).toEqual([
      { id: 'template_2', name: 'template_2', data: '{}', identity: 'identity-a' },
    ]);
  });

  it('a non-ENOENT read error is instead tolerated (returns empty)', () => {
    // Directory read attempts throw EISDIR, not ENOENT — verifies the
    // "any read failure => start empty" contract, not just the missing-file
    // case specifically.
    expect(loadTemplatesFile(tmpDir)).toEqual([]);
  });

  it('tolerates a non-Error value thrown from the file read (defensive error-message fallback)', () => {
    const readSpy = jest.spyOn(fs, 'readFileSync').mockImplementation(() => {
      // eslint-disable-next-line @typescript-eslint/no-throw-literal
      throw 'boom';
    });
    try {
      expect(loadTemplatesFile(filePath)).toEqual([]);
    } finally {
      readSpy.mockRestore();
    }
  });

  it('tolerates a non-Error value thrown from JSON.parse (defensive error-message fallback)', () => {
    fs.writeFileSync(filePath, '[]', 'utf-8');
    const parseSpy = jest.spyOn(JSON, 'parse').mockImplementationOnce(() => {
      // eslint-disable-next-line @typescript-eslint/no-throw-literal
      throw 'not an Error instance';
    });
    try {
      expect(loadTemplatesFile(filePath)).toEqual([]);
    } finally {
      parseSpy.mockRestore();
    }
  });
});

describe('writeTemplatesFileAtomic', () => {
  let tmpDir: string;
  let filePath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'templateFileStore-write-'));
    filePath = path.join(tmpDir, 'nested', 'dir', 'templates.json');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  it('creates missing parent directories', () => {
    expect(fs.existsSync(path.dirname(filePath))).toBe(false);
    writeTemplatesFileAtomic(filePath, []);
    expect(fs.existsSync(path.dirname(filePath))).toBe(true);
    expect(fs.existsSync(filePath)).toBe(true);
  });

  it('round-trips records written to disk', () => {
    const records: PersistedTemplateRecord[] = [
      {
        id: 'template_1',
        name: 'template_1',
        data: JSON.stringify({ name: 'A' }),
        identity: 'identity-a',
      },
      {
        id: 'template_2',
        name: 'template_2',
        data: JSON.stringify({ name: 'B' }),
        identity: 'identity-a',
      },
    ];
    writeTemplatesFileAtomic(filePath, records);
    expect(loadTemplatesFile(filePath)).toEqual(records);
  });

  it('writes to a temp file and renames it over the target (atomic write)', () => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const writeSpy = jest.spyOn(fs, 'writeFileSync');
    const renameSpy = jest.spyOn(fs, 'renameSync');

    writeTemplatesFileAtomic(filePath, [{ id: 't', name: 't', data: '{}', identity: 'identity-a' }]);

    expect(writeSpy).toHaveBeenCalledTimes(1);
    const writtenPath = writeSpy.mock.calls[0]![0] as string;
    expect(writtenPath).not.toBe(filePath);
    expect(writtenPath.startsWith(path.dirname(filePath))).toBe(true);
    expect(path.basename(writtenPath)).toMatch(/\.tmp$/);

    expect(renameSpy).toHaveBeenCalledTimes(1);
    expect(renameSpy).toHaveBeenCalledWith(writtenPath, filePath);

    // The rename must happen after the write completes.
    const writeOrder = writeSpy.mock.invocationCallOrder[0]!;
    const renameOrder = renameSpy.mock.invocationCallOrder[0]!;
    expect(writeOrder).toBeLessThan(renameOrder);
  });

  it('overwrites an existing file completely rather than merging', () => {
    writeTemplatesFileAtomic(filePath, [
      { id: 'old', name: 'old', data: '{}', identity: 'identity-a' },
    ]);
    writeTemplatesFileAtomic(filePath, [
      { id: 'new', name: 'new', data: '{}', identity: 'identity-a' },
    ]);
    expect(loadTemplatesFile(filePath)).toEqual([
      { id: 'new', name: 'new', data: '{}', identity: 'identity-a' },
    ]);
  });
});

describe('persistIdentityTemplateRecords', () => {
  let tmpDir: string;
  let filePath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'templateFileStore-merge-'));
    filePath = path.join(tmpDir, 'templates.json');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('replaces only the given identity records, leaving other identities untouched', async () => {
    writeTemplatesFileAtomic(filePath, [
      { id: 'a1', name: 'a1', data: '{"v":1}', identity: 'identity-a' },
      { id: 'b1', name: 'b1', data: '{"v":1}', identity: 'identity-b' },
    ]);

    await persistIdentityTemplateRecords(filePath, 'identity-a', [
      { id: 'a1', name: 'a1', data: '{"v":2}', identity: 'identity-a' },
      { id: 'a2', name: 'a2', data: '{"v":1}', identity: 'identity-a' },
    ]);

    const onDisk = loadTemplatesFile(filePath);
    expect(onDisk).toHaveLength(3);
    expect(onDisk).toEqual(
      expect.arrayContaining([
        { id: 'a1', name: 'a1', data: '{"v":2}', identity: 'identity-a' },
        { id: 'a2', name: 'a2', data: '{"v":1}', identity: 'identity-a' },
        { id: 'b1', name: 'b1', data: '{"v":1}', identity: 'identity-b' },
      ]),
    );
  });

  it('serializes concurrent persists from different identities so neither clobbers the other (#265 / CRIT-4)', async () => {
    // Two identities race to persist at the same time, starting from an
    // empty file. Without the write mutex, both could read the same
    // (empty) snapshot and each write only its own record, with whichever
    // finishes last winning and silently dropping the other's write.
    await Promise.all([
      persistIdentityTemplateRecords(filePath, 'identity-a', [
        { id: 'a1', name: 'a1', data: '{}', identity: 'identity-a' },
      ]),
      persistIdentityTemplateRecords(filePath, 'identity-b', [
        { id: 'b1', name: 'b1', data: '{}', identity: 'identity-b' },
      ]),
    ]);

    const onDisk = loadTemplatesFile(filePath);
    expect(onDisk).toHaveLength(2);
    expect(onDisk.map((r) => r.identity).sort()).toEqual(['identity-a', 'identity-b']);
  });

  it('creates missing parent directories', () => {
    const nestedPath = path.join(tmpDir, 'nested', 'templates.json');
    return persistIdentityTemplateRecords(nestedPath, 'identity-a', []).then(() => {
      expect(fs.existsSync(nestedPath)).toBe(true);
    });
  });

  describe('durability (issue #293 / LOW-10)', () => {
    it('fsyncs the temp file before the rename, and the directory after it', () => {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const fsyncSpy = jest.spyOn(fs, 'fsyncSync');
      const renameSpy = jest.spyOn(fs, 'renameSync');

      writeTemplatesFileAtomic(filePath, [{ id: 't', name: 't', data: '{}' }]);

      // One flush for the temp file, one for the directory entry.
      expect(fsyncSpy).toHaveBeenCalledTimes(2);
      const renameOrder = renameSpy.mock.invocationCallOrder[0]!;
      expect(fsyncSpy.mock.invocationCallOrder[0]!).toBeLessThan(renameOrder);
      expect(fsyncSpy.mock.invocationCallOrder[1]!).toBeGreaterThan(renameOrder);
    });

    it('does not apply the rename when the temp file cannot be flushed', () => {
      writeTemplatesFileAtomic(filePath, [{ id: 'old', name: 'old', data: '{}' }]);
      const fsyncSpy = jest.spyOn(fs, 'fsyncSync').mockImplementation(() => {
        throw new Error('simulated fsync failure');
      });
      const renameSpy = jest.spyOn(fs, 'renameSync');

      expect(() =>
        writeTemplatesFileAtomic(filePath, [{ id: 'new', name: 'new', data: '{}' }]),
      ).toThrow('simulated fsync failure');

      expect(renameSpy).not.toHaveBeenCalled();
      fsyncSpy.mockRestore();
      expect(loadTemplatesFile(filePath)).toEqual([{ id: 'old', name: 'old', data: '{}' }]);
    });

    it('tolerates a platform that cannot fsync a directory', () => {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const realOpen = fs.openSync;
      jest.spyOn(fs, 'openSync').mockImplementation(((target: string, flags: string) => {
        if (flags === 'r') {
          throw new Error('EISDIR: simulated Windows behaviour');
        }
        return (realOpen as (t: string, f: string) => number)(target, flags);
      }) as unknown as typeof fs.openSync);

      expect(() =>
        writeTemplatesFileAtomic(filePath, [{ id: 't', name: 't', data: '{}' }]),
      ).not.toThrow();
      jest.restoreAllMocks();
      expect(loadTemplatesFile(filePath)).toEqual([{ id: 't', name: 't', data: '{}' }]);
    });
  });
});
