/**
 * CronRun.ts — the Cron Run module: one execution of a Job, behind `runCronJob`.
 *
 * The module owns the whole lifecycle ORDER and every release:
 *   manifest → enabled → slot match → power → run lock → idempotency → network
 *   → Claude slot → wake lock → attempts with retry → ledger row → fail streak
 *   → output routing → release.
 * Idempotency and the network probe run while the run lock is held, so a
 * concurrent duplicate for the same slot logs skip.locked instead of running
 * twice, and an offline 'deferred' row is written before the lock is released.
 * `bin/run-cron-job.ts` (the launchd entrypoint) is only an argv-to-exit-code
 * shim over this interface. See docs/decisions/034-cron-run-is-one-module.md.
 *
 * Interface: `runCronJob({ jobId, catchup }, deps?)` → `{ exitCode, outcome }`.
 * It never calls `process.exit`, and it resolves every path per call from
 * `getKayaHome()` / `memPath` (no module-level path constants), so a test can
 * point KAYA_HOME at a temp dir and call it in-process.
 *
 * Seam: only three dependencies are injected, because only they have a second
 * adapter — `spawn` (production: JobSpawner.spawnJob; tests: a scripted
 * spawn), `probeNetwork` (production: isNetworkReachable(); tests: a fixed
 * answer) and `now` (production: wall clock; tests: a fixed Date). The file
 * system (manifests, logs, ledger, locks) is local-substitutable through
 * KAYA_HOME.
 *
 * `--catchup` (req.catchup): bypasses the cron re-validation + idempotency
 * guard. Used exclusively by bin/job-reconciler.ts to actually EXECUTE a
 * missed slot — without it, a reconciler-triggered re-invocation at an
 * off-schedule wall-clock time immediately returns via skip.cron-mismatch
 * (exit 0, no ledger row), so the reconciler re-decides "run" forever.
 */

import { createAppendLog } from "../core/AppendLog.ts";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { acquireClaudeSlot, type ClaudeSlot } from "../core/ClaudeSemaphore.ts";
import { buildHardenedClaudeEnv } from "../core/Inference.ts";
import { getKayaHome } from "../core/KayaHome.ts";
import { JobSpecSchema, type JobSpec } from "./JobSpec.ts";
import { buildAgentSpawnArgs, fallbackModelFor } from "./AgentSpawnArgs.ts";
import { appendRunLedger, computeSlotKey, lastOutcomeForSlot, type RunOutcome } from "./RunLedger.ts";
import { acquireWakeLock } from "./WakeLock.ts";
import { isNetworkReachable } from "./NetworkPrecondition.ts";
import { getPowerState } from "./PowerState.ts";
import { spawnJob, type SpawnJobOptions, type SpawnJobResult } from "./JobSpawner.ts";
import { acquireRunLock, defaultRunLocksDir } from "./RunLock.ts";
import { findMatchedSlot } from "./CronMatch.ts";
import { routeJobOutput } from "./RouteOutput.ts";
import { trackFailStreak } from "./FailStreak.ts";
import { readManifest } from "./ManifestPaths.ts";
import { classifyFailure, type FailureClass } from "./FailureClassifier.ts";
import { memPath } from "../core/MemoryPaths.ts";

// ── Interface ────────────────────────────────────────────────────────────────

export interface CronRunRequest {
  jobId: string;
  catchup: boolean;
}

export type CronRunOutcome =
  | { kind: "no-manifest" }
  | { kind: "skipped"; reason: "disabled" | "cron-mismatch" | "idempotent" | "locked" }
  | { kind: "deferred"; reason: "offline" | "sleep-inflated"; attempt: number }
  | { kind: "ran"; success: boolean; attempt: number; failureClass?: FailureClass };

/** `exitCode` is launchd's LastExitStatus: 0 = skipped/deferred/success, 1 = failure, 2 = no-manifest. */
export interface CronRunResult {
  exitCode: 0 | 1 | 2;
  outcome: CronRunOutcome;
}

