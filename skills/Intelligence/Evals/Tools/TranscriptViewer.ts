#!/usr/bin/env bun
/**
 * TranscriptViewer.ts
 *
 * CLI tool for browsing and reviewing eval transcripts.
 *
 * Commands:
 *   list   [--task <id>] [--status pass|fail] [--sort score|time]
 *   view   <task-id> [--trial <n>] [--format summary|detail]
 *   summary [--last <n>]
 *
 * Usage:
 *   bun TranscriptViewer.ts list --status fail --sort score
 *   bun TranscriptViewer.ts view kaya_full_format_compliance --trial 1 --format detail
 *   bun TranscriptViewer.ts summary --last 20
 */

import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join, basename } from "path";
import { parseArgs } from "util";
import type { EvalRun, Trial, GraderResult, Transcript, ToolCall } from "../Types/index.ts";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
const EVALS_DIR = join(import.meta.dir, "..");
const RESULTS_DIR = join(EVALS_DIR, "Results");
const TRANSCRIPTS_DIR = join(EVALS_DIR, "Transcripts");

// ---------------------------------------------------------------------------
// Terminal formatting helpers
// ---------------------------------------------------------------------------
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const WHITE = "\x1b[37m";

function pad(str: string, len: number, align: "left" | "right" = "left"): string {
  const stripped = stripAnsi(str);
  const diff = len - stripped.length;
  if (diff <= 0) return str;
  const padding = " ".repeat(diff);
  return align === "right" ? padding + str : str + padding;
}

function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*m/g, "");
}

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 1) + "\u2026";
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60_000);
  const secs = ((ms % 60_000) / 1000).toFixed(0);
  return `${mins}m${secs}s`;
}

function statusBadge(passed: boolean): string {
  return passed ? `${GREEN}PASS${RESET}` : `${RED}FAIL${RESET}`;
}

function scoreColor(score: number): string {
  if (score >= 0.8) return GREEN;
  if (score >= 0.5) return YELLOW;
  return RED;
}

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

/** Find the latest run file in a task's results directory */
function findLatestRun(taskDir: string): string | null {
  if (!existsSync(taskDir) || !statSync(taskDir).isDirectory()) return null;

  const files = readdirSync(taskDir)
    .filter((f) => f.startsWith("run_") && f.endsWith(".json"))
    .sort();

  if (files.length === 0) return null;
  return join(taskDir, files[files.length - 1]);
}

/** Load an EvalRun from a JSON file path */
function loadRun(filePath: string): EvalRun | null {
  try {
    const raw = readFileSync(filePath, "utf-8");
    return JSON.parse(raw) as EvalRun;
  } catch {
    return null;
  }
}

/** Get all task IDs from the Results directory */
function getAllTaskIds(): string[] {
  if (!existsSync(RESULTS_DIR)) return [];
  return readdirSync(RESULTS_DIR)
    .filter((entry) => {
      const fullPath = join(RESULTS_DIR, entry);
      try {
        return statSync(fullPath).isDirectory();
      } catch {
        return false;
      }
    })
    .sort();
}

