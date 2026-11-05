-- D-061: deposit confirmation details (payment-account snapshot + sender account)
ALTER TABLE "Deposit" ADD COLUMN "accountDetails" JSONB;
ALTER TABLE "Deposit" ADD COLUMN "senderAccount" TEXT;
