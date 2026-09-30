#!/usr/bin/env bun

/**
 * generate - UL Image Generation CLI
 *
 * Generate Unsupervised Learning branded images using Flux 1.1 Pro, Nano Banana, Nano Banana Pro, or GPT-image-1.
 * Follows llcli pattern for deterministic, composable CLI design.
 *
 * Usage:
 *   generate --model nano-banana-pro --prompt "..." --size 16:9 --output /tmp/image.png
 *
 * @see ~/.claude/skills/art/README.md
 */

import { rename } from "node:fs/promises";
import { loadEnv, CLIError } from "../Lib/cli-utils.ts";
import { addBackgroundColor, removeBackground } from "./BackgroundOps.ts";
import * as FluxAdapter from "./Adapters/FluxAdapter.ts";
import * as NanoBananaAdapter from "./Adapters/NanoBananaAdapter.ts";
import * as NanaBananaProAdapter from "./Adapters/NanaBananaProAdapter.ts";
import * as GPTImageAdapter from "./Adapters/GPTImageAdapter.ts";
import { getKayaHome } from "../../../../lib/core/KayaHome.ts";

// ============================================================================
// Types
// ============================================================================

type Model = "flux" | "nano-banana" | "nano-banana-pro" | "gpt-image-1";
type ReplicateSize = "1:1" | "16:9" | "3:2" | "2:3" | "3:4" | "4:3" | "4:5" | "5:4" | "9:16" | "21:9";
type OpenAISize = "1024x1024" | "1536x1024" | "1024x1536";
type GeminiSize = "1K" | "2K" | "4K";
type Size = ReplicateSize | OpenAISize | GeminiSize;

interface CLIArgs {
  model: Model;
  prompt: string;
  size: Size;
  output: string;
  creativeVariations?: number;
  aspectRatio?: ReplicateSize;
  transparent?: boolean;
  referenceImages?: string[];
  removeBg?: boolean;
  addBg?: string;
  thumbnail?: boolean;
}

// ============================================================================
// Configuration
// ============================================================================

// Kaya directory for documentation paths — must be defined before DEFAULTS
const KAYA_DIR = getKayaHome(); // was KAYA_DIR-only; getKayaHome() superset

const DEFAULTS = {
  model: "flux" as Model,
  size: "16:9" as Size,
  output: `${process.env.HOME}/Downloads/ul-image.png`,
};

const REPLICATE_SIZES: ReplicateSize[] = ["1:1", "16:9", "3:2", "2:3", "3:4", "4:3", "4:5", "5:4", "9:16", "21:9"];
const OPENAI_SIZES: OpenAISize[] = ["1024x1024", "1536x1024", "1024x1536"];
const GEMINI_SIZES: GeminiSize[] = ["1K", "2K", "4K"];
const GEMINI_ASPECT_RATIOS: ReplicateSize[] = ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"];

// Per-model concurrency caps for --creative-variations to avoid 429 rate limit errors
const CONCURRENCY: Record<Model, number> = {
  flux: 2,
  "nano-banana": 2,
  "nano-banana-pro": 1,
  "gpt-image-1": 2,
};

// ============================================================================
// Error Handling
// ============================================================================

function handleError(error: unknown): never {
  if (error instanceof CLIError) {
    console.error(`❌ Error: ${error.message}`);
    process.exit(error.exitCode);
  }

  if (error instanceof Error) {
    console.error(`❌ Unexpected error: ${error.message}`);
    console.error(error.stack);
    process.exit(1);
  }

  console.error(`❌ Unknown error:`, error);
  process.exit(1);
}

// ============================================================================
// Help Text
// ============================================================================

