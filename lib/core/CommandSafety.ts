/**
 * CommandSafety.ts — single shared base for command-execution safety across
 * AutonomousWork's three independently-drifting allow/deny lists:
 *
 *   1. "verifier"       — SkepticalVerifier.ts's VERIFICATION_ALLOWED_EXECUTABLES
 *                          + VerificationUtils.ts's CATASTROPHIC_PATTERNS, consumed
 *                          by lib/verifier/Evidence.ts's gatherEvidence() security
 *                          gate (ISC verification evidence gathering).
 *   2. "self-verify"    — SelfVerifyRunner.ts's SELF_VERIFY_ALLOWED_EXECUTABLES +
 *                          SELF_VERIFY_CATASTROPHIC (Phase L self-verify harness).
 *   3. "command-runner" — CommandRunner.ts's ALLOWED_EXECUTABLES +
 *                          SAFE_GIT_SUBCOMMANDS (ISC verification command
 *                          execution).
 *
 * Design: ONE shared catastrophic denylist (full-command-string regex scan,
 * the union of every pattern previously spread across the two prior denylists)
 * applied as an unconditional floor to all three scopes, plus a shared
 * BASE_SAFE_EXECUTABLES allowlist (the true intersection of all three original
 * executable sets — every context already trusted these, so inheriting them
 * widens nothing) with EXPLICIT per-context extensions declared below.
 *
 * BINDING INVARIANT: consolidation must never silently widen any context's
 * effective allow/deny set — only identical or stricter. See
 * lib/core/CommandSafety.compat.test.ts for the old-vs-new proof per context
 * (each scope's reconstructed allowlist is asserted to equal the original
 * literal Set element-for-element). The only intentional deltas are additive
 * denylist entries (block MORE, never allow more) — see "Documented
 * narrowings" at the bottom of this file.
 */

// ============================================================================
// Catastrophic denylist — shared, unconditional floor for ALL contexts.
// ============================================================================

export type CatastrophicAction =
  | "git_reset_hard_main"
  | "git_reset_hard_any"
  | "git_push_force_main"
  | "git_push_force_any"
  | "rm_rf_root"
  | "drop_database"
  | "format_disk"
  | "fork_bomb"
  | "disk_overwrite";

/**
 * Union of VerificationUtils.ts's (pre-refactor) CATASTROPHIC_PATTERNS and
 * SelfVerifyRunner.ts's (pre-refactor) SELF_VERIFY_CATASTROPHIC. A union of
 * denylists can only block MORE than either original alone — it can never let
 * through a command either original context blocked — so this trivially
 * satisfies the "never widen" invariant for the denylist half of the design.
 */
