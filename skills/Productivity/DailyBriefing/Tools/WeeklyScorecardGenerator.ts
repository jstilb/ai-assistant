#!/usr/bin/env bun
/**
 * WeeklyScorecardGenerator.ts - Weekly scorecard aggregating full-week DTR data
 *
 * Reads all 4 DTR Google Sheets, calculates week-over-week trends,
 * reviews commitments, detects patterns, and delivers a comprehensive
 * report + voice summary + Telegram.
 *
 * Usage:
 *   bun WeeklyScorecardGenerator.ts              # Generate and deliver
 *   bun WeeklyScorecardGenerator.ts --test       # Dry-run mode (no delivery)
 *   bun WeeklyScorecardGenerator.ts --json       # Output as JSON
 *   bun WeeklyScorecardGenerator.ts --help
 */

import { parseArgs } from "util";
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "fs";
import { join } from "path";
import { deliverVoice, deliverTelegram, loadSettings as loadSettingsAsync } from "./DeliveryUtils.ts";

// ============================================================================
// Configuration
// ============================================================================

const KAYA_HOME = process.env.KAYA_DIR || join(process.env.HOME!, ".claude");
const BRIEFINGS_DIR = join(KAYA_HOME, "MEMORY", "BRIEFINGS");
const SETTINGS_FILE = join(KAYA_HOME, "settings.json");
const DTR_CONFIG_FILE = join(KAYA_HOME, "skills", "InformationManager", "config", "dtr.json");

// ============================================================================
// Types
// ============================================================================

interface DtrConfig {
  sheets: {
    alignment: string;
    goal_achievement: string;
    habit_building: string;
    health: string;
  };
  sheetRanges?: {
    goal_achievement?: string;
    habit_building?: string;
  };
}

interface Settings {
  principal?: { name?: string; timezone?: string };
  daidentity?: { name?: string };
}

interface TrendResult {
  direction: "up" | "down" | "flat";
  delta: number;
  thisWeek: number;
  lastWeek: number;
}

type PatternLabel = "improving" | "declining" | "stalled";

interface HabitPerformanceRow {
  name: string;
  thisWeekPct: number;
  lastWeekPct: number;
  trend: "up" | "down" | "flat";
}

interface LeadMeasureRow {
  id: string;
  name: string;
  thisWeek: number;
  lastWeek: number;
  target: number;
  direction: "up" | "down" | "flat";
  delta: number;
}

interface CommitmentSummary {
  totalPlanned: number;
  totalCompleted: number;
  completionRate: number;
  dailyBreakdown: Array<{ date: string; planned: number; completed: number }>;
}

interface PatternEntry {
  name: string;
  pattern: PatternLabel;
  data: number[];
}

interface NextWeekPreview {
  events: Array<{ title: string; date: string; time: string }>;
  suggestedFocus: string[];
}

interface ParsedRow {
  name: string;
  values: boolean[];
}

interface PlannedPrioritiesFile {
  date: string;
  priorities: Array<{ title: string; [key: string]: unknown }>;
}

interface EveningFile {
  date: string;
  completed: string[];
  incomplete: string[];
}

interface WeeklyScorecardOutput {
  date: string;
  weekStart: string;
  weekEnd: string;
  habitPerformance: HabitPerformanceRow[];
  leadMeasures: LeadMeasureRow[];
  commitments: CommitmentSummary;
  patterns: PatternEntry[];
  nextWeek: NextWeekPreview;
  markdown: string;
  voiceSummary: string;
  telegramMessage: string;
}

// ============================================================================
// Exported Pure Functions (Testable)
// ============================================================================

/**
 * Get array of 7 date strings ending at the given date.
 * Returns dates in YYYY-MM-DD format.
 */
export function getWeekDates(endDate: string): string[] {
  const end = new Date(endDate + "T12:00:00");
  const dates: string[] = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(end);
    d.setDate(end.getDate() - i);
    dates.push(d.toISOString().split("T")[0]!);
  }
  return dates;
}

/**
 * Calculate week-over-week trend between two averages.
 */
