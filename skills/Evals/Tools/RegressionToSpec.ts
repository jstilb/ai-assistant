#!/usr/bin/env bun

/**
 * RegressionToSpec.ts
 *
 * Reads a ComparisonRunner output JSON, identifies regressed suites/tasks,
 * and generates approved-work JSONL entries for the work queue.
 *
 * Usage:
 *   bun RegressionToSpec.ts --report Results/comparisons/comparison-{timestamp}.json
 *   bun RegressionToSpec.ts --report path/to/report.json --dry-run
 *   bun RegressionToSpec.ts --report path/to/report.json --queue /custom/queue.jsonl
 */

import { existsSync, readFileSync, appendFileSync } from 'fs';
import { join } from 'path';
import { parseArgs } from 'util';

// ---------------------------------------------------------------------------
// Types (mirror ComparisonRunner output)
// ---------------------------------------------------------------------------

interface TaskDelta {
  taskId: string;
  suite: string;
  baselineScore: number;
  currentScore: number;
  delta: number;
  status: 'improved' | 'regressed' | 'stable';
}

interface SuiteDelta {
  suite: string;
  baselineScore: number;
  currentScore: number;
  delta: number;
  status: 'improved' | 'regressed' | 'stable';
  taskDeltas: TaskDelta[];
}

interface ComparisonReport {
  id: string;
  baseline: { ref: string; contextSource: string };
  current: { ref: string; contextSource: string };
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
// Approved-work queue entry
// ---------------------------------------------------------------------------

interface ApprovedWorkEntry {
  id: string;
  created: string;
  updated: string;
  source: string;
  priority: number;
  status: string;
  type: string;
  queue: string;
  payload: {
    title: string;
    description: string;
  };
  routing: {
    sourceQueue: string;
    targetQueue: string;
  };
  project: {
    name: string;
    path: string;
  };
  notes: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_QUEUE_PATH = '~/.claude/MEMORY/QUEUES/approved-work.jsonl';

// ---------------------------------------------------------------------------
// Core logic
// ---------------------------------------------------------------------------

/**
 * Read a comparison report and generate one ApprovedWorkEntry per regressed suite.
 */
export function generateRegressionSpecs(reportPath: string): ApprovedWorkEntry[] {
  if (!existsSync(reportPath)) {
    throw new Error(`Comparison report not found: ${reportPath}`);
  }

  const raw = readFileSync(reportPath, 'utf-8');
  const report: ComparisonReport = JSON.parse(raw);

  const regressedSuites = report.deltas.filter(
    (s) => s.status === 'regressed',
  );

  if (regressedSuites.length === 0) {
    return [];
  }

  const now = new Date().toISOString();

  const entries: ApprovedWorkEntry[] = regressedSuites.map((suite) => {
    const regressedTasks = suite.taskDeltas.filter(
      (t) => t.status === 'regressed',
    );

    // Priority: P1 if worst delta < -0.30, P2 if < -0.15, else P3
    const worstDelta = Math.min(...regressedTasks.map((t) => t.delta));
    let priority: number;
    if (worstDelta < -0.30) {
      priority = 1;
    } else if (worstDelta < -0.15) {
      priority = 2;
    } else {
      priority = 3;
    }

    // Build description with task-level detail
    const taskLines = regressedTasks
      .map(
        (t) =>
          `  - ${t.taskId}: ${t.baselineScore.toFixed(2)} -> ${t.currentScore.toFixed(2)} (delta: ${t.delta >= 0 ? '+' : ''}${t.delta.toFixed(2)})`,
      )
      .join('\n');

    const description = [
      `Suite "${suite.suite}" regressed from ${suite.baselineScore.toFixed(2)} to ${suite.currentScore.toFixed(2)} (delta: ${suite.delta >= 0 ? '+' : ''}${suite.delta.toFixed(2)}).`,
      ``,
      `Baseline ref: ${report.baseline.ref} (context: ${report.baseline.contextSource})`,
      `Current ref: ${report.current.ref} (context: ${report.current.contextSource})`,
      ``,
      `Regressed tasks (${regressedTasks.length}):`,
      taskLines,
    ].join('\n');

    const notes = `${regressedTasks.length} task(s) regressed in ${suite.suite}. Worst delta: ${worstDelta.toFixed(2)}. Priority: P${priority}.`;

    return {
      id: `eval-regression-${suite.suite}-${Date.now().toString(36)}`,
      created: now,
      updated: now,
      source: 'eval-comparison',
      priority,
      status: 'pending',
      type: 'dev',
      queue: 'approved-work',
      payload: {
        title: `Fix ${suite.suite} regression: ${regressedTasks.length} tasks degraded`,
        description,
      },
      routing: {
        sourceQueue: 'eval-comparison',
        targetQueue: 'approved-work',
      },
      project: {
        name: 'kaya',
        path: '~/.claude',
      },
      notes,
    };
  });

  return entries;
}

/**
 * Append entries as JSONL to the queue file (one JSON object per line).
 */
export function appendToQueue(
  entries: ApprovedWorkEntry[],
  queuePath: string = DEFAULT_QUEUE_PATH,
): void {
  if (entries.length === 0) return;

  const lines = entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
  appendFileSync(queuePath, lines, 'utf-8');
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

if (import.meta.main) {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      report: { type: 'string', short: 'r' },
      'dry-run': { type: 'boolean', default: false },
      queue: { type: 'string', short: 'q' },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
  });

  if (values.help) {
    console.log(`Usage: bun RegressionToSpec.ts --report <path> [--dry-run] [--queue <path>]

Options:
  --report, -r   Path to comparison report JSON (required)
  --dry-run      Print specs without appending to queue
  --queue, -q    Override queue file path (default: ${DEFAULT_QUEUE_PATH})
  --help, -h     Show this help message`);
    process.exit(0);
  }

  if (!values.report) {
    console.error('Error: --report is required. Use --help for usage.');
    process.exit(1);
  }

  const reportPath = values.report;
  const queuePath = values.queue ?? DEFAULT_QUEUE_PATH;
  const dryRun = values['dry-run'] ?? false;

  try {
    const specs = generateRegressionSpecs(reportPath);

    if (specs.length === 0) {
      console.log('No regressions found. No specs generated.');
      process.exit(0);
    }

    const totalRegressedTasks = specs.reduce((sum, s) => {
      // Count task lines in description (lines starting with "  - ")
      const taskCount = s.payload.description
        .split('\n')
        .filter((line) => line.startsWith('  - ')).length;
      return sum + taskCount;
    }, 0);

    if (dryRun) {
      console.log('=== DRY RUN — specs would be appended ===\n');
      for (const spec of specs) {
        console.log(JSON.stringify(spec, null, 2));
        console.log('');
      }
    } else {
      appendToQueue(specs, queuePath);
      console.log(`Appended ${specs.length} spec(s) to ${queuePath}`);
    }

    console.log(
      `Generated ${specs.length} specs for ${specs.length} regressed suites. ${totalRegressedTasks} total regressed tasks.`,
    );
  } catch (err) {
    console.error(
      `Error: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }
}
