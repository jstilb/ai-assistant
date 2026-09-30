/**
 * CommandRunner.ts — Extracted from WorkOrchestrator.ts
 *
 * Verification command parsing (security allowlist) and execution.
 * - parseVerificationCommand: tokenizes and validates against allowlists
 * - runVerificationCommand: resolves paths, expands globs, and executes
 */

import { existsSync } from "fs";
import { join } from "path";
import { execFileSync } from "child_process";
import { globSync } from "glob";
import type { ISCRow } from "./WorkOrchestrator.ts";
import { normalizeVerificationCommand, findMissingDirectoryArg } from "./VerificationUtils.ts";
import {
  COMMAND_RUNNER_SCOPE,
  buildExecutableAllowlist,
  isCatastrophicCommand,
} from "../../../../lib/core/CommandSafety.ts";

// Moved to lib/core/CommandSafety.ts (L2 command-safety consolidation) — this
// is the "command-runner" scope's resolved allowlist + safe git subcommands,
// reconstructed here for backward compatibility.
const ALLOWED_EXECUTABLES = buildExecutableAllowlist(COMMAND_RUNNER_SCOPE);
const gitScope = COMMAND_RUNNER_SCOPE.git;
const SAFE_GIT_SUBCOMMANDS = new Set(typeof gitScope === "object" ? gitScope.subcommands : []);

export class CommandRunner {
  // --------------------------------------------------------------------------
  // Verification command parsing (security allowlist)
  // --------------------------------------------------------------------------

  parseVerificationCommand(command: string): { exe: string; args: string[] } | null {
    if (command.includes("|") || command.includes("&&") || command.includes(";") || command.includes("$(") || command.includes("`")) {
      return null;
    }

    // Shared catastrophic-pattern floor (lib/core/CommandSafety.ts) — defense
    // in depth. Provably a no-op given the strict allowlist below (rm/dd/mkfs
    // are never allowlisted and git is restricted to read-only subcommands),
    // but keeps this context on the same unconditional floor as the other two.
    if (isCatastrophicCommand(command).blocked) return null;

    const parts: string[] = [];
    let current = "";
    let inQuote: string | null = null;

    for (const char of command) {
      if (inQuote) {
        if (char === inQuote) { inQuote = null; } else { current += char; }
      } else if (char === '"' || char === "'") {
        inQuote = char;
      } else if (char === " " || char === "\t") {
        if (current) { parts.push(current); current = ""; }
      } else {
        current += char;
      }
    }
    if (current) parts.push(current);
    if (parts.length === 0) return null;

    const exe = parts[0];

    if (exe === "git") {
      const sub = parts[1];
      if (!sub || !SAFE_GIT_SUBCOMMANDS.has(sub)) return null;
      return { exe, args: parts.slice(1) };
    }

    if (!ALLOWED_EXECUTABLES.has(exe)) return null;
    return { exe, args: parts.slice(1) };
  }

  // --------------------------------------------------------------------------
  // Run verification
  // --------------------------------------------------------------------------