export interface CronRunDeps {
  /** Clock for slot match, catch-up slot key and ledger startedAt/finishedAt. */
  now: () => Date;
  /** One attempt: spawn + wait + timeout guard. */
  spawn: (o: SpawnJobOptions) => Promise<SpawnJobResult>;
  /** Network precondition probe (fail-closed in production). */
  probeNetwork: () => Promise<boolean>;
}

const DEFAULT_DEPS: CronRunDeps = {
  now: () => new Date(),
  spawn: spawnJob,
  probeNetwork: () => isNetworkReachable(),
};

const DEFAULT_TIMEOUT_MS = 300_000;

/**
 * Retry ONLY on transient/timeout/environment failures, NEVER on bug or auth:
 * retrying a deterministic bug or a bad credential just wastes attempts and
 * delays the failure being surfaced to Jm. The class comes from the spawn
 * result (JobSpawner runs FailureClassifier.classifyFailure).
 */
const RETRYABLE_FAILURES: ReadonlySet<FailureClass> = new Set(["transient", "timeout", "environment"]);

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// ── Internal helpers ─────────────────────────────────────────────────────────

function logEvent(jobId: string, event: Record<string, unknown>): void {
  try {
    // AppendLog owns dir creation + rotation/retention (S6 seam).
    createAppendLog(join(memPath("daemon", "cron", "logs"), `${jobId}.jsonl`)).append({
      timestamp: new Date().toISOString(),
      ...event,
    });
  } catch (err) {
    // Never fail the job over a log write, but say so on stderr (launchd's
    // stderr log) so a broken event log is visible (P04 S4, B4).
    const message = err instanceof Error ? err.message : String(err);
    console.error(`CronRun: cannot write event ${String(event.event)} for ${jobId}: ${message}`);
  }
}

// matchesField/matchesCronExact/matchesCron/findMatchedSlot live in
// ./CronMatch.ts (S2) so bin/job-reconciler.ts's due-slot policy can share
// the exact same local-time matcher instead of growing a second, divergent
// implementation — see CronMatch.ts's module doc for the B2 history this is
// guarding against.

/**
 * Thin wrapper: delegates the actual OutputMode→tier/channel routing to
 * ./RouteOutput.ts's routeJobOutput() (S11 — "messaging collapse";
 * lib/messaging/MessageRouter.ts + MessageQueue.ts deleted outright, see that
 * module's doc for the full rationale). Kept as a wrapper — rather than
 * inlining the call at the one call site below — solely to preserve the
 * `route.failed` breadcrumb contract via the jobId-scoped `logEvent()`, which
 * routeJobOutput() has no reason to know about.
 */
