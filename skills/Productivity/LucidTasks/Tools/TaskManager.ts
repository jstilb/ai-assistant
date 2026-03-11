#!/usr/bin/env bun
/**
 * TaskManager.ts - Business Logic + CLI Interface for LucidTasks
 *
 * Provides the CLI entry point and business logic for all task operations.
 * Handles command parsing, formatting, and dispatching to TaskDB.
 *
 * Usage:
 *   bun run TaskManager.ts                      # Today's tasks
 *   bun run TaskManager.ts inbox                # Inbox items
 *   bun run TaskManager.ts add "title" [opts]   # Add task
 *   bun run TaskManager.ts done <id>            # Complete task
 *   bun run TaskManager.ts next                 # Suggested next task
 *   bun run TaskManager.ts projects             # List projects
 *   bun run TaskManager.ts search "query"       # Full-text search
 *   bun run TaskManager.ts stats                # Dashboard
 *   bun run TaskManager.ts migrate              # Run Asana migration
 *   bun run TaskManager.ts view <id>            # View task details
 *   bun run TaskManager.ts edit <id> [opts]     # Edit task
 *   bun run TaskManager.ts project-add "name"   # Create project
 *
 * @module TaskManager
 */

import { join } from "path";
import { getTaskDB, type Task, type Project, type TaskStatus, type EnergyLevel, type TaskFilter } from "./TaskDB.ts";
import { notifySync } from "../../../../lib/core/NotificationService.ts";
import { getAllGoalIds, getGoal, loadTelosData } from "./TelosGoalLoader.ts";
import {
  extractTaskMetadata,
  decomposeTask,
  scoreTasksWithAI,
  generateWeeklyReview,
  formatWeeklyReview,
  loadTrustConfig,
  type ExtractionContext,
  type ScoredTaskInput,
  type AIScoringContext,
  type ReviewData,
} from "./TaskAI.ts";

// ============================================================================
// Configuration
// ============================================================================

const JSON_FLAG = process.argv.includes("--json");

// ============================================================================
// Date Helpers
// ============================================================================

export function parseRelativeDate(input: string): string | null {
  const lower = input.toLowerCase().trim();
  const today = new Date();

  if (lower === "today") {
    return today.toISOString().split("T")[0];
  }
  if (lower === "tomorrow" || lower === "tmrw") {
    today.setDate(today.getDate() + 1);
    return today.toISOString().split("T")[0];
  }

  // Day names
  const dayNames = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
  const dayAbbrevs: Record<string, number> = {};
  dayNames.forEach((name, i) => {
    dayAbbrevs[name] = i;
    dayAbbrevs[name + "day"] = i;
  });
  // Handle wednesday specially
  dayAbbrevs["wednesday"] = 3;

  for (const [name, dayIndex] of Object.entries(dayAbbrevs)) {
    if (lower === name) {
      const currentDay = today.getDay();
      let daysUntil = dayIndex - currentDay;
      if (daysUntil <= 0) daysUntil += 7;
      today.setDate(today.getDate() + daysUntil);
      return today.toISOString().split("T")[0];
    }
  }

  // +Nd format (e.g., +3d = 3 days from now)
  const plusDaysMatch = lower.match(/^\+(\d+)d$/);
  if (plusDaysMatch) {
    today.setDate(today.getDate() + parseInt(plusDaysMatch[1]));
    return today.toISOString().split("T")[0];
  }

  // +Nw format (e.g., +2w = 2 weeks from now)
  const plusWeeksMatch = lower.match(/^\+(\d+)w$/);
  if (plusWeeksMatch) {
    today.setDate(today.getDate() + parseInt(plusWeeksMatch[1]) * 7);
    return today.toISOString().split("T")[0];
  }

  // ISO date passthrough
  if (/^\d{4}-\d{2}-\d{2}$/.test(lower)) {
    return lower;
  }

  return null;
}

// ============================================================================
// Formatting (extracted to TaskFormatter.ts)
// ============================================================================

import { formatTaskLine, formatTaskDetail, safeParseJSON, formatProjectLine, PRIORITY_LABELS } from "./TaskFormatter.ts";
export { formatTaskLine, formatTaskDetail, safeParseJSON };

function output(data: unknown): void {
  if (JSON_FLAG) {
    console.log(JSON.stringify(data, null, 2));
  } else if (typeof data === "string") {
    console.log(data);
  }
}

// ============================================================================
// CLI Argument Parsing
// ============================================================================

function getArg(name: string, args: string[]): string | undefined {
  const index = args.indexOf(`--${name}`);
  if (index !== -1 && index + 1 < args.length) {
    return args[index + 1];
  }
  return undefined;
}

function hasFlag(name: string, args: string[]): boolean {
  return args.includes(`--${name}`);
}

// ============================================================================
// Command Handlers
// ============================================================================

function cmdToday(args: string[]): void {
  const db = getTaskDB();
  const tasks = db.getTodayTasks();

  if (JSON_FLAG) {
    output(tasks);
    db.close();
    return;
  }

  if (tasks.length === 0) {
    console.log("\nNo tasks for today. Use 'add' to create one.\n");
    db.close();
    return;
  }

  console.log(`\nToday's Tasks (${tasks.length}):\n`);
  for (const task of tasks) {
    console.log(`  ${formatTaskLine(task)}`);
  }

  // Show overdue
  const overdue = db.getOverdueTasks();
  if (overdue.length > 0) {
    console.log(`\nOverdue (${overdue.length}):\n`);
    for (const task of overdue) {
      console.log(`  ${formatTaskLine(task)}`);
    }
  }

  console.log("");
  db.close();
}

function cmdInbox(args: string[]): void {
  const db = getTaskDB();
  const tasks = db.getInboxTasks();

  if (JSON_FLAG) {
    output(tasks);
    db.close();
    return;
  }

  if (tasks.length === 0) {
    console.log("\nInbox is empty.\n");
    db.close();
    return;
  }

  console.log(`\nInbox (${tasks.length} items):\n`);
  for (const task of tasks) {
    console.log(`  ${formatTaskLine(task)}`);
  }
  console.log("");
  db.close();
}

