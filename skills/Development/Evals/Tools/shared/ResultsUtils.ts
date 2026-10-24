/**
 * ResultsUtils - Shared utilities for reading eval run results
 *
 * Reads the REAL eval results store written by ResultsPersistence.ts since
 * 2026-06-18: append-only JSONL at
 *   MEMORY/VALIDATION/evals/<YYYY-MM-DD>/<suite>-results.jsonl
 * Each suite run appends N per-task lines (SuiteResultEntry shape) followed
 * by one `type: "aggregate"` line (SuiteAggregateEntry shape) that closes
 * the run — see ResultsPersistence.ts's persistSuiteResults().
 *
 * Slice A4 (evals-rebuild) — replaces the prior implementation, which read a
 * phantom layout (`Results/<dir>/results.json`) that no writer has ever
 * produced. That bug meant `RegressionAlert.ts check <suite>` always
 * reported "Found: 0 run(s)" regardless of how much real history existed.
 * See MEMORY/SkillAudits/evals-infra-audit-2026-07-09/results.md, finding #1.
 */

import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';
import { getKayaHome } from '../../../../../lib/core/KayaHome.ts';

// ============================================================================
// Store paths
// ============================================================================

// Resolved LAZILY at use-site — NOT frozen at import. A module-scope
// `const KAYA_HOME = getKayaHome()` would capture the home at import time,
// so a test pinning KAYA_HOME after this module loaded would still read the
// LIVE MEMORY/VALIDATION/evals tree instead of its temp fixture (same
// de-freeze pattern as ResultsPersistence.ts's validationDir()).
function validationEvalsDir(): string {
  return join(getKayaHome(), 'MEMORY', 'VALIDATION', 'evals');
}

// ============================================================================
// Declared outage windows (B2, 2026-10-17)
// ============================================================================
//
// 10-13..10-17 (and 10-10) nightly runs were written BEFORE the infra_skipped
// marker existed: `trial_scores:[0]` with no cause recorded, indistinguishable
// from genuine zeros. Rather than rewriting history, those nights are declared
// in Config/known-outages.json and excluded here, at the one reader every
// baseline/trend/tripwire goes through. Excluded runs stay in the file and are
// listed by findExcludedOutageRuns() so a digest can say "N runs excluded".

/** Thrown for a missing/malformed Config/known-outages.json, so callers can
 *  tell "config broken" from a genuine regression/crash. */
export class KnownOutagesConfigError extends Error {}

export interface KnownOutage {
  from: string;
  to: string;
  suites: string[];
  reason: string;
  evidence: string[];
}

