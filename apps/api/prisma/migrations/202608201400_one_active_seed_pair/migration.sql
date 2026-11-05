-- H-09: exactly ONE ACTIVE SeedPair per user, enforced by the database. The
-- rotate-seed route and the new auto-rotation both create the next pair inside
-- a transaction after revealing the previous one; this partial unique index
-- makes a bug in either path fail loudly instead of silently attaching two
-- different committed seeds to interleaved wagers.
CREATE UNIQUE INDEX IF NOT EXISTS "SeedPair_one_active_per_user"
  ON "SeedPair" ("userId") WHERE "status" = 'ACTIVE';
