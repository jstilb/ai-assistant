#!/usr/bin/env bun
/**
 * MapPrompt.ts - D&D Map Generator via Gemini Image Generation
 *
 * Generates D&D maps using map-templates.json and Gemini image generation.
 * Supports battlemap, dungeon, regional, and world map types.
 *
 * @module MapPrompt
 * @version 1.0.0
 */

import { join, dirname } from "path";
import { mkdirSync, existsSync, readFileSync } from "fs";

// ============================================
// TYPES
// ============================================

export interface MapTemplate {
  id: string;
  name: string;
  type: string;
  width?: number;
  height?: number;
  gridSize?: number;
  terrain?: Array<{ type: string; [key: string]: any }>;
  entries?: any[];
  exits?: any[];
  lighting?: string;
  description: string;
}

export interface MapPromptOptions {
  type: "battlemap" | "dungeon" | "regional" | "world";
  theme: string;
  features?: string[];
  grid?: number;
  imageSize?: string;
}

// ============================================
// DATA LOADING
// ============================================

let mapTemplates: { templates: MapTemplate[] } | null = null;

function loadMapTemplates(): MapTemplate[] {
  if (mapTemplates) return mapTemplates.templates;
  const dataPath = join(dirname(import.meta.dir), "Data", "map-templates.json");
  mapTemplates = JSON.parse(readFileSync(dataPath, "utf-8"));
  return mapTemplates!.templates;
}

// ============================================
// TEMPLATE FILTERING
// ============================================

/**
 * Get templates that match a given map type.
 * - battlemap: wilderness and urban templates
 * - dungeon: dungeon templates
 * - regional/world: all templates (used as inspiration)
 */
export function getTemplatesByType(type: string): MapTemplate[] {
  const templates = loadMapTemplates();

  switch (type) {
    case "battlemap":
      return templates.filter((t) => t.type === "wilderness" || t.type === "urban");
    case "dungeon":
      return templates.filter((t) => t.type === "dungeon");
    case "regional":
    case "world":
      return templates; // All templates serve as inspiration
    default:
      return templates;
  }
}

// ============================================
// FEATURE FILLING
// ============================================

/**
 * Fill a template's features with user-provided features.
 * Returns a descriptive string combining template terrain and user features.
 */
export function fillTemplateFeatures(
  template: Pick<MapTemplate, "description" | "terrain" | "name" | "type">,
  features: string[]
): string {
  const parts: string[] = [];

  // Include template info
  parts.push(template.description);

  // Include terrain types from template
  if (template.terrain && template.terrain.length > 0) {
    const terrainTypes = template.terrain.map((t) => t.type.replace(/_/g, " "));
    const uniqueTerrain = [...new Set(terrainTypes)];
    parts.push(`Terrain features: ${uniqueTerrain.join(", ")}.`);
  }

  // Include user-provided features
  if (features.length > 0) {
    parts.push(`Additional features: ${features.join(", ")}.`);
  }

  return parts.join(" ");
}

// ============================================
// PROMPT CONSTRUCTION
// ============================================

/**
 * Build a complete map generation prompt.
 */
export function buildMapPrompt(opts: MapPromptOptions): string {
  const templates = getTemplatesByType(opts.type);
  const parts: string[] = [];

  // Map type prefix
  switch (opts.type) {
    case "battlemap":
      parts.push(`D&D 5e top-down battle map for tabletop RPG combat encounters.`);
      parts.push(`Theme: ${opts.theme}.`);
      break;
    case "dungeon":
      parts.push(`D&D 5e top-down dungeon map for tabletop RPG exploration.`);
      parts.push(`Theme: ${opts.theme}.`);
      break;
    case "regional":
      parts.push(`D&D 5e regional map showing a fantasy landscape.`);
      parts.push(`Theme: ${opts.theme}.`);
      break;
    case "world":
      parts.push(`D&D 5e world map showing continents, oceans, and major geographic features.`);
      parts.push(`Theme: ${opts.theme}.`);
      break;
  }

  // Pick a random matching template for inspiration if available
  if (templates.length > 0) {
    const template = templates[Math.floor(Math.random() * templates.length)];
    const filled = fillTemplateFeatures(template, opts.features || []);
    parts.push(`Inspired by: ${filled}`);
  } else if (opts.features && opts.features.length > 0) {
    parts.push(`Must include: ${opts.features.join(", ")}.`);
  }

  // Grid specification
  if (opts.grid) {
    parts.push(`Square grid overlay, ${opts.grid} pixels per square.`);
  } else if (opts.type === "battlemap" || opts.type === "dungeon") {
    parts.push(`Square grid overlay for tactical movement.`);
  }

  // Quality descriptors
  parts.push("High quality, detailed, professional cartography style.");
  parts.push("Clean lines, clear terrain boundaries, suitable for VTT use.");

  return parts.join(" ");
}

