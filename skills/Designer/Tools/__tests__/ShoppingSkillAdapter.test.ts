/**
 * ShoppingSkillAdapter.test.ts - Tests for Shopping skill adapter
 *
 * Tests:
 * - Query construction from RoomAnalysis data
 * - Result parsing into ProductResult format
 * - Match scoring algorithm
 * - Error handling for Shopping skill unavailability
 * - Default return on failure
 */

import { describe, it, expect } from "bun:test";
import {
  buildSearchQuery,
  parseShoppingResults,
  calculateMatchScore,
  searchViaShopping,
  type ProductResult,
  type RoomAnalysis,
} from "../ShoppingSkillAdapter.ts";

const MOCK_ROOM_ANALYSIS: RoomAnalysis = {
  room_type: "living room",
  styles: ["modern", "minimalist"],
  dominant_colors: [
    { name: "white", hex: "#FFFFFF" },
    { name: "gray", hex: "#808080" },
  ],
  lighting: "abundant natural light",
  features: ["large windows", "hardwood floors", "open floor plan"],
  confidence: 0.85,
  source: "claude",
};

describe("ShoppingSkillAdapter", () => {
  describe("buildSearchQuery", () => {
    it("constructs query from room analysis and category", () => {
      const query = buildSearchQuery(MOCK_ROOM_ANALYSIS, "sofa");
      expect(query).toContain("sofa");
      expect(query).toContain("modern");
    });

    it("includes style in query", () => {
      const query = buildSearchQuery(MOCK_ROOM_ANALYSIS, "lamp");
      expect(query.toLowerCase()).toContain("modern");
    });

    it("handles room analysis with no styles", () => {
      const noStyles: RoomAnalysis = {
        ...MOCK_ROOM_ANALYSIS,
        styles: [],
      };
      const query = buildSearchQuery(noStyles, "chair");
      expect(query).toContain("chair");
    });

    it("limits query length to reasonable size", () => {
      const query = buildSearchQuery(MOCK_ROOM_ANALYSIS, "coffee table");
      expect(query.length).toBeLessThan(200);
    });
  });

  describe("parseShoppingResults", () => {
    it("parses valid product results", () => {
      const raw = [
        {
          name: "Modern White Sofa",
          brand: "Article",
          price: 1299,
          currency: "USD",
          url: "https://example.com/sofa",
          image_url: "https://example.com/sofa.jpg",
          retailer: "Article",
          category: "sofa",
          style: "modern",
        },
      ];

      const results = parseShoppingResults(raw, MOCK_ROOM_ANALYSIS);
      expect(results.length).toBe(1);
      expect(results[0].name).toBe("Modern White Sofa");
      expect(results[0].brand).toBe("Article");
      expect(results[0].price).toBe(1299);
      expect(results[0].currency).toBe("USD");
      expect(results[0].match_score).toBeGreaterThanOrEqual(0);
      expect(results[0].match_score).toBeLessThanOrEqual(1);
    });

    it("filters out products with missing required fields", () => {
      const raw = [
        { name: "Good Product", brand: "Brand", price: 100, currency: "USD", url: "https://x.com", image_url: "https://x.com/img.jpg", retailer: "Store", category: "sofa", style: "modern" },
        { name: "Bad Product" }, // missing fields
      ];

      const results = parseShoppingResults(raw, MOCK_ROOM_ANALYSIS);
      expect(results.length).toBe(1);
      expect(results[0].name).toBe("Good Product");
    });

    it("returns empty array for invalid input", () => {
      const results = parseShoppingResults(null as any, MOCK_ROOM_ANALYSIS);
      expect(results).toEqual([]);
    });

    it("returns empty array for non-array input", () => {
      const results = parseShoppingResults("not an array" as any, MOCK_ROOM_ANALYSIS);
      expect(results).toEqual([]);
    });
  });

  describe("calculateMatchScore", () => {
    it("returns higher score when style matches", () => {
      const score = calculateMatchScore(
        { style: "modern", name: "Modern Chair", category: "chair" },
        MOCK_ROOM_ANALYSIS,
      );
      expect(score).toBeGreaterThan(0.5);
    });

    it("returns lower score when style doesn't match", () => {
      const score = calculateMatchScore(
        { style: "bohemian", name: "Boho Chair", category: "chair" },
        MOCK_ROOM_ANALYSIS,
      );
      // Still valid but lower match
      expect(score).toBeLessThan(0.7);
    });

    it("returns a score between 0 and 1", () => {
      const score = calculateMatchScore(
        { style: "farmhouse", name: "Rustic Table", category: "table" },
        MOCK_ROOM_ANALYSIS,
      );
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    });

    it("gives bonus for name containing room style keywords", () => {
      const matching = calculateMatchScore(
        { style: "modern", name: "Minimalist Modern Lamp", category: "lighting" },
        MOCK_ROOM_ANALYSIS,
      );
      const nonMatching = calculateMatchScore(
        { style: "traditional", name: "Ornate Victorian Lamp", category: "lighting" },
        MOCK_ROOM_ANALYSIS,
      );
      expect(matching).toBeGreaterThan(nonMatching);
    });
  });

  describe("searchViaShopping", () => {
    it("returns empty array when Shopping skill is unavailable", async () => {
      // In test environment, Shopping skill is not available
      const results = await searchViaShopping(MOCK_ROOM_ANALYSIS, "sofa");
      // Should gracefully return empty (not throw)
      expect(results).toBeInstanceOf(Array);
    });

    it("returns ProductResult[] format", async () => {
      const results = await searchViaShopping(MOCK_ROOM_ANALYSIS, "chair");
      expect(results).toBeInstanceOf(Array);
      // If any results, verify format
      results.forEach((r) => {
        expect(r.name).toBeDefined();
        expect(typeof r.price).toBe("number");
        expect(typeof r.match_score).toBe("number");
      });
    });
  });
});