async function cmdAdd(args: string[]): Promise<void> {
  // Get title - first non-flag argument after 'add'
  const rawTitle = args.find((a) => !a.startsWith("--"));
  if (!rawTitle) {
    console.error("Error: title required. Usage: add \"task title\" [--goal G25] [--project id] [--due fri] [--priority 1-3]");
    process.exit(1);
  }

  const useAI = hasFlag("ai", args);

  const db = getTaskDB();

  // ── AI Extraction (--ai flag) ──
  let aiExtracted: Awaited<ReturnType<typeof extractTaskMetadata>> | null = null;
  if (useAI) {
    const trustConfig = loadTrustConfig();
    if (trustConfig.copilot.extract_metadata) {
      try {
        let goalIds: string[] = [];
        let projectNames: string[] = [];
        try {
          goalIds = getAllGoalIds();
          projectNames = db.listProjects("active").map((p: Project) => p.name);
        } catch {
          // TELOS or project lookup unavailable
        }
        const today = new Date().toISOString().split("T")[0];
        const context: ExtractionContext = { today, goalIds, projectNames };
        aiExtracted = await extractTaskMetadata(rawTitle, context);
        if (!JSON_FLAG) {
          console.log(`  AI extracted: title="${aiExtracted.title}"${aiExtracted.due_date ? ` due=${aiExtracted.due_date}` : ""}${aiExtracted.priority ? ` priority=${aiExtracted.priority}` : ""}${aiExtracted.energy_level ? ` energy=${aiExtracted.energy_level}` : ""}`);
        }
      } catch {
        console.warn("  Warning: AI extraction failed, task created with raw input");
        aiExtracted = null;
      }
    }
  }

  // Explicit flags override AI suggestions
  const title: string = rawTitle.startsWith("--") ? rawTitle : (aiExtracted?.title || rawTitle);
  const goalId = getArg("goal", args) || aiExtracted?.goal_id || null;

  // Goal validation against TELOS
  if (goalId) {
    try {
      const validGoalIds = getAllGoalIds();
      if (!validGoalIds.includes(goalId)) {
        console.error(`Error: Goal "${goalId}" not found in TELOS. Valid goals: ${validGoalIds.join(", ")}`);
        process.exit(1);
      }
      const goal = getGoal(goalId);
      if (goal && goal.status !== "In Progress") {
        console.warn(`Warning: Goal ${goalId} status is "${goal.status}" (not In Progress). Task will still be created.`);
      }
    } catch {
      console.warn("Warning: TELOS not available, skipping goal validation.");
    }
  }

  const projectRef = getArg("project", args) || aiExtracted?.project_id || null;
  const dueInput = getArg("due", args);
  const scheduledInput = getArg("schedule", args);
  const priorityStr = getArg("priority", args);
  const status = (getArg("status", args) as TaskStatus) || "inbox";
  const description = getArg("desc", args) || getArg("description", args) || "";
  const energyLevel = (getArg("energy", args) || aiExtracted?.energy_level) as "low" | "medium" | "high" | undefined || undefined;
  const estimatedStr = getArg("estimate", args);
  const parentId = getArg("parent", args) || null;
  const recurRule = getArg("recur", args) || null;

  // Validate recurrence rule
  if (recurRule) {
    const validRules = ["daily", "weekly", "weekdays", "monthly"];
    const isCustom = /^custom:[MTWRFSU]+$/i.test(recurRule);
    if (!validRules.includes(recurRule) && !isCustom) {
      console.error(`Warning: invalid recurrence rule "${recurRule}". Use: daily, weekly, weekdays, monthly, or custom:MWF`);
    }
  }

  // Resolve project reference (could be ID or name)
  let projectId: string | null = null;
  if (projectRef) {
    const projectByName = db.getProjectByName(projectRef);
    if (projectByName) {
      projectId = projectByName.id;
    } else {
      const projectById = db.getProject(projectRef);
      if (projectById) {
        projectId = projectById.id;
      } else {
        console.error(`Warning: project "${projectRef}" not found. Task created without project.`);
      }
    }
  }

  // Resolve due date — explicit flag wins over AI suggestion
  const dueDate = dueInput
    ? parseRelativeDate(dueInput)
    : (aiExtracted?.due_date || null);
  if (dueInput && !dueDate) {
    console.error(`Warning: could not parse due date "${dueInput}". Use: today, tomorrow, fri, +3d, +2w, or YYYY-MM-DD`);
  }

  const scheduledDate = scheduledInput ? parseRelativeDate(scheduledInput) : null;

  // Resolve estimated minutes — explicit flag wins over AI suggestion
  const estimatedMinutes = estimatedStr
    ? parseInt(estimatedStr)
    : (aiExtracted?.estimated_minutes || null);

  // Resolve priority — explicit flag wins over AI suggestion
  const priority = priorityStr
    ? parseInt(priorityStr)
    : (aiExtracted?.priority || 2);

  try {
    const task = db.createTask({
      title,
      description,
      status,
      priority,
      energy_level: energyLevel || null,
      estimated_minutes: estimatedMinutes,
      due_date: dueDate,
      scheduled_date: scheduledDate,
      project_id: projectId,
      goal_id: goalId,
      parent_task_id: parentId,
      recurrence_rule: recurRule,
      raw_input: rawTitle,
    });

    if (JSON_FLAG) {
      output(task);
    } else {
      console.log(`\nCreated: ${formatTaskLine(task)}\n`);
    }

    notifySync(`Task added: ${task.title}`);

    // ── Queue Integration (--queue flag) ──
    if (hasFlag("queue", args)) {
      try {
        const { QueueManager } = await import("../../../Automation/QueueRouter/Tools/QueueManager.ts");
        const qm = new QueueManager();
        const queueItemId = await qm.add(
          {
            title: task.title,
            description: task.description || "",
            context: { source: "lucidtasks", taskId: task.id, priority: task.priority },
          },
          { source: "lucidtasks", autoSpec: false }
        );
        db.updateTask(task.id, { queue_item_id: queueItemId });
        db.logActivity(task.id, "queue_linked", JSON.stringify({ queueItemId }), "queue");
        console.log(`  (added to approvals queue: ${queueItemId})`);
      } catch (err) {
        console.error(`  Warning: Queue integration failed: ${err instanceof Error ? err.message : err}`);
      }
    }

    // ── Calendar Integration (--calendar flag) ──
    if (hasFlag("calendar", args)) {
      if (!task.due_date) {
        console.warn("  Warning: --calendar flag requires --due date. Calendar event not created.");
      } else {
        try {
          const { createEvent } = await import("../../CalendarAssistant/Tools/GoogleCalendarAdapter.ts");
          const est = task.estimated_minutes ?? 30;
          const startTime = `${task.due_date} 09:00`;
          const endHour = 9 + Math.floor(est / 60);
          const endMin = est % 60;
          const endTime = `${task.due_date} ${String(endHour).padStart(2, "0")}:${String(endMin).padStart(2, "0")}`;

          const calResult = await createEvent({
            title: task.title,
            start: startTime,
            end: endTime,
            description: `LucidTasks: ${task.id}`,
          });

          if (calResult.success) {
            db.logActivity(task.id, "calendar_synced", JSON.stringify({ start: startTime, end: endTime }), "calendar");
            console.log(`  (synced to calendar: ${startTime} - ${endTime})`);
          } else {
            console.error(`  Warning: Calendar sync failed: ${calResult.error.message}`);
          }
        } catch (err) {
          console.error(`  Warning: Calendar sync unavailable: ${err instanceof Error ? err.message : err}`);
        }
      }
    }
  } catch (err) {
    console.error(`Database error: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }

  db.close();
}

function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
}

async function cmdDone(args: string[]): Promise<void> {
  // Collect all non-flag positional args
  const taskArgs: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      // Skip flag and its value if it takes one
      if (args[i] === "--note" || args[i] === "--help") {
        i++; // skip the value of --note
      }
      continue;
    }
    taskArgs.push(args[i]);
  }

  if (taskArgs.length === 0) {
    console.error("Error: task ID or title required. Usage: done <id|title>... [--note \"text\"]");
    process.exit(1);
  }

  const note = getArg("note", args);
  const db = getTaskDB();

  const completed: Array<{ task: Task; elapsed_minutes?: number }> = [];
  const failed: Array<{ input: string; error: string }> = [];

  for (const arg of taskArgs) {
    try {
      // Determine if arg is a task ID or title fragment
      const isTaskId = /^t-/.test(arg);
      let resolvedTask: Task | null = null;

      if (isTaskId) {
        resolvedTask = db.getTask(arg);
        if (!resolvedTask) {
          failed.push({ input: arg, error: `Task not found: ${arg}` });
          console.error(`Task not found: ${arg}`);
          continue;
        }
      } else {
        // Fuzzy title match via FTS
        const candidates = db.searchTasks(arg, 5);
        // Filter out done/cancelled tasks
        const activeCandidates = candidates.filter((t) => t.status !== "done" && t.status !== "cancelled");

        if (activeCandidates.length === 0) {
          // Check if all matches are already done
          const doneCandidates = candidates.filter((t) => t.status === "done");
          if (doneCandidates.length > 0) {
            const msg = `Task '${doneCandidates[0].title}' (${doneCandidates[0].id}) is already done`;
            failed.push({ input: arg, error: msg });
            console.error(msg);
          } else {
            failed.push({ input: arg, error: `No match for '${arg}'` });
            console.error(`No match for '${arg}'`);
          }
          continue;
        } else if (activeCandidates.length === 1) {
          resolvedTask = activeCandidates[0];
        } else {
          // Ambiguous match
          console.error(`Ambiguous match for '${arg}'. Did you mean?`);
          for (const candidate of activeCandidates) {
            console.error(`  ${candidate.id}  ${candidate.title}`);
          }
          failed.push({ input: arg, error: `Ambiguous match for '${arg}'` });
          continue;
        }
      }

      // Check if already done
      if (resolvedTask.status === "done") {
        const msg = `Task '${resolvedTask.title}' (${resolvedTask.id}) is already done`;
        failed.push({ input: arg, error: msg });
        console.error(msg);
        continue;
      }

      // Calculate duration if started_at is present
      let elapsedMinutes: number | undefined;
      if (resolvedTask.started_at) {
        const startedTime = new Date(resolvedTask.started_at).getTime();
        const nowTime = Date.now();
        elapsedMinutes = Math.round((nowTime - startedTime) / (1000 * 60));
      }

      // Complete the task
      const updatedTask = db.updateTask(resolvedTask.id, { status: "done" });
      if (!updatedTask) {
        failed.push({ input: arg, error: `Failed to update task: ${resolvedTask.id}` });
        continue;
      }

      // Log activity with note and duration
      const changes: Record<string, unknown> = {};
      if (note) changes.note = note;
      if (elapsedMinutes !== undefined) changes.elapsed_minutes = elapsedMinutes;
      if (Object.keys(changes).length > 0) {
        db.logActivity(resolvedTask.id, "completed", JSON.stringify(changes), "user");
      }

      completed.push({ task: updatedTask, elapsed_minutes: elapsedMinutes });

      // Emit goal progress signal if task has a goal
      if (updatedTask.goal_id) {
        try {
          const { memoryStore } = await import("../../../../lib/core/MemoryStore.ts");
          const progress = db.getGoalProgress();
          const gp = progress[updatedTask.goal_id];
          if (gp) {
            await memoryStore.capture({
              type: 'signal',
              tags: ['pattern', 'tasks', 'goal-progress', updatedTask.goal_id],
              title: `Task completed for ${updatedTask.goal_id}: ${gp.completed}/${gp.total} (${gp.percentage}%)`,
              content: `Completed: "${updatedTask.title}" | Goal: ${updatedTask.goal_id} | Progress: ${gp.completed}/${gp.total} tasks (${gp.percentage}%)`,
              source: 'LucidTasks',
              metadata: { goalId: updatedTask.goal_id, missionId: updatedTask.mission_id,
                completed: gp.completed, total: gp.total, percentage: gp.percentage },
            });
          }
        } catch { /* Non-fatal — don't block task completion */ }
      }

      // Text output per task
      if (!JSON_FLAG) {
        const durationStr = elapsedMinutes !== undefined ? ` (took ${formatDuration(elapsedMinutes)})` : "";
        console.log(`Completed: ${updatedTask.title}${durationStr}`);
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      failed.push({ input: arg, error: errMsg });
      console.error(`Error processing '${arg}': ${errMsg}`);
    }
  }

  // Summary (only if >1 task attempted)
  if (taskArgs.length > 1 && !JSON_FLAG) {
    console.log(`\nSummary: ${completed.length} completed, ${failed.length} failed`);
  }

  if (JSON_FLAG) {
    output({ completed, failed });
  }

  // Notification for completed tasks
  if (completed.length > 0) {
    const titles = completed.map((c) => c.task.title).join(", ");
    notifySync(`Completed: ${titles}`);
  }

  // ── Calendar cleanup: remove events for tasks that were synced ──
  for (const { task } of completed) {
    const activityLog = db.getActivityLog(task.id);
    const wasSynced = activityLog.some((entry) => entry.action === "calendar_synced");
    if (wasSynced) {
      try {
        const { deleteEvent } = await import("../../CalendarAssistant/Tools/GoogleCalendarAdapter.ts");
        const delResult = await deleteEvent(task.title);
        if (delResult.success) {
          db.logActivity(task.id, "calendar_event_removed", null, "calendar");
          console.log(`  (calendar event removed: ${task.title})`);
        } else {
          // Graceful degradation — event may have been manually deleted
          console.warn(`  Warning: Could not remove calendar event for '${task.title}': ${delResult.error.message}`);
        }
      } catch (err) {
        console.warn(`  Warning: Calendar cleanup unavailable: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  // ── JmTaskBridge: resolve human task dependencies if linked to a queue item ──
  for (const { task: resolvedTask } of completed) {
    if (resolvedTask.queue_item_id) {
      try {
        const bridgeResult = Bun.spawnSync([
          "bun", join(process.env.HOME || "", ".claude/skills/Automation/AutonomousWork/Tools/JmTaskBridge.ts"),
          "resolve", "--lucid-task-id", resolvedTask.id,
        ]);
        if (bridgeResult.exitCode === 0) {
          const output = new TextDecoder().decode(bridgeResult.stdout).trim();
          if (output) console.log(`  ${output}`);
        }
      } catch { /* Bridge failure is non-fatal */ }
    }
  }

  db.close();
}

// ============================================================================
// Scoring Algorithm (extracted to TaskScorer.ts)
// ============================================================================

import { scoreTask, type ScoringContext, type ScoredTask } from "./TaskScorer.ts";
export { scoreTask };

async function cmdNext(args: string[]): Promise<void> {
  const db = getTaskDB();

  // Parse new flags
  const projectRef = getArg("project", args);
  const goalFilter = getArg("goal", args);
  const energyFilter = getArg("energy", args) as EnergyLevel | undefined;
  const topStr = getArg("top", args);
  const topN = topStr ? parseInt(topStr) : 3;
  const shouldStart = hasFlag("start", args);
  const useAI = hasFlag("ai", args);

  // Resolve project reference to project_id
  let projectId: string | undefined;
  if (projectRef) {
    const projectByName = db.getProjectByName(projectRef);
    if (projectByName) {
      projectId = projectByName.id;
    } else {
      const projectById = db.getProject(projectRef);
      if (projectById) {
        projectId = projectById.id;
      } else {
        console.error(`Warning: project "${projectRef}" not found. Ignoring filter.`);
      }
    }
  }

  // Fetch wider candidate pool
  const candidates = db.listTasks({
    status: ["next", "in_progress", "inbox"],
    limit: 50,
  });

  if (candidates.length === 0) {
    if (JSON_FLAG) {
      output([]);
    } else {
      console.log("\nNo tasks available. Add some with 'add'.\n");
    }
    db.close();
    return;
  }

  // Apply pre-filters
  let filtered = candidates;
  if (projectId) {
    filtered = filtered.filter((t) => t.project_id === projectId);
  }
  if (goalFilter) {
    filtered = filtered.filter((t) => t.goal_id === goalFilter);
  }
  // Energy filter does NOT exclude -- it just boosts matching tasks (per spec: "Results include tasks of all energy levels")

  if (filtered.length === 0) {
    if (JSON_FLAG) {
      output([]);
    } else {
      console.log("\nNo tasks match the given filters.\n");
    }
    db.close();
    return;
  }

  // Build scoring context
  let activeGoalIds: string[] = [];
  try {
    const telosData = loadTelosData();
    activeGoalIds = telosData.goals
      .filter((g) => g.status === "In Progress")
      .map((g) => g.id);
  } catch {
    // TELOS not available, skip goal alignment scoring
  }

  const ctx: ScoringContext = {
    projectFilter: projectId,
    goalFilter,
    energyFilter,
    activeGoalIds,
    now: new Date(),
  };

  // Score each task
  const scored = filtered.map((t) => scoreTask(t, ctx));

  // Sort by score descending, then tiebreaker: priority ASC, due_date ASC NULLS LAST, created_at DESC
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.task.priority !== b.task.priority) return a.task.priority - b.task.priority;
    if (a.task.due_date && b.task.due_date) return a.task.due_date.localeCompare(b.task.due_date);
    if (a.task.due_date && !b.task.due_date) return -1;
    if (!a.task.due_date && b.task.due_date) return 1;
    return (b.task.created_at || "").localeCompare(a.task.created_at || "");
  });

  const topTasks = scored.slice(0, topN);

  // ── AI Scoring (--ai flag) ──
  let aiScores: Map<string, { adjustment: number; ai_reasoning: string; final_score: number }> = new Map();
  if (useAI) {
    try {
      const scoringInputs: ScoredTaskInput[] = scored.map((st) => ({
        id: st.task.id,
        title: st.task.title,
        priority: st.task.priority,
        due_date: st.task.due_date,
        goal_id: st.task.goal_id,
        project_id: st.task.project_id,
        energy_level: st.task.energy_level,
        deterministic_score: st.score,
        reasons: st.reasons,
      }));

      const aiCtx: AIScoringContext = {
        tasks: scoringInputs,
        activeGoals: activeGoalIds.map((id) => ({ id, title: id, status: "In Progress" })),
        recentCompletions: 0,
        currentTime: new Date().toISOString(),
      };

      const aiResults = await scoreTasksWithAI(scoringInputs, aiCtx);
      for (const r of aiResults) {
        // Save to DB
        db.updateTask(r.id, { ai_priority_score: r.final_score, ai_reasoning: r.ai_reasoning }, "ai");
        aiScores.set(r.id, r);
      }

      // Re-sort by AI final_score for the displayed top tasks
      topTasks.sort((a, b) => {
        const aScore = aiScores.get(a.task.id)?.final_score ?? a.score;
        const bScore = aiScores.get(b.task.id)?.final_score ?? b.score;
        return bScore - aScore;
      });
    } catch {
      console.warn("  Warning: AI scoring failed, using deterministic scores");
    }
  }

  // Handle --start flag
  if (shouldStart && topTasks.length > 0) {
    const topTask = topTasks[0].task;
    db.updateTask(topTask.id, { status: "in_progress" });
    const now = new Date().toISOString();
    db.setStartedAt(topTask.id, now);
    db.logActivity(topTask.id, "started", null, "user");

    if (!JSON_FLAG) {
      console.log(`\nStarted: ${topTask.title} (timer running)\n`);
    }
  }

  // Output
  if (JSON_FLAG) {
    output(topTasks.map((st) => {
      const ai = aiScores.get(st.task.id);
      return {
        task: st.task,
        score: st.score,
        reasons: st.reasons,
        ai_adjustment: ai?.adjustment ?? null,
        ai_reasoning: ai?.ai_reasoning ?? null,
        final_score: ai?.final_score ?? st.score,
      };
    }));
  } else {
    const header = useAI ? "\nSuggested next tasks (AI-enhanced):\n" : "\nSuggested next tasks:\n";
    console.log(header);
    for (let i = 0; i < topTasks.length; i++) {
      const st = topTasks[i];
      const ai = aiScores.get(st.task.id);
      const displayScore = ai?.final_score ?? st.score;
      const priority = PRIORITY_LABELS[st.task.priority] || "   ";
      const due = st.task.due_date ? ` due:${st.task.due_date}` : "";
      const goal = st.task.goal_id ? ` ${st.task.goal_id}` : "";
      const project = st.task.project_id ? ` @${st.task.project_id}` : "";
      console.log(`  ${i + 1}. [Score: ${displayScore}] ${priority} ${st.task.id}  ${st.task.title}${due}${goal}${project}`);
      if (ai) {
        const sign = ai.adjustment >= 0 ? "+" : "";
        console.log(`     Deterministic: ${st.reasons.join(" + ")} = ${st.score}`);
        console.log(`     AI: ${sign}${ai.adjustment} — "${ai.ai_reasoning}"`);
      } else {
        console.log(`     ${st.reasons.join(" + ")}`);
      }
      if (i < topTasks.length - 1) console.log("");
    }
    console.log("");
  }

  db.close();
}

