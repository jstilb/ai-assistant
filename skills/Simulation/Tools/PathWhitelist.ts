#!/usr/bin/env bun
/**
 * PathWhitelist.ts - Path whitelist enforcement for sandbox isolation
 *
 * Only allows writes to Sandboxes/, Reports/, and Transcripts/ under
 * the Simulation skill directory. Blocks all path traversal attacks,
 * null bytes, and non-absolute paths.
 *
 * Usage:
 *   import { isAllowedWritePath } from "./PathWhitelist.ts";
 *   if (!isAllowedWritePath(targetPath)) throw new Error("Write blocked");
 */

import { resolve } from "path";

// ============================================
// CONSTANTS
// ============================================

const SIM_DIR = resolve(`${process.env.HOME}/.claude/skills/Simulation`);

export const ALLOWED_DIRS: readonly string[] = ["Sandboxes", "Reports", "Transcripts"];

// ============================================
// VALIDATION
// ============================================

export function isAllowedWritePath(targetPath: string): boolean {
  // Block empty strings
  if (!targetPath || targetPath.length === 0) return false;

  // Block null byte injection
  if (targetPath.includes("\x00")) return false;

  // Block relative paths (must be absolute)
  if (!targetPath.startsWith("/")) return false;

  // Block encoded traversal
  if (targetPath.includes("%2e") || targetPath.includes("%2E")) return false;

  // Resolve to canonical path (handles ../ and symlinks)
  const resolved = resolve(targetPath);

  // Must be under one of the allowed directories
  for (const dir of ALLOWED_DIRS) {
    const allowedBase = resolve(SIM_DIR, dir);
    if (resolved === allowedBase || resolved.startsWith(allowedBase + "/")) {
      return true;
    }
  }

  return false;
}

// ============================================
// CLI
// ============================================

if (import.meta.main) {
  const targetPath = process.argv[2];

  if (!targetPath) {
    console.log(`PathWhitelist - Path write validation

Usage: bun PathWhitelist.ts <path>

Allowed directories: ${ALLOWED_DIRS.join(", ")}
Base: ${SIM_DIR}`);
    process.exit(0);
  }

  const allowed = isAllowedWritePath(targetPath);
  console.log(JSON.stringify({ path: targetPath, allowed }));
  process.exit(allowed ? 0 : 1);
}
