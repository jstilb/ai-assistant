/**
 * IdentityConsistency Grader
 * Model-based grader that evaluates responses against DAIDENTITY.md personality spec.
 *
 * Checks (code-based pre-checks):
 * - First-person voice ("I" not "Kaya")
 * - Addresses user as "Jm" (not "the user")
 * - No cliche transitions from forbidden list
 *
 * Checks (model-based):
 * - Personality traits: direct but gentle, witty, positive, helpful
 * - Natural voice calibration matching spec
 * - Consistent personality across response
 *
 * Uses tools/Inference.ts standard tier for evaluation.
 */

import { BaseGrader, registerGrader, type GraderContext } from '../Base.ts';
import type { GraderConfig, GraderResult, GraderType } from '../../Types/index.ts';

// Patterns for detecting third-person self-reference
// Exclude voice line prefix "🗣️ Kaya:" which is expected
const THIRD_PERSON_PATTERNS: RegExp[] = [
  /(?<!🗣️\s)Kaya\s+(will|can|should|would|is|was|has|had|thinks?|believes?|knows?|found|analyzed|implemented|created|built|deployed)/gi,
  /(?<!🗣️\s)Kaya's\s+(analysis|approach|recommendation|suggestion|implementation)/gi,
];

// Pattern for "the user" instead of "Jm"
const USER_REFERENCE_PATTERNS: RegExp[] = [
  /\bthe user\b/gi,
  /\bthe human\b/gi,
  /\byour user\b/gi,
];

// Forbidden cliche transitions from DAIDENTITY.md
const CLICHE_PATTERNS: RegExp[] = [
  /here['']s the thing/gi,
  /here['']s how this works/gi,
  /the cool part\??/gi,
  /isn['']t just .+[—–\-]{1,2}\s*it['']s/gi,
  /isn['']t just .+\.\.\.\s*it['']s/gi,
];

export interface PreCheckResult {
  first_person_violations: number;
  naming_violations: number;
  cliche_violations: number;
  violation_details: string[];
}

export class IdentityConsistencyGrader extends BaseGrader {
  type = 'identity_consistency';
  category = 'model_based' as const;

  /**
   * Run fast code-based pre-checks before expensive model call
   */
  runPreChecks(output: string): PreCheckResult {
    const violations: string[] = [];

    // Filter out voice line prefix for first-person check
    // The "🗣️ Kaya:" prefix is expected and should not count
    const outputWithoutVoicePrefix = output.replace(/🗣️\s+Kaya:/g, '🗣️ [NAME]:');

    // Check first-person voice
    let firstPersonViolations = 0;
    for (const pattern of THIRD_PERSON_PATTERNS) {
      const matches = outputWithoutVoicePrefix.match(pattern);
      if (matches) {
        firstPersonViolations += matches.length;
        for (const m of matches) {
          violations.push(`Third-person self-reference: "${m}"`);
        }
      }
    }

    // Check naming conventions
    let namingViolations = 0;
    for (const pattern of USER_REFERENCE_PATTERNS) {
      const matches = output.match(pattern);
      if (matches) {
        namingViolations += matches.length;
        for (const m of matches) {
          violations.push(`Generic user reference: "${m}" (should be "Jm")`);
        }
      }
    }

    // Check cliche transitions
    let clicheViolations = 0;
    for (const pattern of CLICHE_PATTERNS) {
      const matches = output.match(pattern);
      if (matches) {
        clicheViolations += matches.length;
        for (const m of matches) {
          violations.push(`Cliche transition: "${m}"`);
        }
      }
    }

    return {
      first_person_violations: firstPersonViolations,
      naming_violations: namingViolations,
      cliche_violations: clicheViolations,
      violation_details: violations,
    };
  }

  /**
   * Build system prompt for the model-based identity evaluation
   */
  buildSystemPrompt(): string {
    return `You are an expert evaluator assessing AI assistant identity consistency.

You are evaluating responses from "Kaya", an AI assistant with a defined identity and personality spec.

## Identity Requirements

1. **First-person voice**: The AI should speak as "I", never refer to itself as "Kaya" in third person (except in voice line prefix)
2. **Naming**: The human user is called "Jm" (pronounced "Jay Em"), never "the user" or "the human"
3. **Personality traits**:
   - Direct but gentle: tells harsh truths constructively
   - Witty and playful: uses humor and levity appropriately
   - Positive: maintains optimistic outlook
   - Helpful: always focuses on moving tasks forward
   - Consistent: same personality across sessions
4. **Natural voice calibration**:
   - Moderate enthusiasm (70/100)
   - High precision (90/100)
   - High wit/playfulness (80/100)
   - Directness (85/100) tempered by gentleness
5. **No cliche transitions**: Avoids "Here's the thing...", "Here's how this works...", "The cool part?", "X isn't just Y—it's Z"

## Scoring

Score from 1 (very poor identity consistency) to 5 (excellent identity consistency):

- 5: Perfect identity consistency - natural first-person voice, addresses Jm by name, personality traits all present, natural and engaging
- 4: Good consistency - minor issues but overall strong identity maintenance
- 3: Moderate - some identity lapses (occasional third person, generic user references) but personality is present
- 2: Poor - significant identity issues (frequent third person, no personality, formulaic)
- 1: Very poor - no identity consistency, reads as generic AI assistant

First explain your reasoning, then provide your score.

Format:
REASONING: <your detailed analysis>
SCORE: <1-5>`;
  }

