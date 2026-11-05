-- Deposit packages, a signup-bonus transaction type, and the settings that
-- drive the welcome bonus + the daily-bonus minimum balance.

-- 1) Welcome bonus needs its own ledger type so it is distinguishable from
--    referral/check-in credits in transaction history and reconciliation.
ALTER TYPE "TransactionType" ADD VALUE IF NOT EXISTS 'BONUS_SIGNUP';

-- 2) Purchasable top-up packages, shown on the deposit page (which is where
--    signup already lands).
CREATE TABLE IF NOT EXISTS "DepositPackage" (
  "id"          TEXT NOT NULL,
  "name"        TEXT NOT NULL,
  "price"       DECIMAL(18,2) NOT NULL,
  "credits"     DECIMAL(18,2) NOT NULL,
  "bonus"       DECIMAL(18,2) NOT NULL DEFAULT 0,
  "badge"       TEXT,
  "description" TEXT,
  "sortOrder"   INTEGER NOT NULL DEFAULT 0,
  "isActive"    BOOLEAN NOT NULL DEFAULT true,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL,
  CONSTRAINT "DepositPackage_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "DepositPackage_isActive_sortOrder_idx"
  ON "DepositPackage" ("isActive", "sortOrder");

-- Money can never be negative, and a package that credits nothing is a bug.
ALTER TABLE "DepositPackage" DROP CONSTRAINT IF EXISTS "DepositPackage_amounts_nonneg";
ALTER TABLE "DepositPackage" ADD CONSTRAINT "DepositPackage_amounts_nonneg"
  CHECK ("price" >= 0 AND "credits" >= 0 AND "bonus" >= 0);

-- 3) Remember which package a deposit was for, and the bonus promised at the
--    time of purchase, so editing a package later cannot change what an
--    already-paid deposit is worth.
ALTER TABLE "Deposit" ADD COLUMN IF NOT EXISTS "packageId" TEXT;
ALTER TABLE "Deposit" ADD COLUMN IF NOT EXISTS "packageBonus" DECIMAL(18,2);

ALTER TABLE "Deposit" DROP CONSTRAINT IF EXISTS "Deposit_packageId_fkey";
ALTER TABLE "Deposit" ADD CONSTRAINT "Deposit_packageId_fkey"
  FOREIGN KEY ("packageId") REFERENCES "DepositPackage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 4) Settings.
--    daily_checkin_min_balance: the daily ladder used to be claimable by an
--    account that had never deposited, which is a faucet for throwaway
--    accounts. Default 100.
--    signup_bonus_*: there was no welcome bonus at all before; off by default
--    so nothing starts paying out until an admin turns it on.
INSERT INTO "Setting" ("key", "value", "updatedAt")
VALUES
  ('daily_checkin_min_balance', '100'::jsonb,  CURRENT_TIMESTAMP),
  ('signup_bonus_enabled',      'false'::jsonb, CURRENT_TIMESTAMP),
  ('signup_bonus_amount',       '0'::jsonb,     CURRENT_TIMESTAMP)
ON CONFLICT ("key") DO NOTHING;
