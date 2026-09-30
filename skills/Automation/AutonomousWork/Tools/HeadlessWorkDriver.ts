#!/usr/bin/env bun
/**
 * HeadlessWorkDriver.ts — Scheduled approved-work driver (Slice E1).
 *
 * The governed pipeline (WorkOrchestratorCLI.ts mechanical subcommands +
 * Builder/Verifier agent prompts) previously had NO scheduled driver: approved
 * work sat in the queue forever unless a human manually ran the CLI + spawned
 * agents by hand. This is a DETERMINISTIC SCRIPTED LOOP (Option B) — plain
 * control flow driving `bun WorkOrchestratorCLI.ts <cmd>` subprocesses and
 * `lib/core/AgentSpawner.spawnAgentSync` calls directly. It deliberately does
 * NOT nest headless `claude -p` processes via `Task()` (that's Option A, the
 * TaskOrchestratorPrompt.md / Orchestrate.md Executive pattern) — every step
 * here is plain TypeScript so it is unit-testable without spawning any agent.
 *
 * ## CLI subcommand sequence (per item)
 *
 *   prepare → started → [Builder turn ⇄ Verifier turn]×≤4 → mark-done → verify
 *   → report-done, or on non-convergence / any mechanical-step failure → retry.
 *
 * `complete` and `fail` are NEVER called directly — `complete` is an alias for
 * `report-done` (documented CLI contract) and `fail` is manual-kill-only
 * (`--force` required); this driver only ever uses `retry`, which records the
 * attempt, resets the item to pending, and self-escalates to human review
 * after 3 attempts (WorkOrchestrator.ts retry() escalation ladder).
 *
 * ## Worktree isolation
 *
 * `started <id>` already calls `WorkOrchestrator.ensureFeatureBranch(id)`,
 * which creates/reuses a real git worktree via `lib/core/WorktreeManager.ts`
 * and returns `{worktreePath, worktreeBranch}`. Builder and Verifier turns are
 * spawned with `cwd: worktreePath` — NOT AgentSpawner's own `worktree:` option
 * (that would create a SECOND, throwaway worktree and lose the Builder's
 * work, exactly the anti-pattern TaskOrchestratorPrompt.md warns about).
 *
 * ## Budget ceiling — design note (deviation from the literal task wording)
 *
 * `WorkOrchestrator.init()`'s actual return shape is
 * `{success, message, ready, blocked, recovered}` — there is no dollar-spent,
 * budget-ceiling, or percentage-used field anywhere in `WorkOrchestrator.ts`
 * (confirmed by direct grep). `Orchestrate.md` documents a `getBudgetStatus()`
 * gate at 90%/95%, but `getBudgetStatus()` does not exist anywhere in the
 * codebase — a prior task record shows a `CostTracker`/budget-gate feature was
 * explicitly DELETED, and `Orchestrate.md` was never updated to match. There is
 * therefore no live "budget ceiling" signal to read from `init`'s JSON output.
 *
 * The only LIVE percentage-based ceiling in the system is
 * `RateLimitGuard`'s usage percentage, whose `DEFAULT_THRESHOLD` is already 90
 * — the exact number `Orchestrate.md` documents for "stop taking new items,
 * finish the current one." This driver therefore uses
 * `isRateLimited(RATE_LIMIT_THRESHOLD)` as BOTH the rate-limit defer gate AND
 * the budget-ceiling gate — in the current system they are the same signal.
 * `checkCeiling()` below is the single seam to swap if a real dollar-cost
 * budget tracker is added later; call sites (pre-batch, pre-item) don't change.
 */

