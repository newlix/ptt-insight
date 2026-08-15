import type { DB } from "../sqlite.ts";

export interface PushRow {
  articleId: number;
  seq: number;
  tag: string;
  userId: string;
  content: string | null;
  ipdatetime: string | null;
}

export interface PushQueries {
  deletePushesByArticle(articleId: number): void;
  // Batch insert (PG used COPY; SQLite: prepared statement inside a transaction).
  insertPushes(rows: PushRow[]): void;
}

export function createPushQueries(db: DB): PushQueries {
  const insertOne = db.prepare(
    `INSERT INTO pushes (article_id, seq, tag, user_id, content, ipdatetime)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const insertMany = db.transaction((rows: PushRow[]) => {
    for (const r of rows) {
      insertOne.run(r.articleId, r.seq, r.tag, r.userId, r.content, r.ipdatetime);
    }
  });

  return {
    deletePushesByArticle(articleId: number): void {
      db.prepare(`DELETE FROM pushes WHERE article_id = ?`).run(articleId);
    },

    insertPushes(rows: PushRow[]): void {
      if (rows.length === 0) return;
      insertMany(rows);
    },
  };
}
