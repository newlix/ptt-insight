#!/usr/bin/env bash
# Online SQLite backup for the PTT crawler mirror.
#
# Strategy (per CONTEXT.md):
#   1. PRAGMA wal_checkpoint(TRUNCATE) — flush WAL into the main DB file.
#      Safe while the crawler runs (cooperative checkpoint; busy pages skip).
#   2. sqlite3 .backup — online backup API: consistent snapshot without
#      stopping the writer (would also work without step 1, but the
#      checkpoint keeps the copied file compact).
#   3. integrity_check on the backup before accepting it.
#   4. Rotate: keep RETENTION_DAYS of ptt_*.db.
set -euo pipefail

DB_PATH="${DB_PATH:-$HOME/ptt-insight/ptt.db}"
BACKUP_DIR="${BACKUP_DIR:-$HOME/ptt-insight/backups}"
RETENTION_DAYS="${RETENTION_DAYS:-7}"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
FILEPATH="$BACKUP_DIR/ptt_$TIMESTAMP.db"

mkdir -p "$BACKUP_DIR"

if [ ! -f "$DB_PATH" ]; then
  echo "[$(date)] ERROR: database not found: $DB_PATH" >&2
  exit 1
fi

echo "[$(date)] backing up $DB_PATH to $FILEPATH ..."

# Flush WAL into the main file (safe online; crawler keeps running)
sqlite3 "$DB_PATH" "PRAGMA wal_checkpoint(TRUNCATE);"

# Online backup API — consistent snapshot, no downtime
sqlite3 "$DB_PATH" ".backup '$FILEPATH'"

# Verify the backup before accepting it
INTEGRITY=$(sqlite3 "$FILEPATH" "PRAGMA integrity_check;")
if [ "$INTEGRITY" != "ok" ]; then
  echo "[$(date)] ERROR: backup failed integrity_check: $INTEGRITY" >&2
  rm -f "$FILEPATH"
  exit 1
fi

SIZE=$(du -h "$FILEPATH" | cut -f1)
ARTICLES=$(sqlite3 "$FILEPATH" "SELECT count(*) FROM articles;")
BOARDS=$(sqlite3 "$FILEPATH" "SELECT count(*) FROM boards;")
PUSHES=$(sqlite3 "$FILEPATH" "SELECT count(*) FROM pushes;")
echo "[$(date)] backup complete: $(basename "$FILEPATH") ($SIZE) — $BOARDS boards / $ARTICLES articles / $PUSHES pushes"

# Rotate: delete backups older than RETENTION_DAYS
find "$BACKUP_DIR" -name "ptt_*.db" -mtime +"$RETENTION_DAYS" -delete
echo "[$(date)] rotated backups older than ${RETENTION_DAYS} days"

# Summary
COUNT=$(find "$BACKUP_DIR" -name "ptt_*.db" | wc -l)
TOTAL=$(du -sh "$BACKUP_DIR" | cut -f1)
echo "[$(date)] $COUNT sqlite backup(s) on disk, total $TOTAL"
