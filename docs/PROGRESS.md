# PROGRESS — ptt-insight codebase improvement (2026-08-16)

## 敘事

Baseline：83 tests / tsc clean / git clean。全面 read-only 審查（37 檔）後立 5 卡（docs/SPEC.md），
全部完成。84 tests / tsc clean 收尾。

---

# 任務 4 — 提高爬文頻率（2026-08-16）

## 範圍與落地

使用者「提高爬文的頻率」。瓶頸不在吞吐（`RATE_LIMIT` 早已可調）而在 per-board 檢查
floor：`backoff.ts` 硬編碼 600s，活躍板最快 10 分鐘才回查。

- `MIN_INTERVAL_SECS` 600→**120**（活躍板 2 分鐘一查，5× 更快發現新文/推文變化）；
  `nextInterval` 參數化 min/max，`runIncremental`/`processBoardIncremental` 傳遞。
- 新 env：`INCREMENTAL_MIN_SECS`（預設 120）/`INCREMENTAL_MAX_SECS`（預設 7d），
  支援 Go duration；啟動 log 帶 `board-check: 120s-604800s`。
- DB 零遷移：活躍板下次有新文即自動收斂 600→120；安靜板維持 backoff。
- Request 量增量僅 index 頁（活躍板 +4 檢查/10min），文章頁抓取量不變；
  全域 limiter 仍 cap 於 `RATE_LIMIT`。

## 驗證

- `bun test` 88 pass / 0 fail（+2：backoff custom bounds、interval resets to floor）、
  `bunx tsc --noEmit` exit 0。
- verifier（獨立重跑）：4/4 PASS（wiring 全鏈 index→runIncremental→nextInterval）。
- E2E 實機（真實 PTT、temp DB、75s）：啟動行 `board-check: 120s-604800s`、
  console 7× `reset interval to 120s`、DB `check_interval_secs=120` 共 7 板
  （log 留 /tmp/crawl-freq-e2e.log）；SIGTERM 優雅關閉。

## 教訓

- 測試傳 stale board snapshot 給 processBoardIncremental：`setBoardInterval` 後必須
  重取 row（production 的 claimNextBoard 本來就是 fresh row）— 第一次寫測試踩到，
  received 120 vs expected 7200 即此因。

## 完成卡

1. **healthz minNet 一致性**：`insightStats(db, minNet=20)` 參數化、`ServerOptions.minNet`、
   index.ts 傳 `workerMinNet`。修掉「操作者調 WORKER_MIN_NET 後 /healthz total 虛報」。
2. **incremental no-op UPDATE 消除**：新增 `indexMetaChanged(existing, entry)` 閘門
   （nrec 或 mark 有變才寫）。原本每板每次檢查對每篇既有文章都寫一次 UPDATE —
   20K 板規模下是每日百萬級無意義 WAL 寫入，直接加重單事件循環瓶頸。
3. **dead code 移除 ~190 行**：nrec.ts（parseNrec）、listHotArticles、articleCard/articleList、
   lastInsightTime、getPendingBackfillBoards、netBadge/sentimentBadge/controversyBadge/Badge、
   splitLines。repo.test 改用 listBoardArticles 保住 insight join 覆蓋。
4. **穩健性**：fetcher 非 2xx drain body（404 常見，連線池衛生）；`main().catch` + exit 1；
   stats statements 提出迴圈只 prepare 一次；renderBoard 先查頁界再查文章；emptyToNull 去重。
5. **docs 同步**：CLAUDE.md 測試數 83→86、檔案結構移除 nrec/badge 字樣、WORKER_MIN_NET 註明 healthz 同門檻。

## Milestone 驗證

- 實機：暫存 DB 起 web（crawler/worker 關）— `/healthz` JSON 正常、not-collected 頁、CSS 200、
  **live hotboards 從 www.ptt.cc 抓到 98 列完整 render**。
- refuter（GLM-5.2 同級訛證）：**PASS**。其指出 3 個測試覆蓋 gap（非缺陷），已補 2：
  mark-only 變更整合測試（證明閘門單靠 mark 變化就寫回且不觸發重抓）、`?page` 越界 404 測試。
  drainBody 連線池效應 headless 難直接斷言，留間接覆蓋。
- 最終：**bun test 86 pass / 0 fail**、`bunx tsc --noEmit` exit 0。

## 收尾（2026-08-16 resumed session）

- 提交前本 session 重驗：86 pass / 0 fail、tsc exit 0（grounding）。
- commit fb574e7（5 卡改善：18 files, +138/−205）+ 0b79581（docs/SPEC、PROGRESS、designcheck.ts）。
- push：`ee93aa7..0b79581 main -> main`。`.fable/` 加入 .gitignore 留 local。

