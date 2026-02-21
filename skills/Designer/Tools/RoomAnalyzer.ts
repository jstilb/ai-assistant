#!/usr/bin/env bun
/**
 * RoomAnalyzer.ts - Analyze room photos with 3-tier vision fallback
 *
 * Vision Chain (tries in order, falls through on failure):
 *   1. Gemini Vision  - Inference standard tier (Sonnet) with image path context
 *   2. Claude Vision   - Inference smart tier (Opus) with image path context
 *   3. Text Inference  - Inference fast tier (Haiku) with filename/description only
 *
 * Each tier catches errors and logs which method succeeded.
 * Image is validated (exists, type, size) and SHA-256 hashed for cache keying.
 *
 * Usage:
 *   bun Tools/RoomAnalyzer.ts analyze /path/to/room-photo.jpg
 *   bun Tools/RoomAnalyzer.ts analyze /path/to/photo.jpg --focus lighting
 *   bun Tools/RoomAnalyzer.ts analyze /path/to/photo.jpg --json
 *
 * @module RoomAnalyzer
 */

import { z } from "zod";
import { createHash } from "crypto";
import { existsSync, statSync, readFileSync } from "fs";
import { basename, extname } from "path";
import { notifySync } from "../../CORE/Tools/NotificationService.ts";
import { createAnalysisCache } from "./AnalysisCache.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const INFERENCE_TOOL = `${process.env.HOME}/.claude/skills/CORE/Tools/Inference.ts`;
const VALID_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp"]);
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const RoomAnalysisSchema = z.object({
  dimensions: z.object({
    estimatedWidth: z.string().optional(),
    estimatedLength: z.string().optional(),
    ceilingHeight: z.string().optional(),
    squareFootage: z.string().optional(),
  }).optional(),
  lighting: z.object({
    naturalLight: z.enum(["abundant", "moderate", "limited", "none"]),
    artificialLight: z.enum(["well-lit", "adequate", "dim", "none"]),
    windowCount: z.number().optional(),
    recommendation: z.string(),
  }),
  colors: z.object({
    dominant: z.array(z.string()),
    accent: z.array(z.string()),
    mood: z.string(),
  }),
  style: z.object({
    primary: z.string(),
    secondary: z.string().optional(),
    cohesionScore: z.number().min(1).max(10),
  }),
  trafficFlow: z.object({
    assessment: z.enum(["excellent", "good", "fair", "poor"]),
    notes: z.string(),
  }).optional(),
  focalPoints: z.array(z.string()),
  issues: z.array(z.object({
    issue: z.string(),
    severity: z.enum(["minor", "moderate", "major"]),
    suggestion: z.string(),
  })),
  improvements: z.array(z.object({
    suggestion: z.string(),
    impact: z.enum(["low", "medium", "high"]),
    estimatedCost: z.string(),
    priority: z.number().min(1).max(5),
  })).default([]),
  confidence: z.number().min(0).max(1),
  analysisMethod: z.enum(["gemini_vision", "claude_vision", "text_inference"]),
});

type RoomAnalysis = z.infer<typeof RoomAnalysisSchema>;

type AnalysisMethod = RoomAnalysis["analysisMethod"];

// ---------------------------------------------------------------------------
// Image validation
// ---------------------------------------------------------------------------

interface ImageValidation {
  valid: boolean;
  error?: string;
  hash?: string;
  sizeBytes?: number;
  extension?: string;
}

export function validateImage(photoPath: string): ImageValidation {
  if (!existsSync(photoPath)) {
    return { valid: false, error: `File not found: ${photoPath}` };
  }

  const ext = extname(photoPath).toLowerCase();
  if (!VALID_EXTENSIONS.has(ext)) {
    return { valid: false, error: `Unsupported format: ${ext}. Use JPG, PNG, or WebP.` };
  }

  const stat = statSync(photoPath);
  if (stat.size > MAX_FILE_SIZE) {
    const sizeMB = (stat.size / (1024 * 1024)).toFixed(1);
    return { valid: false, error: `File too large: ${sizeMB}MB (max 10MB)` };
  }

  if (stat.size === 0) {
    return { valid: false, error: "File is empty (0 bytes)" };
  }

  const hash = hashImage(photoPath);

  return { valid: true, hash, sizeBytes: stat.size, extension: ext };
}

