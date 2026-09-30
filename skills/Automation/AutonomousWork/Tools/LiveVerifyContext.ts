#!/usr/bin/env bun
/**
 * LiveVerifyContext.ts — decides HOW Phase L live verification runs in the
 * current execution context.
 *
 * Phase L's default engine is a headless `claude -p --dangerously-skip-permissions`
 * Explorer (LiveVerifier.defaultRunExplorer). That dangerous spawn is HARD-BLOCKED
 * by the auto-mode classifier inside an interactive Claude Code session — so in
 * interactive context it can never produce live evidence: the item fails Phase L,
 * burns its retries, and ends up parked on the "Needs Jm" board forever.
 *
 * This module gives Phase L a context-aware choice WITHOUT weakening the classifier:
 *   - "explorer"    → the existing dangerous Explorer (authorized autonomous/cron only)
 *   - "self-verify" → a non-dangerous deterministic harness (SelfVerifyRunner) that
 *                     drives the artifact with plain allowlisted commands (no claude -p,
 *                     no --dangerously-skip-permissions)
 *
 * Detection (first match wins):
 *   1. KAYA_LIVE_VERIFY_MODE = "explorer" | "self-verify"   (explicit override / test seam)
 *   2. authorized autonomous/cron (KAYA_CRON_JOB_ID set, or KAYA_AUTONOMOUS truthy) → "explorer"
 *   3. interactive session (CLAUDECODE set) → "self-verify"  (dangerous spawn would be blocked)
 *   4. default → "self-verify"  (never attempt the blocked spawn from a bare/unknown context)
 *
 * The default is intentionally the SAFE side: self-verify never attempts the
 * classifier-blocked spawn, and still actually runs the artifact. The dangerous
 * Explorer only runs where it already works (cron / explicitly-authorized autonomous).
 */

export type LiveVerifyMode = "explorer" | "self-verify";

export interface LiveVerifyContextEnv {
  KAYA_LIVE_VERIFY_MODE?: string;
  KAYA_CRON_JOB_ID?: string;
  KAYA_AUTONOMOUS?: string;
  CLAUDECODE?: string;
}

export interface LiveVerifyContext {
  mode: LiveVerifyMode;
  /** Human-readable explanation — surfaced in logs/transcripts so a by-design
   *  fallback is never mistaken for a malfunction. */
  reason: string;
}

function truthy(v: string | undefined): boolean {
  const s = (v ?? "").trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes";
}

export function resolveLiveVerifyContext(
  env: LiveVerifyContextEnv = process.env as LiveVerifyContextEnv,
): LiveVerifyContext {
  const override = (env.KAYA_LIVE_VERIFY_MODE ?? "").trim().toLowerCase();
  if (override === "explorer") {
    return { mode: "explorer", reason: "KAYA_LIVE_VERIFY_MODE=explorer (explicit override)" };
  }
  if (override === "self-verify" || override === "self_verify") {
    return { mode: "self-verify", reason: "KAYA_LIVE_VERIFY_MODE=self-verify (explicit override)" };
  }

  // Authorized autonomous/cron context — the dangerous Explorer is permitted here
  // and already works. Cron is checked before the interactive signal because a cron
  // `claude -p` run sets BOTH CLAUDECODE and KAYA_CRON_JOB_ID.
  if (env.KAYA_CRON_JOB_ID) {
    return { mode: "explorer", reason: `authorized cron context (KAYA_CRON_JOB_ID=${env.KAYA_CRON_JOB_ID})` };
  }
  if (truthy(env.KAYA_AUTONOMOUS)) {
    return { mode: "explorer", reason: "authorized autonomous context (KAYA_AUTONOMOUS)" };
  }

  // Interactive Claude Code session — the dangerous Explorer spawn is classifier-blocked.
  if (env.CLAUDECODE) {
    return {
      mode: "self-verify",
      reason: "interactive Claude Code session (CLAUDECODE) — dangerous Explorer spawn is classifier-blocked; using non-dangerous self-verify",
    };
  }

  return { mode: "self-verify", reason: "non-authorized context — defaulting to non-dangerous self-verify" };
}

export function resolveLiveVerifyMode(
  env: LiveVerifyContextEnv = process.env as LiveVerifyContextEnv,
): LiveVerifyMode {
  return resolveLiveVerifyContext(env).mode;
}
