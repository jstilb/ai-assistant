/**
 * ResponseFormatCheck Grader
 * Code-based grader that validates Kaya response format compliance.
 *
 * Checks:
 * - All required sections present (SUMMARY, ANALYSIS, ACTIONS, RESULTS, STATUS, CAPTURE, NEXT, STORY EXPLANATION, RATE, voice line)
 * - Correct emoji prefixes
 * - Section ordering
 * - Voice line word count (max 16 words)
 * - STORY EXPLANATION is numbered list (1-8)
 * - RATE line is left blank (AI should NOT self-rate)
 * - Minimal format detection for conversational responses (SUMMARY + voice line)
 */

import { BaseGrader, registerGrader, type GraderContext } from '../Base.ts';
import type { GraderConfig, GraderResult, GraderType } from '../../Types/index.ts';

// Section definitions in expected order
interface SectionDef {
  key: string;
  emoji: string;
  label: string;
  required_full: boolean;
  required_minimal: boolean;
}

const SECTIONS: SectionDef[] = [
  { key: 'SUMMARY',           emoji: '📋', label: 'SUMMARY',           required_full: true,  required_minimal: true },
  { key: 'ANALYSIS',          emoji: '🔍', label: 'ANALYSIS',          required_full: true,  required_minimal: false },
  { key: 'ACTIONS',           emoji: '⚡', label: 'ACTIONS',           required_full: true,  required_minimal: false },
  { key: 'RESULTS',           emoji: '✅', label: 'RESULTS',           required_full: true,  required_minimal: false },
  { key: 'STATUS',            emoji: '📊', label: 'STATUS',            required_full: true,  required_minimal: false },
  { key: 'CAPTURE',           emoji: '📁', label: 'CAPTURE',           required_full: true,  required_minimal: false },
  { key: 'NEXT',              emoji: '➡️', label: 'NEXT',              required_full: true,  required_minimal: false },
  { key: 'STORY EXPLANATION', emoji: '📖', label: 'STORY EXPLANATION', required_full: true,  required_minimal: false },
  { key: 'RATE',              emoji: '⭐', label: 'RATE',              required_full: true,  required_minimal: false },
  { key: 'VOICE',             emoji: '🗣️', label: 'VOICE',             required_full: true,  required_minimal: true },
];

// Section order for validation (indices into SECTIONS array)
const SECTION_ORDER = SECTIONS.map(s => s.key);

export interface ResponseFormatCheckParams {
  format?: 'full' | 'minimal' | 'auto';
}

export class ResponseFormatCheckGrader extends BaseGrader {
  type = 'response_format_check';
  category = 'code_based' as const;

