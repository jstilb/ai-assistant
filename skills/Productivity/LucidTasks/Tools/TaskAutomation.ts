#!/usr/bin/env bun
/**
 * TaskAutomation.ts - Scheduled Automation Engine for LucidTasks
 *
 * Provides three automation workflows triggered by cron jobs or manual CLI:
 *   - Morning (8 AM): recurring generation, overdue reschedule, inbox triage, AI re-scoring
 *   - Evening (9 PM): stale in-progress detection, tomorrow preview, daily stats snapshot
 *   - Weekly (Sunday 10 AM): Opus review, goal alignment velocity, stale task detection, habit streaks
 *
 * All operations respect TrustConfig.yaml autopilot settings.
 * Every automated change is logged to activity_log with actor "cron".
 * Idempotent: safe to run multiple times without side effects.
 *
 * Usage:
 *   bun TaskAutomation.ts morning [--dry-run] [--json]
 *   bun TaskAutomation.ts evening [--dry-run] [--json]
 *   bun TaskAutomation.ts weekly  [--dry-run] [--json]
 *   bun TaskAutomation.ts status
 *
 * @module TaskAutomation
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "fs";
import { join, dirname } from "path";
import { getTaskDB, calculateNextDueDate, generateTaskId } from "./TaskDB.ts";
import type { Task, HabitStats } from "./TaskDB.ts";
import { loadTrustConfig } from "./TaskAI.ts";
import type { TrustConfig, ReviewData, WeeklyReview } from "./TaskAI.ts";

// ============================================================================
// Configuration
// ============================================================================

const KAYA_HOME = process.env.KAYA_HOME ?? join(process.env.HOME ?? "", ".claude");
const LUCID_DATA_DIR = join(KAYA_HOME, "skills/Productivity/LucidTasks/Data");
const AUTOMATION_STATE_PATH = join(LUCID_DATA_DIR, "automation-state.json");
const DAILY_STATS_PATH = join(LUCID_DATA_DIR, "daily-stats.jsonl");
const REVIEWS_DIR = join(LUCID_DATA_DIR, "reviews");

// Batch limits to prevent runaway AI costs
const MAX_INBOX_BATCHES = 5;
const INBOX_BATCH_SIZE = 10;

// Stale thresholds
const STALE_IN_PROGRESS_HOURS = 48;
const STALE_TASK_DAYS = 30;

// ============================================================================
// Types
// ============================================================================

export interface AutomationState {
  lastMorningRun: string | null;
  lastEveningRun: string | null;
  lastWeeklyRun: string | null;
  lastRecurrenceCheck: string | null;
  stats: {
    totalRecurrencesGenerated: number;
    totalAutoRescheduled: number;
    totalAutoExtracted: number;
    totalReviewsGenerated: number;
  };
}

export interface MorningSummary {
  timestamp: string;
  durationMs: number;
  recurring: { generated: number; titles: string[] };
  overdue: { count: number; rescheduled: number; autopilotOff: boolean };
  inbox: { count: number; needsAttention: boolean; extracted: number };
  prioritized: { count: number; skipped: boolean };
  dryRun: boolean;
}

export interface EveningSummary {
  timestamp: string;
  durationMs: number;
  staleInProgress: Array<{ id: string; title: string; startedHoursAgo: number }>;
  tomorrow: { dueCount: number; scheduledCount: number };
  stats: DailyStatsEntry;
  dryRun: boolean;
}

export interface WeeklySummary {
  timestamp: string;
  durationMs: number;
  reviewPath: string | null;
  goalAlignment: GoalAlignmentEntry[];
  staleTasks: { next: number; someday: number };
  habits: HabitSummaryEntry[];
  dryRun: boolean;
}

export interface DailyStatsEntry {
  date: string;
  completed: number;
  added: number;
  overdue: number;
  inbox: number;
  active: number;
}

export interface GoalAlignmentEntry {
  goalId: string;
  completedThisWeek: number;
  completedLastWeek: number;
  remaining: number;
  velocity: "increasing" | "stable" | "declining";
}

export interface HabitSummaryEntry {
  taskId: string;
  taskTitle: string;
  currentStreak: number;
  brokenThisWeek: boolean;
}

// ============================================================================
// State Management
// ============================================================================

function loadState(): AutomationState {
  if (!existsSync(AUTOMATION_STATE_PATH)) {
    return {
      lastMorningRun: null,
      lastEveningRun: null,
      lastWeeklyRun: null,
      lastRecurrenceCheck: null,
      stats: {
        totalRecurrencesGenerated: 0,
        totalAutoRescheduled: 0,
        totalAutoExtracted: 0,
        totalReviewsGenerated: 0,
      },
    };
  }

  try {
    const raw = readFileSync(AUTOMATION_STATE_PATH, "utf-8");
    const parsed = JSON.parse(raw) as AutomationState;
    // Ensure stats object exists (for upgrade from older state)
    if (!parsed.stats) {
      parsed.stats = {
        totalRecurrencesGenerated: 0,
        totalAutoRescheduled: 0,
        totalAutoExtracted: 0,
        totalReviewsGenerated: 0,
      };
    }
    return parsed;
  } catch {
    return {
      lastMorningRun: null,
      lastEveningRun: null,
      lastWeeklyRun: null,
      lastRecurrenceCheck: null,
      stats: {
        totalRecurrencesGenerated: 0,
        totalAutoRescheduled: 0,
        totalAutoExtracted: 0,
        totalReviewsGenerated: 0,
      },
    };
  }
}

function saveState(state: AutomationState, dryRun: boolean): void {
  if (dryRun) return;

  ensureDir(LUCID_DATA_DIR);
  writeFileSync(AUTOMATION_STATE_PATH, JSON.stringify(state, null, 2), "utf-8");
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

// ============================================================================
// Capability 6.1: Daily Morning Maintenance
// ============================================================================

/**
 * Run morning maintenance operations in sequence:
 * 1. Recurring task generation
 * 2. Overdue reschedule (if autopilot on)
 * 3. Inbox triage (count + optional AI extraction)
 * 4. Priority re-score (if autopilot on)
 */
