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
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";

// ============================================================================
// Types
// ============================================================================

export type EffortLevel = "TRIVIAL" | "QUICK" | "STANDARD" | "THOROUGH" | "DETERMINED";
export type WorkStatus = "pending" | "in_progress" | "completed" | "partial" | "failed";
export type Priority = "low" | "normal" | "high" | "critical";

export interface WorkItemVerification {
  status: "unverified" | "verified" | "failed" | "needs_review";
  verifiedAt: string;
  verdict: "PASS" | "FAIL" | "NEEDS_REVIEW";
  concerns: string[];
  iscRowsVerified: number;
  iscRowsTotal: number;
  verificationCost: number;
  /** Who set this verification — only "skeptical_verifier" is trusted for non-TRIVIAL items */
  verifiedBy: "skeptical_verifier" | "manual";
  /** Which tiers of the SkepticalVerifier pipeline actually executed, e.g. [1, 2] or [1, 2, 3] */
  tiersExecuted: number[];
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
  /** Phases completed so far (for multi-phase work items) */
  completedPhases?: number[];
  /** Total phases expected */
  totalPhases?: number;
  /** Spec path for approved-work items */
  specPath?: string;
  /** Project path for work execution */
  projectPath?: string;
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

export class WorkQueue {
  private state: WorkQueueState;
  private statePath: string;

  constructor(statePath: string = QUEUE_PATH) {
    this.statePath = statePath;
    this.state = this.loadState();
  }

  /** DI constructor for tests — no filesystem */
  static _createForTesting(items: WorkItem[]): WorkQueue {
    const wq = Object.create(WorkQueue.prototype) as WorkQueue;
    wq.statePath = "";
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
      return parsed;
    } catch {
      return { items: [], lastUpdated: new Date().toISOString(), totalProcessed: 0, totalFailed: 0 };
    }
  }

  private save(): void {
    if (!this.statePath) return; // testing mode
    const dir = dirname(this.statePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.state.lastUpdated = new Date().toISOString();
    writeFileSync(this.statePath, JSON.stringify(this.state, null, 2));
  }

  // --------------------------------------------------------------------------
  // CRUD
  // --------------------------------------------------------------------------

  addItem(fields: Omit<WorkItem, "id" | "createdAt" | "status">): WorkItem {
    const item: WorkItem = {
      ...fields,
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      status: "pending",
      createdAt: new Date().toISOString(),
    };
    this.state.items.push(item);
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
    return this.state.items.some(i => i.status === "pending" || i.status === "in_progress" || i.status === "partial");
  }

  // --------------------------------------------------------------------------
  // Status transitions
  // --------------------------------------------------------------------------

  updateStatus(id: string, status: WorkStatus, detail?: string): WorkItem | null {
    const item = this.resolveItem(id);
    if (!item) return null;

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
    }

    item.status = status;
    if (status === "in_progress" && !item.startedAt) {
      item.startedAt = new Date().toISOString();
    }
    if (status === "completed") {
      item.completedAt = new Date().toISOString();
      if (detail) item.result = detail;
      this.state.totalProcessed++;
    }
    if (status === "partial") {
      item.completedAt = undefined; // not fully done yet
      if (detail) item.result = detail;
    }
    if (status === "failed") {
      item.completedAt = new Date().toISOString();
      if (detail) item.error = detail;
      this.state.totalFailed++;
    }

    this.save();
    return item;
  }

