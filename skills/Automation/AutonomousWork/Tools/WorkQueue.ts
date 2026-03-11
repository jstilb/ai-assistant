#!/usr/bin/env bun
/**
 * WorkQueue.ts - Unified work queue with explicit DAG
 *
 * Single replacement for QueueManager (CRUD), WorkQueueManager (state),
 * and DependencyManager (DAG). Items live in one JSON file, mutated in place.
 * Dependencies are explicit only — no AI-inferred guessing.
 *
 * Usage:
 *   bun run WorkQueue.ts load              # Import from legacy approved-work.jsonl
 *   bun run WorkQueue.ts ready             # Items with all deps met
 *   bun run WorkQueue.ts batch [n]         # Parallel-safe batch (default: 5)
 *   bun run WorkQueue.ts update <id> <status> [result]
 *   bun run WorkQueue.ts add --title "..." --desc "..." [--deps id1,id2] [--priority high]
 *   bun run WorkQueue.ts validate          # Check DAG for cycles / missing deps
 *   bun run WorkQueue.ts status            # Queue summary
 *   bun run WorkQueue.ts item <id>         # Single item detail
 */

import { parseArgs } from "util";
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, rmdirSync, statSync } from "fs";
import { join, dirname } from "path";

// ============================================================================
// Types
// ============================================================================

export type EffortLevel = "TRIVIAL" | "QUICK" | "STANDARD" | "THOROUGH" | "DETERMINED";
export type WorkStatus = "pending" | "in_progress" | "completed" | "partial" | "failed" | "blocked";
export type Priority = "low" | "normal" | "high" | "critical";

/** Explicit state machine — updateStatus() rejects any transition not listed here */
const ALLOWED_TRANSITIONS: Record<WorkStatus, WorkStatus[]> = {
  pending:         ["in_progress"],
  in_progress:     ["completed", "failed", "partial", "pending", "blocked", "in_progress"],
  partial:         ["in_progress", "pending", "partial"],
  completed:       [],                     // terminal — no transitions out
  failed:          ["pending"],            // retry resets to pending
  blocked:         ["completed", "failed"], // resolved by human or failed
};

export interface WorkItemVerification {
  status: "unverified" | "verified" | "failed" | "needs_review";
  verifiedAt: string;
  verdict: "PASS" | "FAIL" | "NEEDS_REVIEW";
  concerns: string[];
  iscRowsVerified: number;
  iscRowsTotal: number;
  verificationCost: number;
  /** Who set this verification — only "skeptical_verifier" is trusted for non-TRIVIAL items. "human_proxy" for resolved human tasks. */
  verifiedBy: "skeptical_verifier" | "manual" | "human_proxy";
  /** Which tiers of the SkepticalVerifier pipeline actually executed, e.g. [1, 2] or [1, 2, 3] */
  tiersExecuted: number[];
}

export type RetryStrategy = "standard" | "re-prepare" | "decompose";

export interface WorkItemAttempt {
  attemptNumber: number;
  startedAt: string;
  endedAt: string;
  error: string;
  strategy: RetryStrategy;
  iscRowsCompleted?: number;
  iscRowsTotal?: number;
}

export interface WorkItem {
  id: string;
  title: string;
  description: string;
  priority: Priority;
  status: WorkStatus;
  /** Explicit dependency IDs — item cannot start until all are completed */
  dependencies: string[];
  effort?: EffortLevel;
  workType?: "dev" | "research" | "content" | "mixed";
  source: "approval_queue" | "manual";
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  result?: string;
  error?: string;
  /** Append-only log of failed attempts — items retry instead of dying */
  attempts?: WorkItemAttempt[];
  /** Phases completed so far (for multi-phase work items) */
  completedPhases?: number[];
  /** Total phases expected */
  totalPhases?: number;
  /** Spec path for approved-work items */
  specPath?: string;
  /** Test strategy document path */
  testStrategyPath?: string;
  /** Project path for work execution */
  projectPath?: string;
  /** Output path — where verification commands run (defaults to projectPath) */
  outputPath?: string;
  /** If this is a proxy for a human task, stores the linkage */
  humanTaskRef?: {
    lucidTaskId?: string;  // optional: not set for retry-escalated proxies
    queueItemId: string;
    guideFilePath: string;
    createdAt: string;
    attemptHistory?: string;  // failure history from retry escalation
  };
  /** Estimated minutes based on effort tier (TRIVIAL=5, QUICK=15, STANDARD=45, THOROUGH=120, DETERMINED=240) */
  estimatedMinutes?: number;
  /** Opaque metadata bag — keeps legacy fields accessible */
  metadata?: Record<string, unknown>;
  /** Persisted verification state — survives process boundaries */
  verification?: WorkItemVerification;
}

interface WorkQueueState {
  items: WorkItem[];
  lastUpdated: string;
  totalProcessed: number;
  totalFailed: number;
}

