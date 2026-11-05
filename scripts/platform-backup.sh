#!/bin/bash
# scripts/platform-backup.sh — ONE file, everything needed to rebuild the platform.
#
#   database + uploaded images + a manifest, sealed into a single encrypted
#   archive (`.cpb`) that only your offline private key can open.
#
# WHAT'S INSIDE THE ARCHIVE
#   manifest.json          what this is, when it was made, row counts, checksums,
#                          a NON-REVERSIBLE fingerprint of ENCRYPTION_KEY
#   database.dump          pg_dump -Fc (custom format: schema + data + migration history)
#   objects/minio-data.tar.gz   every deposit proof + avatar (MinIO volume)
#   RESTORE.txt            human instructions that work without this repo
#
# USAGE (on the VPS, or locally in Git Bash)
#   ./scripts/platform-backup.sh                          # encrypt for your public key
#   ./scripts/platform-backup.sh --key backup-key.pub     # explicit key path
#   ./scripts/platform-backup.sh --passphrase             # prompt for a passphrase instead
#   ./scripts/platform-backup.sh --no-encrypt             # plain .tar (NOT recommended)
#   ./scripts/platform-backup.sh --no-objects             # database only (skip images)
#
# OUTPUT
#   ./backups/casino-platform-<timestamp>.cpb   ← the one file you keep
#
# RESTORE
#   ./scripts/platform-restore.sh backups/casino-platform-<timestamp>.cpb
#
# NOTE ON SIZE: encryption is done in memory (one JSON envelope), which is fine
# for the tens-to-hundreds of MB typical here. Above ~1 GiB use a plain tar plus
# a tool like age/gpg — the script warns you before it tries.
set -euo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$DIR"

# ── configuration (override with env vars) ─────────────────────────────────
PG_SVC="${PG_SVC:-postgres}"
PG_USER="${PG_USER:-casino}"
PG_DB="${PG_DB:-casino}"
API_SVC="${API_SVC:-api}"
MINIO_SVC="${MINIO_SVC:-minio}"
COMPOSE="${COMPOSE:-}"
OUT_DIR="${OUT_DIR:-$DIR/backups}"
ENCRYPT=1
WANT_OBJECTS=1
KEY_FILE="${BACKUP_RECIPIENT_PUBKEY_FILE:-}"
USE_PASSPHRASE=0
QUIET=""

while [ $# -gt 0 ]; do
  case "$1" in
    --key)            KEY_FILE="$2"; shift 2 ;;
    --key=*)          KEY_FILE="${1#*=}"; shift ;;
    --passphrase)     USE_PASSPHRASE=1; shift ;;
    --no-encrypt)     ENCRYPT=0; shift ;;
    --no-objects)     WANT_OBJECTS=0; shift ;;
    --out-dir)        OUT_DIR="$2"; shift 2 ;;
    --compose)        COMPOSE="$2"; shift 2 ;;
    -q|--quiet)       QUIET="-q"; shift ;;
    -h|--help)        sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "unknown option: $1 (try --help)" >&2; exit 2 ;;
  esac
done

say() { [ -n "$QUIET" ] || echo "$@"; }
fail() { echo "ERROR: $*" >&2; exit 1; }

command -v docker >/dev/null 2>&1 || fail "docker is not on PATH"

# Pick a compose file automatically when one is present (Dokploy/prod/local).
if [ -z "$COMPOSE" ]; then
  for f in docker-compose.yml; do
    [ -f "$DIR/$f" ] && COMPOSE="$DIR/$f" && break
  done
fi

# Resolve the postgres container: compose project first, then by name.
resolve_container() {
  local svc="$1" id=""
  if [ -n "$COMPOSE" ]; then
    id="$(docker compose -f "$COMPOSE" ps -q "$svc" 2>/dev/null | head -1 || true)"
  fi
  if [ -z "$id" ]; then
    id="$(docker ps --format '{{.ID}} {{.Names}}' 2>/dev/null \
      | awk -v s="-$svc-" 'index($2, s) {print $1; exit}')"
  fi
  printf '%s' "$id"
}

PG_CT="$(resolve_container "$PG_SVC")"
[ -n "$PG_CT" ] || fail "no running '$PG_SVC' container found (start the stack, or set PG_SVC=)"

# The MinIO data volume (name depends on the compose project).
find_minio_volume() {
  if [ -n "${MINIO_VOL:-}" ]; then printf '%s' "$MINIO_VOL"; return; fi
  if [ -n "$COMPOSE" ]; then
    local proj
    proj="$(docker compose -f "$COMPOSE" ps -q "$MINIO_SVC" 2>/dev/null | head -1 || true)"
    if [ -n "$proj" ]; then
      local name
      name="$(docker inspect -f '{{ range .Mounts }}{{ if eq .Destination "/data" }}{{ .Name }}{{ end }}{{ end }}' "$proj" 2>/dev/null || true)"
      [ -n "$name" ] && { printf '%s' "$name"; return; }
    fi
  fi
  docker volume ls -q 2>/dev/null | grep -E '_minio_data$' | head -1
}

