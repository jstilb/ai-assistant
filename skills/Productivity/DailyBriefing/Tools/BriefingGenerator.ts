#!/usr/bin/env bun
/**
 * BriefingGenerator.ts - Main orchestrator for daily briefings
 *
 * Loads BriefingConfig.yaml, executes enabled blocks in priority order,
 * and delivers to configured channels (Telegram, written log, push, voice).
 *
 * Usage:
 *   bun BriefingGenerator.ts              # Generate and deliver
 *   bun BriefingGenerator.ts --dry-run    # Preview without delivery
 *   bun BriefingGenerator.ts --json       # Output as JSON
 *   bun BriefingGenerator.ts --help
 */

import { parseArgs } from "util";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { parse as parseYaml } from "yaml";
import { execSync } from "child_process";
import { marked } from "marked";
import { deliverVoice as deliverVoiceShared, deliverTelegram as deliverTelegramShared, loadSettings as loadSettingsAsync } from "./DeliveryUtils.ts";

// Block imports
import { execute as executeGoals } from "./GoalsBlock.ts";
import { execute as executeCalendar } from "./CalendarBlock.ts";
import { execute as executeApprovalQueue } from "./ApprovalQueueBlock.ts";
import { execute as executeWeather } from "./WeatherBlock.ts";
import { execute as executeNews } from "./NewsBlock.ts";
import { execute as executeMissionGrouped } from "./MissionGroupedBlock.ts";
import { execute as executeStaleItems } from "./StaleItemBlock.ts";
import { execute as executeStrategies } from "./StrategiesBlock.ts";
import { execute as executeHabitTracking } from "./HabitTrackingBlock.ts";
import { execute as executePriorityCandidates } from "./PriorityCandidatesBlock.ts";
import { execute as executeLearningPulse } from "./LearningPulseBlock.ts";
import { execute as executeLucidTasks } from "./LucidTasksBlock.ts";
import { execute as executeHealth } from "./HealthBlock.ts";
import { execute as executeGmailInbox } from "./GmailInboxBlock.ts";
import { execute as executeGraphInsights } from "./GraphInsightsBlock.ts";
import { execute as executeEcosystemUpdates } from "./EcosystemUpdatesBlock.ts";

// ============================================================================
// Configuration
// ============================================================================

const KAYA_HOME = process.env.KAYA_DIR || join(process.env.HOME!, ".claude");
const SKILL_DIR = join(KAYA_HOME, "skills", "DailyBriefing");
const CONFIG_FILE = join(SKILL_DIR, "BriefingConfig.yaml");
const BRIEFINGS_DIR = join(KAYA_HOME, "MEMORY", "BRIEFINGS");
const SETTINGS_FILE = join(KAYA_HOME, "settings.json");

// Canvas ecosystem integration (additive — never breaks existing delivery)
const CANVAS_RENDERER_PATH = join(KAYA_HOME, "skills", "Canvas", "Tools", "CanvasRenderer.ts");

// ============================================================================
// Types
// ============================================================================

import type { BlockResult } from "./types.ts";

interface SectionConfig {
  enabled: boolean;
  priority: number;
  settings?: Record<string, unknown>;
}

interface DeliveryConfig {
  telegram?: { enabled: boolean };
  writtenLog?: { enabled: boolean; path?: string };
  push?: { enabled: boolean };
  voice?: { enabled: boolean };
}

interface BriefingConfig {
  version: number;
  schedule?: { time: string; enabled: boolean };
  delivery: DeliveryConfig;
  sections: Record<string, SectionConfig>;
}

interface Settings {
  principal?: { name?: string; timezone?: string };
  daidentity?: { name?: string };
  notifications?: { ntfy?: { topic?: string } };
}

interface BriefingOutput {
  date: string;
  greeting: string;
  blocks: BlockResult[];
  markdown: string;
  voiceSummary: string;
  pushMessage: string;
}

// ============================================================================
// Config Loading
// ============================================================================

