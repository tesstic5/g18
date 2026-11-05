-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'CLOSED', 'SELF_EXCLUDED');

-- CreateEnum
CREATE TYPE "TransactionType" AS ENUM ('BET', 'WIN', 'REFUND', 'DEPOSIT', 'WITHDRAWAL', 'BONUS_CHECKIN', 'BONUS_REFERRAL', 'BONUS_WINSTREAK', 'BONUS_RAKEBACK', 'GIFT_SENT', 'GIFT_RECEIVED', 'ADMIN_CREDIT', 'ADMIN_DEBIT');

-- CreateEnum
CREATE TYPE "WalletType" AS ENUM ('REAL', 'BONUS', 'GIFTED', 'LOCKED');

-- CreateEnum
CREATE TYPE "ForceOverride" AS ENUM ('NONE', 'FORCE_WIN', 'FORCE_LOSE');

-- CreateEnum
CREATE TYPE "RoundResult" AS ENUM ('WIN', 'LOSE', 'CASHOUT', 'BUST');

-- CreateEnum
CREATE TYPE "SeedStatus" AS ENUM ('ACTIVE', 'REVEALED');

-- CreateEnum
CREATE TYPE "DepositStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'COMPLETED');

-- CreateEnum
CREATE TYPE "WithdrawalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "LeaderboardPeriod" AS ENUM ('DAILY', 'WEEKLY', 'ALL_TIME');

-- CreateEnum
CREATE TYPE "ConvoStatus" AS ENUM ('OPEN', 'ASSIGNED', 'CLOSED');

-- CreateEnum
CREATE TYPE "SenderType" AS ENUM ('USER', 'ADMIN');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "displayName" TEXT,
    "avatarUrl" TEXT,
    "fingerprintHash" TEXT,
    "language" TEXT NOT NULL DEFAULT 'en',
    "theme" TEXT NOT NULL DEFAULT 'dark',
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "selfExcludedUntil" TIMESTAMP(3),
    "dailyLossLimit" DECIMAL(18,2),
    "dailyDepositLimit" DECIMAL(18,2),
    "sessionReminderMin" INTEGER,
    "referralCode" TEXT NOT NULL,
    "referredById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastLoginAt" TIMESTAMP(3),
    "lastActivityAt" TIMESTAMP(3),
    "favorites" JSONB NOT NULL DEFAULT '[]',
    "onboardingStep" INTEGER NOT NULL DEFAULT 0,
    "onboardingDone" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Wallet" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "realBalance" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "bonusBalance" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "giftedBalance" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "lockedBalance" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Wallet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Transaction" (
    "id" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "TransactionType" NOT NULL,
    "walletType" "WalletType" NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "balanceBefore" DECIMAL(18,2) NOT NULL,
    "balanceAfter" DECIMAL(18,2) NOT NULL,
    "referenceType" TEXT,
    "referenceId" TEXT,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Transaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GameConfig" (
    "slug" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "description" TEXT,
    "thumbnailUrl" TEXT,
    "category" TEXT[],
    "tags" TEXT[],
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isFeatured" BOOLEAN NOT NULL DEFAULT false,
    "demoEnabled" BOOLEAN NOT NULL DEFAULT false,
    "baseRtp" DECIMAL(5,2) NOT NULL,
    "winRate" DECIMAL(5,2) NOT NULL,
    "houseEdge" DECIMAL(5,2) NOT NULL,
    "maxWinMultiplier" DECIMAL(10,2) NOT NULL DEFAULT 25,
    "minBet" DECIMAL(18,2) NOT NULL DEFAULT 1,
    "defaultPayout" DECIMAL(10,4) NOT NULL DEFAULT 2,
    "forceOverride" "ForceOverride" NOT NULL DEFAULT 'NONE',
    "forceRoundsLeft" INTEGER NOT NULL DEFAULT 0,
    "forceMaxPayout" DECIMAL(18,2),
    "configJson" JSONB NOT NULL DEFAULT '{}',
    "totalWagered" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "totalPaidOut" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "totalRounds" INTEGER NOT NULL DEFAULT 0,
    "effectiveRtp" DECIMAL(5,2),
    "animationSpeed" DECIMAL(3,2) NOT NULL DEFAULT 1.0,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "GameConfig_pkey" PRIMARY KEY ("slug")
);