function showHelp(): void {
  console.log(`
generate - UL Image Generation CLI

Generate Unsupervised Learning branded images using Flux 1.1 Pro, Nano Banana, Nano Banana Pro, or GPT-image-1.

USAGE:
  generate --model <model> --prompt "<prompt>" [OPTIONS]

REQUIRED:
  --model <model>      Model to use: flux, nano-banana, nano-banana-pro, gpt-image-1
  --prompt <text>      Image generation prompt (quote if contains spaces)

OPTIONS:
  --size <size>              Image size/aspect ratio (default: 16:9)
                             Replicate (flux, nano-banana): 1:1, 16:9, 3:2, 2:3, 3:4, 4:3, 4:5, 5:4, 9:16, 21:9
                             OpenAI (gpt-image-1): 1024x1024, 1536x1024, 1024x1536
                             Gemini (nano-banana-pro): 1K, 2K, 4K (resolution); aspect ratio inferred from context or defaults to 16:9
  --aspect-ratio <ratio>     Aspect ratio for Gemini nano-banana-pro (default: 16:9)
                             Options: 1:1, 2:3, 3:2, 3:4, 4:3, 4:5, 5:4, 9:16, 16:9, 21:9
  --output <path>            Output file path (default: /tmp/ul-image.png)
  --reference-image <path>   Reference image for style/character consistency (Nano Banana Pro only)
                             Can specify MULTIPLE times for improved consistency
                             Accepts: PNG, JPEG, WebP images
                             API Limits: Up to 5 human refs, 6 object refs, 14 total max
  --transparent              Enable transparent background (adds transparency instructions to prompt)
                             Note: Not all models support transparency natively; may require post-processing
  --remove-bg                Remove background after generation using remove.bg API
                             Creates true transparency by removing the generated background
  --add-bg <hex>             Add background color to a transparent image (e.g., "#EAE9DF")
                             Useful for creating thumbnails/social previews from transparent images
  --thumbnail                Generate BOTH transparent AND thumbnail versions for blog headers
                             Creates: output.png (transparent) + output-thumb.png (#EAE9DF background)
                             Automatically enables --remove-bg
  --creative-variations <n>  Generate N variations (appends -v1, -v2, etc. to output filename)
                             Use with the be-creative skill for true prompt diversity
                             CLI mode: generates N images with same prompt (tests model variability)
  --help, -h                 Show this help message

EXAMPLES:
  # Generate blog header with Nano Banana Pro (16:9, 2K quality)
  generate --model nano-banana-pro --prompt "Abstract UL illustration..." --size 2K --aspect-ratio 16:9

  # Generate high-res 4K image with Nano Banana Pro
  generate --model nano-banana-pro --prompt "Editorial cover..." --size 4K --aspect-ratio 3:2

  # Generate blog header with original Nano Banana (16:9)
  generate --model nano-banana --prompt "Abstract UL illustration..." --size 16:9

  # Generate square image with Flux
  generate --model flux --prompt "Minimal geometric art..." --size 1:1 --output /tmp/header.png

  # Generate portrait with GPT-image-1
  generate --model gpt-image-1 --prompt "Editorial cover..." --size 1024x1536

  # Generate 3 creative variations (for testing model variability)
  generate --model gpt-image-1 --prompt "..." --creative-variations 3 --output /tmp/essay.png
  # Outputs: /tmp/essay-v1.png, /tmp/essay-v2.png, /tmp/essay-v3.png

  # Single reference image for style guidance (Nano Banana Pro only)
  generate --model nano-banana-pro --prompt "Tokyo Night themed illustration..." \\
    --reference-image /tmp/style-reference.png --size 2K --aspect-ratio 16:9

  # MULTIPLE reference images for character consistency (Nano Banana Pro only)
  generate --model nano-banana-pro --prompt "Person from references at a party..." \\
    --reference-image face1.jpg --reference-image face2.jpg --reference-image face3.jpg \\
    --size 2K --aspect-ratio 16:9

NOTE: For true creative diversity with different prompts, use the creative workflow which
integrates the be-creative skill. CLI creative mode generates multiple images with the SAME prompt.

MULTI-REFERENCE LIMITS (Gemini API):
  - Up to 5 human reference images for character consistency
  - Up to 6 object reference images
  - Maximum 14 total reference images per request

ENVIRONMENT VARIABLES:
  REPLICATE_API_TOKEN  Required for flux and nano-banana models
  OPENAI_API_KEY       Required for gpt-image-1 model
  GOOGLE_API_KEY       Required for nano-banana-pro model
  REMOVEBG_API_KEY     Required for --remove-bg flag

ERROR CODES:
  0  Success
  1  General error (invalid arguments, API error, file write error)

MORE INFO:
  Documentation: ${KAYA_DIR}/skills/Content/Art/README.md
  Source: ${KAYA_DIR}/skills/Content/Art/Tools/Generate.ts
`);
  process.exit(0);
}

