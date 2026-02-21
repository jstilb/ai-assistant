#!/usr/bin/env bun
/**
 * StyleMatcher.ts - Match photos/descriptions to design style taxonomy
 *
 * Analyzes inspiration images or text, maps to design styles,
 * compares to current room state, generates gap analysis.
 *
 * Usage:
 *   bun Tools/StyleMatcher.ts match --inspiration "warm cozy reading nook" --room living-room
 *   bun Tools/StyleMatcher.ts styles
 *   bun Tools/StyleMatcher.ts gap --room bedroom --target japandi
 *
 * @module StyleMatcher
 */

import { z } from "zod";
import { notifySync } from "../../CORE/Tools/NotificationService.ts";

const StyleSchema = z.object({
  name: z.string(),
  description: z.string(),
  keyElements: z.array(z.string()),
  colors: z.array(z.string()),
  materials: z.array(z.string()),
  avoidElements: z.array(z.string()),
  priceRange: z.enum(["budget", "moderate", "premium", "luxury"]),
});

type DesignStyle = z.infer<typeof StyleSchema>;

const STYLE_TAXONOMY: Record<string, DesignStyle> = {
  hygge: {
    name: "Hygge",
    description: "Danish coziness — warm, intimate, comforting spaces",
    keyElements: ["candles", "throw blankets", "soft textures", "warm lighting", "natural materials", "books", "cushions"],
    colors: ["warm white", "cream", "soft grey", "muted earth tones", "dusty rose"],
    materials: ["wool", "linen", "wood", "sheepskin", "ceramic"],
    avoidElements: ["harsh lighting", "chrome/steel", "minimalist empty spaces", "cold colors"],
    priceRange: "moderate",
  },
  japandi: {
    name: "Japandi",
    description: "Japanese minimalism meets Scandinavian warmth",
    keyElements: ["clean lines", "natural materials", "purposeful objects", "indoor plants", "handcrafted ceramics", "low furniture"],
    colors: ["warm beige", "sage green", "charcoal", "terracotta", "cream"],
    materials: ["light wood", "bamboo", "linen", "stone", "handmade pottery"],
    avoidElements: ["clutter", "bright colors", "ornate patterns", "plastic"],
    priceRange: "moderate",
  },
  boho: {
    name: "Bohemian",
    description: "Eclectic, layered, globally-inspired with rich textures",
    keyElements: ["layered textiles", "plants", "macramé", "vintage pieces", "global patterns", "floor cushions"],
    colors: ["terracotta", "mustard", "deep teal", "burgundy", "burnt orange"],
    materials: ["rattan", "jute", "cotton", "velvet", "brass"],
    avoidElements: ["matchy-matchy sets", "minimalism", "stark white"],
    priceRange: "budget",
  },
  "modern-cozy": {
    name: "Modern Cozy",
    description: "Contemporary clean lines softened with warm textures",
    keyElements: ["plush sofa", "soft rugs", "warm lighting", "modern art", "textured throw pillows"],
    colors: ["warm grey", "navy", "cream", "blush", "forest green"],
    materials: ["bouclé", "velvet", "marble", "brushed brass", "soft leather"],
    avoidElements: ["harsh angles", "industrial pipes", "cold metals"],
    priceRange: "moderate",
  },
  cottagecore: {
    name: "Cottagecore",
    description: "Romantic rural aesthetic with vintage charm",
    keyElements: ["floral prints", "vintage furniture", "fresh flowers", "handmade quilts", "open shelving", "natural light"],
    colors: ["sage green", "lavender", "butter yellow", "soft pink", "cream"],
    materials: ["cotton", "lace", "reclaimed wood", "copper", "wicker"],
    avoidElements: ["modern minimalism", "dark colors", "technology visible"],
    priceRange: "budget",
  },
  "mid-century": {
    name: "Mid-Century Modern",
    description: "1950s-60s inspired clean lines and organic forms",
    keyElements: ["tapered legs", "organic curves", "statement lighting", "bold art", "walnut furniture"],
    colors: ["mustard", "olive green", "burnt orange", "teal", "warm wood tones"],
    materials: ["walnut", "teak", "leather", "brass", "glass"],
    avoidElements: ["ornate details", "heavy drapery", "rustic/farmhouse elements"],
    priceRange: "premium",
  },
  scandinavian: {
    name: "Scandinavian",
    description: "Light, airy, functional with subtle warmth",
    keyElements: ["white walls", "functional furniture", "plants", "cozy textiles", "natural light maximized"],
    colors: ["white", "light grey", "pale wood", "black accents", "muted pastels"],
    materials: ["birch", "pine", "wool", "linen", "concrete"],
    avoidElements: ["dark walls", "heavy furniture", "excessive decoration"],
    priceRange: "moderate",
  },
};

interface StyleMatch {
  style: string;
  confidence: number;
  matchingElements: string[];
  missingElements: string[];
  colorAlignment: number;
}

