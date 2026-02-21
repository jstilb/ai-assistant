#!/usr/bin/env bun
/**
 * GoalStore.ts - Internal Hierarchical Goal Storage
 *
 * CRUD for hierarchical goals (Yearly -> Quarterly -> Weekly)
 * persisted via StateManager. Never uses raw JSON.parse/readFileSync.
 *
 * @module GoalStore
 */

import { z } from "zod";
import { createStateManager } from "../../CORE/Tools/StateManager";
import type { Goal, GoalLevel, Result, CalendarError } from "./types";
import { GoalLevel as GL } from "./types";

const KAYA_DIR = process.env.KAYA_DIR || `${process.env.HOME}/.claude`;
const GOALS_PATH = `${KAYA_DIR}/skills/CalendarAssistant/data/goals.json`;

// ============================================
// SCHEMA
// ============================================

const GoalSchema = z.object({
  id: z.string(),
  title: z.string(),
  level: z.enum(["yearly", "quarterly", "weekly"]),
  parentId: z.string().optional(),
  status: z.enum(["active", "completed", "paused"]),
  keywords: z.array(z.string()),
  targetHoursPerWeek: z.number().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const GoalStoreSchema = z.object({
  goals: z.array(GoalSchema),
  lastUpdated: z.string(),
});

type GoalStoreState = z.infer<typeof GoalStoreSchema>;

// ============================================
// STATE MANAGER
// ============================================

const goalManager = createStateManager<GoalStoreState>({
  path: GOALS_PATH,
  schema: GoalStoreSchema,
  defaults: { goals: [], lastUpdated: new Date().toISOString() },
  version: 1,
});

// ============================================
// HELPERS
// ============================================

function generateId(): string {
  return `goal_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Extract keywords from a goal title.
 * Splits on spaces and filters common words.
 */
function extractKeywords(title: string): string[] {
  const stopWords = new Set([
    "the", "a", "an", "and", "or", "but", "in", "on", "at", "to",
    "for", "of", "with", "by", "from", "is", "are", "was", "were",
    "be", "been", "being", "have", "has", "had", "do", "does", "did",
    "will", "would", "could", "should", "may", "might", "can",
    "my", "your", "our", "their", "this", "that", "these", "those",
  ]);

  return title
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 2 && !stopWords.has(w))
    .map((w) => w.replace(/[^a-z0-9]/g, ""))
    .filter((w) => w.length > 0);
}

// ============================================
// PUBLIC API
// ============================================

/**
 * Add a new goal.
 *
 * @param title - Goal title
 * @param level - Goal level (yearly, quarterly, weekly)
 * @param parentId - Optional parent goal ID
 * @param targetHoursPerWeek - Optional target hours per week
 * @returns The created goal
 */
export async function addGoal(
  title: string,
  level: GoalLevel,
  parentId?: string,
  targetHoursPerWeek?: number
): Promise<Result<Goal, CalendarError>> {
  const goal: Goal = {
    id: generateId(),
    title,
    level,
    parentId,
    status: "active",
    keywords: extractKeywords(title),
    targetHoursPerWeek,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  try {
    await goalManager.update((state) => ({
      ...state,
      goals: [...state.goals, goal],
    }));
    return { success: true, data: goal };
  } catch (err) {
    return {
      success: false,
      error: {
        code: "UNKNOWN",
        message: `Failed to add goal: ${err instanceof Error ? err.message : String(err)}`,
        retryable: false,
      },
    };
  }
}

/**
 * Get all active goals.
 */
export async function getActiveGoals(): Promise<
  Result<Goal[], CalendarError>
> {
  try {
    const state = await goalManager.load();
    const active = state.goals.filter((g) => g.status === "active");
    return { success: true, data: active };
  } catch (err) {
    return {
      success: false,
      error: {
        code: "UNKNOWN",
        message: `Failed to load goals: ${err instanceof Error ? err.message : String(err)}`,
        retryable: true,
      },
    };
  }
}

/**
 * Get goals by level.
 */
export async function getGoalsByLevel(
  level: GoalLevel
): Promise<Result<Goal[], CalendarError>> {
  try {
    const state = await goalManager.load();
    const filtered = state.goals.filter(
      (g) => g.level === level && g.status === "active"
    );
    return { success: true, data: filtered };
  } catch (err) {
    return {
      success: false,
      error: {
        code: "UNKNOWN",
        message: `Failed to load goals: ${err instanceof Error ? err.message : String(err)}`,
        retryable: true,
      },
    };
  }
}

/**
 * Get child goals of a parent.
 */
export async function getChildGoals(
  parentId: string
): Promise<Result<Goal[], CalendarError>> {
  try {
    const state = await goalManager.load();
    const children = state.goals.filter(
      (g) => g.parentId === parentId && g.status === "active"
    );
    return { success: true, data: children };
  } catch (err) {
    return {
      success: false,
      error: {
        code: "UNKNOWN",
        message: `Failed to load goals: ${err instanceof Error ? err.message : String(err)}`,
        retryable: true,
      },
    };
  }
}

/**
 * Update a goal's status.
 */
export async function updateGoalStatus(
  goalId: string,
  status: "active" | "completed" | "paused"
): Promise<Result<Goal, CalendarError>> {
  try {
    const state = await goalManager.update((s) => ({
      ...s,
      goals: s.goals.map((g) =>
        g.id === goalId
          ? { ...g, status, updatedAt: new Date().toISOString() }
          : g
      ),
    }));

    const updated = state.goals.find((g) => g.id === goalId);
    if (!updated) {
      return {
        success: false,
        error: {
          code: "VALIDATION",
          message: `Goal ${goalId} not found`,
          retryable: false,
        },
      };
    }

    return { success: true, data: updated };
  } catch (err) {
    return {
      success: false,
      error: {
        code: "UNKNOWN",
        message: `Failed to update goal: ${err instanceof Error ? err.message : String(err)}`,
        retryable: false,
      },
    };
  }
}

/**
 * Delete a goal by ID.
 */
export async function deleteGoal(
  goalId: string
): Promise<Result<{ deleted: true }, CalendarError>> {
  try {
    await goalManager.update((s) => ({
      ...s,
      goals: s.goals.filter((g) => g.id !== goalId),
    }));
    return { success: true, data: { deleted: true } };
  } catch (err) {
    return {
      success: false,
      error: {
        code: "UNKNOWN",
        message: `Failed to delete goal: ${err instanceof Error ? err.message : String(err)}`,
        retryable: false,
      },
    };
  }
}

/**
 * Get full goal hierarchy.
 */
export async function getGoalHierarchy(): Promise<
  Result<
    { yearly: Goal[]; quarterly: Goal[]; weekly: Goal[] },
    CalendarError
  >
> {
  try {
    const state = await goalManager.load();
    const active = state.goals.filter((g) => g.status === "active");
    return {
      success: true,
      data: {
        yearly: active.filter((g) => g.level === GL.Yearly),
        quarterly: active.filter((g) => g.level === GL.Quarterly),
        weekly: active.filter((g) => g.level === GL.Weekly),
      },
    };
  } catch (err) {
    return {
      success: false,
      error: {
        code: "UNKNOWN",
        message: `Failed to load goal hierarchy: ${err instanceof Error ? err.message : String(err)}`,
        retryable: true,
      },
    };
  }
}

// CLI interface
if (import.meta.main) {
  const args = process.argv.slice(2);
  const command = args[0];

  if (command === "add") {
    const title = args[1];
    const level = (args[2] || "quarterly") as GoalLevel;
    if (!title) {
      console.error("Usage: GoalStore.ts add <title> [level]");
      process.exit(1);
    }
    const result = await addGoal(title, level);
    console.log(JSON.stringify(result, null, 2));
  } else if (command === "list") {
    const level = args[1] as GoalLevel | undefined;
    const result = level
      ? await getGoalsByLevel(level)
      : await getActiveGoals();
    console.log(JSON.stringify(result, null, 2));
  } else if (command === "hierarchy") {
    const result = await getGoalHierarchy();
    console.log(JSON.stringify(result, null, 2));
  } else if (command === "complete") {
    const goalId = args[1];
    if (!goalId) {
      console.error("Usage: GoalStore.ts complete <goal-id>");
      process.exit(1);
    }
    const result = await updateGoalStatus(goalId, "completed");
    console.log(JSON.stringify(result, null, 2));
  } else if (command === "delete") {
    const goalId = args[1];
    if (!goalId) {
      console.error("Usage: GoalStore.ts delete <goal-id>");
      process.exit(1);
    }
    const result = await deleteGoal(goalId);
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`GoalStore - Hierarchical Goal Management

Usage:
  bun run GoalStore.ts add "Goal title" [yearly|quarterly|weekly]
  bun run GoalStore.ts list [level]
  bun run GoalStore.ts hierarchy
  bun run GoalStore.ts complete <goal-id>
  bun run GoalStore.ts delete <goal-id>
`);
  }
}
