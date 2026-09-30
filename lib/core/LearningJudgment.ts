/**
 * LearningJudgment — shared LLM learning-capture criteria (S8, let-the-model-speak).
 *
 * WHY THIS FILE EXISTS:
 * `hooks/lib/learning-utils.ts` (deleted 2026-07 as part of S8) decided, via
 * regex-indicator counting, whether a piece of text was a "learning moment"
 * and whether it belonged in SYSTEM (tooling/infra) or ALGORITHM (task
 * execution) category. That classifier was provably wrong in both
 * directions — see skills/Intelligence/Evals/Data/golden/
 * learning-capture-fixtures.jsonl (lc06-08 are real learnings the regex
 * MISSED because they used no vocabulary word from its dictionaries; lc09-10
 * are pure venting the regex FALSE-POSITIVED on because they happened to hit
 * two indicator categories).
 *
 * S8 inverts this: every writer that used to call isLearningCapture() /
 * getLearningCategory() now either (a) consumes the `learnings` array
 * produced by ONE per-session LLM call (hooks/SessionRatingCapture.hook.ts),
 * (b) makes its own inference call using the SAME judgment criteria
 * (lib/core/SessionHarvester.ts, a manually-invoked batch CLI, not a
 * per-turn/per-session hook), or (c) writes the neutral `UNCATEGORIZED`
 * literal instead of guessing (hooks/WorkCompletionLearning.hook.ts,
 * hooks/ExplicitRatingCapture.hook.ts — both are per-turn/synchronous
 * SessionEnd/UserPromptSubmit paths where adding a second per-event
 * inference call just to assign SYSTEM/ALGORITHM would reintroduce the
 * ungrounded-guess problem this slice removed, only with a model call
 * standing in for the regex). This module is the single place that judgment
 * criteria and the LearningItem shape live, so callers that DO call an LLM
 * stay aligned instead of drifting into two subtly different prompts.
 *
 * The criteria text below is independently worded to the same semantic bar
 * as skills/Intelligence/Evals/Tools/LearningCaptureFixtureRunner.ts's
 * SYSTEM_PROMPT (the eval-baselined judgment prompt that proved an LLM CAN
 * do this job) — it does not quote that file's fixtures verbatim, per the
 * anti-gaming rule (a prior slice was flagged for pasting fixture text into
 * a production prompt as a worked example).
 */

import { z } from 'zod';

// ── Types ─────────────────────────────────────────────────────────────────────

export const LearningItemSchema = z.object({
  /** One-sentence-to-short-paragraph description of what was learned/resolved. */
  summary: z.string().min(1),
  /** SYSTEM = tooling/infra/hook/build/deploy/config/environment. ALGORITHM = task-execution approach/reasoning/methodology. */
  category: z.enum(['SYSTEM', 'ALGORITHM']),
  /** The concrete evidence/quote/detail from the source text that grounds the judgment. */
  evidence: z.string(),
});
export type LearningItem = z.infer<typeof LearningItemSchema>;

/**
 * Neutral category literal for writers that deliberately do NOT classify
 * (see "(c)" in the file docblock above). Shared here so the value itself
 * — not just the shape — stays identical across writers that use it.
 */
export const UNCATEGORIZED = 'UNCATEGORIZED' as const;
export type LearningCategoryOrUncategorized = LearningItem['category'] | typeof UNCATEGORIZED;

// ── Shared judgment criteria (embed into any prompt that extracts learnings) ──

export const LEARNING_JUDGMENT_CRITERIA = `A "learning" is a genuine problem/friction that led to an actual resolution, insight, or concrete lesson — not a plain status update, not a factual statement, and not frustration/venting about an ongoing problem with no insight or fix attached. Something has to have actually been discovered, fixed, or understood; merely naming a difficulty is not enough. Judge the substance, not the vocabulary — do not rely on the presence or absence of specific trigger words (e.g. "bug", "fixed", "error") to decide; text with none of those words can still be a real learning, and text full of them can still be pure venting with nothing resolved.

When something IS a learning, classify it into exactly one category:
  - SYSTEM    — tooling, infrastructure, hooks, build/deploy pipeline, configuration, or environment problems
  - ALGORITHM — task-execution approach, reasoning, or methodology problems (how the work itself was carried out, not the tooling around it)

If nothing in the text meets the bar for a learning, the correct output is an empty list — do not manufacture one.`;

// ── Parsing helper ────────────────────────────────────────────────────────────

/**
 * Defensively parse a `learnings` field from an LLM's parsed JSON output.
 * Per-item fail-open: a malformed individual item is dropped rather than
 * rejecting the whole array, so one bad entry never blocks legitimate ones
 * (or the caller's other, unrelated payload fields — e.g. SessionRatingCapture's
 * rating/sentiment_summary/confidence, which are validated independently).
 *
 * Non-array / missing input returns [] (the documented "no learnings" shape).
 */
export function parseLearningsArray(raw: unknown): LearningItem[] {
  if (!Array.isArray(raw)) return [];
  const out: LearningItem[] = [];
  for (const candidate of raw) {
    const parsed = LearningItemSchema.safeParse(candidate);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}
