import type { Board } from "../repo/articles.ts";
import { esc, topBoards } from "./helpers.ts";

// Light "zinc" layout — used by the legacy /boards page.

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
