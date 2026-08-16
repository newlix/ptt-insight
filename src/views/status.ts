import type { StatusData } from "../repo/status.ts";
import { esc } from "./helpers.ts";
import { pttLayout } from "./ptt.ts";

// /status — operational dashboard (public aggregates).

function row(label: string, value: string, note = ""): string {
  return `<div class="status-row"><span class="status-label">${esc(label)}</span><span class="status-value">${esc(value)}</span>${note === "" ? "" : `<span class="status-note">${esc(note)}</span>`}</div>`;
}

function bar(pct: number): string {
  const w = Math.max(0, Math.min(100, Math.round(pct)));
  const cls = pct >= 95 ? "tl-neg" : "tl-pos";
  return `<div class="tl-bar"><span class="${cls}" style="width:${w}%"></span></div>`;
}

export function statusPage(d: StatusData): string {
  const budgetPct = (d.credits7d / d.weeklyBudget) * 100;
  const drainDays = d.last24h > 0 ? Math.round((d.pendingEligible / d.last24h) * 10) / 10 : Infinity;
  const eta = Number.isFinite(drainDays) ? `${drainDays} 天` : "—";

  const body = `<div class="ptt-container status-page">
<div class="entity-head"><span class="entity-title">系統狀態</span><span class="entity-kind">[即時]</span></div>
<div class="status-grid">
${row("v2 分析總數", String(d.v2Total))}
${row("v1 待回流", String(d.v1Remaining))}
${row("可分析積壓（>7 天）", String(d.pendingEligible), `排完 ETA ≈ ${eta}`)}
${row("年齡門內（<7 天）", String(d.pendingGated), "刻意排除，pre-launch")}
${row("小時產能", String(d.last1h), "近 1 小時")}
${row("日產能", String(d.last24h), "近 24 小時")}
${row("錯誤冷卻", String(d.errorCooldown), "近 1 小時失敗數")}
${row("今日看板日報", String(d.digestsToday))}
${row("資料庫大小", `${d.dbSizeMB} MB`)}
</div>
<div class="entity-section">Z.AI credits（離峰估計，GLM-5.3 級距 ×0.5）</div>
<div class="status-row status-credit">
<span class="status-label">近 24 小時</span><span class="status-value">${d.credits24h.toLocaleString()}</span>
</div>
<div class="status-row status-credit">
<span class="status-label">近 7 天</span><span class="status-value">${d.credits7d.toLocaleString()} / ${d.weeklyBudget.toLocaleString()}</span>
</div>
${bar(budgetPct)}
<div class="status-note">週額度使用率 ${Math.round(budgetPct)}%${budgetPct >= 95 ? " — 已貼近上限" : ""}</div>
</div>`;
  return pttLayout("系統狀態 - 批踢踢實業坊", "", body);
}
