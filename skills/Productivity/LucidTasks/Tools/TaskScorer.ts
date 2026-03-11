/**
 * TaskScorer.ts - 7-Factor Deterministic Scoring for LucidTasks
 *
 * Pure scoring function extracted from TaskManager.ts for modularity.
 *
 * @module TaskScorer
 */

import type { Task, EnergyLevel } from "./TaskDB.ts";

// ============================================================================
// Types
// ============================================================================

export interface ScoringContext {
  projectFilter?: string;
  goalFilter?: string;
  energyFilter?: EnergyLevel;
  activeGoalIds: string[];
  now: Date;
}

export interface ScoredTask {
  task: Task;
  score: number;
  reasons: string[];
}

// ============================================================================
// Scoring Algorithm
// ============================================================================

export function scoreTask(task: Task, ctx: ScoringContext): ScoredTask {
  let score = 0;
  const reasons: string[] = [];
  const today = ctx.now.toISOString().split("T")[0];
  const in48h = new Date(ctx.now.getTime() + 48 * 60 * 60 * 1000).toISOString().split("T")[0];

  // Factor 1: Overdue (+50)
  if (task.due_date && task.due_date < today) {
    score += 50;
    reasons.push("Overdue (+50)");
  }

  // Factor 2: Priority (+30/+15/+0)
  if (task.priority === 1) {
    score += 30;
    reasons.push("High priority (+30)");
  } else if (task.priority === 2) {
    score += 15;
    reasons.push("Normal priority (+15)");
  }
  // priority 3 = +0, no reason added

  // Factor 3: Due soon - within 48h but not overdue (+20)
  if (task.due_date && task.due_date >= today && task.due_date <= in48h) {
    score += 20;
    const hoursUntil = Math.round(
      (new Date(task.due_date).getTime() - ctx.now.getTime()) / (1000 * 60 * 60)
    );
    reasons.push(`Due in ${hoursUntil}h (+20)`);
  }

  // Factor 4: Goal alignment (+15)
  if (task.goal_id && ctx.activeGoalIds.includes(task.goal_id)) {
    score += 15;
    reasons.push(`Goal ${task.goal_id} aligned (+15)`);
  }

  // Factor 5: Project context match (+10)
  if (ctx.projectFilter && task.project_id === ctx.projectFilter) {
    score += 10;
    reasons.push("Matches project (+10)");
  }

  // Factor 6: Energy match (+10)
  if (ctx.energyFilter && task.energy_level === ctx.energyFilter) {
    score += 10;
    reasons.push(`Energy match: ${ctx.energyFilter} (+10)`);
  }

  // Factor 7: Recency - updated in last 24h (+5)
  if (task.updated_at) {
    const updatedTime = new Date(task.updated_at).getTime();
    const oneDayAgo = ctx.now.getTime() - 24 * 60 * 60 * 1000;
    if (updatedTime >= oneDayAgo) {
      score += 5;
      reasons.push("Recently updated (+5)");
    }
  }

  return { task, score, reasons };
}
