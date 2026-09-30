/**
 * CommandSafety.test.ts — Unit tests for the shared command-execution safety
 * module (denylist + base allowlist + per-context scopes).
 *
 * See CommandSafety.compat.test.ts for the old-vs-new behavioral compatibility
 * proof against the three call sites this module consolidates:
 *   1. SkepticalVerifier.ts + VerificationUtils.ts (via Evidence.ts's evidence-
 *      gathering security gate) — "verifier" scope
 *   2. SelfVerifyRunner.ts (Phase L self-verify harness) — "self-verify" scope
 *   3. CommandRunner.ts (ISC verification command execution) — "command-runner"
 *      scope
 */

import { describe, it, expect } from "bun:test";
import {
  CATASTROPHIC_PATTERNS,
  PROTECTED_BRANCHES,
  isCatastrophicCommand,
  isProtectedBranch,
  BASE_SAFE_EXECUTABLES,
  VERIFIER_SCOPE,
  SELF_VERIFY_SCOPE,
  COMMAND_RUNNER_SCOPE,
  buildExecutableAllowlist,
  isExecutableAllowed,
  primaryExecutable,
  isCommandSafe,
  type CatastrophicAction,
} from "./CommandSafety.ts";

// ---------------------------------------------------------------------------
// Catastrophic denylist (shared floor — union of all prior sources)
// ---------------------------------------------------------------------------

describe("isCatastrophicCommand — shared denylist floor", () => {
  const blocked: Array<[string, string]> = [
    ["git reset --hard main", "narrow (VerificationUtils) reset-hard-main"],
    ["git reset --hard some-other-branch", "broad (SelfVerifyRunner) reset-hard-any"],
    ["git push --force origin main", "narrow force-push-main (force before branch)"],
    ["git push origin main --force", "narrow force-push-main (force after branch)"],
    ["git push --force origin feature-branch", "broad (SelfVerifyRunner) force-push-any"],
    ["rm -rf /etc", "rm -rf root path"],
    ["rm -rf ~/", "rm -rf home"],
    ["rm -rf $HOME", "rm -rf $HOME (SelfVerifyRunner variant)"],
    ["DROP DATABASE production", "drop database"],
    ["DROP SCHEMA public", "drop schema"],
    ["mkfs.ext4 /dev/sda", "mkfs"],
    ["dd if=/dev/zero of=/dev/sda", "dd disk overwrite"],
    [":(){ :|:& };:", "fork bomb (SelfVerifyRunner-only)"],
    ["echo hi > /dev/sda", "raw disk overwrite (SelfVerifyRunner-only)"],
  ];

  for (const [cmd, label] of blocked) {
    it(`blocks: ${label} ("${cmd}")`, () => {
      expect(isCatastrophicCommand(cmd).blocked).toBe(true);
    });
  }

  const safe: string[] = ["git add .", "bun test", "git push origin feature-branch", "grep -r pattern src/"];
  for (const cmd of safe) {
    it(`allows (not catastrophic): "${cmd}"`, () => {
      expect(isCatastrophicCommand(cmd).blocked).toBe(false);
    });
  }

  it("returns a named action on block", () => {
    const r = isCatastrophicCommand("rm -rf /etc");
    expect(r.blocked).toBe(true);
    expect(r.action).toBeTruthy();
  });

  it("CATASTROPHIC_PATTERNS is a non-empty array of {pattern, action}", () => {
    expect(CATASTROPHIC_PATTERNS.length).toBeGreaterThan(0);
    for (const entry of CATASTROPHIC_PATTERNS) {
      expect(entry.pattern).toBeInstanceOf(RegExp);
      expect(typeof entry.action).toBe("string");
    }
  });
});

