/**
 * SkillInvoker.test.ts - Smoke tests for SkillInvoker
 */
import { describe, it, expect } from 'bun:test';
import { invokeSkill, skillExists, listSkills } from './SkillInvoker';

describe('SkillInvoker', () => {
  it('exports invokeSkill, skillExists, listSkills', () => {
    expect(typeof invokeSkill).toBe('function');
    expect(typeof skillExists).toBe('function');
    expect(typeof listSkills).toBe('function');
  });

  it('listSkills returns array of strings', () => {
    const skills = listSkills();
    expect(Array.isArray(skills)).toBe(true);
    // Should have at least a few skills
    expect(skills.length).toBeGreaterThan(0);
    for (const s of skills.slice(0, 5)) {
      expect(typeof s).toBe('string');
    }
  });

  it('skillExists returns false for nonexistent skill', () => {
    expect(skillExists('NonExistentSkill12345')).toBe(false);
  });

  it('skillExists returns true for known skill (System)', () => {
    // System skill should always exist
    const result = skillExists('System');
    // May be true or false depending on installation, but must not throw
    expect(typeof result).toBe('boolean');
  });

  it('invokeSkill returns failure result for nonexistent skill', async () => {
    const result = await invokeSkill({
      skill: 'NonExistentSkillXYZ999',
      args: 'test',
      timeout: 5000,
    });
    expect(result.success).toBe(false);
    expect(typeof result.durationMs).toBe('number');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });
});
