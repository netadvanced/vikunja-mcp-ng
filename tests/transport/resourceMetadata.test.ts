/**
 * Unit tests for the RFC 9728 Protected Resource Metadata helpers
 * (src/transport/resourceMetadata.ts) — the discovery half of the MCP
 * authorization spec (2025-06-18 revision): browser MCP clients (e.g.
 * claude.ai custom connectors) fetch `/.well-known/oauth-protected-resource`
 * to find the IdP (`authorization_servers`) for this resource server.
 */

import type { IncomingMessage } from 'node:http';
import {
  WELL_KNOWN_PROTECTED_RESOURCE_PATH,
  buildProtectedResourceMetadata,
  isProtectedResourceMetadataPath,
  resolveResourceMetadataUrl,
  resolveResourceUrl,
} from '../../src/transport/resourceMetadata';
import type { HttpConfig } from '../../src/config/types';

function httpConfig(overrides: Partial<HttpConfig> = {}): HttpConfig {
  return { host: '127.0.0.1', port: 8765, path: '/mcp', ...overrides };
}

function fakeRequest(headers: Record<string, string | string[]> = {}): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

describe('resolveResourceUrl', () => {
  it('returns the configured publicUrl verbatim when set', () => {
    const config = httpConfig({ publicUrl: 'https://mcp-vikunja.example.ch/mcp' });
    expect(resolveResourceUrl(config, fakeRequest({ host: 'other.example:9' }))).toBe(
      'https://mcp-vikunja.example.ch/mcp',
    );
  });

  it('derives from the request Host header + configured path when publicUrl is unset', () => {
    expect(resolveResourceUrl(httpConfig(), fakeRequest({ host: 'mcp.example.ch:8765' }))).toBe(
      'http://mcp.example.ch:8765/mcp',
    );
  });

  it('falls back to the configured host:port when no Host header is present', () => {
    expect(resolveResourceUrl(httpConfig(), fakeRequest())).toBe('http://127.0.0.1:8765/mcp');
  });

  it('falls back to the configured host:port when the Host header is empty', () => {
    expect(resolveResourceUrl(httpConfig(), fakeRequest({ host: '' }))).toBe(
      'http://127.0.0.1:8765/mcp',
    );
  });

  it('honors x-forwarded-proto for the derived scheme', () => {
    expect(
      resolveResourceUrl(
        httpConfig(),
        fakeRequest({ host: 'mcp.example.ch', 'x-forwarded-proto': 'https' }),
      ),
    ).toBe('https://mcp.example.ch/mcp');
  });

  it('uses the first value of a comma-separated x-forwarded-proto chain', () => {
    expect(
      resolveResourceUrl(
        httpConfig(),
        fakeRequest({ host: 'mcp.example.ch', 'x-forwarded-proto': 'https, http' }),
      ),
    ).toBe('https://mcp.example.ch/mcp');
  });

  it('uses the first entry of an array-valued x-forwarded-proto header', () => {
    expect(
      resolveResourceUrl(
        httpConfig(),
        fakeRequest({ host: 'mcp.example.ch', 'x-forwarded-proto': ['https', 'http'] }),
      ),
    ).toBe('https://mcp.example.ch/mcp');
  });

  it('falls back to http when x-forwarded-proto is present but empty', () => {
    expect(
      resolveResourceUrl(
        httpConfig(),
        fakeRequest({ host: 'mcp.example.ch', 'x-forwarded-proto': '' }),
      ),
    ).toBe('http://mcp.example.ch/mcp');
  });

  it('derives without a request at all (startup-time resolution)', () => {
    expect(resolveResourceUrl(httpConfig({ host: '0.0.0.0', port: 9000, path: '/api/mcp' }))).toBe(
      'http://0.0.0.0:9000/api/mcp',
    );
  });
});

describe('resolveResourceMetadataUrl', () => {
  it('is the origin of the configured publicUrl + the well-known path', () => {
    const config = httpConfig({ publicUrl: 'https://mcp-vikunja.example.ch/mcp' });
    expect(resolveResourceMetadataUrl(config, fakeRequest())).toBe(
      'https://mcp-vikunja.example.ch/.well-known/oauth-protected-resource',
    );
  });

  it('is the derived origin + the well-known path when publicUrl is unset', () => {
    expect(resolveResourceMetadataUrl(httpConfig(), fakeRequest({ host: 'gw.example:81' }))).toBe(
      'http://gw.example:81/.well-known/oauth-protected-resource',
    );
  });

  it('throws on a Host header that cannot form a valid URL (caller must guard)', () => {
    expect(() =>
      resolveResourceMetadataUrl(httpConfig(), fakeRequest({ host: 'not a valid host' })),
    ).toThrow();
  });
});

describe('buildProtectedResourceMetadata', () => {
  it('serves the RFC 9728 shape: resource, authorization_servers, bearer_methods_supported', () => {
    const config = httpConfig({ publicUrl: 'https://mcp-vikunja.example.ch/mcp' });
    expect(
      buildProtectedResourceMetadata(config, 'https://idp.example.ch/realms/main', fakeRequest()),
    ).toEqual({
      resource: 'https://mcp-vikunja.example.ch/mcp',
      authorization_servers: ['https://idp.example.ch/realms/main'],
      bearer_methods_supported: ['header'],
    });
  });

  it('derives the resource from the request when publicUrl is unset', () => {
    expect(
      buildProtectedResourceMetadata(
        httpConfig(),
        'https://idp.example.ch/realms/main',
        fakeRequest({ host: '127.0.0.1:8765' }),
      ).resource,
    ).toBe('http://127.0.0.1:8765/mcp');
  });
});

describe('isProtectedResourceMetadataPath', () => {
  it('matches the bare well-known path', () => {
    expect(isProtectedResourceMetadataPath('/.well-known/oauth-protected-resource', '/mcp')).toBe(
      true,
    );
  });

  it('matches the path-suffixed variant for the configured MCP path', () => {
    expect(
      isProtectedResourceMetadataPath('/.well-known/oauth-protected-resource/mcp', '/mcp'),
    ).toBe(true);
  });

  it('follows a non-default MCP path for the suffixed variant', () => {
    expect(
      isProtectedResourceMetadataPath('/.well-known/oauth-protected-resource/api/mcp', '/api/mcp'),
    ).toBe(true);
    expect(
      isProtectedResourceMetadataPath('/.well-known/oauth-protected-resource/mcp', '/api/mcp'),
    ).toBe(false);
  });

  it('rejects unrelated paths', () => {
    expect(isProtectedResourceMetadataPath('/mcp', '/mcp')).toBe(false);
    expect(isProtectedResourceMetadataPath('/.well-known/openid-configuration', '/mcp')).toBe(
      false,
    );
  });

  it('exports the exact RFC 9728 well-known path constant', () => {
    expect(WELL_KNOWN_PROTECTED_RESOURCE_PATH).toBe('/.well-known/oauth-protected-resource');
  });
});
