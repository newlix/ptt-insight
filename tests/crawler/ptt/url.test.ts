import { test, expect } from "bun:test";
import { parseArticleURL, urlIdTimestamp } from "../../../src/crawler/ptt/url.ts";

test("parseArticleURL table", () => {
  const cases: {
    name: string;
    path: string;
    board?: string;
    urlId?: string;
    timestamp?: number;
    wantErr?: boolean;
  }[] = [
    { name: "standard", path: "/bbs/Gossiping/M.1786545600.A.D1C.html", board: "Gossiping", urlId: "M.1786545600.A.D1C", timestamp: 1786545600 },
    { name: "different board", path: "/bbs/Soft_Job/M.1475542702.A.46A.html", board: "Soft_Job", urlId: "M.1475542702.A.46A", timestamp: 1475542702 },
    { name: "invalid - no board", path: "/M.1786545600.A.D1C.html", wantErr: true },
    { name: "invalid - not article", path: "/bbs/Gossiping/index.html", wantErr: true },
    { name: "invalid - garbage", path: "https://example.com/foo", wantErr: true },
  ];

  for (const tt of cases) {
    const got = parseArticleURL(tt.path);
    if (tt.wantErr) {
      expect(got).toBeNull();
      continue;
    }
    expect(got).not.toBeNull();
    expect(got!.board).toBe(tt.board!);
    expect(got!.urlId).toBe(tt.urlId!);
    expect(got!.timestamp).toBe(tt.timestamp!);
  }
});

test("urlIdTimestamp", () => {
  expect(urlIdTimestamp("M.1786545600.A.D1C")).toBe(1786545600);
  expect(urlIdTimestamp("not-a-urlid")).toBeNull();
});