// ============================================================================
// Constants
// ============================================================================

const KAYA_HOME = process.env.KAYA_HOME || join(process.env.HOME || "", ".claude");
/** Single source of truth for work queue state — only file read/written by WorkQueue */
const QUEUE_PATH = join(KAYA_HOME, "MEMORY/WORK/work-queue.json");
const LEGACY_JSONL_PATH = join(KAYA_HOME, "MEMORY/QUEUES/approved-work.jsonl");

const PRIORITY_ORDER: Record<Priority, number> = {
  critical: 4,
  high: 3,
  normal: 2,
  low: 1,
};

const PHASE_REGEX = /Phase\s+(\d+)/;

function parsePhaseNumber(title: string): number {
  const match = title.match(PHASE_REGEX);
  return match ? parseInt(match[1], 10) : Infinity;
}

// ============================================================================
// WorkQueue Class
// ============================================================================

const LOCK_TIMEOUT_MS = 10_000;  // 10s max wait to acquire lock
const LOCK_RETRY_MS = 50;        // poll interval
const LOCK_STALE_MS = 30_000;    // 30s stale lock removal

export class WorkQueue {
  private state: WorkQueueState;
  private statePath: string;
  private lockPath: string;
  /** IDs of items mutated since last save — used for lock-aware merge in save() */
  private dirtyItemIds: Set<string> = new Set();
  /** When true, save() merges structural changes (new items, counter bumps) into disk state */
  private dirtyStructural: boolean = false;
  /** Reentrancy depth counter: >0 when this process holds the advisory lock */
  private lockDepth: number = 0;

  constructor(statePath: string = QUEUE_PATH) {
    this.statePath = statePath;
    this.lockPath = statePath + ".lock";
    this.state = this.loadState();
  }

  /** DI constructor for tests — no filesystem */
  static _createForTesting(items: WorkItem[]): WorkQueue {
    const wq = Object.create(WorkQueue.prototype) as WorkQueue;
    wq.statePath = "";
    wq.lockPath = "";
    wq.dirtyItemIds = new Set();
    wq.dirtyStructural = false;
    wq.lockDepth = 0;
    wq.state = {
      items,
      lastUpdated: new Date().toISOString(),
      totalProcessed: 0,
      totalFailed: 0,
    };
    return wq;
  }

  // --------------------------------------------------------------------------
  // Persistence
  // --------------------------------------------------------------------------

  private loadState(): WorkQueueState {
    if (!existsSync(this.statePath)) {
      return { items: [], lastUpdated: new Date().toISOString(), totalProcessed: 0, totalFailed: 0 };
    }
    try {
      const raw = readFileSync(this.statePath, "utf-8");
      const parsed = JSON.parse(raw) as WorkQueueState;
      if (!Array.isArray(parsed.items)) throw new Error("invalid state");
      // Defense-in-depth: sanitize verification objects on load
      for (const item of parsed.items) {
        if (item.verification) {
          item.verification = this.sanitizeVerification(item.verification);
        }
      }
      return parsed;
    } catch (e) {
      console.error("[WorkQueue] Failed to parse state, starting fresh:", e);
      return { items: [], lastUpdated: new Date().toISOString(), totalProcessed: 0, totalFailed: 0 };
    }
  }

  /** Strip unknown fields from verification objects, keeping only whitelisted keys */
  private sanitizeVerification(v: WorkItemVerification & Record<string, unknown>): WorkItemVerification {
    return {
      status: v.status,
      verifiedAt: v.verifiedAt,
      verdict: v.verdict,
      concerns: v.concerns,
      iscRowsVerified: v.iscRowsVerified,
      iscRowsTotal: v.iscRowsTotal,
      verificationCost: v.verificationCost,
      verifiedBy: v.verifiedBy,
      tiersExecuted: v.tiersExecuted,
    };
  }

