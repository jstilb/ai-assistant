#!/usr/bin/env bun
/**
 * RegressionAlert.ts
 * Detect score regressions in eval runs — evals-rebuild slice B5.
 *
 * Usage:
 *   bun RegressionAlert.ts check <suite> [--last N] [--threshold 0.10] [--max-age-hours 48]
 *
 * ARCHITECTURE (per doctrine feedback_determinism_earns_its_place.md — LLM
 * judgment for classification, deterministic code only for arithmetic,
 * protocol-parse, or fail-loud tripwires citing a named incident):
 *
 *   1. TWO deterministic, category-D tripwires read the unified store
 *      (MEMORY/VALIDATION/evals/<date>/<suite>-results.jsonl, via the A4
 *      ResultsUtils API) and fail loud — console error, recordFailure, a
 *      page-tier sendAlert, and a non-zero exit — never silent:
 *        (a) suite-failed-to-run  — the results store doesn't exist at all,
 *            OR this suite has run before but its freshest run predates the
 *            expected window (--max-age-hours, default 48h — one skipped
 *            nightly cycle of slack past the 24h cadence). Named incident:
 *            MEMORY/SkillAudits/evals-infra-audit-2026-07-09/nightly.md
 *            finding 1 — 11 of the last 12 nightly runs silently
 *            failed/timed out with zero alerting anywhere in the pipeline.
 *        (b) suite-pass-rate-zero — every task in the current (freshest) run
 *            scored a 0 pass rate. Named incident: the 2026-06-19 Zod-4
 *            "0 useful evals" silent-pass (see bin/kaya-evals-nightly.ts's
 *            own STEP 1 guard, which catches this from EvalExecutor's
 *            same-invocation summary; this is an independent second line of
 *            defense reading the persisted historical store, and the only
 *            one that fires for ad hoc/standalone `check <suite>` runs
 *            outside the nightly wrapper).
 *      A brand-new suite with zero runs EVER (but a store that demonstrably
 *      works for other suites) is NOT a tripwire — that's legitimate "no
 *      baseline yet" state, preserved from the original implementation
 *      (the "Found: 0 run(s)" / "Need at least 2 runs" messaging below,
 *      which bin/kaya-evals-nightly.ts's STEP 2 pattern-matches on stdout —
 *      preserved verbatim for that compatibility).
 *
 *   2. Per-task score deltas vs. a rolling baseline (avg of the last N
 *      runs) are the CHEAP TRIGGER for when to invoke a judge — pure
 *      arithmetic, unchanged from the original design (a drop >
 *      --threshold, default 10%, is candidate-worthy). The trigger no
 *      longer BY ITSELF decides "regression" vs "noise" — see judgeRegressionVerdict()
 *      below.
 *
 *   3. Every triggered candidate is classified by an LLM judge
 *      (judgeRegressionVerdict()) given the FULL last-N-days history for
 *      that specific task (not just the two numbers that tripped the
 *      trigger) — real regression vs noise vs known-flake vs environmental.
 *      This is what a pure delta-vs-rolling-baseline check structurally
 *      cannot do: the per-date kaya-pipeline-nightly-results.jsonl files
 *      show kaya_router_disposition_golden's pass_rate pinned at 0 for
 *      2026-06-28 through 2026-07-07 (12 invalid golden fixture entries) —
 *      a real, sustained regression that a naive rolling-baseline delta
 *      alone would under-detect once the poisoned scores become the new
 *      "baseline." The judge sees the whole trend, not just today's delta.
 *      FAIL-LOUD CONTRACT on judge failure: never silently suppress the
 *      candidate — fall back to the raw numeric verdict (severity from the
 *      delta magnitude, same math the original code used) with an explicit
 *      "LLM verdict unavailable, using raw delta" marker in both the
 *      console output and the report. The judge can only ever ADD
 *      suppression (a successful, schema-valid "regression: false" verdict
 *      moves a candidate to `dismissed_as_noise`, still visible in the
 *      report, never dropped outright) — it can never silently swallow one.
 */

import { existsSync } from 'fs';
import { join } from 'path';
import { z } from 'zod';
import type { EvalRunResult } from './shared/ResultsUtils.ts';
import { findSuiteRuns, loadRun } from './shared/ResultsUtils.ts';
import { inference, extractJson, type InferenceLevel, type InferenceResult } from '../../../../lib/core/Inference.ts';
import { getKayaHome } from '../../../../lib/core/KayaHome.ts';
import { sendAlert } from '../../../../lib/core/AlertGate.ts';
import { recordFailure } from '../../../../lib/core/FailureLog.ts';

