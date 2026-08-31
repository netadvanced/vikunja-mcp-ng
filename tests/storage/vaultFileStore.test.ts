/**
 * Unit tests for the encrypted JSON credential vault
 * (docs/OIDC-RESOURCE-SERVER.md §3c, H2a).
 *
 * Covers: encrypt/decrypt round-trip, wrong-key/corrupt-file failure modes
 * (loud at the low-level decrypt function, `null` — never a throw — at the
 * `VikunjaCredentialSource`-facing `getCredential`), concurrent-access
 * serialization via the internal mutex, and atomicity of the write-temp-
 * then-rename path under injected fs failures. Modeled directly on
 * tests/storage/templateFileStore.test.ts's patterns.
 */
import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
// Plain `require`, not `import * as fs`: with esModuleInterop, TS's
// `__importStar` helper freezes the resulting namespace object, which
// breaks `jest.spyOn(fs, ...)` ("Cannot redefine property") in the
// atomicity tests below. `require` returns the real, unfrozen CJS exports.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const fs = require('fs') as typeof import('fs');
import {
  VaultFileStore,
  parseMasterKey,
  resolveVaultMasterKey,
  resolveVaultPath,
  encryptToken,
  decryptToken,
  vaultRecordAad,
  loadVaultFile,
  loadVaultFileWithStatus,
  writeVaultFileAtomic,
  setActiveVaultStore,
  getActiveVaultStore,
  type VaultRecord,
} from '../../src/storage/vaultFileStore';
import type { Identity } from '../../src/context/requestContext';

const KEY = crypto.randomBytes(32);
const OTHER_KEY = crypto.randomBytes(32);

const IDENTITY_A: Identity = { issuer: 'https://idp.example/realm', sub: 'user-a' };
const IDENTITY_B: Identity = { issuer: 'https://idp.example/realm', sub: 'user-b' };

describe('resolveVaultMasterKey', () => {
  const original = process.env.VIKUNJA_MCP_VAULT_KEY;
  const originalFile = process.env.VIKUNJA_MCP_VAULT_KEY_FILE;

  afterEach(() => {
    if (original === undefined) delete process.env.VIKUNJA_MCP_VAULT_KEY;
    else process.env.VIKUNJA_MCP_VAULT_KEY = original;
    if (originalFile === undefined) delete process.env.VIKUNJA_MCP_VAULT_KEY_FILE;
    else process.env.VIKUNJA_MCP_VAULT_KEY_FILE = originalFile;
  });

  it('throws a clear error when unset', () => {
    delete process.env.VIKUNJA_MCP_VAULT_KEY;
    delete process.env.VIKUNJA_MCP_VAULT_KEY_FILE;
    expect(() => resolveVaultMasterKey()).toThrow(/vault master key/);
  });

  it('throws a clear error when set to a value that does not decode to 32 bytes', () => {
    process.env.VIKUNJA_MCP_VAULT_KEY = Buffer.from('too short').toString('base64');
    expect(() => resolveVaultMasterKey()).toThrow(/32 bytes/);
  });

  it('resolves a valid base64-encoded 32-byte key', () => {
    process.env.VIKUNJA_MCP_VAULT_KEY = KEY.toString('base64');
    const resolved = resolveVaultMasterKey();
    expect(resolved.equals(KEY)).toBe(true);
  });
});

describe('resolveVaultPath', () => {
  const original = process.env.VIKUNJA_MCP_VAULT_PATH;

  afterEach(() => {
    if (original === undefined) delete process.env.VIKUNJA_MCP_VAULT_PATH;
    else process.env.VIKUNJA_MCP_VAULT_PATH = original;
  });

  it('returns undefined when neither env var nor config path is set', () => {
    delete process.env.VIKUNJA_MCP_VAULT_PATH;
    expect(resolveVaultPath(undefined)).toBeUndefined();
  });

  it('returns the configured path when only the config value is set', () => {
    delete process.env.VIKUNJA_MCP_VAULT_PATH;
    expect(resolveVaultPath('/data/vault.json')).toBe('/data/vault.json');
  });

  it('prefers the env var over the config value when both are set', () => {
    process.env.VIKUNJA_MCP_VAULT_PATH = '/env/vault.json';
    expect(resolveVaultPath('/config/vault.json')).toBe('/env/vault.json');
  });
});

