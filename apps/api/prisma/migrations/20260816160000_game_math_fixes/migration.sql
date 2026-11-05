-- Game math corrections.
--
-- These update ALREADY-SEEDED databases. The seed script only inserts rows that
-- do not exist yet, so a live deployment would otherwise keep the old numbers
-- forever. Each statement is idempotent and only touches the specific keys.
--
-- 1) BACCARAT tie payout 8.00 -> 10.13, maxWinMultiplier 8 -> 12
--    Measured tie probability with the shipped deal logic (200k hands): 9.473%.
--    8.00x on a 9.473% event = 75.8% RTP. 0.96 / 0.09473 = 10.13x -> ~96% RTP.
--    maxWinMultiplier of 8 would have CLAMPED the corrected payout back to 8x,
--    so it is raised to 12 (baseRtp also corrected 98.9 -> 96 to match reality).
UPDATE "GameConfig"
SET "configJson" = jsonb_set("configJson"::jsonb, '{payouts,tie}', '10.13'::jsonb, true),
    "maxWinMultiplier" = 12,
    "baseRtp" = 96
WHERE "slug" = 'baccarat';

-- 2) DRAGON TIGER tie payout 8.00 -> 12.46, maxWinMultiplier 10 -> 15
--    Measured tie probability (200k deals): 7.706%.
--    8.00x on a 7.706% event = 61.6% RTP -- the worst bet on the platform.
--    0.96 / 0.07706 = 12.46x -> ~96% RTP.
UPDATE "GameConfig"
SET "configJson" = jsonb_set("configJson"::jsonb, '{payouts,tie}', '12.46'::jsonb, true),
    "maxWinMultiplier" = 15
WHERE "slug" = 'dragon-tiger';

-- 3) PLINKO: two separate problems.
--
--    (a) The bucket was chosen UNIFORMLY over the rows+1 slots. Real Plinko is
--        a Galton board: the ball makes one left/right decision per peg row, so
--        the landing slot is BINOMIAL, P(i) = C(rows,i) / 2^rows. On a 16-row
--        board the uniform picker hit an edge jackpot 5.88% of the time instead
--        of 0.0015% -- about 3,855x too often -- and the on-screen ball had to
--        teleport to a slot the pegs would never lead to. Fixed in
--        PlinkoGame.ts (dropBall now walks the board for real and ships the
--        left/right path so the animation can follow the actual route).
--
--    (b) All three "risk levels" shipped BYTE-IDENTICAL payout tables, so Low,
--        Medium and High risk were the same game with different labels.
--
--    These tables are re-calibrated against the true binomial distribution:
--    sum(P(slot) * multiplier) ~= 0.96 for every risk level and board size,
--    with real risk separation (low tops out ~2x, high ~136x on 16 rows).
UPDATE "GameConfig"
SET "configJson" = jsonb_set("configJson"::jsonb, '{risk_levels}', '{
    "low": {
      "8": [1.95, 1.34, 1.02, 0.904, 0.887, 0.904, 1.02, 1.34, 1.95],
      "12": [2.02, 1.56, 1.25, 1.06, 0.959, 0.924, 0.919, 0.924, 0.959, 1.06, 1.25, 1.56, 2.02],
      "16": [2.05, 1.68, 1.4, 1.21, 1.07, 0.992, 0.95, 0.935, 0.933, 0.935, 0.95, 0.992, 1.07, 1.21, 1.4, 1.68, 2.05]
    },
    "medium": {
      "8": [10.29, 3.62, 1.15, 0.579, 0.541, 0.579, 1.15, 3.62, 10.29],
      "12": [13.47, 6.86, 3.23, 1.51, 0.866, 0.719, 0.709, 0.719, 0.866, 1.51, 3.23, 6.86, 13.47],
      "16": [15.17, 9.22, 5.35, 2.99, 1.7, 1.08, 0.855, 0.802, 0.799, 0.802, 0.855, 1.08, 1.7, 2.99, 5.35, 9.22, 15.17]
    },
    "high": {
      "8": [36.63, 6.64, 0.711, 0.149, 0.14, 0.149, 0.711, 6.64, 36.63],
      "12": [86.47, 29.18, 7.89, 1.68, 0.449, 0.333, 0.331, 0.333, 0.449, 1.68, 7.89, 29.18, 86.47],
      "16": [136.39, 61.5, 24.7, 8.62, 2.65, 0.9, 0.556, 0.523, 0.523, 0.523, 0.556, 0.9, 2.65, 8.62, 24.7, 61.5, 136.39]
    }
  }'::jsonb, true),
    "baseRtp" = 96
WHERE "slug" = 'plinko';

-- 4) PLINKO maxWinMultiplier was 25, which would CLAMP the new high-risk edge
--    payouts (up to 136.39x) straight back down to 25x.
UPDATE "GameConfig" SET "maxWinMultiplier" = 200 WHERE "slug" = 'plinko' AND "maxWinMultiplier" < 200;

-- 5) LUCKY NUMBER: a single-number bet paid HALF what it should have.
--    The zone size was computed as `Math.max(1, betMax - betMin) + 1`, so a
--    1-number pick (betMin === betMax) was treated as a 2-number zone and the
--    payout was halved -- 48x instead of ~94x, a measured RTP of 49% while
--    every other bet on the platform pays ~96%. Fixed in LuckyNumberGame.ts.
--    maxWinMultiplier of 90 would have clamped the corrected payout.
UPDATE "GameConfig" SET "maxWinMultiplier" = 120 WHERE "slug" = 'lucky-number' AND "maxWinMultiplier" < 120;
