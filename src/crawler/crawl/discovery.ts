import type { Fetcher } from "../ptt/fetcher.ts";
import { parseClsPage } from "../ptt/cls_parser.ts";
import type { Store } from "../../db/store.ts";
import { isAborted } from "./util.ts";

// discoverHotBoards fetches /bbs/hotboards.html (1 request) and upserts the
// ~150 hottest boards. Use before full /cls/ discovery so Phase 1 backfill
// starts immediately.
export async function discoverHotBoards(fetcher: Fetcher, store: Store, signal?: AbortSignal): Promise<void> {
  const html = await fetcher.fetch(`${fetcher.baseURL}/bbs/hotboards.html`, signal);
  const entries = parseClsPage(html);

  let count = 0;
  const names: string[] = [];
  for (const entry of entries) {
    if (!entry.isBoard) continue;
    store.upsertBoard({
      name: entry.name,
      title: emptyOrNull(entry.title),
      userCount: entry.userCount > 0 ? entry.userCount : null,
    });
    names.push(entry.name);
    count++;
  }

  // Window sweep: hot boards get backfill priority over the long tail.
  if (names.length > 0) {
    store.markBoardsHot(names);
  }

  console.log(`discovered ${count} hot boards`);
}

// discoverBoards recursively traverses the /cls/ category tree from /cls/1,
// collecting all public boards and upserting them into the database.
export async function discoverBoards(fetcher: Fetcher, store: Store, signal?: AbortSignal): Promise<void> {
  const visited = new Set<string>();
  await discoverFromCls(fetcher, store, "/cls/1", "", visited, signal);
}

async function discoverFromCls(
  fetcher: Fetcher,
  store: Store,
  clsPath: string,
  parentPath: string,
  visited: Set<string>,
  signal?: AbortSignal,
): Promise<void> {
  if (visited.has(clsPath)) return;
  visited.add(clsPath);

  const html = await fetcher.fetch(`${fetcher.baseURL}${clsPath}`, signal);
  const entries = parseClsPage(html);

  for (const entry of entries) {
    const catPath = parentPath === "" ? entry.name : `${parentPath} > ${entry.name}`;

    if (entry.isBoard) {
      // Actual board — upsert into DB
      store.upsertBoard({
        name: entry.name,
        title: emptyOrNull(entry.title),
        userCount: entry.userCount > 0 ? entry.userCount : null,
        categoryPath: emptyOrNull(catPath),
      });
    } else {
      // Sub-category — recurse. On shutdown, unwind quietly: discovery is
      // idempotent (upserts), the next start re-walks whatever was missed.
      try {
        await discoverFromCls(fetcher, store, entry.href, catPath, visited, signal);
      } catch (e) {
        if (signal?.aborted) return;
        console.error(`discover ${entry.href}:`, e);
      }
    }

    if (signal?.aborted) return;
  }
}

function emptyOrNull(s: string): string | null {
  const t = s.trim();
  return t === "" ? null : t;
}
