# 任務 6 — 假刪除風暴修復（vanish detection 硬化 + 復活 + 資料復原）（2026-08-16）

## 緣起（[measured] 本 session 取證）

resume 後發現 healthz `total` 異常 → sqlite 對 backup + journal 取證。
時間線注意：journal 時間戳為 local（+08）、DB deleted_at 以 UTC 解讀。
- 假刪除並非單一事件：08-14 前 3 篇 → 08-15 15,337 → **08-16 56,228+**
  （修復部署前持續 ~100/min）。高峰 local 11:00 = 35,262 篇/小時
  —— 正是任務 4 部署（10:47 restart → 全部活躍板立即到期被掃）後的第一小時。
- 受害者：**C_Chat 29,477 / Marginalman 5,265**（08-16 04:00 backup 差分）
  + local 11:00 起擴及 movie/SportLottery/Baseball 等（journal `deleted:` 行）。
- **根因（curl 實證）＝置底文**：C_Chat page-1 尾部帶 2 個月老的置底文
  （`M.1780992084` ≈ −68d），movie page-1/2 同款。原啟發式
  「ts > page-1 oldest 且不在頁上 = 已刪除」在置底文板完全反轉：
  oldest = 數月前 → 所有滑落的近期文章全是候選；驗證頁（第二新頁）的
  prevOldest 同樣被置底文污染 → 灰區消失 → 全數誤刪。
- 次要觸發：stale/部分 index 快照（local 02:55/10:55 dorm 板同分鐘全部
  "new articles found" = PTT 異常快照）→ 暫態候選暴增。
- 放大器：restart 後所有板立即到期（35K/小時主因）；任務 4 的 5× 檢查頻率（次因）。
- **無復活路徑**：upsert 不清 deleted_at、getArticleByBoardUrlID 不濾 deleted →
  文章重新出現在 index 上也不會復原（錯殺 = 永久）。
- 軟刪除資料本體仍在 live DB（content/pushes/insights 完整）→
  復原 = 清 deleted_at，不需回滾 backup（backups/ 00:35/01:12/04:00 三份，
  04:00 份不含 WAL 僅供參考）。

## 設計（防護層次：快照複核 → 矛盾界 → 滑落邊界 → 量護欄 → 復活）

### 卡 6.1 — vanish detection 硬化 + 復活
`detectVanishedArticles` 重寫（v1 先擋量、v2 補置底文根因）：
1. **Stage 1 快照複核**：candidates > 0 時**重抓最新頁**重算；重算後為空 →
   log 返回（暫態 stale 自癒）。抓取失敗 → 返回（寧可不刪）。
2. **Stage 2 矛盾界**：候選 ts > 快照 newest → 快照無法裁決該文（健康頁必然
   列出更新文 = 快照 stale）→ 剔除。置底文對 max 無效，界線穩定。
3. **Stage 3 滑落邊界**：抓第二新頁，以**其 newest entry** 為 pages 1–2 覆蓋
   邊界（置底文是古代時間戳，污染不了 max）。在第二新頁上 → 滑落未刪；
   ts ≤ 邊界 → 超出覆蓋灰區不動；否則刪。抓取失敗 → 返回。
4. **Stage 4 量護欄**：narrowed candidates > `VANISH_GUARD_MAX`（=100）→
   `console.error` 拒絕 + 返回（真實版規清除極少 >100/檢查窗）。
- **復活**：`processBoardIncremental` 既有文章分支 — `existing.deletedAt` 且
  entry 在最新頁 → `resurrectArticle`（清 deleted_at）+ log。文章出現在 index
  = 存在於 PTT 的直接證據。`updateArticlePushes` 的 NotFoundError→
  markArticleDeleted（直接 404）維持不變。
- 測試（deletion.test.ts）：stale 快照矛盾界（150 候選全數 > 快照 newest → 0 刪）、
  置底文板（邊界內 VICTIM 刪、邊界外 RESCUED/OLDSTORED 活）、narrowed 護欄
  （150 候選介於邊界與 newest → 拒絕）、暫態 stale、驗證頁失敗、Stage1 失敗、
  復活；既有 4 測試（真刪除/滑落/灰區/偵測）語意保留全過。

