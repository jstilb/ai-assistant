import { describe, test, expect } from "bun:test";
import {
  rollDice,
  parseDiceNotation,
  generateIndividualTreasure,
  generateHoardTreasure,
  rollOnMagicItemTable,
  getCRTier,
  type TreasureResult,
} from "../LootGenerator";

describe("LootGenerator", () => {
  // ============================================
  // Dice Rolling
  // ============================================
  describe("rollDice()", () => {
    test("rolls a single die within valid range", () => {
      for (let i = 0; i < 50; i++) {
        const result = rollDice("1d6");
        expect(result).toBeGreaterThanOrEqual(1);
        expect(result).toBeLessThanOrEqual(6);
      }
    });

    test("rolls multiple dice within valid range", () => {
      for (let i = 0; i < 50; i++) {
        const result = rollDice("3d8");
        expect(result).toBeGreaterThanOrEqual(3);
        expect(result).toBeLessThanOrEqual(24);
      }
    });

    test("handles modifier notation (2d6+5)", () => {
      for (let i = 0; i < 50; i++) {
        const result = rollDice("2d6+5");
        expect(result).toBeGreaterThanOrEqual(7);
        expect(result).toBeLessThanOrEqual(17);
      }
    });

    test("handles negative modifier (1d8-1)", () => {
      for (let i = 0; i < 50; i++) {
        const result = rollDice("1d8-1");
        expect(result).toBeGreaterThanOrEqual(0);
        expect(result).toBeLessThanOrEqual(7);
      }
    });

    test("handles d100 percentile dice", () => {
      for (let i = 0; i < 20; i++) {
        const result = rollDice("1d100");
        expect(result).toBeGreaterThanOrEqual(1);
        expect(result).toBeLessThanOrEqual(100);
      }
    });
  });

  describe("parseDiceNotation()", () => {
    test("parses multiplier notation (4d6x100)", () => {
      const parsed = parseDiceNotation("4d6x100");
      expect(parsed).toEqual({ count: 4, sides: 6, modifier: 0, multiplier: 100 });
    });

    test("parses simple notation (2d6)", () => {
      const parsed = parseDiceNotation("2d6");
      expect(parsed).toEqual({ count: 2, sides: 6, modifier: 0, multiplier: 1 });
    });

    test("parses with modifier (1d8+3)", () => {
      const parsed = parseDiceNotation("1d8+3");
      expect(parsed).toEqual({ count: 1, sides: 8, modifier: 3, multiplier: 1 });
    });

    test("parses integer constant (1)", () => {
      const parsed = parseDiceNotation("1");
      expect(parsed).toEqual({ count: 0, sides: 0, modifier: 1, multiplier: 1 });
    });
  });

  // ============================================
  // CR Tier Mapping
  // ============================================
  describe("getCRTier()", () => {
    test("CR 0-4 maps to cr0_4 tier", () => {
      expect(getCRTier(0)).toBe("cr0_4");
      expect(getCRTier(3)).toBe("cr0_4");
      expect(getCRTier(4)).toBe("cr0_4");
    });

    test("CR 5-10 maps to cr5_10 tier", () => {
      expect(getCRTier(5)).toBe("cr5_10");
      expect(getCRTier(7)).toBe("cr5_10");
      expect(getCRTier(10)).toBe("cr5_10");
    });

    test("CR 11-16 maps to cr11_16 tier", () => {
      expect(getCRTier(11)).toBe("cr11_16");
      expect(getCRTier(16)).toBe("cr11_16");
    });

    test("CR 17+ maps to cr17_plus tier", () => {
      expect(getCRTier(17)).toBe("cr17_plus");
      expect(getCRTier(30)).toBe("cr17_plus");
    });
  });

  // ============================================
  // Individual Treasure
  // ============================================
  describe("generateIndividualTreasure()", () => {
    test("returns valid treasure result with coins", () => {
      const result = generateIndividualTreasure(3);
      expect(result).toHaveProperty("coins");
      expect(typeof result.coins).toBe("object");
      // Should have at least one coin type
      const totalCoins = Object.values(result.coins).reduce((a, b) => a + b, 0);
      expect(totalCoins).toBeGreaterThan(0);
    });

    test("CR 7 individual treasure has plausible coin amounts", () => {
      // CR 5-10 tier: coins should be in reasonable range
      const result = generateIndividualTreasure(7);
      const allValues = Object.values(result.coins);
      for (const v of allValues) {
        expect(v).toBeGreaterThanOrEqual(0);
      }
    });

    test("coins object only contains valid coin types", () => {
      const validTypes = ["cp", "sp", "ep", "gp", "pp"];
      const result = generateIndividualTreasure(2);
      for (const key of Object.keys(result.coins)) {
        expect(validTypes).toContain(key);
      }
    });
  });

  // ============================================
  // Hoard Treasure
  // ============================================
  describe("generateHoardTreasure()", () => {
    test("returns coins, gems/art, and potentially magic items", () => {
      const result = generateHoardTreasure(7);
      expect(result).toHaveProperty("coins");
      expect(typeof result.coins).toBe("object");
    });

    test("CR 0-4 hoard includes base coins (cp, sp, gp)", () => {
      const result = generateHoardTreasure(2);
      // Base coins for CR 0-4: 6d6x100 cp, 3d6x100 sp, 2d6x10 gp
      expect(result.coins.cp).toBeGreaterThan(0);
      expect(result.coins.sp).toBeGreaterThan(0);
      expect(result.coins.gp).toBeGreaterThan(0);
    });

    test("CR 5-10 hoard includes platinum", () => {
      const result = generateHoardTreasure(7);
      // CR 5-10 base: includes pp: 3d6x10
      expect(result.coins.pp).toBeGreaterThan(0);
    });
  });

  // ============================================
  // Magic Item Tables
  // ============================================
  describe("rollOnMagicItemTable()", () => {
    test("returns a string item name from table A", () => {
      const item = rollOnMagicItemTable("A");
      expect(typeof item).toBe("string");
      expect(item.length).toBeGreaterThan(0);
    });

    test("returns a string item name from table F", () => {
      const item = rollOnMagicItemTable("F");
      expect(typeof item).toBe("string");
      expect(item.length).toBeGreaterThan(0);
    });

    test("returns a string item name from table I", () => {
      const item = rollOnMagicItemTable("I");
      expect(typeof item).toBe("string");
      expect(item.length).toBeGreaterThan(0);
    });
  });
});
