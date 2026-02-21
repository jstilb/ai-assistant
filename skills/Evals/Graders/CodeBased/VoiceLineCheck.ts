/**
 * VoiceLineCheck Grader
 * Code-based grader that validates voice line quality.
 *
 * Checks:
 * - Word count <= 16
 * - Not empty
 * - No conversational filler ("Done.", "Happy to help!", "Got it.", "Ready.")
 * - Is a factual summary (not conversational)
 * - Starts with "🗣️ Kaya:"
 */

import { BaseGrader, registerGrader, type GraderContext } from '../Base.ts';
import type { GraderConfig, GraderResult, GraderType } from '../../Types/index.ts';

// Conversational filler patterns that should be rejected
const FILLER_PATTERNS: RegExp[] = [
  /^done\.?$/i,
  /^happy to help!?$/i,
  /^got it\.?$/i,
  /^ready\.?$/i,
  /^sure thing!?$/i,
  /^no problem!?$/i,
  /^you got it!?$/i,
  /^here you go!?$/i,
  /^all done!?$/i,
  /^let me know if you need anything/i,
  /^i am here and ready to assist/i,
  /^here to help/i,
  /^glad to help/i,
  /^of course/i,
  /^absolutely/i,
  /^right away/i,
  /^on it/i,
  /^will do/i,
];

// Broader conversational patterns (less specific but still filler)
const CONVERSATIONAL_PATTERNS: RegExp[] = [
  /^i('m| am) (here|ready) (to|and)/i,
  /let me know if/i,
  /anything else/i,
  /happy to (help|assist)/i,
  /glad (to|I could)/i,
];

export class VoiceLineCheckGrader extends BaseGrader {
  type = 'voice_line_check';
  category = 'code_based' as const;

  async grade(context: GraderContext): Promise<GraderResult> {
    const start = performance.now();
    const output = context.output.trim();

    if (!output) {
      return this.createResult(0, false, performance.now() - start, {
        reasoning: 'Empty output - no voice line present',
        details: {
          voice_line_found: false,
          empty: true,
          word_count: 0,
          word_count_valid: false,
          has_correct_prefix: false,
          is_filler: false,
        },
      });
    }

    // Extract voice line(s) - use the LAST one if multiple exist
    const voiceLineMatches = output.match(/🗣️\s+\w+:\s*(.*)/g);
    const hasCorrectPrefix = voiceLineMatches !== null && voiceLineMatches.length > 0;

    if (!hasCorrectPrefix) {
      return this.createResult(0, false, performance.now() - start, {
        reasoning: 'No voice line found with correct prefix (🗣️ <Name>:)',
        details: {
          voice_line_found: false,
          empty: true,
          word_count: 0,
          word_count_valid: false,
          has_correct_prefix: false,
          is_filler: false,
        },
      });
    }

    // Use the last voice line match
    const lastMatch = voiceLineMatches[voiceLineMatches.length - 1];
    const lineMatch = lastMatch.match(/🗣️\s+\w+:\s*(.*)/);
    const voiceLine = lineMatch ? lineMatch[1].trim() : '';

    // Empty check
    if (!voiceLine) {
      return this.createResult(0, false, performance.now() - start, {
        reasoning: 'Voice line is empty',
        details: {
          voice_line_found: true,
          voice_line: voiceLine,
          empty: true,
          word_count: 0,
          word_count_valid: false,
          has_correct_prefix: true,
          is_filler: false,
        },
      });
    }

    // Word count
    const words = voiceLine.split(/\s+/).filter(w => w.length > 0);
    const wordCount = words.length;
    const wordCountValid = wordCount <= 16;

    // Filler detection
    const isDirectFiller = FILLER_PATTERNS.some(p => p.test(voiceLine));
    const isConversational = CONVERSATIONAL_PATTERNS.some(p => p.test(voiceLine));
    const isFiller = isDirectFiller || isConversational;

    // Calculate score
    let score = 1.0;
    const issues: string[] = [];

    if (!wordCountValid) {
      score -= 0.4;
      issues.push(`Word count ${wordCount} exceeds maximum of 16`);
    }

    if (isFiller) {
      score -= 0.5;
      issues.push('Voice line is conversational filler, not a factual summary');
    }

    score = Math.max(0, score);
    const passed = wordCountValid && !isFiller;

    return this.createResult(score, passed, performance.now() - start, {
      reasoning: issues.length === 0
        ? 'Voice line passes all quality checks'
        : `Voice line issues: ${issues.join('; ')}`,
      details: {
        voice_line_found: true,
        voice_line: voiceLine,
        empty: false,
        word_count: wordCount,
        word_count_valid: wordCountValid,
        has_correct_prefix: hasCorrectPrefix,
        is_filler: isFiller,
        is_direct_filler: isDirectFiller,
        is_conversational: isConversational,
      },
    });
  }
}

registerGrader('voice_line_check', VoiceLineCheckGrader);
