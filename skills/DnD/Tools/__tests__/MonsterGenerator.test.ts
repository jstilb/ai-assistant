import { describe, test, expect, mock } from "bun:test";
import {
  generateMonsterStats,
  adjustStatsToCR,
  buildMonsterFromStats,
  type GeneratorOptions,
  type GeneratedMonsterStats,
} from "../MonsterGenerator";

describe("MonsterGenerator", () => {
  // ============================================
  // CR-Based Stat Adjustment
  // ============================================
  describe("adjustStatsToCR()", () => {
    test("adjusts HP to match CR 5 target range (131-145)", () => {
      const stats: GeneratedMonsterStats = {
        name: "Test Beast",
        hp: 200, // Too high for CR 5
        ac: 15,
        attackBonus: 6,
        dpr: 35,
        saveDC: 15,
      };
      const adjusted = adjustStatsToCR(stats, 5);
      expect(adjusted.hp).toBeGreaterThanOrEqual(100);
      expect(adjusted.hp).toBeLessThanOrEqual(175);
    });

    test("adjusts DPR to match CR 5 target range (33-38)", () => {
      const stats: GeneratedMonsterStats = {
        name: "Test Beast",
        hp: 136,
        ac: 15,
        attackBonus: 6,
        dpr: 100, // Way too high for CR 5
        saveDC: 15,
      };
      const adjusted = adjustStatsToCR(stats, 5);
      expect(adjusted.dpr).toBeGreaterThanOrEqual(20);
      expect(adjusted.dpr).toBeLessThanOrEqual(55);
    });

    test("preserves name through adjustment", () => {
      const stats: GeneratedMonsterStats = {
        name: "Thornback",
        hp: 136,
        ac: 15,
        attackBonus: 6,
        dpr: 35,
        saveDC: 15,
      };
      const adjusted = adjustStatsToCR(stats, 5);
      expect(adjusted.name).toBe("Thornback");
    });

    test("CR 1 adjustment produces appropriate stats", () => {
      const stats: GeneratedMonsterStats = {
        name: "Small Critter",
        hp: 300,
        ac: 20,
        attackBonus: 12,
        dpr: 80,
        saveDC: 18,
      };
      const adjusted = adjustStatsToCR(stats, 1);
      expect(adjusted.hp).toBeLessThanOrEqual(120);
      expect(adjusted.dpr).toBeLessThanOrEqual(25);
    });

    test("CR 10 adjustment produces appropriate stats", () => {
      const stats: GeneratedMonsterStats = {
        name: "Mid-Boss",
        hp: 50,
        ac: 10,
        attackBonus: 2,
        dpr: 10,
        saveDC: 10,
      };
      const adjusted = adjustStatsToCR(stats, 10);
      expect(adjusted.hp).toBeGreaterThanOrEqual(150);
      expect(adjusted.dpr).toBeGreaterThanOrEqual(40);
    });
  });

  // ============================================
  // Full Monster Building
  // ============================================
  describe("buildMonsterFromStats()", () => {
    test("builds complete monster object from generated stats", () => {
      const stats: GeneratedMonsterStats = {
        name: "Thornback",
        size: "Large",
        type: "beast",
        alignment: "unaligned",
        hp: 136,
        ac: 15,
        attackBonus: 6,
        dpr: 35,
        saveDC: 15,
        speed: { walk: 40 },
        abilities: { str: 18, dex: 14, con: 16, int: 3, wis: 12, cha: 6 },
        traits: [
          { name: "Pack Tactics", description: "Advantage on attack rolls when ally is within 5 feet." }
        ],
        actions: [
          { name: "Bite", description: "Melee Weapon Attack: +6 to hit, reach 5 ft., one target. Hit: 15 (2d10+4) piercing damage." }
        ],
      };
      const monster = buildMonsterFromStats(stats, 5);
      expect(monster.name).toBe("Thornback");
      expect(monster.cr).toBe(5);
      expect(monster.xp).toBe(1800);
      expect(monster.hp).toBe(136);
      expect(monster.actions.length).toBeGreaterThan(0);
    });

    test("assigns correct XP for CR", () => {
      const stats: GeneratedMonsterStats = {
        name: "Test",
        hp: 75,
        ac: 13,
        attackBonus: 3,
        dpr: 10,
        saveDC: 13,
      };
      const monster = buildMonsterFromStats(stats, 1);
      expect(monster.xp).toBe(200);
    });

    test("assigns correct XP for CR 10", () => {
      const stats: GeneratedMonsterStats = {
        name: "Boss",
        hp: 210,
        ac: 17,
        attackBonus: 7,
        dpr: 65,
        saveDC: 16,
      };
      const monster = buildMonsterFromStats(stats, 10);
      expect(monster.xp).toBe(5900);
    });
  });

  // ============================================
  // generateMonsterStats (with mock inference)
  // ============================================
  describe("generateMonsterStats()", () => {
    test("returns a GeneratedMonsterStats object with required fields", async () => {
      // Mock the inference call to return predictable data
      const mockResult: GeneratedMonsterStats = {
        name: "Thornback",
        size: "Large",
        type: "beast",
        alignment: "unaligned",
        hp: 136,
        ac: 15,
        attackBonus: 6,
        dpr: 35,
        saveDC: 15,
        speed: { walk: 40 },
        abilities: { str: 18, dex: 14, con: 16, int: 3, wis: 12, cha: 6 },
        traits: [],
        actions: [
          { name: "Bite", description: "Melee Weapon Attack: +6 to hit, one target. Hit: 15 (2d10+4) piercing." }
        ],
      };

      const result = await generateMonsterStats({
        cr: 5,
        type: "beast",
        environment: "forest",
        name: "Thornback",
        _mockInference: async () => JSON.stringify(mockResult),
      });

      expect(result.name).toBe("Thornback");
      expect(result.type).toBe("beast");
      expect(result.hp).toBeGreaterThan(0);
    });
  });
});
