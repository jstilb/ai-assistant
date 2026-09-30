#!/usr/bin/env bun
/**
 * QueueManager.ts - Universal Queue Management for Kaya
 *
 * Core queue operations for the QueueRouter system. Provides add, list, update,
 * remove, and query operations across all queues with JSONL file persistence.
 *
 * Uses CORE infrastructure tools:
 * - StateManager for global queue state persistence
 *
 * Note: Individual queue files use JSONL format (one item per line) for
 * efficient append operations. This is intentionally different from
 * StateManager's single JSON file design.
 *
 * Usage:
 *   bun run QueueManager.ts add --title "Task" --description "Details" [--queue name] [--priority 1-3]
 *   bun run QueueManager.ts list [--queue name] [--status pending]
 *   bun run QueueManager.ts get <id>
 *   bun run QueueManager.ts update <id> --status completed
 *   bun run QueueManager.ts remove <id>
 *   bun run QueueManager.ts next [--queue name]
 *   bun run QueueManager.ts complete <id> [--output "result"]
 *   bun run QueueManager.ts fail <id> --error "reason"
 *   bun run QueueManager.ts approve <id> [--notes "..."] [--reviewer "..."]
 *   bun run QueueManager.ts reject <id> [--reason "..."] [--reviewer "..."]
 *   bun run QueueManager.ts stats [--queue name]
 *   bun run QueueManager.ts cleanup [--days 30]
 *
 * Progress Tracking:
 *   bun run QueueManager.ts init-progress <id> <totalPhases>
 *   bun run QueueManager.ts set-phase <id> <phase>
 *   bun run QueueManager.ts complete-phase <id> <phase>
 *   bun run QueueManager.ts update-isc <id> <criterion> <evidence>
 *   bun run QueueManager.ts progress <id>
 *
 * @module QueueManager
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, renameSync, unlinkSync } from "fs";
import { join, basename } from "path";
import { z } from "zod";
import { createStateManager, type StateManager } from "../../../../lib/core/StateManager.ts";
import { memoryStore } from "../../../../lib/core/MemoryStore.ts";
import { recordFailure } from "../../../../lib/core/FailureLog.ts";
import { createAppendLog, type AppendLog } from "../../../../lib/core/AppendLog.ts";
import { getTaskClient, type TaskClient } from "../../../../lib/interfaces/QueueTaskIntegration.ts";
import {
  getRepoForQueuesDir,
  pipelineItemToQueueItem,
  queueItemToPipelineParams,
  loadQueueItemsImpl,
  saveQueueItemsImpl,
  appendQueueItemImpl,
  deriveStage,
} from "./PipelineFacade.ts";
import {
  ALLOWED_TRANSITIONS as CANONICAL_TRANSITIONS,
  type Stage,
} from "./PipelineRepository.ts";
import { getKayaHome } from "../../../../lib/core/KayaHome.ts";
import { generateId as generateCoreId } from "../../../../lib/core/GenerateId.ts";

// ============================================================================
// Configuration
// ============================================================================

function getQueuesDir(): string {
  return join(getKayaHome(), "MEMORY/QUEUES");
}
function getStateFile(): string {
  return join(getQueuesDir(), "state.json");
}
export function getArchiveDir(): string {
  return join(getQueuesDir(), "archive");
}

// ============================================================================
// Types
// ============================================================================

export type QueueItemStatus =
  | "pending"
  | "in_progress"
  | "awaiting_approval"
  | "completed"
  | "failed"
  | "approved"
  | "rejected"
  // execution-phase statuses (derived from pipeline stage; absent from legacy JSONL)
  | "partial"
  | "needs_review"
  | "blocked"
  // spec-pipeline statuses
  | "awaiting-context"
  | "researching"
  | "generating-spec"
  | "revision-needed"
  | "escalated"
  /**
   * HUMAN-GATE status — the SpecPipelineRunner (processAll) never processes items
   * parked here. The only way out is the interactive `/queue grill` command, which
   * must be run with a human present. Automated crons and headless `claude -p` calls
   * MUST NOT invoke `/queue grill`.
   *
   * Valid transitions OUT: "researching" (grill finalize), "awaiting-context" (grill defer).
   * The item is removed from this state only by GrillRunner.finalizeGrillToSpec()
   * or GrillRunner.deferTask().
   */
  | "needs-grilling";

// SPEC_PIPELINE_TRANSITIONS and validateSpecPipelineTransition deleted in S2.
// Spec-pipeline transition validation now routes through the canonical
// PipelineRepository.ALLOWED_TRANSITIONS table (CANONICAL_TRANSITIONS).
// Spec-pipeline QueueItemStatus values map to canonical Stages as follows:
//   awaiting-context → intake     researching → researching
//   generating-spec  → generating-spec     revision-needed → revision-needed
//   escalated        → escalated           needs-grilling  → needs-grilling
const SPEC_STATUS_TO_STAGE: Record<string, Stage> = {
  "awaiting-context": "intake",
  "researching":      "researching",
  "generating-spec":  "generating-spec",
  "revision-needed":  "revision-needed",
  "escalated":        "escalated",
  "needs-grilling":   "needs-grilling",
};

/** Stamp written to `_meta.grillStamp` when a grill is finalized via attachContext(). */
export interface GrillStamp {
  /** FNV-1a 32-bit hex over `${title}\n${description}` at grill-finalize time */
  hash: string;
  /** ISO timestamp of grill finalization */
  at: string;
}

/**
 * Content hash for grill stamps — FNV-1a 32-bit over title+description,
 * mirroring the kaya_triage stamp idiom (KayaTaskClassifier.computeTriageHash).
 * A stamp is valid only while the hash matches the item's current content;
 * editing the title or description invalidates it (the item may be re-grilled).
 */
