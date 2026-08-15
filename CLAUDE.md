# PTT Insight

PTT 官網 clone（[熱門看板](https://www.ptt.cc/bbs/hotboards.html) + 看板列表 + 文章頁均為 PTT 風格），
AI 分析（GLM）產出 TL;DR / 社群觀點 / 精選推文 / 情緒 / 爭議度 / 標籤。

## 架構

```
ptt-crawler (~/ptt, systemd) → ptt.db (SQLite, WAL)
                                  ↑ 讀 articles/pushes/boards，只寫 article_insights
ptt-insight web + worker ────────┘ GLM 分析 → article_insights
```

- **同一顆 `ptt.db`**（WAL 允許跨 process 一寫多讀；crawler 寫文章、insight 寫分析表，互不阻塞）
- **Worker**：背景 loop，挑 `net_count` 降序未分析文章，文章 + 推文送 GLM，解析 JSON 存 `article_insights`；Z.AI content-filter（賭博/政治/色情）擋下的文章由 fallback provider（opencode proxy）重試
- **Web**：Bun.serve SSR（HTML template literal + `esc()` 轉義），plain CSS（無 Tailwind/框架）

## 技術棧

| 層 | 工具 |
|---|---|
| 語言 / runtime | TypeScript + Bun |
| DB | SQLite（`bun:sqlite`），讀 crawler 的 `ptt.db` |
| 樣式 | 手寫 CSS（`src/server/app.css`，PTT 官網黑底風 + 淺色 /boards） |
| LLM | OpenAI-compatible chat completions（GLM via Z.AI / opencode proxy） |

## 指令

```bash
bun install
bun test          # 34 tests（in-memory SQLite，零外部依賴）
bun src/index.ts  # 啟動 web + worker
```

## 環境變數

| 變數 | 預設 | 說明 |
|---|---|---|
| `ADDR` | `:8088` | 監聽位址（綁 127.0.0.1） |
| `DB_PATH` | `/home/newlix/ptt/ptt.db` | crawler 的 SQLite 路徑 |
| `RUN_WORKER` | `1` | `0` = 只跑 web |
| `LLM_BASE_URL` | `http://localhost:18905` | OpenAI-compatible endpoint |
| `LLM_API_KEY` | (空) | Bearer token |
| `LLM_MODEL` | `glm-5.2` | 模型名稱 |
| `FALLBACK_LLM_BASE_URL` | (空) | content-filter 被擋文章的重試 provider |
| `FALLBACK_LLM_MODEL` | `gpt-5.6-luna` | fallback 模型 |
| `WORKER_BATCH` | `10` | 每批分析篇數 |
| `WORKER_MIN_NET` | `20` | 只分析 `net_count >=` 此值的文章 |
| `WORKER_INTERVAL` | `0` | `0`=連續；`5m`=每 5 分鐘一批 |
| `WORKER_OFFPEAK` | `1` | 避開平日 14:00-18:00 UTC+8（Z.AI credit 半價時段外） |
| `PAGE_SIZE` | `30` | 每頁文章數 |
| `HOTBOARDS_TTL` | `1m` | 熱門看板快取 TTL（過期抓取失敗回 stale） |

## DB Schema（insight 自有表；migration 掛在 crawler 的 schema_migrations）

```sql
article_insights (
  article_id INTEGER UNIQUE FK→articles,
  tldr TEXT, community_take TEXT, top_comments TEXT,
  sentiment TEXT, controversy TEXT, tags TEXT/*JSON array*/,
  model TEXT, prompt_tokens INT, completion_tokens INT,
  generated_at INTEGER/*epoch 秒*/, error TEXT
)
```

AI 分析可重建 — 從 PG 遷移時不搬 `article_insights`，重新分析即可。

## 檔案結構

```
src/index.ts               — 入口（config + migration + worker + web）
src/db/                    — sqlite driver + insight migrations
src/repo/                  — raw SQL（articles/boards 讀取、insights 讀寫）
src/llm/client.ts          — OpenAI-compatible client（content-filter 偵測）
src/insight/               — prompt + JSON 解析 + worker（offpeak/fallback loop）
src/ptt/hotboards.ts       — 上游熱門看板抓取 + TTL cache（stale fallback）
src/server/                — Bun.serve 路由 + app.css
src/views/                 — HTML 模板（PTT 風 + 淺色風）+ helpers
tests/                     — bun test（in-memory SQLite + Bun.serve stub）
testdata/hotboards.html    — 真實上游 fixture（parser contract）
```

## 路由

| 路徑 | 說明 |
|---|---|
| `GET /` | 熱門看板（PTT 官網 clone，即時上游 + TTL 快取） |
| `GET /bbs/hotboards.html` | 同 `/`（PTT 原始路徑） |
| `GET /b/{board}` | 看板文章列表（淺色舊風格路由保留） |
| `GET /bbs/{board}/index.html` | 看板列表（PTT 風格；最新頁） |
| `GET /bbs/{board}/index{N}.html` | PTT 分頁語意（index1=最舊） |
| `GET /bbs/{board}/{url_id}.html` | 文章頁（PTT 風格 + AI 分析區塊） |
| `GET /a/{id}` | 同文章頁（DB id 別名） |
| `GET /boards` | 所有看板列表（淺色舊風格） |
| `GET /healthz` | 健康 + 分析進度 JSON |
| `GET /static/app.css` | CSS |

## 部署（lab 機）

- `ptt-insight.service`（systemd）：`RUN_WORKER=1`、`LLM_BASE_URL` 走 Z.AI API、fallback 走 opencode proxy；SIGTERM 優雅關閉
- 依赖 ptt-crawler.service 的 `~/ptt/ptt.db`（先啟動 crawler）
