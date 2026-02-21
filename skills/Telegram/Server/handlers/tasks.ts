/**
 * tasks.ts - LucidTasks Telegram Bot Command Handlers
 *
 * Registers /tasks, /next, /done, and /add commands with inline keyboards.
 * All handlers are wrapped in try/catch for graceful degradation.
 *
 * Callback data prefixes (max 64 bytes each):
 *   tasks:done  tasks:next  tasks:inbox
 *   next:start:<id>  next:snooze:<id>  next:skip:<id>
 *   done:next  done:stats
 *   add:<id>:priority  add:<id>:due  add:<id>:project
 *   setpri:<id>:<n>  setdue:<id>:<offset>  setproj:<id>:<projectId>
 */

import { Telegraf, Markup } from "telegraf";
import type { Context } from "telegraf";
import { getTaskDB } from "../../../LucidTasks/Tools/TaskDB.ts";
import { prepareMessage, replyOptions } from "../../Tools/TelegramFormatting.ts";
import { parseRelativeDate } from "../../../LucidTasks/Tools/TaskManager.ts";

const PRIORITY_LABELS: Record<number, string> = { 1: "!!!", 2: "!!", 3: "!" };

function formatPriority(p: number): string {
  return PRIORITY_LABELS[p] ?? "!";
}

