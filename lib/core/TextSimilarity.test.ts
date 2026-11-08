import { describe, expect, test } from "bun:test";
import { jaccardSimilarity, stripDiacritics, tokenizeWords } from "./TextSimilarity.ts";

describe("TextSimilarity", () => {
  test("stripDiacritics removes accents", () => {
    expect(stripDiacritics("Café Señor")).toBe("Cafe Senor");
  });

  test("tokenizeWords lowercases, strips punctuation and short words", () => {
    expect([...tokenizeWords("Tycho @ The Observatory!")]).toEqual(["tycho", "the", "observatory"]);
  });

  test("tokenizeWords folds diacritics so accented and plain spellings match", () => {
    expect(tokenizeWords("Café Noir")).toEqual(tokenizeWords("cafe noir"));
  });

  test("jaccardSimilarity edge cases and ratio", () => {
    expect(jaccardSimilarity(new Set(), new Set())).toBe(1);
    expect(jaccardSimilarity(new Set(["a"]), new Set())).toBe(0);
    expect(jaccardSimilarity(new Set(["a", "b"]), new Set(["b", "c"]))).toBeCloseTo(1 / 3);
  });
});
