import { Database } from "bun:sqlite";

export type DB = Database;

// Open the SQLite database with the pragmas the crawler depends on.
// - WAL: concurrent readers during long writes, better crash safety
//   (also allows an external reader process while this app writes)
// - busy_timeout: tolerate brief writer contention
// - foreign_keys: enforce FK constraints (OFF by default in SQLite)
export function openDB(path: string): DB {
  const db = new Database(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}

// Open an isolated in-memory database (used by tests).
export function openMemoryDB(): DB {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}

// All timestamps are Unix epoch SECONDS (INTEGER columns) — the same unit as
// url_timestamp from PTT URLs, window_floor, and backfill_meta.value.
// One unit everywhere; convert to Date only for display: new Date(secs * 1000).
export function nowSecs(): number {
  return Math.floor(Date.now() / 1000);
}

// Epoch seconds `secs` seconds from now.
export function secsAfter(secs: number): number {
  return nowSecs() + secs;
}
