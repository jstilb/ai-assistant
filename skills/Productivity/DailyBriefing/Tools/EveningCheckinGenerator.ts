#!/usr/bin/env bun
/**
 * EveningCheckinGenerator.ts - Evening check-in comparing morning priorities vs actual completion
 *
 * Reads morning's planned priorities, queries LucidTasks for completed tasks today,
 * compares planned vs completed, and delivers a positive-first evening summary
 * via voice + Telegram.
 *
 * Usage:
 *   bun EveningCheckinGenerator.ts              # Generate and deliver
 *   bun EveningCheckinGenerator.ts --test       # Dry-run mode (no delivery)
 *   bun EveningCheckinGenerator.ts --json       # Output as JSON
 *   bun EveningCheckinGenerator.ts --help
 */

import { parseArgs } from "util";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { deliverVoice, deliverTelegram, loadSettings as loadSettingsAsync } from "./DeliveryUtils.ts";

// ============================================================================
// Configuration
// ============================================================================

const KAYA_HOME = process.env.KAYA_DIR || join(process.env.HOME!, ".claude");
const BRIEFINGS_DIR = join(KAYA_HOME, "MEMORY", "BRIEFINGS");
const SETTINGS_FILE = join(KAYA_HOME, "settings.json");

// ============================================================================
// Types
// ============================================================================

interface PriorityCandidate {
  rank: number;
  title: string;
  source: string;
  urgency: string;
  timeEstimate: string;
  alignmentTag: string;
  taskId?: string;
}

interface PlannedPriorities {
  date: string;
  generatedAt: string;
  priorities: PriorityCandidate[];
  availableHours: number;
  calendarEvents: number;
}

interface CompletedTask {
  name: string;
  gid: string;
  completed: boolean;
  completed_at?: string;
  modified_at?: string;
  due_on?: string;
  project?: { name: string };
}

interface CompletionResult {
  completedCount: number;
  totalPlanned: number;
  completionRate: number;
  completed: Array<{ title: string; alignmentTag: string }>;
  incomplete: Array<{ title: string; alignmentTag: string }>;
  bonusCompleted: Array<{ name: string; gid: string }>;
}

interface Settings {
  principal?: { name?: string; timezone?: string };
  daidentity?: { name?: string };
}

// ============================================================================
// Core Logic - Exported for Testing
// ============================================================================

/**
 * Read morning's planned priorities from the BRIEFINGS directory.
 * Returns null if no planned priorities file exists for the given date.
 */
export function readPlannedPriorities(date: string): PlannedPriorities | null {
  const filePath = join(BRIEFINGS_DIR, `planned-priorities-${date}.json`);

  if (!existsSync(filePath)) {
    return null;
  }

  try {
    const content = readFileSync(filePath, "utf-8");
    return JSON.parse(content) as PlannedPriorities;
  } catch {
    return null;
  }
}

/**
 * Compare planned priorities against completed tasks.
 * Matches by taskId (gid) first, then by title similarity.
 */
export function calculateCompletion(
  planned: PriorityCandidate[],
  completedTasks: CompletedTask[]
): CompletionResult {
  if (planned.length === 0 && completedTasks.length === 0) {
    return {
      completedCount: 0,
      totalPlanned: 0,
      completionRate: 0,
      completed: [],
      incomplete: [],
      bonusCompleted: [],
    };
  }

  const completed: Array<{ title: string; alignmentTag: string }> = [];
  const incomplete: Array<{ title: string; alignmentTag: string }> = [];
  const matchedTaskGids = new Set<string>();

  for (const priority of planned) {
    let found = false;

    // Match by taskId (gid) first
    if (priority.taskId) {
      const match = completedTasks.find((t) => t.gid === priority.taskId);
      if (match) {
        found = true;
        matchedTaskGids.add(match.gid);
      }
    }

    // Fallback: match by title (case-insensitive, fuzzy)
    if (!found) {
      const priorityLower = priority.title.toLowerCase();
      const match = completedTasks.find((t) => {
        const taskLower = t.name.toLowerCase();
        return taskLower === priorityLower || taskLower.includes(priorityLower) || priorityLower.includes(taskLower);
      });
      if (match) {
        found = true;
        matchedTaskGids.add(match.gid);
      }
    }

    if (found) {
      completed.push({ title: priority.title, alignmentTag: priority.alignmentTag });
    } else {
      incomplete.push({ title: priority.title, alignmentTag: priority.alignmentTag });
    }
  }

  // Bonus: completed tasks that were NOT in the morning plan
  const bonusCompleted = completedTasks.filter((t) => !matchedTaskGids.has(t.gid));

  const completedCount = completed.length;
  const totalPlanned = planned.length;
  const completionRate = totalPlanned > 0
    ? Math.round((completedCount / totalPlanned) * 1000) / 10
    : 0;

  return {
    completedCount,
    totalPlanned,
    completionRate,
    completed,
    incomplete,
    bonusCompleted,
  };
}

