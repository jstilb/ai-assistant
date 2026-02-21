#!/usr/bin/env bun
/**
 * HabitTrackingBlock.ts - Habit tracking data for daily briefing
 *
 * Reads from the habit_building Google Sheet via kaya-cli to extract:
 * - Daily habit completion data
 * - 7-day rolling averages per habit
 * - Progress bars and color-coded status
 */

import { join } from "path";
import type { BlockResult } from "./types.ts";

const KAYA_HOME = process.env.KAYA_DIR || join(process.env.HOME!, ".claude");
const KAYA_CLI = join(KAYA_HOME, "bin", "kaya-cli");

export type { BlockResult };

// DTR sheet configuration
const HABIT_SHEET_ID = "1xrGAGvKlgckHbjnMevs9ZhlwtNWaUL5CzzgRQ82X9LA";
const HABIT_RANGE = "A1:AM50";

interface HabitRow {
  name: string;
  completions: boolean[];
  rollingAvg: number;
  status: "green" | "yellow" | "red";
}

export interface HabitTrackingBlockConfig {
  rollingDays?: number;
  maxHabits?: number;
}

/**
 * Generate a text progress bar.
 * e.g. [========--] 80%
 */
function progressBar(percentage: number, width: number = 10): string {
  const filled = Math.round((percentage / 100) * width);
  const empty = width - filled;
  return `[${"=".repeat(filled)}${"-".repeat(empty)}] ${Math.round(percentage)}%`;
}

/**
 * Determine color status based on percentage threshold.
 */
function getStatus(percentage: number): "green" | "yellow" | "red" {
  if (percentage > 70) return "green";
  if (percentage >= 40) return "yellow";
  return "red";
}

/**
 * Get status icon for markdown display.
 */
function statusIcon(status: "green" | "yellow" | "red"): string {
  switch (status) {
    case "green": return "🟢";
    case "yellow": return "🟡";
    case "red": return "🔴";
  }
}

/**
 * Read sheet data via kaya-cli sheets read using Bun.spawn.
 * Returns parsed rows as string[][].
 */
async function readSheet(sheetId: string, range: string): Promise<string[][]> {
  const proc = Bun.spawn([KAYA_CLI, "sheets", "read", sheetId, range, "--json"], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    throw new Error(`kaya-cli sheets read failed: ${stderr.trim() || `exit code ${exitCode}`}`);
  }

  const trimmed = stdout.trim();
  if (!trimmed) return [];

  // Try JSON parse first (kaya-cli may return JSON array)
  if (trimmed.startsWith("[")) {
    try {
      return JSON.parse(trimmed) as string[][];
    } catch {
      // Fall through to TSV parsing
    }
  }

  // Parse as TSV/CSV
  return trimmed.split("\n").map((line) => line.split("\t"));
}

/**
 * Parse habit data from sheet rows.
 * Actual format: Row 1 = headers (Habit, Total Consistency, 4-wk Rolling Consistency, dates...)
 * Rows 2+: habit name, total %, 4-wk rolling %, then weekly counts (0-7 days per week)
 */
function parseHabitRows(rows: string[][], rollingDays: number): HabitRow[] {
  if (rows.length < 2) return [];

  const headers = rows[0]!;
  const habits: HabitRow[] = [];

  // Detect column layout: check for pre-calculated consistency columns
  const hasPreCalc = headers.length >= 3 &&
    (headers[1] || "").toLowerCase().includes("consistency");

  // Daily data starts at col D (index 3) when pre-calc columns exist, col B (index 1) otherwise
  const dataStart = hasPreCalc ? 3 : 1;

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i]!;
    if (!row[0] || !row[0].trim()) continue;

    const name = row[0].trim();

    // Parse daily TRUE/FALSE/1/0 values from the data columns
    const allValues: boolean[] = [];
    for (let j = dataStart; j < row.length; j++) {
      const val = (row[j] || "").trim().toLowerCase();
      if (val === "") continue; // skip empty trailing cells
      allValues.push(val === "true" || val === "1" || val === "yes" || val === "x");
    }

    const recentValues = allValues.slice(-rollingDays);
    const completedCount = recentValues.filter(Boolean).length;
    const totalDays = recentValues.length || 1;
    const rollingAvg = Math.round((completedCount / totalDays) * 100);

    habits.push({
      name,
      completions: recentValues,
      rollingAvg,
      status: getStatus(rollingAvg),
    });
  }

  return habits;
}