describe("isProtectedBranch", () => {
  it.each(["main", "master", "production", "prod"])("detects %s as protected", (b) => {
    expect(isProtectedBranch(b)).toBe(true);
  });
  it.each(["feature/my-work", "develop"])("allows %s as unprotected", (b) => {
    expect(isProtectedBranch(b)).toBe(false);
  });
  it("PROTECTED_BRANCHES matches the exported list", () => {
    expect(PROTECTED_BRANCHES).toEqual(["main", "master", "production", "prod"]);
  });
});

// ---------------------------------------------------------------------------
// Shared base allowlist + per-context scopes
// ---------------------------------------------------------------------------

describe("BASE_SAFE_EXECUTABLES — true intersection of all 3 original allowlists", () => {
  it("contains exactly the 11 executables common to all three original contexts", () => {
    expect([...BASE_SAFE_EXECUTABLES].sort()).toEqual(
      ["bun", "cat", "diff", "grep", "head", "jq", "ls", "node", "tail", "test", "wc"].sort()
    );
  });
});

describe("buildExecutableAllowlist — per-context scope reconstruction", () => {
  it("VERIFIER_SCOPE reconstructs the original 21-executable VERIFICATION_ALLOWED_EXECUTABLES set exactly", () => {
    const set = buildExecutableAllowlist(VERIFIER_SCOPE);
    const expected = new Set([
      "bun", "node", "tsc", "cat", "ls", "echo", "wc", "grep",
      "find", "test", "true", "false", "git", "jq", "head", "tail",
      "diff", "stat", "file", "which", "pwd",
    ]);
    expect(set).toEqual(expected);
  });

  it("SELF_VERIFY_SCOPE reconstructs the original 31-executable SELF_VERIFY_ALLOWED_EXECUTABLES set exactly", () => {
    const set = buildExecutableAllowlist(SELF_VERIFY_SCOPE);
    const expected = new Set([
      "bun", "bunx", "node", "npm", "npx", "pnpm", "yarn",
      "tsc", "curl", "git", "cat", "ls", "echo", "wc", "grep",
      "find", "test", "true", "false", "jq", "head", "tail",
      "diff", "stat", "file", "which", "pwd", "sleep", "kill", "timeout",
      "playwright",
    ]);
    expect(set).toEqual(expected);
  });

  it("COMMAND_RUNNER_SCOPE reconstructs the original 13-executable ALLOWED_EXECUTABLES set exactly (git excluded — handled via subcommand scope)", () => {
    const set = buildExecutableAllowlist(COMMAND_RUNNER_SCOPE);
    const expected = new Set([
      "bun", "node", "npx", "grep", "rg", "test", "diff", "wc", "jq", "ls", "cat", "head", "tail",
    ]);
    expect(set).toEqual(expected);
    expect(set.has("git")).toBe(false);
  });

  it("COMMAND_RUNNER_SCOPE.git carries the original 6 safe git subcommands exactly", () => {
    const git = COMMAND_RUNNER_SCOPE.git;
    expect(typeof git).toBe("object");
    if (typeof git === "object") {
      expect([...git.subcommands].sort()).toEqual(
        ["diff", "log", "show", "status", "rev-parse", "merge-base"].sort()
      );
    }
  });
});

