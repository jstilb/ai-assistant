#!/usr/bin/env bun
/**
 * DailyBriefingGenerator - Morning briefing aggregation and multi-channel delivery
 *
 * Aggregates data from multiple sources:
 * - Calendar (today's schedule, free windows)
 * - LucidTasks (priority tasks, due dates)
 * - TELOS (active goals, missions)
 * - Learnings (patterns from ratings.jsonl)
 *
 * Delivers to multiple channels:
 * - Voice (spoken aloud via NotificationService)
 * - Written log (MEMORY/BRIEFINGS/YYYY-MM-DD.md)
 * - Push notification (ntfy)
 * - Telegram (mobile reference)
 *
 * Usage:
 *   bun DailyBriefingGenerator.ts              # Generate and deliver briefing
 *   bun DailyBriefingGenerator.ts --dry-run    # Preview without sending
 *   bun DailyBriefingGenerator.ts --json       # Output as JSON
 *   bun DailyBriefingGenerator.ts --help       # Show help
 */

import { parseArgs } from "util";
import * as fs from "fs";
import * as path from "path";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

// ============================================================================
// Configuration
// ============================================================================

const KAYA_HOME = process.env.KAYA_DIR || path.join(process.env.HOME!, ".claude");
const BRIEFINGS_DIR = path.join(KAYA_HOME, "MEMORY", "BRIEFINGS");
const CONTEXT_DIR = path.join(KAYA_HOME, "context");
const TELOS_DIR = path.join(KAYA_HOME, "skills", "CORE", "USER", "TELOS");
const RATINGS_FILE = path.join(KAYA_HOME, "MEMORY", "LEARNING", "SIGNALS", "ratings.jsonl");
const SETTINGS_FILE = path.join(KAYA_HOME, "settings.json");

// ============================================================================
// Types
// ============================================================================

interface CalendarEvent {
  time: string;
  title: string;
  duration: string;
  location?: string;
}

interface Task {
  title: string;
  dueDate?: string;
  priority?: string;
  project?: string;
}

interface Goal {
  id: string;
  title: string;
  isWIG: boolean;
  missionId?: string;
}

interface Mission {
  id: string;
  title: string;
}

interface RatingPattern {
  avgRating: number;
  trend: "up" | "down" | "stable";
  topPattern?: string;
}

interface BriefingData {
  date: string;
  greeting: string;
  calendar: {
    events: CalendarEvent[];
    freeWindows: string[];
    eventCount: number;
  };
  tasks: {
    dueToday: Task[];
    thisWeek: Task[];
    upcoming: Task[];
  };
  goals: {
    activeWIGs: Goal[];
    activeMissions: Mission[];
    focusRecommendation: string;
  };
  patterns: RatingPattern;
}

interface Settings {
  principal?: { name?: string; timezone?: string };
  daidentity?: { name?: string };
}

// ============================================================================
// Data Gatherers
// ============================================================================

async function loadSettings(): Promise<Settings> {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      return JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf-8"));
    }
  } catch (e) {
    // Fail silently
  }
  return {};
}

