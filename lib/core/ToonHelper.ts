#!/usr/bin/env bun
/**
 * ToonHelper.ts - TOON Format Encoding/Decoding Utility
 *
 * Provides functions for encoding arrays of objects to TOON (Token-Oriented
 * Object Notation) format and decoding back. TOON is a token-efficient
 * alternative to JSON for uniform arrays, achieving 30-60% token savings.
 *
 * Features:
 *   - toToon/fromToon: Direct encode/decode for arrays
 *   - maybeEncode: Smart encoder that picks TOON or JSON based on savings
 *   - estimateTokenSavings: Preview token savings without encoding
 *
 * Usage:
 *   import { toToon, fromToon, maybeEncode, estimateTokenSavings } from "./ToonHelper";
 *
 *   // Direct encoding
 *   const toon = toToon(users);
 *   const decoded = fromToon(toon);
 *
 *   // Smart encoding (picks best format)
 *   const { format, data } = maybeEncode(users);
 *
 *   // Preview savings
 *   const { jsonTokens, toonTokens, savingsPercent } = estimateTokenSavings(users);
 *
 * CLI:
 *   echo '[{"a":1},{"a":2}]' | bun run ToonHelper.ts encode
 *   echo '<toon-string>' | bun run ToonHelper.ts decode
 *   echo '[{"a":1},{"a":2}]' | bun run ToonHelper.ts estimate
 *   echo '[{"a":1},{"a":2}]' | bun run ToonHelper.ts smart
 *
 * @module ToonHelper
 * @version 1.0.0
 */

import { encode, decode } from "@toon-format/toon";

// ============================================================================
// TYPES
// ============================================================================

/**
 * Result from maybeEncode indicating which format was chosen
 */
export interface MaybeEncodeResult {
  format: "json" | "toon";
  data: string;
}

/**
 * Token savings estimate comparing JSON vs TOON
 */
export interface TokenSavingsEstimate {
  jsonTokens: number;
  toonTokens: number;
  savingsPercent: number;
}

// ============================================================================
// TOKEN ESTIMATION
// ============================================================================

/**
 * Estimate token count for a string.
 *
 * Uses a character-based heuristic (avg ~4 chars per token for English/structured text).
 * This is intentionally approximate -- exact tokenization requires a model-specific
 * tokenizer, but for comparison purposes between JSON and TOON representations
 * of the same data, relative accuracy is what matters.
 *
 * @param text - The string to estimate tokens for
 * @returns Estimated token count (always >= 1 for non-empty strings)
 */
function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  // Heuristic: ~4 characters per token for structured data
  // JSON punctuation ({, }, [, ], :, ,) tends to be ~1 token each
  // TOON uses fewer of these, which is where savings come from
  return Math.max(1, Math.ceil(text.length / 4));
}

// ============================================================================
// CORE FUNCTIONS
// ============================================================================

/**
 * Encode an array of objects (or primitives) to TOON format.
 *
 * TOON is most efficient for uniform arrays of flat objects (same keys across
 * all items). For mixed/nested data, TOON still encodes correctly but with
 * less token savings compared to JSON.
 *
 * @param data - Array of objects or primitives to encode
 * @returns TOON-formatted string
 *
 * @example
 * ```typescript
 * const toon = toToon([
 *   { name: "Alice", age: 30 },
 *   { name: "Bob", age: 25 },
 * ]);
 * // Returns tabular TOON:
 * // [2]{name,age}:
 * //   Alice,30
 * //   Bob,25
 * ```
 */
export function toToon(data: unknown[]): string {
  return encode(data);
}

/**
 * Decode a TOON string back to an array of objects.
 *
 * This is the inverse of toToon(). The decoded output will match the
 * original data structure (flat objects, nested objects, primitives, etc.).
 *
 * @param toon - TOON-formatted string to decode
 * @returns Array of decoded objects/primitives
 *
 * @example
 * ```typescript
 * const data = fromToon("[2]{name,age}:\n  Alice,30\n  Bob,25");
 * // Returns: [{ name: "Alice", age: 30 }, { name: "Bob", age: 25 }]
 * ```
 */
export function fromToon(toon: string): unknown[] {
  const result = decode(toon);
  // decode may return a single value for non-array input; normalize to array
  if (Array.isArray(result)) {
    return result;
  }
  return [result];
}

/**
 * Smart encoder that chooses between TOON and JSON based on token savings.
 *
 * Encodes the data in both formats, estimates token usage for each, and
 * returns whichever format saves more tokens (if savings exceed the threshold).
 *
 * @param data - Array of objects or primitives to encode
 * @param threshold - Minimum savings percentage to justify TOON encoding (default: 10)
 * @returns Object with `format` ("json" or "toon") and encoded `data` string
 *
 * @example
 * ```typescript
 * // Uniform array: TOON wins
 * const result = maybeEncode(users);
 * // { format: "toon", data: "[20]{id,name,email}:\n  ..." }
 *
 * // Mixed array: JSON wins
 * const result = maybeEncode(mixedData);
 * // { format: "json", data: "[{\"type\":\"a\",...}]" }
 * ```
 */
