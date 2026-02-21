/**
 * IdentityConsistency Grader Tests
 * TDD Red Phase - Tests written before implementation
 *
 * NOTE: Model-based grader tests verify the grader structure, prompt building,
 * and response parsing. Actual inference calls are mocked.
 */

import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { IdentityConsistencyGrader } from '../IdentityConsistency.ts';
import type { GraderConfig } from '../../../Types/index.ts';
import type { GraderContext } from '../../Base.ts';

function makeContext(output: string): GraderContext {
  return {
    task_id: 'test-task',
    trial_id: 'test-trial',
    output,
    transcript: {
      task_id: 'test-task',
      trial_id: 'test-trial',
      started_at: new Date().toISOString(),
      turns: [],
      tool_calls: [],
      metrics: {
        n_turns: 0,
        n_tool_calls: 0,
        total_tokens: 0,
        input_tokens: 0,
        output_tokens: 0,
        wall_time_ms: 0,
      },
    },
  };
}

function makeConfig(params?: Record<string, unknown>): GraderConfig {
  return {
    type: 'identity_consistency' as any,
    weight: 1.0,
    params: params ?? {},
  };
}

describe('IdentityConsistencyGrader', () => {
  let grader: IdentityConsistencyGrader;

  beforeEach(() => {
    grader = new IdentityConsistencyGrader(makeConfig());
  });

  // =========================================================================
  // Basic Properties
  // =========================================================================

  it('should have correct type and category', () => {
    expect(grader.type).toBe('identity_consistency');
    expect(grader.category).toBe('model_based');
  });

  // =========================================================================
  // Code-Based Pre-Checks (run before expensive model call)
  // =========================================================================

  describe('code-based pre-checks', () => {
    it('should detect third-person self-reference ("Kaya" instead of "I")', () => {
      const output = 'Kaya will now analyze the code and Kaya thinks this is the best approach.';
      const checks = grader.runPreChecks(output);
      expect(checks.first_person_violations).toBeGreaterThan(0);
    });

    it('should pass first-person voice', () => {
      const output = 'I analyzed the code and I think this is the best approach.';
      const checks = grader.runPreChecks(output);
      expect(checks.first_person_violations).toBe(0);
    });

    it('should detect "the user" instead of "User"', () => {
      const output = 'The user asked for a refactor, so I will help the user.';
      const checks = grader.runPreChecks(output);
      expect(checks.naming_violations).toBeGreaterThan(0);
    });

    it('should pass when "User" is used correctly', () => {
      const output = 'User asked for a refactor, so I will help.';
      const checks = grader.runPreChecks(output);
      expect(checks.naming_violations).toBe(0);
    });

    it('should allow "Kaya" in voice line prefix', () => {
      const output = '🗣️ Kaya: Fixed the bug and ran tests.';
      const checks = grader.runPreChecks(output);
      // The "Kaya" in the voice line prefix should NOT count as a violation
      expect(checks.first_person_violations).toBe(0);
    });

    it('should detect cliche transitions from forbidden list', () => {
      const output = "Here's the thing... we need to refactor this module.";
      const checks = grader.runPreChecks(output);
      expect(checks.cliche_violations).toBeGreaterThan(0);
    });

    it('should detect "X isn\'t just Y -- it\'s Z" pattern', () => {
      const output = "This module isn't just a library -- it's a framework.";
      const checks = grader.runPreChecks(output);
      expect(checks.cliche_violations).toBeGreaterThan(0);
    });
  });

  // =========================================================================
  // Prompt Construction
  // =========================================================================

  describe('prompt construction', () => {
    it('should build a system prompt referencing identity spec', () => {
      const prompt = grader.buildSystemPrompt();
      expect(prompt).toContain('identity');
      expect(prompt).toContain('personality');
      expect(prompt).toContain('first-person');
    });

    it('should build a user prompt with the output to evaluate', () => {
      const output = 'I fixed the auth bug for User.';
      const prompt = grader.buildUserPrompt(output);
      expect(prompt).toContain(output);
      expect(prompt).toContain('SCORE');
    });
  });

  // =========================================================================
  // Response Parsing
  // =========================================================================

  describe('response parsing', () => {
    it('should parse a valid model response with score and reasoning', () => {
      const response = `REASONING: The response maintains first-person voice throughout and addresses the user as User. Personality is direct and helpful.
SCORE: 4`;
      const parsed = grader.parseResponse(response);
      expect(parsed.score).toBeCloseTo(0.75, 1); // (4-1)/4 = 0.75
      expect(parsed.reasoning).toContain('first-person');
    });

    it('should parse pass-fail format', () => {
      const response = `REASONING: Perfect identity consistency.
SCORE: PASS`;
      const parsed = grader.parseResponse(response, 'pass-fail');
      expect(parsed.score).toBe(1);
    });

    it('should handle malformed responses gracefully', () => {
      const response = 'This is just rambling with no structured output.';
      const parsed = grader.parseResponse(response);
      expect(parsed.score).toBe(0);
      expect(parsed.reasoning).toBeTruthy();
    });
  });

  // =========================================================================
  // Integration (with mock inference)
  // =========================================================================

  describe('full grading flow (mocked inference)', () => {
    it('should combine pre-checks with model evaluation', async () => {
      // A response that passes pre-checks
      const output = `📋 SUMMARY: Refactored the auth module for User.
🔍 ANALYSIS: I found several issues in the token refresh logic.
⚡ ACTIONS: I rewrote the refresh handler with exponential backoff.
✅ RESULTS: All tests passing.
📊 STATUS: Complete.
📁 CAPTURE: Token refresh uses jitter to prevent thundering herd.
➡️ NEXT: Deploy to staging.
📖 STORY EXPLANATION:
1. Analyzed the auth module
2. Found token refresh bugs
3. Rewrote with exponential backoff
4. Added jitter for distributed safety
5. Ran full test suite
6. All tests passing
7. Ready for staging deploy
8. Will monitor error rates
⭐ RATE (1-10):
🗣️ Kaya: Refactored auth token refresh with backoff and jitter patterns.`;

      const preChecks = grader.runPreChecks(output);
      expect(preChecks.first_person_violations).toBe(0);
      expect(preChecks.naming_violations).toBe(0);
      expect(preChecks.cliche_violations).toBe(0);
    });

    it('should penalize heavily for identity violations in pre-checks', async () => {
      const output = `Kaya analyzed the code for the user. Here's the thing... Kaya thinks this is great.`;
      const preChecks = grader.runPreChecks(output);
      expect(preChecks.first_person_violations).toBeGreaterThan(0);
      expect(preChecks.naming_violations).toBeGreaterThan(0);
      expect(preChecks.cliche_violations).toBeGreaterThan(0);
    });
  });
});
