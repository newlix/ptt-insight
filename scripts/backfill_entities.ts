// One-shot: rebuild entity_refs from article_insights.entities on a given DB.
// Usage: bun scripts/backfill_entities.ts [/path/to/ptt.db]
import { openDB } from "../src/db/sqlite.ts";
import { migrate } from "../src/db/migrate.ts";
import { backfillEntityRefs, entityRefCount } from "../src/repo/entities.ts";

const path = process.argv[2] ?? "/home/newlix/ptt-insight/ptt.db";
const db = openDB(path);
migrate(db);
console.log(`entity_refs before: ${entityRefCount(db)}`);
backfillEntityRefs(db);
console.log(`entity_refs after: ${entityRefCount(db)}`);
db.close();