export function maybeEncode(
  data: unknown[],
  threshold: number = 10
): MaybeEncodeResult {
  // Empty arrays always use JSON -- no savings possible
  if (data.length === 0) {
    return { format: "json", data: "[]" };
  }

  const jsonStr = JSON.stringify(data);
  const toonStr = encode(data);

  const jsonTokens = estimateTokens(jsonStr);
  const toonTokens = estimateTokens(toonStr);

  const savingsPercent =
    jsonTokens > 0 ? ((jsonTokens - toonTokens) / jsonTokens) * 100 : 0;

  if (savingsPercent >= threshold) {
    return { format: "toon", data: toonStr };
  }

  return { format: "json", data: jsonStr };
}

/**
 * Estimate token savings from using TOON instead of JSON.
 *
 * Encodes the data in both formats and compares estimated token counts.
 * Useful for previewing savings before committing to an encoding format.
 *
 * @param data - Array of objects or primitives to analyze
 * @returns Object with jsonTokens, toonTokens, and savingsPercent (clamped >= 0)
 *
 * @example
 * ```typescript
 * const est = estimateTokenSavings(users);
 * console.log(`JSON: ${est.jsonTokens}, TOON: ${est.toonTokens}, Savings: ${est.savingsPercent}%`);
 * // JSON: 450, TOON: 280, Savings: 37.8%
 * ```
 */
export function estimateTokenSavings(data: unknown[]): TokenSavingsEstimate {
  if (data.length === 0) {
    return { jsonTokens: 0, toonTokens: 0, savingsPercent: 0 };
  }

  const jsonStr = JSON.stringify(data);
  const toonStr = encode(data);

  const jsonTokens = estimateTokens(jsonStr);
  const toonTokens = estimateTokens(toonStr);

  const savingsPercent =
    jsonTokens > 0
      ? Math.max(0, ((jsonTokens - toonTokens) / jsonTokens) * 100)
      : 0;

  return {
    jsonTokens,
    toonTokens,
    savingsPercent: Math.round(savingsPercent * 10) / 10,
  };
}

// ============================================================================
// CLI INTERFACE
// ============================================================================

async function readStdin(): Promise<string> {
  const chunks: string[] = [];
  const reader = Bun.stdin.stream().getReader();
  const decoder = new TextDecoder();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(decoder.decode(value, { stream: true }));
  }

  return chunks.join("").trim();
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === "--help" || command === "-h") {
    console.log(`
ToonHelper - TOON Format Encoding/Decoding Utility

Usage:
  echo '<json-array>' | bun run ToonHelper.ts encode     Encode JSON array to TOON
  echo '<toon-string>' | bun run ToonHelper.ts decode     Decode TOON back to JSON
  echo '<json-array>' | bun run ToonHelper.ts estimate    Estimate token savings
  echo '<json-array>' | bun run ToonHelper.ts smart       Smart encode (picks best format)

Options:
  --threshold <n>   Savings threshold for smart encoding (default: 10%)
  --help, -h        Show this help

Examples:
  echo '[{"name":"Alice","age":30},{"name":"Bob","age":25}]' | bun run ToonHelper.ts encode
  echo '[{"name":"Alice","age":30},{"name":"Bob","age":25}]' | bun run ToonHelper.ts estimate
`);
    process.exit(0);
  }

  const input = await readStdin();
  if (!input) {
    console.error("Error: No input on stdin");
    process.exit(1);
  }

  switch (command) {
    case "encode": {
      const data = JSON.parse(input);
      if (!Array.isArray(data)) {
        console.error("Error: Input must be a JSON array");
        process.exit(1);
      }
      console.log(toToon(data));
      break;
    }

    case "decode": {
      const decoded = fromToon(input);
      console.log(JSON.stringify(decoded, null, 2));
      break;
    }

    case "estimate": {
      const data = JSON.parse(input);
      if (!Array.isArray(data)) {
        console.error("Error: Input must be a JSON array");
        process.exit(1);
      }
      const est = estimateTokenSavings(data);
      console.log(JSON.stringify(est, null, 2));
      break;
    }

    case "smart": {
      const data = JSON.parse(input);
      if (!Array.isArray(data)) {
        console.error("Error: Input must be a JSON array");
        process.exit(1);
      }
      const thresholdIdx = args.indexOf("--threshold");
      const threshold =
        thresholdIdx >= 0 ? Number(args[thresholdIdx + 1]) : 10;
      const result = maybeEncode(data, threshold);
      console.log(JSON.stringify({ format: result.format }, null, 2));
      console.log(result.data);
      break;
    }

    default:
      console.error(`Unknown command: ${command}`);
      console.error("Use --help for available commands");
      process.exit(1);
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("Error:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
