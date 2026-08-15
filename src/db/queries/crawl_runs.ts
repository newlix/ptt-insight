import type { DB } from "../sqlite.ts";
import { nowSecs } from "../sqlite.ts";
import { toCrawlRun, type CrawlRun, type CrawlRunRow } from "../types.ts";

export interface FinishCrawlRunParams {
  id: number;
  status: string;
  pagesCrawled: number;
  articlesNew: number;
  articlesUpdated: number;
  pushesUpdated: number;
  errors: number;
  errorDetail?: string;
}

export interface CrawlRunQueries {
  createCrawlRun(boardId: number | null, runType: string): CrawlRun;
  finishCrawlRun(p: FinishCrawlRunParams): void;
}

export function createCrawlRunQueries(db: DB): CrawlRunQueries {
  return {
    createCrawlRun(boardId: number | null, runType: string): CrawlRun {
      const row = db
        .prepare(`INSERT INTO crawl_runs (board_id, run_type) VALUES (?, ?) RETURNING *`)
        .get(boardId, runType) as CrawlRunRow;
      return toCrawlRun(row);
    },

    finishCrawlRun(p: FinishCrawlRunParams): void {
      db.prepare(
        `UPDATE crawl_runs SET
           status         = ?,
           pages_crawled  = ?,
           articles_new   = ?,
           articles_updated = ?,
           pushes_updated = ?,
           errors         = ?,
           error_detail   = ?,
           finished_at    = ?
         WHERE id = ?`,
      ).run(
        p.status,
        p.pagesCrawled,
        p.articlesNew,
        p.articlesUpdated,
        p.pushesUpdated,
        p.errors,
        p.errorDetail ?? "",
        nowSecs(),
        p.id,
      );
    },
  };
}