  async grade(context: GraderContext): Promise<GraderResult> {
    const start = performance.now();
    const output = context.output.trim();
    const params = (this.config.params ?? {}) as ResponseFormatCheckParams;

    if (!output) {
      return this.createResult(0, false, performance.now() - start, {
        reasoning: 'Empty output',
        details: { missing_sections: SECTIONS.map(s => s.key) },
      });
    }

    // Detect format
    const detectedFormat = this.detectFormat(output);
    const requestedFormat = params.format ?? 'full';
    const activeFormat = requestedFormat === 'auto' ? detectedFormat : requestedFormat;

    // Run checks
    const presentSections = this.findPresentSections(output);
    const missingSections = this.findMissingSections(presentSections, activeFormat);
    const orderingCorrect = this.checkOrdering(presentSections);
    const emojiCorrect = this.checkEmojiPrefixes(output);
    const voiceLineResult = this.checkVoiceLine(output);
    const storyResult = activeFormat === 'full' ? this.checkStoryExplanation(output) : { valid: true, count: 0 };
    const rateResult = activeFormat === 'full' ? this.checkRateBlank(output) : { blank: true };

    // Calculate score
    const totalChecks = activeFormat === 'full' ? SECTIONS.length : 2; // minimal: SUMMARY + VOICE
    const presentCount = totalChecks - missingSections.length;
    const sectionScore = presentCount / totalChecks;

    // Weight scoring: sections 40%, ordering 15%, emoji 15%, voice 15%, story 10%, rate 5%
    let score: number;
    if (activeFormat === 'full') {
      score =
        sectionScore * 0.40 +
        (orderingCorrect ? 0.15 : 0) +
        (emojiCorrect ? 0.15 : 0) +
        (voiceLineResult.valid ? 0.15 : 0) +
        (storyResult.valid ? 0.10 : 0) +
        (rateResult.blank ? 0.05 : 0);
    } else {
      // Minimal: sections 50%, voice 30%, emoji 20%
      score =
        sectionScore * 0.50 +
        (voiceLineResult.valid ? 0.30 : 0) +
        (emojiCorrect ? 0.20 : 0);
    }

    // Must have SUMMARY and VOICE to pass
    const hasSummary = presentSections.includes('SUMMARY');
    const hasVoice = presentSections.includes('VOICE');
    const passed = hasSummary && hasVoice && score >= 0.5;

    return this.createResult(score, passed, performance.now() - start, {
      reasoning: this.buildReasoning(missingSections, orderingCorrect, emojiCorrect, voiceLineResult, storyResult, rateResult, activeFormat),
      details: {
        detected_format: detectedFormat,
        active_format: activeFormat,
        present_sections: presentSections,
        missing_sections: missingSections,
        ordering_correct: orderingCorrect,
        emoji_correct: emojiCorrect,
        voice_line_valid: voiceLineResult.valid,
        voice_line_word_count: voiceLineResult.wordCount,
        voice_line: voiceLineResult.line,
        story_format_valid: storyResult.valid,
        story_item_count: storyResult.count,
        rate_blank: rateResult.blank,
      },
    });
  }

  /**
   * Detect whether the output uses full or minimal format
   */
  private detectFormat(output: string): 'full' | 'minimal' {
    // Count how many full-format sections are present
    const fullSections = ['ANALYSIS', 'ACTIONS', 'RESULTS', 'STATUS'];
    const foundCount = fullSections.filter(section => {
      const sectionDef = SECTIONS.find(s => s.key === section);
      if (!sectionDef) return false;
      return output.includes(`${sectionDef.emoji} ${sectionDef.label}:`);
    }).length;

    // If 2+ of the full-format-only sections exist, it is full format
    return foundCount >= 2 ? 'full' : 'minimal';
  }

  /**
   * Find which sections are present in the output, returned in order of appearance
   */
  private findPresentSections(output: string): string[] {
    const found: { key: string; index: number }[] = [];

    for (const section of SECTIONS) {
      let matchIndex = -1;

      if (section.key === 'VOICE') {
        const m = output.match(/🗣️\s+\w+:/);
        if (m && m.index !== undefined) matchIndex = m.index;
      } else if (section.key === 'STORY EXPLANATION') {
        const m = output.match(/📖\s*STORY\s*EXPLANATION/i);
        if (m && m.index !== undefined) matchIndex = m.index;
      } else if (section.key === 'RATE') {
        const m = output.match(/⭐\s*RATE/i);
        if (m && m.index !== undefined) matchIndex = m.index;
      } else {
        const pattern = new RegExp(`${this.escapeRegex(section.emoji)}\\s*${section.label}:`, 'i');
        const m = output.match(pattern);
        if (m && m.index !== undefined) matchIndex = m.index;
      }

      if (matchIndex >= 0) {
        found.push({ key: section.key, index: matchIndex });
      }
    }

    // Sort by position in the output (order of appearance)
    found.sort((a, b) => a.index - b.index);
    return found.map(f => f.key);
  }

  /**
   * Find missing sections based on format requirements
   */
  private findMissingSections(present: string[], format: 'full' | 'minimal'): string[] {
    const required = SECTIONS.filter(s =>
      format === 'full' ? s.required_full : s.required_minimal
    );
    return required
      .filter(s => !present.includes(s.key))
      .map(s => s.key);
  }

  /**
   * Check if present sections appear in the correct order
   */
  private checkOrdering(present: string[]): boolean {
    if (present.length <= 1) return true;

    const indices = present.map(key => SECTION_ORDER.indexOf(key)).filter(i => i >= 0);
    for (let i = 1; i < indices.length; i++) {
      if (indices[i] < indices[i - 1]) return false;
    }
    return true;
  }

