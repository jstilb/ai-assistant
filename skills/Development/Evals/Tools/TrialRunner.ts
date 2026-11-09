#!/usr/bin/env bun
/**
 * Trial Runner
 * Execute multiple trials and calculate pass@k / pass^k metrics
 */

import type { Task, Trial, EvalRun, Transcript, InfraFailureType } from "../Types/index.ts";
import { createGrader, runGraders, type GraderContext } from "../Graders/Base.ts";
import { TranscriptCapture } from "./TranscriptCapture.ts";
import { parseArgs } from "node:util";
import { classifyText, type TextEnd } from "../../../../lib/core/ClaudeRunEnd.ts";

// Import graders to register them
import "../Graders/CodeBased/index.ts";
import "../Graders/ModelBased/index.ts";

/**
 * Structured, machine-authored signals an executor threads back to
 * TrialRunner so it can classify infra failures WITHOUT ever reading the
 * agent's own output/answer text. See classifyInfraFailure() below for the
 * decision table and MEMORY/SkillAudits/evals-infra-audit-2026-07-09/liverun.md
 * finding 2 for why: the old classifier keyword-scanned agent output and
 * misclassified a fully-correct, well-formatted answer as an infra failure
 * because its own text happened to include the word "authentication" —
 * silently zeroing kaya_full_format_compliance for 5 months.
 */
export interface InfraSignals {
  /** Subprocess exit code (0 on success). */
  exitCode: number;
  /** Subprocess stderr text, if any. Narrow known signatures are matched
   *  ONLY against this — never against stdout/agent output. */
  stderr?: string;
  /** True when the claude CLI's stream-json `result` event itself reported
   *  is_error:true — a machine-authored structured field, not free text. */
  resultIsError?: boolean;
  /** The `result` event's `subtype` field (e.g. "error_during_execution"),
   *  present alongside resultIsError. */
  resultErrorSubtype?: string;
}

// Executor type for running tasks
export type TaskExecutor = (
  task: Task,
  trialNumber: number,
) => Promise<
  {
    output: string;
    transcript: Transcript;
    outcome?: unknown;
  } & InfraSignals
>;

export interface TrialRunnerConfig {
  task: Task;
  /** Runs one trial. Production passes EvalExecutor's trialExecutor(). */
  executor: TaskExecutor;
  onTrialComplete?: (trial: Trial) => void;
}

/**
 * P02's run-end classes → the Evals InfraFailureType labels. A credit/quota
 * banner is a limit, not a bug, so it is bucketed as 'rate_limit'. Network
 * texts (ENOTFOUND, ECONNREFUSED, ECONNRESET, socket closed, …) map to
 * 'timeout'; some of them had no label under the old substring list (plan
 * P10 B3, adopted by Jm 2026-11-08).
 */
const TEXT_END_TO_INFRA: Record<TextEnd, InfraFailureType> = {
  "rate-limit": "rate_limit",
  quota: "rate_limit",
  auth: "auth_error",
  network: "timeout",
  timeout: "timeout",
};

/**
 * Match text against a narrow, known set of infra-failure signatures.
 * ONLY ever call this on machine-authored text — subprocess stderr, a
 * stream-json result event's `subtype` field, or a caught JS exception's
 * message. NEVER on agent output/transcript text (that's the bug this
 * classifier replaced — see InfraSignals doc comment above).
 *
 * Exported so callers OTHER than the internal classification path below can
 * check "would TrialRunner treat this text as an infra signature" —
 * DestructiveScenarioGuard.ts's formatRefusalMessage() uses this as a
 * belt-and-suspenders final check on its assembled (thrown) message, since
 * that message is caught by this same module's catch block further down.
 *
 * The signatures are lib/core/ClaudeRunEnd.ts's ONE table, read through
 * classifyText(text, "machine") (plan P10 slice 5) — cron's retry logic and
 * this classifier must agree on what a limit/auth/timeout message is.
 */
export function matchKnownInfraSignature(text: string): InfraFailureType | null {
  const end = classifyText(text, "machine");
  return end === null ? null : TEXT_END_TO_INFRA[end];
}

