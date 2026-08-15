import type { ArticleCard, Board } from "../repo/articles.ts";
import {
  esc,
  netBadge,
  sentimentBadge,
  controversyBadge,
  relativeTime,
  topBoards,
} from "./helpers.ts";

// Light "zinc" layout — used by the legacy /boards page (Reddit-style list).

export function layout(title: string, boards: Board[], children: string): string {
  const nav = topBoards(boards, 8)
    .map((b) => `<a href="/b/${esc(b.name)}" class="nav-board">${esc(b.name)}</a>`)
    .join("");
  return `<!DOCTYPE html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${esc(title)} — PTT Insight</title>
<link rel="stylesheet" href="/static/app.css"/>
</head>
<body class="light-body">
<header class="light-header">
<div class="light-header-inner">
<a href="/" class="brand"><span class="brand-mark">▲</span><span>PTT Insight</span></a>
<nav class="light-nav">${nav}</nav>
<div class="light-nav-right"><a href="/boards">所有看板</a></div>
</div>
</header>
<main class="light-main">${children}</main>
<footer class="light-footer">資料來源：www.ptt.cc · AI 分析由 GLM-5.2 提供 · 僅供參考</footer>
</body>
</html>`;
}

export function articleCard(a: ArticleCard): string {
  const nb = netBadge(a.netCount);
  const boardBadge = `<a href="/b/${esc(a.boardName)}" class="board-chip">${esc(a.boardName)}</a>`;
  const sentiment = a.hasInsight && a.sentiment !== null
    ? `<span class="pill ${sentimentBadge(a.sentiment).cls}">${esc(sentimentBadge(a.sentiment).text)}</span>`
    : "";
  const controversy = a.hasInsight && a.controversy !== null && a.controversy !== ""
    ? `<span class="pill ${controversyBadge(a.controversy).cls}">${esc(controversyBadge(a.controversy).text)}</span>`
    : "";
  const tldr = a.hasInsight && a.tldr !== null && a.tldr !== ""
    ? `<div class="tldr"><span class="tldr-mark">✦</span><p>${esc(a.tldr)}</p></div>`
    : !a.hasInsight
      ? `<p class="pending">AI 分析中…</p>`
      : "";
  const community = a.hasInsight && a.communityTake !== null && a.communityTake !== ""
    ? `<div class="community"><span class="community-mark">💬</span><p>${esc(a.communityTake)}</p></div>`
    : "";
  const tags = a.tags.length > 0
    ? `<div class="tags">${a.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join("")}</div>`
    : "";
  const author = a.author !== null ? `<span>${esc(a.author)}</span>` : "";
  const push = a.pushCount !== null ? `<span class="push-c">推 ${a.pushCount}</span>` : "";
  const boo = a.booCount !== null && a.booCount > 0 ? `<span class="boo-c">噓 ${a.booCount}</span>` : "";

  return `<article class="card">
<div class="card-vote"><span class="${nb.cls}">${esc(nb.text)}</span><span class="card-vote-label">推噓</span></div>
<div class="card-body">
<div class="card-meta">${boardBadge}${sentiment}${controversy}<span class="meta-time">${esc(relativeTime(a.postedAt))}</span></div>
<a href="/a/${a.id}" class="card-title-link"><h2 class="card-title">${esc(a.title)}</h2></a>
${tldr}${community}${tags}
<div class="card-foot">${author}${push}${boo}</div>
</div>
</article>`;
}

export function articleList(articles: ArticleCard[], page: number, totalPages: number, baseURL: string): string {
  const cards = articles.map(articleCard).join("");
  let pager = "";
  if (totalPages > 1) {
    const prev = page > 1 ? `<a href="${esc(baseURL)}?page=${page - 1}" class="pager-btn">上一頁</a>` : "";
    const next = page < totalPages ? `<a href="${esc(baseURL)}?page=${page + 1}" class="pager-btn">下一頁</a>` : "";
    pager = `<div class="pager">${prev}<span class="pager-info">${page} / ${totalPages}</span>${next}</div>`;
  }
  return `<div class="card-list">${cards}</div>${pager}`;
}
