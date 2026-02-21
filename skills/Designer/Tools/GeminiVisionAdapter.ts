#!/usr/bin/env bun
/**
 * GeminiVisionAdapter.ts - Room analysis via Kaya Inference at standard level (Gemini fallback)
 *
 * Lower-priority fallback when Claude Vision is unavailable. Uses the Kaya
 * Inference tool at the `standard` tier with Gemini-style prompting.
 * Response is normalized to the same RoomAnalysis schema.
 *
 * Usage:
 *   import { analyzeWithGemini } from './GeminiVisionAdapter';
 *   const analysis = await analyzeWithGemini('/path/to/room.jpg');
 *
 * @module GeminiVisionAdapter
 */

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

export function buildGeminiPrompt(imagePath: string, focus?: string): string {
  const focusClause = focus ? `\nFocus area: ${focus}` : "";

  return `Analyze the room in the image at: ${imagePath}

You are an interior design expert. Examine this room photo and provide a structured analysis.
${focusClause}

Return a JSON object with these exact fields:
{
  "room_type": "type of room (living room, bedroom, kitchen, etc.)",
  "styles": ["design styles present"],
  "dominant_colors": [{"name": "color name", "hex": "#HEXCODE"}],
  "lighting": "lighting conditions description",
  "features": ["notable room features"],
  "confidence": 0.75
}

Important:
- Return ONLY the JSON object, no extra text
- confidence should be 0.6-1.0
- Include at least one entry for styles, dominant_colors, and features`;
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

export function parseGeminiResponse(raw: string): RoomAnalysis | null {
  try {
    let cleaned = raw.trim();

    // Strip markdown fences
    const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) {
      cleaned = fenceMatch[1].trim();
    }

    // Extract JSON
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

    // Validate colors structure
    const validColors = parsed.dominant_colors.every(
      (c: any) => typeof c.name === "string" && typeof c.hex === "string",
    );
    if (!validColors || parsed.dominant_colors.length === 0) return null;

    // Enforce confidence bounds for vision (0.6 - 1.0)
    let confidence = typeof parsed.confidence === "number" ? parsed.confidence : 0.7;
    confidence = Math.max(0.6, Math.min(1.0, confidence));

    return {
      room_type: parsed.room_type,
      styles: parsed.styles,
      dominant_colors: parsed.dominant_colors,
      lighting: parsed.lighting,
      features: parsed.features,
      confidence,
      source: "gemini",
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main analysis function
// ---------------------------------------------------------------------------

export async function analyzeWithGemini(
  imagePath: string,
  focus?: string,
): Promise<RoomAnalysis | null> {
  try {
    const prompt = buildGeminiPrompt(imagePath, focus);

    const proc = Bun.spawn(
      ["bun", INFERENCE_TOOL, "standard"],
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
      console.error(`[GeminiVisionAdapter] Inference failed (exit ${exitCode}): ${stderr.trim()}`);
      return null;
    }

    const result = parseGeminiResponse(stdout);
    if (result) {
      console.error(`[GeminiVisionAdapter] Analysis complete: ${result.room_type} (${result.confidence})`);
    } else {
      console.error(`[GeminiVisionAdapter] Failed to parse response`);
    }

    return result;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[GeminiVisionAdapter] Error: ${msg}`);
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
    console.log("Usage: bun GeminiVisionAdapter.ts <image-path> [--focus <area>]");
    process.exit(0);
  }

  const result = await analyzeWithGemini(imagePath, focus);
  if (result) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.error("Gemini Vision analysis failed.");
    process.exit(1);
  }
}
