#!/usr/bin/env bun
/**
 * QualifierFaithfulness.ts
 *
 * Context Integrity Program, Slice F2 — digest *faithfulness* check.
 *
 * FreshnessGuard's contentLag check (Slice A3, preserved verbatim from S1)
 * catches a digest that LOOKS fresh (recently rebuilt) but whose CONTENT has
 * silently frozen relative to its source archive. This module catches a
 * different failure class: a digest entry whose text changed under
 * compression/extraction and, in changing, dropped a load-bearing qualifier
 * from its source — negations ("never", "not"), conditions ("only if",
 * "unless", "except"), scope limiters ("in worktrees only", "when X is
 * running"), quantifiers ("all", "any", "at least N"), and degree/intensity
 * modifiers ("mild" vs "very"). This is the documented failure mode where a
 * summarizer turns "I like mild spicy food" into "loves very spicy food":
 * the qualifier IS the meaning, and it is exactly what naive compression
 * drops first. (Live-verified: the LLM judge's first draft, scoped to only
 * the first four categories, correctly caught that exact canonical example
 * but ALSO flagged a legitimately-faithful compression as unfaithful for
 * dropping a destination file path — a real false positive. Widening the
 * scope by ONE explicit category (degree/intensity) and explicitly listing
 * destinations/examples/labels as OUT OF SCOPE in the prompt fixed both: see
 * QUALIFIER_FAITHFULNESS_SYSTEM_PROMPT and the Slice F2 verification report
 * for the real before/after transcripts.)
 *
 * WHY THE LLM DECIDES, NOT A WORD LIST: whether a dropped clause actually
 * changes a statement's meaning is a judgment call — "Do NOT interview" vs
 * "Interview the user" differ by one word and completely invert the
 * instruction, while "USE WHEN X, Y, OR Z" vs "USE WHEN X, Y, Z" (dropping
 * "OR") changes nothing load-bearing. Per Kaya doctrine ("determinism must
 * earn its place" — feedback_determinism_earns_its_place.md), that
 * distinction is delegated to an LLM via lib/core/Inference.ts, never
 * decided by a hardcoded word list. QUALIFIER_CANDIDATE_MARKERS below is
 * NOT the faithfulness mechanism — it is a cheap deterministic PRE-FILTER
 * that decides whether a source sentence is even worth sending to the LLM.
 * A source sentence with no matching marker is assumed low-risk and never
 * checked (a soft, cost-bounding gap — see module-level residual-gap note
 * near hasQualifierCandidate). Every actual faithful/unfaithful VERDICT for
 * anything that IS checked always comes from the LLM.
 *
 * COST: each LLM call is one `standard` (Sonnet)-tier lib/core/Inference.ts
 * call by default (subscription-billed, no per-call USD charge — see
 * judgeQualifierFaithfulness's docblock for why `standard` and not `fast`)
 * with a short prompt (source + compressed excerpt, typically well under 500
 * characters each) — observed latency ~4-19s per call across both tiers
 * (see verification report; `standard` was not slower than `fast` in the
 * observed sample). Two deterministic
 * gates keep the call count near zero on a healthy digest: (1)
 * unchangedByCompression() skips any pair where the compressed text still
 * contains the source verbatim — true for every entry in the real
 * skill-capabilities.json digest today, since DigestBuilder.ts's current
 * extraction is a literal copy, not a rewrite; (2) hasQualifierCandidate()
 * additionally skips source sentences with no candidate marker at all. A
 * hard per-run cap (maxChecks, default MAX_CHECKS_PER_RUN) bounds worst-case
 * latency even if a batch of SKILL.md edits changes many qualifier-bearing
 * descriptions at once — checkFreshness() runs on a cron budget elsewhere
 * (see FreshnessGuard.ts), so this must never turn into an unbounded LLM
 * marathon. Hitting the cap is logged loudly, never silently truncated.
 */

import { inference, type InferenceLevel, type InferenceResult } from "../../../../lib/core/Inference.ts";
import { z } from "zod";

// ============================================================================
// Types
// ============================================================================

/** Same DI shape convention as Evals/Graders/JudgeProtocol.ts's InferenceFn /
 *  LLMRubricGrader.inferenceFn — a plain function reference tests override;
 *  defaults to the real `inference`. */
