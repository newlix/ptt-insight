#!/usr/bin/env bash
# ptt-insight nightly backup: clean SQLite snapshot + 14-day prune.
# Protects against DB corruption (online .backup is transaction-consistent).
# Off-site copy (R2 upload) is a TODO once credentials exist — see PROGRESS 9.18.
set -euo pipefail

DB_PATH="${1:-/home/newlix/ptt-insight/ptt.db}"
BACKUP_DIR="$(dirname "$DB_PATH")/backups"
DAY="$(date +%F)"
KEEP_DAYS=14

mkdir -p "$BACKUP_DIR"
sqlite3 "$DB_PATH" ".backup '$BACKUP_DIR/ptt-$DAY.db'"
find "$BACKUP_DIR" -name 'ptt-*.db' -mtime +"$KEEP_DAYS" -delete
echo "backup ok: $BACKUP_DIR/ptt-$DAY.db ($(du -h "$BACKUP_DIR/ptt-$DAY.db" | cut -f1))"
