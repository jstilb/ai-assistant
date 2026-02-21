#!/usr/bin/env bun
/**
 * Algorithm Bridge
 * Integration between Evals and THE ALGORITHM verification system
 */

import type { AlgorithmEvalRequest, AlgorithmEvalResult, EvalRun, Task } from '../Types/index.ts';
import { loadSuite, checkSaturation } from './SuiteManager.ts';
import { TrialRunner, formatEvalResults } from './TrialRunner.ts';
import { TranscriptCapture, createTranscript } from './TranscriptCapture.ts';
import { executeTask } from './EvalExecutor.ts';
import { captureBaselines } from './BaselineCaptureRunner.ts';
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { parse as parseYaml } from 'yaml';
import { parseArgs } from 'util';
import { $ } from 'bun';

const EVALS_DIR = join(import.meta.dir, '..');
const RESULTS_DIR = join(EVALS_DIR, 'Results');

/**
 * Run an eval suite for ALGORITHM verification
 */
export async function runEvalForAlgorithm(
  request: AlgorithmEvalRequest
): Promise<AlgorithmEvalResult> {
  const suite = loadSuite(request.suite);
  if (!suite) {
    return {
      isc_row: request.isc_row,
      suite: request.suite,
      passed: false,
      score: 0,
      summary: `Suite not found: ${request.suite}`,
      run_id: 'error',
    };
  }

  // Load tasks from suite
  const tasks: Task[] = [];
  const baselineRefOverride = process.env._BASELINE_REF_OVERRIDE;

  for (const taskId of suite.tasks) {
    const taskPath = findTaskFile(taskId);
    if (taskPath && existsSync(taskPath)) {
      const task = parseYaml(readFileSync(taskPath, 'utf-8')) as Task;

      // If baseline-ref override is set, rewrite pairwise_comparison reference paths
      if (baselineRefOverride) {
        for (const grader of task.graders) {
          if (grader.type === 'pairwise_comparison' && grader.params?.reference) {
            const origRef = grader.params.reference as string;
            // Rewrite: .../baselines/<old-ref>/file.md → .../baselines/<new-ref>/file.md
            const filename = origRef.split('/').pop();
            grader.params.reference = `skills/Evals/References/Kaya/baselines/${baselineRefOverride}/${filename}`;
          }
        }
      }

      tasks.push(task);
    }
  }

  if (tasks.length === 0) {
    return {
      isc_row: request.isc_row,
      suite: request.suite,
      passed: false,
      score: 0,
      summary: `No tasks found in suite: ${request.suite}`,
      run_id: 'error',
    };
  }

  // Run each task and aggregate
  const results: EvalRun[] = [];
  let totalScore = 0;
  let passedTasks = 0;

  for (const task of tasks) {
    const runner = new TrialRunner({
      task,
      executor: async (t, trialNum) => {
        // Use the real EvalExecutor to capture actual agent behavior
        const result = await executeTask(t, trialNum);
        return {
          output: result.output,
          transcript: result.transcript,
          outcome: result.exitCode === 0 ? 'success' : 'failure',
        };
      },
      onTrialComplete: (trial) => {
        console.log(`  Trial ${trial.trial_number}: ${trial.passed ? '✅ PASS' : '❌ FAIL'} (${trial.score.toFixed(2)})`);
      },
    });

    console.log(`Running task: ${task.id}`);
    const run = await runner.run();
    results.push(run);

    totalScore += run.mean_score;
    if (run.pass_rate >= (task.pass_threshold ?? 0.75)) {
      passedTasks++;
    }

    // Save run results
    saveRunResults(request.suite, run);
  }

  const overallScore = totalScore / tasks.length;
  const overallPassed = passedTasks === tasks.length ||
    overallScore >= (suite.pass_threshold ?? 0.75);

  const summary = `${passedTasks}/${tasks.length} tasks passed, score: ${(overallScore * 100).toFixed(1)}%`;

  return {
    isc_row: request.isc_row,
    suite: request.suite,
    passed: overallPassed,
    score: overallScore,
    summary,
    run_id: results[0]?.id ?? 'aggregate',
  };
}