# 32-byte raw key → DER wrappers live in backup-crypto.mjs; here we only need a
# NON-REVERSIBLE fingerprint for the manifest, never the key itself.
key_fingerprint() {
  local k="$1"
  [ -z "$k" ] && { printf 'none'; return; }
  printf '%s' "$k" | sha256sum | cut -c1-16
}

STAMP="$(date -u +%Y%m%d-%H%M%S)"
TMP="$(mktemp -d)"
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT INT TERM

mkdir -p "$OUT_DIR" "$TMP/objects"

say "[1/6] dumping the database..."
docker exec "$PG_CT" pg_dump -U "$PG_USER" -d "$PG_DB" -F c --no-owner --no-privileges \
  -f /tmp/platform-backup.dump
docker cp "$PG_CT:/tmp/platform-backup.dump" "$TMP/database.dump" >/dev/null
docker exec "$PG_CT" rm -f /tmp/platform-backup.dump || true
[ -s "$TMP/database.dump" ] || fail "the dump is empty — is the database reachable?"
say "      database.dump: $(du -h "$TMP/database.dump" | cut -f1)"

if [ "$WANT_OBJECTS" = "1" ]; then
  MINIO_VOL="$(find_minio_volume)"
  if [ -n "$MINIO_VOL" ]; then
    say "[2/6] archiving uploaded images ($MINIO_VOL)..."
    # :ro — the backup must never be able to damage live storage.
    docker run --rm -v "$MINIO_VOL":/data:ro -v "$TMP/objects":/out alpine \
      tar czf /out/minio-data.tar.gz -C /data .
    say "      minio-data.tar.gz: $(du -h "$TMP/objects/minio-data.tar.gz" | cut -f1)"
  else
    echo "WARNING: no MinIO volume found — proof images are NOT in this backup" >&2
    rmdir "$TMP/objects" 2>/dev/null || true
  fi
else
  say "[2/6] skipping images (--no-objects)"
  rmdir "$TMP/objects" 2>/dev/null || true
fi

say "[3/6] collecting row counts + key fingerprint..."
count_of() {
  docker exec "$PG_CT" psql -U "$PG_USER" -d "$PG_DB" -tAc "SELECT COUNT(*) FROM \"$1\";" 2>/dev/null | tr -d '[:space:]'
}
COUNT_LINES=""
for t in User Wallet GameRound Transaction Deposit Withdrawal AdminUser GameConfig; do
  c="$(count_of "$t" || true)"
  case "$c" in ''|*[!0-9]*) c=null ;; esac
  COUNT_LINES="$COUNT_LINES    \"$t\": $c,
"
done
COUNTS="$(printf '%s' "$COUNT_LINES" | sed '$ s/,[[:space:]]*$//')"

API_CT="$(resolve_container "$API_SVC")"
ENC_KEY=""
if [ -n "$API_CT" ]; then
  ENC_KEY="$(docker exec "$API_CT" printenv ENCRYPTION_KEY 2>/dev/null || true)"
  [ -z "$ENC_KEY" ] && ENC_KEY="$(docker exec "$API_CT" printenv AES_ENCRYPTION_KEY 2>/dev/null || true)"
fi
KEY_FP="$(key_fingerprint "$ENC_KEY")"

sha() { sha256sum "$1" | cut -d' ' -f1; }
BYTES_DB="$(stat -c%s "$TMP/database.dump" 2>/dev/null || stat -f%z "$TMP/database.dump")"
DB_SHA="$(sha "$TMP/database.dump")"
OBJ_LINES=""
if [ -f "$TMP/objects/minio-data.tar.gz" ]; then
  BYTES_OBJ="$(stat -c%s "$TMP/objects/minio-data.tar.gz" 2>/dev/null || stat -f%z "$TMP/objects/minio-data.tar.gz")"
  OBJ_SHA="$(sha "$TMP/objects/minio-data.tar.gz")"
  OBJ_LINES="$(printf ',\n    "objects/minio-data.tar.gz": { "bytes": %s, "sha256": "%s" }' "$BYTES_OBJ" "$OBJ_SHA")"
fi

GIT_REV="$(git -C "$DIR" rev-parse --short HEAD 2>/dev/null || echo unknown)"
cat > "$TMP/manifest.json" <<JSON
{
  "format": "casino-platform-backup",
  "version": 1,
  "createdAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "host": "$(hostname)",
  "appCommit": "$GIT_REV",
  "parts": {
    "database.dump": { "bytes": $BYTES_DB, "sha256": "$DB_SHA" }$OBJ_LINES
  },
  "counts": {$COUNTS
  },
  "encryption": {
    "keyFingerprint": "$KEY_FP",
    "note": "sha256(ENCRYPTION_KEY) truncated to 16 hex chars. NOT reversible. If the restored stack has a different ENCRYPTION_KEY, saved payout-account details will be unreadable."
  }
}
JSON

