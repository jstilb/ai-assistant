#!/usr/bin/env bun
/**
 * WorkQueue.ts - Unified work queue with explicit DAG
 *
 * Phase 3: Thin adapter over PipelineRepository (SQLite).
 * All persistent state lives in pipeline.db — no JSONL file writes,
 * no advisory dir-lock, no backup rotation.
 *
 * The in-memory WorkQueueState is kept as a cache / source-of-truth for
 * pure-logic operations (cycle detection, DAG traversal, rate-limit gate).
 * Mutations are persisted to pipeline.db via upsert so cross-process readers
 * and the parallel-batch claimer use the same serialised store.
 *
 * claimParallelBatch() delegates entirely to repo.claimBatch() which issues
 * BEGIN IMMEDIATE — the exact race-safe path that replaces the advisory lock.
 *
 * Usage:
 *   bun run WorkQueue.ts ready             # Items with all deps met
 *   bun run WorkQueue.ts batch [n]         # Parallel-safe batch (default: 5)
 *   bun run WorkQueue.ts update <id> <status> [result]
 *   bun run WorkQueue.ts add --title "..." --desc "..." [--deps id1,id2] [--priority high]
 *   bun run WorkQueue.ts validate          # Check DAG for cycles / missing deps
 *   bun run WorkQueue.ts status            # Queue summary
 *   bun run WorkQueue.ts item <id>         # Single item detail
 */

