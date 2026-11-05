// Canonical lock + version + ledger write. Callers MUST pass a transaction
// client — this module has no Prisma singleton so the worker can import it
// without spinning up a second API database pool.
import type { Prisma, WalletType } from '../generated/prisma/client';
import Decimal from 'decimal.js';
import { AppError } from '../lib/core';

export type LedgerKind =
  | 'BET'
  | 'WIN'
  | 'REFUND'
  | 'DEPOSIT'
  | 'WITHDRAWAL'
  | 'BONUS_CHECKIN'
  | 'BONUS_SIGNUP'
  | 'BONUS_REFERRAL'
  | 'REFERRAL_COMMISSION'
  | 'BONUS_WINSTREAK'
  | 'BONUS_RAKEBACK'
  | 'GIFT_SENT'
  | 'GIFT_RECEIVED'
  | 'ADMIN_CREDIT'
  | 'ADMIN_DEBIT';

const BALANCE_FIELD: Record<
  WalletType,
  'realBalance' | 'bonusBalance' | 'giftedBalance' | 'lockedBalance'
> = {
  REAL: 'realBalance',
  BONUS: 'bonusBalance',
  GIFTED: 'giftedBalance',
  LOCKED: 'lockedBalance',
};

export async function lockWalletRow(
  userId: string,
  tx: Prisma.TransactionClient
): Promise<void> {
  // Fail closed: a money-path row lock must never be silently skipped. The old
  // guard returned quietly when the tx client had no $queryRaw (test doubles),
  // which meant a misconfigured caller would run unlocked without any signal.
  if (typeof (tx as { $queryRaw?: unknown }).$queryRaw !== 'function') {
    throw new AppError(
      'WAL_005',
      500,
      'Wallet row lock unavailable: transaction client does not support raw queries'
    );
  }
  await tx.$queryRaw`SELECT id FROM "Wallet" WHERE "userId" = ${userId} FOR UPDATE`;
}

/**
 * THE only sanctioned money mutation. Row lock, version bump, ledger row.
 */
export async function applyLedgerChange(
  tx: Prisma.TransactionClient,
  userId: string,
  walletType: WalletType,
  delta: Decimal,
  type: LedgerKind,
  reference: { referenceType: string; referenceId: string; description?: string }
): Promise<{
  real: string;
  bonus: string;
  gifted: string;
  locked: string;
}> {
  const field = BALANCE_FIELD[walletType];
  await lockWalletRow(userId, tx);
  const wallet = await tx.wallet.findUniqueOrThrow({ where: { userId } });
  const expectedVersion = wallet.version;
  const updated = await tx.wallet.updateMany({
    where: { userId, version: expectedVersion },
    data: {
      [field]: { increment: delta.toFixed(2) },
      version: { increment: 1 },
    },
  });
  if (updated.count !== 1)
    throw new AppError('WAL_004', 409, 'Concurrent balance change, retry');

  const after = await tx.wallet.findUniqueOrThrow({ where: { userId } });
  await tx.transaction.create({
    data: {
      walletId: wallet.id,
      userId,
      type,
      walletType,
      amount: delta.abs().toFixed(2),
      balanceBefore: new Decimal(wallet[field].toString()).toFixed(2),
      balanceAfter: new Decimal(after[field].toString()).toFixed(2),
      referenceType: reference.referenceType,
      referenceId: reference.referenceId,
      description: reference.description,
    },
  });
  return {
    real: after.realBalance.toString(),
    bonus: after.bonusBalance.toString(),
    gifted: after.giftedBalance.toString(),
    locked: after.lockedBalance.toString(),
  };
}
