// Card 10 render verification: computed-style + CSSOM assertions + screenshots
// for the PTT-design parity fixes (SPEC task 3, F1-F17).
// Requires: designcheck.ts server already listening on :18123.
import { chromium } from "playwright";

const BASE = "http://localhost:18123";
const results: Array<[string, boolean, string]> = [];
function check(name: string, ok: boolean, detail: string) {
  results.push([name, ok, detail]);
}

const browser = await chromium.launch();

// ---------- desktop 1280 ----------
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

await page.goto(`${BASE}/bbs/TestBoard/index.html`);
const boardStyles = await page.evaluate(() => {
  const cs = (sel: string) => {
    const el = document.querySelector(sel);
    return el ? getComputedStyle(el) : null;
  };
  const bar = cs(".ptt-actionbar-container")!;
  const top = cs(".ptt-topbar")!;
  const author = cs(".r-ent .r-author")!;
  const mark = cs(".r-ent .r-mark")!;
  const nrec = cs(".r-ent .nrec")!;
  const title = cs(".r-ent .r-title")!;
  const meta = cs(".r-ent .r-meta")!;
  const btn = cs(".ptt-btn")!;
  return {
    barPosition: bar.position, barZ: bar.zIndex, barBg: bar.backgroundColor,
    barPaddingTop: bar.paddingTop,
    topPosition: top.position, topZ: top.zIndex, topHeight: top.height,
    authorFont: author.fontFamily, markFont: mark.fontFamily,
    nrecFont: nrec.fontFamily, nrecFloat: nrec.cssFloat, nrecWidth: nrec.width,
    titleMarginLeft: title.marginLeft,
    metaMarginLeft: meta.marginLeft,
    rEntBg: cs(".r-ent")!.backgroundColor,
    rEntBorder: cs(".r-ent")!.borderBottomStyle,
    btnPadding: btn.padding, btnFontSize: btn.fontSize,
    btnPadX: btn.paddingRight,
  };
});
check("F1 actionbar fixed", boardStyles.barPosition === "fixed", `position=${boardStyles.barPosition}`);
check("F1 actionbar z=98", boardStyles.barZ === "98", `z=${boardStyles.barZ}`);
check("F1 actionbar bg black", boardStyles.barBg === "rgb(0, 0, 0)", `bg=${boardStyles.barBg}`);
check("F1 actionbar pt=40", boardStyles.barPaddingTop === "40px", `pt=${boardStyles.barPaddingTop}`);
check("F6 topbar fixed z=99 h=40", boardStyles.topPosition === "fixed" && boardStyles.topZ === "99" && boardStyles.topHeight === "40px",
  `pos=${boardStyles.topPosition} z=${boardStyles.topZ} h=${boardStyles.topHeight}`);
check("F5 author Inconsolata", boardStyles.authorFont.includes("Inconsolata"), `font=${boardStyles.authorFont}`);
check("F5/F8 mark Inconsolata bold", boardStyles.markFont.includes("Inconsolata"), `font=${boardStyles.markFont}`);
check("F8 nrec serif float", boardStyles.nrecFont === "serif" && boardStyles.nrecFloat === "left", `font=${boardStyles.nrecFont} float=${boardStyles.nrecFloat}`);
check("F8 desktop title margin-left 5ex", parseFloat(boardStyles.titleMarginLeft) > 45 && parseFloat(boardStyles.titleMarginLeft) < 65, `ml=${boardStyles.titleMarginLeft}`);
check("F8 desktop r-ent bg #111 no border", boardStyles.rEntBg === "rgb(17, 17, 17)" && boardStyles.rEntBorder === "none",
  `bg=${boardStyles.rEntBg} border=${boardStyles.rEntBorder}`);
check("F9 desktop btn padding 2ex font initial", parseFloat(boardStyles.btnPadX) > 10 && boardStyles.btnFontSize === "16px",
  `padX=${boardStyles.btnPadX} fs=${boardStyles.btnFontSize}`);

// CSSOM: hover/visited rules exist with official colors (F4, F17)
const rules = await page.evaluate(() => {
  const found: Record<string, string> = {};
  for (const sheet of document.styleSheets) {
    let list: CSSRuleList;
    try { list = sheet.cssRules; } catch { continue; }
    const walk = (rl: CSSRuleList) => {
      for (const r of Array.from(rl)) {
        if ("cssRules" in r && r.cssRules) walk(r.cssRules as CSSRuleList);
        if ("selectorText" in r && r.selectorText && "style" in r) {
          const st = r as CSSStyleRule;
          found[st.selectorText] = (found[st.selectorText] ?? "") + `bg:${st.style.backgroundColor};color:${st.style.color}`;
        }
      }
    };
    walk(list);
  }
  return found;
});
check("F4 title hover #ccc/#333", (rules[".r-ent .r-title a:hover"] ?? "").includes("rgb(204, 204, 204)") && (rules[".r-ent .r-title a:hover"] ?? "").includes("rgb(51, 51, 51)"),
  `rule=${rules[".r-ent .r-title a:hover"]}`);