/**
 * Classify an infra failure from machine-authored structured signals ONLY —
 * never from the agent's own output text.
 *
 * Decision table (checked in this order; first match wins):
 *   1. `stderr` matches a narrow known signature (rate limit / timeout /
 *      auth)              -> that specific InfraFailureType.
 *   2. stream-json `result` event reported `is_error: true` -> classify its
 *      `subtype` field if it matches a known signature, else the generic
 *      'exec_error' bucket.
 *   3. subprocess `exitCode !== 0` with no more specific signal above
 *                          -> 'exec_error'.
 *   4. otherwise           -> null (not an infra failure; grade normally).
 */
function classifyInfraFailure(signals: InfraSignals): InfraFailureType | null {
  if (signals.stderr) {
    const bySignature = matchKnownInfraSignature(signals.stderr);
    if (bySignature) return bySignature;
  }

  if (signals.resultIsError) {
    const bySubtype = signals.resultErrorSubtype ? matchKnownInfraSignature(signals.resultErrorSubtype) : null;
    return bySubtype ?? "exec_error";
  }

  if (signals.exitCode !== 0) {
    return "exec_error";
  }

  return null;
}

/** Every grader result of the trial carries the structured `details.judge_error`
 *  marker (the judge failed to produce a verdict). False for a trial with no
 *  grader results. */
function isJudgeFailedTrial(trial: Trial): boolean {
  return (
    trial.grader_results.length > 0 && trial.grader_results.every((g) => typeof g.details?.["judge_error"] === "string")
  );
}

function judgeErrorOf(trial: Trial): string {
  const e = trial.grader_results[0]?.details?.["judge_error"];
  return typeof e === "string" ? e : "unknown";
}

// ============================================================================
// Run Verdict — "does this run count, and did it pass?"
// ============================================================================

/** Why a run carries no behavioral signal. Persisted as `status: "infra_skipped"`. */
export type NoSignalCause = "all_trials_infra" | "judge_failure" | "fixture_fallback";

/**
 * The Run Verdict: a run either counts (and passes or fails) or carries no
 * behavioral signal (a cause plus the reason text persisted as `infra_reason`).
 * Computed from the EvalRun, never stored on it — see
 * skills/Development/Evals/docs/adr/0001-run-verdict-computed-not-stored.md.
 */
export type RunVerdict = { counts: true; pass: boolean } | { counts: false; cause: NoSignalCause; reason: string };

/**
 * A task run whose EVERY trial was an infra failure (transient inference
 * timeout, econnreset, etc.) carries NO behavioral signal. Falls back to the
 * run's own counters, so an EvalRun without `trials` is still classified.
 */
function isAllTrialsInfraRun(run: EvalRun): boolean {
  return run.infra_failures >= run.n_trials;
}

/**
 * Trials that reached the graders. Defensive: an EvalRun built without a
 * `trials` array (minimal summary fixtures) has none — never a throw.
 */
function behavioralTrialsOf(run: EvalRun): Trial[] {
  if (!Array.isArray(run.trials)) return [];
  return run.trials.filter((t) => t.status !== "infra_failure");
}

/**
 * A run whose zero score is entirely explained by the JUDGE's OWN nested
 * inference() call failing — not by the agent-under-test's behavior. First
 * built for the S5 401 auth-storm (2026-07-15), widened by B2 (2026-10-17) to
 * ANY judge failure. The all-trials-infra check only sees the TOP-LEVEL agent
 * spawn's signals (classifyInfraFailure(), fed by executeTask()'s exitCode/
 * stderr/resultIsError). It cannot see a judge-based grader's SEPARATE nested
 * `claude -p` spawn inside runGraders() — the agent spawn can exit 0 (or even
 * be skipped entirely, e.g. fixture_accuracy/nightly_judge "static input"
 * tasks) while that second, judge-scoring spawn fails, landing a real
 * `score: 0` with no infra_failure_type at all.
 *
 * Every judge-based grader that wraps Graders/JudgeProtocol.ts's
 * judgeInference() (LLMRubric, NaturalLanguageAssert, NightlyJudge) sets
 * GraderResult.details.judge_error ONLY when the judge failed to produce a
 * usable verdict: the nested inference() call failed (non-zero exit, empty
 * output, timeout, limit/credit text, auth) or its reply was not valid
 * JSON/schema — never on a real, successfully-judged verdict. A score of 0
 * next to a judge_error is therefore "nobody judged", never a judgement of
 * the agent. That's a STRUCTURED, machine-authored marker (a field's mere
 * presence), not agent output/answer text — checking it is NOT the
 * keyword-sniffing anti-pattern the evals-rebuild spine eliminated (see
 * classifyInfraFailure's own doc comment).
 *
 * WHY presence, not matchKnownInfraSignature(judge_error): the original rule
 * required the judge_error TEXT to match the auth signature. The
 * 2026-10-13..10-17 outage's text was `Process exited with code 1` (an
 * empty-stderr `claude -p` exit), which matched nothing, so 9 of 12 nightly
 * tasks persisted as real zeros and poisoned the rolling baselines. Any
 * text-based allow-list will keep missing the next outage shape (credit
 * text, empty output, ...); the marker already says everything needed.
 *
 * A partial judge failure (some trials judged) never reaches here as such:
 * TrialRunner.run() converts those trials to infra trials first.
 */
