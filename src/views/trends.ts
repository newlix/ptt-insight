import type { TrendingEntity, RisingArticle, VelocityBucket } from "../repo/trends.ts";
import { hotProbability } from "../repo/trends.ts";
import { esc, relativeTime } from "./helpers.ts";
import { pttLayout } from "./ptt.ts";

// /trends — trending entities + link to /rising.
// /rising — fresh articles by push velocity with calibrated 爆 probability.

function pct(p: number): string {
  return `${Math.round(p * 100)}%`;
}

export function trendsPage(entities: TrendingEntity[]): string {
  const maxScore = Math.max(...entities.map((e) => e.h48 * 2 + e.d7), 1);
  const rows = entities
    .map((e, i) => {
      const score = e.h48 * 2 + e.d7;
      const w = Math.round((score / maxScore) * 100);
      return `<div class="trend-row">
<span class="trend-rank">${i + 1}</span>
<a class="trend-name" href="/e/${encodeURIComponent(e.nameNorm)}">${esc(e.name)}</a><span class="entity-kind">[${esc(e.kind)}]</span>
<div class="tl-bar"><span class="tl-pos" style="width:${w}%"></span></div>
<span class="trend-counts">7天 ${e.d7} · 48h ${e.h48}</span>
</div>`;
    })
    .join("");

  const body = `<div class="ptt-container trends-page">
<div class="entity-head"><span class="entity-title">話題趨勢</span><span class="entity-kind">[7天]</span><a class="topbar-link" href="/rising" style="margin-left:auto">爆文預測 →</a></div>
<div class="entity-section">AI 分析實體的聲量排行（長度=熱度：48 小時 ×2 加權 + 7 天量）</div>
<div class="trend-list">${rows === "" ? `<div class="search-empty">趨勢資料累積中 — 每小時隨分析更新</div>` : rows}</div>
</div>`;
  return pttLayout("話題趨勢 - 批踢踢實業坊", "", body);
}

export function risingPage(articles: RisingArticle[], calib: VelocityBucket[]): string {
  const rows = articles
    .map((a) => {
      const p = hotProbability(calib, a.vph);
      const w = Math.min(100, Math.round(p * 100));
      const ageH = Math.max(0.5, (Date.now() / 1000 - a.postedAt) / 3600);
      return `<div class="rise-row">
<a class="ea-title" href="/bbs/${esc(a.boardName)}/${esc(a.urlId)}.html">${esc(a.title)}</a>
<div class="ea-meta">
<span class="ea-board">${esc(a.boardName)}</span>
<span>${esc(relativeTime(a.postedAt))}</span>
<span>推 ${a.pushCount} 噓 ${a.booCount} net ${a.netCount}</span>
<span>${a.vph.toFixed(1)} 推/時（${ageH.toFixed(1)}h）</span>
</div>
<div class="rise-prob"><div class="tl-bar"><span class="tl-pos" style="width:${w}%"></span></div><span class="rise-pct ${p >= 0.5 ? "c-f1" : "c-f3"}">${pct(p)}</span></div>
</div>`;
    })
    .join("");

  const calibNote = calib.length > 0
    ? `歷史校準：${calib.map((c) => `${c.bucketVph}+推/時 → ${pct(c.pHot)}(${c.n})`).join("，")}`
    : "歷史校準資料累積中（機率顯示為保守值）";

  const body = `<div class="ptt-container rising-page">
<div class="entity-head"><span class="entity-title">爆文預測</span><span class="entity-kind">[12h]</span><a class="topbar-link" href="/trends" style="margin-left:auto">← 話題趨勢</a></div>
<div class="entity-section">12 小時內新文章按推文速度排序；爆文機率 = 同速度區間文章的歷史爆率（net ≥ 90）</div>
<div class="entity-articles">${rows === "" ? `<div class="search-empty">目前沒有上升中的文章</div>` : rows}</div>
<div class="rise-calib">${esc(calibNote)}</div>
</div>`;
  return pttLayout("爆文預測 - 批踢踢實業坊", "", body);
}
