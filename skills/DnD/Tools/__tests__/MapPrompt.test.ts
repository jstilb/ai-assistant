import { describe, test, expect } from "bun:test";
import {
  buildMapPrompt,
  getMapOutputPath,
  getTemplatesByType,
  fillTemplateFeatures,
  type MapPromptOptions,
} from "../MapPrompt";

describe("MapPrompt", () => {
  // ============================================
  // Template Loading
  // ============================================
  describe("getTemplatesByType()", () => {
    test("returns dungeon templates for 'dungeon' type", () => {
      const templates = getTemplatesByType("dungeon");
      expect(templates.length).toBeGreaterThan(0);
      for (const t of templates) {
        expect(t.type).toBe("dungeon");
      }
    });

    test("returns wilderness templates for 'battlemap' type", () => {
      const templates = getTemplatesByType("battlemap");
      expect(templates.length).toBeGreaterThan(0);
    });

    test("returns all templates for 'regional' type", () => {
      const templates = getTemplatesByType("regional");
      expect(templates.length).toBeGreaterThan(0);
    });

    test("returns all templates for 'world' type", () => {
      const templates = getTemplatesByType("world");
      expect(templates.length).toBeGreaterThan(0);
    });
  });

  // ============================================
  // Feature Filling
  // ============================================
  describe("fillTemplateFeatures()", () => {
    test("includes user-provided features in output", () => {
      const template = {
        id: "forest_clearing",
        name: "Forest Clearing",
        type: "wilderness",
        description: "A sunlit clearing",
        terrain: [],
      };
      const features = ["river", "bridge", "campfire"];
      const result = fillTemplateFeatures(template, features);
      expect(result).toContain("river");
      expect(result).toContain("bridge");
      expect(result).toContain("campfire");
    });

    test("includes template description in output", () => {
      const template = {
        id: "dungeon_entrance",
        name: "Dungeon Entrance Hall",
        type: "dungeon",
        description: "A grand entrance hall with crumbling pillars",
        terrain: [{ type: "stone_floor" }, { type: "pillar" }],
      };
      const result = fillTemplateFeatures(template, []);
      expect(result).toContain("entrance hall");
      expect(result).toContain("pillar");
    });
  });

  // ============================================
  // Prompt Construction
  // ============================================
  describe("buildMapPrompt()", () => {
    test("constructs a complete map prompt for a forest battlemap", () => {
      const opts: MapPromptOptions = {
        type: "battlemap",
        theme: "forest",
        features: ["river", "bridge", "campfire"],
      };
      const prompt = buildMapPrompt(opts);
      expect(prompt).toContain("forest");
      expect(prompt).toContain("river");
      expect(prompt).toContain("battle");
    });

    test("includes grid specification when provided", () => {
      const opts: MapPromptOptions = {
        type: "battlemap",
        theme: "cave",
        grid: 25,
      };
      const prompt = buildMapPrompt(opts);
      expect(prompt).toContain("grid");
    });

    test("constructs dungeon map prompt", () => {
      const opts: MapPromptOptions = {
        type: "dungeon",
        theme: "ancient ruins",
        features: ["traps", "treasure chest"],
      };
      const prompt = buildMapPrompt(opts);
      expect(prompt).toContain("dungeon");
      expect(prompt).toContain("ancient ruins");
    });

    test("constructs regional map prompt", () => {
      const opts: MapPromptOptions = {
        type: "regional",
        theme: "medieval kingdom",
        features: ["castle", "forest", "river"],
      };
      const prompt = buildMapPrompt(opts);
      expect(prompt).toContain("regional");
    });

    test("constructs world map prompt", () => {
      const opts: MapPromptOptions = {
        type: "world",
        theme: "high fantasy",
        features: ["continents", "ocean", "mountain range"],
      };
      const prompt = buildMapPrompt(opts);
      expect(prompt).toContain("world");
    });
  });

  // ============================================
  // Output Path Generation
  // ============================================
  describe("getMapOutputPath()", () => {
    test("generates path in ~/Downloads/dnd-maps/ directory", () => {
      const path = getMapOutputPath("battlemap", "forest");
      expect(path).toContain("Downloads/dnd-maps/");
    });

    test("includes type and theme in filename", () => {
      const path = getMapOutputPath("dungeon", "ancient-ruins");
      expect(path).toContain("dungeon");
      expect(path).toContain("ancient-ruins");
      expect(path).toEndWith(".png");
    });

    test("handles spaces in theme name", () => {
      const path = getMapOutputPath("battlemap", "dark forest");
      expect(path).toContain("dark-forest");
    });
  });
});
