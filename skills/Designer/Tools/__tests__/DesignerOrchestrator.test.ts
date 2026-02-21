/**
 * DesignerOrchestrator.test.ts - Tests for main pipeline orchestrator
 *
 * Tests:
 * - Full pipeline execution (sequential + parallel)
 * - Error handling (partial failures)
 * - Timing/duration logging
 * - Result aggregation
 *
 * Uses mocked dependencies to avoid real API calls.
 */

import { describe, it, expect, mock, beforeEach } from "bun:test";
import {
  createDesignerOrchestrator,
  type OrchestratorResult,
  type OrchestratorDeps,
  type PipelineTimings,
} from "../DesignerOrchestrator.ts";

// ---------------------------------------------------------------------------
// Mock dependencies
// ---------------------------------------------------------------------------

const MOCK_ROOM_ANALYSIS = {
  dimensions: { estimatedWidth: "14ft", estimatedLength: "18ft" },
  lighting: {
    naturalLight: "moderate" as const,
    artificialLight: "adequate" as const,
    recommendation: "Add warm ambient lighting",
  },
  colors: {
    dominant: ["#F5E6D3", "#C19A6B", "#36454F"],
    accent: ["#CC5C3B"],
    mood: "Warm and inviting",
  },
  style: {
    primary: "Modern Cozy",
    secondary: "Hygge",
    cohesionScore: 7,
  },
  focalPoints: ["fireplace"],
  issues: [],
  improvements: [],
  confidence: 0.85,
  analysisMethod: "claude_vision" as const,
};

const MOCK_FURNITURE_RESULTS = [
  { name: "Floor Lamp", price: 150, retailer: "West Elm", styleMatchScore: 0.8, searchMethod: "curated_db" as const },
  { name: "Throw Pillow", price: 35, retailer: "Target", styleMatchScore: 0.7, searchMethod: "curated_db" as const },
];

const MOCK_MOOD_BOARD = {
  palette: [
    { name: "Warm Linen", hex: "#F5E6D3", weight: 0.4 },
    { name: "Camel", hex: "#C19A6B", weight: 0.35 },
    { name: "Charcoal", hex: "#36454F", weight: 0.25 },
  ],
  style_keywords: ["modern", "cozy", "warm"],
  reference_images: [
    { url: "https://example.com/ref1.jpg", style: "Modern Cozy", description: "Living room" },
    { url: "https://example.com/ref2.jpg", style: "Hygge", description: "Reading nook" },
  ],
  color_harmony: "analogous" as const,
};

const MOCK_BUDGET_RESULT = {
  total_cost: 185,
  budget_limit: 2000,
  budget_status: "under" as const,
  currency: "USD",
  per_category: [
    { category: "lighting", top_pick_cost: 150, exceeds_budget: false },
    { category: "textiles", top_pick_cost: 35, exceeds_budget: false },
  ],
};

