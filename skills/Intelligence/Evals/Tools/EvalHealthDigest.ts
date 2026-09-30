#!/usr/bin/env bun
/**
 * EvalHealthDigest.ts — weekly LLM-written eval-health digest (evals-rebuild
 * slice B5).
 *
 * Usage:
 *   bun EvalHealthDigest.ts [--days 7]
 *
 * WHY: MEMORY/SkillAudits/evals-infra-audit-2026-07-09/nightly.md's REDESIGN
 * OPPORTUNITIES #4 — "Surface the existing MEMORY/VALIDATION/evals/ history
 * into a weekly AlertGate digest (pass-rate trend per task) — the most
 * valuable untapped asset in this whole system; real data has existed since
 * 06-18 and nobody has ever looked at it in aggregate." This tool is that
 * surface. It also absorbs the retired comparison-report's job (trend
 * visibility) — the durable, dated file it writes (see writeDigestFile()) is
 * the only browsable trend artifact this store has, per results.md finding 4
 * ("the canonical JSONL store has no query/browse tool at all").
 *
 * DATA READ (per B5 spec):
 *   1. Every date directory under MEMORY/VALIDATION/evals/ inside the last
 *      `--days` (default 7) days — every suite's *-results.jsonl found
 *      there, via the A4 ResultsUtils API (findSuiteRuns/loadRun), scoped to
 *      runs whose timestamp falls in the window.
 *   2. MEMORY/VALIDATION/evals/last-suite-run/*.json — ONE most-recent
 *      structured snapshot per suite (wall_ms, mean_score, started_at/
 *      finished_at). This is NOT a history — EvalExecutor's `suite` command
 *      overwrites it every run — so it is the only source for wall-time/cost
 *      context, and only ever a single data point, never a trend. The digest
 *      prompt says this explicitly rather than letting the judge invent one.
 *
 * ARCHITECTURE (per doctrine feedback_determinism_earns_its_place.md):
 * everything BEFORE the inference call — enumerating suites, building
 * per-task chronological score series, computing deltas/streaks/min/max — is
 * plain arithmetic (category A), done in code. What those numbers MEAN
 * (which trends are worth Jm's attention, which anomalies matter, how to
 * write it up) is the LLM's job — never guessed at deterministically here.
 * `expectJson:true` + zod on the response (house B1 protocol), fail loud
 * (throws) on a missing store or a bad/failed judge response — never a
 * silently empty or fabricated digest.
 *
 * DELIVERY: AlertGate tier=digest (see lib/core/AlertGate.ts's module doc —
 * "digest → appended to MEMORY/NOTIFICATIONS/digest-spool.jsonl, delivered
 * once daily by SystemHealthDigest"), same call shape as other tools' direct
 * `sendAlert()` usage (e.g. skills/Automation/AutoInfoManager/Tools/
 * FreshnessGuard.ts).
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { z } from 'zod';
import { findSuiteRuns, loadRun } from './shared/ResultsUtils.ts';
import { inference, extractJson, type InferenceLevel, type InferenceResult } from '../../../../lib/core/Inference.ts';
import { getKayaHome } from '../../../../lib/core/KayaHome.ts';
import { sendAlert } from '../../../../lib/core/AlertGate.ts';
import { recordFailure } from '../../../../lib/core/FailureLog.ts';

// =============================================================================
// CONSTANTS
// =============================================================================

const DEFAULT_WINDOW_DAYS = 7;
const DIGEST_LEVEL: InferenceLevel = 'standard';
/** Narrative-only flagging threshold for the prompt's "notable_deltas"
 *  section — independent of RegressionAlert.ts's own trigger (these are two
 *  separately-invocable CLI tools; sharing the literal constant isn't worth
 *  coupling their modules together, per this file's own precedent of
 *  duplicating small store-contract constants rather than importing them). */
const NOTABLE_DELTA_THRESHOLD = 0.10;
/** Trailing consecutive 0-pass-rate runs, within the window, before a task
 *  is flagged to the judge as a candidate "silent-red streak" — the failure
 *  class that let kaya_router_disposition_golden run red for ~10 nights
 *  (2026-06-28 through 2026-07-07) with zero alerting. */
const ZERO_PASS_STREAK_FLOOR = 2;

const DATE_DIR_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const RESULTS_SUFFIX = '-results.jsonl';

