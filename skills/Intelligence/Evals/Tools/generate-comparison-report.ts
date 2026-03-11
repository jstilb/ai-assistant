#!/usr/bin/env bun
/**
 * generate-comparison-report.ts
 *
 * Reads all eval suite definitions and their latest run results,
 * then generates a comprehensive markdown comparison report with:
 *   1. Executive Summary Table
 *   2. Per-Task Drill-Down
 *   3. Grader-Level Analysis (for failed/borderline tasks)
 *   4. Threshold Calibration Recommendations
 *   5. Dimension Coverage Summary
 *
 * Usage:
 *   bun run ~/.claude/skills/Intelligence/Evals/Tools/generate-comparison-report.ts
 */

import { parse as parseYaml } from "yaml";
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
  mkdirSync,
} from "fs";
import { join, basename } from "path";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
const EVALS_DIR = join(import.meta.dir, "..");
const SUITES_DIR = join(EVALS_DIR, "Suites", "Kaya");
const RESULTS_DIR = join(EVALS_DIR, "Results");
const USECASES_DIR = join(EVALS_DIR, "UseCases");

// ---------------------------------------------------------------------------
// Types (mirrored from Types/index.ts to keep script self-contained)
// ---------------------------------------------------------------------------
interface GraderResult {
  grader_type: string;
  weight: number;
  score: number;
  passed: boolean;
  duration_ms: number;
  reasoning?: string;
  details?: Record<string, unknown>;
}

interface Trial {
  id: string;
  task_id: string;
  trial_number: number;
  status: string;
  started_at: string;
  completed_at?: string;
  grader_results: GraderResult[];
  score: number;
  passed: boolean;
  error?: string;
}

interface EvalRun {
  id: string;
  task_id: string;
  trials: Trial[];
  n_trials: number;
  pass_rate: number;
  mean_score: number;
  std_dev: number;
  pass_at_k: number;
  pass_to_k: number;
  started_at: string;
  completed_at?: string;
  total_duration_ms: number;
}

interface EvalSuite {
  name: string;
  description: string;
  type: string;
  domain?: string;
  tasks: string[];
  pass_threshold?: number;
  saturation_threshold?: number;
}

interface TaskDef {
  id: string;
  description: string;
  type: string;
  domain: string;
  tags?: string[];
  pass_threshold?: number;
  trials?: number;
}

// ---------------------------------------------------------------------------
// Task file finder (matches AlgorithmBridge / EvalExecutor logic)
// ---------------------------------------------------------------------------
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
          const tasksSubdir = join(fullPath, "Tasks");
          if (existsSync(tasksSubdir) && statSync(tasksSubdir).isDirectory()) {
            dirs.push(tasksSubdir);
          }
        }
      } catch {
        /* skip */
      }
    }
  } catch {
    /* skip */
  }
  return dirs;
}

function findTaskFile(taskId: string): string | null {
  const candidateNames = [taskId];
  const underscoreIndex = taskId.indexOf("_");
  if (underscoreIndex > 0) {
    const withoutPrefix = taskId.slice(underscoreIndex + 1);
    candidateNames.push(`task_${withoutPrefix}`);
  }
  const searchDirs = collectSearchDirs(USECASES_DIR);
  for (const dir of searchDirs) {
    for (const name of candidateNames) {
      const path = join(dir, `${name}.yaml`);
      if (existsSync(path)) return path;
    }
  }
  return null;
}

