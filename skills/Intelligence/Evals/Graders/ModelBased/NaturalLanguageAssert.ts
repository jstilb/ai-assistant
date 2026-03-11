/**
 * Natural Language Assertion Grader
 * Check if specific assertions are true about the output
 */

import { BaseGrader, registerGrader, type GraderContext } from '../Base.ts';
import type { GraderConfig, GraderResult, NaturalLanguageAssertParams } from '../../Types/index.ts';
import { inference, type InferenceLevel } from '../../../../../lib/core/Inference';

export class NaturalLanguageAssertGrader extends BaseGrader {
  type = 'natural_language_assert' as const;
  category = 'model_based' as const;

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

Respond in this exact format for each assertion:
1. TRUE/FALSE: <brief explanation>
2. TRUE/FALSE: <brief explanation>
...`;

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
      const results = this.parseResults(text, params.assertions);

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
    } catch (e) {
      return this.createResult(0, false, performance.now() - start, {
        reasoning: `LLM assertion check error: ${e}`,
      });
    }
  }

  private parseResults(
    text: string,
    assertions: string[]
  ): { assertion: string; passed: boolean; explanation: string }[] {
    return assertions.map((assertion, i) => {
      const num = i + 1;

      // Try multiple patterns LLMs commonly produce:
      // 1. TRUE/FALSE: explanation
      // **1. TRUE**: explanation
      // 1. **TRUE** - explanation
      // Assertion 1: TRUE — explanation
      const patterns = [
        new RegExp(`\\*{0,2}${num}\\.\\s*\\*{0,2}\\s*(TRUE|FALSE)\\s*\\*{0,2}\\s*[:—\\-]\\s*(.*)`, 'i'),
        new RegExp(`${num}\\.\\s*(TRUE|FALSE)\\b[.:]?\\s*(.*)`, 'i'),
        new RegExp(`Assertion\\s+${num}\\s*[:.]\\s*(TRUE|FALSE)\\b[.:]?\\s*(.*)`, 'i'),
        new RegExp(`\\*\\*${num}\\.\\s*(TRUE|FALSE)\\*\\*\\s*[:—\\-]?\\s*(.*)`, 'i'),
      ];

      for (const pattern of patterns) {
        const match = text.match(pattern);
        if (match) {
          return {
            assertion,
            passed: match[1].toUpperCase() === 'TRUE',
            explanation: match[2].trim(),
          };
        }
      }

      // Line-by-line scan: find a line mentioning this assertion number with TRUE/FALSE
      const lines = text.split('\n');
      for (const line of lines) {
        // Line must reference this number (e.g. starts with "1." or contains "assertion 1")
        const numRef = new RegExp(`(?:^\\s*\\*{0,2}${num}[.)]|assertion\\s+${num})`, 'i');
        if (numRef.test(line)) {
          const verdict = line.match(/\b(TRUE|FALSE)\b/i);
          if (verdict) {
            const explanation = line.replace(numRef, '').replace(/\b(TRUE|FALSE)\b/i, '').replace(/^[\s*.:—\-]+|[\s*.:—\-]+$/g, '').trim();
            return {
              assertion,
              passed: verdict[1].toUpperCase() === 'TRUE',
              explanation: explanation || `Parsed from line: ${line.trim().slice(0, 80)}`,
            };
          }
        }
      }

      return {
        assertion,
        passed: false,
        explanation: 'Could not parse result from LLM judge output',
      };
    });
  }
}

registerGrader('natural_language_assert', NaturalLanguageAssertGrader);
