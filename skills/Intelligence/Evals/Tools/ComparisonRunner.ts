#!/usr/bin/env bun

/**
 * ComparisonRunner.ts
 *
 * Orchestrates running all 13 Kaya eval suites against two git refs,
 * computes deltas, and generates a comparison report (JSON + Markdown).
 *
 * Usage:
 *   bun ComparisonRunner.ts --baseline pre-streamline --current HEAD --trials 3 --parallel 3
 *   bun ComparisonRunner.ts --baseline pre-streamline --current HEAD --suite kaya-regression --trials 1
 */

import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { parseArgs } from 'util';
import { runSuite, resolveContextAtRef } from './EvalExecutor.ts';
import type { ResolvedContext } from './EvalExecutor.ts';
import { listSuites } from './SuiteManager.ts';
import type { EvalRun, EvalSuite } from '../Types/index.ts';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const EVALS_DIR = join(import.meta.dir, '..');
const COMPARISONS_DIR = join(EVALS_DIR, 'Results', 'comparisons');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ComparisonConfig {
  baselineRef: string;
  currentRef: string;
  suites?: string[];
  trials?: number;
  timeout?: number;
  parallel?: number;
}

export interface VersionResults {
  ref: string;
  contextSource: string;
  contextCharCount: number;
  suites: Record<string, {
    results: EvalRun[];
    summary: { passed: number; failed: number; total: number; meanScore: number };
  }>;
  startedAt: string;
  completedAt: string;
  totalDurationMs: number;
}

export interface TaskDelta {
  taskId: string;
  suite: string;
  baselineScore: number;
  currentScore: number;
  delta: number;
  status: 'improved' | 'regressed' | 'stable';
}

export interface SuiteDelta {
  suite: string;
  baselineScore: number;
  currentScore: number;
  delta: number;
  status: 'improved' | 'regressed' | 'stable';
  taskDeltas: TaskDelta[];
}