export async function execute(config: HabitTrackingBlockConfig = {}): Promise<BlockResult> {
  const { rollingDays = 7, maxHabits = 30 } = config;

  try {
    // Read habit data from sheet
    const rows = await readSheet(HABIT_SHEET_ID, HABIT_RANGE);

    if (rows.length === 0) {
      return {
        blockName: "habitTracking",
        success: true,
        data: { habits: [], message: "No habit data found" },
        markdown: "## Habit Tracking\n\nNo habit data available.\n",
        summary: "No habit data",
      };
    }

    // Parse habits with rolling averages
    const habits = parseHabitRows(rows, rollingDays);
    const displayed = habits.slice(0, maxHabits);

    // Sort by worst performing first
    const sorted = [...displayed].sort((a, b) => a.rollingAvg - b.rollingAvg);

    // Format markdown table
    let markdown = "## Habit Tracking\n\n";
    markdown += `| Habit | ${rollingDays}-Day Avg | Progress | Status |\n`;
    markdown += "|-------|-----------|----------|--------|\n";

    for (const habit of sorted) {
      const bar = progressBar(habit.rollingAvg);
      const icon = statusIcon(habit.status);
      markdown += `| ${habit.name} | ${habit.rollingAvg}% | ${bar} | ${icon} |\n`;
    }
    markdown += "\n";

    // Gap analysis
    const redHabits = sorted.filter((h) => h.status === "red");
    const yellowHabits = sorted.filter((h) => h.status === "yellow");
    const greenHabits = sorted.filter((h) => h.status === "green");

    if (redHabits.length > 0) {
      markdown += `**Needs attention:** ${redHabits.map((h) => h.name).join(", ")}\n`;
    }
    if (greenHabits.length > 0) {
      markdown += `**Strong:** ${greenHabits.map((h) => h.name).join(", ")}\n`;
    }

    // Find worst habit for summary
    const worst = sorted[0];
    const overallAvg = sorted.length > 0
      ? Math.round(sorted.reduce((sum, h) => sum + h.rollingAvg, 0) / sorted.length)
      : 0;

    const summary = worst
      ? `${sorted.length} habits tracked, overall ${overallAvg}%, worst: ${worst.name} (${worst.rollingAvg}%)`
      : "No habits tracked";

    return {
      blockName: "habitTracking",
      success: true,
      data: {
        habits: sorted,
        totalHabits: sorted.length,
        overallAvg,
        worstHabit: worst || null,
        redCount: redHabits.length,
        yellowCount: yellowHabits.length,
        greenCount: greenHabits.length,
      },
      markdown,
      summary,
    };
  } catch (error) {
    return {
      blockName: "habitTracking",
      success: false,
      data: {},
      markdown: "## Habit Tracking\n\nFailed to load habit data.\n",
      summary: "Habit tracking unavailable",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// CLI entry point
if (import.meta.main) {
  const args = process.argv.slice(2);

  if (args.includes("--test") || args.includes("-t")) {
    execute({ rollingDays: 7, maxHabits: 30 })
      .then((result) => {
        console.log("=== Habit Tracking Block Test ===\n");
        console.log("Success:", result.success);
        console.log("\nMarkdown:\n", result.markdown);
        console.log("\nSummary:", result.summary);
        if (result.error) console.log("\nError:", result.error);
        console.log("\nData:", JSON.stringify(result.data, null, 2));
      })
      .catch(console.error);
  } else {
    console.log("Usage: bun HabitTrackingBlock.ts --test");
  }
}
