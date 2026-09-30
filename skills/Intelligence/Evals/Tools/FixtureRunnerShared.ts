/**
 * FixtureRunnerShared — common load/write plumbing for LIVE fixture-runner
 * scripts (CaptureRoutingFixtureRunner.ts, LearningCaptureFixtureRunner.ts;
 * a PromptClassificationFixtureRunner.ts was retired 2026-09-29).
 *
 * Each of those scripts calls a REAL classifier (a production function like
 * Router.classify(), or a live lib/core/Inference.ts call) once per fixture,
 * so the resulting accuracy record reflects actual model behavior at run
 * time — not a pre-baked static file. This module only holds the boring,
 * identical-across-all-three parts: reading a JSONL fixture file and writing
 * the JSON summary the `fixture_accuracy` grader reads.
 *
 * Three callers use this exact load/write shape (S0's capture-routing
 * and learning-capture runners; prompt-classification retired 2026-09-29) — extracting it here
 * clears the "two adapters = a real seam" bar without over-abstracting the
 * classification logic itself, which differs per runner and stays in each
 * script.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname } from 'path';

/** One fixture line from a Data/golden/*-fixtures.jsonl file. */
export interface Fixture<TExpected> {
  id: string;
  category: string;
  input: string;
  expected: TExpected;
  notes?: string;
}

/** One graded fixture result, appended to the summary's `results` array. */
export interface FixtureResult<TExpected, TActual> {
  id: string;
  category: string;
  input: string;
  expected: TExpected;
  actual: TActual;
  correct: boolean;
  /**
   * Set ONLY when the runner's live classify/inference call for this fixture
   * failed and `actual` is an error-fallback default, not a judgment —
   * machine-authored (String(e)) in the runner's catch block, never present
   * on a judged fixture. An errored fixture must also never count
   * `correct: true` (no judgment happened, so a fallback that coincidentally
   * matches `expected` is not a pass). The fixture_accuracy grader treats a
   * strict MAJORITY of these in one record as an infra-failed run (no
   * behavioral signal — see FixtureAccuracy.ts's fixture_infra_error marker,
   * S5 residual, 401-storm 2026-07-16).
   */
  infra_error?: string;
  notes?: string;
}

/** The JSON summary shape the `fixture_accuracy` grader expects at record_path. */
export interface FixtureRunSummary<TExpected, TActual> {
  task: string;
  ranAt: string;
  total: number;
  correct: number;
  accuracy: number;
  results: FixtureResult<TExpected, TActual>[];
}

/**
 * Load a JSONL fixture file. Blank lines are skipped. Throws (loudly, not
 * silently) on the first malformed line — a bad fixture file should fail the
 * whole run, not silently drop cases.
 */
export function loadFixturesJsonl<TExpected>(path: string): Fixture<TExpected>[] {
  if (!existsSync(path)) {
    throw new Error(`Fixture file not found: ${path}`);
  }
  const raw = readFileSync(path, 'utf-8');
  const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
  return lines.map((line, i) => {
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch (e) {
      throw new Error(`Fixture file ${path}: line ${i + 1} is not valid JSON: ${e}`);
    }
    const rec = obj as Record<string, unknown>;
    if (typeof rec.id !== 'string' || typeof rec.input !== 'string' || !('expected' in rec)) {
      throw new Error(`Fixture file ${path}: line ${i + 1} missing required fields (id, input, expected)`);
    }
    return {
      id: rec.id,
      category: typeof rec.category === 'string' ? rec.category : 'uncategorized',
      input: rec.input,
      expected: rec.expected as TExpected,
      notes: typeof rec.notes === 'string' ? rec.notes : undefined,
    };
  });
}

/** Build the summary object from a list of already-graded results. */
export function buildSummary<TExpected, TActual>(
  task: string,
  results: FixtureResult<TExpected, TActual>[],
): FixtureRunSummary<TExpected, TActual> {
  const correct = results.filter(r => r.correct).length;
  const total = results.length;
  return {
    task,
    ranAt: new Date().toISOString(),
    total,
    correct,
    accuracy: total > 0 ? correct / total : 0,
    results,
  };
}

/** Write the summary to `outPath`, creating parent directories as needed. */
export function writeSummary(outPath: string, summary: FixtureRunSummary<unknown, unknown>): void {
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(summary, null, 2), 'utf-8');
}

/** Parse `--fixtures <path> --out <path>` from argv (shared CLI shape). */
export function parseFixtureRunnerArgs(argv: string[]): { fixtures: string; out: string } {
  let fixtures: string | undefined;
  let out: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--fixtures') fixtures = argv[++i];
    else if (argv[i] === '--out') out = argv[++i];
  }
  if (!fixtures || !out) {
    throw new Error('Usage: --fixtures <path.jsonl> --out <path.json>');
  }
  return { fixtures, out };
}
