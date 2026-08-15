import type { ArticleCard, Board } from "../repo/articles.ts";
import { esc, boardPageHref, pttDate, nrecClass, splitPinned } from "./helpers.ts";
import { pttLayout } from "./ptt.ts";

// PTT board article list (index.html clone with paging buttons).

export function pttBoardPage(board: Board, articles: ArticleCard[], page: number, totalPages: number): string {
  const dirBtns = `<div class="btn-group-dir">
<a href="${esc(boardPageHref(board.name, totalPages, page))}" class="ptt-btn ptt-btn-active">看板</a><a href="https://www.ptt.cc/man/${esc(board.name)}/index.html" class="ptt-btn">精華區</a>
</div>`;

  const oldest = page < totalPages
    ? `<a href="${esc(boardPageHref(board.name, totalPages, totalPages))}" class="ptt-btn ptt-btn-wide">最舊</a><a href="${esc(boardPageHref(board.name, totalPages, page + 1))}" class="ptt-btn ptt-btn-wide">&lsaquo; 上頁</a>`
    : `<span class="ptt-btn ptt-btn-wide ptt-btn-disabled">最舊</span><span class="ptt-btn ptt-btn-wide ptt-btn-disabled">&lsaquo; 上頁</span>`;
  const newer = page > 1
    ? `<a href="${esc(boardPageHref(board.name, totalPages, page - 1))}" class="ptt-btn ptt-btn-wide">下頁 &rsaquo;</a>`
    : `<span class="ptt-btn ptt-btn-wide ptt-btn-disabled">下頁 &rsaquo;</span>`;
  const pagingBtns = `<div class="btn-group-paging">${oldest}${newer}<a href="${esc(boardPageHref(board.name, totalPages, 1))}" class="ptt-btn ptt-btn-wide">最新</a></div>`;

  const { pinned, normal } = splitPinned(articles);
  const rows = normal.map((a) => rEnt(a, board.name)).join("");
  const pinnedRows = pinned.length > 0
    ? `<div class="r-list-sep"></div>${pinned.map((a) => rEnt(a, board.name)).join("")}`
    : "";

  return pttLayout(
    `看板 ${board.name} 文章列表 - 批踢踢實業坊`,
    board.name,
    `<div class="ptt-container ptt-pt40">
<div class="board-toolbar">${dirBtns}${pagingBtns}</div>
<div class="ptt-pt10">
<div class="search-box"><input type="text" name="q" placeholder="搜尋文章⋯" class="query"/></div>
${rows}${pinnedRows}
</div>
<div class="r18-notice">本網站已依台灣網站內容分級規定處理。此區域為限制級，未滿十八歲者不得瀏覽。</div>
</div>`,
  );
}

function rEnt(a: ArticleCard, board: string): string {
  const nrec = a.nrecRaw !== null && a.nrecRaw !== "" ? `<span class="${nrecClass(a.nrecRaw)}">${esc(a.nrecRaw)}</span>` : "";
  const author = a.author !== null ? `<div class="r-author">${esc(a.author)}</div>` : `<div class="r-author"></div>`;
  return `<div class="r-ent">
<div class="nrec">${nrec}</div>
<div class="r-title-container">
<div class="r-title"><a href="/bbs/${esc(board)}/${esc(a.urlId)}.html">${esc(a.title)}</a></div>
<div class="r-meta">${author}<div class="r-date">${esc(pttDate(a.postedAt))}</div><div class="r-mark">${esc(a.mark ?? "")}</div></div>
</div>
<div></div>
</div>`;
}
