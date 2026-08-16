// E2E: run analyze() v2 against the real Z.AI coding endpoint on real articles.
// Read-only on prod DB (claims are SELECTs); nothing is stored.
// Usage: bun scripts/e2e_v2.ts [n_articles]
import { openDB } from "../src/db/sqlite.ts";
import { migrate } from "../src/db/migrate.ts";
import { claimPendingArticles } from "../src/repo/insights.ts";
import { analyze } from "../src/insight/analyze.ts";
import { LLMClient } from "../src/llm/client.ts";

const PROD_DB = process.env.E2E_DB ?? "/home/newlix/ptt-insight/ptt.db";
const N = Number(process.argv[2] ?? 6);

const db = openDB(PROD_DB);
migrate(db); // no-op when current (adds 0004 on first run — needed for claim SQL)

const fileCfg: Record<string, string> = {};
try {
  const env = (await Bun.file("/etc/ptt-insight.env").text())
    .split("\n")
    .map((l) => l.match(/^([A-Z_]+)=(.*)$/))
    .filter((m): m is RegExpMatchArray => m !== null);
  for (const m of env) fileCfg[m[1]!] = m[2]!;
} catch { /* no env file — rely on process env */ }
const cfg = fileCfg;
if (process.env.LLM_API_KEY) cfg.LLM_API_KEY = process.env.LLM_API_KEY;
if (process.env.LLM_BASE_URL) cfg.LLM_BASE_URL = process.env.LLM_BASE_URL;
if (process.env.LLM_MODEL) cfg.LLM_MODEL = process.env.LLM_MODEL;
if (!cfg.LLM_API_KEY || !cfg.LLM_BASE_URL || !cfg.LLM_MODEL) {
  console.error("missing credentials: pass LLM_API_KEY / LLM_BASE_URL / LLM_MODEL env (see /etc/ptt-insight.env)");
  process.exit(1);
}const client = new LLMClient(cfg.LLM_BASE_URL!, cfg.LLM_API_KEY!, cfg.LLM_MODEL!);
const articles = claimPendingArticles(db, N, 20);
console.log(`claimed ${articles.length} articles (db=${PROD_DB} model=${cfg.LLM_MODEL})`);

let pIn = 0, pOut = 0, lat = 0, ok = 0;
const fieldFilled = { article_type: 0, entities: 0, ad_likelihood: 0, factuality: 0, ai_generated: 0, push_stance: 0, push_facts: 0, qa_summary: 0 };
for (const a of articles) {
  const t0 = Date.now();
  try {
    const r = await analyze(client, a, cfg.LLM_MODEL!);
    const secs = (Date.now() - t0) / 1000;
    lat += secs; pIn += r.promptTokens; pOut += r.completionTokens; ok++;
    if (r.articleType !== "其他") fieldFilled.article_type++;
    if (r.entities.length > 0) fieldFilled.entities++;
    if (r.adLikelihood !== "無") fieldFilled.ad_likelihood++;
    if (r.factuality !== "觀點") fieldFilled.factuality++;
    if (r.aiGenerated !== "不確定") fieldFilled.ai_generated++;
    if (r.pushStance.pro + r.pushStance.con + r.pushStance.neutral > 0) fieldFilled.push_stance++;
    if (r.pushFacts !== "") fieldFilled.push_facts++;
    if (r.qaSummary !== "") fieldFilled.qa_summary++;
    console.log(`#${a.id} net=${a.netCount} ${secs.toFixed(1)}s in=${r.promptTokens} out=${r.completionTokens}`);
    console.log(`  類型=${r.articleType} 事實=${r.factuality} 業配=${r.adLikelihood} AI=${r.aiGenerated} 立場=${JSON.stringify(r.pushStance)}`);
    console.log(`  實體=${r.entities.map((e) => `${e.name}(${e.type})`).join(",") || "-"}`);
    console.log(`  情報=${r.pushFacts.slice(0, 50) || "-"} | 問答=${r.qaSummary.slice(0, 50) || "-"}`);
  } catch (e) {
    console.log(`#${a.id} FAILED: ${String(e).slice(0, 160)}`);
  }
}

console.log(`\n=== ${ok}/${articles.length} ok | avg latency ${(lat / Math.max(ok, 1)).toFixed(1)}s | avg in ${Math.round(pIn / Math.max(ok, 1))} out ${Math.round(pOut / Math.max(ok, 1))} ===`);
console.log("field non-default rates:", JSON.stringify(fieldFilled));
const avgOut = pOut / Math.max(ok, 1);
const avgIn = pIn / Math.max(ok, 1);
const creditsPeak = (avgIn * 6.9 + avgOut * 24) / 10000;
console.log(`credits/article: peak ${creditsPeak.toFixed(2)} | off-peak ${(creditsPeak / 2).toFixed(2)} (v1 baseline: peak 8.03 / off-peak 4.02)`);
db.close();