function cmdProjects(args: string[]): void {
  const db = getTaskDB();
  const projects = db.listProjects();

  if (JSON_FLAG) {
    output(projects);
    db.close();
    return;
  }

  if (projects.length === 0) {
    console.log("\nNo projects. Create one with 'project-add \"name\"'.\n");
    db.close();
    return;
  }

  // Count active tasks per project
  const stats = db.getStats();

  console.log(`\nProjects (${projects.length}):\n`);
  for (const project of projects) {
    const info = stats.byProject[project.id];
    const count = info ? info.count : 0;
    console.log(`  ${formatProjectLine(project, count)}`);
  }
  console.log("");

  db.close();
}

function cmdSearch(args: string[]): void {
  const query = args.find((a) => !a.startsWith("--"));
  if (!query) {
    console.error("Error: search query required. Usage: search \"query\"");
    process.exit(1);
  }

  const db = getTaskDB();
  const limitStr = getArg("limit", args);
  const limit = limitStr ? parseInt(limitStr) : 20;
  const tasks = db.searchTasks(query, limit);

  if (JSON_FLAG) {
    output(tasks);
    db.close();
    return;
  }

  if (tasks.length === 0) {
    console.log(`\nNo results for "${query}".\n`);
    db.close();
    return;
  }

  console.log(`\nSearch results for "${query}" (${tasks.length}):\n`);
  for (const task of tasks) {
    console.log(`  ${formatTaskLine(task)}`);
  }
  console.log("");

  db.close();
}

