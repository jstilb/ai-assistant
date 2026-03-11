/**
 * LLM Rubric Grader
 * Score output against a detailed rubric using an LLM judge
 */

import { BaseGrader, registerGrader, type GraderContext } from '../Base.ts';
import type { GraderConfig, GraderResult, LLMRubricParams } from '../../Types/index.ts';
import { inference, type InferenceLevel } from '../../../../../lib/core/Inference';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { parse as parseYaml } from 'yaml';

/**
 * Configuration for Fabric pattern adapters
 */
interface FabricAdapterConfig {
  description: string;
  fabric_pattern: string;
  grader_type: string;
  default_config: Record<string, unknown>;
  output_mapping: Record<string, string>;
}

interface FabricAdaptersFile {
  adapters: Record<string, FabricAdapterConfig>;
  fabric_patterns_dir: string;
}

export class LLMRubricGrader extends BaseGrader {
  type = 'llm_rubric' as const;
  category = 'model_based' as const;

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
    const systemPrompt = this.buildSystemPrompt(scale, params.reasoning_first ?? true);
    const userPrompt = this.buildUserPrompt(rubric, params.assertions, context);

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
      const { score, reasoning, assertion_results } = this.parseResponse(text, scale, params.assertions);

      const passed = this.scoreToPassed(score, scale);

      return this.createResult(score, passed, performance.now() - start, {
        reasoning,
        details: {
          assertion_results,
          inference_level: level,
          scale,
          raw_response: text,
        },
      });
    } catch (e) {
      return this.createResult(0, false, performance.now() - start, {
        reasoning: `LLM judge error: ${e}`,
      });
    }
  }

  private buildSystemPrompt(scale: string, reasoningFirst: boolean): string {
    const scaleInstructions = {
      '1-5': 'Score from 1 (very poor) to 5 (excellent)',
      '1-10': 'Score from 1 (very poor) to 10 (excellent)',
      'pass-fail': 'Determine if the output PASSES or FAILS the criteria',
    }[scale];

    const format = reasoningFirst
      ? `First explain your reasoning, then provide your score. Format:
REASONING: <your detailed analysis>
SCORE: <your score>`
      : `Provide your score first, then explain. Format:
SCORE: <your score>
REASONING: <your explanation>`;

    return `You are an expert evaluator assessing AI-generated output against quality criteria.

${scaleInstructions}

${format}

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

For each assertion, determine if it is TRUE or FALSE:

${assertions.map((a, i) => `${i + 1}. ${a}`).join('\n')}

After the main evaluation, provide assertion results in this format:
ASSERTIONS:
${assertions.map((_, i) => `${i + 1}. TRUE/FALSE`).join('\n')}
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

  private parseResponse(
    text: string,
    scale: string,
    assertions?: string[]
  ): { score: number; reasoning: string; assertion_results?: boolean[] } {
    // Extract score
    let score = 0;
    const scoreMatch = text.match(/SCORE:\s*(\d+(?:\.\d+)?|PASS|FAIL)/i);

    if (scoreMatch) {
      if (scale === 'pass-fail') {
        score = scoreMatch[1].toUpperCase() === 'PASS' ? 1 : 0;
      } else if (scale === '1-5') {
        score = (parseFloat(scoreMatch[1]) - 1) / 4;  // Normalize to 0-1
      } else if (scale === '1-10') {
        score = (parseFloat(scoreMatch[1]) - 1) / 9;  // Normalize to 0-1
      }
    }

    // Extract reasoning
    const reasoningMatch = text.match(/REASONING:\s*([\s\S]*?)(?=SCORE:|ASSERTIONS:|$)/i);
    const reasoning = reasoningMatch?.[1]?.trim() ?? text;

    // Extract assertion results
    let assertion_results: boolean[] | undefined;
    if (assertions?.length) {
      const assertionsMatch = text.match(/ASSERTIONS:\s*([\s\S]*?)$/i);
      if (assertionsMatch) {
        assertion_results = assertions.map((_, i) => {
          const lineMatch = assertionsMatch[1].match(new RegExp(`${i + 1}\\.\\s*(TRUE|FALSE)`, 'i'));
          return lineMatch?.[1]?.toUpperCase() === 'TRUE';
        });
      }
    }

    return { score: Math.max(0, Math.min(1, score)), reasoning, assertion_results };
  }

  private scoreToPassed(score: number, scale: string): boolean {
    if (scale === 'pass-fail') return score >= 0.5;
    // For 1-5 and 1-10, pass if score is above middle
    return score >= 0.5;
  }

  /**
   * Factory method to create an LLMRubricGrader from a Fabric pattern
   *
   * Usage:
   *   const grader = await LLMRubricGrader.fromFabricPattern('arbiter-evaluate-quality', {
   *     axes: ['clarity', 'accuracy'],
   *     scale: '1-10'
   *   });
   *
   * @param patternName - Name of the Fabric pattern (e.g., 'arbiter-evaluate-quality')
   * @param overrides - Optional config overrides
   * @returns Configured LLMRubricGrader instance
   */
  static async fromFabricPattern(
    patternName: string,
    overrides: Partial<LLMRubricParams> = {}
  ): Promise<LLMRubricGrader> {
    const KAYA_HOME = process.env.HOME + '/.claude';

    // Load fabric adapters configuration
    const adaptersPath = join(KAYA_HOME, 'skills/Intelligence/Evals/Templates/fabric-adapters.yaml');
    if (!existsSync(adaptersPath)) {
      throw new Error(`Fabric adapters config not found at ${adaptersPath}`);
    }

    const adaptersContent = readFileSync(adaptersPath, 'utf-8');
    const adapters: FabricAdaptersFile = parseYaml(adaptersContent);

    // Check if pattern has an adapter
    const adapter = adapters.adapters[patternName];
    if (!adapter) {
      // Try loading pattern directly without adapter
      console.warn(`No adapter found for ${patternName}, loading pattern directly`);
    }

    // Resolve patterns directory
    const patternsDir = adapters.fabric_patterns_dir.replace('${HOME}', process.env.HOME || '');

    // Load pattern's system.md
    const patternDir = join(patternsDir, adapter?.fabric_pattern || patternName);
    const systemMdPath = join(patternDir, 'system.md');

    if (!existsSync(systemMdPath)) {
      throw new Error(`Fabric pattern not found: ${systemMdPath}`);
    }

    const patternContent = readFileSync(systemMdPath, 'utf-8');

    // Build rubric from pattern content
    const rubric = `# Evaluation Criteria (from Fabric pattern: ${patternName})

${patternContent}

---

Use the above criteria to evaluate the output. Be thorough and objective.`;

    // Merge adapter defaults with overrides
    const defaultConfig = adapter?.default_config || {};
    const mergedParams: LLMRubricParams = {
      rubric,
      scale: (defaultConfig.scale as '1-5' | '1-10' | 'pass-fail') || '1-5',
      reasoning_first: true,
      ...overrides,
    };

    // Create grader config
    const config: GraderConfig = {
      type: 'llm_rubric',
      weight: 1.0,
      params: mergedParams,
    };

    return new LLMRubricGrader(config);
  }

  /**
   * Check if a grader config references a Fabric pattern
   * Patterns are referenced as: "fabric:pattern-name"
   */
  static isFabricTemplate(template: string): boolean {
    return template.startsWith('fabric:');
  }

  /**
   * Extract pattern name from fabric template reference
   */
  static extractPatternName(template: string): string | null {
    if (!LLMRubricGrader.isFabricTemplate(template)) return null;
    return template.slice('fabric:'.length);
  }
}

registerGrader('llm_rubric', LLMRubricGrader);
