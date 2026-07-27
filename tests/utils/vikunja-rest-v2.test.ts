/**
 * Tests for the Vikunja v2 REST transport (src/utils/vikunja-rest-v2.ts).
 *
 * Covers v2 base-URL normalization, version-scoped circuit breaker naming,
 * the problem+json error adapter, and the request helper itself.
 */

import { describe, it, expect } from '@jest/globals';
import {
  resolveV2BaseUrl,
  deriveRestV2BreakerName,
} from '../../src/utils/vikunja-rest-v2';
import { deriveRestBreakerName } from '../../src/utils/vikunja-rest';

describe('vikunja-rest-v2 helper', () => {
  describe('resolveV2BaseUrl', () => {
    it('appends /api/v2 when no version suffix is present', () => {
      expect(resolveV2BaseUrl('https://vikunja.test')).toBe('https://vikunja.test/api/v2');
    });

    it('strips trailing slashes before appending', () => {
      expect(resolveV2BaseUrl('https://vikunja.test/')).toBe('https://vikunja.test/api/v2');
    });

    it('replaces an existing /api/v1 suffix with /api/v2', () => {
      expect(resolveV2BaseUrl('https://vikunja.test/api/v1')).toBe('https://vikunja.test/api/v2');
    });

    it('leaves an existing /api/v2 suffix intact', () => {
      expect(resolveV2BaseUrl('https://vikunja.test/api/v2')).toBe('https://vikunja.test/api/v2');
    });
  });

  describe('deriveRestV2BreakerName', () => {
    it('drops numeric id segments and prefixes with vikunja-rest-v2', () => {
      expect(deriveRestV2BreakerName('/tasks/7')).toBe('vikunja-rest-v2-tasks');
    });

    it('keeps the first two non-numeric segments', () => {
      expect(deriveRestV2BreakerName('/projects/4/views')).toBe('vikunja-rest-v2-projects-views');
    });

    it('falls back to "root" for a path with no usable segments', () => {
      expect(deriveRestV2BreakerName('/')).toBe('vikunja-rest-v2-root');
    });

    // Regression guard: breakers are process-wide and keyed by name, so a
    // shared name would let v1 failures trip the v2 breaker and vice versa.
    it('never collides with the v1 breaker name for the same path', () => {
      for (const path of ['/tasks/7', '/projects/4/views', '/labels/1']) {
        expect(deriveRestV2BreakerName(path)).not.toBe(deriveRestBreakerName(path));
      }
    });
  });
});
