/**
 * sourceText.ts — helper for the few tests that must check source structure
 * ("file X does not import Y", "file X uses API Z") instead of behavior.
 *
 * Matching raw source text breaks when a formatter changes quote style, line
 * breaks or indentation. normalizeSource() removes comments and makes
 * whitespace and quote style uniform, so a structural check only fails on a
 * real change.
 */

import { readFileSync } from "node:fs";

/**
 * Remove comments, turn single-quoted and backtick-free string quotes into double
 * quotes, and collapse every run of whitespace into one space.
 */
export function normalizeSource(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1")
    .replace(/'/g, '"')
    .replace(/\s+/g, " ")
    .replace(/\s*([(){},;])\s*/g, "$1")
    .trim();
}

/** Read a source file and normalize it (see normalizeSource). */
export function readNormalizedSource(path: string): string {
  return normalizeSource(readFileSync(path, "utf-8"));
}