  /**
   * Lock-aware save: acquires advisory lock, re-reads disk state, merges
   * only the items this process mutated (dirtyItemIds), writes, releases.
   * Prevents last-writer-wins data loss when parallel agents mutate disjoint items.
   */
  private save(): void {
    if (!this.statePath || this.statePath === "/dev/null") return; // testing mode
    const dir = dirname(this.statePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    this.acquireLockSync();
    try {
      // Re-read disk state inside the lock to see other processes' changes
      const diskState = this.loadState();

      // Merge: overlay our dirty items onto the fresh disk state
      if (this.dirtyItemIds.size > 0 || this.dirtyStructural) {
        const diskItemMap = new Map(diskState.items.map(i => [i.id, i]));

        // Apply dirty item mutations: replace disk version with in-memory version
        for (const dirtyId of this.dirtyItemIds) {
          const inMemory = this.state.items.find(i => i.id === dirtyId);
          if (inMemory) {
            diskItemMap.set(dirtyId, inMemory);
          }
        }

        // Structural: new items that don't exist on disk yet
        for (const item of this.state.items) {
          if (!diskItemMap.has(item.id)) {
            diskItemMap.set(item.id, item);
          }
        }

        diskState.items = Array.from(diskItemMap.values());

        // Merge counters: apply deltas rather than overwriting
        if (this.dirtyStructural) {
          diskState.totalProcessed = Math.max(diskState.totalProcessed, this.state.totalProcessed);
          diskState.totalFailed = Math.max(diskState.totalFailed, this.state.totalFailed);
        }
      }

      diskState.lastUpdated = new Date().toISOString();

      // Write merged state
      const tmpPath = this.statePath + ".tmp." + process.pid;
      writeFileSync(tmpPath, JSON.stringify(diskState, null, 2));
      renameSync(tmpPath, this.statePath);

      // Update in-memory state to the merged result (so subsequent reads are consistent)
      this.state = diskState;
      this.dirtyItemIds.clear();
      this.dirtyStructural = false;
    } finally {
      this.releaseLockSync();
    }
  }

  public persist(): void {
    this.save();
  }

  // --------------------------------------------------------------------------
  // Advisory file lock (cross-process mutual exclusion via mkdirSync)
  // --------------------------------------------------------------------------

  private acquireLockSync(): void {
    if (!this.lockPath || this.statePath === "/dev/null") return;
    if (this.lockDepth > 0) { this.lockDepth++; return; } // reentrant: increment depth, skip acquire
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    while (Date.now() < deadline) {
      try {
        mkdirSync(this.lockPath);
        this.lockDepth = 1;
        return; // acquired
      } catch {
        // Lock exists — check for stale lock
        try {
          const lockStat = statSync(this.lockPath);
          if (Date.now() - lockStat.mtimeMs > LOCK_STALE_MS) {
            try { rmdirSync(this.lockPath); } catch { /* race: another process removed it */ }
            continue; // retry
          }
        } catch { /* lock was removed between our mkdirSync and statSync */ continue; }
        // Wait and retry
        const waitMs = Math.min(LOCK_RETRY_MS, deadline - Date.now());
        if (waitMs > 0) Bun.sleepSync(waitMs);
      }
    }
    throw new Error(`WorkQueue: failed to acquire lock after ${LOCK_TIMEOUT_MS}ms (lockPath: ${this.lockPath})`);
  }

  private releaseLockSync(): void {
    if (!this.lockPath || this.statePath === "/dev/null") return;
    if (this.lockDepth <= 0) return; // nothing to release (test mode)
    this.lockDepth--;
    if (this.lockDepth === 0) {
      try { rmdirSync(this.lockPath); } catch { /* already released */ }
    }
    // lockDepth > 0: reentrant release — outer caller still holds the lock
  }

  // --------------------------------------------------------------------------
  // CRUD
  // --------------------------------------------------------------------------

  /** Mark an item as dirty so save() knows to merge it into disk state */
  private markDirty(id: string): void {
    this.dirtyItemIds.add(id);
  }

  addItem(fields: Omit<WorkItem, "id" | "createdAt" | "status"> & { status?: WorkStatus }): WorkItem {
    const item: WorkItem = {
      ...fields,
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      status: fields.status || "pending",
      createdAt: new Date().toISOString(),
    };
    this.state.items.push(item);
    this.markDirty(item.id);
    this.dirtyStructural = true;
    this.save();
    return item;
  }

  /** Resolve an ID to item — exact match first, prefix fallback for truncated IDs */
  private resolveItem(id: string): WorkItem | undefined {
    return this.state.items.find(i => i.id === id)
      ?? this.state.items.find(i => i.id.startsWith(id) && id.length >= 8);
  }

  getItem(id: string): WorkItem | undefined {
    return this.resolveItem(id);
  }

  getAllItems(): WorkItem[] {
    return [...this.state.items];
  }

  hasWork(): boolean {
    return this.state.items.some(i => i.status === "pending" || i.status === "in_progress" || i.status === "partial" || i.status === "blocked");
  }

  // --------------------------------------------------------------------------
  // Status transitions
  // --------------------------------------------------------------------------

  updateStatus(id: string, status: WorkStatus, detail?: string): WorkItem | null {
    const item = this.resolveItem(id);
    if (!item) return null;

    // Transition matrix enforcement — rejects illegal state transitions
    const from = item.status;
    if (!ALLOWED_TRANSITIONS[from]?.includes(status)) {
      throw new Error(
        `Illegal transition: "${from}" -> "${status}" for "${item.title}" [${item.id}]. ` +
        `Allowed from "${from}": [${ALLOWED_TRANSITIONS[from]?.join(", ") || "none"}]`
      );
    }

    // Hard gate: completion requires passing verification — no exceptions
    if (status === "completed") {
      if (!item.verification || item.verification.status !== "verified") {
        const reason = item.verification
          ? `verification status is "${item.verification.status}" (verdict: ${item.verification.verdict})`
          : "no verification record exists";
        throw new Error(
          `Completion blocked for "${item.title}" [${item.id}]: ${reason}. Run verify first.`
        );
      }

      // Provenance gate: non-TRIVIAL items require pipeline verification (or human_proxy for humanTaskRef)
      const effort = item.effort || "STANDARD";
      const isHumanProxy = item.verification.verifiedBy === "human_proxy" && item.humanTaskRef;
      if (effort !== "TRIVIAL" && item.verification.verifiedBy !== "skeptical_verifier" && !isHumanProxy) {
        throw new Error(
          `Completion blocked for "${item.title}": verifiedBy is "${item.verification.verifiedBy}". ` +
          `Non-TRIVIAL items require pipeline verification (or human_proxy for humanTaskRef items).`
        );
      }
    }

    item.status = status;
    if (status === "in_progress" && !item.startedAt) {
      item.startedAt = new Date().toISOString();
    }
    if (status === "completed") {
      item.completedAt = new Date().toISOString();
      if (detail) item.result = detail;
      this.state.totalProcessed++;
      this.dirtyStructural = true;
    }
    if (status === "partial") {
      item.completedAt = undefined; // not fully done yet
      if (detail) item.result = detail;
    }
    if (status === "failed") {
      item.completedAt = new Date().toISOString();
      if (detail) item.error = detail;
      this.state.totalFailed++;
      this.dirtyStructural = true;
    }

    this.markDirty(item.id);
    this.save();
    return item;
  }

  setVerification(id: string, verification: WorkItemVerification): void {
    // Provenance guard: only the SkepticalVerifier pipeline or human_proxy (for humanTaskRef items) may set verification
    const item = this.resolveItem(id);
    const isHumanProxy = verification.verifiedBy === "human_proxy" && item?.humanTaskRef;
    if (verification.verifiedBy !== "skeptical_verifier" && !isHumanProxy) {
      throw new Error(
        `setVerification rejected: verifiedBy "${verification.verifiedBy}" is not "skeptical_verifier". ` +
        `Only the SkepticalVerifier pipeline (or human_proxy for humanTaskRef items) may set verification status.`
      );
    }

    if (item) {
      // Whitelist: only persist known interface fields — strips injected fields like manualVerification
      item.verification = {
        status: verification.status,
        verifiedAt: verification.verifiedAt,
        verdict: verification.verdict,
        concerns: verification.concerns,
        iscRowsVerified: verification.iscRowsVerified,
        iscRowsTotal: verification.iscRowsTotal,
        verificationCost: verification.verificationCost,
        verifiedBy: verification.verifiedBy,
        tiersExecuted: verification.tiersExecuted,
      };
      this.markDirty(item.id);
      this.save();
    }
  }

  /** Maps effort tier to estimated minutes for calibration tracking */
  private static readonly EFFORT_MINUTES: Record<EffortLevel, number> = {
    TRIVIAL: 5,
    QUICK: 15,
    STANDARD: 45,
    THOROUGH: 120,
    DETERMINED: 240,
  };

  setEffort(id: string, effort: EffortLevel): void {
    const item = this.resolveItem(id);
    if (item) {
      item.effort = effort;
      item.estimatedMinutes = WorkQueue.EFFORT_MINUTES[effort];
      this.markDirty(item.id);
      this.save();
    }
  }

  /** Merge key-value pairs into item.metadata (creates metadata if absent) */
  setMetadata(id: string, entries: Record<string, unknown>): void {
    const item = this.resolveItem(id);
    if (!item) return;
    if (!item.metadata) item.metadata = {};
    for (const [key, value] of Object.entries(entries)) {
      item.metadata[key] = value;
    }
    this.markDirty(item.id);
    this.save();
  }

  /** Update the top-level specPath for an item (e.g., after fallback resolution) */
  setSpecPath(id: string, specPath: string): void {
    const item = this.resolveItem(id);
    if (item) {
      item.specPath = specPath;
      this.markDirty(item.id);
      this.save();
    }
  }

  /** Update the top-level projectPath for an item (e.g., after title-based resolution) */
  setProjectPath(id: string, projectPath: string): void {
    const item = this.resolveItem(id);
    if (item) {
      item.projectPath = projectPath;
      this.markDirty(item.id);
      this.save();
    }
  }

  /**
   * Resolve a blocked item to completed.
   * For proxy items (humanTaskRef): uses verifiedBy: "human_proxy".
   * For non-proxy items (former awaiting_manual): uses verifiedBy: "manual" with TRIVIAL effort override.
   */
  resolveBlocked(id: string, result?: string): WorkItem | null {
    const item = this.resolveItem(id);
    if (!item) return null;
    if (item.status !== "blocked") {
      throw new Error(
        `resolveBlocked rejected: item "${item.title}" [${item.id}] status is "${item.status}", expected "blocked"`
      );
    }

    if (item.humanTaskRef) {
      // Proxy path: human_proxy verification (allowed when humanTaskRef exists)
      this.setVerification(id, {
        status: "verified",
        verifiedAt: new Date().toISOString(),
        verdict: "PASS",
        concerns: [],
        iscRowsVerified: 0,
        iscRowsTotal: 0,
        verificationCost: 0,
        verifiedBy: "human_proxy" as WorkItemVerification["verifiedBy"],
        tiersExecuted: [],
      });
    } else {
      // Non-proxy path: manual verification for items without humanTaskRef
      // Set effort to TRIVIAL so the provenance gate allows manual verifiedBy
      item.effort = "TRIVIAL";
      this.markDirty(item.id);
      this.setVerification(id, {
        status: "verified",
        verifiedAt: new Date().toISOString(),
        verdict: "PASS",
        concerns: [],
        iscRowsVerified: 0,
        iscRowsTotal: 0,
        verificationCost: 0,
        verifiedBy: "manual",
        tiersExecuted: [],
      });
    }

    // Complete via updateStatus (which checks verification gate)
    return this.updateStatus(id, "completed", result || "Blocked item resolved by Jm");
  }

  /** Get all items with status blocked */
  getBlockedItems(): WorkItem[] {
    return this.state.items.filter(i => i.status === "blocked");
  }

  /** Append a dependency to an existing item (additive, idempotent) */
  addDependency(itemId: string, depId: string): void {
    const item = this.resolveItem(itemId);
    if (!item) throw new Error(`Item not found: ${itemId}`);
    const dep = this.resolveItem(depId);
    if (!dep) throw new Error(`Dependency not found: ${depId}`);
    if (!item.dependencies.includes(dep.id)) {
      item.dependencies.push(dep.id);
      this.markDirty(item.id);
      this.save();
    }
  }

  /** Reset an in_progress item back to pending (orphan recovery) */
  resetToPending(id: string, reason: string): WorkItem | null {
    const item = this.resolveItem(id);
    if (!item) return null;
    // Clear verification and set audit trail before transition
    item.verification = undefined;
    if (!item.metadata) item.metadata = {};
    item.metadata.lastRecovery = {
      recoveredAt: new Date().toISOString(),
      previousStatus: item.status,
      reason,
    };
    this.markDirty(item.id);
    // Route through updateStatus for transition matrix validation (in_progress -> pending)
    return this.updateStatus(id, "pending");
  }

  /** Record a failed attempt and reset item to pending for retry */
  recordAttempt(id: string, attempt: WorkItemAttempt): WorkItem | null {
    const item = this.resolveItem(id);
    if (!item) return null;
    if (!item.attempts) item.attempts = [];
    item.attempts.push(attempt);
    // Reset fields before transition (updateStatus handles save + dirty tracking)
    item.startedAt = undefined;
    item.completedAt = undefined;
    item.error = undefined;
    item.verification = undefined;
    this.markDirty(item.id);
    // Route through updateStatus for transition matrix validation (in_progress -> pending)
    return this.updateStatus(id, "pending");
  }

  markPartial(id: string, completedPhases: number[], totalPhases: number, detail?: string): WorkItem | null {
    const item = this.resolveItem(id);
    if (!item) return null;

    // Set phase fields before transition (updateStatus handles partial-specific logic)
    item.completedPhases = completedPhases;
    item.totalPhases = totalPhases;
    this.markDirty(item.id);
    // Route through updateStatus for transition matrix validation (in_progress -> partial)
    return this.updateStatus(id, "partial", detail);
  }

  // --------------------------------------------------------------------------
  // DAG — explicit dependencies only
  // --------------------------------------------------------------------------

  /** All direct dependency IDs for an item */
  private getDeps(id: string): string[] {
    return this.state.items.find(i => i.id === id)?.dependencies ?? [];
  }

  /**
   * Detect cycles using DFS with recursion stack.
   * Returns { hasCycle, cycle? } where cycle is the ID path.
   */
  detectCycles(): { hasCycle: boolean; cycle?: string[] } {
    const adjList = new Map<string, string[]>();
    for (const item of this.state.items) {
      // edges go from dependency → dependent (outEdges)
      if (!adjList.has(item.id)) adjList.set(item.id, []);
      for (const depId of item.dependencies) {
        if (!adjList.has(depId)) adjList.set(depId, []);
        adjList.get(depId)!.push(item.id);
      }
    }

    const visited = new Set<string>();
    const inStack = new Set<string>();
    const path: string[] = [];

    const dfs = (node: string): boolean => {
      visited.add(node);
      inStack.add(node);
      path.push(node);

      for (const neighbor of adjList.get(node) ?? []) {
        if (!visited.has(neighbor)) {
          if (dfs(neighbor)) return true;
        } else if (inStack.has(neighbor)) {
          const cycleStart = path.indexOf(neighbor);
          path.splice(0, cycleStart);
          path.push(neighbor);
          return true;
        }
      }

      path.pop();
      inStack.delete(node);
      return false;
    };

    for (const nodeId of adjList.keys()) {
      if (!visited.has(nodeId)) {
        if (dfs(nodeId)) return { hasCycle: true, cycle: [...path] };
      }
    }
    return { hasCycle: false };
  }

  /**
   * Validate DAG integrity: cycles + missing dependency references
   */
  validate(): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    const ids = new Set(this.state.items.map(i => i.id));

    // Missing refs
    for (const item of this.state.items) {
      for (const depId of item.dependencies) {
        if (!ids.has(depId)) {
          errors.push(`Item "${item.title}" references missing dependency: ${depId}`);
        }
      }
    }

    // Cycles
    const cycleResult = this.detectCycles();
    if (cycleResult.hasCycle) {
      errors.push(`Cycle detected: ${cycleResult.cycle?.join(" → ")}`);
    }

    return { valid: errors.length === 0, errors };
  }

