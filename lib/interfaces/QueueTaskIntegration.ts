/**
 * lib/interfaces/QueueTaskIntegration.ts — the QueueRouter <-> LucidTasks seam.
 *
 * Today (pre-S10) QueueRouter (skills/Automation/QueueRouter) and LucidTasks
 * (skills/Productivity/LucidTasks) couple directly via three mechanisms: CLI
 * subprocess spawns that parse stdout (QueueTaskReconciler.ts, GrillRunner.ts),
 * bidirectional dynamic imports of each other's concrete classes
 * (QueueManager.ts <-> TaskDB.ts/TaskManager.ts), and the old ILucidTaskSync
 * interface (lib/interfaces/LucidTaskSync.ts — deleted in this slice, folded
 * into TaskClient.syncQueueStatus below).
 *
 * This file replaces all of that with ONE seam: two small interfaces shaped by
 * the REAL operations the coupling sites perform (no speculative surface), plus
 * a module-level registry. Each skill's own adapter implements its own side
 * in-process:
 *   - skills/Productivity/LucidTasks/Tools/QueueTaskIntegrationAdapter.ts
 *     implements TaskClient over TaskDB/TaskManager.
 *   - skills/Automation/QueueRouter/Tools/QueueTaskIntegrationAdapter.ts
 *     implements QueueClient over QueueManager.
 * bin/wire-queue-task-integration.ts is the composition root that imports both
 * adapters' register*() functions and calls them — every entrypoint that needs
 * the integration imports that wiring module first (side-effect import).
 *
 * NO imports from skills/ in this file — the callers on both sides need to
 * import this file without pulling in the other skill, so the shapes below are
 * defined locally rather than imported from either skill's concrete types
 * (unlike the old LucidTaskSync.ts, which imported a type FROM QueueManager.ts,
 * a skill file — don't repeat that mistake).
 *
 * Getters return null when no adapter has been registered (e.g. a script ran
 * without importing the wiring module). Callers MUST handle null themselves
 * with a loud stderr line (console.error) naming the operation that was
 * skipped — fail visible, never silent. This file intentionally does NOT log
 * on behalf of callers: only the call site knows what it was trying to do and
 * what a safe fallback looks like (return empty list vs. throw vs. no-op).
 *
 * @module QueueTaskIntegration
 */

// ============================================================================
// Task-side (LucidTasks) contract
// ============================================================================

/**
 * Minimal task shape — only the fields the coupling sites actually read
 * (id/status/title/queueItemId). Deliberately NOT the full LucidTasks `Task`
 * zod type (which lives in a skill file and pulls in far more than this seam
 * needs).
 */
export interface TaskClientTask {
  id: string;
  status: string;
  title: string;
  /** Task-side backlink to the queue item it was enqueued as, when present. */
  queueItemId: string | null;
}

/**
 * Minimal aged-task shape for WaitingOnJm's read-only surfaces — the three
 * fields its AgedItem projection consumes (id/title + created_at for the
 * ageDays math). Deliberately narrower than TaskClientTask: these reads never
 * look at status or queue links.
 */
export interface TaskClientAgedTask {
  id: string;
  title: string;
  /** ISO created_at timestamp. */
  createdAt: string;
}

export interface TaskClient {
  /**
   * List all tasks carrying the given LucidTasks status.
   * Used by QueueTaskReconciler to fetch both the closed-task set (done,
   * cancelled, someday) and the active-task set (inbox, next, in_progress,
   * waiting) — one call per status, batched by the caller.
   */
  listTasksByStatus(status: string): Promise<TaskClientTask[]>;

  /** Get a single task by id, or null if it doesn't exist. */
  getTaskById(taskId: string): Promise<TaskClientTask | null>;

  /**
   * Update a task's lifecycle status (e.g. cancel a task whose linked
   * spec-pipeline item was killed). Returns true on success.
   */
  updateTaskStatus(taskId: string, status: string): Promise<boolean>;

  /**
   * Set (or clear, passing null) a task's queue_item_id backlink. Returns
   * true on success, false if the task doesn't exist.
   */
  updateTaskQueueLink(taskId: string, queueItemId: string | null): Promise<boolean>;

  /**
   * Create a new task with a VERBATIM title (no AI title rewriting — mirrors
   * the `--no-ai` contract splitTask relies on). Returns the new task id.
   */
  createTask(title: string, opts?: { parentId?: string; description?: string }): Promise<string>;

  /**
   * Sync a queue item's status to its linked task. Folds in the single
   * operation the old ILucidTaskSync interface (lib/interfaces/LucidTaskSync.ts,
   * deleted in this slice) existed for.
   */
  syncQueueStatus(taskId: string, queueStatus: string): void | Promise<void>;

  /**
   * List open (non-terminal: inbox/next/in_progress/waiting/someday) tasks in
   * the named project, newest-agnostic order. Returns [] when the project
   * doesn't exist — READ-ONLY, must never create the project as a side
   * effect. Used by WaitingOnJm's needsJmEscalations surface (F3).
   */
  listOpenTasksInProject(projectName: string): Promise<TaskClientAgedTask[]>;

  /**
   * List tasks parked for Jm by Lane-A: status 'waiting' AND
   * disposition 'autonomous'. Used by WaitingOnJm's laneAWaitingDeliverables
   * surface (F3).
   */
  listWaitingAutonomousTasks(): Promise<TaskClientAgedTask[]>;
}

// ============================================================================
// Queue-side (QueueRouter) contract
// ============================================================================

export interface QueueClientArchiveResult {
  archived: boolean;
  reason?: string;
}

export interface QueueClient {
  /**
   * Archive a queue item by id, refusing (archived:false + reason) if the
   * item is in-flight/terminal. Used as TaskDB's queue reverse-sync hook —
   * fired when a linked task transitions into a closed status.
   */
  archiveItemById(itemId: string, reason: string): Promise<QueueClientArchiveResult>;

  /**
   * Enqueue a new item (e.g. a LucidTask linked into the approvals queue via
   * spec-pipeline). Returns the new queue item id. `priority` overrides the
   * router's default (1 = highest; mirrors QueueManager's Priority without
   * importing the skill type — F4, UpgradeTriage's enqueue needs it).
   */
  enqueueItem(
    payload: { title: string; description: string; context?: Record<string, unknown> },
    options?: { source?: string; priority?: 1 | 2 | 3 },
  ): Promise<string>;
}

// ============================================================================
// Registry
// ============================================================================

let _taskClient: TaskClient | null = null;
let _queueClient: QueueClient | null = null;

/** Register the task-side (LucidTasks) adapter. Pass null to unregister. */
export function setTaskClient(client: TaskClient | null): void {
  _taskClient = client;
}

/** Returns the registered TaskClient, or null if none has been registered. */
export function getTaskClient(): TaskClient | null {
  return _taskClient;
}

/** Register the queue-side (QueueRouter) adapter. Pass null to unregister. */
export function setQueueClient(client: QueueClient | null): void {
  _queueClient = client;
}

/** Returns the registered QueueClient, or null if none has been registered. */
export function getQueueClient(): QueueClient | null {
  return _queueClient;
}

/**
 * Test-only helper — clears both registries. Production code never calls
 * this; it exists so test files can guarantee a clean slate in
 * beforeEach/afterEach without reaching into module internals.
 */
export function resetQueueTaskIntegrationForTest(): void {
  _taskClient = null;
  _queueClient = null;
}