  /**
   * Check that sections use correct emoji prefixes
   */
  private checkEmojiPrefixes(output: string): boolean {
    for (const section of SECTIONS) {
      if (section.key === 'VOICE') continue; // Voice has special format

      // Check if the section label appears but with a wrong prefix
      const wrongPrefixPattern = new RegExp(`(?!${this.escapeRegex(section.emoji)})\\S+\\s+${section.label}:`, 'i');
      const correctPrefixPattern = new RegExp(`${this.escapeRegex(section.emoji)}\\s*${section.label}:`, 'i');

      if (wrongPrefixPattern.test(output) && !correctPrefixPattern.test(output)) {
        return false;
      }
    }
    return true;
  }

  /**
   * Extract and validate the voice line
   */
  private checkVoiceLine(output: string): { valid: boolean; wordCount: number; line: string } {
    const match = output.match(/🗣️\s+\w+:\s*(.*)/);
    if (!match) {
      return { valid: false, wordCount: 0, line: '' };
    }

    const line = match[1].trim();
    if (!line) {
      return { valid: false, wordCount: 0, line: '' };
    }

    const wordCount = line.split(/\s+/).filter(w => w.length > 0).length;
    const valid = wordCount > 0 && wordCount <= 16;

    return { valid, wordCount, line };
  }

  /**
   * Validate STORY EXPLANATION section format
   */
  private checkStoryExplanation(output: string): { valid: boolean; count: number } {
    const storyMatch = output.match(/📖\s*STORY\s*EXPLANATION:\s*\n([\s\S]*?)(?=⭐|🗣️|$)/i);
    if (!storyMatch) {
      return { valid: false, count: 0 };
    }

    const storyContent = storyMatch[1].trim();
    const numberedItems = storyContent.match(/^\d+\.\s+.+/gm);

    if (!numberedItems || numberedItems.length === 0) {
      return { valid: false, count: 0 };
    }

    const count = numberedItems.length;
    const valid = count >= 1 && count <= 8;

    return { valid, count };
  }

  /**
   * Check that RATE line is left blank (AI should NOT self-rate)
   */
  private checkRateBlank(output: string): { blank: boolean } {
    const rateMatch = output.match(/⭐\s*RATE\s*\(1-10\):[ \t]*(.*)/i);
    if (!rateMatch) {
      // If RATE section is not present, we treat it as blank for this check
      return { blank: true };
    }

    const rateContent = rateMatch[1].trim();
    // Blank means empty or just whitespace
    return { blank: rateContent.length === 0 };
  }

  /**
   * Build human-readable reasoning string
   */
  private buildReasoning(
    missing: string[],
    ordering: boolean,
    emoji: boolean,
    voice: { valid: boolean; wordCount: number; line: string },
    story: { valid: boolean; count: number },
    rate: { blank: boolean },
    format: string
  ): string {
    const issues: string[] = [];

    if (missing.length > 0) issues.push(`Missing sections: ${missing.join(', ')}`);
    if (!ordering) issues.push('Sections are out of order');
    if (!emoji) issues.push('Incorrect emoji prefixes on some sections');
    if (!voice.valid) {
      if (voice.wordCount === 0) issues.push('Voice line is missing or empty');
      else issues.push(`Voice line too long: ${voice.wordCount} words (max 16)`);
    }
    if (format === 'full' && !story.valid) {
      if (story.count === 0) issues.push('STORY EXPLANATION is not a numbered list');
      else issues.push(`STORY EXPLANATION has ${story.count} items (max 8)`);
    }
    if (format === 'full' && !rate.blank) issues.push('RATE line should be left blank (AI must not self-rate)');

    if (issues.length === 0) return `${format} format: All checks passed`;
    return `${format} format: ${issues.join('; ')}`;
  }

  /**
   * Escape special regex characters
   */
  private escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
}

registerGrader('response_format_check', ResponseFormatCheckGrader);
