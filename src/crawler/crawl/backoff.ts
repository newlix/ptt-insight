// Adaptive backoff defaults for per-board incremental scheduling.
export const MIN_INTERVAL_SECS = 120; // 2 minutes — floor, used when new articles found
export const MAX_INTERVAL_SECS = 604800; // 7 days — ceiling for dead boards

// nextInterval calculates the next adaptive backoff interval for a board.
//
//   - newArticles=true  → reset to minSecs (board is active)
//   - newArticles=false → double current, capped at maxSecs (board is quiet)
//
// This lets hot boards converge to ~2 min checks while dead boards
// naturally back off to once per week.
export function nextInterval(
  currentSecs: number,
  newArticles: boolean,
  minSecs: number = MIN_INTERVAL_SECS,
  maxSecs: number = MAX_INTERVAL_SECS,
): number {
  if (newArticles) return minSecs;
  const doubled = currentSecs * 2;
  return doubled > maxSecs ? maxSecs : doubled;
}
