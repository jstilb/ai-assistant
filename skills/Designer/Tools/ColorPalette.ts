#!/usr/bin/env bun
/**
 * ColorPalette.ts - Cohesive color scheme generation
 *
 * Generates palettes using color theory with the 60-30-10 rule,
 * specific paint brand recommendations, and color psychology.
 *
 * Usage:
 *   bun Tools/ColorPalette.ts generate --style "warm cozy" --fixed "oak floors, white trim"
 *   bun Tools/ColorPalette.ts brands --color "warm grey"
 *
 * @module ColorPalette
 */

import { z } from "zod";
import { notifySync } from "../../CORE/Tools/NotificationService.ts";

interface ColorEntry {
  name: string;
  hex: string;
  role: "wall" | "furniture" | "accent" | "trim" | "neutral";
  percentage: number;
  psychology: string;
}

interface PaintRecommendation {
  brand: string;
  name: string;
  code: string;
  colorFamily: string;
}

interface ColorPaletteResult {
  name: string;
  mood: string;
  colors: ColorEntry[];
  rule: string;
  paints: PaintRecommendation[];
  complementaryAccents: string[];
  avoidWith: string[];
}

// Curated palette presets
const PALETTE_PRESETS: Record<string, ColorPaletteResult> = {
  "warm-cozy": {
    name: "Warm Cozy",
    mood: "Inviting, intimate, relaxed",
    rule: "60% warm neutrals, 30% rich mid-tones, 10% deep accents",
    colors: [
      { name: "Warm Linen", hex: "#F5E6D3", role: "wall", percentage: 60, psychology: "Warmth, comfort, openness" },
      { name: "Camel", hex: "#C19A6B", role: "furniture", percentage: 20, psychology: "Grounding, natural, reliable" },
      { name: "Terracotta", hex: "#CC5C3B", role: "accent", percentage: 10, psychology: "Energy, creativity, warmth" },
      { name: "Cream White", hex: "#FFFDD0", role: "trim", percentage: 5, psychology: "Clean, airy, classic" },
      { name: "Charcoal", hex: "#36454F", role: "accent", percentage: 5, psychology: "Depth, sophistication, anchor" },
    ],
    paints: [
      { brand: "Benjamin Moore", name: "White Dove", code: "OC-17", colorFamily: "Warm White" },
      { brand: "Benjamin Moore", name: "Muslin", code: "OC-12", colorFamily: "Warm Neutral" },
      { brand: "Sherwin-Williams", name: "Accessible Beige", code: "SW 7036", colorFamily: "Warm Neutral" },
      { brand: "Sherwin-Williams", name: "Cavern Clay", code: "SW 7701", colorFamily: "Terracotta" },
    ],
    complementaryAccents: ["brass fixtures", "warm wood tones", "ivory ceramics", "amber glass", "soft gold"],
    avoidWith: ["cool greys", "stark white", "chrome/silver", "neon colors"],
  },
  "serene-minimal": {
    name: "Serene Minimal",
    mood: "Calm, focused, airy",
    rule: "60% pale neutrals, 30% soft mid-tones, 10% organic accents",
    colors: [
      { name: "Cloud White", hex: "#F2F0EB", role: "wall", percentage: 60, psychology: "Clarity, peace, spaciousness" },
      { name: "Pale Sage", hex: "#C5CFC0", role: "furniture", percentage: 20, psychology: "Nature, balance, renewal" },
      { name: "Warm Stone", hex: "#AFA99E", role: "neutral", percentage: 10, psychology: "Stability, timelessness" },
      { name: "Soft Black", hex: "#2C2C2C", role: "accent", percentage: 5, psychology: "Contrast, definition" },
      { name: "Natural Oak", hex: "#D4A76A", role: "accent", percentage: 5, psychology: "Warmth, organic connection" },
    ],
    paints: [
      { brand: "Benjamin Moore", name: "Chantilly Lace", code: "OC-65", colorFamily: "Pure White" },
      { brand: "Benjamin Moore", name: "Palladian Blue", code: "HC-144", colorFamily: "Sage" },
      { brand: "Sherwin-Williams", name: "Agreeable Gray", code: "SW 7029", colorFamily: "Warm Grey" },
    ],
    complementaryAccents: ["matte black hardware", "light wood", "white linen", "stone", "dried grasses"],
    avoidWith: ["bold patterns", "heavy textures", "warm reds/oranges", "glossy finishes"],
  },
  "moody-rich": {
    name: "Moody Rich",
    mood: "Dramatic, sophisticated, enveloping",
    rule: "60% deep tones, 30% warm mid-tones, 10% metallic/light accents",
    colors: [
      { name: "Deep Navy", hex: "#1B2A4A", role: "wall", percentage: 60, psychology: "Depth, intellect, calm authority" },
      { name: "Cognac", hex: "#9A463D", role: "furniture", percentage: 20, psychology: "Richness, warmth, maturity" },
      { name: "Aged Brass", hex: "#B5A642", role: "accent", percentage: 10, psychology: "Luxury, warmth, patina" },
      { name: "Cream", hex: "#FFFDD0", role: "trim", percentage: 5, psychology: "Relief, brightness, contrast" },
      { name: "Forest Green", hex: "#228B22", role: "accent", percentage: 5, psychology: "Nature, freshness, balance" },
    ],
    paints: [
      { brand: "Benjamin Moore", name: "Hale Navy", code: "HC-154", colorFamily: "Navy" },
      { brand: "Sherwin-Williams", name: "Naval", code: "SW 6244", colorFamily: "Deep Blue" },
      { brand: "Benjamin Moore", name: "Newburyport Blue", code: "HC-155", colorFamily: "Navy" },
    ],
    complementaryAccents: ["aged brass", "leather", "dark walnut", "velvet", "mercury glass"],
    avoidWith: ["pastels", "chrome", "light pine", "plastic"],
  },
};

