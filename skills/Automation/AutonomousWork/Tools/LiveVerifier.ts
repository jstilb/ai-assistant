#!/usr/bin/env bun
/**
 * LiveVerifier.ts — Mandatory live-verification Explorer engine.
 *
 * Core principle: an item cannot reach VERIFIED/DONE unless an Explorer agent
 * ACTUALLY executed the built artifact and observed real behavior matching the
 * spec. Running the test suite is NOT live verification — the agent must drive
 * the thing the way a user would. "No live evidence" is a hard FAIL.
 *
 * This is the engine used by BOTH enforcement points:
 *   - the build loop (builder self-verification), and
 *   - the independent completion gate (Phase L inside SkepticalVerifier).
 *
 * The Explorer is a tool-enabled headless `claude -p` agent (Bash + Read) that
 * generates scenarios scaled by effort tier, runs them live, compares observed
 * vs expected, and returns a structured JSON block. Edge-case count and the
 * exploration time budget scale with complexity (LIVE_BUDGETS).
 *
 * The Explorer is handed ONE generic "figure out how to actually run this" instruction
 * (genericExerciseInstruction) — it inspects the diff and drives the artifact itself,
 * rather than following a per-surface recipe table.
 */

import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import type { EffortLevel } from "./WorkQueue.ts";
import { resolveLiveVerifyContext, type LiveVerifyMode } from "./LiveVerifyContext.ts";
import { runSelfVerify } from "./SelfVerifyRunner.ts";
import { spawnAgentSync } from "../../../../lib/core/AgentSpawner.ts";
import { resolveModel, type ModelTier } from "../../../../lib/core/RateLimitGuard.ts";
import { getKayaHome } from "../../../../lib/core/KayaHome.ts";

// ============================================================================
// Types
// ============================================================================

/**
 * Surfaces the Explorer knows how to drive. Extends the RuntimeVerifier surface
 * set with the non-executable kinds (docs/config/refactor) so the "mandatory for
 * all work" rule has a real live check for every item.
 */
export type LiveSurface =
  | "browser"
  | "cli"
  | "api"
  | "integration"
  | "native"
  | "docs"
  | "config"
  | "refactor";

export type ScenarioKind = "happy" | "edge" | "error" | "chaos";

export interface LiveExerciseScenario {
  id: string;
  kind: ScenarioKind;
  description?: string;
  /** The command / interaction the Explorer actually ran. */
  command?: string;
  /** Expected behavior per the spec. */
  expected?: string;
  /** Observed output captured live. */
  observed?: string;
  exitCode?: number;
  verdict?: "PASS" | "FAIL";
}

export interface LiveVerificationResult {
  surface: LiveSurface;
  effort: EffortLevel;
  /** PASS only when the artifact was actually run and all scenarios passed. */
  verdict: "PASS" | "FAIL" | "HUMAN_REQUIRED";
  /** True for native (and any surface that cannot be auto-driven here). */
  humanVerificationRequired: boolean;
  scenarios: LiveExerciseScenario[];
  scenariosRun: number;
  scenariosPassed: number;
  scenariosFailed: number;
  /** Count of edge/error/chaos scenarios — a complexity-scaling signal. */
  edgeCasesExplored: number;
  explorationTimeMs: number;
  /** Path to the persisted transcript (audit trail), if written. */
  transcriptPath?: string;
  warnings: string[];
  /**
   * True when the Explorer produced NO executed scenario at all. This is the
   * "no live evidence" condition and forces a hard FAIL — the artifact was
   * never actually run, so we cannot know it works.
   */
  noEvidence: boolean;
  /** Which engine actually produced this result. */
  mode?: LiveVerifyMode;
  /**
   * True when live verification could not run because of the EXECUTION ENVIRONMENT
   * (not the code under test): the self-verify harness found nothing it was allowed
   * to run, or the dangerous Explorer was unavailable. Distinct from a code FAIL —
   * the upstream pipeline re-stages an environment-blocked item to pending for the
   * next eligible run instead of escalating it to the human board (Principle B2).
   */
  environmentBlocked?: boolean;
}

/** Per-effort exploration budget. Depth scales with complexity. */
export interface LiveBudget {
  /** Target number of scenarios the Explorer should run. */
  scenarios: number;
  /** Target number of edge/error/chaos scenarios within that total. */
  edgeCases: number;
  /** Wall-clock budget for the whole exploration. */
  timeBudgetMs: number;
  /** Exploration rounds (DETERMINED loops until no new failures). */
  rounds: number;
}

