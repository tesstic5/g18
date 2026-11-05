#!/bin/sh
# DEPRECATED (D-062c): database-only, and it writes plain SQL with a shell
# redirect. Use scripts/platform-backup.sh instead — ONE encrypted file with the
# database AND every uploaded image, verifiable and restorable in one command.
# Kept only because host cron entries may still call this path.
# scripts/backup.sh — nightly full database snapshot (D-062).
# Run via cron (see README):  0 3 * * * /path/platform/scripts/backup.sh
# Backs up Postgres (pg_dump) + Redis (RDB) into ./backups, keeping the last 7.
# Restore with scripts/restore.sh.
set -e

DIR="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$DIR/backups"
mkdir -p "$OUT"
STAMP=$(date +%Y%m%d-%H%M%S)

# Compose service names (all-in-one stack). Override via env if different.
PG_SVC="${PG_SVC:-postgres}"
PG_USER="${PG_USER:-casino}"
PG_DB="${PG_DB:-casino}"
REDIS_SVC="${REDIS_SVC:-redis}"
REDIS_PASSWORD="${REDIS_PASSWORD:-casino}"

PG_OUT="$OUT/casino-pg-$STAMP.sql"
PG_TMP="$PG_OUT.partial"
echo "[backup] Postgres dump → $PG_OUT"
trap 'rm -f "$PG_TMP"' EXIT INT TERM
docker compose -f "$DIR/docker-compose.yml" exec -T "$PG_SVC" \
  pg_dump -U "$PG_USER" -d "$PG_DB" --no-owner > "$PG_TMP"
mv "$PG_TMP" "$PG_OUT"
trap - EXIT INT TERM

echo "[backup] Redis dump (BGSAVE + copy RDB) → $OUT/casino-redis-$STAMP.rdb"
docker compose -f "$DIR/docker-compose.yml" exec -T "$REDIS_SVC" redis-cli -a "$REDIS_PASSWORD" --no-auth-warning BGSAVE >/dev/null
sleep 2
docker compose -f "$DIR/docker-compose.yml" cp "$REDIS_SVC:/data/dump.rdb" "$OUT/casino-redis-$STAMP.rdb" >/dev/null 2>&1 || echo "[backup] (redis rdb copy skipped)"

# Keep last 7
ls -1t "$OUT"/casino-pg-*.sql 2>/dev/null | tail -n +8 | xargs -r rm -f
ls -1t "$OUT"/casino-redis-*.rdb 2>/dev/null | tail -n +8 | xargs -r rm -f

echo "[backup] done — $(ls -1 "$OUT" | wc -l) files in $OUT"
