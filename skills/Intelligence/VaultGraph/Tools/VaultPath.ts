/**
 * VaultPath — resolve the Obsidian vault root for the VaultGraph CLIs.
 *
 * Shared by GraphBuilder, GapDetector, NoteSummarizer and SemanticIndexer
 * (formerly four identical copies of getVaultPath()).
 */

import { optionalSecret } from "../../../../lib/core/Secrets.ts";

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

  // 2. secrets.json (a broken file throws a SecretError: it must not look like "vault not configured")
  const secretPath = optionalSecret("obsidian_vault");
  if (secretPath !== null) return secretPath;

  // 3. No fallback — fail clearly
  throw new Error(
    "OBSIDIAN_VAULT not configured. " +
      'Set environment variable OBSIDIAN_VAULT or add "obsidian_vault": "/path/to/vault" to ~/.claude/secrets.json',
  );
}