import { execFileSync } from "child_process";
import { existsSync, readFileSync, statSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { parseArgs } from "util";

import { spawnAgentSync, DEFAULT_TIMEOUT_MS } from "../../../../lib/core/AgentSpawner.ts";
import type { AgentSpawnResult } from "../../../../lib/core/AgentSpawner.ts";
import { isRateLimited, DEFAULT_THRESHOLD } from "../../../../lib/core/RateLimitGuard.ts";
import { recordFailure } from "../../../../lib/core/FailureLog.ts";
import { kayaHomePath, getKayaHome } from "../../../../lib/core/KayaHome.ts";
import { createAppendLog, type AppendLog } from "../../../../lib/core/AppendLog.ts";

// ============================================================================
// Constants
// ============================================================================

/** Bounded Builder⇄Verifier convergence loop — same bound idiom as
 *  GrillRunner.finalizeGrillToSpec's MAX_ITERATIONS=4 (for/i<MAX with
 *  early-break termination conditions, unconditional fallthrough on exhaustion). */
export const MAX_ITERATIONS = 4;

/** See "Budget ceiling — design note" above: reused for both the rate-limit
 *  defer gate and the budget-ceiling gate (DEFAULT_THRESHOLD is 90, matching
 *  Orchestrate.md's documented 90% "stop taking new items" threshold). */
export const RATE_LIMIT_THRESHOLD = DEFAULT_THRESHOLD;

/** Every spawn (Builder and Verifier) uses opus, per the task's explicit
 *  instruction — this intentionally overrides Orchestrate.md's effort-based
 *  Verifier model table (opus for STANDARD+/sonnet for QUICK-TRIVIAL). */
export const SPAWN_MODEL = "opus";

/** Builder allowedTools — matches the executor Lane A convention
 *  (skills/Productivity/LucidTasks/Tools/executor/spawnAgent.ts's fixed
 *  reversible-action boundary), the closest existing AW write-capable-agent
 *  precedent. The subagent tool is named `Agent`, not `Task`, in Claude Code
 *  2.1.263 — see S-06 slice-3 probe 0d (jobs/6ee226c4/tmp/slice3/PROBES.md). */
export const BUILDER_ALLOWED_TOOLS = "Bash,Read,Write,Edit,Glob,Grep,WebFetch,WebSearch,Agent,Skill";

/** Verifier allowedTools — matches the LiveVerifier/SpecPipelineRunner
 *  Explorer convention (read-only investigation + test execution), and
 *  VerifierPrompt.md's own documented tool list (Glob/Grep/Read/Bash). */
export const VERIFIER_ALLOWED_TOOLS = "Bash,Read,Glob,Grep";

/** Generous timeout for both Builder and Verifier turns — explicit rather
 *  than implicit, even though it matches AgentSpawner's own default. */
export const SPAWN_TIMEOUT_MS = DEFAULT_TIMEOUT_MS;

export const DEFAULT_BATCH_SIZE = 5;

/** E3 fix round — default TOTAL-RUN item cap when `--max-items` is omitted (cron
 *  sanity; see MEMORY/daemon/cron/manifests/autonomous-work-nightly.yaml).
 *  Numerically equal to DEFAULT_BATCH_SIZE today but conceptually distinct:
 *  DEFAULT_BATCH_SIZE governs the size of a single `next-batch` PULL,
 *  DEFAULT_MAX_ITEMS governs how many items the driver processes in TOTAL across
 *  the whole run before stopping. See parseMaxItemsArg / runDriver below. */
export const DEFAULT_MAX_ITEMS = 5;

/** Mirrors Integrator.ts#checkInteractiveSessionLock()'s staleness threshold. */
export const INTERACTIVE_SESSION_LOCK_STALE_MS = 2 * 60 * 60 * 1000;

/** JSONL run-log idiom, following
 *  skills/Productivity/LucidTasks/Tools/executor/executor.ts's
 *  appendRunRecord() (MEMORY/daemon/cron/logs/<name>.jsonl), but resolved via
 *  the shared kayaHomePath() helper (already used by lib/core/FailureLog.ts)
 *  instead of hand-rolling a second KAYA_HOME join. */
export const RUN_LOG_RELPATH = ["MEMORY", "daemon", "cron", "logs", "headless-work-driver.jsonl"];

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI_SCRIPT_PATH = join(HERE, "WorkOrchestratorCLI.ts");
const INTEGRATOR_SCRIPT_PATH = join(HERE, "Integrator.ts");
const PROMPTS_DIR = join(HERE, "..", "Prompts");
const BUILDER_PROMPT_PATH = join(PROMPTS_DIR, "BuilderPrompt.md");
const VERIFIER_PROMPT_PATH = join(PROMPTS_DIR, "VerifierPrompt.md");

// ============================================================================
// Types
// ============================================================================

export interface CliResult {
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  json: unknown;
}

export type CliRunnerFn = (args: string[]) => CliResult;

interface BuilderReport {
  success?: boolean;
  completedRows?: number[];
  failedRows?: number[];
  budgetSpent?: number;
  testwriterConcerns?: string[];
}

interface VerifierRow {
  iscId: number;
  verdict: "PASS" | "FAIL";
  evidence?: string;
  linkedTest?: string | null;
  concern?: string | null;
}

interface VerifierReport {
  rows: VerifierRow[];
  summary?: string;
  allPass: boolean;
  faultClass?: string;
}

export interface ItemOutcome {
  itemId: string;
  /** "retry-noop" = orch.retry() returned {retried:false, escalated:false} (item
   *  not-found or infra-fault classification) — the retry counter was NOT consumed
   *  and the item was not reset to pending. Distinct from "retried" so run-log
   *  telemetry never claims a retry happened when it didn't. */
  outcome: "done" | "blocked-on-human" | "retried" | "retry-noop" | "escalated" | "deferred" | "driver-error";
  iterations?: number;
  terminationReason?: string;
  detail?: string;
}

export interface DriverRunResult {
  itemsProcessed: ItemOutcome[];
  deferred: boolean;
  error: string | null;
}

/** E3 fix round — result shape returned by a deferred-merge sweep invocation. */
export interface DeferredMergeSweepResult {
  ok: boolean;
  merged?: number;
  conflicts?: number;
  skipped?: number;
  error?: string;
}

export interface HeadlessWorkDriverDeps {
  /** Injectable for tests — defaults to the real spawnAgentSync. Never call the
   *  real one from a unit test; only the live-clone E2E should omit this. */
  spawnAgentSyncFn?: typeof spawnAgentSync;
  /** Injectable for tests — defaults to the real RateLimitGuard.isRateLimited. */
  isRateLimitedFn?: typeof isRateLimited;
  /** Injectable for tests — defaults to a real `bun WorkOrchestratorCLI.ts` subprocess
   *  runner. Most of the CLI layer (init/next-batch/prepare/started/mark-done/retry) is
   *  cheap/deterministic/local (no LLM cost), so unlike the spawn seam it is exercised
   *  for real even in the "unit" suite — only the agent spawn is faked there. The
   *  `verify`/`report-done` subcommands are the exception: they construct a real
   *  WorkOrchestrator → SkepticalVerifier, whose Gate 3 is a real ~$0.30 nondeterministic
   *  Sonnet judge call by DEFAULT, and whose Gate 2 (Phase L) picks a real dangerous
   *  `claude -p` Explorer whenever KAYA_CRON_JOB_ID/KAYA_AUTONOMOUS happen to be set in
   *  the ambient environment (LiveVerifyContext.ts). HeadlessWorkDriver.test.ts's
   *  `scratchCliRunner()` forces the CLI subprocess into a deterministic, spawn-free mode
   *  by explicitly setting KAYA_LIVE_VERIFY_MODE=self-verify + KAYA_TEST_SKIP_JUDGE=1 and
   *  stripping KAYA_AUTONOMOUS/KAYA_CRON_JOB_ID/CLAUDECODE from the subprocess env — see
   *  that file's hygiene notes. Production callers (this file's own `defaultCliRunner`)
   *  set none of that and get the real, costed gates. */
  cliRunner?: CliRunnerFn;
  rateLimitThreshold?: number;
  /** Size of a single `next-batch` pull. Defaults to min(maxItems, DEFAULT_BATCH_SIZE)
   *  when omitted — see runDriver. Independent of maxItems (the total-run cap). */
  batchSize?: number;
  /** E3 fix round — TOTAL-RUN item cap, independent of batchSize. `0` = unlimited
   *  (drains the whole ready queue, batch by batch — use for manual drain runs).
   *  Defaults to DEFAULT_MAX_ITEMS when omitted. See parseMaxItemsArg for the
   *  `--max-items` CLI-flag parsing that feeds this. */
  maxItems?: number;
  /** Injectable for tests — defaults to defaultCheckInteractiveSessionLock(). */
  checkInteractiveSessionLockFn?: () => boolean;
  /** Injectable for tests — defaults to defaultDeferredMergeSweep(). */
  deferredMergeSweepFn?: () => DeferredMergeSweepResult;
}

// ============================================================================
// CLI runner
// ============================================================================

export const defaultCliRunner: CliRunnerFn = (args) => {
  let stdout = "";
  let stderr = "";
  let exitCode = 0;
  let ok = true;
  try {
    stdout = execFileSync("bun", [CLI_SCRIPT_PATH, ...args], {
      encoding: "utf-8",
      maxBuffer: 64 * 1024 * 1024,
      env: process.env as Record<string, string>,
    });
  } catch (e) {
    ok = false;
    const err = e as { stdout?: string; stderr?: string; status?: number | null };
    stdout = err.stdout ?? "";
    stderr = err.stderr ?? "";
    exitCode = err.status ?? 1;
  }
  let json: unknown = null;
  try {
    json = JSON.parse(stdout);
  } catch {
    json = null;
  }
  return { ok, exitCode, stdout, stderr, json };
};

// ============================================================================
// Deferred-merge sweep (E3 fix round)
//
// AW-side deferred merges (mergeStatus "deferred", set by Integrator.mergeItem()
// when E2's interactive-session-lock is live at report-done time) only self-heal
// via Integrator.mergeCompleted() — which had no scheduled invoker (only a manual
// CLI + a stale doc reference). Sweep once per driver run, before the first
// next-batch pull, so items deferred on a prior run (while Jm had an active
// interactive session) get merged once that session ends, without a human
// running the Integrator CLI by hand.
// ============================================================================

/**
 * Resolves KAYA_HOME via lib/core/KayaHome.ts#getKayaHome(). This used to
 * reimplement getKayaHome()'s env-override -> expandPath -> ~/.claude
 * fallback locally to dodge a cache-pinning gotcha (see MEMORY
 * shared_process_test_home_pinning) where getKayaHome()'s cache pinned to
 * whichever KAYA_HOME was live on its FIRST call anywhere in the process and
 * never re-resolved — WRONG inside a single `bun test` run where every test
 * file's beforeEach repoints KAYA_HOME to a fresh scratch dir. getKayaHome()'s
 * cache is now keyed on the env pair that produced it, so it re-resolves
 * automatically whenever KAYA_HOME/KAYA_DIR changes — the gotcha this
 * function dodged no longer applies, so it now delegates directly.
 */
function resolveKayaHomeUncached(): string {
  return getKayaHome();
}

/**
 * Default interactive-session-lock check — same path and staleness rule as
 * Integrator.ts#checkInteractiveSessionLock(), reimplemented locally (rather
 * than calling that method on an in-process `new Integrator()`) to keep this
 * driver's lock check free of an Integrator instantiation dependency.
 * Returns true when a FRESH lock is present (Jm has an active interactive
 * session — the sweep must be skipped this run), false when clear, absent, or
 * the lock file is stale/corrupt (fail-open, matching Integrator's own
 * fail-open behavior on a corrupt lock file).
 */
export function defaultCheckInteractiveSessionLock(): boolean {
  const lockPath = join(resolveKayaHomeUncached(), "MEMORY", "STATE", "interactive-session.lock");
  if (!existsSync(lockPath)) return false;
  try {
    const stat = statSync(lockPath);
    return Date.now() - stat.mtimeMs <= INTERACTIVE_SESSION_LOCK_STALE_MS;
  } catch {
    return false;
  }
}

/**
 * Default deferred-merge sweep — spawns `bun Integrator.ts merge --strategy
 * direct --json` as its own subprocess, the same idiom as defaultCliRunner
 * above. A subprocess (rather than an in-process `new Integrator().mergeCompleted()`
 * call) is deliberate here too: it gets a brand-new process and therefore a
 * fresh, uncached KAYA_HOME resolution, so it can never read a stale KAYA_HOME
 * left over from an earlier test/run sharing this host process.
 * Integrator.mergeCompleted() is itself idempotent/best-effort (0 eligible items
 * -> {merged:0,...}), so invoking it unconditionally every run is safe — the
 * caller (runDriver) only decides WHETHER to invoke it at all, gated on the
 * lock check above.
 */
export const defaultDeferredMergeSweep: () => DeferredMergeSweepResult = () => {
  try {
    const stdout = execFileSync(
      "bun",
      [INTEGRATOR_SCRIPT_PATH, "merge", "--strategy", "direct", "--json"],
      { encoding: "utf-8", maxBuffer: 16 * 1024 * 1024, env: process.env as Record<string, string> },
    );
    const json = JSON.parse(stdout) as { merged?: number; conflicts?: number; skipped?: number };
    return { ok: true, merged: json.merged, conflicts: json.conflicts, skipped: json.skipped };
  } catch (e) {
    const err = e as { stderr?: string; stdout?: string; message?: string };
    const detail = err.stderr || err.stdout || err.message || String(e);
    return { ok: false, error: String(detail).slice(0, 500) };
  }
};

// ============================================================================
// Small helpers
// ============================================================================

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8", maxBuffer: 16 * 1024 * 1024 }).trim();
}