/**
 * Complexity scaling table. Keyed by EffortLevel. TRIVIAL still gets ONE real
 * execution (never skipped) — that alone catches the "never ran it" failures.
 * Numbers are starting points; tune after dogfooding.
 */
export const LIVE_BUDGETS: Record<EffortLevel, LiveBudget> = {
  TRIVIAL: { scenarios: 1, edgeCases: 0, timeBudgetMs: 60_000, rounds: 1 },
  QUICK: { scenarios: 3, edgeCases: 2, timeBudgetMs: 180_000, rounds: 1 },
  STANDARD: { scenarios: 6, edgeCases: 4, timeBudgetMs: 480_000, rounds: 1 },
  THOROUGH: { scenarios: 12, edgeCases: 8, timeBudgetMs: 1_200_000, rounds: 2 },
  DETERMINED: { scenarios: 15, edgeCases: 12, timeBudgetMs: 2_400_000, rounds: 2 },
};

export interface LiveVerifierInput {
  itemId: string;
  surface: LiveSurface;
  effort: EffortLevel;
  /** Worktree path (preferred) or project path — where the artifact lives. */
  workingDir: string;
  /** Relevant spec section(s) so the Explorer knows expected behavior. */
  specExcerpt: string;
  /** Files changed in this work item (drives what to exercise). */
  diffPaths: string[];
  /** Optional dev-server command override (api/browser surfaces). */
  devCommand?: string;
  /**
   * Real, deterministic commands that exercise the artifact, used by the
   * non-dangerous self-verify harness (SelfVerifyRunner) when the dangerous
   * Explorer is not permitted. Populated upstream from the item's ISC
   * verification commands (+ any spec run command). Each is allowlist-validated
   * before it runs; `claude` is never runnable. Ignored by the Explorer path.
   */
  selfVerifyCommands?: string[];
}

/** Result of running the Explorer agent process. */
export interface ExplorerRunResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  /**
   * True when this run could not observe real behavior because of the EXECUTION
   * ENVIRONMENT (rate/usage/credit-pool limit, or a pre-spawn gate) rather than the
   * code under test — mirrors AgentSpawnResult.infraUnavailable. Optional so
   * hand-rolled test fakes (which never hit real infra) can omit it.
   */
  infraUnavailable?: boolean;
  /** True only when a pre-spawn rate-limit gate blocked the spawn entirely (process never ran). */
  preSpawnGated?: boolean;
}

/** DI seam: the function that actually runs the Explorer agent. */
export type ExplorerRunner = (
  prompt: string,
  opts: { cwd: string; timeoutMs: number },
) => ExplorerRunResult | Promise<ExplorerRunResult>;

export interface LiveVerifierDeps {
  /** Defaults to a hardened headless `claude -p` spawn with Bash + Read tools. */
  runExplorer?: ExplorerRunner;
  /** Defaults to MEMORY/AutonomousWork/live-verification. */
  persistDir?: string;
  /** Injectable clock for deterministic tests. Defaults to Date.now. */
  now?: () => number;
  /** Injectable transcript writer. Defaults to fs writeFileSync (+ mkdir). */
  writeTranscript?: (path: string, data: string) => void;
  /**
   * Engine selection override. When omitted, resolved from execution context
   * (LiveVerifyContext): "explorer" only in authorized autonomous/cron context,
   * "self-verify" otherwise. Tests force a branch via this field.
   */
  mode?: LiveVerifyMode;
  /** Injectable self-verify command runner (DI seam for SelfVerifyRunner). */
  runSelfVerifyImpl?: typeof runSelfVerify;
}

// ============================================================================
// Parsed explorer payload
// ============================================================================

interface ExplorerPayload {
  verdict?: "PASS" | "FAIL";
  scenarios: LiveExerciseScenario[];
  summary?: string;
}

// ============================================================================
// Constants
// ============================================================================

const KAYA_HOME = getKayaHome(); // frozen module-scope value, behavior-identical to prior inline resolution
const DEFAULT_PERSIST_DIR = join(KAYA_HOME, "MEMORY", "AutonomousWork", "live-verification");

// ============================================================================
// Prompt builder
// ============================================================================

/**
 * The single generic "how to drive it live" instruction. The Explorer is a
 * tool-enabled agent that reads the diff and figures out how to actually run the
 * artifact for itself — we do NOT hand it a per-surface recipe. We only keep the
 * surface-agnostic rules that prevent FALSE live-fails in this sandbox (the
 * absolute-path bun-test rule and the broken-pipe-capture redirect rule), since
 * those are environment gotchas, not surface strategy.
 */
