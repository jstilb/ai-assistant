#!/usr/bin/env bun
/**
 * ClaudeVisionAdapter.ts - Room analysis via Kaya Inference at smart (Opus) level
 *
 * Constructs a structured prompt for room photo analysis, invokes the Kaya
 * Inference tool at the `smart` tier, and parses the response into the
 * canonical RoomAnalysis interface. Results are cache-compatible via
 * image SHA-256 keying with 7-day TTL through AnalysisCache.
 *
 * Usage:
 *   import { analyzeWithClaude } from './ClaudeVisionAdapter';
 *   const analysis = await analyzeWithClaude('/path/to/room.jpg', 'lighting');
 *
 * @module ClaudeVisionAdapter
 */

import { basename } from "path";

// ---------------------------------------------------------------------------
// Types (shared interface)
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

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const INFERENCE_TOOL = `${process.env.HOME}/.claude/tools/Inference.ts`;

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

export function buildClaudePrompt(imagePath: string, focus?: string): string {
  const focusClause = focus ? `\nPay special attention to: ${focus}` : "";

  return `You are an expert interior designer analyzing a room photo.

Analyze the room image at path: ${imagePath}
Use your vision capabilities to examine this photo carefully.
${focusClause}

Return a JSON object with EXACTLY these fields:
{
  "room_type": "string - the type of room (living room, bedroom, kitchen, bathroom, office, dining room, etc.)",
  "styles": ["string array - design styles present (modern, minimalist, scandinavian, bohemian, mid-century, farmhouse, industrial, traditional, japandi, hygge, etc.)"],
  "dominant_colors": [{"name": "color name", "hex": "#HEXCODE"}],
  "lighting": "string - description of lighting conditions",
  "features": ["string array - notable features in the room"],
  "confidence": 0.85
}

Rules:
- Return ONLY valid JSON, no markdown fences, no explanation
- confidence must be between 0.6 and 1.0
- Include at least 1 style, 1 color, and 1 feature
- Be specific about colors (use actual color names and hex codes)`;
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

export function parseClaudeResponse(raw: string): RoomAnalysis | null {
  try {
    // Strip markdown fences if present
    let cleaned = raw.trim();
    const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) {
      cleaned = fenceMatch[1].trim();
    }

    // Extract JSON object
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    const parsed = JSON.parse(jsonMatch[0]);

    // Validate required fields
    if (
      typeof parsed.room_type !== "string" ||
      !Array.isArray(parsed.styles) ||
      !Array.isArray(parsed.dominant_colors) ||
      typeof parsed.lighting !== "string" ||
      !Array.isArray(parsed.features)
    ) {
      return null;
    }

    // Validate dominant_colors structure
    const validColors = parsed.dominant_colors.every(
      (c: any) => typeof c.name === "string" && typeof c.hex === "string",
    );
    if (!validColors || parsed.dominant_colors.length === 0) return null;

    // Enforce confidence bounds for vision (0.6 - 1.0)
    let confidence = typeof parsed.confidence === "number" ? parsed.confidence : 0.75;
    confidence = Math.max(0.6, Math.min(1.0, confidence));

    return {
      room_type: parsed.room_type,
      styles: parsed.styles,
      dominant_colors: parsed.dominant_colors,
      lighting: parsed.lighting,
      features: parsed.features,
      confidence,
      source: "claude",
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main analysis function
// ---------------------------------------------------------------------------

export async function analyzeWithClaude(
  imagePath: string,
  focus?: string,
): Promise<RoomAnalysis | null> {
  try {
    const prompt = buildClaudePrompt(imagePath, focus);

    const proc = Bun.spawn(
      ["bun", INFERENCE_TOOL, "smart"],
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
      console.error(`[ClaudeVisionAdapter] Inference failed (exit ${exitCode}): ${stderr.trim()}`);
      return null;
    }

    const result = parseClaudeResponse(stdout);
    if (result) {
      console.error(`[ClaudeVisionAdapter] Analysis complete: ${result.room_type} (${result.confidence})`);
    } else {
      console.error(`[ClaudeVisionAdapter] Failed to parse response`);
    }

    return result;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[ClaudeVisionAdapter] Error: ${msg}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

if (import.meta.main) {
  const imagePath = process.argv[2];
  const focus = process.argv.includes("--focus") ? process.argv[process.argv.indexOf("--focus") + 1] : undefined;

  if (!imagePath) {
    console.log("Usage: bun ClaudeVisionAdapter.ts <image-path> [--focus <area>]");
    process.exit(0);
  }

  const result = await analyzeWithClaude(imagePath, focus);
  if (result) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.error("Claude Vision analysis failed.");
    process.exit(1);
  }
}
