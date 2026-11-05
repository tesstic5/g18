// apps/api/src/services/wallet.ts — atomic wallet ops with optimistic locking.
// Canonical: docs/20 §3 (deduction priority) + docs/11 rules 1–6, 45, 51 + docs/19 §7.
import { Prisma, WalletType } from '../generated/prisma/client';
import Decimal from 'decimal.js';
import { AppError } from '../lib/core';
import { prisma } from '../db/prisma';
import { ERROR_CODES } from '@casino/shared/constants/errors';
import { getSetting } from './settings';
import { applyLedgerChange, lockWalletRow } from './walletLedger';
export type { LedgerKind as TransactionKind } from './walletLedger';

export interface WalletSnapshot {
  real: string;
  bonus: string;
  gifted: string;
  locked: string;
}

/** Typed column map — dynamic indexing of balance fields (avoids template-literal indexing). */
const BALANCE_FIELD: Record<
  WalletType,
  'realBalance' | 'bonusBalance' | 'giftedBalance' | 'lockedBalance'
> = {
  REAL: 'realBalance',
  BONUS: 'bonusBalance',
  GIFTED: 'giftedBalance',
  LOCKED: 'lockedBalance',
};

/**
 * Take a real row lock on the wallet for the remainder of the transaction.
 *
 * Delegates to `lockWalletRow` (the single SQL template). Callers that only
 * have `wallet.ts` imported keep working; the worker uses walletLedger
 * directly so it never drifts from this path.
 */
export async function lockWallet(
  userId: string,
  tx: Prisma.TransactionClient
): Promise<void> {
  await lockWalletRow(userId, tx);
}

export async function getWalletSnapshot(
  userId: string,
  tx: Prisma.TransactionClient = prisma
): Promise<WalletSnapshot> {
  const w = await tx.wallet.findUniqueOrThrow({ where: { userId } });
  return {
    real: w.realBalance.toString(),
    bonus: w.bonusBalance.toString(),
    gifted: w.giftedBalance.toString(),
    locked: w.lockedBalance.toString(),
  };
}

/**
 * Atomic balance change with optimistic locking (Wallet.version) + transaction row.
 *
 * THIS IS THE ONLY SANCTIONED WAY TO MOVE MONEY. Every balance mutation must go
 * through here so that (a) `Wallet.version` is bumped for optimistic locking and
 * (b) a `Transaction` ledger row is always written. Direct
 * `tx.wallet.update({ data: { realBalance: … } })` calls bypass both and were the
 * source of unlogged bonus/referral credits and lock-skipping financial writes.
 */
export async function applyBalanceChange(
  userId: string,
  walletType: WalletType,
  delta: Decimal, // positive = credit, negative = debit
  type: import('./walletLedger').LedgerKind,
  reference: { referenceType: string; referenceId: string; description?: string },
  tx: Prisma.TransactionClient
): Promise<WalletSnapshot> {
  return applyLedgerChange(tx, userId, walletType, delta, type, reference);
}

/**
 * deductBet — AUTO priority: BONUS → GIFTED → REAL (configurable), LOCKED never spent.
 * Must run inside the bet settlement transaction (SELECT FOR UPDATE semantics via
 * `findUniqueOrThrow` within the tx + version-guarded update). Docs/20 §3.
 */
export async function deductBet(
  userId: string,
  amount: Decimal,
  requestedWalletType: WalletType | 'AUTO',
  referenceId: string,
  tx: Prisma.TransactionClient
): Promise<{
  deductedFrom: Array<{ type: WalletType; amount: Decimal }>;
  snapshot: WalletSnapshot;
}> {
  // C-3, final backstop. deductBet applies `amount.neg()` as an increment, so a
  // NEGATIVE amount arriving here does not debit — it CREDITS, while writing an
  // ordinary-looking BET ledger row. Callers are validated (HTTP zod schema,
  // socket schema, WinGo placement guard), but this is the last gate before
  // money moves and it must never assume the caller got it right.
  if (!amount.isFinite() || amount.lte(0)) {
    throw new AppError(ERROR_CODES.GAME_INVALID_CHOICES, 400, 'Invalid bet amount');
  }

  // Lock the row ONCE for the whole (possibly multi-wallet) deduction.
  await lockWallet(userId, tx);
  const wallet = await tx.wallet.findUniqueOrThrow({ where: { userId } });

  if (requestedWalletType !== 'AUTO') {
    if (requestedWalletType === 'LOCKED')
      throw new AppError('WAL_003', 400, 'LOCKED balance cannot be bet');
    const field = BALANCE_FIELD[requestedWalletType];
    const balance = new Decimal(wallet[field].toString());
    if (balance.lt(amount))
      throw new AppError(
        ERROR_CODES.WALLET_INSUFFICIENT_BALANCE,
        422,
        'Insufficient balance'
      );
    const snapshot = await applyBalanceChange(
      userId,
      requestedWalletType,
      amount.neg(),
      'BET',
      { referenceType: 'game_round', referenceId },
      tx
    );
    return { deductedFrom: [{ type: requestedWalletType, amount }], snapshot };
  }

  // AUTO: compute the FULL split up front against the locked row, verify
  // sufficiency, and only then apply. Previously each wallet was deducted in
  // its own applyBalanceChange (up to 3 sequential version bumps, each with
  // its own conflict window) and insufficiency was only discovered after
  // partially draining BONUS/GIFTED.
  const priority: WalletType[] = (await getSpendPriority()) as WalletType[];
  let remaining = amount;
  const plan: Array<{ type: WalletType; amount: Decimal }> = [];

  for (const walletType of priority) {
    if (remaining.lte(0)) break;
    if (walletType === 'LOCKED') continue; // never spendable
    const available = new Decimal(wallet[BALANCE_FIELD[walletType]].toString());
    if (available.lte(0)) continue;
    const toDeduct = Decimal.min(available, remaining);
    plan.push({ type: walletType, amount: toDeduct });
    remaining = remaining.minus(toDeduct);
  }
  if (remaining.gt(0))
    throw new AppError(
      ERROR_CODES.WALLET_INSUFFICIENT_BALANCE,
      422,
      'Insufficient balance'
    );

  let snapshot = await getWalletSnapshot(userId, tx);
  for (const part of plan) {
    snapshot = await applyBalanceChange(
      userId,
      part.type,
      part.amount.neg(),
      'BET',
      { referenceType: 'game_round', referenceId },
      tx
    );
  }

  return { deductedFrom: plan, snapshot };
}