function cmdStats(args: string[]): void {
  const db = getTaskDB();
  const stats = db.getEnhancedStats();

  if (JSON_FLAG) {
    output(stats);
    db.close();
    return;
  }

  console.log(`
LucidTasks Dashboard
====================

Total Tasks:         ${stats.total}
Overdue:             ${stats.overdue}
Due Today:           ${stats.dueToday}
Completed (7 days):  ${stats.completedThisWeek}

By Status:
${Object.entries(stats.byStatus)
  .map(([status, count]) => `  ${status.padEnd(15)} ${count}`)
  .join("\n")}

By Project:
${Object.entries(stats.byProject)
  .map(([id, info]) => `  ${info.name.padEnd(20)} ${info.count} active`)
  .join("\n") || "  (none)"}

By Goal:
${Object.entries(stats.byGoal)
  .map(([goal, count]) => `  ${goal.padEnd(10)} ${count} active`)
  .join("\n") || "  (none)"}

Completion Velocity (last 4 weeks):
${stats.velocity.length > 0
  ? stats.velocity.map((w) => `  Week ${w.week}:  ${w.count} tasks`).join("\n")
  : "  No completions in last 4 weeks"}
  Average:             ${stats.averageVelocity} tasks/week

Task Duration:
${stats.tasksWithDuration > 0
  ? `  Average:             ${Math.round(stats.averageDurationMinutes)} min (based on ${stats.tasksWithDuration} tasks)`
  : "  No duration data available"}

Goal Progress:
${Object.entries(stats.goalProgress).length > 0
  ? Object.entries(stats.goalProgress)
      .map(([id, p]) => `  ${id.padEnd(10)} ${p.percentage}% (${p.completed}/${p.total})`)
      .join("\n")
  : "  (none)"}

Estimate Accuracy:
${(() => {
    const accuracy = db.getEstimateAccuracy();
    if (accuracy.count === 0) return "  No tasks with both estimate and actual duration";
    const direction = accuracy.medianRatio > 1 ? "overestimate" : "underestimate";
    const pct = Math.round(Math.abs(accuracy.medianRatio - 1) * 100);
    return `  Median ratio: ${accuracy.medianRatio}x (${accuracy.count} tasks)\n  You tend to ${direction} by ~${pct}%`;
  })()}

Energy Distribution:
  High:    ${stats.energyDistribution.high} tasks
  Medium:  ${stats.energyDistribution.medium} tasks
  Low:     ${stats.energyDistribution.low} tasks
  Unset:   ${stats.energyDistribution.unset} tasks

Overdue Breakdown:
  1-3 days:   ${stats.overdueBreakdown.find((b) => b.range === "1-3_days")?.count ?? 0} tasks
  4-7 days:   ${stats.overdueBreakdown.find((b) => b.range === "4-7_days")?.count ?? 0} tasks
  8-14 days:  ${stats.overdueBreakdown.find((b) => b.range === "8-14_days")?.count ?? 0} tasks
  15+ days:   ${stats.overdueBreakdown.find((b) => b.range === "15+_days")?.count ?? 0} tasks
`);

  db.close();
}

