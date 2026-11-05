// Read-only production reconciliation. Exits non-zero on unexplained money/state
// differences; run before/after deployments and on a schedule.
import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../apps/api/src/generated/prisma/client';

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
});

async function main() {
  const walletDiffs = await prisma.$queryRaw<
    Array<{
      userId: string;
      walletType: string;
      walletBalance: string;
      ledgerBalance: string;
    }>
  >`
    WITH ledger AS (
      SELECT "userId", "walletType",
        SUM(CASE
          WHEN type IN ('BET','WITHDRAWAL','GIFT_SENT','ADMIN_DEBIT') THEN -amount
          ELSE amount
        END) AS balance
      FROM "Transaction"
      GROUP BY "userId", "walletType"
    ), wallet_rows AS (
      SELECT "userId", 'REAL'::"WalletType" AS "walletType", "realBalance" AS balance FROM "Wallet"
      UNION ALL SELECT "userId", 'BONUS'::"WalletType", "bonusBalance" FROM "Wallet"
      UNION ALL SELECT "userId", 'GIFTED'::"WalletType", "giftedBalance" FROM "Wallet"
      UNION ALL SELECT "userId", 'LOCKED'::"WalletType", "lockedBalance" FROM "Wallet"
    )
    SELECT w."userId", w."walletType"::text AS "walletType",
      w.balance::text AS "walletBalance", COALESCE(l.balance,0)::text AS "ledgerBalance"
    FROM wallet_rows w
    LEFT JOIN ledger l ON l."userId"=w."userId" AND l."walletType"=w."walletType"
    WHERE w.balance <> COALESCE(l.balance,0)
  `;

  const duplicateDepositCredits = await prisma.$queryRaw<
    Array<{ referenceId: string; count: bigint }>
  >`
    SELECT "referenceId", COUNT(*) AS count
    FROM "Transaction"
    WHERE "referenceType"='deposit' AND type='DEPOSIT'
    GROUP BY "referenceId", "walletType"
    HAVING COUNT(*) > 1
  `;

  const badWithdrawals = await prisma.$queryRaw<Array<{ id: string; status: string }>>`
    SELECT w.id, w.status::text AS status
    FROM "Withdrawal" w
    WHERE w.status='COMPLETED' AND EXISTS (
      SELECT 1 FROM "Transaction" t
      WHERE t."referenceType"='withdrawal' AND t."referenceId"=w.id AND t.type='REFUND'
    )
  `;

  const openShared = await prisma.sharedRoundBet.count({
    where: {
      status: { in: ['PLACED', 'SETTLING'] },
      createdAt: { lt: new Date(Date.now() - 10 * 60_000) },
    },
  });
  const staleSessions = await prisma.gameRound.count({
    where: {
      result: 'PENDING',
      createdAt: { lt: new Date(Date.now() - 24 * 60 * 60_000) },
    },
  });

  const report = {
    walletLedgerDifferences: walletDiffs.length,
    duplicateDepositCredits: duplicateDepositCredits.length,
    completedWithdrawalsWithRefunds: badWithdrawals.length,
    staleSharedRoundBets: openShared,
    staleGameSessions: staleSessions,
    samples: {
      walletDiffs: walletDiffs.slice(0, 20),
      duplicateDepositCredits: duplicateDepositCredits
        .slice(0, 20)
        .map((row) => ({ ...row, count: Number(row.count) })),
      badWithdrawals: badWithdrawals.slice(0, 20),
    },
  };
  console.log(JSON.stringify(report, null, 2));
  if (
    walletDiffs.length ||
    duplicateDepositCredits.length ||
    badWithdrawals.length ||
    openShared ||
    staleSessions
  ) {
    process.exitCode = 1;
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 2;
  })
  .finally(() => prisma.$disconnect());
