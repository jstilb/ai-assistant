#!/usr/bin/env bun
/**
 * ApprovalQueue.ts - Generic approval queue with multiple backends
 *
 * A flexible approval queue system that supports file-based and memory-based
 * storage, with priority ordering, expiry, notification hooks, and batch operations.
 *
 * Usage:
 *   bun run ApprovalQueue.ts add --data '{"title":"..."}' --priority high
 *   bun run ApprovalQueue.ts list [--status pending] [--priority high]
 *   bun run ApprovalQueue.ts approve <id> [--notes "..."] [--reviewer "..."]
 *   bun run ApprovalQueue.ts reject <id> [--reason "..."]
 *   bun run ApprovalQueue.ts batch-approve <id1> <id2> ...
 *   bun run ApprovalQueue.ts stats
 *   bun run ApprovalQueue.ts cleanup
 *
 * @module ApprovalQueue
 */

import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
} from "fs";
import { join, dirname } from "path";
import type { z } from "zod";

// ============================================================================
// Types
// ============================================================================

/** Status of an approval item */
export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired";

/** Priority level for queue ordering */
export type Priority = "low" | "normal" | "high" | "critical";

/** Priority ordering for sorting (higher number = higher priority) */
const PRIORITY_ORDER: Record<Priority, number> = {
  critical: 4,
  high: 3,
  normal: 2,
  low: 1,
};

/**
 * Base fields that every approval item has
 */
export interface ApprovalItemBase {
  /** Unique identifier */
  id: string;
  /** Current status */
  status: ApprovalStatus;
  /** Priority level */
  priority: Priority;
  /** When the item was created */
  createdAt: string;
  /** When the item expires (optional) */
  expiresAt?: string;
  /** When the item was reviewed */
  reviewedAt?: string;
  /** Who reviewed the item */
  reviewedBy?: string;
  /** Notes from the reviewer */
  reviewNotes?: string;
}

/**
 * Options for creating a queue
 */
export interface QueueOptions<T> {
  /** Zod schema for validating items */
  schema?: z.ZodSchema<T>;
  /** Default expiry in days (0 = no expiry) */
  defaultExpiry?: number;
  /** Hook called when item is added */
  onAdd?: (item: T & ApprovalItemBase) => void | Promise<void>;
  /** Hook called when item is approved */
  onApprove?: (item: T & ApprovalItemBase) => void | Promise<void>;
  /** Hook called when item is rejected */
  onReject?: (item: T & ApprovalItemBase) => void | Promise<void>;
  /** Hook called when item expires */
  onExpire?: (item: T & ApprovalItemBase) => void | Promise<void>;
}

/**
 * Options when adding an item
 */
export interface AddOptions {
  /** Priority level */
  priority?: Priority;
  /** Override default expiry in days */
  expiryDays?: number;
}

/**
 * Filter options for listing items
 */
export interface ListFilter {
  /** Filter by status */
  status?: ApprovalStatus;
  /** Filter by priority */
  priority?: Priority;
}

/**
 * Statistics about the queue
 */
export interface QueueStats {
  /** Number of pending items */
  pending: number;
  /** Number of approved items */
  approved: number;
  /** Number of rejected items */
  rejected: number;
  /** Number of expired items */
  expired: number;
  /** Breakdown by priority */
  byPriority: Record<Priority, number>;
}

/**
 * Result from cleanup operation
 */
export interface CleanupResult {
  /** Number of items marked as expired */
  expired: number;
  /** Number of items removed */
  removed: number;
}

/**
 * Generic approval queue interface
 */
export interface IApprovalQueue<T> {
  /**
   * Add an item to the queue
   * @param item - The item data
   * @param options - Add options (priority, expiry)
   * @returns The generated ID
   */
  add(item: T, options?: AddOptions): Promise<string>;

  /**
   * Get an item by ID
   * @param id - The item ID
   * @returns The item or null if not found
   */
  get(id: string): Promise<(T & ApprovalItemBase) | null>;

