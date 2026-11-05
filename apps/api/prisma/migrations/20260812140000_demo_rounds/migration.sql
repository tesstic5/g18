-- Demo-mode rounds (docs/20 §9): flagged so they can be excluded from stats,
-- leaderboards and admin reports. No money moves for demo rounds.
ALTER TABLE "GameRound" ADD COLUMN "demo" BOOLEAN NOT NULL DEFAULT false;
