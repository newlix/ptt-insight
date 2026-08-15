import * as cheerio from "cheerio";

// Live hot-boards data from www.ptt.cc.

export const HOT_BOARDS_URL = "https://www.ptt.cc/bbs/hotboards.html";

const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

export interface HotBoard {
  name: string; // e.g. "Gossiping"
  class: string; // e.g. "綜合"
  title: string; // e.g. "◎[八卦] …"
  nUser: number; // online user count
  nUserClass: string; // upstream span class: "hl f1", "hl f3", "hl", …
}

export async function fetchHotBoards(url: string, signal?: AbortSignal): Promise<HotBoard[]> {
  const resp = await fetch(url, {
    headers: { "User-Agent": UA },
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000),
  });
  if (!resp.ok) {
    throw new Error(`ptt: hotboards status ${resp.status}`);
  }
  return parseHotBoards(await resp.text());
}

export function parseHotBoards(html: string): HotBoard[] {
  const $ = cheerio.load(html);
  const boards: HotBoard[] = [];
  $(".b-ent").each((_i, el) => {
    const s = $(el);
    const nuser = s.find(".board-nuser span");
    const b: HotBoard = {
      name: s.find(".board-name").text().trim(),
      class: s.find(".board-class").text().trim(),
      title: s.find(".board-title").text().trim(),
      nUser: Number(nuser.text().trim()) || 0,
      nUserClass: nuser.attr("class") ?? "",
    };
    if (b.name !== "") boards.push(b);
  });
  if (boards.length === 0) {
    throw new Error("ptt: no .b-ent entries parsed");
  }
  return boards;
}

// Memoizes fetchHotBoards for a TTL and serves stale data when upstream fails.
export class HotBoardsCache {
  private fetchedAtMs = 0;
  private boards: HotBoard[] = [];
  private inflight: Promise<HotBoard[]> | null = null;

  constructor(
    private readonly url: string,
    private readonly ttlMs: number,
  ) {}

  // Fresh boards from cache, fetching on miss. On fetch failure falls back to
  // stale data; with no data at all it rejects.
  async get(signal?: AbortSignal): Promise<HotBoard[]> {
    if (this.boards.length > 0 && Date.now() - this.fetchedAtMs < this.ttlMs) {
      return this.boards;
    }
    if (!this.inflight) {
      this.inflight = fetchHotBoards(this.url, signal)
        .then((boards) => {
          this.boards = boards;
          this.fetchedAtMs = Date.now();
          return boards;
        })
        .finally(() => {
          this.inflight = null;
        });
    }
    try {
      return await this.inflight;
    } catch (e) {
      if (this.boards.length > 0) return this.boards; // stale fallback
      throw e;
    }
  }

  // Test hook: force expiry.
  expireForTest(): void {
    this.fetchedAtMs = 0;
  }
}
