-- H-17: 24h cooling-off for daily-limit raises/removals (responsible play).
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "pendingLossLimit" DECIMAL(18,2);
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "pendingLossLimitAt" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "pendingDepositLimit" DECIMAL(18,2);
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "pendingDepositLimitAt" TIMESTAMP(3);