export async function runMorning(options: { dryRun?: boolean } = {}): Promise<MorningSummary> {
  const startTime = Date.now();
  const { dryRun = false } = options;

  const db = getTaskDB();
  const trustConfig = loadTrustConfig();
  const state = loadState();
  const today = new Date().toISOString().split("T")[0];
  const timestamp = new Date().toISOString();

  const summary: MorningSummary = {
    timestamp,
    durationMs: 0,
    recurring: { generated: 0, titles: [] },
    overdue: { count: 0, rescheduled: 0, autopilotOff: false },
    inbox: { count: 0, needsAttention: false, extracted: 0 },
    prioritized: { count: 0, skipped: false },
    dryRun,
  };

  // Step 1: Recurring Task Generation
  const recurResult = runRecurringGeneration(db, state, today, dryRun);
  summary.recurring = recurResult;
  state.stats.totalRecurrencesGenerated += recurResult.generated;

  // Step 2: Overdue Reschedule
  const overdueResult = runOverdueReschedule(db, trustConfig, today, dryRun);
  summary.overdue = overdueResult;
  state.stats.totalAutoRescheduled += overdueResult.rescheduled;

  // Step 3: Inbox Triage
  const inboxResult = await runInboxTriage(db, trustConfig, dryRun);
  summary.inbox = inboxResult;
  state.stats.totalAutoExtracted += inboxResult.extracted;

  // Step 4: Priority Re-score
  const prioritizeResult = await runPriorityRescore(db, trustConfig, dryRun);
  summary.prioritized = prioritizeResult;

  // Update state timestamps
  if (!dryRun) {
    state.lastMorningRun = timestamp;
    state.lastRecurrenceCheck = timestamp;
    saveState(state, false);
  }

  summary.durationMs = Date.now() - startTime;
  db.close();
  return summary;
}

/**
 * Generate recurring task instances for completed tasks since last check.
 * Idempotent: checks for existing instances before creating duplicates.
 */
function runRecurringGeneration(
  db: ReturnType<typeof getTaskDB>,
  state: AutomationState,
  today: string,
  dryRun: boolean
): MorningSummary["recurring"] {
  const since = state.lastRecurrenceCheck ?? new Date(0).toISOString();

  // Find completed tasks with recurrence_rule completed since last check
  const rawDb = db.getRawDb();
  const completedWithRecurrence = rawDb
    .prepare(
      `SELECT * FROM tasks
       WHERE status = 'done'
         AND recurrence_rule IS NOT NULL
         AND completed_at >= $since
       ORDER BY completed_at ASC`
    )
    .all({ $since: since }) as Task[];

  const generated: string[] = [];

  for (const task of completedWithRecurrence) {
    if (!task.recurrence_rule) continue;

    // Calculate target due date
    const nextDueDate = calculateNextDueDate(task.due_date, task.recurrence_rule);

    // Idempotency check: does an instance for this date + parent already exist?
    const existingInstance = rawDb
      .prepare(
        `SELECT id FROM tasks
         WHERE parent_task_id = $parent_id
           AND due_date = $due_date
           AND status != 'done'
         LIMIT 1`
      )
      .get({ $parent_id: task.id, $due_date: nextDueDate }) as { id: string } | null;

    // Also check by recurrence_rule + title + due_date (handles tasks without parent_task_id tracking)
    const existingByTitle = rawDb
      .prepare(
        `SELECT id FROM tasks
         WHERE title = $title
           AND recurrence_rule = $rule
           AND due_date = $due_date
           AND status != 'done'
           AND created_at > $since
         LIMIT 1`
      )
      .get({
        $title: task.title,
        $rule: task.recurrence_rule,
        $due_date: nextDueDate,
        $since: since,
      }) as { id: string } | null;

    if (existingInstance ?? existingByTitle) {
      // Recurrence instance already exists — skip (idempotent)
      continue;
    }

    if (!dryRun) {
      const newTaskId = generateTaskId();
      const now = new Date().toISOString();

      rawDb
        .prepare(
          `INSERT INTO tasks (
            id, title, description, status, priority, energy_level,
            estimated_minutes, due_date, scheduled_date, project_id,
            goal_id, mission_id, context_tags, labels, recurrence_rule,
            parent_task_id, created_at, updated_at
          ) VALUES (
            $id, $title, $description, $status, $priority, $energy_level,
            $estimated_minutes, $due_date, $scheduled_date, $project_id,
            $goal_id, $mission_id, $context_tags, $labels, $recurrence_rule,
            $parent_task_id, $created_at, $updated_at
          )`
        )
        .run({
          $id: newTaskId,
          $title: task.title,
          $description: task.description,
          $status: "next",
          $priority: task.priority,
          $energy_level: task.energy_level,
          $estimated_minutes: task.estimated_minutes,
          $due_date: nextDueDate,
          $scheduled_date: nextDueDate,
          $project_id: task.project_id,
          $goal_id: task.goal_id,
          $mission_id: task.mission_id,
          $context_tags: task.context_tags,
          $labels: task.labels,
          $recurrence_rule: task.recurrence_rule,
          $parent_task_id: task.id,
          $created_at: now,
          $updated_at: now,
        });

      db.logActivity(
        newTaskId,
        "recurrence_generated",
        JSON.stringify({ from_task: task.id, rule: task.recurrence_rule, due_date: nextDueDate }),
        "cron"
      );
    }

    generated.push(task.title);
  }

  return { generated: generated.length, titles: generated };
}

