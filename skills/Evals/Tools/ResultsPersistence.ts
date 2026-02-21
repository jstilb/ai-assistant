#!/usr/bin/env bun
/**
 * ResultsPersistence - Write eval results to MEMORY/VALIDATION/evals/
 *
 * Persists eval results in JSONL format:
 *   MEMORY/VALIDATION/evals/YYYY-MM-DD/{suite}-results.jsonl
 *
 * Each line is a JSON object with:
 *   timestamp, suite, eval_name, category, scores, pass_rate, pass_at_k, pass_all_k
 *
 * Usage (Library):
 *   import { persistResults, persistSuiteResults } from './ResultsPersistence.ts';
 *   await persistSuiteResults('foundation', results);
 */

import { existsSync, mkdirSync, appendFileSync } from "fs";
import { join } from "path";

// ============================================================================
// Types
// ============================================================================

export interface EvalResult {
  eval_name: string;
  category: string;
  scores: number[];
  passed: boolean[];
  grader_details: Array<{
    type: string;
    check?: string;
    score: number;
    pass: boolean;
    details: string;
  }>;
}

export interface SuiteResultEntry {
  timestamp: string;
  suite: string;
  eval_name: string;
  category: string;
  trial_scores: number[];
  pass_rate: number;
  pass_at_k: number;
  pass_all_k: number;
  grader_details: EvalResult["grader_details"];
}

export interface SuiteAggregateEntry {
  timestamp: string;
  suite: string;
  type: "aggregate";
  total_evals: number;
  passed_evals: number;
  aggregate_pass_rate: number;
  per_category: Record<
    string,
    { total: number; passed: number; pass_rate: number }
  >;
}

// ============================================================================
// Paths
// ============================================================================

const KAYA_HOME = process.env.HOME + "/.claude";
const VALIDATION_DIR = join(KAYA_HOME, "MEMORY", "VALIDATION", "evals");

/**
 * Get the results directory for today's date
 */
function getDateDir(date?: Date): string {
  const d = date || new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return join(VALIDATION_DIR, `${yyyy}-${mm}-${dd}`);
}

/**
 * Ensure the results directory exists
 */
function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

// ============================================================================
// Persistence Functions
// ============================================================================

/**
 * Persist a single eval result to the suite's JSONL file
 */
export function persistResult(
  suite: string,
  result: EvalResult,
  metrics: { pass_rate: number; pass_at_k: number; pass_all_k: number },
  date?: Date
): string {
  const dateDir = getDateDir(date);
  ensureDir(dateDir);

  const filePath = join(dateDir, `${suite}-results.jsonl`);

  const entry: SuiteResultEntry = {
    timestamp: new Date().toISOString(),
    suite,
    eval_name: result.eval_name,
    category: result.category,
    trial_scores: result.scores,
    pass_rate: metrics.pass_rate,
    pass_at_k: metrics.pass_at_k,
    pass_all_k: metrics.pass_all_k,
    grader_details: result.grader_details,
  };

  appendFileSync(filePath, JSON.stringify(entry) + "\n");
  return filePath;
}

/**
 * Persist aggregate suite results
 */
export function persistAggregateResults(
  suite: string,
  results: EvalResult[],
  date?: Date
): string {
  const dateDir = getDateDir(date);
  ensureDir(dateDir);

  const filePath = join(dateDir, `${suite}-results.jsonl`);

  // Compute per-category stats
  const perCategory: Record<
    string,
    { total: number; passed: number; pass_rate: number }
  > = {};

  for (const result of results) {
    if (!perCategory[result.category]) {
      perCategory[result.category] = { total: 0, passed: 0, pass_rate: 0 };
    }
    perCategory[result.category].total++;
    if (result.passed.every((p) => p)) {
      perCategory[result.category].passed++;
    }
  }

  // Compute pass rates
  for (const cat of Object.values(perCategory)) {
    cat.pass_rate = cat.total > 0 ? cat.passed / cat.total : 0;
  }

  const passedEvals = results.filter((r) => r.passed.every((p) => p)).length;

  const aggregate: SuiteAggregateEntry = {
    timestamp: new Date().toISOString(),
    suite,
    type: "aggregate",
    total_evals: results.length,
    passed_evals: passedEvals,
    aggregate_pass_rate:
      results.length > 0 ? passedEvals / results.length : 0,
    per_category: perCategory,
  };

  appendFileSync(filePath, JSON.stringify(aggregate) + "\n");
  return filePath;
}

/**
 * Persist all results from a full suite run
 */
export function persistSuiteResults(
  suite: string,
  results: Array<{
    eval: EvalResult;
    metrics: { pass_rate: number; pass_at_k: number; pass_all_k: number };
  }>,
  date?: Date
): string {
  let filePath = "";

  // Persist individual results
  for (const { eval: result, metrics } of results) {
    filePath = persistResult(suite, result, metrics, date);
  }

  // Persist aggregate
  const evals = results.map((r) => r.eval);
  filePath = persistAggregateResults(suite, evals, date);

  return filePath;
}

/**
 * Get the path where results would be written for a suite
 */
export function getResultsPath(suite: string, date?: Date): string {
  const dateDir = getDateDir(date);
  return join(dateDir, `${suite}-results.jsonl`);
}

// ============================================================================
// CLI Interface
// ============================================================================

if (import.meta.main) {
  const args = process.argv.slice(2);

  if (args[0] === "--help" || args[0] === "-h") {
    console.log(`
ResultsPersistence - Persist eval results to MEMORY/VALIDATION/evals/

Usage:
  bun ResultsPersistence.ts path <suite>    Show where results would be written
  bun ResultsPersistence.ts test            Write a test entry

Output:
  Results are written to MEMORY/VALIDATION/evals/YYYY-MM-DD/{suite}-results.jsonl
`);
    process.exit(0);
  }

  if (args[0] === "path") {
    const suite = args[1] || "foundation";
    console.log(getResultsPath(suite));
  } else if (args[0] === "test") {
    const testResult: EvalResult = {
      eval_name: "test-eval",
      category: "test",
      scores: [1.0],
      passed: [true],
      grader_details: [
        {
          type: "contains",
          check: "contains",
          score: 1.0,
          pass: true,
          details: "Test passed",
        },
      ],
    };

    const path = persistResult(
      "test",
      testResult,
      { pass_rate: 1.0, pass_at_k: 1.0, pass_all_k: 1.0 },
    );
    console.log(`Test result written to: ${path}`);
  }
}
