-- Repair migration: postgresql needs the guard column list to be stable; the
-- 202608201200 same-target guard used md5(choice::text). No-op safety so fresh
-- databases apply cleanly after a manual drift fix in staging.
SELECT 1;