check("F4 title visited #888", (rules[".r-ent .r-title a:visited"] ?? "").includes("rgb(136, 136, 136)"), `rule=${rules[".r-ent .r-title a:visited"]}`);
const btnVisitedRule = Object.entries(rules).filter(([k]) => k.includes("ptt-btn") && k.includes(":visited")).map(([, v]) => v).join("|");
check("F17 btn visited #ddd", btnVisitedRule.includes("rgb(221, 221, 221)"), `rule=${btnVisitedRule}`);

await page.screenshot({ path: "/tmp/fix2_clone_board.png", fullPage: false });

// article page
await page.goto(`${BASE}/bbs/TestBoard/M.1001.A.A1.html`);
const artStyles = await page.evaluate(() => {
  const cs = (sel: string) => document.querySelector(sel) ? getComputedStyle(document.querySelector(sel)!) : null;
  const ml = cs(".metaline.metaline-board")!;
  const tag = cs(".article-meta-tag")!;
  const wrap = cs(".article-wrap")!;
  const pushTag = cs(".push-line .push-tag")!;
  return {
    mlTop: ml.top, mlPosition: ml.position,
    tagPadding: tag.padding,
    wrapFs: wrap.fontSize, wrapLh: wrap.lineHeight,
    pushTagMinWidth: pushTag.minWidth,
    pushSpanPre: getComputedStyle(document.querySelector(".push-line > span")!).whiteSpace,
    barRect: (document.querySelector(".article-bottombar .bar") as HTMLElement | null)?.getBoundingClientRect().toJSON() ?? null,
    linkRect: (document.querySelector(".article-bottombar .back-to-board") as HTMLElement).getBoundingClientRect().toJSON(),
    navRect: (document.querySelector(".article-bottombar") as HTMLElement).getBoundingClientRect().toJSON(),
    gap: !!document.querySelector(".article-gap"),
  };
});
check("F3 metaline-board top=0", artStyles.mlTop === "0px" && artStyles.mlPosition === "absolute", `top=${artStyles.mlTop}`);
check("F14 metaline padding 1ex", parseFloat(artStyles.tagPadding.split(" ")[1]) > 9.5 && parseFloat(artStyles.tagPadding.split(" ")[1]) < 13, `pad=${artStyles.tagPadding}`);
check("F7 article lh=100% fs=24", artStyles.wrapLh === "24px" && artStyles.wrapFs === "24px", `fs=${artStyles.wrapFs} lh=${artStyles.wrapLh}`);
check("F10 push-tag min-width 3.5ex", parseFloat(artStyles.pushTagMinWidth) > 33 && parseFloat(artStyles.pushTagMinWidth) < 44, `mw=${artStyles.pushTagMinWidth}`);
check("F10 push span pre-wrap", artStyles.pushSpanPre === "pre-wrap", `ws=${artStyles.pushSpanPre}`);
check("F15 no article-gap", !artStyles.gap, `gap=${artStyles.gap}`);
check("F13 bottombar .bar 40px, aligned with link", artStyles.barRect !== null
  && Math.abs(artStyles.navRect.height - 40) < 1
  && Math.abs(artStyles.barRect.height - 40) < 1
  && Math.abs(artStyles.barRect.top - artStyles.linkRect.top) < 1,
  `nav h=${artStyles.navRect.height} bar h=${artStyles.barRect?.height} Δtop=${artStyles.barRect ? artStyles.barRect.top - artStyles.linkRect.top : "n/a"}`);
await page.screenshot({ path: "/tmp/fix2_clone_article.png", fullPage: false });