describe('encryptToken / decryptToken (AES-256-GCM round-trip)', () => {
  it('round-trips a token through encrypt then decrypt', () => {
    const { ciphertext, iv, authTag } = encryptToken('tk_real-token-1234567890', KEY);
    expect(decryptToken({ ciphertext, iv, authTag }, KEY)).toBe('tk_real-token-1234567890');
  });

  it('uses a fresh random IV on every call (never reuses one)', () => {
    const first = encryptToken('tk_same-token', KEY);
    const second = encryptToken('tk_same-token', KEY);
    expect(first.iv).not.toBe(second.iv);
    expect(first.ciphertext).not.toBe(second.ciphertext);
  });

  it('throws (does not silently return garbage) when decrypted with the wrong key', () => {
    const { ciphertext, iv, authTag } = encryptToken('tk_real-token', KEY);
    expect(() => decryptToken({ ciphertext, iv, authTag }, OTHER_KEY)).toThrow();
  });

  it('throws when the authTag has been tampered with', () => {
    const { ciphertext, iv, authTag } = encryptToken('tk_real-token', KEY);
    const tamperedTag = Buffer.from(authTag, 'base64');
    tamperedTag[0] = tamperedTag[0]! ^ 0xff;
    expect(() =>
      decryptToken({ ciphertext, iv, authTag: tamperedTag.toString('base64') }, KEY),
    ).toThrow();
  });

  it('throws when the ciphertext has been tampered with', () => {
    const { ciphertext, iv, authTag } = encryptToken('tk_real-token', KEY);
    const tamperedCiphertext = Buffer.from(ciphertext, 'base64');
    tamperedCiphertext[0] = (tamperedCiphertext[0] ?? 0) ^ 0xff;
    expect(() =>
      decryptToken({ ciphertext: tamperedCiphertext.toString('base64'), iv, authTag }, KEY),
    ).toThrow();
  });
});

describe('vaultRecordAad (identity + vikunjaUrl binding, issue #262)', () => {
  it('produces a different AAD for the same URL under a different identity', () => {
    const a = vaultRecordAad('https://idp.example/realm|user-a', 'https://vikunja.example.com');
    const b = vaultRecordAad('https://idp.example/realm|user-b', 'https://vikunja.example.com');
    expect(a.equals(b)).toBe(false);
  });

  it('produces a different AAD for the same identity under a different URL', () => {
    const a = vaultRecordAad('iss|sub', 'https://vikunja.example.com');
    const b = vaultRecordAad('iss|sub', 'https://evil.example.com');
    expect(a.equals(b)).toBe(false);
  });

  it('length-prefixes the parts so a shifted split cannot collide', () => {
    // Naive concatenation would make these two pairs identical.
    const a = vaultRecordAad('iss|sub', 'x/https://vikunja.example.com');
    const b = vaultRecordAad('iss|subx', '/https://vikunja.example.com');
    expect(a.equals(b)).toBe(false);
  });
});

describe('encryptToken / decryptToken with AAD (issue #262)', () => {
  const aad = vaultRecordAad('iss|sub', 'https://vikunja.example.com');

  it('round-trips when the same AAD is supplied on both sides', () => {
    const enc = encryptToken('tk_bound-token', KEY, aad);
    expect(decryptToken(enc, KEY, aad)).toBe('tk_bound-token');
  });

  it('fails the tag check when the AAD is omitted on decrypt', () => {
    const enc = encryptToken('tk_bound-token', KEY, aad);
    expect(() => decryptToken(enc, KEY)).toThrow();
  });

  it('fails the tag check when a DIFFERENT AAD is supplied on decrypt', () => {
    const enc = encryptToken('tk_bound-token', KEY, aad);
    const otherAad = vaultRecordAad('iss|sub', 'https://evil.example.com');
    expect(() => decryptToken(enc, KEY, otherAad)).toThrow();
  });

  it('fails the tag check when an AAD is supplied for a record encrypted without one', () => {
    const enc = encryptToken('tk_legacy-token', KEY);
    expect(() => decryptToken(enc, KEY, aad)).toThrow();
  });
});