export function genericExerciseInstruction(): string {
  return [
    "HOW TO LIVE-VERIFY: Inspect the changed files and figure out how to ACTUALLY run/exercise",
    "this artifact end-to-end — boot the server and curl it, invoke the CLI with real + edge args,",
    "drive the UI with Playwright and screenshot it, import the library and call its public API,",
    "run the dependents of a refactor, validate the config with the real loader, render/lint docs —",
    "whatever 'actually running it' means for THIS change. Do NOT substitute 'the unit tests pass'",
    "for live behavior: demonstrate the behavior the spec/ISC describes, covering the happy path plus",
    "edge/error cases, and capture the real observed output (stdout, exit codes, status codes,",
    "screenshots) for each. For a UI, open each screenshot with the Read tool and confirm it actually",
    "renders and functions — a component that mounts but does nothing is a FAIL (mirage UI).",
    "ENVIRONMENT RULE: when you run `bun test`, pass ABSOLUTE test-file paths — relative args put bun",
    "in discovery/filter mode, whose full-tree scan corrupts child-process stdio capture in this repo.",
    "CAPTURE-FAILURE RULE: spawnSync/pipe capture of a grandchild process can return EMPTY stdout/stderr",
    "even though the child printed (exit codes stay correct). If a check fails ONLY because captured",
    "output is empty, re-drive the real command with file redirection (`cmd > /tmp/out 2>&1; cat /tmp/out`)",
    "and judge the criterion on the artifact's actual observed behavior — a correct artifact with a",
    "broken pipe-capture is a PASS (record the redirect transcript as evidence), not a LIVE_FAIL.",
  ].join(" ");
}

export function buildExplorerPrompt(input: LiveVerifierInput): string {
  const budget = LIVE_BUDGETS[input.effort];
  return [
    "You are an independent QA Explorer. Your job is to LIVE-VERIFY a completed change by",
    "ACTUALLY RUNNING the built artifact and observing real behavior — never by trusting the code,",
    "the diff, or a passing test suite. If you cannot actually run it, say so; do not pretend.",
    "",
    `WORKING DIRECTORY: ${input.workingDir}`,
    `CHANGED FILES: ${input.diffPaths.join(", ") || "(none reported)"}`,
    "",
    "SPEC / EXPECTED BEHAVIOR:",
    input.specExcerpt || "(no spec excerpt provided — infer expected behavior from the changed files)",
    "",
    genericExerciseInstruction(),
    "",
    `EXPLORATION BUDGET (effort=${input.effort}): run about ${budget.scenarios} scenarios,`,
    `including roughly ${budget.edgeCases} edge/error/chaos cases. Scale your exploration depth and`,
    "time to the complexity of the change — more complex work deserves more edge cases.",
    "",
    "STATE-CHANGE / SIDE-EFFECT ISC — NO DRY RUNS, ASSERT POST-STATE:",
    "For any criterion describing a real side effect (a file regenerated, an mtime advancing, a cron",
    "exiting non-zero, tasks re-triaged, a Telegram/message sent), you MUST trigger the REAL code path",
    "and then assert the POST-state directly: stat the file's mtime before vs after, capture the actual",
    "process exit code, or grep the new log line / artifact content. A `--dry-run`, `--no-op`, mock, or",
    "synthetic/temp-fixture path is NOT live evidence for such a row — running it proves nothing about",
    "real state. If a dry-run/synthetic path is all you can exercise, mark that scenario FAIL with",
    "observed = 'no real side effect exercised (dry-run/synthetic only)'. Never report PASS for a",
    "state-change criterion without an observed real post-state change.",
    "",
    "When finished, output EXACTLY ONE fenced JSON block (```json ... ```) as the LAST thing you say,",
    "with this shape:",
    "```json",
    "{",
    '  "verdict": "PASS" | "FAIL",',
    '  "scenarios": [',
    '    { "id": "s1", "kind": "happy|edge|error|chaos", "description": "...",',
    '      "command": "<what you actually ran>", "expected": "...", "observed": "<real output>",',
    '      "exitCode": 0, "verdict": "PASS|FAIL" }',
    "  ],",
    '  "summary": "one line"',
    "}",
    "```",
    "Rules: a scenario PASSES only if observed matches expected. If ANY scenario fails, overall",
    'verdict is FAIL. If you could not actually run anything, return an empty "scenarios" array.',
  ].join("\n");
}

// ============================================================================
// Output parser
// ============================================================================