async function gatherCalendar(): Promise<BriefingData["calendar"]> {
  const result: BriefingData["calendar"] = {
    events: [],
    freeWindows: [],
    eventCount: 0,
  };

  try {
    // Try to read existing calendar context
    const contextPath = path.join(CONTEXT_DIR, "CalendarContext.md");
    if (fs.existsSync(contextPath)) {
      const content = fs.readFileSync(contextPath, "utf-8");

      // Parse events from the context file
      const todayMatch = content.match(/## Today's Schedule\n\n\|[^\n]+\n\|[^\n]+\n([\s\S]*?)(?=\n##|\n---|\n\*Generated|$)/);
      if (todayMatch) {
        const lines = todayMatch[1].trim().split("\n").filter(l => l.startsWith("|"));
        for (const line of lines) {
          const parts = line.split("|").map(p => p.trim()).filter(Boolean);
          if (parts.length >= 2) {
            result.events.push({
              time: parts[0],
              title: parts[1],
              duration: parts[2] || "",
              location: parts[3],
            });
          }
        }
      }

      // Parse free windows
      const freeMatch = content.match(/## Free Windows\n\n\|[^\n]+\n\|[^\n]+\n([\s\S]*?)(?=\n##|\n---|\n\*Generated|$)/);
      if (freeMatch) {
        const lines = freeMatch[1].trim().split("\n").filter(l => l.startsWith("|"));
        for (const line of lines) {
          const parts = line.split("|").map(p => p.trim()).filter(Boolean);
          if (parts.length >= 2) {
            result.freeWindows.push(`${parts[0]}: ${parts[1]}`);
          }
        }
      }

      result.eventCount = result.events.length;
    }
  } catch (e) {
    console.error("Calendar gather error:", e);
  }

  // If no events found, try kaya-cli directly
  if (result.events.length === 0) {
    try {
      const { stdout } = await execAsync(`kaya-cli calendar list --days 1 2>/dev/null || echo ""`);
      if (stdout.trim()) {
        // Parse CLI output (format varies)
        const lines = stdout.trim().split("\n");
        for (const line of lines) {
          if (line.includes(":") && !line.startsWith("#")) {
            const [time, ...rest] = line.split(" - ");
            if (time && rest.length > 0) {
              result.events.push({
                time: time.trim(),
                title: rest.join(" - ").trim(),
                duration: "",
              });
            }
          }
        }
        result.eventCount = result.events.length;
      }
    } catch (e) {
      // CLI not available
    }
  }

  return result;
}

async function gatherTasks(): Promise<BriefingData["tasks"]> {
  const result: BriefingData["tasks"] = {
    dueToday: [],
    thisWeek: [],
    upcoming: [],
  };

  try {
    // Try to read existing LucidTasks context
    const contextPath = path.join(CONTEXT_DIR, "LucidTasksContext.md");
    if (fs.existsSync(contextPath)) {
      const content = fs.readFileSync(contextPath, "utf-8");

      // Parse tasks - looking for task patterns
      const taskMatches = content.matchAll(/- \[[ x]\] ([^\n]+)/g);
      const today = new Date();

      for (const match of taskMatches) {
        const taskLine = match[1];
        const dueDateMatch = taskLine.match(/\(due: ([^)]+)\)/i) || taskLine.match(/\[([^\]]*due[^\]]*)\]/i);

        const task: Task = {
          title: taskLine.replace(/\(due:[^)]+\)/i, "").replace(/\[[^\]]*due[^\]]*\]/i, "").trim(),
          dueDate: dueDateMatch?.[1],
        };

        // Categorize by due date
        if (dueDateMatch) {
          const dueStr = dueDateMatch[1].toLowerCase();
          if (dueStr.includes("today") || dueStr === today.toISOString().split("T")[0]) {
            result.dueToday.push(task);
          } else if (dueStr.includes("this week") || dueStr.includes("tomorrow")) {
            result.thisWeek.push(task);
          } else {
            result.upcoming.push(task);
          }
        } else {
          result.upcoming.push(task);
        }
      }
    }
  } catch (e) {
    console.error("Tasks gather error:", e);
  }

  // Try kaya-cli as fallback
  if (result.dueToday.length === 0 && result.thisWeek.length === 0 && result.upcoming.length === 0) {
    try {
      const { stdout } = await execAsync(`kaya-cli tasks --limit 10 2>/dev/null || echo ""`);
      if (stdout.trim()) {
        const lines = stdout.trim().split("\n");
        for (const line of lines.slice(0, 5)) {
          // Skip error messages and empty lines
          if (line.trim() && !line.includes("Error:") && !line.includes("Run 'kaya-cli")) {
            result.upcoming.push({ title: line.trim() });
          }
        }
      }
    } catch (e) {
      // CLI not available
    }
  }

  return result;
}