function isAllJudgesFailedRun(run: EvalRun): boolean {
  const behavioralTrials = behavioralTrialsOf(run);
  if (behavioralTrials.length === 0) return false;
  return behavioralTrials.every((trial) => isJudgeFailedTrial(trial));
}

/**
 * A fixture_accuracy task run whose score is error-fallback noise, not
 * judgment (S5 residual, 401-storm 2026-07-16). The runner's per-fixture live
 * inference() calls fail inside setup_commands (agent spawn is skipped for
 * these tasks, so no infra_failure_type; no judge grader, so no
 * judge_error), and the runner's catch-block fallback `actual` can
 * coincidentally match negative-class fixtures' expected values — a
 * misleading NON-zero partial score with 0% genuine judgment.
 *
 * Classification keys on GraderResult.details.fixture_infra_error — a
 * STRUCTURED, machine-authored marker FixtureAccuracy.ts emits ONLY when a
 * strict majority of the record's fixtures carry the runner's own
 * `infra_error` field. Same doctrine as details.judge_error: a field's
 * presence, not output-text sniffing. A minority of errored fixtures does NOT
 * trip this — each already counts incorrect in the record, a real (if
 * depressed) behavioral signal.
 */
function isFixtureFallbackRun(run: EvalRun): boolean {
  const behavioralTrials = behavioralTrialsOf(run);
  if (behavioralTrials.length === 0) return false;
  return behavioralTrials.every((trial) => {
    if (trial.grader_results.length === 0) return false;
    return trial.grader_results.every((g) => g.details?.["fixture_infra_error"] !== undefined);
  });
}

/**
 * THE answer to "does this run count, and did it pass?" for every caller:
 * runSuite()'s task records and console lines, the persisted JSONL
 * (`status: "infra_skipped"` + `infra_reason`), the `run` CLI exit code,
 * summarizeSuiteRuns() and AblationRunner. Pure: no I/O, clock or env.
 *
 * Order (first match wins): all trials infra → judge failure → fixture
 * fallback → counts.
 *
 * Pass rule (only when the run counts): unanimity, `pass_rate >= 1`.
 * Task.pass_threshold is applied EXACTLY ONCE, upstream, inside runGraders()
 * (Graders/Base.ts) — it gates whether each individual TRIAL's `passed`
 * field is true. This asks a DIFFERENT question — "were ALL trials of this
 * task consistent" — so it requires unanimity rather than re-applying a
 * second, independent score threshold. For the live corpus (trials ∈
 * {1,2,3}) this is identical to the old `pass_rate >= 0.75` check; it only
 * matters for a task with 4+ trials, where it demands ALL trials pass.
 */
export function runVerdict(run: EvalRun): RunVerdict {
  if (isAllTrialsInfraRun(run)) {
    const cause = run.trials?.find((t) => t.error)?.error;
    return {
      counts: false,
      cause: "all_trials_infra",
      reason: `all ${run.infra_failures}/${run.n_trials} trial(s) infra-failed${cause ? `: ${cause}` : ""}`,
    };
  }
  if (isAllJudgesFailedRun(run)) {
    const first = run.trials
      .flatMap((t) => t.grader_results)
      .map((g) => g.details?.["judge_error"])
      .find((e): e is string => typeof e === "string");
    return { counts: false, cause: "judge_failure", reason: `judge failure: ${first ?? "unknown"}` };
  }
  if (isFixtureFallbackRun(run)) {
    return {
      counts: false,
      cause: "fixture_fallback",
      reason: "fixture-runner infra failure (majority of fixtures errored)",
    };
  }
  return { counts: true, pass: run.pass_rate >= 1 };
}