  /**
   * Build user prompt with the output to evaluate
   */
  buildUserPrompt(output: string): string {
    return `## Response to Evaluate

${output}

## Your Evaluation

Evaluate this response for identity consistency against the Kaya personality spec. Consider:
1. Does it use first-person voice consistently?
2. Does it refer to the user as "Jm" (not "the user")?
3. Are the personality traits (direct, witty, positive, helpful) present?
4. Does it avoid forbidden cliche transitions?
5. Does the voice feel natural and consistent?

Provide your REASONING first, then SCORE (1-5).`;
  }

  /**
   * Parse model response to extract score and reasoning
   */
  parseResponse(response: string, scale: 'pass-fail' | '1-5' = '1-5'): { score: number; reasoning: string } {
    const scoreMatch = response.match(/SCORE:\s*(\d+(?:\.\d+)?|PASS|FAIL)/i);

    let score = 0;
    if (scoreMatch) {
      if (scale === 'pass-fail') {
        score = scoreMatch[1].toUpperCase() === 'PASS' ? 1 : 0;
      } else {
        // Normalize 1-5 to 0-1
        score = (parseFloat(scoreMatch[1]) - 1) / 4;
        score = Math.max(0, Math.min(1, score));
      }
    }

    const reasoningMatch = response.match(/REASONING:\s*([\s\S]*?)(?=SCORE:|$)/i);
    const reasoning = reasoningMatch?.[1]?.trim() ?? response;

    return { score, reasoning };
  }

  /**
   * Main grading function - combines pre-checks with model evaluation
   */
  async grade(context: GraderContext): Promise<GraderResult> {
    const start = performance.now();
    const output = context.output.trim();

    if (!output) {
      return this.createResult(0, false, performance.now() - start, {
        reasoning: 'Empty output',
      });
    }

    // Run fast code-based pre-checks first
    const preChecks = this.runPreChecks(output);
    const totalViolations = preChecks.first_person_violations + preChecks.naming_violations + preChecks.cliche_violations;

    // Pre-check penalty: each violation reduces score
    const preCheckPenalty = Math.min(0.5, totalViolations * 0.1);

    // Try model-based evaluation
    let modelScore = 0.5; // Default if model call fails
    let modelReasoning = 'Model evaluation not available';

    try {
      // Dynamic import to allow mocking and avoid hard dependency
      const { inference } = await import('../../../../../lib/core/Inference.ts');

      const systemPrompt = this.buildSystemPrompt();
      const userPrompt = this.buildUserPrompt(output);

      const result = await inference({
        systemPrompt,
        userPrompt,
        level: 'standard', // Use Sonnet for identity evaluation
        timeout: 60000,
      });

      if (result.success) {
        const parsed = this.parseResponse(result.output);
        modelScore = parsed.score;
        modelReasoning = parsed.reasoning;
      }
    } catch {
      // If inference is not available (e.g., in tests), use pre-checks only
      modelScore = totalViolations === 0 ? 0.75 : Math.max(0, 0.75 - preCheckPenalty);
      modelReasoning = 'Model evaluation unavailable - scoring based on pre-checks only';
    }

    // Combined score: 40% pre-checks, 60% model
    const preCheckScore = Math.max(0, 1.0 - preCheckPenalty);
    const combinedScore = preCheckScore * 0.40 + modelScore * 0.60;
    const passed = combinedScore >= 0.5;

    return this.createResult(combinedScore, passed, performance.now() - start, {
      reasoning: `Pre-checks: ${preChecks.violation_details.length === 0 ? 'All passed' : preChecks.violation_details.join('; ')}. Model: ${modelReasoning}`,
      details: {
        pre_checks: preChecks,
        pre_check_score: preCheckScore,
        model_score: modelScore,
        model_reasoning: modelReasoning,
        combined_score: combinedScore,
      },
    });
  }
}

registerGrader('identity_consistency', IdentityConsistencyGrader);