/**
 * Detect overdue tasks and optionally reschedule to today per TrustConfig.
 */
function runOverdueReschedule(
  db: ReturnType<typeof getTaskDB>,
  trustConfig: TrustConfig,
  today: string,
  dryRun: boolean
): MorningSummary["overdue"] {
  const overdueTasks = db.getOverdueTasks();
  let rescheduled = 0;

  if (trustConfig.autopilot.reschedule_overdue && !dryRun) {
    for (const task of overdueTasks) {
      db.updateTask(task.id, { due_date: today, scheduled_date: today }, "cron");
      db.logActivity(
        task.id,
        "auto_rescheduled",
        JSON.stringify({ from_due: task.due_date, to_due: today }),
        "cron"
      );
      rescheduled++;
    }
  }

  return {
    count: overdueTasks.length,
    rescheduled,
    autopilotOff: !trustConfig.autopilot.reschedule_overdue,
  };
}

/**
 * Check inbox size and optionally run AI extraction on tasks missing metadata.
 * Batches 10 at a time, max 5 batches per run (50 tasks).
 */
async function runInboxTriage(
  db: ReturnType<typeof getTaskDB>,
  trustConfig: TrustConfig,
  dryRun: boolean
): Promise<MorningSummary["inbox"]> {
  const inboxTasks = db.getInboxTasks();
  const count = inboxTasks.length;
  const needsAttention = count > 10;
  let extracted = 0;

  if (trustConfig.autopilot.auto_extract && needsAttention && !dryRun) {
    // Find inbox tasks missing metadata (no goal_id, no energy_level)
    const missingMeta = inboxTasks.filter((t) => !t.goal_id && !t.energy_level);

    try {
      const { extractTaskMetadata } = await import("./TaskAI.ts");
      const { getAllGoalIds } = await import("./TelosGoalLoader.ts");

      let goalIds: string[] = [];
      let projectNames: string[] = [];
      try {
        goalIds = getAllGoalIds();
        projectNames = db.listProjects("active").map((p) => p.name);
      } catch {
        // TELOS unavailable — proceed without goal context
      }

      const todayStr = new Date().toISOString().split("T")[0];
      const batchCount = Math.min(Math.ceil(missingMeta.length / INBOX_BATCH_SIZE), MAX_INBOX_BATCHES);

      for (let batchIdx = 0; batchIdx < batchCount; batchIdx++) {
        const batch = missingMeta.slice(batchIdx * INBOX_BATCH_SIZE, (batchIdx + 1) * INBOX_BATCH_SIZE);

        for (const task of batch) {
          try {
            const extracted_metadata = await extractTaskMetadata(task.title, {
              today: todayStr,
              goalIds,
              projectNames,
            });

            const updates: Partial<Task> = {};
            if (extracted_metadata.energy_level) updates.energy_level = extracted_metadata.energy_level;
            if (extracted_metadata.goal_id && goalIds.includes(extracted_metadata.goal_id)) {
              updates.goal_id = extracted_metadata.goal_id;
            }
            if (extracted_metadata.priority) updates.priority = extracted_metadata.priority;
            if (extracted_metadata.estimated_minutes) updates.estimated_minutes = extracted_metadata.estimated_minutes;

            if (Object.keys(updates).length > 0) {
              db.updateTask(task.id, updates, "cron");
              db.logActivity(
                task.id,
                "auto_extracted",
                JSON.stringify(updates),
                "cron"
              );
              extracted++;
            }
          } catch {
            // Per-task extraction failure is non-fatal
          }
        }
      }
    } catch {
      // TaskAI unavailable — skip extraction gracefully
    }
  }

  return { count, needsAttention, extracted };
}

/**
 * Lightweight deterministic task scorer for use in automation context.
 * Mirrors the scoring logic from TaskManager.ts without importing it (avoids circular deps).
 */
