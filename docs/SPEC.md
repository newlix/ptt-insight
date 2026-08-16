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
