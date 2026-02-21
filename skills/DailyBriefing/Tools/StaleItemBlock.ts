#!/usr/bin/env bun
/**
 * StaleItemBlock.ts - Detects stale, stuck, and forgotten items
 *
 * Scans LucidTasks tasks and MEMORY/State for items that have gone stale:
 * - Tasks untouched for 14+ days
 * - Tasks with no deadline set
 * - Overdue tasks (grouped for triage)
 * - Memory state files older than 30 days
 */

import { execSync } from "child_process";
import { existsSync, readdirSync, statSync } from "fs";
import { join } from "path";
import type { BlockResult } from "./types.ts";

export type { BlockResult };

const KAYA_HOME = process.env.KAYA_DIR || join(process.env.HOME!, ".claude");
const MEMORY_STATE_DIR = join(KAYA_HOME, "MEMORY", "State");

interface StaleTask {
  title: string;
  lastModified?: string;
  daysAgo: number;
}

interface NoDeadlineTask {
  title: string;
}

interface OverdueTask {
  title: string;
  dueDate: string;
  daysOverdue: number;
}

interface StaleMemoryFile {
  name: string;
  daysAgo: number;
}

export interface StaleItemBlockConfig {
  staleDays?: number;   // Default 14
  memoryDays?: number;  // Default 30
  maxItems?: number;    // Default 10 per category
}

// Filter out sample/tutorial tasks
const SAMPLE_TASK_PATTERNS = [
  /get started/i,
  /using my tasks/i,
  /layout that/i,
  /try lucidtasks/i,
  /welcome to/i,
  /example task/i,
  /sample task/i,
  /tutorial/i,
];

function isSampleTask(title: string): boolean {
  return SAMPLE_TASK_PATTERNS.some((pattern) => pattern.test(title));
}

function daysAgo(date: Date): number {
  return Math.floor((Date.now() - date.getTime()) / (1000 * 60 * 60 * 24));
}

