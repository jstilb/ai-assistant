import { describe, test, expect } from "bun:test";
import {
  exportFoundryEncounter,
  exportRoll20Encounter,
  resolveEncounterMonsters,
  type EncounterExportInput,
  type FoundryEncounterExport,
  type Roll20EncounterExport,
} from "../VTTExporter";

// Sample encounter data as would come from EncounterBalancer
const sampleEncounter: EncounterExportInput = {
  difficulty: "hard",
  totalXP: 400,
  adjustedXP: 600,
  budget: {
    easy: 300,
    medium: 600,
    hard: 900,
    deadly: 1400,
    partyLevel: 3,
    partySize: 4,
  },
  monsters: [
    { name: "Goblin", cr: 0.25, xp: 50, count: 4 },
    { name: "Giant Spider", cr: 1, xp: 200, count: 1 },
  ],
};

describe("VTTExporter", () => {
  // ============================================
  // Monster Resolution
  // ============================================
  describe("resolveEncounterMonsters()", () => {
    test("resolves SRD monster names to full stat blocks", () => {
      const resolved = resolveEncounterMonsters(sampleEncounter.monsters);
      expect(resolved.length).toBe(2);
      expect(resolved[0].name).toBe("Goblin");
      expect(resolved[0].statBlock).toBeDefined();
      expect(resolved[0].statBlock.hp).toBeGreaterThan(0);
    });

    test("includes count for each monster group", () => {
      const resolved = resolveEncounterMonsters(sampleEncounter.monsters);
      expect(resolved[0].count).toBe(4);
      expect(resolved[1].count).toBe(1);
    });

    test("handles unknown monsters gracefully", () => {
      const monsters = [{ name: "CustomCreature", cr: 3, xp: 700, count: 1 }];
      const resolved = resolveEncounterMonsters(monsters);
      expect(resolved.length).toBe(1);
      // Should still return an entry even if not in SRD
      expect(resolved[0].name).toBe("CustomCreature");
    });
  });

  // ============================================
  // Foundry VTT Export
  // ============================================
  describe("exportFoundryEncounter()", () => {
    test("returns a valid Foundry encounter export", () => {
      const result = exportFoundryEncounter(sampleEncounter);
      expect(result).toHaveProperty("actors");
      expect(result).toHaveProperty("encounter");
      expect(Array.isArray(result.actors)).toBe(true);
    });

    test("includes all monster groups as actors", () => {
      const result = exportFoundryEncounter(sampleEncounter);
      // Should have actors for Goblin and Giant Spider
      expect(result.actors.length).toBe(2);
    });

    test("actors have Foundry VTT structure", () => {
      const result = exportFoundryEncounter(sampleEncounter);
      for (const actor of result.actors) {
        expect(actor).toHaveProperty("name");
        expect(actor).toHaveProperty("type");
        expect(actor.type).toBe("npc");
        expect(actor).toHaveProperty("system");
      }
    });

    test("includes encounter metadata", () => {
      const result = exportFoundryEncounter(sampleEncounter);
      expect(result.encounter).toHaveProperty("difficulty");
      expect(result.encounter.difficulty).toBe("hard");
      expect(result.encounter).toHaveProperty("totalXP");
      expect(result.encounter).toHaveProperty("adjustedXP");
    });

    test("includes token counts per monster type", () => {
      const result = exportFoundryEncounter(sampleEncounter);
      const goblinActor = result.actors.find((a: any) => a.name === "Goblin");
      expect(goblinActor).toBeDefined();
      expect(goblinActor!.tokenCount).toBe(4);
    });
  });

  // ============================================
  // Roll20 Export
  // ============================================
  describe("exportRoll20Encounter()", () => {
    test("returns Roll20 formatted encounter text", () => {
      const result = exportRoll20Encounter(sampleEncounter);
      expect(typeof result).toBe("string");
      expect(result.length).toBeGreaterThan(0);
    });

    test("includes encounter difficulty header", () => {
      const result = exportRoll20Encounter(sampleEncounter);
      expect(result.toLowerCase()).toContain("hard");
    });

    test("includes all monster stat blocks", () => {
      const result = exportRoll20Encounter(sampleEncounter);
      expect(result).toContain("Goblin");
      expect(result).toContain("Giant Spider");
    });

    test("includes monster counts", () => {
      const result = exportRoll20Encounter(sampleEncounter);
      expect(result).toContain("4"); // 4 goblins
    });

    test("includes XP information", () => {
      const result = exportRoll20Encounter(sampleEncounter);
      expect(result).toContain("400"); // Total XP
    });
  });
});
