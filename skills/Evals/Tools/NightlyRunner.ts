#!/usr/bin/env bun
/**
 * NightlyRunner.ts
 * Orchestrates nightly eval runs, compares to last run, sends notifications
 *
 * Usage:
 *   bun NightlyRunner.ts [--suites suite1,suite2] [--trials 1]
 */

import { runSuite } from './EvalExecutor.ts';
import { $ } from 'bun';
import { existsSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { parseArgs } from 'util';

const EVALS_DIR = join(import.meta.dir, '..');
const NIGHTLY_LOG = join(EVALS_DIR, 'Results', 'nightly-runs.jsonl');

// =============================================================================
// TYPES
// =============================================================================

interface NightlyRunRecord {
  timestamp: string;
  suites: {
    name: string;
    passed: number;
    failed: number;
    total: number;
    meanScore: number;
  }[];
  totalRegressions: number;
  duration_ms: number;
}

// =============================================================================
// HELPERS
// =============================================================================

function loadLastNightlyRun(): NightlyRunRecord | null {
  if (!existsSync(NIGHTLY_LOG)) {
    return null;
  }

  const lines = readFileSync(NIGHTLY_LOG, 'utf-8').trim().split('\n').filter(Boolean);
  if (lines.length === 0) {
    return null;
  }

  const lastLine = lines[lines.length - 1];
  return JSON.parse(lastLine) as NightlyRunRecord;
}

function logNightlyRun(record: NightlyRunRecord): void {
  const line = JSON.stringify(record) + '\n';
  const fs = require('fs');
  fs.appendFileSync(NIGHTLY_LOG, line);
}

async function sendNotification(message: string, title: string = 'Evals Nightly Run'): Promise<void> {
  try {
    // Use NotificationService if available
    await $`curl -X POST http://localhost:8888/notify -H "Content-Type: application/json" -d ${JSON.stringify({
      message,
      title,
      voice_id: 'iLVmqjzCGGvqtMCk6vVQ',
    })}`.quiet();
  } catch (error) {
    console.warn(`⚠️  Failed to send notification: ${error}`);
  }
}

// =============================================================================
// MAIN
// =============================================================================

async function runNightly(suiteNames?: string[], trials: number = 1): Promise<NightlyRunRecord> {
  const startTime = Date.now();

  console.log(`\n${'='.repeat(60)}`);
  console.log(`Nightly Evals Run`);
  console.log(`Started: ${new Date().toISOString()}`);
  console.log(`${'='.repeat(60)}\n`);

  // Default to all regression suites
  let suitesToRun = suiteNames;
  if (!suitesToRun || suitesToRun.length === 0) {
    suitesToRun = [
      'kaya-regression',
      'kaya-negative-cases',
      'negative-behaviors',
    ];
  }

  console.log(`📋 Running ${suitesToRun.length} suite(s):`);
  for (const suite of suitesToRun) {
    console.log(`   - ${suite}`);
  }
  console.log();

  const suiteResults: NightlyRunRecord['suites'] = [];

  // Run each suite
  for (const suiteName of suitesToRun) {
    console.log(`\n▶️  Running: ${suiteName}`);
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

    try {
      const result = await runSuite(suiteName, { trials });

      suiteResults.push({
        name: suiteName,
        passed: result.summary.passed,
        failed: result.summary.failed,
        total: result.summary.total,
        meanScore: result.summary.meanScore,
      });

      console.log(`\n✅ ${suiteName}: ${result.summary.passed}/${result.summary.total} passed (mean: ${result.summary.meanScore.toFixed(3)})\n`);
    } catch (error) {
      console.error(`\n❌ ${suiteName} failed: ${error}\n`);

      suiteResults.push({
        name: suiteName,
        passed: 0,
        failed: 0,
        total: 0,
        meanScore: 0,
      });
    }
  }

  // Check for regressions
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Regression Detection`);
  console.log(`${'='.repeat(60)}\n`);

  let totalRegressions = 0;

  for (const suite of suiteResults) {
    console.log(`Checking ${suite.name} for regressions...`);

    try {
      // Run regression alert check
      await $`bun ${join(EVALS_DIR, 'Tools', 'RegressionAlert.ts')} check ${suite.name} --last 3 --threshold 0.10`.quiet();
      console.log(`  ✅ No regressions detected\n`);
    } catch (error) {
      // RegressionAlert exits with code 1 if regressions found
      totalRegressions++;
      console.log(`  ⚠️  Regressions detected in ${suite.name}\n`);
    }
  }

  const duration_ms = Date.now() - startTime;

  // Build record
  const record: NightlyRunRecord = {
    timestamp: new Date().toISOString(),
    suites: suiteResults,
    totalRegressions,
    duration_ms,
  };

  // Log to JSONL
  logNightlyRun(record);

  // Summary
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Nightly Run Summary`);
  console.log(`${'='.repeat(60)}\n`);

  const totalPassed = suiteResults.reduce((sum, s) => sum + s.passed, 0);
  const totalFailed = suiteResults.reduce((sum, s) => sum + s.failed, 0);
  const totalTests = suiteResults.reduce((sum, s) => sum + s.total, 0);
  const overallMean = suiteResults.reduce((sum, s) => sum + s.meanScore, 0) / suiteResults.length;

  console.log(`📊 Results:`);
  console.log(`   Total tests: ${totalTests}`);
  console.log(`   Passed: ${totalPassed}`);
  console.log(`   Failed: ${totalFailed}`);
  console.log(`   Overall mean score: ${overallMean.toFixed(3)}`);
  console.log(`   Regressions: ${totalRegressions} suite(s)`);
  console.log(`   Duration: ${(duration_ms / 1000 / 60).toFixed(1)} minutes\n`);

  // Send notification
  const notificationMessage = totalRegressions > 0
    ? `Nightly evals completed with ${totalRegressions} regression(s). ${totalPassed}/${totalTests} tests passed.`
    : `Nightly evals completed successfully. ${totalPassed}/${totalTests} tests passed.`;

  await sendNotification(notificationMessage);

  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

  return record;
}

// =============================================================================
// CLI
// =============================================================================

async function main() {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      suites: { type: 'string' },
      trials: { type: 'string', default: '1' },
      help: { type: 'boolean', default: false },
    },
    strict: true,
  });

  if (values.help) {
    console.log(`
NightlyRunner - Orchestrate nightly eval runs

Usage:
  bun NightlyRunner.ts [options]

Options:
  --suites <names>     Comma-separated suite names (default: all regression suites)
  --trials <n>         Trials per task (default: 1)
  --help               Show this help

Examples:
  bun NightlyRunner.ts
  bun NightlyRunner.ts --suites kaya-regression,kaya-negative-cases --trials 1
`);
    process.exit(0);
  }

  const suites = values.suites ? values.suites.split(',').map(s => s.trim()) : undefined;
  const trials = parseInt(values.trials ?? '1', 10);

  const result = await runNightly(suites, trials);

  // Exit with error if regressions detected
  if (result.totalRegressions > 0) {
    process.exit(1);
  }
}

if (import.meta.main) {
  main();
}
