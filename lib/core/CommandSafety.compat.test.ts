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
import { SELF_VERIFY_SCOPE, isCatastrophicCommand, isCommandSafe } from "./CommandSafety.ts";

// ---------------------------------------------------------------------------
// Shared catastrophic floor. These examples came from the deleted "verifier"
// context (gatherEvidence / WorkOrchestrator.test.ts); the floor is
// scope-independent, so they still pin it. The verifier and command-runner
// scope blocks were removed with their scopes on 2026-11-08.
// ---------------------------------------------------------------------------

describe("compat: shared catastrophic floor", () => {
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
// "self-verify" (SelfVerifyRunner.ts SELF_VERIFY_ALLOWED_EXECUTABLES
// + SELF_VERIFY_CATASTROPHIC, exposed as isSelfVerifyCommandSafe()).
//
// Provenance: literal examples from SelfVerifyRunner.test.ts
// ("isSelfVerifyCommandSafe" describe block) — copied verbatim.
// SelfVerifyRunner.ts was deleted 2026-11-05; its isSelfVerifyCommandSafe was a
// thin wrapper over isCommandSafe(cmd, SELF_VERIFY_SCOPE), which the executor's
// verifier prompt still uses, so the cases now pin that function directly.
// ---------------------------------------------------------------------------

const isSelfVerifyCommandSafe = (cmd: string): boolean => isCommandSafe(cmd, SELF_VERIFY_SCOPE);

describe("compat: self-verify context (CommandSafety SELF_VERIFY_SCOPE)", () => {
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
});
