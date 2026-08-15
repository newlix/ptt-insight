import { test, expect, afterAll } from "bun:test";
import { Fetcher, NotFoundError, USER_AGENT } from "../../../src/crawler/ptt/fetcher.ts";

const servers: ReturnType<typeof Bun.serve>[] = [];
afterAll(() => {
  for (const s of servers) s.stop(true);
});

function serve(handler: (req: Request) => Response | Promise<Response>): string {
  const srv = Bun.serve({ port: 0, fetch: handler });
  servers.push(srv);
  return `http://localhost:${srv.port}`;
}

test("fetcher success", async () => {
  const url = serve(() => new Response("hello ptt"));
  const f = new Fetcher(100, { baseBackoffMs: 10 });
  expect(await f.fetch(url)).toBe("hello ptt");
});

test("fetcher sends over18 cookie and honest user-agent", async () => {
  let gotCookie = "";
  let gotUA = "";
  const url = serve((req) => {
    gotCookie = req.headers.get("cookie") ?? "";
    gotUA = req.headers.get("user-agent") ?? "";
    return new Response("ok");
  });
  await new Fetcher(100, { baseBackoffMs: 10 }).fetch(url);
  expect(gotCookie).toBe("over18=1");
  expect(gotUA).toBe(USER_AGENT);
});

test("fetcher retries on 5xx then succeeds", async () => {
  let attempts = 0;
  const url = serve(() => {
    attempts++;
    if (attempts < 3) return new Response("unavailable", { status: 503 });
    return new Response("ok");
  });
  const f = new Fetcher(100, { baseBackoffMs: 10 });
  expect(await f.fetch(url)).toBe("ok");
  expect(attempts).toBe(3);
});

test("fetcher throws NotFoundError on 404 without retry", async () => {
  let attempts = 0;
  const url = serve(() => {
    attempts++;
    return new Response("gone", { status: 404 });
  });
  const f = new Fetcher(100, { baseBackoffMs: 10 });
  expect(f.fetch(url)).rejects.toBeInstanceOf(NotFoundError);
  await new Promise((r) => setTimeout(r, 50));
  expect(attempts).toBe(1); // no retry on 4xx
});

test("fetcher gives up after max retries", async () => {
  const url = serve(() => new Response("unavailable", { status: 503 }));
  const f = new Fetcher(100, { maxRetries: 2, baseBackoffMs: 10 });
  await expect(f.fetch(url)).rejects.toThrow(/after 2 retries/);
});

test("fetcher rate limiting (5 req/s, 8 requests ≥ 500ms)", async () => {
  const url = serve(() => new Response("ok"));
  const f = new Fetcher(5);
  const start = Date.now();
  for (let i = 0; i < 8; i++) {
    await f.fetch(url);
  }
  const elapsed = Date.now() - start;
  // burst=5, rate=5/s → 8 requests take ≥ (8-5)/5 = 0.6s
  expect(elapsed).toBeGreaterThanOrEqual(500);
});

test("fetcher aborts when signal fires", async () => {
  const url = serve(() => new Response("ok"));
  const f = new Fetcher(1); // 1 req/s — second request must wait ~1s
  await f.fetch(url); // consume the initial burst token
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), 30);
  await expect(f.fetch(url, ctrl.signal)).rejects.toThrow();
});
