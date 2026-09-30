/**
 * LearningEntrySchema.test.ts
 *
 * Proves:
 *  (a) each of the 4 MEMORY/LEARNING writers' real, current construction
 *      shapes pass the schema variant that models them.
 *  (b) real malformed lines — sampled 2026-07-03 from the on-disk
 *      MEMORY/LEARNING/SIGNALS/ratings.jsonl corpus, none of which match any
 *      of the 3 current writer contracts — are rejected by
 *      validateLearningEntry.
 *  (c) one real line sampled from each of the 3 ratings.jsonl writers'
 *      formats round-trips through validateLearningEntry unchanged (no
 *      reshaping — same keys, same values).
 */
import { describe, it, expect } from "bun:test";
import {
  TelegramRatingSignalSchema,
  SessionImplicitRatingSchema,
  ExplicitHookRatingSchema,
  RatingsLineSchema,
  LearningEntrySchema,
  validateLearningEntry,
} from "./LearningEntrySchema.ts";

// ── (a) each writer's real construction shape passes its schema variant ────

describe("LearningEntrySchema — per-writer real shapes", () => {
  it("LearningCapture.ts (Telegram gateway) — explicit N/10 rating branch", () => {
    // Mirrors the `signal` object literal built in captureLearning()'s
    // explicitRating branch (source: "telegram").
    const signal = {
      timestamp: new Date().toISOString(),
      rating: 8,
      session_id: "abc-session-1",
      source: "telegram",
      sentiment_summary: "Explicit rating: 8/10",
      confidence: 0.95,
      platform: "telegram",
      message_type: "text",
      profile: "general",
    };
    expect(TelegramRatingSignalSchema.safeParse(signal).success).toBe(true);
  });

  it("LearningCapture.ts (Telegram gateway) — default neutral branch, profile omitted", () => {
    // Mirrors the default/neutral branch: session.currentProfile can be
    // undefined, so `profile` is legitimately absent (not just optional-but-set).
    const signal = {
      timestamp: new Date().toISOString(),
      rating: 5,
      session_id: "abc-session-2",
      source: "implicit",
      sentiment_summary: "Neutral exchange, no sentiment detected",
      confidence: 0.5,
      platform: "telegram",
      message_type: "text",
    };
    expect(TelegramRatingSignalSchema.safeParse(signal).success).toBe(true);
  });

  it("ExplicitRatingCapture.hook.ts — bare rating, no comment", () => {
    const entry = { timestamp: "2026-07-03T09:51:30-07:00", rating: 8, session_id: "smoke-test" };
    expect(ExplicitHookRatingSchema.safeParse(entry).success).toBe(true);
  });

  it("ExplicitRatingCapture.hook.ts — rating with trailing comment", () => {
    const entry = {
      timestamp: "2026-01-27T09:44:19-08:00",
      rating: 1,
      session_id: "721c7040-3372-41e4-8a8d-5497f8ea360b",
      comment: "AWS, Snowflake, DBT. In the past I've also used GCP.",
    };
    expect(ExplicitHookRatingSchema.safeParse(entry).success).toBe(true);
  });

  it("SessionRatingCapture.hook.ts — SessionRatingRow", () => {
    const row = {
      timestamp: "2026-06-30T11:32:15.390Z",
      rating: 6,
      session_id: "78eae622-f0e1-4c05-8414-911cc2d17818",
      source: "implicit",
      sentiment_summary: "Sync-All completed successfully; minor teardown integration errors.",
      confidence: 0.68,
    };
    expect(SessionImplicitRatingSchema.safeParse(row).success).toBe(true);
  });



  it("each variant is reachable through the top-level LearningEntrySchema union", () => {
    const telegram = { timestamp: "t", rating: 5, session_id: "s", source: "implicit", sentiment_summary: "x", confidence: 0.5, platform: "telegram", message_type: "text" };
    const sessionImplicit = { timestamp: "t", rating: 5, session_id: "s", source: "implicit", sentiment_summary: "x", confidence: 0.5 };
    const explicitHook = { timestamp: "t", rating: 5, session_id: "s" };

    expect(LearningEntrySchema.safeParse(telegram).success).toBe(true);
    expect(LearningEntrySchema.safeParse(sessionImplicit).success).toBe(true);
    expect(LearningEntrySchema.safeParse(explicitHook).success).toBe(true);
  });
});

// ── (b) real malformed rows sampled from the on-disk corpus are rejected ───