// Duplicated from shared/ResultsUtils.ts's opaque run-id contract
// ("<filePath>::<timestamp>", documented on findSuiteRuns/loadRun) — not
// exported there, so re-declared here rather than reaching into that
// module's internals. Same convention RegressionAlert.ts uses.
const RUN_ID_SEPARATOR = '::';
function extractRunTimestamp(runId: string): string {
  const idx = runId.lastIndexOf(RUN_ID_SEPARATOR);
  return idx === -1 ? runId : runId.slice(idx + RUN_ID_SEPARATOR.length);
}

// Resolved lazily at use-site (never frozen at import) — same de-freeze
// pattern as ResultsUtils.ts's validationEvalsDir() / RegressionAlert.ts's
// evalsStoreRoot(), so a test pinning KAYA_HOME after this module loads
// still targets its sandbox.
function evalsStoreRoot(): string {
  return join(getKayaHome(), 'MEMORY', 'VALIDATION', 'evals');
}
function lastSuiteRunDir(): string {
  return join(evalsStoreRoot(), 'last-suite-run');
}
function digestsDir(): string {
  return join(evalsStoreRoot(), 'digests');
}

// =============================================================================
// TYPES — deterministic aggregation
// =============================================================================

export interface TaskSeriesPoint {
  timestamp: string;
  mean_score: number;
  pass_rate: number;
}

export interface TaskTrend {
  suite: string;
  task_id: string;
  n_points: number;
  first_score: number;
  last_score: number;
  delta: number;
  min_score: number;
  max_score: number;
  trailing_zero_pass_streak: number;
}

export interface SuiteWindowSummary {
  suite: string;
  runs_in_window: number;
  tasks: TaskTrend[];
}

// last-suite-run/<suite>.json shape — duplicated locally from
// EvalExecutor.ts's SuiteSummaryFile/SuiteSummaryTask (same convention
// bin/kaya-evals-nightly.ts already established: the CONSUMER validates
// what crossed the machine boundary at runtime via its own zod schema,
// rather than trusting the PRODUCER's compile-time TS types).
const SuiteSummaryTaskSchema = z.object({
  task_id: z.string(),
  status: z.enum(['passed', 'failed', 'infra_skipped', 'error', 'not_found']),
  mean_score: z.number(),
  pass: z.boolean(),
  pass_rate: z.number(),
  infra_failures: z.number(),
  n_trials: z.number(),
  error: z.string().optional(),
});
const SuiteSummaryFileSchema = z.object({
  suite: z.string(),
  tasks: z.array(SuiteSummaryTaskSchema),
  summary: z.object({
    total: z.number(),
    scored: z.number(),
    passed: z.number(),
    failed: z.number(),
    infra_skipped: z.number(),
    mean_score: z.number(),
    started_at: z.string(),
    finished_at: z.string(),
    wall_ms: z.number(),
  }),
});
export type SuiteSummaryFile = z.infer<typeof SuiteSummaryFileSchema>;

export interface LastSuiteRunEntry {
  suite: string;
  data: SuiteSummaryFile | null;
  /** Present only when data is null — always non-empty (fail-loud-per-item,
   *  not fatal to the rest of the digest; mirrors ResultsUtils.ts's
   *  per-line malformed-JSONL handling). */
  parseError?: string;
}

// =============================================================================
// PURE AGGREGATION
// =============================================================================

export function computeZeroPassStreak(pointsAsc: TaskSeriesPoint[]): number {
  let streak = 0;
  for (let i = pointsAsc.length - 1; i >= 0; i--) {
    if (pointsAsc[i]!.pass_rate === 0) streak++;
    else break;
  }
  return streak;
}

export function computeTaskTrend(suite: string, taskId: string, pointsAsc: TaskSeriesPoint[]): TaskTrend {
  if (pointsAsc.length === 0) {
    return { suite, task_id: taskId, n_points: 0, first_score: 0, last_score: 0, delta: 0, min_score: 0, max_score: 0, trailing_zero_pass_streak: 0 };
  }
  const scores = pointsAsc.map(p => p.mean_score);
  const first = scores[0]!;
  const last = scores[scores.length - 1]!;
  return {
    suite,
    task_id: taskId,
    n_points: pointsAsc.length,
    first_score: first,
    last_score: last,
    delta: last - first,
    min_score: Math.min(...scores),
    max_score: Math.max(...scores),
    trailing_zero_pass_streak: computeZeroPassStreak(pointsAsc),
  };
}

/** Lists YYYY-MM-DD date directories under `root` whose name falls within
 *  the last `windowDays` days (lexicographic date-string comparison — safe
 *  since YYYY-MM-DD sorts identically to chronological order). Empty array
 *  when `root` doesn't exist — callers distinguish "store missing" via their
 *  own existsSync(root) check upstream (see generateDigest()'s fail-loud
 *  guard), not via this function's return value. */
