import type { DB } from "./sqlite.ts";
import { createBoardQueries, type BoardQueries } from "./queries/boards.ts";
import { createArticleQueries, type ArticleQueries } from "./queries/articles.ts";
import { createPushQueries, type PushQueries } from "./queries/pushes.ts";
import { createCrawlRunQueries, type CrawlRunQueries } from "./queries/crawl_runs.ts";

export type Store = BoardQueries & ArticleQueries & PushQueries & CrawlRunQueries;

// All query groups bound to one database handle (the sqlc `db.Queries` analogue).
export function createStore(db: DB): Store {
  return {
    ...createBoardQueries(db),
    ...createArticleQueries(db),
    ...createPushQueries(db),
    ...createCrawlRunQueries(db),
  };
}