describe('loadVaultFile / writeVaultFileAtomic', () => {
  let tmpDir: string;
  let filePath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vaultFileStore-'));
    filePath = path.join(tmpDir, 'vault.json');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns an empty map when the file does not exist', () => {
    expect(fs.existsSync(filePath)).toBe(false);
    expect(loadVaultFile(filePath).size).toBe(0);
  });

  it('returns an empty map and tolerates invalid JSON', () => {
    fs.writeFileSync(filePath, '{ not valid json', 'utf-8');
    expect(loadVaultFile(filePath).size).toBe(0);
  });

  it('returns an empty map when the JSON is not an object (e.g. an array)', () => {
    fs.writeFileSync(filePath, JSON.stringify([1, 2, 3]), 'utf-8');
    expect(loadVaultFile(filePath).size).toBe(0);
  });

  it('drops malformed entries but keeps well-formed ones', () => {
    const good: VaultRecord = {
      vikunjaUrl: 'https://vikunja.example.com',
      ciphertext: 'x',
      iv: 'y',
      authTag: 'z',
      keyVersion: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      lastUsedAt: null,
    };
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        'issuer|good': good,
        'issuer|bad': { vikunjaUrl: 'missing other fields' },
      }),
      'utf-8',
    );

    const result = loadVaultFile(filePath);
    expect(result.size).toBe(1);
    expect(result.get('issuer|good')).toEqual(good);
    expect(result.has('issuer|bad')).toBe(false);
  });

  it('a non-ENOENT read error is instead tolerated (returns empty)', () => {
    // Directory read attempts throw EISDIR, not ENOENT.
    expect(loadVaultFile(tmpDir).size).toBe(0);
  });

  describe('loadVaultFileWithStatus reports whether the load is complete (issue #266)', () => {
    it('reports a missing file as complete (fresh deployment), not a failure', () => {
      const result = loadVaultFileWithStatus(filePath);
      expect(result.records.size).toBe(0);
      expect(result.incompleteReason).toBeUndefined();
    });

    it('reports a clean read of a well-formed file as complete', () => {
      const record: VaultRecord = {
        vikunjaUrl: 'https://vikunja.example.com',
        ciphertext: 'x',
        iv: 'y',
        authTag: 'z',
        keyVersion: 2,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        lastUsedAt: null,
      };
      writeVaultFileAtomic(filePath, new Map([['issuer|good', record]]));

      const result = loadVaultFileWithStatus(filePath);
      expect(result.records.size).toBe(1);
      expect(result.incompleteReason).toBeUndefined();
    });

    it('reports an unreadable file as incomplete', () => {
      // A directory read attempt throws EISDIR, not ENOENT.
      const result = loadVaultFileWithStatus(tmpDir);
      expect(result.incompleteReason).toMatch(/could not be read/);
    });

    it('reports invalid JSON as incomplete', () => {
      fs.writeFileSync(filePath, '{ not valid json', 'utf-8');
      expect(loadVaultFileWithStatus(filePath).incompleteReason).toMatch(/not valid JSON/);
    });

    it('reports a non-object document as incomplete', () => {
      fs.writeFileSync(filePath, JSON.stringify([1, 2, 3]), 'utf-8');
      expect(loadVaultFileWithStatus(filePath).incompleteReason).toMatch(/not a JSON object/);
    });

    it('reports dropped malformed entries as incomplete, and counts them', () => {
      fs.writeFileSync(
        filePath,
        JSON.stringify({ 'issuer|bad': { vikunjaUrl: 'missing other fields' } }),
        'utf-8',
      );
      expect(loadVaultFileWithStatus(filePath).incompleteReason).toMatch(/1 malformed entry/);

      fs.writeFileSync(
        filePath,
        JSON.stringify({ 'issuer|bad1': {}, 'issuer|bad2': {} }),
        'utf-8',
      );
      expect(loadVaultFileWithStatus(filePath).incompleteReason).toMatch(/2 malformed entries/);
    });
  });

  it('writes atomically: temp file in the same directory, then rename', () => {
    const writeSpy = jest.spyOn(fs, 'writeFileSync');
    const renameSpy = jest.spyOn(fs, 'renameSync');

    const map = new Map<string, VaultRecord>();
    map.set('issuer|user', {
      vikunjaUrl: 'https://vikunja.example.com',
      ciphertext: 'x',
      iv: 'y',
      authTag: 'z',
      keyVersion: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      lastUsedAt: null,
    });
    writeVaultFileAtomic(filePath, map);

    expect(writeSpy).toHaveBeenCalledTimes(1);
    const writtenPath = writeSpy.mock.calls[0]![0] as string;
    expect(writtenPath).not.toBe(filePath);
    expect(writtenPath.startsWith(path.dirname(filePath))).toBe(true);
    expect(path.basename(writtenPath)).toMatch(/\.tmp$/);

    expect(renameSpy).toHaveBeenCalledTimes(1);
    expect(renameSpy).toHaveBeenCalledWith(writtenPath, filePath);

    const writeOrder = writeSpy.mock.invocationCallOrder[0]!;
    const renameOrder = renameSpy.mock.invocationCallOrder[0]!;
    expect(writeOrder).toBeLessThan(renameOrder);

    writeSpy.mockRestore();
    renameSpy.mockRestore();
  });

  it('a failure writing the temp file leaves any previous good file completely untouched', () => {
    const originalRecord: VaultRecord = {
      vikunjaUrl: 'https://vikunja.example.com',
      ciphertext: 'original-ciphertext',
      iv: 'original-iv',
      authTag: 'original-tag',
      keyVersion: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      lastUsedAt: null,
    };
    const originalMap = new Map([['issuer|user', originalRecord]]);
    writeVaultFileAtomic(filePath, originalMap);

    const writeSpy = jest.spyOn(fs, 'writeFileSync').mockImplementation(() => {
      throw new Error('simulated disk full');
    });
    try {
      const newMap = new Map([
        [
          'issuer|user',
          { ...originalRecord, ciphertext: 'new-ciphertext', updatedAt: '2026-02-01T00:00:00.000Z' },
        ],
      ]);
      expect(() => writeVaultFileAtomic(filePath, newMap)).toThrow('simulated disk full');
    } finally {
      writeSpy.mockRestore();
    }

    // The previous good file must be intact — the crash happened before
    // the atomic rename, so the reader never sees a torn or partial file.
    expect(loadVaultFile(filePath).get('issuer|user')).toEqual(originalRecord);
  });

  it('a failure during rename leaves the previous good file intact (temp file orphaned, not applied)', () => {
    const originalRecord: VaultRecord = {
      vikunjaUrl: 'https://vikunja.example.com',
      ciphertext: 'original-ciphertext',
      iv: 'original-iv',
      authTag: 'original-tag',
      keyVersion: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      lastUsedAt: null,
    };
    writeVaultFileAtomic(filePath, new Map([['issuer|user', originalRecord]]));

    const renameSpy = jest.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw new Error('simulated rename failure');
    });
    try {
      const newMap = new Map([['issuer|user', { ...originalRecord, ciphertext: 'new-ciphertext' }]]);
      expect(() => writeVaultFileAtomic(filePath, newMap)).toThrow('simulated rename failure');
    } finally {
      renameSpy.mockRestore();
    }

    expect(loadVaultFile(filePath).get('issuer|user')).toEqual(originalRecord);
  });

  it('overwrites an existing file completely rather than merging', () => {
    const record: VaultRecord = {
      vikunjaUrl: 'https://vikunja.example.com',
      ciphertext: 'x',
      iv: 'y',
      authTag: 'z',
      keyVersion: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      lastUsedAt: null,
    };
    writeVaultFileAtomic(filePath, new Map([['issuer|old', record]]));
    writeVaultFileAtomic(filePath, new Map([['issuer|new', record]]));

    const result = loadVaultFile(filePath);
    expect(result.has('issuer|old')).toBe(false);
    expect(result.has('issuer|new')).toBe(true);
  });
});

