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

- 三子系統 env 開關（預設全開），共用一個 DB handle（`bun:sqlite` 同步呼叫、單一 writer 天然序列化）
- 技術棧：TypeScript + Bun · `bun:sqlite` · cheerio · GLM（OpenAI-compatible）
- 時間戳一律 **Unix epoch 秒（INTEGER）** — 與 PTT URL timestamp 同單位；除錯用 `datetime(col,'unixepoch')`，**不要手算 epoch**（實際踩過：手算錯導致誤判繫統停擺）
- Raw SQL + 薄 query 層（`src/db/queries/`）；driver 只在 `src/db/sqlite.ts` 出現，換 node:sqlite / D1 只改這檔

## PTT 協定知識（parser 契約，見 testdata/*.html）

- **URL 格式** `/bbs/{board}/M.{unix_epoch秒}.A.{rand}.html` — timestamp 是發文時間，免抓全文即可排序
- **index 頁**：`.r-ent` 每篇；`.nrec span` 推文數顯示值（`5`/`爆`=>99/`X1`=負/空）；`.title a` 無 `<a>` = 已刪除（作者 `-`）；`.mark` `!`=置底會跨頁重複（需 dedup）；`.r-list-sep` 下方是置底文；`‹ 上頁` 連結 = 當前頁號+1
- **article 頁**：`.article-metaline`×3（作者/標題/時間，時間格式 `Mon Jan _2 15:04:05 2006` Asia/Taipei）；`.push` 推文（tag/userid/content/ipdatetime）；`※ 發信站:` 行含發文 IP
- **18+ 板**：所有 request 帶 `over18=1` cookie
- `/bbs/index.html` 與 `/bbs/hotboards.html` byte-identical（實測 md5 相同）— 訪客看到的就是熱門看板
- robots.txt 404、無 CAPTCHA/WAF；`server: Cryophoenix`（PTT 自家 proxy，非 Cloudflare）。風險是把台大學術伺服器搞掛，不是被封 — 全域 5 req/s 是禮貌上限

## Crawler 策略

- **增量**：每板 adaptive backoff（有新文 → 2min，`INCREMENTAL_MIN_SECS` 可調；沒有 → interval×2 上限 7 天，`INCREMENTAL_MAX_SECS` 可調）；index 頁 `nrec_raw` 與 DB 比對，變了才重抓文章頁（省 80-90% request）
- **Backfill window sweep**：只抓熱門板（`is_hot`），全域 90 天水位批次（`window_bottom` 全部到達才 `AdvanceBackfillWindow` 減 90 天）；每板 `window_floor` 記連續覆蓋最舊文章（URL timestamp 免抓全文）；breadth-first（`BACKFILL_BATCH_PAGES` 換板）；**claim 生命週期**：批次暫停/達邊界即釋放（resume 靠 `last_backfill_page`），錯誤保留 6h 排斥當壞板 cool-off；水位前進要求所有未完熱板到位，故殭屍 claim 會讓全系統 idle——啟動 `releaseAllBackfillClaims` 是保險
- **刪除偵測（index 缺席法）**：文章比 index 首頁最舊文新卻不在頁上 → 不可能捲頁 → 抓前一頁複驗（在前一頁=活著；兩頁都缺席且比前一頁最舊新=確認刪除 soft delete；更舊=灰色地帶不動）
- **孤兒 claim**：SIGTERM 中斷會留 `backfill_claimed_at`，6h exclusion 會讓 backfill 停擺 → 啟動時 `releaseAllBackfillClaims()`（本服務是唯一 writer，起動時任何 claim 必是孤兒）
- **看板發現**：`/bbs/hotboards.html`（~150 熱門板）+ 背景 `/cls/1` 遞迴全樹（~20K 板）

## Insight Worker

