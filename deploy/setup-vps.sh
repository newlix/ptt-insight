#!/usr/bin/env bash
# ptt-insight VPS bootstrap — run ONCE as root on a fresh Debian/Ubuntu VPS.
# Idempotent: safe to re-run. Data (repo working copy, DB, env) is pushed from
# the lab machine afterwards — see docs/RUNBOOK-vps.md.
set -euo pipefail

APP_USER=ptt
APP_DIR=/opt/ptt-insight
BUN_PATH=/usr/local/bin/bun

echo "== 1/5 base packages =="
apt-get update -qq
apt-get install -y -qq sqlite3 curl ca-certificates git ufw unattended-upgrades

echo "== 2/5 bun runtime =="
if [ ! -x "$BUN_PATH" ]; then
  curl -fsSL https://bun.sh/install | bash
  install -m 0755 /root/.bun/bin/bun "$BUN_PATH"
fi
"$BUN_PATH" --version

echo "== 3/5 app user + dir =="
id -u "$APP_USER" >/dev/null 2>&1 || useradd -r -m -d "$APP_DIR" -s /usr/sbin/nologin "$APP_USER"
mkdir -p "$APP_DIR" "$APP_DIR/backups"
chown -R "$APP_USER":"$APP_USER" "$APP_DIR"

echo "== 4/5 systemd units =="
# Units are expected at $APP_DIR/deploy/ (pushed with the repo in step 6 of
# the runbook). Install them if present; otherwise skip with a note.
if [ -f "$APP_DIR/deploy/ptt-insight.service" ]; then
  install -m 0644 "$APP_DIR/deploy/ptt-insight.service" /etc/systemd/system/
  install -m 0644 "$APP_DIR/deploy/ptt-insight-backup.service" /etc/systemd/system/
  install -m 0644 "$APP_DIR/deploy/ptt-insight-backup.timer" /etc/systemd/system/
  systemctl daemon-reload
  systemctl enable ptt-insight-backup.timer
  echo "units installed (timer enabled; service starts after data lands)"
else
  echo "note: $APP_DIR/deploy not present yet — re-run after data push"
fi

echo "== 5/5 firewall =="
# Web is served via Cloudflare only: allow SSH + HTTP(S) from anywhere is the
# simple start; tighten to CF IP ranges later (see RUNBOOK).
if ! ufw status | grep -q 'Status: active'; then
  ufw default deny incoming
  ufw default allow outgoing
  ufw allow 22/tcp
  ufw allow 80/tcp
  ufw allow 443/tcp
  ufw --force enable
fi
ufw status | head -8

echo "bootstrap done. Next: push data from the lab machine (RUNBOOK steps 5-7)."
