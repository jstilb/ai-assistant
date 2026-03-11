#!/usr/bin/env bun
/**
 * PriorityCandidatesBlock.ts - Ranked daily priority suggestions for morning briefing
 *
 * Cross-references LucidTasks tasks and Google Calendar events to:
 * - Identify available time blocks in the day
 * - Rank tasks by urgency and goal alignment
 * - Suggest 5-7 priorities with time estimates
 * - Store planned priorities for Phase 2 evening comparison
 */

import { existsSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import type { BlockResult } from "./types.ts";

const KAYA_HOME = process.env.KAYA_DIR || join(process.env.HOME!, ".claude");
const BRIEFINGS_DIR = join(KAYA_HOME, "MEMORY", "BRIEFINGS");

export type { BlockResult };

interface LucidTask {
  title: string;
  dueDate?: string;
  project?: string;
  isOverdue: boolean;
  isDueToday: boolean;
  completed?: boolean;
  gid?: string;
  tags?: string[];
}

interface CalendarEvent {
  time: string;
  title: string;
  duration?: string;
  location?: string;
  startHour?: number;
  endHour?: number;
}

interface PriorityCandidate {
  rank: number;
  title: string;
  source: "lucidtasks" | "calendar" | "goal-derived";
  urgency: "overdue" | "due-today" | "goal-aligned" | "quick-win" | "upcoming";
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

export interface PriorityCandidatesBlockConfig {
  maxPriorities?: number;
  includeQuickWins?: boolean;
}

// Goal/mission keywords for alignment tagging
const ALIGNMENT_KEYWORDS: Record<string, string> = {
  "media": "G0 (Media Reduction)",
  "boredom": "G0/S0 (Boredom Blocks)",
  "storer": "G0/S2 (STORER)",
  "friend": "G1 (Make Friends)",
  "social": "G1/S4 (Social)",
  "community": "G1/S3 (Community)",
  "alignment": "G2 (Alignment Score)",
  "pomodoro": "G2/S1 (Pomodoro)",
  "writing": "M2 (Creative)",
  "book": "M2 (Creative)",
  "piano": "M2/G18 (Piano)",
  "family": "M3 (Family)",
  "julie": "M3/G20 (Partner)",
  "therapy": "M3/G19 (Therapy)",
  "lucidview": "M5/G25 (Lucidview)",
  "pai": "M5/G28 (AI Tools)",
  "stretch": "G33/S6 (Stretching)",
  "pt": "G33/S7 (PT Routine)",
  "rehab": "G33 (Recovery)",
  "exercise": "G33 (Recovery)",
  "surf": "M1/G9 (Surf)",
  "volleyball": "M1/G8 (Volleyball)",
  "dsa": "M1/G7 (DSA)",
  "travel": "M0 (Adventurer)",
  "mexico": "M0/G4 (Mexico City)",
  "tijuana": "M0/G3 (Tijuana)",
};

/**
 * Determine alignment tag for a task based on its title and project.
 */
function getAlignmentTag(title: string, project?: string): string {
  const searchStr = `${title} ${project || ""}`.toLowerCase();

  for (const [keyword, tag] of Object.entries(ALIGNMENT_KEYWORDS)) {
    if (searchStr.includes(keyword)) return tag;
  }

  return "General";
}

/**
 * Estimate time for a task based on title heuristics.
 * Returns the lower bound of the range when no calibration data exists.
 */
function estimateTime(title: string): string {
  const lower = title.toLowerCase();

  if (lower.includes("review") || lower.includes("check") || lower.includes("read")) return "15-30 min";
  if (lower.includes("call") || lower.includes("meeting")) return "30-60 min";
  if (lower.includes("write") || lower.includes("draft") || lower.includes("create")) return "60-90 min";
  if (lower.includes("plan") || lower.includes("research")) return "45-60 min";
  if (lower.includes("fix") || lower.includes("update") || lower.includes("respond")) return "15-30 min";
  if (lower.includes("build") || lower.includes("implement") || lower.includes("develop")) return "90-120 min";

  return "30-60 min";
}

/**
 * Keyword categories for matching tasks to historical durations.
 */
const ESTIMATE_KEYWORDS: Record<string, string[]> = {
  "review": ["review", "check", "read"],
  "meeting": ["call", "meeting"],
  "writing": ["write", "draft", "create"],
  "planning": ["plan", "research"],
  "fix": ["fix", "update", "respond"],
  "build": ["build", "implement", "develop"],
};

/**
 * Get a calibrated estimate using historical LucidTasks data.
 * Falls back to heuristic lower-bound if insufficient data.
 */
function getCalibratedEstimate(title: string): string {
  try {
    // Lazy import to avoid circular dependency at module level
    const { getTaskDB } = require("../../LucidTasks/Tools/TaskDB.ts");
    const db = getTaskDB();
    const lower = title.toLowerCase();

    // Find matching keyword category
    for (const [category, keywords] of Object.entries(ESTIMATE_KEYWORDS)) {
      if (keywords.some((kw) => lower.includes(kw))) {
        const historical = db.getAverageDurationByKeyword(category);
        if (historical) {
          return `~${Math.round(historical.medianMinutes)} min`;
        }
        // Fall back to lower bound of heuristic range
        break;
      }
    }
  } catch {
    // TaskDB unavailable — fall through to heuristic
  }

  // Fallback: use heuristic but take the lower bound
  return estimateTime(title);
}

/**
 * Run a CLI command via Bun.spawn and return stdout.
 */
async function runCli(args: string[]): Promise<string> {
  const proc = Bun.spawn(args, {
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    throw new Error(`${args.join(" ")} failed: ${stderr.trim() || `exit code ${exitCode}`}`);
  }

  return stdout.trim();
}

/**
 * Fetch tasks from LucidTasks via kaya-cli.
 */
async function fetchLucidTasks(): Promise<LucidTask[]> {
  let stdout: string;
  try {
    stdout = await runCli(["kaya-cli", "tasks", "--json"]);
  } catch {
    return [];
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayStr = today.toISOString().split("T")[0];

  const tasks: LucidTask[] = [];

  if (stdout.startsWith("[")) {
    try {
      const parsed = JSON.parse(stdout);
      for (const task of parsed) {
        if (task.completed === true) continue;

        const title = task.name || task.title || "Untitled";
        const dueOn = task.due_on || task.dueDate || task.due;
        const dueDate = dueOn ? new Date(dueOn) : null;

        let isOverdue = false;
        let isDueToday = false;

        if (dueDate) {
          dueDate.setHours(0, 0, 0, 0);
          isDueToday = dueOn === todayStr;
          isOverdue = dueDate < today && !isDueToday;
        }

        tasks.push({
          title,
          dueDate: dueOn,
          project: task.project?.name || task.projectName,
          isOverdue,
          isDueToday,
          gid: task.gid,
          tags: task.tags?.map((t: { name: string }) => t.name) || [],
        });
      }
    } catch {
      // JSON parse failed
    }
  }

  return tasks;
}

/**
 * Fetch calendar events via kaya-cli.
 */
async function fetchCalendarEvents(): Promise<CalendarEvent[]> {
  let stdout: string;
  try {
    stdout = await runCli(["kaya-cli", "gcal", "today", "--json"]);
  } catch {
    return [];
  }

  const events: CalendarEvent[] = [];

  if (stdout.startsWith("[")) {
    try {
      const parsed = JSON.parse(stdout);
      for (const event of parsed) {
        const start = event.start?.dateTime || event.start?.date || event.time || "";
        const end = event.end?.dateTime || event.end?.date || "";

        let time = start;
        let startHour: number | undefined;
        let endHour: number | undefined;

        if (start.includes("T")) {
          const startDate = new Date(start);
          time = startDate.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
          startHour = startDate.getHours();
        }
        if (end.includes("T")) {
          endHour = new Date(end).getHours();
        }

        events.push({
          time,
          title: event.summary || event.title || "Untitled",
          duration: event.duration,
          location: event.location,
          startHour,
          endHour,
        });
      }
    } catch {
      // JSON parse failed
    }
  }

  return events;
}

/**
 * Calculate available hours by subtracting calendar events from work hours.
 */
function calculateAvailableHours(events: CalendarEvent[]): number {
  const workHours = 8; // 9 AM to 5 PM
  let busyHours = 0;

  for (const event of events) {
    if (event.startHour !== undefined && event.endHour !== undefined) {
      busyHours += event.endHour - event.startHour;
    } else {
      // Estimate 1 hour per event without duration info
      busyHours += 1;
    }
  }

  return Math.max(0, workHours - busyHours);
}

/**
 * Rank and select priority candidates.
 */
function rankPriorities(
  tasks: LucidTask[],
  events: CalendarEvent[],
  maxPriorities: number,
  includeQuickWins: boolean
): PriorityCandidate[] {
  const candidates: PriorityCandidate[] = [];

  // 1. Overdue tasks (highest priority)
  const overdueTasks = tasks.filter((t) => t.isOverdue);
  for (const task of overdueTasks) {
    candidates.push({
      rank: 0,
      title: task.title,
      source: "lucidtasks",
      urgency: "overdue",
      timeEstimate: getCalibratedEstimate(task.title),
      alignmentTag: getAlignmentTag(task.title, task.project),
      taskId: task.gid,
    });
  }

  // 2. Due today tasks
  const dueTodayTasks = tasks.filter((t) => t.isDueToday);
  for (const task of dueTodayTasks) {
    candidates.push({
      rank: 0,
      title: task.title,
      source: "lucidtasks",
      urgency: "due-today",
      timeEstimate: getCalibratedEstimate(task.title),
      alignmentTag: getAlignmentTag(task.title, task.project),
      taskId: task.gid,
    });
  }

  // 3. Goal-aligned tasks (tasks that match TELOS goals)
  const goalAligned = tasks.filter(
    (t) => !t.isOverdue && !t.isDueToday && getAlignmentTag(t.title, t.project) !== "General"
  );
  for (const task of goalAligned) {
    candidates.push({
      rank: 0,
      title: task.title,
      source: "lucidtasks",
      urgency: "goal-aligned",
      timeEstimate: getCalibratedEstimate(task.title),
      alignmentTag: getAlignmentTag(task.title, task.project),
      taskId: task.gid,
    });
  }

  // 4. Quick wins (tasks with short time estimates)
  if (includeQuickWins) {
    const quickWins = tasks.filter(
      (t) =>
        !t.isOverdue &&
        !t.isDueToday &&
        getAlignmentTag(t.title, t.project) === "General" &&
        estimateTime(t.title).startsWith("15")
    );
    for (const task of quickWins) {
      candidates.push({
        rank: 0,
        title: task.title,
        source: "lucidtasks",
        urgency: "quick-win",
        timeEstimate: getCalibratedEstimate(task.title),
        alignmentTag: "Quick Win",
        taskId: task.gid,
      });
    }
  }

  // Assign ranks based on urgency ordering
  const urgencyOrder: Record<string, number> = {
    "overdue": 1,
    "due-today": 2,
    "goal-aligned": 3,
    "quick-win": 4,
    "upcoming": 5,
  };

  candidates.sort((a, b) => urgencyOrder[a.urgency]! - urgencyOrder[b.urgency]!);

  // Assign ranks and limit
  const limited = candidates.slice(0, maxPriorities);
  for (let i = 0; i < limited.length; i++) {
    limited[i]!.rank = i + 1;
  }

  return limited;
}

/**
 * Write planned priorities to JSON for Phase 2 evening comparison.
 */
function writePlannedPriorities(priorities: PriorityCandidate[], availableHours: number, calendarEvents: number): void {
  if (!existsSync(BRIEFINGS_DIR)) {
    mkdirSync(BRIEFINGS_DIR, { recursive: true });
  }

  const date = new Date().toISOString().split("T")[0];
  const filePath = join(BRIEFINGS_DIR, `planned-priorities-${date}.json`);

  const data: PlannedPriorities = {
    date: date!,
    generatedAt: new Date().toISOString(),
    priorities,
    availableHours,
    calendarEvents,
  };

  writeFileSync(filePath, JSON.stringify(data, null, 2));
}

/**
 * Get urgency label for display.
 */
function urgencyLabel(urgency: string): string {
  switch (urgency) {
    case "overdue": return "OVERDUE";
    case "due-today": return "Due Today";
    case "goal-aligned": return "Goal-Aligned";
    case "quick-win": return "Quick Win";
    case "upcoming": return "Upcoming";
    default: return urgency;
  }
}

export async function execute(config: PriorityCandidatesBlockConfig = {}): Promise<BlockResult> {
  const { maxPriorities = 7, includeQuickWins = true } = config;

  try {
    // Fetch data from LucidTasks and Calendar in parallel
    const [tasks, events] = await Promise.all([
      fetchLucidTasks(),
      fetchCalendarEvents(),
    ]);

    const availableHours = calculateAvailableHours(events);
    const priorities = rankPriorities(tasks, events, maxPriorities, includeQuickWins);

    // Write planned priorities for Phase 2 evening comparison
    writePlannedPriorities(priorities, availableHours, events.length);

    // Format markdown
    let markdown = "## Priority Candidates\n\n";

    if (events.length > 0) {
      markdown += `**Calendar:** ${events.length} event${events.length > 1 ? "s" : ""} today, ~${availableHours}h available\n\n`;
    } else {
      markdown += `**Calendar:** Clear day, ~${availableHours}h available\n\n`;
    }

    if (priorities.length > 0) {
      for (const p of priorities) {
        const urgencyStr = p.urgency === "overdue" ? " **OVERDUE**" : "";
        markdown += `${p.rank}. **${p.title}**${urgencyStr}\n`;
        markdown += `   - ${urgencyLabel(p.urgency)} | ${p.timeEstimate} | ${p.alignmentTag}\n`;
      }
      markdown += "\n";
    } else {
      markdown += "No priority candidates identified. Check LucidTasks for tasks.\n\n";
    }

    // Overdue warning
    const overdueCount = priorities.filter((p) => p.urgency === "overdue").length;
    if (overdueCount > 0) {
      markdown += `**Warning:** ${overdueCount} overdue task${overdueCount > 1 ? "s" : ""} need attention.\n`;
    }

    // Summary
    const parts: string[] = [];
    if (overdueCount > 0) parts.push(`${overdueCount} overdue`);
    const dueTodayCount = priorities.filter((p) => p.urgency === "due-today").length;
    if (dueTodayCount > 0) parts.push(`${dueTodayCount} due today`);
    const goalCount = priorities.filter((p) => p.urgency === "goal-aligned").length;
    if (goalCount > 0) parts.push(`${goalCount} goal-aligned`);

    const summary = priorities.length > 0
      ? `${priorities.length} priorities: ${parts.join(", ") || "ready"}`
      : "No priorities identified";

    return {
      blockName: "priorityCandidates",
      success: true,
      data: {
        priorities,
        availableHours,
        calendarEvents: events.length,
        overdueCount,
        dueTodayCount,
        goalAlignedCount: goalCount,
        topPriority: priorities[0] || null,
      },
      markdown,
      summary,
    };
  } catch (error) {
    return {
      blockName: "priorityCandidates",
      success: false,
      data: {},
      markdown: "## Priority Candidates\n\nFailed to generate priorities.\n",
      summary: "Priorities unavailable",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// CLI entry point
if (import.meta.main) {
  const args = process.argv.slice(2);

  if (args.includes("--test") || args.includes("-t")) {
    execute({ maxPriorities: 7, includeQuickWins: true })
      .then((result) => {
        console.log("=== Priority Candidates Block Test ===\n");
        console.log("Success:", result.success);
        console.log("\nMarkdown:\n", result.markdown);
        console.log("\nSummary:", result.summary);
        if (result.error) console.log("\nError:", result.error);
        console.log("\nData:", JSON.stringify(result.data, null, 2));
      })
      .catch(console.error);
  } else {
    console.log("Usage: bun PriorityCandidatesBlock.ts --test");
  }
}
