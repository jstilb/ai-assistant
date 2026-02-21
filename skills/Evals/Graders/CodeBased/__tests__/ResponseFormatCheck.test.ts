/**
 * ResponseFormatCheck Grader Tests
 * TDD Red Phase - Tests written before implementation
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import { ResponseFormatCheckGrader } from '../ResponseFormatCheck.ts';
import type { GraderConfig, Transcript } from '../../../Types/index.ts';
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
    type: 'response_format_check' as any,
    weight: 1.0,
    params: params ?? {},
  };
}

// ===========================================================================
// FULL FORMAT RESPONSES
// ===========================================================================

const VALID_FULL_RESPONSE = `
📋 SUMMARY: Implemented the authentication module with OAuth2 support.
🔍 ANALYSIS: The existing codebase lacked proper session management and token refresh.
⚡ ACTIONS: Created auth middleware, token store, and session handler.
✅ RESULTS: All 23 tests passing, OAuth2 flow working end-to-end.
📊 STATUS: Authentication module complete and integrated.
📁 CAPTURE: Token refresh logic uses exponential backoff pattern.
➡️ NEXT: Add rate limiting to auth endpoints.
📖 STORY EXPLANATION:
1. Analyzed the existing authentication flow
2. Identified missing session management
3. Designed OAuth2 integration architecture
4. Implemented token store with refresh logic
5. Built auth middleware for route protection
6. Added comprehensive test coverage
7. Verified end-to-end OAuth2 flow
8. Integrated with existing API routes
⭐ RATE (1-10):
🗣️ Kaya: Built OAuth2 auth module with token refresh and full test coverage.
`.trim();

const VALID_MINIMAL_RESPONSE = `
📋 SUMMARY: Good morning, User!
🗣️ Kaya: Good morning, ready to help with your projects today.
`.trim();

describe('ResponseFormatCheckGrader', () => {
  let grader: ResponseFormatCheckGrader;

  beforeEach(() => {
    grader = new ResponseFormatCheckGrader(makeConfig());
  });

  // =========================================================================
  // Basic Properties
  // =========================================================================

  it('should have correct type and category', () => {
    expect(grader.type).toBe('response_format_check');
    expect(grader.category).toBe('code_based');
  });

  // =========================================================================
  // Full Format Validation
  // =========================================================================

  describe('full format validation', () => {
    it('should pass a valid full format response', async () => {
      const result = await grader.grade(makeContext(VALID_FULL_RESPONSE));
      expect(result.passed).toBe(true);
      expect(result.score).toBeGreaterThanOrEqual(0.9);
    });

    it('should detect missing SUMMARY section', async () => {
      const output = VALID_FULL_RESPONSE.replace(/📋 SUMMARY:.*\n/, '');
      const result = await grader.grade(makeContext(output));
      expect(result.passed).toBe(false);
      expect(result.details?.missing_sections).toContain('SUMMARY');
    });

    it('should detect missing ANALYSIS section', async () => {
      const output = VALID_FULL_RESPONSE.replace(/🔍 ANALYSIS:.*\n/, '');
      const result = await grader.grade(makeContext(output));
      expect(result.score).toBeLessThan(1.0);
      expect(result.details?.missing_sections).toContain('ANALYSIS');
    });

    it('should detect missing voice line', async () => {
      const output = VALID_FULL_RESPONSE.replace(/🗣️ Kaya:.*/, '');
      const result = await grader.grade(makeContext(output));
      expect(result.passed).toBe(false);
      expect(result.details?.missing_sections).toContain('VOICE');
    });

    it('should detect missing STORY EXPLANATION', async () => {
      const lines = VALID_FULL_RESPONSE.split('\n');
      const storyStart = lines.findIndex(l => l.includes('📖 STORY'));
      const rateStart = lines.findIndex(l => l.includes('⭐ RATE'));
      const filtered = lines.filter((_, i) => i < storyStart || i >= rateStart);
      const output = filtered.join('\n');
      const result = await grader.grade(makeContext(output));
      expect(result.details?.missing_sections).toContain('STORY EXPLANATION');
    });

    it('should detect missing RATE section', async () => {
      const output = VALID_FULL_RESPONSE.replace(/⭐ RATE.*\n/, '');
      const result = await grader.grade(makeContext(output));
      expect(result.details?.missing_sections).toContain('RATE');
    });
  });

  // =========================================================================
  // Section Ordering
  // =========================================================================

  describe('section ordering', () => {
    it('should detect out-of-order sections', async () => {
      // Put RESULTS before ANALYSIS
      const output = VALID_FULL_RESPONSE
        .replace(/🔍 ANALYSIS:.*\n/, '')
        .replace(
          /✅ RESULTS:/,
          '✅ RESULTS: All passing.\n🔍 ANALYSIS: Late analysis.'
        );
      const result = await grader.grade(makeContext(output));
      expect(result.details?.ordering_correct).toBe(false);
    });
  });

  // =========================================================================
  // Emoji Prefixes
  // =========================================================================

  describe('emoji prefixes', () => {
    it('should detect wrong emoji prefix', async () => {
      const output = VALID_FULL_RESPONSE.replace('📋 SUMMARY:', '* SUMMARY:');
      const result = await grader.grade(makeContext(output));
      expect(result.score).toBeLessThan(1.0);
    });
  });

  // =========================================================================
  // Voice Line Constraints
  // =========================================================================

  describe('voice line constraints', () => {
    it('should pass voice line with 16 or fewer words', async () => {
      const result = await grader.grade(makeContext(VALID_FULL_RESPONSE));
      expect(result.details?.voice_line_word_count).toBeLessThanOrEqual(16);
    });

    it('should fail voice line with more than 16 words', async () => {
      const output = VALID_FULL_RESPONSE.replace(
        /🗣️ Kaya:.*/,
        '🗣️ Kaya: This is a very long voice line that contains way more than sixteen words and should definitely be flagged as exceeding the word limit.'
      );
      const result = await grader.grade(makeContext(output));
      expect(result.details?.voice_line_valid).toBe(false);
    });
  });

  // =========================================================================
  // STORY EXPLANATION Numbered List
  // =========================================================================

  describe('story explanation format', () => {
    it('should pass numbered list with 1-8 items', async () => {
      const result = await grader.grade(makeContext(VALID_FULL_RESPONSE));
      expect(result.details?.story_format_valid).toBe(true);
    });

    it('should fail story explanation that is not a numbered list', async () => {
      const output = VALID_FULL_RESPONSE.replace(
        /📖 STORY EXPLANATION:\n1\..*\n2\..*\n3\..*\n4\..*\n5\..*\n6\..*\n7\..*\n8\..*/,
        '📖 STORY EXPLANATION:\nThis is just a paragraph without numbering.'
      );
      const result = await grader.grade(makeContext(output));
      expect(result.details?.story_format_valid).toBe(false);
    });

    it('should fail story explanation with more than 8 items', async () => {
      const tooManyItems = Array.from({ length: 10 }, (_, i) => `${i + 1}. Item ${i + 1}`).join('\n');
      const output = VALID_FULL_RESPONSE.replace(
        /📖 STORY EXPLANATION:\n1\..*\n2\..*\n3\..*\n4\..*\n5\..*\n6\..*\n7\..*\n8\..*/,
        `📖 STORY EXPLANATION:\n${tooManyItems}`
      );
      const result = await grader.grade(makeContext(output));
      expect(result.details?.story_format_valid).toBe(false);
    });
  });

  // =========================================================================
  // RATE Line Must Be Blank
  // =========================================================================

  describe('RATE line validation', () => {
    it('should pass when RATE line is blank', async () => {
      const result = await grader.grade(makeContext(VALID_FULL_RESPONSE));
      expect(result.details?.rate_blank).toBe(true);
    });

    it('should fail when AI self-rates', async () => {
      const output = VALID_FULL_RESPONSE.replace(
        '⭐ RATE (1-10):',
        '⭐ RATE (1-10): 8'
      );
      const result = await grader.grade(makeContext(output));
      expect(result.details?.rate_blank).toBe(false);
    });
  });

  // =========================================================================
  // Minimal Format Detection
  // =========================================================================

  describe('minimal format detection', () => {
    it('should pass a valid minimal response', async () => {
      const graderMinimal = new ResponseFormatCheckGrader(
        makeConfig({ format: 'minimal' })
      );
      const result = await graderMinimal.grade(makeContext(VALID_MINIMAL_RESPONSE));
      expect(result.passed).toBe(true);
      expect(result.score).toBeGreaterThanOrEqual(0.9);
    });

    it('should auto-detect minimal format for simple responses', async () => {
      const graderAuto = new ResponseFormatCheckGrader(
        makeConfig({ format: 'auto' })
      );
      const result = await graderAuto.grade(makeContext(VALID_MINIMAL_RESPONSE));
      expect(result.passed).toBe(true);
      expect(result.details?.detected_format).toBe('minimal');
    });

    it('should auto-detect full format for task responses', async () => {
      const graderAuto = new ResponseFormatCheckGrader(
        makeConfig({ format: 'auto' })
      );
      const result = await graderAuto.grade(makeContext(VALID_FULL_RESPONSE));
      expect(result.passed).toBe(true);
      expect(result.details?.detected_format).toBe('full');
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

    it('should handle output with no recognized format', async () => {
      const result = await grader.grade(makeContext('Just some random text without any format.'));
      expect(result.passed).toBe(false);
    });
  });
});