/** Load latest run for each task, optionally filtered */
function loadAllLatestRuns(filterTaskId?: string): Array<{ taskId: string; run: EvalRun; filePath: string }> {
  const taskIds = filterTaskId ? [filterTaskId] : getAllTaskIds();
  const results: Array<{ taskId: string; run: EvalRun; filePath: string }> = [];

  for (const taskId of taskIds) {
    const taskDir = join(RESULTS_DIR, taskId);
    const latestPath = findLatestRun(taskDir);
    if (!latestPath) continue;
    const run = loadRun(latestPath);
    if (run) {
      results.push({ taskId, run, filePath: latestPath });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Tool call sequence extraction
// ---------------------------------------------------------------------------

/** Extract unique ordered tool names from a trial's transcript */
function extractToolSequence(trial: Trial): string[] {
  const transcript = trial.transcript;
  if (!transcript?.tool_calls || transcript.tool_calls.length === 0) return [];

  return transcript.tool_calls.map((tc: ToolCall) => {
    // Shorten common tool names for readability
    const name = tc.name;
    if (name.startsWith("mcp__")) {
      const parts = name.split("__");
      return parts[parts.length - 1];
    }
    return name;
  });
}

/** Format tool names as arrow sequence, deduplicating consecutive same tools */
function formatToolSequence(tools: string[], maxWidth: number = 50): string {
  if (tools.length === 0) return `${DIM}(none)${RESET}`;

  // Deduplicate consecutive identical tools
  const deduped: Array<{ name: string; count: number }> = [];
  for (const tool of tools) {
    const last = deduped[deduped.length - 1];
    if (last && last.name === tool) {
      last.count++;
    } else {
      deduped.push({ name: tool, count: 1 });
    }
  }

  const parts = deduped.map((t) => (t.count > 1 ? `${t.name}x${t.count}` : t.name));
  const full = parts.join(" \u2192 ");
  return truncate(full, maxWidth);
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function cmdList(options: { task?: string; status?: string; sort?: string }): void {
  const allRuns = loadAllLatestRuns(options.task);

  if (allRuns.length === 0) {
    console.log("No results found.");
    return;
  }

  // Filter by status
  let filtered = allRuns;
  if (options.status === "pass") {
    filtered = filtered.filter((r) => r.run.pass_rate === 1);
  } else if (options.status === "fail") {
    filtered = filtered.filter((r) => r.run.pass_rate < 1);
  }

  // Sort
  if (options.sort === "score") {
    filtered.sort((a, b) => a.run.mean_score - b.run.mean_score);
  } else {
    // Default: sort by time (started_at)
    filtered.sort((a, b) => {
      const ta = new Date(a.run.started_at).getTime();
      const tb = new Date(b.run.started_at).getTime();
      return tb - ta;
    });
  }

  if (filtered.length === 0) {
    console.log(`No results matching status="${options.status ?? "all"}".`);
    return;
  }

  // Column widths
  const COL_TASK = 45;
  const COL_STATUS = 6;
  const COL_SCORE = 7;
  const COL_TOOLS = 50;
  const COL_TURNS = 7;
  const COL_TIME = 9;

  // Header
  const header =
    `${BOLD}${pad("TASK ID", COL_TASK)}  ${pad("STATUS", COL_STATUS)}  ${pad("SCORE", COL_SCORE, "right")}  ${pad("TOOL SEQUENCE", COL_TOOLS)}  ${pad("TURNS", COL_TURNS, "right")}  ${pad("WALL TIME", COL_TIME, "right")}${RESET}`;
  console.log(header);
  console.log("\u2500".repeat(stripAnsi(header).length));

  for (const entry of filtered) {
    const { run } = entry;
    const firstTrial = run.trials[0];
    const toolSeq = firstTrial ? extractToolSequence(firstTrial) : [];
    const nTurns = firstTrial?.transcript?.metrics?.n_turns ?? 0;
    const wallTime = run.total_duration_ms;
    const passed = run.pass_rate === 1;

    const sc = scoreColor(run.mean_score);
    const scoreStr = `${sc}${run.mean_score.toFixed(2)}${RESET}`;

    const row = [
      pad(truncate(entry.taskId, COL_TASK), COL_TASK),
      pad(statusBadge(passed), COL_STATUS + (statusBadge(passed).length - stripAnsi(statusBadge(passed)).length)),
      pad(scoreStr, COL_SCORE + (scoreStr.length - stripAnsi(scoreStr).length), "right"),
      pad(formatToolSequence(toolSeq, COL_TOOLS), COL_TOOLS),
      pad(String(nTurns), COL_TURNS, "right"),
      pad(formatMs(wallTime), COL_TIME, "right"),
    ].join("  ");

    console.log(row);
  }

  console.log(`\n${DIM}${filtered.length} task(s) shown.${RESET}`);
}

function cmdView(taskId: string, options: { trial?: number; format?: string }): void {
  const taskDir = join(RESULTS_DIR, taskId);
  const latestPath = findLatestRun(taskDir);

  if (!latestPath) {
    console.log(`No results found for task "${taskId}".`);
    return;
  }

  const run = loadRun(latestPath);
  if (!run) {
    console.log(`Failed to load results for task "${taskId}".`);
    return;
  }

  // Select trial
  const trialIdx = options.trial !== undefined ? options.trial - 1 : 0;
  const trial = run.trials[trialIdx];
  if (!trial) {
    console.log(`Trial ${(options.trial ?? 1)} not found. Available: 1-${run.trials.length}`);
    return;
  }

  const fmt = options.format ?? "summary";

  if (fmt === "summary") {
    printTrialSummary(taskId, run, trial);
  } else if (fmt === "detail") {
    printTrialDetail(taskId, run, trial);
  } else {
    console.log(`Unknown format "${fmt}". Use "summary" or "detail".`);
  }
}

function printTrialSummary(taskId: string, run: EvalRun, trial: Trial): void {
  const transcript = trial.transcript;
  const tools = extractToolSequence(trial);

  console.log(`${BOLD}${CYAN}Task:${RESET}    ${taskId}`);
  console.log(`${BOLD}${CYAN}Trial:${RESET}   ${trial.trial_number} of ${run.n_trials}`);
  console.log(`${BOLD}${CYAN}Status:${RESET}  ${statusBadge(trial.passed)}`);
  console.log(`${BOLD}${CYAN}Score:${RESET}   ${scoreColor(trial.score)}${trial.score.toFixed(3)}${RESET}`);
  console.log(`${BOLD}${CYAN}Tools:${RESET}   ${formatToolSequence(tools, 80)}`);
  console.log(`${BOLD}${CYAN}Turns:${RESET}   ${transcript?.metrics?.n_turns ?? 0}`);
  console.log(`${BOLD}${CYAN}Tokens:${RESET}  ${formatTokens(transcript?.metrics)}`);
  console.log(`${BOLD}${CYAN}Time:${RESET}    ${formatMs(run.total_duration_ms)}`);
  console.log();

  // Grader results summary table
  if (trial.grader_results && trial.grader_results.length > 0) {
    console.log(`${BOLD}Grader Results:${RESET}`);
    const COL_TYPE = 30;
    const COL_PASS = 6;
    const COL_GSCORE = 7;
    const COL_WEIGHT = 8;

    console.log(
      `  ${pad("GRADER", COL_TYPE)}  ${pad("PASS", COL_PASS)}  ${pad("SCORE", COL_GSCORE, "right")}  ${pad("WEIGHT", COL_WEIGHT, "right")}`
    );
    console.log(`  ${"─".repeat(COL_TYPE + COL_PASS + COL_GSCORE + COL_WEIGHT + 6)}`);

    for (const gr of trial.grader_results) {
      const sc = scoreColor(gr.score);
      console.log(
        `  ${pad(gr.grader_type, COL_TYPE)}  ${pad(statusBadge(gr.passed), COL_PASS + (statusBadge(gr.passed).length - stripAnsi(statusBadge(gr.passed)).length))}  ${pad(`${sc}${gr.score.toFixed(2)}${RESET}`, COL_GSCORE + (`${sc}${gr.score.toFixed(2)}${RESET}`.length - stripAnsi(`${sc}${gr.score.toFixed(2)}${RESET}`).length), "right")}  ${pad(gr.weight.toFixed(1), COL_WEIGHT, "right")}`
      );
    }
  }

  if (trial.error) {
    console.log(`\n${RED}${BOLD}Error:${RESET} ${trial.error}`);
  }
}

function printTrialDetail(taskId: string, run: EvalRun, trial: Trial): void {
  // Print summary section first
  printTrialSummary(taskId, run, trial);

  const transcript = trial.transcript;

  // Conversation turns
  if (transcript?.turns && transcript.turns.length > 0) {
    console.log(`\n${"═".repeat(80)}`);
    console.log(`${BOLD}Conversation Turns${RESET}`);
    console.log(`${"═".repeat(80)}`);

    for (const turn of transcript.turns) {
      const roleColor = turn.role === "user" ? CYAN : turn.role === "assistant" ? GREEN : YELLOW;
      const roleLabel = turn.role.toUpperCase();
      const timestamp = turn.timestamp ? `${DIM}${new Date(turn.timestamp).toLocaleTimeString()}${RESET}` : "";

      console.log(`\n${roleColor}${BOLD}[${roleLabel}]${RESET} ${timestamp}`);
      console.log(`${"─".repeat(60)}`);

      // Print content, indenting each line
      const lines = turn.content.split("\n");
      for (const line of lines) {
        console.log(`  ${line}`);
      }
    }
  }

  // Grader reasoning detail
  if (trial.grader_results && trial.grader_results.length > 0) {
    console.log(`\n${"═".repeat(80)}`);
    console.log(`${BOLD}Grader Details${RESET}`);
    console.log(`${"═".repeat(80)}`);

    for (const gr of trial.grader_results) {
      console.log(`\n${BOLD}${gr.grader_type}${RESET}  ${statusBadge(gr.passed)}  score=${scoreColor(gr.score)}${gr.score.toFixed(3)}${RESET}  weight=${gr.weight}  ${DIM}${formatMs(gr.duration_ms)}${RESET}`);

      if (gr.reasoning) {
        console.log(`  ${BOLD}Reasoning:${RESET}`);
        const reasonLines = gr.reasoning.split("\n");
        for (const line of reasonLines) {
          console.log(`    ${line}`);
        }
      }

      if (gr.details && Object.keys(gr.details).length > 0) {
        console.log(`  ${BOLD}Details:${RESET}`);
        for (const [key, val] of Object.entries(gr.details)) {
          const valStr = typeof val === "object" ? JSON.stringify(val) : String(val);
          console.log(`    ${DIM}${key}:${RESET} ${truncate(valStr, 100)}`);
        }
      }
    }
  }
}

function formatTokens(metrics: Transcript["metrics"] | undefined): string {
  if (!metrics) return "N/A";
  const total = metrics.total_tokens;
  const inp = metrics.input_tokens;
  const out = metrics.output_tokens;
  if (total === 0 && inp === 0 && out === 0) return `${DIM}0${RESET}`;
  return `${total.toLocaleString()} (in: ${inp.toLocaleString()}, out: ${out.toLocaleString()})`;
}

function cmdSummary(options: { last?: number }): void {
  const limit = options.last ?? 10;
  const taskIds = getAllTaskIds();

  if (taskIds.length === 0) {
    console.log("No results found.");
    return;
  }

  // Collect latest runs, sorted by start time descending, take last N
  const allEntries: Array<{ taskId: string; run: EvalRun }> = [];
  for (const taskId of taskIds) {
    const taskDir = join(RESULTS_DIR, taskId);
    const latestPath = findLatestRun(taskDir);
    if (!latestPath) continue;
    const run = loadRun(latestPath);
    if (run) {
      allEntries.push({ taskId, run });
    }
  }

  // Sort by started_at descending and take last N
  allEntries.sort((a, b) => {
    const ta = new Date(a.run.started_at).getTime();
    const tb = new Date(b.run.started_at).getTime();
    return tb - ta;
  });
  const recent = allEntries.slice(0, limit);

  if (recent.length === 0) {
    console.log("No results found.");
    return;
  }

  // Aggregate stats
  const totalTasks = recent.length;
  const passedTasks = recent.filter((e) => e.run.pass_rate === 1).length;
  const failedTasks = totalTasks - passedTasks;
  const overallPassRate = passedTasks / totalTasks;
  const meanScore = recent.reduce((sum, e) => sum + e.run.mean_score, 0) / totalTasks;

  console.log(`${BOLD}${CYAN}Eval Summary${RESET} ${DIM}(last ${recent.length} tasks)${RESET}`);
  console.log(`${"═".repeat(50)}`);
  console.log(`${BOLD}Total Tasks:${RESET}   ${totalTasks}`);
  console.log(`${BOLD}Passed:${RESET}        ${GREEN}${passedTasks}${RESET}`);
  console.log(`${BOLD}Failed:${RESET}        ${failedTasks > 0 ? RED : WHITE}${failedTasks}${RESET}`);
  console.log(`${BOLD}Pass Rate:${RESET}     ${scoreColor(overallPassRate)}${(overallPassRate * 100).toFixed(1)}%${RESET}`);
  console.log(`${BOLD}Mean Score:${RESET}    ${scoreColor(meanScore)}${meanScore.toFixed(3)}${RESET}`);

  // Most common failures
  const failures = recent.filter((e) => e.run.pass_rate < 1);
  if (failures.length > 0) {
    console.log(`\n${BOLD}${RED}Failed Tasks:${RESET}`);

    // Collect failing grader types across all failing trials
    const graderFailCounts = new Map<string, number>();
    for (const entry of failures) {
      for (const trial of entry.run.trials) {
        if (!trial.passed) {
          for (const gr of trial.grader_results) {
            if (!gr.passed) {
              graderFailCounts.set(gr.grader_type, (graderFailCounts.get(gr.grader_type) ?? 0) + 1);
            }
          }
        }
      }
    }

    for (const entry of failures) {
      const failingGraders = new Set<string>();
      for (const trial of entry.run.trials) {
        if (!trial.passed) {
          for (const gr of trial.grader_results) {
            if (!gr.passed) {
              failingGraders.add(gr.grader_type);
            }
          }
        }
      }
      const graderList = [...failingGraders].join(", ");
      console.log(`  ${RED}\u2718${RESET} ${entry.taskId}  ${DIM}[${graderList}]${RESET}`);
    }

    // Top failing grader types
    const sortedGraderFails = [...graderFailCounts.entries()].sort((a, b) => b[1] - a[1]);
    if (sortedGraderFails.length > 0) {
      console.log(`\n${BOLD}Most Common Failure Graders:${RESET}`);
      for (const [graderType, count] of sortedGraderFails.slice(0, 5)) {
        console.log(`  ${YELLOW}${count}x${RESET} ${graderType}`);
      }
    }
  }

  // Top tool sequences (from all recent passing trials)
  const sequenceCounts = new Map<string, number>();
  for (const entry of recent) {
    for (const trial of entry.run.trials) {
      const tools = extractToolSequence(trial);
      if (tools.length > 0) {
        const key = formatToolSequence(tools, 120);
        sequenceCounts.set(key, (sequenceCounts.get(key) ?? 0) + 1);
      }
    }
  }

  if (sequenceCounts.size > 0) {
    const sortedSeqs = [...sequenceCounts.entries()].sort((a, b) => b[1] - a[1]);
    console.log(`\n${BOLD}Top Tool Sequences:${RESET}`);
    for (const [seq, count] of sortedSeqs.slice(0, 5)) {
      console.log(`  ${CYAN}${count}x${RESET} ${seq}`);
    }
  }

  console.log();
}

// ---------------------------------------------------------------------------
// CLI Argument Parsing
// ---------------------------------------------------------------------------

function printUsage(): void {
  console.log(`${BOLD}TranscriptViewer${RESET} - Browse and review eval transcripts\n`);
  console.log(`${BOLD}Usage:${RESET}`);
  console.log(`  bun TranscriptViewer.ts list   [--task <id>] [--status pass|fail] [--sort score|time]`);
  console.log(`  bun TranscriptViewer.ts view   <task-id> [--trial <n>] [--format summary|detail]`);
  console.log(`  bun TranscriptViewer.ts summary [--last <n>]\n`);
  console.log(`${BOLD}Commands:${RESET}`);
  console.log(`  list      Show a table of all transcripts`);
  console.log(`  view      View details of a specific task/trial`);
  console.log(`  summary   Aggregate stats across recent runs`);
}

function main(): void {
  const { values, positionals } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      task: { type: "string" },
      status: { type: "string" },
      sort: { type: "string" },
      trial: { type: "string" },
      format: { type: "string" },
      last: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: true,
    strict: false,
  });

  if (values.help || positionals.length === 0) {
    printUsage();
    process.exit(0);
  }

  const command = positionals[0];

  switch (command) {
    case "list": {
      const statusOpt = values.status as string | undefined;
      if (statusOpt && statusOpt !== "pass" && statusOpt !== "fail") {
        console.error(`Invalid --status value: "${statusOpt}". Use "pass" or "fail".`);
        process.exit(1);
      }
      const sortOpt = values.sort as string | undefined;
      if (sortOpt && sortOpt !== "score" && sortOpt !== "time") {
        console.error(`Invalid --sort value: "${sortOpt}". Use "score" or "time".`);
        process.exit(1);
      }
      cmdList({
        task: values.task as string | undefined,
        status: statusOpt,
        sort: sortOpt,
      });
      break;
    }

    case "view": {
      const taskId = positionals[1];
      if (!taskId) {
        console.error("Missing <task-id>. Usage: bun TranscriptViewer.ts view <task-id>");
        process.exit(1);
      }
      const trialNum = values.trial ? parseInt(values.trial as string, 10) : undefined;
      if (trialNum !== undefined && (isNaN(trialNum) || trialNum < 1)) {
        console.error(`Invalid --trial value: "${values.trial}". Must be a positive integer.`);
        process.exit(1);
      }
      const formatOpt = (values.format as string | undefined) ?? "summary";
      if (formatOpt !== "summary" && formatOpt !== "detail") {
        console.error(`Invalid --format value: "${formatOpt}". Use "summary" or "detail".`);
        process.exit(1);
      }
      cmdView(taskId, { trial: trialNum, format: formatOpt });
      break;
    }

    case "summary": {
      const lastN = values.last ? parseInt(values.last as string, 10) : undefined;
      if (lastN !== undefined && (isNaN(lastN) || lastN < 1)) {
        console.error(`Invalid --last value: "${values.last}". Must be a positive integer.`);
        process.exit(1);
      }
      cmdSummary({ last: lastN });
      break;
    }

    default:
      console.error(`Unknown command: "${command}"`);
      printUsage();
      process.exit(1);
  }
}

main();
