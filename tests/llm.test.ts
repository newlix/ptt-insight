import { test, expect, afterAll } from "bun:test";
import { LLMClient, ContentFilterError } from "../src/llm/client.ts";

const servers: ReturnType<typeof Bun.serve>[] = [];
afterAll(() => {
  for (const s of servers) s.stop(true);
});

function okBody(content = "答案"): string {
  return JSON.stringify({
    choices: [{ message: { content } }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  });
}

function serve(handler: (req: Request, hits: number) => Response): { url: string; hits: () => number } {
  let n = 0;
  const srv = Bun.serve({
    port: 0,
    fetch: (req) => {
      n++;
      return handler(req, n);
    },
  });
  servers.push(srv);
  return { url: `http://localhost:${srv.port}`, hits: () => n };
}

test("429 twice then 200: retries with backoff and succeeds", async () => {
  const s = serve((_req, hits) => {
    if (hits < 3) return new Response("rate limited", { status: 429, headers: { "retry-after": "0" } });
    return new Response(okBody("成功"), { headers: { "Content-Type": "application/json" } });
  });
  const c = new LLMClient(s.url, "", "m", { retryBackoffMs: 10 });
  const r = await c.complete("sys", "user", 100);
  expect(r.content).toBe("成功");
  expect(s.hits()).toBe(3);
});

test("500 then 200: retried", async () => {
  const s = serve((_req, hits) => {
    if (hits === 1) return new Response("boom", { status: 502 });
    return new Response(okBody(), { headers: { "Content-Type": "application/json" } });
  });
  const c = new LLMClient(s.url, "", "m", { retryBackoffMs: 10 });
  expect((await c.complete("s", "u", 100)).content).toBe("答案");
  expect(s.hits()).toBe(2);
});

test("400: NOT retried", async () => {
  const s = serve(() => new Response("bad request", { status: 400 }));
  const c = new LLMClient(s.url, "", "m", { retryBackoffMs: 10 });
  await expect(c.complete("s", "u", 100)).rejects.toThrow(/400/);
  expect(s.hits()).toBe(1);
});

test("content filter: immediate ContentFilterError, no retry", async () => {
  const s = serve(() => new Response(JSON.stringify({ error: { code: "1301", message: "blocked" } }), { status: 400 }));
  const c = new LLMClient(s.url, "", "m", { retryBackoffMs: 10 });
  await expect(c.complete("s", "u", 100)).rejects.toBeInstanceOf(ContentFilterError);
  expect(s.hits()).toBe(1);
});

test("persistent 429: gives up after maxRetries and reports last status", async () => {
  const s = serve(() => new Response("rate limited", { status: 429 }));
  const c = new LLMClient(s.url, "", "m", { maxRetries: 2, retryBackoffMs: 10 });
  await expect(c.complete("s", "u", 100)).rejects.toThrow(/429/);
  expect(s.hits()).toBe(3); // initial + 2 retries
});

test("network error then success: retried", async () => {
  const s = serve((_req, hits) => {
    if (hits === 1) return new Response("unavailable", { status: 503 });
    return new Response(okBody("net-ok"), { headers: { "Content-Type": "application/json" } });
  });
  const c = new LLMClient(s.url, "", "m", { retryBackoffMs: 10 });
  expect((await c.complete("s", "u", 100)).content).toBe("net-ok");
});
