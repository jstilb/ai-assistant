/**
 * OutputFormatter.test.ts - Tests for output formatting
 *
 * Tests:
 * - JSON schema compliance
 * - Markdown output structure with required sections
 * - Budget calculation accuracy
 * - MoodBoard and BudgetResult rendering
 * - Credential scrubbing
 * - Metadata section
 */

import { describe, it, expect } from "bun:test";
import {
  formatAsMarkdown,
  formatAsJson,
  calculateBudget,
  scrubCredentials,
  type DesignRecommendation,
} from "../OutputFormatter.ts";

const SAMPLE_RECOMMENDATION: DesignRecommendation = {
  roomName: "Living Room",
  style: "Modern Cozy",
  analysis: {
    strengths: ["Good natural light", "Open floor plan"],
    opportunities: ["Needs texture", "Empty corners"],
    lightingAssessment: "moderate natural, dim artificial",
    colorCoherence: "fair",
  },
  actions: [
    {
      suggestion: "Add throw pillows and blanket to sofa",
      impact: "medium",
      estimatedCost: 80,
      priority: 1,
      category: "textiles",
    },
    {
      suggestion: "Floor lamp in reading corner",
      impact: "high",
      estimatedCost: 150,
      priority: 2,
      category: "lighting",
    },
    {
      suggestion: "Area rug under coffee table",
      impact: "high",
      estimatedCost: 300,
      priority: 3,
      category: "rugs",
    },
  ],
  products: [
    {
      name: "Chunky Knit Throw",
      price: 45,
      retailer: "West Elm",
      styleMatchScore: 0.85,
    },
    {
      name: "Tripod Floor Lamp",
      price: 129,
      retailer: "CB2",
      styleMatchScore: 0.78,
    },
  ],
};

const SAMPLE_WITH_MOOD_BOARD: DesignRecommendation = {
  ...SAMPLE_RECOMMENDATION,
  moodBoard: {
    palette: [
      { name: "Warm Linen", hex: "#F5E6D3", weight: 0.4 },
      { name: "Camel", hex: "#C19A6B", weight: 0.35 },
      { name: "Charcoal", hex: "#36454F", weight: 0.25 },
    ],
    style_keywords: ["modern", "cozy", "warm"],
    reference_images: [
      { url: "https://example.com/ref1.jpg", style: "Modern Cozy", description: "Living room" },
    ],
    color_harmony: "analogous",
  },
  budgetResult: {
    total_cost: 174,
    budget_limit: 2000,
    budget_status: "under",
    currency: "USD",
    per_category: [
      { category: "textiles", top_pick_cost: 45, exceeds_budget: false },
      { category: "lighting", top_pick_cost: 129, exceeds_budget: false },
    ],
  },
  metadata: {
    analysisMethod: "claude_vision",
    confidence: 0.85,
    timestamp: "2026-02-09T12:00:00Z",
  },
};

