#!/usr/bin/env bun
/**
 * QueueTaskIntegrationAdapter.ts — LucidTasks-side implementation of the
 * QueueRouter <-> LucidTasks seam (lib/interfaces/QueueTaskIntegration.ts).
 *
 * Implements `TaskClient` over the real TaskDB (in-process — no subprocess
 * spawn, no CLI stdout parsing). `syncQueueStatus` delegates to
 * TaskManager.ts's existing `syncQueueStatus` export rather than
 * re-implementing the queue-status → task-status map here, so there is a
 * single source of truth for that mapping (QueueManager.ts's lazy `lucidSync`
 * default used to import that exact function — see QueueManager.ts's
 * `syncToLucid`, now migrated onto `getTaskClient()`).
 *
 * `registerTaskClient()` is the one-line composition-root call — imported
 * (for its side effect) by bin/wire-queue-task-integration.ts, which
 * entrypoints import before they touch anything that needs the seam.
 *
 * @module QueueTaskIntegrationAdapter
 */

import { getTaskDB, type TaskStatus, type Task } from "./TaskDB.ts";
import { syncQueueStatus as taskManagerSyncQueueStatus } from "./TaskManager.ts";
import {
  setTaskClient,
  type TaskClient,
  type TaskClientTask,
  type TaskClientAgedTask,
} from "../../../../lib/interfaces/QueueTaskIntegration.ts";

/** Project a full LucidTasks Task row onto the seam's minimal TaskClientTask shape. */
function toClientTask(task: Task): TaskClientTask {
  return {
    id: task.id,
    status: task.status,
    title: task.title,
    queueItemId: task.queue_item_id,
  };
}

/** Project a Task row onto the seam's aged-task shape (WaitingOnJm reads). */
function toAgedTask(task: Task): TaskClientAgedTask {
  return {
    id: task.id,
    title: task.title,
    createdAt: task.created_at,
  };
}

/** Open (non-terminal) task statuses — mirrors getOverdueTasks' status filter idiom. */
const OPEN_TASK_STATUSES: TaskStatus[] = ["inbox", "next", "in_progress", "waiting", "someday"];

export const taskClientAdapter: TaskClient = {
  async listTasksByStatus(status: string): Promise<TaskClientTask[]> {
    const db = getTaskDB();
    // The seam's status is a plain string (deliberately decoupled from
    // TaskDB's TaskStatus enum — see QueueTaskIntegration.ts's module doc).
    // An unrecognized value simply matches zero rows.
    const rows = db.listTasks({ status: status as TaskStatus });
    return rows.map(toClientTask);
  },

  async getTaskById(taskId: string): Promise<TaskClientTask | null> {
    const db = getTaskDB();
    const task = db.getTask(taskId);
    return task ? toClientTask(task) : null;
  },

  async updateTaskStatus(taskId: string, status: string): Promise<boolean> {
    const db = getTaskDB();
    const updated = db.updateTask(taskId, { status: status as TaskStatus }, "queue");
    return updated !== null;
  },

  async updateTaskQueueLink(taskId: string, queueItemId: string | null): Promise<boolean> {
    const db = getTaskDB();
    const updated = db.updateTask(taskId, { queue_item_id: queueItemId }, "queue");
    return updated !== null;
  },

  async createTask(title: string, opts?: { parentId?: string; description?: string }): Promise<string> {
    const db = getTaskDB();
    // Verbatim title — no AI rewriting. Mirrors the `--no-ai` contract
    // GrillRunner.splitTask relies on (TaskManager's `add` command defaults
    // to AI title rewriting; createTask() here never does).
    // Machine-created tasks must carry context (SKILL.md "Task context
    // standard"): callers pass a description with a CONTEXT: line; a caller
    // that has nothing better still gets a pointer at the queue/parent.
    const description =
      opts?.description ?? (opts?.parentId ? `CONTEXT: parent task ${opts.parentId}` : "");
    const task = db.createTask({ title, description, parent_task_id: opts?.parentId ?? null });
    return task.id;
  },

  syncQueueStatus(taskId: string, queueStatus: string): void {
    taskManagerSyncQueueStatus(taskId, queueStatus);
  },

  async listOpenTasksInProject(projectName: string): Promise<TaskClientAgedTask[]> {
    const db = getTaskDB();
    // READ-ONLY: getProjectByName never creates — a missing project means
    // zero rows, not a side-effect-created empty project.
    const project = db.getProjectByName(projectName);
    if (!project) return [];
    return db.listTasks({ project_id: project.id, status: OPEN_TASK_STATUSES }).map(toAgedTask);
  },

  async listWaitingAutonomousTasks(): Promise<TaskClientAgedTask[]> {
    const db = getTaskDB();
    return db
      .listTasks({ status: "waiting" })
      .filter((t) => t.disposition === "autonomous")
      .map(toAgedTask);
  },
};

/** Register taskClientAdapter into the shared QueueTaskIntegration registry. */
export function registerTaskClient(): void {
  setTaskClient(taskClientAdapter);
}