-- CreateTable
CREATE TABLE "GameRound" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "gameSlug" TEXT NOT NULL,
    "betAmount" DECIMAL(18,2) NOT NULL,
    "walletTypeUsed" "WalletType" NOT NULL,
    "requestId" TEXT,
    "seedPairId" TEXT NOT NULL,
    "clientSeed" TEXT NOT NULL,
    "nonce" INTEGER NOT NULL,
    "rawOutcome" DECIMAL(18,16) NOT NULL,
    "mappedOutcome" JSONB NOT NULL,
    "result" "RoundResult" NOT NULL,
    "payoutMultiplier" DECIMAL(10,4) NOT NULL,
    "payoutAmount" DECIMAL(18,2) NOT NULL,
    "configSnapshot" JSONB NOT NULL,
    "configSnapshotHash" TEXT NOT NULL,
    "forceUsed" "ForceOverride" NOT NULL DEFAULT 'NONE',
    "autoPlaySessionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GameRound_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SeedPair" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "serverSeed" TEXT NOT NULL,
    "serverSeedHash" TEXT NOT NULL,
    "clientSeed" TEXT NOT NULL,
    "nonce" INTEGER NOT NULL DEFAULT 0,
    "status" "SeedStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revealedAt" TIMESTAMP(3),

    CONSTRAINT "SeedPair_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Deposit" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "status" "DepositStatus" NOT NULL DEFAULT 'PENDING',
    "paymentMethod" TEXT NOT NULL,
    "accountLabel" TEXT,
    "proofObjectKey" TEXT,
    "proofImageUrl" TEXT,
    "referenceNumber" TEXT,
    "gatewayId" TEXT,
    "reviewedBy" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "rejectionReason" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Deposit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Withdrawal" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "fee" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "netAmount" DECIMAL(18,2) NOT NULL,
    "status" "WithdrawalStatus" NOT NULL DEFAULT 'PENDING',
    "payoutAccountId" TEXT NOT NULL,
    "gatewayId" TEXT,
    "requiresReview" BOOLEAN NOT NULL DEFAULT false,
    "reviewedBy" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "rejectionReason" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Withdrawal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayoutAccount" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "accountDetails" TEXT NOT NULL,
    "isLocked" BOOLEAN NOT NULL DEFAULT false,
    "lockedBy" TEXT,
    "lockedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PayoutAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ManualPaymentAccount" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "accountDetails" JSONB NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ManualPaymentAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DailyCheckin" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "streakCount" INTEGER NOT NULL,
    "bonusAmount" DECIMAL(18,2) NOT NULL,
    "claimedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DailyCheckin_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GiftTransaction" (
    "id" TEXT NOT NULL,
    "senderId" TEXT NOT NULL,
    "receiverId" TEXT NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "message" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GiftTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WinStreak" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "currentStreak" INTEGER NOT NULL DEFAULT 0,
    "lastWinAt" TIMESTAMP(3),
    "milestone5Paid" BOOLEAN NOT NULL DEFAULT false,
    "milestone10Paid" BOOLEAN NOT NULL DEFAULT false,
    "milestone25Paid" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WinStreak_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RakebackRecord" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "weekStart" DATE NOT NULL,
    "weekEnd" DATE NOT NULL,
    "totalLost" DECIMAL(18,2) NOT NULL,
    "rakeback" DECIMAL(18,2) NOT NULL,
    "paidAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RakebackRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeaderboardEntry" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "period" "LeaderboardPeriod" NOT NULL,
    "periodKey" TEXT NOT NULL,
    "totalWagered" DECIMAL(18,2) NOT NULL,
    "totalWon" DECIMAL(18,2) NOT NULL,
    "netProfit" DECIMAL(18,2) NOT NULL,
    "biggestWin" DECIMAL(18,2) NOT NULL,
    "roundsPlayed" INTEGER NOT NULL,
    "rank" INTEGER,

    CONSTRAINT "LeaderboardEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdminUser" (
    "id" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "displayName" TEXT,
    "isSuperAdmin" BOOLEAN NOT NULL DEFAULT false,
    "createdBy" TEXT,
    "permFinancial" BOOLEAN NOT NULL DEFAULT false,
    "permUsers" BOOLEAN NOT NULL DEFAULT false,
    "permReporting" BOOLEAN NOT NULL DEFAULT false,
    "permChat" BOOLEAN NOT NULL DEFAULT false,
    "permGames" BOOLEAN NOT NULL DEFAULT false,
    "permSettings" BOOLEAN NOT NULL DEFAULT false,
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminUser_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdminAuditLog" (
    "id" TEXT NOT NULL,
    "adminId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "targetType" TEXT,
    "targetId" TEXT,
    "beforeState" JSONB,
    "afterState" JSONB,
    "ipAddress" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminAuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FraudSignal" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "signal" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'new',
    "reviewedBy" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FraudSignal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupportConversation" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "ConvoStatus" NOT NULL DEFAULT 'OPEN',
    "assignedTo" TEXT,
    "subject" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupportConversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupportMessage" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "senderType" "SenderType" NOT NULL,
    "senderId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "attachmentUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupportMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "actionUrl" TEXT,
    "isRead" BOOLEAN NOT NULL DEFAULT false,
    "isRetracted" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Setting" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Setting_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "LegalPage" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "language" TEXT NOT NULL DEFAULT 'en',
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "updatedBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LegalPage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_phone_key" ON "User"("phone");

-- CreateIndex
CREATE UNIQUE INDEX "User_referralCode_key" ON "User"("referralCode");

-- CreateIndex
CREATE INDEX "User_phone_idx" ON "User"("phone");

-- CreateIndex
CREATE INDEX "User_referralCode_idx" ON "User"("referralCode");

-- CreateIndex
CREATE INDEX "User_status_createdAt_idx" ON "User"("status", "createdAt");

-- CreateIndex
CREATE INDEX "User_referredById_idx" ON "User"("referredById");

-- CreateIndex
CREATE UNIQUE INDEX "Wallet_userId_key" ON "Wallet"("userId");

-- CreateIndex
CREATE INDEX "Transaction_walletId_createdAt_idx" ON "Transaction"("walletId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "Transaction_userId_type_createdAt_idx" ON "Transaction"("userId", "type", "createdAt");

-- CreateIndex
CREATE INDEX "Transaction_userId_createdAt_idx" ON "Transaction"("userId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "Transaction_referenceType_referenceId_idx" ON "Transaction"("referenceType", "referenceId");

-- CreateIndex
CREATE INDEX "GameRound_userId_createdAt_idx" ON "GameRound"("userId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "GameRound_gameSlug_createdAt_idx" ON "GameRound"("gameSlug", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "GameRound_createdAt_idx" ON "GameRound"("createdAt" DESC);

-- CreateIndex
CREATE INDEX "GameRound_userId_gameSlug_createdAt_idx" ON "GameRound"("userId", "gameSlug", "createdAt");

-- CreateIndex
CREATE INDEX "GameRound_result_gameSlug_idx" ON "GameRound"("result", "gameSlug");

-- CreateIndex
CREATE UNIQUE INDEX "GameRound_userId_requestId_key" ON "GameRound"("userId", "requestId");

-- CreateIndex
CREATE INDEX "SeedPair_userId_status_idx" ON "SeedPair"("userId", "status");

-- CreateIndex
CREATE INDEX "Deposit_userId_createdAt_idx" ON "Deposit"("userId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "Deposit_status_createdAt_idx" ON "Deposit"("status", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "Withdrawal_userId_createdAt_idx" ON "Withdrawal"("userId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "Withdrawal_status_createdAt_idx" ON "Withdrawal"("status", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "PayoutAccount_userId_idx" ON "PayoutAccount"("userId");

-- CreateIndex
CREATE INDEX "DailyCheckin_userId_idx" ON "DailyCheckin"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "DailyCheckin_userId_date_key" ON "DailyCheckin"("userId", "date");

-- CreateIndex
CREATE INDEX "GiftTransaction_senderId_idx" ON "GiftTransaction"("senderId");

-- CreateIndex
CREATE INDEX "GiftTransaction_receiverId_idx" ON "GiftTransaction"("receiverId");

-- CreateIndex
CREATE UNIQUE INDEX "WinStreak_userId_key" ON "WinStreak"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "RakebackRecord_userId_weekStart_key" ON "RakebackRecord"("userId", "weekStart");

-- CreateIndex
CREATE INDEX "LeaderboardEntry_period_periodKey_totalWagered_idx" ON "LeaderboardEntry"("period", "periodKey", "totalWagered" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "LeaderboardEntry_userId_period_periodKey_key" ON "LeaderboardEntry"("userId", "period", "periodKey");

-- CreateIndex
CREATE UNIQUE INDEX "AdminUser_username_key" ON "AdminUser"("username");

-- CreateIndex
CREATE INDEX "AdminAuditLog_adminId_createdAt_idx" ON "AdminAuditLog"("adminId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "AdminAuditLog_targetType_targetId_idx" ON "AdminAuditLog"("targetType", "targetId");

-- CreateIndex
CREATE INDEX "AdminAuditLog_createdAt_idx" ON "AdminAuditLog"("createdAt" DESC);

-- CreateIndex
CREATE INDEX "FraudSignal_status_severity_idx" ON "FraudSignal"("status", "severity");

-- CreateIndex
CREATE INDEX "FraudSignal_userId_idx" ON "FraudSignal"("userId");

-- CreateIndex
CREATE INDEX "SupportConversation_status_createdAt_idx" ON "SupportConversation"("status", "createdAt");

-- CreateIndex
CREATE INDEX "SupportConversation_userId_idx" ON "SupportConversation"("userId");

-- CreateIndex
CREATE INDEX "SupportMessage_conversationId_createdAt_idx" ON "SupportMessage"("conversationId", "createdAt");

-- CreateIndex
CREATE INDEX "Notification_userId_isRead_createdAt_idx" ON "Notification"("userId", "isRead", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "LegalPage_slug_language_key" ON "LegalPage"("slug", "language");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_referredById_fkey" FOREIGN KEY ("referredById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Wallet" ADD CONSTRAINT "Wallet_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "Wallet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GameRound" ADD CONSTRAINT "GameRound_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GameRound" ADD CONSTRAINT "GameRound_gameSlug_fkey" FOREIGN KEY ("gameSlug") REFERENCES "GameConfig"("slug") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GameRound" ADD CONSTRAINT "GameRound_seedPairId_fkey" FOREIGN KEY ("seedPairId") REFERENCES "SeedPair"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SeedPair" ADD CONSTRAINT "SeedPair_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deposit" ADD CONSTRAINT "Deposit_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Withdrawal" ADD CONSTRAINT "Withdrawal_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Withdrawal" ADD CONSTRAINT "Withdrawal_payoutAccountId_fkey" FOREIGN KEY ("payoutAccountId") REFERENCES "PayoutAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayoutAccount" ADD CONSTRAINT "PayoutAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DailyCheckin" ADD CONSTRAINT "DailyCheckin_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GiftTransaction" ADD CONSTRAINT "GiftTransaction_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GiftTransaction" ADD CONSTRAINT "GiftTransaction_receiverId_fkey" FOREIGN KEY ("receiverId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WinStreak" ADD CONSTRAINT "WinStreak_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeaderboardEntry" ADD CONSTRAINT "LeaderboardEntry_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdminAuditLog" ADD CONSTRAINT "AdminAuditLog_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "AdminUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FraudSignal" ADD CONSTRAINT "FraudSignal_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportConversation" ADD CONSTRAINT "SupportConversation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportMessage" ADD CONSTRAINT "SupportMessage_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "SupportConversation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportMessage" ADD CONSTRAINT "SupportMessage_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "AdminUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