  /**
   * Auto-wire phase dependencies within families.
   * Items matching "FamilyName Phase N: ..." get chained: Phase 1 → Phase 2 → Phase 3 etc.
   * Additive only (never removes existing deps), idempotent.
   */
  wirePhaseDependencies(): number {
    const familyRegex = /^(.+?)\s+Phase\s+(\d+)/;
    const families = new Map<string, Array<{ item: WorkItem; phase: number }>>();

    for (const item of this.state.items) {
      const match = item.title.match(familyRegex);
      if (!match) continue;
      const family = match[1].trim();
      const phase = parseInt(match[2], 10);
      if (!families.has(family)) families.set(family, []);
      families.get(family)!.push({ item, phase });
    }

    let wiredCount = 0;
    for (const members of families.values()) {
      if (members.length < 2) continue;
      members.sort((a, b) => a.phase - b.phase);
      for (let i = 1; i < members.length; i++) {
        const prev = members[i - 1].item;
        const curr = members[i].item;
        if (!curr.dependencies.includes(prev.id)) {
          curr.dependencies.push(prev.id);
          this.markDirty(curr.id);
          wiredCount++;
        }
      }
    }

    if (wiredCount > 0) this.save();
    return wiredCount;
  }

  // --------------------------------------------------------------------------
  // Ready items + parallel batching
  // --------------------------------------------------------------------------

