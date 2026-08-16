import type { AuthorArticle } from "../repo/authors.ts";
import { esc, articleTime } from "./helpers.ts";
import { pttLayout } from "./ptt.ts";

// /u/:author — all hot-board articles by one PTT ID.

export function userPage(author: string, stats: { boards: number; total: number; netSum: number }, articles: AuthorArticle[]): string {
  const rows = articles
    .map(
      (a) => `<div class="entity-article">
<a class="ea-title" href="/bbs/${esc(a.boardName)}/${esc(a.urlId)}.html">${esc(a.title)}</a>
<div class="ea-meta">
<a class="ea-board" href="/bbs/${esc(a.boardName)}/index.html">${esc(a.boardName)}</a>
<span class="ea-date">${a.postedAt !== null ? esc(articleTime(a.postedAt)) : "?"}</span>
<span>推 ${a.pushCount} 噓 ${a.booCount} net ${a.netCount}</span>
</div>
${a.tldr !== null && a.tldr !== "" ? `<div class="ea-tldr">${esc(a.tldr)}</div>` : ""}
</div>`,
    )
    .join("");

  const body = `<div class="ptt-container user-page">
<div class="entity-head"><span class="entity-title">${esc(author)}</span><span class="entity-kind">[作者]</span></div>
<div class="entity-section">熱門看板發文：共 ${stats.total} 篇 · 橫跨 ${stats.boards} 板 · 總推數 ${stats.netSum}</div>
<div class="entity-articles">${rows === "" ? `<div class="search-empty">熱門看板內沒有這個 ID 的發文</div>` : rows}</div>
</div>`;
  return pttLayout(`${author} 的發文 - 批踢踢實業坊`, "", body);
}
