-- Durable placements for house-clock games. The stake debit and this row are
-- committed together, so a Redis overwrite/restart cannot erase money owed.
CREATE TYPE "SharedBetStatus" AS ENUM ('PLACED', 'SETTLING', 'SETTLED', 'REFUNDED');

CREATE TABLE "SharedRoundBet" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "gameSlug" TEXT NOT NULL,
  "roundId" TEXT NOT NULL,
  "durationSec" INTEGER,
  "requestId" TEXT NOT NULL,
  "amount" DECIMAL(18,2) NOT NULL,
  "walletType" "WalletType" NOT NULL,
  "deductedFrom" JSONB NOT NULL,
  "choice" JSONB,
  "joinMultiplier" DECIMAL(12,4) NOT NULL DEFAULT 1,
  "cashoutRequestedAt" TIMESTAMP(3),
  "cashoutMultiplier" DECIMAL(12,4),
  "status" "SharedBetStatus" NOT NULL DEFAULT 'PLACED',
  "result" "RoundResult",
  "payoutMultiplier" DECIMAL(12,4),
  "payoutAmount" DECIMAL(18,2),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "settledAt" TIMESTAMP(3),
  CONSTRAINT "SharedRoundBet_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SharedRoundBet_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "shared_bet_amount_positive" CHECK ("amount" > 0),
  CONSTRAINT "shared_bet_payout_non_negative" CHECK ("payoutAmount" IS NULL OR "payoutAmount" >= 0)
);

CREATE UNIQUE INDEX "SharedRoundBet_userId_requestId_key" ON "SharedRoundBet"("userId", "requestId");
CREATE UNIQUE INDEX "SharedRoundBet_gameSlug_roundId_userId_key" ON "SharedRoundBet"("gameSlug", "roundId", "userId");
CREATE INDEX "SharedRoundBet_gameSlug_roundId_status_idx" ON "SharedRoundBet"("gameSlug", "roundId", "status");
CREATE INDEX "SharedRoundBet_status_createdAt_idx" ON "SharedRoundBet"("status", "createdAt");