function scoreTaskDeterministic(
  task: Task,
  activeGoalIds: string[],
  now: Date
): { score: number; reasons: string[] } {
  let score = 0;
  const reasons: string[] = [];
  const today = now.toISOString().split("T")[0];
  const in48h = new Date(now.getTime() + 48 * 60 * 60 * 1000).toISOString().split("T")[0];

  if (task.due_date && task.due_date < today) {
    score += 50;
    reasons.push("Overdue (+50)");
  }

  if (task.priority === 1) {
    score += 30;
    reasons.push("High priority (+30)");
  } else if (task.priority === 2) {
    score += 15;
    reasons.push("Normal priority (+15)");
  }

  if (task.due_date && task.due_date >= today && task.due_date <= in48h) {
    score += 20;
    reasons.push("Due within 48h (+20)");
  }

  if (task.goal_id && activeGoalIds.includes(task.goal_id)) {
    score += 15;
    reasons.push(`Goal ${task.goal_id} aligned (+15)`);
  }

  if (task.updated_at) {
    const updatedTime = new Date(task.updated_at).getTime();
    const oneDayAgo = now.getTime() - 24 * 60 * 60 * 1000;
    if (updatedTime >= oneDayAgo) {
      score += 5;
      reasons.push("Recently updated (+5)");
    }
  }

  return { score, reasons };
}

/**
 * AI priority re-scoring for all active tasks (if autopilot enabled).
 * Uses inline deterministic scorer to avoid circular import from TaskManager.
 */
async function runPriorityRescore(
  db: ReturnType<typeof getTaskDB>,
  trustConfig: TrustConfig,
  dryRun: boolean
): Promise<MorningSummary["prioritized"]> {
  if (!trustConfig.autopilot.auto_prioritize) {
    return { count: 0, skipped: true };
  }

  try {
    const { scoreTasksWithAI } = await import("./TaskAI.ts");
    const { loadTelosData } = await import("./TelosGoalLoader.ts");

    const candidates = db.listTasks({
      status: ["next", "in_progress"],
      limit: 200,
    });

    if (candidates.length === 0) {
      return { count: 0, skipped: false };
    }

    let activeGoalIds: string[] = [];
    let activeGoals: Array<{ id: string; title: string; status: string }> = [];
    try {
      const telosData = loadTelosData();
      activeGoalIds = telosData.goals.filter((g) => g.status === "In Progress").map((g) => g.id);
      activeGoals = telosData.goals
        .filter((g) => g.status === "In Progress")
        .map((g) => ({ id: g.id, title: g.title, status: g.status }));
    } catch {
      // TELOS unavailable
    }

    const now = new Date();
    const scoringInputs = candidates.map((task) => {
      const { score, reasons } = scoreTaskDeterministic(task, activeGoalIds, now);
      return {
        id: task.id,
        title: task.title,
        priority: task.priority,
        due_date: task.due_date,
        goal_id: task.goal_id,
        project_id: task.project_id,
        energy_level: task.energy_level,
        deterministic_score: score,
        reasons,
      };
    });

    const aiResults = await scoreTasksWithAI(scoringInputs, {
      tasks: scoringInputs,
      activeGoals,
      recentCompletions: db.getStats().completedThisWeek,
      currentTime: new Date().toISOString(),
    });

    if (!dryRun) {
      for (const result of aiResults) {
        db.updateTask(result.id, { ai_priority_score: result.final_score, ai_reasoning: result.ai_reasoning }, "cron");
        db.logActivity(result.id, "auto_prioritized", JSON.stringify({ adjustment: result.adjustment }), "cron");
      }
    }

    return { count: aiResults.length, skipped: false };
  } catch {
    // TaskAI unavailable — skip gracefully
    return { count: 0, skipped: true };
  }
}

// ============================================================================
// Capability 6.2: Daily Evening Maintenance
// ============================================================================

/**
 * Run evening maintenance:
 * 1. Stale in-progress detection (>48h)
 * 2. Tomorrow preview
 * 3. Daily stats snapshot
 */
export async function runEvening(options: { dryRun?: boolean } = {}): Promise<EveningSummary> {
  const startTime = Date.now();
  const { dryRun = false } = options;

  const db = getTaskDB();
  const state = loadState();
  const timestamp = new Date().toISOString();
  const today = new Date().toISOString().split("T")[0];

  // Step 1: Stale in-progress detection
  const staleInProgress = detectStaleInProgress(db);

  // Step 2: Tomorrow preview
  const tomorrow = getTomorrowDate();
  const tomorrowTasks = db.listTasks({ due_before: getDateAfterTomorrow() });
  const dueTomorrow = tomorrowTasks.filter((t) => t.due_date === tomorrow && t.status !== "done" && t.status !== "cancelled");
  const scheduledTomorrow = db.listTasks({ scheduled_date: tomorrow });
  const scheduledTomorrowActive = scheduledTomorrow.filter((t) => t.status !== "done" && t.status !== "cancelled");

  // Step 3: Daily stats snapshot
  const statsEntry = gatherDailyStats(db, today);

  if (!dryRun) {
    appendDailyStats(statsEntry);
    state.lastEveningRun = timestamp;
    saveState(state, false);
  }

  const summary: EveningSummary = {
    timestamp,
    durationMs: Date.now() - startTime,
    staleInProgress,
    tomorrow: {
      dueCount: dueTomorrow.length,
      scheduledCount: scheduledTomorrowActive.length,
    },
    stats: statsEntry,
    dryRun,
  };

  db.close();
  return summary;
}

