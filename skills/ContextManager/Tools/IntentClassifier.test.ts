import { describe, test, expect, beforeEach, mock, spyOn } from 'bun:test';
import { classifyIntent, detectTopicChange, type ClassificationResult } from './IntentClassifier';

// Mock emitInsight to prevent side effects during tests
mock.module('../../../lib/core/SkillIntegrationBridge', () => ({
  emitInsight: () => Promise.resolve(''),
}));

// Mock inference to avoid real API calls
const mockInferenceResult = { success: true, parsed: { profile: 'general', confidence: 0.7, reasoning: 'test' } };
mock.module('../../../lib/core/Inference', () => ({
  inference: () => Promise.resolve(mockInferenceResult),
}));

describe('IntentClassifier', () => {
  describe('keyword match - development profile', () => {
    test('matches "fix the authentication bug"', async () => {
      const result = await classifyIntent('fix the authentication bug');
      expect(result.profile).toBe('development');
      expect(result.stage).toBe('keyword');
      expect(result.confidence).toBeGreaterThan(0);
    });

    test('matches "deploy the latest changes"', async () => {
      const result = await classifyIntent('deploy the latest changes');
      expect(result.profile).toBe('development');
      expect(result.stage).toBe('keyword');
    });

    test('matches "refactor the login module"', async () => {
      const result = await classifyIntent('refactor the login module');
      expect(result.profile).toBe('development');
      expect(result.stage).toBe('keyword');
    });
  });

  describe('keyword match - life-coaching profile', () => {
    test('matches "how am I doing on my goals"', async () => {
      const result = await classifyIntent('how am I doing on my goals');
      expect(result.profile).toBe('life-coaching');
      expect(result.stage).toBe('keyword');
    });

    test('matches "review my challenge progress"', async () => {
      const result = await classifyIntent('review my challenge progress');
      expect(result.profile).toBe('life-coaching');
      expect(result.stage).toBe('keyword');
    });
  });

  describe('keyword match - scheduling profile', () => {
    test('matches "what meetings do I have tomorrow"', async () => {
      const result = await classifyIntent('what meetings do I have tomorrow');
      expect(result.profile).toBe('scheduling');
      expect(result.stage).toBe('keyword');
    });

    test('matches "schedule a call for next week"', async () => {
      const result = await classifyIntent('schedule a call for next week');
      expect(result.profile).toBe('scheduling');
      expect(result.stage).toBe('keyword');
    });
  });

  describe('keyword match - task-management profile', () => {
    test('matches "show my lucidtasks tasks"', async () => {
      const result = await classifyIntent('show my lucidtasks tasks');
      expect(result.profile).toBe('task-management');
      expect(result.stage).toBe('keyword');
    });

    test('matches "what tasks are overdue"', async () => {
      const result = await classifyIntent('what tasks are overdue');
      expect(result.profile).toBe('task-management');
      expect(result.stage).toBe('keyword');
    });
  });

  describe('keyword match - knowledge-lookup profile', () => {
    test('matches "search my obsidian notes"', async () => {
      const result = await classifyIntent('search my obsidian notes');
      expect(result.profile).toBe('knowledge-lookup');
      expect(result.stage).toBe('keyword');
    });
  });

  describe('keyword match - conversational profile', () => {
    test('matches "hello"', async () => {
      const result = await classifyIntent('hello');
      expect(result.profile).toBe('conversational');
      expect(result.stage).toBe('keyword');
    });

    test('matches "good morning"', async () => {
      const result = await classifyIntent('good morning');
      expect(result.profile).toBe('conversational');
      expect(result.stage).toBe('keyword');
    });

    test('matches "thanks"', async () => {
      const result = await classifyIntent('thanks');
      expect(result.profile).toBe('conversational');
      expect(result.stage).toBe('keyword');
    });
  });

  describe('keyword match - planning profile', () => {
    test('matches "plan my week"', async () => {
      const result = await classifyIntent('plan my week');
      expect(result.profile).toBe('planning');
      expect(result.stage).toBe('keyword');
    });
  });

  describe('confidence threshold - 2x runner-up rule', () => {
    test('high confidence when only one profile matches', async () => {
      const result = await classifyIntent('obsidian vault');
      expect(result.confidence).toBe(1.0);
    });

    test('keyword match succeeds when top score >= 2x runner-up', async () => {
      // "fix the bug" -> development dominates
      const result = await classifyIntent('fix the bug in the code');
      expect(result.stage).toBe('keyword');
      expect(result.profile).toBe('development');
    });
  });

  describe('inference fallback', () => {
    test('falls back to inference for ambiguous prompts', async () => {
      // A prompt with no matching keywords triggers inference
      const result = await classifyIntent('tell me about quantum computing implications');
      expect(result.stage).toBe('inference');
    });

    test('returns default profile on empty-ish prompts', async () => {
      const result = await classifyIntent('x');
      // Single char may not match keywords, falls through to inference
      expect(result).toBeDefined();
      expect(result.profile).toBeDefined();
    });
  });

  describe('classification result structure', () => {
    test('includes required fields', async () => {
      const result = await classifyIntent('fix the bug');
      expect(result.profile).toBeString();
      expect(result.confidence).toBeNumber();
      expect(result.stage).toMatch(/^(keyword|inference)$/);
      expect(result.timestamp).toBeString();
    });

    test('keyword results include scores', async () => {
      const result = await classifyIntent('deploy the code');
      if (result.stage === 'keyword') {
        expect(result.scores).toBeDefined();
        expect(typeof result.scores).toBe('object');
      }
    });
  });

  describe('detectTopicChange', () => {
    test('detects change from development to scheduling', () => {
      const result = detectTopicChange('schedule a meeting for tomorrow', 'development');
      expect(result.changed).toBe(true);
      expect(result.newProfile).toBe('scheduling');
    });

    test('no change for same-profile prompt', () => {
      const result = detectTopicChange('fix another bug', 'development');
      expect(result.changed).toBe(false);
    });

    test('no change for ambiguous prompt', () => {
      const result = detectTopicChange('tell me something interesting', 'development');
      expect(result.changed).toBe(false);
    });

    test('requires confidence > 0.7 for topic change', () => {
      // A prompt that weakly matches a different profile shouldn't trigger change
      const result = detectTopicChange('maybe check the calendar', 'development');
      // If confidence is low, changed should be false
      if (result.changed) {
        expect(result.confidence).toBeGreaterThan(0.7);
      }
    });
  });

  describe('performance', () => {
    test('keyword match completes in <50ms', async () => {
      const start = performance.now();
      await classifyIntent('fix the bug');
      const elapsed = performance.now() - start;
      // Keyword match should be fast (generous threshold for CI)
      expect(elapsed).toBeLessThan(50);
    });
  });
});
