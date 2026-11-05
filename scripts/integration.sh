#!/usr/bin/env bash
# scripts/integration.sh — run the REAL integration suite against the full stack.
# Requires docker. Starts infra, migrates, seeds, runs tests, tears down.
# Exits non-zero if Postgres/Redis never become ready — a skip is not a pass.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "▶ Starting infra (postgres + redis + minio)..."
docker compose up -d postgres redis minio

echo "▶ Waiting for services..."
ready=0
for i in $(seq 1 30); do
  if docker compose exec -T postgres pg_isready -U casino >/dev/null 2>&1 \
    && docker compose exec -T redis redis-cli ping >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
if [ "$ready" != "1" ]; then
  echo "ERROR: postgres/redis did not become ready within 30s — refusing to skip." >&2
  exit 1
fi

echo "▶ Migrating + seeding..."
cd apps/api
corepack pnpm exec prisma migrate deploy
corepack pnpm exec prisma db seed
cd ../..

echo "▶ Running integration suite (fail-closed: INTEGRATION_REQUIRED=1)..."
export INTEGRATION_REQUIRED=1
corepack pnpm --filter @casino/api exec vitest run src/integration

echo "▶ Done. Infra left running — stop with: docker compose down"
