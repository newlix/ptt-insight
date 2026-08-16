# PROGRESS — ptt-insight codebase improvement (2026-08-16)

---

# 任務 6 — 假刪除風暴修復（2026-08-16）

## 發現過程

resume 巡檢發現 healthz total 異常下降 → backup 對照取證。關鍵校正：
journal 時間戳是 local（+08）、DB deleted_at 以 UTC 解讀 — 首輪「03:00 風暴、
服務停機期間外部刪除」的推論是時區錯覺；真實時間線：**任務 4 部署（10:47
restart → 全板立即到期）後 local 11:00 一小時 35,262 篇假刪**，修復部署前
持續 ~100/min。**根因 = 置底文**（curl 實證 C_Chat page-1 尾帶 −68d 置底文）：
「ts > page-1 oldest = 未滑落」啟發式在置底文板反轉，驗證頁 prevOldest 同被
污染 → 灰區消失 → 全刪。08-15 已 15,337 篇（同機制低頻版）。

## 落地

- v1（14:55 緊急部署止血）：Stage1 重抓複核 + `VANISH_GUARD_MAX=100` 護欄。
  部署即證：0 刪除（原 ~100/min），護欄連續攔下 SportLottery/movie/
  BaseballXXXX/Baseball 的 1.6K–4K 候選（= 舊碼正在執行的誤刪集合）。
- v2（根因修）：Stage2 矛盾界（候選 ts > 快照 newest → 快照 stale 剔除）、
  Stage3 滑落邊界改用**第二新頁 newest**（置底文污染不了 max）、Stage4 護欄
  移到 narrowed 之後（置底文板不再永久噴 refusal）。
- v3（refuter FAIL rework）：Stage5 ground truth — 刪除前逐一 fetch 文章 URL，
  404 才刪、200 保留（殺 stale-verify 漏洞）；insertArticle ON CONFLICT 清
  deleted_at（成功抓取 = 存在；深頁自癒路徑）；鑑別測試 +3。
- refuter round 2：CLAIM1「no index-snapshot path can forge a deletion」/
  CLAIM2 復活可達性（backfillBoard→processArticle→insertArticle）皆驗證過；
  唯一殘留 = upsert 測試 vacuous（listing 復活先跑）→ 改 processArticle 直驅
  + mutation 證明（移除 clause 測試轉紅）。102 pass / 0 fail。
- `resurrectArticle`：文章重現 index → 清 deleted_at。
- 測試 97→102，既有 4 測語意保留。
- refuter round 1 FAIL 的 GAP2（復原述詞過窄）：已改為 `deleted_at >=
  1786762800`（08-15 11:00 local 起 = 假刪除時代全部，保留 7 筆真 baseline；
  受災面 Marginalman 35.5K/C_Chat 34.2K/HatePolitics 1.7K/…），待使用者批准。

## 待辦

- 復原 SQL（使用者批准）：resurrect 08-15 11:00 起全部假刪（修復版偵測會對真刪文
  重新標記，自癒）。
- drip 機制確認：≤100/檢查的慢滴假刪（若有）依賴 Stage3 驗證攔截 — 部署後觀察。

# （原敘事）

## 敘事

Baseline：83 tests / tsc clean / git clean。全面 read-only 審查（37 檔）後立 5 卡（docs/SPEC.md），
全部完成。84 tests / tsc clean 收尾。

---

# 任務 5 — 排程三修：backfill 卡死 + 份額讓渡（2026-08-16）

## 緣起

使用者「管線卡在哪」→ 實測診斷（CPU 0 ticks/5s、RTT 16ms、吞吐 1.6/5 req/s）：
backfill 整個子系統因 2 個殭屍 claim（批次掃完未釋放、6h 排斥鎖住、擋住水位前進）
而 idle；incremental 吃滿靜態 40% 份額而 backfill 閒置份額借不過去。

## 落地

- **claim 生命週期**：批次暫停路徑即 `releaseBackfillClaim`（resume 靠 last_backfill_page）；
  錯誤路徑刻意不釋放（6h 排斥=壞板 cool-off，避免 claim→fail→release 焦土迴圈——
  desk-check 攔下的原設計錯誤）。
- **雙桶 limiter**：全域桶(RATE_LIMIT) + backfill 子桶(60%)，backfill 每請求消耗兩桶、
  incremental 只耗全域桶 → incremental 保證 ~40%、backfill 閒置時可借滿全域；
  全域總量恆 ≤ RATE_LIMIT。`FetcherOptions.limiter` 可覆寫，`CombinedLimiter` 序列取 token。
- Fix B（水位前進忽略 claimed 板）評估後不做：5.1 已除根因，B 會改 pacing 語意。

## 驗證

- `bun test` 92 pass / 0 fail（+3：rate_limiter burst 數學、claim pause 釋放+可立即 re-claim）、
  tsc exit 0。
- E2E stall 重現（/tmp/sched-e2e-p{1,2}.log）：seed 2 板 claimed 1h 前 + floor 高於邊界
  （完全仿 production 卡死現場）→ 重啟 150s → `released 2 orphaned`、`backfill idle` 0 次、
  6 次 `backfill start`、被鎖的 BaseballXXXX 實際被掃（6 頁/107 篇，crawl_run 為證）。

## 教訓

- 殭屍鎖的根因常是「成功路徑忘了釋放」而非「搶鎖邏輯錯」；錯誤路徑的鎖保留反而可能是
  對的（cool-off），兩者要分開推。
- E2E 種現場要忠於 production 數據形狀：window_bottom 在 fresh DB 是 migration 種的
  （非 NULL），假時間戳的 fixture 板要先把邊界調低才模擬得出 mid-window 狀態。
- close-guard 把 `(acceptance: …)` 當 shell 指令機械重跑：acceptance 欄只能放可重跑指令，
  中文敘述/一次性輸出放 evidence 段。耐久指令（git sha / 測試套件 / repo 檔案）優先於
  /tmp 證據（重開機即失效會卡死未來收尾）。

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
