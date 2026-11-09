/**
 * CommandSafety.ts — command-execution safety data for agent prompts.
 *
 * Born as the single shared base for AutonomousWork's three independently-
 * drifting allow/deny lists ("verifier", "self-verify", "command-runner").
 * The AutonomousWork verifiers and CommandRunner were deleted 2026-11-05, and
 * their VERIFIER_SCOPE / COMMAND_RUNNER_SCOPE (and the git-subcommand and
 * no-path-strip variants only they used) were removed 2026-11-08. One scope
 * remains: SELF_VERIFY_SCOPE, which the LucidTasks executor renders into its
 * verifier prompt via describeScopeForPrompt()
 * (skills/Productivity/LucidTasks/Tools/executor/executorVerify.ts).
 *
 * Design: ONE shared catastrophic denylist (full-command-string regex scan)
 * applied as an unconditional floor, plus a shared BASE_SAFE_EXECUTABLES
 * allowlist with EXPLICIT per-scope extensions declared below.
 *
 * BINDING INVARIANT: changes must never silently widen a scope's effective
 * allow/deny set. lib/core/CommandSafety.compat.test.ts pins SELF_VERIFY_SCOPE
 * to its original literal Set element-for-element. The only intentional
 * deltas are additive denylist entries (block MORE, never allow more) — see
 * "Documented narrowings" at the bottom of this file.
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
export function isCatastrophicCommand(command: string): {
  blocked: boolean;
  action?: CatastrophicAction;
  reason?: string;
} {
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
// Executable allowlists — shared safe base + EXPLICIT per-scope extensions.
// ============================================================================

/**
 * The true intersection of the three original executable allowlists (see the
 * module doc). Every context trusted every one of these executables.
 */
export const BASE_SAFE_EXECUTABLES = new Set([
  "bun",
  "node",
  "grep",
  "test",
  "diff",
  "wc",
  "jq",
  "ls",
  "cat",
  "head",
  "tail",
]);

/** Executables that are NEVER allowed, in any scope. No allowlist ever
 * contained "claude" — this is a defense-in-depth restatement of that fact. */
const NEVER_ALLOWED_EXECUTABLES = new Set(["claude"]);

/**
 * How a scope treats the `git` executable:
 *   "none" — git never allowed.
 *   "any"  — bare git allowed regardless of subcommand, subject to the
 *            catastrophic-denylist floor.
 */
type GitScope = "none" | "any";

interface CommandSafetyScope {
  name: string;
  /** Executables allowed in addition to BASE_SAFE_EXECUTABLES. */
  additionalExecutables: readonly string[];
  git: GitScope;
}

/** The executor's self-verify lane (originally SelfVerifyRunner.ts's Phase L harness). */
export const SELF_VERIFY_SCOPE: CommandSafetyScope = {
  name: "self-verify",
  additionalExecutables: [
    "bunx",
    "npm",
    "npx",
    "pnpm",
    "yarn",
    "tsc",
    "curl",
    "echo",
    "find",
    "true",
    "false",
    "stat",
    "file",
    "which",
    "pwd",
    "sleep",
    "kill",
    "timeout",
    "playwright",
  ],
  git: "any",
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
  if (executableName === "git") return scope.git === "any";
  return buildExecutableAllowlist(scope).has(executableName);
}

/**
 * Extract the primary (first-token) executable from a command string.
 * Rejects inline env-var-assignment prefixes (`FOO=bar cmd`) — returns null.
 * Strips directory components to a basename ("/usr/local/bin/node" -> "node").
 */
export function primaryExecutable(cmd: string): string | null {
  const first = cmd.trim().split(/\s+/)[0];
  if (!first) return null;
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(first)) return null;
  return first.split("/").pop() ?? first;
}

/**
 * Full command-safety check on the WHOLE command string (catastrophic floor +
 * primary-executable allowlist). Matches SelfVerifyRunner's (pre-refactor)
 * isSelfVerifyCommandSafe().
 */
export function isCommandSafe(cmd: string, scope: CommandSafetyScope): boolean {
  if (!cmd?.trim()) return false;
  if (isCatastrophicCommand(cmd).blocked) return false;
  const exe = primaryExecutable(cmd);
  if (!exe) return false;
  return isExecutableAllowed(exe, scope);
}

// ============================================================================
// Documented narrowings
// ============================================================================
//
// The shared floor's broad git_reset_hard_any / git_push_force_any and
// fork_bomb / disk_overwrite patterns were narrowings only for the deleted
// "verifier" and "command-runner" contexts; "self-verify" already blocked
// them before consolidation, so SELF_VERIFY_SCOPE has no deltas.

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
      : "git is allowed (read/inspect freely), subject to the catastrophic-command floor.";
  return [
    `Allowed executables (scope "${scope.name}"): ${executables.join(", ")}.`,
    gitLine,
    "Never run `claude`. Never install packages. Never write/edit files or",
    "touch anything outside the current worktree. Never push, publish, or",
    "deploy. Catastrophic command patterns are blocked unconditionally.",
  ].join("\n");
}
