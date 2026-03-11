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

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, readdirSync, renameSync } from "fs";
import { join, basename } from "path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { createStateManager, type StateManager } from "../../../../lib/core/StateManager.ts";
import { memoryStore } from "../../../../lib/core/MemoryStore.ts";
import { syncQueueStatus } from "../../../Productivity/LucidTasks/Tools/TaskManager.ts";

// ============================================================================
// Configuration
// ============================================================================

const KAYA_HOME = process.env.KAYA_HOME || join(process.env.HOME || "", ".claude");
const QUEUES_DIR = join(KAYA_HOME, "MEMORY/QUEUES");
const STATE_FILE = join(QUEUES_DIR, "state.json");
const ROUTING_RULES_FILE = join(KAYA_HOME, "skills/Automation/QueueRouter/RoutingRules.yaml");
const ARCHIVE_DIR = join(QUEUES_DIR, "archive");

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
  // spec-pipeline statuses
  | "awaiting-context"
  | "researching"
  | "generating-spec"
  | "revision-needed"
  | "escalated";

/**
 * Valid status transitions for the spec-pipeline queue.
 * Enforced by validateSpecPipelineTransition().
 */
export const SPEC_PIPELINE_TRANSITIONS: Record<string, readonly string[]> = {
  "awaiting-context": ["researching"],
  "researching": ["generating-spec"],
  "generating-spec": ["revision-needed", "awaiting-context"],
  "revision-needed": ["researching", "escalated"],
  "escalated": [], // terminal state — no auto-transitions
} as const;

/**
 * Validate a status transition for spec-pipeline items.
 * Returns null on success, or an error message string on failure.
 */
export function validateSpecPipelineTransition(
  fromStatus: string,
  toStatus: string
): string | null {
  const allowed = SPEC_PIPELINE_TRANSITIONS[fromStatus];
  if (allowed === undefined) {
    // fromStatus is not a spec-pipeline status — not our concern
    return null;
  }
  if (!allowed.includes(toStatus)) {
    return `Invalid spec-pipeline transition: "${fromStatus}" → "${toStatus}". Allowed: [${allowed.join(", ") || "none (terminal)"}]`;
  }
  return null;
}

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

/** AI-enriched metadata populated on approval queue intake */
export interface QueueItemEnrichment {
  /** Is this part of an existing project or new? */
  projectContext: "existing" | "new";
  /** Classification of the task type */
  taskType: "feature" | "new-app" | "bug" | "refactor" | "research";
  /** Estimated complexity level */
  complexity: "low" | "medium" | "high";
  /** Estimated effort required */
  effort: "hours" | "days" | "weeks";
  /** Questions to clarify for spec sheet creation */
  clarifyingQuestions: string[];
  /** Suggested spec template to use */
  suggestedTemplate: string;
  /** When enrichment was generated */
  enrichedAt: string;
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

