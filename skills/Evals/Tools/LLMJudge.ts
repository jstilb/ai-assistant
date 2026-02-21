#!/usr/bin/env bun
/**
 * LLMJudge - Rubric-based LLM grading for eval suites
 *
 * Uses Kaya Inference.ts (fast level = Haiku) for rubric-based grading.
 * Accepts a rubric string, sends prompt+response to Haiku, returns score 0-1
 * with reasoning.
 *
 * Usage (CLI):
 *   bun LLMJudge.ts <prompt> <response> <rubric>
 *
 * Usage (Library):
 *   import { judge, buildJudgePrompt, parseJudgeResponse } from './LLMJudge.ts';
 *   const result = await judge("What is my name?", "Your name is User.", "Score 1.0 if...");
 */

import { inference } from "../../CORE/Tools/Inference.ts";

// ============================================================================
// Types
// ============================================================================

export interface JudgeResult {
  score: number;
  reasoning: string;
}

// ============================================================================
// Prompt Building
// ============================================================================

const JUDGE_SYSTEM_PROMPT = `You are an expert evaluator for an AI assistant. Your job is to grade a response against a rubric.

You MUST respond in this exact format:

REASONING: <your analysis of how the response matches or fails the rubric>
SCORE: <a number from 0.0 to 1.0>

Rules:
- 0.0 = completely fails the rubric
- 0.5 = partially meets the rubric
- 1.0 = perfectly meets the rubric
- Be precise and objective
- Always provide both REASONING and SCORE lines`;

/**
 * Build the user prompt for the judge
 */
export function buildJudgePrompt(
  prompt: string,
  response: string,
  rubric: string
): string {
  return `## Original Prompt
${prompt}

## Response to Evaluate
${response}

## Rubric
${rubric}

## Instructions
Evaluate the response against the rubric. Provide your analysis and a score from 0.0 to 1.0.

Format your response as:
REASONING: <your analysis>
SCORE: <0.0 to 1.0>`;
}

// ============================================================================
// Response Parsing
// ============================================================================

/**
 * Parse the judge's response to extract score and reasoning
 */
export function parseJudgeResponse(text: string): JudgeResult {
  // Extract score
  const scoreMatch = text.match(/SCORE:\s*([\d.]+)/i);
  let score = 0;
  if (scoreMatch) {
    score = parseFloat(scoreMatch[1]);
    // Clamp to 0-1
    score = Math.max(0, Math.min(1, score));
  }

  // Extract reasoning
  const reasoningMatch = text.match(
    /REASONING:\s*([\s\S]*?)(?=SCORE:|$)/i
  );
  const reasoning = reasoningMatch?.[1]?.trim() || text.trim();

  return { score, reasoning };
}

// ============================================================================
// Core Judge Function
// ============================================================================

/**
 * Judge a response against a rubric using Haiku (fast inference)
 */
export async function judge(
  prompt: string,
  response: string,
  rubric: string
): Promise<JudgeResult> {
  const userPrompt = buildJudgePrompt(prompt, response, rubric);

  try {
    const result = await inference({
      systemPrompt: JUDGE_SYSTEM_PROMPT,
      userPrompt,
      level: "fast", // Haiku for cost-effective grading
      timeout: 15000,
    });

    if (!result.success) {
      return {
        score: 0,
        reasoning: `LLM Judge error: ${result.error}`,
      };
    }

    return parseJudgeResponse(result.output);
  } catch (e) {
    return {
      score: 0,
      reasoning: `LLM Judge exception: ${e}`,
    };
  }
}

// ============================================================================
// CLI Interface
// ============================================================================

if (import.meta.main) {
  const args = process.argv.slice(2);

  if (args.length < 3 || args[0] === "--help" || args[0] === "-h") {
    console.log(`
LLMJudge - Rubric-based LLM grading

Usage:
  bun LLMJudge.ts <prompt> <response> <rubric>

Arguments:
  prompt     The original prompt given to the AI
  response   The AI's response to evaluate
  rubric     The grading rubric (criteria for scoring)

Output:
  JSON with { score: number, reasoning: string }

Examples:
  bun LLMJudge.ts "What is my name?" "Your name is User." "Score 1.0 if response identifies user as User"
  bun LLMJudge.ts "Who are you?" "I am Kaya" "Score 1.0 if identifies as Kaya with first person voice"
`);
    process.exit(0);
  }

  const [prompt, response, rubric] = args;

  judge(prompt, response, rubric)
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
      process.exit(result.score >= 0.5 ? 0 : 1);
    })
    .catch((e) => {
      console.error(`Error: ${e}`);
      process.exit(1);
    });
}