async function gatherGoals(): Promise<BriefingData["goals"]> {
  const result: BriefingData["goals"] = {
    activeWIGs: [],
    activeMissions: [],
    focusRecommendation: "",
  };

  try {
    // Read TELOS goals
    const goalsPath = path.join(TELOS_DIR, "GOALS.md");
    if (fs.existsSync(goalsPath)) {
      const content = fs.readFileSync(goalsPath, "utf-8");

      // Check for WIG section
      const hasWIGSection = content.includes("## Q1 WIGs") || content.includes("WIG");

      // Parse goals - format is "### G0: Goal Title"
      const goalMatches = content.matchAll(/### (G\d+):\s*([^\n]+)/g);
      const allGoals: Goal[] = [];

      for (const match of goalMatches) {
        const id = match[1];
        const title = match[2].trim();

        // Check if this goal is in the WIG section (before the first "---" after WIGs header)
        const wigSectionStart = content.indexOf("## Q1 WIGs");
        const goalPosition = content.indexOf(`### ${id}:`);
        const nextSectionAfterWIG = wigSectionStart > -1 ? content.indexOf("---", wigSectionStart + 20) : -1;

        const isWIG = hasWIGSection &&
          wigSectionStart > -1 &&
          goalPosition > wigSectionStart &&
          (nextSectionAfterWIG === -1 || goalPosition < nextSectionAfterWIG);

        allGoals.push({ id, title, isWIG });
      }

      // Get WIGs first, then fill with other goals
      const wigs = allGoals.filter(g => g.isWIG);
      const nonWigs = allGoals.filter(g => !g.isWIG);

      result.activeWIGs = wigs.length > 0 ? wigs.slice(0, 3) : nonWigs.slice(0, 3);
    }

    // Read TELOS missions
    const missionsPath = path.join(TELOS_DIR, "MISSIONS.md");
    if (fs.existsSync(missionsPath)) {
      const content = fs.readFileSync(missionsPath, "utf-8");

      // Parse missions - format is "### M0: Mission Title" or "## M0: Mission Title"
      const missionMatches = content.matchAll(/##?#?\s*(M\d+):\s*([^\n]+)/g);
      for (const match of missionMatches) {
        const id = match[1];
        const title = match[2].trim();
        // Skip titles that are just status markers
        if (!title.startsWith("**Status") && title.length > 0) {
          result.activeMissions.push({ id, title });
        }
      }
    }

    // Generate focus recommendation
    if (result.activeWIGs.length > 0) {
      const topWIG = result.activeWIGs[0];
      result.focusRecommendation = `Focus on ${topWIG.id}: ${topWIG.title}`;
    } else if (result.activeMissions.length > 0) {
      result.focusRecommendation = `Advance ${result.activeMissions[0].id}: ${result.activeMissions[0].title}`;
    } else {
      result.focusRecommendation = "Set clear goals for today";
    }
  } catch (e) {
    console.error("Goals gather error:", e);
  }

  return result;
}

async function gatherPatterns(): Promise<BriefingData["patterns"]> {
  const result: BriefingData["patterns"] = {
    avgRating: 0,
    trend: "stable",
    topPattern: undefined,
  };

  try {
    if (fs.existsSync(RATINGS_FILE)) {
      const content = fs.readFileSync(RATINGS_FILE, "utf-8");
      const lines = content.trim().split("\n").filter(Boolean);

      // Get last 7 days of ratings
      const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
      const recentRatings: number[] = [];
      const olderRatings: number[] = [];
      const patterns: Record<string, number> = {};

      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          const entryDate = new Date(entry.timestamp).getTime();
          const rating = parseFloat(entry.rating);

          if (entryDate > weekAgo) {
            recentRatings.push(rating);
          } else if (entryDate > weekAgo - 7 * 24 * 60 * 60 * 1000) {
            olderRatings.push(rating);
          }

          // Count patterns from feedback
          if (entry.feedback) {
            const words = entry.feedback.toLowerCase().split(/\s+/);
            for (const word of words) {
              if (word.length > 4) {
                patterns[word] = (patterns[word] || 0) + 1;
              }
            }
          }
        } catch (e) {
          // Skip invalid lines
        }
      }

      // Calculate average and trend
      if (recentRatings.length > 0) {
        result.avgRating = recentRatings.reduce((a, b) => a + b, 0) / recentRatings.length;

        if (olderRatings.length > 0) {
          const olderAvg = olderRatings.reduce((a, b) => a + b, 0) / olderRatings.length;
          if (result.avgRating > olderAvg + 0.5) {
            result.trend = "up";
          } else if (result.avgRating < olderAvg - 0.5) {
            result.trend = "down";
          }
        }
      }

      // Find top pattern
      const sortedPatterns = Object.entries(patterns).sort((a, b) => b[1] - a[1]);
      if (sortedPatterns.length > 0 && sortedPatterns[0][1] >= 3) {
        result.topPattern = sortedPatterns[0][0];
      }
    }
  } catch (e) {
    console.error("Patterns gather error:", e);
  }

  return result;
}

