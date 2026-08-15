import type { Board } from "../repo/articles.ts";
import { esc } from "./helpers.ts";
import { layout } from "./layout.ts";

export function boardsListPage(boards: Board[], allBoards: Board[]): string {
  const items = boards
    .map((b) => {
      const title = b.title !== null && b.title !== ""
        ? `<span class="boards-title">${esc(b.title)}</span>`
        : "";
      return `<a href="/bbs/${esc(b.name)}/index.html" class="board-item">
<div class="board-item-name"><span class="board-item-name-text">${esc(b.name)}</span>${title}</div>
<span class="board-item-count">${b.articleCount}</span>
</a>`;
    })
    .join("");
  return layout("所有看板", allBoards, `<h1 class="boards-h1">所有看板</h1><div class="boards-grid">${items}</div>`);
}
