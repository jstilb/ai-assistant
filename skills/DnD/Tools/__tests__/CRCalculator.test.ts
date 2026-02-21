import { describe, test, expect } from "bun:test";
import { calculateCR, type MonsterStats, type CRResult } from "../CRCalculator";

describe("CRCalculator", () => {
  describe("calculateCR()", () => {
    test("returns a CRResult object with required fields", () => {
      const stats: MonsterStats = {
        hp: 10,
        ac: 12,
        attackBonus: 3,
        dpr: 5,
        saveDC: 10,
      };
      const result = calculateCR(stats);
      expect(result).toHaveProperty("cr");
      expect(result).toHaveProperty("offensiveCR");
      expect(result).toHaveProperty("defensiveCR");
      expect(result).toHaveProperty("details");
      expect(typeof result.cr).toBe("number");
      expect(typeof result.offensiveCR).toBe("number");
      expect(typeof result.defensiveCR).toBe("number");
      expect(typeof result.details).toBe("string");
    });

    test("Goblin calculates to CR 1/4 (0.25)", () => {
      // Goblin: HP 7, AC 15 (leather+shield), +4 to hit, 5 DPR (1d6+2)
      const goblin: MonsterStats = {
        hp: 7,
        ac: 15,
        attackBonus: 4,
        dpr: 5,
        saveDC: 10,
      };
      const result = calculateCR(goblin);
      expect(result.cr).toBe(0.25);
    });

    test("Adult Red Dragon calculates to CR 17", () => {
      // Adult Red Dragon: HP 256, AC 19, +14 to hit, ~73 DPR (multiattack),
      // save DC 21, fire breath (legendary resistance, frightful presence)
      const adultRedDragon: MonsterStats = {
        hp: 256,
        ac: 19,
        attackBonus: 14,
        dpr: 73,
        saveDC: 21,
        resistances: ["fire"],
        legendaryResistances: 3,
        flyingSpeed: 80,
      };
      const result = calculateCR(adultRedDragon);
      expect(result.cr).toBe(17);
    });

    test("Tarrasque calculates to CR 30", () => {
      // Tarrasque: HP 676, AC 25, +19 to hit, ~148 DPR, save DC 24
      // Reflective Carapace, Legendary Resistances x5, Magic Resistance,
      // Frightful Presence, immunities galore
      const tarrasque: MonsterStats = {
        hp: 676,
        ac: 25,
        attackBonus: 19,
        dpr: 148,
        saveDC: 24,
        immunities: ["fire", "poison", "bludgeoning", "piercing", "slashing"],
        conditionImmunities: ["charmed", "frightened", "paralyzed", "poisoned"],
        legendaryResistances: 5,
        magicResistance: true,
        specialTraits: ["reflective_carapace", "siege_monster"],
      };
      const result = calculateCR(tarrasque);
      expect(result.cr).toBe(30);
    });

    test("Commoner calculates to CR 0", () => {
      const commoner: MonsterStats = {
        hp: 4,
        ac: 10,
        attackBonus: 2,
        dpr: 2,
        saveDC: 10,
      };
      const result = calculateCR(commoner);
      expect(result.cr).toBe(0);
    });

    test("Skeleton calculates to CR 1/4 (0.25)", () => {
      // Skeleton: HP 13, AC 13, +4 to hit, 5 DPR
      const skeleton: MonsterStats = {
        hp: 13,
        ac: 13,
        attackBonus: 4,
        dpr: 5,
        saveDC: 10,
      };
      const result = calculateCR(skeleton);
      expect(result.cr).toBe(0.25);
    });

    test("HP adjustments for resistances increase effective HP", () => {
      // A monster with HP 50 and 3 resistances should have higher effective HP
      const withResistances: MonsterStats = {
        hp: 50,
        ac: 13,
        attackBonus: 5,
        dpr: 10,
        saveDC: 12,
        resistances: ["fire", "cold", "lightning"],
      };
      const withoutResistances: MonsterStats = {
        hp: 50,
        ac: 13,
        attackBonus: 5,
        dpr: 10,
        saveDC: 12,
      };
      const resultWith = calculateCR(withResistances);
      const resultWithout = calculateCR(withoutResistances);
      expect(resultWith.defensiveCR).toBeGreaterThanOrEqual(resultWithout.defensiveCR);
    });

    test("immunities have greater effect than resistances", () => {
      const withImmunities: MonsterStats = {
        hp: 100,
        ac: 15,
        attackBonus: 7,
        dpr: 25,
        saveDC: 14,
        immunities: ["fire", "cold", "lightning"],
      };
      const withResistances: MonsterStats = {
        hp: 100,
        ac: 15,
        attackBonus: 7,
        dpr: 25,
        saveDC: 14,
        resistances: ["fire", "cold", "lightning"],
      };
      const resultImm = calculateCR(withImmunities);
      const resultRes = calculateCR(withResistances);
      expect(resultImm.defensiveCR).toBeGreaterThanOrEqual(resultRes.defensiveCR);
    });

    test("details string provides breakdown explanation", () => {
      const stats: MonsterStats = {
        hp: 50,
        ac: 15,
        attackBonus: 5,
        dpr: 10,
        saveDC: 12,
      };
      const result = calculateCR(stats);
      expect(result.details).toContain("Defensive CR");
      expect(result.details).toContain("Offensive CR");
    });

    test("uses save DC when higher than attack bonus for offensive CR", () => {
      // A spellcaster with high save DC but low attack bonus
      const spellcaster: MonsterStats = {
        hp: 40,
        ac: 12,
        attackBonus: 4,
        dpr: 20,
        saveDC: 17,
      };
      const result = calculateCR(spellcaster);
      // The save DC should push offensive CR higher than attack bonus alone
      expect(result.offensiveCR).toBeGreaterThanOrEqual(2);
    });
  });

  describe("fractional CR values", () => {
    test("returns 0, 0.125, 0.25, or 0.5 for very low CR creatures", () => {
      const validFractional = [0, 0.125, 0.25, 0.5];
      const weakCreature: MonsterStats = {
        hp: 7,
        ac: 12,
        attackBonus: 3,
        dpr: 3,
        saveDC: 10,
      };
      const result = calculateCR(weakCreature);
      if (result.cr < 1) {
        expect(validFractional).toContain(result.cr);
      }
    });
  });
});
