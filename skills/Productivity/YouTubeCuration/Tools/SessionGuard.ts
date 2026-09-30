#!/usr/bin/env bun
/**
 * SessionGuard.ts — deterministic check that the current session is the
 * `bin/claude-browser` session (spec.md §3, §12.7; SKILL.md's Session split).
 *
 * `prune`, `wl`, and `steer`'s seeding pass need claude-in-chrome driving
 * Jm's real logged-in Chrome. Every DOM subcommand runbook in SKILL.md must
 * run this check FIRST and STOP on failure — no handoff machinery, ever
 * (CLAUDE.md's banned-landmine rule against auto-launching a terminal
 * session).
 *
 * DETECTION MECHANISM, confirmed by reading `bin/claude-browser` itself
 * (line 160: `export CLAUDE_CONFIG_DIR="$BROWSER_HOME"`; BROWSER_HOME is
 * derived a few lines earlier as `"${CLAUDE_BROWSER_HOME:-$HOME/.claude-browser-home}"`):
 * the browser session is the ONLY place `CLAUDE_CONFIG_DIR` is set to that
 * exact private config dir. This module mirrors that same derivation
 * (honoring a `CLAUDE_BROWSER_HOME` override, not a hardcoded literal) so it
 * can never drift from what the launcher actually sets. Ordinary sessions
 * leave `CLAUDE_CONFIG_DIR` unset or pointed at the default config dir —
 * either way, they fail this check.
 *
 * Deterministic by design: this is a hard safety boundary (which real
 * session is driving the browser), not a content judgment — exactly the
 * class of gate that's supposed to be coded, per this repo's
 * determinism-earns-its-place principle.
 */

import { homedir } from "node:os";

/** The exact one-line pointer SKILL.md's Session split promises — printed verbatim, never paraphrased, so every failure mode looks identical to Jm regardless of which subcommand triggered it. */
export function pointerLine(cmd: string): string {
  return `run /youtube ${cmd} from the claude-browser session.`;
}

/**
 * The `CLAUDE_CONFIG_DIR` value that ONLY the `bin/claude-browser` launcher
 * sets — mirrors that script's own `BROWSER_HOME` derivation exactly.
 */
export function expectedBrowserConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  // NOT the Kaya home — this is the claude-browser session's private
  // CLAUDE_CONFIG_DIR (bin/claude-browser:58). getKayaHome() would be wrong
  // here by definition; the derivation must mirror the launcher's own
  // `${CLAUDE_BROWSER_HOME:-$HOME/.claude-browser-home}` exactly.
  return env.CLAUDE_BROWSER_HOME || `${homedir()}/.claude-browser-home`;
}

/** True iff the CURRENT process env is inside the `bin/claude-browser` session. Pure — takes `env` so tests never depend on the real process's actual env. */
export function isBrowserSession(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CLAUDE_CONFIG_DIR === expectedBrowserConfigDir(env);
}

export interface SessionCheckResult {
  ok: boolean;
  /** Non-null only when `ok` is false — the exact pointer line to show Jm. */
  message: string | null;
}

/** Env-injectable check — the pure decision this whole module exists for. */
export function checkSession(cmd: string, env: NodeJS.ProcessEnv = process.env): SessionCheckResult {
  if (isBrowserSession(env)) return { ok: true, message: null };
  return { ok: false, message: pointerLine(cmd) };
}

// ----------------------------------------------------------------------------
// CLI — SKILL.md's DOM runbooks invoke this first and STOP on a nonzero exit.
// ----------------------------------------------------------------------------

async function main(): Promise<void> {
  const cmd = process.argv[2];
  if (!cmd) {
    console.error("Usage: bun SessionGuard.ts <cmd>   (e.g. prune | wl | steer)");
    process.exit(1);
  }
  const result = checkSession(cmd);
  if (!result.ok) {
    console.error(result.message);
    process.exit(1);
  }
  process.exit(0);
}

if (import.meta.main) {
  main();
}
