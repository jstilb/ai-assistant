/**
 * VoiceLineCheck Grader Tests
 * TDD Red Phase - Tests written before implementation
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import { VoiceLineCheckGrader } from '../VoiceLineCheck.ts';
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
    type: 'voice_line_check' as any,
    weight: 1.0,
    params: params ?? {},
  };
}

describe('VoiceLineCheckGrader', () => {
  let grader: VoiceLineCheckGrader;

  beforeEach(() => {
    grader = new VoiceLineCheckGrader(makeConfig());
  });

  // =========================================================================
  // Basic Properties
  // =========================================================================

  it('should have correct type and category', () => {
    expect(grader.type).toBe('voice_line_check');
    expect(grader.category).toBe('code_based');
  });

  // =========================================================================
  // Valid Voice Lines
  // =========================================================================

  describe('valid voice lines', () => {
    const validLines = [
      'Built OAuth2 auth module with token refresh and full test coverage.',
      'Fixed the authentication bypass bug and added regression tests.',
      'Deployed new monitoring dashboard with real-time metrics.',
      'Analyzed ratings data and identified three key improvement areas.',
      'Created Kaya evals framework with three new behavioral graders.',
    ];

    for (const line of validLines) {
      it(`should pass valid voice line: "${line}"`, async () => {
        const output = `Some response content...\n🗣️ Kaya: ${line}`;
        const result = await grader.grade(makeContext(output));
        expect(result.passed).toBe(true);
        expect(result.score).toBeGreaterThanOrEqual(0.8);
      });
    }
  });

  // =========================================================================
  // Word Count Checks
  // =========================================================================

  describe('word count validation', () => {
    it('should pass voice line with exactly 16 words', async () => {
      const line = 'one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen';
      const output = `Content\n🗣️ Kaya: ${line}`;
      const result = await grader.grade(makeContext(output));
      expect(result.details?.word_count).toBe(16);
      expect(result.details?.word_count_valid).toBe(true);
    });

    it('should fail voice line with more than 16 words', async () => {
      const line = 'one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen';
      const output = `Content\n🗣️ Kaya: ${line}`;
      const result = await grader.grade(makeContext(output));
      expect(result.details?.word_count).toBe(17);
      expect(result.details?.word_count_valid).toBe(false);
      expect(result.passed).toBe(false);
    });

    it('should fail empty voice line', async () => {
      const output = `Content\n🗣️ Kaya:`;
      const result = await grader.grade(makeContext(output));
      expect(result.passed).toBe(false);
      expect(result.details?.empty).toBe(true);
    });
  });

  // =========================================================================
  // Conversational Filler Detection
  // =========================================================================

  describe('conversational filler rejection', () => {
    const fillerLines = [
      'Done.',
      'Happy to help!',
      'Got it.',
      'Ready.',
      'Sure thing!',
      'No problem!',
      'You got it!',
      'Here you go!',
      'All done!',
      'Let me know if you need anything else!',
    ];

    for (const filler of fillerLines) {
      it(`should reject conversational filler: "${filler}"`, async () => {
        const output = `Content\n🗣️ Kaya: ${filler}`;
        const result = await grader.grade(makeContext(output));
        expect(result.passed).toBe(false);
        expect(result.details?.is_filler).toBe(true);
      });
    }
  });

  // =========================================================================
  // Prefix Validation
  // =========================================================================

  describe('prefix validation', () => {
    it('should require voice line to start with the correct prefix', async () => {
      const output = `Content\n🗣️ Kaya: Fixed the auth bug and added tests.`;
      const result = await grader.grade(makeContext(output));
      expect(result.details?.has_correct_prefix).toBe(true);
    });

    it('should fail when prefix is missing', async () => {
      const output = `Content\nKaya: Fixed the auth bug.`;
      const result = await grader.grade(makeContext(output));
      expect(result.passed).toBe(false);
      expect(result.details?.has_correct_prefix).toBe(false);
    });

    it('should fail when voice line is completely absent from output', async () => {
      const output = `Just some content without any voice line.`;
      const result = await grader.grade(makeContext(output));
      expect(result.passed).toBe(false);
      expect(result.details?.voice_line_found).toBe(false);
    });
  });

  // =========================================================================
  // Factual Summary Check
  // =========================================================================

  describe('factual summary quality', () => {
    it('should pass a factual summary of work done', async () => {
      const output = `📋 SUMMARY: Refactored the database connection pool.\n🗣️ Kaya: Refactored database connection pool reducing latency by forty percent.`;
      const result = await grader.grade(makeContext(output));
      expect(result.passed).toBe(true);
    });

    it('should reject purely conversational voice lines', async () => {
      const output = `Content\n🗣️ Kaya: I am here and ready to assist you with whatever you need.`;
      const result = await grader.grade(makeContext(output));
      // Should still pass basic checks but score lower due to lack of factual content
      expect(result.details?.is_filler).toBe(true);
    });
  });

  // =========================================================================
  // Edge Cases
  // =========================================================================

  describe('edge cases', () => {
    it('should handle empty output', async () => {
      const result = await grader.grade(makeContext(''));
      expect(result.passed).toBe(false);
      expect(result.score).toBe(0);
    });

    it('should handle output with multiple voice lines (use last)', async () => {
      const output = `🗣️ Kaya: First line.\nSome content.\n🗣️ Kaya: Second factual line about completed work.`;
      const result = await grader.grade(makeContext(output));
      expect(result.details?.voice_line).toBe('Second factual line about completed work.');
    });
  });
});