export function computeGrillHash(title: string, description: string): string {
  const input = `${title}\n${description}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * Options for attachContext() — grill-findings passthrough.
 *
 * When the interactive grill session has already done the research in-session,
 * it writes a findings artifact and passes its path here; runResearchPhase
 * then skips the autonomous research spawn and dispatches the verdict directly
 * from the artifact. `deepResearch` opts back into the full spawn even when
 * findings are present (for items needing a long autonomous dive).
 */
export interface AttachContextOptions {
  /** Path to a grill-written research findings artifact (skips research spawn). */
  findingsPath?: string;
  /** Force the autonomous research spawn even when findings are provided. */
  deepResearch?: boolean;
  /**
   * When true, this attachContext call is from the auto-advance routing path
   * (verdict=clear), NOT from a human grill session. No grillStamp is written —
   * a stamp must only assert a real human action.
   */
  autoRouted?: boolean;
}

/** True if the item carries a grill stamp matching its current content. */
export function hasValidGrillStamp(item: QueueItem): boolean {
  const meta = (item.payload.context?._meta as Record<string, unknown>) || {};
  const stamp = meta.grillStamp as GrillStamp | undefined;
  if (!stamp?.hash) return false;
  return stamp.hash === computeGrillHash(item.payload.title, item.payload.description ?? "");
}

/**
 * Statuses eligible for cleanup() archival. An allowlist, not a blocklist:
 * any status NOT listed here is kept, so an unknown or newly added status
 * defaults to safe (kept) rather than destructive (archived). Live working
 * statuses — especially the spec-pipeline's awaiting-context / needs-grilling /
 * researching / generating-spec — must never appear here: a June 2026 cleanup
 * swept 31 live items into the archive because the old logic blocklisted only
 * the three generic active statuses.
 */
export const ARCHIVABLE_TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "failed",
  "rejected",
]);

export type Priority = 1 | 2 | 3;

/** Spec linkage for queue items */
export interface QueueItemSpec {
  /** Spec filename without extension */
  id: string;
  /** Full path to grounded spec */
  path: string;
  /** Draft specs need review; approved specs are ready for execution */
  status: "draft" | "approved";
  /** When the spec was approved (only set for approved specs) */
  approvedAt?: string;
  /** Who approved the spec */
  approvedBy?: string;
  /** Optional ideal spec path for complex tasks */
  idealSpecPath?: string;
  /** Path to the test strategy document generated alongside the spec */
  testStrategyPath?: string;
}

/** ISC (Ideal State Criteria) status tracking */
export interface ISCStatus {
  /** Whether this criterion is completed */
  completed: boolean;
  /** When the criterion was completed */
  completedAt?: string;
  /** Evidence of completion (PR link, test output, etc.) - REQUIRED for completion */
  evidence?: string;
}

/** Progress tracking for multi-phase specs */
export interface QueueItemProgress {
  /** Current phase being worked on (1-indexed) */
  currentPhase: number;
  /** Total number of phases in the spec */
  totalPhases: number;
  /** List of completed phase numbers */
  phasesCompleted: number[];
  /** ISC criterion status keyed by criterion description or ID */
  iscStatus: Record<string, ISCStatus>;
  /** Last time progress was updated */
  lastUpdated: string;
}

/** Project configuration for work items */
export interface QueueItemProject {
  /** Unique project identifier (slug) */
  name: string;
  /** Full path to project directory */
  path: string;
  /** Git remote URL if applicable */
  gitRemote?: string;
  /** Whether this is an existing project or new */
  isNew?: boolean;
}

export interface QueueItem {
  id: string;
  created: string;
  updated: string;
  source: string;
  priority: Priority;
  status: QueueItemStatus;
  type: string;
  queue: string;

  payload: {
    title: string;
    description: string;
    context?: Record<string, unknown>;
  };

  /** Project configuration - where the work should be executed */
  project?: QueueItemProject;

  routing?: {
    sourceQueue?: string;
    targetQueue?: string;
    assignedAgent?: string;
    approver?: string;
  };

  result?: {
    completedAt?: string;
    approvedAt?: string;
    completedBy?: string;
    output?: unknown;
    error?: string;
    reviewNotes?: string;
    reviewer?: string;
  };

  /** Spec linkage - required for approved-work queue items */
  spec?: QueueItemSpec;

  /** Progress tracking for multi-phase specs */
  progress?: QueueItemProgress;
}

export interface AddOptions {
  /** Custom ID (defaults to auto-generated) */
  id?: string;
  queue?: string;
  priority?: Priority;
  type?: string;
  source?: string;
  context?: Record<string, unknown>;
  /** Initial reviewer notes */
  notes?: string;
  /** Project configuration - where the work should be executed */
  project?: QueueItemProject;
  /** Attach an existing spec file — bypasses auto enrichment+spec generation */
  spec?: QueueItemSpec;
  /**
   * LLM classifier verdict for this item (from KayaTaskClassifier or equivalent).
   *
   * Drives the initial routing decision in addSpecPipelineItem:
   *   - 'clear'      → attachContext + advance to "researching"
   *   - 'needs-grill' | 'not-executable' | absent → hold at "awaiting-context"
   *
   * Absent verdict is the safe default: never auto-advance unknown items.
   * This replaces the old hassufficientContext / canDeriveISCDirectly regex gates.
   */
  verdict?: "clear" | "needs-grill" | "not-executable";
}

export interface UpdateOptions {
  status?: QueueItemStatus;
  assignedAgent?: string;
  output?: unknown;
  error?: string;
}

export interface TransferOptions {
  targetQueue: string;
  status?: QueueItemStatus;
  notes?: string;
  transferredBy?: string;
  priority?: Priority;
}

export interface ListFilter {
  queue?: string;
  status?: QueueItemStatus;
  priority?: Priority;
  type?: string;
}

export interface QueueStats {
  total: number;
  pending: number;
  inProgress: number;
  awaitingApproval: number;
  completed: number;
  failed: number;
  byQueue: Record<string, number>;
  byPriority: Record<Priority, number>;
}

// Zod schema for QueueState
const QueueStateSchema = z.object({
  lastUpdated: z.string(),
  queues: z.array(z.string()),
  stats: z.object({
    totalItems: z.number(),
    totalProcessed: z.number(),
    lastProcessedAt: z.string().optional(),
  }),
  lastCleanupAt: z.string().optional(),
});

type QueueState = z.infer<typeof QueueStateSchema>;

// StateManager instance for global queue state — LAZY singleton. Constructed
// on first actual USE, not at module-load time: a module-top-level
// `createStateManager({ path: getStateFile(), ... })` here resolves
// getStateFile() -> getKayaHome() during ES module import evaluation, which
// (per import hoisting) runs before an importing test file's own
// process.env.KAYA_HOME pinning takes effect, regardless of textual order.
// That froze this singleton's `path` to the LIVE MEMORY/QUEUES/state.json
// even in KAYA_HOME-isolated test runs, and any test exercising saveState()
// (e.g. via QueueManager.add()) silently clobbered live production queue
// state. See MEMORY shared_process_test_home_pinning.md.
let _queueStateManager: StateManager<QueueState> | null = null;
function getQueueStateManagerInstance(): StateManager<QueueState> {
  if (!_queueStateManager) {
    _queueStateManager = createStateManager({
      path: getStateFile(),
      schema: QueueStateSchema,
      defaults: {
        lastUpdated: new Date().toISOString(),
        queues: [],
        stats: {
          totalItems: 0,
          totalProcessed: 0,
        },
      },
    });
  }
  return _queueStateManager;
}

// ============================================================================
// Helper Functions
// ============================================================================

function ensureDir(dirPath: string): void {
  if (!existsSync(dirPath)) {
    mkdirSync(dirPath, { recursive: true });
  }
}

// archivePath varies per queueName — cache one AppendLog per path.
const queueArchiveLogs = new Map<string, AppendLog>();
function getQueueArchiveLog(path: string): AppendLog {
  let log = queueArchiveLogs.get(path);
  if (!log) {
    log = createAppendLog(path);
    queueArchiveLogs.set(path, log);
  }
  return log;
}

/**
 * Archive queue items to per-queue archive JSONL files.
 * Path: MEMORY/QUEUES/archive/{queueName}-archive.jsonl
 * Uses AppendLog for crash-safe append-only writes.
 */
export function archiveItems(queueName: string, items: QueueItem[]): void {
  if (items.length === 0) return;
  const archivePath = join(getArchiveDir(), `${queueName}-archive.jsonl`);
  const archiveLog = getQueueArchiveLog(archivePath);
  for (const item of items) archiveLog.append(item);
}

/**
 * Release LucidTask → queue-item back-links for archived items.
 *
 * Triage (KayaTaskClassifier) skips any task whose queue_item_id is set, so an
 * archived item that still owns its task's back-link orphans that task forever.
 * Completed items keep the link — the underlying task was done, and releasing
 * it would let triage re-enqueue finished work. Everything else (failed,
 * rejected, or an item swept while still live) is released so triage can pick
 * the task up again on a future run.
 *
 * Best-effort by design: a missing or locked LucidTasks DB must never fail a
 * queue cleanup. Only clears a link that still points at the archived item —
 * never clobbers a newer enqueue.
 *
 * @returns number of back-links cleared
 */
export async function releaseLucidTaskBacklinks(items: QueueItem[]): Promise<number> {
  const releasable = items.filter(
    (i) => i.status !== "completed" && typeof i.payload.context?.lucidTaskId === "string",
  );
  if (releasable.length === 0) return 0;

  const client = getTaskClient();
  if (!client) {
    console.warn(
      "[QueueManager] releaseLucidTaskBacklinks skipped (non-fatal) — no TaskClient registered. " +
      "Import bin/wire-queue-task-integration.ts before calling this function.",
    );
    return 0;
  }

  let cleared = 0;
  try {
    for (const item of releasable) {
      const taskId = item.payload.context!.lucidTaskId as string;
      const task = await client.getTaskById(taskId);
      if (task?.queueItemId === item.id) {
        await client.updateTaskQueueLink(taskId, null);
        cleared++;
      }
    }
  } catch (err) {
    console.warn(
      `[QueueManager] releaseLucidTaskBacklinks failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return cleared;
}

export function generateId(): string {
  return generateCoreId("q");
}

export function getQueueFilePath(queueName: string): string {
  return join(getQueuesDir(), `${queueName}.jsonl`);
}

// Routing is intentionally conservative: every item lands in "approvals" and
// requires approval. This was the de-facto live behavior the whole time
// RoutingRules.yaml existed (its schema never parsed), so the file was deleted
// rather than revived. Add per-route behavior here, in code, if ever needed.
//
// S9: this used to run through a general multi-rule matcher — RoutingConfig /
// RoutingRule + loadRoutingConfig() (always returned exactly one rule: a "*"
// wildcard) + matchPattern() (its `if (pattern === "*") return true` branch
// always matched on the loop's very first iteration). Every rule after the
// first, the priority ?? config.defaults.priority fallback, and the
// post-loop "no rule matched" return were unreachable — zero-ref grepped and
// deleted along with those types. This function returns the one reachable
// route directly; typeOrTitle is accepted for call-site compatibility only.
function routeItem(_typeOrTitle: string): { queue: string; priority: Priority; requiresApproval: boolean } {
  return { queue: "approvals", priority: 2, requiresApproval: true };
}

// ============================================================================
// PipelineRepository facades (delegate to PipelineFacade.ts)
//
// loadQueueItems / saveQueueItems / appendQueueItem are thin facades over
// PipelineRepository (SQLite-backed). pipeline.db is the sole authoritative
// store — no JSONL shadow write, no JSONL-based discovery (see discoverQueues
// below). All codec and stage-derivation logic lives in PipelineFacade.ts.
// ArchiveManager.ts imports these facades directly (J2: the former parallel
// name+config calling convention module was deleted — this file is now the
// sole facade).
// ============================================================================

/**
 * loadQueueItems — PipelineRepository facade.
 *
 * Serves active (non-archived) items straight from pipeline.db.
 */
export function loadQueueItems(queueName: string): QueueItem[] {
  return loadQueueItemsImpl(queueName, getQueuesDir());
}

/**
 * saveQueueItems — PipelineRepository facade.
 *
 * Upserts all provided items into pipeline.db. Archives absentees (existing
 * active rows not in the new set) rather than hard-deleting; the archived rows
 * also get appended to a `*-archive.jsonl` audit trail (dedup'd by ID) — that
 * file is a historical record, not a live-read shadow of the queue.
 */
export function saveQueueItems(queueName: string, items: QueueItem[]): void {
  saveQueueItemsImpl(queueName, items, getQueuesDir(), getArchiveDir());
}

/**
 * appendQueueItem — PipelineRepository facade.
 *
 * Upserts the item into pipeline.db.
 */
export function appendQueueItem(queueName: string, item: QueueItem): void {
  appendQueueItemImpl(queueName, item, getQueuesDir());
}

/**
 * Load global queue state using CORE StateManager
 * Synchronous wrapper for CLI compatibility
 */
export function loadState(): QueueState {
  // Use sync read for CLI commands (StateManager.load is async)
  if (!existsSync(getStateFile())) {
    return {
      lastUpdated: new Date().toISOString(),
      queues: [],
      stats: { totalItems: 0, totalProcessed: 0 },
    };
  }

  try {
    const raw = readFileSync(getStateFile(), "utf-8");
    const parsed = JSON.parse(raw);
    // Remove internal version field if present
    const { _version, ...stateData } = parsed;
    const result = QueueStateSchema.safeParse(stateData);
    return result.success ? result.data : {
      lastUpdated: new Date().toISOString(),
      queues: [],
      stats: { totalItems: 0, totalProcessed: 0 },
    };
  } catch {
    return {
      lastUpdated: new Date().toISOString(),
      queues: [],
      stats: { totalItems: 0, totalProcessed: 0 },
    };
  }
}

/**
 * Save queue state using StateManager (async, concurrency-safe via FileLock).
 *
 * Per Decision C: All state writes go through queueStateManager to prevent the
 * race condition where concurrent cron writes corrupt state.json.
 */
async function saveState(state: QueueState): Promise<void> {
  state.lastUpdated = new Date().toISOString();
  await getQueueStateManagerInstance().save(state);
}

/**
 * Synchronous state save fallback using atomic tmp-then-rename.
 * Use ONLY in sync CLI callers that cannot await. For class methods, use saveState().
 */
export function saveStateSync(state: QueueState): void {
  ensureDir(getQueuesDir());
  state.lastUpdated = new Date().toISOString();
  const stateFile = getStateFile();
  const tmpPath = `${stateFile}.tmp.${process.pid}`;
  writeFileSync(tmpPath, JSON.stringify(state, null, 2));
  renameSync(tmpPath, stateFile);
}

/**
 * Files in MEMORY/QUEUES/ that share the directory but are NOT QueueItem queues.
 * `tech-debt.jsonl` is owned by TechDebtTracker/TechDebtRegistry (different schema:
 * no `payload`). Discovering it as a task queue made `list`/`stats` crash on
 * `item.payload.title`. Keep this in sync if other foreign-schema files land here.
 */
const NON_QUEUE_FILES = new Set(["tech-debt"]);

export function discoverQueues(): string[] {
  // S4: pipeline.db is the sole source of truth — no JSONL filename scan.
  // includeArchived:true mirrors "any queue with a JSONL file" — a queue whose
  // active items were archived must still be discoverable (e.g. restoreArchivedItem).
  ensureDir(getQueuesDir());
  const repo = getRepoForQueuesDir(getQueuesDir());
  const allRows = repo.list({ includeArchived: true });
  const result = new Set<string>();
  for (const item of allRows) {
    if (item.queue && !NON_QUEUE_FILES.has(item.queue)) {
      result.add(item.queue);
    }
  }
  return Array.from(result);
}