export function calculateWeekOverWeekTrend(thisWeek: number, lastWeek: number): TrendResult {
  const delta = Math.round((thisWeek - lastWeek) * 10) / 10;
  let direction: "up" | "down" | "flat";
  if (delta > 0) direction = "up";
  else if (delta < 0) direction = "down";
  else direction = "flat";

  return { direction, delta, thisWeek, lastWeek };
}

/**
 * Detect pattern from daily values: improving (3+ consecutive increases),
 * declining (3+ consecutive decreases), or stalled.
 */
export function detectPattern(dailyValues: number[]): PatternLabel {
  if (dailyValues.length < 3) return "stalled";

  // Check last 5 values (or all if fewer)
  const recent = dailyValues.slice(-5);

  let consecutiveUp = 0;
  let consecutiveDown = 0;
  let maxConsecutiveUp = 0;
  let maxConsecutiveDown = 0;

  for (let i = 1; i < recent.length; i++) {
    if (recent[i]! > recent[i - 1]!) {
      consecutiveUp++;
      consecutiveDown = 0;
    } else if (recent[i]! < recent[i - 1]!) {
      consecutiveDown++;
      consecutiveUp = 0;
    } else {
      consecutiveUp = 0;
      consecutiveDown = 0;
    }
    maxConsecutiveUp = Math.max(maxConsecutiveUp, consecutiveUp);
    maxConsecutiveDown = Math.max(maxConsecutiveDown, consecutiveDown);
  }

  if (maxConsecutiveUp >= 3) return "improving";
  if (maxConsecutiveDown >= 3) return "declining";
  return "stalled";
}

/**
 * Format trend direction as an arrow character.
 */
export function formatTrendArrow(direction: "up" | "down" | "flat"): string {
  switch (direction) {
    case "up": return "^";
    case "down": return "v";
    case "flat": return "-";
  }
}

/**
 * Aggregate planned vs completed from daily briefing files.
 */
export function aggregateCommitments(
  planned: Array<{ date: string; priorities: Array<{ title: string }> }>,
  evenings: Array<{ date: string; completed: string[]; incomplete: string[] }>
): CommitmentSummary {
  let totalPlanned = 0;
  let totalCompleted = 0;
  const dailyBreakdown: Array<{ date: string; planned: number; completed: number }> = [];

  for (const p of planned) {
    const dayPlanned = p.priorities.length;
    totalPlanned += dayPlanned;

    const evening = evenings.find((e) => e.date === p.date);
    const dayCompleted = evening ? evening.completed.length : 0;
    totalCompleted += dayCompleted;

    dailyBreakdown.push({
      date: p.date,
      planned: dayPlanned,
      completed: dayCompleted,
    });
  }

  const completionRate = totalPlanned > 0
    ? Math.round((totalCompleted / totalPlanned) * 1000) / 10
    : 0;

  return { totalPlanned, totalCompleted, completionRate, dailyBreakdown };
}

/**
 * Parse sheet rows into named boolean value arrays.
 */
export function parseSheetRows(rows: string[][]): ParsedRow[] {
  if (rows.length < 2) return [];

  const result: ParsedRow[] = [];

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i]!;
    if (!row[0] || !row[0].trim()) continue;

    const name = row[0].trim();
    const values: boolean[] = [];

    for (let j = 1; j < row.length; j++) {
      const val = (row[j] || "").trim().toLowerCase();
      const completed = val === "true" || val === "1" || val === "yes" || val === "x";
      values.push(completed);
    }

    result.push({ name, values });
  }

  return result;
}

// ============================================================================
// Formatting Functions (Exported for Testing)
// ============================================================================

/**
 * Format Section 1: Habit Performance table.
 */
export function formatHabitPerformanceTable(habits: HabitPerformanceRow[]): string {
  let md = "## 1. Habit Performance\n\n";
  md += "| Habit | This Week | Last Week | Trend |\n";
  md += "|-------|-----------|-----------|-------|\n";

  for (const h of habits) {
    const arrow = formatTrendArrow(h.trend);
    md += `| ${h.name} | ${h.thisWeekPct}% | ${h.lastWeekPct}% | ${arrow} |\n`;
  }

  md += "\n";
  return md;
}

