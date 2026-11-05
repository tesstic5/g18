// @vitest-environment jsdom
// apps/web/src/lib/auth-errors.test.ts — D-103: auth failures must show clear,
// actionable messages — NEVER a raw "An unexpected error occurred".
import { describe, it, expect } from 'vitest';
import { friendlyAuthError } from './auth-errors';

describe('friendlyAuthError (D-103)', () => {
  it('maps DB-unavailable 503 to a clear retry message', () => {
    const msg = friendlyAuthError({
      status: 503,
      code: 'SVC_503',
      message:
        'Service is temporarily unavailable — the database is starting up or unreachable. Please try again in a moment.',
    });
    expect(msg).toContain('temporarily unavailable');
    expect(msg).not.toContain('unexpected error');
  });

  it('maps timeouts to a retry message', () => {
    expect(friendlyAuthError({ code: 'GEN_TIMEOUT' })).toContain(
      'temporarily unavailable'
    );
    expect(friendlyAuthError({ code: 'GEN_004' })).toContain('temporarily unavailable');
  });

  it('maps network failures (no status/code) to a connection message', () => {
    const msg = friendlyAuthError(new TypeError('Failed to fetch'));
    expect(msg).toContain('Can\u2019t reach the server');
  });

  it('replaces the masked generic 500 with a friendly message incl. ref', () => {
    const msg = friendlyAuthError({
      status: 500,
      message: 'An unexpected error occurred',
      details: { requestId: 'abc-123' },
    });
    expect(msg).toContain('Something went wrong on our side');
    expect(msg).toContain('ref: abc-123');
    expect(msg).not.toContain('An unexpected error occurred');
  });

  it('passes through clear API messages (e.g. invalid credentials)', () => {
    expect(
      friendlyAuthError({
        status: 401,
        code: 'AUTH_001',
        message: 'Invalid credentials',
      })
    ).toBe('Incorrect phone number or password');
  });

  it('handles rate limiting with the server message', () => {
    const msg = friendlyAuthError({
      status: 429,
      code: 'GEN_003',
      message: 'Too many attempts — please wait 13 minute(s)',
    });
    expect(msg).toContain('Too many attempts');
  });

  it('maps CORS_DENIED to an actionable security message (D-104)', () => {
    const msg = friendlyAuthError({
      status: 403,
      code: 'CORS_DENIED',
      message: 'Origin not allowed by server configuration',
    });
    expect(msg).toContain('blocked');
    expect(msg).not.toContain('unexpected error');
  });
});
