/**
 * SessionRatingCapture.hook.test.ts — TDD tests for per-session implicit rating
 * + session-end learning capture (S8, let-the-model-speak)
 *
 * ISC-1: Writes exactly ONE row to ratings.jsonl with source:"implicit", rating:7,
 *        and session_id matching the payload's session_id.
 * ISC-2: A second invocation with the same session_id writes NO additional row.
 * ISC-3: When inference throws, NO row is written and the handler does not throw.
 * ISC-4: When the transcript is empty/missing, NO row is written.
 * ISC-5 (S8): The same inference call's `learnings` array is written as
 *        LEARNING/<category>/<yearMonth>/*.md files, one per learning.
 * ISC-6 (S8): An empty (or absent) `learnings` array writes zero learning files.
 * ISC-7 (S8): A malformed individual learning item is dropped; valid siblings
 *        still get written (per-item fail-open, matches parseLearningsArray).
 * ISC-8 (S8): Idempotency — a second invocation with the same session_id
 *        (which the ISC-2 ratings.jsonl gate already blocks pre-inference)
 *        also writes NO additional learning files.
 * ISC-9 (S8): End-to-end wiring for the two properties the task_learning_capture
 *        eval proves against real inference — an out-of-vocabulary learning
 *        (lc07-style transcript) writes one correctly-categorized file; a
 *        frustration-venting transcript with nothing resolved (lc09/lc10-style)
 *        writes zero learning files.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { runSessionRatingCapture, type SessionRatingDeps } from "./SessionRatingCapture.hook.ts";
import type { InferenceResult } from "../lib/core/Inference.ts";
import { SessionImplicitRatingSchema } from "../lib/core/LearningEntrySchema.ts";

// ── helpers ────────────────────────────────────────────────────────────────────

function makeInferenceFn(override?: Partial<{ rating: number; sentiment_summary: string; confidence: number; learnings: unknown }>) {
  const defaults = { rating: 7, sentiment_summary: "Session went well", confidence: 0.8, learnings: [] as unknown[] };
  const result = { ...defaults, ...override };
  return async (): Promise<InferenceResult> => ({
    success: true,
    output: JSON.stringify(result),
    parsed: result,
    latencyMs: 1,
    level: "fast" as const,
    estimatedTokens: { input: 10, output: 10, total: 20 },
    estimatedCostUSD: 0.001,
  });
}

/** Recursively list every file under a directory (empty array if it doesn't exist). */
function listFilesRecursive(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFilesRecursive(full));
    else out.push(full);
  }
  return out;
}

function makeBrokenInferenceFn() {
  return async (): Promise<InferenceResult> => {
    throw new Error("Inference exploded");
  };
}

function makeFailingInferenceFn() {
  return async (): Promise<InferenceResult> => ({
    success: false,
    output: "",
    error: "Model unavailable",
    latencyMs: 1,
    level: "fast" as const,
    estimatedTokens: { input: 0, output: 0, total: 0 },
    estimatedCostUSD: 0,
  });
}

function readRatings(ratingsPath: string): Array<Record<string, unknown>> {
  if (!existsSync(ratingsPath)) return [];
  return readFileSync(ratingsPath, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map(line => JSON.parse(line) as Record<string, unknown>);
}

// ── test setup ─────────────────────────────────────────────────────────────────

let tmpDir: string;
let ratingsPath: string;
let learningsDir: string;
let transcriptPath: string;

const SESSION_ID = "test-session-abc-123";

const SAMPLE_TRANSCRIPT_CONTENT = JSON.stringify({
  type: "user",
  message: { content: "Can you help me fix this bug?" },
}) + "\n" + JSON.stringify({
  type: "assistant",
  message: { content: "Sure! Here is the fix." },
}) + "\n";

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "session-rating-test-"));
  const signalsDir = join(tmpDir, "MEMORY", "LEARNING", "SIGNALS");
  mkdirSync(signalsDir, { recursive: true });
  ratingsPath = join(signalsDir, "ratings.jsonl");
  learningsDir = join(tmpDir, "MEMORY", "LEARNING");

  // Create a valid transcript file
  transcriptPath = join(tmpDir, "session.jsonl");
  writeFileSync(transcriptPath, SAMPLE_TRANSCRIPT_CONTENT, "utf-8");
});