// =============================================================================
// CONSTANTS
// =============================================================================

const DEFAULT_LAST = 3;
const DEFAULT_THRESHOLD = 0.10;
// Nightly cadence is 24h; one full skipped cycle of slack before this
// tripwire fires avoids paging on a single delayed-but-recovering run while
// still catching the documented "N nights in a row" failure class.
const DEFAULT_MAX_AGE_HOURS = 48;
const JUDGE_LEVEL: InferenceLevel = 'standard';

// Separator convention duplicated from shared/ResultsUtils.ts's opaque run-id
// contract ("<filePath>::<timestamp>", documented on findSuiteRuns/loadRun) —
// not exported there, so re-declared here rather than reaching into that
// module's internals. Same "the contract is the shape, not a shared const"
// reasoning ResultsUtils.ts itself uses for not importing ResultsPersistence's
// line types.
const RUN_ID_SEPARATOR = '::';

function extractRunTimestamp(runId: string): string {
  const idx = runId.lastIndexOf(RUN_ID_SEPARATOR);
  return idx === -1 ? runId : runId.slice(idx + RUN_ID_SEPARATOR.length);
}

// Resolved lazily at use-site (never frozen at import) so a test pinning
// KAYA_HOME after this module loads still targets its sandbox — same
// de-freeze pattern as ResultsUtils.ts's validationEvalsDir().
function evalsStoreRoot(): string {
  return join(getKayaHome(), 'MEMORY', 'VALIDATION', 'evals');
}

// =============================================================================
// TYPES
// =============================================================================

export interface RegressionAlertEntry {
  task_id: string;
  current_score: number;
  baseline_score: number;
  delta: number;
  severity: 'critical' | 'warning';
  verdict_source: 'llm' | 'raw-fallback';
  reasoning: string;
}

export interface DismissedCandidate {
  task_id: string;
  current_score: number;
  baseline_score: number;
  delta: number;
  reasoning: string;
}

export interface Tripwire {
  type: 'suite-failed-to-run' | 'suite-pass-rate-zero';
  message: string;
}

export interface AlertReport {
  suite: string;
  timestamp: string;
  tripwires: Tripwire[];
  total_regressions: number;
  critical_count: number;
  warning_count: number;
  regressions: RegressionAlertEntry[];
  dismissed_as_noise: DismissedCandidate[];
}

/** Raw candidate from the cheap numeric trigger, before LLM classification. */
interface RegressionCandidate {
  task_id: string;
  current_score: number;
  baseline_score: number;
  delta: number;
  /** The trigger's own naive severity guess — used as the fallback severity
   *  when the judge is unavailable, and as context fed TO the judge. */
  raw_severity: 'critical' | 'warning';
}

// =============================================================================
// TRIPWIRE (a): suite-failed-to-run
// =============================================================================

export interface FreshnessCheckResult {
  tripped: boolean;
  reason: string;
}

/**
 * Pure — no I/O. Category-D tripwire: the results store must exist AND (once
 * this suite has any history at all) its freshest run must fall inside the
 * expected window. See module docblock for the named incidents this guards.
 */
export function checkSuiteFreshnessTripwire(opts: {
  storeRootExists: boolean;
  /** Timestamp (ISO) of this suite's most recent run, or null when the
   *  store exists but this specific suite has never run — legitimate "no
   *  baseline yet" state, not a tripwire. */
  freshestRunTimestamp: string | null;
  nowMs: number;
  maxAgeHours: number;
}): FreshnessCheckResult {
  if (!opts.storeRootExists) {
    return {
      tripped: true,
      reason:
        'the eval results store (MEMORY/VALIDATION/evals/) does not exist at all — ' +
        'the nightly pipeline has apparently never persisted a single suite run ' +
        '(see MEMORY/SkillAudits/evals-infra-audit-2026-07-09/nightly.md finding 1: ' +
        '11 of 12 nightly runs silently failed/timed out with zero alerting)',
    };
  }
  if (opts.freshestRunTimestamp === null) {
    return { tripped: false, reason: 'no history yet for this suite (benign — new suite, no baseline)' };
  }
  const ageMs = opts.nowMs - Date.parse(opts.freshestRunTimestamp);
  if (Number.isNaN(ageMs)) {
    return { tripped: true, reason: `freshest run timestamp is unparseable: "${opts.freshestRunTimestamp}"` };
  }
  const ageHours = ageMs / 3_600_000;
  if (ageHours > opts.maxAgeHours) {
    return {
      tripped: true,
      reason: `freshest run is ${ageHours.toFixed(1)}h old (expected within ${opts.maxAgeHours}h) — last run at ${opts.freshestRunTimestamp}`,
    };
  }
  return { tripped: false, reason: `freshest run is ${ageHours.toFixed(1)}h old (within ${opts.maxAgeHours}h window)` };
}