export type InferenceFn = (opts: Parameters<typeof inference>[0]) => Promise<InferenceResult>;

export interface QualifierFaithfulnessJudgment {
  success: true;
  faithful: boolean;
  /** Exact load-bearing qualifier phrases from the source that are missing
   *  or contradicted in the compressed text. Empty when faithful. */
  droppedQualifiers: string[];
  reason: string;
}

export interface QualifierFaithfulnessError {
  success: false;
  /** Always non-empty. Fail-loud contract: an inference failure or a
   *  malformed judge response is never silently treated as "faithful" (a
   *  false pass that would hide real drift) nor as "unfaithful" (a false
   *  alarm) — it surfaces here instead, for the caller to report loudly. */
  error: string;
}

export type QualifierFaithfulnessResult = QualifierFaithfulnessJudgment | QualifierFaithfulnessError;

export interface FaithfulnessPair {
  /** Stable identifier for reporting (e.g. skill name). */
  key: string;
  /** The pre-compression source text. */
  source: string;
  /** The post-compression / post-extraction text actually shipped in the digest. */
  compressed: string;
}

export interface EntryFaithfulnessCheck extends FaithfulnessPair {
  /** True when this pair was resolved WITHOUT an LLM call — either the
   *  compressed text still contains the source verbatim (nothing changed) or
   *  the source had no candidate qualifier language. */
  skipped: boolean;
  skipReason?: string;
  faithful?: boolean;
  droppedQualifiers?: string[];
  reason?: string;
  /** Present only when the LLM call itself failed (network/parse error) —
   *  distinct from `faithful === false`, which is a real unfaithful verdict. */
  error?: string;
}

// ============================================================================
// Deterministic step 1: candidate-qualifier sentence extraction (pre-filter only)
// ============================================================================

/**
 * Marker regexes covering the four WORD-MARKED qualifier categories the F2
 * spec calls out by name: negation, condition, scope limiter, quantifier.
 * This list is intentionally broad (biased toward over-triggering the LLM
 * check rather than under-triggering it) BUT IS NOT ITSELF THE FAITHFULNESS
 * MECHANISM — see module docblock. It deliberately does NOT try to match the
 * fifth LLM-judged category (degree/intensity modifiers like "mild"/"very")
 * — those rarely have a reliable marker WORD (an adjective's intensity is
 * carried by the adjective itself, not a preceding keyword), and Kaya's real
 * digest domain (SKILL.md operator instructions) is dominated by
 * negation/condition/scope/quantifier language, not diet-preference-style
 * intensity adjectives — see the real skill-capabilities.json findings in
 * the Slice F2 report. A source sentence that carries a qualifier through
 * vocabulary this list doesn't recognize will not be flagged as a candidate
 * and will never reach the LLM. That is a real, acknowledged residual gap in
 * this pre-filter's recall — traded deliberately for keeping the check cheap
 * enough to run on every regeneration. It does not weaken the check's
 * PRECISION: anything that IS sent to the LLM gets a real 5-category
 * judgment call, not a keyword match.
 */
const QUALIFIER_CANDIDATE_MARKERS: readonly RegExp[] = [
  // negation
  /\bnever\b/i, /\bnot\b/i, /\bno\s/i, /\bwithout\b/i, /\bdon't\b/i, /\bdo not\b/i,
  // condition / scope limiter
  /\bonly\b/i, /\bunless\b/i, /\bexcept\b/i, /\bif\b/i, /\bwhen\b/i, /\bwhile\b/i,
  /\bbefore\b/i, /\bafter\b/i, /\bmust\b/i, /\brequire/i, /\bshould\b/i,
  // quantifier
  /\ball\b/i, /\bany\b/i, /\bevery\b/i, /\bat least\b/i, /\bat most\b/i, /\balways\b/i,
];

/**
 * Naive sentence splitter: splits on '.', '!', '?' followed by whitespace or
 * end-of-string, keeping each fragment. Good enough for the short,
 * single-paragraph text this module reads (SKILL.md frontmatter descriptions
 * and USE WHEN lines) — not a general-purpose NLP sentence splitter, and not
 * meant to be one; it only needs to isolate individual clauses well enough
 * for the marker regexes above to test each one independently instead of the
 * whole blob at once.
 */
