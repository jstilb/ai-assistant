#!/usr/bin/env bun
/**
 * TaskDB.ts - SQLite Database Layer for LucidTasks
 *
 * Provides all data access for the LucidTasks system using bun:sqlite.
 * Handles schema creation, CRUD operations, full-text search, and statistics.
 *
 * Database: skills/LucidTasks/Data/lucidtasks.db
 * Mode: WAL (Write-Ahead Logging) for concurrent access safety
 *
 * @module TaskDB
 */

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { z } from "zod";
import { getMissionForGoal } from "./TelosGoalLoader.ts";

// ============================================================================
// Configuration
// ============================================================================

const KAYA_HOME = process.env.KAYA_HOME || join(process.env.HOME || "", ".claude");
const DB_PATH = join(KAYA_HOME, "skills/LucidTasks/Data/lucidtasks.db");

// ============================================================================
// Types & Schemas
// ============================================================================

export const TaskStatus = z.enum([
  "inbox",
  "next",
  "in_progress",
  "waiting",
  "someday",
  "done",
  "cancelled",
]);
export type TaskStatus = z.infer<typeof TaskStatus>;

export const ProjectStatus = z.enum(["active", "paused", "completed", "archived"]);
export type ProjectStatus = z.infer<typeof ProjectStatus>;

export const EnergyLevel = z.enum(["low", "medium", "high"]);
export type EnergyLevel = z.infer<typeof EnergyLevel>;

export const TaskSchema = z.object({
  id: z.string(),
  title: z.string().min(1),
  description: z.string().default(""),
  status: TaskStatus.default("inbox"),
  priority: z.number().int().min(1).max(3).default(2),
  energy_level: EnergyLevel.nullable().default(null),
  estimated_minutes: z.number().int().positive().nullable().default(null),
  due_date: z.string().nullable().default(null),
  scheduled_date: z.string().nullable().default(null),
  project_id: z.string().nullable().default(null),
  goal_id: z.string().nullable().default(null),
  mission_id: z.string().nullable().default(null),
  parent_task_id: z.string().nullable().default(null),
  context_tags: z.string().default("[]"),
  labels: z.string().default("[]"),
  ai_priority_score: z.number().nullable().default(null),
  ai_reasoning: z.string().nullable().default(null),
  recurrence_rule: z.string().nullable().default(null),
  raw_input: z.string().nullable().default(null),
  asana_gid: z.string().nullable().default(null),
  queue_item_id: z.string().nullable().default(null),
  created_at: z.string(),
  updated_at: z.string(),
  completed_at: z.string().nullable().default(null),
  started_at: z.string().nullable().default(null),
});
export type Task = z.infer<typeof TaskSchema>;

export const ProjectSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  description: z.string().default(""),
  status: ProjectStatus.default("active"),
  goal_id: z.string().nullable().default(null),
  color: z.string().nullable().default(null),
  sort_order: z.number().int().default(0),
  asana_project_gid: z.string().nullable().default(null),
  created_at: z.string(),
  updated_at: z.string(),
});
export type Project = z.infer<typeof ProjectSchema>;

export interface ActivityLogEntry {
  id?: number;
  task_id: string;
  action: string;
  changes: string | null;
  ai_reasoning: string | null;
  actor: string;
  created_at: string;
}

export interface TaskFilter {
  status?: TaskStatus | TaskStatus[];
  project_id?: string;
  goal_id?: string;
  due_before?: string;
  scheduled_date?: string;
  parent_task_id?: string | null;
  limit?: number;
  offset?: number;
}

export interface TaskStats {
  total: number;
  byStatus: Record<string, number>;
  byProject: Record<string, { name: string; count: number }>;
  byGoal: Record<string, number>;
  overdue: number;
  dueToday: number;
  completedThisWeek: number;
}

export interface HabitStats {
  taskId: string;
  taskTitle: string;
  totalCompletions: number;
  currentStreak: number;
  longestStreak: number;
  completionRate: number; // percentage, 0-100
  completionDates: string[]; // ISO date strings
}

export interface SavedView {
  id: string;
  name: string;
  filter: TaskFilter;
  sort?: { field: string; direction: "asc" | "desc" };
  isDefault: boolean;
  createdAt: string;
}

export interface EnhancedTaskStats extends TaskStats {
  velocity: { week: string; count: number }[];
  averageVelocity: number;
  averageDurationMinutes: number;
  tasksWithDuration: number;
  goalProgress: Record<string, { completed: number; total: number; percentage: number }>;
  energyDistribution: { high: number; medium: number; low: number; unset: number };
  overdueBreakdown: { range: string; count: number }[];
}

// Day letter mapping for custom recurrence rules
export const DAY_LETTERS: Record<string, number> = {
  U: 0, // Sunday
  M: 1, // Monday
  T: 2, // Tuesday
  W: 3, // Wednesday
  R: 4, // Thursday
  F: 5, // Friday
  S: 6, // Saturday
};

// ============================================================================
// ID Generation
// ============================================================================

export function generateTaskId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 7);
  return `t-${ts}-${rand}`;
}

export function generateProjectId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 7);
  return `p-${ts}-${rand}`;
}

export function generateViewId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 7);
  return `v-${ts}-${rand}`;
}

// ============================================================================
// Recurrence
// ============================================================================

