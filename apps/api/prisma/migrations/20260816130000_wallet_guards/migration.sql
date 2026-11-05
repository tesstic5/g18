-- Money safety net at the DATABASE level.
--
-- Application code already refuses to overdraw a wallet, but that is one layer.
-- A bug in any current or future code path (a missed guard, a bad admin tool, a
-- hand-run SQL fix at 3am) could silently create money that does not exist.
-- These constraints make that impossible: the transaction aborts instead.
--
-- This is deliberately a hard failure. Losing a request is recoverable; a
-- corrupted ledger discovered weeks later is not.

-- 1. No wallet balance may ever be negative.
ALTER TABLE "Wallet"
  ADD CONSTRAINT "wallet_real_non_negative"   CHECK ("realBalance"   >= 0),
  ADD CONSTRAINT "wallet_bonus_non_negative"  CHECK ("bonusBalance"  >= 0),
  ADD CONSTRAINT "wallet_gifted_non_negative" CHECK ("giftedBalance" >= 0),
  ADD CONSTRAINT "wallet_locked_non_negative" CHECK ("lockedBalance" >= 0);

-- 2. Monetary movements must be sane.
--    Bet/withdrawal amounts are stored as positive magnitudes (direction is
--    conveyed by `type`), so a negative amount always indicates a bug.
ALTER TABLE "Transaction"
  ADD CONSTRAINT "transaction_amount_non_negative" CHECK ("amount" >= 0);

ALTER TABLE "Deposit"
  ADD CONSTRAINT "deposit_amount_positive" CHECK ("amount" > 0);

-- 3. Withdrawal arithmetic must hold: net = amount - fee, and neither the fee
--    nor the net may be negative. This is what makes the C2 fee fix
--    (debit gross, pay net, retain fee) impossible to silently regress.
ALTER TABLE "Withdrawal"
  ADD CONSTRAINT "withdrawal_amount_positive"  CHECK ("amount" > 0),
  ADD CONSTRAINT "withdrawal_fee_non_negative" CHECK ("fee" >= 0),
  ADD CONSTRAINT "withdrawal_net_non_negative" CHECK ("netAmount" >= 0),
  ADD CONSTRAINT "withdrawal_net_matches_fee"  CHECK ("netAmount" = "amount" - "fee");

-- 4. A game round can never pay out a negative amount, and the stake must be
--    positive (free rounds are modelled as bonuses, not zero-stake rounds).
ALTER TABLE "GameRound"
  ADD CONSTRAINT "gameround_bet_positive"        CHECK ("betAmount" > 0),
  ADD CONSTRAINT "gameround_payout_non_negative" CHECK ("payoutAmount" >= 0);
