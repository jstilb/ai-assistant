#!/usr/bin/env bun
/**
 * ShoppingSkillAdapter.ts - Live product search via Shopping skill
 *
 * Invokes the Shopping skill for live product search, constructs queries
 * from RoomAnalysis data (style + category), parses results into
 * ProductResult[] format with style-based match scoring.
 *
 * Usage:
 *   import { searchViaShopping } from './ShoppingSkillAdapter';
 *   const products = await searchViaShopping(roomAnalysis, 'sofa');
 *
 * @module ShoppingSkillAdapter
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RoomAnalysis {
  room_type: string;
  styles: string[];
  dominant_colors: Array<{ name: string; hex: string }>;
  lighting: string;
  features: string[];
  confidence: number;
  source: "claude" | "gemini" | "text_inference";
}

export interface ProductResult {
  name: string;
  brand: string;
  price: number;
  currency: string;
  url: string;
  image_url: string;
  retailer: string;
  match_score: number;
  category: string;
  style: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const KAYA_HOME = process.env.HOME + "/.claude";
const SHOPPING_SKILL_PATH = `${KAYA_HOME}/skills/Shopping/SKILL.md`;
const INFERENCE_TOOL = `${KAYA_HOME}/tools/Inference.ts`;

// ---------------------------------------------------------------------------
// Query construction
// ---------------------------------------------------------------------------

export function buildSearchQuery(analysis: RoomAnalysis, category: string): string {
  const primaryStyle = analysis.styles.length > 0 ? analysis.styles[0] : "";
  const colorHints = analysis.dominant_colors
    .slice(0, 2)
    .map((c) => c.name)
    .join(", ");

  const parts: string[] = [];

  if (primaryStyle) parts.push(primaryStyle);
  parts.push(category);

  if (colorHints && parts.join(" ").length < 100) {
    parts.push(`in ${colorHints} tones`);
  }

  parts.push(`for ${analysis.room_type}`);

  // Cap at reasonable length
  const query = parts.join(" ").slice(0, 199);
  return query;
}

// ---------------------------------------------------------------------------
// Match scoring
// ---------------------------------------------------------------------------

export function calculateMatchScore(
  product: { style?: string; name?: string; category?: string },
  analysis: RoomAnalysis,
): number {
  let score = 0.3; // base score

  const productStyle = (product.style || "").toLowerCase();
  const productName = (product.name || "").toLowerCase();

  // Style match (up to +0.4)
  for (const roomStyle of analysis.styles) {
    const styleLower = roomStyle.toLowerCase();
    if (productStyle.includes(styleLower)) {
      score += 0.4;
      break;
    }
    if (productName.includes(styleLower)) {
      score += 0.3;
      break;
    }
  }

  // Name contains style keywords (additional +0.15)
  const styleKeywords = analysis.styles.map((s) => s.toLowerCase());
  const nameMatchCount = styleKeywords.filter((kw) => productName.includes(kw)).length;
  if (nameMatchCount > 0) {
    score += Math.min(nameMatchCount * 0.1, 0.15);
  }

  // Color compatibility bonus (+0.1)
  for (const color of analysis.dominant_colors) {
    if (productName.includes(color.name.toLowerCase())) {
      score += 0.1;
      break;
    }
  }

  return Math.min(score, 1.0);
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

export function parseShoppingResults(
  raw: unknown,
  analysis: RoomAnalysis,
): ProductResult[] {
  if (!Array.isArray(raw)) return [];

  const results: ProductResult[] = [];

  for (const item of raw) {
    if (
      typeof item !== "object" ||
      item === null ||
      typeof item.name !== "string" ||
      typeof item.price !== "number" ||
      typeof item.brand !== "string" ||
      typeof item.retailer !== "string"
    ) {
      continue;
    }

    const matchScore = calculateMatchScore(
      { style: item.style, name: item.name, category: item.category },
      analysis,
    );

    results.push({
      name: item.name,
      brand: item.brand,
      price: item.price,
      currency: item.currency || "USD",
      url: item.url || "",
      image_url: item.image_url || "",
      retailer: item.retailer,
      match_score: matchScore,
      category: item.category || "general",
      style: item.style || "general",
    });
  }

  // Sort by match score descending
  results.sort((a, b) => b.match_score - a.match_score);

  return results;
}

// ---------------------------------------------------------------------------
// Shopping skill invocation
// ---------------------------------------------------------------------------

export async function searchViaShopping(
  analysis: RoomAnalysis,
  category: string,
  maxResults: number = 8,
): Promise<ProductResult[]> {
  try {
    const query = buildSearchQuery(analysis, category);

    // Use Inference tool to simulate Shopping skill search
    // The Shopping skill itself would be invoked by the main Kaya system
    const prompt = `You are a shopping assistant. Search for "${query}" from home furniture retailers.
Return a JSON array of ${maxResults} products with fields:
name, brand, price (number), currency ("USD"), url, image_url, retailer, category, style

Only return the JSON array, no other text.`;

    const proc = Bun.spawn(
      ["bun", INFERENCE_TOOL, "fast"],
      {
        stdin: new Response(prompt).body!,
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env },
      },
    );

    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);

    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      console.error(`[ShoppingSkillAdapter] Inference failed (exit ${exitCode}): ${stderr.trim()}`);
      return [];
    }

    // Parse JSON array from output
    const arrayMatch = stdout.match(/\[[\s\S]*\]/);
    if (!arrayMatch) {
      console.error("[ShoppingSkillAdapter] No JSON array found in response");
      return [];
    }

    const parsed = JSON.parse(arrayMatch[0]);
    const results = parseShoppingResults(parsed, analysis);

    console.error(`[ShoppingSkillAdapter] Found ${results.length} products for "${category}"`);
    return results.slice(0, maxResults);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[ShoppingSkillAdapter] Error: ${msg}`);
    return [];
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

if (import.meta.main) {
  const category = process.argv[2] || "sofa";
  const style = process.argv[3] || "modern";

  const mockAnalysis: RoomAnalysis = {
    room_type: "living room",
    styles: [style],
    dominant_colors: [{ name: "white", hex: "#FFFFFF" }],
    lighting: "natural",
    features: [],
    confidence: 0.8,
    source: "claude",
  };

  console.log(`Searching for ${category} in ${style} style...`);
  const results = await searchViaShopping(mockAnalysis, category);
  console.log(JSON.stringify(results, null, 2));
}
