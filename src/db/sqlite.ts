import { Database } from "bun:sqlite";

export type DB = Database;

// The crawler owns ptt.db and runs with WAL — this app opens the same file
// read-mostly (articles/pushes/boards) and writes only its own tables
// (article_insights). WAL allows one writer + N readers across processes;
// busy_timeout absorbs brief writer contention with the crawler.
export function openDB(path: string): DB {
  const db = new Database(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA busy_timeout = 10000");
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}

// Isolated in-memory database for tests.
export function openMemoryDB(): DB {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}

export function nowSecs(): number {
  return Math.floor(Date.now() / 1000);
}