export interface ComparisonReport {
  id: string;
  baseline: VersionResults;
  current: VersionResults;
  deltas: SuiteDelta[];
  overallDelta: {
    baselineMeanScore: number;
    currentMeanScore: number;
    delta: number;
    totalRegressions: number;
    totalImprovements: number;
    totalStable: number;
  };
  generatedAt: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function generateId(): string {
  return `cmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function timestamp(): string {
  return new Date().toISOString();
}

function classifyDelta(delta: number): 'improved' | 'regressed' | 'stable' {
  if (delta > 0.05) return 'improved';
  if (delta < -0.05) return 'regressed';
  return 'stable';
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/** Split an array into chunks of a given size. */
function chunk<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

// ---------------------------------------------------------------------------
// Core Functions
// ---------------------------------------------------------------------------

/**
 * Runs a list of suites with parallel chunking, collecting results into
 * a VersionResults object.
 */
async function runAllSuites(
  suiteNames: string[],
  options: {
    trials?: number;
    timeout?: number;
    systemContext: string;
    ref: string;
    parallel?: number;
    contextSource: string;
    contextCharCount: number;
  },
): Promise<VersionResults> {
  const parallelLimit = options.parallel ?? 3;
  const startedAt = timestamp();
  const startMs = Date.now();

  const suiteResults: VersionResults['suites'] = {};
  const chunks = chunk(suiteNames, parallelLimit);

  for (const batch of chunks) {
    const batchResults = await Promise.all(
      batch.map(async (suiteName) => {
        console.log(`  [${options.ref}] Running suite: ${suiteName}`);
        const result = await runSuite(suiteName, {
          trials: options.trials,
          timeout: options.timeout,
          systemContext: options.systemContext,
        });
        console.log(
          `  [${options.ref}] ${suiteName}: ${result.summary.passed}/${result.summary.total} passed (mean: ${result.summary.meanScore.toFixed(3)})`,
        );
        return { suiteName, result };
      }),
    );

    for (const { suiteName, result } of batchResults) {
      suiteResults[suiteName] = result;
    }
  }

  const completedAt = timestamp();
  const totalDurationMs = Date.now() - startMs;

  return {
    ref: options.ref,
    contextSource: options.contextSource,
    contextCharCount: options.contextCharCount,
    suites: suiteResults,
    startedAt,
    completedAt,
    totalDurationMs,
  };
}

/**
 * Computes per-suite and per-task deltas between baseline and current results.
 */
function computeDeltas(
  baseline: VersionResults,
  current: VersionResults,
  suiteNames: string[],
): { deltas: SuiteDelta[]; overallDelta: ComparisonReport['overallDelta'] } {
  const deltas: SuiteDelta[] = [];

  for (const suite of suiteNames) {
    const baselineSuite = baseline.suites[suite];
    const currentSuite = current.suites[suite];

    const baselineScore = baselineSuite?.summary.meanScore ?? 0;
    const currentScore = currentSuite?.summary.meanScore ?? 0;
    const suiteDelta = currentScore - baselineScore;

    // Build a map of task-level scores for each version
    const baselineTaskScores = new Map<string, number>();
    const currentTaskScores = new Map<string, number>();

    if (baselineSuite) {
      for (const run of baselineSuite.results) {
        baselineTaskScores.set(run.task_id, run.mean_score);
      }
    }

    if (currentSuite) {
      for (const run of currentSuite.results) {
        currentTaskScores.set(run.task_id, run.mean_score);
      }
    }

    // Union of all task IDs across both versions
    const allTaskIds = new Set([
      ...baselineTaskScores.keys(),
      ...currentTaskScores.keys(),
    ]);

    const taskDeltas: TaskDelta[] = [];
    for (const taskId of allTaskIds) {
      const bScore = baselineTaskScores.get(taskId) ?? 0;
      const cScore = currentTaskScores.get(taskId) ?? 0;
      const d = cScore - bScore;

      taskDeltas.push({
        taskId,
        suite,
        baselineScore: bScore,
        currentScore: cScore,
        delta: d,
        status: classifyDelta(d),
      });
    }

    // Sort task deltas: regressions first (most negative), then improvements
    taskDeltas.sort((a, b) => a.delta - b.delta);

    deltas.push({
      suite,
      baselineScore,
      currentScore,
      delta: suiteDelta,
      status: classifyDelta(suiteDelta),
      taskDeltas,
    });
  }

  // Compute overall aggregates
  const baselineScores = deltas.map((d) => d.baselineScore);
  const currentScores = deltas.map((d) => d.currentScore);

  const allTaskDeltas = deltas.flatMap((d) => d.taskDeltas);
  const totalRegressions = allTaskDeltas.filter((t) => t.status === 'regressed').length;
  const totalImprovements = allTaskDeltas.filter((t) => t.status === 'improved').length;
  const totalStable = allTaskDeltas.filter((t) => t.status === 'stable').length;

  const overallBaseline = mean(baselineScores);
  const overallCurrent = mean(currentScores);

  return {
    deltas,
    overallDelta: {
      baselineMeanScore: overallBaseline,
      currentMeanScore: overallCurrent,
      delta: overallCurrent - overallBaseline,
      totalRegressions,
      totalImprovements,
      totalStable,
    },
  };
}

/**
 * Generates a Markdown-formatted comparison report.
 */
export function formatComparisonReport(report: ComparisonReport): string {
  const lines: string[] = [];

  // Header
  lines.push(`# Eval Comparison Report`);
  lines.push('');
  lines.push(`**Generated:** ${report.generatedAt}`);
  lines.push(`**Report ID:** ${report.id}`);
  lines.push('');
  lines.push(`## Refs`);
  lines.push('');
  lines.push(`| | Ref | Context Source | Context Chars | Duration |`);
  lines.push(`|---|---|---|---|---|`);
  lines.push(
    `| Baseline | \`${report.baseline.ref}\` | ${report.baseline.contextSource} | ${report.baseline.contextCharCount.toLocaleString()} | ${(report.baseline.totalDurationMs / 1000).toFixed(1)}s |`,
  );
  lines.push(
    `| Current | \`${report.current.ref}\` | ${report.current.contextSource} | ${report.current.contextCharCount.toLocaleString()} | ${(report.current.totalDurationMs / 1000).toFixed(1)}s |`,
  );
  lines.push('');

  // Overall summary
  const od = report.overallDelta;
  const deltaSign = od.delta >= 0 ? '+' : '';
  const deltaEmoji = od.delta > 0.05 ? '**IMPROVED**' : od.delta < -0.05 ? '**REGRESSED**' : 'Stable';

  lines.push(`## Overall Summary`);
  lines.push('');
  lines.push(`| Metric | Value |`);
  lines.push(`|---|---|`);
  lines.push(`| Baseline Mean Score | ${od.baselineMeanScore.toFixed(3)} |`);
  lines.push(`| Current Mean Score | ${od.currentMeanScore.toFixed(3)} |`);
  lines.push(`| Delta | ${deltaSign}${od.delta.toFixed(3)} (${deltaEmoji}) |`);
  lines.push(`| Regressions | ${od.totalRegressions} tasks |`);
  lines.push(`| Improvements | ${od.totalImprovements} tasks |`);
  lines.push(`| Stable | ${od.totalStable} tasks |`);
  lines.push('');

  // Suite-by-suite comparison
  lines.push(`## Suite Comparison`);
  lines.push('');
  lines.push(`| Suite | Baseline | Current | Delta | Status |`);
  lines.push(`|---|---|---|---|---|`);

  for (const sd of report.deltas) {
    const sdSign = sd.delta >= 0 ? '+' : '';
    const statusIcon = sd.status === 'improved' ? 'UP' : sd.status === 'regressed' ? 'DOWN' : '--';
    lines.push(
      `| ${sd.suite} | ${sd.baselineScore.toFixed(3)} | ${sd.currentScore.toFixed(3)} | ${sdSign}${sd.delta.toFixed(3)} | ${statusIcon} |`,
    );
  }
  lines.push('');

  // Regressions section
  const regressions = report.deltas
    .flatMap((sd) => sd.taskDeltas)
    .filter((td) => td.status === 'regressed')
    .sort((a, b) => a.delta - b.delta);

  if (regressions.length > 0) {
    lines.push(`## Regressions (${regressions.length} tasks)`);
    lines.push('');
    lines.push(`| Task | Suite | Baseline | Current | Delta |`);
    lines.push(`|---|---|---|---|---|`);
    for (const td of regressions) {
      lines.push(
        `| ${td.taskId} | ${td.suite} | ${td.baselineScore.toFixed(3)} | ${td.currentScore.toFixed(3)} | ${td.delta.toFixed(3)} |`,
      );
    }
    lines.push('');
  } else {
    lines.push(`## Regressions`);
    lines.push('');
    lines.push(`None detected.`);
    lines.push('');
  }

  // Improvements section
  const improvements = report.deltas
    .flatMap((sd) => sd.taskDeltas)
    .filter((td) => td.status === 'improved')
    .sort((a, b) => b.delta - a.delta);

  if (improvements.length > 0) {
    lines.push(`## Improvements (${improvements.length} tasks)`);
    lines.push('');
    lines.push(`| Task | Suite | Baseline | Current | Delta |`);
    lines.push(`|---|---|---|---|---|`);
    for (const td of improvements) {
      const sign = td.delta >= 0 ? '+' : '';
      lines.push(
        `| ${td.taskId} | ${td.suite} | ${td.baselineScore.toFixed(3)} | ${td.currentScore.toFixed(3)} | ${sign}${td.delta.toFixed(3)} |`,
      );
    }
    lines.push('');
  } else {
    lines.push(`## Improvements`);
    lines.push('');
    lines.push(`None detected.`);
    lines.push('');
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Main Entry Point
// ---------------------------------------------------------------------------

/**
 * Runs a full comparison between two git refs across eval suites.
 */
export async function runComparison(config: ComparisonConfig): Promise<ComparisonReport> {
  const {
    baselineRef,
    currentRef,
    trials = 1,
    timeout,
    parallel = 3,
  } = config;

  const reportId = generateId();

  console.log(`\n=== Eval Comparison: ${baselineRef} vs ${currentRef} ===`);
  console.log(`Report ID: ${reportId}`);
  console.log(`Trials per task: ${trials}`);
  console.log(`Parallel suites: ${parallel}\n`);

  // Step 1: Resolve context for both refs
  console.log('Resolving context for both refs...');

  const baselineContext: ResolvedContext = await resolveContextAtRef(baselineRef);
  const currentContext: ResolvedContext = await resolveContextAtRef(currentRef);

  console.log(`  Baseline [${baselineRef}]: source="${baselineContext.source}", ${baselineContext.context.length} chars`);
  console.log(`  Current  [${currentRef}]: source="${currentContext.source}", ${currentContext.context.length} chars`);
  console.log('');

  // Step 2: Determine which suites to run
  let suiteNames: string[];
  if (config.suites && config.suites.length > 0) {
    suiteNames = config.suites;
  } else {
    const allSuites = listSuites();
    suiteNames = allSuites
      .filter((s: EvalSuite) => s.name.startsWith('kaya-'))
      .map((s: EvalSuite) => s.name);
  }

  console.log(`Running ${suiteNames.length} suites: ${suiteNames.join(', ')}\n`);

  // Step 3: Run baseline
  console.log(`--- Running baseline (${baselineRef}) ---`);
  const baselineResults = await runAllSuites(suiteNames, {
    trials,
    timeout,
    systemContext: baselineContext.context,
    ref: baselineRef,
    parallel,
    contextSource: baselineContext.source,
    contextCharCount: baselineContext.context.length,
  });

  console.log(`\nBaseline complete in ${(baselineResults.totalDurationMs / 1000).toFixed(1)}s\n`);

  // Step 4: Run current
  console.log(`--- Running current (${currentRef}) ---`);
  const currentResults = await runAllSuites(suiteNames, {
    trials,
    timeout,
    systemContext: currentContext.context,
    ref: currentRef,
    parallel,
    contextSource: currentContext.source,
    contextCharCount: currentContext.context.length,
  });

  console.log(`\nCurrent complete in ${(currentResults.totalDurationMs / 1000).toFixed(1)}s\n`);

  // Step 5: Compute deltas
  console.log('Computing deltas...');
  const { deltas, overallDelta } = computeDeltas(baselineResults, currentResults, suiteNames);

  // Step 6: Build report
  const report: ComparisonReport = {
    id: reportId,
    baseline: baselineResults,
    current: currentResults,
    deltas,
    overallDelta,
    generatedAt: timestamp(),
  };

  // Step 7: Save report
  if (!existsSync(COMPARISONS_DIR)) {
    mkdirSync(COMPARISONS_DIR, { recursive: true });
  }

  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const jsonPath = join(COMPARISONS_DIR, `comparison-${ts}.json`);
  const mdPath = join(COMPARISONS_DIR, `comparison-${ts}.md`);

  writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  writeFileSync(mdPath, formatComparisonReport(report));

  console.log(`\nReport saved:`);
  console.log(`  JSON: ${jsonPath}`);
  console.log(`  Markdown: ${mdPath}`);

  // Print summary
  const sign = overallDelta.delta >= 0 ? '+' : '';
  console.log(`\n=== Overall: ${overallDelta.baselineMeanScore.toFixed(3)} -> ${overallDelta.currentMeanScore.toFixed(3)} (${sign}${overallDelta.delta.toFixed(3)}) ===`);
  console.log(`  Regressions: ${overallDelta.totalRegressions} | Improvements: ${overallDelta.totalImprovements} | Stable: ${overallDelta.totalStable}\n`);

  return report;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

if (import.meta.main) {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      baseline: { type: 'string' },
      current: { type: 'string', default: 'HEAD' },
      suite: { type: 'string' },
      trials: { type: 'string', default: '1' },
      parallel: { type: 'string', default: '3' },
      timeout: { type: 'string' },
      help: { type: 'boolean', default: false },
    },
    strict: true,
  });

  if (values.help || !values.baseline) {
    console.log(`
Usage: bun ComparisonRunner.ts --baseline <ref> [options]

Options:
  --baseline <ref>    Git ref for baseline (required)
  --current <ref>     Git ref for current (default: HEAD)
  --suite <names>     Comma-separated suite names (default: all kaya-* suites)
  --trials <n>        Trials per task (default: 1)
  --parallel <n>      Max concurrent suites (default: 3)
  --timeout <ms>      Timeout per suite run in ms
  --help              Show this help

Examples:
  bun ComparisonRunner.ts --baseline pre-streamline --current HEAD --trials 3 --parallel 3
  bun ComparisonRunner.ts --baseline pre-streamline --current HEAD --suite kaya-regression --trials 1
  bun ComparisonRunner.ts --baseline abc123 --current def456 --suite kaya-identity,kaya-behavioral
`);
    process.exit(values.help ? 0 : 1);
  }

  const suites = values.suite
    ? values.suite.split(',').map((s) => s.trim()).filter(Boolean)
    : undefined;

  const config: ComparisonConfig = {
    baselineRef: values.baseline,
    currentRef: values.current ?? 'HEAD',
    suites,
    trials: parseInt(values.trials ?? '1', 10),
    parallel: parseInt(values.parallel ?? '3', 10),
    timeout: values.timeout ? parseInt(values.timeout, 10) : undefined,
  };

  runComparison(config)
    .then((report) => {
      const exitCode = report.overallDelta.totalRegressions > 0 ? 1 : 0;
      process.exit(exitCode);
    })
    .catch((err) => {
      console.error('Comparison failed:', err);
      process.exit(2);
    });
}