export interface ExcludedOutageRun {
  runId: string;
  timestamp: string;
  suite: string;
  reason: string;
  evidence: string[];
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** Test seam: EVALS_KNOWN_OUTAGES_PATH points the reader at a fixture config. */
function knownOutagesPath(): string {
  return process.env.EVALS_KNOWN_OUTAGES_PATH ?? join(import.meta.dir, '..', '..', 'Config', 'known-outages.json');
}

/** Loads and strictly validates the outage config. Throws (never returns an
 *  empty list) on a missing file or any malformed entry: a silently-empty
 *  config would quietly re-admit the poisoned nights into every baseline. */
export function loadKnownOutages(): KnownOutage[] {
  const path = knownOutagesPath();
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf-8'));
  } catch (err) {
    throw new KnownOutagesConfigError(`[ResultsUtils] known-outages config unreadable at ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const outages = (parsed as { outages?: unknown } | null)?.outages;
  if (!Array.isArray(outages)) {
    throw new KnownOutagesConfigError(`[ResultsUtils] known-outages config ${path}: missing "outages" array`);
  }
  return outages.map((o: unknown, i: number): KnownOutage => {
    const e = o as Partial<Record<keyof KnownOutage, unknown>> | null;
    const bad = (why: string): never => {
      throw new KnownOutagesConfigError(`[ResultsUtils] known-outages config ${path}: outages[${i}] ${why}`);
    };
    if (!e || typeof e !== 'object') return bad('is not an object');
    if (typeof e.from !== 'string' || !DATE_ONLY.test(e.from)) return bad('needs "from" as YYYY-MM-DD');
    if (typeof e.to !== 'string' || !DATE_ONLY.test(e.to) || e.to < e.from) return bad('needs "to" as YYYY-MM-DD >= from');
    if (!Array.isArray(e.suites) || e.suites.length === 0 || !e.suites.every(x => typeof x === 'string')) return bad('needs non-empty "suites" string array');
    if (typeof e.reason !== 'string' || e.reason.length === 0) return bad('needs "reason"');
    if (!Array.isArray(e.evidence) || e.evidence.length === 0 || !e.evidence.every(x => typeof x === 'string')) return bad('needs non-empty "evidence" string array');
    return { from: e.from, to: e.to, suites: e.suites as string[], reason: e.reason, evidence: e.evidence as string[] };
  });
}

/** The declared outage covering this run (UTC date of its timestamp), if any. */
function outageFor(suite: string, timestamp: string, outages: KnownOutage[]): KnownOutage | undefined {
  const day = timestamp.slice(0, 10);
  return outages.find(o => o.suites.includes(suite) && day >= o.from && day <= o.to);
}

const DATE_DIR_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

// Separator between a run's source file path and its identifying timestamp
// in the opaque run id returned by findSuiteRuns(). Not expected to appear
// in a filesystem path.
const RUN_ID_SEPARATOR = '::';

// ============================================================================
// JSONL line shapes (mirrors ResultsPersistence.ts's SuiteResultEntry /
// SuiteAggregateEntry — duplicated here rather than imported so this reader
// doesn't couple to the writer's exact types; the JSONL file IS the
// contract).
// ============================================================================

interface SuiteResultLine {
  timestamp: string;
  suite: string;
  eval_name: string;
  category?: string;
  trial_scores: number[];
  pass_rate: number;
  pass_at_k?: number;
  pass_all_k?: number;
  /** "infra_skipped" = the task produced no behavioral signal (outage); see
   *  ResultsPersistence.ts. Such a line is NOT a score and never enters a
   *  run's results (and so never a baseline, history or delta). */
  status?: string;
}

interface SuiteAggregateLine {
  timestamp: string;
  suite: string;
  type: 'aggregate';
  total_evals: number;
  passed_evals: number;
  aggregate_pass_rate: number;
}

/** One eval's outcome within a run, normalized for regression comparisons. */
export interface EvalRunResult {
  task_id: string;
  suite: string;
  category: string;
  /** Average of trial_scores for this eval within this run. */
  mean_score: number;
  pass_rate: number;
}

interface ParsedRun {
  filePath: string;
  /** Timestamp of the run's closing aggregate line, or of its last per-task
   *  line when no aggregate line closed the run (see "incomplete run"
   *  handling below). Unique per run — used as the run id's suffix. */
  timestamp: string;
  results: EvalRunResult[];
  /** eval_names of infra_skipped marker lines in this run (no score). */
  infraSkipped: string[];
}

// ============================================================================
// JSONL parsing
// ============================================================================

// Dedupe warnings across repeated parses of the same file within one
// process (findSuiteRuns() and each subsequent loadRun() call both parse
// their file from scratch — see loadRun()'s doc comment).
const warnedMalformedLines = new Set<string>();

function warnOnce(key: string, message: string): void {
  if (warnedMalformedLines.has(key)) return;
  warnedMalformedLines.add(key);
  console.warn(message);
}

/**
 * Parse one suite's JSONL file into its constituent runs. A run is a
 * contiguous group of per-task lines closed by a `type: "aggregate"` line.
 *
 * Malformed lines (invalid JSON, or missing the fields this reader depends
 * on) are never silently dropped: each is reported via console.warn naming
 * the exact file and 1-indexed line number, and excluded from the parsed
 * result — the doctrine here is "fail loud, not silent," not "fail fast";
 * one corrupt line must not take down every other real run in the file.
 *
 * Per-task lines left over at end-of-file with no closing aggregate line
 * (e.g. a run that crashed between persistResult() calls and the final
 * persistAggregateResults() call) are surfaced as their own incomplete run
 * — with a loud warning — rather than dropped, so a crashed run doesn't
 * vanish without a trace.
 */
function parseFileRuns(filePath: string): ParsedRun[] {
  const raw = readFileSync(filePath, 'utf-8');
  const rawLines = raw.split('\n');

  const runs: ParsedRun[] = [];
  let buffer: EvalRunResult[] = [];
  let skippedBuffer: string[] = [];
  let lastLineTimestamp: string | null = null;

  rawLines.forEach((rawLine, idx) => {
    const line = rawLine.trim();
    if (!line) return; // blank line (typically the trailing newline)

    const lineNumber = idx + 1;
    const warnKey = `${filePath}:${lineNumber}`;

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      warnOnce(
        warnKey,
        `[ResultsUtils] Skipping malformed JSONL line at ${filePath}:${lineNumber}: ` +
          `${err instanceof Error ? err.message : String(err)}`
      );
      return;
    }

    if (typeof parsed !== 'object' || parsed === null) {
      warnOnce(
        warnKey,
        `[ResultsUtils] Skipping malformed JSONL line at ${filePath}:${lineNumber}: not a JSON object`
      );
      return;
    }

    const obj = parsed as Record<string, unknown>;

    if (typeof obj.timestamp !== 'string' || typeof obj.suite !== 'string') {
      warnOnce(
        warnKey,
        `[ResultsUtils] Skipping malformed JSONL line at ${filePath}:${lineNumber}: ` +
          `missing required "timestamp"/"suite" field`
      );
      return;
    }

    if (obj.type === 'aggregate') {
      const agg = obj as unknown as SuiteAggregateLine;
      runs.push({ filePath, timestamp: agg.timestamp, results: buffer, infraSkipped: skippedBuffer });
      buffer = [];
      skippedBuffer = [];
      lastLineTimestamp = null;
      return;
    }

    // Per-task line.
    if (typeof obj.eval_name !== 'string' || !Array.isArray(obj.trial_scores)) {
      warnOnce(
        warnKey,
        `[ResultsUtils] Skipping malformed JSONL line at ${filePath}:${lineNumber}: ` +
          `missing required "eval_name"/"trial_scores" field`
      );
      return;
    }

    const line_ = obj as unknown as SuiteResultLine;
    // B2: an outage is not a score of 0. The line stays in the file as an
    // audit trail but contributes nothing to any regression/baseline reader.
    if (line_.status === 'infra_skipped') {
      skippedBuffer.push(line_.eval_name);
      return;
    }
    const scores = line_.trial_scores;
    const meanScore = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;

    buffer.push({
      task_id: line_.eval_name,
      suite: line_.suite,
      category: line_.category ?? '',
      mean_score: meanScore,
      pass_rate: line_.pass_rate,
    });
    lastLineTimestamp = line_.timestamp;
  });

  // Trailing per-task lines with no closing aggregate line — surface as an
  // incomplete run rather than silently dropping them.
  if (buffer.length > 0 || skippedBuffer.length > 0) {
    warnOnce(
      `${filePath}:incomplete-run:${lastLineTimestamp ?? 'unknown'}`,
      `[ResultsUtils] ${filePath}: ${buffer.length} result line(s) with no closing ` +
        `"aggregate" line — treating as an incomplete run (likely a crashed write).`
    );
    runs.push({
      filePath,
      timestamp: lastLineTimestamp ?? filePath,
      results: buffer,
      infraSkipped: skippedBuffer,
    });
  }

  return runs;
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Find all runs for a given suite, sorted by timestamp descending (most
 * recent first). Optionally limit to the most recent N runs.
 *
 * Scans every date directory under MEMORY/VALIDATION/evals/ for a
 * `<suiteName>-results.jsonl` file; a single date's file may itself contain
 * multiple runs (e.g. a manual re-run on top of the nightly cron), each
 * counted separately. Returns an empty array if the store directory doesn't
 * exist yet, or no file for this suite exists in any date directory — not
 * an error, since "no history yet" is a legitimate state (e.g. a brand new
 * suite).
 */
export function findSuiteRuns(suiteName: string, limit?: number): string[] {
  const outages = loadKnownOutages();
  const kept = collectRuns(suiteName).filter(r => !outageFor(suiteName, r.timestamp, outages));
  const limited = limit !== undefined ? kept.slice(0, limit) : kept;
  return limited.map(r => `${r.filePath}${RUN_ID_SEPARATOR}${r.timestamp}`);
}

/**
 * Runs of this suite excluded by a declared outage window, newest first.
 * Callers (digest, alert) surface this so exclusion is never silent.
 */
export function findExcludedOutageRuns(suiteName: string): ExcludedOutageRun[] {
  const outages = loadKnownOutages();
  const excluded: ExcludedOutageRun[] = [];
  for (const r of collectRuns(suiteName)) {
    const o = outageFor(suiteName, r.timestamp, outages);
    if (o) {
      excluded.push({
        runId: `${r.filePath}${RUN_ID_SEPARATOR}${r.timestamp}`,
        timestamp: r.timestamp,
        suite: suiteName,
        reason: o.reason,
        evidence: o.evidence,
      });
    }
  }
  return excluded;
}

/** Every run of the suite, newest first, before outage filtering. */
function collectRuns(suiteName: string): ParsedRun[] {
  const root = validationEvalsDir();
  if (!existsSync(root)) return [];

  const dateDirs = readdirSync(root, { withFileTypes: true })
    .filter(e => e.isDirectory() && DATE_DIR_PATTERN.test(e.name))
    .map(e => e.name);

  const allRuns: ParsedRun[] = [];
  for (const date of dateDirs) {
    const filePath = join(root, date, `${suiteName}-results.jsonl`);
    if (!existsSync(filePath)) continue;
    allRuns.push(...parseFileRuns(filePath));
  }

  allRuns.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  return allRuns;
}

/**
 * Load a run's per-task results given an id returned by findSuiteRuns().
 *
 * Re-parses the run's source file from scratch (these JSONL files are at
 * most tens of KB — a handful of runs a day) rather than caching parsed
 * state between findSuiteRuns() and loadRun() calls, keeping both functions
 * simple, independent, and correct even if the file changes between calls.
 */
export function loadRun(runId: string): EvalRunResult[] {
  const sepIdx = runId.lastIndexOf(RUN_ID_SEPARATOR);
  if (sepIdx === -1) {
    throw new Error(
      `loadRun: malformed run id "${runId}" (expected "<filePath>${RUN_ID_SEPARATOR}<timestamp>")`
    );
  }

  const filePath = runId.slice(0, sepIdx);
  const timestamp = runId.slice(sepIdx + RUN_ID_SEPARATOR.length);

  if (!existsSync(filePath)) {
    throw new Error(`loadRun: results file not found: ${filePath}`);
  }

  const runs = parseFileRuns(filePath);
  const match = runs.find(r => r.timestamp === timestamp);
  if (!match) {
    throw new Error(`loadRun: no run with timestamp ${timestamp} found in ${filePath}`);
  }

  return match.results;
}

/**
 * eval_names of the tasks recorded as infra_skipped (no score) in a run, given
 * an id from findSuiteRuns(). Lets a caller say "run had N tasks, all
 * infra-skipped" when loadRun() comes back empty.
 */
export function loadRunInfraSkipped(runId: string): string[] {
  const sepIdx = runId.lastIndexOf(RUN_ID_SEPARATOR);
  if (sepIdx === -1) {
    throw new Error(`loadRunInfraSkipped: malformed run id "${runId}"`);
  }
  const filePath = runId.slice(0, sepIdx);
  const timestamp = runId.slice(sepIdx + RUN_ID_SEPARATOR.length);
  const match = parseFileRuns(filePath).find(r => r.timestamp === timestamp);
  if (!match) {
    throw new Error(`loadRunInfraSkipped: no run with timestamp ${timestamp} found in ${filePath}`);
  }
  return match.infraSkipped;
}