function detectStaleInProgress(db: ReturnType<typeof getTaskDB>): Array<{ id: string; title: string; startedHoursAgo: number }> {
  const rawDb = db.getRawDb();
  const cutoff = new Date(Date.now() - STALE_IN_PROGRESS_HOURS * 60 * 60 * 1000).toISOString();

  const staleTasks = rawDb
    .prepare(
      `SELECT id, title, started_at FROM tasks
       WHERE status = 'in_progress'
         AND started_at IS NOT NULL
         AND started_at <= $cutoff
       ORDER BY started_at ASC`
    )
    .all({ $cutoff: cutoff }) as Array<{ id: string; title: string; started_at: string }>;

  return staleTasks.map((t) => ({
    id: t.id,
    title: t.title,
    startedHoursAgo: Math.floor((Date.now() - new Date(t.started_at).getTime()) / (1000 * 60 * 60)),
  }));
}

function getTomorrowDate(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString().split("T")[0];
}

function getDateAfterTomorrow(): string {
  const d = new Date();
  d.setDate(d.getDate() + 2);
  return d.toISOString().split("T")[0];
}

function gatherDailyStats(db: ReturnType<typeof getTaskDB>, today: string): DailyStatsEntry {
  const rawDb = db.getRawDb();

  const startOfDay = `${today}T00:00:00.000Z`;
  const endOfDay = `${today}T23:59:59.999Z`;

  const completed = (
    rawDb
      .prepare(
        `SELECT COUNT(*) as count FROM tasks
         WHERE status = 'done' AND completed_at >= $start AND completed_at <= $end`
      )
      .get({ $start: startOfDay, $end: endOfDay }) as { count: number }
  ).count;

  const added = (
    rawDb
      .prepare(
        `SELECT COUNT(*) as count FROM tasks
         WHERE created_at >= $start AND created_at <= $end`
      )
      .get({ $start: startOfDay, $end: endOfDay }) as { count: number }
  ).count;

  const overdue = (
    rawDb
      .prepare(
        `SELECT COUNT(*) as count FROM tasks
         WHERE due_date IS NOT NULL AND due_date < $today
           AND status NOT IN ('done', 'cancelled')`
      )
      .get({ $today: today }) as { count: number }
  ).count;

  const inbox = (
    rawDb
      .prepare("SELECT COUNT(*) as count FROM tasks WHERE status = 'inbox'")
      .get() as { count: number }
  ).count;

  const active = (
    rawDb
      .prepare(
        "SELECT COUNT(*) as count FROM tasks WHERE status IN ('next', 'in_progress', 'waiting')"
      )
      .get() as { count: number }
  ).count;

  return { date: today, completed, added, overdue, inbox, active };
}

function appendDailyStats(entry: DailyStatsEntry): void {
  ensureDir(LUCID_DATA_DIR);
  const line = JSON.stringify(entry) + "\n";
  appendFileSync(DAILY_STATS_PATH, line, "utf-8");
}

// ============================================================================
// Capability 6.3: Weekly Review (Sunday 10 AM)
// ============================================================================

/**
 * Run weekly review:
 * 1. Generate Opus weekly review via TaskAI
 * 2. Goal alignment velocity report
 * 3. Stale task detection (>30 days)
 * 4. Habit streak report
 */
export async function runWeekly(options: { dryRun?: boolean } = {}): Promise<WeeklySummary> {
  const startTime = Date.now();
  const { dryRun = false } = options;

  const db = getTaskDB();
  const state = loadState();
  const timestamp = new Date().toISOString();
  const today = new Date().toISOString().split("T")[0];

  let reviewPath: string | null = null;

  // Step 1: Generate weekly review
  reviewPath = await generateAndSaveReview(db, today, dryRun, state);

  // Step 2: Goal alignment velocity
  const goalAlignment = buildGoalAlignmentReport(db, today);

  // Step 3: Stale task detection
  const staleTasks = detectStaleTasks(db);

  // Step 4: Habit streak report
  const habits = buildHabitReport(db);

  if (!dryRun) {
    state.lastWeeklyRun = timestamp;
    saveState(state, false);
  }

  const summary: WeeklySummary = {
    timestamp,
    durationMs: Date.now() - startTime,
    reviewPath,
    goalAlignment,
    staleTasks,
    habits,
    dryRun,
  };

  db.close();
  return summary;
}

async function generateAndSaveReview(
  db: ReturnType<typeof getTaskDB>,
  today: string,
  dryRun: boolean,
  state: AutomationState
): Promise<string | null> {
  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const startDate = weekAgo.toISOString().split("T")[0];
  const endDate = today;

  // Gather review data
  const allCompleted = db.listTasks({ status: "done", limit: 500 });
  const completedThisWeek = allCompleted.filter(
    (t) => t.completed_at && t.completed_at >= weekAgo.toISOString()
  );

  const allTasks = db.listTasks({ limit: 1000 });
  const addedThisWeek = allTasks.filter(
    (t) => t.created_at && t.created_at >= weekAgo.toISOString()
  );

  const overdueTasks = db.getOverdueTasks();
  const stats = db.getStats();

  let activeGoals: Array<{ id: string; title: string; status: string }> = [];
  try {
    const { loadTelosData } = await import("./TelosGoalLoader.ts");
    const telosData = loadTelosData();
    activeGoals = telosData.goals
      .filter((g) => g.status === "In Progress")
      .map((g) => ({ id: g.id, title: g.title, status: g.status }));
  } catch {
    // TELOS unavailable
  }

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
      due_date: t.due_date ?? "",
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

  let reviewContent: string;
  let reviewObject: WeeklyReview | null = null;

  try {
    const { generateWeeklyReview, formatWeeklyReview } = await import("./TaskAI.ts");
    reviewObject = await generateWeeklyReview(reviewData);

    if (reviewObject) {
      reviewContent = formatWeeklyReview(reviewObject);
    } else {
      // AI failed — generate stats-only fallback
      reviewContent = generateStatsOnlyReview(reviewData);
      console.warn("Warning: TaskAI unavailable, generating stats-only review");
    }
  } catch {
    // TaskAI import failed entirely
    reviewContent = generateStatsOnlyReview(reviewData);
    console.warn("Warning: TaskAI unavailable, generating stats-only review");
  }

  // Save review to disk
  if (!dryRun) {
    ensureDir(REVIEWS_DIR);
    const reviewFile = join(REVIEWS_DIR, `review-${today}.md`);
    const header = `# LucidTasks Weekly Review — ${today}\n\nGenerated: ${new Date().toISOString()}\n\n`;
    writeFileSync(reviewFile, header + reviewContent, "utf-8");
    state.stats.totalReviewsGenerated++;
    return reviewFile;
  }

  return null;
}

