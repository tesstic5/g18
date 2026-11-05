import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CSRF_COOKIE, mintCsrf, ensureCsrf, clearCsrfCookie } from './csrf';

function fakeReply() {
  const cookies: Array<{
    name: string;
    value: string;
    opts?: Record<string, unknown>;
  }> = [];
  const headers: Record<string, string> = {};
  return {
    cookies,
    headers,
    setCookie: (name: string, value: string, opts?: Record<string, unknown>) => {
      cookies.push({ name, value, opts });
    },
    clearCookie: (name: string, opts?: Record<string, unknown>) => {
      cookies.push({ name, value: '', opts: { ...opts, cleared: true } });
    },
    header: (name: string, value: string) => {
      headers[name.toLowerCase()] = value;
    },
  };
}

describe('csrf helper', () => {
  const prev = process.env.NODE_ENV;
  beforeEach(() => {
    process.env.NODE_ENV = 'test';
  });
  afterEach(() => {
    process.env.NODE_ENV = prev;
  });

  it('mints a UUID cookie that is readable (not httpOnly) and lax', () => {
    const reply = fakeReply();
    const token = mintCsrf(reply, 3600);
    expect(token).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    );
    expect(reply.cookies[0]?.name).toBe(CSRF_COOKIE);
    expect(reply.cookies[0]?.value).toBe(token);
    expect(reply.cookies[0]?.opts?.httpOnly).toBe(false);
    expect(reply.cookies[0]?.opts?.sameSite).toBe('lax');
    expect(reply.cookies[0]?.opts?.path).toBe('/');
    expect(reply.cookies[0]?.opts?.maxAge).toBe(3600);
    expect(reply.headers['x-csrf-token']).toBe(token);
  });

  it('ensureCsrf reuses a present cookie instead of rotating it', () => {
    const reply = fakeReply();
    const existing = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const token = ensureCsrf({ cookies: { [CSRF_COOKIE]: existing } }, reply, 8 * 3600);
    expect(token).toBe(existing);
    expect(reply.headers['x-csrf-token']).toBe(existing);
  });

  it('ensureCsrf mints when the cookie is missing', () => {
    const reply = fakeReply();
    const token = ensureCsrf({ cookies: {} }, reply, 8 * 3600);
    expect(token).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it('clearCsrfCookie drops path=/', () => {
    const reply = fakeReply();
    clearCsrfCookie(reply);
    expect(reply.cookies[0]?.name).toBe(CSRF_COOKIE);
    expect(reply.cookies[0]?.opts?.path).toBe('/');
  });
});