- 佇列語意（`claimPendingArticles`）：`net_count ≥ WORKER_MIN_NET`、content>20 字、無 insight row；**error row 重試矩陣** — `content_filter` → fallback loop（DeepSeek v4-pro）；其他錯誤（429/斷網/parse）→ 1h cooldown 後重新進主佇列
- **重分析**：發文 `INSIGHT_REFRESH_DAYS`(7) 天內且 `last_fetched_at > generated_at`（推文有變）→ 重分析，每篇每小時最多一次；訊號跟著爬蟲走（nrec 變了才重抓）
- LLM client：429/5xx/網路錯指數退避（15s→30s、±20% jitter、尊重 Retry-After）；1301 content-filter 不重試直接 fallback；max_tokens 8192（GLM reasoning 先燒 token，4096 會餓死答案）
- Off-peak：平日 14:00-18:00 UTC+8 暫停（Z.AI credit 全價時段）；fallback loop 不受此限
- 每列記錄 `model` + `generated_at` + tokens；文章頁 AI 區塊右下顯示

## 環境變數

| 變數 | 預設 | 說明 |
|---|---|---|
| `DB_PATH` | `ptt.db` | SQLite 路徑（正式：`~/ptt-insight/ptt.db`） |
| `RUN_CRAWLER` / `RUN_WORKER` / `RUN_WEB` | `1` | 子系統開關 |
| `RATE_LIMIT` | `3` | 爬蟲全域速率（單一全域桶；backfill+discovery 另被 60% 子桶 cap，incremental 保證 ~40%、backfill 閒置時可借滿全域） |
| `CRAWL_CONCURRENCY` | `3` | 單頁內文章抓取並行數（全域 rate limiter 仍 cap） |
| `INCREMENTAL_MIN_SECS` | `120` | 活躍板檢查 floor（有新文 → 重置至此；`2m` Go duration 亦可） |
| `INCREMENTAL_MAX_SECS` | `604800` | 安靜板 backoff 上限（7 天） |
| `WORKER_CONCURRENCY` | `3` | LLM 併發上限（過高觸發 Z.AI 429/1302） |
| `BACKFILL_WORKERS` | `1` | 並行 backfill worker 數 |
| `BACKFILL_BATCH_PAGES` | `200` | 每次 claim 爬多少頁就換板 |
| `BACKFILL_RECENT_DAYS` | `90` | window sweep 批次大小；`0` = 關閉 |
| `SKIP_DISCOVERY` | (未設) | `1` 跳過 /cls/ 全站看板發現 |
| `ADDR` | `:8088` | web 監聽位址（綁 127.0.0.1） |
| `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL` | — | 主分析 provider（正式：Z.AI glm-5.2） |
| `FALLBACK_LLM_BASE_URL` / `_API_KEY` / `_MODEL` | — | content-filter 重試 provider（正式：DeepSeek v4-pro） |
| `WORKER_BATCH` / `WORKER_MIN_NET` | `10` / `20` | 每批篇數 / 最低 net_count（`/healthz` 的 total 同此門檻） |
| `WORKER_INTERVAL` | `0` | `0`=連續；`5m`=每 5 分鐘一批 |
| `WORKER_OFFPEAK` | `1` | 避開平日 14-18 點 UTC+8 |
| `INSIGHT_REFRESH_DAYS` | `7` | 推文有變的重分析窗口；`0` = 關閉 |
| `PAGE_SIZE` / `HOTBOARDS_TTL` | `30` / `1m` | web 每頁文章數 / 熱門看板快取 |

## Migrations

`src/db/migrations/`（啟動自動套用，`schema_migrations` 追蹤，wrangler d1 同格式）：
`0001_init.sql`（crawler 全部 schema：boards/articles/pushes/crawl_runs/backfill_meta）→ `0002_insights.sql`（article_insights，冪等）。
`article_insights` 是 AI 可重建資料 — 不需遷移，重跑分析即可。

## 檔案結構