function generateStatsOnlyReview(data: ReviewData): string {
  const lines: string[] = [
    `## Weekly Review: ${data.period.start} to ${data.period.end}`,
    "",
    "### Summary (Stats Only — AI Unavailable)",
    `- Completed: ${data.stats.completedThisWeek} tasks`,
    `- Added: ${data.addedTasks.length} tasks`,
    `- Overdue: ${data.stats.overdue} tasks`,
    `- Total in system: ${data.stats.total} tasks`,
    "",
    "### Status Breakdown",
  ];

  for (const [status, count] of Object.entries(data.stats.byStatus)) {
    lines.push(`- ${status}: ${count}`);
  }

  if (data.activeGoals.length > 0) {
    lines.push("", "### Active Goals");
    for (const goal of data.activeGoals) {
      const completed = data.completedTasks.filter((t) => t.goal_id === goal.id).length;
      lines.push(`- ${goal.id} ${goal.title}: ${completed} tasks completed this week`);
    }
  }

  return lines.join("\n");
}

function buildGoalAlignmentReport(
  db: ReturnType<typeof getTaskDB>,
  today: string
): GoalAlignmentEntry[] {
  const rawDb = db.getRawDb();
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const twoWeeksAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();

  // Get all active goal IDs from tasks
  const goalIds = rawDb
    .prepare(
      `SELECT DISTINCT goal_id FROM tasks
       WHERE goal_id IS NOT NULL AND status NOT IN ('done', 'cancelled')`
    )
    .all() as { goal_id: string }[];

  const entries: GoalAlignmentEntry[] = [];

  for (const { goal_id } of goalIds) {
    // Tasks completed this week for this goal
    const thisWeek = (
      rawDb
        .prepare(
          `SELECT COUNT(*) as count FROM tasks
           WHERE goal_id = $goal_id AND status = 'done'
             AND completed_at >= $week_ago`
        )
        .get({ $goal_id: goal_id, $week_ago: weekAgo }) as { count: number }
    ).count;

    // Tasks completed last week for this goal
    const lastWeek = (
      rawDb
        .prepare(
          `SELECT COUNT(*) as count FROM tasks
           WHERE goal_id = $goal_id AND status = 'done'
             AND completed_at >= $two_weeks_ago AND completed_at < $week_ago`
        )
        .get({ $goal_id: goal_id, $two_weeks_ago: twoWeeksAgo, $week_ago: weekAgo }) as { count: number }
    ).count;

    // Remaining active tasks for this goal
    const remaining = (
      rawDb
        .prepare(
          `SELECT COUNT(*) as count FROM tasks
           WHERE goal_id = $goal_id AND status NOT IN ('done', 'cancelled')`
        )
        .get({ $goal_id: goal_id }) as { count: number }
    ).count;

    let velocity: GoalAlignmentEntry["velocity"];
    if (thisWeek > lastWeek) {
      velocity = "increasing";
    } else if (thisWeek < lastWeek) {
      velocity = "declining";
    } else {
      velocity = "stable";
    }

    entries.push({
      goalId: goal_id,
      completedThisWeek: thisWeek,
      completedLastWeek: lastWeek,
      remaining,
      velocity,
    });
  }

  // Sort: declining first (needs attention), then by thisWeek desc
  entries.sort((a, b) => {
    if (a.velocity === "declining" && b.velocity !== "declining") return -1;
    if (b.velocity === "declining" && a.velocity !== "declining") return 1;
    return b.completedThisWeek - a.completedThisWeek;
  });

  return entries;
}