  setVerification(id: string, verification: WorkItemVerification): void {
    const item = this.resolveItem(id);
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
      this.save();
    }
  }

  setEffort(id: string, effort: EffortLevel): void {
    const item = this.resolveItem(id);
    if (item) {
      item.effort = effort;
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
    this.save();
  }

  /** Reset an in_progress item back to pending (orphan recovery) */
  resetToPending(id: string, reason: string): WorkItem | null {
    const item = this.resolveItem(id);
    if (!item) return null;
    if (item.status !== "in_progress") {
      throw new Error(
        `resetToPending only valid from in_progress, got "${item.status}" for "${item.title}" [${item.id}]`
      );
    }
    item.status = "pending";
    item.verification = undefined;
    if (!item.metadata) item.metadata = {};
    item.metadata.lastRecovery = {
      recoveredAt: new Date().toISOString(),
      previousStatus: "in_progress",
      reason,
    };
    this.save();
    return item;
  }

  markPartial(id: string, completedPhases: number[], totalPhases: number, detail?: string): WorkItem | null {
    const item = this.resolveItem(id);
    if (!item) return null;

    item.status = "partial";
    item.completedPhases = completedPhases;
    item.totalPhases = totalPhases;
    if (detail) item.result = detail;

    this.save();
    return item;
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
          return dep?.status === "completed";
        });
      })
      .sort((a, b) => {
        const priorityDiff = PRIORITY_ORDER[b.priority] - PRIORITY_ORDER[a.priority];
        if (priorityDiff !== 0) return priorityDiff;
        return parsePhaseNumber(a.title) - parsePhaseNumber(b.title);
      });
  }

  /** Blocked items: pending but at least one dep not completed */
  getBlockedItems(): WorkItem[] {
    return this.state.items.filter(item => {
      if (item.status !== "pending") return false;
      if (item.dependencies.length === 0) return false;
      return item.dependencies.some(depId => {
        const dep = this.state.items.find(i => i.id === depId);
        return !dep || dep.status !== "completed";
      });
    });
  }

  /**
   * Get a parallel-safe batch of ready items.
   * Excludes items that share dependencies with each other to prevent
   * two items modifying the same thing concurrently.
   */
  getParallelBatch(maxItems: number = 5): WorkItem[] {
    const ready = this.getReadyItems();
    if (ready.length === 0) return [];

    const batch: WorkItem[] = [ready[0]];

    for (let i = 1; i < ready.length && batch.length < maxItems; i++) {
      const candidate = ready[i];

      // Two items conflict if one depends on the other
      // (shouldn't happen since both are "ready", but guard anyway)
      // OR if they share any dependency ID (heuristic for same-resource conflict)
      const candidateDeps = new Set(candidate.dependencies);
      const canAdd = batch.every(bItem => {
        const bDeps = new Set(bItem.dependencies);
        // No mutual dependency
        if (candidateDeps.has(bItem.id) || bDeps.has(candidate.id)) return false;
        // No shared dependency
        for (const d of candidateDeps) {
          if (bDeps.has(d)) return false;
        }
        return true;
      });

      if (canAdd) batch.push(candidate);
    }

    return batch;
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
        projectPath: project?.path as string | undefined,
        metadata: {
          spec,
          enrichment: entry.enrichment,
          progress: entry.progress,
          project,
          legacyQueue: entry.queue,
        },
      };

      this.state.items.push(item);
      existingIds.add(id);
      imported++;
    }

    if (imported > 0) this.save();
    return { imported, skipped };
  }

  // --------------------------------------------------------------------------
  // Stats
  // --------------------------------------------------------------------------

  getStats() {
    const items = this.state.items;
    const blocked = this.getBlockedItems();
    return {
      total: items.length,
      pending: items.filter(i => i.status === "pending").length,
      inProgress: items.filter(i => i.status === "in_progress").length,
      completed: items.filter(i => i.status === "completed").length,
      failed: items.filter(i => i.status === "failed").length,
      partial: items.filter(i => i.status === "partial").length,
      blocked: blocked.length,
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
  add --title "..." --desc "..." [--deps id1,id2] [--priority high]
  validate          Check DAG for cycles / missing deps
  status            Queue summary
  item <id>         Single item detail
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
      if (!title) { console.error("--title required"); process.exit(1); }
      const item = wq.addItem({ title, description: desc, priority, dependencies: deps, source: "manual" });
      console.log(`Added: ${item.id}`);
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