/**
 * Suite-level summary, a fold over runVerdict(). A run that does not count
 * (any NoSignalCause) is excluded from pass/mean through ONE counter, so the
 * console summary and runSuite()'s persisted payload can never disagree on
 * the denominator (MEMORY/SkillAudits/evals-infra-audit-2026-07-09/gap.md
 * finding 2). The `ok` flag requires real signal (`scored > 0`) so an
 * all-infra suite still FAILs (no `0 === 0` false-pass). Genuine
 * `error`-status trials (e.g. a code crash) are NOT infra failures and stay
 * counted.
 */
export function summarizeSuiteRuns(runs: EvalRun[]): {
  passed: number;
  failed: number;
  total: number;
  meanScore: number;
  infraSkipped: number;
  ok: boolean;
} {
  let passed = 0;
  let totalScore = 0;
  let scored = 0;
  let infraSkipped = 0;
  for (const run of runs) {
    const v = runVerdict(run);
    if (!v.counts) {
      infraSkipped++;
      continue;
    }
    scored++;
    if (v.pass) passed++;
    totalScore += run.mean_score;
  }
  return {
    passed,
    failed: scored - passed,
    total: scored,
    meanScore: scored > 0 ? totalScore / scored : 0,
    infraSkipped,
    ok: scored > 0 && passed === scored,
  };
}

export class TrialRunner {
  private config: TrialRunnerConfig;
  private executor: TaskExecutor;

  constructor(config: TrialRunnerConfig) {
    this.config = config;
    this.executor = config.executor;
  }