/**
 * Find task file by ID
 *
 * Recursively searches all subdirectories under UseCases/ (Regression, Capability,
 * Kaya, etc.) including nested Tasks/ directories. Dynamically discovers directories
 * so new use cases are automatically picked up without code changes.
 *
 * Handles ID-to-filename mapping: suite YAML may use IDs like "kaya_voice_line_factual"
 * while the actual file is "task_voice_line_factual.yaml". We try both the raw ID
 * and a "task_" prefixed variant (stripping domain prefix like "kaya_").
 */
function findTaskFile(taskId: string): string | null {
  const useCasesDir = join(EVALS_DIR, 'UseCases');

  // Build candidate filenames from the task ID
  const candidateNames = [taskId];

  // If the ID has a domain prefix (e.g., "kaya_voice_line_factual"),
  // also try the "task_" prefixed version (e.g., "task_voice_line_factual")
  const underscoreIndex = taskId.indexOf('_');
  if (underscoreIndex > 0) {
    const withoutPrefix = taskId.slice(underscoreIndex + 1);
    candidateNames.push(`task_${withoutPrefix}`);
  }

  // Collect all directories to search: UseCases/ root + all subdirectories recursively
  const searchDirs = collectSearchDirs(useCasesDir);

  for (const dir of searchDirs) {
    for (const name of candidateNames) {
      const path = join(dir, `${name}.yaml`);
      if (existsSync(path)) return path;
    }
  }

  return null;
}

/**
 * Recursively collect all directories under a root that may contain task YAML files.
 * Includes the root itself, all immediate subdirectories, and any Tasks/ subdirectories.
 */
function collectSearchDirs(root: string): string[] {
  const dirs: string[] = [];
  if (!existsSync(root)) return dirs;

  dirs.push(root);

  try {
    for (const entry of readdirSync(root)) {
      const fullPath = join(root, entry);
      try {
        if (statSync(fullPath).isDirectory()) {
          dirs.push(fullPath);
          // Also check for a nested Tasks/ directory within each use case
          const tasksSubdir = join(fullPath, 'Tasks');
          if (existsSync(tasksSubdir) && statSync(tasksSubdir).isDirectory()) {
            dirs.push(tasksSubdir);
          }
        }
      } catch {
        // Skip entries we can't stat
      }
    }
  } catch {
    // If we can't read the directory, return what we have
  }

  return dirs;
}

/**
 * Save run results
 */
function saveRunResults(suiteName: string, run: EvalRun): void {
  const suiteResultsDir = join(RESULTS_DIR, suiteName);
  if (!existsSync(suiteResultsDir)) mkdirSync(suiteResultsDir, { recursive: true });

  const runDir = join(suiteResultsDir, run.id);
  if (!existsSync(runDir)) mkdirSync(runDir);

  writeFileSync(join(runDir, 'run.json'), JSON.stringify(run, null, 2));
}

/**
 * Format result for ISC update
 */
export function formatForISC(result: AlgorithmEvalResult): string {
  const icon = result.passed ? '✅' : '❌';
  return `${icon} Eval: ${result.summary}`;
}

/**
 * Update ISC row with eval result
 */
export async function updateISCWithResult(result: AlgorithmEvalResult): Promise<void> {
  const status = result.passed ? 'DONE' : 'BLOCKED';

  // ISCManager was removed in autowork-streamline. ISC updates are now handled by WorkOrchestrator.
  console.log(`[AlgorithmBridge] ISC row ${result.isc_row} → ${status} (update skipped: ISCManager removed)`);
}

