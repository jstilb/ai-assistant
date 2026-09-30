/**
 * LearningEntrySchema — Zod schemas for the lines written into MEMORY/LEARNING/
 * by the three current writers:
 *
 *   1. skills/Communication/Telegram/Server/gateway/LearningCapture.ts
 *      → MEMORY/LEARNING/SIGNALS/ratings.jsonl  (RatingSignal)
 *   2. hooks/ExplicitRatingCapture.hook.ts
 *      → MEMORY/LEARNING/SIGNALS/ratings.jsonl  (RatingEntry)
 *   3. hooks/SessionRatingCapture.hook.ts
 *      → MEMORY/LEARNING/SIGNALS/ratings.jsonl  (SessionRatingRow)
 *
 * Three DIFFERENT writers append to the SAME file (ratings.jsonl) with THREE
 * genuinely different shapes — there is no discriminant field common to all
 * of them (ExplicitRatingCapture never writes `source` at all; the other two
 * always do). This is modeled as a union of per-writer variants rather than
 * one shape with optional fields, so that:
 *   - each writer can `.parse()` its own exact contract at construction time
 *     (a strict, self-checking write), and
 *   - a reader can `safeParse()` against the union and reject lines that
 *     don't match ANY of the three real contracts (see validateLearningEntry).
 *
 * Every variant is grepped from the writers' own TypeScript interfaces as of
 * 2026-07-03 (see RatingSignal / RatingEntry / SessionRatingRow) — this file models
 * what those writers actually construct, not an aspirational shape.
 *
 * FLAGGED: sampling the real, on-disk MEMORY/LEARNING/SIGNALS/ratings.jsonl
 * corpus (5220 lines, 2026-07-03) turned up 11 lines that match NONE of the
 * three real variants below — legacy debris from a deleted writer
 * (ImplicitSentimentCapture, removed 2026-07-03) and at least one unknown
 * writer (`session`/`context` keys instead of `session_id`/`sentiment_summary`,
 * session_id "autonomous-work-phase2-batch"). These are intentionally
 * rejected by RatingsLineSchema/validateLearningEntry — see
 * LearningEntrySchema.test.ts's "real malformed rows" suite for the exact
 * samples. This IS the union-inconsistency the S6b task asked to flag.
 *
 * Style: each variant uses `.strict()` (reject unknown keys), NOT
 * `.passthrough()` (contrast lib/core/MemoryPaths.ts's single-shape
 * `.passthrough()` convention). Passthrough was considered and rejected here:
 * with three variants that are structural subsets of one another (the
 * minimal ExplicitHookRatingSchema is a strict subset of the other two),
 * passthrough would make the loosest variant swallow every shape in a
 * z.union, defeating exactly the discrimination this file exists to provide
 * (see the 11 rejected corpus lines above — several of them WOULD have
 * passed a passthrough minimal-shape check). `.strict()` is what makes "3
 * required keys and nothing else" and "6 required keys and nothing else"
 * mutually exclusive matches.
 */

import { z } from 'zod';

// ── Shared base fields (every ratings.jsonl variant has these three) ────────

const RatingsBaseShape = {
  timestamp: z.string().min(1),
  // All 3 writers construct rating as an integer 1-10 (parseInt/hardcoded
  // literals/Math.round + range-checked before write) — no writer has ever
  // produced a fractional or out-of-range value (verified against the full
  // 5220-line corpus, 2026-07-03).
  rating: z.number().int().min(1).max(10),
  session_id: z.string().min(1),
};

// ── Variant 1: hooks/ExplicitRatingCapture.hook.ts — `RatingEntry` ──────────
//
// The minimal shape: this hook only ever knows the number the user typed
// plus an optional trailing comment. No `source`/`sentiment_summary`/
// `confidence` — those fields are never constructed by this writer.

export const ExplicitHookRatingSchema = z
  .object({
    ...RatingsBaseShape,
    comment: z.string().optional(),
  })
  .strict();
export type ExplicitHookRating = z.infer<typeof ExplicitHookRatingSchema>;

// ── Variant 2: hooks/SessionRatingCapture.hook.ts — `SessionRatingRow` ──────
//
// One inferred rating per session at SessionEnd. `source` is always the
// literal "implicit" — this writer never produces "explicit" or "telegram".

export const SessionImplicitRatingSchema = z
  .object({
    ...RatingsBaseShape,
    source: z.literal('implicit'),
    sentiment_summary: z.string(),
    // Not range-clamped by the writer (only a `typeof === "number"` check
    // guards the LLM's output before write) — modeled unconstrained rather
    // than inventing a 0-1 bound the code doesn't actually enforce.
    confidence: z.number(),
  })
  .strict();
export type SessionImplicitRating = z.infer<typeof SessionImplicitRatingSchema>;

// ── Variant 3: LearningCapture.ts (Telegram gateway) — `RatingSignal` ───────
//
// `source` is "telegram" when the rating came from an explicit N/10 in the
// message, "implicit" for sentiment-implied or the default neutral case.
// `profile` is optional (session.currentProfile can be undefined).

export const TelegramRatingSignalSchema = z
  .object({
    ...RatingsBaseShape,
    source: z.enum(['telegram', 'implicit']),
    sentiment_summary: z.string(),
    confidence: z.number(),
    platform: z.literal('telegram'),
    message_type: z.string(),
    profile: z.string().optional(),
  })
  .strict();
export type TelegramRatingSignal = z.infer<typeof TelegramRatingSignalSchema>;

/**
 * The real union of everything written to MEMORY/LEARNING/SIGNALS/ratings.jsonl
 * by the 3 current writers that target that file.
 */
export const RatingsLineSchema = z.union([
  TelegramRatingSignalSchema,
  SessionImplicitRatingSchema,
  ExplicitHookRatingSchema,
]);
export type RatingsLine = z.infer<typeof RatingsLineSchema>;

/**
 * The real union of everything written by all 3 MEMORY/LEARNING writers.
 */
export const LearningEntrySchema = z.union([
  TelegramRatingSignalSchema,
  SessionImplicitRatingSchema,
  ExplicitHookRatingSchema,
]);
export type LearningEntry = z.infer<typeof LearningEntrySchema>;

export type LearningEntryValidationResult =
  | { success: true; data: LearningEntry }
  | { success: false; error: z.ZodError };

/**
 * Validate a raw parsed-JSON value against the full real union of
 * MEMORY/LEARNING writer shapes. Never throws.
 */
export function validateLearningEntry(raw: unknown): LearningEntryValidationResult {
  const result = LearningEntrySchema.safeParse(raw);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, error: result.error };
}