// ---------------------------------------------------------------------------
// Image hashing (SHA-256 for cache keying)
// ---------------------------------------------------------------------------

export function hashImage(photoPath: string): string {
  const buffer = readFileSync(photoPath);
  return createHash("sha256").update(buffer).digest("hex");
}

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------

const ANALYSIS_PROMPT = `Analyze this room photo for interior design purposes. Provide a structured JSON response with:

1. **dimensions**: Estimate room dimensions if possible (width, length, ceiling height)
2. **lighting**: Assess natural and artificial lighting quality
3. **colors**: Identify dominant and accent colors, describe the mood
4. **style**: Classify the design style (Hygge, Japandi, Modern, Scandinavian, Mid-Century, Bohemian, Traditional, Minimalist, Farmhouse, etc.) and rate cohesion 1-10
5. **trafficFlow**: Assess how well the space allows movement
6. **focalPoints**: List visual focal points in the room
7. **issues**: Identify design issues (empty corners, poor lighting, clashing colors, clutter, lack of texture, etc.)
8. **improvements**: Rank suggestions by impact-to-cost ratio

Return valid JSON matching this structure.`;

function buildVisionPrompt(photoPath: string, method: AnalysisMethod, focus?: string): {
  system: string;
  user: string;
} {
  const focusClause = focus ? `\n\nFocus especially on: ${focus}` : "";
  const confidenceHint = method === "text_inference"
    ? '\nIMPORTANT: You do NOT have the actual image. Set "confidence" below 0.5 to reflect this limitation.'
    : '\nSet "confidence" between 0.6 and 1.0 based on how clearly you can assess the room.';

  const jsonShape = `
Include these two extra fields in your JSON response:
  "confidence": <number 0-1>,
  "analysisMethod": "${method}"`;

  const system = "You are an expert interior designer and spatial analyst. Return ONLY valid JSON, no markdown fences.";

  if (method === "text_inference") {
    const filename = basename(photoPath);
    const user = `${ANALYSIS_PROMPT}${focusClause}

I cannot show you the image directly, but the filename is: "${filename}".
Based on the filename and any description provided, give your best analysis.
${confidenceHint}
${jsonShape}`;
    return { system, user };
  }

  // Vision-capable tiers get the image path as context
  const user = `${ANALYSIS_PROMPT}${focusClause}

Analyze the room in the image at path: ${photoPath}
Use your vision capabilities to examine the photo.
${confidenceHint}
${jsonShape}`;

  return { system, user };
}

// ---------------------------------------------------------------------------
// Inference runner (spawns the CORE Inference tool)
// ---------------------------------------------------------------------------

async function runInference(
  level: "fast" | "standard" | "smart",
  system: string,
  user: string,
): Promise<{ success: boolean; parsed?: unknown; raw?: string; error?: string }> {
  try {
    const proc = Bun.spawn(
      [
        "bun", INFERENCE_TOOL,
        "--level", level,
        "--json",
        system,
        user,
      ],
      {
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
      return { success: false, error: stderr.trim() || `Inference exited with code ${exitCode}` };
    }

    const raw = stdout.trim();

    // Attempt to extract JSON from the output
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return { success: false, raw, error: "No JSON object found in inference output" };
    }

    const parsed = JSON.parse(jsonMatch[0]);
    return { success: true, parsed, raw };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: `Inference spawn failed: ${msg}` };
  }
}

// ---------------------------------------------------------------------------
// 3-Tier Vision Fallback Chain
// ---------------------------------------------------------------------------

