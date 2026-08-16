import type { EntityHit } from "../repo/entities.ts";
import { esc } from "./helpers.ts";
import { pttLayout } from "./ptt.ts";

// Entity search page: PTT-clone styled results list.

export function searchPage(q: string, hits: EntityHit[]): string {
  const results = hits
    .map(
      (h) => `<a class="entity-result" href="/e/${encodeURIComponent(h.nameNorm)}">
<span class="entity-name">${esc(h.name)}</span><span class="entity-kind">[${esc(h.kind)}]</span>
<span class="entity-count">${h.count} 篇</span></a>`,
    )
    .join("");
  const body = `<div class="ptt-container entity-search">
<div class="search-head">
<form action="/search" method="get" class="search-form">
<input class="search-input" type="text" name="q" value="${esc(q)}" placeholder="實體搜尋（遊戲／公司／人物…）"/>
<button class="search-btn" type="submit">搜尋</button>
</form>
</div>
<div class="entity-results">${results === "" ? `<div class="search-empty">${q === "" ? "輸入關鍵字搜尋文章分析的實體" : `沒有找到「${esc(q)}」相關的實體`}</div>` : results}</div>
</div>`;
  return pttLayout(`實體搜尋${q === "" ? "" : `：${q}`} - 批踢踢實業坊`, "", body);
}