function formatDaysAgo(days: number): string {
  if (days === 0) return "today";
  if (days === 1) return "1 day ago";
  return `${days} days ago`;
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export async function execute(config: StaleItemBlockConfig = {}): Promise<BlockResult> {
  const { staleDays = 14, memoryDays = 30, maxItems = 10 } = config;

  try {
    // Fetch LucidTasks tasks via kaya-cli
    let stdout = "";
    try {
      stdout = execSync('kaya-cli tasks --json 2>/dev/null || echo "[]"', {
        encoding: "utf-8",
        timeout: 15000,
      });
    } catch {
      stdout = "[]";
    }

    const staleTasks: StaleTask[] = [];
    const noDeadlineTasks: NoDeadlineTask[] = [];
    const overdueTasks: OverdueTask[] = [];

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Parse tasks
    if (stdout.trim().startsWith("[")) {
      try {
        const parsed = JSON.parse(stdout.trim());
        for (const task of parsed) {
          // Skip completed tasks
          if (task.completed === true) continue;

          const taskTitle = task.name || task.title || "Untitled";

          // Skip sample/tutorial tasks
          if (isSampleTask(taskTitle)) continue;

          const dueOn = task.due_on || task.dueDate || task.due;
          const modifiedAt = task.modified_at || task.modifiedAt;

          // Check for no-deadline tasks
          if (!dueOn) {
            noDeadlineTasks.push({ title: taskTitle });
            continue;
          }

          const dueDate = new Date(dueOn);
          dueDate.setHours(0, 0, 0, 0);

          // Check for overdue tasks
          if (dueDate < today) {
            const daysOver = daysAgo(dueDate);
            overdueTasks.push({
              title: taskTitle,
              dueDate: dueOn,
              daysOverdue: daysOver,
            });
            continue;
          }

          // Check for stale tasks (modified_at older than staleDays)
          if (modifiedAt) {
            const modDate = new Date(modifiedAt);
            const daysSinceModified = daysAgo(modDate);
            if (daysSinceModified >= staleDays) {
              staleTasks.push({
                title: taskTitle,
                lastModified: modifiedAt,
                daysAgo: daysSinceModified,
              });
              continue;
            }
          }

          // If no modified_at, check due_on for staleness (far future but untouched)
          if (!modifiedAt && dueOn) {
            const dueDateObj = new Date(dueOn);
            const daysSinceDue = daysAgo(dueDateObj);
            // Negative daysSinceDue means future - only flag if due_on was set long ago
            // and there is no modified_at to indicate recent activity
          }
        }
      } catch {
        // Not valid JSON, skip
      }
    }

    // Sort stale tasks by staleness (most stale first)
    staleTasks.sort((a, b) => b.daysAgo - a.daysAgo);
    overdueTasks.sort((a, b) => b.daysOverdue - a.daysOverdue);

    // Check MEMORY/State for stale files
    const staleMemory: StaleMemoryFile[] = [];
    if (existsSync(MEMORY_STATE_DIR)) {
      try {
        const files = readdirSync(MEMORY_STATE_DIR);
        for (const file of files) {
          const filePath = join(MEMORY_STATE_DIR, file);
          try {
            const stat = statSync(filePath);
            if (stat.isFile()) {
              const daysSinceModified = daysAgo(stat.mtime);
              if (daysSinceModified >= memoryDays) {
                staleMemory.push({
                  name: file,
                  daysAgo: daysSinceModified,
                });
              }
            }
          } catch {
            // Skip files we cannot stat
          }
        }
      } catch {
        // Skip if directory cannot be read
      }
    }

    staleMemory.sort((a, b) => b.daysAgo - a.daysAgo);

    // Calculate totals
    const totalStaleCount =
      staleTasks.length + noDeadlineTasks.length + overdueTasks.length + staleMemory.length;

    // Format markdown
    let markdown = "## Stale Item Triage\n\n";

    if (totalStaleCount === 0) {
      markdown += "No stale items -- all clear.\n";
    } else {
      markdown += `### Needs Attention (${totalStaleCount} items)\n\n`;

      // Stale tasks
      if (staleTasks.length > 0) {
        markdown += `**Stale Tasks (untouched ${staleDays}+ days):**\n`;
        for (const task of staleTasks.slice(0, maxItems)) {
          const modifiedStr = task.lastModified
            ? ` -- last modified ${formatDate(task.lastModified)} (${formatDaysAgo(task.daysAgo)})`
            : ` -- ${formatDaysAgo(task.daysAgo)}`;
          markdown += `- "${task.title}"${modifiedStr}\n`;
        }
        if (staleTasks.length > maxItems) {
          markdown += `- ...and ${staleTasks.length - maxItems} more stale tasks\n`;
        }
        markdown += "\n";
      }

      // No-deadline tasks
      if (noDeadlineTasks.length > 0) {
        markdown += `**Tasks Missing Deadlines (${noDeadlineTasks.length}):**\n`;
        for (const task of noDeadlineTasks.slice(0, maxItems)) {
          markdown += `- "${task.title}" -- no due date\n`;
        }
        if (noDeadlineTasks.length > maxItems) {
          markdown += `- ...and ${noDeadlineTasks.length - maxItems} more without deadlines\n`;
        }
        markdown += "\n";
      }

      // Overdue tasks
      if (overdueTasks.length > 0) {
        markdown += `**Overdue (${overdueTasks.length}):**\n`;
        for (const task of overdueTasks.slice(0, maxItems)) {
          markdown += `- "${task.title}" -- was due ${formatDate(task.dueDate)} (${formatDaysAgo(task.daysOverdue)})\n`;
        }
        if (overdueTasks.length > maxItems) {
          markdown += `- ...and ${overdueTasks.length - maxItems} more overdue\n`;
        }
        markdown += "\n";
      }

      // Stale memory files
      if (staleMemory.length > 0) {
        markdown += `**Stale Memory State (${memoryDays}+ days old):**\n`;
        for (const file of staleMemory.slice(0, maxItems)) {
          markdown += `- \`${file.name}\` -- last updated ${formatDaysAgo(file.daysAgo)}\n`;
        }
        if (staleMemory.length > maxItems) {
          markdown += `- ...and ${staleMemory.length - maxItems} more stale state files\n`;
        }
        markdown += "\n";
      }

      // Suggested actions
      markdown += "### Suggested Actions\n";
      if (noDeadlineTasks.length > 0) {
        markdown += "- Set deadlines on undated tasks\n";
      }
      if (staleTasks.length > 0) {
        markdown += "- Review stale tasks: act, defer, or archive\n";
      }
      if (overdueTasks.length > 0) {
        markdown += "- Triage overdue tasks: reschedule or complete\n";
      }
      if (staleMemory.length > 0) {
        markdown += "- Clean up outdated memory state files\n";
      }
    }

    // Generate summary
    const summary =
      totalStaleCount > 0
        ? `${totalStaleCount} stale items need attention`
        : "No stale items -- all clear";

    return {
      blockName: "staleItems",
      success: true,
      data: {
        staleTasks: staleTasks.slice(0, maxItems),
        noDeadlineTasks: noDeadlineTasks.slice(0, maxItems),
        overdueTasks: overdueTasks.slice(0, maxItems),
        staleMemory: staleMemory.slice(0, maxItems),
        totalStaleCount,
      },
      markdown,
      summary,
    };
  } catch (error) {
    return {
      blockName: "staleItems",
      success: false,
      data: {
        staleTasks: [],
        noDeadlineTasks: [],
        overdueTasks: [],
        staleMemory: [],
        totalStaleCount: 0,
      },
      markdown: "## Stale Item Triage\n\nFailed to check for stale items.\n",
      summary: "Stale check unavailable",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// CLI entry point
if (import.meta.main) {
  const args = process.argv.slice(2);

  if (args.includes("--test") || args.includes("-t")) {
    execute({ staleDays: 14, memoryDays: 30, maxItems: 10 })
      .then((result) => {
        console.log("=== Stale Item Block Test ===\n");
        console.log("Success:", result.success);
        console.log("\nMarkdown:\n", result.markdown);
        console.log("\nSummary:", result.summary);
        console.log("\nData:", JSON.stringify(result.data, null, 2));
        if (result.error) console.log("\nError:", result.error);
      })
      .catch(console.error);
  } else {
    console.log("Usage: bun StaleItemBlock.ts --test");
  }
}