  /** AI-enriched metadata - populated on approval queue intake */
  enrichment?: QueueItemEnrichment;

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
  autoSpec?: boolean;       // Override: force enable/disable auto enrichment+spec
  awaitAutoSpec?: boolean;  // When true, await the chain before returning (for CLI)
  /** Initial reviewer notes */
  notes?: string;
  /** Project configuration - where the work should be executed */
  project?: QueueItemProject;
  /** Attach an existing spec file — bypasses auto enrichment+spec generation */
  spec?: QueueItemSpec;
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

interface RoutingRule {
  pattern: string;
  queue: string;
  requiresApproval?: boolean;
  priority?: Priority;
  description?: string;
}

interface RoutingConfig {
  version: number;
  routes: RoutingRule[];
  defaults: {
    priority: Priority;
    expiryDays: number;
    notifyOnAdd?: boolean;
    notifyOnComplete?: boolean;
  };
  queues?: Record<string, {
    description?: string;
    autoProcess?: boolean;
    expiryDays?: number;
    defaultAgents?: number;
    enrichOnAdd?: boolean;
    requiresSpec?: boolean;
  }>;
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

// StateManager instance for global queue state
const queueStateManager: StateManager<QueueState> = createStateManager({
  path: STATE_FILE,
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

// ============================================================================
// Helper Functions
// ============================================================================

function ensureDir(dirPath: string): void {
  if (!existsSync(dirPath)) {
    mkdirSync(dirPath, { recursive: true });
  }
}

/**
 * Archive queue items to per-queue archive JSONL files.
 * Path: MEMORY/QUEUES/archive/{queueName}-archive.jsonl
 * Uses appendFileSync for crash-safe append-only writes.
 */
export function archiveItems(queueName: string, items: QueueItem[]): void {
  if (items.length === 0) return;
  ensureDir(ARCHIVE_DIR);
  const archivePath = join(ARCHIVE_DIR, `${queueName}-archive.jsonl`);
  const content = items.map((item) => JSON.stringify(item)).join("\n") + "\n";
  appendFileSync(archivePath, content);
}

export function generateId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 8);
  return `${timestamp}-${random}`;
}

export function getQueueFilePath(queueName: string): string {
  return join(QUEUES_DIR, `${queueName}.jsonl`);
}

function loadRoutingConfig(): RoutingConfig {
  if (!existsSync(ROUTING_RULES_FILE)) {
    return {
      version: 1,
      routes: [{ pattern: "*", queue: "approvals", priority: 2, requiresApproval: true }],
      defaults: { priority: 2, expiryDays: 30 },
    };
  }

  const content = readFileSync(ROUTING_RULES_FILE, "utf-8");
  return parseYaml(content) as RoutingConfig;
}

function matchPattern(pattern: string, input: string): boolean {
  // Simple glob matching
  if (pattern === "*") return true;
  if (pattern.endsWith("*")) {
    const prefix = pattern.slice(0, -1);
    return input.startsWith(prefix);
  }
  return pattern === input;
}

function routeItem(typeOrTitle: string): { queue: string; priority: Priority; requiresApproval: boolean } {
  const config = loadRoutingConfig();

  for (const rule of config.routes) {
    if (matchPattern(rule.pattern, typeOrTitle)) {
      return {
        queue: rule.queue,
        priority: rule.priority ?? config.defaults.priority,
        requiresApproval: rule.requiresApproval ?? false,
      };
    }
  }

  return {
    queue: "approvals",
    priority: config.defaults.priority,
    requiresApproval: true,
  };
}

export function loadQueueItems(queueName: string): QueueItem[] {
  const filePath = getQueueFilePath(queueName);
  if (!existsSync(filePath)) {
    return [];
  }

  const content = readFileSync(filePath, "utf-8");
  const lines = content.trim().split("\n").filter(Boolean);
  let droppedLines = 0;

  const items = lines.map((line, index) => {
    try {
      return JSON.parse(line) as QueueItem;
    } catch (err) {
      droppedLines++;
      console.error(`[QueueManager] Corrupt JSONL line ${index + 1} in ${queueName}.jsonl: ${err instanceof Error ? err.message : err}`);
      return null;
    }
  }).filter((item): item is QueueItem => item !== null);

  if (droppedLines > 0) {
    console.error(`[QueueManager] WARNING: Dropped ${droppedLines} corrupt line(s) from ${queueName}.jsonl (${items.length} valid items loaded)`);
  }

  return items;
}

export function saveQueueItems(queueName: string, items: QueueItem[]): void {
  ensureDir(QUEUES_DIR);
  const filePath = getQueueFilePath(queueName);
  const content = items.map((item) => JSON.stringify(item)).join("\n");
  const tmpPath = filePath + ".tmp." + process.pid;
  writeFileSync(tmpPath, content + (content ? "\n" : ""));
  renameSync(tmpPath, filePath);
}

export function appendQueueItem(queueName: string, item: QueueItem): void {
  ensureDir(QUEUES_DIR);
  const filePath = getQueueFilePath(queueName);
  appendFileSync(filePath, JSON.stringify(item) + "\n");
}

/**
 * Load global queue state using CORE StateManager
 * Synchronous wrapper for CLI compatibility
 */
function loadState(): QueueState {
  // Use sync read for CLI commands (StateManager.load is async)
  if (!existsSync(STATE_FILE)) {
    return {
      lastUpdated: new Date().toISOString(),
      queues: [],
      stats: { totalItems: 0, totalProcessed: 0 },
    };
  }

  try {
    const raw = readFileSync(STATE_FILE, "utf-8");
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
 * Save global queue state using CORE StateManager
 */
async function saveStateAsync(state: QueueState): Promise<void> {
  await queueStateManager.save(state);
}

/**
 * Synchronous state save for compatibility
 */
function saveState(state: QueueState): void {
  ensureDir(QUEUES_DIR);
  state.lastUpdated = new Date().toISOString();
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function discoverQueues(): string[] {
  ensureDir(QUEUES_DIR);
  const files = readdirSync(QUEUES_DIR);
  return files
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => basename(f, ".jsonl"));
}

// ============================================================================
// QueueManager Class
// ============================================================================

export class QueueManager {
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
    saveState(state);

    return item.id;
  }

  /**
   * Get a specific item by ID
   */
  async get(id: string): Promise<QueueItem | null> {
    const queues = discoverQueues();

    for (const queueName of queues) {
      const items = loadQueueItems(queueName);
      const item = items.find((i) => i.id === id);
      if (item) return item;
    }

    return null;
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
        saveState(state);

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
        try { syncQueueStatus(lucidTaskId, items[index].status); } catch {}
      }

      // Update state
      const state = loadState();
      state.stats.totalProcessed++;
      state.stats.lastProcessedAt = new Date().toISOString();
      saveState(state);

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
      saveState(state);

      return items[index];
    }

    return null;
  }

  /**
   * Approve an item (for approval queue)
   */
  async approve(id: string, options?: { notes?: string; reviewer?: string }): Promise<QueueItem | null> {
    const item = await this.get(id);
    if (!item) return null;

    const items = loadQueueItems(item.queue);
    const index = items.findIndex((i) => i.id === id);

    if (index !== -1) {
      // For items in approvals queue: require approved spec before allowing approval
      if (item.queue === "approvals") {
        if (!items[index].spec || items[index].spec!.status !== "approved") {
          throw new Error(
            `Cannot approve item "${items[index].payload.title}" — no approved spec. ` +
            `Use /queue review to create and approve a spec first.`
          );
        }
      }

      // Items in approved-work need status "pending" to be actionable by AutonomousWork.
      // Items in other queues (e.g. approvals) get "approved" to indicate review completion.
      items[index].status = item.queue === "approved-work" ? "pending" : "approved";
      items[index].updated = new Date().toISOString();
      items[index].result = {
        ...items[index].result,
        approvedAt: new Date().toISOString(),
        reviewNotes: options?.notes,
        reviewer: options?.reviewer,
      };

      saveQueueItems(item.queue, items);

      const lucidTaskId = items[index].payload?.context?.lucidTaskId as string | undefined;
      if (lucidTaskId) {
        try { syncQueueStatus(lucidTaskId, items[index].status); } catch {}
      }

      // Capture approval decision to memory
      memoryStore.capture({
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
      }).catch(() => {});

      // Sync state after approve
      const state = loadState();
      state.stats.lastProcessedAt = new Date().toISOString();
      saveState(state);

      // Auto-promote from approvals -> approved-work (spec already validated above)
      if (item.queue === "approvals") {
        await this.transfer(id, {
          targetQueue: "approved-work",
          status: "pending",
          notes: "Auto-promoted on approval",
          transferredBy: options?.reviewer,
        });
        return await this.get(id);
      }

      return items[index];
    }

    return null;
  }

