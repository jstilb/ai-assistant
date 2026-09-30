/**
 * VerificationUtils.ts — Extracted from WorkOrchestrator.ts
 *
 * Pure utility functions for verification command normalization and analysis.
 * No class state — all functions are stateless and exported directly.
 */

import { existsSync } from "fs";
import { resolve } from "path";

/**
 * Normalize a raw verification command string before execution.
 *
 * Problems this solves:
 * 1. Bare `test` with no arguments — exits 1 unconditionally, useless as a check.
 *    → Returns null so the caller skips or defers to Tier 2.
 * 2. Tilde `~/` in paths — `execFileSync` does NOT expand `~` (no shell involved).
 *    → Replaces `~/` and bare `~` with the absolute HOME path.
 * 3. Empty/whitespace strings — no-op.
 *    → Returns null.
 *
 * Returns the normalized command string, or null if the command should be skipped.
 */
export function normalizeVerificationCommand(cmd: string, basedir?: string): string | null {
  if (!cmd || !cmd.trim()) return null;

  // Bare 'test' with no arguments always exits 1 — it is not a useful verification command.
  if (cmd.trim() === "test") return null;

  const home = process.env.HOME || "";

  // Expand ~/ and bare ~ at path start (e.g. "~/.claude/…" → "~/.claude/…")
  let normalized = cmd
    .replace(/~\//g, `${home}/`)
    .replace(/^~(?=\s|$)/, home);

  // Replace bare `bun test` (no path args) with safe wrapper that excludes worktrees.
  // Worktree directories contain full repo copies — bun scans them during test discovery,
  // multiplying test file count and causing EMFILE errors after 2-3 parallel work items.
  if (/^bun\s+test\s*$/.test(normalized.trim())) {
    const safeBunTest = `${home}/.claude/bin/safe-bun-test.sh`;
    if (existsSync(safeBunTest)) {
      normalized = safeBunTest;
    }
  }

  // Resolve relative paths in bun/node commands against basedir
  // Only resolve if the file exists NOW — don't guess paths for files that don't exist yet.
  // The SkepticalVerifier handles resolution at verify-time when files are guaranteed to exist.
  if (basedir) {
    normalized = normalized.replace(
      /^(bun\s+(?:run\s+|test\s+)?|node\s+)(\.\/.+|(?!\/)[a-zA-Z][\w./\-]+\.(?:ts|js|mjs))/,
      (_, prefix, relPath) => {
        const direct = resolve(basedir, relPath);
        if (existsSync(direct)) return `${prefix}${direct}`;
        // Leave relative — SkepticalVerifier resolves at verify-time
        return `${prefix}${relPath}`;
      }
    );
  }

  return normalized;
}

/**
 * Scan a list of command arguments for a directory path that does not exist.
 * Only flags paths that explicitly end with "/" (unambiguous directory reference)
 * and that do not exist on the filesystem. Ignores flags (starting with "-").
 *
 * This conservative heuristic catches the known failure category — commands like
 * `ls /tmp/pai-public-staging/` — without incorrectly skipping commands that
 * test for non-existent files (e.g. `test -f /nonexistent/file` is intentional).
 *
 * Returns the first missing directory path found, or null if all present.
 */
export function findMissingDirectoryArg(args: string[], cwd?: string): string | null {
  for (const arg of args) {
    if (arg.startsWith("-")) continue; // Skip flags
    // Only flag paths with an explicit trailing slash — unambiguous directory references
    if (!arg.endsWith("/")) continue;
    // Resolve relative paths against the provided cwd (verification context), not process.cwd()
    const resolved = cwd && !arg.startsWith("/") ? require("path").join(cwd, arg) : arg;
    if (!existsSync(resolved)) {
      return resolved;
    }
  }
  return null;
}

// detectInvertExit (the ~28-pattern ABSENCE-intent prose scanner) was removed in
// the determinism-residue cleanup. "Does success mean a non-zero exit?" is a
// judgment about the criterion's meaning — the comprehension LLM now emits it as
// the per-row `invertExit` field (LLMSpecComprehension Rule 7), read straight
// into verification.invertExit by ISCGenerator. CommandRunner still does the
// objective inversion on the real exit code.

// ============================================================================
// Security Constants — moved to lib/core/CommandSafety.ts (L2 command-safety
// consolidation: single shared base for the three independently-drifting
// allow/deny lists across SkepticalVerifier/Evidence.ts, SelfVerifyRunner.ts,
// and CommandRunner.ts). Re-exported here for backward compatibility with
// existing call sites (WorkOrchestrator.ts, lib/verifier/Evidence.ts,
// lib/verifier/Tier1.ts).
// ============================================================================

export {
  type CatastrophicAction,
  CATASTROPHIC_PATTERNS,
  PROTECTED_BRANCHES,
} from "../../../../lib/core/CommandSafety.ts";
