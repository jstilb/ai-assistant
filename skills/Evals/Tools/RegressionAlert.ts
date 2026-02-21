#!/usr/bin/env bun
/**
 * RegressionAlert.ts
 * Detect score regressions by comparing to last N runs
 *
 * Usage:
 *   bun RegressionAlert.ts check <suite> [--last N] [--threshold 0.10]
 */

import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';
import { parseArgs } from 'util';
import type { EvalRun } from '../Types/index.ts';

const EVALS_DIR = join(import.meta.dir, '..');
const RESULTS_DIR = join(EVALS_DIR, 'Results');

// =============================================================================
// TYPES
// =============================================================================

interface RegressionAlert {
  task_id: string;
  current_score: number;
  baseline_score: number;
  delta: number;
  severity: 'critical' | 'warning';
}

interface AlertReport {
  suite: string;
  timestamp: string;
  total_regressions: number;
  critical_count: number;
  warning_count: number;
  regressions: RegressionAlert[];
}

// =============================================================================
// HELPERS
// =============================================================================

function findSuiteRuns(suiteName: string, limit?: number): string[] {
  const entries = readdirSync(RESULTS_DIR, { withFileTypes: true });
  const runs: { path: string; timestamp: string }[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const dirPath = join(RESULTS_DIR, entry.name);
    const resultsFile = join(dirPath, 'results.json');

    if (!existsSync(resultsFile)) continue;

    const content = readFileSync(resultsFile, 'utf-8');
    const data = JSON.parse(content);
    const results: EvalRun[] = Array.isArray(data) ? data : data.results || [];

    // Check if any result is from this suite
    const hasSuite = results.some(r =>
      r.task_id.startsWith(suiteName) ||
      r.task_id.includes(suiteName)
    );

    if (hasSuite) {
      // Extract timestamp from directory name (format: YYYYMMDD-HHMMSS_*)
      const timestampMatch = entry.name.match(/^(\d{8}-\d{6})/);
      const timestamp = timestampMatch ? timestampMatch[1] : entry.name;

      runs.push({ path: dirPath, timestamp });
    }
  }

  // Sort by timestamp descending (most recent first)
  runs.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

  // Apply limit
  const limited = limit ? runs.slice(0, limit) : runs;
  return limited.map(r => r.path);
}

function loadRun(runPath: string): EvalRun[] {
  const resultsFile = join(runPath, 'results.json');
  if (!existsSync(resultsFile)) {
    throw new Error(`No results.json in ${runPath}`);
  }

  const content = readFileSync(resultsFile, 'utf-8');
  const data = JSON.parse(content);

  return Array.isArray(data) ? data : data.results || [];
}

function detectRegressions(
  currentRun: EvalRun[],
  baselineRuns: EvalRun[][],
  threshold: number
): RegressionAlert[] {
  const regressions: RegressionAlert[] = [];

  // Build baseline score map (average across N runs)
  const baselineScores = new Map<string, number[]>();

  for (const run of baselineRuns) {
    for (const result of run) {
      const scores = baselineScores.get(result.task_id) || [];
      scores.push(result.mean_score);
      baselineScores.set(result.task_id, scores);
    }
  }

  // Check each task in current run
  for (const currentResult of currentRun) {
    const baseline = baselineScores.get(currentResult.task_id);
    if (!baseline || baseline.length === 0) {
      continue; // No baseline for comparison
    }

    const baselineScore = baseline.reduce((sum, s) => sum + s, 0) / baseline.length;
    const currentScore = currentResult.mean_score;
    const delta = currentScore - baselineScore;

    // Detect regression (score dropped)
    if (delta < -threshold) {
      const severity = Math.abs(delta) > threshold * 2 ? 'critical' : 'warning';

      regressions.push({
        task_id: currentResult.task_id,
        current_score: currentScore,
        baseline_score: baselineScore,
        delta,
        severity,
      });
    }
  }

  // Sort by severity and delta (most severe first)
  regressions.sort((a, b) => {
    if (a.severity !== b.severity) {
      return a.severity === 'critical' ? -1 : 1;
    }
    return a.delta - b.delta;
  });

  return regressions;
}