/** Extract and parse the LAST fenced ```json block from the Explorer's stdout. */
export function parseExplorerOutput(stdout: string): ExplorerPayload | null {
  const fence = /```json\s*([\s\S]*?)```/gi;
  let match: RegExpExecArray | null;
  let last: string | null = null;
  while ((match = fence.exec(stdout)) !== null) {
    last = match[1];
  }
  const candidate = last ?? extractBareObject(stdout);
  if (!candidate) return null;
  try {
    const parsed = JSON.parse(candidate.trim()) as Partial<ExplorerPayload>;
    if (!parsed || !Array.isArray(parsed.scenarios)) return null;
    return {
      verdict: parsed.verdict,
      scenarios: parsed.scenarios as LiveExerciseScenario[],
      summary: parsed.summary,
    };
  } catch {
    return null;
  }
}

/** Fallback: find a bare {...} object containing "scenarios". */
function extractBareObject(stdout: string): string | null {
  const idx = stdout.indexOf('"scenarios"');
  if (idx === -1) return null;
  // Walk back to the opening brace, forward to the matching close.
  const start = stdout.lastIndexOf("{", idx);
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < stdout.length; i++) {
    if (stdout[i] === "{") depth++;
    else if (stdout[i] === "}") {
      depth--;
      if (depth === 0) return stdout.slice(start, i + 1);
    }
  }
  return null;
}

// ============================================================================
// Default hardened Explorer spawn (tool-enabled headless claude -p, via the
// shared AgentSpawner substrate — env hardening, rate-limit gating, and spawn
// mechanics all live there now; see lib/core/AgentSpawner.ts)
// ============================================================================

/** Pick the Explorer model, honoring the rate-limit override rule from CLAUDE.md. */
function resolveExplorerModel(): ModelTier {
  return resolveModel("sonnet").model;
}

/**
 * Default Explorer runner: delegates to AgentSpawner.spawnAgentSync for hardened
 * env, pre/post-spawn rate-limit gating, and the actual process spawn. Not used
 * in unit tests (DI'd via deps.runExplorer).
 */
const defaultRunExplorer: ExplorerRunner = (prompt, opts) => {
  const result = spawnAgentSync({
    prompt,
    model: resolveExplorerModel(),
    effort: "medium", // read-only exploration; CLI default (high) over-deliberates here
    allowedTools: "Bash,Read,Glob,Grep",
    cwd: opts.cwd,
    timeoutMs: opts.timeoutMs,
    // resolveExplorerModel() ABOVE already escalates to opus at high usage
    // (RateLimitGuard.resolveModel). Without this flag, spawnAgentSync's OWN
    // pre-spawn isRateLimited() gate reads the SAME rate-limits.json against the
    // SAME default threshold and short-circuits to a pre-spawn-gated result
    // before the escalated model is ever used — a dead double-gate (verified:
    // real spawn never invoked at >=90% usage). Skipping it here lets the
    // escalated model actually run; a genuine infra condition is still caught
    // post-spawn via AgentSpawnResult.infraUnavailable (rate-limit output
    // detection / timeout) and reported below as environmentBlocked.
    skipRateLimitGate: true,
  });

  return {
    success: result.success,
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    infraUnavailable: result.infraUnavailable,
    preSpawnGated: result.preSpawnGated,
  };
};

// ============================================================================
// Main entry point
// ============================================================================