### 卡 6.2 — E2E 重現 + docs
- 以 testutil 真 Bun.serve 模擬「03:00 現場」：seed 板 + 已存文章、首抓 stale
  快照 → 斷言 0 刪除；fresh 下真刪除正常。併入 deletion.test.ts
  （同一 harness，不另開 script）。
- CLAUDE.md 已知坑 + 本事件一段；PROGRESS 記錄。

### 卡 6.4 — refuter rework（GAP1/3/4）
refuter FAIL 後的三項加固：
1. **Stage 5 ground truth**：刪除前逐一 fetch 該文 URL — 404 才 markArticleDeleted；
   200 → 保留 + warn（stale snapshot 分歧以 URL 為準）。殺死「stale verify 頁
   在護欄下漏 ~60/檢查」的洞（GAP1）。
2. **insertArticle ON CONFLICT 清 deleted_at**：成功抓取文章頁 = 存在的直接
   證據；深頁文章從此有復活路徑（backfill window sweep 重掃即自癒）（GAP3）。
3. 鑑別測試：Stage2 矛盾界（50 候選 > snapshot newest、無 Stage2 必刪）、
   URL-alive 不刪、upsert 復活（GAP4 + 新路徑）。

### 卡 6.3 — milestone：refuter + commit + push + 部署（程式碼）
- refuter 診證（餵本節錄 + acceptance）。
- commit（含前置 housekeeping：移除意外產生的空檔 `0`、補送 PROGRESS.md
  既有 3 行 lesson）+ push。
- 部署正式實例（pull + restart + journal 驗證啟動）。

## 資料復原（已執行，2026-08-16 16:13）

使用者 16:08 批准。安全措施：`backups/deleted_at_snapshot_20260816_1608.db`
（71,609 列 id/board/url/deleted_at 快照，2.7MB，完全可逆）。執行時精煉邊界：
**保留 ≥15:04（v2/v3 代碼）的刪除標記**（URL/boundary 已驗證的真刪，1 筆），
只清壞代碼時代：
```sql
UPDATE articles SET deleted_at = NULL
 WHERE deleted_at BETWEEN 1786762800 AND 1786863849;  -- 71,601 rows, 0.63s
```
結果：total deleted = 8（7 baseline + 1 SportLottery 真刪）；C_Chat live 46,327、
Marginalman live 43,870；healthz total 32,069 → **41,955**；服務持續運行、
0 誤刪。深頁真刪文殘留可見（可接受保真誤差，修復版偵測會對覆蓋內者重新標記）。

[measured] 08-15 11:00 local（epoch 1786762800）之前全庫僅 **7** 筆刪除 —
假刪除時代涵蓋全部 71,601+ 筆（08-16 15:10 實測；修復部署後新增 ≈ 0）。
正確述詞 = 復原全部風暴期刪除（不限 C_Chat/Marginalman — movie/SportLottery/
Baseball/HatePolitics 等同受災）：
```sql
-- 核對（預期 ~71,601，隨時間僅微增）
SELECT count(*) FROM articles WHERE deleted_at >= 1786762800;
-- 執行（單一 UPDATE 原子，可運行中執行；保留 7 筆真 baseline）
UPDATE articles SET deleted_at = NULL WHERE deleted_at >= 1786762800;
```
復原後：修復版偵測會對仍在 pages 1–2 覆蓋內的真刪文重新標記（自癒）；
深頁文章本為真實存在文，殘留可見屬可接受保真誤差。eligible 影響實測
+229（31,497→31,726 — 受災集中低淨推文閒聊文）。

## 驗收（每卡 machine-checkable）
- 6.1/6.2：`bun test` 全綠（+≥5 測試）+ `bunx tsc --noEmit` exit 0 +
  `rg -q VANISH_GUARD_MAX src/crawler/crawl/incremental.ts`。