import { parseArgs } from "util";
import { writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { generateId } from "../../../../lib/core/GenerateId.ts";
import { loadSettings } from "../../../../lib/core/ConfigLoader.ts";
import { MEMORY } from "../../../../lib/core/MemoryPaths.ts";
import type { TechDebtInput } from "./CompletionPipeline.ts";
import {
  PipelineRepository,
  ALLOWED_TRANSITIONS as CANONICAL_TRANSITIONS,
  getPipelineRepository,
  resetPipelineRepository,
  type Stage,
} from "../../QueueRouter/Tools/PipelineRepository.ts"; // cross-skill-allowed: WorkQueue is a FACADE over the QueueRouter pipeline store by design — single-store design (ADR-003)
// cross-skill-allowed: WorkQueue is a FACADE over the QueueRouter pipeline store by design — single-store design (ADR-003)
import { defaultPipelineDbPath } from "../../QueueRouter/Tools/PipelineDB.ts";
import {
  WORK_STATUS_TO_STAGE,
  workItemToPipelineParams,
  pipelineItemToWorkItem,
} from "../../QueueRouter/Tools/lib/vocabulary.ts"; // cross-skill-allowed: WorkQueue is a FACADE over the QueueRouter pipeline store by design — single-store design (ADR-003)

// ============================================================================
// ISC 5-7: UnrecoverableQueueError (kept for API compatibility; never thrown in
// the SQLite path but callers that catch it must still compile)
// ============================================================================

/**
 * ISC 7: Kept for public API compatibility. In the SQLite-backed implementation
 * this error is never thrown — SQLite provides its own durability guarantees.
 */
export class UnrecoverableQueueError extends Error {
  readonly paths: string[];
  constructor(paths: string[]) {
    super(
      `[WorkQueue] UNRECOVERABLE: all queue files are corrupt and cannot be read. ` +
      `Attempted: ${paths.join(", ")}. ` +
      `Manual intervention required — restore from version control or external backup.`
    );
    this.name = "UnrecoverableQueueError";
    this.paths = paths;
  }
}

// ============================================================================
// Types
// ============================================================================

export type EffortLevel = "TRIVIAL" | "QUICK" | "STANDARD" | "THOROUGH" | "DETERMINED";
export type WorkStatus = "pending" | "in_progress" | "completed" | "partial" | "failed" | "blocked" | "needs_review";
export type Priority = "low" | "normal" | "high" | "critical";

// ─────────────────────────────────────────────────────────────────────────────
// Rate limits state — shape lives in lib/core/MemoryPaths.ts
// ─────────────────────────────────────────────────────────────────────────────

interface RateLimitsConfig {
  enabled: boolean;
  alertThreshold: number;
  pauseThreshold: number;
}

// ALLOWED_TRANSITIONS deleted in S2 — updateStatus() now routes through the canonical
// PipelineRepository.ALLOWED_TRANSITIONS table (imported as CANONICAL_TRANSITIONS).

export interface WorkItemVerification {
  status: "unverified" | "verified" | "failed" | "needs_review";
  verifiedAt: string;
  verdict: "PASS" | "FAIL" | "NEEDS_REVIEW";
  concerns: string[];
  iscRowsVerified: number;
  iscRowsTotal: number;
  verificationCost: number;
  /** Who set this verification — only "skeptical_verifier" is trusted for non-TRIVIAL items. "human_proxy" for resolved human tasks. */
  verifiedBy: "skeptical_verifier" | "human_proxy";
  /** Which tiers of the SkepticalVerifier pipeline actually executed, e.g. [1, 2] or [1, 2, 3] */
  tiersExecuted: number[];
}

export interface WorkItemAttempt {
  attemptNumber: number;
  startedAt: string;
  endedAt: string;
  error: string;
  /** Audit field — always "standard" since S4 deleted the retry-strategy ladder. */
  strategy: "standard";
  iscRowsCompleted?: number;
  iscRowsTotal?: number;
}

/**
 * ISC 16: Typed metadata bag for WorkItem.metadata.
 * At least 15 named fields replacing Record<string, unknown> escape hatches.
 * Extends Record<string, unknown> to remain open for legacy/unknown keys.
 */
export interface WorkItemMetadata extends Record<string, unknown> {
  /** Surface classification for the work item (set by WorkOrchestrator.prepare()) */
  workSurface?: "browser" | "cli" | "api" | "integration" | "native" | "docs";
  /** Per-repo test-runner override for RuntimeVerifier (e.g. pnpm/vitest monorepos) */
  runtimeTestCommand?: string;
  /** Absolute path to the worktree for this work item */
  worktreePath?: string;
  /** Git SHA at work start (for diff computation) */
  startSha?: string;
  /** Git branch name for the feature worktree */
  worktreeBranch?: string;
  /** ISC rows for this item (persisted for cross-process access) */
  iscRows?: import("./WorkOrchestrator.ts").ISCRow[];
  /** Adversarial concerns raised by SkepticalVerifier Phase 2 */
  adversarialConcerns?: string[];
  /** Execution log entries (command, output, exitCode) from Builder agents */
  executionLog?: Array<{ command: string; output: string; exitCode: number; timestamp?: string }>;
  /** History of verification attempts for this item */
  verificationHistory?: Array<{ timestamp: string; verdict: string; concerns: string[]; tiersExecuted?: number[] }>;
  /** Infrastructure errors that are NOT the item's fault (parseSpec failures, tool crashes) */
  infraErrors?: string[];
  /** Count of environment blocks (verification could not run here) — see Principle B2 / Slice 2.
   *  Re-stages do NOT consume the retry counter; this bounds persistent blocks before escalation. */
  environmentBlockCount?: number;
  /** ISO timestamp of the most recent environment block. */
  lastEnvironmentBlock?: string;
  /** Reason string of the most recent environment block (for triage). */
  lastEnvironmentBlockReason?: string;
  /** ISC row IDs classified as human-required (subset of iscRows) */
  manualRows?: number[];
  /** WorkItem IDs of created HUMAN proxy items */
  humanProxyIds?: string[];
  /** Merge status from Integrator.
   *  - "pending_approval": verified-locally, waiting on a human merge approval (Slice 3)
   *  - "approved":         approval granted; eligible for the approval-gated drain
   *  - "merge_started" / "merged" / "conflict" / "deferred" / "skipped" / "failed": lifecycle */
  mergeStatus?: "pending" | "pending_approval" | "approved" | "merge_started" | "merged" | "conflict" | "deferred" | "failed" | "skipped";
  /** GitHub PR URL after merge */
  prUrl?: string;
  /** Reason recorded when item was force-merged or auto-merged */
  mergeReason?: string;
  /** Slice 3: human approval to merge this item to main (first-class resumable step). */
  mergeApproved?: boolean;
  /** Who granted the merge approval. */
  mergeApprovedBy?: string;
  /** ISO timestamp the merge approval was granted. */
  mergeApprovedAt?: string;
  /** ISO timestamp the merge completed. */
  mergedAt?: string;
  /** Diagnostics for a detected merge conflict. */
  conflictDetectedAt?: string;
  conflictReason?: string;
  /** Git diff stat for surface classification (set after first verify attempt) */
  gitDiffStat?: string;
  /** Repo contexts for multi-repo work items */
  repoContexts?: Array<{ name: string; cwd: string; startSha?: string; pathFilter?: string[] }>;
  /** Absolute path to spec file (for re-reading on retry) */
  specPath?: string;
  /** Gate A + Gate B test execution results from the Verifier sub-agent.
   *  Stored here so WorkOrchestrator.verify() can populate ItemReviewSummary.testExecutionResults. */
  testExecutionResults?: {
    gateA?: {
      command: string;
      exitCode: number;
      stdout: string;
      testsPassed?: number;
      testsFailed?: number;
      verdict: "PASS" | "FAIL" | "SKIP";
    };
    gateB?: Array<{
      file: string;
      exitCode: number;
      stdout: string;
      verdict: "PASS" | "FAIL";
    }>;
  };
  /**
   * Builder self-verification (Step 1.5): the live-interaction transcript the
   * BUILDING agent produced by actually running/exercising its own work each
   * iteration. Cheap early-catch; the independent Phase L gate re-runs live
   * exercise regardless and never trusts this transcript. Threaded into
   * ItemReviewSummary for Phase 2 context.
   */
  liveVerificationTranscript?: Array<{
    iteration: number;
    surface: string;
    /** What the builder actually ran. */
    command: string;
    /** Real observed output (stdout/stderr/screenshot path). */
    observed: string;
    exitCode?: number;
    verdict: "PASS" | "FAIL";
    timestamp?: string;
  }>;
  /** ISC 4: Tech debt incurred during this work item, persisted for cross-process visibility. */
  debtIncurred?: TechDebtInput[];
  /** Slice 4: forward-stub loops for a multi-loop epic. The NEXT loop is auto-enqueued
   *  when this item verifies + completes; the remainder is carried onto the new item. */
  followOnLoops?: import("./FollowOnLoops.ts").FollowOnLoop[];
  /** Slice 4: set true once this item's next follow-on loop has been enqueued (idempotency). */
  followOnEnqueued?: boolean;
  /** Slice 4: id of the follow-on loop item enqueued from this one. */
  nextLoopItemId?: string;
  /** Slice 4: the epic's origin item id, threaded through the loop chain for traceability. */
  epicOriginItemId?: string;
  /**
   * LLM-comprehended spec result from comprehendSpec() / generateISC().
   * Set by WorkOrchestrator.prepare(); comprehension is the sole ISC source.
   */
  comprehendedSpec?: import("./Types.ts").ComprehendedSpec;
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
  /** Execution surface: browser, native, cli, api, daemon, library, or unspecified.
   * Carries the producer's LLM-classified surface (ADR-0006); consumed by the
   * SurfaceClassifier bridge to pick the RuntimeVerifier strategy. */
  surface?: "browser" | "native" | "cli" | "api" | "daemon" | "library";
  /** Opaque metadata bag — keeps legacy fields accessible */
  metadata?: WorkItemMetadata;
  /** Persisted verification state — survives process boundaries */
  verification?: WorkItemVerification;
  /**
   * ISO timestamp: item is not eligible for getReadyItems() until this time.
   * Set by recordAttempt() to enforce minimum delay between retry attempts.
   * Undefined = immediately eligible (no cooldown).
   */
  retryEligibleAfter?: string;
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

const PRIORITY_ORDER: Record<Priority, number> = {
  critical: 4,
  high: 3,
  normal: 2,
  low: 1,
};

// ============================================================================
// WorkStatus ↔ Stage codec, WorkItem ↔ PipelineItem codec
//
// Moved to lib/vocabulary.ts (S9) — WORK_STATUS_TO_STAGE is imported above
// (describeWorkStatusExits and updateStatus below still need it as a lookup
// table for error messages and transition validation).
// ============================================================================

/**
 * Human-readable list of WorkStatus-visible exits from `fromStage`, used to build
 * "Illegal transition" error messages (both the wqExcluded pre-check and the
 * canonical-illegal catch in updateStatus() share this).
 *
 * Filters the canonical exits down to:
 *   (a) stages that have a WorkStatus equivalent at all, and
 *   (b) NOT one of the WorkQueue-specific wqExcluded carve-outs (partial→done/failed,
 *       blocked→in-progress, needs-review→done) — those are canonical-legal (for the
 *       spec-pipeline domain) but never valid via WorkQueue.updateStatus().
 */
function describeWorkStatusExits(fromStage: Stage): string {
  const canonicalAllowed = CANONICAL_TRANSITIONS[fromStage] ?? [];
  return canonicalAllowed
    .filter(s => {
      const ws = Object.entries(WORK_STATUS_TO_STAGE).find(([, stage]) => stage === s)?.[0];
      return ws !== undefined &&
        !(fromStage === "partial" && (s === "done" || s === "failed")) &&
        !(fromStage === "blocked" && s === "in-progress") &&
        !(fromStage === "needs-review" && s === "done");
    })
    .map(s => Object.entries(WORK_STATUS_TO_STAGE).find(([, stage]) => stage === s)?.[0])
    .filter((s): s is WorkStatus => Boolean(s))
    .join(", ") || "none";
}

// ============================================================================
// Priority codec, WorkItem ↔ PipelineItem codec
//
// Moved to lib/vocabulary.ts (S9) — workItemToPipelineParams and
// pipelineItemToWorkItem are imported above.
// ============================================================================

// ============================================================================
// DB path derivation
//
// Given a statePath like /tmp/test/wq.json, the pipeline.db lives at:
//   /tmp/test/.kaya/runtime/pipeline.db
// This keeps each WorkQueue instance isolated (tests pin to different tmpDirs).
// ============================================================================

function dbPathFromStatePath(statePath: string): string {
  const dir = dirname(statePath);
  return join(dir, ".kaya", "runtime", "pipeline.db");
}

// ============================================================================
// WorkQueue Class
// ============================================================================

export class WorkQueue {
  private state: WorkQueueState;
  private statePath: string;
  /**
   * PipelineRepository for this instance.
   * Production: shared singleton keyed by dbPath (via getPipelineRepository) so WorkQueue
   * and PipelineFacade use ONE connection per db, preventing stale-handle issues.
   * Test (_createForTesting): fresh in-memory PipelineRepository per instance.
   */
  private repo: PipelineRepository;
  /**
   * ISC 6: Optional callback invoked when loadState() recovers from a corrupt primary file.
   * Kept for API compatibility — not invoked in the SQLite path.
   */
  _onRecoveryAlert?: (message: string) => void;

  // Default resolved at CONSTRUCTION time (not module load) so test files that
  // repoint KAYA_HOME from their module bodies get their own queue file even when
  // WorkQueue was first loaded by an earlier file in a shared-process test run.
  constructor(statePath: string = MEMORY.work.queue.path(), opts?: { onRecoveryAlert?: (msg: string) => void }) {
    this.statePath = statePath;
    // SINGLE-STORE RESOLUTION (Phase 4 divergence fix).
    // The production default location (MEMORY.work.queue.path()) maps to the ONE
    // canonical pipeline.db shared with QueueManager / PipelineFacade
    // (~/.kaya/runtime/pipeline.db). Previously this derived the db from dirname(statePath)
    // → <KAYA_HOME>/MEMORY/WORK/.kaya/runtime/pipeline.db, a DIFFERENT file, so approved
    // items written by QueueManager were invisible to WorkQueue (two stores masquerading
    // as one). An EXPLICIT override path still gets its own isolated store — preserves
    // both deliberate separate-queue callers (WorkOrchestrator opts.queuePath) and tests
    // that isolate by distinct statePaths without pinning KAYA_HOME.
    const dbPath = !statePath
      ? ":memory:"
      : statePath === MEMORY.work.queue.path()
        ? defaultPipelineDbPath()
        : dbPathFromStatePath(statePath);
    // Use the shared singleton so WorkQueue and PipelineFacade share one connection
    // per db path. If the singleton's underlying file was deleted (test beforeEach
    // wipes the temp dir), proactively evict and recreate before calling list().
    // We detect this by checking whether the DB file exists; if not, the singleton
    // is stale and must be evicted (both the PipelineRepository AND PipelineDB
    // singletons) so the next getPipelineRepository creates a fresh DB connection.
    if (dbPath !== ":memory:" && !existsSync(dbPath)) {
      resetPipelineRepository(dbPath);  // evicts _repos + _instances maps
    }
    this.repo = getPipelineRepository(dbPath);
    this._onRecoveryAlert = opts?.onRecoveryAlert;
    this.state = this.loadFromDb();
  }

  /** DI constructor for tests — uses a fresh in-memory pipeline.db with pre-seeded items */
  static _createForTesting(items: WorkItem[]): WorkQueue {
    const wq = Object.create(WorkQueue.prototype) as WorkQueue;
    wq.statePath = "";
    // In-memory pipeline.db. NOTE: getPipelineDb() caches by resolved path and treats
    // ":memory:" as a literal key, so this is actually SHARED across every
    // _createForTesting() call in this test process, not isolated per-call — see the
    // { enforce: false } seeding comment below.
    wq.repo = new PipelineRepository(":memory:");
    wq._onRecoveryAlert = undefined;
    wq.state = {
      items: items.map(i => ({ ...i })),
      lastUpdated: new Date().toISOString(),
      totalProcessed: 0,
      totalFailed: 0,
    };
    // Seed the in-memory DB so claimParallelBatch works correctly. { enforce: false }:
    // this is fixture seeding, not a real transition — PipelineDB's getPipelineDb()
    // caches by resolved path (see PipelineDB.ts _instances map), and ":memory:" is
    // used as a literal path, so ALL _createForTesting() calls within one test process
    // share the same underlying in-memory DB. Fixture ids (e.g. "a"/"b"/"c") are reused
    // across many describe blocks with arbitrary stage values, which are not legal
    // crossings from whatever an earlier test left that id at. Bulk-seed must bypass the
    // transition guard entirely, the same way transfer()/rejectToSpecPipeline() do.
    for (const item of wq.state.items) {
      wq.repo.upsert(workItemToPipelineParams(item), { enforce: false });
    }
    return wq;
  }

  // --------------------------------------------------------------------------
  // Persistence — SQLite-backed
  // --------------------------------------------------------------------------

  /**
   * Load all WorkItems from pipeline.db into in-memory state.
   *
   * Migration path: if a legacy JSON state file exists at statePath and the DB
   * is empty, import items from JSON (applying verification sanitization) into DB.
   * This preserves backward-compat for existing JSON state files.
   */
  private loadFromDb(): WorkQueueState {
    if (!this.statePath) {
      return { items: [], lastUpdated: new Date().toISOString(), totalProcessed: 0, totalFailed: 0 };
    }

    // S5a: pipeline.db is the sole source — no work-queue.json fallback
    // Load active items from DB
    const activeRows = this.repo.list({ stage: [
      "approved", "in-progress", "done", "partial", "failed", "blocked", "needs-review",
    ]});
    const items = activeRows.map(pipelineItemToWorkItem);

    // Reconstruct counters from items (best-effort — counters are advisory)
    const totalProcessed = items.filter(i => i.status === "completed").length;
    const totalFailed = items.filter(i => i.status === "failed").length;

    return {
      items,
      lastUpdated: new Date().toISOString(),
      totalProcessed,
      totalFailed,
    };
  }

  /**
   * Persist a single item to pipeline.db.
   *
   * mergeMetadata defaults to true. pipeline_items is a single store shared
   * with QueueRouter (ADR-003), and WorkQueue keeps an in-memory copy of each
   * item between mutations — a wholesale metadata replace here silently drops
   * any key QueueRouter wrote to the SAME row after this copy was loaded
   * (proven: an independent verifier reproduced a QueueRouter-written key
   * being wiped by WorkQueue's next write; see the "shared-store metadata"
   * tests in WorkQueue.test.ts). The callers with a genuine key-DELETION
   * contract (deleteMetadata(); resumeBlocked(), via updateStatus()) explicitly
   * pass `{ mergeMetadata: false }` — a repo-level merge shallow-unions old+new
   * metadata, so it cannot express "this key is now absent" and would resurrect
   * it from the existing row. setMetadata() itself can NEVER delete (see its own
   * docstring) so it always merges. See PipelineRepository.upsert()'s
   * mergeMetadata docstring for the general contract.
   */
  private persistItem(item: WorkItem, opts?: { mergeMetadata?: boolean }): void {
    this.repo.upsert(workItemToPipelineParams(item), { mergeMetadata: opts?.mergeMetadata ?? true });
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

  public persist(): void {
    for (const item of this.state.items) {
      this.persistItem(item);
    }
  }

  // --------------------------------------------------------------------------
  // ISC 3: Heartbeat stamping
  // --------------------------------------------------------------------------

  /**
   * ISC 3: Stamp `metadata.lastEventAt` on an in-progress item.
   * Uses a 5-second debounce to avoid write amplification: if a natural save
   * is pending within 5s, the timestamp will be flushed as part of that save.
   * Otherwise the debounce fires an explicit save after 5 seconds.
   *
   * The method is safe to call from multiple places: TaskOrchestrator loop,
   * CompletionPipeline stage transitions, and WorkOrchestrator.executeTask().
   */
  touchHeartbeat(itemId: string): void {
    // Skip heartbeat in test mode (_createForTesting sets statePath to "").
    // Heartbeat's purpose is cross-process disk visibility, which is meaningless in unit tests.
    if (!this.statePath) return;
    const item = this.state.items.find(i => i.id === itemId);
    if (!item) return;
    const now = new Date().toISOString();
    if (!item.metadata) item.metadata = {};
    item.metadata.lastEventAt = now;
    this.persistItem(item);
  }

  // --------------------------------------------------------------------------
  // CRUD
  // --------------------------------------------------------------------------

  /**
   * Compatibility alias for addItem() — accepts a minimal { title, description } shape
   * and returns the new item's string ID.
   * Convenience for test code and simple callers that don't need full WorkItem fields.
   */
  add(fields: { title: string; description?: string; priority?: Priority; dependencies?: string[]; source?: WorkItem["source"]; status?: WorkStatus }): string {
    const item = this.addItem({
      title: fields.title,
      description: fields.description ?? "",
      priority: fields.priority ?? "normal",
      dependencies: fields.dependencies ?? [],
      source: fields.source ?? "manual",
      ...(fields.status ? { status: fields.status } : {}),
    });
    return item.id;
  }

  addItem(fields: Omit<WorkItem, "id" | "createdAt" | "status"> & { status?: WorkStatus }): WorkItem {
    const item: WorkItem = {
      ...fields,
      id: generateId("w"),
      status: fields.status || "pending",
      createdAt: new Date().toISOString(),
    };
    this.state.items.push(item);
    this.persistItem(item);
    return item;
  }

  /** Resolve an ID to item — exact match first, prefix fallback for truncated IDs */
  private resolveItem(id: string): WorkItem | undefined {
    return this.state.items.find(i => i.id === id)
      ?? this.state.items.find(i => i.id.startsWith(id) && id.length >= 8);
  }

  getItem(id: string): WorkItem | undefined {
    const item = this.resolveItem(id);
    return item ? structuredClone(item) : undefined;
  }

  getAllItems(): WorkItem[] {
    return this.state.items.map(i => structuredClone(i));
  }

  hasWork(): boolean {
    return this.state.items.some(i => i.status === "pending" || i.status === "in_progress" || i.status === "partial" || i.status === "blocked");
  }

  // --------------------------------------------------------------------------
  // Status transitions
  // --------------------------------------------------------------------------

  /**
   * mergeMetadata (opts, 4th param) defaults to true for the same reason as
   * persistItem() — WorkQueue's `item` here can be a stale in-memory copy
   * relative to a concurrent QueueRouter write on the same pipeline_items row
   * (ADR-003). resumeBlocked() is the one internal caller that unconditionally
   * DELETES metadata keys before reaching this method; it explicitly passes
   * `{ mergeMetadata: false }` so its deletions aren't resurrected by the
   * merge. Every other caller (external: TransitionGuard/WorkOrchestrator/
   * OrphanRecovery; internal: resolveBlocked/resetToPending/recordAttempt/
   * restagePending/markPartial — all grep-audited) only adds metadata or
   * doesn't touch it, so they inherit the safe default.
   */
  updateStatus(id: string, status: WorkStatus, detail?: string, opts?: { mergeMetadata?: boolean }): WorkItem | null {
    const item = this.resolveItem(id);
    if (!item) return null;

    const from = item.status;
    const fromStage: Stage = WORK_STATUS_TO_STAGE[from];
    const toStage: Stage = WORK_STATUS_TO_STAGE[status];

    // WorkQueue execution sub-domain exclusions — STRICTER than the canonical
    // PipelineRepository table, so they stay as a pre-check ahead of the canonical
    // enforcer (repo.transition() below would otherwise ALLOW them; they are a
    // WorkQueue-specific safety class, not a generic transition-legality rule).
    // The canonical table intentionally includes partial→done, partial→failed,
    // blocked→in-progress, and needs-review→done for spec-pipeline use, but the
    // WorkQueue executor must always route back through in_progress first.
    const wqExcluded =
      (fromStage === "partial" && (toStage === "done" || toStage === "failed")) ||
      (fromStage === "blocked" && toStage === "in-progress") ||
      (fromStage === "needs-review" && toStage === "done");
    if (wqExcluded) {
      throw new Error(
        `Illegal transition: "${from}" -> "${status}" for "${item.title}" [${item.id}]. ` +
        `Allowed from "${from}": [${describeWorkStatusExits(fromStage)}]`
      );
    }

    // Hard gate: completion requires passing verification — no exceptions. Also
    // STRICTER than the canonical table (which only knows stage legality, not
    // verification provenance), so this stays as a pre-check too.
    //
    // Gated on canonical legality (read-only lookup — repo.transition() below
    // remains the sole place that ENFORCES + PERSISTS the crossing) so an illegal
    // crossing always surfaces "Illegal transition" from the canonical enforcer,
    // never masked by this gate. Without this guard, e.g. "pending" -> "completed"
    // (canonically illegal: approved has no "done" exit) would incorrectly throw
    // "Completion blocked: no verification record" instead of "Illegal transition" —
    // regressing the pre-existing error-priority contract the test suite encodes.
    const isCanonicallyLegal = !!CANONICAL_TRANSITIONS[fromStage]?.includes(toStage);
    if (isCanonicallyLegal && status === "completed") {
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

    // Compute the next-state fields WITHOUT mutating the tracked `item` yet — it
    // must not advance past the canonical transition() enforcer below, otherwise
    // an illegal-crossing throw would leave in-memory state ahead of pipeline.db
    // (item.status flipped in RAM, nothing actually persisted/rolled back).
    const next: WorkItem = { ...item, status };
    if (status === "in_progress" && !next.startedAt) {
      next.startedAt = new Date().toISOString();
    }
    if (status === "completed") {
      next.completedAt = new Date().toISOString();
      next.retryEligibleAfter = undefined; // clear stale cooldown
      if (detail) next.result = detail;
    }
    if (status === "partial") {
      next.completedAt = undefined; // not fully done yet
      if (detail) next.result = detail;
    }
    if (status === "failed") {
      next.completedAt = new Date().toISOString();
      if (detail) next.error = detail;
    }

    // Atomic enforce + persist via the canonical transition() enforcer — replaces
    // the deleted duplicated CANONICAL_TRANSITIONS legality check + this.persistItem
    // upsert. transition() re-validates fromStage→toStage against the actual DB row
    // and rolls back + throws (writing nothing) on an illegal crossing.
    //
    // "dependencies" is included in the patch — PipelineRepository.transition()'s
    // blobFields set now covers it (slice A4), so it round-trips as JSON like the
    // other blob fields instead of crashing bun:sqlite's binder.
    const { stage: _stage, created_at: _createdAt, updated_at: _updatedAt, id: _pid, ...patch } =
      workItemToPipelineParams(next);
    try {
      this.repo.transition(item.id, toStage, {
        patch,
        actor: "WorkQueue.updateStatus",
        mergeMetadata: opts?.mergeMetadata ?? true,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("illegal transition")) {
        throw new Error(
          `Illegal transition: "${from}" -> "${status}" for "${item.title}" [${item.id}]. ` +
          `Allowed from "${from}": [${describeWorkStatusExits(fromStage)}]`
        );
      }
      throw err;
    }

    // Persisted successfully — commit the computed next-state onto the tracked item
    // (same object reference held in this.state.items, matching prior in-place-mutation semantics).
    Object.assign(item, next);
    if (status === "completed") this.state.totalProcessed++;
    if (status === "failed") this.state.totalFailed++;

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
      this.persistItem(item);
    }
  }

  setEffort(id: string, effort: EffortLevel): void {
    const item = this.resolveItem(id);
    if (item) {
      item.effort = effort;
      this.persistItem(item);
    }
  }

  /**
   * Set (overwrite) key-value pairs in item.metadata (creates metadata if absent).
   *
   * Every value is expected to be defined. This method used to treat
   * `value === undefined` as "delete this key" — a footgun: an unguarded
   * optional silently flowing through (`{ reason: error }` where
   * `error?: string` was never defaulted) would silently DELETE instead of
   * setting, AND would force a wholesale metadata write that re-exposed the
   * exact cross-writer clobber this slice closes (see persistItem()'s
   * docstring). A real instance of this shape shipped in production
   * (WorkOrchestrator.retry()'s environment-block path — fixed alongside this)
   * and a grep-only audit of the ~30 call sites is inspection, not proof —
   * this one was missed by the first pass. Deletion now has its own explicit
   * method — deleteMetadata() — so setMetadata() can never accidentally
   * delete, and can ALWAYS use the safe repo-level metadata merge
   * unconditionally (no more per-call branching).
   *
   * An `undefined` entry is loud-but-non-fatal: console.error with full
   * context (id, key, remedy), then that ONE key is skipped — every other
   * defined key in the same call is still set and persisted. This is
   * deliberately NOT a throw: setMetadata() is reachable from recovery/retry
   * paths (WorkOrchestrator.retry(), OrphanRecovery's per-item sweep) that
   * have no per-item try/catch — OrphanRecovery.recoverOrphanedItems() in
   * particular iterates ALL stale items in one uncaught loop, so a throw from
   * ONE item would abort recovery for every OTHER item in the same batch, and
   * the CLI's `main().catch(console.error)` prints but does not set a
   * non-zero exit code, making a thrown error here LESS visible to
   * exit-code-watching automation than console.error already is. Silently
   * corrupting metadata was the original sin; a throw that can silently take
   * down an unrelated batch of recovery work is trading one blast radius for
   * a worse one when the offending call site is not exhaustively known to be
   * safe. See the workqueue-metadata-clobber-20260730 audit for the full
   * reasoning.
   *
   * Trade-off to weigh before reaching for setMetadata(): skipping an
   * undefined key leaves the PREVIOUS value (if any) in place rather than
   * clearing it. For a "what happened this time" field paired with an
   * advancing counter/timestamp in the same call (e.g. an event-reason field
   * alongside an incrementing count), a stale previous value can read as
   * current and misattribute a new event to an old cause. Prefer a `??
   * fallback` at the call site so the field always reflects THIS call, reach
   * for deleteMetadata() when the key should genuinely go away, and use
   * `...(value ? { key: value } : {})` to omit a key that's legitimately
   * inapplicable for this call (not every optional is a bug — see
   * CompletionPipeline.ts's prUrl, which only applies to the "pr" merge
   * strategy and is correctly absent on a "direct" merge).
   */
  setMetadata(id: string, entries: Record<string, unknown>): void {
    const item = this.resolveItem(id);
    if (!item) return;
    if (!item.metadata) item.metadata = {};
    for (const [key, value] of Object.entries(entries)) {
      if (value === undefined) {
        console.error(
          `[WorkQueue] setMetadata(${id}): entries.${key} is undefined — NOT set (previous value, if any, ` +
          `is unchanged) and NOT deleted. If "${key}" is genuinely inapplicable for this call, omit it ` +
          `instead of passing undefined (e.g. \`...(value ? { ${key}: value } : {})\`) to avoid this log. ` +
          `If it should have had a value, the source is likely an unguarded optional missing a \`?? ` +
          `fallback\`. For an intentional deletion, call deleteMetadata(id, ["${key}"]) instead.`
        );
        continue;
      }
      item.metadata[key] = value;
    }
    this.persistItem(item, { mergeMetadata: true });
  }

  /**
   * Explicitly delete keys from item.metadata — the counterpart to setMetadata()'s
   * unconditional merge. Deletion needs wholesale-replace semantics: a repo-level
   * merge shallow-unions old+new metadata, so it cannot express "this key is now
   * absent" and would resurrect a just-deleted key from the existing DB row (see
   * persistItem()'s docstring). No-op if the item or its metadata doesn't exist.
   */
  deleteMetadata(id: string, keys: string[]): void {
    const item = this.resolveItem(id);
    if (!item || !item.metadata) return;
    for (const key of keys) delete item.metadata[key];
    this.persistItem(item, { mergeMetadata: false });
  }

  /** Update the top-level specPath for an item (e.g., after fallback resolution) */
  setSpecPath(id: string, specPath: string): void {
    const item = this.resolveItem(id);
    if (item) {
      item.specPath = specPath;
      this.persistItem(item);
    }
  }

  /** Update the top-level projectPath for an item (e.g., after title-based resolution) */
  setProjectPath(id: string, projectPath: string): void {
    const item = this.resolveItem(id);
    if (item) {
      item.projectPath = projectPath;
      this.persistItem(item);
    }
  }

  /**
   * Resolve a blocked proxy item to completed.
   * Only items with humanTaskRef can be resolved — uses verifiedBy: "human_proxy".
   */
  resolveBlocked(id: string, result?: string): WorkItem | null {
    const item = this.resolveItem(id);
    if (!item) return null;
    if (item.status !== "blocked") {
      throw new Error(
        `resolveBlocked rejected: item "${item.title}" [${item.id}] status is "${item.status}", expected "blocked"`
      );
    }

    if (!item.humanTaskRef) {
      throw new Error(
        `resolveBlocked rejected: item "${item.title}" [${item.id}] has no humanTaskRef. ` +
        `Only proxy items (with humanTaskRef) can be resolved via resolveBlocked().`
      );
    }

    // Proxy path: human_proxy verification (allowed when humanTaskRef exists)
    this.setVerification(id, {
      status: "verified",
      verifiedAt: new Date().toISOString(),
      verdict: "PASS",
      concerns: [],
      iscRowsVerified: 0,
      iscRowsTotal: 0,
      verificationCost: 0,
      verifiedBy: "human_proxy",
      tiersExecuted: [],
    });

    // Complete via updateStatus (which checks verification gate)
    return this.updateStatus(id, "completed", result || "Blocked item resolved by Jm");
  }

  /**
   * Resume a directly-blocked REAL work item back to `pending` so it can run.
   *
   * Counterpart to resolveBlocked(). The two are mutually exclusive by design:
   * - resolveBlocked() COMPLETES a throwaway human-PROXY item (it REQUIRES a
   *   top-level humanTaskRef). For proxies the human action IS the deliverable,
   *   so completing the proxy — which unblocks the real item via its dependency
   *   — is correct.
   * - resumeBlocked() RE-PENDS a real work item that was directly set to
   *   `blocked` while it waited on a human PREREQUISITE (no top-level
   *   humanTaskRef — the legacy `escalateItem` whole-item path). The build still
   *   has to run, so completing it would be a FALSE completion. Such items used
   *   to be stranded forever: resolveBlocked() rejects them (no humanTaskRef)
   *   and the matrix forbade blocked→pending. This is their recovery path.
   *
   * Rejects proxy items (use resolveBlocked) and non-blocked items.
   */
  resumeBlocked(id: string, reason: string): WorkItem | null {
    const item = this.resolveItem(id);
    if (!item) return null;
    if (item.status !== "blocked") {
      throw new Error(
        `resumeBlocked rejected: item "${item.title}" [${item.id}] status is "${item.status}", expected "blocked"`
      );
    }
    if (item.humanTaskRef) {
      throw new Error(
        `resumeBlocked rejected: item "${item.title}" [${item.id}] is a human-proxy item (has humanTaskRef). ` +
        `Use resolveBlocked() to complete the proxy, not resumeBlocked().`
      );
    }

    // Clear stale run/verification state so a fresh prepare re-derives cleanly.
    item.verification = undefined;
    item.startedAt = undefined;
    item.completedAt = undefined;
    item.error = undefined;
    item.retryEligibleAfter = undefined;

    // Record the resolution and shed the legacy whole-item escalation markers so
    // the item is not mistaken for an open escalation on the next run.
    if (!item.metadata) item.metadata = {};
    item.metadata.blockResolution = {
      resolvedAt: new Date().toISOString(),
      reason,
      priorEscalationReason: item.metadata.escalationReason,
    };
    delete item.metadata.humanTaskRef;
    delete item.metadata.escalationReason;
    delete item.metadata.escalatedAt;

    // Route through updateStatus for transition-matrix validation (blocked → pending).
    // mergeMetadata: false — this method unconditionally deletes 3 metadata keys
    // above; a repo-level merge would resurrect them from the existing DB row
    // (mirrors setMetadata()'s deleting-call carve-out — see persistItem()'s docstring).
    return this.updateStatus(id, "pending", undefined, { mergeMetadata: false });
  }

  /** Get all items with status blocked */
  getBlockedItems(): WorkItem[] {
    return this.state.items.filter(i => i.status === "blocked");
  }

  /** Remove a dependency from an existing item (idempotent) */
  removeDependency(id: string, depId: string): void {
    const item = this.resolveItem(id);
    if (!item) return;
    item.dependencies = item.dependencies.filter(d => d !== depId);
    this.persistItem(item);
  }

  /** Append a dependency to an existing item (additive, idempotent) */
  addDependency(itemId: string, depId: string): void {
    const item = this.resolveItem(itemId);
    if (!item) throw new Error(`Item not found: ${itemId}`);
    const dep = this.resolveItem(depId);
    if (!dep) throw new Error(`Dependency not found: ${depId}`);
    if (!item.dependencies.includes(dep.id)) {
      item.dependencies.push(dep.id);
      this.persistItem(item);
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
    // Retry cooldown: enforce minimum delay between attempts
    const COOLDOWN_SECS: Record<number, number> = { 1: 60, 2: 180, 3: 300 };
    const cooldown = COOLDOWN_SECS[attempt.attemptNumber] ?? 300;
    item.retryEligibleAfter = new Date(Date.now() + cooldown * 1000).toISOString();
    // Route through updateStatus for transition matrix validation (in_progress -> pending)
    return this.updateStatus(id, "pending");
  }

  /**
   * Re-stage an item to pending with a cooldown WITHOUT recording a retry attempt.
   *
   * Unlike recordAttempt(), this does NOT push to item.attempts — so it never
   * advances the 3-strikes escalation counter. Used for environment blocks
   * (Principle B2 / Slice 2): the work is fine but the execution context could not
   * verify it, so the next eligible run should pick it up after the cooldown.
   */
  restagePending(id: string, cooldownMs: number): WorkItem | null {
    const item = this.resolveItem(id);
    if (!item) return null;
    // Reset transient run state (mirrors recordAttempt minus the attempt push)
    item.startedAt = undefined;
    item.completedAt = undefined;
    item.error = undefined;
    item.verification = undefined;
    item.retryEligibleAfter = new Date(Date.now() + Math.max(0, cooldownMs)).toISOString();
    // Route through updateStatus for transition-matrix validation (→ pending).
    return this.updateStatus(id, "pending");
  }

  markPartial(id: string, completedPhases: number[], totalPhases: number, detail?: string): WorkItem | null {
    const item = this.resolveItem(id);
    if (!item) return null;

    // Set phase fields before transition (updateStatus handles partial-specific logic)
    item.completedPhases = completedPhases;
    item.totalPhases = totalPhases;
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
   * S5b: warn-on-detect (replaces the old title-regex auto-wiring).
   * Phase ordering is NO LONGER inferred from "FamilyName Phase N" titles — explicit
   * dependencies + the follow-on engine own ordering. This only OBSERVES: if phase-named
   * items exist in a family without an explicit dependency chaining a later phase to its
   * prior, it logs loudly so the missing-dependency gap is visible (never mutates deps).
   * Returns the number of unwired transitions detected.
   */
  warnUnwiredPhaseItems(): number {
    const familyRegex = /^(.+?)\s+Phase\s+(\d+)/;
    const families = new Map<string, Array<{ item: WorkItem; phase: number }>>();

    for (const item of this.state.items) {
      const match = item.title.match(familyRegex);
      if (!match) continue;
      const family = match[1].trim();
      if (!families.has(family)) families.set(family, []);
      families.get(family)!.push({ item, phase: parseInt(match[2], 10) });
    }

    let warned = 0;
    for (const [family, members] of families.entries()) {
      if (members.length < 2) continue;
      members.sort((a, b) => a.phase - b.phase);
      for (let i = 1; i < members.length; i++) {
        const prev = members[i - 1].item;
        const curr = members[i].item;
        if (!curr.dependencies.includes(prev.id)) {
          console.warn(
            `[WorkQueue] Phase-named item "${curr.title}" has no explicit dependency on its prior ` +
            `phase "${prev.title}" (family "${family}"). S5b no longer auto-wires phase order — ` +
            `add an explicit dependency if this ordering matters.`
          );
          warned++;
        }
      }
    }

    return warned;
  }

  // --------------------------------------------------------------------------
  // Ready items + parallel batching
  // --------------------------------------------------------------------------

  // --------------------------------------------------------------------------
  // Rate Limit Gate
  // --------------------------------------------------------------------------

  /** Read rateLimits config via ConfigLoader (merges settings.json + runtime-config.json) */
  private getRateLimitsConfig(): RateLimitsConfig {
    const defaults: RateLimitsConfig = { enabled: true, alertThreshold: 80, pauseThreshold: 90 };
    try {
      const settings = loadSettings();
      const rl = settings.rateLimits as Partial<RateLimitsConfig> | undefined;
      if (!rl) return defaults;
      return { ...defaults, ...rl };
    } catch {
      return defaults;
    }
  }

  /**
   * Returns true if an item with the given priority is allowed to start.
   * Critical items always proceed. Non-critical items are blocked when either
   * rate limit window exceeds pauseThreshold. State file must be < 30 min old
   * to be trusted; stale file = gate skipped.
   */
  private isRateLimitGateOpen(priority: Priority): boolean {
    const config = this.getRateLimitsConfig();
    if (!config.enabled) return true;
    if (priority === "critical") return true;

    const state = MEMORY.state.rateLimits.read();
    if (!state) return true; // missing/parse-fail/validation-fail = fail open

    // Staleness check: skip gating if file is > 30 minutes old
    if (state.updatedAt) {
      const ageMs = Date.now() - new Date(state.updatedAt).getTime();
      if (ageMs > 30 * 60 * 1000) return true;
    }

    const fiveOver = state.fiveHour !== null && state.fiveHour.usedPercentage > config.pauseThreshold;
    const sevenOver = state.sevenDay !== null && state.sevenDay.usedPercentage > config.pauseThreshold;
    if (fiveOver || sevenOver) {
      console.warn(`[WorkQueue] Rate limit gate: non-critical item paused (5h=${state.fiveHour?.usedPercentage ?? "n/a"}%, 7d=${state.sevenDay?.usedPercentage ?? "n/a"}%)`);
      return false;
    }

    return true;
  }

  /** Items whose status is pending and all dependencies are completed */
  getReadyItems(): WorkItem[] {
    return this.state.items
      .filter(item => {
        if (item.status !== "pending") return false;
        // Retry cooldown gate: skip items still in cooldown window
        if (item.retryEligibleAfter && new Date(item.retryEligibleAfter) > new Date()) return false;
        const depsOk = item.dependencies.every(depId => {
          const dep = this.state.items.find(i => i.id === depId);
          if (!dep) {
            console.warn(`[WorkQueue] Item "${item.title}" has missing dependency "${depId}" — permanently blocked`);
            return false;
          }
          return dep.status === "completed";
        });
        if (!depsOk) return false;
        return this.isRateLimitGateOpen(item.priority);
      })
      // S5b: priority-only ordering. The title-regex "Phase N" tiebreaker is removed —
      // explicit dependencies (the depsOk filter above) + the follow-on engine own phase order.
      .sort((a, b) => PRIORITY_ORDER[b.priority] - PRIORITY_ORDER[a.priority]);
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
   *
   * Selection: `getReadyItems()` + DAG-conflict exclusion runs in-memory on
   * `this.state` (rate-limit gate, cooldown, dependency checks). This produces
   * a candidate id list.
   *
   * Claim: `repo.claimByIds(candidateIds, "approved", "in-progress")` executes
   * ONE BEGIN IMMEDIATE transaction that does a compare-and-swap UPDATE for each
   * candidate id (`WHERE id=? AND stage="approved"`). If another process claimed
   * an item first, its stage will already be "in-progress" → changes()=0 → that
   * id is excluded from the returned set. Zero double-claims by construction.
   *
   * In-memory state is updated from the ACTUAL claimed set (not the candidate
   * set), so this process stays consistent with the DB.
   */
  claimParallelBatch(maxItems: number = 5): WorkItem[] {
    // Step 1: Select candidates in-memory (applies rate-limit gate, cooldown, DAG checks)
    const ready = this.getReadyItems();
    if (ready.length === 0) return [];

    // Build the candidate batch (DAG safety: exclude items sharing a dependency)
    const candidateBatch: WorkItem[] = [ready[0]];
    for (let i = 1; i < ready.length && candidateBatch.length < maxItems; i++) {
      const candidate = ready[i];
      const candidateDeps = new Set(candidate.dependencies);
      const canAdd = candidateBatch.every(bItem => {
        const bDeps = new Set(bItem.dependencies);
        if (candidateDeps.has(bItem.id) || bDeps.has(candidate.id)) return false;
        for (const d of candidateDeps) {
          if (bDeps.has(d)) return false;
        }
        return true;
      });
      if (canAdd) candidateBatch.push(candidate);
    }

    const candidateIds = candidateBatch.map(i => i.id);

    // Step 2: Atomically claim the candidates via compare-and-swap in ONE BEGIN IMMEDIATE.
    // claimByIds returns ONLY the ids this process won (concurrent losers get 0 changes → excluded).
    // "pending" WorkStatus → "approved" Stage → "in-progress" Stage is the claim path.
    const actuallyClaimedRows = this.repo.claimByIds(candidateIds, "approved", "in-progress");
    if (actuallyClaimedRows.length === 0) return [];

    // Step 3: Sync in-memory state from the actual winners (not the candidates)
    const claimedItems: WorkItem[] = [];
    for (const row of actuallyClaimedRows) {
      const fresh = pipelineItemToWorkItem(row);
      const idx = this.state.items.findIndex(i => i.id === row.id);
      if (idx >= 0) {
        this.state.items[idx] = { ...fresh, status: "in_progress", startedAt: row.started_at ?? new Date().toISOString() };
        claimedItems.push(this.state.items[idx]);
      } else {
        // Item wasn't in in-memory state (cross-process seeded item) — add it
        claimedItems.push(fresh);
      }
    }

    return claimedItems;
  }

  /** @deprecated Use claimParallelBatch() which atomically claims items. */
  getParallelBatch(maxItems: number = 5): WorkItem[] {
    return this.claimParallelBatch(maxItems);
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
