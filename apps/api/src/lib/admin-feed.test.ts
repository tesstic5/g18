/**
 * v1.3.8 regression test — admin notifications were silently dead in
 * production because globalThis.__io was only ever assigned by the test
 * suite. These tests pin the emitAdmin contract so the silent-death path
 * can never regress unnoticed again.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { emitAdmin } from './admin-feed';

interface Captured {
  room: string;
  event: string;
  payload: unknown;
}

function fakeIo(): { io: object; captured: Captured[] } {
  const captured: Captured[] = [];
  const io = {
    to(room: string) {
      return {
        emit(event: string, payload: unknown) {
          captured.push({ room, event, payload });
        },
      };
    },
  };
  return { io, captured };
}

afterEach(() => {
  delete (globalThis as { __io?: unknown }).__io;
  vi.restoreAllMocks();
});

describe('emitAdmin', () => {
  it('broadcasts to the admins room with the admin: prefix and the payload intact', () => {
    const { io, captured } = fakeIo();
    (globalThis as { __io?: unknown }).__io = io;
    emitAdmin('new-deposit', {
      kind: 'deposit',
      at: 123,
      userId: 'abc123',
      amount: 5000,
      method: 'easypaisa',
      status: 'PENDING',
    });
    expect(captured).toEqual([
      {
        room: 'admins',
        event: 'admin:new-deposit',
        payload: {
          kind: 'deposit',
          at: 123,
          userId: 'abc123',
          amount: 5000,
          method: 'easypaisa',
          status: 'PENDING',
        },
      },
    ]);
  });

  it('withdrawal-request events reach the same room (deposits + withdrawals are the two flows the admin must see)', () => {
    const { io, captured } = fakeIo();
    (globalThis as { __io?: unknown }).__io = io;
    emitAdmin('withdrawal-request', {
      kind: 'withdrawal',
      at: 456,
      userId: 'u7',
      amount: 1000,
      netAmount: 950,
      status: 'PENDING',
    });
    expect(captured).toHaveLength(1);
    expect(captured[0]!.room).toBe('admins');
    expect(captured[0]!.event).toBe('admin:withdrawal-request');
  });

  it('does not throw and warns in non-production when no socket server is registered', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const prevEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';
    expect(() => emitAdmin('live-bet', { x: 1 })).not.toThrow();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('admin:live-bet'));
    process.env.NODE_ENV = prevEnv;
  });

  it('stays silent in production even with no io (log-never-leaks rule)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const prevEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    expect(() => emitAdmin('live-bet', { x: 1 })).not.toThrow();
    expect(warn).not.toHaveBeenCalled();
    process.env.NODE_ENV = prevEnv;
  });
});
