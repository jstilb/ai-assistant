/**
 * JudgeProtocol — ONE structured judge protocol for every model-based grader
 * (evals-rebuild slice B1).
 *
 * BEFORE: each model-based judge hand-parsed a free-text LLM response —
 * NaturalLanguageAssertGrader had a 4-stacked-regex parser plus a
 * line-by-line scan fallback (Graders/ModelBased/NaturalLanguageAssert.ts),
 * NightlyJudgeGrader parsed `SCORE:`/`REASONING:` lines with its own
 * first-vs-last-marker disambiguation logic (NightlyJudge.ts's
 * parseJudgeScore), and LLMRubricGrader had a third, independent
 * SCORE:/REASONING:/ASSERTIONS: parser. Three parsers, three sets of edge
 * cases, zero shared test coverage on the two heaviest-used graders
 * (natural_language_assert: 79 tasks, llm_rubric: 47 tasks) — see
 * MEMORY/SkillAudits/evals-infra-audit-2026-07-09/graders.md finding #4 and
 * REDESIGN OPPORTUNITIES #6.
 *
 * AFTER: every judge calls judgeInference() here, which mirrors the ONE
 * grader that already did this right — EnsembleLabelGrader
 * (Graders/ModelBased/EnsembleLabel.ts:56-66): `inference({expectJson:
 * true})` + a typed read of `.parsed`. This module adds the piece
 * EnsembleLabel didn't need (it only reads one string field): a shared zod
 * schema validating the FULL judge contract (score/reasoning/
 * assertion_results), so every judge's response shape is checked the same
 * way instead of each grader inventing its own ad hoc `.parsed` cast.
 *
 * FAIL-LOUD CONTRACT: on inference failure OR schema-invalid JSON, this
 * returns `{success:false, score:0, error:<string>}` — never a silent 0.5,
 * never a silent pass, and the error is always surfaced into the calling
 * grader's GraderResult.reasoning so it's visible in run output (per the
 * B1 spec and the doctrine in memory
 * feedback_determinism_earns_its_place.md: "fail loud, never silent
 * containment"). This also FIXES a real inconsistency the old parsers had:
 * NightlyJudgeGrader/NaturalLanguageAssertGrader/LLMRubricGrader all threw
 * on `!result.success` and caught it into score 0 (correct), but
 * NaturalLanguageAssertGrader's *parser* additionally had a silent
 * default-FALSE fallback for unparseable-but-successful judge output
 * (`'Could not parse result from LLM judge output'`, indistinguishable
 * from a genuine FALSE verdict — see
 * Graders/__tests__/fixtures/judge-raw-responses.json fixture
 * nla-06-unparseable-silent-false-synthetic). Under JudgeProtocol, that
 * same case is a visible `success:false` + `error` instead.
 *
 * SCALE CONTRACT: `score` is 0..1 ONLY. The old NightlyJudge parser
 * auto-detected a 0-10 scale ("SCORE: 8" -> 0.8) and silently normalized —
 * that guess is gone. The system prompt each grader sends via
 * judgeSystemPromptSuffix() below explicitly demands a 0..1 score; a judge
 * that returns 8 instead of 0.8 now fails zod validation (score must be
 * <=1) and surfaces as a loud grader error rather than a silently
 * mis-scaled 8.0 clamped to 1.0.
 */

import { inference, extractJson, type InferenceLevel, type InferenceResult } from '../../../../lib/core/Inference';
import { z } from 'zod';

// ============================================================================
// Schema
// ============================================================================

/** One assertion's structured verdict — richer than a bare boolean so
 *  NaturalLanguageAssertGrader can keep reporting a real per-assertion
 *  explanation (its pre-migration `details.results` shape), while
 *  LLMRubricGrader (which never surfaced per-assertion explanations) can
 *  just read `.passed` off each entry. */
export const AssertionResultSchema = z.object({
  assertion: z.string().min(1),
  passed: z.boolean(),
  explanation: z.string().optional(),
});
export type AssertionResult = z.infer<typeof AssertionResultSchema>;

/**
 * The ONE judge response contract. `score` is 0..1 (never a raw 1-5/1-10/
 * PASS-FAIL token — each grader normalizes its OWN scale into 0..1 in the
 * prompt instructions it sends, per judgeSystemPromptSuffix()).
 * `assertion_results` is present only for judges that check discrete
 * assertions (natural_language_assert, llm_rubric with an assertions
 * param) — absent for nightly_judge's single overall verdict.
 */
export const JudgeResponseSchema = z.object({
  score: z.number().min(0).max(1),
  reasoning: z.string().min(1),
  assertion_results: z.array(AssertionResultSchema).optional(),
});
export type JudgeResponse = z.infer<typeof JudgeResponseSchema>;

// ============================================================================
// judgeInference()
// ============================================================================