  /**
   * List items with optional filtering
   * @param filter - Filter options
   * @returns Array of items sorted by priority
   */
  list(filter?: ListFilter): Promise<(T & ApprovalItemBase)[]>;

  /**
   * Approve an item
   * @param id - The item ID
   * @param notes - Optional approval notes
   * @param reviewer - Optional reviewer name
   * @returns The approved item
   * @throws If item not found or not pending
   */
  approve(id: string, notes?: string, reviewer?: string): Promise<T & ApprovalItemBase>;

  /**
   * Reject an item
   * @param id - The item ID
   * @param reason - Optional rejection reason
   * @param reviewer - Optional reviewer name
   * @returns The rejected item
   * @throws If item not found or not pending
   */
  reject(id: string, reason?: string, reviewer?: string): Promise<T & ApprovalItemBase>;

  /**
   * Batch approve multiple items
   * @param ids - Array of item IDs
   * @param notes - Optional notes for all
   * @returns Array of approved items
   */
  batchApprove(ids: string[], notes?: string): Promise<(T & ApprovalItemBase)[]>;

  /**
   * Batch reject multiple items
   * @param ids - Array of item IDs
   * @param reason - Optional reason for all
   * @returns Array of rejected items
   */
  batchReject(ids: string[], reason?: string): Promise<(T & ApprovalItemBase)[]>;

  /**
   * Cleanup expired items
   * @param daysOld - Remove items older than this many days (default: 30)
   * @returns Cleanup statistics
   */
  cleanup(daysOld?: number): Promise<CleanupResult>;

  /**
   * Get queue statistics
   * @returns Statistics about the queue
   */
  getStats(): Promise<QueueStats>;
}

// ============================================================================
// Implementation: Memory Queue
// ============================================================================

/**
 * In-memory approval queue implementation
 *
 * @example
 * ```typescript
 * const queue = new MemoryApprovalQueue<{ title: string }>({
 *   defaultExpiry: 7,
 *   onAdd: (item) => console.log(`Added: ${item.title}`),
 * });
 *
 * const id = await queue.add({ title: "My item" }, { priority: "high" });
 * await queue.approve(id, "Looks good!", "reviewer");
 * ```
 */
export class MemoryApprovalQueue<T> implements IApprovalQueue<T> {
  private items: Map<string, T & ApprovalItemBase> = new Map();
  private options: QueueOptions<T>;

  constructor(options: QueueOptions<T> = {}) {
    this.options = options;
  }

