// apps/api/src/routes/gifts.ts — send coins by phone (real_balance only, atomic, v4)
import type { FastifyInstance } from 'fastify';
import Decimal from 'decimal.js';
import { giftSendSchema } from '@casino/shared/validators';
import { ERROR_CODES } from '@casino/shared/constants/errors';
import { ok, AppError } from '../lib/core';
import { authMiddleware } from '../middleware';
import { prisma } from '../db/prisma';
import { applyBalanceChange } from '../services/wallet';
import { normalizePhone } from '@casino/shared/utils/phone';

export async function giftRoutes(app: FastifyInstance) {
  app.post('/send', { preHandler: [authMiddleware] }, async (request) => {
    const body = giftSendSchema.parse(request.body);
    const senderId = request.user!.id;
    const recipientPhone = normalizePhone(body.recipientPhone) ?? body.recipientPhone;
    const recipient = await prisma.user.findUnique({
      where: { phone: recipientPhone },
    });
    if (!recipient)
      throw new AppError(ERROR_CODES.GEN_NOT_FOUND, 404, 'Recipient not found');
    if (recipient.id === senderId)
      throw new AppError(ERROR_CODES.GEN_VALIDATION_ERROR, 422, 'Cannot gift yourself');

    await prisma.$transaction(async (tx) => {
      const senderWallet = await tx.wallet.findUniqueOrThrow({
        where: { userId: senderId },
      });
      if (senderWallet.realBalance.lt(body.amount)) {
        throw new AppError(
          ERROR_CODES.WALLET_INSUFFICIENT_BALANCE,
          422,
          'Insufficient real balance'
        );
      }
      const gift = await tx.giftTransaction.create({
        data: {
          senderId,
          receiverId: recipient.id,
          amount: body.amount.toFixed(2),
          message: body.message?.slice(0, 200),
        },
      });
      // Both legs go through the locking+ledger helper so `Wallet.version` is
      // bumped on each side and both parties get a Transaction row (v4).
      const amount = new Decimal(body.amount);
      await applyBalanceChange(
        senderId,
        'REAL',
        amount.neg(),
        'GIFT_SENT',
        { referenceType: 'gift', referenceId: gift.id, description: 'Coins sent' },
        tx
      );
      await applyBalanceChange(
        recipient.id,
        'GIFTED',
        amount,
        'GIFT_RECEIVED',
        { referenceType: 'gift', referenceId: gift.id, description: 'Coins received' },
        tx
      );
    });

    return ok({ sent: true }, request.requestId!);
  });
}
