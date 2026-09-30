#!/usr/bin/env bun
/**
 * SelfVerifyRunner.ts — non-dangerous deterministic Phase L harness.
 *
 * Used when the dangerous `claude -p --dangerously-skip-permissions` Explorer is
 * NOT permitted (interactive context — see LiveVerifyContext). Instead of spawning
 * a headless agent, it ACTUALLY RUNS the artifact with plain allowlisted shell
 * commands (no `claude`, no `--dangerously-skip-permissions`), captures real
 * transcripts, and emits a real PASS/FAIL. This keeps Phase L's "the artifact must
 * actually run" guarantee while giving it a path the auto-mode classifier does not
 * block.
 *
 * Safety (does NOT weaken any existing gate — it adds a narrower one):
 *   - Every command's PRIMARY executable must be allowed by the "self-verify"
 *     scope (lib/core/CommandSafety.ts's SELF_VERIFY_SCOPE).
 *   - The FULL command string is scanned for catastrophic patterns (rm -rf /,
 *     force-push, drop database, fork bombs, …) — stronger than first-token-only.
 *   - `claude` is never runnable here, so the blocked spawn can never recur.
 *
 * When the harness genuinely cannot run anything (no allowlisted command available),
 * it returns `environmentBlocked: true` — a distinct signal from a code FAIL. The
 * upstream pipeline re-stages such items to pending for the next eligible run rather
 * than escalating them to the human board (Principle B2 / Slice 2).
 */