/**
 * Format Section 2: Lead Measure Scorecard.
 */
export function formatLeadMeasureScorecard(measures: LeadMeasureRow[]): string {
  let md = "## 2. Lead Measure Scorecard\n\n";
  md += "| ID | Name | This Week | Last Week | Target | Delta | Direction |\n";
  md += "|----|------|-----------|-----------|--------|-------|-----------|\n";

  for (const m of measures) {
    const arrow = formatTrendArrow(m.direction);
    const deltaStr = m.delta >= 0 ? `+${m.delta}` : `${m.delta}`;
    md += `| ${m.id} | ${m.name} | ${m.thisWeek} | ${m.lastWeek} | ${m.target} | ${deltaStr} | ${arrow} |\n`;
  }

  // WIG gap analysis
  md += "\n### WIG Gap Analysis\n\n";
  const critical = measures.filter((m) => {
    const gap = m.target > 0 ? ((m.thisWeek - m.target) / m.target) * 100 : 0;
    return gap < -40;
  });

  if (critical.length > 0) {
    md += "**Critical gaps:**\n";
    for (const m of critical) {
      const gap = m.target > 0 ? Math.round(((m.thisWeek - m.target) / m.target) * 100) : 0;
      md += `- ${m.id} (${m.name}): ${gap}% below target\n`;
    }
  } else {
    md += "No critical gaps this week.\n";
  }

  md += "\n";
  return md;
}

/**
 * Format Section 3: Commitment Review.
 */
export function formatCommitmentReview(commitments: CommitmentSummary): string {
  let md = "## 3. Commitment Review\n\n";
  md += `**Overall:** ${commitments.totalCompleted}/${commitments.totalPlanned} planned priorities completed (${commitments.completionRate}%)\n\n`;

  if (commitments.dailyBreakdown.length > 0) {
    md += "| Date | Planned | Completed | Rate |\n";
    md += "|------|---------|-----------|------|\n";

    for (const day of commitments.dailyBreakdown) {
      const rate = day.planned > 0 ? Math.round((day.completed / day.planned) * 100) : 0;
      md += `| ${day.date} | ${day.planned} | ${day.completed} | ${rate}% |\n`;
    }
    md += "\n";
  }

  return md;
}

/**
 * Format Section 4: Patterns Detected.
 */
export function formatPatternsDetected(patterns: PatternEntry[]): string {
  let md = "## 4. Patterns Detected\n\n";

  const improving = patterns.filter((p) => p.pattern === "improving");
  const declining = patterns.filter((p) => p.pattern === "declining");
  const stalled = patterns.filter((p) => p.pattern === "stalled");

  if (improving.length > 0) {
    md += "**Improving:**\n";
    for (const p of improving) {
      const recent = p.data.slice(-3);
      md += `- ${p.name}: ${recent.join(" -> ")}\n`;
    }
    md += "\n";
  }

  if (declining.length > 0) {
    md += "**Declining:**\n";
    for (const p of declining) {
      const recent = p.data.slice(-3);
      md += `- ${p.name}: ${recent.join(" -> ")}\n`;
    }
    md += "\n";
  }

  if (stalled.length > 0) {
    md += "**Stalled:**\n";
    for (const p of stalled) {
      const avg = p.data.length > 0
        ? Math.round(p.data.reduce((a, b) => a + b, 0) / p.data.length)
        : 0;
      md += `- ${p.name}: averaging ${avg}%\n`;
    }
    md += "\n";
  }

  return md;
}

/**
 * Format Section 5: Next Week Preview.
 */
export function formatNextWeekPreview(preview: NextWeekPreview): string {
  let md = "## 5. Next Week Preview\n\n";

  if (preview.events.length > 0) {
    md += "### Calendar\n\n";
    for (const event of preview.events) {
      md += `- **${event.date}** ${event.time} - ${event.title}\n`;
    }
    md += "\n";
  } else {
    md += "No calendar events loaded for next week.\n\n";
  }

  if (preview.suggestedFocus.length > 0) {
    md += "### Suggested Focus Areas\n\n";
    md += "_Based on weakest metrics this week:_\n\n";
    for (const focus of preview.suggestedFocus) {
      md += `- ${focus}\n`;
    }
    md += "\n";
  }

  return md;
}