function fillTemplate(template: string, vars: Record<string, string>): string {
  let out = template;
  for (const [k, v] of Object.entries(vars)) {
    out = out.split(`{{${k}}}`).join(v);
  }
  return out;
}

/** Tolerant JSON extraction — Builder/Verifier are instructed to output ONLY
 *  JSON, but headless agent stdout sometimes wraps it in prose. Returns null
 *  on any malformity (never a partial/default result), mirroring
 *  AgentSpawner.parseVerdictBlock's contract. */
function extractJson<T>(stdout: string): T | null {
  const trimmed = stdout.trim();
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    /* fall through to brace-scan */
  }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(trimmed.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}

function readFileOr(path: string | undefined, fallback: string): string {
  if (!path || !existsSync(path)) return fallback;
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return fallback;
  }
}

/** AppendLog instances keyed by resolved path — reused per path; the run-log
 *  path can shift across calls when KAYA_HOME changes (test isolation). */
const runLogs = new Map<string, AppendLog>();
function getRunLog(path: string): AppendLog {
  let log = runLogs.get(path);
  if (!log) {
    log = createAppendLog(path);
    runLogs.set(path, log);
  }
  return log;
}

/** Follows executor.ts's appendRunRecord() idiom: one JSON line per event,
 *  never throws, best-effort mkdir. */
