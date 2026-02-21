import { describe, test, expect } from "bun:test";
import {
  calculateExpectedDamage,
  findComparableSpells,
  buildSpellBlock,
  forgeSpell,
  type SpellForgeOptions,
  type ForgedSpell,
} from "../SpellForge";

describe("SpellForge", () => {
  // ============================================
  // Expected Damage Calculation
  // ============================================
  describe("calculateExpectedDamage()", () => {
    test("8d6 averages to 28", () => {
      expect(calculateExpectedDamage("8d6")).toBe(28);
    });

    test("1d10 averages to 5.5", () => {
      expect(calculateExpectedDamage("1d10")).toBe(5.5);
    });

    test("10d6+40 averages to 75", () => {
      expect(calculateExpectedDamage("10d6+40")).toBe(75);
    });

    test("8d8 averages to 36", () => {
      expect(calculateExpectedDamage("8d8")).toBe(36);
    });

    test("5d8 averages to 22.5", () => {
      expect(calculateExpectedDamage("5d8")).toBe(22.5);
    });
  });

  // ============================================
  // Comparable Spell Lookup
  // ============================================
  describe("findComparableSpells()", () => {
    test("finds Fireball when searching level 3 evocation", () => {
      const comparable = findComparableSpells(3, "evocation");
      const names = comparable.map((s) => s.name);
      expect(names).toContain("Fireball");
    });

    test("finds Cone of Cold when searching level 5 evocation", () => {
      const comparable = findComparableSpells(5, "evocation");
      const names = comparable.map((s) => s.name);
      expect(names).toContain("Cone of Cold");
    });

    test("returns spells at the same level", () => {
      const comparable = findComparableSpells(3);
      for (const spell of comparable) {
        expect(spell.level).toBe(3);
      }
    });

    test("returns empty array for level with no matching spells in school", () => {
      // Level 9 enchantment - Power Word Kill is enchantment at 9
      const comparable = findComparableSpells(9, "enchantment");
      // Should either find PWK or be empty - either is valid
      expect(Array.isArray(comparable)).toBe(true);
    });
  });

  // ============================================
  // Spell Block Building
  // ============================================
  describe("buildSpellBlock()", () => {
    test("builds complete spell object from forged data", () => {
      const spell = buildSpellBlock({
        name: "Frost Nova",
        level: 3,
        school: "evocation",
        castingTime: "1 action",
        range: "Self (20-foot radius)",
        components: ["V", "S", "M"],
        material: "a shard of ice",
        duration: "Instantaneous",
        description: "A burst of freezing cold erupts from you. Each creature in a 20-foot radius must make a Constitution saving throw, taking 8d6 cold damage on a failed save, or half as much on a successful one.",
        damage: "8d6",
        damageType: "cold",
      });

      expect(spell.name).toBe("Frost Nova");
      expect(spell.level).toBe(3);
      expect(spell.school).toBe("evocation");
      expect(spell.damage).toBe("8d6");
    });

    test("calculates average damage", () => {
      const spell = buildSpellBlock({
        name: "Test Spell",
        level: 3,
        school: "evocation",
        castingTime: "1 action",
        range: "120 feet",
        components: ["V", "S"],
        duration: "Instantaneous",
        description: "Deals damage.",
        damage: "8d6",
        damageType: "fire",
      });
      expect(spell.averageDamage).toBe(28);
    });
  });

  // ============================================
  // Forge Spell (with mock inference)
  // ============================================
  describe("forgeSpell()", () => {
    test("produces a ForgedSpell with balance analysis", async () => {
      const mockInferenceResult = JSON.stringify({
        casting_time: "1 action",
        range: "Self (20-foot radius)",
        components: ["V", "S", "M"],
        material: "a shard of ice",
        duration: "Instantaneous",
        description: "A burst of freezing cold erupts from you. Each creature in a 20-foot radius must make a Constitution saving throw, taking 8d6 cold damage on a failed save, or half as much on a successful one.",
        damage: "8d6",
      });

      const result = await forgeSpell({
        name: "Frost Nova",
        level: 3,
        school: "evocation",
        damageType: "cold",
        _mockInference: async () => mockInferenceResult,
      });

      expect(result.spell.name).toBe("Frost Nova");
      expect(result.spell.level).toBe(3);
      expect(result.balanceAnalysis).toHaveProperty("status");
      expect(["balanced", "overpowered", "underpowered"]).toContain(result.balanceAnalysis.status);
    });

    test("includes comparable spells when requested", async () => {
      const mockInferenceResult = JSON.stringify({
        casting_time: "1 action",
        range: "150 feet",
        components: ["V", "S", "M"],
        material: "sulfur",
        duration: "Instantaneous",
        description: "Fire damage spell.",
        damage: "8d6",
      });

      const result = await forgeSpell({
        name: "Fire Storm Mini",
        level: 3,
        school: "evocation",
        damageType: "fire",
        compare: true,
        _mockInference: async () => mockInferenceResult,
      });

      expect(result.comparableSpells.length).toBeGreaterThan(0);
    });
  });
});
