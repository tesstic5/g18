// apps/api/src/services/wallet.test.ts — wallet logic with an in-memory prisma mock (docs/20 §20)
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Decimal } from '@casino/shared/utils/money';

const h = vi.hoisted(() => {
  type WalletRow = {
    id: string;
    userId: string;
    realBalance: string;
    bonusBalance: string;
    giftedBalance: string;
    lockedBalance: string;
    version: number;
  };
  const wallets = new Map<string, WalletRow>();
  const transactions: unknown[] = [];
  let nextVersion = 0;

  const prismaLike = {
    // lockWalletRow is fail-closed: the mock must expose $queryRaw or the
    // FOR UPDATE lock would throw WAL_005.
    $queryRaw: async () => [],
    wallet: {
      findUniqueOrThrow: async ({ where }: { where: { userId: string } }) => {
        const w = wallets.get(where.userId);
        if (!w) throw new Error('wallet not found');
        return {
          ...w,
          realBalance: new Decimal(w.realBalance),
          bonusBalance: new Decimal(w.bonusBalance),
          giftedBalance: new Decimal(w.giftedBalance),
          lockedBalance: new Decimal(w.lockedBalance),
        };
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: { userId: string; version: number };
        data: Record<string, unknown>;
      }) => {
        const w = wallets.get(where.userId);
        if (!w || w.version !== where.version) return { count: 0 };
        if (prismaLike.failNextUpdate) {
          prismaLike.failNextUpdate = false;
          return { count: 0 };
        }
        apply(w, data);
        return { count: 1 };
      },
      update: async ({
        where,
        data,
      }: {
        where: { userId: string };
        data: Record<string, unknown>;
      }) => {
        const w = wallets.get(where.userId)!;
        apply(w, data);
        w.version = ++nextVersion;
        return w;
      },
    },
    transaction: {
      create: async (d: unknown) => {
        transactions.push((d as { data: unknown }).data);
        return d;
      },
    },
    setting: { findUnique: async () => null },
    failNextUpdate: false,
  };

  function apply(w: WalletRow, data: Record<string, unknown>) {
    for (const [k, v] of Object.entries(data)) {
      if (v && typeof v === 'object' && 'increment' in (v as object)) {
        (w as Record<string, unknown>)[k] = new Decimal(
          w[k as keyof WalletRow] as unknown as string
        )
          .plus(String((v as { increment: string }).increment))
          .toFixed(2);
      }
    }
  }

  return { wallets, transactions, prismaLike };
});

vi.mock('../db/redis', () => ({
  redis: {
    set: async () => 'OK',
    get: async () => null,
    del: async () => 1,
    expire: async () => 1,
  },
}));
vi.mock('../db/prisma', () => ({
  prisma: {
    ...h.prismaLike,
    $transaction: async (cb: (tx: unknown) => Promise<unknown>) => cb(h.prismaLike),
  },
}));

import { deductBet, creditWin } from './wallet';
import { AppError } from '../lib/core';

const { wallets, transactions, prismaLike } = h;

function seedWallet(
  userId: string,
  balances: Partial<Record<'real' | 'bonus' | 'gifted' | 'locked', string>>
) {
  wallets.set(userId, {
    id: `w-${userId}`,
    userId,
    realBalance: balances.real ?? '100.00',
    bonusBalance: balances.bonus ?? '0.00',
    giftedBalance: balances.gifted ?? '0.00',
    lockedBalance: balances.locked ?? '0.00',
    version: 0,
  });
}
const tx = () => prismaLike as never;

beforeEach(() => {
  wallets.clear();
  transactions.length = 0;
});

describe('deductBet', () => {
  it('spends bonus → gifted → real in priority order (docs/20 §3)', async () => {
    seedWallet('u1', { bonus: '20.00', gifted: '30.00', real: '100.00' });
    const { deductedFrom } = await deductBet(
      'u1',
      new Decimal('60'),
      'AUTO',
      'r1',
      tx()
    );
    expect(deductedFrom.map((d) => [d.type, d.amount.toString()])).toEqual([
      ['BONUS', '20'],
      ['GIFTED', '30'],
      ['REAL', '10'],
    ]);
    expect(wallets.get('u1')!.bonusBalance).toBe('0.00');
    expect(wallets.get('u1')!.giftedBalance).toBe('0.00');
    expect(wallets.get('u1')!.realBalance).toBe('90.00');
  });

  it('rejects when total balance is insufficient (422)', async () => {
    seedWallet('u1', { bonus: '5.00', real: '10.00' });
    await expect(
      deductBet('u1', new Decimal('50'), 'AUTO', 'r1', tx())
    ).rejects.toMatchObject({ statusCode: 422 });
  });

  it('never spends LOCKED', async () => {
    seedWallet('u1', { locked: '100.00', real: '0.00' });
    await expect(
      deductBet('u1', new Decimal('1'), 'AUTO', 'r1', tx())
    ).rejects.toMatchObject({ statusCode: 422 });
  });

  it('honors an explicit wallet type', async () => {
    seedWallet('u1', { real: '100.00' });
    const { deductedFrom } = await deductBet(
      'u1',
      new Decimal('25'),
      'REAL',
      'r1',
      tx()
    );
    expect(deductedFrom.map((d) => [d.type, d.amount.toString()])).toEqual([
      ['REAL', '25'],
    ]);
  });
});

describe('creditWin', () => {
  it('adds the payout to the wallet', async () => {
    seedWallet('u1', { real: '50.00' });
    await creditWin('u1', 'REAL', new Decimal('49.50'), 'round-1', tx());
    expect(wallets.get('u1')!.realBalance).toBe('99.50');
  });

  it('writes a WIN transaction row', async () => {
    seedWallet('u1', { real: '50.00' });
    await creditWin('u1', 'REAL', new Decimal('10'), 'round-1', tx());
    expect(transactions.some((t) => (t as { type?: string }).type === 'WIN')).toBe(
      true
    );
  });
});

describe('concurrency guard', () => {
  it('throws WAL_004 on version conflict (optimistic lock)', async () => {
    seedWallet('u1', { real: '10.00' });
    (prismaLike as { failNextUpdate: boolean }).failNextUpdate = true; // simulate a concurrent writer bumping version
    await expect(
      creditWin('u1', 'REAL', new Decimal('1'), 'r', tx())
    ).rejects.toBeInstanceOf(AppError);
  });
});