export function listDateDirsInWindow(root: string, windowDays: number, nowMs: number): string[] {
  if (!existsSync(root)) return [];
  const cutoffStr = new Date(nowMs - windowDays * 24 * 3600_000).toISOString().slice(0, 10);
  return readdirSync(root, { withFileTypes: true })
    .filter(e => e.isDirectory() && DATE_DIR_PATTERN.test(e.name) && e.name >= cutoffStr)
    .map(e => e.name)
    .sort();
}

/** Distinct suite names discovered from `<date>/<suite>-results.jsonl`
 *  filenames across the given date directories. This is the one piece
 *  ResultsUtils.ts has no export for (it only answers "give me THIS suite's
 *  runs", never "what suites exist") — a plain filename-suffix scan, not a
 *  business-logic duplication of anything ResultsUtils already does. */
export function listSuiteNamesInDateDirs(root: string, dateDirs: string[]): string[] {
  const names = new Set<string>();
  for (const date of dateDirs) {
    const dir = join(root, date);
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir)) {
      if (entry.endsWith(RESULTS_SUFFIX)) {
        names.add(entry.slice(0, -RESULTS_SUFFIX.length));
      }
    }
  }
  return [...names].sort();
}

/** Builds one suite's window summary: every run whose timestamp falls at or
 *  after `cutoffIso`, reusing findSuiteRuns()/loadRun() (the exported A4
 *  API) rather than re-parsing JSONL directly — this is the same store,
 *  read the same way RegressionAlert.ts reads it. */
export function buildSuiteWindowSummary(suite: string, cutoffIso: string): SuiteWindowSummary {
  const allRunIds = findSuiteRuns(suite); // desc (most-recent-first)
  const inWindow = allRunIds.filter(id => extractRunTimestamp(id) >= cutoffIso);
  const asc = [...inWindow].reverse(); // chronological, oldest first

  const perTask = new Map<string, TaskSeriesPoint[]>();
  for (const runId of asc) {
    const ts = extractRunTimestamp(runId);
    const results = loadRun(runId);
    for (const r of results) {
      const points = perTask.get(r.task_id) ?? [];
      points.push({ timestamp: ts, mean_score: r.mean_score, pass_rate: r.pass_rate });
      perTask.set(r.task_id, points);
    }
  }

  const tasks = [...perTask.entries()]
    .map(([taskId, points]) => computeTaskTrend(suite, taskId, points))
    .sort((a, b) => a.task_id.localeCompare(b.task_id));

  return { suite, runs_in_window: asc.length, tasks };
}

/** Reads every last-suite-run/*.json snapshot present, regardless of
 *  whether that suite had activity in the window — a suite that stopped
 *  running entirely is itself digest-worthy, and its last snapshot may
 *  predate the window (still useful context: "last known state"). A
 *  corrupt/invalid file is reported loudly (console.warn, naming the exact
 *  path) and excluded from that suite's snapshot data, but never aborts the
 *  read for the other suites — mirrors ResultsUtils.ts's per-line
 *  malformed-JSONL philosophy applied per-file here. */
