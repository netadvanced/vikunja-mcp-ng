/**
 * Logger Credential Redaction Tests
 *
 * The logger is the single choke point every credential-bearing log call passes
 * through. These tests assert that redaction happens *there*, so no individual
 * call site has to remember to strip its own secrets.
 *
 * All fixtures are obvious fakes (`tk_FAKE…`, `FAKEfake…`); no real credential
 * appears in this file.
 */

import {
  redactSecretsInText,
  redactUrlSecrets,
  sanitizeForLogging,
  sanitizeLogArgs,
} from '../../src/utils/security';

// Obvious fakes, never real credentials.
const FAKE_API_TOKEN = 'tk_FAKEfake0123456789abcdef';
const FAKE_JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJGQUtFIn0.FAKEfakeSignature0123';
const FAKE_WEBHOOK_SECRET = 'FAKEfakeWebhookHmacSecret9876';
const FAKE_SLACK_PATH_SECRET = 'FAKEfakeFAKEfake12345678';
const FAKE_SLACK_URL = `https://hooks.slack.com/services/T00000000/B00000000/${FAKE_SLACK_PATH_SECRET}`;

interface TestLogger {
  error(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  debug(message: string, ...args: unknown[]): void;
}

describe('Logger credential redaction', () => {
  let originalEnv: NodeJS.ProcessEnv;
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    originalEnv = { ...process.env };
    delete process.env.DEBUG;
    delete process.env.LOG_LEVEL;
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();
  });

  afterEach(() => {
    process.env = originalEnv;
    consoleErrorSpy.mockRestore();
  });

  /** Loads a fresh logger honouring the current environment. */
  function freshLogger(): TestLogger {
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('../../src/utils/logger').logger as TestLogger;
  }

  function output(): string {
    return consoleErrorSpy.mock.calls.map((call) => String(call[0])).join('\n');
  }

  describe('ERROR level (enabled by default)', () => {
    it('redacts a webhook secret and a secret-bearing target URL with no env configured', () => {
      // No DEBUG, no LOG_LEVEL: this is the default production configuration,
      // where ERROR is emitted. This is the path that leaked.
      const log = freshLogger();

      log.error('Webhook operation failed', {
        subcommand: 'create',
        scope: 'project',
        args: {
          projectId: 12,
          targetUrl: FAKE_SLACK_URL,
          secret: FAKE_WEBHOOK_SECRET,
          events: ['task.created'],
        },
      });

      expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
      expect(output()).not.toContain(FAKE_WEBHOOK_SECRET);
      expect(output()).not.toContain(FAKE_SLACK_PATH_SECRET);
      // The endpoint itself stays legible.
      expect(output()).toContain('hooks.slack.com');
      expect(output()).toContain('[ERROR]');
    });

    it('redacts credentials carried on a thrown error alongside raw args', () => {
      const log = freshLogger();
      const error = new Error(`Request failed for ${FAKE_SLACK_URL}`);

      log.error('Notifications operation failed', {
        error,
        subcommand: 'list',
        args: { apiToken: FAKE_API_TOKEN, page: 2 },
      });

      expect(output()).not.toContain(FAKE_API_TOKEN);
      expect(output()).not.toContain(FAKE_SLACK_PATH_SECRET);
    });
  });

  describe('every level sanitizes', () => {
    it.each(['error', 'warn', 'info', 'debug'] as const)('redacts at %s level', (level) => {
      process.env.LOG_LEVEL = level;
      const log = freshLogger();

      log[level]('tool called', {
        subcommand: 'create',
        args: { secret: FAKE_WEBHOOK_SECRET, apiToken: FAKE_API_TOKEN, jwt: FAKE_JWT },
      });

      expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
      expect(output()).not.toContain(FAKE_WEBHOOK_SECRET);
      expect(output()).not.toContain(FAKE_API_TOKEN);
      expect(output()).not.toContain(FAKE_JWT);
    });
  });

  describe('call-site shapes used across the codebase', () => {
    beforeEach(() => {
      process.env.LOG_LEVEL = 'debug';
    });

    it('redacts the `{ subcommand, args }` shape used by the tasks tool', () => {
      const log = freshLogger();

      log.debug('Executing tasks tool', {
        subcommand: 'create',
        args: { subcommand: 'create', title: 'Buy milk', apiToken: FAKE_API_TOKEN },
      });

      expect(output()).not.toContain(FAKE_API_TOKEN);
      expect(output()).toContain('Buy milk');
    });

    it('redacts credentials passed positionally rather than in an object', () => {
      const log = freshLogger();

      log.debug('Connecting with token %s', FAKE_API_TOKEN);

      expect(output()).not.toContain(FAKE_API_TOKEN);
    });

    it('redacts a credential interpolated into the message itself', () => {
      const log = freshLogger();

      log.error(`Auth failed with token=${FAKE_API_TOKEN} and jwt ${FAKE_JWT}`);

      expect(output()).not.toContain(FAKE_API_TOKEN);
      expect(output()).not.toContain(FAKE_JWT);
    });

    it('redacts credentials nested several levels deep', () => {
      const log = freshLogger();

      log.debug('deep', { a: { b: { c: [{ webhookSecret: FAKE_WEBHOOK_SECRET }] } } });

      expect(output()).not.toContain(FAKE_WEBHOOK_SECRET);
    });

    it('redacts URL userinfo and sensitive query parameters', () => {
      const log = freshLogger();

      log.debug(
        'calling %s',
        `https://someone:FAKEpassword@example.com/hook?token=${FAKE_API_TOKEN}&page=2`,
      );

      expect(output()).not.toContain('FAKEpassword');
      expect(output()).not.toContain(FAKE_API_TOKEN);
      // Non-sensitive query parameters survive.
      expect(output()).toContain('page=2');
    });
  });