// ============================================================================
// QueueManager Class
// ============================================================================

/** Sync failure alert record for LucidTasks divergence detection */
interface SyncFailureAlert {
  timestamp: string;
  failureCount: number;
  pendingItems: Array<{
    itemId: string;
    queueName: string;
    lucidTaskId: string;
    status: QueueItemStatus;
    lastAttemptError: string;
  }>;
  recoveryInstructions: string;
}

export class QueueManager {
  /** Optional TaskClient override (injected at construction — mainly for tests) */
  private readonly lucidSync: TaskClient | null;
  /** Consecutive LucidTasks sync failure counter */
  private syncFailureCount = 0;
  /** Pending sync failures for alert file generation */
  private syncFailurePending: SyncFailureAlert["pendingItems"] = [];

  constructor(options: { lucidSync?: TaskClient } = {}) {
    // Default: resolve the registered TaskClient lazily via getTaskClient()
    // (lib/interfaces/QueueTaskIntegration.ts) rather than hard-importing LucidTasks.
    this.lucidSync = options.lucidSync ?? null;
  }

  /**
   * Resolve the TaskClient to use for LucidTasks sync — constructor override
   * first, else the registry (lib/interfaces/QueueTaskIntegration.ts).
   */
  private getLucidSync(): TaskClient | null {
    return this.lucidSync ?? getTaskClient();
  }

  /**
   * Sync a queue item status to LucidTasks, with failure counting and alert file generation.
   * Per Bug NEW-3: After 3 consecutive failures, writes a sync-failure alert file.
   */
  private async syncToLucid(lucidTaskId: string, status: QueueItemStatus, queueName: string, itemId: string): Promise<void> {
    const sync = this.getLucidSync();
    if (!sync) {
      console.error(
        `[QueueManager] No TaskClient registered — cannot sync item ${itemId} status to LucidTask ${lucidTaskId}. ` +
        "Import bin/wire-queue-task-integration.ts before calling QueueManager methods that sync to LucidTasks.",
      );
      return;
    }
    try {
      await sync.syncQueueStatus(lucidTaskId, status);
      // On success, reset failure tracking and clean up any alert files
      if (this.syncFailureCount > 0) {
        this.syncFailureCount = 0;
        this.syncFailurePending = [];
        this.cleanupSyncAlerts();
      }
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      console.warn(`[QueueManager] LucidTasks sync failed for item ${itemId}: ${errMsg}`);
      this.syncFailureCount++;
      this.syncFailurePending.push({ itemId, queueName, lucidTaskId, status, lastAttemptError: errMsg });
      if (this.syncFailureCount >= 3) {
        this.writeSyncFailureAlert();
      }
    }
  }

  /**
   * Write a sync-failure alert file to MEMORY/QUEUES/ for manual recovery.
   */
  private writeSyncFailureAlert(): void {
    try {
      const alertsDir = getQueuesDir();
      ensureDir(alertsDir);
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const alertPath = join(alertsDir, `sync-failure-${timestamp}.json`);
      const alert: SyncFailureAlert = {
        timestamp: new Date().toISOString(),
        failureCount: this.syncFailureCount,
        pendingItems: [...this.syncFailurePending],
        recoveryInstructions: "Run: bun QueueManager.ts recompute && manually update LucidTasks for each pendingItem.",
      };
      writeFileSync(alertPath, JSON.stringify(alert, null, 2));
      console.warn(`[QueueManager] Sync failure alert written: ${alertPath}`);
    } catch {
      // Alert write failure is non-fatal
    }
  }

  /**
   * Delete resolved sync-failure alert files. Archives files older than 7 days.
   */
  private cleanupSyncAlerts(): void {
    try {
      const queuesDir = getQueuesDir();
      if (!existsSync(queuesDir)) return;
      const files = readdirSync(queuesDir).filter(f => f.startsWith("sync-failure-") && f.endsWith(".json"));
      const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
      const archiveDir = join(queuesDir, "archive");
      for (const file of files) {
        const filePath = join(queuesDir, file);
        try {
          const stat = Bun.file(filePath);
          const mtime = new Date(stat.lastModified).getTime();
          if (Date.now() - mtime > sevenDaysMs) {
            ensureDir(archiveDir);
            renameSync(filePath, join(archiveDir, file));
          } else {
            // Delete recent resolved alerts
            unlinkSync(filePath);
          }
        } catch {
          // Skip files we can't process
        }
      }
    } catch {
      // Cleanup failure is non-fatal
    }
  }

  /**
   * Add a new item to a queue
   */
  async add(
    payload: { title: string; description: string; context?: Record<string, unknown> },
    options: AddOptions = {}
  ): Promise<string> {
    const type = options.type || "task";
    const routing = routeItem(`${type}:${payload.title}`);

    // When a spec is provided, route directly to approvals (bypass spec-pipeline)
    const queueName = options.spec
      ? (options.queue || "approvals")
      : (options.queue || routing.queue);
    const priority = options.priority || routing.priority;

    // Spec-pipeline delegation: items without a spec go through spec-pipeline first
    if (queueName === "spec-pipeline" && !options.spec) {
      return this.addSpecPipelineItem(payload, {
        id: options.id,
        priority,
        type,
        source: options.source,
        context: options.context,
      });
    }

    // Approvals guard: nothing enters approvals without a spec (defense in depth)
    if (queueName === "approvals" && !options.spec) {
      throw new Error(
        `Cannot add item to approvals without a spec. ` +
        `Items must go through spec-pipeline first, or use --spec to attach an existing spec.`
      );
    }

    const item: QueueItem = {
      id: options.id || generateId(),
      created: new Date().toISOString(),
      updated: new Date().toISOString(),
      source: options.source || "manual",
      priority,
      status: routing.requiresApproval ? "awaiting_approval" : "pending",
      type,
      queue: queueName,
      payload: {
        title: payload.title,
        description: payload.description,
        context: payload.context || options.context,
      },
      routing: {
        targetQueue: queueName,
      },
      ...(options.notes ? { result: { reviewNotes: options.notes } } : {}),
      ...(options.spec ? { spec: options.spec } : {}),
    };

    // Idempotency: skip if item with same custom ID already exists and is not terminal
    if (options.id) {
      const existing = loadQueueItems(queueName);
      const match = existing.find(i => i.id === options.id && i.status !== "completed" && i.status !== "failed");
      if (match) {
        return match.id;
      }
    }

    appendQueueItem(queueName, item);

    // Update state
    const state = loadState();
    if (!state.queues.includes(queueName)) {
      state.queues.push(queueName);
    }
    state.stats.totalItems++;
    await saveState(state);

    return item.id;
  }

  /**
   * Get a specific item by ID — O(1) via primary-key repo.get(id).
   * Returns null for archived items (mirroring repo.list default behaviour).
   */
  async get(id: string): Promise<QueueItem | null> {
    const repo = getRepoForQueuesDir(getQueuesDir());
    const pipelineItem = repo.get(id);
    if (!pipelineItem || pipelineItem.stage === "archived") return null;
    return pipelineItemToQueueItem(pipelineItem);
  }

  /**
   * List items with optional filtering
   */
  async list(filter: ListFilter = {}): Promise<QueueItem[]> {
    const queues = filter.queue ? [filter.queue] : discoverQueues();
    let allItems: QueueItem[] = [];

    for (const queueName of queues) {
      const items = loadQueueItems(queueName);
      allItems = allItems.concat(items);
    }

    // Apply filters
    if (filter.status) {
      allItems = allItems.filter((i) => i.status === filter.status);
    }
    if (filter.priority) {
      allItems = allItems.filter((i) => i.priority === filter.priority);
    }
    if (filter.type) {
      allItems = allItems.filter((i) => i.type === filter.type);
    }

    // Sort by priority (ascending - 1 is highest) then by created date
    allItems.sort((a, b) => {
      if (a.priority !== b.priority) {
        return a.priority - b.priority;
      }
      return new Date(a.created).getTime() - new Date(b.created).getTime();
    });

    return allItems;
  }

  /**
   * Get the next pending item from a queue
   */
  async next(queueName?: string): Promise<QueueItem | null> {
    const items = await this.list({
      queue: queueName,
      status: "pending",
    });

    return items[0] || null;
  }

  /**
   * Update an item
   */
  async update(id: string, updates: UpdateOptions): Promise<QueueItem | null> {
    const queues = discoverQueues();

    for (const queueName of queues) {
      const items = loadQueueItems(queueName);
      const index = items.findIndex((i) => i.id === id);

      if (index !== -1) {
        const item = items[index];
        item.updated = new Date().toISOString();

        if (updates.status) {
          item.status = updates.status;
        }
        if (updates.assignedAgent) {
          item.routing = item.routing || {};
          item.routing.assignedAgent = updates.assignedAgent;
        }
        if (updates.output !== undefined) {
          item.result = item.result || {};
          item.result.output = updates.output;
        }
        if (updates.error) {
          item.result = item.result || {};
          item.result.error = updates.error;
        }

        saveQueueItems(queueName, items);

        // Sync state after update
        const state = loadState();
        state.lastUpdated = new Date().toISOString();
        await saveState(state);

        return item;
      }
    }

    return null;
  }

  /**
   * Mark an item as completed
   */
  async complete(id: string, result?: { output?: unknown; completedBy?: string }): Promise<QueueItem | null> {
    const item = await this.get(id);
    if (!item) return null;

    const items = loadQueueItems(item.queue);
    const index = items.findIndex((i) => i.id === id);

    if (index !== -1) {
      // Phase verification gate: if progress tracking is initialized,
      // all phases must be completed before marking the item done
      if (items[index].progress) {
        const { phasesCompleted, totalPhases } = items[index].progress!;
        if (phasesCompleted.length < totalPhases) {
          const missing = [];
          for (let p = 1; p <= totalPhases; p++) {
            if (!phasesCompleted.includes(p)) missing.push(p);
          }
          console.error(
            `[QueueManager] BLOCKED: Cannot complete "${items[index].payload.title}" — ` +
            `phases [${missing.join(", ")}] of ${totalPhases} not completed. ` +
            `Use complete-phase to mark them done first.`
          );
          return null;
        }
      }

      items[index].status = "completed";
      items[index].updated = new Date().toISOString();
      items[index].result = {
        ...items[index].result,
        completedAt: new Date().toISOString(),
        output: result?.output,
        completedBy: result?.completedBy,
      };

      saveQueueItems(item.queue, items);

      const lucidTaskId = items[index].payload?.context?.lucidTaskId as string | undefined;
      if (lucidTaskId) {
        await this.syncToLucid(lucidTaskId, items[index].status, item.queue, items[index].id);
      }

      // Update state
      const state = loadState();
      state.stats.totalProcessed++;
      state.stats.lastProcessedAt = new Date().toISOString();
      await saveState(state);

      return items[index];
    }

    return null;
  }