  /** Items whose status is pending and all dependencies are completed */
  getReadyItems(): WorkItem[] {
    return this.state.items
      .filter(item => {
        if (item.status !== "pending") return false;
        return item.dependencies.every(depId => {
          const dep = this.state.items.find(i => i.id === depId);
          if (!dep) {
            console.warn(`[WorkQueue] Item "${item.title}" has missing dependency "${depId}" — permanently blocked`);
            return false;
          }
          return dep.status === "completed";
        });
      })
      .sort((a, b) => {
        const priorityDiff = PRIORITY_ORDER[b.priority] - PRIORITY_ORDER[a.priority];
        if (priorityDiff !== 0) return priorityDiff;
        return parsePhaseNumber(a.title) - parsePhaseNumber(b.title);
      });
  }

  /** DAG-blocked items: pending but at least one dep not completed */
  getDagBlockedItems(): WorkItem[] {
    return this.state.items.filter(item => {
      if (item.status !== "pending") return false;
      if (item.dependencies.length === 0) return false;
      return item.dependencies.some(depId => {
        const dep = this.state.items.find(i => i.id === depId);
        if (!dep) {
          console.warn(`[WorkQueue] Item "${item.title}" has missing dependency "${depId}" — permanently blocked`);
        }
        return !dep || dep.status !== "completed";
      });
    });
  }

