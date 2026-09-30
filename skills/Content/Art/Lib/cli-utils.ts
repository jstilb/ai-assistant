/**
 * cli-utils.ts — Shared CLI utilities for Art skill tools
 *
 * Exports loadEnv() and CLIError, extracted from Generate.ts and
 * ComposeThumbnail.ts to eliminate duplication across tool files.
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { getKayaHome } from "../../../../lib/core/KayaHome.ts";

/**
 * Load environment variables from ${KAYA_DIR}/.env
 * This ensures API keys are available regardless of how the CLI is invoked
 */
export async function loadEnv(): Promise<void> {
  const kayaDir = getKayaHome();
  const envPath = resolve(kayaDir, '.env');
  try {
    const envContent = await readFile(envPath, 'utf-8');
    for (const line of envContent.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIndex = trimmed.indexOf('=');
      if (eqIndex === -1) continue;
      const key = trimmed.slice(0, eqIndex).trim();
      let value = trimmed.slice(eqIndex + 1).trim();
      // Remove surrounding quotes if present
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      // Only set if not already defined (allow overrides from shell)
      if (!process.env[key]) {
        process.env[key] = value;
      }
    }
  } catch (error) {
    // Silently continue if .env doesn't exist - rely on shell env vars
  }
}

export class CLIError extends Error {
  constructor(message: string, public exitCode: number = 1) {
    super(message);
    this.name = "CLIError";
  }
}
