// parseNrec converts a PTT index page nrec display string to a numeric value.
//
//	  "5"  → 5
//	  "99" → 99
//	  "爆" → 100  (actual count unknown, display caps at 爆 for >99)
//	  "X1" → -1   (negative push count, X prefix)
//	  ""   → 0    (no pushes or not yet displayed)
export function parseNrec(s: string): number {
  s = s.trim();
  if (s === "") return 0;
  if (s === "爆") return 100;
  // Negative: "X1" means -1
  if (s.startsWith("X")) {
    const n = Number(s.slice(1));
    if (!Number.isInteger(n)) return 0;
    return -n;
  }
  const n = Number(s);
  if (!Number.isInteger(n)) return 0;
  return n;
}
