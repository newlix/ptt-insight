// Adaptive backoff constants for per-board incremental scheduling.
export const MIN_INTERVAL_SECS = 600; // 10 minutes — floor, used when new articles found
export const MAX_INTERVAL_SECS = 604800; // 7 days — ceiling for dead boards

// nextInterval calculates the next adaptive backoff interval for a board.
//
//   - newArticles=true  → reset to MIN_INTERVAL_SECS (board is active)
//   - newArticles=false → double current, capped at MAX_INTERVAL_SECS (board is quiet)
//
// This lets hot boards converge to ~10 min checks while dead boards
// naturally back off to once per week.
export function nextInterval(currentSecs: number, newArticles: boolean): number {
  if (newArticles) return MIN_INTERVAL_SECS;
  const doubled = currentSecs * 2;
  return doubled > MAX_INTERVAL_SECS ? MAX_INTERVAL_SECS : doubled;
}