export function calculateNextDueDate(currentDue: string | null, rule: string): string {
  const base = currentDue ? new Date(currentDue + "T00:00:00") : new Date();

  switch (rule) {
    case "daily":
      base.setDate(base.getDate() + 1);
      break;

    case "weekly":
      base.setDate(base.getDate() + 7);
      break;

    case "weekdays": {
      do {
        base.setDate(base.getDate() + 1);
      } while (base.getDay() === 0 || base.getDay() === 6);
      break;
    }

    case "monthly": {
      const targetDay = base.getDate();
      base.setMonth(base.getMonth() + 1);
      // Clamp to last day of month if needed
      if (base.getDate() !== targetDay) {
        base.setDate(0); // Last day of previous month
      }
      break;
    }

    default: {
      // Handle custom:MWF pattern
      const customMatch = rule.match(/^custom:([MTWRFSU]+)$/i);
      if (customMatch) {
        const letters = customMatch[1].toUpperCase().split("");
        const allowedDays = letters
          .map((l) => DAY_LETTERS[l])
          .filter((d): d is number => d !== undefined);
        if (allowedDays.length > 0) {
          do {
            base.setDate(base.getDate() + 1);
          } while (!allowedDays.includes(base.getDay()));
        } else {
          // Invalid letters -- fall back to weekly
          base.setDate(base.getDate() + 7);
        }
      } else {
        // Unknown rule -- fall back to weekly
        base.setDate(base.getDate() + 7);
      }
      break;
    }
  }

  return base.toISOString().split("T")[0];
}

// ============================================================================
// Database Class
// ============================================================================

export class TaskDB {
  private db: Database;

  constructor(dbPath: string = DB_PATH) {
    // Ensure data directory exists
    const dir = dirname(dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(dbPath);
    this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec("PRAGMA foreign_keys=ON");
    this.initSchema();
  }

  // --------------------------------------------------------------------------
  // Schema Initialization
  // --------------------------------------------------------------------------

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT DEFAULT '',
        status TEXT DEFAULT 'active' CHECK(status IN ('active','paused','completed','archived')),
        goal_id TEXT,
        color TEXT,
        sort_order INTEGER DEFAULT 0,
        asana_project_gid TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT DEFAULT '',
        status TEXT NOT NULL DEFAULT 'inbox'
          CHECK(status IN ('inbox','next','in_progress','waiting','someday','done','cancelled')),
        priority INTEGER DEFAULT 2 CHECK(priority BETWEEN 1 AND 3),
        energy_level TEXT CHECK(energy_level IN ('low','medium','high') OR energy_level IS NULL),
        estimated_minutes INTEGER,
        due_date TEXT,
        scheduled_date TEXT,
        project_id TEXT REFERENCES projects(id),
        goal_id TEXT,
        mission_id TEXT,
        parent_task_id TEXT REFERENCES tasks(id),
        context_tags TEXT DEFAULT '[]',
        labels TEXT DEFAULT '[]',
        ai_priority_score REAL,
        ai_reasoning TEXT,
        recurrence_rule TEXT,
        raw_input TEXT,
        asana_gid TEXT,
        queue_item_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        completed_at TEXT,
        started_at TEXT
      );

