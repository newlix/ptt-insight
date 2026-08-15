import type { HotBoard } from "../ptt/hotboards.ts";
import { esc, nuserColor } from "./helpers.ts";

// PTT-official-website-clone layout (black background, fixed top bar).

export function pttLayout(title: string, board: string, children: string): string {
  const boardCrumb = board !== ""
    ? `<span class="crumb-sep">&rsaquo;</span><a href="/bbs/${esc(board)}/index.html" class="crumb-board"><span class="crumb-board-label">看板 </span>${esc(board)}</a>`
    : "";
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${esc(title)}</title>
<link rel="stylesheet" href="/static/app.css"/>
</head>
<body class="ptt-font ptt-body">
<div class="ptt-topbar"><div class="ptt-topbar-inner">
<a href="/" class="topbar-home">批踢踢實業坊</a>
${boardCrumb}
<a href="https://www.ptt.cc/contact.html" class="topbar-link topbar-right">聯絡資訊</a>
<a href="https://www.ptt.cc/about.html" class="topbar-link topbar-right">關於我們</a>
</div></div>
${children}
</body>
</html>`;
}

function hotBoardsActionBar(): string {
  return `<div class="ptt-container ptt-pt40">
<div class="actionbar">
<a href="/" class="ab-btn ab-active">熱門看板</a><a href="https://www.ptt.cc/cls/1" class="ab-btn">分類看板</a>
</div>
</div>`;
}

export function hotBoardsPage(boards: HotBoard[]): string {
  const rows = boards.map(hotBoardRow).join("");
  return pttLayout("熱門看板 - 批踢踢實業坊", "", `${hotBoardsActionBar()}
<div class="ptt-container ptt-pt10">${rows}</div>`);
}

function hotBoardRow(b: HotBoard): string {
  return `<a href="/b/${esc(b.name)}" class="hotboard-row">
<div class="hb-name">${esc(b.name)}</div>
<div class="hb-nuser ${nuserColor(b.nUserClass)}">${b.nUser}</div>
<div class="hb-class">${esc(b.class)}</div>
<div class="hb-title">${esc(b.title)}</div>
</a>`;
}

export function boardNotCollectedPage(name: string): string {
  return pttLayout(
    `看板 ${name} - 批踢踢實業坊`,
    name,
    `${hotBoardsActionBar()}
<div class="ptt-container ptt-pt40 ptt-px2">
<div class="notcollected-title">此看板尚未收錄：${esc(name)}</div>
<div class="notcollected-back"><a href="/">‹ 返回熱門看板</a></div>
</div>`,
  );
}
