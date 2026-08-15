import { test, expect } from "bun:test";
import { parseNrec } from "../../../src/crawler/ptt/nrec.ts";

test("parseNrec table", () => {
  const cases: [string, number][] = [
    ["5", 5],
    ["99", 99],
    ["爆", 100],
    ["X1", -1],
    ["X5", -5],
    ["", 0],
    ["  3  ", 3], // whitespace trimmed
    ["XX", 0], // unparseable X prefix → 0
    ["abc", 0], // unparseable → 0
  ];
  for (const [input, want] of cases) {
    expect(parseNrec(input)).toBe(want);
  }
});