// home
await page.goto(`${BASE}/`);
const homeStyles = await page.evaluate(() => {
  const row = document.querySelector(".hotboard-row") as HTMLElement;
  const nuser = document.querySelector(".hb-nuser") as HTMLElement;
  return {
    rowDisplay: getComputedStyle(row).display,
    rowFont: getComputedStyle(row).fontFamily,
    nuserPaddingRight: getComputedStyle(nuser).paddingRight,
    rightLinks: Array.from(document.querySelectorAll(".ptt-topbar-inner .topbar-right")).map((a) => (a as HTMLElement).textContent),
  };
});
check("F16 hotboard block + Inconsolata", homeStyles.rowDisplay === "block" && homeStyles.rowFont.includes("Inconsolata"), `disp=${homeStyles.rowDisplay} font=${homeStyles.rowFont}`);
check("F16 nuser padding-right 1ex", parseFloat(homeStyles.nuserPaddingRight) > 7.5 && parseFloat(homeStyles.nuserPaddingRight) < 11, `pr=${homeStyles.nuserPaddingRight}`);
check("F6 right link order 關於我們 first", homeStyles.rightLinks[0] === "關於我們", `order=${homeStyles.rightLinks.join(",")}`);
await page.screenshot({ path: "/tmp/fix2_clone_home.png", fullPage: false });

// ---------- breakpoint boundary 799 vs 800 ----------
for (const [w, wantBorder] of [[799, true], [800, false]] as const) {
  const p2 = await browser.newPage({ viewport: { width: w, height: 800 } });
  await p2.goto(`${BASE}/bbs/TestBoard/index.html`);
  const border = await p2.evaluate(() => getComputedStyle(document.querySelector(".r-ent")!).borderBottomStyle);
  check(`F2 breakpoint @${w} border=${wantBorder ? "solid" : "none"}`, (border === "solid") === wantBorder, `border=${border}`);
  await p2.close();
}

// ---------- mobile 390 ----------
const m = await browser.newPage({ viewport: { width: 390, height: 844 } });
await m.goto(`${BASE}/`);
await m.screenshot({ path: "/tmp/fix2_clone_home_m.png" });
await m.goto(`${BASE}/bbs/TestBoard/index.html`);
const mobileStyles = await m.evaluate(() => {
  const btn = document.querySelector(".ptt-btn")!;
  const rEnt = document.querySelector(".r-ent")!;
  const title = document.querySelector(".r-ent .r-title")!;
  return {
    btnFs: getComputedStyle(btn).fontSize, btnPad: getComputedStyle(btn).padding,
    rEntBorder: getComputedStyle(rEnt).borderBottomStyle, rEntBg: getComputedStyle(rEnt).backgroundColor,
    titleMl: getComputedStyle(title).marginLeft, titleMr: getComputedStyle(title).marginRight,
  };
});
check("F9 mobile btn font small pad 1ex", parseFloat(mobileStyles.btnFs) < 14 && parseFloat(mobileStyles.btnPad.split(" ")[1]) < 10,
  `fs=${mobileStyles.btnFs} pad=${mobileStyles.btnPad}`);
check("F8 mobile r-ent border #444 no bg", mobileStyles.rEntBorder === "solid" && mobileStyles.rEntBg === "rgba(0, 0, 0, 0)",
  `border=${mobileStyles.rEntBorder} bg=${mobileStyles.rEntBg}`);
check("F8 mobile title margins 5ex/2ex", parseFloat(mobileStyles.titleMl) > 35 && parseFloat(mobileStyles.titleMl) < 50 && parseFloat(mobileStyles.titleMr) > 12 && parseFloat(mobileStyles.titleMr) < 20,
  `ml=${mobileStyles.titleMl} mr=${mobileStyles.titleMr}`);
await m.goto(`${BASE}/`);
const mobileToolbar = await m.evaluate(() => {  const bar = document.querySelector(".ptt-actionbar") as HTMLElement;
  const btn = document.querySelector(".btn-group-cls > .ab-btn") as HTMLElement;
  return { barW: bar.getBoundingClientRect().width, btnW: btn.getBoundingClientRect().width };
});
check("F19 mobile toolbar buttons stretch 50%", Math.abs(mobileToolbar.btnW / mobileToolbar.barW - 0.5) < 0.02,
  `btn=${mobileToolbar.btnW.toFixed(1)} bar=${mobileToolbar.barW.toFixed(1)}`);
await m.screenshot({ path: "/tmp/fix2_clone_board_m.png" });
await m.goto(`${BASE}/bbs/TestBoard/M.1001.A.A1.html`);
await m.screenshot({ path: "/tmp/fix2_clone_article_m.png" });
await m.close();

await browser.close();

let fails = 0;
for (const [name, ok, detail] of results) {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}  [${detail}]`);
  if (!ok) fails++;
}
console.log(`\n${results.length - fails}/${results.length} checks passed`);
process.exit(fails === 0 ? 0 : 1);