  /**
   * Claim a parallel-safe batch of ready items.
   * Acquires advisory lock, re-reads state from disk, selects batch,
   * marks each item in_progress, saves, releases lock.
   * Two processes calling this concurrently get disjoint sets.
   */
  claimParallelBatch(maxItems: number = 5): WorkItem[] {
    this.acquireLockSync();
    try {
      // Re-read from disk inside lock to see other processes' changes
      // Skip re-read in test mode (no statePath) to preserve in-memory state
      if (this.statePath) {
        this.state = this.loadState();
      }

      const ready = this.getReadyItems();
      if (ready.length === 0) return [];

      const batch: WorkItem[] = [ready[0]];

      for (let i = 1; i < ready.length && batch.length < maxItems; i++) {
        const candidate = ready[i];
        const candidateDeps = new Set(candidate.dependencies);
        const canAdd = batch.every(bItem => {
          const bDeps = new Set(bItem.dependencies);
          if (candidateDeps.has(bItem.id) || bDeps.has(candidate.id)) return false;
          for (const d of candidateDeps) {
            if (bDeps.has(d)) return false;
          }
          return true;
        });
        if (canAdd) batch.push(candidate);
      }

      // Mark claimed items as in_progress before releasing lock
      for (const item of batch) {
        item.status = "in_progress";
        if (!item.startedAt) item.startedAt = new Date().toISOString();
        this.markDirty(item.id);
      }
      this.dirtyStructural = true;
      this.save();

      return batch;
    } finally {
      this.releaseLockSync();
    }
  }

