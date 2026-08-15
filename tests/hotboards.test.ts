import { test, expect, afterAll } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseHotBoards, fetchHotBoards, HotBoardsCache, type HotBoard } from "../src/ptt/hotboards.ts";

const FIXTURE = join(import.meta.dir, "../testdata/hotboards.html");

const servers: ReturnType<typeof Bun.serve>[] = [];
afterAll(() => {
  for (const s of servers) s.stop(true);
});

function serveFixture(): string {
  const srv = Bun.serve({
    port: 0,
    fetch: (req) => {
      if (!req.headers.get("user-agent")) return new Response("missing UA", { status: 403 });
      return new Response(readFileSync(FIXTURE), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    },
  });
  servers.push(srv);
  return `http://localhost:${srv.port}`;
}

test("parseHotBoards on real fixture", async () => {
  const boards = parseHotBoards(readFileSync(FIXTURE, "utf-8"));
  expect(boards.length).toBe(128);

  const first = boards[0]!;
  expect(first.name).toBe("Gossiping");
  expect(first.class).toBe("綜合");
  expect(first.nUser).toBeGreaterThan(100); // live value; structural check only
  expect(first.nUserClass).toBe("hl f1");
  expect(first.title.includes("八卦")).toBe(true);

  const last = boards[boards.length - 1]!;
  expect(last.name).not.toBe("");
  expect(last.nUser).toBeGreaterThan(0);
});

test("fetchHotBoards sends UA and parses", async () => {
  const url = serveFixture();
  const boards = await fetchHotBoards(url);
  expect(boards.length).toBe(128);
  expect(boards[0]!.name).toBe("Gossiping");
});

test("cache serves fresh without refetch", async () => {
  const url = serveFixture();
  const c = new HotBoardsCache(url, 3600_000);
  const first = await c.get();
  expect(first.length).toBe(128);
  // kill origin — second Get must come from cache
  servers.pop()!.stop(true);
  const again = await c.get();
  expect(again.length).toBe(128);
});

test("cache falls back to stale on origin failure", async () => {
  const url = serveFixture();
  const c = new HotBoardsCache(url, 3600_000);
  await c.get();
  servers.pop()!.stop(true);
  c.expireForTest(); // force expiry
  const stale = await c.get();
  expect(stale.length).toBe(128);
});

test("cache with no data rejects on origin failure", async () => {
  const url = serveFixture();
  const c = new HotBoardsCache(url, 3600_000);
  servers.pop()!.stop(true); // dead before first fetch
  await expect(c.get()).rejects.toThrow();
});

test("parseHotBoards errors on empty page", () => {
  expect(() => parseHotBoards("<html><body></body></html>")).toThrow();
});

// type sanity (HotBoard shape used by views)
const _hb: HotBoard = { name: "", class: "", title: "", nUser: 0, nUserClass: "" };
void _hb;
