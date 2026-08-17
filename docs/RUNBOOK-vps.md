# RUNBOOK — lab → VPS 遷移與 Cloudflare 接入

目標形態：VPS（$5 級）跑 crawler+worker+web，Cloudflare 橙雲代理對外。
全程由 goose 可執行——使用者只需提供（A）VPS SSH 存取（B）CF API token（選配）。

## 需要使用者提供的東西

1. **VPS**：開一台 Debian 12（Linode Nanode $5 / Hetzner CX22 皆可），取得 IP
2. **SSH 存取**：把 lab 的金鑰加到 VPS（或提供金鑰路徑），lab 能 `ssh root@<IP>` 免密碼
3. **（選配）Cloudflare API token**（Zone.DNS Edit 權限）+ 網域——有的話 DNS 自動化；沒有的話 dashboard 手點

## 遷移步驟（goose 執行）

1. **bootstrap**：`ssh root@<IP> 'bash -s' < deploy/setup-vps.sh`
   （套件、bun、ptt 使用者、systemd units、ufw）
2. **推送程式碼**：`rsync -a --delete --exclude ptt.db --exclude backups/ /home/newlix/ptt-insight/ <IP>:/opt/ptt-insight/`
3. **推送 DB（一致性快照，不停機）**：
   `sqlite3 /home/newlix/ptt-insight/ptt.db ".backup '/tmp/migrate.db'"`
   `rsync -a <IP>:/tmp → /opt/ptt-insight/ptt.db`（到 VPS 後 chown ptt:ptt）
4. **推送 env**：`scp /etc/ptt-insight.env <IP>:/etc/ptt-insight.env`（含 LLM key；RATE_LIMIT=5）
5. **啟動驗證**：`systemctl enable --now ptt-insight`；curl healthz、/status、板頁、文章頁
6. **CF 接入**：A record `<domain>` → VPS IP，**橙雲開**（Proxy enabled）
   - API 版：`POST /zones/{zone}/dns_records`（type A, proxied true）
   - 驗證：`curl -sI https://<domain>/bbs/Gossiping/index.html` 有 `cf-ray` header
7. **切流**：DNS 生效後，lab 停機：`sudo systemctl stop ptt-insight`（VPS 已在增量爬）
8. **回滾**：任何異常 → lab `systemctl start ptt-insight` + DNS 切回（或 CF 暫停橙雲直指 lab）

## 上線後加固（VPS 上，goose 可代跑）

- SSH 僅金鑰：`PasswordAuthentication no`
- ufw 限 CF IP 段（origin 只收 Cloudflare 流量）：https://www.cloudflare.com/ips/
- 自動安全更新：unattended-upgrades（bootstrap 已裝）
- 監看：/status 頁 + backup timer 04:30（暫停窗模式已內建）

## 已知注意事項

- **同時跑兩台會重複爬**：切流前 lab 必須停（步驟 7）
- DB 遷移用快照：VPS 啟動時 backfill/incremental 自動續上（斷點續爬是內建行為）
- $5 機 1GB RAM：實測服務 RSS 145MB，餘裕 7×
- 每日 +~10MB 磁碟成長，25GB 盤可撐多年
