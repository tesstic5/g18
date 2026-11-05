-- Support desk: category, money-row link, per-side last-read for unread badges.

ALTER TABLE "SupportConversation" ADD COLUMN IF NOT EXISTS "category" TEXT;
ALTER TABLE "SupportConversation" ADD COLUMN IF NOT EXISTS "referenceType" TEXT;
ALTER TABLE "SupportConversation" ADD COLUMN IF NOT EXISTS "referenceId" TEXT;
ALTER TABLE "SupportConversation" ADD COLUMN IF NOT EXISTS "playerLastReadAt" TIMESTAMP(3);
ALTER TABLE "SupportConversation" ADD COLUMN IF NOT EXISTS "adminLastReadAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "SupportConversation_assignedTo_status_idx"
  ON "SupportConversation"("assignedTo", "status");
CREATE INDEX IF NOT EXISTS "SupportConversation_referenceType_referenceId_idx"
  ON "SupportConversation"("referenceType", "referenceId");

-- Backfill category from the original subject picker labels.
UPDATE "SupportConversation" SET "category" = 'deposit' WHERE "category" IS NULL AND "subject" ILIKE '%deposit%';
UPDATE "SupportConversation" SET "category" = 'withdrawal' WHERE "category" IS NULL AND "subject" ILIKE '%withdraw%';
UPDATE "SupportConversation" SET "category" = 'game' WHERE "category" IS NULL AND "subject" ILIKE '%game%';
UPDATE "SupportConversation" SET "category" = 'account' WHERE "category" IS NULL AND ("subject" ILIKE '%account%' OR "subject" ILIKE '%login%');
UPDATE "SupportConversation" SET "category" = 'bonus' WHERE "category" IS NULL AND ("subject" ILIKE '%bonus%' OR "subject" ILIKE '%promo%');
UPDATE "SupportConversation" SET "category" = 'other' WHERE "category" IS NULL;