// ============================================================================
// Argument Parsing
// ============================================================================

function parseArgs(argv: string[]): CLIArgs {
  const args = argv.slice(2);

  if (args.includes("--help") || args.includes("-h") || args.length === 0) {
    showHelp();
  }

  const parsed: Partial<CLIArgs> = {
    model: DEFAULTS.model,
    size: DEFAULTS.size,
    output: DEFAULTS.output,
  };

  const referenceImages: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const flag = args[i];

    if (!flag.startsWith("--")) {
      throw new CLIError(`Invalid flag: ${flag}. Flags must start with --`);
    }

    const key = flag.slice(2);

    if (key === "transparent") {
      parsed.transparent = true;
      continue;
    }
    if (key === "remove-bg") {
      parsed.removeBg = true;
      continue;
    }
    if (key === "thumbnail") {
      parsed.thumbnail = true;
      parsed.removeBg = true;
      continue;
    }

    const value = args[i + 1];
    if (!value || value.startsWith("--")) {
      throw new CLIError(`Missing value for flag: ${flag}`);
    }

    switch (key) {
      case "model":
        if (value !== "flux" && value !== "nano-banana" && value !== "nano-banana-pro" && value !== "gpt-image-1") {
          throw new CLIError(`Invalid model: ${value}. Must be: flux, nano-banana, nano-banana-pro, or gpt-image-1`);
        }
        parsed.model = value;
        i++;
        break;
      case "prompt":
        parsed.prompt = value;
        i++;
        break;
      case "size":
        parsed.size = value as Size;
        i++;
        break;
      case "aspect-ratio":
        parsed.aspectRatio = value as ReplicateSize;
        i++;
        break;
      case "output":
        parsed.output = value;
        i++;
        break;
      case "reference-image":
        referenceImages.push(value);
        i++;
        break;
      case "creative-variations": {
        const variations = parseInt(value, 10);
        if (isNaN(variations) || variations < 1 || variations > 10) {
          throw new CLIError(`Invalid creative-variations: ${value}. Must be 1-10`);
        }
        parsed.creativeVariations = variations;
        i++;
        break;
      }
      case "add-bg":
        if (!/^#[0-9A-Fa-f]{6}$/.test(value)) {
          throw new CLIError(`Invalid hex color: ${value}. Must be in format #RRGGBB (e.g., #EAE9DF)`);
        }
        parsed.addBg = value;
        i++;
        break;
      default:
        throw new CLIError(`Unknown flag: ${flag}`);
    }
  }

  if (referenceImages.length > 0) {
    parsed.referenceImages = referenceImages;
  }

  if (!parsed.prompt) {
    throw new CLIError("Missing required argument: --prompt");
  }

  if (!parsed.model) {
    throw new CLIError("Missing required argument: --model");
  }

  if (parsed.referenceImages && parsed.referenceImages.length > 0 && parsed.model !== "nano-banana-pro") {
    throw new CLIError("--reference-image is only supported with --model nano-banana-pro");
  }

  if (parsed.referenceImages && parsed.referenceImages.length > 14) {
    throw new CLIError(`Too many reference images: ${parsed.referenceImages.length}. Maximum is 14 total (5 human, 6 object)`);
  }

  if (parsed.model === "gpt-image-1") {
    if (!OPENAI_SIZES.includes(parsed.size as OpenAISize)) {
      throw new CLIError(`Invalid size for gpt-image-1: ${parsed.size}. Must be: ${OPENAI_SIZES.join(", ")}`);
    }
  } else if (parsed.model === "nano-banana-pro") {
    if (!GEMINI_SIZES.includes(parsed.size as GeminiSize)) {
      throw new CLIError(`Invalid size for nano-banana-pro: ${parsed.size}. Must be: ${GEMINI_SIZES.join(", ")}`);
    }
    if (parsed.aspectRatio && !GEMINI_ASPECT_RATIOS.includes(parsed.aspectRatio)) {
      throw new CLIError(`Invalid aspect-ratio for nano-banana-pro: ${parsed.aspectRatio}. Must be: ${GEMINI_ASPECT_RATIOS.join(", ")}`);
    }
    if (!parsed.aspectRatio) {
      parsed.aspectRatio = "16:9";
    }
  } else {
    if (!REPLICATE_SIZES.includes(parsed.size as ReplicateSize)) {
      throw new CLIError(`Invalid size for ${parsed.model}: ${parsed.size}. Must be: ${REPLICATE_SIZES.join(", ")}`);
    }
  }

  return parsed as CLIArgs;
}