export function appendRunLog(record: Record<string, unknown>): void {
  try {
    const path = kayaHomePath(...RUN_LOG_RELPATH);
    getRunLog(path).append({ timestamp: new Date().toISOString(), ...record });
  } catch (err) {
    console.warn(`[HeadlessWorkDriver] failed to append run record: ${err instanceof Error ? err.message : err}`);
  }
}

function buildFeedbackTable(iteration: number, failRows: VerifierRow[]): string {
  if (failRows.length === 0) return "(none — first iteration)";
  const lines = failRows.map(
    (r) => `| ${r.iscId} | FAIL | ${(r.concern ?? r.evidence ?? "no detail").replace(/\|/g, "/").replace(/\n/g, " ")} |`,
  );
  return [
    `## Verifier Feedback (Iteration ${iteration})`,
    "",
    "| ISC Row | Verdict | Feedback |",
    "|---------|---------|----------|",
    ...lines,
    "",
    "Address each FAIL row specifically before re-submitting.",
  ].join("\n");
}

/** Same signal used for both the pre-batch and per-item budget-ceiling gate —
 *  see the "Budget ceiling — design note" module doc comment. */
function checkCeiling(deps: HeadlessWorkDriverDeps): boolean {
  const fn = deps.isRateLimitedFn ?? isRateLimited;
  const threshold = deps.rateLimitThreshold ?? RATE_LIMIT_THRESHOLD;
  return fn(threshold);
}