  /**
   * Generate a unique ID
   */
  private generateId(): string {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  /**
   * Calculate expiry date
   */
  private calculateExpiry(days?: number): string | undefined {
    const expiryDays = days ?? this.options.defaultExpiry;
    if (expiryDays === undefined || expiryDays < 0) return undefined;

    const date = new Date();
    date.setDate(date.getDate() + expiryDays);
    return date.toISOString();
  }

  /**
   * Validate item against schema if provided
   */
  private validate(item: T): void {
    if (this.options.schema) {
      this.options.schema.parse(item);
    }
  }

  async add(item: T, options: AddOptions = {}): Promise<string> {
    this.validate(item);

    const id = this.generateId();
    const fullItem: T & ApprovalItemBase = {
      ...item,
      id,
      status: "pending",
      priority: options.priority ?? "normal",
      createdAt: new Date().toISOString(),
      expiresAt: this.calculateExpiry(options.expiryDays),
    };

    this.items.set(id, fullItem);

    if (this.options.onAdd) {
      await this.options.onAdd(fullItem);
    }

    return id;
  }

  async get(id: string): Promise<(T & ApprovalItemBase) | null> {
    return this.items.get(id) ?? null;
  }

  async list(filter: ListFilter = {}): Promise<(T & ApprovalItemBase)[]> {
    let items = Array.from(this.items.values());

    // Apply filters
    if (filter.status) {
      items = items.filter((item) => item.status === filter.status);
    }

    if (filter.priority) {
      items = items.filter((item) => item.priority === filter.priority);
    }

    // Sort by priority (descending)
    items.sort(
      (a, b) => PRIORITY_ORDER[b.priority] - PRIORITY_ORDER[a.priority]
    );

    return items;
  }

  async approve(
    id: string,
    notes?: string,
    reviewer?: string
  ): Promise<T & ApprovalItemBase> {
    const item = this.items.get(id);

    if (!item) {
      throw new Error(`Item not found: ${id}`);
    }

    if (item.status !== "pending") {
      throw new Error(`Item already ${item.status}: ${id}`);
    }

    item.status = "approved";
    item.reviewedAt = new Date().toISOString();
    item.reviewNotes = notes;
    item.reviewedBy = reviewer;

    if (this.options.onApprove) {
      await this.options.onApprove(item);
    }

    return item;
  }

  async reject(
    id: string,
    reason?: string,
    reviewer?: string
  ): Promise<T & ApprovalItemBase> {
    const item = this.items.get(id);

    if (!item) {
      throw new Error(`Item not found: ${id}`);
    }

    if (item.status !== "pending") {
      throw new Error(`Item already ${item.status}: ${id}`);
    }

    item.status = "rejected";
    item.reviewedAt = new Date().toISOString();
    item.reviewNotes = reason;
    item.reviewedBy = reviewer;

    if (this.options.onReject) {
      await this.options.onReject(item);
    }

    return item;
  }

  async batchApprove(
    ids: string[],
    notes?: string
  ): Promise<(T & ApprovalItemBase)[]> {
    const results: (T & ApprovalItemBase)[] = [];

    for (const id of ids) {
      try {
        const item = await this.approve(id, notes);
        results.push(item);
      } catch {
        // Skip items that can't be approved
      }
    }

    return results;
  }

  async batchReject(
    ids: string[],
    reason?: string
  ): Promise<(T & ApprovalItemBase)[]> {
    const results: (T & ApprovalItemBase)[] = [];

    for (const id of ids) {
      try {
        const item = await this.reject(id, reason);
        results.push(item);
      } catch {
        // Skip items that can't be rejected
      }
    }

    return results;
  }

  async cleanup(daysOld: number = 30): Promise<CleanupResult> {
    const now = new Date();
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - daysOld);

    let expired = 0;
    let removed = 0;

    for (const [id, item] of this.items) {
      // Check for expiry
      if (item.status === "pending" && item.expiresAt) {
        if (new Date(item.expiresAt) < now) {
          item.status = "expired";
          expired++;

          if (this.options.onExpire) {
            await this.options.onExpire(item);
          }
        }
      }

      // Remove old items
      if (item.status !== "pending") {
        const createdAt = new Date(item.createdAt);
        if (createdAt < cutoff) {
          this.items.delete(id);
          removed++;
        }
      }
    }

    return { expired, removed };
  }

  async getStats(): Promise<QueueStats> {
    const stats: QueueStats = {
      pending: 0,
      approved: 0,
      rejected: 0,
      expired: 0,
      byPriority: {
        low: 0,
        normal: 0,
        high: 0,
        critical: 0,
      },
    };

    for (const item of this.items.values()) {
      stats[item.status]++;
      stats.byPriority[item.priority]++;
    }

    return stats;
  }
}

// ============================================================================
// Implementation: File Queue
// ============================================================================

/**
 * Internal state structure for file storage
 */
interface FileQueueState<T> {
  lastUpdated: string;
  items: (T & ApprovalItemBase)[];
}

/**
 * File-backed approval queue implementation
 *
 * @example
 * ```typescript
 * const queue = new FileApprovalQueue<{ title: string }>(
 *   "~/.claude/MEMORY/WORK/pending-approval/queue.json",
 *   { defaultExpiry: 7 }
 * );
 *
 * const id = await queue.add({ title: "My item" });
 * ```
 */
export class FileApprovalQueue<T> implements IApprovalQueue<T> {
  private storagePath: string;
  private options: QueueOptions<T>;

  constructor(storagePath: string, options: QueueOptions<T> = {}) {
    this.storagePath = storagePath;
    this.options = options;
    this.ensureDirectory();
  }

