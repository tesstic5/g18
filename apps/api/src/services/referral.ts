// apps/api/src/services/referral.ts — referral reward payout.
//
// THE RULE: a referral bonus is paid ONCE, when the referred player's FIRST
// DEPOSIT IS APPROVED. Not at signup.
//
// WHY IT MOVED
// ------------
// Paying both legs at signup cost ₨35 per referred account with no deposit, no
// wager and no KYC — so self-referral farming with a drawer of SIM cards was
// directly profitable. Requiring an APPROVED deposit changes the economics
// completely: an attacker cannot approve their own deposit (that takes an
// admin), so each fake referral now costs them real, non-refundable money.
//
// IDEMPOTENCY
// -----------
// `User.referralRewardedAt` is the once-only marker. It is claimed with a
// CONDITIONAL UPDATE (`updateMany ... WHERE referralRewardedAt IS NULL`), so
// two concurrent approvals of a player's deposits cannot both win. A claimant
// that updates 0 rows simply skips — no read-then-write race, no double pay.
//
// ORDER MATTERS
// -------------
// Every "should we pay at all?" check happens BEFORE the claim, so a bonus that
// is temporarily switched off or capped does not burn the marker — the player
// can still be rewarded later if the operator turns it back on or raises the
// cap.
import { Prisma } from '../generated/prisma/client';
import Decimal from 'decimal.js';
import { applyBalanceChange } from './wallet';
import { getSettings } from './settings';
import { DEMO_USER_PHONE } from '../middleware';

export interface ReferralPayoutResult {
  paid: boolean;
  reason?:
    | 'not-referred'
    | 'demo-user'
    | 'disabled'
    | 'zero-amount'
    | 'capped'
    | 'referrer-inactive'
    | 'already-rewarded';
  refereeBonus?: string;
  referrerBonus?: string;
}

/**
 * Called from INSIDE the deposit-approval transaction, after the deposit itself
 * has been credited. Never throws — a referral problem must never fail or roll
 * back a deposit the admin just approved.
 */
export async function maybeRewardReferral(
  tx: Prisma.TransactionClient,
  userId: string
): Promise<ReferralPayoutResult> {
  try {
    const user = await tx.user.findUnique({
      where: { id: userId },
      select: { id: true, phone: true, referredById: true },
    });
    if (!user?.referredById) return { paid: false, reason: 'not-referred' };

    // The shared demo account must never earn real bonus money.
    if (user.phone === DEMO_USER_PHONE()) return { paid: false, reason: 'demo-user' };

    // ── checks BEFORE the claim ────────────────────────────────────────────
    const s = await getSettings();
    if (s.referral_bonus_enabled !== true) return { paid: false, reason: 'disabled' };

    const refereeBonus = new Decimal(Number(s.referral_bonus_referee) || 0);
    const referrerBonus = new Decimal(Number(s.referral_bonus_referrer) || 0);
    if (!refereeBonus.gt(0) && !referrerBonus.gt(0))
      return { paid: false, reason: 'zero-amount' };

    const cap = Number(s.referral_max_rewards) || 0;
    if (cap > 0) {
      const alreadyPaid = await tx.user.count({
        where: {
          referredById: user.referredById,
          referralRewardedAt: { not: null },
        },
      });
      if (alreadyPaid >= cap) return { paid: false, reason: 'capped' };
    }

    // The house does not pay bonuses to accounts that are suspended, closed or
    // self-excluded — that would be a payout channel around the sanction.
    const referrer = await tx.user.findUnique({
      where: { id: user.referredById },
      select: { status: true, selfExcludedUntil: true },
    });
    if (!referrer) return { paid: false, reason: 'referrer-inactive' };
    if (referrer.status !== 'ACTIVE')
      return { paid: false, reason: 'referrer-inactive' };
    if (referrer.selfExcludedUntil && referrer.selfExcludedUntil > new Date())
      return { paid: false, reason: 'referrer-inactive' };

    // ── the atomic once-only claim ─────────────────────────────────────────
    const claimed = await tx.user.updateMany({
      where: {
        id: userId,
        referredById: { not: null },
        referralRewardedAt: null,
      },
      data: { referralRewardedAt: new Date() },
    });
    if (claimed.count !== 1) return { paid: false, reason: 'already-rewarded' };

    // ── pay both legs ──────────────────────────────────────────────────────
    // BONUS wallet, so it has to be wagered before it can be withdrawn.
    // Both go through applyBalanceChange for the version bump + ledger rows —
    // /referral/stats sums BONUS_REFERRAL rows, and the reconciliation check
    // compares the ledger against the wallet.
    if (refereeBonus.gt(0)) {
      await applyBalanceChange(
        userId,
        'BONUS',
        refereeBonus,
        'BONUS_REFERRAL',
        {
          referenceType: 'referral',
          referenceId: user.referredById,
          description: 'Referral bonus — first deposit',
        },
        tx
      );
    }
    if (referrerBonus.gt(0)) {
      await applyBalanceChange(
        user.referredById,
        'BONUS',
        referrerBonus,
        'BONUS_REFERRAL',
        {
          referenceType: 'referral',
          referenceId: userId,
          description: 'Referral reward',
        },
        tx
      );
    }

    console.warn(
      `[referral] paid ${userId} <- ${user.referredById} (referee ${refereeBonus.toString()}, referrer ${referrerBonus.toString()})`
    );
    return {
      paid: true,
      refereeBonus: refereeBonus.toString(),
      referrerBonus: referrerBonus.toString(),
    };
  } catch (e) {
    // A referral failure must never block or roll back a deposit approval.
    console.error('[referral] payout failed:', (e as Error).message);
    return { paid: false };
  }
}