function loadTaskDef(taskId: string): TaskDef | null {
  const path = findTaskFile(taskId);
  if (!path) return null;
  try {
    return parseYaml(readFileSync(path, "utf-8")) as TaskDef;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Result loader — find the LATEST run for a given task
// ---------------------------------------------------------------------------

/** Parse a timestamp from a run directory or file name like run_<timestamp>_<rand> */
function parseRunTimestamp(name: string): number {
  const match = name.match(/run_(\d+)/);
  return match ? parseInt(match[1], 10) : 0;
}

/**
 * Find the latest EvalRun for a task ID.
 *
 * Two storage layouts exist:
 *  A) /Results/<task_id>/run_<id>.json          (EvalExecutor)
 *  B) /Results/<suite_name>/run_<id>/run.json   (AlgorithmBridge)
 *
 * We search both and return the most recent by timestamp.
 */
function findLatestRun(taskId: string, suiteName?: string): EvalRun | null {
  const candidates: { ts: number; run: EvalRun }[] = [];

  // Layout A: /Results/<task_id>/run_*.json
  const taskDir = join(RESULTS_DIR, taskId);
  if (existsSync(taskDir)) {
    try {
      for (const file of readdirSync(taskDir)) {
        if (file.endsWith(".json") && file.startsWith("run")) {
          try {
            const run = JSON.parse(
              readFileSync(join(taskDir, file), "utf-8")
            ) as EvalRun;
            if (run.task_id === taskId) {
              candidates.push({ ts: parseRunTimestamp(run.id), run });
            }
          } catch {
            /* skip bad json */
          }
        }
      }
    } catch {
      /* skip */
    }
  }

  // Layout B: /Results/<suite_name>/run_<id>/run.json
  if (suiteName) {
    const suiteDir = join(RESULTS_DIR, suiteName);
    if (existsSync(suiteDir)) {
      try {
        for (const entry of readdirSync(suiteDir)) {
          if (!entry.startsWith("run_")) continue;
          const runJsonPath = join(suiteDir, entry, "run.json");
          if (existsSync(runJsonPath)) {
            try {
              const run = JSON.parse(
                readFileSync(runJsonPath, "utf-8")
              ) as EvalRun;
              if (run.task_id === taskId) {
                candidates.push({ ts: parseRunTimestamp(run.id), run });
              }
            } catch {
              /* skip */
            }
          }
        }
      } catch {
        /* skip */
      }
    }
  }

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.ts - a.ts);
  return candidates[0].run;
}

// ---------------------------------------------------------------------------
// Load all suites
// ---------------------------------------------------------------------------
function loadAllSuites(): EvalSuite[] {
  const suites: EvalSuite[] = [];
  if (!existsSync(SUITES_DIR)) return suites;
  for (const file of readdirSync(SUITES_DIR)) {
    if (!file.endsWith(".yaml")) continue;
    try {
      const suite = parseYaml(
        readFileSync(join(SUITES_DIR, file), "utf-8")
      ) as EvalSuite;
      suites.push(suite);
    } catch {
      /* skip */
    }
  }
  return suites;
}

// ---------------------------------------------------------------------------
// Report generation
// ---------------------------------------------------------------------------

interface SuiteReport {
  suite: EvalSuite;
  taskRuns: { taskId: string; run: EvalRun | null; taskDef: TaskDef | null }[];
  meanScore: number;
  passRate: number;
  avgPassAtK: number;
  avgPassToK: number;
  status: "pass" | "warn" | "fail";
}

function buildSuiteReport(suite: EvalSuite): SuiteReport {
  const taskRuns = suite.tasks.map((taskId) => ({
    taskId,
    run: findLatestRun(taskId, suite.name),
    taskDef: loadTaskDef(taskId),
  }));

  const runsWithData = taskRuns.filter((t) => t.run !== null);
  const threshold = suite.pass_threshold ?? 0.75;

  let totalScore = 0;
  let totalPassRate = 0;
  let totalPassAtK = 0;
  let totalPassToK = 0;

  for (const { run } of runsWithData) {
    if (!run) continue;
    totalScore += run.mean_score;
    totalPassRate += run.pass_rate;
    totalPassAtK += run.pass_at_k;
    totalPassToK += run.pass_to_k;
  }

  const count = runsWithData.length || 1;
  const meanScore = totalScore / count;
  const passRate = totalPassRate / count;
  const avgPassAtK = totalPassAtK / count;
  const avgPassToK = totalPassToK / count;

  let status: "pass" | "warn" | "fail";
  if (passRate >= threshold) {
    status = "pass";
  } else if (passRate >= threshold * 0.9) {
    status = "warn";
  } else {
    status = "fail";
  }

  return {
    suite,
    taskRuns,
    meanScore,
    passRate,
    avgPassAtK,
    avgPassToK,
    status,
  };
}

function statusIcon(status: "pass" | "warn" | "fail"): string {
  switch (status) {
    case "pass":
      return "PASS";
    case "warn":
      return "WARN";
    case "fail":
      return "FAIL";
  }
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function score3(n: number): string {
  return n.toFixed(3);
}

// ---------------------------------------------------------------------------
// Section 1: Executive Summary Table
// ---------------------------------------------------------------------------
function renderExecutiveSummary(reports: SuiteReport[]): string {
  const lines: string[] = [];
  lines.push("## Section 1: Executive Summary");
  lines.push("");
  lines.push(
    "| Suite | Tasks | Threshold | Mean Score | Pass Rate | Pass@k | Pass^k | Status |"
  );
  lines.push(
    "|-------|-------|-----------|------------|-----------|--------|--------|--------|"
  );

  for (const r of reports) {
    const threshold = r.suite.pass_threshold ?? 0.75;
    const tasksWithData = r.taskRuns.filter((t) => t.run !== null).length;
    const totalTasks = r.suite.tasks.length;
    lines.push(
      `| ${r.suite.name} | ${tasksWithData}/${totalTasks} | ${pct(threshold)} | ${score3(r.meanScore)} | ${pct(r.passRate)} | ${pct(r.avgPassAtK)} | ${pct(r.avgPassToK)} | ${statusIcon(r.status)} |`
    );
  }

  // Overall row
  const totalTasks = reports.reduce(
    (s, r) => s + r.taskRuns.filter((t) => t.run !== null).length,
    0
  );
  const totalAll = reports.reduce((s, r) => s + r.suite.tasks.length, 0);
  const overallMean =
    reports.reduce((s, r) => s + r.meanScore, 0) / (reports.length || 1);
  const overallPass =
    reports.reduce((s, r) => s + r.passRate, 0) / (reports.length || 1);
  const passCount = reports.filter((r) => r.status === "pass").length;
  const failCount = reports.filter((r) => r.status === "fail").length;
  const warnCount = reports.filter((r) => r.status === "warn").length;

  lines.push(
    `| **OVERALL** | **${totalTasks}/${totalAll}** | - | **${score3(overallMean)}** | **${pct(overallPass)}** | - | - | **${passCount}P/${warnCount}W/${failCount}F** |`
  );

  lines.push("");
  lines.push("Legend: PASS = pass_rate >= threshold, WARN = within 10% of threshold, FAIL = below threshold");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Section 2: Per-Task Drill-Down
// ---------------------------------------------------------------------------
function renderPerTaskDrillDown(reports: SuiteReport[]): string {
  const lines: string[] = [];
  lines.push("## Section 2: Per-Task Drill-Down");
  lines.push("");

  for (const r of reports) {
    lines.push(`### ${r.suite.name}`);
    lines.push("");
    lines.push(
      "| Task ID | Score (avg) | StdDev | Pass Rate | Trials | Threshold Met? |"
    );
    lines.push(
      "|---------|-------------|--------|-----------|--------|----------------|"
    );

    for (const { taskId, run, taskDef } of r.taskRuns) {
      if (!run) {
        lines.push(`| ${taskId} | - | - | - | 0 | NO DATA |`);
        continue;
      }
      const taskThreshold = taskDef?.pass_threshold ?? r.suite.pass_threshold ?? 0.75;
      const met = run.pass_rate >= taskThreshold ? "YES" : "NO";
      lines.push(
        `| ${taskId} | ${score3(run.mean_score)} | ${score3(run.std_dev)} | ${pct(run.pass_rate)} | ${run.n_trials} | ${met} |`
      );
    }
    lines.push("");
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Section 3: Grader-Level Analysis (failed or borderline < 0.8)
// ---------------------------------------------------------------------------
function renderGraderAnalysis(reports: SuiteReport[]): string {
  const lines: string[] = [];
  lines.push("## Section 3: Grader-Level Analysis");
  lines.push("");
  lines.push(
    "Detailed grader breakdown for tasks that failed or scored below 0.8."
  );
  lines.push("");

  let foundAny = false;

  for (const r of reports) {
    for (const { taskId, run } of r.taskRuns) {
      if (!run) continue;
      if (run.mean_score >= 0.8 && run.pass_rate >= (r.suite.pass_threshold ?? 0.75))
        continue;

      foundAny = true;
      lines.push(`### Task: ${taskId}`);
      lines.push(`Suite: ${r.suite.name} | Mean Score: ${score3(run.mean_score)} | Pass Rate: ${pct(run.pass_rate)}`);
      lines.push("");

      for (const trial of run.trials) {
        const trialStatus = trial.passed ? "PASS" : "FAIL";
        lines.push(
          `**Trial ${trial.trial_number}: ${trialStatus}** (score: ${score3(trial.score)})`
        );

        if (trial.grader_results.length === 0) {
          lines.push("  - No grader results recorded");
        }

        for (const gr of trial.grader_results) {
          const grStatus = gr.passed ? "PASS" : "FAIL";
          const reasonSnippet = gr.reasoning
            ? gr.reasoning.slice(0, 120).replace(/\n/g, " ")
            : "no reasoning";
          lines.push(
            `  - ${gr.grader_type} (w=${gr.weight}): ${grStatus} ${score3(gr.score)} — ${reasonSnippet}`
          );
        }
        lines.push("");
      }
    }
  }

  if (!foundAny) {
    lines.push(
      "All tasks scored >= 0.8 and met their thresholds. No detailed grader breakdown needed."
    );
    lines.push("");
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Section 4: Threshold Calibration Recommendations
// ---------------------------------------------------------------------------
function renderCalibrationRecommendations(reports: SuiteReport[]): string {
  const lines: string[] = [];
  lines.push("## Section 4: Threshold Calibration Recommendations");
  lines.push("");
  lines.push(
    "Tasks where actual mean is >20% away from threshold in either direction."
  );
  lines.push("");
  lines.push(
    "| Task | Suite | Set Threshold | Actual Mean | Gap | Recommendation |"
  );
  lines.push(
    "|------|-------|---------------|-------------|-----|----------------|"
  );

  let foundAny = false;

  for (const r of reports) {
    for (const { taskId, run, taskDef } of r.taskRuns) {
      if (!run) continue;
      const threshold =
        taskDef?.pass_threshold ?? r.suite.pass_threshold ?? 0.75;
      const gap = run.mean_score - threshold;
      const absGap = Math.abs(gap);

      if (absGap > 0.2) {
        foundAny = true;
        let recommendation: string;
        if (gap > 0.2) {
          recommendation = "Threshold too low - raise to match capability";
        } else {
          recommendation = "Threshold too high - lower or improve task";
        }
        lines.push(
          `| ${taskId} | ${r.suite.name} | ${pct(threshold)} | ${score3(run.mean_score)} | ${gap > 0 ? "+" : ""}${pct(gap)} | ${recommendation} |`
        );
      }
    }
  }

  if (!foundAny) {
    lines.push(
      "| - | - | - | - | - | All thresholds are well-calibrated (within 20%) |"
    );
  }

  lines.push("");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Section 5: Dimension Coverage Summary
// ---------------------------------------------------------------------------
function renderDimensionCoverage(reports: SuiteReport[]): string {
  const lines: string[] = [];
  lines.push("## Section 5: Dimension Coverage Summary");
  lines.push("");

  // Group tasks by tags or domain. We derive a "dimension" from the suite name
  // and from the task's tags/domain.
  interface DimensionStats {
    tasks: number;
    passing: number;
    totalScore: number;
    strongest: { taskId: string; score: number };
    weakest: { taskId: string; score: number };
  }

  const dimensions = new Map<string, DimensionStats>();

  for (const r of reports) {
    for (const { taskId, run, taskDef } of r.taskRuns) {
      // Derive dimension from tags or suite name
      const tags = taskDef?.tags ?? [];
      const domain = taskDef?.domain ?? r.suite.domain ?? "general";

      // Use the primary tag (first non-"kaya" tag) or fall back to domain
      let dimension = domain;
      for (const tag of tags) {
        if (tag !== "kaya" && tag !== "regression" && tag !== "capability") {
          dimension = tag;
          break;
        }
      }

      // Also incorporate suite-derived dimension
      // e.g., "kaya-security" -> "security", "kaya-behavioral" -> "behavioral"
      const suiteDimension = r.suite.name.replace(/^kaya-/, "");
      // Prefer the suite dimension as it is more structured
      dimension = suiteDimension;

      if (!dimensions.has(dimension)) {
        dimensions.set(dimension, {
          tasks: 0,
          passing: 0,
          totalScore: 0,
          strongest: { taskId: "", score: -1 },
          weakest: { taskId: "", score: 2 },
        });
      }

      const stats = dimensions.get(dimension)!;
      stats.tasks++;

      if (run) {
        stats.totalScore += run.mean_score;
        const threshold =
          taskDef?.pass_threshold ?? r.suite.pass_threshold ?? 0.75;
        if (run.pass_rate >= threshold) {
          stats.passing++;
        }
        if (run.mean_score > stats.strongest.score) {
          stats.strongest = { taskId, score: run.mean_score };
        }
        if (run.mean_score < stats.weakest.score) {
          stats.weakest = { taskId, score: run.mean_score };
        }
      } else {
        // No run data — counts as weakest if nothing else
        if (0 < stats.weakest.score) {
          stats.weakest = { taskId, score: 0 };
        }
      }
    }
  }

  lines.push(
    "| Dimension | Tasks | Passing | Rate | Strongest | Weakest |"
  );
  lines.push(
    "|-----------|-------|---------|------|-----------|---------|"
  );

  const sorted = [...dimensions.entries()].sort((a, b) =>
    a[0].localeCompare(b[0])
  );

  for (const [dim, stats] of sorted) {
    const rate = stats.tasks > 0 ? stats.passing / stats.tasks : 0;
    const strongest =
      stats.strongest.taskId
        ? `${stats.strongest.taskId} (${score3(stats.strongest.score)})`
        : "-";
    const weakest =
      stats.weakest.taskId
        ? `${stats.weakest.taskId} (${score3(stats.weakest.score)})`
        : "-";
    lines.push(
      `| ${dim} | ${stats.tasks} | ${stats.passing} | ${pct(rate)} | ${strongest} | ${weakest} |`
    );
  }

  lines.push("");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Manifest generation
// ---------------------------------------------------------------------------
interface RunManifest {
  generated_at: string;
  suites: {
    name: string;
    tasks: { task_id: string; run_id: string | null; mean_score: number | null }[];
  }[];
}

function buildManifest(reports: SuiteReport[]): RunManifest {
  return {
    generated_at: new Date().toISOString(),
    suites: reports.map((r) => ({
      name: r.suite.name,
      tasks: r.taskRuns.map(({ taskId, run }) => ({
        task_id: taskId,
        run_id: run?.id ?? null,
        mean_score: run?.mean_score ?? null,
      })),
    })),
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function main() {
  console.log("Loading suites from:", SUITES_DIR);
  const suites = loadAllSuites();

  if (suites.length === 0) {
    console.error("No suite YAML files found in", SUITES_DIR);
    process.exit(1);
  }

  console.log(`Found ${suites.length} suites:`);
  for (const s of suites) {
    console.log(`  - ${s.name} (${s.tasks.length} tasks, threshold: ${pct(s.pass_threshold ?? 0.75)})`);
  }

  // Build reports
  const reports = suites.map(buildSuiteReport);

  // Count data availability
  const totalTasks = reports.reduce((s, r) => s + r.suite.tasks.length, 0);
  const tasksWithData = reports.reduce(
    (s, r) => s + r.taskRuns.filter((t) => t.run !== null).length,
    0
  );
  console.log(
    `\nData coverage: ${tasksWithData}/${totalTasks} tasks have run results`
  );

  // Generate report
  const now = new Date();
  const isoDate = now.toISOString().split("T")[0];
  const timestamp = now.toISOString();

  const reportLines: string[] = [];
  reportLines.push(`# Kaya Eval Comparison Report`);
  reportLines.push("");
  reportLines.push(`**Generated:** ${timestamp}`);
  reportLines.push(`**Suites:** ${suites.length}`);
  reportLines.push(`**Tasks with data:** ${tasksWithData}/${totalTasks}`);
  reportLines.push("");
  reportLines.push("---");
  reportLines.push("");
  reportLines.push(renderExecutiveSummary(reports));
  reportLines.push("");
  reportLines.push("---");
  reportLines.push("");
  reportLines.push(renderPerTaskDrillDown(reports));
  reportLines.push("---");
  reportLines.push("");
  reportLines.push(renderGraderAnalysis(reports));
  reportLines.push("---");
  reportLines.push("");
  reportLines.push(renderCalibrationRecommendations(reports));
  reportLines.push("---");
  reportLines.push("");
  reportLines.push(renderDimensionCoverage(reports));

  const reportContent = reportLines.join("\n");

  // Save report
  if (!existsSync(RESULTS_DIR)) mkdirSync(RESULTS_DIR, { recursive: true });

  const reportPath = join(
    RESULTS_DIR,
    `comparison-report-${isoDate}.md`
  );
  writeFileSync(reportPath, reportContent);
  console.log(`\nReport saved to: ${reportPath}`);

  // Save manifests
  const manifest = buildManifest(reports);

  const currentManifestPath = join(RESULTS_DIR, "current-state-manifest.json");
  writeFileSync(currentManifestPath, JSON.stringify(manifest, null, 2));
  console.log(`Current state manifest saved to: ${currentManifestPath}`);

  // Baseline manifest: save only if it doesn't already exist (first run becomes baseline)
  const baselineManifestPath = join(RESULTS_DIR, "baseline-manifest.json");
  if (!existsSync(baselineManifestPath)) {
    writeFileSync(baselineManifestPath, JSON.stringify(manifest, null, 2));
    console.log(
      `Baseline manifest saved to: ${baselineManifestPath} (first run)`
    );
  } else {
    console.log(
      `Baseline manifest already exists at: ${baselineManifestPath} (not overwritten)`
    );
  }

  // Print summary to stdout
  console.log("\n" + "=".repeat(60));
  console.log("EXECUTIVE SUMMARY");
  console.log("=".repeat(60));
  for (const r of reports) {
    const icon =
      r.status === "pass" ? "PASS" : r.status === "warn" ? "WARN" : "FAIL";
    const threshold = r.suite.pass_threshold ?? 0.75;
    const tasksReported = r.taskRuns.filter((t) => t.run !== null).length;
    console.log(
      `  [${icon}] ${r.suite.name}: score=${score3(r.meanScore)} pass_rate=${pct(r.passRate)} (${tasksReported}/${r.suite.tasks.length} tasks, threshold=${pct(threshold)})`
    );
  }

  const overallMean =
    reports.reduce((s, r) => s + r.meanScore, 0) / (reports.length || 1);
  const overallPass =
    reports.reduce((s, r) => s + r.passRate, 0) / (reports.length || 1);
  const passingSuites = reports.filter((r) => r.status === "pass").length;
  const failingSuites = reports.filter((r) => r.status === "fail").length;
  const warningSuites = reports.filter((r) => r.status === "warn").length;

  console.log("=".repeat(60));
  console.log(
    `OVERALL: mean_score=${score3(overallMean)} pass_rate=${pct(overallPass)}`
  );
  console.log(
    `SUITES: ${passingSuites} passing, ${warningSuites} warning, ${failingSuites} failing out of ${reports.length}`
  );
  console.log("=".repeat(60));
}

main();