// CLI interface
if (import.meta.main) {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      suite: { type: 'string', short: 's' },
      'isc-row': { type: 'string', short: 'r' },
      'update-isc': { type: 'boolean', short: 'u' },
      'show-saturation': { type: 'boolean' },
      'capture-baseline': { type: 'string' },
      'baseline-ref': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: true,
  });

  if (values.help || !values.suite) {
    console.log(`
AlgorithmBridge - Connect Evals to THE ALGORITHM

Usage:
  bun run AlgorithmBridge.ts -s <suite> [-r row] [-u]

Options:
  -s, --suite                Eval suite to run
  -r, --isc-row              ISC row number (for result binding)
  -u, --update-isc           Automatically update ISC with result
  --show-saturation          Show suite saturation status
  --capture-baseline <ref>   Capture baselines for comparison suite from git ref
  --baseline-ref <ref>       Override baseline ref when running comparison suite
  -h, --help                 Show this help

Examples:
  # Run suite and show results
  bun run AlgorithmBridge.ts -s regression-core

  # Run and update ISC row 3
  bun run AlgorithmBridge.ts -s regression-core -r 3 -u

  # Check saturation status
  bun run AlgorithmBridge.ts -s capability-auth --show-saturation

  # Capture baselines from pre-streamline tag
  bun run AlgorithmBridge.ts -s kaya-comparison --capture-baseline pre-streamline

  # Run comparison with specific baseline
  bun run AlgorithmBridge.ts -s kaya-comparison --baseline-ref pre-streamline
`);
    process.exit(0);
  }

  if (values['show-saturation']) {
    const status = checkSaturation(values.suite!);
    console.log(`\nSaturation Status: ${values.suite}\n`);
    console.log(`  Saturated: ${status.saturated ? '⚠️ Yes' : '✅ No'}`);
    console.log(`  Consecutive above threshold: ${status.consecutive_above_threshold}/3`);
    console.log(`  Recommendation: ${status.recommended_action}`);
    process.exit(0);
  }

  // Handle --capture-baseline: capture baselines and exit
  if (values['capture-baseline']) {
    const ref = values['capture-baseline'];
    console.log(`\nCapturing baselines for suite: ${values.suite} from ref: ${ref}\n`);
    try {
      const manifest = await captureBaselines(ref, { suite: values.suite });
      const count = Object.keys(manifest.tasks).length;
      console.log(`\n✅ Captured ${count} baselines from ${ref}`);
      process.exit(0);
    } catch (e) {
      console.error(`Error capturing baselines: ${e}`);
      process.exit(1);
    }
  }

  // Handle --baseline-ref: rewrite reference paths in comparison tasks before running
  if (values['baseline-ref']) {
    const ref = values['baseline-ref'];
    const refDir = ref.replace(/[^a-zA-Z0-9_.-]/g, '_');
    console.log(`\nUsing baseline ref: ${ref} (dir: ${refDir})\n`);

    // Rewrite will happen inside runEvalForAlgorithm via task loading
    // We modify the loaded tasks' reference paths dynamically
    const originalRunEval = runEvalForAlgorithm;
    // Store the baseline ref for the task loader to use
    process.env._BASELINE_REF_OVERRIDE = refDir;
  }

  const request: AlgorithmEvalRequest = {
    isc_row: values['isc-row'] ? parseInt(values['isc-row']) : 0,
    suite: values.suite!,
  };

  console.log(`\nRunning eval suite: ${request.suite}\n`);

  const result = await runEvalForAlgorithm(request);

  console.log(`\n${'='.repeat(50)}`);
  console.log(`\n📊 EVAL RESULT: ${result.passed ? '✅ PASSED' : '❌ FAILED'}`);
  console.log(`   Suite: ${result.suite}`);
  console.log(`   Score: ${(result.score * 100).toFixed(1)}%`);
  console.log(`   Summary: ${result.summary}`);
  console.log(`   Run ID: ${result.run_id}`);

  if (values['update-isc'] && request.isc_row > 0) {
    await updateISCWithResult(result);
    console.log(`\n   Updated ISC row ${request.isc_row}`);
  }

  process.exit(result.passed ? 0 : 1);
}
