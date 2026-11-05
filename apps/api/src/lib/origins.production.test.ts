// Production-mode CORS check: the permissive loopback rule must be OFF when
// NODE_ENV=production — any locally running software can claim a localhost
// Origin, so in production only the configured FRONTEND_URL match is allowed.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

describe('CORS origin matching in production', () => {
  const FE = 'https://2win2play.com';
  let prev: string | undefined;

  beforeEach(async () => {
    prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    vi.resetModules();
  });

  afterEach(() => {
    process.env.NODE_ENV = prev;
    vi.resetModules();
  });

  it('rejects loopback origins even on the usual dev ports', async () => {
    const { isOriginAllowed } = await import('./origins');
    expect(isOriginAllowed('http://localhost:8080', FE)).toBe(false);
    expect(isOriginAllowed('http://127.0.0.1:3000', FE)).toBe(false);
    expect(isOriginAllowed('http://[::1]:4000', FE)).toBe(false);
  });

  it('still accepts the configured frontend origin', async () => {
    const { isOriginAllowed } = await import('./origins');
    expect(isOriginAllowed('https://2win2play.com', FE)).toBe(true);
  });
});
