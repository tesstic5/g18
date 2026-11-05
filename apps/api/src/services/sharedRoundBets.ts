import { prisma } from '../db/prisma';
import { applyBalanceChange } from './wallet';
import { money } from '@casino/shared/utils/money';
import type { WalletType } from '../generated/prisma/client';

/**
 * Refund durable shared-round placements that a previous clock owner did not
 * settle. Called before a new leader starts a fresh clock. The PLACED claim,
 * per-wallet refunds, and REFUNDED state commit atomically.
 */
export async function refundOpenSharedBets(
  gameSlug: string,
  durationSec?: number,
  roundId?: string
): Promise<number> {
  const rows = await prisma.sharedRoundBet.findMany({
    where: {
      gameSlug,
      status: 'PLACED',
      ...(durationSec === undefined ? {} : { durationSec }),
      // v1.3.4: crash rounds now settle DETACHED from the round clock, so a
      // failure-recovery refund running late MUST NOT touch the NEXT round's
      // live placements (the old slug-wide sweep would have refunded bets
      // players just placed on the new round — money vanishing mid-bet).
      ...(roundId === undefined ? {} : { roundId }),
    },
    orderBy: { createdAt: 'asc' },
  });
  let refunded = 0;

  for (const bet of rows) {
    const didRefund = await prisma.$transaction(async (tx) => {
      const claim = await tx.sharedRoundBet.updateMany({
        where: { id: bet.id, status: 'PLACED' },
        data: { status: 'SETTLING' },
      });
      if (claim.count !== 1) return false;

      const split = bet.deductedFrom as unknown as Array<{
        type: WalletType;
        amount: string;
      }>;
      for (const part of split) {
        await applyBalanceChange(
          bet.userId,
          part.type,
          money(part.amount),
          'REFUND',
          {
            referenceType: 'shared_round_bet',
            referenceId: bet.id,
            description: `${bet.gameSlug} round interrupted — stake refunded`,
          },
          tx
        );
      }
      await tx.sharedRoundBet.update({
        where: { id: bet.id },
        data: { status: 'REFUNDED', payoutAmount: '0', settledAt: new Date() },
      });
      return true;
    });
    if (didRefund) refunded += 1;
  }
  return refunded;
}
