import { describe, expect, test } from "bun:test";
import { columnLetter } from "./SheetsA1.ts";

describe("columnLetter", () => {
  test("maps single-letter columns", () => {
    expect(columnLetter(0)).toBe("A");
    expect(columnLetter(1)).toBe("B");
    expect(columnLetter(25)).toBe("Z");
  });

  test("rolls over to two letters at 26", () => {
    expect(columnLetter(26)).toBe("AA");
    expect(columnLetter(27)).toBe("AB");
    expect(columnLetter(51)).toBe("AZ");
    expect(columnLetter(52)).toBe("BA");
    expect(columnLetter(701)).toBe("ZZ");
  });

  test("rolls over to three letters at 702", () => {
    expect(columnLetter(702)).toBe("AAA");
    expect(columnLetter(18277)).toBe("ZZZ");
  });

  test("is the inverse of the standard A1 column-to-index decode", () => {
    const decode = (letters: string): number =>
      [...letters].reduce((acc, ch) => acc * 26 + (ch.charCodeAt(0) - 64), 0) - 1;
    for (const idx of [0, 7, 25, 26, 99, 255, 701, 702, 16383]) {
      expect(decode(columnLetter(idx))).toBe(idx);
    }
  });
});
