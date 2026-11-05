-- Session-game payout ladders (mines / tower / stairs) were hand-written tables
-- that did not match the real odds. Deleting them makes the engine derive the
-- mathematically fair ladder from the game's own parameters, which it already
-- knows how to do.
--
-- MINES  (payout_ladders)
--   The engine's minesLadder() pays 0.96 x C(25,k) / C(25-m,k) -- exactly fair
--   at every cash-out point. The seeded tables instead:
--     * OVERPAID badly at depth. With 10 mines, cashing out after 10 safe tiles
--       paid 3750x where fair is 1044.96x -- 344% RTP. A player who always dug
--       deep beat the house. With 3 mines the last rung was 239% RTP.
--     * were TRUNCATED. 10 mines had 10 rungs for 15 safe tiles, 5 mines had 17
--       for 20, 3 mines had 19 for 22. Past the end the multiplier clamped flat,
--       so those digs carried full bust risk for zero extra reward.
--
-- TOWER  (payout_ladder_easy / _medium / _hard / _expert)
--   P(survive a floor) = (cols - traps) / cols, so fair after f floors is
--   0.96 / p^f. The seeded ladders FLATLINED at 100x:
--     medium floor 10: paid 100x,   fair    983.04x  ->   9.8% RTP
--     hard   floor 10: paid 100x,   fair 1006632x    ->   0.01% RTP
--     expert floor 10: paid 100x,   fair 9375000x    ->   0.00% RTP
--   Every floor past the flatline was pure loss for the player, and the ladder
--   was displayed on screen, so the game actively advertised those payouts.
--
-- STAIRS (payout_ladder)
--   Same flatline: 100x from step 7 where fair is 122.88 / 245.76 / 491.52 /
--   983.04.
--
-- maxWinMultiplier is raised in step with the ladders, otherwise the corrected
-- top rungs would simply be clamped back down to the old broken value.

UPDATE "GameConfig"
SET "configJson" = ("configJson"::jsonb - 'payout_ladders'),
    "maxWinMultiplier" = 10000
WHERE "slug" = 'mines';

UPDATE "GameConfig"
SET "configJson" = ("configJson"::jsonb
      - 'payout_ladder_easy' - 'payout_ladder_medium'
      - 'payout_ladder_hard' - 'payout_ladder_expert'),
    "maxWinMultiplier" = 10000000
WHERE "slug" = 'tower';

UPDATE "GameConfig"
SET "configJson" = ("configJson"::jsonb - 'payout_ladder'),
    "maxWinMultiplier" = 2000
WHERE "slug" = 'stairs';
