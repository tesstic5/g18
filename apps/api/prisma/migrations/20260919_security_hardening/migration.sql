-- Security hardening (SECURITY-INVENTORY.md follow-up, 2FA excluded).
--
-- 1. Dual control on withdrawals: a payout at/above the threshold needs two
--    different admins. Snapshotted per row so a later threshold change cannot
--    retroactively alter an approval already given.
-- 2. PasswordHistory: the last N hashes, so a new password may not repeat.
-- 3. SecurityAlert: monitored conditions persist, so "was anyone told?" is
--    answerable after the fact.
-- 4. AdminUser.lastActiveAt: sliding stamp for the panel idle timeout.
--
-- Additive and idempotent: no existing row is modified or dropped.

-- ── Withdrawal: dual control ───────────────────────────────────────────────
ALTER TABLE "Withdrawal" ADD COLUMN IF NOT EXISTS "dualControlRequired" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Withdrawal" ADD COLUMN IF NOT EXISTS "firstApprovedBy" TEXT;
ALTER TABLE "Withdrawal" ADD COLUMN IF NOT EXISTS "firstApprovedAt" TIMESTAMP(3);
ALTER TABLE "Withdrawal" ADD COLUMN IF NOT EXISTS "secondApprovedBy" TEXT;
ALTER TABLE "Withdrawal" ADD COLUMN IF NOT EXISTS "secondApprovedAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "Withdrawal_dualControlRequired_status_idx"
  ON "Withdrawal"("dualControlRequired", "status");

-- ── AdminUser: activity stamp ──────────────────────────────────────────────
ALTER TABLE "AdminUser" ADD COLUMN IF NOT EXISTS "lastActiveAt" TIMESTAMP(3);

-- ── PasswordHistory ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "PasswordHistory" (
  "id"           TEXT NOT NULL,
  "userId"       TEXT NOT NULL,
  "passwordHash" TEXT NOT NULL,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PasswordHistory_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "PasswordHistory_userId_createdAt_idx"
  ON "PasswordHistory"("userId", "createdAt" DESC);

DO $$ BEGIN
  ALTER TABLE "PasswordHistory"
    ADD CONSTRAINT "PasswordHistory_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── SecurityAlert ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "SecurityAlert" (
  "id"             TEXT NOT NULL,
  "kind"           TEXT NOT NULL,
  "severity"       TEXT NOT NULL DEFAULT 'medium',
  "message"        TEXT NOT NULL,
  "data"           JSONB,
  "dedupeKey"      TEXT,
  "status"         TEXT NOT NULL DEFAULT 'open',
  "acknowledgedBy" TEXT,
  "acknowledgedAt" TIMESTAMP(3),
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SecurityAlert_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "SecurityAlert_status_createdAt_idx"
  ON "SecurityAlert"("status", "createdAt" DESC);
CREATE INDEX IF NOT EXISTS "SecurityAlert_kind_createdAt_idx"
  ON "SecurityAlert"("kind", "createdAt" DESC);
CREATE INDEX IF NOT EXISTS "SecurityAlert_dedupeKey_createdAt_idx"
  ON "SecurityAlert"("dedupeKey", "createdAt" DESC);

-- Backfill: withdrawals already approved keep dualControlRequired = false —
-- they were released under the rules in force at the time. Nothing to rewrite.

-- ── WalletAdjustment: parked dual-control credits ──────────────────────────
CREATE TABLE IF NOT EXISTS "WalletAdjustment" (
  "id"                   TEXT NOT NULL,
  "userId"               TEXT NOT NULL,
  "walletType"           TEXT NOT NULL,
  "amount"               DECIMAL(18,2) NOT NULL,
  "reason"               TEXT,
  "status"               TEXT NOT NULL DEFAULT 'PENDING',
  "requestedBy"          TEXT NOT NULL,
  "requestedAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "approvedBy"           TEXT,
  "approvedAt"           TIMESTAMP(3),
  "rejectedBy"           TEXT,
  "rejectedAt"           TIMESTAMP(3),
  "rejectReason"         TEXT,
  "appliedTransactionId" TEXT,
  CONSTRAINT "WalletAdjustment_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "WalletAdjustment_status_requestedAt_idx"
  ON "WalletAdjustment"("status", "requestedAt" DESC);
CREATE INDEX IF NOT EXISTS "WalletAdjustment_userId_idx"
  ON "WalletAdjustment"("userId");

DO $$ BEGIN
  ALTER TABLE "WalletAdjustment"
    ADD CONSTRAINT "WalletAdjustment_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
