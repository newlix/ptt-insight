import type { AuthorArticle, UserPush, PushStats } from "../repo/authors.ts";
import { esc, articleTime } from "./helpers.ts";
import { pttLayout } from "./ptt.ts";

// /u/:author — hot-board articles + push footprint for one PTT ID.

export function userPage(
  author: string,
  stats: { boards: number; total: number; netSum: number },
  articles: AuthorArticle[],
  pushStats: PushStats,
  pushes: UserPush[],
): string {
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

  const pushRows = pushes
    .map(
      (p) => `<div class="push-row">
<span class="push-tag tag-${p.tag === "推" || p.tag === "噓" ? p.tag : "arrow"}">${esc(p.tag)}</span>
<span class="push-user">${esc(author)}</span>
<span class="push-content">${esc(p.content ?? "")}</span>
<a class="push-article" href="/bbs/${esc(p.boardName)}/${esc(p.urlId)}.html">↦ ${esc(p.articleTitle)}</a>
</div>`,
    )
    .join("");

  const articlesSection = stats.total > 0
    ? `<div class="entity-section">發文（最新 ${articles.length} 篇）</div>
<div class="entity-articles">${rows}</div>`
    : "";

  const pushesSection = pushStats.total > 0
    ? `<div class="entity-section">推文足跡 — 共 ${pushStats.total} 則（推 ${pushStats.pushCount} · 噓 ${pushStats.booCount} · → ${pushStats.arrowCount} · 橫跨 ${pushStats.boards} 板），最新 ${pushes.length} 則</div>
<div class="push-footprint">${pushRows}</div>`
    : "";

  const body = `<div class="ptt-container user-page">
<div class="entity-head"><span class="entity-title">${esc(author)}</span><span class="entity-kind">[使用者]</span></div>
<div class="entity-section">熱門看板發文：共 ${stats.total} 篇 · 橫跨 ${stats.boards} 板 · 總推數 ${stats.netSum}</div>
${articlesSection}
${pushesSection}
${stats.total === 0 && pushStats.total === 0 ? `<div class="search-empty">熱門看板內沒有這個 ID 的發文或推文</div>` : ""}
</div>`;
  return pttLayout(`${author} 的發文 - 批踢踢實業坊`, "", body);
}
