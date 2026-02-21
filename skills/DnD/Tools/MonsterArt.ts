#!/usr/bin/env bun
/**
 * MonsterArt.ts - D&D Creature Art Generator
 *
 * Generates D&D-style creature art via the Kaya Art skill (Gemini image generation).
 * Builds detailed prompts from monster attributes (type, CR, size, environment, description).
 *
 * @module MonsterArt
 * @version 1.0.0
 */

import { join } from "path";
import { mkdirSync, existsSync, readFileSync } from "fs";

// ============================================
// TYPES
// ============================================

export interface MonsterArtOptions {
  name: string;
  type: string;
  cr: number;
  style?: string;
  size?: string;
  environment?: string;
  description?: string;
  token?: boolean;
  imageSize?: string;
}

// ============================================
// CR POWER LEVEL DESCRIPTORS
// ============================================

function getCRDescriptor(cr: number): string {
  if (cr <= 0.5) return "small, weak creature, minor threat";
  if (cr <= 2) return "low-level threat, scrappy combatant";
  if (cr <= 5) return "dangerous creature, formidable fighter";
  if (cr <= 10) return "powerful monster, imposing and deadly";
  if (cr <= 15) return "terrifying apex predator, awe-inspiring";
  if (cr <= 20) return "legendary being, world-shaking power";
  return "legendary godlike entity, reality-bending presence";
}

// ============================================
// PROMPT BUILDERS
// ============================================

/**
 * Build a detailed art prompt from monster attributes.
 */
export function buildArtPrompt(opts: MonsterArtOptions): string {
  const style = opts.style || "dark fantasy";
  const crDesc = getCRDescriptor(opts.cr);
  const parts: string[] = [];

  parts.push(`D&D 5e creature concept art in ${style} style.`);
  parts.push(`A ${opts.type} called "${opts.name}".`);

  if (opts.size) {
    parts.push(`${opts.size} sized creature.`);
  }

  parts.push(`Power level: ${crDesc} (Challenge Rating ${opts.cr}).`);

  if (opts.environment) {
    parts.push(`Native to ${opts.environment} environments.`);
  }

  if (opts.description) {
    parts.push(opts.description);
  }

  parts.push("Dramatic lighting, detailed texture, high quality concept art.");
  parts.push("Full body illustration showing the complete creature in a dynamic pose.");

  return parts.join(" ");
}

/**
 * Build a circular VTT token prompt.
 */
export function buildTokenPrompt(opts: MonsterArtOptions): string {
  const parts: string[] = [];

  parts.push("Circular token portrait for virtual tabletop.");
  parts.push("Transparent background.");
  parts.push(`Head and shoulders view of a ${opts.type} creature called "${opts.name}".`);
  parts.push(`Power level: ${getCRDescriptor(opts.cr)}.`);
  parts.push("Dramatic circular framing, detailed, digital art style.");

  return parts.join(" ");
}

// ============================================
// OUTPUT PATH
// ============================================

/**
 * Generate the output file path for monster art.
 */
export function getOutputPath(name: string, isToken: boolean): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
  const suffix = isToken ? "-token" : "";
  const timestamp = Date.now();
  const dir = join(process.env.HOME!, "Downloads", "dnd-art");
  return join(dir, `${slug}${suffix}-${timestamp}.png`);
}

// ============================================
// MONSTER FILE PARSING
// ============================================

/**
 * Extract art-relevant fields from a monster JSON object.
 */
export function parseMonsterFile(monsterJson: any): MonsterArtOptions {
  const description = monsterJson.traits
    ?.map((t: any) => t.description)
    .join(". ");

  return {
    name: monsterJson.name,
    type: monsterJson.type,
    cr: monsterJson.cr,
    size: monsterJson.size,
    environment: monsterJson.environment,
    description: description || undefined,
  };
}

// ============================================
// ART GENERATION (calls Art skill CLI)
// ============================================

async function generateArt(
  prompt: string,
  outputPath: string,
  imageSize?: string
): Promise<string> {
  const dir = join(process.env.HOME!, "Downloads", "dnd-art");
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
    throw new Error(`Art generation failed: ${stderr || stdout}`);
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
MonsterArt - D&D Creature Art Generator

Usage:
  bun MonsterArt.ts --name <name> --type <type> --cr <n> [OPTIONS]
  bun MonsterArt.ts --file <monster.json> [OPTIONS]
  bun MonsterArt.ts --help

Options:
  --name <name>        Creature name
  --type <type>        Creature type (beast, dragon, undead, etc.)
  --cr <n>             Challenge Rating (0-30)
  --style <style>      Art style (default: "dark fantasy")
  --size <WxH>         Image dimensions (default: "2K")
  --token              Generate a VTT token (circular crop, transparent bg)
  --file <path>        Read monster JSON file and auto-generate prompt
  --json               Output result as JSON
  --help               Show this help
`);
    process.exit(0);
  }

  const jsonOutput = args.includes("--json");
  const isToken = args.includes("--token");
  const nameIdx = args.indexOf("--name");
  const typeIdx = args.indexOf("--type");
  const crIdx = args.indexOf("--cr");
  const styleIdx = args.indexOf("--style");
  const sizeIdx = args.indexOf("--size");
  const fileIdx = args.indexOf("--file");

  let opts: MonsterArtOptions;

  if (fileIdx !== -1) {
    // Read from monster JSON file
    const filePath = args[fileIdx + 1];
    const monsterJson = JSON.parse(readFileSync(filePath, "utf-8"));
    opts = parseMonsterFile(monsterJson);
  } else {
    if (nameIdx === -1 || typeIdx === -1 || crIdx === -1) {
      console.error("Error: --name, --type, and --cr are required (or use --file). Use --help for usage.");
      process.exit(1);
    }
    opts = {
      name: args[nameIdx + 1],
      type: args[typeIdx + 1],
      cr: parseFloat(args[crIdx + 1]),
    };
  }

  // Apply optional overrides
  if (styleIdx !== -1) opts.style = args[styleIdx + 1];
  if (sizeIdx !== -1) opts.imageSize = args[sizeIdx + 1];
  opts.token = isToken;

  try {
    const prompt = isToken ? buildTokenPrompt(opts) : buildArtPrompt(opts);
    const outputPath = getOutputPath(opts.name, isToken);

    if (jsonOutput) {
      console.log(JSON.stringify({
        prompt,
        outputPath,
        options: opts,
        status: "generating",
      }, null, 2));
    } else {
      console.log(`Generating art for ${opts.name}...`);
      console.log(`Style: ${opts.style || "dark fantasy"}`);
      console.log(`Prompt: ${prompt}`);
    }

    const result = await generateArt(prompt, outputPath, opts.imageSize);

    if (jsonOutput) {
      console.log(JSON.stringify({
        success: true,
        outputPath: result,
        prompt,
        options: opts,
      }, null, 2));
    } else {
      console.log(`Image saved to: ${result}`);
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
