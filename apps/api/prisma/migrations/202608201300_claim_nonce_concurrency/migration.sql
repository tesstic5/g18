-- H-01: the nonce claim is now an UPDATE ... WHERE id AND nonce guard executed
-- inside the settlement transaction (see OutcomeEngine). This migration adds a
-- defensive CHECK so a negative nonce can never exist.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'SeedPair_nonce_nonnegative'
  ) THEN
    ALTER TABLE "SeedPair" ADD CONSTRAINT "SeedPair_nonce_nonnegative"
      CHECK ("nonce" >= 0);
  END IF;
END $$;
