-- 20260919_session_integrity
--
-- "Sign out everywhere" used to revoke refresh-token families only, which
-- stops a session from being RENEWED but leaves an already-issued access token
-- working for up to its full 15-minute lifetime (8 hours for the panel cookie).
-- Both identities now carry a session version that is stamped into every token
-- and compared on every request, so revocation is immediate.
--
-- Idempotent by construction: IF NOT EXISTS on both statements, so re-running
-- the deploy or applying it to a database that already has the columns is a
-- no-op rather than a failed migration.

ALTER TABLE "User"
  ADD COLUMN IF NOT EXISTS "sessionVersion" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "AdminUser"
  ADD COLUMN IF NOT EXISTS "sessionVersion" INTEGER NOT NULL DEFAULT 0;
