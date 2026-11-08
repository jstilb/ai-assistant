/**
 * evalStoreFixture.ts — test helpers that write synthetic eval results into a
 * JSONL store (MEMORY/VALIDATION/evals/<date>/<suite>-results.jsonl), in the
 * shape ResultsUtils reads.
 *
 * Shared by ResultsUtils.hermetic.test.ts, RegressionAlert.test.ts and
 * EvalHealthDigest.test.ts (formerly three copies). Test-only: no production
 * code imports this.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function resultLine(opts: {
  timestamp: string;
  suite: string;
  eval_name: string;
  trial_scores: number[];
  pass_rate?: number;
}): string {
  return JSON.stringify({
    timestamp: opts.timestamp,
    suite: opts.suite,
    eval_name: opts.eval_name,
    category: "kaya",
    trial_scores: opts.trial_scores,
    pass_rate: opts.pass_rate ?? 1,
    pass_at_k: 1,
    pass_all_k: 1,
    grader_details: [],
  });
}

export function aggregateLine(opts: { timestamp: string; suite: string; total_evals: number }): string {
  return JSON.stringify({
    timestamp: opts.timestamp,
    suite: opts.suite,
    type: "aggregate",
    total_evals: opts.total_evals,
    passed_evals: opts.total_evals,
    aggregate_pass_rate: 1,
    per_category: { kaya: { total: opts.total_evals, passed: opts.total_evals, pass_rate: 1 } },
  });
}

export interface EvalRunFixture {
  date: string;
  lines: string[];
}

/** One run (one result line per task) closed by an aggregate line, at `timestamp`. */
export function buildRun(
  date: string,
  suite: string,
  timestamp: string,
  tasks: Record<string, { score: number; pass_rate?: number }>,
): EvalRunFixture {
  const lines = Object.entries(tasks).map(([taskId, t]) =>
    resultLine({
      timestamp,
      suite,
      eval_name: taskId,
      trial_scores: [t.score],
      pass_rate: t.pass_rate ?? (t.score >= 0.75 ? 1 : 0),
    }),
  );
  lines.push(aggregateLine({ timestamp, suite, total_evals: lines.length }));
  return { date, lines };
}

/** File writers bound to one store root. */
export function evalStore(storeRoot: string) {
  function writeDateFile(date: string, suite: string, lines: string[]): string {
    const dir = join(storeRoot, date);
    mkdirSync(dir, { recursive: true });
    const filePath = join(dir, `${suite}-results.jsonl`);
    writeFileSync(filePath, lines.join("\n") + "\n", "utf-8");
    return filePath;
  }

  /** Write runs grouped into one results file per date. */
  function appendRuns(suite: string, runs: EvalRunFixture[]): void {
    const byDate = new Map<string, string[]>();
    for (const run of runs) {
      byDate.set(run.date, [...(byDate.get(run.date) ?? []), ...run.lines]);
    }
    for (const [date, lines] of byDate) {
      writeDateFile(date, suite, lines);
    }
  }

  return { writeDateFile, appendRuns };
}
