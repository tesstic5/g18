-- Wheel of Fortune and Ring of Fortune become games the player actually BETS on.
--
-- Both used to ignore the player's input entirely: you tapped PLAY, the wheel
-- span, and it paid whatever slice it stopped on. There was no decision to make,
-- so neither was really a game -- just a slot pull with a spinning graphic.
--
-- Now the rim is divided into colour/prize TIERS and the player backs one. You
-- win only if the wheel stops on a slice of the tier you backed.
--
-- FAIRNESS: a tier covering fraction p of the rim pays 0.96 / p, so every tier
-- returns the same ~96% RTP. Backing the 1-in-24 jackpot is high variance, not
-- bad value -- exactly like a single number vs red on roulette.
--
--   WHEEL (24 slices)            RING (36 slices)
--   yellow 12/24 = 50.0%  1.92x  bronze 18/36 = 50.00%   1.92x
--   blue    8/24 = 33.3%  2.88x  silver  9/36 = 25.00%   3.84x
--   green   3/24 = 12.5%  7.68x  gold    6/36 = 16.67%   5.76x
--   purple  1/24 =  4.2% 23.04x  ruby    2/36 =  5.56%  17.28x
--                                jackpot 1/36 =  2.78%  34.56x
--
-- maxWinMultiplier is raised alongside, otherwise the top tier's payout would be
-- clamped back down and that bet would silently pay less than advertised.

UPDATE "GameConfig"
SET "configJson" = jsonb_set(
      ("configJson"::jsonb - 'segments'), '{tiers}',
      '[
        {"id": "yellow", "label": "2x",      "color": "#f5c842", "slices": 12},
        {"id": "blue",   "label": "3x",      "color": "#4d9fff", "slices": 8},
        {"id": "green",  "label": "5x",      "color": "#00d97e", "slices": 3},
        {"id": "purple", "label": "JACKPOT", "color": "#9b59ff", "slices": 1}
      ]'::jsonb, true),
    "maxWinMultiplier" = 50,
    "baseRtp" = 96
WHERE "slug" = 'wheel';

UPDATE "GameConfig"
SET "configJson" = jsonb_set(
      (("configJson"::jsonb - 'segments') - 'special_segment'), '{tiers}',
      '[
        {"id": "bronze",  "label": "BRONZE",  "color": "#c98b4b", "slices": 18},
        {"id": "silver",  "label": "SILVER",  "color": "#c7d0dd", "slices": 9},
        {"id": "gold",    "label": "GOLD",    "color": "#f5c842", "slices": 6},
        {"id": "ruby",    "label": "RUBY",    "color": "#ff3b5c", "slices": 2},
        {"id": "jackpot", "label": "JACKPOT", "color": "#9b59ff", "slices": 1}
      ]'::jsonb, true),
    "maxWinMultiplier" = 60,
    "baseRtp" = 96
WHERE "slug" = 'ring-of-fortune';
