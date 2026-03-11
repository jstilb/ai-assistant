/**
 * Reference Comparison Grader
 * Compare output to golden reference via LLM judge
 */

import { BaseGrader, registerGrader, type GraderContext } from '../Base.ts';
import type { GraderConfig, GraderResult } from '../../Types/index.ts';
import { inference, type InferenceLevel } from '../../../../../lib/core/Inference';
import { readFileSync, existsSync } from 'fs';

export interface ReferenceComparisonParams {
  reference: string;  // Path to reference file or inline content
  judge_model?: string;
  criteria?: string[];  // Specific aspects to compare
  similarity_threshold?: number;  // 0-1, default 0.8
  allow_superset?: boolean;  // Allow output to be more complete than reference
}

export class ReferenceComparisonGrader extends BaseGrader {
  type = 'reference_comparison' as const;
  category = 'model_based' as const;

  async grade(context: GraderContext): Promise<GraderResult> {
    const start = performance.now();
    const params = this.config.params as ReferenceComparisonParams;

    // Load reference
    let reference = params.reference;
    if (existsSync(params.reference)) {
      reference = readFileSync(params.reference, 'utf-8');
    }

    if (!reference) {
      return this.createResult(0, false, performance.now() - start, {
        reasoning: 'No reference output available',
      });
    }

    // Map model preference to inference level
    const levelMap: Record<string, InferenceLevel> = {
      'claude-haiku-4-5-20251001': 'fast',
      'claude-sonnet-4-20250514': 'standard',
      'claude-opus-4-20250514': 'smart',
    };
    const level: InferenceLevel = levelMap[params.judge_model ?? ''] ?? 'standard';

    const criteriaText = params.criteria?.length
      ? `Focus on these specific criteria:\n${params.criteria.map(c => `- ${c}`).join('\n')}`
      : 'Consider overall semantic similarity, correctness, and completeness.';

    const systemPrompt = `You are comparing an agent's output to a golden reference to assess similarity and correctness.

${criteriaText}

${params.allow_superset
  ? 'The output may contain MORE information than the reference - this is acceptable as long as the core content matches.'
  : 'The output should closely match the reference in content and structure.'}

Respond in this format:
ANALYSIS: <detailed comparison of output vs reference>
SIMILARITY: <score from 0.0 to 1.0>
MISSING: <key elements from reference that are missing in output, or "none">
EXTRA: <significant extra content in output not in reference, or "none">
ERRORS: <factual errors or inconsistencies, or "none">

Be precise with the similarity score - 1.0 means perfect match, 0.8+ means good match with minor differences, 0.5-0.8 means partial match, below 0.5 means significant differences.`;

    const userPrompt = `## Reference (Golden Output)

${reference}

## Agent Output

${context.output}

Compare the agent output to the reference and provide similarity assessment.`;

    try {
      const result = await inference({
        systemPrompt,
        userPrompt,
        level,
        timeout: 60000,
      });

      if (!result.success) {
        throw new Error(result.error || 'Inference failed');
      }

      const text = result.output;

      // Parse response
      const analysisMatch = text.match(/ANALYSIS:\s*([\s\S]*?)(?=SIMILARITY:|$)/i);
      const similarityMatch = text.match(/SIMILARITY:\s*([\d.]+)/i);
      const missingMatch = text.match(/MISSING:\s*([\s\S]*?)(?=EXTRA:|$)/i);
      const extraMatch = text.match(/EXTRA:\s*([\s\S]*?)(?=ERRORS:|$)/i);
      const errorsMatch = text.match(/ERRORS:\s*([\s\S]*?)$/i);

      const similarity = similarityMatch?.[1] ? parseFloat(similarityMatch[1]) : 0.5;
      const analysis = analysisMatch?.[1]?.trim() ?? 'No analysis provided';
      const missing = missingMatch?.[1]?.trim() ?? 'unknown';
      const extra = extraMatch?.[1]?.trim() ?? 'unknown';
      const errors = errorsMatch?.[1]?.trim() ?? 'unknown';

      const threshold = params.similarity_threshold ?? 0.8;
      const score = Math.max(0, Math.min(1, similarity));
      const passed = score >= threshold;

      return this.createResult(score, passed, performance.now() - start, {
        reasoning: `Similarity: ${score.toFixed(2)} (threshold: ${threshold.toFixed(2)}) - ${passed ? 'PASS' : 'FAIL'}`,
        details: {
          similarity: score,
          threshold,
          analysis,
          missing,
          extra,
          errors,
          inference_level: level,
          criteria: params.criteria,
        },
      });
    } catch (e) {
      return this.createResult(0, false, performance.now() - start, {
        reasoning: `Reference comparison error: ${e}`,
      });
    }
  }
}

registerGrader('reference_comparison', ReferenceComparisonGrader);