// =============================================================================
// TRIPWIRE (b): suite-pass-rate-zero
// =============================================================================

/**
 * Pure — no I/O. True when every task in the current run scored a 0 pass
 * rate (the 2026-06-19 Zod-4 "0 useful evals" incident's shape). An empty
 * run (no tasks at all) is NOT a pass-rate-zero trip — that is caught
 * upstream as "no run found" / handled by the freshness tripwire; a run
 * with truly zero tasks scored is a different failure mode than a run where
 * every registered task scored 0.
 */
export function checkSuitePassRateZeroTripwire(currentRun: EvalRunResult[]): boolean {
  if (currentRun.length === 0) return false;
  return currentRun.every(r => r.pass_rate === 0);
}

// =============================================================================
// CHEAP TRIGGER: delta vs rolling baseline (pure arithmetic, unchanged design)
// =============================================================================

export function detectRegressionCandidates(
  currentRun: EvalRunResult[],
  baselineRuns: EvalRunResult[][],
  threshold: number
): RegressionCandidate[] {
  const candidates: RegressionCandidate[] = [];

  const baselineScores = new Map<string, number[]>();
  for (const run of baselineRuns) {
    for (const result of run) {
      const scores = baselineScores.get(result.task_id) || [];
      scores.push(result.mean_score);
      baselineScores.set(result.task_id, scores);
    }
  }

  for (const currentResult of currentRun) {
    const baseline = baselineScores.get(currentResult.task_id);
    if (!baseline || baseline.length === 0) continue; // no baseline for comparison

    const baselineScore = baseline.reduce((sum, s) => sum + s, 0) / baseline.length;
    const currentScore = currentResult.mean_score;
    const delta = currentScore - baselineScore;

    if (delta < -threshold) {
      candidates.push({
        task_id: currentResult.task_id,
        current_score: currentScore,
        baseline_score: baselineScore,
        delta,
        raw_severity: Math.abs(delta) > threshold * 2 ? 'critical' : 'warning',
      });
    }
  }

  candidates.sort((a, b) => a.delta - b.delta); // most severe (most negative) first
  return candidates;
}

// =============================================================================
// LLM VERDICT: real regression vs noise vs known-flake vs environmental
// =============================================================================

const RegressionVerdictSchema = z.object({
  regression: z.boolean(),
  severity: z.enum(['critical', 'warning', 'noise']),
  reasoning: z.string().min(1),
});
export type RegressionVerdict = z.infer<typeof RegressionVerdictSchema>;

/** Same DI shape convention as JudgeProtocol.InferenceFn / EnsembleValidator's
 *  inferenceFn / GoalConnector's GoalInferenceFn — a plain function reference
 *  tests can override; defaults to the real `inference`. */
export type RegressionInferenceFn = (opts: Parameters<typeof inference>[0]) => Promise<InferenceResult>;

export interface TaskHistoryPoint {
  timestamp: string;
  mean_score: number;
  pass_rate: number;
}

export interface RegressionVerdictResult {
  verdict: RegressionVerdict | null;
  /** Present only when verdict is null — always non-empty (fail-loud contract). */
  error?: string;
  raw_output?: string;
}