// ============================================================================
// Briefing Generation
// ============================================================================

function getGreeting(settings: Settings): string {
  const hour = new Date().getHours();
  const name = settings.principal?.name || "User";

  if (hour < 12) {
    return `Good morning, ${name}`;
  } else if (hour < 17) {
    return `Good afternoon, ${name}`;
  }
  return `Good evening, ${name}`;
}

async function generateBriefing(): Promise<BriefingData> {
  const settings = await loadSettings();
  const today = new Date();
  const dateStr = today.toISOString().split("T")[0];

  // Gather all data in parallel
  const [calendar, tasks, goals, patterns] = await Promise.all([
    gatherCalendar(),
    gatherTasks(),
    gatherGoals(),
    gatherPatterns(),
  ]);

  return {
    date: dateStr,
    greeting: getGreeting(settings),
    calendar,
    tasks,
    goals,
    patterns,
  };
}

// ============================================================================
// Formatting
// ============================================================================

function formatMarkdown(data: BriefingData): string {
  const trendIcon = data.patterns.trend === "up" ? "↑" : data.patterns.trend === "down" ? "↓" : "→";

  let md = `# ${data.greeting} - ${formatDate(data.date)}

## Quick Stats

| Metric | Value |
|--------|-------|
| Events Today | ${data.calendar.eventCount} |
| Tasks Due Today | ${data.tasks.dueToday.length} |
| Active WIGs | ${data.goals.activeWIGs.length} |
| Rating Trend | ${data.patterns.avgRating.toFixed(1)} ${trendIcon} |

`;

  // Calendar section
  if (data.calendar.events.length > 0) {
    md += `## Today's Schedule

| Time | Event | Duration |
|------|-------|----------|
`;
    for (const event of data.calendar.events) {
      md += `| ${event.time} | ${event.title} | ${event.duration} |\n`;
    }
    md += "\n";

    if (data.calendar.freeWindows.length > 0) {
      md += `**Free windows:** ${data.calendar.freeWindows.join(", ")}\n\n`;
    }
  } else {
    md += `## Today's Schedule

No calendar events loaded. Run \`/info calendar\` to refresh.\n\n`;
  }

  // Tasks section
  md += `## Priority Tasks\n\n`;

  if (data.tasks.dueToday.length > 0) {
    for (const task of data.tasks.dueToday) {
      md += `- **[DUE TODAY]** ${task.title}\n`;
    }
  }

  if (data.tasks.thisWeek.length > 0) {
    for (const task of data.tasks.thisWeek.slice(0, 3)) {
      md += `- **[THIS WEEK]** ${task.title}\n`;
    }
  }

  if (data.tasks.upcoming.length > 0 && data.tasks.dueToday.length === 0 && data.tasks.thisWeek.length === 0) {
    for (const task of data.tasks.upcoming.slice(0, 3)) {
      md += `- ${task.title}\n`;
    }
  }

  if (data.tasks.dueToday.length === 0 && data.tasks.thisWeek.length === 0 && data.tasks.upcoming.length === 0) {
    md += `No tasks loaded. Run \`/info lucidtasks\` to refresh.\n`;
  }
  md += "\n";

  // Goals section
  md += `## Goal Focus

`;
  if (data.goals.activeWIGs.length > 0) {
    md += `**Active WIGs:** `;
    md += data.goals.activeWIGs.map(g => `${g.id} (${g.title.slice(0, 30)}${g.title.length > 30 ? "..." : ""})`).join(", ");
    md += "\n";
  }

  if (data.goals.activeMissions.length > 0) {
    md += `**Missions:** `;
    md += data.goals.activeMissions.slice(0, 3).map(m => m.id).join(", ");
    md += "\n";
  }

  md += `\n**Focus recommendation:** ${data.goals.focusRecommendation}\n\n`;

  // Patterns section
  md += `## Patterns & Insights

- **Rating trend:** ${data.patterns.avgRating.toFixed(1)} avg (${data.patterns.trend === "up" ? "↑ improving" : data.patterns.trend === "down" ? "↓ declining" : "→ stable"})
`;

  if (data.patterns.topPattern) {
    md += `- **Top pattern:** ${data.patterns.topPattern}\n`;
  }

  md += `
---
*Generated by DailyBriefingGenerator at ${new Date().toISOString()}*
`;

  return md;
}