interface TierAttempt {
  method: AnalysisMethod;
  level: "fast" | "standard" | "smart";
  requiresImage: boolean;
}

const TIER_CHAIN: TierAttempt[] = [
  { method: "gemini_vision",  level: "standard", requiresImage: true },
  { method: "claude_vision",  level: "smart",    requiresImage: true },
  { method: "text_inference", level: "fast",     requiresImage: false },
];

// Shared cache instance
const analysisCache = createAnalysisCache();

export async function analyzeRoom(
  photoPath: string,
  focus?: string,
): Promise<RoomAnalysis | null> {
  // Validate image first
  const validation = validateImage(photoPath);
  const errors: string[] = [];

  // Check cache if image is valid (use SHA-256 hash as key)
  if (validation.valid && validation.hash) {
    const cacheKey = focus ? `${validation.hash}:${focus}` : validation.hash;
    try {
      const cached = await analysisCache.get(cacheKey);
      if (cached) {
        console.error(`[RoomAnalyzer] Cache hit for ${cacheKey.slice(0, 12)}...`);
        const parsed = RoomAnalysisSchema.safeParse(cached.analysis);
        if (parsed.success) return parsed.data;
      }
    } catch {
      // Cache read failed -- proceed with analysis
    }
  }

  for (const tier of TIER_CHAIN) {
    // Skip vision tiers if the image is invalid
    if (tier.requiresImage && !validation.valid) {
      errors.push(`[${tier.method}] Skipped: ${validation.error}`);
      continue;
    }

    const { system, user } = buildVisionPrompt(photoPath, tier.method, focus);

    try {
      const result = await runInference(tier.level, system, user);

      if (!result.success) {
        errors.push(`[${tier.method}] Inference failed: ${result.error}`);
        continue;
      }

      // Ensure the method and confidence fields are present
      const data = result.parsed as Record<string, unknown>;
      data.analysisMethod = tier.method;

      // Enforce confidence cap for text-only tier
      if (tier.method === "text_inference") {
        const rawConf = typeof data.confidence === "number" ? data.confidence : 0.3;
        data.confidence = Math.min(rawConf, 0.49);
      }

      // Validate against schema
      const parsed = RoomAnalysisSchema.safeParse(data);
      if (!parsed.success) {
        errors.push(`[${tier.method}] Schema validation failed: ${parsed.error.message}`);
        continue;
      }

      // Success -- log which tier worked
      if (errors.length > 0) {
        console.error(`[RoomAnalyzer] Fallback chain used ${tier.method} after ${errors.length} failure(s):`);
        errors.forEach((e) => console.error(`  ${e}`));
      } else {
        console.error(`[RoomAnalyzer] Analysis via ${tier.method}`);
      }

      // Write to cache if we have a valid image hash
      if (validation.valid && validation.hash) {
        const cacheKey = focus ? `${validation.hash}:${focus}` : validation.hash;
        try {
          await analysisCache.set(cacheKey, {
            imageHash: cacheKey,
            analysis: parsed.data as unknown as Record<string, unknown>,
            method: tier.method,
            cachedAt: new Date().toISOString(),
            ttlDays: 7,
          });
        } catch {
          // Cache write failed -- not critical, continue
        }
      }

      return parsed.data;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`[${tier.method}] Unexpected error: ${msg}`);
    }
  }

  // All tiers failed
  console.error("[RoomAnalyzer] All analysis tiers failed:");
  errors.forEach((e) => console.error(`  ${e}`));
  return null;
}

// ---------------------------------------------------------------------------
// Quick assessment (human-friendly summary)
// ---------------------------------------------------------------------------

