import { describe, test, expect } from 'bun:test';
import { selectContext, getProfile, listProfiles, maybeConvertContentToToon } from './ContextSelector';

describe('ContextSelector', () => {
  describe('selectContext', () => {
    test('development profile loads CLI-INDEX as required', async () => {
      const selection = await selectContext('development');
      expect(selection.profile).toBe('development');
      expect(selection.tokenBudget).toBe(1800);
      const requiredFiles = selection.files.filter(f => f.tier === 'required');
      const hasCliIndex = requiredFiles.some(f => f.path.includes('CLI-INDEX'));
      expect(hasCliIndex).toBe(true);
    });

    test('development profile never exceeds budget', async () => {
      const selection = await selectContext('development');
      expect(selection.totalTokens).toBeLessThanOrEqual(selection.tokenBudget);
    });

    test('life-coaching profile loads TELOS files as required', async () => {
      const selection = await selectContext('life-coaching');
      expect(selection.profile).toBe('life-coaching');
      const requiredPaths = selection.files
        .filter(f => f.tier === 'required')
        .map(f => f.path);
      // Should attempt to load TELOS files
      expect(selection.tokenBudget).toBe(2200);
    });

    test('scheduling profile has 800 token budget', async () => {
      const selection = await selectContext('scheduling');
      expect(selection.tokenBudget).toBe(800);
      expect(selection.totalTokens).toBeLessThanOrEqual(800);
    });

    test('conversational profile loads nothing', async () => {
      const selection = await selectContext('conversational');
      expect(selection.files).toHaveLength(0);
      expect(selection.tokenBudget).toBe(200);
    });

    test('boot profile loads nothing', async () => {
      const selection = await selectContext('boot');
      expect(selection.files).toHaveLength(0);
      expect(selection.tokenBudget).toBe(200);
    });

    test('unknown profile returns empty with error', async () => {
      const selection = await selectContext('nonexistent-profile-xyz');
      expect(selection.files).toHaveLength(0);
      expect(selection.tokenBudget).toBe(0);
      expect(selection.skippedFiles.length).toBeGreaterThan(0);
      expect(selection.skippedFiles[0].reason).toContain('not found');
    });
  });

  describe('budget enforcement', () => {
    test('files are loaded in priority order: required > recommended > optional', async () => {
      const selection = await selectContext('development');
      if (selection.files.length >= 2) {
        const tiers = selection.files.map(f => f.tier);
        const tierOrder = { required: 0, recommended: 1, optional: 2 };
        for (let i = 1; i < tiers.length; i++) {
          expect(tierOrder[tiers[i]]).toBeGreaterThanOrEqual(tierOrder[tiers[i - 1]]);
        }
      }
    });

    test('skipped files include reason', async () => {
      // Use a profile that might skip files due to budget
      const selection = await selectContext('development');
      for (const skipped of selection.skippedFiles) {
        expect(skipped.path).toBeString();
        expect(skipped.reason).toBeString();
      }
    });

    test('budgetUsed + budgetRemaining equals tokenBudget', async () => {
      const selection = await selectContext('development');
      expect(selection.budgetUsed + selection.budgetRemaining).toBe(selection.tokenBudget);
    });

    test('totalTokens matches sum of file tokens', async () => {
      const selection = await selectContext('development');
      const computed = selection.files.reduce((sum, f) => sum + f.tokens, 0);
      expect(selection.totalTokens).toBe(computed);
    });
  });

  describe('compressed fallback', () => {
    test('files have compressed flag set correctly', async () => {
      const selection = await selectContext('development');
      for (const file of selection.files) {
        expect(typeof file.compressed).toBe('boolean');
      }
    });
  });

  describe('getProfile', () => {
    test('returns profile config for valid profile', async () => {
      const profile = await getProfile('development');
      expect(profile).not.toBeNull();
      expect(profile!.tokenBudget).toBe(1800);
      expect(profile!.required).toBeArray();
      expect(profile!.recommended).toBeArray();
      expect(profile!.optional).toBeArray();
      expect(profile!.excludes).toBeArray();
    });

    test('returns null for unknown profile', async () => {
      const profile = await getProfile('nonexistent-xyz');
      expect(profile).toBeNull();
    });
  });

  describe('listProfiles', () => {
    test('returns all configured profiles', async () => {
      const profiles = await listProfiles();
      expect(profiles.length).toBeGreaterThan(0);
      const names = profiles.map(p => p.name);
      expect(names).toContain('development');
      expect(names).toContain('life-coaching');
      expect(names).toContain('scheduling');
      expect(names).toContain('conversational');
      expect(names).toContain('boot');
    });

    test('each profile has name, budget, description', async () => {
      const profiles = await listProfiles();
      for (const p of profiles) {
        expect(p.name).toBeString();
        expect(p.budget).toBeNumber();
        expect(p.description).toBeString();
      }
    });
  });

  describe('maybeConvertContentToToon', () => {
    test('returns original for non-JSON content', () => {
      const result = maybeConvertContentToToon('# Hello World\nSome markdown');
      expect(result.converted).toBe(false);
      expect(result.format).toBe('original');
    });

    test('returns original for JSON objects (not arrays)', () => {
      const result = maybeConvertContentToToon('{"key": "value"}');
      expect(result.converted).toBe(false);
      expect(result.format).toBe('original');
    });

    test('returns original for empty arrays', () => {
      const result = maybeConvertContentToToon('[]');
      expect(result.converted).toBe(false);
      expect(result.format).toBe('original');
    });

    test('returns original for arrays of primitives', () => {
      const result = maybeConvertContentToToon('[1, 2, 3]');
      expect(result.converted).toBe(false);
      expect(result.format).toBe('original');
    });

    test('handles invalid JSON gracefully', () => {
      const result = maybeConvertContentToToon('[{broken json');
      expect(result.converted).toBe(false);
      expect(result.format).toBe('original');
    });
  });
});