import { spawnSync } from "child_process";
import { mkdirSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import {
  LIVE_BUDGETS,
  type LiveVerifierInput,
  type LiveVerificationResult,
  type LiveExerciseScenario,
} from "./LiveVerifier.ts";
import { SELF_VERIFY_SCOPE, isCommandSafe } from "../../../../lib/core/CommandSafety.ts";
import { getKayaHome } from "../../../../lib/core/KayaHome.ts";

// Reads KAYA_HOME env override → getKayaHome() (memoized).
const KAYA_HOME = getKayaHome();
const DEFAULT_PERSIST_DIR = join(KAYA_HOME, "MEMORY", "AutonomousWork", "live-verification");

export interface SelfVerifyDeps {
  /** Injectable command executor (default: spawnSync via bash -lc). */
  exec?: (cmd: string, opts: { cwd: string; timeoutMs: number }) => ExecResult;
  /** Injectable clock for deterministic tests. Defaults to Date.now. */
  now?: () => number;
  /** Defaults to MEMORY/AutonomousWork/live-verification. */
  persistDir?: string;
  /** Injectable transcript writer. Defaults to fs writeFileSync (+ mkdir). */
  writeTranscript?: (path: string, data: string) => void;
  /** Detection reason, threaded into the transcript/warnings for observability. */
  contextReason?: string;
  /** Test seam: override tsconfig existence check (default reads disk). */
  hasTsconfig?: (workingDir: string) => boolean;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}

/**
 * True when a command is safe to run in the self-verify harness. Moved to
 * lib/core/CommandSafety.ts (L2 command-safety consolidation) — this is a
 * thin wrapper over isCommandSafe(cmd, SELF_VERIFY_SCOPE), which folds in the
 * shared catastrophic-pattern floor, the "self-verify" allowlist (deliberately
 * excludes `claude`; adds browser/test-runner tooling — bunx/npx/playwright —
 * on top of the shared base), and the env-assignment-prefix rejection.
 */
export function isSelfVerifyCommandSafe(cmd: string): boolean {
  return isCommandSafe(cmd, SELF_VERIFY_SCOPE);
}

const defaultExec = (cmd: string, opts: { cwd: string; timeoutMs: number }): ExecResult => {
  const res = spawnSync("bash", ["-lc", cmd], {
    cwd: opts.cwd,
    timeout: opts.timeoutMs,
    encoding: "utf-8",
    maxBuffer: 32 * 1024 * 1024,
  });
  const timedOut = res.signal === "SIGTERM";
  return {
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
    exitCode: res.status ?? (timedOut ? 124 : 1),
    timedOut,
  };
};

function defaultHasTsconfig(workingDir: string): boolean {
  try {
    return existsSync(join(workingDir, "tsconfig.json"));
  } catch {
    return false;
  }
}

/**
 * Build the list of real exercises to run. Priority:
 *   1. caller-supplied selfVerifyCommands (ISC verify commands + spec run command)
 *   2. a surface-appropriate smoke default (typecheck the changed code when a
 *      tsconfig is present — a real compile, not a test)
 * Deduped, order-preserving.
 */
export function buildSelfVerifyCommands(
  input: LiveVerifierInput,
  hasTsconfig: (dir: string) => boolean,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (c: string) => {
    const t = c.trim();
    if (t && !seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  };

  for (const c of input.selfVerifyCommands ?? []) push(c);

  // Smoke default: a real typecheck of the changed code. Catches "compiles?" for
  // every TypeScript surface and guarantees we always have something real to run.
  if (hasTsconfig(input.workingDir)) {
    push("bunx tsc --noEmit");
  }

  return out;
}

/**
 * Run the non-dangerous deterministic self-verify harness for one work item.
 * Returns a LiveVerificationResult shaped exactly like the Explorer path so the
 * Phase L gate is engine-agnostic.
 */
export async function runSelfVerify(
  input: LiveVerifierInput,
  deps: SelfVerifyDeps = {},
): Promise<LiveVerificationResult> {
  const now = deps.now ?? (() => Date.now());
  const start = now();
  const exec = deps.exec ?? defaultExec;
  const hasTsconfig = deps.hasTsconfig ?? defaultHasTsconfig;
  const budget = LIVE_BUDGETS[input.effort];
  const warnings: string[] = [];
  if (deps.contextReason) warnings.push(`self-verify engine selected: ${deps.contextReason}`);

  // Native UI can never be auto-driven here — defer to a human/device check.
  if (input.surface === "native") {
    return {
      surface: "native",
      effort: input.effort,
      verdict: "HUMAN_REQUIRED",
      humanVerificationRequired: true,
      scenarios: [],
      scenariosRun: 0,
      scenariosPassed: 0,
      scenariosFailed: 0,
      edgeCasesExplored: 0,
      explorationTimeMs: now() - start,
      warnings: [
        ...warnings,
        "native UI requires a human/device check (no iOS simulator / Android emulator here) — disposition human-required; do not auto-DONE",
      ],
      noEvidence: false,
      mode: "self-verify",
      environmentBlocked: false,
    };
  }

  const candidates = buildSelfVerifyCommands(input, hasTsconfig);
  const safe = candidates.filter(isSelfVerifyCommandSafe);
  const dropped = candidates.length - safe.length;
  if (dropped > 0) {
    warnings.push(`${dropped} self-verify command(s) skipped (not allowlisted or unsafe)`);
  }

  const scenarios: LiveExerciseScenario[] = [];
  const perCommandTimeout = Math.min(budget.timeBudgetMs, 120_000);
  for (let i = 0; i < safe.length; i++) {
    if (now() - start > budget.timeBudgetMs) {
      warnings.push(`self-verify time budget (${budget.timeBudgetMs}ms) exceeded — stopped after ${i} command(s)`);
      break;
    }
    const cmd = safe[i];
    let r: ExecResult;
    try {
      r = exec(cmd, { cwd: input.workingDir, timeoutMs: perCommandTimeout });
    } catch (err) {
      r = { stdout: "", stderr: err instanceof Error ? err.message : String(err), exitCode: 1, timedOut: false };
    }
    const observed = (r.stdout || r.stderr || "").slice(-1500);
    scenarios.push({
      id: `sv${i + 1}`,
      kind: i === 0 ? "happy" : "edge",
      description: `self-verify exercise: ${cmd}`,
      command: cmd,
      expected: "exit 0 (artifact runs cleanly)",
      observed,
      exitCode: r.exitCode,
      verdict: r.exitCode === 0 && !r.timedOut ? "PASS" : "FAIL",
    });
    if (r.timedOut) warnings.push(`command timed out: ${cmd}`);
  }

  const scenariosRun = scenarios.length;
  const scenariosPassed = scenarios.filter((s) => s.verdict === "PASS").length;
  const scenariosFailed = scenarios.filter((s) => s.verdict === "FAIL").length;
  const edgeCasesExplored = scenarios.filter((s) => s.kind === "edge" || s.kind === "error" || s.kind === "chaos").length;

  // No allowlisted command to run = environment limitation, NOT a code FAIL.
  // Surface it as environmentBlocked so the pipeline re-stages (does not escalate).
  const environmentBlocked = scenariosRun === 0;
  if (environmentBlocked) {
    warnings.push(
      "self-verify found no allowlisted command to exercise the artifact (no ISC verify commands and no tsconfig) — environment-blocked, not a code failure",
    );
  }

  const verdict: "PASS" | "FAIL" = scenariosFailed > 0 || environmentBlocked ? "FAIL" : "PASS";

  // Persist the transcript (audit trail) — always, pass or fail.
  let transcriptPath: string | undefined;
  const persistDir = deps.persistDir ?? DEFAULT_PERSIST_DIR;
  const transcript = {
    itemId: input.itemId,
    engine: "self-verify",
    contextReason: deps.contextReason,
    surface: input.surface,
    effort: input.effort,
    verdict,
    environmentBlocked,
    scenarios,
    warnings,
    timestamp: start,
  };
  try {
    const dir = join(persistDir, input.itemId);
    transcriptPath = join(dir, `selfverify-${start}.json`);
    const write =
      deps.writeTranscript ??
      ((p: string, data: string) => {
        mkdirSync(dir, { recursive: true });
        writeFileSync(p, data, "utf-8");
      });
    write(transcriptPath, JSON.stringify(transcript, null, 2));
  } catch {
    warnings.push("failed to persist self-verify transcript (non-fatal)");
    transcriptPath = undefined;
  }

  return {
    surface: input.surface,
    effort: input.effort,
    verdict,
    humanVerificationRequired: false,
    scenarios,
    scenariosRun,
    scenariosPassed,
    scenariosFailed,
    edgeCasesExplored,
    explorationTimeMs: now() - start,
    transcriptPath,
    warnings,
    // environmentBlocked is its own signal; noEvidence stays false so the pipeline
    // routes via the environment-block path, not the "never ran it" hard FAIL.
    noEvidence: false,
    mode: "self-verify",
    environmentBlocked,
  };
}
