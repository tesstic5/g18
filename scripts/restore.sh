#!/bin/sh
# DEPRECATED (D-062c): use scripts/platform-restore.sh <file.cpb> — it verifies
# the archive checksums, restores images as well as the database, and warns when
# ENCRYPTION_KEY does not match the backup.
# scripts/restore.sh — restore a Postgres snapshot (D-062).
# Usage:  ./scripts/restore.sh backups/casino-pg-YYYYMMDD-HHMMSS.sql
# DANGER: this DROPS and recreates the database from the dump. Run on a staging
# copy first if unsure; the JSON restore in the admin panel is safer for merges.
set -e

DIR="$(cd "$(dirname "$0")/.." && pwd)"
DUMP="${1:?usage: restore.sh <dump.sql>}"
[ -f "$DUMP" ] || { echo "file not found: $DUMP"; exit 1; }

PG_SVC="${PG_SVC:-postgres}"
PG_USER="${PG_USER:-casino}"
PG_DB="${PG_DB:-casino}"

echo "[restore] WARNING: this will REPLACE all data in $PG_DB with $DUMP"
printf 'Type RESTORE to continue: '
read -r CONFIRM
[ "$CONFIRM" = "RESTORE" ] || { echo "aborted"; exit 1; }

echo "[restore] dropping + recreating $PG_DB..."
docker compose -f "$DIR/docker-compose.yml" exec -T "$PG_SVC" \
  psql -U "$PG_USER" -d postgres -c "DROP DATABASE IF EXISTS \"$PG_DB\";" -c "CREATE DATABASE \"$PG_DB\" OWNER \"$PG_USER\";"

echo "[restore] loading dump..."
docker compose -f "$DIR/docker-compose.yml" exec -T "$PG_SVC" \
  psql -U "$PG_USER" -d "$PG_DB" < "$DUMP"

echo "[restore] done."
