#!/usr/bin/env bun
/**
 * PathEnv — Export correct PATH for launchd-spawned shell scripts
 *
 * LaunchD runs scripts in a minimal environment without the user's shell PATH.
 * This module provides the correct PATH that includes bun, homebrew, and system tools.
 *
 * Usage in shell scripts:
 *   eval "$(bun ~/.claude/lib/core/PathEnv.ts)"
 *
 * Or in TypeScript:
 *   import { setupPath } from './lib/core/PathEnv';
 *   setupPath();
 */

import * as os from "os";
import * as path from "path";
import * as fs from "fs";

const HOME = os.homedir();

const PATH_COMPONENTS = [
  path.join(HOME, ".claude", "bin"),          // kaya-cli and local scripts
  path.join(HOME, ".local", "bin"),           // Claude binary location
  path.join(HOME, ".bun", "bin"),             // bun
  "/opt/homebrew/bin",                        // Homebrew (Apple Silicon)
  "/opt/homebrew/sbin",
  "/usr/local/bin",                           // Homebrew (Intel)
  "/usr/bin",
  "/bin",
  "/usr/sbin",
  "/sbin",
];

/**
 * Returns the correct PATH string for launchd environments.
 */
export function getCorrectPath(): string {
  // Filter to only include directories that actually exist
  const existing = PATH_COMPONENTS.filter((p) => {
    try {
      return fs.statSync(p).isDirectory();
    } catch {
      return false;
    }
  });
  return existing.join(":");
}

/**
 * Set process.env.PATH to the correct value.
 */
export function setupPath(): void {
  process.env["PATH"] = getCorrectPath();
}

// CLI: when run directly, output shell export statement
if (import.meta.main) {
  const correctPath = getCorrectPath();
  process.stdout.write(`export PATH="${correctPath}"\n`);
}