cat > "$TMP/RESTORE.txt" <<'TXT'
How to restore this platform backup
===================================

With the repository (recommended):

    ./scripts/platform-restore.sh <this-file>.cpb

The script asks for confirmation, then:
  1. decrypts the archive
  2. verifies every part against the manifest checksums
  3. restores the database (drop + recreate + pg_restore)
  4. restores uploaded images into the MinIO volume
  5. flushes Redis caches and restarts the app

Without the repository:

    node scripts/backup-crypto.mjs decrypt --key backup-key.txt --in <file>.cpb --out platform.tar
    tar xf platform.tar          # -> manifest.json, database.dump, objects/, this file

  Database (into a running postgres container, e.g. <pg>):
    docker cp database.dump <pg>:/tmp/restore.dump
    docker exec <pg> dropdb -U casino --force --if-exists casino
    docker exec <pg> createdb -U casino -O casino casino
    docker exec <pg> pg_restore -U casino -d casino --no-owner --no-privileges --exit-on-error /tmp/restore.dump

  Images (replace <minio_vol> with the volume from `docker volume ls`):
    docker run --rm -v <minio_vol>:/data -v "$PWD/objects":/ro alpine sh -c 'cd /data && tar xzf /ro/minio-data.tar.gz'

  IMPORTANT: the restored stack must use the SAME ENCRYPTION_KEY as the one that
  made this backup (see manifest.json -> encryption.keyFingerprint), otherwise
  saved bank / mobile-wallet details cannot be read.
TXT

say "[4/6] packaging..."
TAR="$OUT_DIR/casino-platform-$STAMP.tar"
TAR_ARGS=(manifest.json database.dump RESTORE.txt)
if [ -f "$TMP/objects/minio-data.tar.gz" ]; then
  TAR_ARGS+=(objects)
fi
tar cf "$TAR" -C "$TMP" "${TAR_ARGS[@]}"
say "      $(du -h "$TAR" | cut -f1)"

OUT="$TAR"
if [ "$ENCRYPT" = "1" ]; then
  TAR_BYTES="$(stat -c%s "$TAR" 2>/dev/null || stat -f%z "$TAR")"
  if [ "$TAR_BYTES" -gt 1073741824 ]; then
    echo "WARNING: archive is larger than 1 GiB; in-memory encryption may exhaust RAM." >&2
  fi
  say "[5/6] encrypting..."
  # Prefer host node; fall back to a throwaway container so this works on a VPS
  # with no Node installed.
  run_crypto() {
    if command -v node >/dev/null 2>&1; then
      node "$DIR/scripts/backup-crypto.mjs" "$@"
    else
      docker run --rm -v "$DIR":/repo:ro -v "$OUT_DIR":/out -w /repo node:22-alpine \
        node scripts/backup-crypto.mjs "$@"
    fi
  }
  OUT="$OUT_DIR/casino-platform-$STAMP.cpb"
  if [ "$USE_PASSPHRASE" = "1" ]; then
    # Passphrase mode must NOT put the secret on the command line.
    printf 'Backup passphrase (min 12 chars): ' >&2
    stty -echo 2>/dev/null || true
    IFS= read -r BACKUP_PASSPHRASE
    stty echo 2>/dev/null || true
    echo >&2
    [ -n "${BACKUP_PASSPHRASE:-}" ] || fail "empty passphrase"
    export BACKUP_PASSPHRASE
    run_crypto encrypt --passphrase-env BACKUP_PASSPHRASE --in "$TAR" --out "$OUT" $QUIET
  else
    if [ -z "$KEY_FILE" ] && [ -f "$DIR/backup-key.pub" ]; then
      KEY_FILE="$DIR/backup-key.pub"
    fi
    if [ -z "$KEY_FILE" ]; then
      fail "no public key found. Either:
      node scripts/backup-crypto.mjs keygen        # creates backup-key.pub + backup-key.txt
    ...or pass --key PATH, ...or use --passphrase"
    fi
    run_crypto encrypt --to "$KEY_FILE" --in "$TAR" --out "$OUT" $QUIET
  fi
  rm -f "$TAR"   # never leave the plaintext archive lying around
else
  say "[5/6] NOT encrypting (--no-encrypt) — the archive is readable by anyone with the file"
fi

say "[6/6] done"
echo
echo "  Backup: $OUT"
echo "  Size:   $(du -h "$OUT" | cut -f1)"
echo "  Contents: database.dump$( [ -f "$TMP/objects/minio-data.tar.gz" ] && echo ' + all uploaded images' ) + manifest"
echo "  ENCRYPTION_KEY fingerprint: $KEY_FP"
echo
echo "  Keep TWO copies in different places (this machine + your PC/cloud)."
echo "  Restore with:  ./scripts/platform-restore.sh \"$OUT\""
