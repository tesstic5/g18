// apps/api/src/services/session-security.test.ts
//
// Refresh-token rotation is now backed by Postgres, so the reuse check runs
// even when Redis is unavailable. These tests pin that behaviour — in
// particular the case that used to be exploitable:
//
//   "Redis is down AND a refresh token was stolen" → the token must still be
//   rejected on reuse. Previously the code failed open and accepted it for the
//   token's full 7-day life.
import { describe, expect, it, beforeEach, vi } from 'vitest';

// Redis is FORCED TO FAIL in every test here. That is the whole point: the
// security guarantee must not depend on it.
vi.mock('../db/redis', () => ({
  redis: {
    set: async () => {
      throw new Error('Redis is down');
    },
    get: async () => {
      throw new Error('Redis is down');
    },
    del: async () => {
      throw new Error('Redis is down');
    },
    expire: async () => {
      throw new Error('Redis is down');
    },
  },
  keys: { rl: (n: string, s: string) => `rl:${n}:${s}` },
}));

interface FamilyRow {
  id: string;
  userId: string;
  usedAt: Date | null;
  revokedAt: Date | null;
  revokedReason: string | null;
  expiresAt: Date;
  createdAt: Date;
  replacedById: string | null;
  parentId: string | null;
}

const families = new Map<string, FamilyRow>();

function matches(row: FamilyRow, where: Record<string, unknown>): boolean {
  for (const [k, v] of Object.entries(where)) {
    if (k === 'id' && typeof v === 'object' && v && 'in' in v) {
      if (!(v as { in: string[] }).in.includes(row.id)) return false;
    } else if (v === null) {
      if ((row as unknown as Record<string, unknown>)[k] !== null) return false;
    } else if (typeof v !== 'object') {
      if ((row as unknown as Record<string, unknown>)[k] !== v) return false;
    }
  }
  return true;
}

vi.mock('../db/prisma', () => {
  const prismaMock: any = {
    $transaction: async (fn: (tx: typeof prismaMock) => unknown) => fn(prismaMock),
    refreshTokenFamily: {
      create: async ({ data }: { data: Partial<FamilyRow> }) => {
        const row: FamilyRow = {
          id: data.id!,
          userId: data.userId!,
          usedAt: null,
          revokedAt: null,
          revokedReason: null,
          expiresAt: data.expiresAt!,
          createdAt: new Date(),
          replacedById: null,
          parentId: data.parentId ?? null,
        };
        families.set(row.id, row);
        return row;
      },
      findUnique: async ({ where }: { where: { id: string } }) =>
        families.get(where.id) ?? null,
      update: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: Partial<FamilyRow>;
      }) => {
        const row = families.get(where.id);
        if (!row) throw new Error('not found');
        Object.assign(row, data);
        return row;
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: Record<string, unknown>;
        data: Partial<FamilyRow>;
      }) => {
        let count = 0;
        for (const row of families.values()) {
          if (matches(row, where)) {
            Object.assign(row, data);
            count++;
          }
        }
        return { count };
      },
      deleteMany: async () => ({ count: 0 }),
    },
    user: { findUnique: async () => null, update: async () => ({}) },
    setting: { findMany: async () => [] },
  };
  return { prisma: prismaMock };
});

import { issueTokens, refreshTokens, logout, revokeAllSessions } from './auth';

beforeEach(() => families.clear());

describe('refresh rotation survives a Redis outage', () => {
  it('issues tokens even though every Redis write fails', async () => {
    const { refreshToken, family } = await issueTokens('u1');
    expect(refreshToken).toBeTruthy();
    // The durable record is what matters.
    expect(families.get(family)?.userId).toBe('u1');
  });

  it('rotates normally: the old token is marked used, a new family is issued', async () => {
    const first = await issueTokens('u1');
    const second = await refreshTokens(first.refreshToken);
    expect(second.family).not.toBe(first.family);
    expect(families.get(first.family)?.usedAt).toBeInstanceOf(Date);
    expect(families.get(first.family)?.replacedById).toBe(second.family);
  });

  it('returns a retryable conflict for an immediate legitimate tab race, then revokes later reuse', async () => {
    const first = await issueTokens('u1');
    await refreshTokens(first.refreshToken);

    // A concurrent tab gets no token and does not revoke the winner's family.
    await expect(refreshTokens(first.refreshToken)).rejects.toMatchObject({
      code: 'AUTH_REFRESH_RACE',
      statusCode: 409,
    });

    // Reuse outside the short race window is treated as stolen-token replay.
    families.get(first.family)!.usedAt = new Date(Date.now() - 20_000);
    await expect(refreshTokens(first.refreshToken)).rejects.toMatchObject({
      code: 'AUTH_003',
    });
  });

  it('revokes the whole rotation chain when reuse is detected', async () => {
    const first = await issueTokens('u1');
    const second = await refreshTokens(first.refreshToken);
    const third = await refreshTokens(second.refreshToken);

    // Attacker replays the oldest stolen token outside the tab-race window.
    families.get(first.family)!.usedAt = new Date(Date.now() - 20_000);
    await expect(refreshTokens(first.refreshToken)).rejects.toThrow();

    // Every descendant is dead, so the thief's newer token is useless too.
    expect(families.get(second.family)?.revokedAt).toBeInstanceOf(Date);
    expect(families.get(third.family)?.revokedAt).toBeInstanceOf(Date);
    await expect(refreshTokens(third.refreshToken)).rejects.toThrow();
  });

  it('rejects a token whose family was revoked by logout', async () => {
    const { refreshToken, family } = await issueTokens('u1');
    await logout(family);
    expect(families.get(family)?.revokedReason).toBe('logout');
    await expect(refreshTokens(refreshToken)).rejects.toMatchObject({
      code: 'AUTH_003',
    });
  });

  it('rejects an expired family', async () => {
    const { refreshToken, family } = await issueTokens('u1');
    families.get(family)!.expiresAt = new Date(Date.now() - 1000);
    await expect(refreshTokens(refreshToken)).rejects.toThrow();
  });

  it('rejects a token for a family that does not exist', async () => {
    const { refreshToken, family } = await issueTokens('u1');
    families.delete(family); // e.g. purged / forged fam claim
    await expect(refreshTokens(refreshToken)).rejects.toMatchObject({
      code: 'AUTH_003',
    });
  });

  it('revokeAllSessions kills every active session for a user', async () => {
    const a = await issueTokens('u1');
    const b = await issueTokens('u1');
    const other = await issueTokens('u2');

    const count = await revokeAllSessions('u1', 'password_change');
    expect(count).toBe(2);

    await expect(refreshTokens(a.refreshToken)).rejects.toThrow();
    await expect(refreshTokens(b.refreshToken)).rejects.toThrow();
    // A different user is unaffected.
    await expect(refreshTokens(other.refreshToken)).resolves.toBeTruthy();
  });
});
