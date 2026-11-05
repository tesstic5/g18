-- 20260901_referral_reward
--
-- Referral hardening:
--   1. one-shot payout marker (referralRewardedAt) + index for the cap count
--   2. canonicalise every referralCode to UPPERCASE
--   3. backfill the marker for players already paid under the old rule
--
-- Why (3) matters: the payout now fires on a referred player's FIRST APPROVED
-- DEPOSIT. Anyone who was referred and already received BONUS_REFERRAL at
-- signup must be marked as rewarded, or their next deposit would pay them a
-- second time.

-- ── 1. column + index ──────────────────────────────────────────────────────
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "referralRewardedAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "User_referredById_referralRewardedAt_idx"
  ON "User"("referredById", "referralRewardedAt");

-- ── 2. canonicalise codes to UPPERCASE ─────────────────────────────────────
--
-- Codes are generated as uppercase hex, but the column default is cuid()
-- (lowercase), so both shapes exist. Invite links are re-cased in transit by
-- some clients, and the lookup is exact-match — a lowercased link used to be
-- rejected outright.
--
-- Uppercasing is injective for both formats, so the ONLY way it can collide is
-- an existing pair that already differs by case alone (e.g. cuid 'a1b2' next to
-- hex 'A1B2'). Regenerate those first: keep the oldest account's code, give the
-- others a fresh uppercase hex code.
WITH ranked AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY upper("referralCode") ORDER BY "createdAt", id
    ) AS rn
  FROM "User"
)
UPDATE "User" u
SET "referralCode" = upper(substr(md5(random()::text || u.id), 1, 12))
FROM ranked r
WHERE r.id = u.id
  AND r.rn > 1;

-- no case-only duplicates can remain, so this is now safe against the unique index
UPDATE "User"
SET "referralCode" = upper("referralCode")
WHERE "referralCode" <> upper("referralCode");

-- ── 3. backfill: mark everyone already paid ────────────────────────────────
-- A BONUS_REFERRAL ledger row on the REFEREE's own account is the record that
-- the old signup-time payout already ran for them.
UPDATE "User" u
SET "referralRewardedAt" = NOW()
WHERE u."referredById" IS NOT NULL
  AND u."referralRewardedAt" IS NULL
  AND EXISTS (
    SELECT 1
    FROM "Transaction" t
    WHERE t."userId" = u.id
      AND t."type" = 'BONUS_REFERRAL'
  );