const REGRESSION_JUDGE_SYSTEM_PROMPT = `You are Kaya's eval regression classifier.

Kaya runs an LLM-graded golden-fixture suite nightly. Individual task scores
vary run to run for reasons that are NOT real behavioral regressions:
normal LLM-judge score variance, transient tool/infra failures, a model
update, or a bug in the fixture/golden data itself (not the system under
test). Your job is to read one task's score history and classify whether
its LATEST drop below the rolling baseline reflects:
  - a REAL regression (the system under test genuinely got worse; worth
    investigating)
  - NOISE (a single-run blip with no sustained pattern; not worth alerting)
  - a KNOWN-FLAKE pattern (this task oscillates in and out of failure
    repeatedly; a persistent flakiness issue, not a new development)
  - an ENVIRONMENTAL/fixture cause (a sustained multi-day streak more
    consistent with an infra or golden-data bug than the agent's own
    behavior changing)

Calibration — a real named incident: from 2026-06-28 through 2026-07-07,
kaya_router_disposition_golden's pass_rate sat at 0 on most nights because
of 12 invalid golden fixture entries. That was a REAL, sustained regression
that went undetected by naive delta-vs-rolling-baseline comparison, because
the poisoned low scores became the new "baseline" each night, shrinking the
apparent delta. A multi-run sustained low/zero streak is a strong regression
signal even when the single-night delta looks unremarkable. Conversely, one
low score that recovers on the very next run, surrounded by otherwise-stable
history, is much more likely noise.

Use "regression": true for anything Jm should actually look at (real
regression, sustained known-flake, or environmental/fixture issue needing a
fix) and false for a one-off blip not worth alerting on. Set "severity" to
"noise" whenever "regression" is false.`;

function buildRegressionJudgeUserPrompt(opts: {
  suite: string;
  taskId: string;
  currentScore: number;
  baselineScore: number;
  delta: number;
  threshold: number;
  history: TaskHistoryPoint[];
}): string {
  return JSON.stringify(
    {
      suite: opts.suite,
      task_id: opts.taskId,
      current_score: opts.currentScore,
      rolling_baseline_score: opts.baselineScore,
      delta: opts.delta,
      trigger_threshold: opts.threshold,
      // Chronological ascending — oldest first, current run last.
      history: opts.history,
    },
    null,
    2
  );
}

function regressionVerdictFormatInstruction(): string {
  return `Respond with ONLY a single JSON object (no markdown fences, no prose outside the JSON) matching exactly this shape:
{
  "regression": true|false,
  "severity": "critical"|"warning"|"noise",
  "reasoning": "<1-3 sentences citing the specific pattern in the history you observed>"
}`;
}

/**
 * Call the judge and return a validated, structured verdict — or a
 * non-null `error` on any failure. Mirrors Graders/JudgeProtocol.ts's
 * judgeInference() fail-loud contract (expectJson + zod validation, never a
 * silent default), but against RegressionVerdictSchema rather than
 * JudgeProtocol's own {score, reasoning} grading contract — those two
 * response shapes don't overlap enough to share the function itself.
 */