function cmdView(args: string[]): void {
  const id = args.find((a) => !a.startsWith("--"));
  if (!id) {
    console.error("Error: task ID required. Usage: view <id>");
    process.exit(1);
  }

  const db = getTaskDB();

  try {
    const task = db.getTask(id);

    if (!task) {
      console.error(`Task not found: ${id}`);
      process.exit(1);
    }

    if (JSON_FLAG) {
      output(task);
    } else {
      console.log(`\n${formatTaskDetail(task)}`);

      // Show subtasks if any
      const subtasks = db.getSubtasks(id);
      if (subtasks.length > 0) {
        console.log(`\nSubtasks (${subtasks.length}):`);
        for (const sub of subtasks) {
          console.log(`  ${formatTaskLine(sub)}`);
        }
      }

      // Show recent activity
      const activity = db.getActivityLog(id, 5);
      if (activity.length > 0) {
        console.log(`\nRecent Activity:`);
        for (const entry of activity) {
          console.log(`  ${entry.created_at.slice(0, 16)} - ${entry.action} by ${entry.actor}`);
        }
      }
      console.log("");
    }
  } catch (err) {
    console.error(`Database error: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }

  db.close();
}

function cmdEdit(args: string[]): void {
  const id = args.find((a) => !a.startsWith("--"));
  if (!id) {
    console.error("Error: task ID required. Usage: edit <id> --title \"new\" --status next ...");
    process.exit(1);
  }

  const db = getTaskDB();
  const existing = db.getTask(id);
  if (!existing) {
    console.error(`Task not found: ${id}`);
    process.exit(1);
  }

  const updates: Record<string, unknown> = {};

  const title = getArg("title", args);
  if (title) updates.title = title;

  const description = getArg("desc", args) || getArg("description", args);
  if (description) updates.description = description;

  const status = getArg("status", args) as TaskStatus | undefined;
  if (status) updates.status = status;

  const priorityStr = getArg("priority", args);
  if (priorityStr) updates.priority = parseInt(priorityStr);

  const dueInput = getArg("due", args);
  if (dueInput) {
    const dueDate = parseRelativeDate(dueInput);
    if (dueDate) {
      updates.due_date = dueDate;
    } else {
      console.error(`Warning: could not parse due date "${dueInput}"`);
    }
  }

  const goalId = getArg("goal", args);
  if (goalId) {
    // Goal validation against TELOS
    try {
      const validGoalIds = getAllGoalIds();
      if (!validGoalIds.includes(goalId)) {
        console.error(`Error: Goal "${goalId}" not found in TELOS. Valid goals: ${validGoalIds.join(", ")}`);
        process.exit(1);
      }
      const goalData = getGoal(goalId);
      if (goalData && goalData.status !== "In Progress") {
        console.warn(`Warning: Goal ${goalId} status is "${goalData.status}" (not In Progress). Task will still be updated.`);
      }
    } catch {
      console.warn("Warning: TELOS not available, skipping goal validation.");
    }
    updates.goal_id = goalId;
  }

  const projectRef = getArg("project", args);
  if (projectRef) {
    const projectByName = db.getProjectByName(projectRef);
    if (projectByName) {
      updates.project_id = projectByName.id;
    } else {
      const projectById = db.getProject(projectRef);
      if (projectById) {
        updates.project_id = projectById.id;
      } else {
        console.error(`Warning: project "${projectRef}" not found`);
      }
    }
  }

  const energyLevel = getArg("energy", args);
  if (energyLevel) updates.energy_level = energyLevel;

  const estimateStr = getArg("estimate", args);
  if (estimateStr) updates.estimated_minutes = parseInt(estimateStr);

  const queueItemId = getArg("queue-item-id", args);
  if (queueItemId) updates.queue_item_id = queueItemId;

  if (Object.keys(updates).length === 0) {
    console.error("Error: no updates provided. Use --title, --status, --due, --goal, --project, --priority, --energy, --estimate, --queue-item-id");
    process.exit(1);
  }

  try {
    const task = db.updateTask(id, updates);

    if (JSON_FLAG) {
      output(task);
    } else {
      console.log(`\nUpdated: ${formatTaskLine(task!)}\n`);
    }
  } catch (err) {
    console.error(`Database error: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }

  db.close();
}

function cmdProjectAdd(args: string[]): void {
  const name = args.find((a) => !a.startsWith("--"));
  if (!name) {
    console.error("Error: project name required. Usage: project-add \"name\" [--goal G25] [--color blue]");
    process.exit(1);
  }

  const db = getTaskDB();

  const goalId = getArg("goal", args) || null;
  const color = getArg("color", args) || null;
  const description = getArg("desc", args) || getArg("description", args) || "";

  const project = db.createProject({
    name,
    description,
    goal_id: goalId,
    color,
  });

  if (JSON_FLAG) {
    output(project);
  } else {
    console.log(`\nCreated project: ${formatProjectLine(project)}\n`);
  }

  db.close();
}

async function cmdMigrate(args: string[]): Promise<void> {
  // Dynamic import to keep TaskManager lightweight
  const { MigrationRunner } = await import("./MigrationRunner.ts");
  const dryRun = args.includes("--dry-run");
  const skipAI = args.includes("--skip-ai");
  const runner = new MigrationRunner({ dryRun, skipAI });
  await runner.run();
  if (!dryRun) {
    notifySync("Asana migration complete");
  }
}

function cmdList(args: string[]): void {
  const db = getTaskDB();

  const status = getArg("status", args) as TaskStatus | undefined;
  const projectId = getArg("project", args);
  const goalId = getArg("goal", args);
  const limitStr = getArg("limit", args);
  // --context-tags: filter by tags in the context_tags JSON array
  // Accepts a single tag (e.g. @kaya) or comma-separated tags (e.g. @kaya,@review)
  const contextTagsArg = getArg("context-tags", args);

  let tasks = db.listTasks({
    status: status || undefined,
    project_id: projectId || undefined,
    goal_id: goalId || undefined,
    limit: limitStr ? parseInt(limitStr) : 50,
  });

  // Apply context_tags filter in-memory (SQLite JSON functions may not be universally available)
  if (contextTagsArg) {
    const filterTags = contextTagsArg.split(",").map((t) => t.trim()).filter(Boolean);
    tasks = tasks.filter((task) => {
      const taskTags = safeParseJSON(task.context_tags);
      // Item matches if ALL requested filter tags are present in the task's context_tags
      return filterTags.every((ft) => taskTags.includes(ft));
    });
  }

  if (JSON_FLAG) {
    output(tasks);
    db.close();
    return;
  }

  if (tasks.length === 0) {
    console.log("\nNo tasks found.\n");
    db.close();
    return;
  }

  const label = status ? `Tasks (${status})` : contextTagsArg ? `Tasks (tags: ${contextTagsArg})` : "All Tasks";
  console.log(`\n${label} (${tasks.length}):\n`);
  for (const task of tasks) {
    console.log(`  ${formatTaskLine(task)}`);
  }
  console.log("");

  db.close();
}

// ============================================================================
// Phase 2 Command Handlers
// ============================================================================

function cmdHabits(args: string[]): void {
  const db = getTaskDB();
  const taskId = getArg("task", args);
  const daysStr = getArg("days", args);
  const days = daysStr ? parseInt(daysStr) : 30;

  if (taskId) {
    // Single task habit detail
    const stats = db.getHabitStats(taskId, days);

    if (JSON_FLAG) {
      output(stats);
      db.close();
      return;
    }

    const completionRate = `${stats.completionRate}%`;
    console.log(`
Habit Report: ${stats.taskTitle} (${stats.taskId})
${"=".repeat(45)}
Period:            Last ${days} days
Total Completions: ${stats.totalCompletions}
Current Streak:    ${stats.currentStreak} days
Longest Streak:    ${stats.longestStreak} days
Completion Rate:   ${completionRate}
`);
  } else {
    // Overview of all habits
    const allStats = db.getAllHabitStats(days);

    if (JSON_FLAG) {
      output(allStats);
      db.close();
      return;
    }

    if (allStats.length === 0) {
      console.log("\nNo habit data found. Complete recurring tasks to start tracking habits.\n");
      db.close();
      return;
    }

    console.log(`\nHabit Overview (last ${days} days, ${allStats.length} habits):\n`);
    for (const s of allStats) {
      const bar = "#".repeat(Math.min(s.currentStreak, 20));
      console.log(`  ${s.taskTitle.padEnd(30)} streak:${String(s.currentStreak).padStart(3)}d  rate:${String(s.completionRate).padStart(3)}%  ${bar}`);
    }
    console.log("");
  }

  db.close();
}

function cmdSaveView(args: string[]): void {
  const name = args.find((a) => !a.startsWith("--"));
  if (!name) {
    console.error("Error: view name required. Usage: save-view \"name\" [--status next] [--project id] [--priority 1-3] [--goal G25] [--energy low|medium|high]");
    process.exit(1);
  }

  const db = getTaskDB();

  const filter: TaskFilter = {};
  const statusVal = getArg("status", args);
  if (statusVal) filter.status = statusVal as TaskStatus;

  const projectRef = getArg("project", args);
  if (projectRef) {
    const projectByName = db.getProjectByName(projectRef);
    if (projectByName) {
      filter.project_id = projectByName.id;
    } else {
      const projectById = db.getProject(projectRef);
      if (projectById) {
        filter.project_id = projectById.id;
      } else {
        console.error(`Warning: project "${projectRef}" not found`);
      }
    }
  }

  const goalVal = getArg("goal", args);
  if (goalVal) filter.goal_id = goalVal;

  const dueBefore = getArg("due-before", args);
  if (dueBefore) filter.due_before = dueBefore;

  db.createSavedView(name, filter);

  if (JSON_FLAG) {
    output({ name, filter });
  } else {
    console.log(`\nSaved view: "${name}"\n`);
  }

  db.close();
}

function cmdViewSaved(args: string[]): void {
  const name = args.find((a) => !a.startsWith("--"));
  if (!name) {
    console.error("Error: view name required. Usage: view-saved \"name\"");
    process.exit(1);
  }

  const db = getTaskDB();
  const tasks = db.applyView(name);

  if (JSON_FLAG) {
    output(tasks);
    db.close();
    return;
  }

  if (tasks.length === 0) {
    const view = db.getSavedView(name);
    if (!view) {
      console.error(`View not found: "${name}"`);
      process.exit(1);
    }
    console.log(`\nView "${name}": No matching tasks.\n`);
    db.close();
    return;
  }

  console.log(`\nView "${name}" (${tasks.length} tasks):\n`);
  for (const task of tasks) {
    console.log(`  ${formatTaskLine(task)}`);
  }
  console.log("");

  db.close();
}

function cmdViews(args: string[]): void {
  const db = getTaskDB();
  const views = db.listSavedViews();

  if (JSON_FLAG) {
    output(views);
    db.close();
    return;
  }

  if (views.length === 0) {
    console.log("\nNo saved views. Create one with: save-view \"name\" [filters]\n");
    db.close();
    return;
  }

  console.log(`\nSaved Views (${views.length}):\n`);
  for (const view of views) {
    const defaultMark = view.isDefault ? " [default]" : "";
    const filterDesc = Object.entries(view.filter)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${k}:${String(v)}`)
      .join(" ");
    console.log(`  ${view.name.padEnd(20)} ${filterDesc}${defaultMark}`);
  }
  console.log("");

  db.close();
}

function cmdDeleteView(args: string[]): void {
  const name = args.find((a) => !a.startsWith("--"));
  if (!name) {
    console.error("Error: view name required. Usage: delete-view \"name\"");
    process.exit(1);
  }

  const db = getTaskDB();
  const deleted = db.deleteSavedView(name);

  if (JSON_FLAG) {
    output({ deleted, name });
    db.close();
    return;
  }

  if (deleted) {
    console.log(`\nDeleted view: "${name}"\n`);
  } else {
    console.error(`View not found: "${name}"`);
    process.exit(1);
  }

  db.close();
}

// ============================================================================
// Phase 5: AI Commands
// ============================================================================

async function cmdDecompose(args: string[]): Promise<void> {
  const taskId = args.find((a) => !a.startsWith("--"));
  if (!taskId) {
    console.error("Error: task ID required. Usage: decompose <id> [--dry-run]");
    process.exit(1);
  }

  const dryRun = hasFlag("dry-run", args);
  const db = getTaskDB();

  const task = db.getTask(taskId);
  if (!task) {
    console.error(`Task not found: ${taskId}`);
    process.exit(1);
  }

  // Check for existing subtasks
  const existingSubtasks = db.getSubtasks(taskId);
  if (existingSubtasks.length > 0 && !hasFlag("force", args)) {
    console.warn(`Warning: Task already has ${existingSubtasks.length} subtask(s). Use --force to decompose anyway.`);
    db.close();
    return;
  }

  // Resolve context
  let projectName: string | undefined;
  let goalDescription: string | undefined;

  if (task.project_id) {
    const project = db.getProject(task.project_id);
    if (project) projectName = project.name;
  }

  if (task.goal_id) {
    try {
      const goal = getGoal(task.goal_id);
      if (goal) goalDescription = goal.title;
    } catch {
      // TELOS unavailable
    }
  }

  if (!JSON_FLAG && !dryRun) {
    console.log(`\nDecomposing "${task.title}"...`);
  } else if (!JSON_FLAG && dryRun) {
    console.log(`\n[DRY RUN] Decomposing "${task.title}"...`);
  }

  const result = await decomposeTask(task, { projectName, goalDescription });

  if (!result) {
    console.error("Error: AI decomposition failed. Try again or check Inference.ts availability.");
    db.close();
    process.exit(1);
  }

  if (result.simple) {
    if (JSON_FLAG) {
      output({ simple: true, message: result.message });
    } else {
      console.log(`\n${result.message}\n`);
    }
    db.close();
    return;
  }

  const subtasks = result.subtasks;

  if (dryRun) {
    // Display only, no DB writes
    if (JSON_FLAG) {
      output({ dryRun: true, parentId: taskId, subtasks });
    } else {
      console.log(`\nProposed subtasks (${subtasks.length}) — [DRY RUN, not created]:\n`);
      let totalMinutes = 0;
      for (let i = 0; i < subtasks.length; i++) {
        const sub = subtasks[i];
        console.log(`  ${i + 1}. ${sub.title.padEnd(45)} est: ${formatDuration(sub.estimated_minutes)}  energy: ${sub.energy_level}`);
        totalMinutes += sub.estimated_minutes;
      }
      console.log(`\nTotal estimated: ${formatDuration(totalMinutes)}\n`);
    }
    db.close();
    return;
  }

  // Create subtasks in DB
  const createdIds: string[] = [];
  for (const sub of subtasks) {
    const created = db.createTask({
      title: sub.title,
      status: "next",
      priority: task.priority,
      energy_level: sub.energy_level,
      estimated_minutes: sub.estimated_minutes,
      goal_id: task.goal_id,
      project_id: task.project_id,
      parent_task_id: taskId,
    });
    createdIds.push(created.id);
  }

  // Log activity on parent
  db.logActivity(taskId, "decomposed", JSON.stringify({ subtaskIds: createdIds }), "ai");

  if (JSON_FLAG) {
    const createdTasks = createdIds.map((id) => db.getTask(id));
    output({ parentId: taskId, subtasks: createdTasks });
  } else {
    console.log(`\nDecomposed "${task.title}" into ${subtasks.length} subtasks:\n`);
    let totalMinutes = 0;
    for (let i = 0; i < subtasks.length; i++) {
      const sub = subtasks[i];
      const id = createdIds[i];
      console.log(`  ${i + 1}. ${id}  ${sub.title.padEnd(40)} est: ${formatDuration(sub.estimated_minutes)}  energy: ${sub.energy_level}`);
      totalMinutes += sub.estimated_minutes;
    }
    console.log(`\nTotal estimated: ${formatDuration(totalMinutes)}\n`);
  }

  db.close();
}

async function cmdPrioritize(args: string[]): Promise<void> {
  const dryRun = hasFlag("dry-run", args);
  const db = getTaskDB();

  // Fetch all active tasks
  const candidates = db.listTasks({
    status: ["next", "in_progress", "inbox"],
    limit: 200,
  });

  if (candidates.length === 0) {
    if (JSON_FLAG) {
      output({ rescored: 0, tasks: [] });
    } else {
      console.log("\nNo active tasks to prioritize.\n");
    }
    db.close();
    return;
  }

  if (!JSON_FLAG) {
    console.log(`\nRe-scoring ${candidates.length} active tasks with AI...`);
  }

  // Build deterministic scores first
  let activeGoalIds: string[] = [];
  try {
    const telosData = loadTelosData();
    activeGoalIds = telosData.goals.filter((g) => g.status === "In Progress").map((g) => g.id);
  } catch {
    // TELOS unavailable
  }

  const ctx: ScoringContext = {
    activeGoalIds,
    now: new Date(),
  };

  const scored = candidates.map((t) => scoreTask(t, ctx));

  // Build AI scoring inputs
  const scoringInputs: ScoredTaskInput[] = scored.map((st) => ({
    id: st.task.id,
    title: st.task.title,
    priority: st.task.priority,
    due_date: st.task.due_date,
    goal_id: st.task.goal_id,
    project_id: st.task.project_id,
    energy_level: st.task.energy_level,
    deterministic_score: st.score,
    reasons: st.reasons,
  }));

  let activeGoals: Array<{ id: string; title: string; status: string }> = [];
  try {
    const telosData = loadTelosData();
    activeGoals = telosData.goals
      .filter((g) => g.status === "In Progress")
      .map((g) => ({ id: g.id, title: g.title, status: g.status }));
  } catch {
    // TELOS unavailable
  }

  const aiCtx: AIScoringContext = {
    tasks: scoringInputs,
    activeGoals,
    recentCompletions: db.getStats().completedThisWeek,
    currentTime: new Date().toISOString(),
  };

  const aiResults = await scoreTasksWithAI(scoringInputs, aiCtx);

  if (!dryRun) {
    // Save scores to DB
    for (const r of aiResults) {
      db.updateTask(r.id, { ai_priority_score: r.final_score, ai_reasoning: r.ai_reasoning }, "ai");
      db.logActivity(r.id, "ai_scored", JSON.stringify({ adjustment: r.adjustment }), "ai");
    }
  }

  if (JSON_FLAG) {
    output({
      dryRun,
      rescored: aiResults.length,
      tasks: aiResults.map((r) => {
        const original = scored.find((s) => s.task.id === r.id);
        return {
          id: r.id,
          title: original?.task.title,
          deterministic_score: r.final_score - r.adjustment,
          adjustment: r.adjustment,
          final_score: r.final_score,
          ai_reasoning: r.ai_reasoning,
        };
      }),
    });
  } else {
    const prefix = dryRun ? "[DRY RUN] " : "";
    console.log(`\n${prefix}Re-scored ${aiResults.length} tasks:\n`);

    // Sort by final score desc
    const sorted = [...aiResults].sort((a, b) => b.final_score - a.final_score);
    for (const r of sorted.slice(0, 10)) {
      const original = scored.find((s) => s.task.id === r.id);
      const sign = r.adjustment >= 0 ? "+" : "";
      console.log(`  [${r.final_score}] ${r.id}  ${original?.task.title || r.id}`);
      console.log(`     ${sign}${r.adjustment} — "${r.ai_reasoning}"`);
    }
    if (aiResults.length > 10) {
      console.log(`  ... and ${aiResults.length - 10} more`);
    }
    console.log("");
  }

  db.close();
}

async function cmdReview(args: string[]): Promise<void> {
  const db = getTaskDB();

  if (!JSON_FLAG) {
    console.log("\nGenerating weekly review (this may take a few seconds)...");
  }

  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const endDate = now.toISOString().split("T")[0];
  const startDate = weekAgo.toISOString().split("T")[0];

  // Gather completed tasks this week
  const allCompleted = db.listTasks({ status: "done" as TaskStatus, limit: 500 });
  const completedThisWeek = allCompleted.filter(
    (t) => t.completed_at && t.completed_at >= weekAgo.toISOString()
  );

  // Gather added tasks this week
  const allTasks = db.listTasks({ limit: 1000 });
  const addedThisWeek = allTasks.filter(
    (t) => t.created_at && t.created_at >= weekAgo.toISOString()
  );

  // Overdue tasks
  const overdueTasks = db.getOverdueTasks();

  // Active goals
  let activeGoals: Array<{ id: string; title: string; status: string }> = [];
  try {
    const telosData = loadTelosData();
    activeGoals = telosData.goals
      .filter((g) => g.status === "In Progress")
      .map((g) => ({ id: g.id, title: g.title, status: g.status }));
  } catch {
    // TELOS unavailable
  }

  const stats = db.getStats();

  const reviewData: ReviewData = {
    period: { start: startDate, end: endDate },
    completedTasks: completedThisWeek.map((t) => ({
      id: t.id,
      title: t.title,
      goal_id: t.goal_id,
      project_id: t.project_id,
      estimated_minutes: t.estimated_minutes,
    })),
    addedTasks: addedThisWeek.map((t) => ({
      id: t.id,
      title: t.title,
      goal_id: t.goal_id,
    })),
    overdueTasks: overdueTasks.map((t) => ({
      id: t.id,
      title: t.title,
      due_date: t.due_date || "",
      goal_id: t.goal_id,
    })),
    activeGoals,
    stats: {
      total: stats.total,
      completedThisWeek: stats.completedThisWeek,
      overdue: stats.overdue,
      byStatus: stats.byStatus,
    },
  };

  const review = await generateWeeklyReview(reviewData);

  if (!review) {
    console.error("Error: Weekly review generation failed. Check Inference.ts availability.");
    db.close();
    process.exit(1);
  }

  if (JSON_FLAG) {
    output(review);
  } else {
    console.log(formatWeeklyReview(review));
  }

  db.close();
}

// ============================================================================
// Phase 6: Automation Command
// ============================================================================

async function cmdAutomate(args: string[]): Promise<void> {
  const subcommand = args.find((a) => !a.startsWith("--"));
  const dryRun = hasFlag("dry-run", args);

  // Dynamic import to keep TaskManager lightweight
  const {
    runMorning,
    runEvening,
    runWeekly,
    formatMorningSummary,
    formatEveningSummary,
    formatWeeklySummary,
  } = await import("./TaskAutomation.ts");

  switch (subcommand) {
    case "morning": {
      const summary = await runMorning({ dryRun });
      if (JSON_FLAG) {
        output(summary);
      } else {
        console.log(formatMorningSummary(summary));
      }
      break;
    }

    case "evening": {
      const summary = await runEvening({ dryRun });
      if (JSON_FLAG) {
        output(summary);
      } else {
        console.log(formatEveningSummary(summary));
      }
      break;
    }

    case "weekly": {
      const summary = await runWeekly({ dryRun });
      if (JSON_FLAG) {
        output(summary);
      } else {
        console.log(formatWeeklySummary(summary));
      }
      break;
    }

    case "status": {
      const proc = Bun.spawnSync(
        ["bun", `${import.meta.dir}/TaskAutomation.ts`, "status"],
        { stdout: "inherit", stderr: "inherit" }
      );
      if (proc.exitCode !== 0) {
        console.error("Error running automation status");
        process.exit(1);
      }
      break;
    }

    default: {
      console.error(`Error: automate subcommand required: morning, evening, weekly, status`);
      console.error("Usage: automate <morning|evening|weekly|status> [--dry-run] [--json]");
      process.exit(1);
    }
  }
}

// ============================================================================
// Help
// ============================================================================

function showHelp(): void {
  console.log(`
LucidTasks - AI-First Task Management

Usage:
  bun TaskManager.ts [command] [options]

Commands:
  (none)                          Today's tasks (next + in_progress)
  inbox                           Inbox items needing triage
  add "title" [opts]              Add a new task to inbox
  done <id|title>... [opts]       Complete tasks (batch, fuzzy match)
  next [opts]                     Smart task suggestions with scoring
  projects                        List all projects
  search "query"                  Full-text search on tasks
  stats                           Dashboard with counts and metrics (enhanced)
  view <id>                       View task details + activity log
  edit <id> [opts]                Edit a task
  list [opts]                     List tasks with filters
  project-add "name" [opts]       Create a new project
  migrate                         Run Asana migration
  habits [--task id] [--days 30]  Habit tracking and streaks
  save-view "name" [opts]         Save a named filter view
  view-saved "name"               Apply a saved view
  views                           List all saved views
  delete-view "name"              Delete a saved view
  decompose <id> [opts]           Decompose task into subtasks (AI)
  prioritize [opts]               Batch re-score all tasks with AI
  review [opts]                   Generate weekly strategic review (AI)
  automate <sub> [opts]           Run scheduled automation workflows

Add Options:
  --goal G25                      Link to TELOS goal (validated)
  --project <name|id>             Assign to project
  --due <date>                    Set due date (today, tomorrow, fri, +3d, +2w, YYYY-MM-DD)
  --schedule <date>               Set scheduled date
  --priority 1-3                  Set priority (1=high, 2=normal, 3=low)
  --status <status>               Set initial status (default: inbox)
  --desc "description"            Add description
  --energy low|medium|high        Set energy level
  --estimate <minutes>            Set time estimate
  --parent <task-id>              Set parent task (for subtasks)
  --recur <rule>                  Set recurrence: daily|weekly|weekdays|monthly|custom:MWF
  --ai                            AI-parse natural language into task fields (Haiku)

Done Options:
  --note "text"                   Add completion note to all tasks in batch

Next Options:
  --project <name|id>             Filter to tasks in this project
  --goal <id>                     Filter to tasks linked to this goal
  --energy low|medium|high        Boost tasks matching energy level
  --top <N>                       Number of suggestions (default: 3)
  --start                         Start working on top task (set timer)
  --ai                            AI-enhanced priority scoring (Sonnet)

Decompose Options:
  --dry-run                       Show proposed subtasks without creating them
  --force                         Decompose even if task already has subtasks

Prioritize Options:
  --dry-run                       Show proposed scores without saving

Review Options:
  (none)

Automate Subcommands:
  morning                         Run daily 8 AM maintenance (recurring, overdue, inbox, AI score)
  evening                         Run daily 9 PM maintenance (stale, tomorrow preview, stats)
  weekly                          Run Sunday 10 AM review (Opus review, goals, stale tasks, habits)
  status                          Show last run times and lifetime stats

Automate Options:
  --dry-run                       Show what would happen without executing any changes
  --json                          Output results as JSON

Edit Options:
  --title "new title"             Update title
  --status next|in_progress|...   Update status
  --due <date>                    Update due date
  --goal G25                      Update goal link (validated)
  --project <name|id>             Update project
  --priority 1-3                  Update priority
  --energy low|medium|high        Update energy level
  --estimate <minutes>            Update time estimate

List Options:
  --status <status>               Filter by status
  --project <id>                  Filter by project
  --goal <id>                     Filter by goal
  --limit <n>                     Limit results (default: 50)
  --context-tags <tag>            Filter by context_tags (e.g. @kaya or @kaya,@review)

Global Options:
  --json                          Output as JSON (pipe-friendly)
  --help, -h                      Show this help

Examples:
  bun TaskManager.ts add "Buy groceries" --due tomorrow
  bun TaskManager.ts add "Write chapter 3" --goal G13 --project writing --priority 1
  bun TaskManager.ts done t-abc123-xyz
  bun TaskManager.ts done t-001 t-002 t-003 --note "Sprint cleanup"
  bun TaskManager.ts done "buy groceries"
  bun TaskManager.ts next --project writing --energy high --top 5
  bun TaskManager.ts next --start
  bun TaskManager.ts next --json
  bun TaskManager.ts edit t-abc123-xyz --status next --due fri
  bun TaskManager.ts search "groceries"
  bun TaskManager.ts list --status next --json
  bun TaskManager.ts stats
`);
}

// ============================================================================
// Queue-to-Task Status Sync (exported for external callers)
// ============================================================================

/**
 * Sync task status based on queue item status changes.
 *
 * Called by QueueRouter hooks or external pollers when a queue item
 * linked to a LucidTask changes status.
 *
 * Does NOT call db.close() — the singleton manages its own lifecycle.
 *
 * @param taskId - The LucidTask ID (t-...)
 * @param queueStatus - The new queue item status string
 */
export function syncQueueStatus(taskId: string, queueStatus: string): void {
  const db = getTaskDB();
  const task = db.getTask(taskId);
  if (!task) {
    console.warn(`syncQueueStatus: task not found: ${taskId}`);
    return;
  }

  const statusMap: Partial<Record<string, TaskStatus>> = {
    approved: "next",
    pending: "next",
    in_progress: "in_progress",
    completed: "done",
  };

  const newStatus = statusMap[queueStatus];
  if (newStatus && task.status !== newStatus) {
    db.updateTask(taskId, { status: newStatus }, "queue");
    db.logActivity(taskId, "status_sync", JSON.stringify({ from: task.status, to: newStatus, queueStatus }), "queue");
  }
}

// ============================================================================
// Main CLI Entry Point
// ============================================================================

if (import.meta.main) {
  const args = process.argv.slice(2);

  // Remove --json flag from args for command parsing
  const commandArgs = args.filter((a) => a !== "--json");
  const command = commandArgs[0];
  const subArgs = commandArgs.slice(1);

  if (hasFlag("help", args) || command === "-h" || command === "--help") {
    showHelp();
    process.exit(0);
  }

  switch (command) {
    case undefined:
    case "today":
      cmdToday(subArgs);
      break;

    case "inbox":
      cmdInbox(subArgs);
      break;

    case "add":
      cmdAdd(subArgs).catch((err) => {
        console.error(`Add error: ${err}`);
        process.exit(1);
      });
      break;

    case "done":
    case "complete":
      cmdDone(subArgs).catch((err) => {
        console.error(`Done error: ${err}`);
        process.exit(1);
      });
      break;

    case "next":
      cmdNext(subArgs).catch((err) => {
        console.error(`Next error: ${err}`);
        process.exit(1);
      });
      break;

    case "projects":
      cmdProjects(subArgs);
      break;

    case "search":
      cmdSearch(subArgs);
      break;

    case "stats":
    case "dashboard":
      cmdStats(subArgs);
      break;

    case "view":
    case "show":
    case "get":
      cmdView(subArgs);
      break;

    case "edit":
    case "update":
      cmdEdit(subArgs);
      break;

    case "list":
    case "ls":
      cmdList(subArgs);
      break;

    case "project-add":
      cmdProjectAdd(subArgs);
      break;

    case "migrate":
      cmdMigrate(subArgs).catch((err) => {
        console.error(`Migration error: ${err}`);
        process.exit(1);
      });
      break;

    case "habits":
    case "habit":
      cmdHabits(subArgs);
      break;

    case "save-view":
      cmdSaveView(subArgs);
      break;

    case "view-saved":
    case "view-view":
      cmdViewSaved(subArgs);
      break;

    case "views":
    case "saved-views":
      cmdViews(subArgs);
      break;

    case "delete-view":
    case "rm-view":
      cmdDeleteView(subArgs);
      break;

    case "decompose":
      cmdDecompose(subArgs).catch((err) => {
        console.error(`Decompose error: ${err}`);
        process.exit(1);
      });
      break;

    case "prioritize":
    case "reprioritize":
      cmdPrioritize(subArgs).catch((err) => {
        console.error(`Prioritize error: ${err}`);
        process.exit(1);
      });
      break;

    case "review":
    case "weekly-review":
      cmdReview(subArgs).catch((err) => {
        console.error(`Review error: ${err}`);
        process.exit(1);
      });
      break;

    case "automate":
    case "auto":
      cmdAutomate(subArgs).catch((err) => {
        console.error(`Automate error: ${err}`);
        process.exit(1);
      });
      break;

    default:
      console.error(`Unknown command: ${command}`);
      console.error("Use --help for usage.");
      process.exit(1);
  }
}