describe('VaultFileStore', () => {
  let tmpDir: string;
  let filePath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vaultFileStore-store-'));
    filePath = path.join(tmpDir, 'vault.json');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('getCredential', () => {
    it('returns null for an identity with no record', () => {
      const store = new VaultFileStore(filePath, KEY);
      expect(store.getCredential(IDENTITY_A)).toBeNull();
    });

    it('round-trips: provision then getCredential returns the same token', async () => {
      const store = new VaultFileStore(filePath, KEY);
      await store.provision(IDENTITY_A, 'https://vikunja.example.com', 'tk_real-token-1234567890');

      const credential = store.getCredential(IDENTITY_A);
      expect(credential).toEqual({
        apiUrl: 'https://vikunja.example.com',
        apiToken: 'tk_real-token-1234567890',
        authType: 'api-token',
      });
    });

    it('never throws for a wrong-key/corrupted record — resolves to null instead', async () => {
      const store = new VaultFileStore(filePath, KEY);
      await store.provision(IDENTITY_A, 'https://vikunja.example.com', 'tk_real-token');

      const wrongKeyStore = new VaultFileStore(filePath, OTHER_KEY);
      expect(() => wrongKeyStore.getCredential(IDENTITY_A)).not.toThrow();
      expect(wrongKeyStore.getCredential(IDENTITY_A)).toBeNull();
    });

    it('never leaks one identity into another (no fallback / no cross-identity match)', async () => {
      const store = new VaultFileStore(filePath, KEY);
      await store.provision(IDENTITY_A, 'https://vikunja.example.com', 'tk_a-real');

      expect(store.getCredential(IDENTITY_B)).toBeNull();
    });
  });

  describe('file-write attacker without the master key (issue #262)', () => {
    /** Rewrite the on-disk vault, bypassing the store's own write path. */
    const rewrite = (mutate: (obj: Record<string, VaultRecord>) => void): void => {
      const obj = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Record<string, VaultRecord>;
      mutate(obj);
      fs.writeFileSync(filePath, JSON.stringify(obj), 'utf-8');
    };

    it('writes new records in the AAD-bound format (keyVersion 2)', async () => {
      const store = new VaultFileStore(filePath, KEY);
      await store.provision(IDENTITY_A, 'https://vikunja.example.com', 'tk_real');

      const onDisk = loadVaultFile(filePath).get('https://idp.example/realm|user-a');
      expect(onDisk?.keyVersion).toBe(2);
    });

    it('cannot retarget vikunjaUrl to an attacker-controlled server', async () => {
      const store = new VaultFileStore(filePath, KEY);
      await store.provision(IDENTITY_A, 'https://vikunja.example.com', 'tk_real-token');

      rewrite((obj) => {
        const key = 'https://idp.example/realm|user-a';
        obj[key] = { ...obj[key]!, vikunjaUrl: 'https://exfil.attacker.example' };
      });

      // A fresh store reads the tampered file: the retarget invalidates the
      // GCM tag, so no plaintext token is ever handed to the attacker's URL.
      const tampered = new VaultFileStore(filePath, KEY);
      expect(() => tampered.getCredential(IDENTITY_A)).not.toThrow();
      expect(tampered.getCredential(IDENTITY_A)).toBeNull();
    });

    it("cannot splice identity A's ciphertext under identity B's key", async () => {
      const store = new VaultFileStore(filePath, KEY);
      await store.provision(IDENTITY_A, 'https://vikunja.example.com', 'tk_a-secret');
      await store.provision(IDENTITY_B, 'https://vikunja.example.com', 'tk_b-secret');

      rewrite((obj) => {
        const a = obj['https://idp.example/realm|user-a']!;
        const b = obj['https://idp.example/realm|user-b']!;
        obj['https://idp.example/realm|user-b'] = {
          ...b,
          ciphertext: a.ciphertext,
          iv: a.iv,
          authTag: a.authTag,
        };
      });

      const tampered = new VaultFileStore(filePath, KEY);
      expect(tampered.getCredential(IDENTITY_B)).toBeNull();
      // A's own record is untouched and still resolves normally.
      expect(tampered.getCredential(IDENTITY_A)?.apiToken).toBe('tk_a-secret');
    });
  });

  describe('legacy keyVersion migration (issue #262)', () => {
    /** Write a pre-#262 record: encrypted with no AAD, `keyVersion: 1`. */
    const writeLegacyRecord = (identityKeyValue: string, token: string): void => {
      const enc = encryptToken(token, KEY);
      const record: VaultRecord = {
        vikunjaUrl: 'https://vikunja.example.com',
        ...enc,
        keyVersion: 1,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        lastUsedAt: null,
      };
      writeVaultFileAtomic(filePath, new Map([[identityKeyValue, record]]));
    };

    it('still decrypts a legacy keyVersion 1 record written by an older build', () => {
      writeLegacyRecord('https://idp.example/realm|user-a', 'tk_legacy-token');

      const store = new VaultFileStore(filePath, KEY);
      expect(store.getCredential(IDENTITY_A)).toEqual({
        apiUrl: 'https://vikunja.example.com',
        apiToken: 'tk_legacy-token',
        authType: 'api-token',
      });
    });

    it('upgrades a legacy record to the bound format on the next provision', async () => {
      writeLegacyRecord('https://idp.example/realm|user-a', 'tk_legacy-token');

      const store = new VaultFileStore(filePath, KEY);
      await store.provision(IDENTITY_A, 'https://vikunja.example.com', 'tk_rotated-token');

      const onDisk = loadVaultFile(filePath).get('https://idp.example/realm|user-a');
      expect(onDisk?.keyVersion).toBe(2);
      expect(store.getCredential(IDENTITY_A)?.apiToken).toBe('tk_rotated-token');
    });

    it('returns null (never crashes) for a record written by a newer, unknown format', () => {
      const enc = encryptToken('tk_future', KEY);
      writeVaultFileAtomic(
        filePath,
        new Map([
          [
            'https://idp.example/realm|user-a',
            {
              vikunjaUrl: 'https://vikunja.example.com',
              ...enc,
              keyVersion: 99,
              createdAt: '2026-01-01T00:00:00.000Z',
              updatedAt: '2026-01-01T00:00:00.000Z',
              lastUsedAt: null,
            } satisfies VaultRecord,
          ],
        ]),
      );

      const store = new VaultFileStore(filePath, KEY);
      expect(() => store.getCredential(IDENTITY_A)).not.toThrow();
      expect(store.getCredential(IDENTITY_A)).toBeNull();
    });
  });

  describe('getStatus', () => {
    it('reports provisioned: false for an unlinked identity', () => {
      const store = new VaultFileStore(filePath, KEY);
      expect(store.getStatus(IDENTITY_A)).toEqual({ provisioned: false });
    });

    it('reports a masked token and timestamps for a linked identity, never the raw token', async () => {
      const store = new VaultFileStore(filePath, KEY);
      await store.provision(IDENTITY_A, 'https://vikunja.example.com', 'tk_real-token-1234567890');

      const status = store.getStatus(IDENTITY_A);
      expect(status.provisioned).toBe(true);
      expect(status.vikunjaUrl).toBe('https://vikunja.example.com');
      expect(status.maskedToken).toBe('tk_r...');
      expect(status.maskedToken).not.toContain('real-token-1234567890');
      expect(status.createdAt).toBeDefined();
      expect(status.updatedAt).toBeDefined();
      expect(status.lastUsedAt).toBeNull();
    });
  });

  describe('provision', () => {
    it('preserves createdAt but bumps updatedAt on a re-provision (token swap)', async () => {
      const store = new VaultFileStore(filePath, KEY);
      await store.provision(IDENTITY_A, 'https://vikunja.example.com', 'tk_old');
      const firstStatus = store.getStatus(IDENTITY_A);

      await new Promise((resolve) => setTimeout(resolve, 5));
      await store.provision(IDENTITY_A, 'https://vikunja.example.com', 'tk_new');
      const secondStatus = store.getStatus(IDENTITY_A);

      expect(secondStatus.createdAt).toBe(firstStatus.createdAt);
      expect(secondStatus.updatedAt).not.toBe(firstStatus.updatedAt);
      expect(store.getCredential(IDENTITY_A)?.apiToken).toBe('tk_new');
    });

    it('persists to disk — a fresh store instance reading the same file sees the record', async () => {
      const store = new VaultFileStore(filePath, KEY);
      await store.provision(IDENTITY_A, 'https://vikunja.example.com', 'tk_real-token');

      const freshStore = new VaultFileStore(filePath, KEY);
      expect(freshStore.getCredential(IDENTITY_A)).toEqual({
        apiUrl: 'https://vikunja.example.com',
        apiToken: 'tk_real-token',
        authType: 'api-token',
      });
    });
  });

  describe('deprovision', () => {
    it('is idempotent and reports whether a record actually existed', async () => {
      const store = new VaultFileStore(filePath, KEY);
      expect(await store.deprovision(IDENTITY_A)).toBe(false);

      await store.provision(IDENTITY_A, 'https://vikunja.example.com', 'tk_real');
      expect(await store.deprovision(IDENTITY_A)).toBe(true);
      expect(store.getCredential(IDENTITY_A)).toBeNull();

      // Second deprovision of the same (now-removed) identity: idempotent.
      expect(await store.deprovision(IDENTITY_A)).toBe(false);
    });

    it('does not affect another identity\'s record', async () => {
      const store = new VaultFileStore(filePath, KEY);
      await store.provision(IDENTITY_A, 'https://vikunja.example.com', 'tk_a');
      await store.provision(IDENTITY_B, 'https://vikunja.example.com', 'tk_b');

      await store.deprovision(IDENTITY_A);

      expect(store.getCredential(IDENTITY_A)).toBeNull();
      expect(store.getCredential(IDENTITY_B)?.apiToken).toBe('tk_b');
    });
  });

  describe('memory and disk never diverge on a failed write (issue #277)', () => {
    it('a failed provision write leaves nothing behind in memory', async () => {
      const store = new VaultFileStore(filePath, KEY);
      await store.provision(IDENTITY_A, 'https://vikunja.example.com', 'tk_a');

      const writeSpy = jest.spyOn(fs, 'writeFileSync').mockImplementation(() => {
        throw new Error('simulated disk full');
      });
      try {
        await expect(
          store.provision(IDENTITY_B, 'https://vikunja.example.com', 'tk_b'),
        ).rejects.toThrow('simulated disk full');
      } finally {
        writeSpy.mockRestore();
      }

      // B was never persisted, so it must not be usable in memory either —
      // otherwise it works until the next restart and then vanishes.
      expect(store.getCredential(IDENTITY_B)).toBeNull();
      expect(store.getStatus(IDENTITY_B).provisioned).toBe(false);
      // A's record is untouched, in memory and on disk.
      expect(store.getCredential(IDENTITY_A)?.apiToken).toBe('tk_a');
      expect(loadVaultFile(filePath).has('https://idp.example/realm|user-a')).toBe(true);
    });

    it('a failed re-provision write keeps the previously stored token live', async () => {
      const store = new VaultFileStore(filePath, KEY);
      await store.provision(IDENTITY_A, 'https://vikunja.example.com', 'tk_old');

      const writeSpy = jest.spyOn(fs, 'writeFileSync').mockImplementation(() => {
        throw new Error('simulated disk full');
      });
      try {
        await expect(
          store.provision(IDENTITY_A, 'https://vikunja.example.com', 'tk_new'),
        ).rejects.toThrow('simulated disk full');
      } finally {
        writeSpy.mockRestore();
      }

      expect(store.getCredential(IDENTITY_A)?.apiToken).toBe('tk_old');
    });

    it('a failed deprovision write leaves the record live in memory too', async () => {
      const store = new VaultFileStore(filePath, KEY);
      await store.provision(IDENTITY_A, 'https://vikunja.example.com', 'tk_a');

      const renameSpy = jest.spyOn(fs, 'renameSync').mockImplementation(() => {
        throw new Error('simulated rename failure');
      });
      try {
        await expect(store.deprovision(IDENTITY_A)).rejects.toThrow('simulated rename failure');
      } finally {
        renameSpy.mockRestore();
      }

      // The credential is still on disk, so it must still be in memory —
      // reporting it removed would be a lie that a restart undoes.
      expect(store.getCredential(IDENTITY_A)?.apiToken).toBe('tk_a');
      expect(loadVaultFile(filePath).has('https://idp.example/realm|user-a')).toBe(true);
    });
  });

  describe('incomplete load never becomes the write-back source of truth (issue #266)', () => {
    const validRecord = (ciphertext: string): VaultRecord => ({
      vikunjaUrl: 'https://vikunja.example.com',
      ciphertext,
      iv: 'aXY=',
      authTag: 'dGFn',
      keyVersion: 2,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      lastUsedAt: null,
    });

    it('refuses to provision when the vault file could not be read at all', async () => {
      const readSpy = jest.spyOn(fs, 'readFileSync').mockImplementation(() => {
        const error = new Error('EACCES: permission denied') as NodeJS.ErrnoException;
        error.code = 'EACCES';
        throw error;
      });
      const store = new VaultFileStore(filePath, KEY);
      try {
        expect(store.isDegraded()).toBe(true);
        await expect(
          store.provision(IDENTITY_A, 'https://vikunja.example.com', 'tk_new'),
        ).rejects.toThrow(/cannot be updated right now/);
      } finally {
        readSpy.mockRestore();
      }
      // Nothing was written: the store never created the file.
      expect(fs.existsSync(filePath)).toBe(false);
    });

    it('refuses to deprovision when the vault file could not be read at all', async () => {
      const readSpy = jest.spyOn(fs, 'readFileSync').mockImplementation(() => {
        const error = new Error('EIO: i/o error') as NodeJS.ErrnoException;
        error.code = 'EIO';
        throw error;
      });
      const store = new VaultFileStore(filePath, KEY);
      try {
        await expect(store.deprovision(IDENTITY_A)).rejects.toThrow(/cannot be updated right now/);
      } finally {
        readSpy.mockRestore();
      }
      expect(fs.existsSync(filePath)).toBe(false);
    });

    it('refuses to provision when the vault file is not valid JSON', async () => {
      fs.writeFileSync(filePath, '{ half-written', 'utf-8');
      const store = new VaultFileStore(filePath, KEY);

      await expect(
        store.provision(IDENTITY_A, 'https://vikunja.example.com', 'tk_new'),
      ).rejects.toThrow(/not valid JSON/);
      // The damaged file is left exactly as it was, for the operator to inspect.
      expect(fs.readFileSync(filePath, 'utf-8')).toBe('{ half-written');
    });

    it("does not destroy other identities' records when some entries were dropped", async () => {
      // The CRIT-5 scenario: one entry fails validation, so the load is
      // partial; the next provision used to write that partial map back.
      fs.writeFileSync(
        filePath,
        JSON.stringify({
          'https://idp.example/realm|user-a': validRecord('a-ciphertext'),
          'https://idp.example/realm|user-broken': { vikunjaUrl: 'only-this-field' },
        }),
        'utf-8',
      );

      const store = new VaultFileStore(filePath, KEY);
      expect(store.isDegraded()).toBe(true);
      await expect(
        store.provision(IDENTITY_B, 'https://vikunja.example.com', 'tk_b'),
      ).rejects.toThrow(/malformed entr/);

      const onDisk = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
      expect(Object.keys(onDisk).sort()).toEqual([
        'https://idp.example/realm|user-a',
        'https://idp.example/realm|user-broken',
      ]);
    });

    it('treats a missing file as a clean empty vault, not a failed load', async () => {
      const store = new VaultFileStore(filePath, KEY);
      expect(store.isDegraded()).toBe(false);

      await store.provision(IDENTITY_A, 'https://vikunja.example.com', 'tk_fresh');
      expect(store.getCredential(IDENTITY_A)?.apiToken).toBe('tk_fresh');
    });
  });

  describe('concurrent access', () => {
    it('serializes concurrent provisions for different identities without tearing the file', async () => {
      const store = new VaultFileStore(filePath, KEY);

      await Promise.all([
        store.provision(IDENTITY_A, 'https://vikunja.example.com', 'tk_a'),
        store.provision(IDENTITY_B, 'https://vikunja.example.com', 'tk_b'),
      ]);

      expect(store.getCredential(IDENTITY_A)?.apiToken).toBe('tk_a');
      expect(store.getCredential(IDENTITY_B)?.apiToken).toBe('tk_b');

      // The on-disk file itself must be valid JSON with both records —
      // proof no interleaved write corrupted it.
      const onDisk = loadVaultFile(filePath);
      expect(onDisk.size).toBe(2);
    });

    it('serializes many concurrent provisions of the SAME identity (last write observably wins, never torn)', async () => {
      const store = new VaultFileStore(filePath, KEY);

      const tokens = Array.from({ length: 20 }, (_, i) => `tk_token-${i}`);
      await Promise.all(
        tokens.map((token) => store.provision(IDENTITY_A, 'https://vikunja.example.com', token)),
      );

      const finalToken = store.getCredential(IDENTITY_A)?.apiToken;
      expect(tokens).toContain(finalToken);

      // The file on disk is well-formed (parseable, exactly one record) —
      // the mutex prevented any interleaved read-modify-write.
      const onDisk = loadVaultFile(filePath);
      expect(onDisk.size).toBe(1);
    });

    it('interleaves provision and deprovision of the same identity safely', async () => {
      const store = new VaultFileStore(filePath, KEY);
      await store.provision(IDENTITY_A, 'https://vikunja.example.com', 'tk_initial');

      await Promise.all([
        store.deprovision(IDENTITY_A),
        store.provision(IDENTITY_A, 'https://vikunja.example.com', 'tk_after'),
      ]);

      // Whichever operation landed last, the file must be well-formed and
      // in one of the two valid end states — never a torn/corrupt file.
      const onDisk = loadVaultFile(filePath);
      expect(onDisk.size).toBeLessThanOrEqual(1);
    });
  });
});

