import type { BoardWithDigest } from "../repo/digests.ts";
import { esc, relativeTime } from "./helpers.ts";
import { pttLayout } from "./ptt.ts";

// /digest — latest board digests (one LLM call per hot board per day).

export function digestPage(boards: BoardWithDigest[]): string {
  const withDigest = boards.filter((b) => b.digest !== null);
  const sections = withDigest
    .map(
      (b) => `<div class="digest-board">
<a class="digest-board-name" href="/bbs/${esc(b.boardName)}/index.html">${esc(b.boardName)}</a>
<span class="digest-meta">${b.day} · ${b.articleCount} 篇 · ${b.generatedAt !== null ? esc(relativeTime(b.generatedAt)) : ""}</span>
<div class="digest-text">${esc(b.digest!)}</div>
</div>`,
    )
    .join("");
  const body = `<div class="ptt-container digest-page">
<div class="entity-head"><span class="entity-title">看板日報</span><span class="entity-kind">[AI]</span></div>
<div class="entity-section">熱門看板近 24 小時新分析摘要（每板每日一次生成）</div>
<div class="digest-list">${sections === "" ? `<div class="search-empty">日報生成中 — 等分析累積後每小時補位</div>` : sections}</div>
</div>`;
  return pttLayout("看板日報 - 批踢踢實業坊", "", body);
}
