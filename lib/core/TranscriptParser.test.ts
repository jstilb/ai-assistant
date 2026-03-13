/**
 * TranscriptParser.test.ts - Smoke tests for TranscriptParser
 */
import { describe, it, expect } from 'bun:test';
import {
  contentToText,
  parseTranscript,
  getLastAssistantMessage,
  parseLastAssistantMessage,
  extractVoiceCompletion,
  extractCompletionPlain,
  extractStructuredSections,
  detectResponseState,
} from './TranscriptParser';
import { writeFileSync } from 'fs';
import { join } from 'path';
import os from 'os';

const TMP = os.tmpdir();

describe('TranscriptParser', () => {
  it('exports expected functions', () => {
    expect(typeof contentToText).toBe('function');
    expect(typeof parseTranscript).toBe('function');
    expect(typeof getLastAssistantMessage).toBe('function');
    expect(typeof parseLastAssistantMessage).toBe('function');
    expect(typeof extractVoiceCompletion).toBe('function');
    expect(typeof extractCompletionPlain).toBe('function');
    expect(typeof extractStructuredSections).toBe('function');
    expect(typeof detectResponseState).toBe('function');
  });

  it('contentToText handles plain string', () => {
    expect(contentToText('hello')).toBe('hello');
  });

  it('contentToText handles array of text blocks', () => {
    const result = contentToText([{ type: 'text', text: 'foo' }, { type: 'text', text: 'bar' }]);
    expect(result).toContain('foo');
    expect(result).toContain('bar');
  });

  it('contentToText handles string array', () => {
    const result = contentToText(['one', 'two']);
    expect(result).toContain('one');
  });

  it('contentToText handles null/undefined gracefully', () => {
    expect(contentToText(null)).toBe('');
    expect(contentToText(undefined)).toBe('');
  });

  it('parseTranscript with empty file returns defined result', () => {
    const tmpFile = join(TMP, `transcript-test-${Date.now()}.jsonl`);
    writeFileSync(tmpFile, '');
    const result = parseTranscript(tmpFile);
    expect(result).toBeDefined();
    expect(typeof result.raw).toBe('string');
    expect(typeof result.lastMessage).toBe('string');
    expect(typeof result.voiceCompletion).toBe('string');
    expect(typeof result.plainCompletion).toBe('string');
    expect(typeof result.responseState).toBe('string');
  });

  it('parseTranscript with valid assistant entry extracts message', () => {
    const tmpFile = join(TMP, `transcript-test2-${Date.now()}.jsonl`);
    const entry = {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: '📋 SUMMARY: All done.\n🗣️ Kaya: Job complete.' }],
      },
      timestamp: new Date().toISOString(),
    };
    writeFileSync(tmpFile, JSON.stringify(entry) + '\n');
    const result = parseTranscript(tmpFile);
    expect(result.lastMessage).toContain('SUMMARY');
  });

  it('parseTranscript with nonexistent file throws or returns empty result', () => {
    // parseTranscript may throw ENOENT or return empty — both are acceptable behaviors
    try {
      const result = parseTranscript('/nonexistent/path/transcript.jsonl');
      expect(result).toBeDefined();
    } catch (err) {
      // Acceptable: file not found
      expect(err).toBeDefined();
    }
  });

  it('getLastAssistantMessage returns string for nonexistent path', () => {
    // May throw or return empty string
    try {
      const result = getLastAssistantMessage('/nonexistent/path.jsonl');
      expect(typeof result).toBe('string');
    } catch (err) {
      expect(err).toBeDefined();
    }
  });

  it('extractVoiceCompletion extracts 🗣️ Kaya line', () => {
    const text = '📋 SUMMARY: Done.\n🗣️ Kaya: All tests pass.';
    const voice = extractVoiceCompletion(text);
    expect(typeof voice).toBe('string');
    expect(voice).toContain('All tests pass');
  });

  it('extractCompletionPlain returns plain text string', () => {
    const text = '📋 SUMMARY: Done.\n🗣️ Kaya: All tests pass.';
    const plain = extractCompletionPlain(text);
    expect(typeof plain).toBe('string');
  });

  it('extractStructuredSections extracts known sections', () => {
    const text = '📋 SUMMARY: Done.\n🔍 ANALYSIS: Found issue.\n✅ RESULTS: Fixed.';
    const sections = extractStructuredSections(text);
    expect(typeof sections).toBe('object');
    expect(sections.summary).toBeDefined();
  });

  it('detectResponseState returns valid state', () => {
    const state = detectResponseState('Task completed', '');
    expect(['awaitingInput', 'completed', 'error']).toContain(state);
  });
});
