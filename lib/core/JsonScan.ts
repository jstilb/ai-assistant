/**
 * JsonScan — locate a balanced JSON array inside free text (LLM output).
 *
 * Shared by Inference.detectJsonArraysInText and EventScout's SPAAdapter
 * array parser, formerly two copies of this string-aware bracket scanner.
 */

/**
 * Index of the `]` that closes the `[` at `openIdx`, skipping brackets inside
 * JSON strings (with backslash escapes). Returns -1 if it never closes.
 */
export function findClosingBracket(text: string, openIdx: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = openIdx; i < text.length; i++) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\" && inString) {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (ch === "[") depth++;
    else if (ch === "]") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}
