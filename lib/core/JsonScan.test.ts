import { expect, test } from "bun:test";
import { findClosingBracket } from "./JsonScan.ts";

test("finds the matching bracket across nesting", () => {
  const t = 'x [1, [2, 3], {"a": [4]}] y';
  expect(findClosingBracket(t, 2)).toBe(t.lastIndexOf("]"));
});

test("ignores brackets inside strings, including escaped quotes", () => {
  const t = '["a]", "b\\"]"]';
  expect(findClosingBracket(t, 0)).toBe(t.length - 1);
});

test("returns -1 when unbalanced", () => {
  expect(findClosingBracket("[1, [2]", 0)).toBe(-1);
});