  /**
   * Ensure the storage directory exists
   */
  private ensureDirectory(): void {
    const dir = dirname(this.storagePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  /**
   * Load state from file
   */
  private loadState(): FileQueueState<T> {
    if (!existsSync(this.storagePath)) {
      return {
        lastUpdated: new Date().toISOString(),
        items: [],
      };
    }

    try {
      return JSON.parse(readFileSync(this.storagePath, "utf-8"));
    } catch {
      return {
        lastUpdated: new Date().toISOString(),
        items: [],
      };
    }
  }

  /**
   * Save state to file
   */
  private saveState(state: FileQueueState<T>): void {
    state.lastUpdated = new Date().toISOString();
    writeFileSync(this.storagePath, JSON.stringify(state, null, 2));
  }

  /**
   * Generate a unique ID
   */
  private generateId(): string {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  /**
   * Calculate expiry date
   */
  private calculateExpiry(days?: number): string | undefined {
    const expiryDays = days ?? this.options.defaultExpiry;
    if (expiryDays === undefined || expiryDays < 0) return undefined;

    const date = new Date();
    date.setDate(date.getDate() + expiryDays);
    return date.toISOString();
  }

  /**
   * Validate item against schema if provided
   */
  private validate(item: T): void {
    if (this.options.schema) {
      this.options.schema.parse(item);
    }
  }

  async add(item: T, options: AddOptions = {}): Promise<string> {
    this.validate(item);

    const state = this.loadState();
    const id = this.generateId();

    const fullItem: T & ApprovalItemBase = {
      ...item,
      id,
      status: "pending",
      priority: options.priority ?? "normal",
      createdAt: new Date().toISOString(),
      expiresAt: this.calculateExpiry(options.expiryDays),
    };

    state.items.push(fullItem);
    this.saveState(state);

    if (this.options.onAdd) {
      await this.options.onAdd(fullItem);
    }

    return id;
  }

  async get(id: string): Promise<(T & ApprovalItemBase) | null> {
    const state = this.loadState();
    return state.items.find((item) => item.id === id) ?? null;
  }

  async list(filter: ListFilter = {}): Promise<(T & ApprovalItemBase)[]> {
    const state = this.loadState();
    let items = [...state.items];

    if (filter.status) {
      items = items.filter((item) => item.status === filter.status);
    }

    if (filter.priority) {
      items = items.filter((item) => item.priority === filter.priority);
    }

    items.sort(
      (a, b) => PRIORITY_ORDER[b.priority] - PRIORITY_ORDER[a.priority]
    );

    return items;
  }

  async approve(
    id: string,
    notes?: string,
    reviewer?: string
  ): Promise<T & ApprovalItemBase> {
    const state = this.loadState();
    const item = state.items.find((i) => i.id === id);

    if (!item) {
      throw new Error(`Item not found: ${id}`);
    }

    if (item.status !== "pending") {
      throw new Error(`Item already ${item.status}: ${id}`);
    }

    item.status = "approved";
    item.reviewedAt = new Date().toISOString();
    item.reviewNotes = notes;
    item.reviewedBy = reviewer;

    this.saveState(state);

    if (this.options.onApprove) {
      await this.options.onApprove(item);
    }

    return item;
  }

  async reject(
    id: string,
    reason?: string,
    reviewer?: string
  ): Promise<T & ApprovalItemBase> {
    const state = this.loadState();
    const item = state.items.find((i) => i.id === id);

    if (!item) {
      throw new Error(`Item not found: ${id}`);
    }

    if (item.status !== "pending") {
      throw new Error(`Item already ${item.status}: ${id}`);
    }

    item.status = "rejected";
    item.reviewedAt = new Date().toISOString();
    item.reviewNotes = reason;
    item.reviewedBy = reviewer;

    this.saveState(state);

    if (this.options.onReject) {
      await this.options.onReject(item);
    }

    return item;
  }

  async batchApprove(
    ids: string[],
    notes?: string
  ): Promise<(T & ApprovalItemBase)[]> {
    const results: (T & ApprovalItemBase)[] = [];

    for (const id of ids) {
      try {
        const item = await this.approve(id, notes);
        results.push(item);
      } catch {
        // Skip items that can't be approved
      }
    }

    return results;
  }

  async batchReject(
    ids: string[],
    reason?: string
  ): Promise<(T & ApprovalItemBase)[]> {
    const results: (T & ApprovalItemBase)[] = [];

    for (const id of ids) {
      try {
        const item = await this.reject(id, reason);
        results.push(item);
      } catch {
        // Skip items that can't be rejected
      }
    }

    return results;
  }

  async cleanup(daysOld: number = 30): Promise<CleanupResult> {
    const state = this.loadState();
    const now = new Date();
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - daysOld);

    let expired = 0;
    let removed = 0;

    // Mark expired items
    for (const item of state.items) {
      if (item.status === "pending" && item.expiresAt) {
        if (new Date(item.expiresAt) < now) {
          item.status = "expired";
          expired++;

          if (this.options.onExpire) {
            await this.options.onExpire(item);
          }
        }
      }
    }

    // Remove old items
    const originalLength = state.items.length;
    state.items = state.items.filter((item) => {
      if (item.status !== "pending") {
        const createdAt = new Date(item.createdAt);
        if (createdAt < cutoff) {
          return false;
        }
      }
      return true;
    });
    removed = originalLength - state.items.length;

    this.saveState(state);

    return { expired, removed };
  }

  async getStats(): Promise<QueueStats> {
    const state = this.loadState();
    const stats: QueueStats = {
      pending: 0,
      approved: 0,
      rejected: 0,
      expired: 0,
      byPriority: {
        low: 0,
        normal: 0,
        high: 0,
        critical: 0,
      },
    };

    for (const item of state.items) {
      stats[item.status]++;
      stats.byPriority[item.priority]++;
    }

    return stats;
  }
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create an approval queue with the specified backend
 *
 * @example
 * ```typescript
 * // Memory queue
 * const memQueue = createApprovalQueue<MyItem>('memory', { defaultExpiry: 7 });
 *
 * // File queue
 * const fileQueue = createApprovalQueue<MyItem>('file', '/path/to/queue.json', {
 *   onAdd: (item) => notify(`New item: ${item.title}`),
 * });
 * ```
 */
export function createApprovalQueue<T>(
  backend: "memory",
  options?: QueueOptions<T>
): IApprovalQueue<T>;
export function createApprovalQueue<T>(
  backend: "file",
  storagePath: string,
  options?: QueueOptions<T>
): IApprovalQueue<T>;
export function createApprovalQueue<T>(
  backend: "file" | "memory",
  pathOrOptions?: string | QueueOptions<T>,
  options?: QueueOptions<T>
): IApprovalQueue<T> {
  if (backend === "memory") {
    return new MemoryApprovalQueue<T>(
      (pathOrOptions as QueueOptions<T>) ?? options
    );
  }

  if (backend === "file") {
    if (typeof pathOrOptions !== "string") {
      throw new Error("File backend requires a storage path");
    }
    return new FileApprovalQueue<T>(pathOrOptions, options);
  }

  throw new Error(`Unknown backend: ${backend}`);
}

// ============================================================================
// CLI Interface
// ============================================================================

const KAYA_HOME = process.env.KAYA_HOME || join(process.env.HOME || "", ".claude");
const DEFAULT_QUEUE_PATH = join(KAYA_HOME, "MEMORY/WORK/pending-approval/queue.json");

/**
 * Format an item for display
 */
function formatItem<T>(item: T & ApprovalItemBase): string {
  const statusEmoji: Record<ApprovalStatus, string> = {
    pending: "[PENDING]",
    approved: "[APPROVED]",
    rejected: "[REJECTED]",
    expired: "[EXPIRED]",
  };

  const priorityIndicator: Record<Priority, string> = {
    critical: "!!!",
    high: "!!",
    normal: "!",
    low: "",
  };

  const lines = [
    "---",
    `ID:       ${item.id}`,
    `Status:   ${statusEmoji[item.status]} ${item.status}`,
    `Priority: ${priorityIndicator[item.priority]} ${item.priority}`,
    `Created:  ${item.createdAt}`,
  ];

  if (item.expiresAt) {
    lines.push(`Expires:  ${item.expiresAt}`);
  }

  if (item.reviewedAt) {
    lines.push(`Reviewed: ${item.reviewedAt}`);
  }

  if (item.reviewedBy) {
    lines.push(`Reviewer: ${item.reviewedBy}`);
  }

  if (item.reviewNotes) {
    lines.push(`Notes:    ${item.reviewNotes}`);
  }

  // Add any other fields from T
  const baseKeys = new Set([
    "id",
    "status",
    "priority",
    "createdAt",
    "expiresAt",
    "reviewedAt",
    "reviewedBy",
    "reviewNotes",
  ]);

  for (const [key, value] of Object.entries(item)) {
    if (!baseKeys.has(key) && value !== undefined) {
      lines.push(`${key}: ${JSON.stringify(value)}`);
    }
  }

  lines.push("---");

  return lines.join("\n");
}

// CLI handling
if (import.meta.main) {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h") || args.length === 0) {
    console.log(`
ApprovalQueue - Generic approval queue with multiple backends

Commands:
  add --data <json> [--priority <level>] [--expiry <days>]
      Add an item to the queue

  list [--status <status>] [--priority <level>]
      List items in the queue

  get <id>
      Get item details

  approve <id> [--notes <text>] [--reviewer <name>]
      Approve an item

  reject <id> [--reason <text>] [--reviewer <name>]
      Reject an item

  batch-approve <id1> [id2] ... [--notes <text>]
      Approve multiple items

  batch-reject <id1> [id2] ... [--reason <text>]
      Reject multiple items

  stats
      Show queue statistics

  cleanup [--days <n>]
      Clean up expired/old items

Options:
  --queue <path>      Path to queue file (default: ~/.claude/MEMORY/WORK/pending-approval/queue.json)
  --priority <level>  low | normal | high | critical
  --status <status>   pending | approved | rejected | expired

Examples:
  bun run ApprovalQueue.ts add --data '{"title":"Fix bug","branch":"fix/bug-123"}'
  bun run ApprovalQueue.ts add --data '{"title":"Deploy"}' --priority critical
  bun run ApprovalQueue.ts list --status pending
  bun run ApprovalQueue.ts approve abc123 --notes "Looks good!"
  bun run ApprovalQueue.ts batch-approve id1 id2 id3
  bun run ApprovalQueue.ts stats
`);
    process.exit(0);
  }

  // Parse global options
  const queuePathIndex = args.indexOf("--queue");
  const queuePath =
    queuePathIndex !== -1 ? args[queuePathIndex + 1] : DEFAULT_QUEUE_PATH;

  // Create queue instance
  const queue = new FileApprovalQueue<Record<string, unknown>>(queuePath);

  const command = args[0];

  switch (command) {
    case "add": {
      const dataIndex = args.indexOf("--data");
      if (dataIndex === -1) {
        console.error("Error: --data required");
        process.exit(1);
      }
      const dataStr = args[dataIndex + 1];
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(dataStr);
      } catch {
        console.error("Error: Invalid JSON data");
        process.exit(1);
      }

      const priorityIndex = args.indexOf("--priority");
      const priority = priorityIndex !== -1 ? (args[priorityIndex + 1] as Priority) : undefined;

      const expiryIndex = args.indexOf("--expiry");
      const expiryDays = expiryIndex !== -1 ? parseInt(args[expiryIndex + 1]) : undefined;

      queue
        .add(data, { priority, expiryDays })
        .then((id) => {
          console.log(`Added item: ${id}`);
          return queue.get(id);
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
      const statusIndex = args.indexOf("--status");
      const status = statusIndex !== -1 ? (args[statusIndex + 1] as ApprovalStatus) : undefined;

      const priorityIndex = args.indexOf("--priority");
      const priority = priorityIndex !== -1 ? (args[priorityIndex + 1] as Priority) : undefined;

      queue
        .list({ status, priority })
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

      queue
        .get(id)
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

    case "approve": {
      const id = args[1];
      if (!id) {
        console.error("Error: ID required");
        process.exit(1);
      }

      const notesIndex = args.indexOf("--notes");
      const notes = notesIndex !== -1 ? args[notesIndex + 1] : undefined;

      const reviewerIndex = args.indexOf("--reviewer");
      const reviewer = reviewerIndex !== -1 ? args[reviewerIndex + 1] : undefined;

      queue
        .approve(id, notes, reviewer)
        .then((item) => {
          console.log(`Approved: ${id}`);
          console.log(formatItem(item));
        })
        .catch((e) => {
          console.error(`Error: ${e}`);
          process.exit(1);
        });
      break;
    }

    case "reject": {
      const id = args[1];
      if (!id) {
        console.error("Error: ID required");
        process.exit(1);
      }

      const reasonIndex = args.indexOf("--reason");
      const reason = reasonIndex !== -1 ? args[reasonIndex + 1] : undefined;

      const reviewerIndex = args.indexOf("--reviewer");
      const reviewer = reviewerIndex !== -1 ? args[reviewerIndex + 1] : undefined;

      queue
        .reject(id, reason, reviewer)
        .then((item) => {
          console.log(`Rejected: ${id}`);
          console.log(formatItem(item));
        })
        .catch((e) => {
          console.error(`Error: ${e}`);
          process.exit(1);
        });
      break;
    }

    case "batch-approve": {
      const ids = args.slice(1).filter((a) => !a.startsWith("--"));
      if (ids.length === 0) {
        console.error("Error: At least one ID required");
        process.exit(1);
      }

      const notesIndex = args.indexOf("--notes");
      const notes = notesIndex !== -1 ? args[notesIndex + 1] : undefined;

      queue
        .batchApprove(ids, notes)
        .then((items) => {
          console.log(`Approved ${items.length} items:`);
          for (const item of items) {
            console.log(`  - ${item.id}`);
          }
        })
        .catch((e) => {
          console.error(`Error: ${e}`);
          process.exit(1);
        });
      break;
    }

    case "batch-reject": {
      const ids = args.slice(1).filter((a) => !a.startsWith("--"));
      if (ids.length === 0) {
        console.error("Error: At least one ID required");
        process.exit(1);
      }

      const reasonIndex = args.indexOf("--reason");
      const reason = reasonIndex !== -1 ? args[reasonIndex + 1] : undefined;

      queue
        .batchReject(ids, reason)
        .then((items) => {
          console.log(`Rejected ${items.length} items:`);
          for (const item of items) {
            console.log(`  - ${item.id}`);
          }
        })
        .catch((e) => {
          console.error(`Error: ${e}`);
          process.exit(1);
        });
      break;
    }

    case "stats": {
      queue
        .getStats()
        .then((stats) => {
          console.log(`
Queue Statistics:
  Pending:  ${stats.pending}
  Approved: ${stats.approved}
  Rejected: ${stats.rejected}
  Expired:  ${stats.expired}

By Priority:
  Critical: ${stats.byPriority.critical}
  High:     ${stats.byPriority.high}
  Normal:   ${stats.byPriority.normal}
  Low:      ${stats.byPriority.low}
`);
        })
        .catch((e) => {
          console.error(`Error: ${e}`);
          process.exit(1);
        });
      break;
    }

    case "cleanup": {
      const daysIndex = args.indexOf("--days");
      const daysOld = daysIndex !== -1 ? parseInt(args[daysIndex + 1]) : 30;

      queue
        .cleanup(daysOld)
        .then((result) => {
          console.log(`Cleanup complete:`);
          console.log(`  Expired: ${result.expired}`);
          console.log(`  Removed: ${result.removed}`);
        })
        .catch((e) => {
          console.error(`Error: ${e}`);
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
