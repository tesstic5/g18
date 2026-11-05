import { describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { proxy } from '../proxy';
describe('PayFast checkout CSP boundary', () => {
  it('lets the launch API supply the exact provider form CSP', () => {
    const response = proxy(
      new NextRequest('https://example.com/api/v1/payfast/launch/abc')
    );
    expect(response.headers.get('content-security-policy')).toBeNull();
  });
  it('preserves restrictive CSP on ordinary pages', () => {
    const response = proxy(new NextRequest('https://example.com/wallet'));
    expect(response.headers.get('content-security-policy')).toContain(
      "form-action 'self'"
    );
    expect(response.headers.get('content-security-policy')).toContain(
      "frame-ancestors 'none'"
    );
  });
});
