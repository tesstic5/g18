ALTER TABLE "Deposit"
  ADD COLUMN "payfastConfigSnapshot" TEXT,
  ADD COLUMN "payfastLaunchHash" TEXT,
  ADD COLUMN "payfastLaunchData" TEXT,
  ADD COLUMN "payfastLaunchExpiresAt" TIMESTAMP(3),
  ADD COLUMN "payfastLastCheckedAt" TIMESTAMP(3),
  ADD COLUMN "payfastLastError" TEXT,
  ADD COLUMN "payfastCustomerIp" TEXT;
CREATE UNIQUE INDEX "Deposit_payfastLaunchHash_key" ON "Deposit"("payfastLaunchHash");