  /**
   * Run all trials for a task
   */
  async run(): Promise<EvalRun> {
    const task = this.config.task;
    const nTrials = task.trials ?? 1;
    const trials: Trial[] = [];

    const runId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const startTime = Date.now();

    // Create graders
    const graders = task.graders.map((config) => createGrader(config));

    for (let i = 0; i < nTrials; i++) {
      const trialId = `trial_${i + 1}`;
      const trialStart = Date.now();

      try {
        // Execute the task
        const execution = await this.executor(task, i + 1);

        // Classify infra failures from structured signals only (exitCode /
        // stderr / stream-json result event) — never from execution.output,
        // the agent's own answer text. See classifyInfraFailure() above.
        const infraType = classifyInfraFailure(execution);
        if (infraType) {
          const trial: Trial = {
            id: trialId,
            task_id: task.id,
            trial_number: i + 1,
            status: "infra_failure",
            started_at: new Date(trialStart).toISOString(),
            completed_at: new Date().toISOString(),
            transcript: execution.transcript,
            grader_results: [],
            score: 0,
            passed: false,
            error: `Infra failure detected: ${infraType}`,
            infra_failure_type: infraType,
          };

          trials.push(trial);
          console.log(`  ⚠️  Trial ${i + 1}: infra failure (${infraType}) — skipping graders`);

          if (this.config.onTrialComplete) {
            this.config.onTrialComplete(trial);
          }
          continue;
        }

        // Create grader context
        const context: GraderContext = {
          task_id: task.id,
          trial_id: trialId,
          transcript: execution.transcript,
          output: execution.output,
          working_dir: task.setup?.working_dir,
          reference: task.reference_solution,
          // evals-rebuild slice B1: plumbs Task.pass_threshold into
          // runGraders()'s trial-level pass/fail decision — see
          // GraderContext.pass_threshold's doc comment (Graders/Base.ts).
          pass_threshold: task.pass_threshold,
        };

        // Run graders
        const { results, aggregate_score, passed } = await runGraders(graders, context);

        const trial: Trial = {
          id: trialId,
          task_id: task.id,
          trial_number: i + 1,
          status: passed ? "passed" : "failed",
          started_at: new Date(trialStart).toISOString(),
          completed_at: new Date().toISOString(),
          transcript: execution.transcript,
          grader_results: results,
          score: aggregate_score,
          passed,
        };

        trials.push(trial);

        if (this.config.onTrialComplete) {
          this.config.onTrialComplete(trial);
        }
      } catch (e) {
        // Genuine thrown exception (not the agent's output) during
        // execution — still classified as an infra failure when its
        // message matches a known signature. This is our own/Node's
        // machine-authored error message (e.g. a timeout we threw), never
        // agent-authored text, so pattern-matching it is fine.
        const errorStr = String(e);
        const infraType = matchKnownInfraSignature(errorStr);

        const trial: Trial = {
          id: trialId,
          task_id: task.id,
          trial_number: i + 1,
          status: infraType ? "infra_failure" : "error",
          started_at: new Date(trialStart).toISOString(),
          completed_at: new Date().toISOString(),
          transcript: new TranscriptCapture(task.id, trialId).finalize(),
          grader_results: [],
          score: 0,
          passed: false,
          error: errorStr,
          infra_failure_type: infraType ?? undefined,
        };

        trials.push(trial);

        if (this.config.onTrialComplete) {
          this.config.onTrialComplete(trial);
        }
      }
    }

    // B2: a trial whose behavioral graders ALL failed to judge (details.judge_error
    // — see isAllJudgesFailedRun for why that marker means "nobody judged")
    // carries no signal, so when OTHER trials of the same run did get judged it
    // is an infra trial like any other: out of mean, pass_rate, pass@k.
    // If EVERY trial is judge-failed the run is left as-is for runVerdict()
    // (cause "judge_failure", whole-run skip) — not converted here, so a judge
    // outage doesn't feed the suite circuit breaker (agent spawns succeeded).
    const judgeFailedTrials = trials.filter((t) => t.status !== "infra_failure" && isJudgeFailedTrial(t));
    if (
      judgeFailedTrials.length > 0 &&
      judgeFailedTrials.length < trials.filter((t) => t.status !== "infra_failure").length
    ) {
      for (const t of judgeFailedTrials) {
        const judgeError = judgeErrorOf(t);
        t.status = "infra_failure";
        t.passed = false;
        t.error = `Judge failure: ${judgeError}`;
        t.infra_failure_type = matchKnownInfraSignature(judgeError) ?? "exec_error";
        console.log(`  ⚠️  Trial ${t.trial_number}: judge failed (${judgeError}) — counted as infra trial`);
      }
    }

    // Calculate aggregate metrics, excluding infra failures from denominator
    const infraFailures = trials.filter((t) => t.status === "infra_failure").length;
    const behavioralTrials = trials.filter((t) => t.status !== "infra_failure");
    const passCount = behavioralTrials.filter((t) => t.passed).length;
    const behavioralCount = behavioralTrials.length;

    const scores = behavioralTrials.map((t) => t.score);
    const meanScore = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
    const variance = scores.length > 0 ? scores.reduce((sum, s) => sum + (s - meanScore) ** 2, 0) / scores.length : 0;
    const stdDev = Math.sqrt(variance);

    // Calculate pass@k and pass^k using only behavioral trials
    const passAtK = this.calculatePassAtK(behavioralTrials);
    const passToK = this.calculatePassToK(behavioralTrials);

    if (infraFailures > 0) {
      console.log(`  ⚠️  ${infraFailures}/${nTrials} trials were infra failures (excluded from pass_rate)`);
    }

    const evalRun: EvalRun = {
      id: runId,
      task_id: task.id,
      trials,
      n_trials: nTrials,
      pass_rate: behavioralCount > 0 ? passCount / behavioralCount : 0,
      mean_score: meanScore,
      std_dev: stdDev,
      pass_at_k: passAtK,
      pass_to_k: passToK,
      infra_failures: infraFailures,
      started_at: new Date(startTime).toISOString(),
      completed_at: new Date().toISOString(),
      total_duration_ms: Date.now() - startTime,
    };

    return evalRun;
  }

  /**
   * pass@k: Probability of at least one success in k trials
   * This measures capability - can the agent ever succeed?
   *
   * Formula: 1 - (n-c choose k) / (n choose k)
   * where n = total trials, c = successful trials, k = trials considered
   *
   * For k = n (using all trials): 1 if any passed, 0 otherwise
   * Simplified: At least one trial passed
   */
  private calculatePassAtK(trials: Trial[]): number {
    const anyPassed = trials.some((t) => t.passed);
    return anyPassed ? 1 : 0;
  }

  /**
   * pass^k: Probability all k trials succeed
   * This measures consistency/reliability
   *
   * For k = n (using all trials): All trials must pass
   * Simplified: pass_rate
   */
  private calculatePassToK(trials: Trial[]): number {
    const passCount = trials.filter((t) => t.passed).length;
    return passCount / trials.length;
  }
}

