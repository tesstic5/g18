-- AlterEnum
ALTER TYPE "RoundResult" ADD VALUE 'PENDING';

-- DropForeignKey
ALTER TABLE "SupportMessage" DROP CONSTRAINT "SupportMessage_senderId_fkey";

-- AddForeignKey
ALTER TABLE "SupportMessage" ADD CONSTRAINT "SupportMessage_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "AdminUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;