// =============================================================================
// COMMANDS
// =============================================================================

function cmdCheck(suite: string, last: number, threshold: number): AlertReport {
  console.log(`\n=== Regression Alert: ${suite} ===`);
  console.log(`Baseline: Last ${last} runs`);
  console.log(`Threshold: ${(threshold * 100).toFixed(0)}% score drop\n`);

  const runs = findSuiteRuns(suite, last + 1); // +1 to include current

  if (runs.length < 2) {
    console.log(`❌ Need at least 2 runs for regression detection`);
    console.log(`   Found: ${runs.length} run(s)\n`);
    return {
      suite,
      timestamp: new Date().toISOString(),
      total_regressions: 0,
      critical_count: 0,
      warning_count: 0,
      regressions: [],
    };
  }

  const currentRunPath = runs[0];
  const baselineRunPaths = runs.slice(1, last + 1);

  console.log(`📊 Loading runs...`);
  console.log(`   Current: ${currentRunPath.split('/').pop()}`);
  console.log(`   Baseline: ${baselineRunPaths.length} run(s)\n`);

  const currentRun = loadRun(currentRunPath);
  const baselineRuns = baselineRunPaths.map(p => loadRun(p));

  // Filter to suite tasks
  const suiteFilter = (results: EvalRun[]) =>
    results.filter(r => r.task_id.startsWith(suite) || r.task_id.includes(suite));

  const current = suiteFilter(currentRun);
  const baseline = baselineRuns.map(suiteFilter);

  const regressions = detectRegressions(current, baseline, threshold);

  const criticalCount = regressions.filter(r => r.severity === 'critical').length;
  const warningCount = regressions.filter(r => r.severity === 'warning').length;

  console.log(`🔍 Regression Detection:`);
  console.log(`   Total regressions: ${regressions.length}`);
  console.log(`   Critical: ${criticalCount}`);
  console.log(`   Warnings: ${warningCount}\n`);

  if (regressions.length === 0) {
    console.log(`✅ No regressions detected\n`);
  } else {
    console.log(`❌ Regressions Detected:\n`);

    for (const regression of regressions) {
      const icon = regression.severity === 'critical' ? '🔴' : '⚠️';
      console.log(`${icon} ${regression.task_id}`);
      console.log(`   Current:  ${regression.current_score.toFixed(3)}`);
      console.log(`   Baseline: ${regression.baseline_score.toFixed(3)}`);
      console.log(`   Delta:    ${regression.delta.toFixed(3)} (${(regression.delta * 100).toFixed(1)}%)`);
      console.log();
    }
  }

  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

  const report: AlertReport = {
    suite,
    timestamp: new Date().toISOString(),
    total_regressions: regressions.length,
    critical_count: criticalCount,
    warning_count: warningCount,
    regressions,
  };

  // Exit with error code if regressions found
  if (regressions.length > 0) {
    process.exit(1);
  }

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
  --last <N>            Compare to last N runs (default: 3)
  --threshold <pct>     Regression threshold as decimal (default: 0.10 = 10%)

Examples:
  bun RegressionAlert.ts check kaya-behavioral
  bun RegressionAlert.ts check kaya-behavioral --last 5 --threshold 0.15
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

  const suite = args[1];

  const lastIdx = args.indexOf('--last');
  const last = lastIdx !== -1 && args[lastIdx + 1] ? parseInt(args[lastIdx + 1]) : 3;

  const thresholdIdx = args.indexOf('--threshold');
  const threshold = thresholdIdx !== -1 && args[thresholdIdx + 1]
    ? parseFloat(args[thresholdIdx + 1])
    : 0.10;

  try {
    cmdCheck(suite, last, threshold);
  } catch (error) {
    console.error(`\n❌ Error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}

main();
