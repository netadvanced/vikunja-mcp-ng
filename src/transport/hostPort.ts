import { isIPv6 } from 'node:net';

/**
 * `host:port` as it appears in a URL or a `Host` header. IPv6 literals are
 * bracketed (`[::1]:8765`), which is what clients send in `Host` and what a
 * URL requires; IPv4 addresses and names are left as they are.
 */
export function formatHostPort(host: string, port: number): string {
  return isIPv6(host) ? `[${host}]:${port}` : `${host}:${port}`;
}
