/**
 * TaskFormatter.ts - Display Formatting for LucidTasks
 *
 * Pure formatting functions extracted from TaskManager.ts for modularity.
 *
 * @module TaskFormatter
 */

import type { Task, Project } from "./TaskDB.ts";

// ============================================================================
// Constants
// ============================================================================

const STATUS_ICONS: Record<string, string> = {
  inbox: "[ ]",
  next: "[>]",
  in_progress: "[~]",
  waiting: "[.]",
  someday: "[?]",
  done: "[x]",
  cancelled: "[-]",
};

export const PRIORITY_LABELS: Record<number, string> = {
  1: "!!!",
  2: "!! ",
  3: "!  ",
};

// ============================================================================
// Functions
// ============================================================================

export function formatTaskLine(task: Task): string {
  const status = STATUS_ICONS[task.status] || "[?]";
  const priority = PRIORITY_LABELS[task.priority] || "   ";
  const due = task.due_date ? ` due:${task.due_date}` : "";
  const goal = task.goal_id ? ` ${task.goal_id}` : "";
  const project = task.project_id ? ` @${task.project_id}` : "";

  return `${status} ${priority} ${task.id}  ${task.title}${due}${goal}${project}`;
}

export function formatTaskDetail(task: Task): string {
  const lines: string[] = [
    "-------------------------------------------",
    `ID:          ${task.id}`,
    `Title:       ${task.title}`,
    `Status:      ${task.status}`,
    `Priority:    ${task.priority} (${task.priority === 1 ? "high" : task.priority === 2 ? "normal" : "low"})`,
  ];

  if (task.description) lines.push(`Description: ${task.description}`);
  if (task.due_date) lines.push(`Due:         ${task.due_date}`);
  if (task.scheduled_date) lines.push(`Scheduled:   ${task.scheduled_date}`);
  if (task.goal_id) lines.push(`Goal:        ${task.goal_id}`);
  if (task.mission_id) lines.push(`Mission:     ${task.mission_id}`);
  if (task.project_id) lines.push(`Project:     ${task.project_id}`);
  if (task.energy_level) lines.push(`Energy:      ${task.energy_level}`);
  if (task.estimated_minutes) lines.push(`Est. Time:   ${task.estimated_minutes} min`);
  if (task.parent_task_id) lines.push(`Parent:      ${task.parent_task_id}`);
  if (task.asana_gid) lines.push(`Asana GID:   ${task.asana_gid}`);
  if (task.ai_priority_score !== null && task.ai_priority_score !== undefined)
    lines.push(`AI Score:    ${task.ai_priority_score.toFixed(2)}`);
  if (task.ai_reasoning) lines.push(`AI Reason:   ${task.ai_reasoning}`);

  const tags = safeParseJSON(task.context_tags);
  if (tags.length > 0) lines.push(`Tags:        ${tags.join(", ")}`);

  const labels = safeParseJSON(task.labels);
  if (labels.length > 0) lines.push(`Labels:      ${labels.join(", ")}`);

  lines.push(`Created:     ${task.created_at}`);
  lines.push(`Updated:     ${task.updated_at}`);
  if (task.completed_at) lines.push(`Completed:   ${task.completed_at}`);

  lines.push("-------------------------------------------");

  return lines.join("\n");
}

export function safeParseJSON(str: string | null | undefined): string[] {
  if (!str) return [];
  try {
    const parsed = JSON.parse(str);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function formatProjectLine(project: Project, taskCount?: number): string {
  const statusIcon = project.status === "active" ? "+" : project.status === "paused" ? "~" : project.status === "completed" ? "x" : "-";
  const count = taskCount !== undefined ? ` (${taskCount} tasks)` : "";
  const goal = project.goal_id ? ` -> ${project.goal_id}` : "";
  return `[${statusIcon}] ${project.id}  ${project.name}${count}${goal}`;
}