function detectStaleTasks(db: ReturnType<typeof getTaskDB>): WeeklySummary["staleTasks"] {
  const rawDb = db.getRawDb();
  const cutoff = new Date(Date.now() - STALE_TASK_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const staleNext = (
    rawDb
      .prepare(
        `SELECT COUNT(*) as count FROM tasks
         WHERE status = 'next' AND updated_at <= $cutoff`
      )
      .get({ $cutoff: cutoff }) as { count: number }
  ).count;

  const staleSomeday = (
    rawDb
      .prepare(
        `SELECT COUNT(*) as count FROM tasks
         WHERE status = 'someday' AND updated_at <= $cutoff`
      )
      .get({ $cutoff: cutoff }) as { count: number }
  ).count;

  return { next: staleNext, someday: staleSomeday };
}

function buildHabitReport(db: ReturnType<typeof getTaskDB>): HabitSummaryEntry[] {
  const allHabitStats = db.getAllHabitStats(30);

  if (allHabitStats.length === 0) return [];

  // Sort by current streak descending
  allHabitStats.sort((a, b) => b.currentStreak - a.currentStreak);

  const today = new Date().toISOString().split("T")[0];
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];

  return allHabitStats.map((stats) => {
    // A streak is "broken this week" if currentStreak = 0 and there were completions last week
    const hadCompletionsLastWeek = stats.completionDates.some(
      (d) => d >= weekAgo && d <= today
    );
    const brokenThisWeek = stats.currentStreak === 0 && hadCompletionsLastWeek;

    return {
      taskId: stats.taskId,
      taskTitle: stats.taskTitle,
      currentStreak: stats.currentStreak,
      brokenThisWeek,
    };
  });
}

// ============================================================================
// Summary Formatting
// ============================================================================

export function formatMorningSummary(summary: MorningSummary): string {
  const date = new Date(summary.timestamp);
  const timeStr = `${date.toISOString().split("T")[0]} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  const prefix = summary.dryRun ? "[DRY RUN] " : "";

  const lines: string[] = [
    `${prefix}LucidTasks Morning Maintenance (${timeStr})`,
    "",
  ];

  // Recurring
  const recurDesc = summary.recurring.generated > 0
    ? `${summary.recurring.generated} generated (${summary.recurring.titles.slice(0, 3).join(", ")}${summary.recurring.titles.length > 3 ? ", ..." : ""})`
    : "0 generated";
  lines.push(`Recurring:    ${recurDesc}`);

  // Overdue
  let overdueDesc: string;
  if (summary.overdue.autopilotOff) {
    overdueDesc = `${summary.overdue.count} task${summary.overdue.count !== 1 ? "s" : ""} overdue (autopilot off — no action taken)`;
  } else {
    overdueDesc = summary.overdue.rescheduled > 0
      ? `${summary.overdue.rescheduled} task${summary.overdue.rescheduled !== 1 ? "s" : ""} rescheduled to today`
      : "none overdue";
  }
  lines.push(`Overdue:      ${overdueDesc}`);

  // Inbox
  let inboxDesc: string;
  if (summary.inbox.needsAttention) {
    inboxDesc = `${summary.inbox.count} items — Inbox needs attention`;
    if (summary.inbox.extracted > 0) {
      inboxDesc += ` (${summary.inbox.extracted} auto-extracted)`;
    }
  } else {
    inboxDesc = `${summary.inbox.count} item${summary.inbox.count !== 1 ? "s" : ""} (below threshold, no action needed)`;
  }
  lines.push(`Inbox:        ${inboxDesc}`);

  // Prioritize
  const prioritizeDesc = summary.prioritized.skipped
    ? "Skipped (autopilot off)"
    : `${summary.prioritized.count} task${summary.prioritized.count !== 1 ? "s" : ""} re-scored`;
  lines.push(`Prioritize:   ${prioritizeDesc}`);

  lines.push("");
  lines.push(`Duration: ${(summary.durationMs / 1000).toFixed(1)}s`);

  return lines.join("\n");
}

export function formatEveningSummary(summary: EveningSummary): string {
  const date = new Date(summary.timestamp);
  const timeStr = `${date.toISOString().split("T")[0]} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  const prefix = summary.dryRun ? "[DRY RUN] " : "";

  const lines: string[] = [
    `${prefix}LucidTasks Evening Maintenance (${timeStr})`,
    "",
  ];

  // Stale in-progress
  if (summary.staleInProgress.length === 0) {
    lines.push("Stale:        No stale in-progress tasks");
  } else {
    const staleDesc = summary.staleInProgress
      .slice(0, 3)
      .map((t) => `"${t.title}" (started ${t.startedHoursAgo}h ago)`)
      .join(", ");
    const moreCount = summary.staleInProgress.length - 3;
    lines.push(`Stale:        ${summary.staleInProgress.length} in-progress: ${staleDesc}${moreCount > 0 ? `, +${moreCount} more` : ""}`);
  }

  // Tomorrow
  lines.push(`Tomorrow:     ${summary.tomorrow.dueCount} task${summary.tomorrow.dueCount !== 1 ? "s" : ""} due, ${summary.tomorrow.scheduledCount} task${summary.tomorrow.scheduledCount !== 1 ? "s" : ""} scheduled`);

  // Stats
  const { stats } = summary;
  lines.push(`Stats:        ${stats.completed} completed, ${stats.added} added, ${stats.overdue} overdue today`);

  lines.push("");
  lines.push(`Duration: ${(summary.durationMs / 1000).toFixed(1)}s`);

  return lines.join("\n");
}

