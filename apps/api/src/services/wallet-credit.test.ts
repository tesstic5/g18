// Regression tests for pro-rata win crediting.
//
// Wins used to ALWAYS credit REAL, regardless of which wallet funded the bet.
// With spend priority BONUS → GIFTED → REAL that converted promotional balance
// into withdrawable cash (and, via coin gifts, let two accounts launder it).
import { describe, expect, it, beforeEach } from 'vitest';
import Decimal from 'decimal.js';
import { creditWinProRata, primaryWalletType } from './wallet';
import type { WalletType } from '../generated/prisma/client';

interface Row {
  realBalance: Decimal;
  bonusBalance: Decimal;
  giftedBalance: Decimal;
  lockedBalance: Decimal;
  version: number;
  id: string;
}

let wallet: Row;
const credits: Array<{ type: WalletType; amount: string }> = [];

/** Minimal in-memory stand-in for Prisma's TransactionClient. */
function tx() {
  return {
    // lockWalletRow is fail-closed: expose $queryRaw so the FOR UPDATE lock runs.
    $queryRaw: async () => [],
    wallet: {
      findUniqueOrThrow: async () => wallet,
      updateMany: async ({
        data,
      }: {
        data: Record<string, { increment?: string }>;
      }) => {
        for (const [k, v] of Object.entries(data)) {
          if (k === 'version') {
            wallet.version += 1;
            continue;
          }
          const delta = new Decimal(v.increment ?? '0');
          (wallet as unknown as Record<string, Decimal>)[k] = (
            wallet as unknown as Record<string, Decimal>
          )[k]!.plus(delta);
        }
        return { count: 1 };
      },
    },
    transaction: {
      create: async ({
        data,
      }: {
        data: { walletType: WalletType; amount: string };
      }) => {
        credits.push({ type: data.walletType, amount: data.amount });
        return data;
      },
    },
  } as never;
}

beforeEach(() => {
  wallet = {
    id: 'w1',
    version: 0,
    realBalance: new Decimal(0),
    bonusBalance: new Decimal(0),
    giftedBalance: new Decimal(0),
    lockedBalance: new Decimal(0),
  };
  credits.length = 0;
});

describe('creditWinProRata', () => {
  it('returns a bonus-funded win to BONUS, not REAL', async () => {
    await creditWinProRata(
      'u1',
      [{ type: 'BONUS', amount: new Decimal('100') }],
      new Decimal('250'),
      'r1',
      tx()
    );
    expect(wallet.bonusBalance.toFixed(2)).toBe('250.00');
    expect(wallet.realBalance.toFixed(2)).toBe('0.00');
  });

  it('splits a mixed-funding win in the same proportion as the stake', async () => {
    // 40 bonus + 60 real = 100 staked; a 200 payout → 80 bonus / 120 real
    await creditWinProRata(
      'u1',
      [
        { type: 'BONUS', amount: new Decimal('40') },
        { type: 'REAL', amount: new Decimal('60') },
      ],
      new Decimal('200'),
      'r1',
      tx()
    );
    expect(wallet.bonusBalance.toFixed(2)).toBe('80.00');
    expect(wallet.realBalance.toFixed(2)).toBe('120.00');
  });

  it('credits exactly the payout even when the split does not divide evenly', async () => {
    await creditWinProRata(
      'u1',
      [
        { type: 'BONUS', amount: new Decimal('1') },
        { type: 'REAL', amount: new Decimal('2') },
      ],
      new Decimal('10'),
      'r1',
      tx()
    );
    const total = wallet.bonusBalance
      .plus(wallet.realBalance)
      .plus(wallet.giftedBalance);
    expect(total.toFixed(2)).toBe('10.00'); // no cent created or destroyed
  });

  it('does nothing for a zero payout', async () => {
    await creditWinProRata(
      'u1',
      [{ type: 'BONUS', amount: new Decimal('10') }],
      new Decimal('0'),
      'r1',
      tx()
    );
    expect(credits).toHaveLength(0);
  });
});

describe('primaryWalletType', () => {
  it('reports the wallet that funded the largest share', () => {
    expect(
      primaryWalletType([
        { type: 'BONUS', amount: new Decimal('30') },
        { type: 'REAL', amount: new Decimal('70') },
      ])
    ).toBe('REAL');
  });

  it('defaults to REAL when nothing was recorded', () => {
    expect(primaryWalletType([])).toBe('REAL');
  });
});