- 6.3：git sha 入 LEDGER + `systemctl is-active --quiet ptt-insight`。

## 不修（評估後排除）
- 備援 WAL 完整性（backup 腳本另行處理，非本卡範圍）。
- backoff 在異常快照下的 reset 行為（次要放大器；Stage 1 複核已切斷刪除路徑）。
- 歷史真刪文與風暴刪文的逐篇區分（不可能，接受深頁殘留）。

---

# 任務 4 — 提高爬文頻率（2026-08-16）

## 緣起

使用者要求「提高爬文的頻率」。[measured] 現行 per-board incremental 排程：
`backoff.ts` 硬編碼 `MIN_INTERVAL_SECS=600`（有新文 → 10 分鐘後再查）、
`MAX_INTERVAL_SECS=604800`（沒新文 → interval×2 上限 7 天）；不可由 env 調。
全域 request 速率由 `RATE_LIMIT`（預設 3 req/s，incremental 40%）cap，與檢查間隔無關 —
檢查間隔決定「多快發現新文/推文變化」，速率限制決定吞吐，兩者獨立。

## 設計

- `nextInterval(currentSecs, newArticles, minSecs=MIN, maxSecs=MAX)` 參數化；
  常數改名語意不變（仍 export 供測試引用）。
- `runIncremental`/`processBoardIncremental` 加可選 `minIntervalSecs`/`maxIntervalSecs`
  （預設 = 常數），既有測試呼叫簽名不破。
- `index.ts` 新 env：`INCREMENTAL_MIN_SECS`（預設 **120s，5× 更頻繁**）、
  `INCREMENTAL_MAX_SECS`（預設 7d 不變）；envSecs 支援 Go duration（"2m"）；邊界 clamp
  min≥1、max≥min。啟動 log 帶出。
- DB 無需遷移：活躍板下次「有新文」檢查即 reset 到新 floor（600→120 自動收斂）；
  安靜板維持 backoff。schema DEFAULT 600 只影響新板首輪，不改（migration append-only 原則）。
- Request 量影響評估 [inferred]：增量全落在 index 頁（活躍板每 10min 多 4 次輕量檢查）；
  文章頁抓取量不變（同樣的文章終究要抓，只是延遲下降）；全域 limiter 仍 cap。

## 任務卡

### 卡 4.1 — backoff 參數化 + 新預設 + env 接線
backoff.ts、incremental.ts、index.ts 三檔 + backoff.test.ts（自訂 min/max 案例、
更新常數表）+ incremental.test.ts（新文後 interval reset 到傳入 min 的斷言）。
- 驗收：`bun test` 全綠（新增 ≥2 測試）；`bunx tsc --noEmit` exit 0；
  `rg INCREMENTAL_MIN_SECS src/index.ts` 有接線。

### 卡 4.2 — 實機 E2E + docs 同步
- E2E：`DB_PATH=/tmp/... RUN_WORKER=0 RUN_WEB=0 SKIP_DISCOVERY=1` 跑 ~75s（真實 PTT、
  temp DB），`sqlite3 "SELECT count(*) FROM boards WHERE check_interval_secs=120"` > 0，
  console 出現 `reset interval to 120s`。
- CLAUDE.md：env 表 +2 行、「Crawler 策略」10min→2min 描述、測試數對齊；
  docs/PROGRESS.md 記錄。
- 驗收：rg 檢查 docs 一致；E2E 輸出留存。

## 里程碑

`refuter` 訛證（餵本節錄）。綠後 commit + push + 部署（~/ptt-insight pull →
systemctl restart → journalctl 確認啟動行帶新 interval）。

---

# 任務 5 — 排程三修：backfill 卡死 + 份額讓渡（2026-08-16）

## 緣起（[measured] 本 session 診斷）

