ALTER TABLE "Deposit" ADD COLUMN "payfastCallbackHash" TEXT, ADD COLUMN "payfastTransactionId" TEXT;
CREATE UNIQUE INDEX "Deposit_payfastTransactionId_key" ON "Deposit"("payfastTransactionId");
