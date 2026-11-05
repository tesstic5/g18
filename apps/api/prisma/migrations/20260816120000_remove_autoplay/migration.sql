-- Remove auto-play support.
--
-- Auto-play (and auto-cashout) were removed by product decision: every bet and
-- every cashout must be an explicit, deliberate player action. The column only
-- ever tagged rounds placed by the client-side auto-play loop, which no longer
-- exists, so the data has no remaining consumer.

ALTER TABLE "GameRound" DROP COLUMN IF EXISTS "autoPlaySessionId";
