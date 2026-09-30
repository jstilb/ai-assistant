#!/usr/bin/env bun
/**
 * SessionRatingCapture.hook.ts — Per-session implicit rating + learning capture
 * at SessionEnd
 *
 * PURPOSE:
 * Emits ONE implicit rating per session into ratings.jsonl at SessionEnd, so the
 * learning signals get real per-session rating data. As of S8
 * (let-the-model-speak), the SAME inference call also returns any genuine
 * learning moments from the session (`learnings: [{summary, category, evidence}]`),
 * which are written as MEMORY/LEARNING/<category>/<yearMonth>/*.md files
 * following the same file convention hooks/handlers/ResponseCapture.ts used
 * for its (now-deleted) per-stop learning branch — see docs/decisions/015.
 *
 * This is the ONE per-session-end LLM judgment call that replaced the
 * regex-first classifiers in hooks/lib/learning-utils.ts
 * (isLearningCapture()/getLearningCategory(), deleted in S8): "was this a
 * learning moment, and is it SYSTEM or ALGORITHM?" is content judgment that
 * belongs to the LLM, not a keyword dictionary.
 *
 * TRIGGER: SessionEnd
 *
 * INPUT:
 *   session_id:     Claude Code session UUID (from hook JSON)
 *   transcript_path: Path to the conversation transcript JSONL
 *
 * OUTPUT:
 *   - Appends ONE row to MEMORY/LEARNING/SIGNALS/ratings.jsonl
 *     Row shape: { timestamp, rating, session_id, source:"implicit", sentiment_summary, confidence }
 *   - Writes zero or more MEMORY/LEARNING/<SYSTEM|ALGORITHM>/<yearMonth>/*.md
 *     learning files (empty `learnings` array ⇒ zero files, the common case).
 *
 * IDEMPOTENCY:
 *   If a row already exists in ratings.jsonl with the same session_id AND
 *   source:"implicit", the hook exits BEFORE the inference call — this gate
 *   protects both the rating write and the learning-file writes, since both
 *   are downstream of the one inference call it guards. A per-file
 *   existsSync() check (deterministic filename) is a second, redundant safety
 *   net for the narrow edge case of a prior run's inference succeeding but
 *   its rating-row write failing (which would leave hasExistingImplicitRow()
 *   returning false on a re-fire) — see writeLearningFiles().
 *
 * ERROR POLICY:
 *   Fail-open: on any error (inference failure, missing transcript, bad input)
 *   the hook logs to stderr and exits 0. Never blocks session teardown.
 *
 * INTER-HOOK RELATIONSHIPS:
 *   MUST NOT MODIFY: ExplicitRatingCapture, ImplicitSentimentCapture
 *
 * COST: 1 inference call per session. Bumped from fast/Haiku to
 *   standard/Sonnet in S8 — the learning-judgment sub-task (distinguishing a
 *   genuine resolved learning from frustration-worded venting, per
 *   skills/Intelligence/Evals/Data/golden/learning-capture-fixtures.jsonl's
 *   anti-gaming cases) is the eval-baselined task_learning_capture.yaml task,
 *   which required 'standard' level to clear its accuracy bar — the coarser
 *   rating sub-task doesn't need Sonnet, but the combined call is bound by
 *   whichever sub-task is more demanding.
 */

