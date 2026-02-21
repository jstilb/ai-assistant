#!/usr/bin/env bun
/**
 * ResultsCompare.ts
 * Compare eval results from different runs
 *
 * Usage:
 *   bun ResultsCompare.ts diff <run1> <run2>             Per-task score delta
 *   bun ResultsCompare.ts trend <suite> [--last N]       Trend visualization
 *   bun ResultsCompare.ts report <suite>                 Markdown summary
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

interface TaskComparison {
  task_id: string;
  run1_score: number;
  run2_score: number;
  delta: number;
  status: 'IMPROVED' | 'REGRESSED' | 'UNCHANGED';
}

interface RunMetadata {
  run_id: string;
  timestamp: string;
  task_count: number;
  mean_score: number;
}

// =============================================================================
// HELPERS
// =============================================================================

function loadRun(runPath: string): EvalRun[] {
  if (!existsSync(runPath)) {
    throw new Error(`Run not found: ${runPath}`);
  }

  const resultsFile = join(runPath, 'results.json');
  if (!existsSync(resultsFile)) {
    throw new Error(`No results.json in ${runPath}`);
  }

  const content = readFileSync(resultsFile, 'utf-8');
  const data = JSON.parse(content);

  // Handle both array and object formats
  return Array.isArray(data) ? data : data.results || [];
}

function findRunPath(identifier: string): string {
  // If it's an absolute path, use it
  if (identifier.startsWith('/')) {
    return identifier;
  }

  // If it's a directory name in Results/
  const directPath = join(RESULTS_DIR, identifier);
  if (existsSync(directPath)) {
    return directPath;
  }

  // Try to find by partial match
  const entries = readdirSync(RESULTS_DIR, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory() && entry.name.includes(identifier)) {
      return join(RESULTS_DIR, entry.name);
    }
  }

  throw new Error(`Could not find run: ${identifier}`);
}

function classifyDelta(delta: number): 'IMPROVED' | 'REGRESSED' | 'UNCHANGED' {
  if (delta > 0.05) return 'IMPROVED';
  if (delta < -0.05) return 'REGRESSED';
  return 'UNCHANGED';
}

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

// =============================================================================
// COMMANDS
// =============================================================================

function cmdDiff(run1: string, run2: string): void {
  console.log(`\n=== Comparing Runs ===`);
  console.log(`Run 1: ${run1}`);
  console.log(`Run 2: ${run2}\n`);

  const run1Path = findRunPath(run1);
  const run2Path = findRunPath(run2);

  const results1 = loadRun(run1Path);
  const results2 = loadRun(run2Path);

  // Build task score maps
  const scores1 = new Map<string, number>();
  const scores2 = new Map<string, number>();

  for (const r of results1) {
    scores1.set(r.task_id, r.mean_score);
  }

  for (const r of results2) {
    scores2.set(r.task_id, r.mean_score);
  }

  // Find all tasks
  const allTasks = new Set([...scores1.keys(), ...scores2.keys()]);
  const comparisons: TaskComparison[] = [];

  for (const taskId of allTasks) {
    const score1 = scores1.get(taskId) ?? 0;
    const score2 = scores2.get(taskId) ?? 0;
    const delta = score2 - score1;

    comparisons.push({
      task_id: taskId,
      run1_score: score1,
      run2_score: score2,
      delta,
      status: classifyDelta(delta),
    });
  }

  // Sort by delta (regressions first)
  comparisons.sort((a, b) => a.delta - b.delta);

  // Print results
  const regressions = comparisons.filter(c => c.status === 'REGRESSED');
  const improvements = comparisons.filter(c => c.status === 'IMPROVED');
  const unchanged = comparisons.filter(c => c.status === 'UNCHANGED');

  console.log(`📊 Summary:`);
  console.log(`   Total tasks: ${comparisons.length}`);
  console.log(`   Regressions: ${regressions.length}`);
  console.log(`   Improvements: ${improvements.length}`);
  console.log(`   Unchanged: ${unchanged.length}\n`);

  if (regressions.length > 0) {
    console.log(`❌ Regressions (${regressions.length}):`);
    for (const c of regressions) {
      console.log(`   ${c.task_id}: ${c.run1_score.toFixed(3)} → ${c.run2_score.toFixed(3)} (${c.delta.toFixed(3)})`);
    }
    console.log();
  }

  if (improvements.length > 0) {
    console.log(`✅ Improvements (${improvements.length}):`);
    for (const c of improvements) {
      console.log(`   ${c.task_id}: ${c.run1_score.toFixed(3)} → ${c.run2_score.toFixed(3)} (+${c.delta.toFixed(3)})`);
    }
    console.log();
  }

  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
}

function cmdTrend(suite: string, last?: number): void {
  console.log(`\n=== Trend Analysis: ${suite} ===\n`);

  const runs = findSuiteRuns(suite, last);

  if (runs.length === 0) {
    console.log(`❌ No runs found for suite: ${suite}\n`);
    return;
  }

  console.log(`Found ${runs.length} runs (most recent first):\n`);

  // Load all runs and compute mean scores
  const trendData: { timestamp: string; mean_score: number; task_count: number }[] = [];

  for (const runPath of runs) {
    const results = loadRun(runPath);

    // Filter to suite tasks
    const suiteResults = results.filter(r =>
      r.task_id.startsWith(suite) || r.task_id.includes(suite)
    );

    if (suiteResults.length === 0) continue;

    const meanScore = suiteResults.reduce((sum, r) => sum + r.mean_score, 0) / suiteResults.length;

    // Extract timestamp from path
    const dirName = runPath.split('/').pop() || '';
    const timestampMatch = dirName.match(/^(\d{8}-\d{6})/);
    const timestamp = timestampMatch ? timestampMatch[1] : dirName;

    trendData.push({
      timestamp,
      mean_score: meanScore,
      task_count: suiteResults.length,
    });
  }

  // Sort chronologically
  trendData.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  // Print trend table
  console.log(`| Timestamp       | Mean Score | Tasks | Sparkline                    |`);
  console.log(`|-----------------|------------|-------|------------------------------|`);

  for (const data of trendData) {
    const bar = '█'.repeat(Math.round(data.mean_score * 30));
    console.log(
      `| ${data.timestamp} | ${data.mean_score.toFixed(3)}      | ${data.task_count.toString().padStart(5)} | ${bar.padEnd(30)} |`
    );
  }

  console.log();

  // Compute trend direction
  if (trendData.length >= 2) {
    const first = trendData[0].mean_score;
    const last = trendData[trendData.length - 1].mean_score;
    const delta = last - first;
    const direction = delta > 0.05 ? '📈 IMPROVING' : delta < -0.05 ? '📉 DECLINING' : '➡️  STABLE';

    console.log(`Trend: ${direction} (${first.toFixed(3)} → ${last.toFixed(3)}, Δ ${delta > 0 ? '+' : ''}${delta.toFixed(3)})\n`);
  }

  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
}

function cmdReport(suite: string): void {
  console.log(`\n=== Generating Report: ${suite} ===\n`);

  const runs = findSuiteRuns(suite);

  if (runs.length === 0) {
    console.log(`❌ No runs found for suite: ${suite}\n`);
    return;
  }

  const latestRunPath = runs[0];
  const results = loadRun(latestRunPath);

  const suiteResults = results.filter(r =>
    r.task_id.startsWith(suite) || r.task_id.includes(suite)
  );

  if (suiteResults.length === 0) {
    console.log(`❌ No results for suite in latest run\n`);
    return;
  }

  const passed = suiteResults.filter(r => r.passed).length;
  const failed = suiteResults.length - passed;
  const meanScore = suiteResults.reduce((sum, r) => sum + r.mean_score, 0) / suiteResults.length;

  // Markdown report
  const lines: string[] = [];
  lines.push(`# ${suite} — Latest Run Report`);
  lines.push('');
  lines.push(`**Generated:** ${new Date().toISOString()}`);
  lines.push(`**Run:** ${latestRunPath.split('/').pop()}`);
  lines.push('');
  lines.push(`## Summary`);
  lines.push('');
  lines.push(`| Metric | Value |`);
  lines.push(`|--------|-------|`);
  lines.push(`| Tasks | ${suiteResults.length} |`);
  lines.push(`| Passed | ${passed} |`);
  lines.push(`| Failed | ${failed} |`);
  lines.push(`| Mean Score | ${meanScore.toFixed(3)} |`);
  lines.push('');
  lines.push(`## Task Results`);
  lines.push('');
  lines.push(`| Task | Score | Status | Trials |`);
  lines.push(`|------|-------|--------|--------|`);

  for (const r of suiteResults) {
    const status = r.passed ? '✅ PASS' : '❌ FAIL';
    lines.push(`| ${r.task_id} | ${r.mean_score.toFixed(3)} | ${status} | ${r.trials.length} |`);
  }

  lines.push('');

  const markdown = lines.join('\n');

  console.log(markdown);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
}

// =============================================================================
// CLI
// =============================================================================

async function main() {
  const args = Bun.argv.slice(2);

  if (args.length === 0 || args.includes('--help')) {
    console.log(`
Results Comparison Tool

Usage:
  bun ResultsCompare.ts diff <run1> <run2>        Compare two runs
  bun ResultsCompare.ts trend <suite> [--last N]  Show trend for suite
  bun ResultsCompare.ts report <suite>            Generate markdown report

Examples:
  bun ResultsCompare.ts diff 20260212-101530_kaya-regression 20260212-141822_kaya-regression
  bun ResultsCompare.ts trend kaya-behavioral --last 5
  bun ResultsCompare.ts report kaya-identity
`);
    process.exit(0);
  }

  const command = args[0];

  try {
    if (command === 'diff') {
      if (args.length < 3) {
        console.error('❌ diff requires two run identifiers');
        process.exit(1);
      }
      cmdDiff(args[1], args[2]);
    } else if (command === 'trend') {
      if (args.length < 2) {
        console.error('❌ trend requires a suite name');
        process.exit(1);
      }

      const lastIdx = args.indexOf('--last');
      const last = lastIdx !== -1 && args[lastIdx + 1] ? parseInt(args[lastIdx + 1]) : undefined;

      cmdTrend(args[1], last);
    } else if (command === 'report') {
      if (args.length < 2) {
        console.error('❌ report requires a suite name');
        process.exit(1);
      }
      cmdReport(args[1]);
    } else {
      console.error(`❌ Unknown command: ${command}`);
      console.error(`   Valid commands: diff, trend, report`);
      process.exit(1);
    }
  } catch (error) {
    console.error(`\n❌ Error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}

main();