/**
 * Format the evening summary markdown.
 * Positive-first: accomplishments -> partial progress -> tomorrow candidates
 */
export function formatEveningSummary(
  date: string,
  data: CompletionResult
): string {
  const dateFormatted = new Date(date + "T12:00:00").toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  let md = `# Evening Check-in - ${dateFormatted}\n\n`;
  md += `**Completion Rate:** ${data.completionRate}% (${data.completedCount}/${data.totalPlanned} planned priorities)\n\n`;

  // Section 1: Accomplishments (positive-first)
  md += `## Accomplishments\n\n`;
  if (data.completed.length > 0) {
    for (const item of data.completed) {
      md += `- [x] **${item.title}** (${item.alignmentTag})\n`;
    }
  } else {
    md += `_No planned priorities completed today._\n`;
  }
  md += "\n";

  // Section 2: Bonus completions (unplanned wins)
  if (data.bonusCompleted.length > 0) {
    md += `## Bonus Completions\n\n`;
    md += `_Tasks completed that weren't in the morning plan:_\n\n`;
    for (const item of data.bonusCompleted) {
      md += `- [x] ${item.name}\n`;
    }
    md += "\n";
  }

  // Section 3: Tomorrow candidates (not failures -- reframed as forward-looking)
  if (data.incomplete.length > 0) {
    md += `## Tomorrow Candidates\n\n`;
    md += `_Priorities to carry forward:_\n\n`;
    for (const item of data.incomplete) {
      md += `- [ ] ${item.title} (${item.alignmentTag})\n`;
    }
    md += "\n";
  }

  md += `---\n*Generated by EveningCheckinGenerator at ${new Date().toISOString()}*\n`;

  return md;
}

/**
 * Generate a voice line summarizing the evening check-in.
 * Must be 16 words or fewer.
 */
export function generateVoiceLine(data: CompletionResult): string {
  if (data.totalPlanned === 0) {
    return "No morning priorities were set today. Consider setting them tomorrow.";
  }

  if (data.completionRate === 100) {
    return `All ${data.totalPlanned} planned priorities completed today. Great work.`;
  }

  if (data.completionRate >= 50) {
    return `Completed ${data.completedCount} of ${data.totalPlanned} priorities today, ${data.completionRate}% completion rate.`;
  }

  const carryForward = data.incomplete.length;
  return `${data.completedCount} of ${data.totalPlanned} priorities done. ${carryForward} carry forward to tomorrow.`;
}

/**
 * Write the evening summary markdown to BRIEFINGS directory.
 */
export function writeEveningSummary(date: string, markdown: string): void {
  if (!existsSync(BRIEFINGS_DIR)) {
    mkdirSync(BRIEFINGS_DIR, { recursive: true });
  }

  const filePath = join(BRIEFINGS_DIR, `evening-${date}.md`);
  writeFileSync(filePath, markdown);
}

// ============================================================================
// LucidTasks Integration
// ============================================================================

/**
 * Fetch completed tasks from LucidTasks for today using kaya-cli.
 */
