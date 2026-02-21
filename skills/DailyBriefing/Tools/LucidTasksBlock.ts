#!/usr/bin/env bun
/**
 * LucidTasksBlock.ts - LucidTasks summary block for DailyBriefing
 *
 * Reads task data from TaskDB and renders a formatted task summary for
 * the morning briefing. Shows overdue tasks, tasks due today, and
 * the highest-priority next tasks.
 *
 * Follows the ApprovalQueueBlock.ts pattern exactly.
 */

import { getTaskDB } from "../../LucidTasks/Tools/TaskDB.ts";
import type { BlockResult } from "./types.ts";

export interface LucidTasksBlockConfig {
  maxOverdue?: number;
  maxDueToday?: number;
  maxNextTasks?: number;
}

function priorityIcon(priority: number): string {
  if (priority === 1) return "!!!";
  if (priority === 2) return "!! ";
  return "!  ";
}

export async function execute(config: Record<string, unknown> = {}): Promise<BlockResult> {
  const {
    maxOverdue = 5,
    maxDueToday = 5,
    maxNextTasks = 3,
  } = config as LucidTasksBlockConfig;

  try {
    const db = getTaskDB();
    const today = new Date().toISOString().split("T")[0];

    const overdue = db.getOverdueTasks();

    // Due today: active tasks (not done/cancelled) with due_date = today
    const allActive = db.listTasks({
      status: ["inbox", "next", "in_progress", "waiting"],
    });
    const dueToday = allActive.filter((t) => t.due_date === today);

    // Next tasks: highest priority "next" or "in_progress" tasks
    const nextTasks = db.listTasks({
      status: ["next", "in_progress"],
      limit: maxNextTasks,
    });

    // Build markdown
    let markdown = "## Tasks\n\n";

    if (overdue.length === 0 && dueToday.length === 0 && nextTasks.length === 0) {
      markdown += "No tasks need attention today.\n";
    } else {
      if (overdue.length > 0) {
        markdown += `**Overdue (${overdue.length}):**\n`;
        for (const t of overdue.slice(0, maxOverdue)) {
          const pri = priorityIcon(t.priority);
          const proj = t.project_id ? ` @${t.project_id}` : "";
          markdown += `- ${pri} ${t.title} (due: ${t.due_date})${proj}\n`;
        }
        if (overdue.length > maxOverdue) {
          markdown += `  _+${overdue.length - maxOverdue} more overdue_\n`;
        }
        markdown += "\n";
      }

      if (dueToday.length > 0) {
        markdown += `**Due Today (${dueToday.length}):**\n`;
        for (const t of dueToday.slice(0, maxDueToday)) {
          const pri = priorityIcon(t.priority);
          const proj = t.project_id ? ` @${t.project_id}` : "";
          markdown += `- ${pri} ${t.title}${proj}\n`;
        }
        if (dueToday.length > maxDueToday) {
          markdown += `  _+${dueToday.length - maxDueToday} more due today_\n`;
        }
        markdown += "\n";
      }

      if (nextTasks.length > 0) {
        markdown += `**Next Up:**\n`;
        for (const t of nextTasks) {
          const pri = priorityIcon(t.priority);
          const proj = t.project_id ? ` @${t.project_id}` : "";
          markdown += `- [>] ${pri} ${t.title}${proj}\n`;
        }
      }
    }

    // Build summary
    const parts: string[] = [];
    if (overdue.length > 0) parts.push(`${overdue.length} overdue`);
    if (dueToday.length > 0) parts.push(`${dueToday.length} due today`);
    if (nextTasks.length > 0) parts.push(`${nextTasks.length} next`);
    const summary = parts.length > 0 ? parts.join(", ") : "No active tasks";

    return {
      blockName: "lucidTasks",
      success: true,
      data: {
        overdueCount: overdue.length,
        dueTodayCount: dueToday.length,
        nextTaskCount: nextTasks.length,
        overdueTasks: overdue.slice(0, maxOverdue).map((t) => ({
          id: t.id,
          title: t.title,
          due_date: t.due_date ?? "",
          priority: t.priority,
        })),
        dueTodayTasks: dueToday.slice(0, maxDueToday).map((t) => ({
          id: t.id,
          title: t.title,
          priority: t.priority,
        })),
        nextTasks: nextTasks.slice(0, maxNextTasks).map((t) => ({
          id: t.id,
          title: t.title,
          priority: t.priority,
          project_id: t.project_id ?? undefined,
        })),
      },
      markdown,
      summary,
    };
  } catch (error) {
    return {
      blockName: "lucidTasks",
      success: false,
      data: {
        overdueCount: 0,
        dueTodayCount: 0,
        nextTaskCount: 0,
        overdueTasks: [],
        dueTodayTasks: [],
        nextTasks: [],
      },
      markdown: "## Tasks\n\nFailed to load tasks.\n",
      summary: "Tasks unavailable",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// CLI self-test when run directly
if (import.meta.main) {
  console.log("LucidTasksBlock - Self Test");
  console.log("===========================\n");

  execute({ maxOverdue: 5, maxDueToday: 5, maxNextTasks: 3 })
    .then((result) => {
      console.log("Success:", result.success);
      console.log("Summary:", result.summary);
      console.log("\nMarkdown:\n");
      console.log(result.markdown);
      if (result.error) {
        console.error("Error:", result.error);
      }
      console.log("\nData:", JSON.stringify(result.data, null, 2));
    })
    .catch(console.error);
}
