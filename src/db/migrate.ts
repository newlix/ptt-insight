import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DB } from "./sqlite.ts";

const MIGRATIONS_DIR = join(import.meta.dir, "migrations");

// Apply pending ptt-insight migrations. Shares the schema_migrations table
// with the crawler (disjoint file names, e.g. 0001_insights.sql vs the
// crawler's 0001_init.sql — neither sees the other's rows as its own).
// Idempotent — safe on every startup, even while the crawler is running.
export function migrate(db: DB): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY,
    applied_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`);

  const applied = new Set(
    db.prepare("SELECT name FROM schema_migrations").all().map((r) => (r as { name: string }).name),
  );

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf-8");
    const run = db.transaction(() => {
      db.exec(sql);
      db.prepare("INSERT OR IGNORE INTO schema_migrations (name) VALUES (?)").run(file);
    });
    run();
    console.log(`applied migration ${file}`);
  }
}