export function registerTaskCommands(bot: Telegraf): void {

  // ── /tasks — Today's task summary ──
  bot.command("tasks", async (ctx: Context) => {
    const db = getTaskDB();
    try {
      const overdue = db.getOverdueTasks();
      const todayTasks = db.getTodayTasks();
      const stats = db.getStats();

      const date = new Date().toLocaleDateString("en-US", {
        weekday: "short",
        month: "short",
        day: "numeric",
      });

      if (overdue.length === 0 && todayTasks.length === 0) {
        await ctx.reply(
          prepareMessage(`*Today's Tasks* (${date})\n\nNo tasks need attention today.\n\nUse /add to create one.`),
          replyOptions()
        );
        return;
      }

      let msg = `*Today's Tasks* (${date})\n\n`;

      if (overdue.length > 0) {
        msg += `*Overdue (${overdue.length}):*\n`;
        for (const t of overdue.slice(0, 3)) {
          msg += `- [${formatPriority(t.priority)}] ${t.title} (${t.due_date ?? ""})\n`;
        }
        if (overdue.length > 3) msg += `  _+${overdue.length - 3} more_\n`;
        msg += "\n";
      }

      if (todayTasks.length > 0) {
        msg += `*Active (${todayTasks.length}):*\n`;
        for (const t of todayTasks.slice(0, 5)) {
          const proj = t.project_id ? ` @${t.project_id}` : "";
          msg += `- [${formatPriority(t.priority)}] ${t.title}${proj}\n`;
        }
        if (todayTasks.length > 5) msg += `  _+${todayTasks.length - 5} more_\n`;
        msg += "\n";
      }

      msg += `_${stats.completedThisWeek} completed this week_`;

      await ctx.reply(prepareMessage(msg), {
        ...replyOptions(),
        ...Markup.inlineKeyboard([
          Markup.button.callback("Done", "tasks:done"),
          Markup.button.callback("Next", "tasks:next"),
          Markup.button.callback("Inbox", "tasks:inbox"),
        ]),
      });
    } catch (error) {
      console.error("[tasks:tasks]", error);
      await ctx.reply("Failed to load tasks.");
    }
  });

  // ── /next — Suggested next task ──
  bot.command("next", async (ctx: Context) => {
    const db = getTaskDB();
    try {
      const tasks = db.listTasks({ status: ["next", "in_progress"], limit: 5 });

      if (tasks.length === 0) {
        const inbox = db.getInboxTasks();
        if (inbox.length > 0) {
          await ctx.reply(
            prepareMessage(`No *next* tasks set.\n\n_${inbox.length} item${inbox.length === 1 ? "" : "s"} in inbox need triage._`),
            replyOptions()
          );
        } else {
          await ctx.reply("No tasks available. Use /add to create one.");
        }
        return;
      }

      const task = tasks[0];
      const proj = task.project_id ? `\nProject: ${task.project_id}` : "";
      const due = task.due_date ? `\nDue: ${task.due_date}` : "";
      const est = task.estimated_minutes ? `\nEst: ${task.estimated_minutes} min` : "";
      const priLabel = task.priority === 1 ? "HIGH" : task.priority === 2 ? "NORMAL" : "LOW";

      let msg = `*Suggested Next Task:*\n\n*${task.title}*\nPriority: ${priLabel}${due}${proj}${est}`;

      if (tasks.length > 1) {
        const otherTitles = tasks.slice(1).map((t) => t.title).join(", ");
        msg += `\n\n_Also ready: ${otherTitles}_`;
      }

      await ctx.reply(prepareMessage(msg), {
        ...replyOptions(),
        ...Markup.inlineKeyboard([
          Markup.button.callback("Start", `next:start:${task.id}`),
          Markup.button.callback("Snooze", `next:snooze:${task.id}`),
          Markup.button.callback("Skip", `next:skip:${task.id}`),
        ]),
      });
    } catch (error) {
      console.error("[tasks:next]", error);
      await ctx.reply("Failed to load next task.");
    }
  });

  // ── /done <id or title> — Quick complete ──
  bot.command("done", async (ctx: Context) => {
    const db = getTaskDB();
    try {
      const text = (ctx.message && "text" in ctx.message) ? ctx.message.text : "";
      const arg = text.replace(/^\/done\s*/, "").trim();

      if (!arg) {
        await ctx.reply("Usage: /done <task-id or title>");
        return;
      }

      // Try exact ID match first
      let task = db.getTask(arg);

      // Fall back to fuzzy title search
      if (!task) {
        const results = db.searchTasks(arg, 1);
        task = results[0] ?? null;
      }

      if (!task) {
        await ctx.reply(`Task not found: "${arg}"`);
        return;
      }

      db.updateTask(task.id, { status: "done" }, "telegram");
      const stats = db.getStats();

      await ctx.reply(
        prepareMessage(`*Completed:* ${task.title}\n\n_${stats.completedThisWeek} completed this week_`),
        {
          ...replyOptions(),
          ...Markup.inlineKeyboard([
            Markup.button.callback("Next Task", "done:next"),
            Markup.button.callback("Stats", "done:stats"),
          ]),
        }
      );
    } catch (error) {
      console.error("[tasks:done]", error);
      await ctx.reply("Failed to complete task.");
    }
  });

  // ── /add <title> — Quick create ──
  bot.command("add", async (ctx: Context) => {
    const db = getTaskDB();
    try {
      const text = (ctx.message && "text" in ctx.message) ? ctx.message.text : "";
      const title = text.replace(/^\/add\s*/, "").trim();

      if (!title) {
        await ctx.reply("Usage: /add <task title>");
        return;
      }

      const task = db.createTask({ title, status: "inbox" });
      db.logActivity(task.id, "created_via_telegram", null, "telegram");

      await ctx.reply(
        prepareMessage(`*Added:* ${task.title}\n\nStatus: inbox | Priority: normal`),
        {
          ...replyOptions(),
          ...Markup.inlineKeyboard([
            Markup.button.callback("Prioritize", `add:${task.id}:priority`),
            Markup.button.callback("Set Due", `add:${task.id}:due`),
            Markup.button.callback("Tag Project", `add:${task.id}:project`),
          ]),
        }
      );
    } catch (error) {
      console.error("[tasks:add]", error);
      await ctx.reply("Failed to create task.");
    }
  });

  // ── Callback Actions ──

  // tasks:done -> prompt user to enter ID
  bot.action("tasks:done", async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply("Send /done <task-id or title> to complete a task.");
  });

  // tasks:next -> show next suggestion inline
  bot.action("tasks:next", async (ctx) => {
    await ctx.answerCbQuery();
    const db = getTaskDB();
    try {
      const tasks = db.listTasks({ status: ["next", "in_progress"], limit: 1 });
      if (tasks.length === 0) {
        await ctx.reply("No next tasks set. Use /add or triage your inbox.");
        return;
      }
      const t = tasks[0];
      await ctx.reply(
        prepareMessage(`*Next:* ${t.title}`),
        replyOptions()
      );
    } catch (error) {
      console.error("[tasks:next callback]", error);
      await ctx.reply("Failed to load next task.");
    }
  });

  // tasks:inbox -> show inbox items
  bot.action("tasks:inbox", async (ctx) => {
    await ctx.answerCbQuery();
    const db = getTaskDB();
    try {
      const inbox = db.getInboxTasks();
      if (inbox.length === 0) {
        await ctx.reply("Inbox is empty.");
        return;
      }
      let msg = `*Inbox (${inbox.length}):*\n\n`;
      for (const t of inbox.slice(0, 10)) {
        msg += `- ${t.title}\n`;
      }
      if (inbox.length > 10) msg += `_+${inbox.length - 10} more_`;
      await ctx.reply(prepareMessage(msg), replyOptions());
    } catch (error) {
      console.error("[tasks:inbox callback]", error);
      await ctx.reply("Failed to load inbox.");
    }
  });

  // next:start:<id> -> set task to in_progress
  bot.action(/^next:start:(.+)$/, async (ctx) => {
    await ctx.answerCbQuery("Started!");
    const taskId = ctx.match[1];
    const db = getTaskDB();
    try {
      const task = db.updateTask(taskId, { status: "in_progress" }, "telegram");
      if (task) {
        await ctx.reply(
          prepareMessage(`*Started:* ${task.title}`),
          replyOptions()
        );
      } else {
        await ctx.reply(`Task not found: ${taskId}`);
      }
    } catch (error) {
      console.error("[tasks:next:start]", error);
      await ctx.reply("Failed to start task.");
    }
  });

  // next:snooze:<id> -> schedule to tomorrow
  bot.action(/^next:snooze:(.+)$/, async (ctx) => {
    await ctx.answerCbQuery("Snoozed to tomorrow");
    const taskId = ctx.match[1];
    const db = getTaskDB();
    try {
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      const tomorrowStr = tomorrow.toISOString().split("T")[0];
      const task = db.updateTask(taskId, { scheduled_date: tomorrowStr }, "telegram");
      if (task) {
        await ctx.reply(
          prepareMessage(`*Snoozed:* ${task.title} -> ${tomorrowStr}`),
          replyOptions()
        );
      } else {
        await ctx.reply(`Task not found: ${taskId}`);
      }
    } catch (error) {
      console.error("[tasks:next:snooze]", error);
      await ctx.reply("Failed to snooze task.");
    }
  });

  // next:skip:<id> -> show next suggestion skipping this one
  bot.action(/^next:skip:(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const skipId = ctx.match[1];
    const db = getTaskDB();
    try {
      const tasks = db.listTasks({ status: ["next", "in_progress"], limit: 5 });
      const next = tasks.find((t) => t.id !== skipId);
      if (next) {
        await ctx.reply(
          prepareMessage(`*Next suggestion:* ${next.title}`),
          replyOptions()
        );
      } else {
        await ctx.reply("No more tasks to suggest.");
      }
    } catch (error) {
      console.error("[tasks:next:skip]", error);
      await ctx.reply("Failed to skip task.");
    }
  });

  // done:next -> show next task after completing one
  bot.action("done:next", async (ctx) => {
    await ctx.answerCbQuery();
    const db = getTaskDB();
    try {
      const tasks = db.listTasks({ status: ["next", "in_progress"], limit: 1 });
      if (tasks.length === 0) {
        await ctx.reply("No more next tasks. Nice work!");
        return;
      }
      await ctx.reply(
        prepareMessage(`*Next:* ${tasks[0].title}`),
        replyOptions()
      );
    } catch (error) {
      console.error("[tasks:done:next]", error);
      await ctx.reply("Failed to load next task.");
    }
  });

  // done:stats -> show task statistics
  bot.action("done:stats", async (ctx) => {
    await ctx.answerCbQuery();
    const db = getTaskDB();
    try {
      const stats = db.getStats();
      let msg = `*Task Stats:*\n\n`;
      msg += `Total: ${stats.total}\n`;
      msg += `Overdue: ${stats.overdue}\n`;
      msg += `Due Today: ${stats.dueToday}\n`;
      msg += `Completed (7d): ${stats.completedThisWeek}\n`;
      if (stats.byStatus["next"]) msg += `Next: ${stats.byStatus["next"]}\n`;
      if (stats.byStatus["in_progress"]) msg += `In Progress: ${stats.byStatus["in_progress"]}\n`;
      if (stats.byStatus["inbox"]) msg += `Inbox: ${stats.byStatus["inbox"]}\n`;
      await ctx.reply(prepareMessage(msg), replyOptions());
    } catch (error) {
      console.error("[tasks:done:stats]", error);
      await ctx.reply("Failed to load stats.");
    }
  });

  // add:<id>:priority -> show priority picker
  bot.action(/^add:(.+):priority$/, async (ctx) => {
    await ctx.answerCbQuery();
    const taskId = ctx.match[1];
    await ctx.reply(
      "Set priority:",
      Markup.inlineKeyboard([
        Markup.button.callback("High (!)", `setpri:${taskId}:1`),
        Markup.button.callback("Normal (!!)", `setpri:${taskId}:2`),
        Markup.button.callback("Low (!!!)", `setpri:${taskId}:3`),
      ])
    );
  });

  // setpri:<id>:<n> -> apply priority
  bot.action(/^setpri:(.+):(\d)$/, async (ctx) => {
    await ctx.answerCbQuery("Priority set!");
    const taskId = ctx.match[1];
    const priority = parseInt(ctx.match[2], 10);
    const db = getTaskDB();
    try {
      db.updateTask(taskId, { priority }, "telegram");
      const label = priority === 1 ? "High" : priority === 2 ? "Normal" : "Low";
      await ctx.reply(
        prepareMessage(`Priority set to *${label}*`),
        replyOptions()
      );
    } catch (error) {
      console.error("[tasks:setpri]", error);
      await ctx.reply("Failed to set priority.");
    }
  });

  // add:<id>:due -> show due date picker
  bot.action(/^add:(.+):due$/, async (ctx) => {
    await ctx.answerCbQuery();
    const taskId = ctx.match[1];
    await ctx.reply(
      "Set due date:",
      Markup.inlineKeyboard([
        [
          Markup.button.callback("Today", `setdue:${taskId}:today`),
          Markup.button.callback("Tomorrow", `setdue:${taskId}:tomorrow`),
        ],
        [
          Markup.button.callback("+3 days", `setdue:${taskId}:+3d`),
          Markup.button.callback("+1 week", `setdue:${taskId}:+1w`),
        ],
      ])
    );
  });

  // setdue:<id>:<offset> -> apply due date
  bot.action(/^setdue:(.+):(today|tomorrow|\+\d+[dw])$/, async (ctx) => {
    await ctx.answerCbQuery("Due date set!");
    const taskId = ctx.match[1];
    const dateInput = ctx.match[2];
    const dueDate = parseRelativeDate(dateInput);
    if (dueDate) {
      const db = getTaskDB();
      try {
        db.updateTask(taskId, { due_date: dueDate }, "telegram");
        await ctx.reply(
          prepareMessage(`Due date set to *${dueDate}*`),
          replyOptions()
        );
      } catch (error) {
        console.error("[tasks:setdue]", error);
        await ctx.reply("Failed to set due date.");
      }
    } else {
      await ctx.reply("Could not parse due date.");
    }
  });

  // add:<id>:project -> show project picker
  bot.action(/^add:(.+):project$/, async (ctx) => {
    await ctx.answerCbQuery();
    const taskId = ctx.match[1];
    const db = getTaskDB();
    try {
      const projects = db.listProjects("active");
      if (projects.length === 0) {
        await ctx.reply("No active projects. Create one with the CLI.");
        return;
      }
      const buttons = projects.slice(0, 8).map((p) =>
        Markup.button.callback(p.name, `setproj:${taskId}:${p.id}`)
      );
      // Arrange in rows of 2
      const rows: ReturnType<typeof Markup.button.callback>[][] = [];
      for (let i = 0; i < buttons.length; i += 2) {
        rows.push(buttons.slice(i, i + 2));
      }
      await ctx.reply("Tag project:", Markup.inlineKeyboard(rows));
    } catch (error) {
      console.error("[tasks:add:project]", error);
      await ctx.reply("Failed to load projects.");
    }
  });

  // setproj:<taskId>:<projectId> -> apply project
  bot.action(/^setproj:(.+?):(.+)$/, async (ctx) => {
    await ctx.answerCbQuery("Project set!");
    const taskId = ctx.match[1];
    const projectId = ctx.match[2];
    const db = getTaskDB();
    try {
      const project = db.getProject(projectId);
      db.updateTask(taskId, { project_id: projectId }, "telegram");
      await ctx.reply(
        prepareMessage(`Tagged to project: *${project?.name ?? projectId}*`),
        replyOptions()
      );
    } catch (error) {
      console.error("[tasks:setproj]", error);
      await ctx.reply("Failed to set project.");
    }
  });
}