## 教訓（本 session）

- edit 工具 before/after 方向搞反會「復活」想刪的函式（卡 3 lastInsightTime 短暫重複兩份）— 
  刪除操作後要 grep 確認目標真的只剩零份。
- 測試數增減要能拆帳：84 = 85 − nrec.test(1) − badges(1) + nuserColor(1)，對得上才是乾淨的刪除。

## 未做（評估後排除，見 SPEC「不修」清單）

fallback ping-pong、processClaim 部分失敗 pacing、advanceBackfillWindow 雙 worker、
hotboards cache signal 傳遞、搜尋框外觀、reply_count 欄位（append-only migration 留置）。

---

# 任務 2 — PTT web design 遵循度審計（2026-08-16）

## 範圍

使用者要求：檢查 clone 網站有沒有 follow PTT web design（https://www.ptt.cc/bbs/index.html）。
唯讀審計 + 實機渲染證據；**不改產品碼**（差異只回報，修不修由使用者決定）。

## 基準（[measured] 皆於本 session 抓取）

- 官方三頁型：/bbs/index.html（熱門看板）、/bbs/Baseball/index.html（看板列表）、
  文章頁 M.1786814018.A.59D.html；CSS v2.27（bbs-common/base/custom），存 /tmp/ptt_*。
- 比對標的：src/views/{ptt,board,article,helpers}.ts + src/server/app.css 的 PTT clone 主題
  （legacy light /boards 頁非 clone，明確排除）。

## 卡

### 卡 A1 — 審計 + 渲染證據
scripts/designcheck.ts：seed 記憶體 DB（含 insight）+ fixture hotboards → Bun.serve →
curl 三頁型取渲染輸出，與官方基準逐項比對（結構/class/顏色/字型/尺寸/行為）。
- 驗收：差異清單每項附雙邊證據（官方 CSS/HTML 行 vs clone CSS/HTML 行或 curl 輸出）；
  報告交付使用者。

## 結果（卡 7 完成）

**結論：高度遵循（視覺還原 ~95%）。** 3 中等差異（action bar 未 fixed、斷點 640 vs 800、
看板 metaline top:40px）+ 10 minor。證據：curl 三頁型渲染輸出、playwright 官方/clone
並排截圖（1280px+390px）、官方 computed-style probe（確認 `.r-list .title a` 不生效 →
官方標題實為 #aaa，clone 正確）。無產品碼變更；probe script 留 scripts/designcheck.ts
可重跑。偏差聲明：未跑 refuter — 唯讀審計、無碼變更，所有論斷皆以機械證據
（curl 輸出/截圖/computed style）落地。

---

# 任務 3 — 設計差異全修（2026-08-16）

## 範圍

使用者 "fix all" 審計差異。原 D1–D13 僅存對話 → 以 /tmp 官方基準重推導為 F1–F18（SPEC 任務 3），
全部落地 + refuter 兩輪。範圍僅 PTT clone 主題；light 主題零波及。

## 卡

- 卡 9：app.css 重寫 PTT 主題為官方 v2.27 模型（fixed action bar、800px 斷點、float r-ent、
  Inconsolata @import、ex 單位、金屬線 1ex、push 3.5ex+padEnd(12)、topbar 順序/字級、
  按鈕 1ex/2ex 兩段、bar 分隔條、r18/清單sep 官方樣式）+ 三視圖結構對齊。
- 卡 10：scripts/designverify.ts 29 checks（computed style + CSSOM + 邊界 799/800）→ 29/29。
- 卡 11：refuter 兩輪 — 第一輪 FAIL 抓到 F13 底栏 54px 回歸（真缺陷）+ 3 gaps，全修
  （vertical-align:middle 護欄、F19 mobile 伸展、mark right、斷言帶化）；第二輪 PASS。

## 教訓

- 空 inline-block 的 baseline = 底緣：加裝飾性空元素（.bar）進文字行箱會撐高 fixed bar —
  官方 CSS 的 vertical-align:middle 護欄不是風格，是必要條件。
- parseFloat 對 "0px Xpx" shorthand 回 0 — 斷言要用單邊屬性（paddingRight）或 split。
- 群組選擇器 selectorText 是整串 — CSSOM 查表要 contains，不能精確鍵。
- 背景 refuter 任務要給「只查差異、立刻輸出 verdict」的緊範圍，否則會燒滿自己的 turn 上限。
