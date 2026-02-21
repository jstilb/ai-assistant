#!/usr/bin/env bun
/**
 * FurnitureSearch.ts - Home goods search with curated DB + inference fallback
 *
 * Primary: Loads and filters products from curated-products.json
 * Fallback: Uses Inference tool when curated DB has <3 results
 *
 * Usage:
 *   bun Tools/FurnitureSearch.ts search "reading chair" --style cozy --budget 500
 *   bun Tools/FurnitureSearch.ts search "floor lamp" --style mid-century --budget 200
 *
 * @module FurnitureSearch
 */

import { z } from "zod";
import { createStateManager } from "../../CORE/Tools/StateManager.ts";
import { notifySync } from "../../CORE/Tools/NotificationService.ts";

const KAYA_HOME = process.env.HOME + "/.claude";
const CURATED_DB_PATH = import.meta.dir + "/../data/curated-products.json";

const FurnitureResultSchema = z.object({
  name: z.string(),
  price: z.number(),
  retailer: z.string(),
  url: z.string().optional(),
  dimensions: z.object({
    width: z.number().optional(),
    depth: z.number().optional(),
    height: z.number().optional(),
    unit: z.string().default("inches"),
  }).optional(),
  material: z.string().optional(),
  color: z.string().optional(),
  styleMatchScore: z.number().min(0).max(1).default(0),
  rating: z.number().optional(),
  inStock: z.boolean().default(true),
  searchMethod: z.enum(["curated_db", "inference"]).default("inference"),
});

type FurnitureResult = z.infer<typeof FurnitureResultSchema>;

interface CuratedProduct {
  name: string;
  price: number;
  retailer: string;
  url?: string;
  dimensions?: { width?: number; depth?: number; height?: number; unit?: string };
  material?: string;
  color?: string;
  rating?: number;
  inStock?: boolean;
  category?: string;
  style?: string;
  tags?: string[];
}

interface SearchOptions {
  query: string;
  style?: string;
  budget?: number;
  widthMax?: number;
  depthMax?: number;
  material?: string;
  retailers?: string[];
  maxResults?: number;
}

const HOME_RETAILERS = [
  "West Elm", "CB2", "IKEA", "Wayfair", "Target",
  "Article", "Pottery Barn", "Crate & Barrel",
  "World Market", "HomeGoods", "Amazon",
];

const STYLE_KEYWORDS: Record<string, string[]> = {
  cozy: ["plush", "soft", "warm", "upholstered", "fabric", "cushioned"],
  "mid-century": ["walnut", "tapered legs", "organic", "retro", "teak"],
  scandinavian: ["light wood", "minimalist", "birch", "pine", "clean lines"],
  bohemian: ["rattan", "woven", "macramé", "colorful", "eclectic"],
  japandi: ["natural", "low-profile", "bamboo", "simple", "handcrafted"],
  modern: ["sleek", "contemporary", "metal", "glass", "geometric"],
  farmhouse: ["rustic", "reclaimed", "distressed", "country", "shiplap"],
};

// Fuzzy category mapping: query terms -> canonical category
const CATEGORY_MAP: Record<string, string> = {
  sofa: "sofa",
  couch: "sofa",
  loveseat: "sofa",
  "coffee table": "coffee_table",
  "dining table": "dining_table",
  chair: "chair",
  "reading chair": "chair",
  "accent chair": "chair",
  armchair: "chair",
  lamp: "lighting",
  light: "lighting",
  lighting: "lighting",
  "floor lamp": "lighting",
  "table lamp": "lighting",
  chandelier: "lighting",
  rug: "rug",
  carpet: "rug",
  bookshelf: "bookshelf",
  shelf: "bookshelf",
  shelving: "bookshelf",
  nightstand: "nightstand",
  "bedside table": "nightstand",
  "end table": "nightstand",
  desk: "desk",
  "writing desk": "desk",
  decor: "decor",
  vase: "decor",
  plant: "decor",
  mirror: "decor",
  art: "decor",
  pillow: "decor",
  throw: "decor",
};

function calculateStyleMatch(result: Partial<FurnitureResult>, style?: string): number {
  if (!style) return 0.5;
  const keywords = STYLE_KEYWORDS[style.toLowerCase()] ?? [];
  if (keywords.length === 0) return 0.5;

  const text = `${result.name} ${result.material} ${result.color}`.toLowerCase();
  const matches = keywords.filter(k => text.includes(k)).length;
  return Math.min(matches / keywords.length + 0.3, 1);
}

