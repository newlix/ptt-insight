import type { IndexEntry, ParsedArticle, ParsedPush } from "../ptt/types.ts";
import { urlIdTimestamp } from "../ptt/url.ts";
import type { InsertArticleParams } from "../../db/queries/articles.ts";
import type { PushRow } from "../../db/queries/pushes.ts";
import { emptyToNull } from "../../db/types.ts";

// buildArticleParams converts a parsed index entry + parsed article into DB
// insert params. url_timestamp is 0 when the url_id has no parseable
// timestamp (matches the Go version; excluded from vanished-candidate scans).
export function buildArticleParams(
  boardId: number,
  entry: IndexEntry,
  a: ParsedArticle,
): InsertArticleParams {
  return {
    boardId,
    urlId: entry.urlId,
    urlTimestamp: urlIdTimestamp(entry.urlId) ?? 0,
    postedAt: a.postedAt,
    title: emptyToNull(a.title),
    author: emptyToNull(a.author),
    content: emptyToNull(a.content),
    ip: emptyToNull(a.ip),
    mark: emptyToNull(entry.mark),
    nrecRaw: emptyToNull(entry.nrecRaw),
    pushCount: a.pushCount,
    booCount: a.booCount,
    neutralCount: a.neutralCount,
    netCount: a.pushCount - a.booCount,
  };
}

// buildPushParams converts parsed pushes into DB insert rows (seq = position).
export function buildPushParams(articleId: number, pushes: ParsedPush[]): PushRow[] {
  return pushes.map((push, i) => ({
    articleId,
    seq: i,
    tag: push.tag,
    userId: push.userId,
    content: emptyToNull(push.content),
    ipdatetime: emptyToNull(push.ipDateTime),
  }));
}

// articleURL builds the relative PTT article URL for parsing.
export function articleURL(board: string, urlId: string): string {
  return `/bbs/${board}/${urlId}.html`;
}
