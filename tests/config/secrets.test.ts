/**
 * Tests for Docker-secrets-style environment variable resolution
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readSecretEnv, SENSITIVE_ENV_VARS } from '../../src/config/secrets';
import { ConfigurationError } from '../../src/config/types';

describe('readSecretEnv', () => {
  let originalEnv: NodeJS.ProcessEnv;
  let tempDir: string;

  beforeEach(() => {
    originalEnv = { ...process.env };
    delete process.env.TEST_SECRET;
    delete process.env.TEST_SECRET_FILE;
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vikunja-mcp-secrets-test-'));
  });

  afterEach(() => {
    process.env = originalEnv;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns undefined when neither the plain var nor the _FILE var is set', () => {
    expect(readSecretEnv('TEST_SECRET')).toBeUndefined();
  });

  it('returns the plain env var verbatim when only it is set', () => {
    process.env.TEST_SECRET = '  raw-value-with-space  ';
    expect(readSecretEnv('TEST_SECRET')).toBe('  raw-value-with-space  ');
  });

  it('reads and trims the file contents when only the _FILE var is set', () => {
    const filePath = path.join(tempDir, 'secret');
    fs.writeFileSync(filePath, '\n  secret-from-file  \t\n');
    process.env.TEST_SECRET_FILE = filePath;

    expect(readSecretEnv('TEST_SECRET')).toBe('secret-from-file');
  });

  it('throws a ConfigurationError when both the plain var and _FILE var are set', () => {
    const filePath = path.join(tempDir, 'secret');
    fs.writeFileSync(filePath, 'secret-from-file');
    process.env.TEST_SECRET = 'plain-value';
    process.env.TEST_SECRET_FILE = filePath;

    expect(() => readSecretEnv('TEST_SECRET')).toThrow(ConfigurationError);
    expect(() => readSecretEnv('TEST_SECRET')).toThrow(/Both TEST_SECRET and TEST_SECRET_FILE/);
  });

  it('throws a ConfigurationError when the _FILE var points at a nonexistent file', () => {
    process.env.TEST_SECRET_FILE = path.join(tempDir, 'does-not-exist');

    expect(() => readSecretEnv('TEST_SECRET')).toThrow(ConfigurationError);
    expect(() => readSecretEnv('TEST_SECRET')).toThrow(/Failed to read secret file/);
  });

  it('lists VIKUNJA_API_TOKEN as a sensitive env var', () => {
    expect(SENSITIVE_ENV_VARS).toContain('VIKUNJA_API_TOKEN');
  });
});