describe('active-vault seam (setActiveVaultStore / getActiveVaultStore)', () => {
  afterEach(() => {
    setActiveVaultStore(undefined);
  });

  it('is undefined until a store is registered', () => {
    expect(getActiveVaultStore()).toBeUndefined();
  });

  it('returns the exact instance that was registered', () => {
    const store = new VaultFileStore('/tmp/does-not-matter.json', KEY);
    setActiveVaultStore(store);
    expect(getActiveVaultStore()).toBe(store);
  });

  it('clears back to undefined when set to undefined', () => {
    const store = new VaultFileStore('/tmp/does-not-matter.json', KEY);
    setActiveVaultStore(store);
    setActiveVaultStore(undefined);
    expect(getActiveVaultStore()).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Reconciliation (H2a + H2b): the canonical VaultFileStore folds in H2b's
// dual hex/base64 master-key parsing and its byte-level secret-hygiene
// assertions. These blocks guard the pieces H2a's own suite did not cover so
// H2b's e2e lane + threat-model tests (which mint keys with `openssl rand
// -hex 32`) run against exactly this implementation.
// ---------------------------------------------------------------------------

describe('parseMasterKey (hex/base64 master-key parsing)', () => {
  it('accepts a 64-char hex string (openssl rand -hex 32)', () => {
    const raw = crypto.randomBytes(32);
    expect(parseMasterKey(raw.toString('hex')).equals(raw)).toBe(true);
  });

  it('accepts a standard base64 32-byte string (openssl rand -base64 32)', () => {
    const raw = crypto.randomBytes(32);
    expect(parseMasterKey(raw.toString('base64')).equals(raw)).toBe(true);
  });

  it('trims surrounding whitespace before parsing', () => {
    const raw = crypto.randomBytes(32);
    expect(parseMasterKey(`  ${raw.toString('hex')}\n`).equals(raw)).toBe(true);
  });

  it('rejects a value that decodes to the wrong length', () => {
    expect(() => parseMasterKey('too-short')).toThrow(/32 bytes/);
  });

  it('rejects an empty string', () => {
    expect(() => parseMasterKey('')).toThrow(/32 bytes/);
  });
});

describe('resolveVaultMasterKey accepts a hex-encoded key (e2e/threat format)', () => {
  const original = process.env.VIKUNJA_MCP_VAULT_KEY;
  const originalFile = process.env.VIKUNJA_MCP_VAULT_KEY_FILE;

  afterEach(() => {
    if (original === undefined) delete process.env.VIKUNJA_MCP_VAULT_KEY;
    else process.env.VIKUNJA_MCP_VAULT_KEY = original;
    if (originalFile === undefined) delete process.env.VIKUNJA_MCP_VAULT_KEY_FILE;
    else process.env.VIKUNJA_MCP_VAULT_KEY_FILE = originalFile;
  });

  it('resolves a 64-char hex key the same as its raw bytes', () => {
    const raw = crypto.randomBytes(32);
    process.env.VIKUNJA_MCP_VAULT_KEY = raw.toString('hex');
    expect(resolveVaultMasterKey().equals(raw)).toBe(true);
  });
});

describe('writeVaultFileAtomic byte-level secret hygiene', () => {
  let dir: string;
  let filePath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-hygiene-'));
    filePath = path.join(dir, 'vault.json');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('creates the parent directory if missing', () => {
    const nestedPath = path.join(dir, 'nested', 'deep', 'vault.json');
    writeVaultFileAtomic(nestedPath, new Map());
    expect(fs.existsSync(nestedPath)).toBe(true);
  });

  it('restricts the written file to owner-only permissions (0600)', () => {
    writeVaultFileAtomic(filePath, new Map());
    const mode = fs.statSync(filePath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('leaves no temp file behind after a successful write', () => {
    writeVaultFileAtomic(filePath, new Map());
    expect(fs.readdirSync(dir)).toEqual(['vault.json']);
  });

  it('never persists the plaintext token anywhere in the file bytes', () => {
    const key = crypto.randomBytes(32);
    const token = 'tk_this-must-never-appear-on-disk';
    const enc = encryptToken(token, key);
    const record: VaultRecord = {
      vikunjaUrl: 'http://localhost:33456/api/v1',
      ...enc,
      keyVersion: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      lastUsedAt: null,
    };
    writeVaultFileAtomic(filePath, new Map([['iss|sub', record]]));
    expect(fs.readFileSync(filePath, 'utf-8')).not.toContain(token);
  });
});