export async function judgeRegressionVerdict(opts: {
  suite: string;
  taskId: string;
  currentScore: number;
  baselineScore: number;
  delta: number;
  threshold: number;
  history: TaskHistoryPoint[];
  inferenceFn?: RegressionInferenceFn;
  level?: InferenceLevel;
}): Promise<RegressionVerdictResult> {
  const infer = opts.inferenceFn ?? inference;
  const userPrompt =
    buildRegressionJudgeUserPrompt(opts) + '\n\n' + regressionVerdictFormatInstruction();

  let result: InferenceResult;
  try {
    result = await infer({
      systemPrompt: REGRESSION_JUDGE_SYSTEM_PROMPT,
      userPrompt,
      level: opts.level ?? JUDGE_LEVEL,
      expectJson: true,
      retries: 1,
      retryDelayMs: 4000,
    });
  } catch (err) {
    return { verdict: null, error: `inference threw: ${err instanceof Error ? err.message : String(err)}` };
  }

  if (!result.success) {
    return {
      verdict: null,
      error: `judge inference failed: ${result.error ?? 'unknown error'}`,
      raw_output: result.output,
    };
  }

  // inference({expectJson:true}) already ran extractJson()'s repair pass and
  // populates `.parsed` on success. The extractJson() fallback here is a
  // pure defensive measure for a DI-mocked inferenceFn in tests that sets
  // `output` but forgets `.parsed` — same convention as JudgeProtocol.ts.
  const parsedRaw = result.parsed ?? extractJson(result.output);
  if (parsedRaw === undefined) {
    return {
      verdict: null,
      error: 'judge response was not valid JSON (expected {regression, severity, reasoning})',
      raw_output: result.output,
    };
  }

  const validated = RegressionVerdictSchema.safeParse(parsedRaw);
  if (!validated.success) {
    const issues = validated.error.issues.map(i => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    return {
      verdict: null,
      error: `judge response failed schema validation: ${issues}`,
      raw_output: result.output,
    };
  }

  return { verdict: validated.data, raw_output: result.output };
}

// =============================================================================
// HELPERS
// =============================================================================

/** Builds one task's chronological (oldest-first) score history from the
 *  already-loaded baseline + current runs, tagging each point with the
 *  run's timestamp (parsed out of the opaque run id findSuiteRuns() returns
 *  — see extractRunTimestamp()). baselineRunPaths/baseline are DESC
 *  (most-recent-first, per findSuiteRuns()'s documented contract) — reversed
 *  here so the judge reads the story in the order it happened. */
function buildTaskHistory(
  taskId: string,
  baseline: EvalRunResult[][],
  baselineRunPaths: string[],
  current: EvalRunResult[],
  currentRunPath: string
): TaskHistoryPoint[] {
  const points: TaskHistoryPoint[] = [];
  for (let i = baseline.length - 1; i >= 0; i--) {
    const entry = baseline[i]?.find(r => r.task_id === taskId);
    if (entry) {
      points.push({
        timestamp: extractRunTimestamp(baselineRunPaths[i]!),
        mean_score: entry.mean_score,
        pass_rate: entry.pass_rate,
      });
    }
  }
  const currentEntry = current.find(r => r.task_id === taskId);
  if (currentEntry) {
    points.push({
      timestamp: extractRunTimestamp(currentRunPath),
      mean_score: currentEntry.mean_score,
      pass_rate: currentEntry.pass_rate,
    });
  }
  return points;
}

function sortRegressions(regressions: RegressionAlertEntry[]): RegressionAlertEntry[] {
  return [...regressions].sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === 'critical' ? -1 : 1;
    return a.delta - b.delta;
  });
}

// =============================================================================
// COMMAND
// =============================================================================

export interface CmdCheckOptions {
  maxAgeHours?: number;
  inferenceFn?: RegressionInferenceFn;
  level?: InferenceLevel;
  /** Injectable clock for tests. */
  nowMs?: number;
}