  /**
   * Reject an item (for approval queue)
   */
  async reject(id: string, options?: { reason?: string; reviewer?: string }): Promise<QueueItem | null> {
    const item = await this.get(id);
    if (!item) return null;

    const items = loadQueueItems(item.queue);
    const index = items.findIndex((i) => i.id === id);

    if (index !== -1) {
      items[index].status = "rejected";
      items[index].updated = new Date().toISOString();
      items[index].result = {
        ...items[index].result,
        completedAt: new Date().toISOString(),
        error: options?.reason,
        reviewer: options?.reviewer,
      };

      saveQueueItems(item.queue, items);

      // Capture rejection decision to memory
      memoryStore.capture({
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
      }).catch(() => {});

      // Sync state after reject
      const state = loadState();
      state.stats.totalProcessed++;
      state.stats.lastProcessedAt = new Date().toISOString();
      saveState(state);

      return items[index];
    }

    return null;
  }

  /**
   * Remove an item
   */
  async remove(id: string): Promise<boolean> {
    const queues = discoverQueues();

    for (const queueName of queues) {
      const items = loadQueueItems(queueName);
      const index = items.findIndex((i) => i.id === id);

      if (index !== -1) {
        items.splice(index, 1);
        saveQueueItems(queueName, items);
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
   * Cleanup old completed/failed items with archive-before-delete.
   * Items are archived to MEMORY/QUEUES/archive/{queueName}-archive.jsonl
   * before being removed from active queue files.
   */
  async cleanup(daysOld: number = 30): Promise<{ removed: number; archived: number }> {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - daysOld);

    let removed = 0;
    let archived = 0;
    const queues = discoverQueues();

    for (const queueName of queues) {
      const items = loadQueueItems(queueName);
      const keep: QueueItem[] = [];
      const toArchive: QueueItem[] = [];

      for (const item of items) {
        if (item.status === "pending" || item.status === "in_progress" || item.status === "awaiting_approval") {
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
      }
    }

    // Record cleanup timestamp in state for debounce
    const state = loadState();
    state.lastCleanupAt = new Date().toISOString();
    saveState(state);

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
    saveState(state);

    return item.id;
  }

  /**
   * Update an item's enrichment data
   *
   * @param id - The item ID
   * @param enrichment - The enrichment data to set
   */
  async setEnrichment(id: string, enrichment: QueueItemEnrichment): Promise<QueueItem | null> {
    const queues = discoverQueues();

    for (const queueName of queues) {
      const items = loadQueueItems(queueName);
      const index = items.findIndex((i) => i.id === id);

      if (index !== -1) {
        items[index].enrichment = enrichment;
        items[index].updated = new Date().toISOString();
        saveQueueItems(queueName, items);
        return items[index];
      }
    }

    return null;
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
   * @param id - The item ID to transfer
   * @param options - Transfer options including target queue and optional overrides
   * @returns The transferred item in its new queue, or null if not found
   */
  async transfer(id: string, options: TransferOptions): Promise<QueueItem | null> {
    const queues = discoverQueues();
    let sourceQueue: string | null = null;
    let sourceItems: QueueItem[] = [];
    let itemIndex = -1;

    // Find the item across all queues
    for (const queueName of queues) {
      const items = loadQueueItems(queueName);
      const index = items.findIndex((i) => i.id === id);
      if (index !== -1) {
        sourceQueue = queueName;
        sourceItems = items;
        itemIndex = index;
        break;
      }
    }

    if (sourceQueue === null || itemIndex === -1) {
      return null;
    }

    // Prevent no-op transfers
    if (sourceQueue === options.targetQueue) {
      throw new Error(`Item ${id} is already in queue "${options.targetQueue}"`);
    }

    // Deep copy the item
    const item: QueueItem = JSON.parse(JSON.stringify(sourceItems[itemIndex]));

    // Update queue and routing metadata
    item.queue = options.targetQueue;
    item.updated = new Date().toISOString();
    item.routing = {
      ...item.routing,
      sourceQueue,
      targetQueue: options.targetQueue,
    };

    // Apply optional overrides
    if (options.status) {
      item.status = options.status;
    }
    if (options.priority) {
      item.priority = options.priority;
    }
    if (options.notes) {
      item.result = {
        ...item.result,
        reviewNotes: options.notes,
      };
    }
    if (options.transferredBy) {
      item.result = {
        ...item.result,
        reviewer: options.transferredBy,
      };
    }

    // Atomic transfer: write to target FIRST, then remove from source.
    // If append succeeds but remove fails → item in both (safe, recoverable via dedup).
    // If append fails → source untouched (safe).
    appendQueueItem(options.targetQueue, item);

    // Now remove from source queue
    sourceItems.splice(itemIndex, 1);
    saveQueueItems(sourceQueue, sourceItems);

    const lucidTaskId = item.payload?.context?.lucidTaskId as string | undefined;
    if (lucidTaskId) {
      try { syncQueueStatus(lucidTaskId, item.status); } catch {}
    }

    // Update state if target queue is new
    const state = loadState();
    if (!state.queues.includes(options.targetQueue)) {
      state.queues.push(options.targetQueue);
    }
    saveState(state);

    return item;
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

    saveState(state);
    return state;
  }

  /**
   * Persist state (called by hooks) — now uses recomputeStats for accuracy
   */
  async persist(): Promise<void> {
    await this.recomputeStats();
  }

  /**
   * Check if a queue has enrichOnAdd enabled in RoutingRules.yaml
   */
  private shouldAutoEnrich(queueName: string): boolean {
    try {
      const config = loadRoutingConfig();
      return config.queues?.[queueName]?.enrichOnAdd === true;
    } catch {
      return false;
    }
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
    options: Omit<AddOptions, "queue" | "autoSpec" | "awaitAutoSpec"> = {}
  ): Promise<string> {
    // Dedup: check for active item with same normalized title
    const existingItems = loadQueueItems("spec-pipeline");
    const normalizedTitle = payload.title.trim().toLowerCase();
    const duplicate = existingItems.find(
      (i) =>
        i.payload.title.trim().toLowerCase() === normalizedTitle &&
        i.status !== "completed" &&
        i.status !== "failed"
    );
    if (duplicate) {
      console.log(
        `[spec-pipeline] Dedup: item with title "${payload.title}" already exists as ${duplicate.id} (status: ${duplicate.status})`
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
    saveState(state);

    // Context sufficiency auto-advance: skip awaiting-context if item has enough detail
    if (this.hassufficientContext(payload, options.context)) {
      if (this.canDeriveISCDirectly(payload, options.context)) {
        // Skip research entirely — description has ISC-ready material
        const autoNotes = payload.description;
        try {
          await this.attachContext(item.id, autoNotes, "Direct: description contains ISC-derivable structure");
          await this.updateSpecPipelineStatus(item.id, "generating-spec");
          console.log(`[spec-pipeline] Direct-advanced ${item.id} to generating-spec (ISC-derivable)`);
        } catch (err) {
          console.error(`[spec-pipeline] Direct-advance failed for ${item.id}:`, err);
        }
      } else {
        // Needs research to structure the description into ISC-ready findings
        const autoNotes = payload.description;
        try {
          await this.attachContext(item.id, autoNotes, "Research needed: structure description into ISC-ready findings");
          console.log(`[spec-pipeline] Advanced ${item.id} to researching (needs structuring)`);
        } catch (err) {
          console.error(`[spec-pipeline] Auto-advance failed for ${item.id}:`, err);
        }
      }
    } else {
      console.log(`[spec-pipeline] ${item.id} held at awaiting-context (insufficient context for spec creation)`);
    }

    return item.id;
  }

  /**
   * Check if an item has sufficient context to skip the awaiting-context stage.
   *
   * Sufficient when ANY of:
   *   - caller pre-supplied notes AND researchGuidance in context
   *   - description >= 400 chars AND has >= 2 ISC-derivable signals from:
   *     enumerated deliverables, specific artifacts, measurable targets, explicit constraints
   */
  hassufficientContext(
    payload: { description: string },
    context?: Record<string, unknown>
  ): boolean {
    // Check if caller pre-supplied structured context
    if (context?.notes && context?.researchGuidance) {
      return true;
    }

    const desc = payload.description || "";
    if (desc.length < 400) return false;

    let signals = 0;
    // Enumerated deliverables: (1), (2) or numbered lists
    if (/\(\d+\)/.test(desc) || /\d+\.\s+\w/.test(desc)) signals++;
    // Specific artifacts: file paths, function names, repo refs
    if (/\.\w{2,4}\b|github\.com|\.ts\b|\.py\b|\.md\b/.test(desc)) signals++;
    // Measurable targets: percentages, version numbers, counts
    if (/\d+%|\bv\d+|\b\d+\s+(test|item|file|row|endpoint)s?/.test(desc)) signals++;
    // Explicit constraints: must/never/only/gate/require
    if (/\bmust\b|\bnever\b|\bonly\b|\bgate\b|\brequire/i.test(desc)) signals++;

    return signals >= 2;
  }

  /**
   * Determine if ISC can be derived directly from the description without research.
   *
   * Returns true when the description already contains structured, ISC-ready material
   * (e.g., acceptance criteria, table format, or >=4 numbered constraints with outcomes).
   * When true, the pipeline skips research and goes straight to spec generation.
   */
  canDeriveISCDirectly(
    payload: { description: string },
    context?: Record<string, unknown>
  ): boolean {
    // If caller provided prior research findings, skip research
    if (context?.researchFindings || context?.previousResearchPath) return true;

    const desc = payload.description || "";

    // Check for structured ISC-like content already in description:
    const hasAcceptanceCriteria = /\bacceptance\s+criteria\b|\bdone.when\b|\bverif(?:y|ication)\b/i.test(desc);
    const hasTableFormat = /\|[^|]+\|[^|]+\|/.test(desc);
    const hasNumberedConstraints = (desc.match(/\(\d+\)\s+\w/g) || []).length >= 4;

    return hasAcceptanceCriteria || hasTableFormat || hasNumberedConstraints;
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
    const validationError = validateSpecPipelineTransition(item.status, newStatus);
    if (validationError) {
      throw new Error(validationError);
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

    saveQueueItems("spec-pipeline", items);

    const state = loadState();
    state.lastUpdated = new Date().toISOString();
    saveState(state);

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
   * @returns Updated item or null if not found
   */
  async attachContext(
    id: string,
    notes: string,
    researchGuidance: string,
    scopeHints?: string
  ): Promise<QueueItem | null> {
    const contextUpdates: Record<string, unknown> = {
      notes,
      researchGuidance,
      contextAttachedAt: new Date().toISOString(),
    };

    if (scopeHints) {
      contextUpdates.scopeHints = scopeHints;
    }

    return this.updateSpecPipelineStatus(id, "researching", contextUpdates);
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
    // We bypass the normal validateSpecPipelineTransition since this is
    // an external transfer from approvals (not an internal pipeline transition)
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
    saveState(state);

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
}

// ============================================================================
// CLI Interface
// ============================================================================

function formatItem(item: QueueItem): string {
  const statusEmoji: Record<string, string> = {
    pending: "pending",
    in_progress: "in_progress",
    awaiting_approval: "awaiting_approval",
    completed: "completed",
    approved: "approved",
    failed: "failed",
    rejected: "rejected",
    // spec-pipeline statuses
    "awaiting-context": "awaiting-context",
    "researching": "researching",
    "generating-spec": "generating-spec",
    "revision-needed": "revision-needed",
    "escalated": "escalated",
  };

  const priorityLabel: Record<Priority, string> = {
    1: "HIGH",
    2: "NORMAL",
    3: "LOW",
  };

  const lines = [
    "───────────────────────────────────────",
    `ID:       ${item.id}`,
    `Title:    ${item.payload.title}`,
    `Queue:    ${item.queue}`,
    `Status:   ${statusEmoji[item.status] ?? item.status}`,
    `Priority: ${priorityLabel[item.priority]}`,
    `Type:     ${item.type}`,
    `Source:   ${item.source}`,
    `Created:  ${item.created}`,
  ];

  if (item.payload.description) {
    lines.push(`Desc:     ${item.payload.description.slice(0, 60)}${item.payload.description.length > 60 ? "..." : ""}`);
  }

  if (item.result?.completedAt) {
    lines.push(`Completed: ${item.result.completedAt}`);
  }

  if (item.result?.approvedAt) {
    lines.push(`Approved: ${item.result.approvedAt}`);
  }

  if (item.result?.error) {
    lines.push(`Error:    ${item.result.error}`);
  }

  // Show spec path for easy navigation
  const specPath = item.spec?.path
    || (existsSync(join(KAYA_HOME, `plans/Specs/Queue/${item.id}-spec.md`))
      ? join(KAYA_HOME, `plans/Specs/Queue/${item.id}-spec.md`)
      : undefined);
  if (specPath) {
    const relativePath = specPath.replace(KAYA_HOME + "/", "");
    lines.push(`Spec:     ${relativePath}`);
  }

  if (item.result?.reviewNotes) {
    lines.push(`Notes:    ${item.result.reviewNotes}`);
  }

  lines.push("───────────────────────────────────────");

  return lines.join("\n");
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === "--help" || command === "-h") {
    console.log(`
QueueManager - Universal Queue Management for Kaya

Commands:
  add <title> [--desc <description>] [--id <custom-id>] [--queue name] [--priority 1-3] [--type task] [--notes "..."] [--no-spec] [--spec <path>]
  add --title <title> [--description <desc>] [--id <custom-id>] [--queue name] [--priority 1-3] [--type task] [--notes "..."] [--no-spec] [--spec <path>]
      Add an item to a queue (title can be positional or --title flag)
      --no-spec     Skip auto enrichment and spec generation
      --spec <path> Attach an existing spec/plan file (implies --no-spec)

  list [--queue name] [--status pending] [--priority 1-3]
      List items

  get <id>
      Get item details

  next [--queue name]
      Get next pending item

  update <id> --status <status>
      Update item status

  complete <id> [--output "result"]
      Mark item as completed

  fail <id> --error "reason"
      Mark item as failed

  approve <id> [--notes "..."] [--reviewer "..."]
      Approve an item (requires approved spec)

  approve-spec <id> [--reviewer "..."]
      Approve a draft spec on an item (does not approve the item itself)

  reject <id> [--reason "..."] [--reviewer "..."]
      Reject an item

  transfer <id> --to <target-queue> [--status <status>] [--notes "..."] [--by "..."] [--priority 1-3]
      Transfer item to another queue (preserves all metadata)

  remove <id>
      Remove an item

  stats [--queue name]
      Show queue statistics

  cleanup [--days 30]
      Remove old completed/failed items

  recompute
      Rebuild state.json from actual JSONL data (fixes stat drift)

Progress Tracking:
  init-progress <id> <totalPhases>
      Initialize progress tracking for an item

  set-phase <id> <phase>
      Set the current phase number

  complete-phase <id> <phase>
      Mark a phase as completed

  update-isc <id> <criterion> <evidence>
      Mark ISC criterion complete (evidence REQUIRED)

  progress <id>
      Show progress details for an item

Examples:
  bun run QueueManager.ts add "Review PR" --desc "Check auth changes" --type approval
  bun run QueueManager.ts add "Custom Task" --id my-custom-id --desc "With custom ID" --notes "Linked spec"
  bun run QueueManager.ts add "My Feature" --desc "Details" --no-spec
  bun run QueueManager.ts add "My Feature" --desc "Details" --spec plans/my-feature-spec.md
  bun run QueueManager.ts list --status pending
  bun run QueueManager.ts approve abc123 --notes "Looks good!"
  bun run QueueManager.ts init-progress abc123 5
  bun run QueueManager.ts complete-phase abc123 1
  bun run QueueManager.ts update-isc abc123 "Tests pass" "PR #42"
  bun run QueueManager.ts progress abc123
  bun run QueueManager.ts stats
`);
    process.exit(0);
  }

  const qm = new QueueManager();

  // Helper to get arg value
  const getArg = (name: string): string | undefined => {
    const index = args.indexOf(`--${name}`);
    return index !== -1 ? args[index + 1] : undefined;
  };

  switch (command) {
    case "add": {
      // Support both positional title and --title flag
      const titleFlag = getArg("title");
      const positionalTitle = args[1] && !args[1].startsWith("--") ? args[1] : undefined;
      const title = titleFlag || positionalTitle;
      const description = getArg("description") || getArg("desc") || "";
      const queue = getArg("queue");
      const priority = getArg("priority") ? (parseInt(getArg("priority")!) as Priority) : undefined;
      const type = getArg("type");
      const source = getArg("source");
      const id = getArg("id");
      const notes = getArg("notes");
      const noSpec = args.includes("--no-spec");
      const specPath = getArg("spec");

      // Build spec object from --spec <path> if provided
      let spec: QueueItemSpec | undefined;
      if (specPath) {
        const { resolve } = await import("path");
        const resolvedPath = resolve(specPath);
        if (!existsSync(resolvedPath)) {
          console.error(`Error: spec file not found: ${resolvedPath}`);
          process.exit(1);
        }
        const specId = basename(resolvedPath, ".md");
        spec = {
          id: specId,
          path: resolvedPath,
          status: "approved",
          approvedAt: new Date().toISOString(),
        };
      }

      // --spec implies --no-spec (skip auto enrichment+spec)
      const autoSpec = (noSpec || spec) ? false : undefined;

      if (!title) {
        console.error("Error: title required (positional or --title)");
        process.exit(1);
      }

      // Use addSpecPipelineItem for spec-pipeline queue to ensure correct initial status
      const addPromise = queue === "spec-pipeline"
        ? qm.addSpecPipelineItem({ title, description }, { id, priority, type, source })
        : qm.add({ title, description }, { id, queue, priority, type, source, notes, autoSpec, spec, awaitAutoSpec: !noSpec && !spec });

      addPromise
        .then((newId) => {
          console.log(`Added item: ${newId}`);
          return qm.get(newId);
        })
        .then((item) => {
          if (item) console.log(formatItem(item));
        })
        .catch((e) => {
          console.error(`Error: ${e}`);
          process.exit(1);
        });
      break;
    }

    case "list": {
      const queue = getArg("queue");
      const status = getArg("status") as QueueItemStatus | undefined;
      const priority = getArg("priority") ? (parseInt(getArg("priority")!) as Priority) : undefined;

      qm.list({ queue, status, priority })
        .then((items) => {
          if (items.length === 0) {
            console.log("No items found.");
          } else {
            console.log(`\nFound ${items.length} items:\n`);
            for (const item of items) {
              console.log(formatItem(item));
            }
          }
        })
        .catch((e) => {
          console.error(`Error: ${e}`);
          process.exit(1);
        });
      break;
    }

    case "get": {
      const id = args[1];
      if (!id) {
        console.error("Error: ID required");
        process.exit(1);
      }

      qm.get(id)
        .then((item) => {
          if (!item) {
            console.error(`Item not found: ${id}`);
            process.exit(1);
          }
          console.log(formatItem(item));
        })
        .catch((e) => {
          console.error(`Error: ${e}`);
          process.exit(1);
        });
      break;
    }

    case "next": {
      const queue = getArg("queue");

      qm.next(queue)
        .then((item) => {
          if (!item) {
            console.log("No pending items.");
          } else {
            console.log("Next pending item:");
            console.log(formatItem(item));
          }
        })
        .catch((e) => {
          console.error(`Error: ${e}`);
          process.exit(1);
        });
      break;
    }

    case "update": {
      const id = args[1];
      const status = getArg("status") as QueueItemStatus | undefined;

      if (!id) {
        console.error("Error: ID required");
        process.exit(1);
      }

      qm.update(id, { status })
        .then((item) => {
          if (!item) {
            console.error(`Item not found: ${id}`);
            process.exit(1);
          }
          console.log(`Updated: ${id}`);
          console.log(formatItem(item));
        })
        .catch((e) => {
          console.error(`Error: ${e}`);
          process.exit(1);
        });
      break;
    }

    case "transfer": {
      const id = args[1];
      const targetQueue = getArg("to");
      const status = getArg("status") as QueueItemStatus | undefined;
      const notes = getArg("notes");
      const transferredBy = getArg("by");
      const priority = getArg("priority") ? (parseInt(getArg("priority")!) as Priority) : undefined;

      if (!id) {
        console.error("Error: ID required");
        process.exit(1);
      }
      if (!targetQueue) {
        console.error("Error: --to <target-queue> required");
        process.exit(1);
      }

      qm.transfer(id, { targetQueue, status, notes, transferredBy, priority })
        .then((item) => {
          if (!item) {
            console.error(`Item not found: ${id}`);
            process.exit(1);
          }
          console.log(`Transferred: ${id} → ${targetQueue}`);
          console.log(formatItem(item));
        })
        .catch((e) => {
          console.error(`Error: ${e instanceof Error ? e.message : e}`);
          process.exit(1);
        });
      break;
    }

    case "complete": {
      const id = args[1];
      const output = getArg("output");

      if (!id) {
        console.error("Error: ID required");
        process.exit(1);
      }

      qm.complete(id, { output })
        .then((item) => {
          if (!item) {
            console.error(`Item not found: ${id}`);
            process.exit(1);
          }
          console.log(`Completed: ${id}`);
          console.log(formatItem(item));
        })
        .catch((e) => {
          console.error(`Error: ${e}`);
          process.exit(1);
        });
      break;
    }

    case "fail": {
      const id = args[1];
      const error = getArg("error") || "Unknown error";

      if (!id) {
        console.error("Error: ID required");
        process.exit(1);
      }

      qm.fail(id, error)
        .then((item) => {
          if (!item) {
            console.error(`Item not found: ${id}`);
            process.exit(1);
          }
          console.log(`Failed: ${id}`);
          console.log(formatItem(item));
        })
        .catch((e) => {
          console.error(`Error: ${e}`);
          process.exit(1);
        });
      break;
    }

    case "approve": {
      const id = args[1];
      const notes = getArg("notes");
      const reviewer = getArg("reviewer");

      if (!id) {
        console.error("Error: ID required");
        process.exit(1);
      }

      qm.approve(id, { notes, reviewer })
        .then((item) => {
          if (!item) {
            console.error(`Item not found: ${id}`);
            process.exit(1);
          }
          console.log(`Approved: ${id}`);
          if (item.queue === "approved-work") {
            console.log(`Promoted to approved-work queue`);
          }
          console.log(formatItem(item));
        })
        .catch((e) => {
          console.error(`Error: ${e instanceof Error ? e.message : e}`);
          process.exit(1);
        });
      break;
    }

    case "approve-spec": {
      const id = args[1];
      const reviewer = getArg("reviewer") || "Jm";

      if (!id) {
        console.error("Error: ID required");
        process.exit(1);
      }

      qm.approveSpec(id, reviewer)
        .then((item) => {
          if (!item) {
            console.error(`Item not found: ${id}`);
            process.exit(1);
          }
          console.log(`Spec approved for: ${id}`);
          console.log(`Spec status: draft -> approved`);
          console.log(`Item can now be approved via: approve ${id}`);
          console.log(formatItem(item));
        })
        .catch((e) => {
          console.error(`Error: ${e instanceof Error ? e.message : e}`);
          process.exit(1);
        });
      break;
    }

    case "reject": {
      const id = args[1];
      const reason = getArg("reason");
      const reviewer = getArg("reviewer");

      if (!id) {
        console.error("Error: ID required");
        process.exit(1);
      }

      // Check if item is in approvals queue — if so, route to spec-pipeline
      qm.get(id)
        .then(async (existing) => {
          if (!existing) {
            console.error(`Item not found: ${id}`);
            process.exit(1);
          }

          let item: QueueItem | null;
          if (existing.queue === "approvals" && reason) {
            item = await qm.rejectToSpecPipeline(id, reason, reviewer);
            if (item) {
              console.log(`Rejected: ${id}`);
              console.log(`Transferred to spec-pipeline (status: ${item.status})`);
              console.log(formatItem(item));
            }
          } else {
            item = await qm.reject(id, { reason, reviewer });
            if (item) {
              console.log(`Rejected: ${id}`);
              console.log(formatItem(item));
            }
          }

          if (!item) {
            console.error(`Failed to reject: ${id}`);
            process.exit(1);
          }
        })
        .catch((e) => {
          console.error(`Error: ${e}`);
          process.exit(1);
        });
      break;
    }

    case "remove": {
      const id = args[1];

      if (!id) {
        console.error("Error: ID required");
        process.exit(1);
      }

      qm.remove(id)
        .then((removed) => {
          if (!removed) {
            console.error(`Item not found: ${id}`);
            process.exit(1);
          }
          console.log(`Removed: ${id}`);
        })
        .catch((e) => {
          console.error(`Error: ${e}`);
          process.exit(1);
        });
      break;
    }

    case "stats": {
      const queue = getArg("queue");

      qm.stats(queue)
        .then((stats) => {
          console.log(`
Queue Statistics${queue ? ` (${queue})` : ""}:
  Total:              ${stats.total}
  Pending:            ${stats.pending}
  In Progress:        ${stats.inProgress}
  Awaiting Approval:  ${stats.awaitingApproval}
  Completed:          ${stats.completed}
  Failed:             ${stats.failed}

By Priority:
  HIGH (1):           ${stats.byPriority[1]}
  NORMAL (2):         ${stats.byPriority[2]}
  LOW (3):            ${stats.byPriority[3]}

By Queue:
${Object.entries(stats.byQueue)
  .map(([q, count]) => `  ${q}: ${count}`)
  .join("\n")}
`);
        })
        .catch((e) => {
          console.error(`Error: ${e}`);
          process.exit(1);
        });
      break;
    }

    case "cleanup": {
      const days = getArg("days") ? parseInt(getArg("days")!) : 30;

      qm.cleanup(days)
        .then((result) => {
          console.log(`Cleanup complete: removed ${result.removed} items (${result.archived} archived to MEMORY/QUEUES/archive/)`);
        })
        .catch((e) => {
          console.error(`Error: ${e}`);
          process.exit(1);
        });
      break;
    }

    // =========================================================================
    // Progress Tracking Commands
    // =========================================================================

    case "init-progress": {
      const id = args[1];
      const totalPhases = args[2] ? parseInt(args[2]) : undefined;

      if (!id) {
        console.error("Error: ID required");
        process.exit(1);
      }
      if (!totalPhases || isNaN(totalPhases) || totalPhases < 1) {
        console.error("Error: totalPhases must be a positive number");
        process.exit(1);
      }

      qm.initProgress(id, totalPhases)
        .then((item) => {
          if (!item) {
            console.error(`Item not found: ${id}`);
            process.exit(1);
          }
          console.log(`✅ Progress initialized: ${totalPhases} phases`);
          console.log(`   Current phase: 1/${totalPhases}`);
          console.log(`   Phases completed: none`);
        })
        .catch((e) => {
          console.error(`Error: ${e instanceof Error ? e.message : e}`);
          process.exit(1);
        });
      break;
    }

    case "set-phase": {
      const id = args[1];
      const phase = args[2] ? parseInt(args[2]) : undefined;

      if (!id) {
        console.error("Error: ID required");
        process.exit(1);
      }
      if (!phase || isNaN(phase)) {
        console.error("Error: phase number required");
        process.exit(1);
      }

      qm.setPhase(id, phase)
        .then((item) => {
          if (!item) {
            console.error(`Item not found: ${id}`);
            process.exit(1);
          }
          console.log(`✅ Current phase set to: ${phase}/${item.progress?.totalPhases}`);
        })
        .catch((e) => {
          console.error(`Error: ${e instanceof Error ? e.message : e}`);
          process.exit(1);
        });
      break;
    }

    case "complete-phase": {
      const id = args[1];
      const phase = args[2] ? parseInt(args[2]) : undefined;

      if (!id) {
        console.error("Error: ID required");
        process.exit(1);
      }
      if (!phase || isNaN(phase)) {
        console.error("Error: phase number required");
        process.exit(1);
      }

      qm.completePhase(id, phase)
        .then((item) => {
          if (!item) {
            console.error(`Item not found: ${id}`);
            process.exit(1);
          }
          const progress = item.progress!;
          console.log(`✅ Phase ${phase} marked complete`);
          console.log(`   Completed: [${progress.phasesCompleted.join(", ")}]`);
          console.log(`   Current phase: ${progress.currentPhase}/${progress.totalPhases}`);
        })
        .catch((e) => {
          console.error(`Error: ${e instanceof Error ? e.message : e}`);
          process.exit(1);
        });
      break;
    }

    case "update-isc": {
      const id = args[1];
      const criterion = args[2];
      const evidence = args[3];

      if (!id) {
        console.error("Error: ID required");
        process.exit(1);
      }
      if (!criterion) {
        console.error("Error: criterion required");
        process.exit(1);
      }
      if (!evidence) {
        console.error("Error: evidence is REQUIRED (PR link, test output, etc.)");
        process.exit(1);
      }

      qm.updateISC(id, criterion, true, evidence)
        .then((item) => {
          if (!item) {
            console.error(`Item not found: ${id}`);
            process.exit(1);
          }
          const iscProgress = qm.getISCProgress(item);
          console.log(`✅ ISC criterion completed: "${criterion.slice(0, 40)}${criterion.length > 40 ? "..." : ""}"`);
          console.log(`   Evidence: ${evidence}`);
          console.log(`   ISC progress: ${iscProgress.completed}/${iscProgress.total}`);
        })
        .catch((e) => {
          console.error(`Error: ${e instanceof Error ? e.message : e}`);
          process.exit(1);
        });
      break;
    }

    case "progress": {
      const id = args[1];

      if (!id) {
        console.error("Error: ID required");
        process.exit(1);
      }

      qm.get(id)
        .then((item) => {
          if (!item) {
            console.error(`Item not found: ${id}`);
            process.exit(1);
          }
          if (!item.progress) {
            console.log(`No progress tracking for item: ${id}`);
            console.log(`Use 'init-progress ${id} <totalPhases>' to initialize.`);
            process.exit(0);
          }

          const progress = item.progress;
          const iscProgress = qm.getISCProgress(item);
          const isComplete = qm.isFullyComplete(item);

          console.log(`
Progress for: ${item.payload.title}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Phase Progress:
  Current Phase:   ${progress.currentPhase}/${progress.totalPhases}
  Completed:       [${progress.phasesCompleted.join(", ") || "none"}]
  All Done:        ${isComplete ? "✅ Yes" : "❌ No"}

ISC Progress:
  Completed:       ${iscProgress.completed}/${iscProgress.total}
`);

          if (Object.keys(progress.iscStatus).length > 0) {
            console.log("ISC Criteria:");
            for (const [criterion, status] of Object.entries(progress.iscStatus)) {
              const check = status.completed ? "✅" : "⬜";
              const desc = criterion.length > 50 ? criterion.slice(0, 50) + "..." : criterion;
              console.log(`  ${check} ${desc}`);
              if (status.evidence) {
                console.log(`     Evidence: ${status.evidence}`);
              }
            }
          }

          console.log(`
Last Updated: ${progress.lastUpdated}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`);
        })
        .catch((e) => {
          console.error(`Error: ${e instanceof Error ? e.message : e}`);
          process.exit(1);
        });
      break;
    }

    case "recompute": {
      qm.recomputeStats()
        .then((state) => {
          console.log(`✅ State recomputed from JSONL data:`);
          console.log(`   Queues:          [${state.queues.join(", ")}]`);
          console.log(`   Total items:     ${state.stats.totalItems}`);
          console.log(`   Total processed: ${state.stats.totalProcessed}`);
          if (state.stats.lastProcessedAt) {
            console.log(`   Last processed:  ${state.stats.lastProcessedAt}`);
          }
        })
        .catch((e) => {
          console.error(`Error: ${e instanceof Error ? e.message : e}`);
          process.exit(1);
        });
      break;
    }

    // =========================================================================
    // Spec Pipeline Commands
    // =========================================================================

    case "context": {
      // context <id> --notes "..." --research "..." [--scope "..."]
      const id = args[1] && !args[1].startsWith("--") ? args[1] : undefined;
      const notes = getArg("notes");
      const research = getArg("research");
      const scope = getArg("scope");

      if (!id) {
        console.error("Error: item ID required");
        console.error("Usage: context <id> --notes \"Problem context\" --research \"Research guidance\" [--scope \"Scope hints\"]");
        process.exit(1);
      }
      if (!notes) {
        console.error("Error: --notes required");
        process.exit(1);
      }
      if (!research) {
        console.error("Error: --research required");
        process.exit(1);
      }

      qm.attachContext(id, notes, research, scope)
        .then((item) => {
          if (!item) {
            console.error(`Item not found in spec-pipeline: ${id}`);
            process.exit(1);
          }
          console.log(`Context attached: ${id}`);
          console.log(`Status: awaiting-context → researching`);
          console.log(formatItem(item));
        })
        .catch((e) => {
          console.error(`Error: ${e instanceof Error ? e.message : e}`);
          process.exit(1);
        });
      break;
    }

    case "pipeline-list": {
      // pipeline-list [--status <status>]
      const pipelineStatus = getArg("status");

      qm.listSpecPipeline(pipelineStatus)
        .then((items) => {
          if (items.length === 0) {
            console.log(`No spec-pipeline items${pipelineStatus ? ` with status "${pipelineStatus}"` : ""}.`);
          } else {
            console.log(`\nSpec Pipeline (${items.length} items${pipelineStatus ? `, status: ${pipelineStatus}` : ""}):\n`);
            for (const item of items) {
              const ctx = item.payload.context as Record<string, unknown> | undefined;
              const meta = ctx?._meta as Record<string, unknown> | undefined;
              const revCount = meta?.revisionCount ?? 0;
              const hasContext = !!(ctx?.notes);
              const statusLine = `${item.status}${revCount ? ` (rev:${revCount})` : ""}${hasContext ? " [ctx]" : ""}`;
              console.log(`  ${item.id}  ${item.payload.title.slice(0, 50)}  [${statusLine}]`);
            }
            console.log("");
          }
        })
        .catch((e) => {
          console.error(`Error: ${e}`);
          process.exit(1);
        });
      break;
    }

    case "reject-to-pipeline": {
      // reject-to-pipeline <id> [--reason "..."] [--reviewer "..."]
      const id = args[1];
      const reason = getArg("reason") || "No reason provided";
      const reviewer = getArg("reviewer");

      if (!id) {
        console.error("Error: ID required");
        process.exit(1);
      }

      qm.rejectToSpecPipeline(id, reason, reviewer)
        .then((item) => {
          if (!item) {
            console.error(`Item not found: ${id}`);
            process.exit(1);
          }
          const meta = (item.payload.context?._meta as Record<string, unknown>) || {};
          const revCount = meta.revisionCount ?? 1;
          console.log(`Rejected → spec-pipeline: ${id}`);
          console.log(`Status: ${item.status}`);
          console.log(`Revision count: ${revCount}`);
          if (item.status === "escalated") {
            console.log(`ESCALATED: 3 rejections reached — manual review required`);
          }
          console.log(formatItem(item));
        })
        .catch((e) => {
          console.error(`Error: ${e instanceof Error ? e.message : e}`);
          process.exit(1);
        });
      break;
    }

    default:
      console.error(`Unknown command: ${command}`);
      console.error("Use --help for usage.");
      process.exit(1);
  }
}
