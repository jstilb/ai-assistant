import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile } from "node:fs/promises";
import { httpClient } from "../../../../lib/core/CachedHTTPClient.ts";
import { CLIError } from "../Lib/cli-utils.ts";

const execFileAsync = promisify(execFile);

/**
 * Verify ImageMagick is installed and accessible.
 * Throws CLIError with install instructions if not found.
 */
async function checkImageMagick(): Promise<void> {
  try {
    await execFileAsync("magick", ["-version"]);
  } catch (error) {
    // Surface the real underlying error (e.g. a PATH/permissions issue looks nothing like
    // "not installed" and was previously masked identically, costing debugging time).
    const detail = error instanceof Error ? error.message : String(error);
    throw new CLIError(
      "ImageMagick not found or not runnable. Install with: brew install imagemagick\n" +
      "Required for --add-bg and --thumbnail flags.\n" +
      `Underlying error: ${detail}`
    );
  }
}

/**
 * Add a solid background color to a transparent PNG image.
 * Uses ImageMagick execFile (no shell interpolation) to safely composite
 * the transparent image onto a colored background.
 */
export async function addBackgroundColor(inputPath: string, outputPath: string, hexColor: string): Promise<void> {
  await checkImageMagick();

  console.log(`🎨 Adding background color ${hexColor} to image...`);

  try {
    await execFileAsync("magick", [inputPath, "-background", hexColor, "-flatten", outputPath]);
    console.log(`✅ Thumbnail saved to ${outputPath}`);
  } catch (error) {
    throw new CLIError(`Failed to add background color: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Remove background from an image using the remove.bg API.
 * Overwrites the original file with the transparent result.
 */
export async function removeBackground(imagePath: string): Promise<void> {
  const apiKey = process.env.REMOVEBG_API_KEY;
  if (!apiKey) {
    throw new CLIError("Missing environment variable: REMOVEBG_API_KEY");
  }

  console.log("🔲 Removing background with remove.bg API...");

  const imageBuffer = await readFile(imagePath);
  const formData = new FormData();
  formData.append("image_file", new Blob([imageBuffer]), "image.png");
  formData.append("size", "auto");

  const response = await httpClient.fetch("https://api.remove.bg/v1.0/removebg", {
    method: "POST",
    headers: {
      "X-Api-Key": apiKey,
    },
    body: formData,
    cache: "none",
    retry: 3,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new CLIError(`remove.bg API error: ${response.status} - ${errorText}`);
  }

  const resultBuffer = Buffer.from(await response.arrayBuffer());
  await writeFile(imagePath, resultBuffer);
  console.log("✅ Background removed successfully");
}
