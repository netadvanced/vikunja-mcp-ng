/**
 * Tests for the v1/v2 routing decision point (src/utils/api-version.ts).
 */

import { describe, it, expect, afterEach, beforeEach } from '@jest/globals';
import { resolveApiVersion } from '../../src/utils/api-version';
import { AuthManager } from '../../src/auth/AuthManager';
import { ConfigurationManager } from '../../src/config/ConfigurationManager';

describe('resolveApiVersion', () => {
  let authManager: AuthManager;

  beforeEach(() => {
    ConfigurationManager.reset();
    authManager = new AuthManager();
    authManager.connect('https://vikunja.test', 'tk_test-token');
  });

  afterEach(() => {
    delete process.env.VIKUNJA_MCP_FORCE_V1_API;
    ConfigurationManager.reset();
  });

  it('returns v2 when the session cached hasV2Api: true', () => {
    authManager.setCapabilities({ features: {}, hasV2Api: true, serverVersion: '2.4.0' });

    expect(resolveApiVersion(authManager)).toBe('v2');
  });

  it('returns v1 when the session cached hasV2Api: false', () => {
    authManager.setCapabilities({ features: {}, hasV2Api: false, serverVersion: '2.3.0' });

    expect(resolveApiVersion(authManager)).toBe('v1');
  });

  // Capabilities are populated during connect/info and cleared on
  // disconnect, so an uninitialized session must fall back rather than
  // assume v2.
  it('returns v1 when no capability snapshot has been cached', () => {
    expect(authManager.getCapabilities()).toBeUndefined();
    expect(resolveApiVersion(authManager)).toBe('v1');
  });

  it('returns v1 for an unauthenticated manager', () => {
    expect(resolveApiVersion(new AuthManager())).toBe('v1');
  });

  it('returns v1 when the kill switch is set despite a v2-capable server', () => {
    process.env.VIKUNJA_MCP_FORCE_V1_API = 'true';
    ConfigurationManager.reset();
    authManager.setCapabilities({ features: {}, hasV2Api: true, serverVersion: '2.4.0' });

    expect(resolveApiVersion(authManager)).toBe('v1');
  });
});
