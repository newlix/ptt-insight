import type { ArticleDetail, Push } from "../repo/articles.ts";
import { esc, articleTime, sentimentClass, controversyClass, relativeTime } from "./helpers.ts";
import { pttLayout } from "./ptt.ts";

// PTT article page clone: metalines, content, pushes, AI block, bottom bar.

export function pttArticlePage(d: ArticleDetail): string {
  const content = d.content !== null ? `<div class="article-content">${esc(d.content)}</div>` : "";
  const ipLine = d.ip !== null && d.ip !== ""
    ? `※ 發信站: 批踢踢實業坊(ptt.cc), 來自: ${esc(d.ip)} (臺灣)`
    : `※ 發信站: 批踢踢實業坊(ptt.cc)`;
  const url = `https://www.ptt.cc/bbs/${d.boardName}/${d.urlId}.html`;
  const pushes = d.pushes.map(pushLine).join("");

  return pttLayout(
    `${d.title} - 看板 ${d.boardName} - 批踢踢實業坊`,
    d.boardName,
    `<div class="ptt-container ptt-pb56 article-page">
<div class="article-wrap">
<div class="metaline"><span class="article-meta-tag">作者</span><span class="article-meta-value">${esc(d.author ?? "")}</span></div>
<div class="metaline metaline-board"><span class="article-meta-tag">看板</span><span class="article-meta-value">${esc(d.boardName)}</span></div>
<div class="metaline"><span class="article-meta-tag">標題</span><span class="article-meta-value">${esc(d.title)}</span></div>
<div class="metaline"><span class="article-meta-tag">時間</span><span class="article-meta-value">${esc(articleTime(d.postedAt))}</span></div>
${content}
<div class="src-line">${ipLine}</div>
<div class="src-line">※ 文章網址: <a class="src-link" href="${esc(url)}">${esc(url)}</a></div>
${pushes}
${aiBlock(d)}
</div>
</div>
<div class="article-bottombar"><div class="ptt-container"><a href="/bbs/${esc(d.boardName)}/index.html" class="back-to-board">返回看板</a><div class="bar"></div></div></div>`,
  );
}

function aiBlock(d: ArticleDetail): string {
  if (!d.hasInsight) return "";
  const tldr = d.tldr !== null && d.tldr !== ""
    ? `<div><span class="ai-label">◎ 摘要　</span>${esc(d.tldr)}</div>`
    : "";
  const community = d.communityTake !== null && d.communityTake !== ""
    ? `<div><span class="ai-label">◎ 社群觀點　</span>${esc(d.communityTake)}</div>`
    : "";
  const topComments = d.topComments !== null && d.topComments !== ""
    ? `<div><span class="ai-label">▸ 精選推文</span><div class="top-comments">${d.topComments
        .split("\n")
        .filter((c) => c !== "")
        .map((c) => `<div class="top-comment">${esc(c.replace(/^「/, "").trim())}</div>`)
        .join("")}</div></div>`
    : "";
  const sentiment = d.sentiment !== null && d.sentiment !== ""
    ? `<span>情緒 <span class="${sentimentClass(d.sentiment)}">[${esc(d.sentiment)}]</span></span>`
    : "";
  const controversy = d.controversy !== null && d.controversy !== ""
    ? `<span>爭議 <span class="${controversyClass(d.controversy)}">[${esc(d.controversy)}]</span></span>`
    : "";
  const tags = d.tags
    .filter((t) => t !== "")
    .map((t) => `<span class="c-f3">#${esc(t)}</span>`)
    .join("");
  const modelLabel = d.model === null || d.model === ""
    ? ""
    : `${esc(d.model)}${d.insightGeneratedAt !== null ? ` · ${esc(relativeTime(d.insightGeneratedAt))}` : ""}`;

  return `<div class="ai-block">
<div class="ai-block-title">AI 分析</div>
<div class="ai-block-body">
${tldr}${community}${topComments}
<div class="ai-meta">${sentiment}${controversy}${tags}<span class="ai-meta-grow"></span><span class="ai-model">${modelLabel}</span></div>
</div>
</div>`;
}

function pushLine(p: Push): string {
  const tagClass = p.tag === "噓" || p.tag === "→" ? "c-f1" : "c-white";
  return `<div class="push-line">
<span class="push-tag ${tagClass}">${esc(p.tag)} </span>
<span class="c-f3">${esc(p.userId.padEnd(12))}</span>
<span class="push-content">: ${esc(p.content ?? "")}</span>
<span class="push-ipdatetime">${esc(p.ipDatetime ?? "")}</span>
</div>`;
}
