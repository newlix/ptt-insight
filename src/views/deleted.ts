import type { DeletedArticle } from "../repo/deleted.ts";
import { esc, articleTime, relativeTime } from "./helpers.ts";
import { pttLayout } from "./ptt.ts";

// /deleted — soft-deleted article archive, grouped by deletion day, newest first.

export function deletedPage(articles: DeletedArticle[]): string {
  const byDay = new Map<string, DeletedArticle[]>();
  for (const a of articles) {
    const day = a.deletedAt !== null
      ? new Date(a.deletedAt * 1000 + 8 * 3600 * 1000).toISOString().slice(0, 10)
      : "未知";
    const list = byDay.get(day) ?? [];
    list.push(a);
    byDay.set(day, list);
  }

  const sections = [...byDay.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .map(([day, list]) => {
      const rows = list
        .map(
          (a) => `<div class="del-article">
<div class="del-title">${esc(a.title)}</div>
<div class="del-meta">
<span class="del-board">${esc(a.boardName)}</span>
<span>${a.author !== null ? esc(a.author) : "?"}</span>
<span>發文 ${a.postedAt !== null ? esc(articleTime(a.postedAt)) : "?"}</span>
<span>刪於 ${a.deletedAt !== null ? esc(relativeTime(a.deletedAt)) : "?"}</span>
<span>推 ${a.pushCount} 噓 ${a.booCount} net ${a.netCount}</span>
</div>
${a.tldr !== null && a.tldr !== "" ? `<div class="del-tldr">◎ ${esc(a.tldr)}</div>` : ""}
${a.contentExcerpt !== "" ? `<div class="del-excerpt">${esc(a.contentExcerpt)}${a.contentExcerpt.length >= 300 ? "…" : ""}</div>` : ""}
</div>`,
        )
        .join("");
      return `<div class="del-day">${esc(day)}（${list.length} 篇）</div>${rows}`;
    })
    .join("");

  const body = `<div class="ptt-container deleted-page">
<div class="entity-head"><span class="entity-title">刪文存檔</span><span class="entity-kind">[mirror]</span></div>
<div class="entity-section">本站留存的被刪除文章 — PTT 官網已看不到；高推刪文是本站獨家紀錄</div>
<div class="entity-articles">${sections === "" ? `<div class="search-empty">目前沒有刪文紀錄</div>` : sections}</div>
</div>`;
  return pttLayout("刪文存檔 - 批踢踢實業坊", "", body);
}