  runVerificationCommand(row: ISCRow, cwd?: string): boolean | null {
    if (!row.verification?.command) return null; // No command = cannot verify locally — defer to Phase 2 judgment
    const normalized = normalizeVerificationCommand(row.verification.command);
    if (!normalized) {
      // Bare 'test', empty, or otherwise unusable — defer to Phase 2 judgment without failing
      console.warn(`[CommandRunner] Skipping unusable verification command: "${row.verification.command}" (row #${row.id})`);
      return null;
    }
    const parsed = this.parseVerificationCommand(normalized);
    if (!parsed) return null; // Unparseable command (shell operators) — defer to Phase 2 judgment

    // Guard: if the command references a directory path that doesn't exist, skip rather than fail
    const missingDir = findMissingDirectoryArg(parsed.args, cwd);
    if (missingDir) {
      console.warn(`[CommandRunner] Skipping verification command (directory not found: "${missingDir}"): "${normalized}" (row #${row.id})`);
      return null;
    }

    // Resolve relative .ts/.js/.json file paths in args to absolute paths within cwd.
    if (cwd) {
      for (let i = 0; i < parsed.args.length; i++) {
        const arg = parsed.args[i];
        // Skip flags, patterns, and non-file args
        if (arg.startsWith("-") || /[*?]/.test(arg)) continue;

        // For absolute paths: remap main-repo paths to worktree paths if the file was modified there
        if (arg.startsWith("/") && cwd && cwd.includes("/worktrees/")) {
          const mainRepo = cwd.replace(/\/worktrees\/.*$/, "");
          if (arg.startsWith(mainRepo + "/") && !arg.startsWith(cwd + "/")) {
            const relFromRepo = arg.slice(mainRepo.length + 1);
            const worktreeVersion = join(cwd, relFromRepo);
            if (existsSync(worktreeVersion)) {
              parsed.args[i] = worktreeVersion;
            }
          }
          continue;
        }

        if (!/\.(?:ts|js|mjs|json|sh|md)$/.test(arg)) continue;

        // Direct resolution against cwd
        const direct = join(cwd, arg);
        if (existsSync(direct)) { parsed.args[i] = direct; continue; }

        // Fallback: search for the file under cwd
        try {
          const found = execFileSync("find", [cwd, "-path", `*/${arg}`, "-type", "f",
            "-not", "-path", "*/node_modules/*"],
            { encoding: "utf-8", timeout: 5000 }).trim().split("\n")[0];
          if (found) { parsed.args[i] = found; continue; }
        } catch { /* find failed */ }

        // Fuzzy fallback: try matching just the filename
        const basename = arg.split("/").pop() || arg;
        const stem = basename.replace(/\.test\.ts$/, "").replace(/\.spec\.ts$/, "");
        if (stem !== basename) {
          try {
            const fuzzy = execFileSync("find", [cwd, "-name", `${stem}*.test.ts`, "-type", "f",
              "-not", "-path", "*/node_modules/*"],
              { encoding: "utf-8", timeout: 5000 }).trim().split("\n")[0];
            if (fuzzy) { parsed.args[i] = fuzzy; continue; }
          } catch { /* fuzzy find failed */ }
        }

        console.warn(`[CommandRunner] File resolution: "${arg}" not found under ${cwd}`);
      }
    }

    // Expand glob patterns in args
    const expandedArgs = parsed.args.flatMap(arg => {
      if (/[*?\[]/.test(arg)) {
        const expanded = globSync(arg, { cwd: cwd || process.cwd() });
        return expanded.length > 0 ? expanded : [arg];
      }
      return [arg];
    });

    try {
      execFileSync(parsed.exe, expandedArgs, { encoding: "utf-8", timeout: 120000, ...(cwd ? { cwd } : {}) });
      return !row.verification.invertExit; // exit 0: PASS normally, FAIL if inverted
    } catch (e: unknown) {
      // OS resource/network errors: treat as infrastructure transient, not a work-item failure.
      // Tag the row at origin so classifyFailure() can route without re-parsing strings.
      const errOutput = (e as { stderr?: string; stdout?: string })?.stderr ?? (e as { stdout?: string })?.stdout ?? (e instanceof Error ? e.message : String(e));
      if (
        errOutput.includes("EMFILE") ||
        errOutput.includes("ProcessFdQuotaExceeded") ||
        errOutput.includes("ECONNRESET") ||
        errOutput.includes("ETIMEDOUT") ||
        errOutput.includes("ECONNREFUSED")
      ) {
        console.warn(`[CommandRunner] Verification hit resource limit (EMFILE) for row #${row.id} — deferring to Phase 2`);
        // S3a: tag at origin so classifyFailure() sees a structured signal instead of reparsing
        row.infraFault = true;
        return null;
      }
      return !!row.verification.invertExit; // non-zero: FAIL normally, PASS if inverted
    }
  }
}