async function fetchCompletedTasks(): Promise<CompletedTask[]> {
  try {
    const proc = Bun.spawn(
      ["kaya-cli", "tasks", "--completed", "--json"],
      { stdout: "pipe", stderr: "pipe" }
    );

    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      console.error("Failed to fetch completed tasks from LucidTasks");
      return [];
    }

    const trimmed = stdout.trim();
    if (!trimmed || !trimmed.startsWith("[")) return [];

    const allCompleted = JSON.parse(trimmed) as CompletedTask[];

    // Filter to tasks completed/modified today
    // Use completed_at or modified_at as proxy for completion date
    const today = new Date().toISOString().split("T")[0];
    return allCompleted.filter((task) => {
      const timestamp = task.completed_at || task.modified_at;
      if (!timestamp) return false;
      return timestamp.startsWith(today!);
    });
  } catch (error) {
    console.error("LucidTasks fetch error:", error);
    return [];
  }
}

// ============================================================================
// Habit Confirmation Prompts
// ============================================================================

/**
 * Generate habit confirmation prompts for habits not yet logged today.
 * Reads from the habit tracking sheet via kaya-cli.
 */
async function getHabitPrompts(): Promise<string[]> {
  try {
    const proc = Bun.spawn(
      ["kaya-cli", "sheets", "read", "1xrGAGvKlgckHbjnMevs9ZhlwtNWaUL5CzzgRQ82X9LA", "A1:AM10"],
      { stdout: "pipe", stderr: "pipe" }
    );

    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    if (exitCode !== 0) return [];

    const trimmed = stdout.trim();
    if (!trimmed) return [];

    // Parse rows
    let rows: string[][];
    if (trimmed.startsWith("[")) {
      rows = JSON.parse(trimmed) as string[][];
    } else {
      rows = trimmed.split("\n").map((line) => line.split("\t"));
    }

    if (rows.length < 2) return [];

    // Get today's column index (last column with data)
    const headers = rows[0]!;
    const todayColIndex = headers.length - 1;

    const unloggedHabits: string[] = [];

    for (let i = 1; i < rows.length; i++) {
      const row = rows[i]!;
      if (!row[0] || !row[0].trim()) continue;

      const habitName = row[0].trim();
      const todayValue = (row[todayColIndex] || "").trim().toLowerCase();

      // If today's value is empty, the habit hasn't been logged
      if (!todayValue || todayValue === "") {
        unloggedHabits.push(habitName);
      }
    }

    return unloggedHabits;
  } catch {
    return [];
  }
}

// ============================================================================
// Delivery
// ============================================================================

async function loadSettings(): Promise<Settings> {
  return await loadSettingsAsync() as Settings;
}

// deliverVoice and deliverTelegram imported from DeliveryUtils.ts

/**
 * Format Telegram-friendly summary (4096 char limit).
 */
function formatTelegramMessage(
  data: CompletionResult,
  habitPrompts: string[],
  date: string
): string {
  const dateFormatted = new Date(date + "T12:00:00").toLocaleDateString("en-US", {
    weekday: "long",
    month: "short",
    day: "numeric",
  });

  let msg = `*Evening Check-in - ${dateFormatted}*\n\n`;

  // Completion rate
  const rateEmoji = data.completionRate >= 80 ? "🎯" : data.completionRate >= 50 ? "📊" : "📋";
  msg += `${rateEmoji} *${data.completionRate}% completion* (${data.completedCount}/${data.totalPlanned})\n\n`;

  // Accomplishments
  if (data.completed.length > 0) {
    msg += `*Accomplishments*\n`;
    for (const item of data.completed) {
      msg += `✅ ${item.title}\n`;
    }
    msg += "\n";
  }

  // Bonus completions
  if (data.bonusCompleted.length > 0) {
    msg += `*Bonus*\n`;
    for (const item of data.bonusCompleted.slice(0, 5)) {
      msg += `⭐ ${item.name}\n`;
    }
    if (data.bonusCompleted.length > 5) {
      msg += `  _+${data.bonusCompleted.length - 5} more_\n`;
    }
    msg += "\n";
  }

  // Tomorrow candidates
  if (data.incomplete.length > 0) {
    msg += `*Tomorrow*\n`;
    for (const item of data.incomplete) {
      msg += `➡️ ${item.title}\n`;
    }
    msg += "\n";
  }

  // Habit prompts
  if (habitPrompts.length > 0) {
    msg += `*Habits to Log*\n`;
    for (const habit of habitPrompts) {
      msg += `🔔 ${habit}\n`;
    }
    msg += "\n";
  }

  return msg;
}