export async function quickAssessment(photoPath: string): Promise<string> {
  const analysis = await analyzeRoom(photoPath);
  if (!analysis) return "Unable to analyze room photo.";

  const methodLabel: Record<AnalysisMethod, string> = {
    gemini_vision: "Gemini Vision",
    claude_vision: "Claude Vision",
    text_inference: "Text Inference (no image)",
  };

  const lines: string[] = [
    `Room Analysis`,
    ``,
    `Method: ${methodLabel[analysis.analysisMethod]} (confidence: ${(analysis.confidence * 100).toFixed(0)}%)`,
    `Style: ${analysis.style.primary}${analysis.style.secondary ? ` / ${analysis.style.secondary}` : ""} (cohesion: ${analysis.style.cohesionScore}/10)`,
    `Lighting: Natural ${analysis.lighting.naturalLight}, Artificial ${analysis.lighting.artificialLight}`,
    `Colors: ${analysis.colors.dominant.join(", ")} with ${analysis.colors.accent.join(", ")} accents`,
    `Mood: ${analysis.colors.mood}`,
  ];

  if (analysis.trafficFlow) {
    lines.push(`Traffic Flow: ${analysis.trafficFlow.assessment} - ${analysis.trafficFlow.notes}`);
  }

  if (analysis.focalPoints.length > 0) {
    lines.push("", "Focal Points:");
    analysis.focalPoints.forEach((fp) => lines.push(`  - ${fp}`));
  }

  if (analysis.issues.length > 0) {
    lines.push("", "Issues:");
    analysis.issues.forEach((i) => lines.push(`  [${i.severity}] ${i.issue} -- ${i.suggestion}`));
  }

  if (analysis.improvements.length > 0) {
    lines.push("", "Top Improvements:");
    analysis.improvements
      .sort((a, b) => a.priority - b.priority)
      .slice(0, 3)
      .forEach((i) => lines.push(`  ${i.priority}. ${i.suggestion} (${i.impact} impact, ~${i.estimatedCost})`));
  }

  if (analysis.confidence < 0.5) {
    lines.push("", "Note: Low confidence analysis. Provide an actual room photo for more accurate results.");
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// CLI entrypoint
// ---------------------------------------------------------------------------

if (import.meta.main) {
  const args = process.argv.slice(2);

  if (args.length < 2 || args[0] !== "analyze") {
    console.log("Usage: bun Tools/RoomAnalyzer.ts analyze <photo-path> [--focus <area>] [--json]");
    console.log("");
    console.log("Options:");
    console.log("  --focus <area>   Focus analysis on a specific aspect (lighting, colors, etc.)");
    console.log("  --json           Output raw JSON instead of formatted summary");
    console.log("  --validate       Only validate the image file, do not analyze");
    console.log("");
    console.log("Vision Chain: Gemini (standard) -> Claude (smart) -> Text (fast)");
    process.exit(0);
  }

  const photoPath = args[1];
  const focus = args.includes("--focus") ? args[args.indexOf("--focus") + 1] : undefined;
  const jsonOutput = args.includes("--json");
  const validateOnly = args.includes("--validate");

  // Validate-only mode
  if (validateOnly) {
    const validation = validateImage(photoPath);
    console.log(JSON.stringify(validation, null, 2));
    process.exit(validation.valid ? 0 : 1);
  }

  if (jsonOutput) {
    const analysis = await analyzeRoom(photoPath, focus);
    if (analysis) {
      console.log(JSON.stringify(analysis, null, 2));
    } else {
      console.error("All analysis methods failed.");
      process.exit(1);
    }
  } else {
    console.log(`Analyzing room: ${photoPath}...`);

    // Show validation info
    const validation = validateImage(photoPath);
    if (validation.valid) {
      const sizeMB = ((validation.sizeBytes || 0) / (1024 * 1024)).toFixed(1);
      console.log(`Image: ${validation.extension} | ${sizeMB}MB | SHA-256: ${validation.hash?.slice(0, 12)}...`);
    } else {
      console.log(`Image validation warning: ${validation.error}`);
      console.log("Falling back to text-only analysis...");
    }

    console.log("");
    const summary = await quickAssessment(photoPath);
    console.log(summary);
    notifySync("Room analysis complete with prioritized improvements");
  }
}