function loadConfig(): BriefingConfig {
  if (!existsSync(CONFIG_FILE)) {
    // Return default config
    return {
      version: 1,
      delivery: {
        telegram: { enabled: true },
        writtenLog: { enabled: true, path: "MEMORY/BRIEFINGS" },
        push: { enabled: true },
        voice: { enabled: true },
      },
      sections: {
        goals: { enabled: true, priority: 1 },
        approvalQueue: { enabled: true, priority: 2 },
        weather: { enabled: true, priority: 3 },
        calendar: { enabled: true, priority: 4 },
        lucidTasks: { enabled: true, priority: 5 },
        news: { enabled: true, priority: 6 },
      },
    };
  }

  const content = readFileSync(CONFIG_FILE, "utf-8");
  return parseYaml(content) as BriefingConfig;
}

async function loadSettings(): Promise<Settings> {
  return await loadSettingsAsync() as Settings;
}

// ============================================================================
// Block Execution
// ============================================================================

type BlockExecutor = (config: Record<string, unknown>) => Promise<BlockResult>;

const BLOCK_EXECUTORS: Record<string, BlockExecutor> = {
  goals: executeGoals,
  calendar: executeCalendar,
  approvalQueue: executeApprovalQueue,
  weather: executeWeather,
  news: executeNews,
  missionGrouped: executeMissionGrouped,
  staleItems: executeStaleItems,
  strategies: executeStrategies,
  habitTracking: executeHabitTracking,
  priorityCandidates: executePriorityCandidates,
  learningPulse: executeLearningPulse,
  lucidTasks: executeLucidTasks,
  health: executeHealth,
  gmailInbox: executeGmailInbox,
  graphInsights: executeGraphInsights,
  ecosystemUpdates: executeEcosystemUpdates,
};