export function splitSentences(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const matches = trimmed.match(/[^.!?]+[.!?]+(?:\s+|$)|[^.!?]+$/g);
  return (matches ?? [trimmed]).map(s => s.trim()).filter(Boolean);
}

/** Deterministic extraction: which sentences in `text` are worth an LLM
 *  faithfulness check at all. See QUALIFIER_CANDIDATE_MARKERS doc for the
 *  precision/recall trade this makes. */
export function extractQualifierCandidateSentences(text: string): string[] {
  return splitSentences(text).filter(sentence => QUALIFIER_CANDIDATE_MARKERS.some(re => re.test(sentence)));
}

export function hasQualifierCandidate(text: string): boolean {
  return extractQualifierCandidateSentences(text).length > 0;
}

// ============================================================================
// Deterministic step 2: diffing (fast exit when nothing actually changed)
// ============================================================================

/**
 * True when `compressed` still contains `source` verbatim (modulo
 * whitespace normalization) — i.e. the "compression" step was a literal copy
 * or a superset wrap, so by definition nothing could have been dropped. This
 * is the fast exit that keeps a healthy digest (today's DigestBuilder.ts,
 * which extracts fields verbatim) from ever reaching the LLM at all.
 */
export function unchangedByCompression(source: string, compressed: string): boolean {
  const normalize = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();
  const normSource = normalize(source);
  if (!normSource) return true; // nothing to have dropped
  return normalize(compressed).includes(normSource);
}

// ============================================================================
// Judgment call: the LLM decides
// ============================================================================

const QualifierVerdictSchema = z.object({
  faithful: z.boolean(),
  droppedQualifiers: z.array(z.string()).default([]),
  reason: z.string().min(1),
});

const QUALIFIER_FAITHFULNESS_SYSTEM_PROMPT = `You check ONLY ONE narrow thing: whether a COMPRESSED rewrite of a statement preserved every LOAD-BEARING QUALIFIER from the ORIGINAL. A qualifier is strictly one of these five kinds:
- NEGATION ("never", "not", "without", "don't")
- CONDITION ("only if", "unless", "except", "when X", "while X")
- SCOPE LIMITER ("only in worktrees", "only when X is running", "applies to Y not Z")
- QUANTIFIER ("all", "any", "every", "at least N", "at most N", "always")
- DEGREE/INTENSITY MODIFIER ("mild" vs "very"/"extremely", "a little" vs "a lot", "rarely" vs "often")

A qualifier is LOAD-BEARING if dropping or reversing it would change WHO/WHAT the statement applies to, WHEN it applies, WHETHER it applies at all, or HOW STRONGLY it applies (e.g. flips a prohibition into a permission, a "some" into an "all", or "mild" into "very").

OUT OF SCOPE — do NOT flag these, even if the compressed version omits them: destinations/file paths, examples, secondary details, renamed labels, or any other content loss that isn't one of the five qualifier kinds above. This check is narrowly about qualifier survival, not general fidelity or completeness — a compressed version that drops a location or an example while keeping every qualifier intact is FAITHFUL.

Respond with ONLY a JSON object, no markdown fences, no prose outside the JSON:
{
  "faithful": true|false,
  "droppedQualifiers": ["<exact load-bearing qualifier phrase from the original that is missing or contradicted in the compressed version>", ...],
  "reason": "<one sentence explaining the verdict>"
}
"faithful" is true only if every load-bearing qualifier from the original survived (even if reworded) in the compressed version. "droppedQualifiers" is empty when faithful is true.`;