```
src/index.ts               — 合併入口（config + migration + 三子系統 + stats/heartbeat）
src/db/                    — driver + migrations + crawler query 層（queries/、store、types）
src/crawler/ptt/           — PTT 協定層：index/article/cls/hotboards parser、fetcher、rate limiter、url
src/crawler/crawl/         — 編排：discovery、backfill、incremental、backoff、util（mapLimit）
src/repo/                  — 讀側查詢（articles/boards 卡片、insights 讀寫）
src/llm/client.ts          — OpenAI-compatible client（retry + content-filter 偵測）
src/insight/               — prompt + JSON 解析 + worker（offpeak/fallback loop）
src/server/                — Bun.serve 路由 + app.css（plain CSS）
src/views/                 — HTML 模板（PTT 黑底風 + 淺色 /boards）+ helpers（esc/顏色class/Taipei 時間）
tests/                     — in-memory SQLite + Bun.serve stub（零外部依賴）
testdata/*.html            — 真實 PTT fixtures（parser contract；hotboards 的 nUser 是即時值，斷言要結構性）
scripts/backup.sh          — SQLite 線上備份（wal_checkpoint + .backup + integrity_check + 7 天輪替）
```

## 測試

```bash
bun test          # 92 tests；in-memory SQLite，不可能碰 production
bunx tsc --noEmit # typecheck
```

- parser fixture-based（parse 錯不 crash 而是靜默寫壞資料 → 最高風險層）
- LLM/stub server 測 retry 矩陣；crawl 編排 smoke test 走並行路徑（concurrency=3）
- 不測：src/index.ts 接線（E2E 手動驗證）

## 部署與運維（lab 機，CachyOS）

- **正式實例**：`~/ptt-insight`（git checkout；`ptt.db` = 生產資料 ~1.3GB）
- **`ptt-insight.service`**：env 在 `/etc/ptt-insight.env`（root:600，含 LLM key；**改 key 用 python 寫入，sed 對 `KEY=` 行靜默失敗過**）；SIGTERM 優雅關閉、`Restart=on-failure`
- **`ptt-backup.timer`**：每天 04:00 `~/ptt-insight/scripts/backup.sh`（`Persistent=true`），restic → pCloud
- 部署流程：repo push → `cd ~/ptt-insight && git pull` → `sudo systemctl restart ptt-insight` → `journalctl -u ptt-insight --since '-15s'` 確認三子系統起來
- 常用診斷：
  ```bash
  systemctl status ptt-insight && curl -s localhost:8088/healthz   # 活著 + 分析進度
  journalctl -u ptt-insight -f                                     # stats 每分鐘一條
  sqlite3 ~/ptt-insight/ptt.db "SELECT count(*) FROM articles WHERE last_fetched_at > unixepoch()-300;"
  ```

## 已知坑與教訓

- **`trg_boards_set_updated_at` trigger 會讓 `run().changes` 虛報兩倍**（trigger 內 UPDATE 也計入）— 需要真實計數就 SELECT 先數
- **單事件循環是吞吐瓶頸**：cheerio parse + 同步 SQLite 寫在事件循環上序列化；`CRAWL_CONCURRENCY=3` 只移除網路閒置（1.48→1.73/s，預算 5/s）。再往上要 batch writes 或拆 process（未做）。**但瓶頸是分檔的**（2026-08-16 實測）：incremental 為主的時段 CPU 幾乎 0%、真正卡的是排程（殭屍 claim 卡水位前進、靜態速率分帳借不過去）——已修（claim 暫停即釋放 + 雙桶讓渡）；純 backfill 突發時事件循環上限才會觸頂
- **HTML 模板一律 `esc()`**（templ 自動轉義的手動等價物）；attribute 位置也要
- SQLite `DESC` 天然 NULLS last；by-name 取 row 時**表達式欄位必須 alias**（`AS has_insight`）
- 測試曾連 production DB + TRUNCATE 清空 34 小時資料（Go 時代）— 這是全面改 in-memory 測試的原因
- Z.AI 1302 (429) 來自併發爆發（batch=10 無界 Promise.all）— 已用 semaphore + client 退避解決
- 舊 PG 遺產（可刪）：`~/ptt/data/`、`~/ptt/backups/*.dump`；ptt-crawler 本地已刪，歷史在 github.com/newlix/ptt-crawler（tombstone `17e91d7`）

## 演進

Go + PostgreSQL（docker）→ TS + Bun + SQLite（2026-08，為 Cloudflare D1 可攜性；`scripts/migrate-from-pg.ts` 已驗證 306K articles/6.8M pushes 全數一致）→ ptt-crawler 合併進 ptt-insight 成單一 service（2026-08-16）。
