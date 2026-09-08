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

  /**
   * Per-operation minimum server version (issue #184 P3 step 1). The driver
   * is task update: v2 `PATCH` corrupts subscriptions on 2.4.0 and is fixed
   * from 2.5.0, so that one operation needs its own floor while every other
   * operation keeps using v2 on any v2-capable server.
   */
  describe('minVersion', () => {
    // `GET /info` reports the version with a leading `v` on all three
    // supported releases, so a comparison that does not strip it would send
    // every server to v1.
    it('returns v2 when the detected version is above the floor', () => {
      authManager.setCapabilities({ features: {}, hasV2Api: true, serverVersion: 'v2.6.0' });

      expect(resolveApiVersion(authManager, { minVersion: '2.5.0' })).toBe('v2');
    });

    it('returns v2 when the detected version equals the floor exactly', () => {
      authManager.setCapabilities({ features: {}, hasV2Api: true, serverVersion: 'v2.5.0' });

      expect(resolveApiVersion(authManager, { minVersion: '2.5.0' })).toBe('v2');
    });

    it('returns v1 when the detected version is below the floor', () => {
      authManager.setCapabilities({ features: {}, hasV2Api: true, serverVersion: 'v2.4.0' });

      expect(resolveApiVersion(authManager, { minVersion: '2.5.0' })).toBe('v1');
    });

    // "We could not tell" is not evidence that a server is new enough.
    it('returns v1 when the server version was never detected', () => {
      authManager.setCapabilities({ features: {}, hasV2Api: true });

      expect(resolveApiVersion(authManager, { minVersion: '2.5.0' })).toBe('v1');
    });

    it('returns v1 when the detected version is unparseable', () => {
      authManager.setCapabilities({ features: {}, hasV2Api: true, serverVersion: 'unversioned' });

      expect(resolveApiVersion(authManager, { minVersion: '2.5.0' })).toBe('v1');
    });

    it('treats a prerelease of the floor version as meeting it', () => {
      authManager.setCapabilities({ features: {}, hasV2Api: true, serverVersion: 'v2.5.0-rc1' });

      expect(resolveApiVersion(authManager, { minVersion: '2.5.0' })).toBe('v2');
    });

    it('still returns v1 below the floor even on a v2-capable server', () => {
      authManager.setCapabilities({ features: {}, hasV2Api: false, serverVersion: 'v2.6.0' });

      expect(resolveApiVersion(authManager, { minVersion: '2.5.0' })).toBe('v1');
    });

    it('is overridden by the kill switch', () => {
      process.env.VIKUNJA_MCP_FORCE_V1_API = 'true';
      ConfigurationManager.reset();
      authManager.setCapabilities({ features: {}, hasV2Api: true, serverVersion: 'v2.6.0' });

      expect(resolveApiVersion(authManager, { minVersion: '2.5.0' })).toBe('v1');
    });

    // The behaviour-neutrality guarantee for this step: adding the option
    // must not move any existing caller, all of which pass no options.
    it('leaves callers that pass no options unchanged', () => {
      for (const serverVersion of ['v2.4.0', 'v2.5.0', 'v2.6.0']) {
        authManager.setCapabilities({ features: {}, hasV2Api: true, serverVersion });
        expect(resolveApiVersion(authManager)).toBe('v2');
        expect(resolveApiVersion(authManager, {})).toBe('v2');
      }
    });
  });
});