  describe('legibility of ordinary diagnostics', () => {
    beforeEach(() => {
      process.env.LOG_LEVEL = 'debug';
    });

    it('does not mangle text that merely looks suspicious to an input validator', () => {
      const log = freshLogger();

      log.debug('recovery hint: %s', 'failed at ../src/foo.ts, retry with curl; 2>&1');

      expect(output()).toContain('../src/foo.ts');
      expect(output()).not.toContain('SANITIZATION_FAILED');
    });

    it('does not truncate long diagnostic strings', () => {
      const log = freshLogger();
      const long = `${'detail '.repeat(300)}tail-marker`;

      log.debug('long', { detail: long });

      expect(output()).toContain('tail-marker');
      expect(output()).not.toContain('SANITIZATION_FAILED');
    });

    it('keeps an ordinary API URL readable', () => {
      const log = freshLogger();

      log.debug('request', { url: 'https://vikunja.example.com/api/v1/projects/12/tasks?page=2' });

      expect(output()).toContain('vikunja.example.com/api/v1/projects/12/tasks');
    });

    it('keeps the native `Error: message` rendering for a plain error', () => {
      const log = freshLogger();

      log.error('Operation failed', new Error('Boom'));

      expect(output()).toContain('Error: Boom');
      expect(output()).toContain('logger-redaction.test.ts');
    });

    it('unwraps an error that carries extra properties and redacts the sensitive ones', () => {
      const log = freshLogger();
      const error = Object.assign(new Error('Request failed'), {
        code: 'API_ERROR',
        authorization: `Bearer ${FAKE_JWT}`,
      });

      log.error('Operation failed', error);

      expect(output()).toContain('Request failed');
      expect(output()).toContain('API_ERROR');
      expect(output()).not.toContain(FAKE_JWT);
    });

    it('survives a cyclic argument', () => {
      const log = freshLogger();
      const cyclic: Record<string, unknown> = { name: 'root', secret: FAKE_WEBHOOK_SECRET };
      cyclic.self = cyclic;

      expect(() => log.error('cyclic', cyclic)).not.toThrow();
      expect(output()).toContain('[Circular Reference]');
      expect(output()).not.toContain(FAKE_WEBHOOK_SECRET);
    });
  });

  describe('cost when the level is disabled', () => {
    it('does not touch the argument at all for a suppressed level', () => {
      process.env.LOG_LEVEL = 'error';
      const log = freshLogger();

      let reads = 0;
      const probe = {};
      Object.defineProperty(probe, 'secret', {
        enumerable: true,
        get() {
          reads += 1;
          return FAKE_WEBHOOK_SECRET;
        },
      });

      log.debug('suppressed', probe);
      expect(reads).toBe(0);
      expect(consoleErrorSpy).not.toHaveBeenCalled();

      log.error('emitted', probe);
      expect(reads).toBe(1);
      expect(output()).not.toContain(FAKE_WEBHOOK_SECRET);
    });
  });
});

describe('redactSecretsInText', () => {
  it('returns non-string and empty input unchanged', () => {
    expect(redactSecretsInText('')).toBe('');
    expect(redactSecretsInText(undefined as unknown as string)).toBeUndefined();
  });

  it('redacts JWTs, API tokens and authorization header values', () => {
    expect(redactSecretsInText(`jwt ${FAKE_JWT}`)).toBe('jwt [REDACTED_JWT]');
    expect(redactSecretsInText(`token ${FAKE_API_TOKEN}`)).toBe('token [REDACTED_TOKEN]');
    expect(redactSecretsInText('sent Basic RkFLRWZha2VCYXNpYw== upstream')).toBe(
      'sent Basic [REDACTED] upstream',
    );
    // A credential-named assignment redacts the whole value regardless of form.
    expect(redactSecretsInText('Authorization: Basic RkFLRWZha2VCYXNpYw==')).not.toContain(
      'RkFLRWZha2VCYXNpYw',
    );
  });

  it('redacts PEM private key blocks', () => {
    const pem =
      '-----BEGIN RSA PRIVATE KEY-----\nFAKEfakeKeyMaterial\n-----END RSA PRIVATE KEY-----';
    expect(redactSecretsInText(`loaded ${pem} ok`)).toContain('[REDACTED_PRIVATE_KEY]');
    expect(redactSecretsInText(`key: ${pem}`)).not.toContain('FAKEfakeKeyMaterial');
  });

  it('redacts credential-named assignments but leaves ordinary ones alone', () => {
    expect(redactSecretsInText('password=hunter2 count=3')).toBe('password=[REDACTED] count=3');
    expect(redactSecretsInText('projectId: 12')).toBe('projectId: 12');
    expect(redactSecretsInText('elapsed 00:12')).toBe('elapsed 00:12');
  });
});