export const CATASTROPHIC_PATTERNS: Array<{ pattern: RegExp; action: CatastrophicAction }> = [
  // git reset --hard: narrow (main/master only) from VerificationUtils, plus
  // the broader (any branch) form from SelfVerifyRunner. [Documented narrowing:
  // the "verifier" and "command-runner"-adjacent (WorkOrchestrator.isCatastrophic)
  // contexts previously only blocked main/master resets — they now also block
  // resets on any branch. This only removes previously-allowed-but-untested
  // commands; no test asserted such a reset was allowed.]
  { pattern: /git\s+reset\s+--hard.*(?:main|master)/i, action: "git_reset_hard_main" },
  { pattern: /git\s+reset\s+--hard/i, action: "git_reset_hard_any" },

  // git push --force: narrow (main/master only, two orderings) from
  // VerificationUtils, plus the broader (any branch) form from
  // SelfVerifyRunner. [Documented narrowing, same rationale as above.]
  { pattern: /git\s+push\s+(?:--force|-f).*(?:main|master)/i, action: "git_push_force_main" },
  { pattern: /git\s+push.*(?:main|master).*(?:--force|-f)/i, action: "git_push_force_main" },
  { pattern: /git\s+push\s+.*(?:--force|-f)\b/i, action: "git_push_force_any" },

  // rm -rf: VerificationUtils's two forms (root path, home path) plus
  // SelfVerifyRunner's broader flag-order/`$HOME`-aware form.
  { pattern: /rm\s+(?:-rf|-fr|--recursive)\s+\/(?!\s)/i, action: "rm_rf_root" },
  { pattern: /rm\s+(?:-rf|-fr|--recursive)\s+~\//i, action: "rm_rf_root" },
  { pattern: /rm\s+(?:-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r|--recursive)\s+(?:\/|~\/|\$HOME)/i, action: "rm_rf_root" },

  { pattern: /drop\s+database/i, action: "drop_database" },
  { pattern: /drop\s+schema/i, action: "drop_database" },

  { pattern: /mkfs\./i, action: "format_disk" },
  { pattern: /dd\s+if=.*of=\/dev\//i, action: "format_disk" },

  // SelfVerifyRunner-only additions — new to the "verifier" and
  // "command-runner" contexts, but a pure no-op there: neither context's
  // allowlist can ever produce a fork bomb or a raw `> /dev/sda` redirect
  // (no shell subshell/pipe/redirect tokens are ever allowlisted upstream).
  { pattern: /:\s*\(\s*\)\s*\{.*\}\s*;\s*:/, action: "fork_bomb" },
  { pattern: />\s*\/dev\/sda/i, action: "disk_overwrite" },
];

export const PROTECTED_BRANCHES = ["main", "master", "production", "prod"];

/** Full-command-string scan against the shared catastrophic denylist. */
export function isCatastrophicCommand(
  command: string
): { blocked: boolean; action?: CatastrophicAction; reason?: string } {
  for (const { pattern, action } of CATASTROPHIC_PATTERNS) {
    if (pattern.test(command)) {
      return { blocked: true, action, reason: `Catastrophic action detected: ${action}` };
    }
  }
  return { blocked: false };
}

export function isProtectedBranch(branch: string): boolean {
  return PROTECTED_BRANCHES.includes(branch.toLowerCase());
}

// ============================================================================
// Executable allowlists — shared safe base + EXPLICIT per-context extensions.
// ============================================================================

/**
 * The true intersection of all three original executable allowlists. Every
 * context already trusted every one of these executables, so folding them
 * into a shared base widens nothing.
 */
export const BASE_SAFE_EXECUTABLES = new Set([
  "bun", "node", "grep", "test", "diff", "wc", "jq", "ls", "cat", "head", "tail",
]);

/** Executables that are NEVER allowed, in any scope. None of today's three
 * allowlists contained "claude" — this is a defense-in-depth restatement of
 * that fact (SelfVerifyRunner made it explicit; this makes it universal), not
 * a behavior change for any context. */
const NEVER_ALLOWED_EXECUTABLES = new Set(["claude"]);

/**
 * How a scope treats the `git` executable:
 *   "none"                    — git never allowed.
 *   "any"                     — bare git allowed regardless of subcommand,
 *                                subject to the catastrophic-denylist floor
 *                                (matches "verifier" and "self-verify" today).
 *   { subcommands: [...] }    — only these git subcommands are safe (matches
 *                                "command-runner" today).
 */
export type GitScope = "none" | "any" | { subcommands: readonly string[] };

export interface CommandSafetyScope {
  name: string;
  /** Executables allowed in addition to BASE_SAFE_EXECUTABLES. */
  additionalExecutables: readonly string[];
  git: GitScope;
  /** Strip leading directory components before checking the allowlist (e.g.
   * "/usr/local/bin/node" -> "node"). Matches Evidence.ts's and
   * SelfVerifyRunner's basename-based executable check; CommandRunner does
   * NOT do this (exact-string match on the parsed token). */
  stripExecutablePath: boolean;
}

/** Context 1 — SkepticalVerifier.ts / Evidence.ts (ISC evidence gathering). */
export const VERIFIER_SCOPE: CommandSafetyScope = {
  name: "verifier",
  additionalExecutables: ["tsc", "echo", "find", "true", "false", "stat", "file", "which", "pwd"],
  git: "any",
  stripExecutablePath: true,
};

/** Context 2 — SelfVerifyRunner.ts (Phase L self-verify harness). */
export const SELF_VERIFY_SCOPE: CommandSafetyScope = {
  name: "self-verify",
  additionalExecutables: [
    "bunx", "npm", "npx", "pnpm", "yarn", "tsc", "curl", "echo", "find", "true", "false",
    "stat", "file", "which", "pwd", "sleep", "kill", "timeout", "playwright",
  ],
  git: "any",
  stripExecutablePath: true,
};

/** Context 3 — CommandRunner.ts (ISC verification command execution). */
export const COMMAND_RUNNER_SCOPE: CommandSafetyScope = {
  name: "command-runner",
  additionalExecutables: ["npx", "rg"],
  git: { subcommands: ["diff", "log", "show", "status", "rev-parse", "merge-base"] },
  stripExecutablePath: false,
};

/** Resolve a scope's flat executable Set (base ∪ extensions ∪ "git" iff scope.git === "any"). */
export function buildExecutableAllowlist(scope: CommandSafetyScope): Set<string> {
  return new Set([
    ...BASE_SAFE_EXECUTABLES,
    ...scope.additionalExecutables,
    ...(scope.git === "any" ? (["git"] as const) : []),
  ]);
}

export function isExecutableAllowed(executableName: string, scope: CommandSafetyScope): boolean {
  if (NEVER_ALLOWED_EXECUTABLES.has(executableName)) return false;
  // Bare "git" is only allowed as a plain executable-name check when the scope
  // trusts any subcommand ("any"). A { subcommands: [...] } scope validates
  // git through a SEPARATE mechanism (subcommand membership, not bare-exe
  // membership) — see COMMAND_RUNNER_SCOPE and CommandRunner.parseVerificationCommand.
  if (executableName === "git") return scope.git === "any";
  return buildExecutableAllowlist(scope).has(executableName);
}

/**
 * Extract the primary (first-token) executable from a command string.
 * Rejects inline env-var-assignment prefixes (`FOO=bar cmd`) — returns null.
 * Strips directory components to a basename when scope.stripExecutablePath.
 */
export function primaryExecutable(cmd: string, scope: CommandSafetyScope): string | null {
  const first = cmd.trim().split(/\s+/)[0];
  if (!first) return null;
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(first)) return null;
  return scope.stripExecutablePath ? first.split("/").pop() ?? first : first;
}

/**
 * Full command-safety check for scopes that validate the WHOLE command string
 * at once (catastrophic floor + primary-executable allowlist). Matches
 * SelfVerifyRunner's (pre-refactor) isSelfVerifyCommandSafe() and Evidence.ts's
 * inline gate composition.
 */
export function isCommandSafe(cmd: string, scope: CommandSafetyScope): boolean {
  if (!cmd || !cmd.trim()) return false;
  if (isCatastrophicCommand(cmd).blocked) return false;
  const exe = primaryExecutable(cmd, scope);
  if (!exe) return false;
  return isExecutableAllowed(exe, scope);
}

// ============================================================================
// Documented narrowings (see compat suite for the exhaustive proof)
// ============================================================================
//
// 1. git_reset_hard_any / git_push_force_any: the shared catastrophic floor
//    now blocks `git reset --hard <any-branch>` and `git push --force
//    <any-branch>` everywhere (previously only main/master were blocked in
//    the "verifier" context and in WorkOrchestrator.isCatastrophic; the
//    "self-verify" context already blocked these broadly). No known caller
//    or test relies on a non-main/master hard-reset or force-push being
//    allowed through gatherEvidence or WorkOrchestrator.isCatastrophic.
//
// 2. fork_bomb / disk_overwrite patterns: net-new to the "verifier" and
//    "command-runner" contexts. Provably a no-op there — neither context's
//    allowlist ever admits the shell metacharacters (`(`, `)`, `{`, `}`,
//    `;`, `>`) these patterns require, so no currently-passing command could
//    ever have matched them anyway.
//
// 3. "command-runner" now also runs the shared catastrophic-pattern check
//    (previously it relied solely on its strict allowlist + shell-operator
//    rejection + git-subcommand scoping). This is additive defense-in-depth,
//    not a behavior change: CommandRunner.ALLOWED_EXECUTABLES never included
//    `rm`/`dd`/`mkfs`, and its git handling is restricted to
//    diff/log/show/status/rev-parse/merge-base — none of which can match any
//    catastrophic pattern.

// ============================================================================
// Prompt-facing rendering (S12 — one source of truth for lane prose)
// ============================================================================

/**
 * Render a scope's effective allowlist as prompt prose, so agent prompts that
 * INSTRUCT a verifier about safe commands derive from the SAME data that
 * enforcement uses (executorVerify.ts previously hand-wrote this "in the
 * spirit of" SelfVerifyRunner — prose in one lane, code in the other, free to
 * drift). Changing a scope here changes both enforcement and instructions.
 */
export function describeScopeForPrompt(scope: CommandSafetyScope): string {
  const executables = [...BASE_SAFE_EXECUTABLES, ...scope.additionalExecutables].sort();
  const gitLine =
    scope.git === "none"
      ? "git is NOT allowed."
      : scope.git === "any"
        ? "git is allowed (read/inspect freely), subject to the catastrophic-command floor."
        : `git is allowed ONLY for: ${scope.git.subcommands.join(", ")}.`;
  return [
    `Allowed executables (scope "${scope.name}"): ${executables.join(", ")}.`,
    gitLine,
    "Never run `claude`. Never install packages. Never write/edit files or",
    "touch anything outside the current worktree. Never push, publish, or",
    "deploy. Catastrophic command patterns are blocked unconditionally.",
  ].join("\n");
}
