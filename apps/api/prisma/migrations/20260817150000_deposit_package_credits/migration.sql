-- Snapshot the real credits promised by a deposit package. Previously approval
-- credited Deposit.amount (the price paid) and ignored DepositPackage.credits,
-- so packages advertising extra real credits under-delivered.
ALTER TABLE "Deposit" ADD COLUMN IF NOT EXISTS "packageCredits" DECIMAL(18,2);

ALTER TABLE "Deposit" DROP CONSTRAINT IF EXISTS "deposit_package_credits_non_negative";
ALTER TABLE "Deposit" ADD CONSTRAINT "deposit_package_credits_non_negative"
  CHECK ("packageCredits" IS NULL OR "packageCredits" >= 0);
