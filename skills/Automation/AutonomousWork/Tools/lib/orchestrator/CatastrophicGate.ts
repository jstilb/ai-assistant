/**
 * CatastrophicGate.ts — command-safety gate: detect destructive commands and
 * protected git branches.
 *
 * Extracted from WorkOrchestrator.ts (S11 decomposition, pass 1). Pure functions —
 * no state, no DI beyond the shared CATASTROPHIC_PATTERNS/PROTECTED_BRANCHES
 * constants, which are already centralized in VerificationUtils.ts (itself a
 * re-export of lib/core/CommandSafety.ts — the single cross-module source of truth).
 */

import { CATASTROPHIC_PATTERNS, PROTECTED_BRANCHES, type CatastrophicAction } from "../../VerificationUtils.ts";

/** Detect a catastrophic/destructive command against the shared CATASTROPHIC_PATTERNS allowlist. */
export function isCatastrophic(command: string): { blocked: boolean; action?: CatastrophicAction; reason?: string } {
  for (const { pattern, action } of CATASTROPHIC_PATTERNS) {
    if (pattern.test(command)) {
      return { blocked: true, action, reason: `Catastrophic action detected: ${action}` };
    }
  }
  return { blocked: false };
}

/** Detect a protected git branch (main/master/production/prod — case-insensitive). */
export function isProtectedBranch(branch: string): boolean {
  return PROTECTED_BRANCHES.includes(branch.toLowerCase());
}
