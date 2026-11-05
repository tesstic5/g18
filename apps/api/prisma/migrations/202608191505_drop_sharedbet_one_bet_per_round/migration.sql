-- WinGo allows multiple bets per shared round when the TARGET differs
-- (Red + 7 + Big in one period is standard play). The DB still carried a
-- legacy one-bet-per-round unique index whose schema entry was removed long
-- ago; every second target in the same period therefore failed P2002 and was
-- silently acked without a debit. Drop it — (userId, requestId) remains the
-- idempotency key; same-target duplicates are rejected in application code.
DROP INDEX IF EXISTS "SharedRoundBet_gameSlug_roundId_userId_key";