// ============================================
// OUTPUT PATH
// ============================================

/**
 * Generate the output file path for a map.
 */
export function getMapOutputPath(type: string, theme: string): string {
  const slug = theme
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
  const timestamp = Date.now();
  const dir = join(process.env.HOME!, "Downloads", "dnd-maps");
  return join(dir, `${type}-${slug}-${timestamp}.png`);
}

// ============================================
// MAP GENERATION (calls Art skill CLI)
// ============================================

async function generateMap(
  prompt: string,
  outputPath: string,
  imageSize?: string
): Promise<string> {
  const dir = join(process.env.HOME!, "Downloads", "dnd-maps");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const generateScript = join(
    process.env.HOME!,
    ".claude",
    "skills",
    "Art",
    "Tools",
    "Generate.ts"
  );

  const size = imageSize || "2K";
  const args = [
    "run",
    generateScript,
    "--model", "nano-banana-pro",
    "--prompt", prompt,
    "--size", size,
    "--aspect-ratio", "1:1",
    "--output", outputPath,
  ];

  const proc = Bun.spawn(["bun", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const exitCode = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();

  if (exitCode !== 0) {
    throw new Error(`Map generation failed: ${stderr || stdout}`);
  }

  return outputPath;
}

// ============================================
// CLI
// ============================================

if (import.meta.main) {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    console.log(`
MapPrompt - D&D Map Generator

Usage:
  bun MapPrompt.ts --type <type> --theme <theme> [OPTIONS]
  bun MapPrompt.ts --help

Options:
  --type <type>        Map type: battlemap, dungeon, regional, world
  --theme <theme>      Map theme (e.g. "forest", "ancient ruins", "volcanic")
  --features <list>    Comma-separated features to include (e.g. "river, bridge, campfire")
  --grid <n>           Grid size in pixels per square (default: auto)
  --size <size>        Image dimensions (default: "2K")
  --json               Output result as JSON
  --help               Show this help
`);
    process.exit(0);
  }

  const jsonOutput = args.includes("--json");
  const typeIdx = args.indexOf("--type");
  const themeIdx = args.indexOf("--theme");
  const featuresIdx = args.indexOf("--features");
  const gridIdx = args.indexOf("--grid");
  const sizeIdx = args.indexOf("--size");

  if (typeIdx === -1 || themeIdx === -1) {
    console.error("Error: --type and --theme are required. Use --help for usage.");
    process.exit(1);
  }

  const opts: MapPromptOptions = {
    type: args[typeIdx + 1] as MapPromptOptions["type"],
    theme: args[themeIdx + 1],
  };

  if (featuresIdx !== -1) {
    opts.features = args[featuresIdx + 1].split(",").map((f) => f.trim());
  }
  if (gridIdx !== -1) {
    opts.grid = parseInt(args[gridIdx + 1]);
  }
  if (sizeIdx !== -1) {
    opts.imageSize = args[sizeIdx + 1];
  }

  try {
    const prompt = buildMapPrompt(opts);
    const outputPath = getMapOutputPath(opts.type, opts.theme);

    if (jsonOutput) {
      console.log(JSON.stringify({
        prompt,
        outputPath,
        options: opts,
        status: "generating",
      }, null, 2));
    } else {
      console.log(`Generating ${opts.type} map: ${opts.theme}...`);
      console.log(`Prompt: ${prompt}`);
    }

    const result = await generateMap(prompt, outputPath, opts.imageSize);

    if (jsonOutput) {
      console.log(JSON.stringify({
        success: true,
        outputPath: result,
        prompt,
        options: opts,
      }, null, 2));
    } else {
      console.log(`Map saved to: ${result}`);
    }
  } catch (e) {
    if (jsonOutput) {
      console.log(JSON.stringify({
        success: false,
        error: e instanceof Error ? e.message : String(e),
      }, null, 2));
    } else {
      console.error("Error:", e instanceof Error ? e.message : e);
    }
    process.exit(1);
  }
}