使用者問「管線卡在哪」，實測發現（CPU 0 ticks/5s、RTT 16ms、吞吐 ~1.6/5 req/s）：
1. **backfill 全子系統閒置**：156 熱板中 154 已達水位邊界，2 板（C_Chat、Marginalman）
   在 10:47 領 claim、掃完 200 頁批次後 **claim 未釋放**（`backfillBoard` 只有
   reachedBoundary 路徑 release，breadth-first 暫停路徑不釋放，backfill.ts:101）→
   6h 排斥鎖卡到 16:47 → `advanceBackfillWindow` 要求全部到位 → 全體 idle（log
   "backfill idle"）→ backfill 的 3.0 req/s 份額整段閒置。
2. **incremental 吃滿自己 2.0 req/s**（394 活躍板需求 > 份額；單迴圈序列），
   而靜態 40/60 分帳（index.ts）讓 backfill 閒置份額借不過去。
3. CLAUDE.md 記載的「事件循環 1.7/s 天花板」此刻非瓶頸（CPU 0%）——先修排程。

## 設計

### 卡 5.1 — claim 生命週期修正
- `backfillBoard`：批次暫停路徑（`!reachedBoundary && endPage > 1`）加
  `releaseBackfillClaim`。
- **錯誤路徑不釋放**（desk-check 修正）：持續失敗的板若釋放 claim 會變成
  claim→fail→release→claim 迴圈；6h 排斥正是壞板的 cool-off 機制，維持原行為。
  SIGTERM 中斷由啟動時 `releaseOrphanedClaims` 收尾。
- 語意不變：claim 的用途是「批次進行中防止並發重掃」；批次正常結束（完成/暫停）
  即釋放，resume 靠 `last_backfill_page`。
- 部署時 `releaseOrphanedClaims`（啟動）會清掉 production 現有 2 個殭屍 claim。

### 卡 5.2 — 雙桶 limiter（backfill 閒置時讓渡份額）
- `rate_limiter.ts` 加 `CombinedLimiter`（序列 await 多個桶）。
- `FetcherOptions` 加 `limiter?: RateLimiter` 覆寫（預設行為不變）。
- index.ts：`global = RateLimiter(RATE_LIMIT)`、`backfillCap = RateLimiter(0.6R)`；
  backfill fetcher = Combined(backfillCap, global)，incremental fetcher = global。
  數學：backfill ≤ min(0.6R, R)；incremental 保證 ≥ 0.4R、backfill 閒置時可用滿 R；
  全域總量恆 ≤ RATE_LIMIT（禮貌上限不變）。discovery 沿用 backfill fetcher（仍被 sub-cap）。
- 不做：動態調 share 的 env（無需求）；Fix B「水位前進忽略 claimed 板」——5.1 已除根因，
  B 會改變 pacing 語意（板正當掃描中就推進水位），不需要。

### 卡 5.3 — E2E + 里程碑
- E2E 兩階段：temp DB 跑 90s（hotboard 探索+首輪 backfill）→ SIGTERM → 以 SQL 種出
  「stall 現場」（1 板 claimed 1h 前 + floor 高於邊界、其餘板 floor=邊界、window_bottom 存在）
  → 重啟 120s → 斷言：重複 `backfill batch:` 該板、無 `backfill idle`、（若掃到）`window
  boundary`/`window advanced`、且該板 claim 在批次間為 NULL。
- docs（CLAUDE.md：Crawler 策略 + 已知坑）、PROGRESS、refuter、部署正式實例。

## 驗收（每卡 machine-checkable）
- 5.1/5.2：`bun test` 全綠（各 +≥1 測試）+ `bunx tsc --noEmit` exit 0。
- 5.3：E2E 輸出留檔；refuter PASS；正式實例 journal 顯示 backfill 恢復工作。

---

# SPEC — 改善整個 codebase（ptt-insight）

日期：2026-08-16 · Baseline：`bun test` 83 pass / `bunx tsc --noEmit` 乾淨 / git clean。

## 範圍

