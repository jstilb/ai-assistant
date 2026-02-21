#!/usr/bin/env bun
/**
 * BudgetCalculator.ts - Budget analysis for design recommendations
 *
 * Calculates total cost from top-pick products per category, determines
 * budget status, and tags over-budget items with explanations.
 * Never silently excludes over-budget products.
 *
 * Usage:
 *   import { calculateBudgetResult } from './BudgetCalculator';
 *   const result = calculateBudgetResult(products, budgetLimit);
 *
 * @module BudgetCalculator
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProductForBudget {
  name: string;
  price: number;
  category: string;
}

export interface BudgetResult {
  total_cost: number;
  budget_limit: number | null;
  budget_status: "within" | "over" | "under" | "no_budget";
  currency: string;
  per_category: Array<{
    category: string;
    top_pick_cost: number;
    exceeds_budget: boolean;
    explanation?: string;
  }>;
}

// ---------------------------------------------------------------------------
// Budget calculation
// ---------------------------------------------------------------------------

export function calculateBudgetResult(
  products: ProductForBudget[],
  budgetLimit: number | null,
  currency: string = "USD"
): BudgetResult {
  // Group products by category, pick highest-priced per category as top pick
  const categoryMap = new Map<string, ProductForBudget[]>();

  for (const product of products) {
    const existing = categoryMap.get(product.category) || [];
    existing.push(product);
    categoryMap.set(product.category, existing);
  }

  // First pass: collect top picks per category
  const topPicks: Array<{ category: string; topPick: ProductForBudget }> = [];

  for (const [category, categoryProducts] of categoryMap) {
    const topPick = categoryProducts.reduce(
      (best, p) => (p.price > best.price ? p : best),
      categoryProducts[0]
    );
    topPicks.push({ category, topPick });
  }

  // Calculate total to determine if we're over budget
  const prelimTotal = topPicks.reduce((sum, t) => sum + t.topPick.price, 0);
  const isOverBudget = budgetLimit !== null && prelimTotal > budgetLimit;

  // Second pass: flag exceeding categories
  const perCategory: BudgetResult["per_category"] = [];

  for (const { category, topPick } of topPicks) {
    let exceedsBudget = false;
    let explanation: string | undefined;

    if (budgetLimit !== null) {
      // Flag if single item exceeds entire budget
      if (topPick.price > budgetLimit) {
        exceedsBudget = true;
        explanation = `${topPick.name} at $${topPick.price} exceeds the total budget of $${budgetLimit}`;
      }
      // Flag if we're over budget and this category uses > 50% of the budget
      else if (isOverBudget && topPick.price >= budgetLimit * 0.5) {
        exceedsBudget = true;
        const pct = ((topPick.price / budgetLimit) * 100).toFixed(0);
        explanation = `${topPick.name} at $${topPick.price} uses ${pct}% of the $${budgetLimit} budget`;
      }
    }

    perCategory.push({
      category,
      top_pick_cost: topPick.price,
      exceeds_budget: exceedsBudget,
      explanation,
    });
  }

  // Total cost = sum of top picks per category
  const totalCost = perCategory.reduce((sum, c) => sum + c.top_pick_cost, 0);

  // Determine budget status
  let budgetStatus: BudgetResult["budget_status"];

  if (budgetLimit === null) {
    budgetStatus = "no_budget";
  } else if (totalCost > budgetLimit) {
    budgetStatus = "over";
  } else if (totalCost < budgetLimit * 0.8) {
    budgetStatus = "under";
  } else {
    budgetStatus = "within";
  }

  return {
    total_cost: totalCost,
    budget_limit: budgetLimit,
    budget_status: budgetStatus,
    currency,
    per_category: perCategory,
  };
}

// ---------------------------------------------------------------------------
// CLI entrypoint
// ---------------------------------------------------------------------------

if (import.meta.main) {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.length === 0) {
    console.log("Usage: bun Tools/BudgetCalculator.ts --products <json> --budget <amount>");
    console.log("");
    console.log("Calculate budget status from product selections.");
    process.exit(0);
  }

  const budgetArg = args.includes("--budget") ? args[args.indexOf("--budget") + 1] : null;
  const budget = budgetArg ? parseFloat(budgetArg) : null;

  // Example products for CLI demo
  const demoProducts: ProductForBudget[] = [
    { name: "Floor Lamp", price: 150, category: "lighting" },
    { name: "Throw Pillows", price: 45, category: "textiles" },
    { name: "Area Rug", price: 300, category: "rugs" },
  ];

  const result = calculateBudgetResult(demoProducts, budget);
  console.log(JSON.stringify(result, null, 2));
}