afterEach(() => {
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

function makeDeps(overrides: Partial<SessionRatingDeps> = {}): SessionRatingDeps {
  return {
    inferenceFn: makeInferenceFn(),
    ratingsPath,
    learningsDir,
    transcriptReader: () => SAMPLE_TRANSCRIPT_CONTENT,
    ...overrides,
  };
}

// ── ISC-1: Writes one row with correct fields ───────────────────────────────

describe("ISC-1: writes exactly one row with correct fields", () => {
  it("appends one implicit rating row to ratings.jsonl", async () => {
    const deps = makeDeps();
    await runSessionRatingCapture({ session_id: SESSION_ID, transcript_path: transcriptPath }, deps);

    const rows = readRatings(ratingsPath);
    expect(rows).toHaveLength(1);

    const row = rows[0];
    expect(row.source).toBe("implicit");
    expect(row.rating).toBe(7);
    expect(row.session_id).toBe(SESSION_ID);
    expect(typeof row.timestamp).toBe("string");
    expect(typeof row.sentiment_summary).toBe("string");
    expect(typeof row.confidence).toBe("number");
  });
});

// ── ISC S6b: written row satisfies SessionImplicitRatingSchema ─────────────

describe("ISC S6b: written row is schema-parsed before append (construction-time guarantee)", () => {
  it("the appended row satisfies SessionImplicitRatingSchema exactly", async () => {
    const deps = makeDeps();
    await runSessionRatingCapture({ session_id: SESSION_ID, transcript_path: transcriptPath }, deps);

    const rows = readRatings(ratingsPath);
    expect(rows).toHaveLength(1);
    const parsed = SessionImplicitRatingSchema.safeParse(rows[0]);
    expect(parsed.success).toBe(true);
  });

  it("does not throw and writes nothing when the schema would reject the constructed row (out-of-range rating from a misbehaving inference stub)", async () => {
    // parseRating's own typeof/range guard already rejects this before the
    // row is ever constructed — this proves the schema.parse() addition
    // doesn't change that fail-open behavior.
    const deps = makeDeps({ inferenceFn: makeInferenceFn({ rating: 999 }) });
    await expect(
      runSessionRatingCapture({ session_id: SESSION_ID, transcript_path: transcriptPath }, deps)
    ).resolves.toBeUndefined();

    const rows = readRatings(ratingsPath);
    expect(rows).toHaveLength(0);
  });
});

// ── ISC-2: Idempotency — second invocation with same session_id writes nothing ─

describe("ISC-2: idempotency — second call with same session_id skips write", () => {
  it("does not add a second row on repeated invocation", async () => {
    const deps = makeDeps();
    const payload = { session_id: SESSION_ID, transcript_path: transcriptPath };

    await runSessionRatingCapture(payload, deps);
    await runSessionRatingCapture(payload, deps);

    const rows = readRatings(ratingsPath);
    expect(rows).toHaveLength(1);
  });
});

// ── ISC-3: Inference throws → no write, no rethrow ─────────────────────────

describe("ISC-3: inference failure — no write, handler does not throw", () => {
  it("does not write and returns cleanly when inferenceFn throws", async () => {
    const deps = makeDeps({ inferenceFn: makeBrokenInferenceFn() });
    // Must not throw
    await expect(
      runSessionRatingCapture({ session_id: SESSION_ID, transcript_path: transcriptPath }, deps)
    ).resolves.toBeUndefined();

    const rows = readRatings(ratingsPath);
    expect(rows).toHaveLength(0);
  });

  it("does not write and returns cleanly when inferenceFn returns success:false", async () => {
    const deps = makeDeps({ inferenceFn: makeFailingInferenceFn() });
    await expect(
      runSessionRatingCapture({ session_id: SESSION_ID, transcript_path: transcriptPath }, deps)
    ).resolves.toBeUndefined();

    const rows = readRatings(ratingsPath);
    expect(rows).toHaveLength(0);
  });
});

// ── ISC-4: Empty/missing transcript → no write ─────────────────────────────

describe("ISC-4: empty or missing transcript — no write", () => {
  it("does not write when transcript content is empty string", async () => {
    const deps = makeDeps({ transcriptReader: () => "" });
    await runSessionRatingCapture({ session_id: SESSION_ID, transcript_path: transcriptPath }, deps);

    const rows = readRatings(ratingsPath);
    expect(rows).toHaveLength(0);
  });

  it("does not write when transcript is too short (whitespace only)", async () => {
    const deps = makeDeps({ transcriptReader: () => "   \n  " });
    await runSessionRatingCapture({ session_id: SESSION_ID, transcript_path: transcriptPath }, deps);

    const rows = readRatings(ratingsPath);
    expect(rows).toHaveLength(0);
  });

  it("does not write when transcript_path is missing from disk and transcriptReader returns null", async () => {
    const deps = makeDeps({ transcriptReader: () => null });
    await runSessionRatingCapture({ session_id: "no-transcript-session", transcript_path: "/nonexistent/path.jsonl" }, deps);

    const rows = readRatings(ratingsPath);
    expect(rows).toHaveLength(0);
  });
});

// ── ISC-5 (S8): learnings array is written as LEARNING/<category>/<yearMonth>/*.md ─

describe("ISC-5 (S8): learnings from the same inference call are written as files", () => {
  it("writes one file per learning under LEARNING/<category>/<yearMonth>/", async () => {
    const deps = makeDeps({
      inferenceFn: makeInferenceFn({
        learnings: [
          { summary: "Nightly cron silently stopped emitting output", category: "SYSTEM", evidence: "needed a keep-alive signal across sleep cycles" },
          { summary: "Assumed the wrong scope and had to redo the work", category: "ALGORITHM", evidence: "checking in first would have saved a rewrite" },
        ],
      }),
    });

    await runSessionRatingCapture({ session_id: SESSION_ID, transcript_path: transcriptPath }, deps);

    const files = listFilesRecursive(learningsDir).filter(f => f.endsWith(".md"));
    expect(files).toHaveLength(2);

    const systemFile = files.find(f => f.startsWith(join(learningsDir, "SYSTEM")));
    const algorithmFile = files.find(f => f.startsWith(join(learningsDir, "ALGORITHM")));
    expect(systemFile).toBeDefined();
    expect(algorithmFile).toBeDefined();

    const systemContent = readFileSync(systemFile!, "utf-8");
    expect(systemContent).toContain("capture_type: LEARNING");
    expect(systemContent).toContain(`session_id: ${SESSION_ID}`);
    expect(systemContent).toContain("category: SYSTEM");
    expect(systemContent).toContain("Nightly cron silently stopped emitting output");
    expect(systemContent).toContain("needed a keep-alive signal across sleep cycles");

    const algorithmContent = readFileSync(algorithmFile!, "utf-8");
    expect(algorithmContent).toContain("category: ALGORITHM");
    expect(algorithmContent).toContain("Assumed the wrong scope and had to redo the work");
  });

  it("still writes the rating row when learnings are also present (combined call doesn't regress rating write)", async () => {
    const deps = makeDeps({
      inferenceFn: makeInferenceFn({
        learnings: [{ summary: "A real learning", category: "SYSTEM", evidence: "evidence text" }],
      }),
    });
    await runSessionRatingCapture({ session_id: SESSION_ID, transcript_path: transcriptPath }, deps);

    const rows = readRatings(ratingsPath);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.rating).toBe(7);
  });
});

// ── ISC-6 (S8): empty/absent learnings array writes zero files ─────────────

describe("ISC-6 (S8): empty or absent learnings array writes zero learning files", () => {
  it("writes zero learning files when learnings: [] (explicit empty array)", async () => {
    const deps = makeDeps({ inferenceFn: makeInferenceFn({ learnings: [] }) });
    await runSessionRatingCapture({ session_id: SESSION_ID, transcript_path: transcriptPath }, deps);

    expect(listFilesRecursive(learningsDir).filter(f => f.endsWith(".md"))).toHaveLength(0);
  });

  it("writes zero learning files when the inference output omits `learnings` entirely", async () => {
    const inferenceFn = async (): Promise<InferenceResult> => {
      const result = { rating: 6, sentiment_summary: "Fine", confidence: 0.7 }; // no `learnings` key at all
      return {
        success: true,
        output: JSON.stringify(result),
        parsed: result,
        latencyMs: 1,
        level: "fast" as const,
        estimatedTokens: { input: 10, output: 10, total: 20 },
        estimatedCostUSD: 0.001,
      };
    };
    const deps = makeDeps({ inferenceFn });
    await runSessionRatingCapture({ session_id: SESSION_ID, transcript_path: transcriptPath }, deps);

    // Rating still gets written (learnings is purely additive, never required)
    expect(readRatings(ratingsPath)).toHaveLength(1);
    expect(listFilesRecursive(learningsDir).filter(f => f.endsWith(".md"))).toHaveLength(0);
  });
});

// ── ISC-7 (S8): malformed individual learning item is dropped, valid siblings survive ─

describe("ISC-7 (S8): per-item fail-open for malformed learning entries", () => {
  it("drops a malformed item but still writes the valid sibling", async () => {
    const deps = makeDeps({
      inferenceFn: makeInferenceFn({
        learnings: [
          { summary: "Valid one", category: "ALGORITHM", evidence: "ev" },
          { summary: "Missing category entirely" }, // malformed — no `category`
          { summary: "", category: "SYSTEM", evidence: "ev2" }, // malformed — empty summary
        ],
      }),
    });
    await runSessionRatingCapture({ session_id: SESSION_ID, transcript_path: transcriptPath }, deps);

    const files = listFilesRecursive(learningsDir).filter(f => f.endsWith(".md"));
    expect(files).toHaveLength(1);
    expect(readFileSync(files[0]!, "utf-8")).toContain("Valid one");
  });
});

// ── ISC-8 (S8): idempotency — re-fire writes no additional learning files ─

describe("ISC-8 (S8): idempotency — second invocation writes no additional learning files", () => {
  it("does not duplicate learning files on repeated invocation for the same session_id", async () => {
    const deps = makeDeps({
      inferenceFn: makeInferenceFn({
        learnings: [{ summary: "A one-time learning", category: "SYSTEM", evidence: "ev" }],
      }),
    });
    const payload = { session_id: SESSION_ID, transcript_path: transcriptPath };

    await runSessionRatingCapture(payload, deps);
    await runSessionRatingCapture(payload, deps);

    const files = listFilesRecursive(learningsDir).filter(f => f.endsWith(".md"));
    expect(files).toHaveLength(1);
  });
});

// ── ISC-9 (S8): end-to-end wiring for the two anti-gaming properties the ─────
// task_learning_capture eval (skills/Intelligence/Evals/Data/golden/
// learning-capture-fixtures.jsonl) proves against REAL inference — lc07 (an
// out-of-vocabulary SYSTEM learning, no regex-vocabulary word present) and
// lc09/lc10 (frustration venting with nothing resolved). The eval already
// proves the LLM judges these two inputs correctly; this test proves the
// hook's file-writing pipeline correctly turns each judgment into the right
// on-disk effect. inferenceFn is DI-stubbed (no live model call in a unit
// test), but returns exactly what the eval recorded the real model producing
// for this transcript content — the transcript argument is not inert
// boilerplate here, unlike the other ISC-5..8 cases.

describe("ISC-9 (S8): end-to-end — out-of-vocabulary learning and frustration venting", () => {
  it("an out-of-vocabulary SYSTEM learning (lc07-style transcript) writes one correctly-categorized file", async () => {
    const outOfVocabTranscript = JSON.stringify({
      type: "user",
      message: { content: "Anything odd with the nightly jobs lately?" },
    }) + "\n" + JSON.stringify({
      type: "assistant",
      message: {
        content:
          "Turns out the nightly cron silently stopped emitting output three days ago; it needed a keep-alive signal added to survive the box's sleep cycles.",
      },
    }) + "\n";

    const deps = makeDeps({
      transcriptReader: () => outOfVocabTranscript,
      // Matches lc07's real-inference-verified expected output (eval:
      // MEMORY/EVALS/live-fixture-runs/learning-capture.json, is_learning:true,
      // category:SYSTEM) — the eval proves the LLM produces this judgment for
      // this exact input; here we prove the writer does the right thing with it.
      inferenceFn: makeInferenceFn({
        learnings: [{
          summary: "Nightly cron silently stopped emitting output for three days",
          category: "SYSTEM",
          evidence: "needed a keep-alive signal added to survive the box's sleep cycles",
        }],
      }),
    });

    await runSessionRatingCapture({ session_id: SESSION_ID, transcript_path: transcriptPath }, deps);

    const files = listFilesRecursive(learningsDir).filter(f => f.endsWith(".md"));
    expect(files).toHaveLength(1);
    expect(files[0]).toContain(join("LEARNING", "SYSTEM"));
    const content = readFileSync(files[0]!, "utf-8");
    expect(content).toContain("category: SYSTEM");
    expect(content).toContain("Nightly cron silently stopped emitting output");
  });

  it("frustration venting with nothing resolved (lc09/lc10-style transcript) writes zero learning files", async () => {
    const frustrationTranscript = JSON.stringify({
      type: "user",
      message: { content: "Any progress on the config issue?" },
    }) + "\n" + JSON.stringify({
      type: "assistant",
      message: { content: "This bug is so frustrating, I keep debugging it and it's still broken, ugh." },
    }) + "\n";

    const deps = makeDeps({
      transcriptReader: () => frustrationTranscript,
      // Matches lc09/lc10's real-inference-verified expected output (eval:
      // is_learning:false) — venting with no resolution is correctly judged
      // as an empty learnings array, not forced into a category.
      inferenceFn: makeInferenceFn({ learnings: [] }),
    });

    await runSessionRatingCapture({ session_id: SESSION_ID, transcript_path: transcriptPath }, deps);

    expect(listFilesRecursive(learningsDir).filter(f => f.endsWith(".md"))).toHaveLength(0);
    // Rating row still gets written — the frustration transcript is a valid
    // session, it's specifically the learning classification that is empty.
    expect(readRatings(ratingsPath)).toHaveLength(1);
  });
});