// ============================================================================
// Prompt Enhancement
// ============================================================================

function enhancePromptForTransparency(prompt: string): string {
  return "CRITICAL: Transparent background (PNG with alpha channel) - NO background color, pure transparency. Object floating in transparent space. " + prompt;
}

// ============================================================================
// Generation Dispatch
// ============================================================================

async function generateSingle(args: CLIArgs, prompt: string, outputPath: string): Promise<void> {
  const options = {
    transparent: args.transparent,
    referenceImages: args.referenceImages,
    aspectRatio: args.aspectRatio,
  };

  if (args.model === "flux") {
    await FluxAdapter.generate(prompt, args.size, outputPath, options);
  } else if (args.model === "nano-banana") {
    await NanoBananaAdapter.generate(prompt, args.size, outputPath, options);
  } else if (args.model === "nano-banana-pro") {
    await NanaBananaProAdapter.generate(prompt, args.size, outputPath, options);
  } else if (args.model === "gpt-image-1") {
    await GPTImageAdapter.generate(prompt, args.size, outputPath, options);
  }
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  try {
    await loadEnv();

    const args = parseArgs(process.argv);

    const finalPrompt = args.transparent
      ? enhancePromptForTransparency(args.prompt)
      : args.prompt;

    if (args.transparent) {
      console.log("🔲 Transparent background mode enabled");
      console.log("💡 Note: Not all models support transparency natively; may require post-processing\n");
    }

    // Handle creative variations mode with per-model concurrency cap
    if (args.creativeVariations && args.creativeVariations > 1) {
      console.log(`🎨 Creative Mode: Generating ${args.creativeVariations} variations...`);
      console.log(`💡 Note: CLI mode uses same prompt for all variations (tests model variability)`);
      console.log(`   For true creative diversity, use the creative workflow with be-creative skill\n`);

      const basePath = args.output.replace(/\.png$/, "");
      const cap = CONCURRENCY[args.model];

      const variationOutputs: string[] = [];
      for (let i = 1; i <= args.creativeVariations; i++) {
        variationOutputs.push(`${basePath}-v${i}.png`);
      }

      for (let i = 0; i < variationOutputs.length; i += cap) {
        const batch = variationOutputs.slice(i, i + cap);
        console.log(`Generating batch ${Math.floor(i / cap) + 1}: variations ${i + 1}-${i + batch.length}`);
        await Promise.all(
          batch.map((varOutput) => generateSingle(args, finalPrompt, varOutput))
        );
      }

      console.log(`\n✅ Generated ${args.creativeVariations} variations`);
      return;
    }

    // Standard single image generation
    await generateSingle(args, finalPrompt, args.output);

    // Remove background if requested
    if (args.removeBg) {
      await removeBackground(args.output);
    }

    // Add background color (standalone mode)
    if (args.addBg && !args.thumbnail) {
      const tempPath = args.output.replace(/\.png$/, "-temp.png");
      await addBackgroundColor(args.output, tempPath, args.addBg);
      await rename(tempPath, args.output);
    }

    // Generate thumbnail with background color (blog header mode)
    if (args.thumbnail) {
      const thumbPath = args.output.replace(/\.png$/, "-thumb.png");
      const THUMBNAIL_BG_COLOR = "#EAE9DF";
      await addBackgroundColor(args.output, thumbPath, THUMBNAIL_BG_COLOR);
      console.log(`\n📸 Blog header mode: Created both versions`);
      console.log(`   Transparent: ${args.output}`);
      console.log(`   Thumbnail:   ${thumbPath}`);
    }
  } catch (error) {
    handleError(error);
  }
}

main();
