import type { DB } from "../sqlite.ts";
import { nowSecs } from "../sqlite.ts";
import { toBoard, placeholders, type Board, type BoardRow } from "../types.ts";

// Backfill claim exclusion window (matches PG interval '6 hours').
const CLAIM_EXCLUSION_SECS = 6 * 60 * 60;

export interface UpsertBoardParams {
  name: string;
  categoryPath?: string | null;
  title?: string | null;
  userCount?: number | null;
}

export interface BoardQueries {
  // Discovery: insert new board (start incremental immediately via next_check_at = now).
  // On conflict: refresh metadata only, preserve all crawl state.
  upsertBoard(p: UpsertBoardParams): Board;
  getBoardByName(name: string): Board | null;
  getBoardByID(id: number): Board | null;
  // Atomic work-queue claim: reschedule with current interval + stamp last_check_at.
  // Returns null when no board is due. (PG used FOR UPDATE SKIP LOCKED; SQLite's
  // synchronous single-connection execution + this transaction give the same
  // atomicity without it.)
  claimNextBoard(): Board | null;
  setBoardInterval(id: number, checkIntervalSecs: number, nextCheckAt: number): void;
  updateBackfillProgress(id: number, lastBackfillPage: number, latestPageIndex: number): void;
  updateLatestPageIndex(id: number, latestPageIndex: number): void;
  completeBackfill(id: number): void;
  getPendingBackfillBoards(): Board[];
  // Atomic claim for concurrent backfill workers. Window sweep: hot boards first
  // (non-hot only after ALL hot boards are fully backfilled), each board only
  // claimable while its window_floor hasn't reached the global boundary.
  claimBackfillBoard(): Board | null;
  getBackfillWindow(): number | null;
  setWindowFloor(id: number, windowFloor: number): void;
  releaseBackfillClaim(id: number): void;
  // Clear every backfill claim (startup: the single-writer service just
  // booted, so any existing claim is an orphan from the previous process).
  releaseAllBackfillClaims(): number;
  // Decrement window_bottom by stepSeconds once every incomplete hot board has
  // reached the current boundary. Returns new boundary, or null when boards are
  // still mid-window (workers treat as "keep waiting").
  advanceBackfillWindow(stepSeconds: number): number | null;
  markBoardsHot(names: string[]): void;
  countBoards(): number;
}

