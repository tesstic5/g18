-- Durable refresh-token families.
--
-- Rotation/reuse detection previously lived ONLY in Redis. During a Redis
-- outage the check could not run, and the code chose availability (accept the
-- token) — which left a stolen refresh token replayable for its full 7-day
-- lifetime. Postgres is now the source of truth, so the security check always
-- runs; Redis becomes a pure read-through cache for speed.

CREATE TABLE "RefreshTokenFamily" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "usedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "revokedReason" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "replacedById" TEXT,
    "parentId" TEXT,

    CONSTRAINT "RefreshTokenFamily_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "RefreshTokenFamily_replacedById_key" ON "RefreshTokenFamily"("replacedById");
CREATE UNIQUE INDEX "RefreshTokenFamily_parentId_key" ON "RefreshTokenFamily"("parentId");
CREATE INDEX "RefreshTokenFamily_userId_createdAt_idx" ON "RefreshTokenFamily"("userId", "createdAt" DESC);
-- Supports the periodic purge of expired rows.
CREATE INDEX "RefreshTokenFamily_expiresAt_idx" ON "RefreshTokenFamily"("expiresAt");

ALTER TABLE "RefreshTokenFamily"
  ADD CONSTRAINT "RefreshTokenFamily_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
