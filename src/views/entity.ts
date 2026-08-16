import type { EntityArticle, TimelinePoint } from "../repo/entities.ts";
import { esc, articleTime, sentimentClass, controversyClass } from "./helpers.ts";
import { pttLayout } from "./ptt.ts";

// Entity page: sentiment timeline (CSS bars, no JS) + recent analyzed articles.

export function entityPage(
  name: string,
  kind: string,
  timeline: TimelinePoint[],
  articles: EntityArticle[],
): string {
  const maxN = Math.max(...timeline.map((t) => t.articles), 1);
  const tl = [...timeline]
    .sort((a, b) => (a.day < b.day ? -1 : 1))
    .map((t) => {
      const totalPct = Math.round((t.articles / maxN) * 100);
      const posShare = (1 + t.sentiment) / 2; // 1 = all positive
      const posPct = Math.round(totalPct * posShare);
      const negPct = totalPct - posPct;
      const label = t.day.slice(5).replace("-", "/");
      return `<div class="tl-row"><span class="tl-day">${esc(label)}</span><div class="tl-bar"><span class="tl-pos" style="width:${posPct}%"></span><span class="tl-neg" style="width:${negPct}%"></span></div><span class="tl-count">${t.articles}</span></div>`;
    })
    .join("");

  const list = articles
    .map(
      (a) => `<div class="entity-article">
<a class="ea-title" href="/bbs/${esc(a.boardName)}/${esc(a.urlId)}.html">${esc(a.title)}</a>
<div class="ea-meta"><a class="ea-board" href="/bbs/${esc(a.boardName)}/index.html">${esc(a.boardName)}</a><span class="ea-date">${esc(articleTime(a.postedAt))}</span><span>推 ${a.netCount}</span>${a.sentiment !== null ? `<span>情緒 <span class="${sentimentClass(a.sentiment)}">[${esc(a.sentiment)}]</span></span>` : ""}${a.controversy !== null ? `<span>爭議 <span class="${controversyClass(a.controversy)}">[${esc(a.controversy)}]</span></span>` : ""}</div>
${a.tldr !== null && a.tldr !== "" ? `<div class="ea-tldr">${esc(a.tldr)}</div>` : ""}
</div>`,
    )
    .join("");

  const body = `<div class="ptt-container entity-page">
<div class="entity-head"><span class="entity-title">${esc(name)}</span><span class="entity-kind">[${esc(kind)}]</span><span class="entity-articles-count">${articles.length} 篇已分析</span></div>
<div class="entity-section">情緒時序（綠=正面佔比 / 紅=負面佔比 / 長度=文章數）</div>
<div class="entity-timeline">${tl === "" ? `<div class="search-empty">尚無時序資料</div>` : tl}</div>
<div class="entity-section">相關文章</div>
<div class="entity-articles">${list}</div>
</div>`;
  return pttLayout(`${name} - 批踢踢實業坊`, "", body);
}
