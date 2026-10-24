/**
 * ResultsUtils.hermetic.test.ts — regression guard for slice A4 (evals-rebuild,
 * one results store).
 *
 * Prior bug (MEMORY/SkillAudits/evals-infra-audit-2026-07-09/results.md,
 * finding #1): findSuiteRuns/loadRun read a phantom layout
 * (`Results/<dir>/results.json`) that nothing ever wrote, so
 * `RegressionAlert.ts check <suite>` always reported "Found: 0 run(s)" even
 * with real history present. The REAL store, written by
 * ResultsPersistence.ts since 2026-06-18, is
 * `MEMORY/VALIDATION/evals/<YYYY-MM-DD>/<suite>-results.jsonl` — an
 * append-only JSONL log where each suite run appends N per-task lines
 * followed by one `type: "aggregate"` line.
 *
 * pinKayaHome() is used (not a bespoke tmpdir) so KAYA_HOME/KAYA_DIR are
 * repointed AFTER this file's static imports resolve — ResultsUtils must
 * resolve the store root LAZILY at use-site (same de-freeze pattern as
 * ResultsPersistence.hermetic.test.ts), never live MEMORY/VALIDATION/evals.
 */
import { describe, it, expect, afterAll, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { findSuiteRuns, loadRun } from "./ResultsUtils.ts";
import { pinKayaHome, restoreKayaHome } from "../../../../../lib/test/pinKayaHome.ts";

const TEST_DIR = pinKayaHome("results-utils-hermetic-");
const STORE_ROOT = join(TEST_DIR, "MEMORY", "VALIDATION", "evals");

afterAll(async () => {
  await restoreKayaHome();
});

let warnSpy: ReturnType<typeof mockConsoleWarn> | null = null;

// Minimal manual console.warn capture (no bun:test mock.module needed —
// this file doesn't touch any module the rest of the suite imports).
function mockConsoleWarn() {
  const original = console.warn;
  const calls: unknown[][] = [];
  console.warn = (...args: unknown[]) => {
    calls.push(args);
  };
  return {
    calls,
    restore: () => {
      console.warn = original;
    },
  };
}

beforeEach(() => {
  // Full isolation between tests — each test writes its own STORE_ROOT
  // fixtures and must not see a prior test's dates/suites.
  rmSync(STORE_ROOT, { recursive: true, force: true });
  warnSpy = mockConsoleWarn();
});

afterEach(() => {
  warnSpy?.restore();
  warnSpy = null;
});

function writeDateFile(date: string, suite: string, lines: string[]): string {
  const dir = join(STORE_ROOT, date);
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, `${suite}-results.jsonl`);
  writeFileSync(filePath, lines.join("\n") + "\n", "utf-8");
  return filePath;
}