/**
 * Ask the LLM whether `compressed` preserved every load-bearing qualifier in
 * `source`. Never throws — fail-loud contract mirrors
 * Evals/Graders/JudgeProtocol.ts's judgeInference(): inference failure or a
 * schema-invalid response both come back as `{success:false, error}`, never
 * a silent "faithful" (a false pass that hides real drift) and never a
 * silent "unfaithful" (a false alarm).
 *
 * DEFAULT LEVEL IS "standard" (Sonnet), NOT "fast": live verification during
 * F2 (see the Slice F2 report) ran the SAME faithful-compression pair 11
 * times at `fast` (Haiku) and observed 1 false positive — the judge read a
 * dropped "current" (from "current conversation context") as a violated
 * scope limiter, an overly literal call outside what a human would consider
 * load-bearing. 10 immediate re-runs (5 at fast, 5 at standard) on the same
 * pair all correctly returned faithful:true. That is inherent LLM-judge
 * noise, not a prompt-design bug (the earlier, systematic false-positive
 * class — flagging dropped destinations/file-paths as "qualifiers" — WAS a
 * real prompt-scoping bug and was fixed by narrowing
 * QUALIFIER_FAITHFULNESS_SYSTEM_PROMPT to the five named categories plus an
 * explicit out-of-scope list; see the module docblock). `standard` costs
 * nothing extra (both tiers are subscription-billed, no per-call USD charge
 * — lib/core/Inference.ts's own docs) and is a more careful reasoner, so it
 * is the default; `fast` remains available via opts.level for callers that
 * want to trade a little more noise for lower rate-limit-window usage.
 */
export async function judgeQualifierFaithfulness(
  source: string,
  compressed: string,
  opts: { level?: InferenceLevel; inferenceFn?: InferenceFn; timeout?: number } = {}
): Promise<QualifierFaithfulnessResult> {
  const runInference = opts.inferenceFn ?? inference;
  const result = await runInference({
    systemPrompt: QUALIFIER_FAITHFULNESS_SYSTEM_PROMPT,
    userPrompt: `ORIGINAL:\n${source}\n\nCOMPRESSED:\n${compressed}`,
    level: opts.level ?? "standard",
    expectJson: true,
    timeout: opts.timeout,
  });

  if (!result.success) {
    return { success: false, error: `inference failed: ${result.error ?? "unknown error"}` };
  }

  const parsed = QualifierVerdictSchema.safeParse(result.parsed);
  if (!parsed.success) {
    return { success: false, error: `malformed judge response: ${parsed.error.message}` };
  }

  return {
    success: true,
    faithful: parsed.data.faithful,
    droppedQualifiers: parsed.data.droppedQualifiers,
    reason: parsed.data.reason,
  };
}

// ============================================================================
// Orchestration
// ============================================================================

/** Per-run safety cap: bounds worst-case latency/subprocess-spawn count when
 *  many entries change + carry qualifier candidates in the same regeneration
 *  (e.g. a batch SKILL.md edit). Hitting it is logged loudly (see
 *  FreshnessGuard.ts's call site), never a silent truncation. */
export const MAX_CHECKS_PER_RUN = 10;

/**
 * Run the full pipeline over a batch of (key, source, compressed) pairs:
 * deterministic diff -> deterministic candidate extraction -> capped LLM
 * judgment for whatever survives both filters.
 */
export async function checkEntriesFaithfulness(
  pairs: readonly FaithfulnessPair[],
  opts: { level?: InferenceLevel; inferenceFn?: InferenceFn; maxChecks?: number } = {}
): Promise<EntryFaithfulnessCheck[]> {
  const maxChecks = opts.maxChecks ?? MAX_CHECKS_PER_RUN;
  const results: EntryFaithfulnessCheck[] = [];
  let checksUsed = 0;

  for (const pair of pairs) {
    if (unchangedByCompression(pair.source, pair.compressed)) {
      results.push({ ...pair, skipped: true, skipReason: "compressed text contains source verbatim — nothing to check" });
      continue;
    }
    if (!hasQualifierCandidate(pair.source)) {
      results.push({
        ...pair,
        skipped: true,
        skipReason: "source has no candidate qualifier language (negation/condition/scope/quantifier)",
      });
      continue;
    }
    if (checksUsed >= maxChecks) {
      results.push({
        ...pair,
        skipped: true,
        skipReason: `per-run check budget exhausted (${maxChecks} max) — see FreshnessGuard stderr diagnostic`,
      });
      continue;
    }

    checksUsed++;
    const judged = await judgeQualifierFaithfulness(pair.source, pair.compressed, opts);
    if (!judged.success) {
      results.push({ ...pair, skipped: false, error: judged.error });
      continue;
    }
    results.push({
      ...pair,
      skipped: false,
      faithful: judged.faithful,
      droppedQualifiers: judged.droppedQualifiers,
      reason: judged.reason,
    });
  }

  return results;
}