import { existsSync, readFileSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { spawn } from "child_process";
import { inference } from "../lib/core/Inference.ts";
import type { InferenceResult } from "../lib/core/Inference.ts";
import { readHookInput } from "../lib/hook-utils.ts";
import { SessionImplicitRatingSchema } from "../lib/core/LearningEntrySchema.ts";
import { createAppendLog } from "../lib/core/AppendLog.ts";
import { MEMORY, RATINGS_PATH } from "../lib/core/MemoryPaths.ts";
import { LEARNING_JUDGMENT_CRITERIA, parseLearningsArray, type LearningItem } from "../lib/core/LearningJudgment.ts";
import { getPSTTimestamp, getPSTDate, getYearMonth } from "./lib/time.ts";

// ── Types ─────────────────────────────────────────────────────────────────────

interface SessionEndInput {
  session_id: string;
  transcript_path: string;
  hook_event_name?: string;
}

interface SessionRatingRow {
  timestamp: string;
  rating: number;
  session_id: string;
  source: "implicit";
  sentiment_summary: string;
  confidence: number;
}

interface InferenceRatingResult {
  rating: number;
  sentiment_summary: string;
  confidence: number;
  learnings: LearningItem[];
}

/**
 * Injectable dependencies — allows tests to stub inference and transcript reading
 * without making real LLM calls or touching the filesystem.
 */
export interface SessionRatingDeps {
  /** Stubable inference function. Signature matches `inference()` from lib/core/Inference.ts */
  inferenceFn: (opts: Parameters<typeof inference>[0]) => Promise<InferenceResult>;
  /** Absolute path to ratings.jsonl */
  ratingsPath: string;
  /** Absolute path to the MEMORY/LEARNING directory (learning files write under <this>/<category>/<yearMonth>/) */
  learningsDir: string;
  /** Read transcript content; return null/empty to signal missing or too-short transcript */
  transcriptReader: (transcriptPath: string) => string | null;
}

// ── Constants ─────────────────────────────────────────────────────────────────

/** Minimum non-whitespace characters in transcript to attempt inference. */
const MIN_TRANSCRIPT_LENGTH = 20;

const RATING_SYSTEM_PROMPT = `You are analyzing a Kaya (AI assistant) session transcript for Jm. You have two jobs: rate Jm's satisfaction with the session, and identify any genuine learning moments worth recording for later reference.

Produce a JSON object with exactly these fields:
  "rating"            - integer 1-10 (1=very frustrated, 5=neutral, 10=extremely satisfied)
  "sentiment_summary" - string, max 15 words, factual summary of the session outcome
  "confidence"        - float 0.0-1.0 (your confidence in the rating)
  "learnings"         - array (use [] if there are none — do not force one), each item: {"summary": string, "category": "SYSTEM"|"ALGORITHM", "evidence": string}

Rating guide:
  1-2  Strong frustration, repeated corrections, explicit complaints
  3-4  Mild dissatisfaction, partial failures, multiple retries
  5    Neutral / purely technical session with no emotional signal
  6-7  Satisfied, task completed, minor friction
  8-9  Strong approval, efficient execution, impressed
  10   Extraordinary outcome, explicitly praised

Learning criteria:
${LEARNING_JUDGMENT_CRITERIA}

Return ONLY valid JSON — no prose, no markdown fences.`;

// ── Core testable handler ─────────────────────────────────────────────────────

/**
 * Core handler — fully injectable for testing.
 * Called by main() with real deps, and by tests with stubs.
 * Returns void; errors are logged to stderr and swallowed (fail-open).
 */
export async function runSessionRatingCapture(
  input: SessionEndInput,
  deps: SessionRatingDeps,
): Promise<void> {
  const { session_id, transcript_path } = input;
  const { inferenceFn, ratingsPath, learningsDir, transcriptReader } = deps;

  // 1. Read transcript — bail if empty or too short
  const transcriptContent = transcriptReader(transcript_path);
  if (!transcriptContent || transcriptContent.trim().length < MIN_TRANSCRIPT_LENGTH) {
    console.error("[SessionRatingCapture] Transcript missing or too short — skipping");
    return;
  }

  // 2. Idempotency check — skip if we already wrote a row for this session.
  // This gate runs BEFORE the inference call, so it protects both the rating
  // write and the learning-file writes below (both are downstream of the one
  // inference call it guards).
  if (hasExistingImplicitRow(ratingsPath, session_id)) {
    console.error(`[SessionRatingCapture] Implicit row already exists for session ${session_id} — skipping`);
    return;
  }

  // 3. Inference — one Sonnet call to rate the session AND extract learnings
  let ratingResult: InferenceRatingResult;
  try {
    const result = await inferenceFn({
      systemPrompt: RATING_SYSTEM_PROMPT,
      userPrompt: buildUserPrompt(transcriptContent),
      level: "standard",
      expectJson: true,
      timeout: 45000,
    });

    if (!result.success || !result.parsed) {
      console.error(`[SessionRatingCapture] Inference failed: ${result.error ?? "no parsed output"}`);
      return;
    }

    const parsed = result.parsed as Record<string, unknown>;
    if (
      typeof parsed.rating !== "number" ||
      parsed.rating < 1 || parsed.rating > 10 ||
      typeof parsed.sentiment_summary !== "string" ||
      typeof parsed.confidence !== "number"
    ) {
      console.error("[SessionRatingCapture] Inference output missing required fields — skipping");
      return;
    }

    ratingResult = {
      rating: Math.round(parsed.rating),
      sentiment_summary: (parsed.sentiment_summary as string).slice(0, 120),
      confidence: parsed.confidence,
      // Purely additive and never required: malformed/absent `learnings`
      // degrades to [] rather than failing the whole (already-validated) rating.
      learnings: parseLearningsArray(parsed.learnings),
    };
  } catch (err) {
    console.error(`[SessionRatingCapture] Inference threw: ${err}`);
    return;
  }

  // 4. Write rating row
  const row: SessionRatingRow = {
    timestamp: new Date().toISOString(),
    rating: ratingResult.rating,
    session_id,
    source: "implicit",
    sentiment_summary: ratingResult.sentiment_summary,
    confidence: ratingResult.confidence,
  };

  try {
    // Schema-parsed before append (construction-time guarantee, ISC S6b) —
    // the original `row` object is what's actually serialized, so a
    // successful parse never changes what gets written.
    SessionImplicitRatingSchema.parse(row);
    createAppendLog(ratingsPath).append(row);
    console.error(
      `[SessionRatingCapture] Wrote rating ${row.rating}/10 ` +
      `(conf=${row.confidence.toFixed(2)}) for session ${session_id}`,
    );
  } catch (err) {
    console.error(`[SessionRatingCapture] Failed to write ratings.jsonl: ${err}`);
  }

  // 5. Write session-end learning files (S8) — empty array is the common case.
  writeLearningFiles(ratingResult.learnings, session_id, learningsDir);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function hasExistingImplicitRow(ratingsPath: string, session_id: string): boolean {
  if (!existsSync(ratingsPath)) return false;
  try {
    const lines = readFileSync(ratingsPath, "utf-8").split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as Record<string, unknown>;
        const rowId = (entry.session_id ?? entry.sessionId) as string | undefined;
        if (rowId === session_id && entry.source === "implicit") {
          return true;
        }
      } catch (err) {
        // skip malformed lines
        console.error(`[SessionRatingCapture] malformed ratings line skipped: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } catch (err) {
    // can't read file — treat as no existing row
    console.error(`[SessionRatingCapture] failed to read ratings file, treating as no existing row: ${err instanceof Error ? err.message : String(err)}`);
  }
  return false;
}

/**
 * Build the user prompt from transcript content.
 * Caps at 4000 chars (roughly 1000 tokens) to keep the call cheap.
 */
function buildUserPrompt(transcriptContent: string): string {
  const cap = 4000;
  const body = transcriptContent.length > cap
    ? transcriptContent.slice(-cap)
    : transcriptContent;
  return `Rate this Kaya session and extract any learnings, based on the transcript below:\n\n${body}`;
}

/**
 * Generate a learning-file filename in the same
 * `<date>-<time>_LEARNING_<slug>[-<index>].md` shape
 * hooks/handlers/ResponseCapture.ts used for its (now-deleted) per-stop
 * learning branch.
 */
function generateLearningFilename(summary: string, index: number): string {
  const pstTimestamp = getPSTTimestamp();
  const date = pstTimestamp.slice(0, 10);
  const time = pstTimestamp.slice(11, 19).replace(/:/g, "");

  const cleanDesc = summary
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .slice(0, 60);

  const suffix = index > 0 ? `-${index}` : "";
  return `${date}-${time}_LEARNING_${cleanDesc}${suffix}.md`;
}

/**
 * Learning-file content — same frontmatter keys (capture_type, timestamp,
 * auto_captured, tags) ResponseCapture used, plus session_id/category added
 * for traceability now that capture happens once per session instead of once
 * per stop.
 */
function generateLearningFileContent(item: LearningItem, session_id: string, timestamp: string): string {
  return `---
capture_type: LEARNING
timestamp: ${timestamp}
auto_captured: true
tags: [auto-capture, session-end]
session_id: ${session_id}
category: ${item.category}
---

# Quick Learning: ${item.summary}

**Date:** ${getPSTDate()}
**Session:** ${session_id}
**Auto-captured:** Yes

---

## Summary

${item.summary}

## Evidence

${item.evidence}

---

*Captured by SessionRatingCapture at SessionEnd*
`;
}

/**
 * Write one MEMORY/LEARNING/<category>/<yearMonth>/*.md file per learning.
 * No-op for an empty array (the common case).
 *
 * Idempotency: the caller's hasExistingImplicitRow() pre-inference gate is
 * the primary guard (see runSessionRatingCapture step 2/5). The
 * existsSync() check here is a second, redundant safety net for the edge
 * case where inference succeeded but the rating-row write above failed
 * (leaving hasExistingImplicitRow() → false on a re-fire) — the filename is
 * deterministic per (summary, index) within the same PST second, so a
 * genuine re-run of the identical learning set collides on the same path
 * and is skipped rather than duplicated.
 */
function writeLearningFiles(learnings: LearningItem[], session_id: string, learningsDir: string): void {
  if (learnings.length === 0) return;

  const yearMonth = getYearMonth();
  const timestamp = getPSTTimestamp();

  learnings.forEach((item, index) => {
    const targetDir = join(learningsDir, item.category, yearMonth);
    if (!existsSync(targetDir)) {
      mkdirSync(targetDir, { recursive: true });
    }

    const filename = generateLearningFilename(item.summary, index);
    const filepath = join(targetDir, filename);

    if (existsSync(filepath)) {
      console.error(`[SessionRatingCapture] Learning file already exists, skipping: ${filepath}`);
      return;
    }

    writeFileSync(filepath, generateLearningFileContent(item, session_id, timestamp), "utf-8");
    console.error(`[SessionRatingCapture] Captured session-end learning (${item.category}) to: ${filepath}`);
  });
}

/**
 * Default transcript reader — reads from disk.
 * Returns null if the file is missing or unreadable.
 */
function defaultTranscriptReader(transcriptPath: string): string | null {
  if (!transcriptPath || !existsSync(transcriptPath)) return null;
  try {
    return readFileSync(transcriptPath, "utf-8");
  } catch {
    return null;
  }
}

function resolveRatingsPath(): string {
  return RATINGS_PATH();
}

function resolveLearningsDir(): string {
  return MEMORY.LEARNING();
}

// ── CLI entry points ──────────────────────────────────────────────────────────
//
// The rating step makes an inference network call. Running that
// synchronously on the SessionEnd teardown path got the hook CANCELLED every
// time — the CLI kills the hook's process group on exit before the call
// returns, so 0 rows were ever written. Fix: the launcher does only the fast,
// synchronous input read, then hands the slow call to a DETACHED worker that
// survives teardown (own process group, unref'd), and exits immediately.

/**
 * Worker mode — does the slow inference + write, off the teardown path.
 * Invoked as: bun SessionRatingCapture.hook.ts --worker <session_id> <transcript_path>
 */
async function runWorker(session_id: string, transcript_path: string): Promise<void> {
  try {
    const realDeps: SessionRatingDeps = {
      inferenceFn: inference,
      ratingsPath: resolveRatingsPath(),
      learningsDir: resolveLearningsDir(),
      transcriptReader: defaultTranscriptReader,
    };
    await runSessionRatingCapture({ session_id, transcript_path }, realDeps);
  } catch (err) {
    console.error(`[SessionRatingCapture] Worker error: ${err}`);
  }
  process.exit(0);
}

/**
 * Launcher mode (default SessionEnd invocation) — reads hook input fast, then
 * dispatches a detached worker and exits IMMEDIATELY so session teardown is
 * never blocked and the hook is never cancelled mid-call.
 */
async function runLauncher(): Promise<void> {
  try {
    const data = await readHookInput<SessionEndInput>();
    if (!data?.session_id) {
      console.error("[SessionRatingCapture] No session_id in hook input — exiting");
      process.exit(0);
    }

    // Pre-check idempotency here to avoid spawning a no-op worker.
    if (hasExistingImplicitRow(resolveRatingsPath(), data.session_id)) {
      console.error(`[SessionRatingCapture] Implicit row already exists for session ${data.session_id} — skipping`);
      process.exit(0);
    }

    const child = spawn(
      process.execPath,
      [import.meta.path, "--worker", data.session_id, data.transcript_path ?? ""],
      { detached: true, stdio: "ignore" },
    );
    child.unref();
    console.error(`[SessionRatingCapture] Dispatched detached rating worker for session ${data.session_id}`);
  } catch (err) {
    // Outer safety net — never crash session teardown
    console.error(`[SessionRatingCapture] Launcher error: ${err}`);
  }
  process.exit(0);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv[0] === "--worker") {
    await runWorker(argv[1] ?? "", argv[2] ?? "");
    return;
  }
  await runLauncher();
}

if (import.meta.main) {
  main();
}
