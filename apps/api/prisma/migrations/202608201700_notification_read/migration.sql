-- M-05: per-user read receipts for broadcast (userId IS NULL) notifications.
CREATE TABLE "NotificationRead" (
  "id"             TEXT      NOT NULL,
  "notificationId" TEXT      NOT NULL,
  "userId"         TEXT      NOT NULL,
  "readAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "NotificationRead_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "NotificationRead_notificationId_userId_key"
  ON "NotificationRead"("notificationId", "userId");
CREATE INDEX "NotificationRead_userId_idx" ON "NotificationRead"("userId");