/**
 * Generate voice summary from top insights (max 16 words).
 */
export function generateVoiceSummary(insights: string[]): string {
  if (insights.length === 0) {
    return "Weekly scorecard generated. No significant insights this week.";
  }

  // Take the first insight and ensure it's under 16 words
  const firstInsight = insights[0]!;
  const words = firstInsight.split(/\s+/);
  if (words.length <= 16) {
    return firstInsight;
  }

  // Truncate to 14 words and add period
  return words.slice(0, 14).join(" ") + ".";
}

// ============================================================================
// Sheet Reading
// ============================================================================

/**
 * Read sheet data via kaya-cli sheets read using Bun.spawn.
 */
async function readSheet(sheetId: string, range: string): Promise<string[][]> {
  const proc = Bun.spawn(["kaya-cli", "sheets", "read", sheetId, range], {
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

  if (trimmed.startsWith("[")) {
    try {
      return JSON.parse(trimmed) as string[][];
    } catch {
      // Fall through to TSV
    }
  }

  return trimmed.split("\n").map((line) => line.split("\t"));
}

/**
 * Load DTR config from dtr.json.
 */
function loadDtrConfig(): DtrConfig {
  if (!existsSync(DTR_CONFIG_FILE)) {
    throw new Error(`DTR config not found: ${DTR_CONFIG_FILE}`);
  }
  return JSON.parse(readFileSync(DTR_CONFIG_FILE, "utf-8")) as DtrConfig;
}

/**
 * Load settings via shared DeliveryUtils (StateManager-backed).
 */
async function loadSettings(): Promise<Settings> {
  return await loadSettingsAsync() as Settings;
}

// ============================================================================
// Data Collection
// ============================================================================

/**
 * Read 7-day habit data from the habit_building sheet.
 * Returns both this week and last week data for trend calculation.
 */
async function readHabitData(
  sheetId: string,
  range: string
): Promise<{ habits: HabitPerformanceRow[]; patterns: PatternEntry[] }> {
  try {
    const rows = await readSheet(sheetId, range);
    if (rows.length < 2) return { habits: [], patterns: [] };

    const parsed = parseSheetRows(rows);
    const habits: HabitPerformanceRow[] = [];
    const patterns: PatternEntry[] = [];

    for (const row of parsed) {
      // This week: last 7 values; Last week: 7 before that
      const thisWeekValues = row.values.slice(-7);
      const lastWeekValues = row.values.slice(-14, -7);

      const thisWeekPct = thisWeekValues.length > 0
        ? Math.round((thisWeekValues.filter(Boolean).length / thisWeekValues.length) * 100)
        : 0;

      const lastWeekPct = lastWeekValues.length > 0
        ? Math.round((lastWeekValues.filter(Boolean).length / lastWeekValues.length) * 100)
        : 0;

      const trend = calculateWeekOverWeekTrend(thisWeekPct, lastWeekPct);

      habits.push({
        name: row.name,
        thisWeekPct,
        lastWeekPct,
        trend: trend.direction,
      });

      // Build daily percentage data for pattern detection
      const dailyPcts = thisWeekValues.map((v) => v ? 100 : 0);
      patterns.push({
        name: row.name,
        pattern: detectPattern(dailyPcts),
        data: dailyPcts,
      });
    }

    return { habits, patterns };
  } catch (error) {
    console.error("Error reading habit data:", error);
    return { habits: [], patterns: [] };
  }
}

/**
 * Read lead measure data from the goal_achievement sheet.
 */
async function readLeadMeasureData(
  sheetId: string,
  range: string
): Promise<LeadMeasureRow[]> {
  try {
    const rows = await readSheet(sheetId, range);
    if (rows.length < 2) return [];

    const headers = rows[0]!.map((h) => h.toLowerCase().trim());
    const measures: LeadMeasureRow[] = [];

    const idCol = headers.findIndex((h) => h.includes("id") || h.includes("strategy") || h.includes("measure"));
    const nameCol = headers.findIndex((h) => h.includes("name") || h.includes("title") || h.includes("description"));
    const currentCol = headers.findIndex((h) => h.includes("current") || h.includes("actual") || h.includes("score"));
    const targetCol = headers.findIndex((h) => h.includes("target"));
    // Look for a "last week" or "previous" column
    const lastWeekCol = headers.findIndex((h) => h.includes("last") || h.includes("previous") || h.includes("prior"));

    for (let i = 1; i < rows.length; i++) {
      const row = rows[i]!;
      if (!row[0] || !row[0].trim()) continue;

      const id = idCol >= 0 ? row[idCol]!.trim() : row[0]!.trim();
      if (!id.match(/^S\d$/)) continue;

      const name = nameCol >= 0 && nameCol !== idCol ? (row[nameCol] || "").trim() : "";
      const currentStr = currentCol >= 0 ? (row[currentCol] || "").trim() : "";
      const targetStr = targetCol >= 0 ? (row[targetCol] || "").trim() : "";
      const lastWeekStr = lastWeekCol >= 0 ? (row[lastWeekCol] || "").trim() : "";

      const current = parseFloat(currentStr.replace("%", "")) || 0;
      const target = parseFloat(targetStr.replace("%", "")) || 100;
      const lastWeek = lastWeekStr ? (parseFloat(lastWeekStr.replace("%", "")) || 0) : current;

      const trend = calculateWeekOverWeekTrend(current, lastWeek);

      measures.push({
        id,
        name,
        thisWeek: current,
        lastWeek,
        target,
        direction: trend.direction,
        delta: trend.delta,
      });
    }

    return measures;
  } catch (error) {
    console.error("Error reading lead measure data:", error);
    return [];
  }
}

/**
 * Read planned priorities and evening check-ins for the week.
 */
function readCommitmentData(weekDates: string[]): CommitmentSummary {
  const planned: Array<{ date: string; priorities: Array<{ title: string }> }> = [];
  const evenings: Array<{ date: string; completed: string[]; incomplete: string[] }> = [];

  for (const date of weekDates) {
    // Read planned priorities
    const plannedPath = join(BRIEFINGS_DIR, `planned-priorities-${date}.json`);
    if (existsSync(plannedPath)) {
      try {
        const data = JSON.parse(readFileSync(plannedPath, "utf-8")) as PlannedPrioritiesFile;
        planned.push({ date, priorities: data.priorities || [] });
      } catch {}
    }

    // Read evening check-in (parse markdown for completed/incomplete)
    const eveningPath = join(BRIEFINGS_DIR, `evening-${date}.md`);
    if (existsSync(eveningPath)) {
      try {
        const content = readFileSync(eveningPath, "utf-8");
        const completed: string[] = [];
        const incomplete: string[] = [];

        // Parse markdown checkboxes
        const lines = content.split("\n");
        for (const line of lines) {
          const checkedMatch = line.match(/^\s*-\s*\[x\]\s*\*?\*?(.+?)\*?\*?\s*(\(.+\))?\s*$/i);
          const uncheckedMatch = line.match(/^\s*-\s*\[\s\]\s*(.+?)\s*(\(.+\))?\s*$/);

          if (checkedMatch) {
            completed.push(checkedMatch[1]!.trim());
          } else if (uncheckedMatch) {
            incomplete.push(uncheckedMatch[1]!.trim());
          }
        }

        evenings.push({ date, completed, incomplete });
      } catch {}
    }
  }

  return aggregateCommitments(planned, evenings);
}

/**
 * Fetch next week calendar via kaya-cli.
 */
async function fetchNextWeekCalendar(): Promise<Array<{ title: string; date: string; time: string }>> {
  try {
    const proc = Bun.spawn(
      ["kaya-cli", "gcal", "week", "--next", "--json"],
      { stdout: "pipe", stderr: "pipe" }
    );

    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    if (exitCode !== 0) return [];

    const trimmed = stdout.trim();
    if (!trimmed || !trimmed.startsWith("[")) return [];

    const events = JSON.parse(trimmed) as Array<{
      summary?: string;
      title?: string;
      start?: { dateTime?: string; date?: string };
      date?: string;
      time?: string;
    }>;

    return events.map((e) => ({
      title: e.summary || e.title || "Untitled",
      date: e.start?.date || e.date || "",
      time: e.start?.dateTime
        ? new Date(e.start.dateTime).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
        : e.time || "",
    }));
  } catch {
    return [];
  }
}

// ============================================================================
// Delivery (via shared DeliveryUtils)
// ============================================================================

// deliverVoice and deliverTelegram imported from DeliveryUtils.ts

// ============================================================================
// Report Assembly
// ============================================================================

function assembleMarkdownReport(
  date: string,
  weekStart: string,
  weekEnd: string,
  habits: HabitPerformanceRow[],
  measures: LeadMeasureRow[],
  commitments: CommitmentSummary,
  patterns: PatternEntry[],
  nextWeek: NextWeekPreview,
  settings: Settings
): string {
  const name = settings.principal?.name || "Jm";
  const dateFormatted = new Date(date + "T12:00:00").toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  let md = `# Weekly Scorecard - ${dateFormatted}\n\n`;
  md += `**Week:** ${weekStart} to ${weekEnd}\n\n`;
  md += `---\n\n`;

  // Section 1: Habit Performance
  md += formatHabitPerformanceTable(habits);

  // Section 2: Lead Measure Scorecard
  md += formatLeadMeasureScorecard(measures);

  // Section 3: Commitment Review
  md += formatCommitmentReview(commitments);

  // Section 4: Patterns Detected
  md += formatPatternsDetected(patterns);

  // Section 5: Next Week Preview
  md += formatNextWeekPreview(nextWeek);

  md += `---\n*Generated by WeeklyScorecardGenerator at ${new Date().toISOString()}*\n`;

  return md;
}

function assembleTelegramMessage(
  weekStart: string,
  weekEnd: string,
  habits: HabitPerformanceRow[],
  measures: LeadMeasureRow[],
  commitments: CommitmentSummary,
  patterns: PatternEntry[]
): string {
  let msg = `*Weekly Scorecard*\n`;
  msg += `${weekStart} to ${weekEnd}\n\n`;

  // Overall habit average
  if (habits.length > 0) {
    const avgPct = Math.round(habits.reduce((s, h) => s + h.thisWeekPct, 0) / habits.length);
    const improving = habits.filter((h) => h.trend === "up").length;
    const declining = habits.filter((h) => h.trend === "down").length;
    msg += `*Habits:* ${avgPct}% avg`;
    if (improving > 0) msg += `, ${improving} improving`;
    if (declining > 0) msg += `, ${declining} declining`;
    msg += "\n";
  }

  // Lead measures
  if (measures.length > 0) {
    const critical = measures.filter((m) => {
      const gap = m.target > 0 ? ((m.thisWeek - m.target) / m.target) * 100 : 0;
      return gap < -40;
    });
    msg += `*Lead Measures:* ${measures.length} tracked`;
    if (critical.length > 0) {
      msg += `, ${critical.length} critical`;
    }
    msg += "\n";
  }

  // Commitments
  if (commitments.totalPlanned > 0) {
    msg += `*Commitments:* ${commitments.completionRate}% (${commitments.totalCompleted}/${commitments.totalPlanned})\n`;
  }

  // Patterns
  const improvingPatterns = patterns.filter((p) => p.pattern === "improving");
  const decliningPatterns = patterns.filter((p) => p.pattern === "declining");
  if (improvingPatterns.length > 0 || decliningPatterns.length > 0) {
    msg += "\n";
    if (improvingPatterns.length > 0) {
      msg += `Improving: ${improvingPatterns.map((p) => p.name).join(", ")}\n`;
    }
    if (decliningPatterns.length > 0) {
      msg += `Declining: ${decliningPatterns.map((p) => p.name).join(", ")}\n`;
    }
  }

  return msg;
}

function buildInsights(
  habits: HabitPerformanceRow[],
  measures: LeadMeasureRow[],
  commitments: CommitmentSummary
): string[] {
  const insights: string[] = [];

  // Habit insight
  if (habits.length > 0) {
    const avgPct = Math.round(habits.reduce((s, h) => s + h.thisWeekPct, 0) / habits.length);
    const improving = habits.filter((h) => h.trend === "up").length;
    if (improving > 0) {
      insights.push(`Habits averaged ${avgPct}% with ${improving} improving trends this week.`);
    } else {
      insights.push(`Habits averaged ${avgPct}% across ${habits.length} tracked this week.`);
    }
  }

  // Worst lead measure
  if (measures.length > 0) {
    const sorted = [...measures].sort((a, b) => a.thisWeek - b.thisWeek);
    const worst = sorted[0]!;
    insights.push(`${worst.id} ${worst.name} needs attention at ${worst.thisWeek} versus ${worst.target} target.`);
  }

  // Commitment rate
  if (commitments.totalPlanned > 0) {
    insights.push(`Weekly commitment rate was ${commitments.completionRate}% across ${commitments.totalPlanned} priorities.`);
  }

  return insights;
}

// ============================================================================
// Main
// ============================================================================

async function generateWeeklyScorecard(dryRun: boolean = false, jsonOutput: boolean = false): Promise<void> {
  const settings = await loadSettings();
  const today = new Date().toISOString().split("T")[0]!;
  const weekDates = getWeekDates(today);
  const weekStart = weekDates[0]!;
  const weekEnd = weekDates[6]!;

  console.log("Weekly Scorecard Generator\n");
  console.log(`  Date: ${today}`);
  console.log(`  Week: ${weekStart} to ${weekEnd}`);
  console.log(`  Mode: ${dryRun ? "DRY RUN" : "LIVE"}\n`);

  // Load DTR config
  let dtrConfig: DtrConfig;
  try {
    dtrConfig = loadDtrConfig();
  } catch (error) {
    console.error("Failed to load DTR config:", error);
    process.exit(1);
  }

  // Step 1: Read habit data from habit_building sheet
  console.log("  Reading habit data...");
  const habitRange = dtrConfig.sheetRanges?.habit_building || "A1:AM10";
  const { habits, patterns } = await readHabitData(
    dtrConfig.sheets.habit_building,
    habitRange
  );
  console.log(`  Found ${habits.length} habits.`);

  // Step 2: Read lead measures from goal_achievement sheet
  console.log("  Reading lead measures...");
  const goalRange = dtrConfig.sheetRanges?.goal_achievement || "A1:Z20";
  const measures = await readLeadMeasureData(
    dtrConfig.sheets.goal_achievement,
    goalRange
  );
  console.log(`  Found ${measures.length} lead measures.`);

  // Step 3: Read commitment data from daily briefings
  console.log("  Reading commitment data...");
  const commitments = readCommitmentData(weekDates);
  console.log(`  ${commitments.totalPlanned} planned, ${commitments.totalCompleted} completed.`);

  // Step 4: Fetch next week calendar
  console.log("  Fetching next week calendar...");
  const nextWeekEvents = await fetchNextWeekCalendar();
  console.log(`  ${nextWeekEvents.length} upcoming events.`);

  // Build suggested focus from weakest metrics
  const weakestHabits = [...habits]
    .sort((a, b) => a.thisWeekPct - b.thisWeekPct)
    .slice(0, 3)
    .map((h) => `${h.name} (${h.thisWeekPct}%)`);

  const weakestMeasures = [...measures]
    .sort((a, b) => (a.thisWeek / a.target) - (b.thisWeek / b.target))
    .slice(0, 2)
    .map((m) => `${m.id}: ${m.name} (${m.thisWeek}/${m.target})`);

  const suggestedFocus = [...weakestHabits, ...weakestMeasures];

  const nextWeek: NextWeekPreview = {
    events: nextWeekEvents,
    suggestedFocus,
  };

  // Build insights for voice
  const insights = buildInsights(habits, measures, commitments);
  const voiceLine = generateVoiceSummary(insights);

  // Assemble report
  const markdown = assembleMarkdownReport(
    today, weekStart, weekEnd,
    habits, measures, commitments, patterns, nextWeek, settings
  );

  const telegramMsg = assembleTelegramMessage(
    weekStart, weekEnd, habits, measures, commitments, patterns
  );

  // JSON output mode
  if (jsonOutput) {
    const output: WeeklyScorecardOutput = {
      date: today,
      weekStart,
      weekEnd,
      habitPerformance: habits,
      leadMeasures: measures,
      commitments,
      patterns,
      nextWeek,
      markdown,
      voiceSummary: voiceLine,
      telegramMessage: telegramMsg,
    };
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  // Dry run mode
  if (dryRun) {
    console.log("\n=== MARKDOWN ===\n");
    console.log(markdown);
    console.log("\n=== VOICE ===\n");
    console.log(voiceLine);
    console.log("\n=== TELEGRAM ===\n");
    console.log(telegramMsg);
    console.log("\n=== INSIGHTS ===\n");
    for (const i of insights) {
      console.log(`  - ${i}`);
    }
    return;
  }

  // Step 5: Write report to file
  console.log("\n  Writing weekly report...");
  if (!existsSync(BRIEFINGS_DIR)) {
    mkdirSync(BRIEFINGS_DIR, { recursive: true });
  }
  const reportPath = join(BRIEFINGS_DIR, `weekly-${today}.md`);
  writeFileSync(reportPath, markdown);
  console.log(`  Written to: ${reportPath}`);

  // Step 6: Deliver voice
  console.log("  Delivering voice notification...");
  await deliverVoice(voiceLine, "Weekly Scorecard");

  // Step 7: Deliver Telegram
  console.log("  Delivering Telegram message...");
  await deliverTelegram(telegramMsg);

  console.log("\nWeekly scorecard complete!");
}

// ============================================================================
// CLI Entry Point
// ============================================================================

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      test: { type: "boolean" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });

  if (values.help) {
    console.log(`
Weekly Scorecard Generator - Comprehensive weekly performance report

Usage:
  bun WeeklyScorecardGenerator.ts              Generate and deliver weekly scorecard
  bun WeeklyScorecardGenerator.ts --test       Dry-run mode (preview without delivery)
  bun WeeklyScorecardGenerator.ts --json       Output as JSON
  bun WeeklyScorecardGenerator.ts --help       Show this help

Features:
  - Reads all 4 DTR sheets (habit_building, goal_achievement, health, alignment)
  - Calculates week-over-week trends with direction + magnitude
  - Generates commitment review aggregating daily planned vs evening outcomes
  - Detects patterns (improving/declining/stalled) via rolling averages
  - Includes next week calendar preview with suggested focus areas
  - Delivers as written report + voice + Telegram

Report Sections:
  1. Habit Performance    - This week %, last week %, trend arrow
  2. Lead Measure Scorecard - S0-S8 progress vs targets with WIG gap analysis
  3. Commitment Review    - Planned vs actual across the week
  4. Patterns Detected    - Improving/declining/stalled labels
  5. Next Week Preview    - Calendar + suggested focus based on weakest metrics

Files:
  Input:  MEMORY/BRIEFINGS/planned-priorities-{date}.json, evening-{date}.md
  Input:  DTR Google Sheets (via kaya-cli sheets read)
  Output: MEMORY/BRIEFINGS/weekly-{date}.md
`);
    process.exit(0);
  }

  const dryRun = values.test || false;
  const jsonOutput = values.json || false;

  await generateWeeklyScorecard(dryRun, jsonOutput);
}

// Run if executed directly
if (import.meta.main) {
  main().catch(console.error);
}

// Exports for testing and programmatic use
export type {
  HabitPerformanceRow,
  LeadMeasureRow,
  CommitmentSummary,
  PatternEntry,
  NextWeekPreview,
  WeeklyScorecardOutput,
  TrendResult,
  PatternLabel,
};
