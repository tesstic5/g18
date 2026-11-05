-- D-078: polymorphic support-message sender.
-- senderId becomes nullable (admin FK); add userId (player FK) so players can
-- actually send messages (previously FK to AdminUser failed → P2003 500).

ALTER TABLE "SupportMessage" ALTER COLUMN "senderId" DROP NOT NULL;

ALTER TABLE "SupportMessage" ADD COLUMN "userId" text;

ALTER TABLE "SupportMessage"
  ADD CONSTRAINT "SupportMessage_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

