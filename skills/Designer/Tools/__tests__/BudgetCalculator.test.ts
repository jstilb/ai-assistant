/**
 * BudgetCalculator.test.ts - Tests for budget calculation
 *
 * Tests 5 scenarios:
 * 1. Under budget (< 80%)
 * 2. Within budget (80-100%)
 * 3. Over budget (> 100%)
 * 4. 50% over budget
 * 5. No budget specified
 *
 * Plus: per-category breakdown, exceeds_budget tagging
 */

import { describe, it, expect } from "bun:test";
import {
  calculateBudgetResult,
  type BudgetResult,
  type ProductForBudget,
} from "../BudgetCalculator.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PRODUCTS_UNDER: ProductForBudget[] = [
  { name: "Floor Lamp", price: 120, category: "lighting" },
  { name: "Throw Pillow Set", price: 45, category: "textiles" },
  { name: "Area Rug", price: 180, category: "rugs" },
];

const PRODUCTS_WITHIN: ProductForBudget[] = [
  { name: "Sofa", price: 800, category: "seating" },
  { name: "Coffee Table", price: 350, category: "tables" },
  { name: "Floor Lamp", price: 200, category: "lighting" },
  { name: "Area Rug", price: 400, category: "rugs" },
];

const PRODUCTS_OVER: ProductForBudget[] = [
  { name: "Sectional Sofa", price: 2500, category: "seating" },
  { name: "Dining Table", price: 1200, category: "tables" },
  { name: "Chandelier", price: 800, category: "lighting" },
];

const PRODUCTS_WAY_OVER: ProductForBudget[] = [
  { name: "Designer Sectional", price: 5000, category: "seating" },
  { name: "Italian Marble Table", price: 3000, category: "tables" },
  { name: "Crystal Chandelier", price: 2000, category: "lighting" },
  { name: "Persian Rug", price: 5000, category: "rugs" },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("BudgetCalculator", () => {
  describe("under budget (< 80%)", () => {
    it("returns budget_status 'under'", () => {
      const result = calculateBudgetResult(PRODUCTS_UNDER, 2000);
      expect(result.budget_status).toBe("under");
    });

    it("calculates correct total cost", () => {
      const result = calculateBudgetResult(PRODUCTS_UNDER, 2000);
      expect(result.total_cost).toBe(345); // 120 + 45 + 180
    });

    it("no products flagged as exceeds_budget", () => {
      const result = calculateBudgetResult(PRODUCTS_UNDER, 2000);
      const exceeding = result.per_category.filter(c => c.exceeds_budget);
      expect(exceeding.length).toBe(0);
    });
  });

  describe("within budget (80-100%)", () => {
    it("returns budget_status 'within'", () => {
      const result = calculateBudgetResult(PRODUCTS_WITHIN, 2000);
      expect(result.budget_status).toBe("within");
    });

    it("calculates correct total cost", () => {
      const result = calculateBudgetResult(PRODUCTS_WITHIN, 2000);
      expect(result.total_cost).toBe(1750); // 800 + 350 + 200 + 400
    });

    it("has correct per_category entries", () => {
      const result = calculateBudgetResult(PRODUCTS_WITHIN, 2000);
      expect(result.per_category.length).toBe(4);
      const seating = result.per_category.find(c => c.category === "seating");
      expect(seating).toBeDefined();
      expect(seating!.top_pick_cost).toBe(800);
    });
  });

  describe("over budget (> 100%)", () => {
    it("returns budget_status 'over'", () => {
      const result = calculateBudgetResult(PRODUCTS_OVER, 2000);
      expect(result.budget_status).toBe("over");
    });

    it("total cost exceeds budget limit", () => {
      const result = calculateBudgetResult(PRODUCTS_OVER, 2000);
      expect(result.total_cost).toBeGreaterThan(2000);
      expect(result.total_cost).toBe(4500); // 2500 + 1200 + 800
    });

    it("never silently excludes over-budget products", () => {
      const result = calculateBudgetResult(PRODUCTS_OVER, 2000);
      // All products must be present in per_category
      expect(result.per_category.length).toBe(3);
    });

    it("tags expensive categories with exceeds_budget and explanation", () => {
      const result = calculateBudgetResult(PRODUCTS_OVER, 2000);
      // Individual categories that by themselves are over budget / high proportion
      const seating = result.per_category.find(c => c.category === "seating");
      expect(seating).toBeDefined();
      // Seating is $2500 which exceeds the $2000 total budget
      expect(seating!.exceeds_budget).toBe(true);
      expect(seating!.explanation).toBeDefined();
      expect(seating!.explanation!.length).toBeGreaterThan(0);
    });
  });

  describe("50% over budget", () => {
    it("returns budget_status 'over' for 50% over", () => {
      const result = calculateBudgetResult(PRODUCTS_WAY_OVER, 10000);
      expect(result.budget_status).toBe("over");
      expect(result.total_cost).toBe(15000);
    });

    it("identifies all individual categories exceeding budget", () => {
      const result = calculateBudgetResult(PRODUCTS_WAY_OVER, 10000);
      // At least one category should be flagged
      const flagged = result.per_category.filter(c => c.exceeds_budget);
      expect(flagged.length).toBeGreaterThan(0);
    });
  });

  describe("no budget specified", () => {
    it("returns budget_status 'no_budget'", () => {
      const result = calculateBudgetResult(PRODUCTS_UNDER, null);
      expect(result.budget_status).toBe("no_budget");
    });

    it("budget_limit is null", () => {
      const result = calculateBudgetResult(PRODUCTS_UNDER, null);
      expect(result.budget_limit).toBeNull();
    });

    it("still calculates total cost", () => {
      const result = calculateBudgetResult(PRODUCTS_UNDER, null);
      expect(result.total_cost).toBe(345);
    });

    it("no products flagged as exceeds_budget", () => {
      const result = calculateBudgetResult(PRODUCTS_UNDER, null);
      const exceeding = result.per_category.filter(c => c.exceeds_budget);
      expect(exceeding.length).toBe(0);
    });
  });

  describe("currency and defaults", () => {
    it("defaults to USD currency", () => {
      const result = calculateBudgetResult(PRODUCTS_UNDER, 2000);
      expect(result.currency).toBe("USD");
    });

    it("accepts custom currency", () => {
      const result = calculateBudgetResult(PRODUCTS_UNDER, 2000, "EUR");
      expect(result.currency).toBe("EUR");
    });
  });

  describe("empty products", () => {
    it("handles empty product array", () => {
      const result = calculateBudgetResult([], 2000);
      expect(result.total_cost).toBe(0);
      expect(result.budget_status).toBe("under");
      expect(result.per_category.length).toBe(0);
    });
  });

  describe("multiple products per category", () => {
    it("uses highest-priced product as top pick per category", () => {
      const products: ProductForBudget[] = [
        { name: "Cheap Lamp", price: 50, category: "lighting" },
        { name: "Nice Lamp", price: 200, category: "lighting" },
        { name: "Premium Lamp", price: 500, category: "lighting" },
      ];
      const result = calculateBudgetResult(products, 1000);
      const lighting = result.per_category.find(c => c.category === "lighting");
      expect(lighting).toBeDefined();
      expect(lighting!.top_pick_cost).toBe(500);
    });
  });
});