export function formatWeeklySummary(summary: WeeklySummary): string {
  const date = new Date(summary.timestamp);
  const timeStr = `${date.toISOString().split("T")[0]} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  const prefix = summary.dryRun ? "[DRY RUN] " : "";

  const lines: string[] = [
    `${prefix}LucidTasks Weekly Review (${timeStr})`,
    "",
  ];

  // Review path
  if (summary.reviewPath) {
    lines.push(`Review saved: ${summary.reviewPath}`);
  } else if (summary.dryRun) {
    lines.push("Review saved: (skipped in dry-run mode)");
  } else {
    lines.push("Review:       (AI review generation failed, stats-only saved)");
  }
  lines.push("");

  // Goal alignment
  if (summary.goalAlignment.length === 0) {
    lines.push("Goals:        No active goals with tasks");
  } else {
    lines.push("Goal Progress:");
    for (const g of summary.goalAlignment) {
      const velocityIcon = g.velocity === "increasing" ? "^" : g.velocity === "declining" ? "v" : "-";
      const note = g.velocity === "declining" && g.completedThisWeek === 0
        ? ` (was ${g.completedLastWeek} last week)`
        : "";
      lines.push(`  ${g.goalId.padEnd(10)} ${g.completedThisWeek} completed, ${g.remaining} remaining  ${velocityIcon} ${g.velocity}${note}`);
    }
    lines.push("");
  }

  // Stale tasks
  const { staleTasks } = summary;
  if (staleTasks.next > 0 || staleTasks.someday > 0) {
    lines.push(`Stale Tasks:  ${staleTasks.next} next (>30d), ${staleTasks.someday} someday (>30d)`);
  } else {
    lines.push("Stale Tasks:  None (all tasks updated within 30 days)");
  }

  // Habits
  if (summary.habits.length > 0) {
    const top3 = summary.habits.filter((h) => h.currentStreak > 0).slice(0, 3);
    const broken = summary.habits.filter((h) => h.brokenThisWeek);

    if (top3.length > 0 || broken.length > 0) {
      const habitParts: string[] = [];
      for (const h of top3) {
        habitParts.push(`"${h.taskTitle}" ${h.currentStreak}-day streak`);
      }
      for (const h of broken) {
        habitParts.push(`"${h.taskTitle}" broken`);
      }
      lines.push(`Habits:       ${habitParts.join(", ")}`);
    }
  } else {
    lines.push("Habits:       No habit data recorded");
  }

  lines.push("");
  lines.push(`Duration: ${(summary.durationMs / 1000).toFixed(1)}s`);

  return lines.join("\n");
}

// ============================================================================
// Status Command
// ============================================================================

function showStatus(): void {
  const state = loadState();

  console.log(`
LucidTasks Automation Status
=============================

Last morning run:    ${state.lastMorningRun ?? "never"}
Last evening run:    ${state.lastEveningRun ?? "never"}
Last weekly run:     ${state.lastWeeklyRun ?? "never"}
Last recurrence check: ${state.lastRecurrenceCheck ?? "never"}

Lifetime Stats:
  Recurrences generated: ${state.stats.totalRecurrencesGenerated}
  Auto-rescheduled:      ${state.stats.totalAutoRescheduled}
  Auto-extracted:        ${state.stats.totalAutoExtracted}
  Reviews generated:     ${state.stats.totalReviewsGenerated}

Config:
  State file:   ${AUTOMATION_STATE_PATH}
  Stats file:   ${DAILY_STATS_PATH}
  Reviews dir:  ${REVIEWS_DIR}
`);
}

// ============================================================================
// Notification Delivery
// ============================================================================

async function sendNotification(text: string): Promise<void> {
  try {
    const { notifySync } = await import("../../../../lib/core/NotificationService.ts");
    notifySync(text.slice(0, 500)); // Keep notification concise
  } catch {
    // NotificationService unavailable — skip silently
  }
}

// ============================================================================
// CLI Entry Point
// ============================================================================

if (import.meta.main) {
  const args = process.argv.slice(2);
  const command = args[0];
  const dryRun = args.includes("--dry-run");
  const jsonOutput = args.includes("--json");

  switch (command) {
    case "morning": {
      const summary = await runMorning({ dryRun });
      if (jsonOutput) {
        console.log(JSON.stringify(summary, null, 2));
      } else {
        const text = formatMorningSummary(summary);
        console.log(text);
        if (!dryRun) {
          await sendNotification(text);
        }
      }
      break;
    }

    case "evening": {
      const summary = await runEvening({ dryRun });
      if (jsonOutput) {
        console.log(JSON.stringify(summary, null, 2));
      } else {
        const text = formatEveningSummary(summary);
        console.log(text);
        if (!dryRun) {
          await sendNotification(text);
        }
      }
      break;
    }

    case "weekly": {
      const summary = await runWeekly({ dryRun });
      if (jsonOutput) {
        console.log(JSON.stringify(summary, null, 2));
      } else {
        const text = formatWeeklySummary(summary);
        console.log(text);
        if (!dryRun) {
          await sendNotification(text);
        }
      }
      break;
    }

    case "status": {
      showStatus();
      break;
    }

    default: {
      console.log(`
LucidTasks Automation Runner

Usage:
  bun TaskAutomation.ts morning [--dry-run] [--json]   Daily 8 AM maintenance
  bun TaskAutomation.ts evening [--dry-run] [--json]   Daily 9 PM maintenance
  bun TaskAutomation.ts weekly  [--dry-run] [--json]   Weekly Sunday 10 AM review
  bun TaskAutomation.ts status                          Show last run times and stats

Options:
  --dry-run    Show what would happen without executing
  --json       Output results as JSON
`);
      break;
    }
  }
}
