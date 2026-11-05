// apps/api/src/lib/origins.test.ts — D-104: CORS origin matching must accept
// every legitimate variant of the frontend URL and reject foreign origins.
import { describe, it, expect } from 'vitest';
import { normalizeOrigin, isOriginAllowed, isLoopbackOrigin, hostnameOf } from './origins';

describe('CORS origin matching (D-104)', () => {
  const FE = 'https://2win2play.com';

  it('accepts the exact frontend origin', () => {
    expect(isOriginAllowed('https://2win2play.com', FE)).toBe(true);
  });

  it('accepts trailing slash, http, and www variants of the same site', () => {
    expect(isOriginAllowed('https://2win2play.com/', FE)).toBe(true);
    expect(isOriginAllowed('http://2win2play.com', FE)).toBe(true);
    expect(isOriginAllowed('https://www.2win2play.com', FE)).toBe(true);
    expect(isOriginAllowed('http://www.2win2play.com/', FE)).toBe(true);
    expect(isOriginAllowed('HTTPS://2WIN2PLAY.COM', FE)).toBe(true);
  });

  it('accepts missing Origin (proxied same-origin, curl, server-to-server)', () => {
    expect(isOriginAllowed(null, FE)).toBe(true);
    expect(isOriginAllowed(undefined, FE)).toBe(true);
  });

  it('rejects foreign origins', () => {
    expect(isOriginAllowed('https://evil.example', FE)).toBe(false);
    expect(isOriginAllowed('https://2win2play.com.evil.example', FE)).toBe(false);
    expect(isOriginAllowed('https://not2win2play.com', FE)).toBe(false);
  });

  it('rejects everything when FRONTEND_URL is unset (fail-closed)', () => {
    expect(isOriginAllowed('https://2win2play.com', undefined)).toBe(false);
  });

  // ── D-105: the web container's host port must never decide whether login works ──
  it('accepts loopback origins on ANY port in non-production (the WEB_HOST_PORT trap)', () => {
    expect(process.env.NODE_ENV).not.toBe('production');
    expect(isOriginAllowed('http://localhost:8080', FE)).toBe(true);
    expect(isOriginAllowed('http://localhost:8081', FE)).toBe(true);
    expect(isOriginAllowed('http://localhost:3000', FE)).toBe(true); // old default still fine
    expect(isOriginAllowed('http://localhost:4000', FE)).toBe(true);
    expect(isOriginAllowed('http://127.0.0.1:8080', FE)).toBe(true);
    expect(isOriginAllowed('http://127.0.0.1:3000', FE)).toBe(true);
    expect(isOriginAllowed('http://[::1]:8080', FE)).toBe(true);
    expect(isOriginAllowed('http://localhost:8080/', FE)).toBe(true);
    expect(isOriginAllowed('https://localhost:8443', FE)).toBe(true);
  });

  it('does not let a foreign host masquerade as loopback', () => {
    expect(isOriginAllowed('https://localhost.evil.example', FE)).toBe(false);
    expect(isOriginAllowed('https://127.0.0.1.evil.example', FE)).toBe(false);
    expect(isOriginAllowed('https://evil.example/localhost:8080', FE)).toBe(false);
    expect(isOriginAllowed('https://notlocalhost', FE)).toBe(false);
  });

  it('parses hostnames including brackets and bare host:port', () => {
    expect(hostnameOf('http://localhost:8080')).toBe('localhost');
    expect(hostnameOf('localhost:8080')).toBe('localhost');
    expect(hostnameOf('http://[::1]:8080')).toBe('[::1]');
    expect(hostnameOf('https://2WIN2PLAY.com')).toBe('2win2play.com');
    expect(hostnameOf('')).toBe('');
    expect(hostnameOf('not a url at all')).toBe('');
  });

  it('isLoopbackOrigin is false for public hosts', () => {
    expect(isLoopbackOrigin('https://2win2play.com')).toBe(false);
    expect(isLoopbackOrigin('https://localhost.evil.example')).toBe(false);
    expect(isLoopbackOrigin('http://localhost:8080')).toBe(true);
  });

  it('stays fail-closed on the configured site when FRONTEND_URL is unset', () => {
    // Loopback is accepted on its own merits; the configured site still needs
    // FRONTEND_URL to exist at all.
    expect(isOriginAllowed('http://localhost:8080', undefined)).toBe(false);
  });

  it('normalizeOrigin strips scheme, www and trailing slash', () => {
    expect(normalizeOrigin('https://www.2win2play.com/')).toBe('2win2play.com');
    expect(normalizeOrigin('HTTP://2WIN2PLAY.COM')).toBe('2win2play.com');
  });
});
