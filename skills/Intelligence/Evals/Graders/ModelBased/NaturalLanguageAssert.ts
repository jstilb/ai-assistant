/**
 * Natural Language Assertion Grader
 * Check if specific assertions are true about the output
 *
 * evals-rebuild slice B1: migrated from a 4-stacked-regex + line-scan-
 * fallback free-text parser to Graders/JudgeProtocol.ts's structured
 * expectJson+zod contract. See JudgeProtocol.ts's docblock for the full
 * rationale and MEMORY/SkillAudits/evals-infra-audit-2026-07-09/graders.md
 * finding #4 / REDESIGN OPPORTUNITIES #6. The DELETED parser (and its
 * frozen pre-migration golden fixtures) live in git history / the B1
 * report — see Graders/__tests__/fixtures/judge-raw-responses.json for the
 * frozen "old parser vs new protocol" agreement disposition table.
 */

import { BaseGrader, registerGrader, type GraderContext } from '../Base.ts';
import type { GraderResult, NaturalLanguageAssertParams } from '../../Types/index.ts';
import { inference, type InferenceLevel } from '../../../../../lib/core/Inference';
import { judgeInference, judgeResponseFormatInstruction, type InferenceFn } from '../JudgeProtocol.ts';

export class NaturalLanguageAssertGrader extends BaseGrader {
  type = 'natural_language_assert' as const;
  category = 'model_based' as const;
  // Builds the judge prompt directly from context.output and
  // context.transcript.tool_calls.
  readsOutput = true;

  /**
   * Dependency-injection point for tests. Same convention as
   * EnsembleLabelGrader.inferenceFn / NightlyJudgeGrader.inferenceFn:
   * defaults to the real `inference`; override in tests.
   */
  public inferenceFn: InferenceFn = inference;

  async grade(context: GraderContext): Promise<GraderResult> {
    const start = performance.now();
    const params = this.config.params as NaturalLanguageAssertParams;

    if (!params?.assertions?.length) {
      return this.createResult(0, false, performance.now() - start, {
        reasoning: 'No assertions configured',
      });
    }

    // Map model preference to inference level (default to standard/Sonnet)
    const levelMap: Record<string, InferenceLevel> = {
      'claude-haiku-4-5-20251001': 'fast',
      'claude-sonnet-4-20250514': 'standard',
      'claude-opus-4-20250514': 'smart',
    };
    const level: InferenceLevel = levelMap[params.judge_model ?? ''] ?? 'standard';
    const requireAll = params.require_all ?? true;

    const systemPrompt = `You are an assertion checker. For each assertion, determine if it is TRUE or FALSE based on the given output.

Be strict and literal. If you cannot clearly verify an assertion, mark it FALSE.

${judgeResponseFormatInstruction({ withAssertions: true })}

"assertion_results" MUST contain exactly one entry per assertion listed below, in the SAME order, with "assertion" set to the exact assertion text given. "score" MUST equal (number of TRUE assertions) / (total assertions). "reasoning" is a brief overall summary.`;

    const userPrompt = `## Output to Check

${context.output}

## Tool Calls Made (for context)

${context.transcript.tool_calls.map(tc => {
  let line = `- ${tc.name}(${JSON.stringify(tc.params).slice(0, 200)})`;
  if (tc.result) {
    const r = (typeof tc.result === 'string' ? tc.result : JSON.stringify(tc.result)).slice(0, 300);
    line += `\n  Result: ${r}`;
  }
  return line;
}).join('\n') || 'None'}

## Assertions to Verify

${params.assertions.map((a, i) => `${i + 1}. ${a}`).join('\n')}

Check each assertion against the output and tool calls.`;

    const judged = await judgeInference(
      { systemPrompt, userPrompt, level, timeout: 60000 },
      this.inferenceFn,
    );

    // Fail loud: inference failure OR schema-invalid/non-JSON response both
    // surface here as an explicit score-0 grader error — never a silent
    // default-FALSE per-assertion guess (the old parser's
    // 'Could not parse result from LLM judge output' fallback this
    // replaces; see fixture nla-06-unparseable-silent-false-synthetic).
    if (!judged.success) {
      return this.createResult(0, false, performance.now() - start, {
        reasoning: judged.error,
        details: { judge_error: judged.error, raw_output: judged.raw_output, inference_level: level },
      });
    }

    const returned = judged.assertion_results ?? [];
    if (returned.length !== params.assertions.length) {
      return this.createResult(0, false, performance.now() - start, {
        reasoning: `Judge returned ${returned.length} assertion_results but ${params.assertions.length} assertions were configured`,
        details: {
          judge_error: 'assertion_results count mismatch',
          raw_output: judged.raw_output,
          inference_level: level,
        },
      });
    }

    // Score is ALWAYS recomputed from the per-assertion verdicts (never
    // trusted from the judge's own top-level "score") — this was true of
    // the pre-migration parser too (passCount/total, independent of
    // whatever the judge might have self-reported) and stays the single
    // source of truth for what "score" means on this grader.
    const results = returned.map((r, i) => ({
      assertion: params.assertions[i],
      passed: r.passed,
      explanation: r.explanation ?? '',
    }));

    const passCount = results.filter(r => r.passed).length;
    const score = passCount / params.assertions.length;

    const passed = requireAll
      ? passCount === params.assertions.length
      : passCount > 0;

    return this.createResult(score, passed, performance.now() - start, {
      reasoning: `${passCount}/${params.assertions.length} assertions passed`,
      details: {
        results,
        require_all: requireAll,
        inference_level: level,
      },
    });
  }
}

registerGrader('natural_language_assert', NaturalLanguageAssertGrader);