export async function cmdCheck(
  suite: string,
  last: number,
  threshold: number,
  opts: CmdCheckOptions = {}
): Promise<AlertReport> {
  const maxAgeHours = opts.maxAgeHours ?? DEFAULT_MAX_AGE_HOURS;
  const nowMs = opts.nowMs ?? Date.now();
  const tripwires: Tripwire[] = [];

  console.log(`\n=== Regression Alert: ${suite} ===`);
  console.log(`Baseline: Last ${last} run(s)`);
  console.log(`Threshold: ${(threshold * 100).toFixed(0)}% score drop`);
  console.log(`Freshness window: ${maxAgeHours}h\n`);

  const storeRootExists = existsSync(evalsStoreRoot());
  const allRuns = storeRootExists ? findSuiteRuns(suite) : [];
  const freshestTimestamp = allRuns.length > 0 ? extractRunTimestamp(allRuns[0]!) : null;

  const freshness = checkSuiteFreshnessTripwire({ storeRootExists, freshestRunTimestamp: freshestTimestamp, nowMs, maxAgeHours });
  if (freshness.tripped) {
    console.error(`🚨 TRIPWIRE (suite-failed-to-run): ${freshness.reason}`);
    tripwires.push({ type: 'suite-failed-to-run', message: freshness.reason });
    recordFailure({
      source: 'RegressionAlert',
      error: `suite failed to run: ${freshness.reason}`,
      context: { suite, step: 'freshnessTripwire' },
    });
    sendAlert(`Eval regression check: ${suite} — suite failed to run (${freshness.reason})`, {
      key: `regression-alert-stale:${suite}`,
      tier: 'page',
      cooldownMs: 12 * 3600_000,
    });
  }

  if (!storeRootExists) {
    // Nothing else to read — short-circuit rather than printing the benign
    // "Found: 0 run(s)" messaging (that phrasing is reserved for the
    // legitimate new-suite case where the store itself demonstrably works).
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
    const report: AlertReport = {
      suite,
      timestamp: new Date(nowMs).toISOString(),
      tripwires,
      total_regressions: 0,
      critical_count: 0,
      warning_count: 0,
      regressions: [],
      dismissed_as_noise: [],
    };
    return report; // tripwires.length > 0 — caller (main()) exits non-zero
  }

  const runs = allRuns.slice(0, last + 1);

  if (runs.length < 2) {
    console.log(`❌ Need at least 2 runs for regression detection`);
    console.log(`   Found: ${runs.length} run(s)\n`);
    const report: AlertReport = {
      suite,
      timestamp: new Date(nowMs).toISOString(),
      tripwires,
      total_regressions: 0,
      critical_count: 0,
      warning_count: 0,
      regressions: [],
      dismissed_as_noise: [],
    };
    return report; // caller (main()) exits non-zero iff tripwires.length > 0
  }

  const currentRunPath = runs[0]!;
  const baselineRunPaths = runs.slice(1, last + 1);

  console.log(`📊 Loading runs...`);
  console.log(`   Current: ${currentRunPath.split('/').pop()}`);
  console.log(`   Baseline: ${baselineRunPaths.length} run(s)\n`);

  const current = loadRun(currentRunPath);
  const baseline = baselineRunPaths.map(p => loadRun(p));

  if (checkSuitePassRateZeroTripwire(current)) {
    const reason = `every task in the current run (${current.length} task(s)) scored a 0 pass rate — see the 2026-06-19 Zod-4 "0 useful evals" named incident`;
    console.error(`🚨 TRIPWIRE (suite-pass-rate-zero): ${reason}`);
    tripwires.push({ type: 'suite-pass-rate-zero', message: reason });
    recordFailure({
      source: 'RegressionAlert',
      error: `suite pass rate zero: ${reason}`,
      context: { suite, step: 'passRateZeroTripwire', run: currentRunPath },
    });
    sendAlert(`Eval regression check: ${suite} — every task scored 0 pass rate this run`, {
      key: `regression-alert-zero-pass-rate:${suite}`,
      tier: 'page',
      cooldownMs: 12 * 3600_000,
    });
  }

  const candidates = detectRegressionCandidates(current, baseline, threshold);

  console.log(`🔍 Cheap trigger: ${candidates.length} candidate(s) crossed the ${(threshold * 100).toFixed(0)}% threshold\n`);

  const regressions: RegressionAlertEntry[] = [];
  const dismissed: DismissedCandidate[] = [];

  for (const candidate of candidates) {
    const history = buildTaskHistory(candidate.task_id, baseline, baselineRunPaths, current, currentRunPath);
    const verdictResult = await judgeRegressionVerdict({
      suite,
      taskId: candidate.task_id,
      currentScore: candidate.current_score,
      baselineScore: candidate.baseline_score,
      delta: candidate.delta,
      threshold,
      history,
      inferenceFn: opts.inferenceFn,
      level: opts.level,
    });

    if (verdictResult.verdict === null) {
      const marker = `LLM verdict unavailable, using raw delta (${verdictResult.error})`;
      console.error(`⚠️  ${candidate.task_id}: ${marker}`);
      regressions.push({
        task_id: candidate.task_id,
        current_score: candidate.current_score,
        baseline_score: candidate.baseline_score,
        delta: candidate.delta,
        severity: candidate.raw_severity,
        verdict_source: 'raw-fallback',
        reasoning: marker,
      });
      continue;
    }

    if (verdictResult.verdict.regression) {
      const severity = verdictResult.verdict.severity === 'noise' ? 'warning' : verdictResult.verdict.severity;
      console.log(`🔴 ${candidate.task_id}: judge confirmed regression (${severity}) — ${verdictResult.verdict.reasoning}`);
      regressions.push({
        task_id: candidate.task_id,
        current_score: candidate.current_score,
        baseline_score: candidate.baseline_score,
        delta: candidate.delta,
        severity,
        verdict_source: 'llm',
        reasoning: verdictResult.verdict.reasoning,
      });
    } else {
      console.log(`✅ ${candidate.task_id}: judge dismissed as noise — ${verdictResult.verdict.reasoning}`);
      dismissed.push({
        task_id: candidate.task_id,
        current_score: candidate.current_score,
        baseline_score: candidate.baseline_score,
        delta: candidate.delta,
        reasoning: verdictResult.verdict.reasoning,
      });
    }
  }

  const sortedRegressions = sortRegressions(regressions);
  const criticalCount = sortedRegressions.filter(r => r.severity === 'critical').length;
  const warningCount = sortedRegressions.filter(r => r.severity === 'warning').length;

  console.log(`\n🔍 Regression Detection:`);
  console.log(`   Total regressions: ${sortedRegressions.length}`);
  console.log(`   Critical: ${criticalCount}`);
  console.log(`   Warnings: ${warningCount}`);
  console.log(`   Dismissed as noise: ${dismissed.length}\n`);

  if (sortedRegressions.length === 0) {
    console.log(`✅ No regressions detected\n`);
  } else {
    console.log(`❌ Regressions Detected:\n`);
    for (const regression of sortedRegressions) {
      const icon = regression.severity === 'critical' ? '🔴' : '⚠️';
      console.log(`${icon} ${regression.task_id}`);
      console.log(`   Current:  ${regression.current_score.toFixed(3)}`);
      console.log(`   Baseline: ${regression.baseline_score.toFixed(3)}`);
      console.log(`   Delta:    ${regression.delta.toFixed(3)} (${(regression.delta * 100).toFixed(1)}%)`);
      console.log(`   Verdict:  ${regression.verdict_source} — ${regression.reasoning}`);
      console.log();
    }
  }

  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

  const report: AlertReport = {
    suite,
    timestamp: new Date(nowMs).toISOString(),
    tripwires,
    total_regressions: sortedRegressions.length,
    critical_count: criticalCount,
    warning_count: warningCount,
    regressions: sortedRegressions,
    dismissed_as_noise: dismissed,
  };

  // Exit-code decision belongs to the CLI wrapper (main()), not here — see
  // EnsembleValidator.ts's runValidation() for the same convention. Keeping
  // cmdCheck() free of process.exit() calls is what makes it callable
  // in-process from tests without killing the test runner.
  return report;
}

