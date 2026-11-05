#!/bin/sh
# apps/api/docker-entrypoint.sh — production container bootstrap.
# 1. Wait for Postgres (hard gate) + Redis (fail-open, D-104).
# 2. Apply database migrations (idempotent).
# 3. Seed ONLY when the DB is empty (fresh volumes) — never clobber existing data.
# 4. Start the API server (pre-compiled bundle — no tsx, no src/).
#
# Runs from the MINIMAL image: only prod deps + dist/ + prisma/ are present.
set -e

cd /app/apps/api
export DATABASE_URL="${DATABASE_URL:?DATABASE_URL must be set}"
export REDIS_URL="${REDIS_URL:?REDIS_URL must be set}"

echo "[entrypoint] waiting for Postgres + Redis..."
node scripts/wait-for.mjs

echo "[entrypoint] applying migrations..."
./node_modules/.bin/prisma migrate deploy

# Seed ONLY when the games table is genuinely empty. The probe script exits
# non-zero on ANY read failure, so a broken DB never falls through to "0 games"
# and a seeded DB is never clobbered (was: `tsx -e` with a fragile grep).
GAMES=$(node scripts/game-count.mjs)

if [ "$GAMES" = "0" ]; then
  echo "[entrypoint] database is empty — seeding (superadmin, 20 games, settings)..."
  node dist/seed.js
else
  echo "[entrypoint] database already seeded (${GAMES} games) — skipping seed"
fi

echo "[entrypoint] starting API..."
exec node dist/server.js
