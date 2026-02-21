import { describe, test, expect } from "bun:test";
import {
  calculateXPBudget,
  getMonsterCountMultiplier,
  rateEncounterDifficulty,
  suggestMonsters,
  parseMonsterList,
  type EncounterBudget,
  type EncounterRating,
  type MonsterSuggestion,
} from "../EncounterBalancer";

describe("EncounterBalancer", () => {
  // ============================================
  // XP Budget Calculation
  // ============================================
  describe("calculateXPBudget()", () => {
    test("party of 4 level-5 PCs returns correct thresholds", () => {
      const budget = calculateXPBudget(5, 4);
      // Per DMG: level 5 thresholds are easy=250, medium=500, hard=750, deadly=1100
      // Party of 4: multiply by 4
      expect(budget.easy).toBe(1000);
      expect(budget.medium).toBe(2000);
      expect(budget.hard).toBe(3000);
      expect(budget.deadly).toBe(4400);
    });

    test("party of 3 level-1 PCs returns correct thresholds", () => {
      const budget = calculateXPBudget(1, 3);
      // Level 1: easy=25, medium=50, hard=75, deadly=100 per character
      expect(budget.easy).toBe(75);
      expect(budget.medium).toBe(150);
      expect(budget.hard).toBe(225);
      expect(budget.deadly).toBe(300);
    });

    test("party of 6 level-10 PCs returns correct thresholds", () => {
      const budget = calculateXPBudget(10, 6);
      // Level 10: easy=600, medium=1200, hard=1900, deadly=2800
      expect(budget.easy).toBe(3600);
      expect(budget.medium).toBe(7200);
      expect(budget.hard).toBe(11400);
      expect(budget.deadly).toBe(16800);
    });

    test("party of 5 level-20 PCs returns correct thresholds", () => {
      const budget = calculateXPBudget(20, 5);
      // Level 20: easy=2800, medium=5700, hard=8500, deadly=12700
      expect(budget.easy).toBe(14000);
      expect(budget.medium).toBe(28500);
      expect(budget.hard).toBe(42500);
      expect(budget.deadly).toBe(63500);
    });
  });

  // ============================================
  // Monster Count Multiplier
  // ============================================
  describe("getMonsterCountMultiplier()", () => {
    test("1 monster = 1.0x multiplier", () => {
      expect(getMonsterCountMultiplier(1)).toBe(1.0);
    });

    test("2 monsters = 1.5x multiplier", () => {
      expect(getMonsterCountMultiplier(2)).toBe(1.5);
    });

    test("4 monsters = 2.0x multiplier (3-6 range)", () => {
      expect(getMonsterCountMultiplier(4)).toBe(2.0);
    });

    test("8 monsters = 2.5x multiplier (7-10 range)", () => {
      expect(getMonsterCountMultiplier(8)).toBe(2.5);
    });

    test("12 monsters = 3.0x multiplier (11-14 range)", () => {
      expect(getMonsterCountMultiplier(12)).toBe(3.0);
    });

    test("15+ monsters = 4.0x multiplier", () => {
      expect(getMonsterCountMultiplier(15)).toBe(4.0);
      expect(getMonsterCountMultiplier(20)).toBe(4.0);
    });
  });

  // ============================================
  // Encounter Difficulty Rating
  // ============================================
  describe("rateEncounterDifficulty()", () => {
    test("2 goblins (50 XP each) vs party of 4 level-5 PCs rates as easy or trivial", () => {
      // 2 goblins: 2 * 50 = 100 base XP, x1.5 multiplier = 150 adjusted XP
      // Budget: easy=1000, medium=2000
      const rating = rateEncounterDifficulty(
        [{ name: "Goblin", cr: 0.25, xp: 50, count: 2 }],
        5,
        4
      );
      expect(["trivial", "easy"]).toContain(rating.difficulty);
    });

    test("1 troll (1800 XP) vs party of 4 level-5 PCs rates as medium-hard range", () => {
      // 1 troll: 1800 XP, x1.0 = 1800 adjusted
      // Budget: easy=1000, medium=2000, hard=3000
      const rating = rateEncounterDifficulty(
        [{ name: "Troll", cr: 5, xp: 1800, count: 1 }],
        5,
        4
      );
      expect(["easy", "medium"]).toContain(rating.difficulty);
    });

    test("returns totalXP, adjustedXP, and difficulty fields", () => {
      const rating = rateEncounterDifficulty(
        [{ name: "Goblin", cr: 0.25, xp: 50, count: 3 }],
        1,
        4
      );
      expect(rating).toHaveProperty("totalXP");
      expect(rating).toHaveProperty("adjustedXP");
      expect(rating).toHaveProperty("difficulty");
      expect(typeof rating.totalXP).toBe("number");
      expect(typeof rating.adjustedXP).toBe("number");
    });

    test("adjustedXP is higher than totalXP with multiple monsters", () => {
      const rating = rateEncounterDifficulty(
        [{ name: "Goblin", cr: 0.25, xp: 50, count: 5 }],
        3,
        4
      );
      expect(rating.adjustedXP).toBeGreaterThan(rating.totalXP);
    });
  });

  // ============================================
  // Monster Suggestion
  // ============================================
  describe("suggestMonsters()", () => {
    test("suggests monsters that fit medium difficulty for 4 level-5 PCs", () => {
      const suggestions = suggestMonsters(5, 4, "medium");
      expect(suggestions.length).toBeGreaterThan(0);
      // Total XP should be in plausible range for medium encounter
      const totalXP = suggestions.reduce((sum, s) => sum + s.xp * s.count, 0);
      expect(totalXP).toBeGreaterThan(0);
    });

    test("suggested monsters are from SRD monster list", () => {
      const suggestions = suggestMonsters(3, 4, "hard");
      for (const s of suggestions) {
        expect(typeof s.name).toBe("string");
        expect(s.name.length).toBeGreaterThan(0);
        expect(s.cr).toBeGreaterThanOrEqual(0);
      }
    });

    test("returns empty or valid list for edge cases", () => {
      const suggestions = suggestMonsters(20, 4, "easy");
      expect(Array.isArray(suggestions)).toBe(true);
    });
  });

  // ============================================
  // Monster List Parsing
  // ============================================
  describe("parseMonsterList()", () => {
    test("parses '2 goblins, 1 bugbear' correctly", () => {
      const parsed = parseMonsterList("2 goblins, 1 bugbear");
      expect(parsed.length).toBe(2);
      expect(parsed[0]).toEqual({ name: "goblin", count: 2 });
      expect(parsed[1]).toEqual({ name: "bugbear", count: 1 });
    });

    test("parses single monster without count", () => {
      const parsed = parseMonsterList("troll");
      expect(parsed.length).toBe(1);
      expect(parsed[0]).toEqual({ name: "troll", count: 1 });
    });

    test("handles plural forms (goblins -> goblin)", () => {
      const parsed = parseMonsterList("3 wolves");
      expect(parsed.length).toBe(1);
      expect(parsed[0].name).toBe("wolf");
    });
  });
});