export function generatePalette(style: string, fixedElements?: string): ColorPaletteResult | null {
  const key = style.toLowerCase().replace(/\s+/g, "-");

  // Direct match
  if (PALETTE_PRESETS[key]) return PALETTE_PRESETS[key];

  // Keyword match
  const lower = style.toLowerCase();
  if (lower.includes("warm") || lower.includes("cozy")) return PALETTE_PRESETS["warm-cozy"];
  if (lower.includes("serene") || lower.includes("minimal") || lower.includes("calm")) return PALETTE_PRESETS["serene-minimal"];
  if (lower.includes("moody") || lower.includes("dark") || lower.includes("dramatic")) return PALETTE_PRESETS["moody-rich"];

  return PALETTE_PRESETS["warm-cozy"]; // Default
}

export function getPaintRecommendations(colorFamily: string): PaintRecommendation[] {
  const all = Object.values(PALETTE_PRESETS).flatMap(p => p.paints);
  const lower = colorFamily.toLowerCase();
  return all.filter(p =>
    p.colorFamily.toLowerCase().includes(lower) ||
    p.name.toLowerCase().includes(lower)
  );
}

export function listPalettes(): string[] {
  return Object.values(PALETTE_PRESETS).map(p => `${p.name} — ${p.mood}`);
}

// CLI entrypoint
if (import.meta.main) {
  const args = process.argv.slice(2);
  const command = args[0];
  const jsonOutput = args.includes("--json");

  switch (command) {
    case "generate": {
      const style = args.includes("--style") ? args[args.indexOf("--style") + 1] : "warm cozy";
      const fixed = args.includes("--fixed") ? args[args.indexOf("--fixed") + 1] : undefined;
      const palette = generatePalette(style, fixed);
      if (!palette) { console.log("No palette found."); break; }

      if (jsonOutput) {
        console.log(JSON.stringify(palette, null, 2));
      } else {
        console.log(`\n${palette.name} Palette\n`);
        console.log(`Mood: ${palette.mood}`);
        console.log(`Rule: ${palette.rule}\n`);
        palette.colors.forEach(c => {
          console.log(`  ${c.hex} ${c.name} (${c.role}, ${c.percentage}%) -- ${c.psychology}`);
        });
        console.log(`\nPaint Recommendations:`);
        palette.paints.forEach(p => console.log(`  ${p.brand} "${p.name}" (${p.code})`));
        console.log(`\nPairs well with: ${palette.complementaryAccents.join(", ")}`);
        console.log(`Avoid: ${palette.avoidWith.join(", ")}`);
        notifySync(`Generated ${palette.name} color palette with ${palette.paints.length} paint recommendations`);
      }
      break;
    }
    case "brands": {
      const color = args.includes("--color") ? args[args.indexOf("--color") + 1] : args[1];
      if (!color) { console.log("Usage: bun Tools/ColorPalette.ts brands --color <family> [--json]"); break; }
      const paints = getPaintRecommendations(color);
      if (paints.length === 0) { console.log(`No paint recs found for "${color}".`); break; }
      if (jsonOutput) {
        console.log(JSON.stringify(paints, null, 2));
      } else {
        console.log(`\nPaint Recommendations for "${color}":\n`);
        paints.forEach(p => console.log(`  ${p.brand} "${p.name}" (${p.code}) -- ${p.colorFamily}`));
      }
      break;
    }
    case "list": {
      if (jsonOutput) {
        console.log(JSON.stringify(Object.values(PALETTE_PRESETS).map(p => ({ name: p.name, mood: p.mood })), null, 2));
      } else {
        console.log("\nAvailable Palettes:\n");
        listPalettes().forEach(p => console.log(`  - ${p}`));
      }
      break;
    }
    default:
      console.log("Commands: generate, brands, list");
      console.log("Flags: --json (structured JSON output)");
  }
}
