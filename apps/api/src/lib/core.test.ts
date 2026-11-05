// apps/api/src/lib/core.test.ts — D-103: error bodies must never mask DB
// failures as a generic 500 "An unexpected error occurred".
import { describe, it, expect } from 'vitest';
import { err, AppError } from './core';

describe('err() — D-103 DB/connection failure mapping', () => {
  it('maps Prisma ECONNREFUSED to a clear 503-style message', () => {
    const e = new Error(
      "Invalid `prisma.adminUser.findUnique()` invocation — can't reach database server at `localhost:5432`"
    );
    (e as { code?: string }).code = 'ECONNREFUSED';
    const body = err(e, 'req-1');
    expect(body.code).toBe('SVC_503');
    expect(body.message).toContain('temporarily unavailable');
    expect(body.message).not.toContain('unexpected error');
    expect(body.requestId).toBe('req-1');
  });

  it("maps Prisma P1001 (can't reach) to the same clear message", () => {
    const e = new Error('P1017: Server has closed the connection');
    (e as { code?: string }).code = 'P1017';
    const body = err(e, 'req-2');
    expect(body.code).toBe('SVC_503');
    expect(body.message).toContain('temporarily unavailable');
  });

  it('keeps AppErrors intact (401 invalid credentials)', () => {
    const appErr = new AppError('AUTH_001', 401, 'Invalid credentials');
    const body = err(appErr, 'req-3');
    expect(body.code).toBe('AUTH_001');
    expect(body.message).toBe('Invalid credentials');
    expect(body.requestId).toBe('req-3');
  });

  it('masks real code bugs as generic (not DB) — still has requestId', () => {
    const body = err(
      new Error('TypeError: cannot read properties of undefined'),
      'req-4'
    );
    expect(body.code).not.toBe('SVC_503');
    expect(body.message).toBe('An unexpected error occurred');
    expect(body.requestId).toBe('req-4');
  });
});