export function matchStyle(description: string): StyleMatch[] {
  const lower = description.toLowerCase();
  const matches: StyleMatch[] = [];

  for (const [key, style] of Object.entries(STYLE_TAXONOMY)) {
    let score = 0;
    const matching: string[] = [];
    const missing: string[] = [];

    // Check key elements
    for (const element of style.keyElements) {
      if (lower.includes(element.toLowerCase())) {
        score += 2;
        matching.push(element);
      } else {
        missing.push(element);
      }
    }

    // Check colors
    let colorScore = 0;
    for (const color of style.colors) {
      if (lower.includes(color.toLowerCase())) colorScore++;
    }

    // Check materials
    for (const material of style.materials) {
      if (lower.includes(material.toLowerCase())) score += 1;
    }

    // Check style name/description match
    if (lower.includes(key) || lower.includes(style.name.toLowerCase())) score += 5;
    for (const word of style.description.toLowerCase().split(" ")) {
      if (word.length > 4 && lower.includes(word)) score += 0.5;
    }

    const maxScore = style.keyElements.length * 2 + style.materials.length + 5;
    matches.push({
      style: style.name,
      confidence: Math.min(score / maxScore, 1),
      matchingElements: matching,
      missingElements: missing.slice(0, 5),
      colorAlignment: style.colors.length > 0 ? colorScore / style.colors.length : 0,
    });
  }

  return matches.sort((a, b) => b.confidence - a.confidence).slice(0, 3);
}

export function getStyleDetails(styleName: string): DesignStyle | null {
  const key = styleName.toLowerCase().replace(/\s+/g, "-");
  return STYLE_TAXONOMY[key] ?? null;
}

export function generateGapAnalysis(currentDescription: string, targetStyle: string): {
  target: DesignStyle;
  toAdd: string[];
  toRemove: string[];
  colorChanges: string[];
  productCategories: string[];
} | null {
  const style = getStyleDetails(targetStyle);
  if (!style) return null;

  const lower = currentDescription.toLowerCase();
  const toAdd = style.keyElements.filter(e => !lower.includes(e.toLowerCase()));
  const toRemove = style.avoidElements.filter(e => lower.includes(e.toLowerCase()));
  const colorChanges = style.colors.filter(c => !lower.includes(c.toLowerCase()));

  const productCategories = new Set<string>();
  toAdd.forEach(element => {
    if (element.includes("light")) productCategories.add("lighting");
    if (element.includes("blanket") || element.includes("textile") || element.includes("cushion") || element.includes("pillow")) productCategories.add("textiles");
    if (element.includes("plant")) productCategories.add("plants");
    if (element.includes("art") || element.includes("print")) productCategories.add("wall art");
    if (element.includes("rug")) productCategories.add("rugs");
    if (element.includes("furniture") || element.includes("sofa") || element.includes("chair")) productCategories.add("furniture");
    if (element.includes("candle")) productCategories.add("candles & decor");
  });

  return {
    target: style,
    toAdd,
    toRemove,
    colorChanges,
    productCategories: [...productCategories],
  };
}

export function listStyles(): string[] {
  return Object.values(STYLE_TAXONOMY).map(s => s.name);
}

// CLI entrypoint
if (import.meta.main) {
  const args = process.argv.slice(2);
  const command = args[0];
  const jsonOutput = args.includes("--json");

  switch (command) {
    case "match": {
      const inspiration = args.includes("--inspiration") ? args[args.indexOf("--inspiration") + 1] : args[1];
      if (!inspiration) { console.log("Usage: bun Tools/StyleMatcher.ts match --inspiration <description> [--json]"); break; }
      const matches = matchStyle(inspiration);
      if (jsonOutput) {
        console.log(JSON.stringify(matches, null, 2));
      } else {
        console.log(`\nStyle Matches for "${inspiration}":\n`);
        matches.forEach((m, i) => {
          console.log(`${i + 1}. ${m.style} (${(m.confidence * 100).toFixed(0)}% match)`);
          if (m.matchingElements.length) console.log(`   Matching: ${m.matchingElements.join(", ")}`);
          if (m.missingElements.length) console.log(`   To add: ${m.missingElements.join(", ")}`);
        });
        notifySync(`Style matched: top result is ${matches[0]?.style ?? "unknown"}`);
      }
      break;
    }
    case "styles": {
      if (jsonOutput) {
        console.log(JSON.stringify(STYLE_TAXONOMY, null, 2));
      } else {
        console.log("\nAvailable Design Styles:\n");
        Object.values(STYLE_TAXONOMY).forEach(s => {
          console.log(`  ${s.name} -- ${s.description}`);
          console.log(`    Colors: ${s.colors.join(", ")}`);
          console.log(`    Key: ${s.keyElements.slice(0, 4).join(", ")}`);
          console.log();
        });
      }
      break;
    }
    case "gap": {
      const target = args.includes("--target") ? args[args.indexOf("--target") + 1] : args[1];
      if (!target) { console.log("Usage: bun Tools/StyleMatcher.ts gap --target <style> [--current <desc>] [--json]"); break; }
      const current = args.includes("--current") ? args[args.indexOf("--current") + 1] : "";
      const gap = generateGapAnalysis(current, target);
      if (!gap) { console.log(`Style "${target}" not found. Available: ${listStyles().join(", ")}`); break; }
      if (jsonOutput) {
        console.log(JSON.stringify(gap, null, 2));
      } else {
        console.log(`\nGap Analysis to ${gap.target.name}:\n`);
        console.log(`To Add: ${gap.toAdd.join(", ")}`);
        if (gap.toRemove.length) console.log(`To Remove: ${gap.toRemove.join(", ")}`);
        console.log(`Colors to Introduce: ${gap.colorChanges.join(", ")}`);
        console.log(`Shopping Categories: ${gap.productCategories.join(", ")}`);
        notifySync(`Gap analysis complete for ${gap.target.name} style`);
      }
      break;
    }
    default:
      console.log("Commands: match, styles, gap");
      console.log("Flags: --json (structured JSON output)");
  }
}