// ============================================================================
// Main
// ============================================================================

async function generateEveningCheckin(dryRun: boolean = false, jsonOutput: boolean = false): Promise<void> {
  const settings = await loadSettings();
  const name = settings.principal?.name || "Jm";
  const date = new Date().toISOString().split("T")[0]!;

  console.log("Evening Check-in Generator\n");
  console.log(`  Date: ${date}`);
  console.log(`  Mode: ${dryRun ? "DRY RUN" : "LIVE"}\n`);

  // Step 1: Read morning's planned priorities
  console.log("  Reading planned priorities...");
  const planned = readPlannedPriorities(date);

  if (!planned) {
    console.log("  No planned priorities found for today.");
    console.log("  This can happen if the morning briefing didn't run.");
  }

  const priorities = planned?.priorities || [];

  // Step 2: Fetch completed tasks from LucidTasks
  console.log("  Fetching completed tasks from LucidTasks...");
  const completedTasks = await fetchCompletedTasks();
  console.log(`  Found ${completedTasks.length} completed tasks today.`);

  // Step 3: Compare planned vs completed
  console.log("  Calculating completion...");
  const completionData = calculateCompletion(priorities, completedTasks);
  console.log(`  Completion rate: ${completionData.completionRate}%`);

  // Step 4: Get habit prompts
  console.log("  Checking habit logging...");
  const habitPrompts = await getHabitPrompts();
  if (habitPrompts.length > 0) {
    console.log(`  ${habitPrompts.length} habits not yet logged today.`);
  }

  // Step 5: Generate outputs
  const markdown = formatEveningSummary(date, completionData);
  const voiceLine = generateVoiceLine(completionData);
  const telegramMsg = formatTelegramMessage(completionData, habitPrompts, date);

  // JSON output mode
  if (jsonOutput) {
    const output = {
      date,
      completionData,
      habitPrompts,
      voiceLine,
      markdown,
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
    console.log("\n=== HABIT PROMPTS ===\n");
    if (habitPrompts.length > 0) {
      for (const h of habitPrompts) {
        console.log(`  - ${h}`);
      }
    } else {
      console.log("  All habits logged (or none configured).");
    }
    return;
  }

  // Step 6: Write evening summary to file
  console.log("\n  Writing evening summary...");
  writeEveningSummary(date, markdown);
  console.log(`  Written to: ${join(BRIEFINGS_DIR, `evening-${date}.md`)}`);

  // Step 7: Deliver via voice
  console.log("  Delivering voice notification...");
  await deliverVoice(voiceLine, "Evening Check-in");

  // Step 8: Deliver via Telegram
  console.log("  Delivering Telegram message...");
  await deliverTelegram(telegramMsg);

  console.log("\nEvening check-in complete!");
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
Evening Check-in Generator - Compare morning priorities vs actual completion

Usage:
  bun EveningCheckinGenerator.ts              Generate and deliver evening check-in
  bun EveningCheckinGenerator.ts --test       Dry-run mode (preview without delivery)
  bun EveningCheckinGenerator.ts --json       Output as JSON
  bun EveningCheckinGenerator.ts --help       Show this help

Features:
  - Reads morning's planned priorities (from PriorityCandidatesBlock)
  - Queries LucidTasks for tasks completed today
  - Calculates completion rate
  - Highlights accomplishments first (positive-first approach)
  - Lists bonus completions (unplanned wins)
  - Suggests tomorrow candidates for incomplete items
  - Prompts for unlogged habits
  - Delivers via voice + Telegram

Files:
  Input:  MEMORY/BRIEFINGS/planned-priorities-{date}.json
  Output: MEMORY/BRIEFINGS/evening-{date}.md
`);
    process.exit(0);
  }

  const dryRun = values.test || false;
  const jsonOutput = values.json || false;

  await generateEveningCheckin(dryRun, jsonOutput);
}

// Run if executed directly
if (import.meta.main) {
  main().catch(console.error);
}
