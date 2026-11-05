-- Referral codes are looked up UPPERCASE at signup, but the schema default
-- cuid() produced lowercase codes. Normalise existing codes so old invite
-- links keep working.
UPDATE "User" SET "referralCode" = UPPER("referralCode")
WHERE "referralCode" <> UPPER("referralCode");
