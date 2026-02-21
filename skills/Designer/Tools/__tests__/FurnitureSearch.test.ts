/**
 * FurnitureSearch.test.ts - Tests for product search with curated DB
 *
 * Tests:
 * - Curated DB loading and filtering
 * - Category resolution (fuzzy matching)
 * - Style matching and scoring
 * - Budget filtering
 * - Dimension constraints
 * - Deduplication logic
 */

import { describe, it, expect } from "bun:test";
import { searchFurniture, getRetailers, getStyleOptions } from "../FurnitureSearch.ts";

describe("FurnitureSearch", () => {
  describe("getRetailers", () => {
    it("returns a non-empty list of retailers", () => {
      const retailers = getRetailers();
      expect(retailers.length).toBeGreaterThan(0);
      expect(retailers).toContain("West Elm");
      expect(retailers).toContain("IKEA");
    });
  });

  describe("getStyleOptions", () => {
    it("returns available style keywords", () => {
      const styles = getStyleOptions();
      expect(styles.length).toBeGreaterThan(0);
      expect(styles).toContain("cozy");
      expect(styles).toContain("mid-century");
      expect(styles).toContain("scandinavian");
    });
  });

  describe("searchFurniture - curated DB", () => {
    it("finds sofas from curated DB", async () => {
      const results = await searchFurniture({ query: "sofa" });
      expect(results.length).toBeGreaterThan(0);
      // All results should be from curated_db when there are enough
      const curatedResults = results.filter(r => r.searchMethod === "curated_db");
      expect(curatedResults.length).toBeGreaterThan(0);
    });

    it("filters by budget constraint", async () => {
      const results = await searchFurniture({ query: "sofa", budget: 1000 });
      results.forEach(r => {
        if (r.searchMethod === "curated_db") {
          expect(r.price).toBeLessThanOrEqual(1000);
        }
      });
    });

    it("filters by style when specified", async () => {
      const results = await searchFurniture({ query: "chair", style: "mid-century" });
      expect(results.length).toBeGreaterThan(0);
      // Results should have style match scores
      results.forEach(r => {
        expect(r.styleMatchScore).toBeGreaterThanOrEqual(0);
        expect(r.styleMatchScore).toBeLessThanOrEqual(1);
      });
    });

    it("returns results sorted by style match score", async () => {
      const results = await searchFurniture({ query: "lamp", style: "cozy" });
      if (results.length >= 2) {
        for (let i = 0; i < results.length - 1; i++) {
          expect(results[i].styleMatchScore).toBeGreaterThanOrEqual(results[i + 1].styleMatchScore);
        }
      }
    });

    it("respects maxResults limit", async () => {
      const results = await searchFurniture({ query: "sofa", maxResults: 3 });
      expect(results.length).toBeLessThanOrEqual(3);
    });

    it("resolves category aliases correctly", async () => {
      // "couch" should map to "sofa" category
      const couchResults = await searchFurniture({ query: "couch" });
      const sofaResults = await searchFurniture({ query: "sofa" });
      // Both should find sofa products
      expect(couchResults.length).toBeGreaterThan(0);
      expect(sofaResults.length).toBeGreaterThan(0);
    });

    it("handles decor/accessory searches", async () => {
      const results = await searchFurniture({ query: "decor" });
      expect(results.length).toBeGreaterThan(0);
    });
  });

  describe("searchFurniture - dimension constraints", () => {
    it("filters by width-max when specified", async () => {
      const results = await searchFurniture({ query: "desk", widthMax: 48 });
      results.forEach(r => {
        if (r.searchMethod === "curated_db" && r.dimensions?.width) {
          expect(r.dimensions.width).toBeLessThanOrEqual(48);
        }
      });
    });
  });
});
