# SPEC — 改善整個 codebase（ptt-insight）

日期：2026-08-16 · Baseline：`bun test` 83 pass / `bunx tsc --noEmit` 乾淨 / git clean。

## 範圍

使用者要求「改善整個 codebase」。經全面 read-only 審查（37 檔 / 3,767 行 TS + migrations + tests），
排除風格 nit 與「合理設計選擇」後，收斂為 5 張卡。不做：大重構、新功能、schema 遷移
（`article_insights.reply_count` 為 PG 遺產欄位，但 migration 是 append-only，留著無害）。

## 審查證據（load-bearing 發現）

1. **[measured] `/healthz` 與 worker 門檻不一致**：`src/repo/insights.ts` `insightStats()`
   硬編碼 `net_count >= 20`；worker 實際用 `WORKER_MIN_NET`（env 可調）。操作者調高門檻後
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