function createMockDeps(overrides?: Partial<OrchestratorDeps>): OrchestratorDeps {
  return {
    analyzeRoom: mock(async () => MOCK_ROOM_ANALYSIS),
    searchFurniture: mock(async () => MOCK_FURNITURE_RESULTS),
    generateMoodBoard: mock(() => MOCK_MOOD_BOARD),
    calculateBudget: mock(() => MOCK_BUDGET_RESULT),
    formatOutput: mock((data: unknown) => JSON.stringify(data, null, 2)),
    loadConfig: mock(() => ({
      aesthetic: { primary: "cozy", secondary: "warm", descriptors: [] },
      colors: { love: [], avoid: [], accentPreference: "" },
      budget: "moderate" as const,
      avoidStyles: [],
      rooms: [],
      goals: [],
    })),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("DesignerOrchestrator", () => {
  describe("full pipeline", () => {
    it("executes the complete pipeline and returns an OrchestratorResult", async () => {
      const deps = createMockDeps();
      const orchestrator = createDesignerOrchestrator(deps);

      const result = await orchestrator.run({
        imagePath: "/tmp/test-room.jpg",
        budget: 2000,
      });

      expect(result).toBeDefined();
      expect(result.success).toBe(true);
      expect(result.roomAnalysis).toBeDefined();
      expect(result.furnitureResults).toBeDefined();
      expect(result.moodBoard).toBeDefined();
      expect(result.budgetResult).toBeDefined();
    });

    it("calls analyzeRoom in sequential phase", async () => {
      const deps = createMockDeps();
      const orchestrator = createDesignerOrchestrator(deps);

      await orchestrator.run({ imagePath: "/tmp/test.jpg" });
      expect(deps.analyzeRoom).toHaveBeenCalled();
    });

    it("calls searchFurniture and generateMoodBoard in parallel phase", async () => {
      const deps = createMockDeps();
      const orchestrator = createDesignerOrchestrator(deps);

      await orchestrator.run({ imagePath: "/tmp/test.jpg" });
      expect(deps.searchFurniture).toHaveBeenCalled();
      expect(deps.generateMoodBoard).toHaveBeenCalled();
    });

    it("calls calculateBudget with furniture results", async () => {
      const deps = createMockDeps();
      const orchestrator = createDesignerOrchestrator(deps);

      await orchestrator.run({ imagePath: "/tmp/test.jpg", budget: 2000 });
      expect(deps.calculateBudget).toHaveBeenCalled();
    });
  });

  describe("sequential then parallel execution order", () => {
    it("runs vision analysis before furniture search", async () => {
      const callOrder: string[] = [];

      const deps = createMockDeps({
        analyzeRoom: mock(async () => {
          callOrder.push("analyzeRoom");
          return MOCK_ROOM_ANALYSIS;
        }),
        searchFurniture: mock(async () => {
          callOrder.push("searchFurniture");
          return MOCK_FURNITURE_RESULTS;
        }),
        generateMoodBoard: mock(() => {
          callOrder.push("generateMoodBoard");
          return MOCK_MOOD_BOARD;
        }),
      });

      const orchestrator = createDesignerOrchestrator(deps);
      await orchestrator.run({ imagePath: "/tmp/test.jpg" });

      const analyzeIdx = callOrder.indexOf("analyzeRoom");
      const searchIdx = callOrder.indexOf("searchFurniture");
      const moodIdx = callOrder.indexOf("generateMoodBoard");

      expect(analyzeIdx).toBeLessThan(searchIdx);
      expect(analyzeIdx).toBeLessThan(moodIdx);
    });
  });

  describe("error handling", () => {
    it("returns partial results when furniture search fails", async () => {
      const deps = createMockDeps({
        searchFurniture: mock(async () => {
          throw new Error("Shopping API unavailable");
        }),
      });

      const orchestrator = createDesignerOrchestrator(deps);
      const result = await orchestrator.run({ imagePath: "/tmp/test.jpg" });

      expect(result.success).toBe(true); // Still succeeds overall
      expect(result.roomAnalysis).toBeDefined();
      expect(result.moodBoard).toBeDefined();
      expect(result.furnitureResults).toEqual([]); // Empty due to failure
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it("returns partial results when mood board generation fails", async () => {
      const deps = createMockDeps({
        generateMoodBoard: mock(() => {
          throw new Error("MoodBoard generation failed");
        }),
      });

      const orchestrator = createDesignerOrchestrator(deps);
      const result = await orchestrator.run({ imagePath: "/tmp/test.jpg" });

      expect(result.success).toBe(true);
      expect(result.roomAnalysis).toBeDefined();
      expect(result.furnitureResults).toBeDefined();
      expect(result.moodBoard).toBeNull();
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it("fails completely when vision analysis fails", async () => {
      const deps = createMockDeps({
        analyzeRoom: mock(async () => {
          throw new Error("Vision API unavailable");
        }),
      });

      const orchestrator = createDesignerOrchestrator(deps);
      const result = await orchestrator.run({ imagePath: "/tmp/test.jpg" });

      expect(result.success).toBe(false);
      expect(result.roomAnalysis).toBeNull();
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it("returns null analysis when analyzeRoom returns null", async () => {
      const deps = createMockDeps({
        analyzeRoom: mock(async () => null),
      });

      const orchestrator = createDesignerOrchestrator(deps);
      const result = await orchestrator.run({ imagePath: "/tmp/test.jpg" });

      expect(result.success).toBe(false);
      expect(result.roomAnalysis).toBeNull();
    });
  });

  describe("timings", () => {
    it("records timing for each phase", async () => {
      const deps = createMockDeps();
      const orchestrator = createDesignerOrchestrator(deps);

      const result = await orchestrator.run({ imagePath: "/tmp/test.jpg" });

      expect(result.timings).toBeDefined();
      expect(result.timings.configLoad_ms).toBeGreaterThanOrEqual(0);
      expect(result.timings.visionAnalysis_ms).toBeGreaterThanOrEqual(0);
      expect(result.timings.parallelPhase_ms).toBeGreaterThanOrEqual(0);
      expect(result.timings.total_ms).toBeGreaterThanOrEqual(0);
    });

    it("total timing is at least sum of sequential phases", async () => {
      const deps = createMockDeps();
      const orchestrator = createDesignerOrchestrator(deps);

      const result = await orchestrator.run({ imagePath: "/tmp/test.jpg" });

      expect(result.timings.total_ms).toBeGreaterThanOrEqual(
        result.timings.configLoad_ms + result.timings.visionAnalysis_ms
      );
    });
  });

  describe("output formatting", () => {
    it("calls formatOutput with aggregated results", async () => {
      const deps = createMockDeps();
      const orchestrator = createDesignerOrchestrator(deps);

      const result = await orchestrator.run({ imagePath: "/tmp/test.jpg" });
      expect(deps.formatOutput).toHaveBeenCalled();
      expect(result.formattedOutput).toBeDefined();
    });
  });
});
