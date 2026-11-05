-- A stake returned exactly (table-game tie push) is neither a win nor a loss.
-- Storing it as WIN inflated win-rate reports and advanced win-streak bonuses.
ALTER TYPE "RoundResult" ADD VALUE IF NOT EXISTS 'PUSH';