export async function creditWin(
  userId: string,
  walletType: WalletType,
  amount: Decimal,
  referenceId: string,
  tx: Prisma.TransactionClient
): Promise<WalletSnapshot> {
  return applyBalanceChange(
    userId,
    walletType,
    amount,
    'WIN',
    { referenceType: 'game_round', referenceId },
    tx
  );
}

/**
 * Credit a win back to the SAME wallets the bet was funded from, pro rata.
 *
 * Previously every win credited REAL regardless of source. Combined with the
 * BONUS → GIFTED → REAL spend priority that let a player stake promotional
 * balance and receive withdrawable cash — and, via coin gifts (real → gifted),
 * let two accounts convert bonus funds into withdrawable funds.
 *
 * The payout is split in the same proportion as the stake, with any rounding
 * remainder assigned to the largest contributing wallet so the credited total
 * always equals `payout` exactly.
 */
export async function creditWinProRata(
  userId: string,
  deductedFrom: Array<{ type: WalletType; amount: Decimal }>,
  payout: Decimal,
  referenceId: string,
  tx: Prisma.TransactionClient
): Promise<WalletSnapshot> {
  if (payout.lte(0)) return getWalletSnapshot(userId, tx);
  const staked = deductedFrom.reduce((s, d) => s.plus(d.amount), new Decimal(0));
  // No recorded split (shouldn't happen) — fall back to REAL.
  if (staked.lte(0) || deductedFrom.length === 0) {
    return creditWin(userId, 'REAL', payout, referenceId, tx);
  }
  // Single source: credit it all back there (no rounding to reconcile).
  if (deductedFrom.length === 1) {
    return creditWin(userId, deductedFrom[0]!.type, payout, referenceId, tx);
  }

  const shares = deductedFrom.map((d) => ({
    type: d.type,
    amount: payout.mul(d.amount).div(staked).toDecimalPlaces(2, Decimal.ROUND_DOWN),
  }));
  // Assign the rounding remainder to the biggest contributor.
  const distributed = shares.reduce((s, p) => s.plus(p.amount), new Decimal(0));
  const remainder = payout.minus(distributed);
  if (remainder.gt(0)) {
    let biggest = 0;
    for (let i = 1; i < deductedFrom.length; i++) {
      if (deductedFrom[i]!.amount.gt(deductedFrom[biggest]!.amount)) biggest = i;
    }
    shares[biggest]!.amount = shares[biggest]!.amount.plus(remainder);
  }

  let snapshot = await getWalletSnapshot(userId, tx);
  for (const share of shares) {
    if (share.amount.lte(0)) continue;
    snapshot = await creditWin(userId, share.type, share.amount, referenceId, tx);
  }
  return snapshot;
}

/** The wallet that funded most of the stake — recorded as GameRound.walletTypeUsed. */
export function primaryWalletType(
  deductedFrom: Array<{ type: WalletType; amount: Decimal }>
): WalletType {
  if (deductedFrom.length === 0) return 'REAL';
  return deductedFrom.reduce((a, b) => (b.amount.gt(a.amount) ? b : a)).type;
}

export async function refundBet(
  userId: string,
  walletType: WalletType,
  amount: Decimal,
  referenceId: string
): Promise<void> {
  await prisma.$transaction((tx) =>
    applyBalanceChange(
      userId,
      walletType,
      amount,
      'REFUND',
      { referenceType: 'game_round', referenceId },
      tx
    )
  );
}

const DEFAULT_SPEND_PRIORITY: WalletType[] = ['BONUS', 'GIFTED', 'REAL'];

/** M-11: also served to the client (GET /wallet/balance) so its optimistic
 *  deduction follows the SAME spend order the server applies. */
export async function getSpendPriority(): Promise<WalletType[]> {
  // Read through the Redis-cached settings service (30s TTL). This used to hit
  // Postgres with an uncached findUnique on EVERY bet. Fail-open to the default
  // priority — a settings read must never be able to block a bet.
  let configured: WalletType[] | undefined;
  try {
    configured = await getSetting<WalletType[]>('bet_spend_priority');
  } catch {
    return DEFAULT_SPEND_PRIORITY;
  }
  const valid = Array.isArray(configured)
    ? configured.filter((t) => t !== 'LOCKED' && t in BALANCE_FIELD)
    : [];
  return valid.length > 0 ? valid : DEFAULT_SPEND_PRIORITY;
}