/** Same DI shape convention as EnsembleLabelGrader.inferenceFn /
 *  NightlyJudgeGrader.inferenceFn — a plain function reference tests can
 *  override; defaults to the real `inference`. */
export type InferenceFn = (opts: Parameters<typeof inference>[0]) => Promise<InferenceResult>;

export interface JudgeInferenceOptions {
  systemPrompt: string;
  userPrompt: string;
  level?: InferenceLevel;
  timeout?: number;
  /** Forwarded to inference() — a transient post-sleep network stall
   *  recovers via a fresh subprocess, not a longer timeout. Judge calls
   *  default to 1 retry (NightlyJudge's existing precedent: "judging a
   *  full golden set + rubric is a large prompt", timeout-too-low is our
   *  bug, not the judge's). */
  retries?: number;
  retryDelayMs?: number;
}

export interface JudgeInferenceResult {
  success: boolean;
  score: number;
  reasoning: string;
  assertion_results?: AssertionResult[];
  /** Present ONLY on failure. Always non-empty when success is false —
   *  callers MUST surface this into GraderResult.reasoning (fail loud). */
  error?: string;
  /** The model's raw text response, kept for grader `details.raw_response`
   *  (debugging/audit trail — mirrors LLMRubricGrader's pre-migration
   *  `details.raw_response` field). Present on both success and failure. */
  raw_output: string;
  latencyMs: number;
  level: InferenceLevel;
}

/**
 * The system-prompt suffix every judge appends to its own rubric-specific
 * instructions, demanding the shared JudgeResponseSchema shape. Centralized
 * so the wire-format contract can't drift between judges — each grader's
 * PROMPT (the judging criteria/rubric) stays entirely its own; only the
 * OUTPUT FORMAT instruction is shared.
 */
export function judgeResponseFormatInstruction(opts?: { withAssertions?: boolean }): string {
  const assertionsLine = opts?.withAssertions
    ? '\n  "assertion_results": [{ "assertion": "<assertion text>", "passed": true|false, "explanation": "<brief explanation>" }, ...]'
    : '';
  return `Respond with ONLY a single JSON object (no markdown fences, no prose outside the JSON) matching exactly this shape:
{
  "score": <number between 0.0 and 1.0>,
  "reasoning": "<your detailed analysis>"${assertionsLine}
}
"score" MUST be a number between 0.0 and 1.0 inclusive — never a 1-5/1-10 scale, never the literal string "PASS"/"FAIL". Normalize any scale to 0.0-1.0 yourself before responding.`;
}

/**
 * Call the judge model and return a validated, structured result. Fails
 * loud (never a silent 0.5 or silent pass) on inference failure OR
 * schema-invalid JSON — see module docblock's FAIL-LOUD CONTRACT.
 */
export async function judgeInference(
  opts: JudgeInferenceOptions,
  inferenceFn: InferenceFn = inference,
): Promise<JudgeInferenceResult> {
  const result = await inferenceFn({
    systemPrompt: opts.systemPrompt,
    userPrompt: opts.userPrompt,
    level: opts.level ?? 'standard',
    timeout: opts.timeout,
    retries: opts.retries,
    retryDelayMs: opts.retryDelayMs,
    expectJson: true,
  });

  if (!result.success) {
    return {
      success: false,
      score: 0,
      reasoning: '',
      error: `Judge inference failed: ${result.error ?? 'unknown error'}`,
      raw_output: result.output ?? '',
      latencyMs: result.latencyMs,
      level: result.level,
    };
  }

  // inference({expectJson:true}) already ran extractJson()'s 3-strategy
  // repair pass (direct parse -> strip markdown fences -> greedy regex,
  // each retried once with control-char escaping) and populates `.parsed`
  // whenever one of those succeeded. The second attempt here is a pure
  // defensive fallback for a DI-mocked inferenceFn in tests that sets
  // `output` but forgets to also set `.parsed` — the real `inference()`
  // never reaches this branch with `.parsed` unset on success.
  const parsedRaw = result.parsed ?? extractJson(result.output);
  if (parsedRaw === undefined) {
    return {
      success: false,
      score: 0,
      reasoning: '',
      error: 'Judge response was not valid JSON (expected {score, reasoning, assertion_results?})',
      raw_output: result.output,
      latencyMs: result.latencyMs,
      level: result.level,
    };
  }

  const validated = JudgeResponseSchema.safeParse(parsedRaw);
  if (!validated.success) {
    const issues = validated.error.issues
      .map(i => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    return {
      success: false,
      score: 0,
      reasoning: '',
      error: `Judge response failed schema validation: ${issues}`,
      raw_output: result.output,
      latencyMs: result.latencyMs,
      level: result.level,
    };
  }

  return {
    success: true,
    score: validated.data.score,
    reasoning: validated.data.reasoning,
    assertion_results: validated.data.assertion_results,
    raw_output: result.output,
    latencyMs: result.latencyMs,
    level: result.level,
  };
}
