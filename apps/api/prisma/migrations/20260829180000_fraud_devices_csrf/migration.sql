-- Device + login history for fraud review; last-seen IP/country on User;
-- review notes on FraudSignal; deposit credit exactly-once unique index.

ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "lastLoginIp" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "lastLoginCountry" TEXT;

CREATE INDEX IF NOT EXISTS "User_fingerprintHash_idx" ON "User"("fingerprintHash");
CREATE INDEX IF NOT EXISTS "User_lastLoginIp_idx" ON "User"("lastLoginIp");

ALTER TABLE "FraudSignal" ADD COLUMN IF NOT EXISTS "notes" TEXT;

CREATE TABLE IF NOT EXISTS "UserDevice" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "fingerprintHash" TEXT NOT NULL,
    "userAgent" TEXT,
    "screen" TEXT,
    "timezone" TEXT,
    "language" TEXT,
    "firstIp" TEXT,
    "lastIp" TEXT,
    "ipCountry" TEXT,
    "loginCount" INTEGER NOT NULL DEFAULT 1,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserDevice_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "UserDevice_userId_fingerprintHash_key"
  ON "UserDevice"("userId", "fingerprintHash");
CREATE INDEX IF NOT EXISTS "UserDevice_fingerprintHash_idx" ON "UserDevice"("fingerprintHash");
CREATE INDEX IF NOT EXISTS "UserDevice_lastIp_idx" ON "UserDevice"("lastIp");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'UserDevice_userId_fkey'
  ) THEN
    ALTER TABLE "UserDevice"
      ADD CONSTRAINT "UserDevice_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "UserLoginEvent" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "ip" TEXT NOT NULL,
    "ipCountry" TEXT,
    "userAgent" TEXT,
    "fingerprintHash" TEXT,
    "timezone" TEXT,
    "language" TEXT,
    "screen" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserLoginEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "UserLoginEvent_userId_createdAt_idx"
  ON "UserLoginEvent"("userId", "createdAt" DESC);
CREATE INDEX IF NOT EXISTS "UserLoginEvent_ip_createdAt_idx"
  ON "UserLoginEvent"("ip", "createdAt" DESC);
CREATE INDEX IF NOT EXISTS "UserLoginEvent_fingerprintHash_idx"
  ON "UserLoginEvent"("fingerprintHash");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'UserLoginEvent_userId_fkey'
  ) THEN
    ALTER TABLE "UserLoginEvent"
      ADD CONSTRAINT "UserLoginEvent_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- One DEPOSIT ledger row per (deposit id, wallet). Skipped when historical
-- duplicates already exist so this migration cannot fail a live book.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "Transaction"
    WHERE "referenceType" = 'deposit' AND "type" = 'DEPOSIT' AND "referenceId" IS NOT NULL
    GROUP BY "referenceId", "walletType"
    HAVING COUNT(*) > 1
  ) THEN
    CREATE UNIQUE INDEX IF NOT EXISTS "Transaction_deposit_credit_uniq"
      ON "Transaction" ("referenceId", "walletType")
      WHERE "referenceType" = 'deposit' AND "type" = 'DEPOSIT';
  END IF;
END $$;
