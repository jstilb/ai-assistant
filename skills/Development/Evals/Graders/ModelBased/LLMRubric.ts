/**
 * LLM Rubric Grader
 * Score output against a detailed rubric using an LLM judge
 *
 * evals-rebuild slice B1: migrated from a SCORE:/REASONING:/ASSERTIONS:
 * free-text parser to Graders/JudgeProtocol.ts's structured expectJson+zod
 * contract. See JudgeProtocol.ts's docblock for the full rationale. The
 * DELETED parser (and its frozen pre-migration golden fixtures) live in
 * git history / the B1 report — see
 * Graders/__tests__/fixtures/judge-raw-responses.json for the frozen
 * "old parser vs new protocol" agreement disposition table. `scale` still
 * controls the QUALITATIVE flavor text shown to the judge (1-5 / 1-10 /
 * pass-fail framing) — the judging criteria are unchanged — but the judge
 * always reports its final verdict as a normalized 0.0-1.0 "score" field;
 * this grader no longer does its own 1-5/1-10 -> 0-1 arithmetic.
 */

import { BaseGrader, registerGrader, type GraderContext } from '../Base.ts';
import type { GraderResult, LLMRubricParams } from '../../Types/index.ts';
import { inference, type InferenceLevel } from '../../../../../lib/core/Inference';
import { readFileSync, existsSync } from 'fs';
import { judgeInference, judgeResponseFormatInstruction, type InferenceFn } from '../JudgeProtocol.ts';

export class LLMRubricGrader extends BaseGrader {
  type = 'llm_rubric' as const;
  category = 'model_based' as const;
  // buildUserPrompt() puts context.output (and context.transcript.tool_calls)
  // directly into the judge prompt.
  readsOutput = true;

  /**
   * Dependency-injection point for tests. Same convention as
   * EnsembleLabelGrader.inferenceFn / NightlyJudgeGrader.inferenceFn:
   * defaults to the real `inference`; override in tests.
   */
  public inferenceFn: InferenceFn = inference;

  async grade(context: GraderContext): Promise<GraderResult> {
    const start = performance.now();
    const params = this.config.params as LLMRubricParams;

    // Load rubric
    let rubric = params.rubric;
    if (existsSync(params.rubric)) {
      rubric = readFileSync(params.rubric, 'utf-8');
    }

    const scale = params.scale ?? '1-5';
    // Map model preference to inference level (default to standard/Sonnet)
    const levelMap: Record<string, InferenceLevel> = {
      'claude-haiku-4-5-20251001': 'fast',
      'claude-sonnet-4-20250514': 'standard',
      'claude-opus-4-20250514': 'smart',
    };
    const level: InferenceLevel = levelMap[params.judge_model ?? ''] ?? 'standard';

    // Build prompt
    const systemPrompt = this.buildSystemPrompt(scale, params.assertions);
    const userPrompt = this.buildUserPrompt(rubric, params.assertions, context);

    const judged = await judgeInference(
      { systemPrompt, userPrompt, level, timeout: 60000 },
      this.inferenceFn,
    );

    // Fail loud: inference failure OR schema-invalid/non-JSON response both
    // surface here as an explicit score-0 grader error — never a silent
    // 0.5 (there was no such silent-0.5 path in the old parser either, but
    // the old parser DID silently default score=0 with an EMPTY reasoning
    // string when SCORE: simply never matched; this is now a visible error
    // string instead).
    if (!judged.success) {
      return this.createResult(0, false, performance.now() - start, {
        reasoning: `LLM judge error: ${judged.error}`,
        details: { judge_error: judged.error, raw_response: judged.raw_output, inference_level: level, scale },
      });
    }

    const assertion_results = params.assertions?.length
      ? judged.assertion_results?.map(r => r.passed)
      : undefined;

    // Pass bar: score >= 0.5 for every scale (this was already true of the
    // pre-migration rubricScoreToPassed — both its 'pass-fail' and
    // 1-5/1-10 branches were the literal same `score >= 0.5` expression;
    // unchanged here).
    const passed = judged.score >= 0.5;

    return this.createResult(judged.score, passed, performance.now() - start, {
      reasoning: judged.reasoning,
      details: {
        assertion_results,
        inference_level: level,
        scale,
        raw_response: judged.raw_output,
      },
    });
  }

  private buildSystemPrompt(scale: string, assertions?: string[]): string {
    const scaleInstructions = {
      '1-5': 'Judge the output on a 1 (very poor) to 5 (excellent) quality scale internally, then report it normalized to the shared 0.0-1.0 "score" field below (1->0.0, 5->1.0, linear in between).',
      '1-10': 'Judge the output on a 1 (very poor) to 10 (excellent) quality scale internally, then report it normalized to the shared 0.0-1.0 "score" field below (1->0.0, 10->1.0, linear in between).',
      'pass-fail': 'Determine if the output PASSES or FAILS the criteria. Report "score" as exactly 1.0 for PASS or exactly 0.0 for FAIL.',
    }[scale];

    return `You are an expert evaluator assessing AI-generated output against quality criteria.

${scaleInstructions}

${judgeResponseFormatInstruction({ withAssertions: Boolean(assertions?.length) })}

Be objective and fair. Consider both strengths and weaknesses.`;
  }

  private buildUserPrompt(
    rubric: string,
    assertions: string[] | undefined,
    context: GraderContext
  ): string {
    let prompt = `## Evaluation Rubric

${rubric}

## Output to Evaluate

${context.output}
`;

    if (assertions?.length) {
      prompt += `
## Specific Assertions to Check

For each assertion, determine if it is TRUE or FALSE and include it in "assertion_results", one entry per assertion, in this order, with "assertion" set to the exact text:

${assertions.map((a, i) => `${i + 1}. ${a}`).join('\n')}
`;
    }

    if (context.reference) {
      prompt += `
## Reference Output (for comparison)

${context.reference}
`;
    }

    if (context.transcript.tool_calls.length > 0) {
      prompt += `
## Tool Calls and Results

`;
      for (const tc of context.transcript.tool_calls) {
        const paramsStr = JSON.stringify(tc.params).slice(0, 200);
        prompt += `### ${tc.name}(${paramsStr})\n`;
        if (tc.result) {
          const resultStr = (typeof tc.result === 'string' ? tc.result : JSON.stringify(tc.result)).slice(0, 500);
          prompt += `Result: ${resultStr}\n\n`;
        }
        if (tc.error) {
          prompt += `Error: ${tc.error}\n\n`;
        }
      }
    }

    prompt += `
## Your Evaluation

Evaluate the output against the rubric and provide your assessment.`;

    return prompt;
  }
}

registerGrader('llm_rubric', LLMRubricGrader);
