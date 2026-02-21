#!/usr/bin/env bun
/**
 * MoodBoardGenerator.ts - Generate mood boards from room analysis data
 *
 * Extracts palette colors from RoomAnalysis dominant_colors, detects color
 * harmony, and attaches curated style reference images based on detected style.
 *
 * Usage:
 *   import { generateMoodBoard, extractPalette, detectColorHarmony } from './MoodBoardGenerator';
 *   const board = generateMoodBoard(roomAnalysis);
 *
 * @module MoodBoardGenerator
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MoodBoard {
  palette: Array<{ name: string; hex: string; weight: number }>;
  style_keywords: string[];
  reference_images: Array<{ url: string; style: string; description: string }>;
  color_harmony: "complementary" | "analogous" | "triadic" | "monochromatic";
}

interface RoomColors {
  dominant: string[];
  accent: string[];
  mood: string;
}

interface RoomStyle {
  primary: string;
  secondary?: string;
  cohesionScore: number;
}

interface RoomAnalysisInput {
  colors: RoomColors;
  style: RoomStyle;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Color name mapping (hex -> human-readable)
// ---------------------------------------------------------------------------

const COLOR_NAMES: Record<string, string> = {
  "#F5E6D3": "Warm Linen",
  "#C19A6B": "Camel",
  "#36454F": "Charcoal",
  "#CC5C3B": "Terracotta",
  "#FFFDD0": "Cream",
  "#1B2A4A": "Deep Navy",
  "#9A463D": "Cognac",
  "#B5A642": "Aged Brass",
  "#228B22": "Forest Green",
  "#F2F0EB": "Cloud White",
  "#C5CFC0": "Pale Sage",
  "#AFA99E": "Warm Stone",
  "#2C2C2C": "Soft Black",
  "#D4A76A": "Natural Oak",
  "#FFFFFF": "Pure White",
  "#000000": "Black",
  "#FF0000": "Red",
  "#00FF00": "Green",
  "#0000FF": "Blue",
  "#FFFF00": "Yellow",
  "#FF8800": "Orange",
  "#00FFFF": "Cyan",
  "#FF00FF": "Magenta",
  "#808080": "Grey",
};

function getColorName(hex: string): string {
  const upper = hex.toUpperCase();
  if (COLOR_NAMES[upper]) return COLOR_NAMES[upper];

  // Generate a descriptive name from the hex value based on hue
  const { h, s, l } = hexToHSL(hex);

  if (s < 10) {
    if (l > 90) return "Off White";
    if (l > 60) return "Light Grey";
    if (l > 30) return "Medium Grey";
    return "Dark Grey";
  }

  const hueNames: [number, string][] = [
    [15, "Red"],
    [45, "Orange"],
    [65, "Gold"],
    [80, "Yellow"],
    [150, "Green"],
    [200, "Teal"],
    [250, "Blue"],
    [290, "Purple"],
    [330, "Pink"],
    [360, "Red"],
  ];

  let hueName = "Color";
  for (const [boundary, name] of hueNames) {
    if (h <= boundary) {
      hueName = name;
      break;
    }
  }

  const lightPrefix = l > 70 ? "Light " : l < 30 ? "Deep " : "";
  const satSuffix = s < 40 ? " Muted" : "";

  return `${lightPrefix}${hueName}${satSuffix}`;
}

// ---------------------------------------------------------------------------
// Color math utilities
// ---------------------------------------------------------------------------

function hexToRGB(hex: string): { r: number; g: number; b: number } {
  const clean = hex.replace("#", "");
  return {
    r: parseInt(clean.slice(0, 2), 16),
    g: parseInt(clean.slice(2, 4), 16),
    b: parseInt(clean.slice(4, 6), 16),
  };
}

function hexToHSL(hex: string): { h: number; s: number; l: number } {
  const { r, g, b } = hexToRGB(hex);
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;

  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;

  if (max === min) {
    return { h: 0, s: 0, l: l * 100 };
  }

  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);

  let h = 0;
  switch (max) {
    case rn:
      h = ((gn - bn) / d + (gn < bn ? 6 : 0)) * 60;
      break;
    case gn:
      h = ((bn - rn) / d + 2) * 60;
      break;
    case bn:
      h = ((rn - gn) / d + 4) * 60;
      break;
  }

  return { h, s: s * 100, l: l * 100 };
}

function hueDifference(h1: number, h2: number): number {
  const diff = Math.abs(h1 - h2);
  return Math.min(diff, 360 - diff);
}

// ---------------------------------------------------------------------------
// Palette extraction
// ---------------------------------------------------------------------------

export function extractPalette(
  colors: RoomColors
): Array<{ name: string; hex: string; weight: number }> {
  const allColors: Array<{ hex: string; isDominant: boolean }> = [];

  for (const hex of colors.dominant) {
    allColors.push({ hex: hex.toUpperCase(), isDominant: true });
  }
  for (const hex of colors.accent) {
    allColors.push({ hex: hex.toUpperCase(), isDominant: false });
  }

  // Limit to top 5 colors
  const selected = allColors.slice(0, 5);

  if (selected.length === 0) {
    return [{ name: "Neutral", hex: "#808080", weight: 1.0 }];
  }

  // Assign weights: dominant get higher weight
  const dominantCount = selected.filter(c => c.isDominant).length;
  const accentCount = selected.length - dominantCount;

  // Dominant colors share 70% weight, accent share 30%
  const dominantWeight = dominantCount > 0 ? 0.7 / dominantCount : 0;
  const accentWeight = accentCount > 0 ? 0.3 / accentCount : 0;

  // If no accent colors, all weight goes to dominant
  const effectiveDominantWeight = accentCount === 0
    ? 1.0 / dominantCount
    : dominantWeight;
  const effectiveAccentWeight = dominantCount === 0
    ? 1.0 / accentCount
    : accentWeight;

  return selected.map(c => ({
    name: getColorName(c.hex),
    hex: c.hex,
    weight: c.isDominant ? effectiveDominantWeight : effectiveAccentWeight,
  }));
}

// ---------------------------------------------------------------------------
// Color harmony detection
// ---------------------------------------------------------------------------

export function detectColorHarmony(
  hexColors: string[]
): "complementary" | "analogous" | "triadic" | "monochromatic" {
  if (hexColors.length <= 1) return "monochromatic";

  const hsls = hexColors.map(hexToHSL);

  // Filter out very desaturated colors (greys/whites/blacks) from hue analysis
  const chromatic = hsls.filter(c => c.s > 10);

  if (chromatic.length <= 1) return "monochromatic";

  // Check max hue spread
  const hues = chromatic.map(c => c.h);
  const diffs: number[] = [];
  for (let i = 0; i < hues.length; i++) {
    for (let j = i + 1; j < hues.length; j++) {
      diffs.push(hueDifference(hues[i], hues[j]));
    }
  }

  const maxDiff = Math.max(...diffs);
  const avgDiff = diffs.reduce((a, b) => a + b, 0) / diffs.length;

  // Monochromatic: all hues within 30 degrees
  if (maxDiff < 30) return "monochromatic";

  // Complementary: two groups roughly 180 degrees apart
  if (diffs.some(d => d > 150 && d < 210)) return "complementary";

  // Triadic: hues roughly 120 degrees apart
  if (chromatic.length >= 3 && avgDiff > 90 && avgDiff < 150) return "triadic";

  // Analogous: hues within 90 degrees
  if (maxDiff < 90) return "analogous";

  // Default to analogous for warm palettes
  return "analogous";
}

// ---------------------------------------------------------------------------
// Style reference images (curated database)
// ---------------------------------------------------------------------------

interface StyleReference {
  url: string;
  style: string;
  description: string;
  keywords: string[];
}

const STYLE_REFERENCES: StyleReference[] = [
  // Modern Cozy
  {
    url: "https://images.unsplash.com/photo-1616046229478-9901c5536a45",
    style: "Modern Cozy",
    description: "Warm living room with plush sofa and layered textiles",
    keywords: ["modern", "cozy", "warm", "living room", "plush"],
  },
  {
    url: "https://images.unsplash.com/photo-1600210492486-724fe5c67fb0",
    style: "Modern Cozy",
    description: "Contemporary reading nook with soft lighting and neutral tones",
    keywords: ["modern", "cozy", "reading", "neutral", "warm"],
  },
  {
    url: "https://images.unsplash.com/photo-1586023492125-27b2c045efd7",
    style: "Modern Cozy",
    description: "Open plan living with warm wood accents and textured fabrics",
    keywords: ["modern", "cozy", "wood", "textured", "open"],
  },
  // Hygge
  {
    url: "https://images.unsplash.com/photo-1513694203232-719a280e022f",
    style: "Hygge",
    description: "Candlelit Scandinavian room with soft blankets and warm wood",
    keywords: ["hygge", "cozy", "candles", "scandinavian", "warm"],
  },
  {
    url: "https://images.unsplash.com/photo-1505691938895-1758d7feb511",
    style: "Hygge",
    description: "Intimate corner with sheepskin, knitted throws, and tea",
    keywords: ["hygge", "intimate", "knitted", "sheepskin", "comfort"],
  },
  {
    url: "https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d",
    style: "Hygge",
    description: "Warm minimalist bedroom with natural linen and soft light",
    keywords: ["hygge", "bedroom", "linen", "minimalist", "warm"],
  },
  // Japandi
  {
    url: "https://images.unsplash.com/photo-1600607687939-ce8a6c25118c",
    style: "Japandi",
    description: "Clean-lined living space with natural materials and low furniture",
    keywords: ["japandi", "clean", "natural", "low", "minimal"],
  },
  {
    url: "https://images.unsplash.com/photo-1600585154340-be6161a56a0c",
    style: "Japandi",
    description: "Serene room with bamboo accents and handcrafted ceramics",
    keywords: ["japandi", "serene", "bamboo", "ceramics", "handcrafted"],
  },
  {
    url: "https://images.unsplash.com/photo-1600566753086-00f18fb6b3ea",
    style: "Japandi",
    description: "Minimalist dining area with warm wood and simple pottery",
    keywords: ["japandi", "dining", "wood", "pottery", "simple"],
  },
  // Minimalist
  {
    url: "https://images.unsplash.com/photo-1600210491892-03d54c0aaf87",
    style: "Minimalist",
    description: "All-white living space with clean lines and purposeful objects",
    keywords: ["minimalist", "white", "clean", "simple", "airy"],
  },
  {
    url: "https://images.unsplash.com/photo-1600607687644-c7171b42498f",
    style: "Minimalist",
    description: "Sparse bedroom with monochrome palette and geometric forms",
    keywords: ["minimalist", "monochrome", "geometric", "bedroom"],
  },
  {
    url: "https://images.unsplash.com/photo-1600585154526-990dced4db0d",
    style: "Minimalist",
    description: "Functional kitchen with hidden storage and clean surfaces",
    keywords: ["minimalist", "kitchen", "functional", "clean"],
  },
  // Scandinavian
  {
    url: "https://images.unsplash.com/photo-1556228453-efd6c1ff04f6",
    style: "Scandinavian",
    description: "Light-filled room with birch furniture and muted pastels",
    keywords: ["scandinavian", "light", "birch", "pastel", "airy"],
  },
  {
    url: "https://images.unsplash.com/photo-1560448204-e02f11c3d0e2",
    style: "Scandinavian",
    description: "Nordic living room with wool textiles and pine accents",
    keywords: ["scandinavian", "nordic", "wool", "pine", "cozy"],
  },
  // Mid-Century Modern
  {
    url: "https://images.unsplash.com/photo-1556228578-0d85b1a4d571",
    style: "Mid-Century Modern",
    description: "Retro lounge with walnut furniture and statement lighting",
    keywords: ["mid-century", "retro", "walnut", "statement", "vintage"],
  },
  {
    url: "https://images.unsplash.com/photo-1600121848594-d8644e57abab",
    style: "Mid-Century Modern",
    description: "Living room with organic curves and bold color accents",
    keywords: ["mid-century", "organic", "bold", "curves", "modern"],
  },
  // Bohemian
  {
    url: "https://images.unsplash.com/photo-1600573472573-e1e8e5f18e2a",
    style: "Bohemian",
    description: "Eclectic living space with layered textiles and global patterns",
    keywords: ["bohemian", "boho", "eclectic", "textiles", "colorful"],
  },
  {
    url: "https://images.unsplash.com/photo-1522444195799-478538b28823",
    style: "Bohemian",
    description: "Boho bedroom with macrame, plants, and warm tones",
    keywords: ["bohemian", "boho", "macrame", "plants", "warm"],
  },
];

function findStyleReferences(
  stylePrimary: string,
  styleSecondary?: string
): Array<{ url: string; style: string; description: string }> {
  const primaryLower = stylePrimary.toLowerCase();
  const secondaryLower = styleSecondary?.toLowerCase() || "";

  // Score each reference by keyword match
  const scored = STYLE_REFERENCES.map(ref => {
    let score = 0;
    const styleLower = ref.style.toLowerCase();

    // Direct style name match gets highest score
    if (styleLower.includes(primaryLower) || primaryLower.includes(styleLower)) score += 10;
    if (secondaryLower && (styleLower.includes(secondaryLower) || secondaryLower.includes(styleLower))) score += 5;

    // Keyword overlap
    for (const kw of ref.keywords) {
      if (primaryLower.includes(kw) || kw.includes(primaryLower)) score += 2;
      if (secondaryLower && (secondaryLower.includes(kw) || kw.includes(secondaryLower))) score += 1;
    }

    return { ref, score };
  });

  // Sort by score descending, take top 3
  scored.sort((a, b) => b.score - a.score);

  // Ensure we return 2-3 references, preferring diverse styles
  const selected: Array<{ url: string; style: string; description: string }> = [];
  const usedUrls = new Set<string>();

  for (const { ref, score } of scored) {
    if (score <= 0) continue;
    if (usedUrls.has(ref.url)) continue;
    selected.push({ url: ref.url, style: ref.style, description: ref.description });
    usedUrls.add(ref.url);
    if (selected.length >= 3) break;
  }

  // If we don't have enough, fill with top-scored remaining
  if (selected.length < 2) {
    for (const { ref } of scored) {
      if (usedUrls.has(ref.url)) continue;
      selected.push({ url: ref.url, style: ref.style, description: ref.description });
      usedUrls.add(ref.url);
      if (selected.length >= 2) break;
    }
  }

  return selected;
}

// ---------------------------------------------------------------------------
// Style keywords extraction
// ---------------------------------------------------------------------------

const STYLE_KEYWORD_MAP: Record<string, string[]> = {
  "modern cozy": ["modern", "cozy", "warm textures", "plush", "inviting"],
  "hygge": ["hygge", "cozy", "candlelight", "intimate", "warm"],
  "japandi": ["japandi", "minimal", "natural materials", "zen", "functional"],
  "minimalist": ["minimalist", "clean lines", "simple", "uncluttered", "airy"],
  "scandinavian": ["scandinavian", "light", "functional", "natural", "airy"],
  "mid-century": ["mid-century", "retro", "organic forms", "statement pieces", "bold"],
  "mid-century modern": ["mid-century", "retro", "organic forms", "statement pieces", "bold"],
  "bohemian": ["bohemian", "eclectic", "layered", "global", "colorful"],
  "boho": ["bohemian", "eclectic", "layered", "global", "colorful"],
  "cottagecore": ["cottage", "romantic", "vintage", "floral", "handmade"],
  "farmhouse": ["rustic", "reclaimed", "country", "natural", "cozy"],
  "traditional": ["traditional", "classic", "elegant", "timeless", "refined"],
  "industrial": ["industrial", "raw", "exposed", "urban", "metallic"],
};

function getStyleKeywords(stylePrimary: string, styleSecondary?: string): string[] {
  const primary = stylePrimary.toLowerCase();
  const secondary = styleSecondary?.toLowerCase() || "";

  const keywords = new Set<string>();

  // Try exact match first
  if (STYLE_KEYWORD_MAP[primary]) {
    for (const kw of STYLE_KEYWORD_MAP[primary]) keywords.add(kw);
  } else {
    // Partial match
    for (const [key, kws] of Object.entries(STYLE_KEYWORD_MAP)) {
      if (primary.includes(key) || key.includes(primary)) {
        for (const kw of kws) keywords.add(kw);
        break;
      }
    }
  }

  // Add secondary style keywords
  if (secondary && STYLE_KEYWORD_MAP[secondary]) {
    for (const kw of STYLE_KEYWORD_MAP[secondary].slice(0, 2)) {
      keywords.add(kw);
    }
  }

  // If no keywords found, generate from style name
  if (keywords.size === 0) {
    keywords.add(primary);
    if (secondary) keywords.add(secondary);
    keywords.add("curated");
    keywords.add("thoughtful");
  }

  return [...keywords];
}

// ---------------------------------------------------------------------------
// Main generator
// ---------------------------------------------------------------------------

export function generateMoodBoard(roomAnalysis: RoomAnalysisInput): MoodBoard {
  const palette = extractPalette(roomAnalysis.colors);

  const allHexColors = [
    ...roomAnalysis.colors.dominant,
    ...roomAnalysis.colors.accent,
  ];

  const color_harmony = detectColorHarmony(allHexColors);

  const style_keywords = getStyleKeywords(
    roomAnalysis.style.primary,
    roomAnalysis.style.secondary
  );

  const reference_images = findStyleReferences(
    roomAnalysis.style.primary,
    roomAnalysis.style.secondary
  );

  return {
    palette,
    style_keywords,
    reference_images,
    color_harmony,
  };
}

// ---------------------------------------------------------------------------
// CLI entrypoint
// ---------------------------------------------------------------------------

if (import.meta.main) {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.length === 0) {
    console.log("Usage: bun Tools/MoodBoardGenerator.ts --style <style> [--colors <hex1,hex2,...>] [--json]");
    console.log("");
    console.log("Generate a mood board from style and color inputs.");
    console.log("Styles: modern cozy, hygge, japandi, minimalist, scandinavian, mid-century, bohemian");
    process.exit(0);
  }

  const style = args.includes("--style") ? args[args.indexOf("--style") + 1] : "modern cozy";
  const colorsArg = args.includes("--colors") ? args[args.indexOf("--colors") + 1] : "#F5E6D3,#C19A6B,#36454F";
  const jsonOutput = args.includes("--json");

  const hexColors = colorsArg.split(",").map(c => c.trim());
  const dominant = hexColors.slice(0, 3);
  const accent = hexColors.slice(3);

  const mockAnalysis: RoomAnalysisInput = {
    colors: { dominant, accent, mood: "Generated from CLI" },
    style: { primary: style, cohesionScore: 5 },
  };

  const board = generateMoodBoard(mockAnalysis);

  if (jsonOutput) {
    console.log(JSON.stringify(board, null, 2));
  } else {
    console.log("\nMood Board\n");
    console.log(`Harmony: ${board.color_harmony}`);
    console.log(`Keywords: ${board.style_keywords.join(", ")}`);
    console.log("\nPalette:");
    board.palette.forEach(c => {
      console.log(`  ${c.hex} ${c.name} (weight: ${(c.weight * 100).toFixed(0)}%)`);
    });
    console.log("\nReference Images:");
    board.reference_images.forEach(r => {
      console.log(`  [${r.style}] ${r.description}`);
      console.log(`  ${r.url}`);
    });
  }
}