使用者要求「改善整個 codebase」。經全面 read-only 審查（37 檔 / 3,767 行 TS + migrations + tests），
排除風格 nit 與「合理設計選擇」後，收斂為 5 張卡。不做：大重構、新功能、schema 遷移
（`article_insights.reply_count` 為 PG 遺產欄位，但 migration 是 append-only，留著無害）。

## 審查證據（load-bearing 發現）

1. **[measured] `/healthz` 與 worker 閾值不一致**：`src/repo/insights.ts` `insightStats()`
   硬編碼 `net_count >= 20`；worker 實際用 `WORKER_MIN_NET`（env 可調）。操作者調高閾值後
   healthz 的 `total`（分母）會虛報。→ 卡 1
2. **[measured] incremental 每次檢查對每篇既有文章寫 no-op UPDATE**：
   `src/crawler/crawl/incremental.ts` `processBoardIncremental` 對 nrec 未變的文章仍呼叫
   `updateNrecOnly` → `UPDATE articles SET nrec_raw=?, mark=?`。20K 板 × 每板數十篇 = 每日
   百萬級無意義 WAL 寫入，加重 CLAUDE.md 記載的「單事件循環是吞吐瓶頸」。→ 卡 2
3. **[measured] dead code ~150 行**（rg 全 repo 僅自身/測試引用）：
   `src/crawler/ptt/nrec.ts`（parseNrec）、`repo/articles.ts` `listHotArticles`、
   `views/layout.ts` `articleCard`/`articleList`（~70 行）、`repo/insights.ts` `lastInsightTime`、
   `db/queries/boards.ts` `getPendingBackfillBoards`。→ 卡 3
4. **[inferred] 穩健性缺口**：(a) `fetcher.ts` 5xx/4xx 分支未 drain response body（連線池衛生，
   PTT 404 常見）；(b) `index.ts` `main()` 無 catch（啟動期 exception → unhandled rejection）、
   stats timer 每 tick 重複 `db.prepare`；(c) `server.ts` `renderBoard` 先查文章後才檢查
   `p > total`（白查）；(d) `backfill.ts` 本地 `emptyToNull` 與 `db/types.ts` 重複。→ 卡 4
5. **[measured] docs 漂移**：CLAUDE.md 記「83 tests」、檔案結構列 nrec.ts — 卡 1–4 落地後需同步。→ 卡 5

已考慮但**不修**（避免為修而修）：
- worker fallback ping-pong（filter-blocked 文章 1h 週期重試）：1301 拒絕不燒 token，節奏可接受。
- `processClaim` 部分失敗回傳 0 → 多睡 30s：pacing 選擇，非正確性問題。
- `advanceBackfillWindow` 雙 worker 連續推進：推導後守衛條件使其只在「所有板已覆蓋更深」時發生，屬正確行為。
- hotboards `HotBoardsCache.get(signal)` 把請求 signal 傳進 inflight fetch：內部服務可接受。
- board 頁搜尋框無功能：PTT clone 的外觀還原，刻意。

## 任務卡

### 卡 1 — healthz minNet 一致性（bug fix）
`insightStats(db, minNet = 20)` 參數化；`ServerOptions` 加 `minNet`；`index.ts` 傳 `workerMinNet`。
- 驗收：新增測試 — minNet=5 時 total 只計 net_count≥5；`/healthz` 反映設定值；`bun test` + `bunx tsc --noEmit` 全綠。

### 卡 2 — incremental 跳過 no-op UPDATE（perf）
抽 `indexMetaChanged(existing: Article, entry: IndexEntry): boolean`（nrec 或 mark 有變才 true；
比對用 emptyToNull 正規化）。`processBoardIncremental` 只在變化時呼叫 `updateNrecOnly`。
- 驗收：新測試覆蓋 4 案例（不變/nrec 變/mark 變/空字串 vs null）；`bun test` + `tsc` 全綠。