describe("isExecutableAllowed", () => {
  it("allows executables unique to one scope only within that scope", () => {
    expect(isExecutableAllowed("curl", SELF_VERIFY_SCOPE)).toBe(true);
    expect(isExecutableAllowed("curl", VERIFIER_SCOPE)).toBe(false);
    expect(isExecutableAllowed("curl", COMMAND_RUNNER_SCOPE)).toBe(false);

    expect(isExecutableAllowed("rg", COMMAND_RUNNER_SCOPE)).toBe(true);
    expect(isExecutableAllowed("rg", VERIFIER_SCOPE)).toBe(false);
    expect(isExecutableAllowed("rg", SELF_VERIFY_SCOPE)).toBe(false);

    expect(isExecutableAllowed("echo", VERIFIER_SCOPE)).toBe(true);
    expect(isExecutableAllowed("echo", COMMAND_RUNNER_SCOPE)).toBe(false);
  });

  it("treats bare git per scope.git mode", () => {
    expect(isExecutableAllowed("git", VERIFIER_SCOPE)).toBe(true); // "any"
    expect(isExecutableAllowed("git", SELF_VERIFY_SCOPE)).toBe(true); // "any"
    expect(isExecutableAllowed("git", COMMAND_RUNNER_SCOPE)).toBe(false); // subcommand-scoped, not a bare-exe allow
  });

  it("never allows 'claude' in any scope (defense-in-depth floor)", () => {
    expect(isExecutableAllowed("claude", VERIFIER_SCOPE)).toBe(false);
    expect(isExecutableAllowed("claude", SELF_VERIFY_SCOPE)).toBe(false);
    expect(isExecutableAllowed("claude", COMMAND_RUNNER_SCOPE)).toBe(false);
  });

  it("rejects executables in none of the scopes", () => {
    expect(isExecutableAllowed("python", VERIFIER_SCOPE)).toBe(false);
    expect(isExecutableAllowed("python", SELF_VERIFY_SCOPE)).toBe(false);
    expect(isExecutableAllowed("python", COMMAND_RUNNER_SCOPE)).toBe(false);
  });
});

describe("primaryExecutable", () => {
  it("strips directory path when scope.stripExecutablePath is true", () => {
    expect(primaryExecutable("/usr/local/bin/node script.js", VERIFIER_SCOPE)).toBe("node");
    expect(primaryExecutable("/usr/local/bin/node script.js", SELF_VERIFY_SCOPE)).toBe("node");
  });

  it("does NOT strip directory path when scope.stripExecutablePath is false", () => {
    expect(primaryExecutable("/usr/local/bin/node script.js", COMMAND_RUNNER_SCOPE)).toBe("/usr/local/bin/node");
  });

  it("rejects inline env-var-assignment prefixes (FOO=bar cmd)", () => {
    expect(primaryExecutable("FOO=bar bun test", SELF_VERIFY_SCOPE)).toBeNull();
  });

  it("returns null for empty/whitespace-only input", () => {
    expect(primaryExecutable("", SELF_VERIFY_SCOPE)).toBeNull();
    expect(primaryExecutable("   ", SELF_VERIFY_SCOPE)).toBeNull();
  });
});

describe("isCommandSafe — combined catastrophic + allowlist check (self-verify shape)", () => {
  it("allows allowlisted, non-catastrophic commands", () => {
    expect(isCommandSafe("bun test ./Foo.test.ts", SELF_VERIFY_SCOPE)).toBe(true);
    expect(isCommandSafe("bunx tsc --noEmit", SELF_VERIFY_SCOPE)).toBe(true);
    expect(isCommandSafe("curl -s localhost:3000/health", SELF_VERIFY_SCOPE)).toBe(true);
    expect(isCommandSafe("/usr/local/bin/node script.js", SELF_VERIFY_SCOPE)).toBe(true);
  });

  it("blocks non-allowlisted executables", () => {
    expect(isCommandSafe("python evil.py", SELF_VERIFY_SCOPE)).toBe(false);
    expect(isCommandSafe("FOO=bar bun test", SELF_VERIFY_SCOPE)).toBe(false);
  });

  it("blocks catastrophic commands even when the first token is allowlisted", () => {
    expect(isCommandSafe("bun run x && rm -rf /", SELF_VERIFY_SCOPE)).toBe(false);
    expect(isCommandSafe("git push --force origin main", SELF_VERIFY_SCOPE)).toBe(false);
    expect(isCommandSafe("bun run db && drop database prod", SELF_VERIFY_SCOPE)).toBe(false);
  });

  it("never allows claude regardless of scope", () => {
    expect(isCommandSafe("claude -p --dangerously-skip-permissions 'go'", SELF_VERIFY_SCOPE)).toBe(false);
  });
});
