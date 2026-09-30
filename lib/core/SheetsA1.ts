/**
 * SheetsA1.ts — A1-notation helpers for Google Sheets ranges.
 *
 * S14 (ADR-006): this pure logic existed in THREE copies — LifeOS
 * StorageIO/SheetsIO.ts `colLetter`, LifeOS bin/export-to-sheets.ts
 * `colLetter` (comment: "duplicated from SheetsIO to avoid import
 * coupling"), and UnixCLI Tools/Sheets.ts `indexToColumn`. Pure +
 * multi-skill = lib/core. All three now import from here.
 */

/** 0-based column index → A1 column letters (0→A, 25→Z, 26→AA, …). */
export function columnLetter(zeroBasedIdx: number): string {
  let n = zeroBasedIdx;
  let out = "";
  do {
    out = String.fromCharCode("A".charCodeAt(0) + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out;
}