  /** @deprecated Use claimParallelBatch() which atomically claims items. */
  getParallelBatch(maxItems: number = 5): WorkItem[] {
    return this.claimParallelBatch(maxItems);
  }

  // --------------------------------------------------------------------------
  // Legacy import
  // --------------------------------------------------------------------------

  /**
   * Import items from the legacy approved-work.jsonl format.
   * Only imports actionable items (pending/in_progress/approved) that
   * aren't already in the queue. Orphaned in_progress items reset to pending.
   */
  loadFromLegacy(jsonlPath: string = LEGACY_JSONL_PATH): { imported: number; skipped: number } {
    if (!existsSync(jsonlPath)) return { imported: 0, skipped: 0 };

    const content = readFileSync(jsonlPath, "utf-8").trim();
    if (!content) return { imported: 0, skipped: 0 };

    const existingIds = new Set(this.state.items.map(i => i.id));
    let imported = 0;
    let skipped = 0;

    const priorityMap: Record<number, Priority> = { 1: "high", 2: "normal", 3: "low" };

    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      let entry: Record<string, unknown>;
      try {
        entry = JSON.parse(line);
      } catch {
        skipped++;
        continue;
      }

      const id = entry.id as string;
      if (!id || existingIds.has(id)) {
        skipped++;
        continue;
      }

      const status = entry.status as string;
      // Only import actionable items
      if (status !== "pending" && status !== "in_progress" && status !== "approved") {
        skipped++;
        continue;
      }

      const payload = (entry.payload ?? {}) as Record<string, unknown>;
      const context = (payload.context ?? {}) as Record<string, unknown>;
      const spec = entry.spec as Record<string, unknown> | undefined;
      const project = entry.project as Record<string, unknown> | undefined;

      const item: WorkItem = {
        id,
        title: (payload.title as string) || "Untitled",
        description: (payload.description as string) || "",
        priority: priorityMap[(entry.priority as number)] || "normal",
        status: "pending", // reset orphaned in_progress to pending
        dependencies: (context.dependencies as string[]) || [],
        workType: (entry.type as WorkItem["workType"]) || "dev",
        source: "approval_queue",
        createdAt: (entry.created as string) || new Date().toISOString(),
        specPath: spec?.path as string | undefined,
        testStrategyPath: (spec as Record<string, unknown>)?.testStrategyPath as string | undefined,
        projectPath: project?.path as string | undefined,
        outputPath: (project?.outputPath as string | undefined),
        metadata: {
          spec,
          enrichment: entry.enrichment,
          progress: entry.progress,
          project,
          legacyQueue: entry.queue,
        },
      };

      this.state.items.push(item);
      this.markDirty(item.id);
      existingIds.add(id);
      imported++;
    }

    if (imported > 0) {
      this.dirtyStructural = true;
      this.save();
    }
    return { imported, skipped };
  }

  // --------------------------------------------------------------------------
  // Stats
  // --------------------------------------------------------------------------

  getStats() {
    const items = this.state.items;
    return {
      total: items.length,
      pending: items.filter(i => i.status === "pending").length,
      inProgress: items.filter(i => i.status === "in_progress").length,
      completed: items.filter(i => i.status === "completed").length,
      failed: items.filter(i => i.status === "failed").length,
      partial: items.filter(i => i.status === "partial").length,
      blocked: items.filter(i => i.status === "blocked").length + this.getDagBlockedItems().length,
      ready: this.getReadyItems().length,
      totalProcessed: this.state.totalProcessed,
      totalFailed: this.state.totalFailed,
    };
  }
}

// ============================================================================
// CLI
// ============================================================================