### 卡 3 — dead code 移除
刪：`nrec.ts`+其測試、`listHotArticles`+其測試段、`articleCard`/`articleList`、`lastInsightTime`、`getPendingBackfillBoards`（含 interface 宣告）。
- 驗收：`rg -n "parseNrec|listHotArticles|articleCard|articleList|lastInsightTime|getPendingBackfillBoards" src tests` 零輸出；`bun test` + `tsc` 全綠。

### 卡 4 — 穩健性小修 bundle
(a) fetcher 非 2xx 分支 drain body（`resp.body?.cancel()` 容錯）；(b) `main().catch` 設 exitCode 1 + stats statements 提升為 prepared；(c) renderBoard 先檢查頁界再查詢；(d) backfill.ts 改用 db/types 的 `emptyToNull`。
- 驗收：`bun test` + `tsc` 全綠；fetcher retry 既有測試仍綠。

### 卡 5 — docs 同步
CLAUDE.md：測試數、檔案結構（刪 nrec.ts 行）、insightStats minNet 說明；寫 docs/PROGRESS.md。
- 驗收：`rg -n "nrec.ts" CLAUDE.md` 零輸出；CLAUDE.md 中測試數與 `bun test` 實際輸出一致。

## 驗證計畫

- 每卡：`bun test` + `bunx tsc --noEmit`（machine-checkable）。
- Milestone：`refuter` recipe 訛證（餵本 SPEC 節錄）。
- 實機驗證：暫存 DB + `RUN_CRAWLER=0 RUN_WORKER=0` 起 web，curl `/healthz` 與首頁比對預期輸出。

---

# 任務 3 — 設計差異全修（2026-08-16）

## 緣起

使用者指示 "fix all"。原審計差異清單（D1–D13）僅存於對話未落地，故本 SPEC 以官方基準
（/tmp/ptt_bbs-{common,base,custom}.css v2.27 + /tmp/ptt_{index,board,article}.html，
皆本機可驗證）重新推導差異並全數列修。範圍：PTT clone 主題（.ptt-body 族）；
legacy light /boards 主題不動。產品功能零變更（僅視覺/結構）。

## 差異清單（重推導；官方值 ← clone 現值）

中（3）：
- F1 action bar 非 fixed：官方 `#action-bar-container{position:fixed;top:0;padding:40px 0 0 0;background:#000;z-index:98}` + 內容 `action-bar-margin{margin-top:40px}`。clone 為 static。
- F2 斷點 640→800：官方 desktop `@media(min-width:800px)` / mobile `max-width:799px`。僅 PTT 主題改；light 主題 640/768/1024 不動。
- F3 看板 metaline `top:40px`→`0`（官方 `.article-metaline-right{top:0}`，與作者行同高）。