export async function runLiveVerification(
  input: LiveVerifierInput,
  deps: LiveVerifierDeps = {},
): Promise<LiveVerificationResult> {
  const now = deps.now ?? (() => Date.now());
  const start = now();

  // Native UI cannot be auto-driven here (no simulator/emulator). Fail closed to
  // a human device check — never a silent auto-pass.
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
        "native UI requires a human/device check (no iOS simulator / Android emulator / Detox / Appium here) — disposition human-required; do not auto-DONE",
      ],
      noEvidence: false,
    };
  }

  // Context-aware engine selection (Slice 1). The dangerous `claude -p` Explorer is
  // classifier-blocked in interactive sessions; fall back to the non-dangerous
  // self-verify harness there. The Explorer keeps running in authorized autonomous/cron.
  const ctx = resolveLiveVerifyContext();
  const mode: LiveVerifyMode = deps.mode ?? ctx.mode;
  if (mode === "self-verify") {
    const selfVerify = deps.runSelfVerifyImpl ?? runSelfVerify;
    return selfVerify(input, {
      now: deps.now,
      persistDir: deps.persistDir,
      writeTranscript: deps.writeTranscript,
      contextReason: deps.mode ? `forced mode=self-verify` : ctx.reason,
    });
  }

  const runExplorer = deps.runExplorer ?? defaultRunExplorer;
  const prompt = buildExplorerPrompt(input);
  const budget = LIVE_BUDGETS[input.effort];

  const warnings: string[] = [];
  let res: ExplorerRunResult;
  try {
    res = await runExplorer(prompt, { cwd: input.workingDir, timeoutMs: budget.timeBudgetMs });
  } catch (err) {
    res = {
      success: false,
      stdout: "",
      stderr: err instanceof Error ? err.message : String(err),
      exitCode: 1,
      timedOut: false,
    };
  }

  // Infra-blocked run (pre-spawn rate-limit gate, or a post-spawn infra signal —
  // rate/usage/credit-pool limit, or blank output) is NOT a code FAIL. Map it
  // onto the SAME "could not run" semantics SelfVerifyRunner already uses
  // (environmentBlocked) so the upstream pipeline (PhaseL) re-stages the item
  // instead of blaming the task with a generic no-evidence FAIL.
  //
  // A PURE TIMEOUT is deliberately excluded here even though AgentSpawner's
  // isInfraUnavailable() folds timedOut into infraUnavailable (rate-limit-signal
  // classification, not this gate's semantics). A genuine explorer wall-clock
  // timeout is exactly the hanging-artifact case Phase L must hard-FAIL on — if
  // it re-staged as environmentBlocked instead, it would loop through cooldown
  // re-stages (WorkOrchestrator) without ever consuming a retry or blaming the
  // code. Only a rate-limit/infra signal WITHOUT a timeout — or a pre-spawn gate
  // — counts as environment-blocked; a timeout always falls through to the
  // normal noEvidence hard-FAIL path below (PhaseL.ts noEvidence handling).
  const environmentBlocked =
    res.preSpawnGated === true || (res.infraUnavailable === true && res.timedOut !== true);
  if (environmentBlocked) {
    warnings.push(
      res.preSpawnGated
        ? "Explorer spawn was pre-spawn rate-limit gated (usage at/above threshold) — environment-blocked, not a code failure"
        : "Explorer run hit an infrastructure condition (rate/usage/credit-pool limit, or blank output) — environment-blocked, not a code failure",
    );
  } else if (res.timedOut) {
    warnings.push(`Explorer timeout: exceeded ${budget.timeBudgetMs}ms budget for ${input.effort}`);
  }

  const parsed = parseExplorerOutput(res.stdout);
  const scenarios = parsed?.scenarios ?? [];
  const scenariosRun = scenarios.length;
  const noEvidence = scenariosRun === 0;

  if (noEvidence && !res.timedOut && !environmentBlocked) {
    warnings.push(
      res.success
        ? "Explorer produced no executed scenario — no live evidence that the artifact runs"
        : `Explorer process failed (exit ${res.exitCode}); no live evidence captured. stderr: ${res.stderr.slice(0, 200)}`,
    );
  }

  const scenariosPassed = scenarios.filter(s => s.verdict === "PASS").length;
  const scenariosFailed = scenarios.filter(s => s.verdict === "FAIL").length;
  const edgeCasesExplored = scenarios.filter(s => s.kind === "edge" || s.kind === "error" || s.kind === "chaos").length;

  // Verdict: no evidence OR any failed scenario OR explorer-declared FAIL → FAIL.
  let verdict: "PASS" | "FAIL";
  if (noEvidence || scenariosFailed > 0 || parsed?.verdict === "FAIL") {
    verdict = "FAIL";
  } else {
    verdict = "PASS";
  }

  // Persist the transcript for audit (always — pass or fail).
  let transcriptPath: string | undefined;
  const persistDir = deps.persistDir ?? DEFAULT_PERSIST_DIR;
  const transcript = {
    itemId: input.itemId,
    surface: input.surface,
    effort: input.effort,
    verdict,
    scenarios,
    summary: parsed?.summary,
    rawStdoutTail: res.stdout.slice(-4000),
    warnings,
    timestamp: start,
  };
  try {
    const dir = join(persistDir, input.itemId);
    transcriptPath = join(dir, `run-${start}.json`);
    const write = deps.writeTranscript ?? ((p: string, data: string) => {
      mkdirSync(dir, { recursive: true });
      writeFileSync(p, data, "utf-8");
    });
    write(transcriptPath, JSON.stringify(transcript, null, 2));
  } catch {
    warnings.push("failed to persist live-verification transcript (non-fatal)");
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
    noEvidence,
    mode: "explorer",
    environmentBlocked,
  };
}
