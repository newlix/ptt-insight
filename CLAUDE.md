# PTT Insight

單一 Bun process：**全站 mirror 爬蟲**（原 ptt-crawler）+ **GLM 分析 worker** + **PTT 官網 clone web**。
資料都在一顆 `ptt.db`（SQLite WAL）。作為「有價值內容提取」系統的資料源與展示層。

## 架構

```
┌─────────────────── ptt-insight (Bun, 單一 process) ───────────────────┐
│  crawler (RUN_CRAWLER)   → 寫 boards/articles/pushes（增量+backfill） │
│  insight worker (RUN_WORKER) → 讀文章+推文 → GLM → 寫 article_insights │
│  web (RUN_WEB)           → SSR 讀全部表（PTT 官網 clone + AI 區塊）   │
└────────────────────────────── ptt.db (SQLite) ────────────────────────┘
```

- 三個子系統用 env 開關（預設全開），共用一個 DB handle（`bun:sqlite` 同步呼叫天然序列化）
- **Crawler**：全站 mirror www.ptt.cc；增量 adaptive backoff（10min–7d）+ backfill window sweep（熱門板優先、全域 90 天水位批次）+ 文章刪除偵測（index 缺席法）
- **Worker**：挑 `net_count ≥ 20` 未分析文章（降序），文章+推文送 GLM 產出 TL;DR/社群觀點/精選推文/情緒/爭議度/標籤；每列記錄 `model` + `generated_at`（文章頁 AI 區塊顯示）；**重新分析機制**：發文 7 天內且推文有變 → 重分析（每篇每小時最多一次）；暫時性錯誤（429/斷網）1 小時後重試；平日 14-18 點（UTC+8）暫停省 Z.AI credit；content-filter 擋文由 fallback provider（DeepSeek v4-pro）重試
- **Web**：Bun.serve SSR（HTML template + `esc()` 轉義）、手寫 plain CSS（無框架）

## 技術棧

TypeScript + Bun · `bun:sqlite` · cheerio · GLM（OpenAI-compatible）
時間戳一律 **Unix epoch 秒（INTEGER）**；raw SQL + 薄 query 層（`src/db/queries/`，換 D1 只改 `src/db/sqlite.ts`）

## 指令

```bash
bun install
bun test          # 71 tests（in-memory SQLite，零外部依賴）
bun src/index.ts  # 啟動全部
```

## 環境變數

| 變數 | 預設 | 說明 |
|---|---|---|
| `DB_PATH` | `ptt.db` | SQLite 路徑（正式：`~/ptt-insight/ptt.db`） |
| `RUN_CRAWLER` / `RUN_WORKER` / `RUN_WEB` | `1` | 子系統開關 |
| `RATE_LIMIT` | `3` | 爬蟲全域速率（incremental 40% / backfill 60%） |
| `BACKFILL_WORKERS` | `1` | 並行 backfill worker 數 |
| `BACKFILL_BATCH_PAGES` | `200` | 每次claim爬多少頁就換板（breadth-first） |
| `BACKFILL_RECENT_DAYS` | `90` | window sweep 批次大小；`0` = 關閉 |
| `SKIP_DISCOVERY` | (未設) | `1` 跳過 /cls/ 全站看板發現 |
| `ADDR` | `:8088` | web 監聽位址（綁 127.0.0.1） |
| `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL` | proxy / 空 / `glm-5.2` | 主分析 provider |
| `FALLBACK_LLM_BASE_URL` / `FALLBACK_LLM_MODEL` | 空 / `gpt-5.6-luna` | content-filter 重試 provider |
| `WORKER_BATCH` / `WORKER_MIN_NET` | `10` / `20` | 每批篇數 / 最低 net_count |
| `WORKER_INTERVAL` | `0` | `0`=連續；`5m`=每 5 分鐘一批 |
| `WORKER_OFFPEAK` | `1` | 避開平日 14:00-18:00 UTC+8（credit 半價時段外） |
| `INSIGHT_REFRESH_DAYS` | `7` | 發文 N 天內且推文有變（`last_fetched_at > generated_at`）→ 重新分析（每篇每小時最多一次）；`0` = 關閉 |
| `PAGE_SIZE` | `30` | 每頁文章數 |
| `HOTBOARDS_TTL` | `1m` | 熱門看板快取 TTL（失敗回 stale） |

## Migrations

`src/db/migrations/`（啟動自動套用，`schema_migrations` 追蹤，wrangler d1 同格式）：
`0001_init.sql`（crawler 全部 schema）→ `0002_insights.sql`（article_insights，冪等）
`article_insights` 是 AI 可重建資料 — 不需遷移，重跑分析即可。

## 檔案結構

```
src/index.ts               — 合併入口（config + migration + 三子系統 + stats/heartbeat）
src/db/                    — driver + migrations + crawler query 層（queries/、store、types）
src/crawler/ptt/           — PTT 協定層：index/article/cls parser、fetcher、rate limiter、nrec、url、hotboards
src/crawler/crawl/         — 編排：discovery、backfill、incremental、deletion、backoff
src/repo/                  — 讀側查詢（articles/boards 卡片、insights 讀寫）
src/llm/client.ts          — OpenAI-compatible client（content-filter 偵測）
src/insight/               — prompt + JSON 解析 + worker（offpeak/fallback loop）
src/server/                — Bun.serve 路由 + app.css（plain CSS）
src/views/                 — HTML 模板（PTT 黑底風 + 淺色 /boards）
tests/{crawler,db,insight,web…}  — 71 tests（in-memory SQLite + Bun.serve stub）
testdata/*.html            — 真實 PTT fixtures（parser contract）
scripts/backup.sh          — SQLite 線上備份（wal_checkpoint + .backup + integrity_check + 7 天輪替）
```

## 路由

`GET /` 熱門看板（PTT clone）· `/bbs/{board}/index{N}.html` 看板分頁 · `/bbs/{board}/{url_id}.html` 文章頁（+AI 區塊）· `/a/{id}` 同文別名 · `/b/{board}`、`/boards` 舊風格 · `/healthz`（分析進度 JSON）· `/static/app.css`

## 部署（lab 機，CachyOS）

- **正式實例**：`~/ptt-insight`（git checkout；`~/ptt-insight/ptt.db` = 生產資料）
- **`ptt-insight.service`**：單一 service 跑全部；env 在 `/etc/ptt-insight.env`（root:600，含 LLM key）；SIGTERM 優雅關閉、`Restart=on-failure`
- **`ptt-backup.timer`**：每天 04:00 `scripts/backup.sh`（`Persistent=true`）
- 部署 = push 後 `~/ptt-insight` fetch + reset + `systemctl restart ptt-insight`
- 舊 PG 遺產（確認穩定後可刪）：`~/ptt/data/`、`~/ptt/backups/*.dump`；原 ptt-crawler repo 歷史在 `~/github/newlix/ptt-crawler`