/**
 * Resolve a search query to a canonical category for DB filtering.
 * Tries longest match first (e.g. "reading chair" before "chair").
 */
function resolveCategory(query: string): string | null {
  const q = query.toLowerCase().trim();

  // Sort keys by length descending so multi-word phrases match first
  const sortedKeys = Object.keys(CATEGORY_MAP).sort((a, b) => b.length - a.length);

  for (const key of sortedKeys) {
    if (q.includes(key)) {
      return CATEGORY_MAP[key];
    }
  }
  return null;
}

/**
 * Load and filter products from the curated product database.
 */
function searchCuratedDB(opts: SearchOptions): FurnitureResult[] {
  let products: CuratedProduct[];
  try {
    const raw = Bun.file(CURATED_DB_PATH);
    const text = require(CURATED_DB_PATH);
    // Handle both formats: plain array or { products: [...] } wrapper
    if (Array.isArray(text)) {
      products = text as CuratedProduct[];
    } else if (text && Array.isArray(text.products)) {
      products = text.products as CuratedProduct[];
    } else {
      return [];
    }
  } catch {
    // DB file missing or malformed -- return empty so caller falls back
    return [];
  }

  if (!Array.isArray(products) || products.length === 0) return [];

  const category = resolveCategory(opts.query);

  let filtered = products;

  // Filter by category (fuzzy match via canonical mapping)
  if (category) {
    filtered = filtered.filter(p => {
      // Match product's own category field
      if (p.category?.toLowerCase() === category) return true;
      // Also match if the product name contains the query term
      if (p.name?.toLowerCase().includes(opts.query.toLowerCase())) return true;
      // Also match via tags
      if (p.tags?.some(t => t.toLowerCase() === category)) return true;
      return false;
    });
  } else {
    // No category mapping -- fall back to name/tag substring match
    const q = opts.query.toLowerCase();
    filtered = filtered.filter(p =>
      p.name?.toLowerCase().includes(q) ||
      p.tags?.some(t => t.toLowerCase().includes(q)) ||
      p.category?.toLowerCase().includes(q)
    );
  }

  // Filter by style if specified
  if (opts.style) {
    const styleLower = opts.style.toLowerCase();
    const withStyle = filtered.filter(p =>
      p.style?.toLowerCase() === styleLower ||
      p.tags?.some(t => t.toLowerCase() === styleLower)
    );
    // Only narrow if style filter still leaves results; otherwise keep all category matches
    if (withStyle.length > 0) {
      filtered = withStyle;
    }
  }

  // Filter by budget
  if (opts.budget) {
    filtered = filtered.filter(p => p.price <= opts.budget!);
  }

  // Filter by width constraint
  if (opts.widthMax) {
    filtered = filtered.filter(p =>
      !p.dimensions?.width || p.dimensions.width <= opts.widthMax!
    );
  }

  // Filter by material
  if (opts.material) {
    const mat = opts.material.toLowerCase();
    filtered = filtered.filter(p =>
      p.material?.toLowerCase().includes(mat)
    );
  }

  // Convert to FurnitureResult with style scoring
  const results: FurnitureResult[] = filtered.map(p => {
    const partial: Partial<FurnitureResult> = {
      name: p.name,
      price: p.price,
      retailer: p.retailer,
      url: p.url,
      dimensions: p.dimensions ? { ...p.dimensions, unit: p.dimensions.unit ?? "inches" } : undefined,
      material: p.material,
      color: p.color,
      rating: p.rating,
      inStock: p.inStock ?? true,
    };
    return FurnitureResultSchema.parse({
      ...partial,
      styleMatchScore: calculateStyleMatch(partial, opts.style),
      searchMethod: "curated_db" as const,
    });
  });

  // Sort by style match score descending
  results.sort((a, b) => b.styleMatchScore - a.styleMatchScore);

  return results;
}

/**
 * Search via Inference tool (original approach). Used as fallback.
 */
