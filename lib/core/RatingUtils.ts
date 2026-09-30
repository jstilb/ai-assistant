/**
 * RatingUtils — Shared rating parsing utilities for the ExplicitRatingCapture
 * hook. (ImplicitSentimentCapture, the other original consumer, was deleted
 * 2026-07-03 — de-registered since April 2026.)
 *
 * Usage:
 *   import { parseRating, isExplicitRating } from 'lib/core/RatingUtils.ts';
 *   const result = parseRating("8/10 - great response");
 *   // → { rating: 8, comment: "great response" }
 */

export interface ParsedRating {
  /** Numeric rating value, 1–10 */
  rating: number;
  /** Optional comment following the rating */
  comment?: string;
}

/**
 * Parse a user prompt for an explicit rating pattern.
 * Returns null if the prompt is not a rating.
 *
 * Recognized patterns:
 *   "8"          → { rating: 8 }
 *   "8/10"       → { rating: 8 }            (explicit fraction form)
 *   "8/10 great" → { rating: 8, comment: "great" }
 *   "8 - good"   → { rating: 8, comment: "good" }
 *   "8: good"    → { rating: 8, comment: "good" }
 *
 * A trailing comment REQUIRES an explicit "/10" or a "-"/":" separator. A bare word
 * after the digit ("8 are complete", "1 and then 3") is ordinary prose, NOT a rating —
 * this prevents the false-positive `rating: 1` entries that corrupted ratings.jsonl
 * (digit-prefixed task continuations were being captured as ratings). Replaces the old
 * sentence-starter blocklist, which only caught an enumerated set of leading words.
 */
export function parseRating(prompt: string): ParsedRating | null {
  const trimmed = prompt.trim();
  if (!trimmed) return null;

  // Form 1: explicit "/10" fraction — unambiguous; any trailing text is a comment.
  const fractionMatch = trimmed.match(/^(10|[1-9])\/10\b\s*(.*)$/);
  if (fractionMatch) {
    return { rating: parseInt(fractionMatch[1], 10), comment: fractionMatch[2]?.trim() || undefined };
  }

  // Form 2: a bare number on its own line — "8", "10".
  const standaloneMatch = trimmed.match(/^(10|[1-9])$/);
  if (standaloneMatch) {
    return { rating: parseInt(standaloneMatch[1], 10) };
  }

  // Form 3: number + explicit "-"/":" separator + comment — "8 - great", "8: great".
  const separatorMatch = trimmed.match(/^(10|[1-9])\s*[-:]\s*(.+)$/);
  if (separatorMatch) {
    return { rating: parseInt(separatorMatch[1], 10), comment: separatorMatch[2]?.trim() || undefined };
  }

  return null;
}

/**
 * Returns true if the prompt is an explicit rating (any form parseRating recognizes).
 *
 * Originally isExplicitRating() in hooks/ImplicitSentimentCapture.hook.ts
 * (deleted 2026-07-03); this is now the only home of that logic.
 */
export function isExplicitRating(prompt: string): boolean {
  return parseRating(prompt) !== null;
}