describe('redactUrlSecrets', () => {
  it('returns an unparseable value untouched', () => {
    expect(redactUrlSecrets('not a url')).toBe('not a url');
  });

  it('redacts a high-entropy path segment but keeps short identifiers', () => {
    const redacted = redactUrlSecrets(FAKE_SLACK_URL);
    expect(redacted).not.toContain(FAKE_SLACK_PATH_SECRET);
    expect(redacted).toContain('T00000000');
  });

  it('keeps a readable lowercase slug', () => {
    const url = 'https://example.com/projects/my-very-long-project-slug-name';
    expect(redactUrlSecrets(url)).toBe(url);
  });

  it('redacts uppercase-and-digit and mixed-case opaque segments', () => {
    expect(redactUrlSecrets('https://example.com/h/FAKE0123456789ABCDEFGH')).toContain('REDACTED');
    expect(redactUrlSecrets('https://example.com/h/FAKEfakeFAKEfakeFAKEfake')).toContain(
      'REDACTED',
    );
  });

  it('redacts a credential-named fragment', () => {
    expect(redactUrlSecrets('https://example.com/cb#access_token')).toContain('#REDACTED');
  });
});

describe('sanitizeForLogging / sanitizeLogArgs', () => {
  it('leaves primitives alone', () => {
    expect(sanitizeForLogging(null)).toBeNull();
    expect(sanitizeForLogging(undefined)).toBeUndefined();
    expect(sanitizeForLogging(42)).toBe(42);
    expect(sanitizeForLogging(true)).toBe(true);
  });

  it('reports unsupported types rather than emitting them', () => {
    expect(sanitizeForLogging(() => undefined)).toBe('[Unsupported Type]');
    expect(sanitizeForLogging(Symbol('x'))).toBe('[Unsupported Type]');
  });

  it('renders a repeated (non-cyclic) object on each occurrence', () => {
    const shared = { value: 1 };
    expect(sanitizeForLogging({ a: shared, b: shared })).toEqual({
      a: { value: 1 },
      b: { value: 1 },
    });
  });

  it('detects a cycle inside an array', () => {
    const arr: unknown[] = [1];
    arr.push(arr);
    expect(sanitizeForLogging(arr)).toEqual([1, '[Circular Reference]']);
  });

  it('detects a cycle through an error property', () => {
    const error = Object.assign(new Error('cyclic'), { self: undefined as unknown });
    error.self = error;
    expect(sanitizeForLogging(error)).toMatchObject({
      name: 'Error',
      message: 'cyclic',
      self: '[Circular Reference]',
    });
  });

  it('falls back to name and message when an error has no stack', () => {
    const error = new Error(`stackless ${FAKE_API_TOKEN}`);
    delete (error as { stack?: string }).stack;
    expect(sanitizeForLogging(error)).toBe('Error: stackless [REDACTED_TOKEN]');

    const withProps = Object.assign(new Error('stackless with props'), { code: 'X' });
    delete (withProps as { stack?: string }).stack;
    expect(sanitizeForLogging(withProps)).toEqual({
      name: 'Error',
      message: 'stackless with props',
      code: 'X',
    });
  });

  it('follows an error cause chain', () => {
    const inner = new Error(`inner ${FAKE_API_TOKEN}`);
    const outer = new Error('outer', { cause: inner });
    const result = JSON.stringify(sanitizeForLogging(outer));
    expect(result).not.toContain(FAKE_API_TOKEN);
    expect(result).toContain('outer');
  });

  it('masks a long credential held under a sensitive key', () => {
    const long = `FAKEfake${'x'.repeat(60)}`;
    const result = sanitizeForLogging({ password: long }) as Record<string, unknown>;
    expect(result.password).not.toBe(long);
  });

  it('sanitizes every argument of a call', () => {
    const [first, second] = sanitizeLogArgs([{ secret: FAKE_WEBHOOK_SECRET }, 'plain']);
    expect(JSON.stringify(first)).not.toContain(FAKE_WEBHOOK_SECRET);
    expect(second).toBe('plain');
  });
});
