import { describe, test, expect } from "bun:test";
import {
  buildArtPrompt,
  buildTokenPrompt,
  getOutputPath,
  parseMonsterFile,
  type MonsterArtOptions,
} from "../MonsterArt";

describe("MonsterArt", () => {
  // ============================================
  // Prompt Construction
  // ============================================
  describe("buildArtPrompt()", () => {
    test("constructs prompt from basic monster attributes", () => {
      const opts: MonsterArtOptions = {
        name: "Thornback",
        type: "beast",
        cr: 5,
        style: "dark fantasy",
      };
      const prompt = buildArtPrompt(opts);
      expect(prompt).toContain("Thornback");
      expect(prompt).toContain("beast");
      expect(prompt).toContain("dark fantasy");
    });

    test("includes CR-based power level descriptors", () => {
      const lowCR = buildArtPrompt({ name: "Rat", type: "beast", cr: 0.25 });
      const highCR = buildArtPrompt({ name: "Lich", type: "undead", cr: 21 });
      // Low CR should suggest small/weak, high CR should suggest powerful/legendary
      expect(lowCR.toLowerCase()).toContain("small");
      expect(highCR.toLowerCase()).toContain("legendary");
    });

    test("includes size when provided", () => {
      const prompt = buildArtPrompt({
        name: "Hill Giant",
        type: "giant",
        cr: 5,
        size: "Huge",
      });
      expect(prompt).toContain("Huge");
    });

    test("includes environment when provided", () => {
      const prompt = buildArtPrompt({
        name: "Reef Lurker",
        type: "aberration",
        cr: 3,
        environment: "underwater",
      });
      expect(prompt).toContain("underwater");
    });

    test("includes description when provided", () => {
      const prompt = buildArtPrompt({
        name: "Thornback",
        type: "beast",
        cr: 5,
        description: "A massive turtle with thorny shell plates",
      });
      expect(prompt).toContain("thorny shell plates");
    });

    test("defaults to 'dark fantasy' style when none provided", () => {
      const prompt = buildArtPrompt({ name: "Goblin", type: "humanoid", cr: 0.25 });
      expect(prompt.toLowerCase()).toContain("fantasy");
    });
  });

  // ============================================
  // Token Prompt
  // ============================================
  describe("buildTokenPrompt()", () => {
    test("adds circular token framing to prompt", () => {
      const prompt = buildTokenPrompt({ name: "Goblin", type: "humanoid", cr: 0.25 });
      expect(prompt.toLowerCase()).toContain("circular");
      expect(prompt.toLowerCase()).toContain("token");
    });

    test("includes transparent background instruction", () => {
      const prompt = buildTokenPrompt({ name: "Goblin", type: "humanoid", cr: 0.25 });
      expect(prompt.toLowerCase()).toContain("transparent");
    });
  });

  // ============================================
  // Output Path Generation
  // ============================================
  describe("getOutputPath()", () => {
    test("generates path in ~/Downloads/dnd-art/ directory", () => {
      const path = getOutputPath("Thornback", false);
      expect(path).toContain("Downloads/dnd-art/");
    });

    test("generates descriptive filename from monster name", () => {
      const path = getOutputPath("Adult Red Dragon", false);
      expect(path).toContain("adult-red-dragon");
      expect(path).toEndWith(".png");
    });

    test("adds -token suffix for token images", () => {
      const path = getOutputPath("Goblin", true);
      expect(path).toContain("goblin-token");
    });

    test("handles special characters in name", () => {
      const path = getOutputPath("Thorn'back the Destroyer", false);
      expect(path).not.toContain("'");
      expect(path).toContain("thornback");
    });
  });

  // ============================================
  // Monster File Parsing
  // ============================================
  describe("parseMonsterFile()", () => {
    test("extracts art-relevant fields from monster JSON", () => {
      const monsterJson = {
        name: "Thornback",
        size: "Large",
        type: "beast",
        cr: 5,
        alignment: "unaligned",
        traits: [{ name: "Thorny Hide", description: "Covered in sharp thorns" }],
      };
      const opts = parseMonsterFile(monsterJson);
      expect(opts.name).toBe("Thornback");
      expect(opts.type).toBe("beast");
      expect(opts.cr).toBe(5);
      expect(opts.size).toBe("Large");
    });

    test("builds description from traits when available", () => {
      const monsterJson = {
        name: "Flame Maw",
        type: "elemental",
        cr: 7,
        traits: [
          { name: "Fire Aura", description: "Wreathed in magical flames" },
          { name: "Molten Core", description: "Its body glows with inner fire" },
        ],
      };
      const opts = parseMonsterFile(monsterJson);
      expect(opts.description).toContain("flames");
    });
  });
});