async function searchInference(opts: SearchOptions): Promise<FurnitureResult[]> {
  const maxResults = opts.maxResults ?? 8;
  const retailers = opts.retailers ?? HOME_RETAILERS.slice(0, 5);

  const styleHint = opts.style ? ` in ${opts.style} style` : "";
  const budgetHint = opts.budget ? ` under $${opts.budget}` : "";
  const dimHint = opts.widthMax ? ` max width ${opts.widthMax} inches` : "";
  const matHint = opts.material ? ` in ${opts.material}` : "";

  const prompt = `Search for "${opts.query}"${styleHint}${budgetHint}${dimHint}${matHint} from home furniture retailers (${retailers.join(", ")}). Return ${maxResults} results as JSON array with fields: name, price (number), retailer, url, dimensions ({width, depth, height} in inches), material, color, rating (1-5), inStock (boolean). Include realistic prices and dimensions.`;

  const result = await Bun.spawn(
    ["bun", `${KAYA_HOME}/tools/Inference.ts`, "fast"],
    { stdin: new Response(prompt).body!, stdout: "pipe", stderr: "pipe" }
  );
  const output = await new Response(result.stdout).text();

  try {
    const jsonMatch = output.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return [];
    const parsed = JSON.parse(jsonMatch[0]) as Partial<FurnitureResult>[];
    return parsed
      .map(r => ({
        ...r,
        styleMatchScore: calculateStyleMatch(r, opts.style),
        searchMethod: "inference" as const,
      }))
      .filter(r => !opts.budget || (r.price && r.price <= opts.budget))
      .filter(r => !opts.widthMax || !r.dimensions?.width || r.dimensions.width <= opts.widthMax)
      .sort((a, b) => (b.styleMatchScore ?? 0) - (a.styleMatchScore ?? 0))
      .slice(0, maxResults)
      .map(r => FurnitureResultSchema.parse(r));
  } catch {
    return [];
  }
}

/**
 * Search for furniture products.
 * Tries curated DB first, falls back to inference if <3 results.
 */
export async function searchFurniture(opts: SearchOptions): Promise<FurnitureResult[]> {
  const maxResults = opts.maxResults ?? 8;

  // Primary: try curated product database
  const curatedResults = searchCuratedDB(opts);

  if (curatedResults.length >= 3) {
    return curatedResults.slice(0, maxResults);
  }

  // Fallback: inference-based search (curated DB had <3 results)
  const inferenceResults = await searchInference(opts);

  // Merge: curated results first (higher trust), then inference
  const merged = [...curatedResults, ...inferenceResults];

  // Deduplicate by name similarity (lowercase exact match)
  const seen = new Set<string>();
  const deduped = merged.filter(r => {
    const key = r.name.toLowerCase().trim();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return deduped
    .sort((a, b) => b.styleMatchScore - a.styleMatchScore)
    .slice(0, maxResults);
}

export function getRetailers(): string[] {
  return HOME_RETAILERS;
}

export function getStyleOptions(): string[] {
  return Object.keys(STYLE_KEYWORDS);
}

// CLI entrypoint
if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args[0] !== "search" || args.length < 2) {
    console.log("Usage: bun Tools/FurnitureSearch.ts search <query> [--style S] [--budget N] [--width-max N]");
    console.log(`\nStyles: ${getStyleOptions().join(", ")}`);
    console.log(`Retailers: ${HOME_RETAILERS.join(", ")}`);
    process.exit(0);
  }

  const query = args[1];
  const style = args.includes("--style") ? args[args.indexOf("--style") + 1] : undefined;
  const budget = args.includes("--budget") ? parseInt(args[args.indexOf("--budget") + 1]) : undefined;
  const widthMax = args.includes("--width-max") ? parseInt(args[args.indexOf("--width-max") + 1]) : undefined;

  console.log(`🔍 Searching for "${query}"${style ? ` (${style})` : ""}${budget ? ` under $${budget}` : ""}...\n`);
  const results = await searchFurniture({ query, style, budget, widthMax });

  if (results.length === 0) {
    console.log("No results found. Try broadening your search.");
    process.exit(0);
  }

  if (args.includes("--json")) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    results.forEach((r, i) => {
      const method = r.searchMethod === "curated_db" ? "[DB]" : "[AI]";
      console.log(`${i + 1}. ${method} ${r.name} -- $${r.price}`);
      console.log(`   ${r.retailer}${r.material ? ` | ${r.material}` : ""}${r.color ? ` | ${r.color}` : ""}`);
      if (r.dimensions) {
        const d = r.dimensions;
        console.log(`   ${d.width ? d.width + '"W' : ""}${d.depth ? " x " + d.depth + '"D' : ""}${d.height ? " x " + d.height + '"H' : ""}`);
      }
      console.log(`   Style match: ${(r.styleMatchScore * 100).toFixed(0)}%${r.rating ? ` | Rating: ${r.rating}/5` : ""}`);
      console.log();
    });
    notifySync(`Found ${results.length} furniture results for ${query}`);
  }
}