function main() {
  const { values, positionals } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      help: { type: "boolean", short: "h" },
      json: { type: "boolean", short: "j" },
      title: { type: "string" },
      desc: { type: "string" },
      deps: { type: "string" },
      priority: { type: "string" },
      source: { type: "string" },
      status: { type: "string" },
      "human-task-ref": { type: "string" },
    },
    allowPositionals: true,
  });

  const cmd = positionals[0];

  if (values.help || !cmd) {
    console.log(`
WorkQueue — Unified work queue with explicit DAG

Commands:
  load              Import from legacy approved-work.jsonl
  ready             Items with all deps met
  batch [n]         Parallel-safe batch (default 5)
  update <id> <status> [result]
  add --title "..." --desc "..." [--deps id1,id2] [--priority high] [--status blocked] [--human-task-ref '{...}']
  add-dep <id> <dep-id>   Append a dependency to an existing item
  validate          Check DAG for cycles / missing deps
  status            Queue summary
  item <id>         Single item detail
  blocked           List all blocked items (awaiting Jm action)
`);
    return;
  }

  const wq = new WorkQueue();

  switch (cmd) {
    case "load": {
      const result = wq.loadFromLegacy();
      console.log(`Imported ${result.imported} items (${result.skipped} skipped)`);
      break;
    }

    case "ready": {
      const ready = wq.getReadyItems();
      if (values.json) {
        console.log(JSON.stringify(ready, null, 2));
      } else {
        console.log(`Ready: ${ready.length}`);
        for (const item of ready) {
          console.log(`  [${item.priority}] ${item.id}  ${item.title.slice(0, 50)}`);
        }
      }
      break;
    }

    case "batch": {
      const n = parseInt(positionals[1]) || 5;
      const batch = wq.getParallelBatch(n);
      if (values.json) {
        console.log(JSON.stringify(batch, null, 2));
      } else {
        console.log(`Batch (max ${n}): ${batch.length} items`);
        for (const item of batch) {
          console.log(`  [${item.priority}] ${item.id}  ${item.title.slice(0, 50)}`);
        }
      }
      break;
    }

    case "update": {
      const id = positionals[1];
      const status = positionals[2] as WorkStatus;
      const detail = positionals[3];
      if (!id || !status) {
        console.error("Usage: update <id> <status> [result]");
        process.exit(1);
      }
      // Block direct completion from CLI — must use WorkOrchestrator.ts report-done
      if (status === "completed") {
        console.error("Direct completion disabled. Use WorkOrchestrator.ts report-done.");
        process.exit(1);
      }
      try {
        const item = wq.updateStatus(id, status, detail);
        if (item) console.log(`${item.id} → ${item.status}`);
        else { console.error(`Not found: ${id}`); process.exit(1); }
      } catch (err) {
        console.error(`Blocked: ${err instanceof Error ? err.message : err}`);
        process.exit(1);
      }
      break;
    }

    case "add": {
      const title = values.title;
      const desc = values.desc || "";
      const deps = values.deps ? values.deps.split(",").map(s => s.trim()) : [];
      const priority = (values.priority || "normal") as Priority;
      const initialStatus = (values.status as WorkStatus) || undefined;
      if (!title) { console.error("--title required"); process.exit(1); }
      const addFields: Parameters<typeof wq.addItem>[0] = {
        title, description: desc, priority, dependencies: deps, source: "manual",
      };
      if (initialStatus) addFields.status = initialStatus;
      if (values["human-task-ref"]) {
        try {
          addFields.humanTaskRef = JSON.parse(values["human-task-ref"]);
        } catch {
          console.error("--human-task-ref must be valid JSON");
          process.exit(1);
        }
      }
      const item = wq.addItem(addFields);
      console.log(`Added: ${item.id}`);
      break;
    }

    case "add-dep": {
      const itemId = positionals[1];
      const depId = positionals[2];
      if (!itemId || !depId) {
        console.error("Usage: add-dep <item-id> <dep-id>");
        process.exit(1);
      }
      try {
        wq.addDependency(itemId, depId);
        console.log(`Dependency added: ${itemId} now depends on ${depId}`);
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : err}`);
        process.exit(1);
      }
      break;
    }

    case "blocked": {
      const items = wq.getBlockedItems();
      if (values.json) {
        console.log(JSON.stringify(items, null, 2));
      } else {
        console.log(`Blocked: ${items.length}`);
        for (const item of items) {
          const ref = item.humanTaskRef;
          const lucidId = ref?.lucidTaskId || "n/a";
          console.log(`  ${item.id}  ${item.title.slice(0, 50)}  (LucidTask: ${lucidId})`);
        }
      }
      break;
    }

    case "validate": {
      const result = wq.validate();
      if (result.valid) {
        console.log("DAG valid — no cycles, no missing deps");
      } else {
        console.error("DAG invalid:");
        for (const e of result.errors) console.error(`  - ${e}`);
        process.exit(1);
      }
      break;
    }

    case "status": {
      const s = wq.getStats();
      if (values.json) {
        console.log(JSON.stringify(s, null, 2));
      } else {
        console.log(`Total: ${s.total}  Pending: ${s.pending}  In-Progress: ${s.inProgress}  Completed: ${s.completed}  Failed: ${s.failed}  Blocked: ${s.blocked}  Ready: ${s.ready}`);
      }
      break;
    }

    case "item": {
      const id = positionals[1];
      if (!id) { console.error("Usage: item <id>"); process.exit(1); }
      const item = wq.getItem(id);
      if (item) console.log(JSON.stringify(item, null, 2));
      else { console.error(`Not found: ${id}`); process.exit(1); }
      break;
    }

    default:
      console.error(`Unknown: ${cmd}. Use --help.`);
      process.exit(1);
  }
}

if (import.meta.main) main();
