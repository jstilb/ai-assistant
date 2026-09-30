/**
 * CommandSafety.compat.test.ts — Old-vs-new compatibility suite (L2 command-safety
 * consolidation).
 *
 * BINDING RULE (see the L2 task/report): consolidating the three independently-
 * drifting command-safety allow/deny lists into lib/core/CommandSafety.ts must
 * NEVER silently widen any context's effective allow/deny set. This file pins
 * down each context's allowed/denied examples AS THEY EXISTED before the
 * refactor (extracted verbatim from the pre-refactor literal arrays/Sets and
 * from the existing test suites that exercised them — see file header comments
 * per context below for provenance) and asserts CommandSafety reproduces them
 * exactly post-refactor.
 *
 * Any command that is denied here but was NOT denied pre-refactor would be a
 * silent narrowing; any command that is allowed here but was NOT allowed
 * pre-refactor would be a silent widening (the dangerous direction). Both are
 * asserted per context below. Intentional, documented narrowings (the shared
 * catastrophic-denylist union — see CommandSafety.ts header) are called out
 * explicitly and are the only permitted deltas.
 */

import { describe, it, expect } from "bun:test";
import {
  VERIFIER_SCOPE,
  SELF_VERIFY_SCOPE,
  COMMAND_RUNNER_SCOPE,
  isExecutableAllowed,
  primaryExecutable,
  isCatastrophicCommand,
  isCommandSafe,
} from "./CommandSafety.ts";
import { isSelfVerifyCommandSafe } from "../../skills/Automation/AutonomousWork/Tools/SelfVerifyRunner.ts";

// ---------------------------------------------------------------------------
// Context 1 — "verifier" (SkepticalVerifier.ts VERIFICATION_ALLOWED_EXECUTABLES
// + VerificationUtils.ts CATASTROPHIC_PATTERNS, consumed by
// lib/verifier/Evidence.ts's gatherEvidence security gate).
//
// Provenance: literal Set from SkepticalVerifier.ts (pre-refactor) + literal
// CATASTROPHIC_PATTERNS array from VerificationUtils.ts (pre-refactor) +
// examples from skills/Automation/AutonomousWork/Tools/__tests__/
// AutonomousWork-isc1-18.testwriter.test.ts (ISC 1 "gatherEvidence security").
// ---------------------------------------------------------------------------