describe("OutputFormatter", () => {
  describe("formatAsJson", () => {
    it("returns valid JSON string", () => {
      const json = formatAsJson(SAMPLE_RECOMMENDATION);
      const parsed = JSON.parse(json);
      expect(parsed).toBeDefined();
      expect(parsed.roomName).toBe("Living Room");
    });

    it("includes all required fields", () => {
      const json = formatAsJson(SAMPLE_RECOMMENDATION);
      const parsed = JSON.parse(json);
      expect(parsed.roomName).toBeDefined();
      expect(parsed.style).toBeDefined();
      expect(parsed.analysis).toBeDefined();
      expect(parsed.actions).toBeDefined();
      expect(parsed.budget).toBeDefined();
    });

    it("includes calculated budget summary", () => {
      const json = formatAsJson(SAMPLE_RECOMMENDATION);
      const parsed = JSON.parse(json);
      expect(parsed.budget.total).toBe(530);
      expect(parsed.budget.byCategory).toBeDefined();
    });

    it("includes moodBoard when provided", () => {
      const json = formatAsJson(SAMPLE_WITH_MOOD_BOARD);
      const parsed = JSON.parse(json);
      expect(parsed.moodBoard).toBeDefined();
      expect(parsed.moodBoard.palette.length).toBe(3);
      expect(parsed.moodBoard.color_harmony).toBe("analogous");
    });

    it("includes budgetResult when provided", () => {
      const json = formatAsJson(SAMPLE_WITH_MOOD_BOARD);
      const parsed = JSON.parse(json);
      expect(parsed.budgetResult).toBeDefined();
      expect(parsed.budgetResult.budget_status).toBe("under");
    });

    it("includes metadata when provided", () => {
      const json = formatAsJson(SAMPLE_WITH_MOOD_BOARD);
      const parsed = JSON.parse(json);
      expect(parsed.metadata).toBeDefined();
      expect(parsed.metadata.analysisMethod).toBe("claude_vision");
    });
  });

  describe("formatAsMarkdown", () => {
    it("returns a non-empty markdown string", () => {
      const md = formatAsMarkdown(SAMPLE_RECOMMENDATION);
      expect(md.length).toBeGreaterThan(0);
    });

    it("includes room name as heading", () => {
      const md = formatAsMarkdown(SAMPLE_RECOMMENDATION);
      expect(md).toContain("Living Room");
    });

    it("includes priority actions", () => {
      const md = formatAsMarkdown(SAMPLE_RECOMMENDATION);
      expect(md).toContain("throw pillows");
      expect(md).toContain("Floor lamp");
    });

    it("includes budget breakdown", () => {
      const md = formatAsMarkdown(SAMPLE_RECOMMENDATION);
      expect(md).toContain("$530");
    });

    it("includes product recommendations when present", () => {
      const md = formatAsMarkdown(SAMPLE_RECOMMENDATION);
      expect(md).toContain("Chunky Knit Throw");
      expect(md).toContain("West Elm");
    });

    it("contains ## Room Analysis section", () => {
      const md = formatAsMarkdown(SAMPLE_RECOMMENDATION);
      expect(md).toContain("## Room Analysis");
    });

    it("contains ## Recommended Products section", () => {
      const md = formatAsMarkdown(SAMPLE_RECOMMENDATION);
      expect(md).toContain("## Recommended Products");
    });

    it("contains ## Budget Summary section", () => {
      const md = formatAsMarkdown(SAMPLE_RECOMMENDATION);
      expect(md).toContain("## Budget Summary");
    });

    it("contains ## Mood Board section when moodBoard provided", () => {
      const md = formatAsMarkdown(SAMPLE_WITH_MOOD_BOARD);
      expect(md).toContain("## Mood Board");
      expect(md).toContain("analogous");
      expect(md).toContain("modern");
    });

    it("contains ## Metadata section when metadata provided", () => {
      const md = formatAsMarkdown(SAMPLE_WITH_MOOD_BOARD);
      expect(md).toContain("## Metadata");
      expect(md).toContain("claude_vision");
    });

    it("includes mood board palette colors", () => {
      const md = formatAsMarkdown(SAMPLE_WITH_MOOD_BOARD);
      expect(md).toContain("#F5E6D3");
      expect(md).toContain("Warm Linen");
    });

    it("includes budget result status", () => {
      const md = formatAsMarkdown(SAMPLE_WITH_MOOD_BOARD);
      expect(md).toContain("under");
    });
  });

  describe("calculateBudget", () => {
    it("sums total costs correctly", () => {
      const budget = calculateBudget(SAMPLE_RECOMMENDATION.actions);
      expect(budget.total).toBe(530);
    });

    it("groups costs by category", () => {
      const budget = calculateBudget(SAMPLE_RECOMMENDATION.actions);
      expect(budget.byCategory.textiles).toBe(80);
      expect(budget.byCategory.lighting).toBe(150);
      expect(budget.byCategory.rugs).toBe(300);
    });

    it("groups costs by impact tier", () => {
      const budget = calculateBudget(SAMPLE_RECOMMENDATION.actions);
      expect(budget.byImpact.medium).toBe(80);
      expect(budget.byImpact.high).toBe(450);
    });

    it("handles empty actions array", () => {
      const budget = calculateBudget([]);
      expect(budget.total).toBe(0);
      expect(Object.keys(budget.byCategory)).toHaveLength(0);
    });
  });

  describe("scrubCredentials", () => {
    it("strips API keys from output", () => {
      const dirty = 'api_key: "sk-ant-abcdefghijklmnopqrstuvwxyz1234567890"';
      const clean = scrubCredentials(dirty);
      expect(clean).not.toContain("abcdefghijklmnopqrstuvwxyz");
    });

    it("strips Bearer tokens", () => {
      const dirty = "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9abcdef";
      const clean = scrubCredentials(dirty);
      expect(clean).not.toContain("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9");
    });

    it("strips sk- prefixed secrets", () => {
      const dirty = "secret: sk_test_abcdefghijklmnopqrstuvwxyz";
      const clean = scrubCredentials(dirty);
      expect(clean).not.toContain("sk_test_abcdefghijklmnopqrstuvwxyz");
    });

    it("preserves non-credential content", () => {
      const safe = "Room analysis completed with 85% confidence";
      const clean = scrubCredentials(safe);
      expect(clean).toBe(safe);
    });

    it("handles empty string", () => {
      expect(scrubCredentials("")).toBe("");
    });

    it("scrubs credentials from JSON output", () => {
      const rec: DesignRecommendation = {
        ...SAMPLE_RECOMMENDATION,
        metadata: {
          note: "api_key: sk-ant-THISISASECRETKEYTHATISLONGENOUGH123",
        },
      };
      const json = formatAsJson(rec);
      expect(json).not.toContain("THISISASECRETKEYTHATISLONGENOUGH");
    });
  });
});
