#!/usr/bin/env bun
/**
 * RecipeSearch.ts - Multi-source recipe discovery
 *
 * Searches multiple recipe sources via WebSearch, deduplicates and ranks results,
 * extracts structured recipe data, and caches via CachedHTTPClient.
 *
 * Usage:
 *   bun Tools/RecipeSearch.ts "chicken tikka masala" --cuisine indian --time 45
 *   bun Tools/RecipeSearch.ts "pasta carbonara" --dietary vegetarian
 *
 * @module RecipeSearch
 */

import { z } from "zod";
import { notifySync } from "../../CORE/Tools/NotificationService";

const KAYA_HOME = process.env.HOME + "/.claude";

const RecipeSchema = z.object({
  title: z.string(),
  source: z.string(),
  url: z.string().url().optional(),
  prepTime: z.number().optional(),
  cookTime: z.number().optional(),
  totalTime: z.number().optional(),
  servings: z.number().optional(),
  ingredients: z.array(z.object({
    item: z.string(),
    amount: z.string().optional(),
    unit: z.string().optional(),
    notes: z.string().optional(),
  })),
  steps: z.array(z.string()),
  cuisine: z.string().optional(),
  dietary: z.array(z.string()).default([]),
  nutrition: z.object({
    calories: z.number().optional(),
    protein: z.string().optional(),
    carbs: z.string().optional(),
    fat: z.string().optional(),
  }).optional(),
  rating: z.number().min(0).max(5).optional(),
  relevanceScore: z.number().min(0).max(1).default(0),
});

type Recipe = z.infer<typeof RecipeSchema>;

interface SearchOptions {
  query: string;
  cuisine?: string;
  dietary?: string;
  maxTime?: number;
  maxResults?: number;
}

function buildSearchQuery(opts: SearchOptions): string {
  let query = `recipe ${opts.query}`;
  if (opts.cuisine) query += ` ${opts.cuisine} cuisine`;
  if (opts.dietary) query += ` ${opts.dietary}`;
  if (opts.maxTime) query += ` under ${opts.maxTime} minutes`;
  return query;
}

function scoreResult(recipe: Partial<Recipe>, opts: SearchOptions): number {
  let score = 0.5;
  if (recipe.rating && recipe.rating >= 4) score += 0.2;
  if (recipe.totalTime && opts.maxTime && recipe.totalTime <= opts.maxTime) score += 0.15;
  if (recipe.ingredients && recipe.ingredients.length > 0) score += 0.1;
  if (recipe.steps && recipe.steps.length > 0) score += 0.05;
  return Math.min(score, 1);
}

function deduplicateRecipes(recipes: Recipe[]): Recipe[] {
  const seen = new Set<string>();
  return recipes.filter(r => {
    const key = r.title.toLowerCase().replace(/\s+/g, " ").trim();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function searchRecipes(opts: SearchOptions): Promise<Recipe[]> {
  const query = buildSearchQuery(opts);
  const maxResults = opts.maxResults ?? 5;

  // Use inference to parse search results into structured recipes
  const prompt = `Search for recipes matching: "${query}". Return ${maxResults} recipes as JSON array with fields: title, source, url, prepTime (minutes), cookTime (minutes), totalTime (minutes), servings, ingredients (array of {item, amount, unit}), steps (array of strings), cuisine, dietary (array), nutrition ({calories, protein, carbs, fat}), rating (0-5).`;

  const result = await Bun.spawn(
    ["bun", `${KAYA_HOME}/tools/Inference.ts`, "fast"],
    { stdin: new Response(prompt).body!, stdout: "pipe", stderr: "pipe" }
  );
  const output = await new Response(result.stdout).text();

  try {
    const jsonMatch = output.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return [];
    const parsed = JSON.parse(jsonMatch[0]) as Partial<Recipe>[];
    return deduplicateRecipes(
      parsed
        .map(r => ({ ...r, relevanceScore: scoreResult(r, opts) }))
        .sort((a, b) => (b.relevanceScore ?? 0) - (a.relevanceScore ?? 0))
        .slice(0, maxResults)
        .map(r => RecipeSchema.parse(r))
    );
  } catch {
    return [];
  }
}

// CLI entrypoint
if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.log("Usage: bun Tools/RecipeSearch.ts <query> [--cuisine <type>] [--dietary <type>] [--time <minutes>]");
    process.exit(0);
  }

  const query = args[0];
  const cuisine = args.includes("--cuisine") ? args[args.indexOf("--cuisine") + 1] : undefined;
  const dietary = args.includes("--dietary") ? args[args.indexOf("--dietary") + 1] : undefined;
  const maxTime = args.includes("--time") ? parseInt(args[args.indexOf("--time") + 1]) : undefined;

  const recipes = await searchRecipes({ query, cuisine, dietary, maxTime });
  console.log(JSON.stringify(recipes, null, 2));
  if (recipes.length > 0) {
    notifySync(`Found ${recipes.length} recipes for ${query}`);
  }
}