// =============================================================================
// CLI
// =============================================================================

async function main() {
  const args = Bun.argv.slice(2);

  if (args.length === 0 || args.includes('--help')) {
    console.log(`
Regression Alert - Detect score regressions in eval runs

Usage:
  bun RegressionAlert.ts check <suite> [options]

Options:
  --last <N>            Compare to last N runs (default: ${DEFAULT_LAST})
  --threshold <pct>     Regression trigger threshold as decimal (default: ${DEFAULT_THRESHOLD} = 10%)
  --max-age-hours <H>   Suite-failed-to-run tripwire window (default: ${DEFAULT_MAX_AGE_HOURS})

Examples:
  bun RegressionAlert.ts check kaya-pipeline-nightly
  bun RegressionAlert.ts check kaya-pipeline-nightly --last 7 --threshold 0.10
`);
    process.exit(0);
  }

  const command = args[0];

  if (command !== 'check') {
    console.error(`❌ Unknown command: ${command}`);
    console.error(`   Valid commands: check`);
    process.exit(1);
  }

  if (args.length < 2) {
    console.error('❌ check requires a suite name');
    process.exit(1);
  }

  const suite = args[1]!;

  const lastIdx = args.indexOf('--last');
  const last = lastIdx !== -1 && args[lastIdx + 1] ? parseInt(args[lastIdx + 1]!, 10) : DEFAULT_LAST;

  const thresholdIdx = args.indexOf('--threshold');
  const threshold = thresholdIdx !== -1 && args[thresholdIdx + 1] ? parseFloat(args[thresholdIdx + 1]!) : DEFAULT_THRESHOLD;

  const maxAgeIdx = args.indexOf('--max-age-hours');
  const maxAgeHours = maxAgeIdx !== -1 && args[maxAgeIdx + 1] ? parseFloat(args[maxAgeIdx + 1]!) : DEFAULT_MAX_AGE_HOURS;

  try {
    const report = await cmdCheck(suite, last, threshold, { maxAgeHours });
    // Exit-code contract bin/kaya-evals-nightly.ts's STEP 2 depends on: 1
    // when a tripwire fired OR at least one judge/fallback-confirmed
    // regression is present, 0 otherwise (including the benign "not enough
    // history yet" case — see cmdCheck()'s "Found: N run(s)" branch).
    if (report.tripwires.length > 0 || report.total_regressions > 0) {
      process.exit(1);
    }
  } catch (error) {
    console.error(`\n❌ Error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}

if (import.meta.main) {
  main();
}