      CREATE TABLE IF NOT EXISTS activity_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        action TEXT NOT NULL,
        changes TEXT,
        ai_reasoning TEXT,
        actor TEXT NOT NULL DEFAULT 'user',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS habit_completions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL REFERENCES tasks(id),
        completed_date TEXT NOT NULL,
        notes TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(task_id, completed_date)
      );

      CREATE TABLE IF NOT EXISTS saved_views (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        filter_json TEXT NOT NULL,
        sort_json TEXT,
        is_default INTEGER DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);

    // Create indices
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
      CREATE INDEX IF NOT EXISTS idx_tasks_project_id ON tasks(project_id);
      CREATE INDEX IF NOT EXISTS idx_tasks_goal_id ON tasks(goal_id);
      CREATE INDEX IF NOT EXISTS idx_tasks_due_date ON tasks(due_date);
      CREATE INDEX IF NOT EXISTS idx_tasks_scheduled_date ON tasks(scheduled_date);
      CREATE INDEX IF NOT EXISTS idx_tasks_parent_task_id ON tasks(parent_task_id);
      CREATE INDEX IF NOT EXISTS idx_tasks_asana_gid ON tasks(asana_gid);
      CREATE INDEX IF NOT EXISTS idx_activity_task_id ON activity_log(task_id);
    `);

    // Schema migrations for existing databases
    try {
      this.db.exec("ALTER TABLE tasks ADD COLUMN started_at TEXT");
    } catch {
      // Column already exists, ignore
    }

    // Full-text search virtual table
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS tasks_fts USING fts5(
        title,
        description,
        content='tasks',
        content_rowid='rowid'
      );
    `);

    // Triggers to keep FTS in sync
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS tasks_ai AFTER INSERT ON tasks BEGIN
        INSERT INTO tasks_fts(rowid, title, description)
        VALUES (new.rowid, new.title, new.description);
      END;

      CREATE TRIGGER IF NOT EXISTS tasks_ad AFTER DELETE ON tasks BEGIN
        INSERT INTO tasks_fts(tasks_fts, rowid, title, description)
        VALUES ('delete', old.rowid, old.title, old.description);
      END;

      CREATE TRIGGER IF NOT EXISTS tasks_au AFTER UPDATE ON tasks BEGIN
        INSERT INTO tasks_fts(tasks_fts, rowid, title, description)
        VALUES ('delete', old.rowid, old.title, old.description);
        INSERT INTO tasks_fts(rowid, title, description)
        VALUES (new.rowid, new.title, new.description);
      END;
    `);
  }

  // --------------------------------------------------------------------------
  // Task CRUD
  // --------------------------------------------------------------------------

  createTask(input: {
    title: string;
    description?: string;
    status?: TaskStatus;
    priority?: number;
    energy_level?: EnergyLevel | null;
    estimated_minutes?: number | null;
    due_date?: string | null;
    scheduled_date?: string | null;
    project_id?: string | null;
    goal_id?: string | null;
    mission_id?: string | null;
    parent_task_id?: string | null;
    context_tags?: string[];
    labels?: string[];
    raw_input?: string | null;
    asana_gid?: string | null;
    recurrence_rule?: string | null;
    started_at?: string | null;
    id?: string;
  }): Task {
    const id = input.id || generateTaskId();
    const now = new Date().toISOString();

    // Auto-populate mission_id from goal_id if not provided
    let missionId = input.mission_id || null;
    if (input.goal_id && !missionId) {
      try {
        const mission = getMissionForGoal(input.goal_id);
        if (mission) {
          missionId = mission.id;
        }
      } catch {
        console.error(`Warning: TELOS not available, mission_id not auto-populated for goal ${input.goal_id}`);
      }
    }

    const stmt = this.db.prepare(`
      INSERT INTO tasks (
        id, title, description, status, priority, energy_level,
        estimated_minutes, due_date, scheduled_date, project_id,
        goal_id, mission_id, parent_task_id, context_tags, labels,
        raw_input, asana_gid, recurrence_rule, started_at, created_at, updated_at
      ) VALUES (
        $id, $title, $description, $status, $priority, $energy_level,
        $estimated_minutes, $due_date, $scheduled_date, $project_id,
        $goal_id, $mission_id, $parent_task_id, $context_tags, $labels,
        $raw_input, $asana_gid, $recurrence_rule, $started_at, $created_at, $updated_at
      )
    `);

    stmt.run({
      $id: id,
      $title: input.title,
      $description: input.description || "",
      $status: input.status || "inbox",
      $priority: input.priority || 2,
      $energy_level: input.energy_level || null,
      $estimated_minutes: input.estimated_minutes || null,
      $due_date: input.due_date || null,
      $scheduled_date: input.scheduled_date || null,
      $project_id: input.project_id || null,
      $goal_id: input.goal_id || null,
      $mission_id: missionId,
      $parent_task_id: input.parent_task_id || null,
      $context_tags: JSON.stringify(input.context_tags || []),
      $labels: JSON.stringify(input.labels || []),
      $raw_input: input.raw_input || null,
      $asana_gid: input.asana_gid || null,
      $recurrence_rule: input.recurrence_rule || null,
      $started_at: input.started_at || null,
      $created_at: now,
      $updated_at: now,
    });

    // Log creation
    this.logActivity(id, "created", null, "user");

    return this.getTask(id)!;
  }

  getTask(id: string): Task | null {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as Task | null;
    return row;
  }

  updateTask(
    id: string,
    updates: Partial<Omit<Task, "id" | "created_at">>,
    actor: string = "user"
  ): Task | null {
    const existing = this.getTask(id);
    if (!existing) return null;

    const now = new Date().toISOString();
    const changes: Record<string, { from: unknown; to: unknown }> = {};

    // Build SET clause dynamically
    const setClauses: string[] = ["updated_at = $updated_at"];
    const params: Record<string, unknown> = {
      $updated_at: now,
      $id: id,
    };

    for (const [key, value] of Object.entries(updates)) {
      if (key === "id" || key === "created_at") continue;
      if (value === undefined) continue;

      const oldVal = (existing as Record<string, unknown>)[key];
      if (oldVal !== value) {
        changes[key] = { from: oldVal, to: value };
      }

      setClauses.push(`${key} = $${key}`);
      params[`$${key}`] = value;
    }

    // Handle completion timestamp
    if (updates.status === "done" && !existing.completed_at) {
      setClauses.push("completed_at = $completed_at");
      params.$completed_at = now;
      changes.completed_at = { from: null, to: now };
    }

    // Auto-set started_at when status changes to in_progress (only if not already set)
    if (updates.status === "in_progress" && !existing.started_at && !updates.started_at) {
      setClauses.push("started_at = $started_at");
      params.$started_at = now;
      changes.started_at = { from: null, to: now };
    }

    // Auto-populate mission_id when goal_id changes and mission_id is not being set
    if (updates.goal_id && updates.goal_id !== existing.goal_id && !updates.mission_id && !existing.mission_id) {
      try {
        const mission = getMissionForGoal(updates.goal_id);
        if (mission) {
          setClauses.push("mission_id = $mission_id");
          params.$mission_id = mission.id;
          changes.mission_id = { from: existing.mission_id, to: mission.id };
        }
      } catch {
        console.error(`Warning: TELOS not available, mission_id not auto-populated for goal ${updates.goal_id}`);
      }
    }

    if (setClauses.length <= 1) return existing; // Nothing changed besides updated_at

    const sql = `UPDATE tasks SET ${setClauses.join(", ")} WHERE id = $id`;

    // Wrap in transaction when completing a recurring task (atomicity)
    const isCompletingRecurring = updates.status === "done" && !existing.completed_at && existing.recurrence_rule;

    if (isCompletingRecurring) {
      const transaction = this.db.transaction(() => {
        this.db.prepare(sql).run(params);

        // Log the update
        if (Object.keys(changes).length > 0) {
          const action = "completed";
          this.logActivity(id, action, JSON.stringify(changes), actor);
        }

        // Get the freshly updated task to pass to recurrence
        const completedTask = this.getTask(id);
        if (completedTask && completedTask.recurrence_rule) {
          this.createRecurrenceInstance(completedTask);
        }
      });
      transaction();
    } else {
      this.db.prepare(sql).run(params);

      // Log the update
      if (Object.keys(changes).length > 0) {
        const action = updates.status === "done" ? "completed" : "updated";
        this.logActivity(id, action, JSON.stringify(changes), actor);
      }
    }

    return this.getTask(id);
  }

  /**
   * Create the next instance of a recurring task after completion.
   * Records a habit_completion entry and creates a new task with calculated due date.
   */
  private createRecurrenceInstance(completedTask: Task): Task {
    const rule = completedTask.recurrence_rule!;
    const nextDueDate = calculateNextDueDate(completedTask.due_date, rule);

    // Record habit completion
    const today = new Date().toISOString().split("T")[0];
    try {
      this.db
        .prepare(
          "INSERT OR IGNORE INTO habit_completions (task_id, completed_date) VALUES ($task_id, $completed_date)"
        )
        .run({ $task_id: completedTask.id, $completed_date: today });
    } catch (err) {
      console.error(`Warning: failed to record habit completion: ${err instanceof Error ? err.message : err}`);
    }

    // Create the next task instance
    const newTaskId = generateTaskId();
    const now = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO tasks (
          id, title, description, status, priority, energy_level,
          estimated_minutes, due_date, project_id, goal_id, mission_id,
          context_tags, labels, recurrence_rule, created_at, updated_at
        ) VALUES (
          $id, $title, $description, $status, $priority, $energy_level,
          $estimated_minutes, $due_date, $project_id, $goal_id, $mission_id,
          $context_tags, $labels, $recurrence_rule, $created_at, $updated_at
        )`
      )
      .run({
        $id: newTaskId,
        $title: completedTask.title,
        $description: completedTask.description,
        $status: "inbox",
        $priority: completedTask.priority,
        $energy_level: completedTask.energy_level,
        $estimated_minutes: completedTask.estimated_minutes,
        $due_date: nextDueDate,
        $project_id: completedTask.project_id,
        $goal_id: completedTask.goal_id,
        $mission_id: completedTask.mission_id,
        $context_tags: completedTask.context_tags,
        $labels: completedTask.labels,
        $recurrence_rule: rule,
        $created_at: now,
        $updated_at: now,
      });

    this.logActivity(newTaskId, "recurrence_created", JSON.stringify({ from_task: completedTask.id, rule }), "system");

    return this.getTask(newTaskId)!;
  }

  /**
   * Set AI priority score and reasoning on a task.
   * Provides a clean API for future AI scoring algorithm (Phase 3).
   */
  setAIPriority(taskId: string, score: number, reasoning: string): Task | null {
    return this.updateTask(taskId, { ai_priority_score: score, ai_reasoning: reasoning }, "ai");
  }

  /**
   * Set the started_at timestamp for a task (used by cmdNext --start)
   */
  setStartedAt(id: string, timestamp: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare("UPDATE tasks SET started_at = $ts, updated_at = $now WHERE id = $id")
      .run({ $ts: timestamp, $now: now, $id: id });
  }

  deleteTask(id: string): boolean {
    const result = this.db.prepare("DELETE FROM tasks WHERE id = ?").run(id);
    if (result.changes > 0) {
      this.logActivity(id, "deleted", null, "user");
      return true;
    }
    return false;
  }

  // --------------------------------------------------------------------------
  // Task Queries
  // --------------------------------------------------------------------------

  listTasks(filter: TaskFilter = {}): Task[] {
    const conditions: string[] = [];
    const params: Record<string, unknown> = {};

    if (filter.status) {
      if (Array.isArray(filter.status)) {
        const placeholders = filter.status.map((_, i) => `$status_${i}`);
        conditions.push(`status IN (${placeholders.join(", ")})`);
        filter.status.forEach((s, i) => {
          params[`$status_${i}`] = s;
        });
      } else {
        conditions.push("status = $status");
        params.$status = filter.status;
      }
    }

    if (filter.project_id) {
      conditions.push("project_id = $project_id");
      params.$project_id = filter.project_id;
    }

    if (filter.goal_id) {
      conditions.push("goal_id = $goal_id");
      params.$goal_id = filter.goal_id;
    }

    if (filter.due_before) {
      conditions.push("due_date IS NOT NULL AND due_date <= $due_before");
      params.$due_before = filter.due_before;
    }

    if (filter.scheduled_date) {
      conditions.push("scheduled_date = $scheduled_date");
      params.$scheduled_date = filter.scheduled_date;
    }

    if (filter.parent_task_id !== undefined) {
      if (filter.parent_task_id === null) {
        conditions.push("parent_task_id IS NULL");
      } else {
        conditions.push("parent_task_id = $parent_task_id");
        params.$parent_task_id = filter.parent_task_id;
      }
    }

    let sql = "SELECT * FROM tasks";
    if (conditions.length > 0) {
      sql += ` WHERE ${conditions.join(" AND ")}`;
    }
    sql += " ORDER BY priority ASC, due_date ASC NULLS LAST, created_at DESC";

    if (filter.limit) {
      sql += ` LIMIT ${filter.limit}`;
    }
    if (filter.offset) {
      sql += ` OFFSET ${filter.offset}`;
    }

    return this.db.prepare(sql).all(params) as Task[];
  }

  /**
   * Get today's tasks: next + in_progress, optionally including those scheduled for today
   */
  getTodayTasks(): Task[] {
    const today = new Date().toISOString().split("T")[0];
    return this.db
      .prepare(
        `SELECT * FROM tasks
         WHERE (status IN ('next', 'in_progress'))
            OR (scheduled_date = $today AND status NOT IN ('done', 'cancelled'))
         ORDER BY priority ASC, due_date ASC NULLS LAST`
      )
      .all({ $today: today }) as Task[];
  }

  /**
   * Get inbox items (status = 'inbox')
   */
  getInboxTasks(): Task[] {
    return this.db
      .prepare("SELECT * FROM tasks WHERE status = 'inbox' ORDER BY created_at DESC")
      .all() as Task[];
  }

  /**
   * Get overdue tasks
   */
  getOverdueTasks(): Task[] {
    const today = new Date().toISOString().split("T")[0];
    return this.db
      .prepare(
        `SELECT * FROM tasks
         WHERE due_date IS NOT NULL
           AND due_date < $today
           AND status NOT IN ('done', 'cancelled')
         ORDER BY due_date ASC`
      )
      .all({ $today: today }) as Task[];
  }

  /**
   * Full-text search on tasks
   */
  searchTasks(query: string, limit: number = 50): Task[] {
    // Use FTS5 match syntax
    const ftsQuery = query
      .split(/\s+/)
      .map((term) => `"${term}"`)
      .join(" OR ");

    return this.db
      .prepare(
        `SELECT tasks.* FROM tasks
         JOIN tasks_fts ON tasks.rowid = tasks_fts.rowid
         WHERE tasks_fts MATCH $query
         ORDER BY rank
         LIMIT $limit`
      )
      .all({ $query: ftsQuery, $limit: limit }) as Task[];
  }

  /**
   * Get subtasks for a parent task
   */
  getSubtasks(parentId: string): Task[] {
    return this.db
      .prepare("SELECT * FROM tasks WHERE parent_task_id = ? ORDER BY priority ASC, created_at ASC")
      .all(parentId) as Task[];
  }

  // --------------------------------------------------------------------------
  // Project CRUD
  // --------------------------------------------------------------------------

  createProject(input: {
    name: string;
    description?: string;
    status?: ProjectStatus;
    goal_id?: string | null;
    color?: string | null;
    sort_order?: number;
    asana_project_gid?: string | null;
    id?: string;
  }): Project {
    const id = input.id || generateProjectId();
    const now = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO projects (id, name, description, status, goal_id, color, sort_order, asana_project_gid, created_at, updated_at)
         VALUES ($id, $name, $description, $status, $goal_id, $color, $sort_order, $asana_project_gid, $created_at, $updated_at)`
      )
      .run({
        $id: id,
        $name: input.name,
        $description: input.description || "",
        $status: input.status || "active",
        $goal_id: input.goal_id || null,
        $color: input.color || null,
        $sort_order: input.sort_order || 0,
        $asana_project_gid: input.asana_project_gid || null,
        $created_at: now,
        $updated_at: now,
      });

    return this.getProject(id)!;
  }

  getProject(id: string): Project | null {
    return this.db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as Project | null;
  }

  getProjectByName(name: string): Project | null {
    return this.db
      .prepare("SELECT * FROM projects WHERE LOWER(name) = LOWER(?)")
      .get(name) as Project | null;
  }

  listProjects(status?: ProjectStatus): Project[] {
    if (status) {
      return this.db
        .prepare("SELECT * FROM projects WHERE status = ? ORDER BY sort_order ASC, name ASC")
        .all(status) as Project[];
    }
    return this.db
      .prepare("SELECT * FROM projects ORDER BY sort_order ASC, name ASC")
      .all() as Project[];
  }

  updateProject(
    id: string,
    updates: Partial<Omit<Project, "id" | "created_at">>
  ): Project | null {
    const existing = this.getProject(id);
    if (!existing) return null;

    const now = new Date().toISOString();
    const setClauses: string[] = ["updated_at = $updated_at"];
    const params: Record<string, unknown> = { $updated_at: now, $id: id };

    for (const [key, value] of Object.entries(updates)) {
      if (key === "id" || key === "created_at") continue;
      if (value === undefined) continue;
      setClauses.push(`${key} = $${key}`);
      params[`$${key}`] = value;
    }

    const sql = `UPDATE projects SET ${setClauses.join(", ")} WHERE id = $id`;
    this.db.prepare(sql).run(params);

    return this.getProject(id);
  }

  // --------------------------------------------------------------------------
  // Activity Log
  // --------------------------------------------------------------------------

  logActivity(
    taskId: string,
    action: string,
    changes: string | null,
    actor: string = "user",
    aiReasoning: string | null = null
  ): void {
    this.db
      .prepare(
        `INSERT INTO activity_log (task_id, action, changes, ai_reasoning, actor, created_at)
         VALUES ($task_id, $action, $changes, $ai_reasoning, $actor, $created_at)`
      )
      .run({
        $task_id: taskId,
        $action: action,
        $changes: changes,
        $ai_reasoning: aiReasoning,
        $actor: actor,
        $created_at: new Date().toISOString(),
      });
  }

  getActivityLog(taskId: string, limit: number = 20): ActivityLogEntry[] {
    return this.db
      .prepare(
        "SELECT * FROM activity_log WHERE task_id = ? ORDER BY created_at DESC LIMIT ?"
      )
      .all(taskId, limit) as ActivityLogEntry[];
  }

  // --------------------------------------------------------------------------
  // Statistics
  // --------------------------------------------------------------------------

  getStats(): TaskStats {
    const total = (
      this.db.prepare("SELECT COUNT(*) as count FROM tasks").get() as { count: number }
    ).count;

    // By status
    const statusRows = this.db
      .prepare("SELECT status, COUNT(*) as count FROM tasks GROUP BY status")
      .all() as { status: string; count: number }[];
    const byStatus: Record<string, number> = {};
    for (const row of statusRows) {
      byStatus[row.status] = row.count;
    }

    // By project
    const projectRows = this.db
      .prepare(
        `SELECT p.id, p.name, COUNT(t.id) as count
         FROM projects p
         LEFT JOIN tasks t ON t.project_id = p.id AND t.status NOT IN ('done', 'cancelled')
         GROUP BY p.id
         ORDER BY count DESC`
      )
      .all() as { id: string; name: string; count: number }[];
    const byProject: Record<string, { name: string; count: number }> = {};
    for (const row of projectRows) {
      byProject[row.id] = { name: row.name, count: row.count };
    }

    // By goal
    const goalRows = this.db
      .prepare(
        `SELECT goal_id, COUNT(*) as count FROM tasks
         WHERE goal_id IS NOT NULL AND status NOT IN ('done', 'cancelled')
         GROUP BY goal_id ORDER BY count DESC`
      )
      .all() as { goal_id: string; count: number }[];
    const byGoal: Record<string, number> = {};
    for (const row of goalRows) {
      byGoal[row.goal_id] = row.count;
    }

    // Overdue
    const today = new Date().toISOString().split("T")[0];
    const overdue = (
      this.db
        .prepare(
          `SELECT COUNT(*) as count FROM tasks
           WHERE due_date IS NOT NULL AND due_date < $today
             AND status NOT IN ('done', 'cancelled')`
        )
        .get({ $today: today }) as { count: number }
    ).count;

    // Due today
    const dueToday = (
      this.db
        .prepare(
          `SELECT COUNT(*) as count FROM tasks
           WHERE due_date = $today AND status NOT IN ('done', 'cancelled')`
        )
        .get({ $today: today }) as { count: number }
    ).count;

    // Completed this week (last 7 days)
    const weekAgo = new Date();
    weekAgo.setDate(weekAgo.getDate() - 7);
    const completedThisWeek = (
      this.db
        .prepare(
          `SELECT COUNT(*) as count FROM tasks
           WHERE status = 'done' AND completed_at >= $week_ago`
        )
        .get({ $week_ago: weekAgo.toISOString() }) as { count: number }
    ).count;

    return {
      total,
      byStatus,
      byProject,
      byGoal,
      overdue,
      dueToday,
      completedThisWeek,
    };
  }

  // --------------------------------------------------------------------------
  // Bulk Operations (for migration)
  // --------------------------------------------------------------------------

  /**
   * Insert multiple tasks in a transaction for performance
   */
  bulkCreateTasks(
    tasks: Array<Parameters<TaskDB["createTask"]>[0]>
  ): string[] {
    const ids: string[] = [];
    const transaction = this.db.transaction(() => {
      for (const task of tasks) {
        const created = this.createTask(task);
        ids.push(created.id);
      }
    });
    transaction();
    return ids;
  }

  /**
   * Check if task with given asana_gid already exists
   */
  getTaskByAsanaGid(gid: string): Task | null {
    return this.db
      .prepare("SELECT * FROM tasks WHERE asana_gid = ?")
      .get(gid) as Task | null;
  }

  /**
   * Get project by asana project gid
   */
  getProjectByAsanaGid(gid: string): Project | null {
    return this.db
      .prepare("SELECT * FROM projects WHERE asana_project_gid = ?")
      .get(gid) as Project | null;
  }

  // --------------------------------------------------------------------------
  // Habit Tracking
  // --------------------------------------------------------------------------

  /**
   * Record a habit completion for a recurring task.
   * Uses INSERT OR IGNORE to handle idempotency (duplicate dates silently skipped).
   */
  recordHabitCompletion(taskId: string, date: string, notes?: string): void {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO habit_completions (task_id, completed_date, notes) VALUES ($task_id, $completed_date, $notes)"
      )
      .run({
        $task_id: taskId,
        $completed_date: date,
        $notes: notes || null,
      });
  }

  /**
   * Get habit stats for a specific task over the given number of days.
   */
  getHabitStats(taskId: string, days: number = 30): HabitStats {
    const task = this.getTask(taskId);
    const taskTitle = task ? task.title : "Unknown";

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    const cutoffStr = cutoff.toISOString().split("T")[0];

    const rows = this.db
      .prepare(
        `SELECT completed_date FROM habit_completions
         WHERE task_id = $task_id AND completed_date >= $cutoff
         ORDER BY completed_date DESC`
      )
      .all({ $task_id: taskId, $cutoff: cutoffStr }) as { completed_date: string }[];

    const completionDates = rows.map((r) => r.completed_date);
    const totalCompletions = completionDates.length;
    const completionRate = Math.round((totalCompletions / days) * 100);

    // Current streak: count consecutive days backward from today
    const today = new Date();
    let currentStreak = 0;
    const dateSet = new Set(completionDates);
    for (let i = 0; i < days; i++) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      const dStr = d.toISOString().split("T")[0];
      if (dateSet.has(dStr)) {
        currentStreak++;
      } else {
        break;
      }
    }

    // Longest streak: scan all completions sorted ascending
    const allRows = this.db
      .prepare(
        "SELECT completed_date FROM habit_completions WHERE task_id = $task_id ORDER BY completed_date ASC"
      )
      .all({ $task_id: taskId }) as { completed_date: string }[];

    let longestStreak = 0;
    let streak = 0;
    let prevDate: Date | null = null;
    for (const row of allRows) {
      const current = new Date(row.completed_date + "T00:00:00");
      if (prevDate !== null) {
        const diff = Math.round((current.getTime() - prevDate.getTime()) / (1000 * 60 * 60 * 24));
        if (diff === 1) {
          streak++;
        } else {
          streak = 1;
        }
      } else {
        streak = 1;
      }
      if (streak > longestStreak) longestStreak = streak;
      prevDate = current;
    }

    return {
      taskId,
      taskTitle,
      totalCompletions,
      currentStreak,
      longestStreak,
      completionRate,
      completionDates,
    };
  }

  /**
   * Get habit stats for all tasks that have at least one habit_completion entry.
   */
  getAllHabitStats(days: number = 30): HabitStats[] {
    const taskIds = this.db
      .prepare("SELECT DISTINCT task_id FROM habit_completions")
      .all() as { task_id: string }[];

    return taskIds.map((row) => this.getHabitStats(row.task_id, days));
  }

  // --------------------------------------------------------------------------
  // Saved Views
  // --------------------------------------------------------------------------

  /**
   * Create or replace a saved view by name.
   */
  createSavedView(name: string, filter: TaskFilter, sort?: { field: string; direction: "asc" | "desc" }): void {
    // Use upsert pattern: replace existing view with same name
    const existing = this.db
      .prepare("SELECT id FROM saved_views WHERE name = $name")
      .get({ $name: name }) as { id: string } | null;

    const id = existing ? existing.id : generateViewId();
    const now = new Date().toISOString();

    if (existing) {
      this.db
        .prepare(
          "UPDATE saved_views SET filter_json = $filter_json, sort_json = $sort_json WHERE id = $id"
        )
        .run({
          $filter_json: JSON.stringify(filter),
          $sort_json: sort ? JSON.stringify(sort) : null,
          $id: id,
        });
    } else {
      this.db
        .prepare(
          `INSERT INTO saved_views (id, name, filter_json, sort_json, is_default, created_at)
           VALUES ($id, $name, $filter_json, $sort_json, 0, $created_at)`
        )
        .run({
          $id: id,
          $name: name,
          $filter_json: JSON.stringify(filter),
          $sort_json: sort ? JSON.stringify(sort) : null,
          $created_at: now,
        });
    }
  }

  /**
   * Get a saved view's filter and sort by name.
   */
  getSavedView(name: string): { filter: TaskFilter; sort?: { field: string; direction: "asc" | "desc" } } | null {
    const row = this.db
      .prepare("SELECT filter_json, sort_json FROM saved_views WHERE name = $name")
      .get({ $name: name }) as { filter_json: string; sort_json: string | null } | null;

    if (!row) return null;

    try {
      const filter = JSON.parse(row.filter_json) as TaskFilter;
      const sort = row.sort_json ? (JSON.parse(row.sort_json) as { field: string; direction: "asc" | "desc" }) : undefined;
      return { filter, sort };
    } catch {
      console.error(`Error parsing saved view filter for "${name}"`);
      return null;
    }
  }

  /**
   * List all saved views.
   */
  listSavedViews(): SavedView[] {
    const rows = this.db
      .prepare("SELECT id, name, filter_json, sort_json, is_default, created_at FROM saved_views ORDER BY name ASC")
      .all() as { id: string; name: string; filter_json: string; sort_json: string | null; is_default: number; created_at: string }[];

    return rows.map((row) => {
      let filter: TaskFilter = {};
      let sort: { field: string; direction: "asc" | "desc" } | undefined;
      try {
        filter = JSON.parse(row.filter_json) as TaskFilter;
        sort = row.sort_json ? (JSON.parse(row.sort_json) as { field: string; direction: "asc" | "desc" }) : undefined;
      } catch {
        // Malformed JSON, return empty filter
      }
      return {
        id: row.id,
        name: row.name,
        filter,
        sort,
        isDefault: row.is_default === 1,
        createdAt: row.created_at,
      };
    });
  }

  /**
   * Delete a saved view by name. Returns true if deleted, false if not found.
   */
  deleteSavedView(name: string): boolean {
    const result = this.db
      .prepare("DELETE FROM saved_views WHERE name = $name")
      .run({ $name: name });
    return result.changes > 0;
  }

  /**
   * Set the default view by name (clears other defaults first).
   */
  setDefaultView(name: string): void {
    this.db.exec("UPDATE saved_views SET is_default = 0");
    this.db
      .prepare("UPDATE saved_views SET is_default = 1 WHERE name = $name")
      .run({ $name: name });
  }

  /**
   * Apply a saved view by name: loads its filter and returns matching tasks.
   */
  applyView(name: string): Task[] {
    const view = this.getSavedView(name);
    if (!view) return [];
    return this.listTasks(view.filter);
  }

  // --------------------------------------------------------------------------
  // Enhanced Statistics
  // --------------------------------------------------------------------------

  /**
   * Get task completion velocity per week for the last N weeks.
   */
  getCompletionVelocity(weeks: number = 4): { week: string; count: number }[] {
    const rows = this.db
      .prepare(
        `SELECT
          strftime('%Y-%W', completed_at) as week,
          COUNT(*) as count
         FROM tasks
         WHERE status = 'done'
           AND completed_at >= date('now', $offset)
         GROUP BY week
         ORDER BY week ASC`
      )
      .all({ $offset: `-${weeks * 7} days` }) as { week: string; count: number }[];

    return rows;
  }

  /**
   * Get average task duration in minutes (tasks with both started_at and completed_at).
   */
  getAverageTaskDuration(): { averageMinutes: number; taskCount: number } {
    const row = this.db
      .prepare(
        `SELECT
          AVG((julianday(completed_at) - julianday(started_at)) * 1440) as avg_minutes,
          COUNT(*) as task_count
         FROM tasks
         WHERE started_at IS NOT NULL
           AND completed_at IS NOT NULL
           AND status = 'done'`
      )
      .get() as { avg_minutes: number | null; task_count: number };

    return {
      averageMinutes: row.avg_minutes ? Math.round(row.avg_minutes * 10) / 10 : 0,
      taskCount: row.task_count,
    };
  }

  /**
   * Get completion progress grouped by goal_id (excluding cancelled tasks from total).
   */
  getGoalProgress(): Record<string, { completed: number; total: number; percentage: number }> {
    const rows = this.db
      .prepare(
        `SELECT
          goal_id,
          SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) as completed,
          COUNT(*) as total
         FROM tasks
         WHERE goal_id IS NOT NULL
           AND status != 'cancelled'
         GROUP BY goal_id`
      )
      .all() as { goal_id: string; completed: number; total: number }[];

    const result: Record<string, { completed: number; total: number; percentage: number }> = {};
    for (const row of rows) {
      const percentage = row.total > 0 ? Math.round((row.completed / row.total) * 100) : 0;
      result[row.goal_id] = { completed: row.completed, total: row.total, percentage };
    }
    return result;
  }

  /**
   * Get distribution of active tasks by energy level.
   */
  getEnergyDistribution(): { high: number; medium: number; low: number; unset: number } {
    const rows = this.db
      .prepare(
        `SELECT
          COALESCE(energy_level, 'unset') as level,
          COUNT(*) as count
         FROM tasks
         WHERE status NOT IN ('done', 'cancelled')
         GROUP BY level`
      )
      .all() as { level: string; count: number }[];

    const result = { high: 0, medium: 0, low: 0, unset: 0 };
    for (const row of rows) {
      if (row.level === "high" || row.level === "medium" || row.level === "low" || row.level === "unset") {
        result[row.level] = row.count;
      }
    }
    return result;
  }

  /**
   * Get overdue tasks bucketed by how many days overdue they are.
   */
  getOverdueBreakdown(): { range: string; count: number }[] {
    const rows = this.db
      .prepare(
        `SELECT
          CASE
            WHEN days_overdue BETWEEN 1 AND 3 THEN '1-3_days'
            WHEN days_overdue BETWEEN 4 AND 7 THEN '4-7_days'
            WHEN days_overdue BETWEEN 8 AND 14 THEN '8-14_days'
            ELSE '15+_days'
          END as range,
          COUNT(*) as count
         FROM (
           SELECT julianday('now') - julianday(due_date) as days_overdue
           FROM tasks
           WHERE due_date IS NOT NULL
             AND due_date < date('now')
             AND status NOT IN ('done', 'cancelled')
         )
         GROUP BY range
         ORDER BY
           CASE range
             WHEN '1-3_days' THEN 1
             WHEN '4-7_days' THEN 2
             WHEN '8-14_days' THEN 3
             ELSE 4
           END`
      )
      .all() as { range: string; count: number }[];

    // Ensure all ranges are represented
    const rangeMap: Record<string, number> = {};
    for (const row of rows) {
      rangeMap[row.range] = row.count;
    }
    return [
      { range: "1-3_days", count: rangeMap["1-3_days"] || 0 },
      { range: "4-7_days", count: rangeMap["4-7_days"] || 0 },
      { range: "8-14_days", count: rangeMap["8-14_days"] || 0 },
      { range: "15+_days", count: rangeMap["15+_days"] || 0 },
    ];
  }

  /**
   * Get enhanced statistics combining existing stats with new metrics.
   */
  getEnhancedStats(): EnhancedTaskStats {
    const base = this.getStats();
    const velocity = this.getCompletionVelocity(4);
    const averageVelocity =
      velocity.length > 0
        ? Math.round((velocity.reduce((s, w) => s + w.count, 0) / velocity.length) * 10) / 10
        : 0;
    const durationData = this.getAverageTaskDuration();
    const goalProgress = this.getGoalProgress();
    const energyDistribution = this.getEnergyDistribution();
    const overdueBreakdown = this.getOverdueBreakdown();

    return {
      ...base,
      velocity,
      averageVelocity,
      averageDurationMinutes: durationData.averageMinutes,
      tasksWithDuration: durationData.taskCount,
      goalProgress,
      energyDistribution,
      overdueBreakdown,
    };
  }

  // --------------------------------------------------------------------------
  // Utility
  // --------------------------------------------------------------------------

  close(): void {
    this.db.close();
  }

  /**
   * Get raw database handle for advanced queries
   */
  getRawDb(): Database {
    return this.db;
  }
}

// ============================================================================
// Singleton Access
// ============================================================================

let _instance: TaskDB | null = null;

export function getTaskDB(dbPath?: string): TaskDB {
  if (!_instance) {
    _instance = new TaskDB(dbPath);
  }
  return _instance;
}

// ============================================================================
// CLI self-test when run directly
// ============================================================================

if (import.meta.main) {
  console.log("TaskDB - SQLite Database Layer for LucidTasks");
  console.log("==============================================\n");

  const db = getTaskDB();
  const stats = db.getStats();

  console.log(`Database: ${DB_PATH}`);
  console.log(`Total tasks: ${stats.total}`);
  console.log(`By status:`, stats.byStatus);
  console.log(`Projects: ${Object.keys(stats.byProject).length}`);
  console.log(`Overdue: ${stats.overdue}`);
  console.log(`Due today: ${stats.dueToday}`);
  console.log(`Completed this week: ${stats.completedThisWeek}`);

  db.close();
}
