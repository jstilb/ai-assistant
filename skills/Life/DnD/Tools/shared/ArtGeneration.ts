/**
 * ArtGeneration — render a D&D image through the Content/Art skill's CLI.
 *
 * Shared by MapPrompt (battle/dungeon maps) and MonsterArt (creature art and
 * tokens), formerly two copies of this spawn block. Calls Art's Generate.ts
 * as a subprocess (not an import), so there is no cross-skill import.
 */

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getKayaHome } from "../../../../../lib/core/KayaHome.ts";

export interface ArtSkillRenderOptions {
  /** Directory to create before rendering (e.g. ~/Downloads/dnd-maps). */
  ensureDir: string;
  /** Image size passed to Generate.ts --size. Default "2K". */
  imageSize?: string;
  /** Word used in the error message: "Map" → "Map generation failed: …". */
  label: string;
}

/**
 * Generate a 1:1 nano-banana-pro image for `prompt` at `outputPath`.
 * Throws if the Art skill is missing or Generate.ts exits non-zero.
 */
export async function renderWithArtSkill(
  prompt: string,
  outputPath: string,
  { ensureDir, imageSize, label }: ArtSkillRenderOptions,
): Promise<string> {
  if (!existsSync(ensureDir)) {
    mkdirSync(ensureDir, { recursive: true });
  }

  const generateScript = join(getKayaHome(), "skills", "Content", "Art", "Tools", "Generate.ts");

  if (!existsSync(generateScript)) {
    throw new Error(
      `[DnD] Art skill not found at expected path: ${generateScript}\n` +
        `Check that the Content/Art skill is installed and the path is correct.`,
    );
  }

  const args = [
    "run",
    generateScript,
    "--model",
    "nano-banana-pro",
    "--prompt",
    prompt,
    "--size",
    imageSize || "2K",
    "--aspect-ratio",
    "1:1",
    "--output",
    outputPath,
  ];

  const proc = Bun.spawn(["bun", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const exitCode = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();

  if (exitCode !== 0) {
    throw new Error(`${label} generation failed: ${stderr || stdout}`);
  }

  return outputPath;
}