describe("compat: verifier context (SkepticalVerifier/Evidence.ts)", () => {
  const allowedExecutables = [
    "bun", "node", "tsc", "cat", "ls", "echo", "wc", "grep",
    "find", "test", "true", "false", "git", "jq", "head", "tail",
    "diff", "stat", "file", "which", "pwd",
  ];
  it.each(allowedExecutables)("executable allowed pre-refactor: %s", (exe) => {
    expect(isExecutableAllowed(exe, VERIFIER_SCOPE)).toBe(true);
  });

  const deniedExecutables = ["curl", "python", "wget", "rm", "rg", "npx", "bunx", "npm", "sh", "bash"];
  it.each(deniedExecutables)("executable denied pre-refactor: %s", (exe) => {
    expect(isExecutableAllowed(exe, VERIFIER_SCOPE)).toBe(false);
  });

  // gatherEvidence's own "safe command executes" example (ISC 1).
  it("allows: bun test src/index.test.ts", () => {
    const exe = primaryExecutable("bun test src/index.test.ts", VERIFIER_SCOPE);
    expect(exe && isExecutableAllowed(exe, VERIFIER_SCOPE)).toBe(true);
  });

  // gatherEvidence's own "catastrophic command blocked" example (ISC 1 + WorkOrchestrator.test.ts).
  const catastrophicExamples = [
    "rm -rf /tmp",
    "git reset --hard main",
    "git push --force origin main",
    "git push origin main --force",
    "DROP DATABASE production",
    "DROP SCHEMA public",
    "mkfs.ext4 /dev/sda",
  ];
  it.each(catastrophicExamples)("blocked pre-refactor (CATASTROPHIC_PATTERNS): %s", (cmd) => {
    expect(isCatastrophicCommand(cmd).blocked).toBe(true);
  });

  const nonCatastrophicExamples = ["git add .", "bun test", "git push origin feature-branch"];
  it.each(nonCatastrophicExamples)("NOT catastrophic pre-refactor: %s", (cmd) => {
    expect(isCatastrophicCommand(cmd).blocked).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Context 2 — "self-verify" (SelfVerifyRunner.ts SELF_VERIFY_ALLOWED_EXECUTABLES
// + SELF_VERIFY_CATASTROPHIC, exposed as isSelfVerifyCommandSafe()).
//
// Provenance: literal examples from SelfVerifyRunner.test.ts
// ("isSelfVerifyCommandSafe" describe block) — copied verbatim.
// ---------------------------------------------------------------------------

describe("compat: self-verify context (SelfVerifyRunner.ts isSelfVerifyCommandSafe)", () => {
  const allowed = [
    "bun test ./Foo.test.ts",
    "bunx tsc --noEmit",
    "curl -s localhost:3000/health",
    "/usr/local/bin/node script.js",
  ];
  it.each(allowed)("allowed pre-refactor: %s", (cmd) => {
    expect(isSelfVerifyCommandSafe(cmd)).toBe(true);
  });

  const deniedNeverClaude = ["claude -p --dangerously-skip-permissions 'go'"];
  it.each(deniedNeverClaude)("NEVER allowed (claude): %s", (cmd) => {
    expect(isSelfVerifyCommandSafe(cmd)).toBe(false);
  });

  const deniedNotAllowlisted = ["python evil.py", "FOO=bar bun test"];
  it.each(deniedNotAllowlisted)("denied pre-refactor (not allowlisted): %s", (cmd) => {
    expect(isSelfVerifyCommandSafe(cmd)).toBe(false);
  });

  const deniedCatastrophic = [
    "bun run x && rm -rf /",
    "git push --force origin main",
    "bun run db && drop database prod",
  ];
  it.each(deniedCatastrophic)("denied pre-refactor (catastrophic even with allowlisted first token): %s", (cmd) => {
    expect(isSelfVerifyCommandSafe(cmd)).toBe(false);
  });

  // Cross-checked directly against the new shared function too — proves
  // SelfVerifyRunner.isSelfVerifyCommandSafe is now a thin wrapper over
  // CommandSafety.isCommandSafe(cmd, SELF_VERIFY_SCOPE) with identical results.
  it("isSelfVerifyCommandSafe(cmd) === isCommandSafe(cmd, SELF_VERIFY_SCOPE) for every example above", () => {
    for (const cmd of [...allowed, ...deniedNeverClaude, ...deniedNotAllowlisted, ...deniedCatastrophic]) {
      expect(isSelfVerifyCommandSafe(cmd)).toBe(isCommandSafe(cmd, SELF_VERIFY_SCOPE));
    }
  });
});

// ---------------------------------------------------------------------------
// Context 3 — "command-runner" (CommandRunner.ts ALLOWED_EXECUTABLES +
// SAFE_GIT_SUBCOMMANDS, consumed by parseVerificationCommand()).
//
// Provenance: literal examples from WorkOrchestrator.test.ts's
// "parseVerificationCommand security" describe block (exercises the same
// CommandRunner instance via WorkOrchestrator's delegate method) — copied
// verbatim.
// ---------------------------------------------------------------------------

describe("compat: command-runner context (CommandRunner.ts parseVerificationCommand)", () => {
  const allowedExecutables = ["bun", "node", "npx", "grep", "rg", "test", "diff", "wc", "jq", "ls", "cat", "head", "tail"];
  it.each(allowedExecutables)("executable allowed pre-refactor: %s", (exe) => {
    expect(isExecutableAllowed(exe, COMMAND_RUNNER_SCOPE)).toBe(true);
  });

  const deniedExecutables = ["curl", "python", "wget", "rm", "echo", "tsc", "bunx", "npm", "sh", "bash", "find", "stat"];
  it.each(deniedExecutables)("executable denied pre-refactor: %s", (exe) => {
    expect(isExecutableAllowed(exe, COMMAND_RUNNER_SCOPE)).toBe(false);
  });

  it("bare git is NOT allowlisted as an executable (only specific read-only subcommands)", () => {
    expect(isExecutableAllowed("git", COMMAND_RUNNER_SCOPE)).toBe(false);
  });

  const safeGitSubcommands = ["diff", "log", "show", "status", "rev-parse", "merge-base"];
  it("safe git subcommands allowed pre-refactor", () => {
    const scope = COMMAND_RUNNER_SCOPE.git;
    expect(typeof scope).toBe("object");
    if (typeof scope === "object") {
      for (const sub of safeGitSubcommands) {
        expect(scope.subcommands.includes(sub)).toBe(true);
      }
    }
  });

  const mutatingGitSubcommands = ["checkout", "reset", "push", "commit", "config", "branch", "clean"];
  it("mutating git subcommands rejected pre-refactor", () => {
    const scope = COMMAND_RUNNER_SCOPE.git;
    expect(typeof scope).toBe("object");
    if (typeof scope === "object") {
      for (const sub of mutatingGitSubcommands) {
        expect(scope.subcommands.includes(sub)).toBe(false);
      }
    }
  });
});