  /**
   * Mark an item as failed
   */
  async fail(id: string, error: string): Promise<QueueItem | null> {
    const item = await this.get(id);
    if (!item) return null;

    const items = loadQueueItems(item.queue);
    const index = items.findIndex((i) => i.id === id);

    if (index !== -1) {
      items[index].status = "failed";
      items[index].updated = new Date().toISOString();
      items[index].result = {
        ...items[index].result,
        completedAt: new Date().toISOString(),
        error,
      };

      saveQueueItems(item.queue, items);

      // Sync state after fail
      const state = loadState();
      state.stats.totalProcessed++;
      state.stats.lastProcessedAt = new Date().toISOString();
      await saveState(state);

      return items[index];
    }

    return null;
  }

  /**
   * Approve an item (for approval queue) — O(1) via primary-key repo.get(id) +
   * repo.transition()/repo.upsert(), replacing the old load-ALL/save-ALL
   * full-queue rewrite (slice A4).
   *
   * Writes exactly one pipeline_events row for the approve itself (a legal
   * stage crossing, e.g. awaiting-approval → approved). The auto-promotion
   * from "approvals" to "approved-work" (below) is a SAME-STAGE queue move
   * (approved-work's "pending" status also derives to stage "approved" — see
   * PipelineFacade.deriveStage) — same-stage patches never write an event
   * (see PipelineRepository.upsert's docstring), so it produces none.
   */
  async approve(id: string, options?: { notes?: string; reviewer?: string }): Promise<QueueItem | null> {
    const repo = getRepoForQueuesDir(getQueuesDir());
    const pipelineItem = repo.get(id);
    if (!pipelineItem || pipelineItem.stage === "archived") return null;

    const item = pipelineItemToQueueItem(pipelineItem);
    if (!item) return null;

    // For items in approvals queue: require approved spec before allowing approval
    if (item.queue === "approvals") {
      if (!item.spec || item.spec.status !== "approved") {
        throw new Error(
          `Cannot approve item "${item.payload.title}" — no approved spec. ` +
          `Use /queue review to create and approve a spec first.`
        );
      }
    }

    // Items in approved-work need status "pending" to be actionable by AutonomousWork.
    // Items in other queues (e.g. approvals) get "approved" to indicate review completion.
    const newStatus: QueueItemStatus = item.queue === "approved-work" ? "pending" : "approved";
    const nowIso = new Date().toISOString();
    const updatedItem: QueueItem = {
      ...item,
      status: newStatus,
      updated: nowIso,
      result: {
        ...item.result,
        approvedAt: nowIso,
        reviewNotes: options?.notes,
        reviewer: options?.reviewer,
      },
    };

    const fromStage = pipelineItem.stage;
    const toStage = deriveStage(newStatus, item.queue);
    const actor = "QueueManager.approve";
    const note = options?.reviewer ? `approve:${options.reviewer}` : "approve";

    const { stage: _stage, created_at: _createdAt, updated_at: _updatedAt, id: _pid, ...patch } =
      queueItemToPipelineParams(updatedItem);

    if (toStage === fromStage) {
      // Same-stage patch (e.g. re-approving an already-"approved" approved-work
      // item) — transition() would throw for stages with no self-loop, so use
      // upsert()'s same-stage patch rule instead. No event is written.
      // mergeMetadata: true — patch.metadata comes from queueItemToPipelineParams,
      // a fixed-partial-key-set codec (see its docstring); merging preserves
      // foreign metadata another producer wrote instead of wiping it on every
      // approve() call (fable-remediation b1/b2).
      repo.upsert({ id, stage: fromStage, ...patch }, { actor, mergeMetadata: true });
    } else {
      // mergeMetadata: true — same rationale as the same-stage branch above.
      repo.transition(id, toStage, { patch, actor, note, mergeMetadata: true });
    }

    const lucidTaskId = updatedItem.payload?.context?.lucidTaskId as string | undefined;
    if (lucidTaskId) {
      await this.syncToLucid(lucidTaskId, newStatus, item.queue, id);
    }

    // Capture approval decision to memory — awaited so the write is durable
    // before approve() returns (previously two un-awaited fire-and-forget
    // capture() calls could double-write, and both could land after the
    // caller/test had already moved on). Never silent: a capture failure is
    // recorded to the central failure log (tier "log") rather than swallowed,
    // and never fails the approve operation itself.
    try {
      await memoryStore.capture({
        type: 'decision',
        category: 'queue-approval',
        title: `Queue approve: ${item.payload.title || item.id}`,
        content: JSON.stringify({
          itemId: item.id,
          queue: item.queue,
          action: 'approve',
          reason: options?.notes,
          reviewer: options?.reviewer,
        }),
        tags: ['queuerouter', 'approve', item.queue],
        tier: 'warm',
        source: 'QueueRouter/QueueManager',
      });
    } catch (err) {
      recordFailure({ source: "QueueManager.approve", error: err, context: { itemId: id }, tier: "log" });
    }

    // Sync state after approve
    const state = loadState();
    state.stats.lastProcessedAt = new Date().toISOString();
    await saveState(state);

    // Auto-promote from approvals -> approved-work (spec already validated above)
    if (item.queue === "approvals") {
      await this.transfer(id, {
        targetQueue: "approved-work",
        status: "pending",
        notes: "Auto-promoted on approval",
        transferredBy: options?.reviewer,
      });
      // Phase 4b: importToWorkQueue removed — transfer() already writes the item to
      // pipeline.db with stage="approved" via the Phase 2 facade, so WorkQueue's
      // claimParallelBatch can see it immediately. No copy-handoff needed.
      return await this.get(id);
    }

    // Items approved directly in approved-work are now actionable — pipeline.db
    // already has the row at stage="approved"; no importToWorkQueue needed.

    return await this.get(id);
  }

  /**
   * Reject an item (for approval queue) — O(1) via primary-key repo.get(id) +
   * a single repo.transition() call to "rejected", replacing the old
   * load-ALL/save-ALL full-queue rewrite (slice A4).
   */
  async reject(id: string, options?: { reason?: string; reviewer?: string }): Promise<QueueItem | null> {
    const repo = getRepoForQueuesDir(getQueuesDir());
    const pipelineItem = repo.get(id);
    if (!pipelineItem || pipelineItem.stage === "archived") return null;

    const item = pipelineItemToQueueItem(pipelineItem);
    if (!item) return null;

    const nowIso = new Date().toISOString();
    const updatedItem: QueueItem = {
      ...item,
      status: "rejected",
      updated: nowIso,
      result: {
        ...item.result,
        completedAt: nowIso,
        error: options?.reason,
        reviewer: options?.reviewer,
      },
    };

    const actor = "QueueManager.reject";
    const note = options?.reason ?? (options?.reviewer ? `reject:${options.reviewer}` : "reject");

    const { stage: _stage, created_at: _createdAt, updated_at: _updatedAt, id: _pid, ...patch } =
      queueItemToPipelineParams(updatedItem);

    // mergeMetadata: true — patch.metadata comes from queueItemToPipelineParams,
    // a fixed-partial-key-set codec; merging preserves foreign metadata another
    // producer wrote instead of wiping it on rejection (fable-remediation b1/b2).
    repo.transition(id, "rejected", { patch, actor, note, mergeMetadata: true });

    // Capture rejection decision to memory — awaited so the write is durable
    // before reject() returns (previously two un-awaited fire-and-forget
    // capture() calls could double-write, and both could land after the
    // caller/test had already moved on). Never silent: a capture failure is
    // recorded to the central failure log (tier "log") rather than swallowed,
    // and never fails the reject operation itself.
    try {
      await memoryStore.capture({
        type: 'decision',
        category: 'queue-rejection',
        title: `Queue reject: ${item.payload.title || item.id}`,
        content: JSON.stringify({
          itemId: item.id,
          queue: item.queue,
          action: 'reject',
          reason: options?.reason,
          reviewer: options?.reviewer,
        }),
        tags: ['queuerouter', 'reject', item.queue],
        tier: 'warm',
        source: 'QueueRouter/QueueManager',
      });
    } catch (err) {
      recordFailure({ source: "QueueManager.reject", error: err, context: { itemId: id }, tier: "log" });
    }

    // Sync state after reject
    const state = loadState();
    state.stats.totalProcessed++;
    state.stats.lastProcessedAt = new Date().toISOString();
    await saveState(state);

    return await this.get(id);
  }

  /**
   * Remove an item
   */
  async remove(id: string): Promise<boolean> {
    // Resolve queue via primary-key repo lookup
    const repo = getRepoForQueuesDir(getQueuesDir());
    const pipelineItem = repo.get(id);

    if (pipelineItem?.queue) {
      const items = loadQueueItems(pipelineItem.queue);
      const index = items.findIndex((i) => i.id === id);
      if (index !== -1) {
        items.splice(index, 1);
        saveQueueItems(pipelineItem.queue, items);
        return true;
      }
    }

    // Fallback full scan (repo and JSONL shadow may transiently diverge)
    const queues = discoverQueues();
    for (const q of queues) {
      const items = loadQueueItems(q);
      const index = items.findIndex((i) => i.id === id);
      if (index !== -1) {
        items.splice(index, 1);
        saveQueueItems(q, items);
        return true;
      }
    }

    return false;
  }

  /**
   * Get queue statistics
   */
  async stats(queueName?: string): Promise<QueueStats> {
    const items = await this.list({ queue: queueName });

    const stats: QueueStats = {
      total: items.length,
      pending: 0,
      inProgress: 0,
      awaitingApproval: 0,
      completed: 0,
      failed: 0,
      byQueue: {},
      byPriority: { 1: 0, 2: 0, 3: 0 },
    };

    for (const item of items) {
      // Status counts
      switch (item.status) {
        case "pending":
          stats.pending++;
          break;
        case "in_progress":
        // execution-phase statuses derived from stage — count as in-progress
        case "partial":
        case "needs_review":
        case "blocked":
          stats.inProgress++;
          break;
        case "awaiting_approval":
          stats.awaitingApproval++;
          break;
        case "completed":
        case "approved":
          stats.completed++;
          break;
        case "failed":
        case "rejected":
          stats.failed++;
          break;
      }

      // Queue counts
      stats.byQueue[item.queue] = (stats.byQueue[item.queue] || 0) + 1;

      // Priority counts
      stats.byPriority[item.priority]++;
    }

    return stats;
  }