describe("LearningEntrySchema — real malformed rows from MEMORY/LEARNING/SIGNALS/ratings.jsonl", () => {
  it("rejects a legacy row missing `rating` entirely (source-only implicit stub)", () => {
    // Real row sampled from the corpus 2026-07-03; predates all 3 current
    // ratings.jsonl writers (no writer today ever omits `rating`).
    const row = {
      timestamp: "2026-01-19T12:39:08-08:00",
      session_id: "dfeb910f-06b8-4d92-b574-7268818dc46a",
      source: "implicit",
    };
    const result = validateLearningEntry(row);
    expect(result.success).toBe(false);
  });

  it("rejects a legacy row using `session`/`context` instead of `session_id`/`sentiment_summary`", () => {
    // Real row from an unknown/deleted writer, session_id
    // "autonomous-work-phase2-batch"; sampled from the corpus 2026-07-03.
    const row = {
      timestamp: "2026-02-06T02:35:00.000Z",
      rating: 9,
      context: "Autonomous work orchestration: 6 items executed via 5 parallel agents",
      session: "autonomous-work-phase2-batch",
    };
    const result = validateLearningEntry(row);
    expect(result.success).toBe(false);
  });

  it("rejects a row with `source` but missing sentiment_summary/confidence (partial write, matches no writer contract)", () => {
    // Real row sampled from the corpus 2026-07-03 — has source:"implicit" like
    // SessionRatingCapture rows, but SessionRatingCapture never omits
    // sentiment_summary/confidence, and ExplicitRatingCapture never writes
    // `source` at all. Matches neither.
    const row = {
      timestamp: "2026-03-09T20:41:08-07:00",
      rating: 5,
      session_id: "b4195488-4114-45bd-8388-b5fede1f9f86",
      source: "implicit",
    };
    expect(validateLearningEntry(row).success).toBe(false);
  });

  it("rejects non-object JSON", () => {
    expect(validateLearningEntry([1, 2, 3]).success).toBe(false);
    expect(validateLearningEntry("just a string").success).toBe(false);
    expect(validateLearningEntry(null).success).toBe(false);
  });

  it("rejects rating outside 1-10", () => {
    expect(validateLearningEntry({ timestamp: "t", rating: 11, session_id: "s" }).success).toBe(false);
    expect(validateLearningEntry({ timestamp: "t", rating: 0, session_id: "s" }).success).toBe(false);
  });

  it("rejects a well-formed SessionImplicitRating shape with an extra unknown key (strict rejects extras)", () => {
    const row = {
      timestamp: "t",
      rating: 5,
      session_id: "s",
      source: "implicit",
      sentiment_summary: "x",
      confidence: 0.5,
      unexpected_future_field: "should not silently pass today",
    };
    // Deliberately strict: a genuinely new field should surface as a rejected
    // line (logged/counted by the reader) rather than silently validate,
    // until this schema file is updated to model it.
    expect(RatingsLineSchema.safeParse(row).success).toBe(false);
  });

  it("returns a ZodError on the failure branch of validateLearningEntry", () => {
    const result = validateLearningEntry({ nonsense: true });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.length).toBeGreaterThan(0);
    }
  });
});

// ── (c) real per-writer lines round-trip unchanged ──────────────────────────

describe("LearningEntrySchema — round-trip fidelity on real sampled lines", () => {
  const realLines: Array<{ label: string; line: string }> = [
    {
      label: "LearningCapture.ts (telegram)",
      line: '{"timestamp": "2026-02-18T19:52:18.343Z", "rating": 5, "session_id": "8009738983-2026-02-18T19-25-06", "source": "implicit", "sentiment_summary": "Neutral exchange, no sentiment detected", "confidence": 0.5, "platform": "telegram", "message_type": "text", "profile": "general"}',
    },
    {
      label: "SessionRatingCapture.hook.ts",
      line: '{"timestamp":"2026-06-30T11:32:15.390Z","rating":6,"session_id":"78eae622-f0e1-4c05-8414-911cc2d17818","source":"implicit","sentiment_summary":"Sync-All completed successfully; minor teardown integration errors.","confidence":0.68}',
    },
    {
      label: "ExplicitRatingCapture.hook.ts (no comment)",
      line: '{"timestamp":"2026-07-03T09:51:30-07:00","rating":8,"session_id":"smoke-test"}',
    },
  ];

  for (const { label, line } of realLines) {
    it(`round-trips a real ${label} line with no reshaping`, () => {
      const raw = JSON.parse(line);
      const result = validateLearningEntry(raw);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toEqual(raw);
      }
    });
  }
});