/**
 * Calculate extended pass@k for different k values
 */
export function calculatePassAtKForK(trials: Trial[], k: number): number {
  const n = trials.length;
  const c = trials.filter((t) => t.passed).length;

  if (k > n) return 0; // Can't calculate for k > n
  if (c === 0) return 0; // No successes
  if (c >= k) return 1; // Guaranteed at least one success in any k sample

  // Calculate: 1 - (n-c choose k) / (n choose k)
  // = 1 - [(n-c)! / (k! * (n-c-k)!)] / [n! / (k! * (n-k)!)]
  // = 1 - [(n-c)! * (n-k)!] / [(n-c-k)! * n!]

  let failProb = 1;
  for (let i = 0; i < k; i++) {
    failProb *= (n - c - i) / (n - i);
  }

  return 1 - failProb;
}

/**
 * Format evaluation results for display
 */
export function formatEvalResults(run: EvalRun): string {
  const lines: string[] = [];

  lines.push(`## Evaluation Results: ${run.task_id}`);
  lines.push("");
  lines.push(`**Run ID:** ${run.id}`);
  lines.push(`**Duration:** ${(run.total_duration_ms / 1000).toFixed(2)}s`);
  lines.push("");
  lines.push("### Summary");
  lines.push("");
  lines.push(`| Metric | Value |`);
  lines.push(`|--------|-------|`);
  lines.push(`| Trials | ${run.n_trials} |`);
  lines.push(`| Pass Rate | ${(run.pass_rate * 100).toFixed(1)}% |`);
  lines.push(`| Mean Score | ${run.mean_score.toFixed(3)} |`);
  lines.push(`| Std Dev | ${run.std_dev.toFixed(3)} |`);
  lines.push(`| pass@k | ${(run.pass_at_k * 100).toFixed(1)}% |`);
  lines.push(`| pass^k | ${(run.pass_to_k * 100).toFixed(1)}% |`);
  if (run.infra_failures > 0) {
    lines.push(`| Infra Failures | ${run.infra_failures} (excluded from pass_rate) |`);
  }
  lines.push("");

  lines.push("### Trial Results");
  lines.push("");
  lines.push(`| Trial | Status | Score | Duration |`);
  lines.push(`|-------|--------|-------|----------|`);

  for (const trial of run.trials) {
    const status = trial.passed
      ? "✅ PASS"
      : trial.status === "infra_failure"
        ? "⚠️ INFRA"
        : trial.status === "error"
          ? "❌ ERROR"
          : "❌ FAIL";
    const duration = trial.transcript.metrics.wall_time_ms;
    lines.push(`| ${trial.trial_number} | ${status} | ${trial.score.toFixed(3)} | ${(duration / 1000).toFixed(2)}s |`);
  }

  // Show grader breakdown for first trial
  const firstTrial = run.trials[0];
  if (firstTrial && firstTrial.grader_results.length > 0) {
    lines.push("");
    lines.push("### Grader Breakdown (Trial 1)");
    lines.push("");
    lines.push(`| Grader | Score | Passed | Weight |`);
    lines.push(`|--------|-------|--------|--------|`);

    for (const result of firstTrial.grader_results) {
      const passed = result.passed ? "✅" : "❌";
      lines.push(`| ${result.grader_type} | ${result.score.toFixed(3)} | ${passed} | ${result.weight} |`);
    }
  }

  return lines.join("\n");
}

// CLI interface
if (import.meta.main) {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      "task-file": { type: "string", short: "t" },
      trials: { type: "string", short: "n", default: "1" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: true,
  });

  if (values.help || !values["task-file"]) {
    console.log(`
TrialRunner - Execute evaluations with multiple trials

Usage:
  bun run TrialRunner.ts -t <task-file> [-n trials]

Options:
  -t, --task-file    Path to task YAML file
  -n, --trials       Number of trials (default: from task or 1)
  -h, --help         Show this help

Example:
  bun run TrialRunner.ts -t UseCases/coding/fix-auth/task.yaml -n 3
`);
    process.exit(0);
  }

  console.log("Note: Full execution requires an agent executor to be configured.");
  console.log("This CLI is for testing the runner infrastructure.");
}
