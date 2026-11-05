-- Enforce one active session per player/game at the database boundary. Concurrent
-- starts can no longer both pass an application-level pre-check and debit twice.
CREATE UNIQUE INDEX IF NOT EXISTS "GameRound_one_pending_session_per_user_game"
  ON "GameRound" ("userId", "gameSlug")
  WHERE "result" = 'PENDING';