async function executeBlocks(config: BriefingConfig): Promise<BlockResult[]> {
  // Get enabled sections sorted by priority
  const enabledSections = Object.entries(config.sections)
    .filter(([_, section]) => section.enabled)
    .sort((a, b) => a[1].priority - b[1].priority);

  const results: BlockResult[] = [];

  for (const [name, section] of enabledSections) {
    const executor = BLOCK_EXECUTORS[name];
    if (!executor) {
      console.error(`Unknown block: ${name}`);
      continue;
    }

    try {
      console.log(`  Executing ${name}...`);
      const result = await executor(section.settings || {});
      results.push(result);
    } catch (error) {
      console.error(`  Error in ${name}:`, error);
      results.push({
        blockName: name,
        success: false,
        data: {},
        markdown: `## ${name}\n\nError loading ${name}.\n`,
        summary: `${name} error`,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return results;
}

// ============================================================================
// Formatting
// ============================================================================

function wrapInHtml(markdown: string, date: string): string {
  const body = marked.parse(markdown) as string;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Daily Briefing — ${date}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; line-height: 1.6; color: #1a1a1a; background: #f8f9fa; margin: 0; padding: 16px; }
  .container { max-width: 680px; margin: 0 auto; background: #fff; border-radius: 8px; padding: 24px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
  h1 { font-size: 1.4em; border-bottom: 2px solid #e9ecef; padding-bottom: 8px; }
  h2 { font-size: 1.15em; color: #495057; margin-top: 1.5em; }
  table { width: 100%; border-collapse: collapse; margin: 12px 0; font-size: 0.92em; }
  th, td { padding: 8px 10px; border: 1px solid #dee2e6; text-align: left; }
  th { background: #f1f3f5; font-weight: 600; }
  tr:nth-child(even) { background: #f8f9fa; }
  code { background: #f1f3f5; padding: 2px 5px; border-radius: 3px; font-size: 0.9em; }
  pre { background: #f1f3f5; padding: 12px; border-radius: 6px; overflow-x: auto; }
  a { color: #228be6; }
  ul, ol { padding-left: 20px; }
  hr { border: none; border-top: 1px solid #e9ecef; margin: 20px 0; }
  em { color: #868e96; }
</style>
</head>
<body><div class="container">
${body}
</div></body>
</html>`;
}

function getGreeting(settings: Settings): string {
  const hour = new Date().getHours();
  const name = settings.principal?.name || "Jm";

  if (hour < 12) {
    return `Good morning, ${name}`;
  } else if (hour < 17) {
    return `Good afternoon, ${name}`;
  }
  return `Good evening, ${name}`;
}

function formatDate(dateStr: string, tz: string): string {
  // dateStr is "YYYY-MM-DD" — append time to avoid UTC midnight shift
  const d = new Date(`${dateStr}T12:00:00`);
  return d.toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: tz,
  });
}

function formatMarkdown(greeting: string, date: string, blocks: BlockResult[], tz: string): string {
  let md = `# ${greeting} - ${formatDate(date, tz)}\n\n`;

  for (const block of blocks) {
    md += block.markdown + "\n";
  }

  md += `---\n*Generated by DailyBriefing at ${new Date().toISOString()}*\n`;

  return md;
}

function formatVoiceSummary(greeting: string, blocks: BlockResult[]): string {
  const parts: string[] = [greeting];

  // Calendar
  const calendar = blocks.find((b) => b.blockName === "calendar");
  if (calendar?.success) {
    const eventCount = (calendar.data.eventCount as number) || 0;
    if (eventCount > 0) {
      parts.push(`You have ${eventCount} event${eventCount > 1 ? "s" : ""} today`);
    } else {
      parts.push("Your calendar is clear today");
    }
  }

  // LucidTasks
  const lucidTasks = blocks.find((b) => b.blockName === "lucidTasks");
  if (lucidTasks?.success) {
    const overdueCount = (lucidTasks.data.overdueCount as number) || 0;
    const dueTodayCount = (lucidTasks.data.dueTodayCount as number) || 0;
    if (overdueCount > 0) {
      parts.push(`${overdueCount} task${overdueCount > 1 ? "s" : ""} overdue`);
    }
    if (dueTodayCount > 0) {
      parts.push(`${dueTodayCount} due today`);
    }
  }

  // Tasks (LucidTasks fallback — check both block names for compat)
  const tasksLegacy = blocks.find((b) => b.blockName === "lucidTasks" || b.blockName === "asanaTasks");
  if (tasksLegacy?.success) {
    const dueToday = (tasksLegacy.data.dueToday as unknown[])?.length || 0;
    const overdue = (tasksLegacy.data.overdue as unknown[])?.length || 0;
    if (dueToday > 0) {
      parts.push(`${dueToday} task${dueToday > 1 ? "s" : ""} due today`);
    }
    if (overdue > 0) {
      parts.push(`${overdue} overdue`);
    }
  }

  // Goals
  const goals = blocks.find((b) => b.blockName === "goals");
  if (goals?.success) {
    const focus = goals.data.focusRecommendation as string;
    if (focus) {
      parts.push(focus);
    }
  }

  // Strategies
  const strats = blocks.find((b) => b.blockName === "strategies");
  if (strats?.success) {
    const worst = strats.data.worstStrategy as { id: string; name: string; gap: number } | null;
    if (worst) {
      parts.push(`Biggest strategy gap is ${worst.id}, ${worst.name}, at ${worst.gap}%`);
    }
  }

  // Habit Tracking - mention worst habit
  const habits = blocks.find((b) => b.blockName === "habitTracking");
  if (habits?.success) {
    const worst = habits.data.worstHabit as { name: string; rollingAvg: number } | null;
    if (worst) {
      parts.push(`Weakest habit is ${worst.name} at ${worst.rollingAvg}%`);
    }
  }

  // Priority Candidates - mention top 3
  const priorities = blocks.find((b) => b.blockName === "priorityCandidates");
  if (priorities?.success) {
    const top = priorities.data.topPriority as { title: string; urgency: string } | null;
    const overdueCount = priorities.data.overdueCount as number || 0;
    if (overdueCount > 0) {
      parts.push(`${overdueCount} overdue task${overdueCount > 1 ? "s" : ""} need attention`);
    } else if (top) {
      parts.push(`Top priority: ${top.title}`);
    }
  }

  // Weather
  const weather = blocks.find((b) => b.blockName === "weather");
  if (weather?.success) {
    parts.push(weather.summary);
  }

  return parts.join(". ") + ".";
}

function formatPushMessage(blocks: BlockResult[]): string {
  const parts: string[] = [];

  const calendar = blocks.find((b) => b.blockName === "calendar");
  if (calendar) parts.push(calendar.summary);

  const tasks = blocks.find((b) => b.blockName === "lucidTasks");
  if (tasks) parts.push(tasks.summary);

  const weather = blocks.find((b) => b.blockName === "weather");
  if (weather) parts.push(weather.summary);

  return parts.join(" | ");
}

// ============================================================================
// Delivery
// ============================================================================

async function deliverVoice(message: string): Promise<void> {
  await deliverVoiceShared(message, "Morning Briefing");
  console.log("✅ Voice delivered");
}

async function deliverWritten(markdown: string, date: string, config: BriefingConfig): Promise<string> {
  try {
    const logDir = config.delivery.writtenLog?.path
      ? join(KAYA_HOME, config.delivery.writtenLog.path)
      : BRIEFINGS_DIR;

    if (!existsSync(logDir)) {
      mkdirSync(logDir, { recursive: true });
    }

    // Write markdown (local reference)
    const mdPath = join(logDir, `${date}.md`);
    writeFileSync(mdPath, markdown);
    console.log(`✅ Written to: ${mdPath}`);

    // Write HTML (for Drive upload — renders in mobile browsers)
    const htmlPath = join(logDir, `${date}.html`);
    writeFileSync(htmlPath, wrapInHtml(markdown, date));
    console.log(`✅ Written to: ${htmlPath}`);

    return htmlPath;
  } catch (e) {
    console.error("❌ Written delivery failed:", e);
    return "";
  }
}

async function deliverPush(title: string, message: string): Promise<void> {
  try {
    const settings = await loadSettings();
    const ntfyTopic = settings.notifications?.ntfy?.topic;

    if (ntfyTopic) {
      // Use Bun.spawn array form to prevent shell injection via topic/title/message
      const url = `https://ntfy.sh/${encodeURIComponent(ntfyTopic)}`;
      const proc = Bun.spawn(
        ["curl", "-s", "-X", "POST", url, "-H", `Title: ${title}`, "-d", message],
        { stdout: "ignore", stderr: "ignore" }
      );
      await proc.exited;
      console.log("✅ Push delivered");
    } else {
      console.log("⏭️ Push skipped (no ntfy topic)");
    }
  } catch (e) {
    console.error("❌ Push delivery failed:", e);
  }
}

/**
 * Deliver briefing blocks to Canvas as typed containers.
 * Canvas is ADDITIVE — this never replaces Telegram delivery.
 * If Canvas is unavailable, silently returns false (zero regression).
 */
async function deliverCanvas(blocks: BlockResult[]): Promise<boolean> {
  try {
    if (!existsSync(CANVAS_RENDERER_PATH)) {
      console.log("⏭️ Canvas delivery skipped (CanvasRenderer not found)");
      return false;
    }
    const { deliverBriefingToCanvas } = await import(CANVAS_RENDERER_PATH);
    const result = await deliverBriefingToCanvas(blocks) as
      | { rendered: true; containersRendered: number }
      | { rendered: false; containersRendered: 0; error: string };

    if (result.rendered) {
      console.log(`✅ Canvas delivered (${result.containersRendered} containers)`);
      return true;
    } else {
      console.log("⏭️ Canvas skipped (not available)");
      return false;
    }
  } catch (e) {
    console.error("❌ Canvas delivery failed:", e);
    return false;
  }
}

async function deliverTelegram(message: string): Promise<void> {
  await deliverTelegramShared(message);
}

/**
 * Upload briefing to Google Drive and return the shareable link
 */
async function uploadToDrive(localPath: string, dateStr: string): Promise<string | null> {
  try {
    const driveFileName = `DailyBriefing-${dateStr}.html`;
    const drivePath = `gdrive:Kaya/Briefings/${driveFileName}`;

    // Upload using rclone directly
    execSync(`rclone copyto "${localPath}" "${drivePath}" 2>/dev/null`, {
      encoding: "utf-8",
      timeout: 30000,
    });

    // Get shareable link
    const linkOutput = execSync(`rclone link "${drivePath}" 2>/dev/null`, {
      encoding: "utf-8",
      timeout: 10000,
    });

    const driveLink = linkOutput.trim();
    if (driveLink && driveLink.startsWith("http")) {
      console.log(`✅ Uploaded to Drive: ${drivePath}`);
      return driveLink;
    }
    console.log(`✅ Uploaded to Drive: ${drivePath} (no link available)`);
    return null;
  } catch (e) {
    console.error("❌ Drive upload failed:", e);
    return null;
  }
}

/**
 * Format Telegram briefing summary — complete, clean, mobile-readable.
 * Shows all sections without cutting things off. Telegram limit is 4096 chars.
 */
function formatTelegramSummary(blocks: BlockResult[], driveLink: string | null): string {
  const date = new Date().toLocaleDateString("en-US", {
    weekday: "long",
    month: "short",
    day: "numeric",
  });

  let msg = `📅 *${date}*\n`;

  // ── Weather ──
  const weather = blocks.find((b) => b.blockName === "weather");
  if (weather?.success && weather.data.current) {
    const current = weather.data.current as { temp: string; condition?: string };
    const forecast = weather.data.forecast as { high?: string; low?: string } | undefined;
    msg += `🌡️ ${current.temp}`;
    if (current.condition) msg += `, ${current.condition}`;
    if (forecast?.high && forecast?.low) {
      msg += ` · H ${forecast.high} / L ${forecast.low}`;
    }
    msg += `\n`;
  } else {
    msg += `⚠️ Weather data unavailable\n`;
  }

  msg += `\n`;

  // ── Goals (all WIGs) ──
  const goals = blocks.find((b) => b.blockName === "goals");
  if (goals?.success) {
    const wigs = goals.data.wigs as Array<{
      id: string; title: string; status?: string;
      current?: string; metric?: string; target?: string;
    }> | undefined;

    if (wigs && wigs.length > 0) {
      msg += `🎯 *Goals*\n`;
      for (const wig of wigs) {
        let progress = "";
        if (wig.current && wig.metric) {
          // Extract target from metric (format like "4wk-rolling avg → 3hrs")
          const targetPart = wig.metric.includes("→")
            ? wig.metric.split("→").pop()?.trim()
            : wig.metric;
          progress = ` (${wig.current} → ${targetPart})`;
        }
        msg += `• ${wig.id}: ${wig.title}${progress}\n`;
      }
      if (goals.data.focusRecommendation) {
        const focus = (goals.data.focusRecommendation as string).replace(/^Focus on\s*/i, "");
        msg += `_Today's focus: ${focus}_\n`;
      }
      msg += `\n`;
    }
  }

  // ── Calendar (all events, neatly) ──
  const cal = blocks.find((b) => b.blockName === "calendar");
  if (cal?.success) {
    const events = cal.data.events as Array<{
      time: string; title: string; location?: string;
    }> | undefined;

    if (events && events.length > 0) {
      msg += `📅 *Schedule* (${events.length} events)\n`;
      const MAX_INLINE = 6;
      for (const event of events.slice(0, MAX_INLINE)) {
        const loc = event.location ? ` @ ${event.location}` : "";
        msg += `• ${event.time} – ${event.title}${loc}\n`;
      }
      if (events.length > MAX_INLINE) {
        const remaining = events.slice(MAX_INLINE);
        const titles = remaining.map((e) => e.title);
        // Group remaining into a single summary line
        if (titles.length <= 3) {
          msg += `• _Also: ${titles.join(", ")}_\n`;
        } else {
          msg += `• _Also: ${titles.slice(0, 2).join(", ")} +${titles.length - 2} more_\n`;
        }
      }
      msg += `\n`;
    }
  }

  // ── Tasks ──
  const tasks = blocks.find((b) => b.blockName === "lucidTasks");
  if (tasks?.success) {
    const dueToday = tasks.data.dueToday as Array<{ title: string }> | undefined;
    const overdue = tasks.data.overdue as Array<{ title: string; dueDate?: string }> | undefined;
    const upcoming = tasks.data.upcoming as Array<{ title: string }> | undefined;

    const hasDue = (dueToday && dueToday.length > 0);
    const hasOverdue = (overdue && overdue.length > 0);
    const hasUpcoming = (upcoming && upcoming.length > 0);

    if (hasDue || hasOverdue || hasUpcoming) {
      msg += `✅ *Tasks*\n`;
      if (hasOverdue) {
        for (const t of overdue!.slice(0, 3)) {
          msg += `• ⚠️ ${t.title} (overdue)\n`;
        }
        if (overdue!.length > 3) {
          msg += `  _+${overdue!.length - 3} more overdue_\n`;
        }
      }
      if (hasDue) {
        for (const t of dueToday!.slice(0, 5)) {
          msg += `• ${t.title}\n`;
        }
        if (dueToday!.length > 5) {
          msg += `  _+${dueToday!.length - 5} more due today_\n`;
        }
      }
      if (!hasDue && !hasOverdue && hasUpcoming) {
        msg += `_No tasks due today._ `;
        const upTitles = upcoming!.slice(0, 3).map((t) => t.title);
        msg += `Upcoming: ${upTitles.join(", ")}`;
        if (upcoming!.length > 3) msg += ` +${upcoming!.length - 3} more`;
        msg += `\n`;
      }
      msg += `\n`;
    }
  }

  // ── LucidTasks ──
  const lucidTasksBlock = blocks.find((b) => b.blockName === "lucidTasks");
  if (lucidTasksBlock?.success) {
    const overdueCount = (lucidTasksBlock.data.overdueCount as number) || 0;
    const dueTodayCount = (lucidTasksBlock.data.dueTodayCount as number) || 0;
    const nextTasks = lucidTasksBlock.data.nextTasks as Array<{ title: string; priority: number }> | undefined;
    if (overdueCount > 0 || dueTodayCount > 0 || (nextTasks && nextTasks.length > 0)) {
      msg += `✅ *LucidTasks*\n`;
      if (overdueCount > 0) msg += `• ⚠️ ${overdueCount} overdue\n`;
      if (dueTodayCount > 0) msg += `• ${dueTodayCount} due today\n`;
      if (nextTasks && nextTasks.length > 0) {
        msg += `• Next: ${nextTasks[0].title}\n`;
      }
      msg += `\n`;
    }
  }

  // ── Strategies ──
  const strategies = blocks.find((b) => b.blockName === "strategies");
  if (strategies?.success) {
    const top3 = strategies.data.top3Worst as Array<{
      id: string; name: string; current: string; target: string; gap: number; status: string;
    }> | undefined;

    if (top3 && top3.length > 0) {
      msg += `📊 *Lead Measures*\n`;
      for (const s of top3) {
        const icon = s.status === "Critical" ? "🔴" : s.status === "Struggling" ? "🟡" : "🟢";
        msg += `${icon} ${s.id}: ${s.current} / ${s.target} (${s.gap}%)\n`;
      }
      msg += `\n`;
    }
  }

  // ── Habit Tracking ──
  const habitBlock = blocks.find((b) => b.blockName === "habitTracking");
  if (habitBlock?.success) {
    const habits = habitBlock.data.habits as Array<{
      name: string; rollingAvg: number; status: string;
    }> | undefined;

    if (habits && habits.length > 0) {
      msg += `📈 *Habits* (${habitBlock.data.overallAvg}% avg)\n`;
      // Show worst 3 habits that need attention
      const needsWork = habits.filter((h) => h.status === "red" || h.status === "yellow").slice(0, 3);
      for (const h of needsWork) {
        const icon = h.status === "red" ? "🔴" : "🟡";
        msg += `${icon} ${h.name}: ${h.rollingAvg}%\n`;
      }
      const greenCount = habits.filter((h) => h.status === "green").length;
      if (greenCount > 0) {
        msg += `🟢 ${greenCount} habit${greenCount > 1 ? "s" : ""} on track\n`;
      }
      msg += `\n`;
    }
  }

  // ── Priority Candidates ──
  const priorityBlock = blocks.find((b) => b.blockName === "priorityCandidates");
  if (priorityBlock?.success) {
    const pList = priorityBlock.data.priorities as Array<{
      rank: number; title: string; urgency: string; timeEstimate: string; alignmentTag: string;
    }> | undefined;

    if (pList && pList.length > 0) {
      msg += `🎯 *Today's Priorities*\n`;
      for (const p of pList.slice(0, 5)) {
        const urgencyIcon = p.urgency === "overdue" ? "⚠️ " : "";
        msg += `${p.rank}. ${urgencyIcon}${p.title} (${p.timeEstimate})\n`;
      }
      if (pList.length > 5) {
        msg += `  _+${pList.length - 5} more_\n`;
      }
      msg += `\n`;
    }
  }

  // ── Queue ──
  const queue = blocks.find((b) => b.blockName === "approvalQueue");
  if (queue?.success) {
    const awaitingCount = queue.data.awaitingCount as number || 0;
    const pendingCount = queue.data.pendingCount as number || 0;
    const highCount = queue.data.highPriorityCount as number || 0;
    if (awaitingCount > 0 || pendingCount > 0) {
      msg += `📋 *Queue:* ${awaitingCount} awaiting, ${pendingCount} pending`;
      if (highCount > 0) msg += `, ${highCount} high priority`;
      msg += `\n\n`;
    }
  }

  // ── News ──
  const news = blocks.find((b) => b.blockName === "news");
  if (news?.success) {
    const topics = news.data.topics as Array<{ topic: string }> | undefined;
    if (topics && topics.length > 0) {
      const topicNames = topics.map((t) => t.topic).join(", ");
      msg += `📰 *News:* ${topicNames}\n\n`;
    }
  }

  // ── Full briefing link ──
  if (driveLink) {
    msg += `📄 [Full briefing](${driveLink})`;
  }

  return msg;
}

// ============================================================================
// Main
// ============================================================================

async function generateBriefing(): Promise<BriefingOutput> {
  const config = loadConfig();
  const settings = await loadSettings();
  const tz = settings.principal?.timezone || "America/Los_Angeles";
  const date = new Date().toLocaleDateString("en-CA", { timeZone: tz });
  const greeting = getGreeting(settings);

  console.log("📋 Generating daily briefing...\n");
  console.log(`  Date: ${date}`);
  console.log(`  Greeting: ${greeting}\n`);

  // Execute blocks
  const blocks = await executeBlocks(config);

  // Format outputs
  const markdown = formatMarkdown(greeting, date, blocks, tz);
  const voiceSummary = formatVoiceSummary(greeting, blocks);
  const pushMessage = formatPushMessage(blocks);

  return {
    date,
    greeting,
    blocks,
    markdown,
    voiceSummary,
    pushMessage,
  };
}

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
      "skip-news": { type: "boolean" },
      "skip-canvas": { type: "boolean" },
    },
  });

  if (values.help) {
    console.log(`
DailyBriefing Generator - Modular morning briefings

Usage:
  bun BriefingGenerator.ts              Generate and deliver briefing
  bun BriefingGenerator.ts --dry-run    Preview without sending
  bun BriefingGenerator.ts --json       Output as JSON
  bun BriefingGenerator.ts --skip-voice Skip voice delivery
  bun BriefingGenerator.ts --skip-telegram Skip Telegram
  bun BriefingGenerator.ts --skip-push  Skip push notification
  bun BriefingGenerator.ts --skip-news  Skip news section
  bun BriefingGenerator.ts --skip-canvas Skip Canvas rendering

Configuration:
  Edit BriefingConfig.yaml to:
  - Enable/disable sections
  - Set section priorities
  - Configure delivery channels
  - Customize news topics

Blocks:
  goals         - TELOS WIGs and missions
  approvalQueue - Items awaiting approval
  weather       - Current weather and forecast
  calendar      - Today's events (via kaya-cli gcal)
  lucidTasks    - Due/overdue tasks (via kaya-cli tasks)
  news          - Multi-topic news aggregation
`);
    process.exit(0);
  }

  // Generate briefing
  const output = await generateBriefing();

  // JSON output mode
  if (values.json) {
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  // Dry run mode
  if (values["dry-run"]) {
    console.log("\n=== MARKDOWN ===\n");
    console.log(output.markdown);
    console.log("\n=== VOICE ===\n");
    console.log(output.voiceSummary);
    console.log("\n=== TELEGRAM SUMMARY ===\n");
    console.log(formatTelegramSummary(output.blocks, null));
    console.log("\n=== PUSH ===\n");
    console.log(output.pushMessage);
    return;
  }

  // Load config for delivery settings
  const config = loadConfig();

  // ── Dedup guard: skip delivery if briefing already sent today ──
  const dedupFile = join(BRIEFINGS_DIR, `.sent-${output.date}`);
  if (existsSync(dedupFile)) {
    console.log(`⚠️ Briefing already delivered today (${output.date}). Skipping duplicate delivery.`);
    console.log("   To force re-delivery, delete:", dedupFile);
    // Still write the file (may have updated content), just skip channel delivery
    if (config.delivery.writtenLog?.enabled !== false) {
      await deliverWritten(output.markdown, output.date, config);
    }
    return;
  }

  console.log("\n📤 Delivering to channels...\n");

  // Always write to file first
  let localPath = "";
  if (config.delivery.writtenLog?.enabled !== false) {
    localPath = await deliverWritten(output.markdown, output.date, config);
  }

  // Upload to Google Drive and get shareable link
  let driveLink: string | null = null;
  if (localPath) {
    driveLink = await uploadToDrive(localPath, output.date);
  }

  // Voice
  if (config.delivery.voice?.enabled !== false && !values["skip-voice"]) {
    await deliverVoice(output.voiceSummary);
  }

  // Push
  if (config.delivery.push?.enabled !== false && !values["skip-push"]) {
    await deliverPush("Morning Briefing", output.pushMessage);
  }

  // Canvas — render briefing as typed containers (additive, never replaces Telegram)
  // If Canvas is unavailable, silently skips (ISC 7, 8)
  if (!values["skip-canvas"]) {
    await deliverCanvas(output.blocks);
  }

  // Telegram - send condensed summary with Drive link instead of full message
  if (config.delivery.telegram?.enabled !== false && !values["skip-telegram"]) {
    const telegramSummary = formatTelegramSummary(output.blocks, driveLink);
    await deliverTelegram(telegramSummary);
  }

  // Write dedup sentinel after successful delivery
  writeFileSync(dedupFile, new Date().toISOString(), "utf-8");

  console.log("\n✅ Daily briefing complete!");
}

// Run if executed directly
if (import.meta.main) {
  main().catch(console.error);
}

// Exports for programmatic use
export { generateBriefing, loadConfig };
export type { BriefingOutput, BriefingConfig, BlockResult };
