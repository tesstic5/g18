import Decimal from 'decimal.js';
import { prisma } from '../db/prisma';
import { decryptJson } from '../lib/crypto-utils';
import { AppError } from '../lib/core';
import { payfastSettingsSchema, type PayfastSettings } from './payfastSettings';
import { inquirePayfast } from './payfast';
import { applyBalanceChange, lockWallet } from './wallet';
import { maybeRewardReferral } from './referral';
import { notifyUser } from './notify';

export async function configForPayment(
  snapshot: string | null
): Promise<PayfastSettings> {
  if (snapshot) return payfastSettingsSchema.parse(decryptJson(snapshot));
  // Legacy UAT orders from the first implementation have no encrypted snapshot.
  // Do not guess which merchant/credentials were used; require manual provider reconciliation.
  throw new AppError(
    'PAYFAST_LEGACY',
    409,
    'Legacy payment requires provider-assisted reconciliation'
  );
}
export async function reconcilePayfast(id: string) {
  const d = await prisma.deposit.findUniqueOrThrow({ where: { id } });
  if (d.paymentMethod !== 'PAYFAST')
    throw new AppError('PAYFAST_INVALID', 400, 'Not a PayFast order');
  if (d.status !== 'PENDING') return { id, status: d.status };
  try {
    const c = await configForPayment(d.payfastConfigSnapshot);
    // Once created, an order uses its encrypted credential/endpoint snapshot,
    // independent of later settings edits or disabling new checkout.
    const payment = await inquirePayfast(
      c,
      d.id,
      d.amount.toFixed(2),
      d.payfastCustomerIp || ''
    );
    const credited = await prisma.$transaction(async (tx) => {
      // One row lock protects callback, polling, retries and admin reconciliation.
      await tx.$queryRaw`SELECT id FROM "Deposit" WHERE id = ${id} FOR UPDATE`;
      const current = await tx.deposit.findUniqueOrThrow({ where: { id } });
      if (current.status !== 'PENDING') return false;
      if (payment.outcome === 'failed') {
        await tx.deposit.update({
          where: { id },
          data: {
            status: 'REJECTED',
            rejectionReason: 'Provider inquiry confirmed final failure',
            payfastLastCheckedAt: new Date(),
            payfastLastError: null,
            payfastLaunchData: null,
            payfastLaunchHash: null,
          },
        });
        return false;
      }
      await lockWallet(current.userId, tx);
      await tx.deposit.update({
        where: { id },
        data: {
          status: 'COMPLETED',
          gatewayId: payment.transactionId,
          payfastTransactionId: payment.transactionId,
          reviewedAt: new Date(),
          payfastLastCheckedAt: new Date(),
          payfastLastError: null,
          payfastLaunchData: null,
          payfastLaunchHash: null,
        },
      });
      await applyBalanceChange(
        current.userId,
        'REAL',
        new Decimal((current.packageCredits ?? current.amount).toString()),
        'DEPOSIT',
        { referenceType: 'deposit', referenceId: id },
        tx
      );
      const bonus = new Decimal(current.packageBonus?.toString() ?? '0');
      if (bonus.gt(0))
        await applyBalanceChange(
          current.userId,
          'BONUS',
          bonus,
          'DEPOSIT',
          { referenceType: 'deposit', referenceId: id },
          tx
        );
      await maybeRewardReferral(tx, current.userId);
      return true;
    });
    if (credited) {
      const io = (globalThis as { __io?: import('socket.io').Server }).__io;
      try {
        io?.to(`user:${d.userId}`).emit('deposit:status', { id, status: 'COMPLETED' });
      } catch {
        /* events must not change committed settlement */
      }
      void notifyUser(
        d.userId,
        'Deposit completed',
        `Your PayFast deposit of PKR ${d.amount.toFixed(2)} has been credited.`,
        'deposit',
        '/wallet'
      ).catch(() => {});
    }
    const final = await prisma.deposit.findUniqueOrThrow({
      where: { id },
      select: { status: true },
    });
    return { id, status: final.status };
  } catch {
    // Do not persist provider bodies, URLs, tokens or detailed network errors.
    await prisma.deposit.updateMany({
      where: { id, status: 'PENDING' },
      data: {
        payfastLastCheckedAt: new Date(),
        payfastLastError:
          'Not independently confirmed; awaiting provider verification or reconciliation.',
      },
    });
    return { id, status: 'PENDING' };
  }
}

/** Distributed lease prevents multiple API replicas hammering the inquiry API. */
export async function sweepPayfast() {
  const { redis } = await import('../db/redis');
  const { randomUUID } = await import('node:crypto');
  const lease = randomUUID();
  if ((await redis.set('payfast:reconcile:lease', lease, 'EX', 120, 'NX')) !== 'OK')
    return;
  try {
    await prisma.deposit.updateMany({
      where: {
        status: 'PENDING',
        paymentMethod: 'PAYFAST',
        payfastLaunchData: { not: null },
        payfastLaunchExpiresAt: { lt: new Date() },
      },
      data: {
        status: 'REJECTED',
        rejectionReason: 'Checkout link expired before launch',
        payfastLaunchData: null,
        payfastLaunchHash: null,
      },
    });
    const rows = await prisma.deposit.findMany({
      where: {
        paymentMethod: 'PAYFAST',
        status: 'PENDING',
        payfastConfigSnapshot: { not: null },
        OR: [
          { payfastLastCheckedAt: null },
          { payfastLastCheckedAt: { lt: new Date(Date.now() - 5 * 60_000) } },
        ],
      },
      orderBy: { payfastLastCheckedAt: { sort: 'asc', nulls: 'first' } },
      take: 4,
    });
    for (const row of rows) await reconcilePayfast(row.id);
  } finally {
    await redis.eval(
      "if redis.call('get',KEYS[1]) == ARGV[1] then return redis.call('del',KEYS[1]) else return 0 end",
      1,
      'payfast:reconcile:lease',
      lease
    );
  }
}