async function routeOutput(jobId: string, output: string, mode: JobSpec["output"]): Promise<void> {
  try {
    await routeJobOutput(jobId, output, mode);
  } catch (err) {
    logEvent(jobId, { event: "route.failed", error: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * One spawn + wait + timeout-guard attempt through `deps.spawn` (production:
 * the shared ./JobSpawner.ts core). Kept as a thin wrapper so the retry loop
 * (item 4 — B4) can call it multiple times with fresh state per attempt (a
 * retry is a brand-new spawn, not a re-wait on a dead process), and so this
 * call site keeps its own jobId-scoped logEvent on timeout.
 */
async function spawnOnce(
  spawn: CronRunDeps["spawn"],
  jobId: string,
  spawnArgs: string[],
  directMode: boolean,
  correlationId: string,
  timeout: number,
  expectedExitCodes: number[],
): Promise<SpawnJobResult> {
  const attemptStart = Date.now();
  try {
    // `await` inside the try: Bun.spawn throws synchronously (e.g. ENOENT on a
    // missing binary) and a spawn may also reject; both land in the catch.
    return await spawn({
      spawnArgs,
      cwd: getKayaHome(),
      env: {
        ...(directMode ? process.env : agentSpawnEnv()),
        KAYA_CRON_JOB_ID: jobId,
        KAYA_CORRELATION_ID: correlationId,
      },
      timeout,
      expectedExitCodes,
      onTimeout: () => logEvent(jobId, { event: "timeout", timeout }),
    });
  } catch (err) {
    // A throwing attempt is a failed attempt (P04 S4, B2): it gets a
    // spawn.complete{success:false}, the retry decision, a ledger 'failure'
    // row, the fail streak and the output route like any other failure —
    // never an orphan spawn.start. exitCode null: the process never started,
    // so it has no exit code (SpawnJobResult.exitCode is `number | null`).
    const stderr = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      exitCode: null,
      stdout: "",
      stderr,
      timedOut: false,
      wallMs: Date.now() - attemptStart,
      sleptThrough: false,
      failureClass: classifyFailure({
        exitCode: null,
        signal: null,
        stderr,
        stdout: "",
        wasOffline: false,
        timedOut: false,
      }),
    };
  }
}

// ── Agent mode (P02 owns these calls) ───────────────────────────────────────
// The Claude slot, the hardened Claude env, the agent spawn args and the
// model fallback are owned by plan P02. Their call sites live in this one
// block, moved verbatim from bin/run-cron-job.ts; a P02 slice that changes
// them edits only this block. Direct-mode jobs never reach any of it.

/** Resolved per call: the usual install (~/.local/bin/claude) first, then PATH. */
function resolveClaudeBin(): string {
  const defaultClaudeBin = join(homedir(), ".local/bin/claude");
  return existsSync(defaultClaudeBin) ? defaultClaudeBin : (Bun.which("claude") ?? defaultClaudeBin);
}

function agentSpawnArgs(job: JobSpec, jobId: string, modelOverride?: string): string[] {
  return modelOverride
    ? buildAgentSpawnArgs(job, jobId, resolveClaudeBin(), { modelOverride })
    : buildAgentSpawnArgs(job, jobId, resolveClaudeBin());
}

function agentSpawnEnv(): Record<string, string | undefined> {
  return buildHardenedClaudeEnv();
}

// Concurrency gate (durable backstop): only agent-mode jobs spawn a heavy `claude -p`, so
// only they acquire a claude slot. Direct-mode (plain bun scripts) are cheap and ungated.
// Proceeds ungated if no slot frees within the wait budget — never blocks the job forever.
async function acquireAgentSlot(jobId: string): Promise<ClaudeSlot> {
  const claudeSlot = await acquireClaudeSlot({ timeoutMs: 300_000 });
  logEvent(jobId, {
    event: "claude-semaphore",
    acquired: claudeSlot.acquired,
    note: claudeSlot.acquired ? "slot acquired" : "proceeding ungated (all slots busy)",
  });
  return claudeSlot;
}

// Model fallback (2026-08-29: 18 consecutive agent-mode failures on
// "You've reached your Fable 5 limit" — every retry re-spawned on the same
// exhausted pool). Once an attempt classifies as rate-limit/quota, every
// later attempt in this run re-spawns on FALLBACK_AGENT_MODEL (see
// AgentSpawnArgs.fallbackModelFor). Direct-mode jobs are untouched.
function agentModelFallback(jobId: string, attemptResult: SpawnJobResult, attemptNum: number): string | undefined {
  const fallback = fallbackModelFor(attemptResult);
  if (fallback) {
    logEvent(jobId, {
      event: "model.fallback",
      from: "cli-default",
      to: fallback,
      attempt: attemptNum,
    });
  }
  return fallback;
}

// ── The Cron Run ─────────────────────────────────────────────────────────────

export async function runCronJob(req: CronRunRequest, deps: Partial<CronRunDeps> = {}): Promise<CronRunResult> {
  const { now: clock, spawn, probeNetwork } = { ...DEFAULT_DEPS, ...deps };
  const { jobId, catchup } = req;

  const manifest = readManifest(memPath("daemon", "cron", "manifests"), `${jobId}.yaml`);
  if (!manifest) {
    console.error(`No yaml found for ${jobId} in manifests/`);
    return { exitCode: 2, outcome: { kind: "no-manifest" } };
  }

  const job: JobSpec = JobSpecSchema.parse(parseYaml(manifest.content));
  if (!job.enabled) {
    logEvent(jobId, { event: "skip.disabled" });
    return { exitCode: 0, outcome: { kind: "skipped", reason: "disabled" } };
  }

  const now = clock();
  let slotKey: string;
  if (catchup) {
    // Catch-up invocation (from bin/job-reconciler.ts): the whole point of a
    // catch-up run is to execute a slot that is no longer due by wall-clock,
    // so the defensive cron re-check and idempotency short-circuit below
    // (both keyed off "is `now` on-schedule") do not apply here — applying
    // them would just re-produce the skip.cron-mismatch bug this flag exists
    // to fix. The slot key is still derived (from `now`, not a matched cron
    // slot) purely so the RunLedger row this run produces is forensically
    // distinguishable.
    slotKey = computeSlotKey(jobId, now);
  } else {
    // Defensive guard: launchd may over-fire for compound rules (e.g. "first
    // Friday" expressed as Day:1-7 + Weekday:5). Re-validate against the cron
    // expression so we never run on a wrong day.
    const matchedSlot = findMatchedSlot(job.schedule, now);
    if (!matchedSlot) {
      logEvent(jobId, { event: "skip.cron-mismatch", schedule: job.schedule, now: now.toISOString() });
      return { exitCode: 0, outcome: { kind: "skipped", reason: "cron-mismatch" } };
    }
    slotKey = computeSlotKey(jobId, matchedSlot);
  }

  const correlationId = `cron-${jobId}-${Math.random().toString(36).slice(2, 8)}`;
  const startedAt = clock().toISOString();
  const start = Date.now();
  const timeout = job.timeout ?? DEFAULT_TIMEOUT_MS;

  // Power state (B1/A2): record on-AC/battery + percentage on every ledger
  // row, whether the job actually runs, gets deferred, or fails. Never
  // throws (see PowerState.ts) — desktop Macs with no battery just report
  // onAC: null, source: 'unknown'. The wrapper process only runs while the
  // machine is awake (launchd wakes it to fire, or it was already up), so
  // reaching this line IS the "awake" signal — no separate probe needed.
  const powerState = getPowerState();
  const ledgerExtras = { awake: true, onAC: powerState.onAC, batteryPct: powerState.percentage };

  // Two execution paths:
  //   1. `execute:` present  → spawn the command directly; the script's own
  //      exit code becomes the cron run's exit code. Use for self-contained
  //      scripts (e.g. BriefingFallback) where we want exit-code discipline
  //      to propagate.
  //   2. `execute:` absent   → wrap `task` in a `claude -p ...` agent invocation.
  //      Use for jobs whose work is naturally agentic (knowledge ingest,
  //      maintenance routines, etc.).
  const directMode = job.execute?.command;
  const spawnArgs: string[] = directMode
    ? [job.execute!.command, ...(job.execute!.args ?? [])]
    : agentSpawnArgs(job, jobId);

  // Per-job run lock: exactly one wrapper may execute a given jobId at a
  // time. Guards the schedule-vs-reconciler race (launchd's scheduled fire
  // and the hourly reconciler's catch-up can land in the same second, before
  // the scheduled run writes its artifact — observed: daily-briefing
  // 2026-07-10T13:00Z ran twice) and any other double-invocation source.
  // Acquired BEFORE the claude-semaphore wait below so a duplicate never
  // camps on a slot for up to 300s while the real run is already going.
  // 'skip.locked' is invisible to cron-health-monitor (it pages on failed
  // spawn.complete rows only) — a skipped duplicate is not a failure. Stale
  // locks (crashed wrapper, pid gone) are recovered inside acquireRunLock;
  // exit paths that bypass the finally below (e.g. a throw before the try)
  // leave a dead-pid file that the next acquire reclaims. See RunLock.ts.
  const runLock = acquireRunLock(jobId, defaultRunLocksDir(), { correlationId });
  if (!runLock.acquired) {
    logEvent(jobId, {
      event: "skip.locked",
      slotKey,
      holderPid: runLock.holder?.pid,
      holderCorrelationId: runLock.holder?.correlationId,
    });
    return { exitCode: 0, outcome: { kind: "skipped", reason: "locked" } };
  }

  let claudeSlot: ClaudeSlot | null = null;
  let wakeLock: ReturnType<typeof acquireWakeLock> | null = null;
  try {
    // Idempotency guard (I3: read while the run lock is held, so a concurrent
    // duplicate for the same slot cannot pass it before the first run writes
    // its row): if this exact scheduled slot already succeeded (e.g. launchd
    // coalesced a duplicate fire, or a wake-from-sleep re-delivery), skip
    // re-spawning. Only a prior 'success' short-circuits — 'failure' /
    // 'deferred' / 'skipped' / no history all proceed normally. `--catchup`
    // bypasses it (see the catch-up comment above).
    if (!catchup && lastOutcomeForSlot(jobId, slotKey) === "success") {
      logEvent(jobId, { event: "skip.idempotent", slotKey });
      return { exitCode: 0, outcome: { kind: "skipped", reason: "idempotent" } };
    }

    // Network precondition (item 1): jobs that declare precondition.network
    // must not spawn while offline — spawning anyway would waste a
    // claude-semaphore slot + wake-lock + retry budget on a run that was never
    // going to succeed. Defer instead: write a 'deferred' ledger row and exit
    // 0 (not an error — the S5 reconciler is expected to catch up this slot
    // once connectivity returns). Fail-closed probe (see NetworkPrecondition.ts)
    // means a broken probe defers rather than spawning blind. Tests inject
    // `deps.probeNetwork`; production probes a real socket.
    if (job.precondition?.network) {
      const reachable = await probeNetwork();
      if (!reachable) {
        logEvent(jobId, { event: "skip.offline", slotKey });
        appendRunLedger({
          jobId,
          slotKey,
          startedAt,
          finishedAt: clock().toISOString(),
          outcome: "deferred",
          attempt: 0,
          ...ledgerExtras,
        });
        return { exitCode: 0, outcome: { kind: "deferred", reason: "offline", attempt: 0 } };
      }
    }

    if (!directMode) {
      claudeSlot = await acquireAgentSlot(jobId);
    }

    logEvent(jobId, {
      event: "spawn.start",
      mode: directMode ? "direct" : "agent",
      cmd: spawnArgs[0],
      correlationId,
    });

    // Wake-lock (A1): hold a `caffeinate -i` assertion tied to THIS wrapper
    // process's lifetime for the duration of the spawn+wait below, so macOS
    // can't idle-sleep mid-run. This is the fix for the 2026-07-01 sleep-kill
    // incident, where a long cron job got killed because the Mac idle-slept
    // while it was still running. `-w <pid>` means caffeinate auto-exits if
    // this wrapper ever dies without reaching the finally (crash/OOM-kill),
    // so a held lock can never outlive its job.
    //
    // KNOWN LIMIT: `caffeinate -i` prevents idle sleep only — it can NOT
    // defeat clamshell (lid-closed) sleep while on battery power. Guarding
    // against that is out of scope here (tracked separately, "A3 territory").
    wakeLock = job.wakeLock !== false ? acquireWakeLock(process.pid) : null;
    if (wakeLock) {
      logEvent(jobId, { event: wakeLock.held ? "caffeinate.held" : "caffeinate.failed" });
    }

    // Sleep-inflated timeouts defer instead of fail — but ONLY for jobs the
    // reconciler can catch up (catchUp + desiredArtifact). A job nobody would
    // re-run keeps loud failure semantics: silently deferring it would hide a
    // nightly job that never runs (fail visibly, never mask).
    const deferEligible = Boolean(job.catchUp && job.desiredArtifact);

    // Retry loop (item 4 — B4): job.retry defaults to {max:2, backoffMs:4000}
    // (see JobSpec.ts). attempt 1 is the initial try, not a "retry" — max=2
    // means up to 2 ADDITIONAL attempts after the first failure, for 3 total.
    // Only retry when the classified failure is transient/timeout/environment
    // (RETRYABLE_FAILURES above) — a deterministic 'bug' or bad 'auth'
    // credential will fail identically on every attempt, so retrying just
    // burns time and delays the failure being surfaced to Jm. Each retry is a
    // FRESH spawn (spawnOnce), never a re-wait on the previous (already-dead)
    // process. The loop stops on success, on a non-retryable failure, on a
    // sleep-deferred attempt, or once max+1 attempts are spent.
    let modelOverride: string | undefined;
    const maxAttempts = job.retry.max + 1;
    let attempt = 1;
    let result: SpawnJobResult;
    for (;;) {
      const attemptArgs = !directMode && modelOverride ? agentSpawnArgs(job, jobId, modelOverride) : spawnArgs;
      const attemptResult = await spawnOnce(
        spawn,
        jobId,
        attemptArgs,
        Boolean(directMode),
        correlationId,
        timeout,
        job.expectedExitCodes,
      );
      if (!directMode && !modelOverride) {
        const fallback = agentModelFallback(jobId, attemptResult, attempt);
        if (fallback) {
          modelOverride = fallback;
        }
      }
      // A sleep-inflated attempt on a reconciler-covered job logs
      // 'spawn.deferred' (NOT spawn.complete — bin/cron-health-monitor.ts
      // pages on failed spawn.complete rows, and a machine that slept
      // mid-run is not a job failure) and stops the retry loop: retrying
      // against a sleeping machine just re-burns the budget (2026-07-08/09
      // nights: 3x ~17min timeout attempts per run, 4-5 runs per night).
      const deferAttempt = attemptResult.sleptThrough && deferEligible;
      logEvent(jobId, {
        event: deferAttempt ? "spawn.deferred" : "spawn.complete",
        exitCode: attemptResult.exitCode,
        success: attemptResult.success,
        outputLength: attemptResult.stdout.length,
        attempt,
        ...(attemptResult.sleptThrough ? { sleptThrough: true, wallMs: attemptResult.wallMs, timeout } : {}),
        ...(attemptResult.failureClass ? { failureClass: attemptResult.failureClass } : {}),
        // Forensics on EVERY failed attempt, not just the last (the
        // briefing-hang investigation had only outputLength per attempt;
        // the killed agent's actual stdout — "Execution error" — and the
        // per-attempt wall-vs-timeout overshoot were the two facts that
        // localized the root cause). Tails bounded so a chatty job can't
        // bloat the jsonl.
        ...(attemptResult.success
          ? {}
          : {
              wallMs: attemptResult.wallMs,
              ...(attemptResult.stdout ? { stdoutTail: attemptResult.stdout.slice(-400) } : {}),
              ...(attemptResult.stderr ? { stderrTail: attemptResult.stderr.slice(-400) } : {}),
            }),
      });
      result = attemptResult;
      const shouldRetry =
        !attemptResult.success &&
        !deferAttempt &&
        attempt < maxAttempts &&
        attemptResult.failureClass !== undefined &&
        RETRYABLE_FAILURES.has(attemptResult.failureClass);
      if (!shouldRetry) break;
      logEvent(jobId, { event: "retry", attempt, nextAttempt: attempt + 1, backoffMs: job.retry.backoffMs });
      await sleep(job.retry.backoffMs);
      attempt += 1;
    }
    // Free the Claude slot as soon as the attempts end; the finally below
    // releases it again for a throw (ClaudeSlot.release() is idempotent).
    claudeSlot?.release();

    const duration = Date.now() - start;
    const { success, exitCode, stdout, stderr, failureClass } = result;
    // Breadcrumb the REAL error: the claude CLI prints usage-limit errors to
    // stdout with an EMPTY stderr (2026-07-09: 4x daily-upkeep failures all
    // logged the useless "Exit code: 1" while the actual message sat
    // unlogged in stdout), so fall back to a stdout head before the bare
    // exit code.
    const error = success ? undefined : stderr || stdout.slice(0, 300) || `Exit code: ${exitCode}`;

    if (result.sleptThrough && deferEligible) {
      // The machine slept through the attempt — this run is deferred, not
      // failed. Ledger 'deferred' (same semantics as the skip.offline path
      // above: the S5 reconciler is expected to catch this slot up once the
      // machine is properly awake) and exit 0. FailStreak is deliberately
      // NOT touched: a sleep between two identical bug failures must not
      // reset the heal-escalation streak.
      logEvent(jobId, {
        event: "execute.deferred",
        type: "isolated",
        reason: "sleep-inflated",
        duration,
        wallMs: result.wallMs,
        timeout,
        attempt,
      });
      appendRunLedger({
        jobId,
        slotKey,
        startedAt,
        finishedAt: clock().toISOString(),
        outcome: "deferred",
        attempt,
        ...ledgerExtras,
        // Override ledgerExtras' hardcoded awake:true: THIS row exists
        // BECAUSE the machine slept through the attempt (sleptThrough &&
        // deferEligible, checked above) — awake:true here would be actively
        // wrong, not just imprecise. The OTHER deferred-ledger branch
        // (skip.offline, above) keeps the ledgerExtras default: a
        // network-unreachable defer can happen on a fully awake machine, so
        // that row's awake:true is not misleading.
        awake: false,
      });
      return { exitCode: 0, outcome: { kind: "deferred", reason: "sleep-inflated", attempt } };
    }

    logEvent(jobId, {
      event: "execute.complete",
      type: "isolated",
      success,
      duration,
      attempt,
      ...(error ? { error } : {}),
      ...(failureClass ? { failureClass } : {}),
    });

    const outcome: RunOutcome = success ? "success" : "failure";
    appendRunLedger({
      jobId,
      slotKey,
      startedAt,
      finishedAt: clock().toISOString(),
      outcome,
      ...(failureClass ? { failureClass } : {}),
      attempt,
      ...ledgerExtras,
    });

    // Heal-streak escalation (L1 — appusage-duckdb-batching follow-on): pages
    // via AlertGate once the SAME 'bug'-class (or, per the 2026-07-20
    // widening, non-sleep-inflated 'timeout'-class) failure recurs
    // HEAL_ESCALATE_THRESHOLD times in a row for this jobId, ending the blind
    // multi-hour retry-burn class from the 2026-07-03/07-07 appusage-nightly
    // DuckDB SIGTRAP incident. Success (or any non-escalatable failure)
    // resets the streak — see FailStreak.ts's module doc. `sleptThrough` is
    // passed through so a sleep-inflated timeout on a job that reaches this
    // branch (i.e. NOT reconciler-eligible — see deferEligible above) never
    // bumps the streak. Additive only: does not touch routeOutput() or the
    // exit-code path below. Awaited (T2-01): trackFailStreak()/sendAlert()
    // are now async — an un-awaited call here would serialize a bare
    // Promise into the forensic ledger below (JSON.stringify silently
    // renders it `{}`), destroying exactly the delivery-confirmation signal
    // this fix exists to add.
    const failStreakResult = await trackFailStreak(jobId, outcome, failureClass, undefined, result.sleptThrough);
    logEvent(jobId, { event: "fail-streak", ...failStreakResult });

    // S6 (401 auth-storm remediation, 2026-07-15): route to the digest
    // spool ONLY on failure. Before this, only SUCCESS routed — routine
    // successful stdout (gmail-jobs-sync's daily sync summary, chief
    // among them) piled into SystemHealthDigest's spool under stable
    // `cron:<jobId>` keys every run; several concurrently-nonempty job
    // keys pushed the composed digest past Telegram's 4096-char cap, the
    // resulting HTTP 400 re-spooled the ENTIRE uncapped entry set
    // verbatim, and the next day's attempt repeated the cycle — the
    // digest poison pill (587 spool entries observed 07-15). `error` is
    // always a defined string here (computed above whenever `!success`,
    // with its own `Exit code: N` fallback) — the `??` guards only
    // TypeScript's control-flow narrowing, not a real runtime gap.
    if (!success) {
      await routeOutput(jobId, error ?? `Exit code: ${exitCode}`, job.output);
    }

    return {
      exitCode: success ? 0 : 1,
      outcome: { kind: "ran", success, attempt, ...(failureClass ? { failureClass } : {}) },
    };
  } finally {
    // Release on ALL exit paths — success, failure, timeout, or an
    // unexpected throw anywhere in the try block above. The returns inside
    // the try complete only after this finally has run, so the caffeinate
    // assertion and the run lock are released before the caller (the bin
    // shim) calls process.exit().
    claudeSlot?.release();
    if (wakeLock?.held) {
      wakeLock.release();
      logEvent(jobId, { event: "caffeinate.released" });
    }
    runLock.release();
  }
}