  /**
   * Cleanup old terminal items (completed/failed/rejected) with archive-before-delete.
   * Items are archived to MEMORY/QUEUES/archive/{queueName}-archive.jsonl
   * before being removed from active queue files.
   *
   * Only statuses in ARCHIVABLE_TERMINAL_STATUSES are ever archived — live
   * working statuses (needs-grilling, awaiting-context, researching, …) are
   * always kept regardless of age.
   *
   * @param deps.releaseBacklinks - injectable for tests; defaults to releaseLucidTaskBacklinks
   */
  async cleanup(
    daysOld: number = 30,
    deps?: { releaseBacklinks?: (items: QueueItem[]) => Promise<number> },
  ): Promise<{ removed: number; archived: number }> {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - daysOld);

    let removed = 0;
    let archived = 0;
    const queues = discoverQueues();
    const allArchived: QueueItem[] = [];

    for (const queueName of queues) {
      const items = loadQueueItems(queueName);
      const keep: QueueItem[] = [];
      const toArchive: QueueItem[] = [];

      for (const item of items) {
        if (!ARCHIVABLE_TERMINAL_STATUSES.has(item.status)) {
          keep.push(item);
          continue;
        }

        const itemDate = new Date(item.result?.completedAt || item.updated);
        if (itemDate < cutoff) {
          toArchive.push(item);
        } else {
          keep.push(item);
        }
      }

      if (toArchive.length > 0) {
        // Archive FIRST (safe on crash — worst case is duplicate in archive)
        archiveItems(queueName, toArchive);
        archived += toArchive.length;
        removed += toArchive.length;
        // Rewrite active file without archived items
        saveQueueItems(queueName, keep);
        allArchived.push(...toArchive);
      }
    }

    // Release LucidTask back-links so archived items can't orphan their tasks
    // (triage skips any task whose queue_item_id is still set).
    if (allArchived.length > 0) {
      const release = deps?.releaseBacklinks ?? releaseLucidTaskBacklinks;
      await release(allArchived);
    }

    // Record cleanup timestamp in state for debounce
    const state = loadState();
    state.lastCleanupAt = new Date().toISOString();
    await saveState(state);

