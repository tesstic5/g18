-- Referral agent (partner) accounts: admin-created agents with a read-only
-- referral dashboard and a daily commission on referred users' net spend.
ALTER TABLE "User" ADD COLUMN "isReferralAgent" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "User" ADD COLUMN "referralCommissionPaidUpTo" TIMESTAMP(3);
ALTER TYPE "TransactionType" ADD VALUE 'REFERRAL_COMMISSION';
ALTER TABLE "AdminUser" ADD COLUMN "hiddenFromAdmins" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "User" ADD COLUMN "referralSignupBonusEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "User" ADD COLUMN "referralSignupBonusAmount" DECIMAL(18,2) NOT NULL DEFAULT 0;
