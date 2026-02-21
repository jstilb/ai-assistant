import { describe, test, expect } from "bun:test";
import {
  validateMonster,
  validateSpell,
  validateItem,
  type ValidationResult,
  type MonsterValidationInput,
  type SpellValidationInput,
  type ItemValidationInput,
} from "../HomebrewValidator";

describe("HomebrewValidator", () => {
  // ============================================
  // Monster Validation
  // ============================================
  describe("validateMonster()", () => {
    test("balanced CR-5 monster passes validation", () => {
      const monster: MonsterValidationInput = {
        name: "Forest Guardian",
        cr: 5,
        hp: 136,
        ac: 15,
        attackBonus: 6,
        dpr: 35,
        saveDC: 15,
      };
      const result = validateMonster(monster);
      expect(result.status).toBe("balanced");
      expect(result.flags.length).toBe(0);
    });

    test("CR-5 monster with CR-15 HP is flagged as overpowered", () => {
      const monster: MonsterValidationInput = {
        name: "Overpowered Beast",
        cr: 5,
        hp: 290, // CR 15 range (281-295)
        ac: 15,
        attackBonus: 6,
        dpr: 35,
        saveDC: 15,
      };
      const result = validateMonster(monster);
      expect(result.status).toBe("overpowered");
      expect(result.flags.length).toBeGreaterThan(0);
      expect(result.flags.some((f) => f.field === "hp")).toBe(true);
    });

    test("CR-5 monster with very low HP is flagged as underpowered", () => {
      const monster: MonsterValidationInput = {
        name: "Glass Cannon",
        cr: 5,
        hp: 20, // Way below CR 5 range (131-145)
        ac: 15,
        attackBonus: 6,
        dpr: 35,
        saveDC: 15,
      };
      const result = validateMonster(monster);
      expect(result.status).toBe("underpowered");
      expect(result.flags.some((f) => f.field === "hp")).toBe(true);
    });

    test("CR-5 monster with extremely high AC is flagged", () => {
      const monster: MonsterValidationInput = {
        name: "Iron Shell",
        cr: 5,
        hp: 136,
        ac: 22, // Expected AC for CR 5 is 15; 22 is way over
        attackBonus: 6,
        dpr: 35,
        saveDC: 15,
      };
      const result = validateMonster(monster);
      expect(result.flags.some((f) => f.field === "ac")).toBe(true);
    });

    test("CR-5 monster with extremely high DPR is flagged as overpowered", () => {
      const monster: MonsterValidationInput = {
        name: "Death Dealer",
        cr: 5,
        hp: 136,
        ac: 15,
        attackBonus: 6,
        dpr: 100, // CR 15+ DPR range
        saveDC: 15,
      };
      const result = validateMonster(monster);
      expect(result.status).toBe("overpowered");
      expect(result.flags.some((f) => f.field === "dpr")).toBe(true);
    });

    test("result includes suggested adjustments", () => {
      const monster: MonsterValidationInput = {
        name: "Overpowered Beast",
        cr: 5,
        hp: 290,
        ac: 22,
        attackBonus: 12,
        dpr: 100,
        saveDC: 20,
      };
      const result = validateMonster(monster);
      expect(result.suggestions.length).toBeGreaterThan(0);
      // Should suggest reducing HP toward CR 5 range
      expect(result.suggestions.some((s) => s.toLowerCase().includes("hp"))).toBe(true);
    });

    test("result has required structure", () => {
      const monster: MonsterValidationInput = {
        name: "Test Monster",
        cr: 1,
        hp: 75,
        ac: 13,
        attackBonus: 3,
        dpr: 10,
        saveDC: 13,
      };
      const result = validateMonster(monster);
      expect(result).toHaveProperty("status");
      expect(result).toHaveProperty("flags");
      expect(result).toHaveProperty("suggestions");
      expect(["balanced", "overpowered", "underpowered"]).toContain(result.status);
      expect(Array.isArray(result.flags)).toBe(true);
      expect(Array.isArray(result.suggestions)).toBe(true);
    });
  });

  // ============================================
  // Spell Validation
  // ============================================
  describe("validateSpell()", () => {
    test("level-3 spell with 8d6 damage is balanced (comparable to Fireball)", () => {
      const spell: SpellValidationInput = {
        name: "Frost Nova",
        level: 3,
        school: "evocation",
        damage: "8d6",
        damageType: "cold",
        range: "150 feet",
        area: "20-foot radius",
      };
      const result = validateSpell(spell);
      expect(result.status).toBe("balanced");
    });

    test("level-1 spell with 8d6 damage is overpowered", () => {
      const spell: SpellValidationInput = {
        name: "Mega Blast",
        level: 1,
        school: "evocation",
        damage: "8d6",
        damageType: "fire",
        range: "120 feet",
      };
      const result = validateSpell(spell);
      expect(result.status).toBe("overpowered");
    });

    test("level-5 spell with 1d4 damage is underpowered", () => {
      const spell: SpellValidationInput = {
        name: "Weak Zap",
        level: 5,
        school: "evocation",
        damage: "1d4",
        damageType: "lightning",
        range: "60 feet",
      };
      const result = validateSpell(spell);
      expect(result.status).toBe("underpowered");
    });

    test("includes comparable SRD spells in result", () => {
      const spell: SpellValidationInput = {
        name: "Custom Spell",
        level: 3,
        school: "evocation",
        damage: "8d6",
        damageType: "fire",
        range: "150 feet",
      };
      const result = validateSpell(spell);
      expect(result.comparableSpells.length).toBeGreaterThan(0);
    });
  });

  // ============================================
  // Item Validation
  // ============================================
  describe("validateItem()", () => {
    test("uncommon item with +1 bonus is balanced", () => {
      const item: ItemValidationInput = {
        name: "Sword of Frost",
        type: "Weapon",
        rarity: "uncommon",
        properties: ["+1 to attack and damage"],
      };
      const result = validateItem(item);
      expect(result.status).toBe("balanced");
    });

    test("common item with legendary-tier properties is overpowered", () => {
      const item: ItemValidationInput = {
        name: "Peasant Ring",
        type: "Ring",
        rarity: "common",
        properties: ["+3 to attack and damage", "grants truesight 120 ft"],
      };
      const result = validateItem(item);
      expect(result.status).toBe("overpowered");
    });

    test("result includes rarity comparison", () => {
      const item: ItemValidationInput = {
        name: "Test Shield",
        type: "Armor (shield)",
        rarity: "uncommon",
        properties: ["+1 to AC"],
      };
      const result = validateItem(item);
      expect(result).toHaveProperty("status");
      expect(result).toHaveProperty("flags");
      expect(result).toHaveProperty("suggestions");
    });
  });
});
