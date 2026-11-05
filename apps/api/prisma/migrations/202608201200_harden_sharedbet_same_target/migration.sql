-- H-08: race-safe same-target guard for shared-round bets.
-- Application code rejects a second bet on the SAME target in the SAME round,
-- but two concurrent requests could both pass the check and both insert. A
-- partial unique index on the choice payload (md5 of the JSON) closes the
-- race at the DB level. PLACED-only: a settled/cancelled row must not block
-- reuse of its (requestId-free) coordinates, and refunds keep their row.
DROP INDEX IF EXISTS "SharedRoundBet_gameSlug_roundId_userId_key";

CREATE UNIQUE INDEX IF NOT EXISTS "SharedRoundBet_same_target_guard"
  ON "SharedRoundBet" ("gameSlug", "roundId", "userId", md5(COALESCE("choice"::text, 'null')))
  WHERE "status" = 'PLACED';