function formatDate(dateStr: string): string {
  const date = new Date(dateStr);
  return date.toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

function formatVoiceSummary(data: BriefingData): string {
  const parts: string[] = [];

  parts.push(data.greeting);

  // Calendar summary
  if (data.calendar.eventCount > 0) {
    parts.push(`You have ${data.calendar.eventCount} event${data.calendar.eventCount > 1 ? "s" : ""} today`);
    if (data.calendar.events.length > 0) {
      const firstEvent = data.calendar.events[0];
      parts.push(`First up: ${firstEvent.title} at ${firstEvent.time}`);
    }
  } else {
    parts.push("Your calendar is clear today");
  }

  // Tasks summary
  if (data.tasks.dueToday.length > 0) {
    parts.push(`${data.tasks.dueToday.length} task${data.tasks.dueToday.length > 1 ? "s" : ""} due today`);
  }

  // Focus
  if (data.goals.focusRecommendation) {
    parts.push(data.goals.focusRecommendation);
  }

  return parts.join(". ") + ".";
}

function formatTelegramMessage(data: BriefingData): string {
  let msg = `*${data.greeting}*\n\n`;

  // Quick stats
  msg += `📅 *Today:* ${data.calendar.eventCount} events\n`;
  msg += `✅ *Tasks due:* ${data.tasks.dueToday.length}\n`;
  msg += `📊 *Rating:* ${data.patterns.avgRating.toFixed(1)} ${data.patterns.trend === "up" ? "↑" : data.patterns.trend === "down" ? "↓" : "→"}\n\n`;

  // Top events
  if (data.calendar.events.length > 0) {
    msg += `*Schedule:*\n`;
    for (const event of data.calendar.events.slice(0, 3)) {
      msg += `• ${event.time} - ${event.title}\n`;
    }
    msg += "\n";
  }

  // Priority tasks
  if (data.tasks.dueToday.length > 0) {
    msg += `*Due today:*\n`;
    for (const task of data.tasks.dueToday.slice(0, 3)) {
      msg += `• ${task.title}\n`;
    }
    msg += "\n";
  }

  // Focus
  msg += `🎯 *Focus:* ${data.goals.focusRecommendation}`;

  return msg;
}

function formatPushNotification(data: BriefingData): string {
  const parts: string[] = [];

  parts.push(`${data.calendar.eventCount} events`);
  parts.push(`${data.tasks.dueToday.length} tasks due`);

  if (data.calendar.events.length > 0) {
    parts.push(`First: ${data.calendar.events[0].title}`);
  }

  return parts.join(" | ");
}

// ============================================================================
// Delivery
// ============================================================================

async function deliverVoice(message: string): Promise<void> {
  try {
    const notificationPath = path.join(KAYA_HOME, "skills", "CORE", "Tools", "NotificationService.ts");
    if (fs.existsSync(notificationPath)) {
      const { notifySync } = await import(notificationPath);
      notifySync(message, { agentName: "Morning Briefing" });
    } else {
      // Fallback to direct curl
      await execAsync(`curl -s -X POST http://localhost:8888/notify -H "Content-Type: application/json" -d '{"message": ${JSON.stringify(message)}, "voice_enabled": true}' 2>/dev/null || true`);
    }
    console.log("✅ Voice delivered");
  } catch (e) {
    console.error("❌ Voice delivery failed:", e);
  }
}

async function deliverWritten(markdown: string, date: string): Promise<string> {
  try {
    if (!fs.existsSync(BRIEFINGS_DIR)) {
      fs.mkdirSync(BRIEFINGS_DIR, { recursive: true });
    }

    const filePath = path.join(BRIEFINGS_DIR, `${date}.md`);
    fs.writeFileSync(filePath, markdown);
    console.log(`✅ Written to: ${filePath}`);
    return filePath;
  } catch (e) {
    console.error("❌ Written delivery failed:", e);
    return "";
  }
}

async function deliverPush(title: string, message: string): Promise<void> {
  try {
    const settings = await loadSettings();
    const ntfyTopic = (settings as any).notifications?.ntfy?.topic;

    if (ntfyTopic) {
      await execAsync(`curl -s -X POST "https://ntfy.sh/${ntfyTopic}" -H "Title: ${title}" -d "${message}" 2>/dev/null || true`);
      console.log("✅ Push delivered");
    } else {
      console.log("⏭️ Push skipped (no ntfy topic configured)");
    }
  } catch (e) {
    console.error("❌ Push delivery failed:", e);
  }
}

async function deliverTelegram(message: string): Promise<void> {
  try {
    const telegramPath = path.join(KAYA_HOME, "skills", "Telegram", "Tools", "TelegramClient.ts");
    if (fs.existsSync(telegramPath)) {
      await execAsync(`bun "${telegramPath}" send "${message.replace(/"/g, '\\"')}" 2>/dev/null || true`);
      console.log("✅ Telegram delivered");
    } else {
      console.log("⏭️ Telegram skipped (client not found)");
    }
  } catch (e) {
    console.error("❌ Telegram delivery failed:", e);
  }
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      "dry-run": { type: "boolean" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
      "skip-voice": { type: "boolean" },
      "skip-telegram": { type: "boolean" },
      "skip-push": { type: "boolean" },
    },
  });

  if (values.help) {
    console.log(`
DailyBriefingGenerator - Morning briefing with multi-channel delivery

Usage:
  bun DailyBriefingGenerator.ts              Generate and deliver briefing
  bun DailyBriefingGenerator.ts --dry-run    Preview without sending
  bun DailyBriefingGenerator.ts --json       Output as JSON
  bun DailyBriefingGenerator.ts --skip-voice Skip voice delivery
  bun DailyBriefingGenerator.ts --skip-telegram Skip Telegram delivery
  bun DailyBriefingGenerator.ts --skip-push  Skip push notification

Delivery Channels:
  - Voice: Spoken via NotificationService
  - Written: Saved to MEMORY/BRIEFINGS/YYYY-MM-DD.md
  - Push: ntfy notification
  - Telegram: Mobile message

Data Sources:
  - Calendar: context/CalendarContext.md or kaya-cli
  - Tasks: context/LucidTasksContext.md or kaya-cli
  - Goals: TELOS/GOALS.md, TELOS/MISSIONS.md
  - Patterns: MEMORY/LEARNING/SIGNALS/ratings.jsonl
`);
    process.exit(0);
  }

  console.log("📋 Generating daily briefing...\n");

  // Generate briefing data
  const data = await generateBriefing();

  // JSON output mode
  if (values.json) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  // Format outputs
  const markdown = formatMarkdown(data);
  const voiceSummary = formatVoiceSummary(data);
  const telegramMessage = formatTelegramMessage(data);
  const pushMessage = formatPushNotification(data);

  // Dry run mode
  if (values["dry-run"]) {
    console.log("=== MARKDOWN ===\n");
    console.log(markdown);
    console.log("\n=== VOICE ===\n");
    console.log(voiceSummary);
    console.log("\n=== TELEGRAM ===\n");
    console.log(telegramMessage);
    console.log("\n=== PUSH ===\n");
    console.log(pushMessage);
    return;
  }

  // Deliver to all channels
  console.log("📤 Delivering to channels...\n");

  // Always write to file
  await deliverWritten(markdown, data.date);

  // Voice (unless skipped)
  if (!values["skip-voice"]) {
    await deliverVoice(voiceSummary);
  }

  // Push (unless skipped)
  if (!values["skip-push"]) {
    await deliverPush("Morning Briefing", pushMessage);
  }

  // Telegram (unless skipped)
  if (!values["skip-telegram"]) {
    await deliverTelegram(telegramMessage);
  }

  console.log("\n✅ Daily briefing complete!");
}

// Run if executed directly
if (import.meta.main) {
  main().catch(console.error);
}

// Exports for programmatic use
export { generateBriefing, formatMarkdown, formatVoiceSummary, formatTelegramMessage };
export type { BriefingData };