// ============================================================================
// Per-item processing
// ============================================================================

interface ItemLite {
  id: string;
  title?: string;
  specPath?: string;
  testStrategyPath?: string;
}

async function processItem(item: ItemLite, deps: HeadlessWorkDriverDeps): Promise<ItemOutcome> {
  const cli = deps.cliRunner ?? defaultCliRunner;
  const spawn = deps.spawnAgentSyncFn ?? spawnAgentSync;
  const id = item.id;

  const prepareRes = cli(["prepare", id, "--json"]);
  const prepareJson = prepareRes.json as { success?: boolean; iscRows?: { id: number }[]; error?: string } | null;
  if (!prepareJson?.success) {
    const detail = `prepare failed: ${prepareJson?.error ?? prepareRes.stderr ?? "unparseable prepare output"}`;
    const retryRes = cli(["retry", id, detail]);
    const result = finalizeRetry(id, retryRes, detail);
    appendRunLog({ event: "item-outcome", itemId: id, step: "prepare", outcome: result.outcome, detail });
    return result;
  }
  const allIscRowIds = (prepareJson.iscRows ?? []).map((r) => r.id);

  const startedRes = cli(["started", id, "--json"]);
  const startedJson = startedRes.json as { success?: boolean; worktreePath?: string | null; worktreeError?: string } | null;
  if (!startedJson?.success || !startedJson.worktreePath) {
    const detail = `started/worktree failed: ${startedJson?.worktreeError ?? startedRes.stderr ?? "no worktreePath returned"}`;
    const retryRes = cli(["retry", id, detail]);
    const result = finalizeRetry(id, retryRes, detail);
    appendRunLog({ event: "item-outcome", itemId: id, step: "started", outcome: result.outcome, detail });
    return result;
  }
  const worktreePath = startedJson.worktreePath;

  const iscTableRes = cli(["format-isc-table", id]);
  const iscTable = iscTableRes.stdout.trim() || "(no ISC rows)";

  const startSha = git(worktreePath, ["rev-parse", "HEAD"]);
  const specPath = item.specPath ?? "(none)";
  const specContent = readFileOr(item.specPath, "(no spec file — template-generated ISC rows)");
  const testStrategy = readFileOr(item.testStrategyPath, "(no test strategy file — use best judgment for test types)");

  const builderTemplate = readFileSync(BUILDER_PROMPT_PATH, "utf-8");
  const verifierTemplate = readFileSync(VERIFIER_PROMPT_PATH, "utf-8");

  let iteration = 1;
  let verifierFeedback = "(none — first iteration)";
  let previousFailedIds: string | null = null;
  let verifierReport: VerifierReport | null = null;
  let converged = false;
  let terminationReason = "max_iterations";

  while (iteration <= MAX_ITERATIONS) {
    const builderPrompt =
      `CRITICAL: All file operations (Read, Write, Edit, Bash git commands) MUST use absolute paths under ${worktreePath}. ` +
      `Do NOT use paths relative to your current directory. Do NOT create your own worktree or branch. The worktree and branch already exist.\n\n` +
      fillTemplate(builderTemplate, {
        SPEC_PATH: specPath,
        WORKTREE_PATH: worktreePath,
        ITERATION: String(iteration),
        PRIOR_WORK: "(none)",
        SPEC_CONTENT: specContent,
        TEST_STRATEGY: testStrategy,
        ISC_TABLE: iscTable,
        TESTWRITER_FILES: "(none — TestWriter step not run by HeadlessWorkDriver; write your own tests per the Test Strategy above.)",
        VERIFIER_FEEDBACK: verifierFeedback,
      });

    const builderSpawn: AgentSpawnResult = spawn(
      { prompt: builderPrompt, model: SPAWN_MODEL, allowedTools: BUILDER_ALLOWED_TOOLS, cwd: worktreePath, timeoutMs: SPAWN_TIMEOUT_MS },
      {},
    );
    if (builderSpawn.infraUnavailable) {
      appendRunLog({ event: "defer", itemId: id, turn: "builder", iteration, reason: builderSpawn.preSpawnGated ? "rate-limit-pre-spawn-gate" : "infra-unavailable", stderrSnippet: builderSpawn.stderr.slice(0, 500) });
      return { itemId: id, outcome: "deferred", iterations: iteration, detail: "Builder spawn infra-unavailable (rate limit or infra pause) — leaving item in_progress for the next driver run." };
    }
    const builderReport = extractJson<BuilderReport>(builderSpawn.stdout);

    const logLines = git(worktreePath, ["log", "--oneline", "-5"]);
    let diff = git(worktreePath, ["diff", `${startSha}..HEAD`]);
    if (diff.length > 10000) diff = diff.slice(0, 10000) + "\n[TRUNCATED — full diff available via git]";
    const changedFiles = git(worktreePath, ["diff", "--name-only", `${startSha}..HEAD`]);
    const builderChanges = [`## git log\n${logLines}`, `## git diff\n${diff}`, `## changed files\n${changedFiles}`].join("\n\n");

    const verifierPrompt =
      `CRITICAL: All file reads and searches MUST use absolute paths under ${worktreePath}. This is where the Builder wrote its files.\n\n` +
      fillTemplate(verifierTemplate, {
        SPEC_PATH: specPath,
        WORKTREE_PATH: worktreePath,
        ITERATION: String(iteration),
        TESTWRITER_FILES: "(none — TestWriter step not run by HeadlessWorkDriver)",
        TESTWRITER_COMMIT_SHA: "",
        BUILDER_CHANGES: builderChanges,
        SPEC_CONTENT: specContent,
        TEST_STRATEGY: testStrategy,
        START_SHA: startSha,
        PROGRAMMATIC_VERIFICATION_RESULTS: "(none — HeadlessWorkDriver does not pre-run ISC verification commands; rely on Gates A/B.)",
      });

    const verifierSpawn: AgentSpawnResult = spawn(
      { prompt: verifierPrompt, model: SPAWN_MODEL, allowedTools: VERIFIER_ALLOWED_TOOLS, cwd: worktreePath, timeoutMs: SPAWN_TIMEOUT_MS },
      {},
    );
    if (verifierSpawn.infraUnavailable) {
      appendRunLog({ event: "defer", itemId: id, turn: "verifier", iteration, reason: verifierSpawn.preSpawnGated ? "rate-limit-pre-spawn-gate" : "infra-unavailable", stderrSnippet: verifierSpawn.stderr.slice(0, 500) });
      return { itemId: id, outcome: "deferred", iterations: iteration, detail: "Verifier spawn infra-unavailable (rate limit or infra pause) — leaving item in_progress for the next driver run." };
    }

    verifierReport = extractJson<VerifierReport>(verifierSpawn.stdout);
    if (!verifierReport) {
      // Verifier crashed/unparseable — synthesize an all-FAIL report over every
      // known ISC row so stall detection still converges deterministically
      // (mirrors TaskOrchestratorPrompt.md's "Verifier crashes" error handling).
      const rowIds = allIscRowIds.length > 0 ? allIscRowIds : (builderReport?.completedRows ?? []);
      verifierReport = {
        rows: rowIds.map((rid) => ({ iscId: rid, verdict: "FAIL" as const, evidence: "Verifier crashed or returned unparseable output.", linkedTest: null, concern: "Verifier crashed" })),
        summary: "Verifier crashed or returned unparseable output.",
        allPass: false,
      };
    }

    appendRunLog({ event: "iteration", itemId: id, iteration, builderSuccess: builderReport?.success ?? null, verifierAllPass: verifierReport.allPass, failCount: verifierReport.rows.filter((r) => r.verdict === "FAIL").length });

    const currentFailedIds = JSON.stringify(verifierReport.rows.filter((r) => r.verdict === "FAIL").map((r) => r.iscId).sort((a, b) => a - b));

    if (verifierReport.allPass && verifierReport.rows.every((r) => r.verdict === "PASS")) {
      converged = true;
      terminationReason = "allPass";
      break;
    }
    if (previousFailedIds !== null && currentFailedIds === previousFailedIds) {
      converged = false;
      terminationReason = "stall";
      break;
    }
    previousFailedIds = currentFailedIds;
    if (iteration >= MAX_ITERATIONS) {
      converged = false;
      terminationReason = "max_iterations";
      break;
    }
    verifierFeedback = buildFeedbackTable(iteration, verifierReport.rows.filter((r) => r.verdict === "FAIL"));
    iteration++;
  }

  if (converged && verifierReport) {
    const completedRowIds = verifierReport.rows.filter((r) => r.verdict === "PASS").map((r) => r.iscId);
    const markDoneRes = cli(["mark-done", id, ...completedRowIds.map(String), "--json"]);
    const markDoneJson = markDoneRes.json as { success?: boolean; error?: string } | null;
    if (!markDoneJson?.success) {
      const detail = `mark-done failed post-convergence: ${markDoneJson?.error ?? markDoneRes.stderr}`;
      const retryRes = cli(["retry", id, detail]);
      const result = finalizeRetry(id, retryRes, detail, iteration, terminationReason);
      appendRunLog({ event: "item-outcome", itemId: id, step: "mark-done", outcome: result.outcome, detail, iterations: iteration });
      return result;
    }

    const verifyRes = cli(["verify", id, "--json"]);
    const verifyJson = verifyRes.json as { success?: boolean; failures?: { id: number; description: string }[] } | null;
    if (!verifyJson?.success) {
      const detail = `post-convergence verify failed: ${JSON.stringify(verifyJson?.failures ?? verifyRes.stderr)}`;
      const retryRes = cli(["retry", id, detail]);
      const result = finalizeRetry(id, retryRes, detail, iteration, terminationReason);
      appendRunLog({ event: "item-outcome", itemId: id, step: "verify", outcome: result.outcome, detail, iterations: iteration });
      return result;
    }

    const concerns = verifierReport.rows.map((r) => r.concern).filter((c): c is string => !!c);
    const reportDoneArgs = ["report-done", id, ...completedRowIds.map(String)];
    if (concerns.length > 0) reportDoneArgs.push("--adversarial-concerns", concerns.join("||"));
    const reportDoneRes = cli([...reportDoneArgs, "--json"]);
    const reportDoneJson = reportDoneRes.json as { success?: boolean; reason?: string } | null;

    if (reportDoneJson?.success) {
      const outcome: ItemOutcome["outcome"] = /blocked/i.test(reportDoneJson.reason ?? "") ? "blocked-on-human" : "done";
      appendRunLog({ event: "item-outcome", itemId: id, step: "report-done", outcome, iterations: iteration, reason: reportDoneJson.reason ?? null });
      return { itemId: id, outcome, iterations: iteration, terminationReason };
    }

    const detail = `report-done rejected: ${reportDoneJson?.reason ?? reportDoneRes.stderr}`;
    const retryRes = cli(["retry", id, detail]);
    const result = finalizeRetry(id, retryRes, detail, iteration, terminationReason);
    appendRunLog({ event: "item-outcome", itemId: id, step: "report-done", outcome: result.outcome, detail, iterations: iteration });
    return result;
  }

  const detail = `${terminationReason}: ${verifierReport?.summary ?? "no verifier report produced"}`;
  const retryRes = cli(["retry", id, detail]);
  const result = finalizeRetry(id, retryRes, detail, iteration, terminationReason);
  appendRunLog({ event: "item-outcome", itemId: id, step: "converge", outcome: result.outcome, detail, iterations: iteration, terminationReason });
  return result;
}

