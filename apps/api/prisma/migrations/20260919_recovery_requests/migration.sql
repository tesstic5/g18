-- Account recovery console.
--
-- Adds the agent-mediated recovery flow (no email, no SMS): a public request
-- carrying a ticket code, an evidence checklist verified by one admin and
-- approved by a second, a one-time recovery code, and a withdrawal freeze that
-- holds the money rails until it lapses.
--
-- Idempotent like the other hand-written migrations in this folder.

DO $$ BEGIN
  CREATE TYPE "RecoveryStatus" AS ENUM (
    'PENDING', 'IN_REVIEW', 'VERIFIED', 'APPROVED', 'REDEEMED', 'REJECTED', 'EXPIRED'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "RecoveryRequest" (
  "id"               TEXT NOT NULL,
  "userId"           TEXT,
  "phoneClaimed"     TEXT NOT NULL,
  "answers"          JSONB,
  "conversationId"   TEXT,
  "status"           "RecoveryStatus" NOT NULL DEFAULT 'PENDING',
  "ticketHash"       TEXT NOT NULL,
  "checks"           JSONB,
  "verifiedBy"       TEXT,
  "verifiedAt"       TIMESTAMP(3),
  "approvedBy"       TEXT,
  "approvedAt"       TIMESTAMP(3),
  "rejectedBy"       TEXT,
  "rejectedAt"       TIMESTAMP(3),
  "rejectReason"     TEXT,
  "codeHash"         TEXT,
  "codeEncrypted"    TEXT,
  "codeExpiresAt"    TIMESTAMP(3),
  "attempts"         INTEGER NOT NULL DEFAULT 0,
  "redeemedAt"       TIMESTAMP(3),
  "freezeUntil"      TIMESTAMP(3),
  "freezeHours"      INTEGER,
  "freezeReleasedAt" TIMESTAMP(3),
  "ip"               TEXT,
  "userAgent"        TEXT,
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"        TIMESTAMP(3) NOT NULL,
  CONSTRAINT "RecoveryRequest_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "RecoveryRequest_ticketHash_key"
  ON "RecoveryRequest"("ticketHash");
CREATE UNIQUE INDEX IF NOT EXISTS "RecoveryRequest_conversationId_key"
  ON "RecoveryRequest"("conversationId");
CREATE INDEX IF NOT EXISTS "RecoveryRequest_status_createdAt_idx"
  ON "RecoveryRequest"("status", "createdAt" DESC);
CREATE INDEX IF NOT EXISTS "RecoveryRequest_userId_idx"
  ON "RecoveryRequest"("userId");

DO $$ BEGIN
  ALTER TABLE "RecoveryRequest"
    ADD CONSTRAINT "RecoveryRequest_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "RecoveryRequest"
    ADD CONSTRAINT "RecoveryRequest_conversationId_fkey"
    FOREIGN KEY ("conversationId") REFERENCES "SupportConversation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Withdrawal freeze on the player row (read on every withdrawal + payout-account
-- change, so it lives next to the wallet rather than in a join).
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "withdrawalFrozenUntil" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "withdrawalFreezeReason" TEXT;

-- Backfill: nothing to backfill — no historical row is in a frozen state and
-- the new columns default to NULL (= not frozen).
