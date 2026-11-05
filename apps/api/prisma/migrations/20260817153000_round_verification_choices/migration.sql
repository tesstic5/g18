-- Persist the exact validated player selection needed to reproduce the mapped
-- game result from the committed seed and config snapshot.
ALTER TABLE "GameRound" ADD COLUMN IF NOT EXISTS "choices" JSONB NOT NULL DEFAULT '{}';