小（重推導，全修）：
- F4 標題連結 hover：官方全局 `a:hover{background:#ccc;color:#333}`、`a:visited{#888}`（`.r-list .title a` 規則因官方 HTML 無 .r-list 祖先而不生效 → 標題色 #aaa 已正確）。clone hover bg#aaa/color#999 → 改 bg#ccc/color#333，補 :visited #888。
- F5 Inconsolata：官方 base.css @import 該字型且 `.r-ent .author/.mark` 用 `Inconsolata,serif|sans-serif`。clone 未載字型、author 僅 serif、mark 無字型。
- F6 topbar：右側連結 DOM 順序（官方 關於我們 在前=float right 後最右）、padding 0 5px（logo 0 10px）、desktop 字級 24px（#topbar.bbs-content）、右鏈/label `font-size:small`、z-index 99、`> *`（含 › span）inline-block/line-height 40px。
- F7 文章行高：官方 `.bbs-screen{line-height:100%}` → clone 1.2/24px 改 1。
- F8 r-ent 版模：官方 float 模型 — nrec `width:4ex;float:left;font-family:serif;padding:.5ex 0 0 0`、title/meta display:block、mobile `margin-left:5ex;margin-right:2ex`、desktop `margin:1ex 0;padding:.5ex 0;background:#111` + title `margin:0 5ex` meta `margin-left:5ex`、`> *{font-size:20px}`、date `min-width:6ex`+serif、mark `width:2ex`+bold+Inconsolata、meta 子項 padding .5ex 0、mark/date `float:right;margin-left:5px`。clone grid 37px/1fr/46px + padding-left 9px → 改官方模型（HTML 去 r-title-container 包裹與空第三欄，nrec/title/meta 為 r-ent 直接子元素）。author 去 flex/ellipsis（PTT id ≤12 字，信任內部資料）。
- F9 按鈕：mobile `padding:0 1ex;font-size:small`、desktop `0 2ex;font-size:initial`、wide 僅 desktop `0 3ex`。toolbar：mobile `text-align:center`、desktop left + `.btn-group-paging{float:right}`（去 flex+gap）。`.btn-group{font-size:0}`、相鄰 btn `margin-left:-1px`。home 加 `.btn-group-cls` 包裹（結構對齊官方）。
- F10 push：`.push-tag{min-width:3.5ex}`（去 24/38px 兩段式）、`.push-line>span{white-space:pre-wrap}`、view 端 `userId.padEnd(12)`（官方 12 字欄位；parser 已 trim）。
- F11 r18-notice：官方 over18 樣式 desktop `margin:20px` / mobile `padding:0 1ex`，去 text-align:center。內容保留（分級聲明，產品選擇）。
- F12 r-list-sep：`height:.5ex` 去 margin。
- F13 文章底栏加 `.bar` 分隔（4px #888）。
- F14 metaline tag/value `padding:0 1ex`（原 0 9px）。
- F15 移除 article-gap（官方 metaline 後直接接內文）。
- F16 hotboard：desktop 欄寬改 ex 制（name 20ex/class 6ex/nuser 9ex+`padding-right:1ex`、name `padding-left:1ex`）、mobile class/title `font-size:small`、name `padding:0 1ex`、nuser `padding:.5ex 1ex`。
- F17 按鈕 :visited 補 `color:#ddd`（官方 .btn:link,.btn:visited）。
- F18（跳過聲明）官方每列 article-menu（⋯ dropdown）不重製：無搜尋後端，做死 UI 反而違背意圖；記錄為刻意差異。

## 任務卡

### 卡 9 — 套用 F1–F17（app.css + ptt.ts + board.ts + article.ts）
- 驗收：`bun test` + `bunx tsc --noEmit` 全綠；`rg "min-width: 640" src/server/app.css` 僅剩 light 主題區（PTT 區全 800）；`rg "r-title-container|article-gap" src` 零輸出；curl 渲染輸出含 `btn-group-cls`、push userid 欄位對齊（padEnd 生效）。

### 卡 10 — 實機渲染驗證
- designcheck 起 seeded server；curl 三頁型結構斷言；playwright 1280/390 截圖與官方並排；computed-style probe：topbar 高 40、action bar fixed(z-index 98)、metaline-right top 0、author 字型 Inconsolata。

### 卡 11 — milestone：refuter 訛證 + commit + push
- 餵本節錄；PASS 後 commit（單一 commit：design parity fixes）+ push origin/main。

## 里程碑後記（refuter 兩輪）

- 第一輪 FAIL（實質缺陷）：F13 `.bar` 空 inline-block baseline 對齊 → 底栏 54px/分隔條上浮 14px。
  修法：`.article-bottombar .ptt-container{height:40px}` + 子項 `vertical-align:middle`（官方
  `#navigation` 同款護欄）。designverify F13 改幾何斷言（nav h=40、bar h=40、Δtop=0）。
- 同輪補修：F19 mobile toolbar 滿寬伸展（官方 custom.css 33%/66%/50%/25%/100% + nowrap，
  probe btnW/barW=0.5）；r-mark text-align right（官方 .r-ent .meta .mark 覆蓋）；
  designverify 四處寬鬆下界改區間帶。
- 第二輪（聚焦四修）VERDICT: PASS — 含桌面 ≥800 無伸展外漏的獨立 computed probe、
  逐帶可證偽性確認。