/**
 * Maps the `retry` CLI's JSON response to a driver-level outcome label.
 *
 * `orch.retry()` returns `{retried:false, escalated:false}` in two cases — the item
 * was not found, or WorkOrchestrator classified the failure as an "infrastructure"
 * fault (pipeline tooling broken, not the work item) — see WorkOrchestrator.retry()'s
 * comments. In BOTH cases no retry counter was consumed and the item was NOT reset to
 * pending, so labeling this "retried" would be a false telemetry claim. "retry-noop"
 * keeps run-log/outcome telemetry honest about what actually happened.
 */
function finalizeRetry(id: string, retryRes: CliResult, detail: string, iterations?: number, terminationReason?: string): ItemOutcome {
  const retryJson = retryRes.json as { retried?: boolean; escalated?: boolean } | null;
  const outcome: ItemOutcome["outcome"] = retryJson?.escalated
    ? "escalated"
    : retryJson?.retried === false
      ? "retry-noop"
      : "retried";
  return { itemId: id, outcome, iterations, terminationReason, detail };
}

// ============================================================================
// Driver loop
// ============================================================================

export async function runDriver(deps: HeadlessWorkDriverDeps = {}): Promise<DriverRunResult> {
  const cli = deps.cliRunner ?? defaultCliRunner;
  // maxItems: TOTAL-RUN item cap (0 = unlimited). batchSize: size of a single
  // next-batch PULL. Independent knobs — see HeadlessWorkDriverDeps doc comments.
  const maxItems = deps.maxItems ?? DEFAULT_MAX_ITEMS;
  const batchSize = deps.batchSize ?? (maxItems === 0 ? DEFAULT_BATCH_SIZE : Math.min(maxItems, DEFAULT_BATCH_SIZE));
  const itemsProcessed: ItemOutcome[] = [];

  appendRunLog({ event: "driver-start" });

  const initRes = cli(["init", "--json"]);
  const initJson = initRes.json as { success?: boolean; message?: string } | null;
  if (!initJson || initJson.success === false) {
    const message = `init failed: ${initJson?.message ?? initRes.stderr ?? "unparseable init output"}`;
    recordFailure({ source: "HeadlessWorkDriver:init", error: new Error(message), tier: "digest" });
    appendRunLog({ event: "driver-error", step: "init", detail: message });
    return { itemsProcessed, deferred: false, error: message };
  }

  // Deferred-merge sweep (E3 fix round) — see the "Deferred-merge sweep" section
  // above. Runs once, at the START of the run, before the first next-batch pull.
  // Best-effort: a live lock or a sweep failure never blocks the rest of the run.
  const checkLock = deps.checkInteractiveSessionLockFn ?? defaultCheckInteractiveSessionLock;
  if (checkLock()) {
    appendRunLog({ event: "deferred-merge-sweep", outcome: "skipped-lock-live" });
  } else {
    const sweep = deps.deferredMergeSweepFn ?? defaultDeferredMergeSweep;
    try {
      const sweepResult = sweep();
      if (sweepResult.ok) {
        appendRunLog({
          event: "deferred-merge-sweep",
          outcome: "ran",
          merged: sweepResult.merged ?? 0,
          conflicts: sweepResult.conflicts ?? 0,
          skipped: sweepResult.skipped ?? 0,
        });
      } else {
        recordFailure({
          source: "HeadlessWorkDriver:deferred-merge-sweep",
          error: new Error(sweepResult.error ?? "sweep failed"),
          tier: "digest",
        });
        appendRunLog({ event: "deferred-merge-sweep", outcome: "failed", detail: sweepResult.error ?? "sweep failed" });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      recordFailure({
        source: "HeadlessWorkDriver:deferred-merge-sweep",
        error: err instanceof Error ? err : new Error(message),
        tier: "digest",
      });
      appendRunLog({ event: "deferred-merge-sweep", outcome: "failed", detail: message });
    }
  }

  let deferred = false;
  let processedCount = 0;

  outer: while (true) {
    if (maxItems !== 0 && processedCount >= maxItems) {
      appendRunLog({ event: "max-items-reached", maxItems, processedCount });
      break;
    }

    if (checkCeiling(deps)) {
      appendRunLog({ event: "defer", reason: "pre-batch-rate-limit-or-budget-ceiling" });
      deferred = true;
      break;
    }

    // Trim the pull size to what's left under the total cap so a capped run
    // never pulls (and thus never has to discard) more ready items than it
    // will actually process this run.
    const pullSize = maxItems === 0 ? batchSize : Math.min(batchSize, maxItems - processedCount);
    const batchRes = cli(["next-batch", String(pullSize), "--json"]);
    const batchJson = batchRes.json as { items?: ItemLite[]; blocked?: number } | null;
    if (!batchJson) {
      const message = `next-batch failed: ${batchRes.stderr ?? "unparseable next-batch output"}`;
      recordFailure({ source: "HeadlessWorkDriver:next-batch", error: new Error(message), tier: "digest" });
      appendRunLog({ event: "driver-error", step: "next-batch", detail: message });
      return { itemsProcessed, deferred, error: message };
    }

    const items = batchJson.items ?? [];
    if (items.length === 0) {
      appendRunLog({ event: "queue-empty", blocked: batchJson.blocked ?? 0 });
      break;
    }

    for (const item of items) {
      if (checkCeiling(deps)) {
        appendRunLog({ event: "defer", itemId: item.id, reason: "budget-ceiling-mid-batch" });
        deferred = true;
        break outer;
      }
      const outcome = await processItem(item, deps);
      itemsProcessed.push(outcome);
      processedCount++;
      if (outcome.outcome === "deferred") {
        deferred = true;
        break outer;
      }
      if (maxItems !== 0 && processedCount >= maxItems) {
        appendRunLog({ event: "max-items-reached", maxItems, processedCount });
        break outer;
      }
    }
  }

  appendRunLog({ event: "driver-end", processed: itemsProcessed.length, deferred });
  return { itemsProcessed, deferred, error: null };
}

// ============================================================================
// CLI entrypoint
// ============================================================================

/**
 * E3 fix round — parses the `--max-items` CLI flag into a validated TOTAL-RUN item
 * cap (wired to HeadlessWorkDriverDeps.maxItems). This is a cap on how many items
 * the driver processes across the WHOLE run, independent of batchSize (which
 * governs the size of each individual `next-batch` pull inside runDriver's outer
 * loop — see DEFAULT_BATCH_SIZE above); runDriver derives batchSize from maxItems
 * when batchSize isn't explicitly overridden (min(maxItems, DEFAULT_BATCH_SIZE)).
 *
 * Originally (E3) this flag only ever bounded a single `next-batch` pull size, so
 * a queue deeper than the flag's value was still drained to zero across repeated
 * batches — silently contradicting both the flag's own name and the nightly
 * manifest's documented "drains up to 5 items" behavior. Fixed here: the outer
 * loop now stops once `maxItems` items have been PROCESSED, full stop.
 *
 * Pure — no I/O, no process.exit; main() is the thin wrapper that catches a thrown
 * error and exits non-zero with a usage message.
 *
 *   - undefined (flag omitted)                 → DEFAULT_MAX_ITEMS (5 — cron sanity
 *                                                 default; see
 *                                                 manifests/autonomous-work-nightly.yaml)
 *   - "0"                                      → 0 = UNLIMITED (drains the entire
 *                                                 ready queue, batch by batch — the
 *                                                 pre-fix-round behavior; intended
 *                                                 for manual drain runs, not cron)
 *   - a positive-integer string ("1", "12")    → that integer, as a TOTAL cap
 *                                                 across the whole run (not per-batch)
 *   - anything else (non-numeric, negative,
 *     non-integer, e.g. "-1"/"abc"/"1.5")       → throws
 */
export function parseMaxItemsArg(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_MAX_ITEMS;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`--max-items must be a non-negative integer (0 = unlimited), got: ${JSON.stringify(raw)}`);
  }
  return n;
}

async function main() {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: { "max-items": { type: "string" } },
    allowPositionals: true,
    strict: false,
  });

  let maxItems: number;
  try {
    maxItems = parseMaxItemsArg(values["max-items"] as string | undefined);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }

  const result = await runDriver({ maxItems });
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.error ? 1 : 0);
}

if (import.meta.main) main();
