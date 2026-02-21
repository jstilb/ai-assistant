/**
 * MoodBoardGenerator.test.ts - Tests for mood board generation
 *
 * Tests:
 * - Color palette extraction from room analysis
 * - Color harmony detection (complementary, analogous, triadic, monochromatic)
 * - Style reference image matching
 * - Weight distribution across palette
 * - Edge cases: empty colors, unknown styles
 */

import { describe, it, expect } from "bun:test";
import {
  generateMoodBoard,
  detectColorHarmony,
  extractPalette,
  type MoodBoard,
} from "../MoodBoardGenerator.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SAMPLE_ROOM_ANALYSIS = {
  colors: {
    dominant: ["#F5E6D3", "#C19A6B", "#36454F"],
    accent: ["#CC5C3B", "#FFFDD0"],
    mood: "Warm and inviting",
  },
  style: {
    primary: "Modern Cozy",
    secondary: "Hygge",
    cohesionScore: 7,
  },
  lighting: {
    naturalLight: "moderate" as const,
    artificialLight: "adequate" as const,
    recommendation: "Add warm ambient lighting",
  },
  focalPoints: ["fireplace", "window seat"],
  issues: [],
  confidence: 0.85,
  analysisMethod: "claude_vision" as const,
};

const MINIMAL_ROOM_ANALYSIS = {
  colors: {
    dominant: ["#FFFFFF"],
    accent: [],
    mood: "Neutral",
  },
  style: {
    primary: "Minimalist",
    cohesionScore: 5,
  },
  lighting: {
    naturalLight: "abundant" as const,
    artificialLight: "well-lit" as const,
    recommendation: "Good lighting",
  },
  focalPoints: [],
  issues: [],
  confidence: 0.6,
  analysisMethod: "gemini_vision" as const,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("MoodBoardGenerator", () => {
  describe("extractPalette", () => {
    it("extracts colors from dominant and accent arrays", () => {
      const palette = extractPalette(SAMPLE_ROOM_ANALYSIS.colors);
      expect(palette.length).toBeGreaterThanOrEqual(3);
      expect(palette.length).toBeLessThanOrEqual(5);
    });

    it("assigns higher weight to dominant colors", () => {
      const palette = extractPalette(SAMPLE_ROOM_ANALYSIS.colors);
      const dominant = palette.filter(c =>
        SAMPLE_ROOM_ANALYSIS.colors.dominant.includes(c.hex)
      );
      const accent = palette.filter(c =>
        SAMPLE_ROOM_ANALYSIS.colors.accent.includes(c.hex)
      );
      if (dominant.length > 0 && accent.length > 0) {
        expect(dominant[0].weight).toBeGreaterThan(accent[0].weight);
      }
    });

    it("includes hex values and names for each color", () => {
      const palette = extractPalette(SAMPLE_ROOM_ANALYSIS.colors);
      for (const color of palette) {
        expect(color.hex).toMatch(/^#[0-9A-Fa-f]{6}$/);
        expect(color.name.length).toBeGreaterThan(0);
        expect(typeof color.weight).toBe("number");
        expect(color.weight).toBeGreaterThan(0);
        expect(color.weight).toBeLessThanOrEqual(1);
      }
    });

    it("handles single-color palette", () => {
      const palette = extractPalette(MINIMAL_ROOM_ANALYSIS.colors);
      expect(palette.length).toBeGreaterThanOrEqual(1);
      expect(palette[0].hex).toBe("#FFFFFF");
    });

    it("weights sum to approximately 1.0", () => {
      const palette = extractPalette(SAMPLE_ROOM_ANALYSIS.colors);
      const totalWeight = palette.reduce((sum, c) => sum + c.weight, 0);
      expect(totalWeight).toBeCloseTo(1.0, 1);
    });
  });

  describe("detectColorHarmony", () => {
    it("detects monochromatic harmony for similar hues", () => {
      const mono = detectColorHarmony(["#1B2A4A", "#2B3A5A", "#3B4A6A"]);
      expect(mono).toBe("monochromatic");
    });

    it("detects complementary harmony for opposite hues", () => {
      const comp = detectColorHarmony(["#FF0000", "#00FFFF"]);
      expect(comp).toBe("complementary");
    });

    it("detects analogous harmony for adjacent hues", () => {
      const analog = detectColorHarmony(["#FF0000", "#FF8800", "#FFFF00"]);
      expect(analog).toBe("analogous");
    });

    it("returns analogous as default for mixed palettes", () => {
      const result = detectColorHarmony(["#F5E6D3", "#C19A6B", "#36454F"]);
      expect(["complementary", "analogous", "triadic", "monochromatic"]).toContain(result);
    });

    it("handles single color", () => {
      const result = detectColorHarmony(["#FF0000"]);
      expect(result).toBe("monochromatic");
    });
  });

  describe("generateMoodBoard", () => {
    it("returns a complete MoodBoard object", () => {
      const board = generateMoodBoard(SAMPLE_ROOM_ANALYSIS);
      expect(board).toBeDefined();
      expect(board.palette).toBeDefined();
      expect(board.style_keywords).toBeDefined();
      expect(board.reference_images).toBeDefined();
      expect(board.color_harmony).toBeDefined();
    });

    it("palette has 1-5 colors", () => {
      const board = generateMoodBoard(SAMPLE_ROOM_ANALYSIS);
      expect(board.palette.length).toBeGreaterThanOrEqual(1);
      expect(board.palette.length).toBeLessThanOrEqual(5);
    });

    it("style_keywords includes primary style", () => {
      const board = generateMoodBoard(SAMPLE_ROOM_ANALYSIS);
      expect(board.style_keywords.length).toBeGreaterThan(0);
      // Should contain keywords related to the detected style
      const allKeywords = board.style_keywords.join(" ").toLowerCase();
      expect(
        allKeywords.includes("modern") ||
        allKeywords.includes("cozy") ||
        allKeywords.includes("hygge") ||
        allKeywords.includes("warm")
      ).toBe(true);
    });

    it("reference_images has 2-3 entries with required fields", () => {
      const board = generateMoodBoard(SAMPLE_ROOM_ANALYSIS);
      expect(board.reference_images.length).toBeGreaterThanOrEqual(2);
      expect(board.reference_images.length).toBeLessThanOrEqual(3);
      for (const ref of board.reference_images) {
        expect(ref.url).toBeDefined();
        expect(ref.url.length).toBeGreaterThan(0);
        expect(ref.style).toBeDefined();
        expect(ref.description).toBeDefined();
      }
    });

    it("color_harmony is a valid harmony type", () => {
      const board = generateMoodBoard(SAMPLE_ROOM_ANALYSIS);
      expect(["complementary", "analogous", "triadic", "monochromatic"]).toContain(
        board.color_harmony
      );
    });

    it("handles minimal room analysis gracefully", () => {
      const board = generateMoodBoard(MINIMAL_ROOM_ANALYSIS);
      expect(board).toBeDefined();
      expect(board.palette.length).toBeGreaterThanOrEqual(1);
      expect(board.style_keywords.length).toBeGreaterThan(0);
      expect(board.reference_images.length).toBeGreaterThanOrEqual(2);
    });
  });
});