export function createBoardQueries(db: DB): BoardQueries {
  const claimNextBoard = db.transaction((): Board | null => {
    const now = nowSecs();
    const row = db
      .prepare(
        `SELECT * FROM boards
         WHERE next_check_at IS NOT NULL AND next_check_at <= ?
         ORDER BY next_check_at
         LIMIT 1`,
      )
      .get(now) as BoardRow | undefined;
    if (!row) return null;
    const next = now + row.check_interval_secs;
    db.prepare(`UPDATE boards SET next_check_at = ?, last_check_at = ? WHERE id = ?`).run(
      next,
      now,
      row.id,
    );
    return toBoard({ ...row, next_check_at: next, last_check_at: now });
  });

  const claimBackfillBoard = db.transaction((): Board | null => {
    const cutoff = nowSecs() - CLAIM_EXCLUSION_SECS;
    const row = db
      .prepare(
        `SELECT * FROM boards
         WHERE backfill_complete = 0
           AND (backfill_claimed_at IS NULL OR backfill_claimed_at < ?)
           AND (is_hot = 1 OR NOT EXISTS (
               SELECT 1 FROM boards h
               WHERE h.is_hot = 1 AND h.backfill_complete = 0))
           AND (window_floor IS NULL OR window_floor > (
               SELECT value FROM backfill_meta WHERE key = 'window_bottom'))
         ORDER BY is_hot DESC, (last_backfill_page > 1), user_count DESC, id
         LIMIT 1`,
      )
      .get(cutoff) as BoardRow | undefined;
    if (!row) return null;
    const now = nowSecs();
    db.prepare(`UPDATE boards SET backfill_claimed_at = ? WHERE id = ?`).run(now, row.id);
    return toBoard({ ...row, backfill_claimed_at: now });
  });

  return {
    upsertBoard(p: UpsertBoardParams): Board {
      const row = db
        .prepare(
          `INSERT INTO boards (name, category_path, title, user_count, next_check_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (name) DO UPDATE SET
             category_path = excluded.category_path,
             title         = excluded.title,
             user_count    = excluded.user_count
           RETURNING *`,
        )
        .get(p.name, p.categoryPath ?? null, p.title ?? null, p.userCount ?? null, nowSecs()) as BoardRow;
      return toBoard(row);
    },

    getBoardByName(name: string): Board | null {
      const row = db.prepare(`SELECT * FROM boards WHERE name = ?`).get(name) as
        | BoardRow
        | undefined;
      return row ? toBoard(row) : null;
    },

    getBoardByID(id: number): Board | null {
      const row = db.prepare(`SELECT * FROM boards WHERE id = ?`).get(id) as
        | BoardRow
        | undefined;
      return row ? toBoard(row) : null;
    },

    claimNextBoard,
    claimBackfillBoard,

    setBoardInterval(id: number, checkIntervalSecs: number, nextCheckAt: number): void {
      db.prepare(
        `UPDATE boards SET check_interval_secs = ?, next_check_at = ? WHERE id = ?`,
      ).run(checkIntervalSecs, nextCheckAt, id);
    },

    updateBackfillProgress(id: number, lastBackfillPage: number, latestPageIndex: number): void {
      db.prepare(
        `UPDATE boards SET last_backfill_page = ?, latest_page_index = ? WHERE id = ?`,
      ).run(lastBackfillPage, latestPageIndex, id);
    },

    updateLatestPageIndex(id: number, latestPageIndex: number): void {
      db.prepare(`UPDATE boards SET latest_page_index = ? WHERE id = ?`).run(
        latestPageIndex,
        id,
      );
    },

    completeBackfill(id: number): void {
      db.prepare(
        `UPDATE boards SET backfill_complete = 1, backfill_recent_complete = 1, window_floor = 0 WHERE id = ?`,
      ).run(id);
    },

    getPendingBackfillBoards(): Board[] {
      const rows = db
        .prepare(`SELECT * FROM boards WHERE backfill_complete = 0 ORDER BY user_count DESC, id`)
        .all() as BoardRow[];
      return rows.map(toBoard);
    },

    getBackfillWindow(): number | null {
      const row = db
        .prepare(`SELECT value FROM backfill_meta WHERE key = 'window_bottom'`)
        .get() as { value: number } | undefined;
      return row ? row.value : null;
    },

    setWindowFloor(id: number, windowFloor: number): void {
      db.prepare(`UPDATE boards SET window_floor = ? WHERE id = ?`).run(windowFloor, id);
    },

    releaseBackfillClaim(id: number): void {
      db.prepare(`UPDATE boards SET backfill_claimed_at = NULL WHERE id = ?`).run(id);
    },

    releaseAllBackfillClaims(): number {
      return db.prepare(`UPDATE boards SET backfill_claimed_at = NULL WHERE backfill_claimed_at IS NOT NULL`).run().changes;
    },

    advanceBackfillWindow(stepSeconds: number): number | null {
      const row = db
        .prepare(
          `UPDATE backfill_meta SET value = value - ?
           WHERE key = 'window_bottom'
             AND EXISTS (SELECT 1 FROM boards WHERE is_hot = 1 AND backfill_complete = 0)
             AND NOT EXISTS (
                 SELECT 1 FROM boards
                 WHERE is_hot = 1
                   AND backfill_complete = 0
                   AND (window_floor IS NULL OR window_floor >
                        (SELECT value FROM backfill_meta WHERE key = 'window_bottom')))
           RETURNING value`,
        )
        .get(stepSeconds) as { value: number } | undefined;
      return row ? row.value : null;
    },

    markBoardsHot(names: string[]): void {
      if (names.length === 0) return;
      const stmt = db.prepare(`UPDATE boards SET is_hot = 1 WHERE name IN (${placeholders(names.length)})`);
      stmt.run(...names);
    },

    countBoards(): number {
      return (db.prepare(`SELECT count(*) AS c FROM boards`).get() as { c: number }).c;
    },
  };
}
