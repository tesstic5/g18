import { describe, expect, it } from 'vitest';
import { buildCsp } from './csp';

describe('buildCsp', () => {
  it('binds scripts to the request nonce and never allows unsafe-inline scripts', () => {
    const csp = buildCsp('abc123+/');
    expect(csp).toContain("script-src 'self' 'nonce-abc123+/' 'strict-dynamic'");
    expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
  });

  it('keeps style-src unsafe-inline (Next/font + Tailwind inject styles)', () => {
    expect(buildCsp('n')).toContain("style-src 'self' 'unsafe-inline'");
  });

  it('blocks framing and plugins', () => {
    const csp = buildCsp('n');
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
  });
});