function resultLine(opts: {
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

function aggregateLine(opts: { timestamp: string; suite: string; total_evals: number }): string {
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

describe("ResultsUtils — real JSONL store (slice A4)", () => {
  it("returns no runs when the store directory does not exist at all", () => {
    // Nothing written under STORE_ROOT for this suite.
    const runs = findSuiteRuns("nonexistent-suite");
    expect(runs).toEqual([]);
  });

  it("finds a single run in a single date directory and loads its per-task results", () => {
    writeDateFile("2026-07-06", "kaya-pipeline-nightly", [
      resultLine({ timestamp: "2026-07-06T22:00:00.000Z", suite: "kaya-pipeline-nightly", eval_name: "task_a", trial_scores: [0.9] }),
      resultLine({ timestamp: "2026-07-06T22:00:00.001Z", suite: "kaya-pipeline-nightly", eval_name: "task_b", trial_scores: [0.8] }),
      aggregateLine({ timestamp: "2026-07-06T22:00:00.002Z", suite: "kaya-pipeline-nightly", total_evals: 2 }),
    ]);

    const runs = findSuiteRuns("kaya-pipeline-nightly");
    expect(runs.length).toBe(1);

    const results = loadRun(runs[0]);
    expect(results).toHaveLength(2);
    expect(results.map(r => r.task_id).sort()).toEqual(["task_a", "task_b"]);
    const a = results.find(r => r.task_id === "task_a");
    expect(a?.mean_score).toBeCloseTo(0.9, 6);
  });

  it("sorts runs across multiple date directories most-recent-first", () => {
    writeDateFile("2026-07-06", "kaya-pipeline-nightly", [
      resultLine({ timestamp: "2026-07-06T22:00:00.000Z", suite: "kaya-pipeline-nightly", eval_name: "task_a", trial_scores: [0.5] }),
      aggregateLine({ timestamp: "2026-07-06T22:00:00.001Z", suite: "kaya-pipeline-nightly", total_evals: 1 }),
    ]);
    writeDateFile("2026-07-09", "kaya-pipeline-nightly", [
      resultLine({ timestamp: "2026-07-09T22:00:00.000Z", suite: "kaya-pipeline-nightly", eval_name: "task_a", trial_scores: [0.6] }),
      aggregateLine({ timestamp: "2026-07-09T22:00:00.001Z", suite: "kaya-pipeline-nightly", total_evals: 1 }),
    ]);
    writeDateFile("2026-07-07", "kaya-pipeline-nightly", [
      resultLine({ timestamp: "2026-07-07T22:00:00.000Z", suite: "kaya-pipeline-nightly", eval_name: "task_a", trial_scores: [0.55] }),
      aggregateLine({ timestamp: "2026-07-07T22:00:00.001Z", suite: "kaya-pipeline-nightly", total_evals: 1 }),
    ]);

    const runs = findSuiteRuns("kaya-pipeline-nightly");
    expect(runs.length).toBe(3);

    // Most recent (07-09) first.
    const first = loadRun(runs[0]);
    expect(first[0].mean_score).toBeCloseTo(0.6, 6);
    const last = loadRun(runs[2]);
    expect(last[0].mean_score).toBeCloseTo(0.5, 6);
  });

  it("handles multiple runs appended to the same date's file (e.g. a re-run same day)", () => {
    writeDateFile("2026-07-10", "kaya-pipeline-nightly", [
      resultLine({ timestamp: "2026-07-10T09:24:56.500Z", suite: "kaya-pipeline-nightly", eval_name: "task_a", trial_scores: [1.0] }),
      aggregateLine({ timestamp: "2026-07-10T09:24:56.531Z", suite: "kaya-pipeline-nightly", total_evals: 1 }),
      resultLine({ timestamp: "2026-07-10T22:21:49.100Z", suite: "kaya-pipeline-nightly", eval_name: "task_a", trial_scores: [0.4] }),
      aggregateLine({ timestamp: "2026-07-10T22:21:49.207Z", suite: "kaya-pipeline-nightly", total_evals: 1 }),
    ]);

    const runs = findSuiteRuns("kaya-pipeline-nightly");
    expect(runs.length).toBe(2);

    // Newest (evening) run first.
    expect(loadRun(runs[0])[0].mean_score).toBeCloseTo(0.4, 6);
    expect(loadRun(runs[1])[0].mean_score).toBeCloseTo(1.0, 6);
  });

  it("respects the limit parameter, returning the N most recent runs", () => {
    writeDateFile("2026-07-10", "kaya-pipeline-nightly", [
      resultLine({ timestamp: "2026-07-10T01:00:00.000Z", suite: "kaya-pipeline-nightly", eval_name: "task_a", trial_scores: [0.1] }),
      aggregateLine({ timestamp: "2026-07-10T01:00:00.100Z", suite: "kaya-pipeline-nightly", total_evals: 1 }),
      resultLine({ timestamp: "2026-07-10T02:00:00.000Z", suite: "kaya-pipeline-nightly", eval_name: "task_a", trial_scores: [0.2] }),
      aggregateLine({ timestamp: "2026-07-10T02:00:00.100Z", suite: "kaya-pipeline-nightly", total_evals: 1 }),
      resultLine({ timestamp: "2026-07-10T03:00:00.000Z", suite: "kaya-pipeline-nightly", eval_name: "task_a", trial_scores: [0.3] }),
      aggregateLine({ timestamp: "2026-07-10T03:00:00.100Z", suite: "kaya-pipeline-nightly", total_evals: 1 }),
    ]);

    const runs = findSuiteRuns("kaya-pipeline-nightly", 2);
    expect(runs.length).toBe(2);
    expect(loadRun(runs[0])[0].mean_score).toBeCloseTo(0.3, 6);
    expect(loadRun(runs[1])[0].mean_score).toBeCloseTo(0.2, 6);
  });

  it("computes mean_score as the average across multiple trial_scores", () => {
    writeDateFile("2026-07-10", "multi-trial-suite", [
      resultLine({ timestamp: "2026-07-10T05:00:00.000Z", suite: "multi-trial-suite", eval_name: "task_x", trial_scores: [0.8, 1.0, 0.6] }),
      aggregateLine({ timestamp: "2026-07-10T05:00:00.100Z", suite: "multi-trial-suite", total_evals: 1 }),
    ]);

    const runs = findSuiteRuns("multi-trial-suite");
    const results = loadRun(runs[0]);
    expect(results[0].mean_score).toBeCloseTo(0.8, 6);
  });

  it("excludes the aggregate line's own fields from the per-task results array", () => {
    writeDateFile("2026-07-10", "agg-shape-suite", [
      resultLine({ timestamp: "2026-07-10T06:00:00.000Z", suite: "agg-shape-suite", eval_name: "task_only", trial_scores: [0.7] }),
      aggregateLine({ timestamp: "2026-07-10T06:00:00.100Z", suite: "agg-shape-suite", total_evals: 1 }),
    ]);

    const runs = findSuiteRuns("agg-shape-suite");
    const results = loadRun(runs[0]);
    expect(results).toHaveLength(1);
    expect(results[0].task_id).toBe("task_only");
    // No stray "total_evals"/"aggregate_pass_rate"-shaped entry.
    expect(results.every(r => "task_id" in r)).toBe(true);
  });

  it("does not pick up a different suite's file living in the same date directory", () => {
    writeDateFile("2026-07-10", "suite-one", [
      resultLine({ timestamp: "2026-07-10T07:00:00.000Z", suite: "suite-one", eval_name: "s1_task", trial_scores: [0.5] }),
      aggregateLine({ timestamp: "2026-07-10T07:00:00.100Z", suite: "suite-one", total_evals: 1 }),
    ]);
    writeDateFile("2026-07-10", "suite-two", [
      resultLine({ timestamp: "2026-07-10T07:05:00.000Z", suite: "suite-two", eval_name: "s2_task", trial_scores: [0.9] }),
      aggregateLine({ timestamp: "2026-07-10T07:05:00.100Z", suite: "suite-two", total_evals: 1 }),
    ]);

    const runs = findSuiteRuns("suite-one");
    expect(runs.length).toBe(1);
    expect(loadRun(runs[0]).map(r => r.task_id)).toEqual(["s1_task"]);
  });

  it("skips a malformed JSONL line, warns loudly naming file and line number, and still returns the valid lines", () => {
    const filePath = writeDateFile("2026-07-10", "malformed-suite", [
      resultLine({ timestamp: "2026-07-10T08:00:00.000Z", suite: "malformed-suite", eval_name: "good_task_1", trial_scores: [0.7] }),
      "{not valid json at all",
      resultLine({ timestamp: "2026-07-10T08:00:00.200Z", suite: "malformed-suite", eval_name: "good_task_2", trial_scores: [0.3] }),
      aggregateLine({ timestamp: "2026-07-10T08:00:00.300Z", suite: "malformed-suite", total_evals: 2 }),
    ]);

    const runs = findSuiteRuns("malformed-suite");
    const results = loadRun(runs[0]);

    expect(results.map(r => r.task_id).sort()).toEqual(["good_task_1", "good_task_2"]);

    const warnedText = (warnSpy?.calls ?? []).map(c => c.join(" ")).join("\n");
    expect(warnedText).toContain(filePath);
    // Line 2 (1-indexed) is the malformed line.
    expect(warnedText).toMatch(/:2\b/);
  });

  it("surfaces trailing per-task lines with no closing aggregate as an incomplete run, with a loud warning, instead of silently dropping them", () => {
    writeDateFile("2026-07-10", "crashed-suite", [
      resultLine({ timestamp: "2026-07-10T09:00:00.000Z", suite: "crashed-suite", eval_name: "orphan_task", trial_scores: [0.5] }),
      // No aggregate line — simulates a run that crashed mid-write.
    ]);

    const runs = findSuiteRuns("crashed-suite");
    expect(runs.length).toBe(1);

    const results = loadRun(runs[0]);
    expect(results.map(r => r.task_id)).toEqual(["orphan_task"]);

    const warnedText = (warnSpy?.calls ?? []).map(c => c.join(" ")).join("\n");
    expect(warnedText.toLowerCase()).toContain("aggregate");
  });

  it("loadRun throws a clear error for an unknown/malformed run id", () => {
    expect(() => loadRun("/nonexistent/path::2026-07-10T00:00:00.000Z")).toThrow();
  });
});