    return { removed, archived };
  }

  /**
   * Debounced cleanup wrapper — skips if last cleanup was < 6 hours ago.
   * Safe to call on every session start with negligible overhead on skip.
   */
  async maybeCleanup(): Promise<{ removed: number; archived: number } | null> {
    const state = loadState();

    if (state.lastCleanupAt) {
      const lastCleanup = new Date(state.lastCleanupAt).getTime();
      const sixHoursMs = 6 * 60 * 60 * 1000;
      if (Date.now() - lastCleanup < sixHoursMs) {
        return null; // Debounce: too recent
      }
    }

    return this.cleanup();
  }

  /**
   * Add an item directly to the approved-work queue
   *
   * This method enforces the hard constraint that items in approved-work
   * must have an approved grounded spec. Use WorkPromoter.promoteToApprovedWork()
   * for the standard workflow from approvals → approved-work.
   *
   * @param payload - The item payload (title, description, context)
   * @param spec - Required spec linkage with approved grounded spec
   * @param options - Additional options
   */
  async addApprovedWork(
    payload: { title: string; description: string; context?: Record<string, unknown> },
    spec: QueueItemSpec,
    options: Omit<AddOptions, "queue"> = {}
  ): Promise<string> {
    // Validate spec has required fields
    if (!spec.id || !spec.path || spec.status !== "approved") {
      throw new Error(
        "Invalid spec: must have id, path, and status='approved'. " +
        "Use WorkPromoter.promoteToApprovedWork() for the standard workflow."
      );
    }

    const item: QueueItem = {
      id: generateId(),
      created: new Date().toISOString(),
      updated: new Date().toISOString(),
      source: options.source || "direct",
      priority: options.priority || 2,
      status: "pending",
      type: options.type || "task",
      queue: "approved-work",
      payload: {
        title: payload.title,
        description: payload.description,
        context: payload.context || options.context,
      },
      spec,
      routing: {
        targetQueue: "approved-work",
      },
    };

    appendQueueItem("approved-work", item);

    // Update state
    const state = loadState();
    if (!state.queues.includes("approved-work")) {
      state.queues.push("approved-work");
    }
    state.stats.totalItems++;
    await saveState(state);

    return item.id;
  }

  /**
   * Update an item's spec linkage
   *
   * @param id - The item ID
   * @param spec - The spec data to set
   */
  async setSpec(id: string, spec: QueueItemSpec): Promise<QueueItem | null> {
    const queues = discoverQueues();

    for (const queueName of queues) {
      const items = loadQueueItems(queueName);
      const index = items.findIndex((i) => i.id === id);

      if (index !== -1) {
        items[index].spec = spec;
        items[index].updated = new Date().toISOString();
        saveQueueItems(queueName, items);
        return items[index];
      }
    }

    return null;
  }

  // ==========================================================================
  // Progress Tracking Methods
  // ==========================================================================

  /**
   * Initialize progress tracking for an item
   *
   * @param id - The item ID
   * @param totalPhases - Total number of phases in the spec
   */
  async initProgress(id: string, totalPhases: number): Promise<QueueItem | null> {
    const queues = discoverQueues();

    for (const queueName of queues) {
      const items = loadQueueItems(queueName);
      const index = items.findIndex((i) => i.id === id);

      if (index !== -1) {
        items[index].progress = {
          currentPhase: 1,
          totalPhases,
          phasesCompleted: [],
          iscStatus: {},
          lastUpdated: new Date().toISOString(),
        };
        items[index].updated = new Date().toISOString();
        saveQueueItems(queueName, items);
        return items[index];
      }
    }

    return null;
  }

  /**
   * Set the current phase for an item
   *
   * @param id - The item ID
   * @param phase - The phase number to set as current
   */
  async setPhase(id: string, phase: number): Promise<QueueItem | null> {
    const queues = discoverQueues();

    for (const queueName of queues) {
      const items = loadQueueItems(queueName);
      const index = items.findIndex((i) => i.id === id);

      if (index !== -1) {
        if (!items[index].progress) {
          throw new Error(`Progress not initialized for item ${id}. Call initProgress first.`);
        }
        if (phase < 1 || phase > items[index].progress!.totalPhases) {
          throw new Error(`Phase ${phase} out of range (1-${items[index].progress!.totalPhases})`);
        }

        items[index].progress!.currentPhase = phase;
        items[index].progress!.lastUpdated = new Date().toISOString();
        items[index].updated = new Date().toISOString();
        saveQueueItems(queueName, items);
        return items[index];
      }
    }

    return null;
  }

  /**
   * Mark a phase as complete
   *
   * @param id - The item ID
   * @param phase - The phase number that was completed
   */
  async completePhase(id: string, phase: number): Promise<QueueItem | null> {
    const queues = discoverQueues();

    for (const queueName of queues) {
      const items = loadQueueItems(queueName);
      const index = items.findIndex((i) => i.id === id);

      if (index !== -1) {
        if (!items[index].progress) {
          throw new Error(`Progress not initialized for item ${id}. Call initProgress first.`);
        }
        if (phase < 1 || phase > items[index].progress!.totalPhases) {
          throw new Error(`Phase ${phase} out of range (1-${items[index].progress!.totalPhases})`);
        }

        const progress = items[index].progress!;
        if (!progress.phasesCompleted.includes(phase)) {
          progress.phasesCompleted.push(phase);
          progress.phasesCompleted.sort((a, b) => a - b);
        }

        // Auto-advance current phase if this was the current one
        if (progress.currentPhase === phase && phase < progress.totalPhases) {
          progress.currentPhase = phase + 1;
        }

        progress.lastUpdated = new Date().toISOString();
        items[index].updated = new Date().toISOString();
        saveQueueItems(queueName, items);
        return items[index];
      }
    }

    return null;
  }

  /**
   * Update ISC criterion status
   *
   * @param id - The item ID
   * @param criterion - The ISC criterion key (description or ID string)
   * @param completed - Whether the criterion is completed
   * @param evidence - REQUIRED evidence of completion (PR link, test output, etc.)
   */
  async updateISC(
    id: string,
    criterion: string,
    completed: boolean,
    evidence: string
  ): Promise<QueueItem | null> {
    // Evidence is required for marking complete
    if (completed && (!evidence || evidence.trim() === "")) {
      throw new Error("Evidence is REQUIRED when marking an ISC criterion as completed");
    }

    const queues = discoverQueues();

    for (const queueName of queues) {
      const items = loadQueueItems(queueName);
      const index = items.findIndex((i) => i.id === id);

      if (index !== -1) {
        if (!items[index].progress) {
          throw new Error(`Progress not initialized for item ${id}. Call initProgress first.`);
        }

        const progress = items[index].progress!;
        progress.iscStatus[criterion] = {
          completed,
          completedAt: completed ? new Date().toISOString() : undefined,
          evidence: completed ? evidence : undefined,
        };

        progress.lastUpdated = new Date().toISOString();
        items[index].updated = new Date().toISOString();
        saveQueueItems(queueName, items);
        return items[index];
      }
    }

    return null;
  }

  /**
   * Get progress for an item
   *
   * @param item - The queue item
   * @returns Progress data or null if not tracked
   */
  getProgress(item: QueueItem): QueueItemProgress | null {
    return item.progress || null;
  }

  /**
   * Check if all phases are complete
   *
   * @param item - The queue item
   * @returns true if all phases completed
   */
  isFullyComplete(item: QueueItem): boolean {
    if (!item.progress) return false;
    const { phasesCompleted, totalPhases } = item.progress;
    return phasesCompleted.length === totalPhases;
  }

  /**
   * Get count of completed ISC criteria
   *
   * @param item - The queue item
   * @returns Object with completed and total counts
   */
  getISCProgress(item: QueueItem): { completed: number; total: number } {
    if (!item.progress) return { completed: 0, total: 0 };
    const entries = Object.values(item.progress.iscStatus);
    return {
      completed: entries.filter((e) => e.completed).length,
      total: entries.length,
    };
  }

  /**
   * Transfer an item from one queue to another, preserving its ID and all metadata.
   *
   * O(1) via primary-key repo.get(id) — replaces the old discoverQueues() +
   * per-queue loadQueueItems() scan to locate the item, plus the O(n)
   * full-source-queue saveQueueItems() rewrite (slice A4).
   *
   * The queue move is ALWAYS written via repo.upsert({ id, stage: toStage, ...patch }),
   * never repo.transition(). Two reasons:
   *   - Same-stage moves (e.g. approvals "approved" → approved-work "approved" — both
   *     derive to stage "approved", see PipelineFacade.deriveStage) need upsert()'s
   *     same-stage patch rule anyway: transition() throws for stages with no
   *     self-loop in ALLOWED_TRANSITIONS.
   *   - Cross-stage moves must NOT hard-enforce ALLOWED_TRANSITIONS. Pre-A4, transfer()
   *     went through saveQueueItems()/appendQueueItem(), which bottom out in
   *     repo.upsert()'s shadow mode: legal crossings write a "shadow-legal" event,
   *     ILLEGAL crossings still write (audited as "shadow-illegal" + recordFailure)
   *     rather than throwing. This is a deliberate, documented codebase pattern (see
   *     ApprovalsStageClamp.test.ts) — transfer() is used both by the spec-pipeline
   *     state machine (where crossings are expected to be legal) AND by manual/CLI
   *     moves (CLI.ts's `queue transfer`) that intentionally bypass state-machine
   *     enforcement. Using repo.transition() here regressed that: it throws on any
   *     crossing not already in ALLOWED_TRANSITIONS, breaking real call sites (caught
   *     by SpecPipelineE2E.test.ts — a direct researching→approvals move, which the
   *     pre-A4 code allowed and the enforced version rejected).
   *
   * @param id - The item ID to transfer
   * @param options - Transfer options including target queue and optional overrides
   * @returns The transferred item in its new queue, or null if not found
   */
  async transfer(id: string, options: TransferOptions): Promise<QueueItem | null> {
    const repo = getRepoForQueuesDir(getQueuesDir());
    const pipelineItem = repo.get(id);
    if (!pipelineItem || pipelineItem.stage === "archived") return null;

    const item = pipelineItemToQueueItem(pipelineItem);
    if (!item) return null;

    const sourceQueue = item.queue;

    // Prevent no-op transfers
    if (sourceQueue === options.targetQueue) {
      throw new Error(`Item ${id} is already in queue "${options.targetQueue}"`);
    }

    const nowIso = new Date().toISOString();
    const updatedItem: QueueItem = {
      ...item,
      queue: options.targetQueue,
      updated: nowIso,
      routing: {
        ...item.routing,
        sourceQueue,
        targetQueue: options.targetQueue,
      },
    };

    // Apply optional overrides
    if (options.status) {
      updatedItem.status = options.status;
    }
    if (options.priority) {
      updatedItem.priority = options.priority;
    }
    if (options.notes) {
      updatedItem.result = {
        ...updatedItem.result,
        reviewNotes: options.notes,
      };
    }
    if (options.transferredBy) {
      updatedItem.result = {
        ...updatedItem.result,
        reviewer: options.transferredBy,
      };
    }

    const toStage = deriveStage(updatedItem.status, updatedItem.queue);
    const actor = "QueueManager.transfer";

    const { stage: _stage, created_at: _createdAt, updated_at: _updatedAt, id: _pid, ...patch } =
      queueItemToPipelineParams(updatedItem);

    // Uniform upsert — never transition(). Same-stage moves hit upsert()'s
    // same-stage patch rule (no event); cross-stage moves hit upsert()'s
    // shadow-mode crossing classification (shadow-legal/shadow-illegal event,
    // never a throw). { enforce: false } is REQUIRED here post-flip (upsert()'s
    // default is now enforce) to preserve that never-a-throw guarantee. See
    // docstring above.
    // mergeMetadata: true — patch.metadata comes from queueItemToPipelineParams,
    // a fixed-partial-key-set codec; merging preserves foreign metadata another
    // producer wrote instead of wiping it on every cross-queue transfer
    // (fable-remediation b1/b2).
    repo.upsert({ id, stage: toStage, ...patch }, { actor, enforce: false, mergeMetadata: true });

    const lucidTaskId = updatedItem.payload?.context?.lucidTaskId as string | undefined;
    if (lucidTaskId) {
      await this.syncToLucid(lucidTaskId, updatedItem.status, options.targetQueue, id);
    }

    // Emit trace on transfer — never silent: a capture failure is recorded to
    // the central failure log (tier "log") rather than swallowed outright.
    memoryStore.capture({
      source: "QueueRouter/QueueManager",
      type: "decision",
      title: `Queue transfer: ${updatedItem.payload.title || id}`,
      content: JSON.stringify({ itemId: id, from: sourceQueue, to: options.targetQueue, status: updatedItem.status }),
      tags: ["queuerouter", "transfer", sourceQueue, options.targetQueue],
    }).catch((err) => recordFailure({ source: "QueueManager.transfer", error: err, context: { itemId: id, sourceQueue, targetQueue: options.targetQueue }, tier: "log" }));

    // Update state if target queue is new
    const state = loadState();
    if (!state.queues.includes(options.targetQueue)) {
      state.queues.push(options.targetQueue);
    }
    await saveState(state);

    return await this.get(id);
  }

  /**
   * Recompute stats by scanning all JSONL files for actual counts.
   * This is the source of truth — fixes any drift between state.json and reality.
   */
  async recomputeStats(): Promise<QueueState> {
    const queues = discoverQueues();
    let totalItems = 0;
    let totalProcessed = 0;
    let lastProcessedAt: string | undefined;

    for (const queueName of queues) {
      const items = loadQueueItems(queueName);
      totalItems += items.length;

      for (const item of items) {
        if (["completed", "failed", "rejected"].includes(item.status)) {
          totalProcessed++;
          const processedAt = item.result?.completedAt || item.updated;
          if (processedAt && (!lastProcessedAt || processedAt > lastProcessedAt)) {
            lastProcessedAt = processedAt;
          }
        }
      }
    }

    const state: QueueState = {
      lastUpdated: new Date().toISOString(),
      queues,
      stats: {
        totalItems,
        totalProcessed,
        ...(lastProcessedAt ? { lastProcessedAt } : {}),
      },
    };

    await saveState(state);
    return state;
  }

  /**
   * Persist state (called by hooks) — now uses recomputeStats for accuracy
   */
  async persist(): Promise<void> {
    await this.recomputeStats();
  }

  /**
   * Boost an item's priority (only raises, never lowers).
   * Lower number = higher priority (1 = HIGH, 2 = NORMAL, 3 = LOW).
   */
  boostPriority(id: string, newPriority: Priority): QueueItem | null {
    // Search all queues for the item
    for (const queueName of discoverQueues()) {
      const items = loadQueueItems(queueName);
      const item = items.find(i => i.id === id);
      if (item) {
        // Only boost (lower number = higher priority)
        if (newPriority < item.priority) {
          item.priority = newPriority;
          item.updated = new Date().toISOString();
          saveQueueItems(queueName, items);
          return item;
        }
        return item; // Already at same or higher priority
      }
    }
    return null;
  }

  /**
   * Add an item directly to the spec-pipeline queue.
   *
   * Items must start in "awaiting-context" status. Statuses in the
   * spec-pipeline have their own valid set and transition rules —
   * they are not the same as the standard QueueItemStatus set.
   *
   * @param payload - Title, description, and optional context
   * @param options - Queue options (source, priority, type, context)
   * @returns The new item ID
   */
  async addSpecPipelineItem(
    payload: { title: string; description: string; context?: Record<string, unknown> },
    options: Omit<AddOptions, "queue"> = {}
  ): Promise<string> {
    // Dedup: exact-title match against spec-pipeline, approvals, and approved-work.
    // Fuzzy word-overlap matching was removed (Slice 1b): "are these the same task?"
    // is semantic judgment — silently blocking on a similarity guess hides legitimate
    // near-dup additions. Exact-title idempotency EARNS its place (deterministic
    // ground truth); semantic dedup belongs to the LLM routing layer.
    const pipelineItems = loadQueueItems("spec-pipeline");
    const approvalsItems = loadQueueItems("approvals");
    const normalizedTitle = payload.title.trim().toLowerCase();

    // Also check approved-work for recent items (completed/failed/blocked)
    const approvedWorkItems = loadQueueItems("approved-work");
    const allCandidates = [...pipelineItems, ...approvalsItems, ...approvedWorkItems];

    const duplicate = allCandidates.find((i) => {
      // Only skip completed items older than 90 days — everything else blocks duplicates
      if (i.status === "completed") {
        const completedAt = i.result?.completedAt || i.updated || i.created;
        if (completedAt) {
          const age = Date.now() - new Date(completedAt).getTime();
          if (age > 90 * 24 * 60 * 60 * 1000) return false; // 90-day expiry
        }
      }
      const candidateTitle = (i.payload.title || "").trim().toLowerCase();
      return candidateTitle === normalizedTitle;
    });

    if (duplicate) {
      console.log(
        `[spec-pipeline] Dedup: exact-title match — "${payload.title}" matches existing ${duplicate.id} in ${duplicate.queue || "spec-pipeline"} (status: ${duplicate.status})`
      );
      return duplicate.id;
    }

    const item: QueueItem = {
      id: options.id || generateId(),
      created: new Date().toISOString(),
      updated: new Date().toISOString(),
      source: options.source || "manual",
      priority: options.priority || 2,
      status: "awaiting-context",
      type: options.type || "task",
      queue: "spec-pipeline",
      payload: {
        title: payload.title,
        description: payload.description,
        context: payload.context || options.context,
      },
      routing: {
        targetQueue: "spec-pipeline",
      },
    };

    appendQueueItem("spec-pipeline", item);

    const state = loadState();
    if (!state.queues.includes("spec-pipeline")) {
      state.queues.push("spec-pipeline");
    }
    state.stats.totalItems++;
    await saveState(state);

    // Verdict-driven routing: trust the LLM classifier's judgment, not content heuristics.
    //
    // Routing rules (in priority order):
    //   1. verdict='clear'                           → advance to researching
    //   2. context.notes AND context.researchGuidance (caller-supplied) → advance to researching
    //   3. verdict='needs-grill' | 'not-executable'  → hold at awaiting-context
    //   4. absent verdict                             → hold at awaiting-context (safe default)
    //
    // "never auto-advance unknown items" is the invariant: the only time we skip
    // awaiting-context is when we have a positive, explicit signal to do so.
    const ctx = options.context ?? {};
    const hasExplicitContext = typeof ctx.notes === "string" && typeof ctx.researchGuidance === "string";
    const shouldAdvance = options.verdict === "clear" || hasExplicitContext;

    if (shouldAdvance) {
      const notes = typeof ctx.notes === "string" ? ctx.notes : payload.description;
      const guidance = typeof ctx.researchGuidance === "string"
        ? ctx.researchGuidance
        : `Verdict: clear — ready for research`;
      try {
        await this.attachContext(item.id, notes, guidance, undefined, { autoRouted: true });
        console.log(`[spec-pipeline] Advanced ${item.id} to researching (verdict: ${options.verdict ?? "explicit-context"})`);
      } catch (err) {
        console.error(`[spec-pipeline] Auto-advance failed for ${item.id}:`, err);
      }
    } else {
      console.log(`[spec-pipeline] ${item.id} held at awaiting-context (verdict: ${options.verdict ?? "absent"} — no auto-advance)`);
    }

    return item.id;
  }

  /**
   * Update the status of a spec-pipeline item, validating the transition.
   * Also supports attaching context metadata (notes, researchGuidance, etc.)
   * when transitioning to "researching".
   *
   * @param id - Item ID
   * @param newStatus - Target status
   * @param contextUpdates - Optional context fields to merge into payload.context
   * @param metadata - Optional metadata to merge (e.g., revisionCount)
   * @returns Updated item or null if not found
   */
  async updateSpecPipelineStatus(
    id: string,
    newStatus: string,
    contextUpdates?: Record<string, unknown>,
    metadata?: Record<string, unknown>
  ): Promise<QueueItem | null> {
    const items = loadQueueItems("spec-pipeline");
    const index = items.findIndex((i) => i.id === id);

    if (index === -1) {
      return null;
    }

    const item = items[index];
    const fromStatus = item.status;

    // A target that isn't a recognised spec-pipeline status is never a valid
    // spec-pipeline transition (e.g. execution statuses like "completed"/"pending"
    // would lossily map to "intake" via deriveStage and slip through). Reject it —
    // matches the old validateSpecPipelineTransition, which threw for any target
    // not in the from-status's allowed list. This check is orthogonal to stage
    // legality (below) — it validates newStatus even NAMES a spec-pipeline status
    // before asking the canonical enforcer to validate the crossing.
    const toStage = SPEC_STATUS_TO_STAGE[newStatus];
    if (toStage === undefined) {
      throw new Error(
        `Invalid spec-pipeline transition: "${fromStatus}" → "${newStatus}" ` +
        `(not a spec-pipeline status)`
      );
    }

    item.status = newStatus as QueueItemStatus;
    item.updated = new Date().toISOString();

    if (contextUpdates) {
      item.payload.context = {
        ...(item.payload.context || {}),
        ...contextUpdates,
      };
    }

    if (metadata) {
      // Store pipeline-specific metadata in payload.context under "_meta" key
      item.payload.context = {
        ...(item.payload.context || {}),
        _meta: {
          ...((item.payload.context?._meta as Record<string, unknown>) || {}),
          ...metadata,
        },
      };
    }

    // Atomic enforce + persist via the canonical transition() enforcer — replaces
    // the deleted hand-rolled CANONICAL_TRANSITIONS check + saveQueueItems array-resave
    // (which rewrote every sibling item in the queue on every single-item update).
    // transition() re-derives fromStage from the actual DB row (not the possibly-stale
    // in-memory item.status) and rolls back + throws on an illegal crossing, so there
    // is exactly one source of truth for transition legality.
    const repo = getRepoForQueuesDir(getQueuesDir());
    // "dependencies" is included in the patch — PipelineRepository.transition()'s
    // blobFields set now covers it (slice A4), so it round-trips as JSON like the
    // other blob fields instead of crashing bun:sqlite's binder.
    const { stage: _stage, created_at: _createdAt, updated_at: _updatedAt, id: _pid, ...patch } =
      queueItemToPipelineParams(item);
    try {
      // mergeMetadata: true — patch.metadata comes from queueItemToPipelineParams,
      // a fixed-partial-key-set codec; merging preserves foreign metadata another
      // producer wrote instead of wiping it on every spec-pipeline status update
      // (fable-remediation b1/b2).
      repo.transition(id, toStage, {
        patch,
        actor: "QueueManager.updateSpecPipelineStatus",
        mergeMetadata: true,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("illegal transition")) {
        const fromStage = SPEC_STATUS_TO_STAGE[fromStatus];
        const canonicalAllowed = fromStage ? CANONICAL_TRANSITIONS[fromStage] : undefined;
        throw new Error(
          `Invalid spec-pipeline transition: "${fromStatus}" → "${newStatus}". ` +
          `Allowed from "${fromStage}": [${canonicalAllowed?.join(", ") || "none (terminal)"}]`
        );
      }
      throw err;
    }

    const state = loadState();
    state.lastUpdated = new Date().toISOString();
    await saveState(state);

    return item;
  }

  /**
   * Attach context and research guidance to a spec-pipeline item,
   * then transition it to "researching" status.
   *
   * This is the programmatic equivalent of the `/queue context` CLI command.
   *
   * @param id - Item ID (must be in spec-pipeline with status "awaiting-context")
   * @param notes - Problem context / notes from Jm
   * @param researchGuidance - Research questions and direction
   * @param scopeHints - Optional scope constraints
   * @param options - Optional grill-findings passthrough (see AttachContextOptions)
   * @returns Updated item or null if not found
   */
  async attachContext(
    id: string,
    notes: string,
    researchGuidance: string,
    scopeHints?: string,
    options?: AttachContextOptions
  ): Promise<QueueItem | null> {
    const contextUpdates: Record<string, unknown> = {
      notes,
      researchGuidance,
      contextAttachedAt: new Date().toISOString(),
    };

    if (scopeHints) {
      contextUpdates.scopeHints = scopeHints;
    }

    // Grill-provided findings: record the artifact so runResearchPhase can
    // short-circuit the autonomous research spawn (the grill session already
    // did the research in-session). deepResearch explicitly opts back in.
    const metaExtras: Record<string, unknown> = {};
    if (options?.findingsPath) {
      metaExtras.researchArtifactPath = options.findingsPath;
      metaExtras.grillFindingsProvided = true;
    }
    if (options?.deepResearch) {
      metaExtras.deepResearchRequested = true;
    }

    // Grill completion is first-class state: the stamp marks "this content has
    // been grilled" so parkForGrill (and the daily backfill) can never demote
    // the item back to needs-grilling while title+description are unchanged.
    // IMPORTANT: only write the stamp when a human actually grilled this item.
    // Auto-routed items (verdict=clear) must NOT carry a grill stamp — the stamp
    // must assert a real human action, not a classifier decision.
    const item = await this.get(id);
    let stampMeta: Record<string, unknown> = {};
    if (options?.autoRouted) {
      // Auto-advance path: persist the flag so callers can distinguish
      // auto-routed items from human-grilled ones without regex inference.
      metaExtras.autoRouted = true;
    } else {
      // Real human grill finalization — write the content-hashed stamp.
      const grillStamp: GrillStamp | undefined = item
        ? {
            hash: computeGrillHash(item.payload.title, item.payload.description ?? ""),
            at: new Date().toISOString(),
          }
        : undefined;
      if (grillStamp) {
        stampMeta = { grillStamp };
      }
    }

    const metadata: Record<string, unknown> = {
      ...stampMeta,
      ...metaExtras,
    };

    return this.updateSpecPipelineStatus(
      id,
      "researching",
      contextUpdates,
      Object.keys(metadata).length > 0 ? metadata : undefined
    );
  }

  /**
   * Transfer a rejected approvals item back to spec-pipeline with feedback.
   * Increments revisionCount, sets status to "revision-needed" or "escalated"
   * if revisionCount >= 3.
   *
   * @param id - The item ID in the approvals queue
   * @param reason - Rejection reason / feedback
   * @param reviewer - Optional reviewer name
   * @returns The transferred item or null if not found
   */
  async rejectToSpecPipeline(
    id: string,
    reason: string,
    reviewer?: string
  ): Promise<QueueItem | null> {
    const item = await this.get(id);
    if (!item) return null;

    // First reject in current queue to track the rejection
    const items = loadQueueItems(item.queue);
    const index = items.findIndex((i) => i.id === id);

    if (index === -1) return null;

    // Get existing revisionCount from context._meta
    const existingMeta = (items[index].payload.context?._meta as Record<string, unknown>) || {};
    const currentRevisionCount = (existingMeta.revisionCount as number) || 0;
    const newRevisionCount = currentRevisionCount + 1;

    const isEscalated = newRevisionCount >= 3;
    const targetStatus = isEscalated ? "escalated" : "revision-needed";

    // Transfer to spec-pipeline with feedback
    // Bypass the canonical transition check — this is an external transfer from
    // approvals (not an internal pipeline transition), so stage-continuity rules
    // do not apply here.
    const deepCopied: QueueItem = JSON.parse(JSON.stringify(items[index]));
    deepCopied.queue = "spec-pipeline";
    deepCopied.status = targetStatus as QueueItemStatus;
    deepCopied.updated = new Date().toISOString();
    deepCopied.routing = {
      ...deepCopied.routing,
      sourceQueue: item.queue,
      targetQueue: "spec-pipeline",
    };
    deepCopied.result = {
      ...deepCopied.result,
      completedAt: new Date().toISOString(),
      reviewNotes: reason,
      reviewer,
    };
    deepCopied.payload.context = {
      ...(deepCopied.payload.context || {}),
      _meta: {
        ...existingMeta,
        revisionCount: newRevisionCount,
        lastRejectionReason: reason,
        lastRejectedAt: new Date().toISOString(),
        lastRejectedBy: reviewer,
      },
    };

    // Atomic: write target first, then remove from source
    appendQueueItem("spec-pipeline", deepCopied);
    items.splice(index, 1);
    saveQueueItems(item.queue, items);

    // Capture rejection-to-pipeline decision to memory
    memoryStore.capture({
      type: 'decision',
      category: 'queue-rejection-to-pipeline',
      title: `Queue reject-to-pipeline: ${item.payload.title || item.id}`,
      content: JSON.stringify({
        itemId: item.id,
        queue: item.queue,
        action: 'reject-to-pipeline',
        reason,
        reviewer,
        revisionCount: newRevisionCount,
        isEscalated,
      }),
      tags: ['queuerouter', 'reject-to-pipeline', item.queue],
      tier: 'warm',
      source: 'QueueRouter/QueueManager',
    }).catch(() => {});

    const state = loadState();
    if (!state.queues.includes("spec-pipeline")) {
      state.queues.push("spec-pipeline");
    }
    await saveState(state);

    return deepCopied;
  }

  /**
   * Transfer a rejected approvals item back to spec-pipeline with needs-grilling status.
   *
   * This is the "intent-change" feedback path: the user's underlying goal has
   * shifted and the spec needs re-grilling before it can be revised. The item
   * lands in spec-pipeline at "needs-grilling" with a grillBrief built from the
   * reviewer feedback, so it appears in `/queue grill`.
   *
   * @param id - The item ID in the approvals queue
   * @param feedback - The intent-change feedback from the reviewer
   * @param reviewer - Optional reviewer name
   * @returns The transferred item or null if not found
   */
  async rejectToGrill(
    id: string,
    feedback: string,
    reviewer?: string
  ): Promise<QueueItem | null> {
    const item = await this.get(id);
    if (!item) return null;

    const items = loadQueueItems(item.queue);
    const index = items.findIndex((i) => i.id === id);
    if (index === -1) return null;

    // Intent changed — any prior grill is stale, so drop its stamp: the item
    // must be re-grillable (and re-parkable) with the new intent.
    const { grillStamp: _staleGrillStamp, ...existingMeta } =
      (items[index].payload.context?._meta as Record<string, unknown>) || {};

    const grillBrief = {
      missing: [feedback],
      suggested_questions: [] as string[],
    };

    const deepCopied: QueueItem = JSON.parse(JSON.stringify(items[index]));
    deepCopied.queue = "spec-pipeline";
    deepCopied.status = "needs-grilling";
    deepCopied.updated = new Date().toISOString();
    deepCopied.routing = {
      ...deepCopied.routing,
      sourceQueue: item.queue,
      targetQueue: "spec-pipeline",
    };
    deepCopied.result = {
      ...deepCopied.result,
      completedAt: new Date().toISOString(),
      reviewNotes: feedback,
      reviewer,
    };
    deepCopied.payload.context = {
      ...(deepCopied.payload.context || {}),
      _meta: {
        ...existingMeta,
        grillBrief,
        intentChangeFeedback: feedback,
        intentChangeRejectedAt: new Date().toISOString(),
        intentChangeRejectedBy: reviewer,
      },
    };

    // Atomic: write target first, then remove from source
    appendQueueItem("spec-pipeline", deepCopied);
    items.splice(index, 1);
    saveQueueItems(item.queue, items);

    // Capture intent-change rejection to memory
    memoryStore.capture({
      type: 'decision',
      category: 'queue-rejection-to-grill',
      title: `Queue reject-to-grill: ${item.payload.title || item.id}`,
      content: JSON.stringify({
        itemId: item.id,
        queue: item.queue,
        action: 'reject-to-grill',
        feedback,
        reviewer,
      }),
      tags: ['queuerouter', 'reject-to-grill', item.queue],
      tier: 'warm',
      source: 'QueueRouter/QueueManager',
    }).catch(() => {});

    const state = loadState();
    if (!state.queues.includes("spec-pipeline")) {
      state.queues.push("spec-pipeline");
    }
    await saveState(state);

    return deepCopied;
  }

  /**
   * Approve the spec on a queue item (without approving the item itself).
   *
   * Use this after reviewing a draft spec generated by SpecPipelineRunner.
   * Once spec.status is "approved", the item can be approved via approve().
   *
   * @param id - Item ID (must have a spec with status "draft")
   * @param approvedBy - Who approved the spec (defaults to "Jm")
   * @returns Updated item or null if not found
   */
  async approveSpec(id: string, approvedBy: string = "Jm"): Promise<QueueItem | null> {
    const queues = discoverQueues();

    for (const queueName of queues) {
      const items = loadQueueItems(queueName);
      const index = items.findIndex((i) => i.id === id);

      if (index !== -1) {
        const item = items[index];

        if (!item.spec) {
          throw new Error(`Item "${item.payload.title}" has no spec attached.`);
        }
        if (item.spec.status === "approved") {
          throw new Error(`Spec for "${item.payload.title}" is already approved.`);
        }

        item.spec.status = "approved";
        item.spec.approvedAt = new Date().toISOString();
        item.spec.approvedBy = approvedBy;
        item.updated = new Date().toISOString();

        saveQueueItems(queueName, items);
        return item;
      }
    }

    return null;
  }

  /**
   * List items in the spec-pipeline queue, optionally filtered by status.
   *
   * @param status - Optional status filter (spec-pipeline statuses)
   * @returns Array of spec-pipeline items
   */
  async listSpecPipeline(status?: string): Promise<QueueItem[]> {
    let items = loadQueueItems("spec-pipeline");
    if (status) {
      items = items.filter((i) => i.status === status);
    }
    return items;
  }

  /**
   * Park a spec-pipeline item in `needs-grilling` status with a grill brief.
   *
   * The brief captures what information is missing and suggested questions for
   * Slice 3's interactive grill. Parked items are skipped by processAll() since
   * "needs-grilling" is not in the processable status set.
   *
   * @param id - Item ID (must be in spec-pipeline, pre-approval: awaiting-context,
   *   researching, generating-spec, or already needs-grilling)
   * @param brief - Grill brief: missing info + suggested questions + optional
   *   confidence. Optional verdict/reasoning carry the classifier's judgment
   *   (e.g. "not-executable") so the grill flow can show WHY it was parked.
   * @param opts.force - Override the grill-stamp guard. Only for human-driven
   *   callers (CLI) that explicitly want to re-grill already-grilled content.
   * @returns Updated item, or null if not found
   * @throws When the item carries a VALID grill stamp (content unchanged since
   *   grill finalize) and force is not set — a completed grill must never be
   *   demoted by automated re-triage (root cause of the 2026-06-11 Canvas v2
   *   demotion). A stale stamp (title/description edited) does not refuse.
   */
  async parkForGrill(
    id: string,
    brief: {
      missing: string[];
      suggested_questions: string[];
      confidence?: number;
      verdict?: string;
      reasoning?: string;
    },
    opts?: { force?: boolean }
  ): Promise<QueueItem | null> {
    if (!opts?.force) {
      const item = await this.get(id);
      if (item && hasValidGrillStamp(item)) {
        const meta = (item.payload.context?._meta as Record<string, unknown>) || {};
        const stamp = meta.grillStamp as GrillStamp;
        throw new Error(
          `parkForGrill refused: item ${id} has a valid grill stamp (grilled ${stamp.at}) — ` +
            `its grill answers are intact and it must not be re-parked. Pass {force:true} to override.`
        );
      }
    }
    return this.updateSpecPipelineStatus(id, "needs-grilling", undefined, {
      grillBrief: brief,
      parkedAt: new Date().toISOString(),
    });
  }

  /**
   * List spec-pipeline items parked for grill (status "needs-grilling"),
   * sorted by priority (1 = highest) then by created date ascending.
   *
   * @returns Sorted array of parked items
   */
  listParkedForGrill(): QueueItem[] {
    const items = loadQueueItems("spec-pipeline").filter(
      (i) => i.status === "needs-grilling"
    );
    items.sort((a, b) => {
      if (a.priority !== b.priority) {
        return a.priority - b.priority;
      }
      return new Date(a.created).getTime() - new Date(b.created).getTime();
    });
    return items;
  }

  /**
   * Get items from approvals queue that need specs
   *
   * Returns items that are:
   * - In the approvals queue
   * - Have status pending or awaiting_approval
   * - Do NOT have an approved spec linked
   *
   * @param options - Filter options
   * @returns Array of queue items needing specs
   */
  async getItemsNeedingSpecs(options: { includeWithDrafts?: boolean } = {}): Promise<QueueItem[]> {
    const items = loadQueueItems("approvals");

    return items.filter((item) => {
      // Only pending/awaiting_approval items
      if (item.status !== "pending" && item.status !== "awaiting_approval") {
        return false;
      }

      // No spec at all - definitely needs one
      if (!item.spec) {
        return true;
      }

      // Has spec but not approved - needs approval (include if we want drafts)
      if (item.spec.status !== "approved") {
        return options.includeWithDrafts ?? true;
      }

      // Has approved spec - doesn't need one
      return false;
    });
  }

  /**
   * Archive a single queue item by ID if it is in a pre-execution state.
   *
   * Pre-execution statuses (safe to archive without interrupting in-flight work):
   *   awaiting-context, needs-grilling, researching, generating-spec,
   *   revision-needed, escalated, pending, awaiting-approval, awaiting_approval
   *
   * Non-pre-execution contexts:
   *   - queue === "approved-work" (item may already be running)
   *   - status === "in_progress"
   *   - terminal statuses (completed, failed, rejected, approved)
   *
   * On success the item is stamped with `archiveReason` and `archivedAt` fields,
   * appended to MEMORY/QUEUES/archive/{queue}-archive.jsonl, and removed from
   * the source JSONL file using the safe tmp-then-rename pattern.
   *
   * @param itemId - The queue item ID to archive
   * @param reason - Human-readable archive reason (stored on the item)
   * @returns Result object indicating success/failure with explanation
   */
  async archiveItemById(
    itemId: string,
    reason: string,
  ): Promise<{ archived: boolean; queue?: string; status?: string; reason?: string }> {
    const queues = discoverQueues();

    for (const queueName of queues) {
      const items = loadQueueItems(queueName);
      const index = items.findIndex((i) => i.id === itemId);
      if (index === -1) continue;

      const item = items[index];

      // Gate 1: approved-work items may already be executing — never archive them here.
      if (queueName === "approved-work") {
        return {
          archived: false,
          queue: queueName,
          status: item.status,
          reason: `Item is in approved-work queue; cannot archive without confirming execution state`,
        };
      }

      // Gate 2: refuse items whose authoritative STAGE indicates in-flight or
      // terminal state. Stage is the single source of truth; checking the derived
      // status string directly is fragile across status vocabularies, so we map
      // back to the stage via deriveStage (the left-inverse of the read projection).
      const NON_PRE_EXEC_STAGES: ReadonlySet<Stage> = new Set<Stage>([
        "approved",
        "in-progress",
        "partial",
        "needs-review",
        "blocked",
        "done",
        "failed",
        "rejected",
      ]);
      const itemStage = deriveStage(item.status, queueName);
      if (NON_PRE_EXEC_STAGES.has(itemStage)) {
        return {
          archived: false,
          queue: queueName,
          status: item.status,
          reason: `Item stage "${itemStage}" is not a pre-execution state; archival refused`,
        };
      }

      // Stamp archival metadata onto the item before archiving.
      const itemToArchive: QueueItem & { archiveReason?: string; archivedAt?: string } =
        JSON.parse(JSON.stringify(item));
      itemToArchive.archiveReason = reason;
      itemToArchive.archivedAt = new Date().toISOString();
      itemToArchive.updated = new Date().toISOString();

      // Archive first (crash-safe: worst case is a duplicate in archive).
      archiveItems(queueName, [itemToArchive]);

      // Remove from source queue using safe rewrite.
      items.splice(index, 1);
      saveQueueItems(queueName, items);

      return { archived: true, queue: queueName, status: item.status };
    }

    return {
      archived: false,
      reason: `Item not found in any queue: ${itemId}`,
    };
  }
}
