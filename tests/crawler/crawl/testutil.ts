import type { Store } from "../../../src/db/store.ts";
import type { DB } from "../../../src/db/sqlite.ts";
import { openMemoryDB } from "../../../src/db/sqlite.ts";
import { migrate } from "../../../src/db/migrate.ts";
import { createStore } from "../../../src/db/store.ts";
import { Fetcher } from "../../../src/crawler/ptt/fetcher.ts";

export interface TestEnv {
  url: string;
  db: DB;
  store: Store;
  fetcher: Fetcher;
  stop: () => void;
}

// setupTestEnv creates a Bun.serve test server + fresh in-memory SQLite DB.
// handler receives the request; typical usage checks url.pathname to serve
// canned HTML. In-memory DB per test — no shared state, no TRUNCATE hazard,
// can never touch production data.
export function setupTestEnv(handler: (req: Request) => Response | Promise<Response>): TestEnv {
  const server = Bun.serve({ port: 0, fetch: handler });

  const db = openMemoryDB();
  migrate(db);
  const store = createStore(db);

  const fetcher = new Fetcher(100, { baseURL: `http://localhost:${server.port}`, baseBackoffMs: 10 });

  return {
    url: `http://localhost:${server.port}`,
    db,
    store,
    fetcher,
    stop: () => server.stop(true),
  };
}

// pathServer serves different HTML per URL path; 404 for unknown paths.
export function pathServer(routes: Record<string, string>): (req: Request) => Response {
  return (req: Request) => {
    const body = routes[new URL(req.url).pathname];
    if (body !== undefined) {
      return new Response(body, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }
    return new Response("not found", { status: 404 });
  };
}

// --- Canned PTT HTML (ported from Go testutil_test.go) ---

export const cannedIndexPage = `<html><body>
<div class="r-list-container">
	<div class="r-ent">
		<div class="nrec"><span class="hl f2">5</span></div>
		<div class="title"><a href="/bbs/TestBoard/M.1000000000.A.AAA.html">Article One</a></div>
		<div class="meta"><div class="author">user1</div><div class="date"> 1/01</div><div class="mark"></div></div>
	</div>
	<div class="r-ent">
		<div class="nrec"></div>
		<div class="title"><a href="/bbs/TestBoard/M.2000000000.A.BBB.html">Article Two</a></div>
		<div class="meta"><div class="author">user2</div><div class="date"> 1/02</div><div class="mark"></div></div>
	</div>
</div>
<div class="btn-group btn-group-paging">
	<a class="btn" href="/bbs/TestBoard/index1.html">最舊</a>
	<a class="btn" href="/bbs/TestBoard/index1.html">&lsaquo; 上頁</a>
	<a class="btn disabled">下頁</a>
	<a class="btn" href="/bbs/TestBoard/index.html">最新</a>
</div>
</body></html>`;

export const cannedIndex1Page = `<html><body>
<div class="r-list-container">
	<div class="r-ent">
		<div class="nrec"></div>
		<div class="title"><a href="/bbs/TestBoard/M.500000000.A.CCC.html">Old Article</a></div>
		<div class="meta"><div class="author">user3</div><div class="date">12/01</div><div class="mark"></div></div>
	</div>
</div>
<div class="btn-group btn-group-paging">
	<a class="btn" href="/bbs/TestBoard/index1.html">最舊</a>
	<a class="btn disabled">&lsaquo; 上頁</a>
	<a class="btn" href="/bbs/TestBoard/index.html">下頁</a>
	<a class="btn" href="/bbs/TestBoard/index.html">最新</a>
</div>
</body></html>`;

export const cannedArticleAAA = `<html><body>
<div id="main-content">
	<div class="article-metaline"><span class="article-meta-tag">作者</span><span class="article-meta-value">user1 (nick1)</span></div>
	<div class="article-metaline-right"><span class="article-meta-tag">看板</span><span class="article-meta-value">TestBoard</span></div>
	<div class="article-metaline"><span class="article-meta-tag">標題</span><span class="article-meta-value">Article One</span></div>
	<div class="article-metaline"><span class="article-meta-tag">時間</span><span class="article-meta-value">Mon Jan  1 12:00:00 2024</span></div>
	This is article one content.
	<span class="f2">※ 發信站: 批踢踢實業坊(ptt.cc), 來自: 1.2.3.4 (臺灣)
	</span>
	<div class="push">
		<span class="hl push-tag">推 </span>
		<span class="f3 hl push-userid">user2</span>
		<span class="f3 push-content">: Good</span>
		<span class="push-ipdatetime">1.2.3.5 01/01 12:01</span>
	</div>
	<div class="push">
		<span class="f1 hl push-tag">噓 </span>
		<span class="f3 hl push-userid">user3</span>
		<span class="f3 push-content">: Bad</span>
		<span class="push-ipdatetime">01/01 12:02</span>
	</div>
</div>
</body></html>`;

export const cannedArticleBBB = `<html><body>
<div id="main-content">
	<div class="article-metaline"><span class="article-meta-tag">作者</span><span class="article-meta-value">user2 (nick2)</span></div>
	<div class="article-metaline"><span class="article-meta-tag">標題</span><span class="article-meta-value">Article Two</span></div>
	<div class="article-metaline"><span class="article-meta-tag">時間</span><span class="article-meta-value">Tue Jan  2 12:00:00 2024</span></div>
	Article two has no pushes.
	<span class="f2">※ 發信站: 批踢踢實業坊(ptt.cc), 來自: 5.6.7.8 (臺灣)
	</span>
</div>
</body></html>`;

export const cannedArticleCCC = `<html><body>
<div id="main-content">
	<div class="article-metaline"><span class="article-meta-tag">作者</span><span class="article-meta-value">user3 (nick3)</span></div>
	<div class="article-metaline"><span class="article-meta-tag">標題</span><span class="article-meta-value">Old Article</span></div>
	<div class="article-metaline"><span class="article-meta-tag">時間</span><span class="article-meta-value">Fri Dec  1 12:00:00 2023</span></div>
	An old article.
	<span class="f2">※ 發信站: 批踢踢實業坊(ptt.cc), 來自: 9.10.11.12 (臺灣)
	</span>
</div>
</body></html>`;