export function readLastSuiteRunSnapshots(): LastSuiteRunEntry[] {
  const dir = lastSuiteRunDir();
  if (!existsSync(dir)) return [];

  const entries: LastSuiteRunEntry[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.json')) continue;
    const suite = file.slice(0, -'.json'.length);
    const path = join(dir, file);
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf-8'));
      const validated = SuiteSummaryFileSchema.safeParse(parsed);
      if (!validated.success) {
        const msg = `schema validation failed: ${validated.error.issues.map(i => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`;
        console.warn(`[EvalHealthDigest] Skipping ${path}: ${msg}`);
        entries.push({ suite, data: null, parseError: msg });
        continue;
      }
      entries.push({ suite, data: validated.data });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[EvalHealthDigest] Skipping ${path}: ${msg}`);
      entries.push({ suite, data: null, parseError: msg });
    }
  }
  return entries.sort((a, b) => a.suite.localeCompare(b.suite));
}

// =============================================================================
// LLM DIGEST
// =============================================================================

const DigestResponseSchema = z.object({
  headline: z.string().min(1),
  digest: z.string().min(1),
});
export type DigestResponse = z.infer<typeof DigestResponseSchema>;

/** Same DI shape convention as RegressionAlert.ts's RegressionInferenceFn /
 *  JudgeProtocol's InferenceFn — a plain function reference tests can
 *  override; defaults to the real `inference`. */
export type DigestInferenceFn = (opts: Parameters<typeof inference>[0]) => Promise<InferenceResult>;

const DIGEST_SYSTEM_PROMPT = `You are Kaya's weekly eval-health analyst.

You are given structured data from Kaya's eval results store: per-suite,
per-task score/pass-rate series over a recent window, pre-flagged "notable
deltas" (candidates whose score dropped meaningfully within the window) and
"silent red streaks" (tasks whose pass_rate has been 0 for 2+ consecutive
runs), plus the single most-recent structured run snapshot per suite
(wall-clock time, mean score, pass/fail counts).

Write a digest with these sections:
1. **Trends** — which tasks/suites are improving, flat, or declining over
   the window. Use judgment, not just the pre-flagged lists — a task that's
   noisy but flat overall is not a trend.
2. **Regressions** — for each pre-flagged notable delta, say whether you
   think it's worth Jm's attention or likely noise, and why (cite the
   specific score pattern you see, not just the number).
3. **Silent-red streaks** — call out every pre-flagged streak explicitly.
   This is exactly the failure class that let kaya_router_disposition_golden
   run red for ~10 nights (2026-06-28 through 2026-07-07, 12 invalid golden
   fixture entries) with zero alerting anywhere in the pipeline — see
   MEMORY/SkillAudits/evals-infra-audit-2026-07-09/nightly.md. Do not soften
   or omit these.
4. **Anomalies** — anything structurally odd: a suite with zero runs in the
   window (stopped running?), a task flipping between 0 and full score run
   to run, an empty window, a corrupted/unreadable last-suite-run snapshot.
5. **Cost / wall-time** — the data gives you only ONE data point per suite
   (the latest last-suite-run snapshot's wall_ms/mean_score/started_at/
   finished_at) — there is NO historical wall-time series in this store.
   Report the single latest figure per suite; explicitly say a trend isn't
   available yet rather than inventing one from one data point.

If the window has no data at all for a suite (or any suite), say so plainly
— never invent findings to fill a section.

Respond with ONLY a single JSON object (no markdown fences, no prose outside
the JSON):
{
  "headline": "<one sentence, under 140 characters, suitable for a chat notification>",
  "digest": "<the full markdown-formatted digest body, with the 5 sections above>"
}`;

function buildDigestUserPrompt(opts: {
  windowDays: number;
  windowStart: string;
  windowEnd: string;
  suites: SuiteWindowSummary[];
  lastSuiteRuns: LastSuiteRunEntry[];
}): string {
  const notableDeltas = opts.suites.flatMap(s =>
    s.tasks
      .filter(t => t.delta <= -NOTABLE_DELTA_THRESHOLD)
      .map(t => ({ suite: s.suite, task_id: t.task_id, first_score: t.first_score, last_score: t.last_score, delta: t.delta }))
  );
  const silentRedStreaks = opts.suites.flatMap(s =>
    s.tasks
      .filter(t => t.trailing_zero_pass_streak >= ZERO_PASS_STREAK_FLOOR)
      .map(t => ({ suite: s.suite, task_id: t.task_id, trailing_zero_pass_streak: t.trailing_zero_pass_streak, n_points: t.n_points }))
  );

  return JSON.stringify(
    {
      window_days: opts.windowDays,
      window_start: opts.windowStart,
      window_end: opts.windowEnd,
      suites: opts.suites,
      notable_deltas: notableDeltas,
      silent_red_streaks: silentRedStreaks,
      last_suite_run_snapshots: opts.lastSuiteRuns.map(e => ({
        suite: e.suite,
        ok: e.data !== null,
        parse_error: e.parseError,
        summary: e.data?.summary ?? null,
      })),
    },
    null,
    2
  );
}

export interface GenerateDigestOptions {
  windowDays?: number;
  inferenceFn?: DigestInferenceFn;
  level?: InferenceLevel;
  /** Injectable clock for tests. */
  nowMs?: number;
}

export interface DigestResult {
  headline: string;
  digest: string;
  windowStart: string;
  windowEnd: string;
  suitesCovered: string[];
  raw_output: string;
}

/**
 * Build the deterministic data package and call the judge. FAIL LOUD
 * (throws) when the store doesn't exist at all, or the judge call/response
 * fails for any reason — this function never returns a fabricated or
 * silently-empty digest. Callers (main() below) decide how to surface that
 * failure (recordFailure + a page-tier sendAlert, see main()).
 */
export async function generateDigest(opts: GenerateDigestOptions = {}): Promise<DigestResult> {
  const windowDays = opts.windowDays ?? DEFAULT_WINDOW_DAYS;
  const nowMs = opts.nowMs ?? Date.now();
  const root = evalsStoreRoot();

  if (!existsSync(root)) {
    throw new Error(
      `EvalHealthDigest: eval results store (${root}) does not exist at all — ` +
        `the nightly pipeline has apparently never persisted a single suite run ` +
        `(see MEMORY/SkillAudits/evals-infra-audit-2026-07-09/nightly.md finding 1)`
    );
  }

  const windowEnd = new Date(nowMs).toISOString();
  const windowStart = new Date(nowMs - windowDays * 24 * 3600_000).toISOString();

  const dateDirs = listDateDirsInWindow(root, windowDays, nowMs);
  const suiteNames = listSuiteNamesInDateDirs(root, dateDirs);
  const suites = suiteNames.map(name => buildSuiteWindowSummary(name, windowStart));
  const lastSuiteRuns = readLastSuiteRunSnapshots();

  const userPrompt = buildDigestUserPrompt({ windowDays, windowStart, windowEnd, suites, lastSuiteRuns });

  const infer = opts.inferenceFn ?? inference;
  const result = await infer({
    systemPrompt: DIGEST_SYSTEM_PROMPT,
    userPrompt,
    level: opts.level ?? DIGEST_LEVEL,
    expectJson: true,
    retries: 1,
    retryDelayMs: 4000,
  });

  if (!result.success) {
    throw new Error(`EvalHealthDigest: inference failed: ${result.error ?? 'unknown error'}`);
  }

  const parsedRaw = result.parsed ?? extractJson(result.output);
  if (parsedRaw === undefined) {
    throw new Error('EvalHealthDigest: judge response was not valid JSON (expected {headline, digest})');
  }

  const validated = DigestResponseSchema.safeParse(parsedRaw);
  if (!validated.success) {
    const issues = validated.error.issues.map(i => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    throw new Error(`EvalHealthDigest: judge response failed schema validation: ${issues}`);
  }

  return {
    headline: validated.data.headline,
    digest: validated.data.digest,
    windowStart,
    windowEnd,
    suitesCovered: suiteNames,
    raw_output: result.output,
  };
}

// =============================================================================
// CLI
// =============================================================================

/** Persists a dated copy under MEMORY/VALIDATION/evals/digests/ — the only
 *  browsable trend artifact this store has (see module docblock). Returns
 *  the path written. */
export function writeDigestFile(result: DigestResult, nowMs: number): string {
  const dateStr = new Date(nowMs).toISOString().slice(0, 10);
  const dir = digestsDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const filePath = join(dir, `${dateStr}.md`);
  writeFileSync(filePath, `# Eval Health Digest — ${dateStr}\n\n${result.digest}\n`, 'utf-8');
  return filePath;
}

async function main() {
  const args = Bun.argv.slice(2);
  const daysIdx = args.indexOf('--days');
  const windowDays = daysIdx !== -1 && args[daysIdx + 1] ? parseInt(args[daysIdx + 1]!, 10) : DEFAULT_WINDOW_DAYS;

  try {
    const result = await generateDigest({ windowDays });

    console.log(`\n=== Eval Health Digest (${result.windowStart} → ${result.windowEnd}) ===`);
    console.log(`Suites covered: ${result.suitesCovered.length > 0 ? result.suitesCovered.join(', ') : '(none)'}\n`);
    console.log(`Headline: ${result.headline}\n`);
    console.log(result.digest);
    console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

    const filePath = writeDigestFile(result, Date.now());
    console.log(`[EvalHealthDigest] wrote ${filePath}`);

    const alertResult = await sendAlert(`${result.headline}\n\n${result.digest}`, {
      key: 'eval-health-weekly-digest',
      tier: 'digest',
    });
    console.log(`[EvalHealthDigest] AlertGate result: ${alertResult}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`\n❌ ${message}\n`);
    recordFailure({ source: 'EvalHealthDigest', error: err, context: { step: 'main' } });
    // Awaited (T2-01): process.exit(1) immediately follows — without the
    // await, the delivery attempt would be truncated before it could even
    // start, on the highest-urgency (page-tier crash) alert in this file.
    await sendAlert(`Eval health digest failed: ${message}`, { key: 'eval-health-digest-crash', tier: 'page' });
    process.exit(1);
  }
}

if (import.meta.main) {
  main();
}
