/**
 * VaultPath — resolve the Obsidian vault root for the VaultGraph CLIs.
 *
 * Shared by GraphBuilder, GapDetector, NoteSummarizer and SemanticIndexer
 * (formerly four identical copies of getVaultPath()).
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { defaultKayaHome } from "../../../../lib/core/KayaHome.ts";

/**
 * Resolve the Obsidian vault path from:
 *  1. OBSIDIAN_VAULT environment variable
 *  2. secrets.json obsidian_vault key
 *  3. Throws with a clear error if neither is set
 */
export function getVaultPath(): string {
  // 1. Environment variable
  const envPath = process.env.OBSIDIAN_VAULT;
  if (envPath) return envPath;

  // 2. secrets.json
  try {
    const secretsPath = join(defaultKayaHome(), "secrets.json");
    if (existsSync(secretsPath)) {
      const secrets = JSON.parse(readFileSync(secretsPath, "utf-8")) as Record<string, unknown>;
      if (secrets.obsidian_vault && typeof secrets.obsidian_vault === "string") {
        return secrets.obsidian_vault;
      }
    }
  } catch (err) {
    // A broken secrets.json must not look like "vault not configured": say what failed, then fall through.
    console.error(
      `Could not read obsidian_vault from secrets.json: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // 3. No fallback — fail clearly
  throw new Error(
    "OBSIDIAN_VAULT not configured. " +
      'Set environment variable OBSIDIAN_VAULT or add "obsidian_vault": "/path/to/vault" to ~/.claude/secrets.json',
  );
}
