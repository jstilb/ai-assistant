#!/usr/bin/env bun
/**
 * PipelineRepository.ts — Unified Pipeline State Machine Repository
 *
 * Single transactional store for all autonomous-work pipeline state.
 * Replaces three diverging file stores:
 *   • WorkQueue JSONL  (skills/Automation/AutonomousWork/Tools/WorkQueue.ts)
 *   • QueueManager JSONL (skills/Automation/QueueRouter/Tools/QueueManager.ts)
 *   • Approval queue JSONL
 *
 * ============================================================================
 * FIELD MAPPING
 * ============================================================================
 *
 * The WorkItem <-> PipelineItem <-> QueueItem field mapping lives in
 * Tools/lib/vocabulary.ts as typed, tested, pure converter functions (S9).
 * Do NOT maintain a parallel table here — it drifted for months. Change the
 * mapping in vocabulary.ts and its round-trip tests, nowhere else.
 * ============================================================================
 *
 * @module PipelineRepository
 */

import { getPipelineDb, defaultPipelineDbPath, withRetry, resetPipelineDb } from "./PipelineDB.ts";
import { generateId } from "../../../../lib/core/GenerateId.ts";
import { recordFailure } from "../../../../lib/core/FailureLog.ts";
import type { Database } from "bun:sqlite";

// ============================================================================
// Stage Enum (unified pipeline stages)
// ============================================================================

export const STAGES = [
  "intake",             // newly entered — equivalent to QueueItem "pending" / "awaiting-context"
  "needs-grilling",     // HUMAN-GATE: /queue grill required
  "researching",        // autonomous research phase
  "generating-spec",    // spec generation in progress
  "revision-needed",    // spec needs rework
  "escalated",          // terminal for spec pipeline (no auto-transitions out)
  "awaiting-approval",  // spec awaiting human approval
  "approved",           // spec approved; eligible for work execution
  "in-progress",        // work actively being executed
  "partial",            // partially completed (multi-phase)
  "needs-review",       // execution done, human review needed
  "blocked",            // blocked on dependency or external factor
  "done",               // terminal: successfully completed
  "failed",             // terminal: failed (may retry via transition to intake)
  "rejected",           // terminal: rejected by human
  "archived",           // soft-deleted; excluded from normal queries
] as const;

export type Stage = typeof STAGES[number];

// ============================================================================
// Unified Transition Table
//
// Derived by merging:
//   WorkQueue.ALLOWED_TRANSITIONS (WorkStatus → WorkStatus)
//   QueueManager.SPEC_PIPELINE_TRANSITIONS (QueueItemStatus → QueueItemStatus)
//
// Mapping of old statuses to unified stages:
//   WorkQueue:
//     pending          → intake
//     in_progress      → in-progress
//     completed        → done
//     partial          → partial
//     failed           → failed
//     blocked          → blocked
//     needs_review     → needs-review
//
//   QueueManager:
//     awaiting-context → intake       (maps to same "newly entered" concept)
//     pending          → intake       (generic queue pending)
//     in_progress      → in-progress
//     awaiting_approval → awaiting-approval
//     completed        → done
//     failed           → failed
//     approved         → approved
//     rejected         → rejected
//     researching      → researching
//     generating-spec  → generating-spec
//     revision-needed  → revision-needed
//     escalated        → escalated
//     needs-grilling   → needs-grilling
// ============================================================================

export const ALLOWED_TRANSITIONS: Record<Stage, Stage[]> = {
  // intake: entry point — can begin research/grilling, or be claimed for work
  // (maps to WorkQueue.pending→in_progress + QueueManager.awaiting-context→researching/needs-grilling)
  // self-loop: maps QueueManager's awaiting-context self-loop (metadata-only updates without
  // leaving the stage, e.g. resetting researchTimeouts for a human-attended retry).
  "intake": [
    "intake",            // self-loop: metadata-only update (QueueManager awaiting-context self-loop)
    "in-progress",       // direct claim for work (WorkQueue path)
    "researching",       // spec pipeline: advance to research
    "needs-grilling",    // spec pipeline: human gate
    "awaiting-approval", // spec already exists, skip pipeline
    "approved",          // pre-approved work
    "failed",            // immediate reject
    "rejected",
    "archived",
  ],

  // needs-grilling: HUMAN-GATE
  // (QueueManager.needs-grilling → researching | awaiting-context(=intake) | needs-grilling)
  "needs-grilling": [
    "researching",       // grill finalized → advance
    "intake",            // grill deferred → back to intake
    "needs-grilling",    // idempotent re-park (update brief in place)
    "rejected",
    "archived",
  ],

  // researching: autonomous research phase
  // (QueueManager.researching → generating-spec | awaiting-context | needs-grilling)
  "researching": [
    "generating-spec",   // research complete → spec generation
    "intake",            // needs more context → back to intake
    "needs-grilling",    // pull back to grill
    "escalated",         // unresolvable → escalate
    "failed",
    "archived",
  ],

  // generating-spec: spec generation in progress
  // (QueueManager.generating-spec → revision-needed | awaiting-context | needs-grilling)
  "generating-spec": [
    "revision-needed",   // spec needs rework
    "awaiting-approval", // spec ready for human approval
    "intake",            // needs more context
    "needs-grilling",    // pull back to grill
    "escalated",
    "failed",
    "archived",
  ],

  // revision-needed: spec rework required
  // (QueueManager.revision-needed → researching | escalated)
  "revision-needed": [
    "researching",       // rework: re-research
    "generating-spec",   // direct re-spec attempt
    "escalated",         // give up
    "failed",
    "archived",
  ],

  // escalated: terminal for spec pipeline — no auto-transitions
  // (QueueManager.escalated → [])
  "escalated": [
    "intake",            // human manually resets
    "archived",
  ],

  // awaiting-approval: human approval gate for specs
  // (QueueManager.awaiting_approval + WorkQueue has no direct equivalent — bridges here)
  "awaiting-approval": [
    "approved",          // human approves
    "rejected",          // human rejects
    "revision-needed",   // human requests changes
    "archived",
  ],

  // approved: ready for work execution
  // (QueueManager.approved → in-progress via executor)
  "approved": [
    "in-progress",       // executor claims it
    "rejected",          // human revokes
    "archived",
  ],

  // in-progress: actively being executed
  // (WorkQueue.in_progress → completed|failed|partial|pending|blocked|in_progress|needs_review)
  "in-progress": [
    "done",              // successfully completed
    "failed",            // execution failed
    "partial",           // partial completion (multi-phase)
    "approved",          // reset to approved for retry/unblock (WorkQueue.in_progress→pending)
    "intake",            // reset to beginning
    "blocked",           // blocked on dep or external
    "in-progress",       // self-loop: metadata update / re-claim
    "needs-review",      // human review required
    "archived",
  ],

  // partial: partially completed (multi-phase)
  // (WorkQueue.partial → in_progress | pending | partial)
  "partial": [
    "in-progress",       // resume next phase
    "approved",          // reset to approved for retry (WorkQueue.partial→pending)
    "intake",            // reset
    "partial",           // self-loop: phase update
    "done",              // all phases done
    "failed",
    "archived",
  ],

  // needs-review: awaiting human review after execution
  // (WorkQueue.needs_review → pending | in_progress | failed)
  "needs-review": [
    "approved",          // reset to approved for retry (WorkQueue.needs_review→pending)
    "intake",            // retry
    "in-progress",       // resume
    "failed",            // abandon
    "done",              // human accepts as-is
    "archived",
  ],

  // blocked: blocked on dependency or external
  // (WorkQueue.blocked → completed|failed|pending)
  "blocked": [
    "done",              // proxy completed (resolveBlocked)
    "failed",            // abandon
    "approved",          // re-approved once blocker clears (WorkQueue.blocked→pending)
    "intake",            // re-pending once blocker clears (resumeBlocked)
    "in-progress",       // directly resume
    "archived",
  ],

  // Terminal stages — extremely limited exits (only human rescue ops)
  "done": [
    "archived",          // archive completed work
  ],

  "failed": [
    "approved",          // retry: reset to approved (WorkQueue.failed→pending)
    "intake",            // retry: reset to beginning (WorkQueue.failed→pending)
    "archived",
  ],

  "rejected": [
    "archived",
  ],

  "archived": [
    // No transitions out — permanent soft-delete
  ],
};

// ============================================================================
// PipelineItem Model
// ============================================================================

export interface PipelineItemSpec {
  id: string;
  path: string;
  status: "draft" | "approved";
  approvedAt?: string;
  approvedBy?: string;
}

export interface PipelineItemProgress {
  currentPhase?: number;
  totalPhases?: number;
  phasesCompleted?: number[];
  iscStatus?: Record<string, { completed: boolean; completedAt?: string; evidence?: string }>;
  lastUpdated?: string;
}

export interface PipelineItem {
  // Identity
  id: string;

  // State machine
  stage: Stage;

  // Scheduling
  priority: 1 | 2 | 3;
  source?: string;
  type?: string;
  queue?: string;
  title: string;
  description: string;

  // Cross-references
  lucid_task_id?: string;

  // Spec linkage (first-class for querying)
  spec_id?: string;
  spec_path?: string;
  spec_status?: "draft" | "approved";
  spec_approved_at?: string;
  spec_approved_by?: string;

  // Dependencies (array of sibling pipeline_item ids)
  dependencies: string[];

  // Execution
  started_at?: string;
  completed_at?: string;
  result?: string;
  error?: string;

  // Work paths
  project_path?: string;
  output_path?: string;
  worktree_path?: string;
  worktree_branch?: string;

  // Retry
  retry_eligible_after?: string;

  // Opaque JSON blobs
  metadata: Record<string, unknown>;
  context: Record<string, unknown>;
  attempts: unknown[];
  progress: PipelineItemProgress;
  isc_rows: unknown[];

  // Audit
  created_at: string;
  updated_at: string;

  // Verification (JSON blob matching WorkItemVerification shape)
  verification?: {
    status: "unverified" | "verified" | "failed" | "needs_review";
    verifiedAt: string;
    verdict: "PASS" | "FAIL" | "NEEDS_REVIEW";
    concerns: string[];
    iscRowsVerified: number;
    iscRowsTotal: number;
    verificationCost: number;
    verifiedBy: "skeptical_verifier" | "human_proxy";
    tiersExecuted: number[];
  };
}

// ============================================================================
// Event Model (pipeline_events — append-only audit trail, slice A1/A2)
// ============================================================================

/**
 * One row of the append-only pipeline_events audit trail.
 *
 * `id` is the autoincrement primary key — it's monotonic and gap-free per
 * insert order, which makes it the right checkpoint field for a polling
 * consumer (slice D2's edge-triggered notification poller): unlike `ts`
 * (ISO-8601 string), two events written in the same millisecond can't
 * collide on `id`, and "give me everything after id N" is a single
 * indexed range scan with no ambiguity about ties.
 */
export interface PipelineEvent {
  id: number;
  item_id: string;
  from_stage: Stage | null;
  /**
   * Typed as `Stage` here, but `rowToEvent`'s `row.to_stage as Stage` is an UNVALIDATED cast —
   * appendCrossRefEvent() (see its JSDoc) deliberately writes free-text pseudo-stages like
   * "lane-a-started" / "lane-a-verified" / "lane-a-merged" that are NOT members of the real
   * `Stage` enum, because pipeline_events.to_stage has no CHECK constraint (unlike
   * pipeline_items.stage). Those rows pass through this cast unvalidated at read time too.
   * Functionally safe: cross-ref events never have a pipeline_items row, so they can never
   * collide with — or be mistaken for — a real Stage transition by any code that actually
   * switches on Stage values (see PipelineIntegrity.checkGuardBypass, which is structurally
   * blind to them via its INNER JOIN). Treat `to_stage` as `Stage | string` in spirit.
   */
  to_stage: Stage;
  actor: string;
  note: string | null;
  ts: string;
}

function rowToEvent(row: DbRow): PipelineEvent {
  return {
    id: row.id as number,
    item_id: row.item_id as string,
    from_stage: (row.from_stage as Stage | null) ?? null,
    to_stage: row.to_stage as Stage,
    actor: row.actor as string,
    note: (row.note as string | null) ?? null,
    ts: row.ts as string,
  };
}

// ============================================================================
// Integrity Report
// ============================================================================

export interface IntegrityReport {
  ok: boolean;
  errors: string[];
  warnings: string[];
  checkedAt: string;
  stats: {
    total: number;
    byStage: Record<string, number>;
  };
}

// ============================================================================
// Filter
// ============================================================================

export interface PipelineFilter {
  stage?: Stage | Stage[];
  priority?: 1 | 2 | 3;
  queue?: string;
  source?: string;
  lucid_task_id?: string;
  spec_id?: string;
  limit?: number;
  offset?: number;
  includeArchived?: boolean;
}

// ============================================================================
// ID Generation
// ============================================================================

export function generatePipelineId(): string {
  return generateId("pi");
}

// ============================================================================
// Row Codec (DB row ↔ PipelineItem)
// ============================================================================

type DbRow = Record<string, unknown>;

function parseJson<T>(raw: unknown, fallback: T): T {
  if (raw === null || raw === undefined) return fallback;
  if (typeof raw !== "string") return raw as T;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/**
 * Canonical (key-order-independent) JSON serialization, used only by
 * upsert()'s dirty-check (see its docstring). Object keys are sorted
 * recursively; array element order is preserved (order is semantically
 * significant there). This lets two structurally-equal values (e.g. a
 * `metadata` object rebuilt by a caller in a different field insertion
 * order than it was originally stored) compare equal, where a raw
 * `JSON.stringify(a) === JSON.stringify(b)` string compare would wrongly
 * report them as different.
 */
function canonicalJson(value: unknown): string | undefined {
  return JSON.stringify(value, (_key, val: unknown) => {
    if (val && typeof val === "object" && !Array.isArray(val)) {
      const entries = Object.entries(val as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
      return Object.fromEntries(entries);
    }
    return val;
  });
}

function rowToItem(row: DbRow): PipelineItem {
  return {
    id: row.id as string,
    stage: row.stage as Stage,
    priority: (row.priority as 1 | 2 | 3) ?? 2,
    source: (row.source as string | undefined) ?? undefined,
    type: (row.type as string | undefined) ?? undefined,
    queue: (row.queue as string | undefined) ?? undefined,
    title: (row.title as string) ?? "",
    description: (row.description as string) ?? "",
    lucid_task_id: (row.lucid_task_id as string | undefined) ?? undefined,
    spec_id: (row.spec_id as string | undefined) ?? undefined,
    spec_path: (row.spec_path as string | undefined) ?? undefined,
    spec_status: (row.spec_status as "draft" | "approved" | undefined) ?? undefined,
    spec_approved_at: (row.spec_approved_at as string | undefined) ?? undefined,
    spec_approved_by: (row.spec_approved_by as string | undefined) ?? undefined,
    dependencies: parseJson<string[]>(row.dependencies, []),
    started_at: (row.started_at as string | undefined) ?? undefined,
    completed_at: (row.completed_at as string | undefined) ?? undefined,
    result: (row.result as string | undefined) ?? undefined,
    error: (row.error as string | undefined) ?? undefined,
    project_path: (row.project_path as string | undefined) ?? undefined,
    output_path: (row.output_path as string | undefined) ?? undefined,
    worktree_path: (row.worktree_path as string | undefined) ?? undefined,
    worktree_branch: (row.worktree_branch as string | undefined) ?? undefined,
    retry_eligible_after: (row.retry_eligible_after as string | undefined) ?? undefined,
    metadata: parseJson<Record<string, unknown>>(row.metadata, {}),
    context: parseJson<Record<string, unknown>>(row.context, {}),
    attempts: parseJson<unknown[]>(row.attempts, []),
    progress: parseJson<PipelineItemProgress>(row.progress, {}),
    isc_rows: parseJson<unknown[]>(row.isc_rows, []),
    verification: parseJson<PipelineItem["verification"]>(row.verification, undefined),
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

// ============================================================================
// PipelineRepository
// ============================================================================

export class PipelineRepository {
  private db: Database;

  constructor(dbPath?: string) {
    this.db = getPipelineDb(dbPath).db;
  }

  // --------------------------------------------------------------------------
  // get
  // --------------------------------------------------------------------------

  get(id: string): PipelineItem | null {
    const row = this.db
      .prepare("SELECT * FROM pipeline_items WHERE id = ?")
      .get(id) as DbRow | null;
    return row ? rowToItem(row) : null;
  }

  // --------------------------------------------------------------------------
  // upsert
  // --------------------------------------------------------------------------

  /**
   * Transition guard (slice A2, ENFORCE-by-default since the post-A2b flip).
   *
   * upsert() historically wrote any stage value with zero validation — transition()
   * was the only enforcement point. A2 made upsert() transition-AWARE in SHADOW mode
   * (log-but-allow) to collect real production shadow data without regressing
   * anything. That shadow cycle came back clean (zero production-id shadow entries
   * in failure-log.jsonl, after the deriveStage approvals-clamp false-illegal bug
   * was fixed in A2b), so the default is now ENFORCE.
   *
   *   - Same-stage patch (stage omitted or unchanged)  → always legal, no event, no log.
   *     Required: researching/generating-spec/revision-needed/awaiting-approval/
   *     approved/needs-review/blocked have no self-loop in ALLOWED_TRANSITIONS, and
   *     same-stage re-saves are ubiquitous (saveQueueItemsImpl re-saves whole queues).
   *   - New-item creation                              → always legal, writes a
   *     creation event (from_stage NULL, to_stage = initial stage).
   *   - Legal stage-crossing                            → proceeds, writes an event
   *     (note: "shadow-legal").
   *   - Illegal stage-crossing, ENFORCE (default)        → rolls back + throws, like
   *     transition().
   *   - Illegal stage-crossing, SHADOW (opt-out only)    → still writes (zero
   *     regression vs. pre-flip behavior), logs via recordFailure (AFTER commit —
   *     see below), writes an event (note: "shadow-illegal"). Opt out via
   *     { enforce: false } or env KAYA_PIPELINE_TRANSITION_ENFORCE=0 (emergency
   *     escape hatch back to shadow). The option always takes precedence over the
   *     env var (for tests and callers with deliberately shadow semantics, e.g.
   *     QueueManager.transfer()/rejectToSpecPipeline()/rejectToGrill() and the
   *     whole-queue-save path saveQueueItemsImpl — see their call sites for why).
   *
   * recordFailure does its own file I/O (mkdirSync/appendFileSync) which must never
   * run inside an open BEGIN IMMEDIATE transaction — so the shadow-illegal verdict is
   * only *collected* inside the tx and *emitted* after COMMIT.
   *
   * --------------------------------------------------------------------------
   * Dirty-check on updated_at (fable-remediation b1/b2)
   * --------------------------------------------------------------------------
   * upsert() used to unconditionally bind `updated_at = now` on every call,
   * including a same-stage patch whose resolved values are byte-identical to
   * what's already on disk. saveQueueItemsImpl() (PipelineFacade.ts) calls
   * upsert() in a loop over the WHOLE active-queue array on every save, so
   * completing ONE item restamped updated_at on every OTHER unrelated row in
   * the same queue. Observed production impact: this silently reset
   * PipelineIntegrity's STUCK-item staleness clock for an item that had
   * genuinely been stuck for 420h, clearing a real alarm. It's also the
   * likely explanation for the "2026-06-29 bulk sweep touched updated_at on
   * every row" fingerprint already documented in BacklogTriage.ts (:137,
   * :445), which is why that file no longer trusts updated_at for age.
   *
   * Fix: the existing row is already SELECTed inside this transaction. Every
   * persisted column is resolved to its final to-be-written value (the same
   * resolution used to build the SQL bind params below) and compared against
   * the existing row decoded via rowToItem(). If every column is unchanged,
   * `updated_at` is preserved from the existing row instead of restamped to
   * `now`. JSON-blob columns (metadata/context/attempts/progress/isc_rows/
   * dependencies/verification) are compared via canonicalJson() (recursive
   * key-sort) rather than raw string equality, so two semantically-identical
   * objects with different key insertion order never produce a false
   * "dirty" verdict. created_at is untouched by this (already preserved
   * separately, see $created_at below). A genuinely-changed row (including
   * any stage crossing) still restamps updated_at — that's the whole point
   * of the field. No consumer of updated_at depends on unchanged rows being
   * restamped: the only logic consumer is PipelineIntegrity's STUCK check,
   * which this fix serves directly; nothing sorts, paginates, or does
   * LRU/recency ordering by updated_at (grep-verified against QueueRouter/
   * and the wider repo before this change landed).
   */
  upsert(
    item: Partial<PipelineItem> & { id: string },
    // mergeMetadata: shallow-merge item.metadata over the existing row's metadata
    // instead of replacing it wholesale. OFF by default (exact prior behavior) —
    // only opt in from a codec that reconstructs metadata from a fixed, partial
    // key set (e.g. queueItemToPipelineParams), never from a caller that needs to
    // DELETE a metadata key (WorkQueue.setMetadata/resumeBlocked do; they must NOT
    // set this). See upsert() docstring, fable-remediation b1/b2.
    opts?: { actor?: string; enforce?: boolean; mergeMetadata?: boolean }
  ): PipelineItem {
    const now = new Date().toISOString();
    const actor = opts?.actor ?? "upsert";
    const enforceMode = opts?.enforce ?? (process.env.KAYA_PIPELINE_TRANSITION_ENFORCE !== "0");

    // Set inside the tx when an illegal crossing is observed in shadow mode; emitted
    // via recordFailure AFTER the tx commits (see docstring above).
    let shadowIllegalVerdict: { id: string; from: Stage; to: Stage } | null = null;

    // BEGIN IMMEDIATE: acquire write lock before reading the existing row.
    // db.transaction() uses BEGIN DEFERRED — two concurrent upserts on the same
    // id can both enter the transaction in read mode, both read "no existing row",
    // then race for the write lock, and the loser's write is dropped or throws
    // SQLITE_BUSY after withRetry exhausts. IMMEDIATE prevents this by serialising
    // all upsert writers at the lock-acquisition point.
    const result = withRetry(() => {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        // Read existing row inside the write transaction (consistent view)
        const existing = this.db
          .prepare("SELECT * FROM pipeline_items WHERE id = ?")
          .get(item.id) as DbRow | null;
        const existingItem = existing ? rowToItem(existing) : null;

        const stage = (item.stage ?? existingItem?.stage ?? "intake") as Stage;
        const priority = item.priority ?? existingItem?.priority ?? 2;
        const title = item.title ?? existingItem?.title ?? "";
        const description = item.description ?? existingItem?.description ?? "";

        // --- A2: transition-aware event classification (shadow mode) ---
        const isNewItem = !existingItem;
        const fromStage: Stage | null = existingItem ? existingItem.stage : null;
        const isCrossing = !isNewItem && item.stage !== undefined && stage !== fromStage;

        let eventToWrite: { from: Stage | null; to: Stage; note: string } | null = null;

        if (isNewItem) {
          eventToWrite = { from: null, to: stage, note: "creation" };
        } else if (isCrossing) {
          const allowed = ALLOWED_TRANSITIONS[fromStage as Stage];
          const legal = allowed?.includes(stage) ?? false;
          if (legal) {
            eventToWrite = { from: fromStage, to: stage, note: "shadow-legal" };
          } else if (enforceMode) {
            this.db.exec("ROLLBACK");
            throw new Error(
              `PipelineRepository.upsert: illegal transition "${fromStage}" → "${stage}" for item ${item.id}. ` +
              `Allowed from "${fromStage}": [${allowed?.join(", ") || "none"}]`
            );
          } else {
            eventToWrite = { from: fromStage, to: stage, note: "shadow-illegal" };
            shadowIllegalVerdict = { id: item.id, from: fromStage as Stage, to: stage };
          }
        }
        // else: same-stage patch — eventToWrite stays null, no event, no log.

        // --- Dirty-check: resolve every persisted column exactly once, so both
        // the SQL bind params below and the "did anything actually change"
        // comparison read from the same values (see docstring above). ---
        const resolvedSource = item.source ?? existingItem?.source ?? null;
        const resolvedType = item.type ?? existingItem?.type ?? null;
        const resolvedQueue = item.queue ?? existingItem?.queue ?? null;
        const resolvedLucidTaskId = item.lucid_task_id ?? existingItem?.lucid_task_id ?? null;
        const resolvedSpecId = item.spec_id ?? existingItem?.spec_id ?? null;
        const resolvedSpecPath = item.spec_path ?? existingItem?.spec_path ?? null;
        const resolvedSpecStatus = item.spec_status ?? existingItem?.spec_status ?? null;
        const resolvedSpecApprovedAt = item.spec_approved_at ?? existingItem?.spec_approved_at ?? null;
        const resolvedSpecApprovedBy = item.spec_approved_by ?? existingItem?.spec_approved_by ?? null;
        const resolvedDependencies = item.dependencies ?? existingItem?.dependencies ?? [];
        const resolvedStartedAt = item.started_at ?? existingItem?.started_at ?? null;
        const resolvedCompletedAt = item.completed_at ?? existingItem?.completed_at ?? null;
        const resolvedResult = item.result ?? existingItem?.result ?? null;
        const resolvedError = item.error ?? existingItem?.error ?? null;
        const resolvedProjectPath = item.project_path ?? existingItem?.project_path ?? null;
        const resolvedOutputPath = item.output_path ?? existingItem?.output_path ?? null;
        const resolvedWorktreePath = item.worktree_path ?? existingItem?.worktree_path ?? null;
        const resolvedWorktreeBranch = item.worktree_branch ?? existingItem?.worktree_branch ?? null;
        const resolvedRetryEligibleAfter = item.retry_eligible_after ?? existingItem?.retry_eligible_after ?? null;
        const resolvedMetadata = item.metadata !== undefined
          ? (opts?.mergeMetadata && existingItem ? { ...existingItem.metadata, ...item.metadata } : item.metadata)
          : (existingItem?.metadata ?? {});
        const resolvedContext = item.context ?? existingItem?.context ?? {};
        const resolvedAttempts = item.attempts ?? existingItem?.attempts ?? [];
        const resolvedProgress = item.progress ?? existingItem?.progress ?? {};
        const resolvedIscRows = item.isc_rows ?? existingItem?.isc_rows ?? [];
        const resolvedVerification = item.verification !== undefined
          ? item.verification
          : existingItem?.verification;

        // Scalars: direct equality (existing optional fields normalized ?? null to
        // match the resolved-value convention above). JSON blobs: canonicalJson so
        // key-order differences never produce a false "dirty" verdict.
        const isDirty = !existingItem || (
          stage !== existingItem.stage ||
          priority !== existingItem.priority ||
          resolvedSource !== (existingItem.source ?? null) ||
          resolvedType !== (existingItem.type ?? null) ||
          resolvedQueue !== (existingItem.queue ?? null) ||
          title !== existingItem.title ||
          description !== existingItem.description ||
          resolvedLucidTaskId !== (existingItem.lucid_task_id ?? null) ||
          resolvedSpecId !== (existingItem.spec_id ?? null) ||
          resolvedSpecPath !== (existingItem.spec_path ?? null) ||
          resolvedSpecStatus !== (existingItem.spec_status ?? null) ||
          resolvedSpecApprovedAt !== (existingItem.spec_approved_at ?? null) ||
          resolvedSpecApprovedBy !== (existingItem.spec_approved_by ?? null) ||
          resolvedStartedAt !== (existingItem.started_at ?? null) ||
          resolvedCompletedAt !== (existingItem.completed_at ?? null) ||
          resolvedResult !== (existingItem.result ?? null) ||
          resolvedError !== (existingItem.error ?? null) ||
          resolvedProjectPath !== (existingItem.project_path ?? null) ||
          resolvedOutputPath !== (existingItem.output_path ?? null) ||
          resolvedWorktreePath !== (existingItem.worktree_path ?? null) ||
          resolvedWorktreeBranch !== (existingItem.worktree_branch ?? null) ||
          resolvedRetryEligibleAfter !== (existingItem.retry_eligible_after ?? null) ||
          canonicalJson(resolvedDependencies) !== canonicalJson(existingItem.dependencies) ||
          canonicalJson(resolvedMetadata) !== canonicalJson(existingItem.metadata) ||
          canonicalJson(resolvedContext) !== canonicalJson(existingItem.context) ||
          canonicalJson(resolvedAttempts) !== canonicalJson(existingItem.attempts) ||
          canonicalJson(resolvedProgress) !== canonicalJson(existingItem.progress) ||
          canonicalJson(resolvedIscRows) !== canonicalJson(existingItem.isc_rows) ||
          canonicalJson(resolvedVerification) !== canonicalJson(existingItem.verification)
        );

        this.db.prepare(`
          INSERT INTO pipeline_items (
            id, stage, priority, source, type, queue, title, description,
            lucid_task_id,
            spec_id, spec_path, spec_status, spec_approved_at, spec_approved_by,
            dependencies,
            started_at, completed_at, result, error,
            project_path, output_path, worktree_path, worktree_branch,
            retry_eligible_after,
            metadata, context, attempts, progress, isc_rows, verification,
            created_at, updated_at
          ) VALUES (
            $id, $stage, $priority, $source, $type, $queue, $title, $description,
            $lucid_task_id,
            $spec_id, $spec_path, $spec_status, $spec_approved_at, $spec_approved_by,
            $dependencies,
            $started_at, $completed_at, $result, $error,
            $project_path, $output_path, $worktree_path, $worktree_branch,
            $retry_eligible_after,
            $metadata, $context, $attempts, $progress, $isc_rows, $verification,
            $created_at, $updated_at
          )
          ON CONFLICT(id) DO UPDATE SET
            stage             = excluded.stage,
            priority          = excluded.priority,
            source            = excluded.source,
            type              = excluded.type,
            queue             = excluded.queue,
            title             = excluded.title,
            description       = excluded.description,
            lucid_task_id     = excluded.lucid_task_id,
            spec_id           = excluded.spec_id,
            spec_path         = excluded.spec_path,
            spec_status       = excluded.spec_status,
            spec_approved_at  = excluded.spec_approved_at,
            spec_approved_by  = excluded.spec_approved_by,
            dependencies      = excluded.dependencies,
            started_at        = excluded.started_at,
            completed_at      = excluded.completed_at,
            result            = excluded.result,
            error             = excluded.error,
            project_path      = excluded.project_path,
            output_path       = excluded.output_path,
            worktree_path     = excluded.worktree_path,
            worktree_branch   = excluded.worktree_branch,
            retry_eligible_after = excluded.retry_eligible_after,
            metadata          = excluded.metadata,
            context           = excluded.context,
            attempts          = excluded.attempts,
            progress          = excluded.progress,
            isc_rows          = excluded.isc_rows,
            verification      = excluded.verification,
            updated_at        = excluded.updated_at
        `).run({
          $id: item.id,
          $stage: stage,
          $priority: priority,
          $source: resolvedSource,
          $type: resolvedType,
          $queue: resolvedQueue,
          $title: title,
          $description: description,
          $lucid_task_id: resolvedLucidTaskId,
          $spec_id: resolvedSpecId,
          $spec_path: resolvedSpecPath,
          $spec_status: resolvedSpecStatus,
          $spec_approved_at: resolvedSpecApprovedAt,
          $spec_approved_by: resolvedSpecApprovedBy,
          $dependencies: JSON.stringify(resolvedDependencies),
          $started_at: resolvedStartedAt,
          $completed_at: resolvedCompletedAt,
          $result: resolvedResult,
          $error: resolvedError,
          $project_path: resolvedProjectPath,
          $output_path: resolvedOutputPath,
          $worktree_path: resolvedWorktreePath,
          $worktree_branch: resolvedWorktreeBranch,
          $retry_eligible_after: resolvedRetryEligibleAfter,
          $metadata: JSON.stringify(resolvedMetadata),
          $context: JSON.stringify(resolvedContext),
          $attempts: JSON.stringify(resolvedAttempts),
          $progress: JSON.stringify(resolvedProgress),
          $isc_rows: JSON.stringify(resolvedIscRows),
          $verification: resolvedVerification !== undefined ? JSON.stringify(resolvedVerification) : null,
          $created_at: existingItem?.created_at ?? item.created_at ?? now,
          // Preserve updated_at when nothing persisted actually changed (see
          // dirty-check docstring above) — only a genuine change restamps it.
          $updated_at: existingItem && !isDirty ? existingItem.updated_at : now,
        });

        // A2: append-only audit row for creation / stage-crossing upserts — same tx
        // as the pipeline_items write above, so both land or roll back together.
        if (eventToWrite) {
          this.db.prepare(`
            INSERT INTO pipeline_events (item_id, from_stage, to_stage, actor, note, ts)
            VALUES ($item_id, $from_stage, $to_stage, $actor, $note, $ts)
          `).run({
            $item_id: item.id,
            $from_stage: eventToWrite.from,
            $to_stage: eventToWrite.to,
            $actor: actor,
            $note: eventToWrite.note,
            $ts: now,
          });
        }

        const updated = this.db
          .prepare("SELECT * FROM pipeline_items WHERE id = ?")
          .get(item.id) as DbRow;
        this.db.exec("COMMIT");
        return rowToItem(updated);
      } catch (err) {
        try { this.db.exec("ROLLBACK"); } catch { /* ignore rollback errors */ }
        throw err;
      }
    });

    // Emitted AFTER commit — recordFailure's own file I/O must never run inside an
    // open sqlite tx (see docstring above). Never fires in enforce mode (that path
    // throws before shadowIllegalVerdict is ever set).
    if (shadowIllegalVerdict) {
      recordFailure({
        source: "PipelineRepository.upsert.shadow",
        context: { id: shadowIllegalVerdict.id, from: shadowIllegalVerdict.from, to: shadowIllegalVerdict.to },
        tier: "log",
      });
    }

    return result;
  }

  // --------------------------------------------------------------------------
  // list
  // --------------------------------------------------------------------------

  list(filter: PipelineFilter = {}): PipelineItem[] {
    const conditions: string[] = [];
    const params: Record<string, unknown> = {};

    if (!filter.includeArchived) {
      conditions.push("stage != 'archived'");
    }

    if (filter.stage) {
      if (Array.isArray(filter.stage)) {
        const placeholders = filter.stage.map((_, i) => `$stage_${i}`).join(", ");
        conditions.push(`stage IN (${placeholders})`);
        filter.stage.forEach((s, i) => { params[`$stage_${i}`] = s; });
      } else {
        conditions.push("stage = $stage");
        params.$stage = filter.stage;
      }
    }

    if (filter.priority !== undefined) {
      conditions.push("priority = $priority");
      params.$priority = filter.priority;
    }

    if (filter.queue) {
      conditions.push("queue = $queue");
      params.$queue = filter.queue;
    }

    if (filter.source) {
      conditions.push("source = $source");
      params.$source = filter.source;
    }

    if (filter.lucid_task_id) {
      conditions.push("lucid_task_id = $lucid_task_id");
      params.$lucid_task_id = filter.lucid_task_id;
    }

    if (filter.spec_id) {
      conditions.push("spec_id = $spec_id");
      params.$spec_id = filter.spec_id;
    }

    let sql = "SELECT * FROM pipeline_items";
    if (conditions.length > 0) {
      sql += ` WHERE ${conditions.join(" AND ")}`;
    }
    sql += " ORDER BY priority ASC, created_at ASC";

    if (filter.limit) sql += ` LIMIT ${filter.limit}`;
    if (filter.offset) sql += ` OFFSET ${filter.offset}`;

    const rows = this.db.prepare(sql).all(params) as DbRow[];
    return rows.map(rowToItem);
  }

  // --------------------------------------------------------------------------
  // getEvents / getRecentEvents (slice A6 — read-only reader API)
  // --------------------------------------------------------------------------

  /**
   * All pipeline_events rows for a single item, ordered by id ASC (oldest first).
   * Read-only — no lock acquisition, mirrors get()/list().
   */
  getEvents(itemId: string): PipelineEvent[] {
    const rows = this.db
      .prepare("SELECT * FROM pipeline_events WHERE item_id = ? ORDER BY id ASC")
      .all(itemId) as DbRow[];
    return rows.map(rowToEvent);
  }

  /**
   * Events newer than a checkpoint, ordered by id ASC. Drives an edge-triggered
   * notification poller (slice D2): the poller reads a batch, remembers the
   * highest `id` it saw, and passes that back in as `opts.sinceId` next tick.
   *
   * Accepts EITHER a `since` ISO-8601 timestamp (exclusive: ts > since) OR
   * `opts.sinceId` (exclusive: id > sinceId). `sinceId` is strictly better for
   * a checkpointing poller — it's monotonic and gap-free, so it can't miss or
   * double-deliver events that share a millisecond-resolution timestamp the
   * way `since` can — so when both are supplied, `sinceId` takes precedence.
   * At least one of the two must be provided; a bare call with neither would
   * silently return the entire audit table, which is never what a poller wants.
   */
  getRecentEvents(
    since?: string | null,
    opts?: { toStage?: Stage; sinceId?: number }
  ): PipelineEvent[] {
    const sinceId = opts?.sinceId;
    const hasSinceId = sinceId !== undefined && sinceId !== null;
    const hasSince = since !== undefined && since !== null;

    if (!hasSinceId && !hasSince) {
      throw new Error(
        "PipelineRepository.getRecentEvents: must provide either `since` (ISO-8601 ts) or `opts.sinceId` (event id)"
      );
    }

    const conditions: string[] = [];
    const params: Record<string, unknown> = {};

    if (hasSinceId) {
      conditions.push("id > $sinceId");
      params.$sinceId = sinceId;
    } else {
      conditions.push("ts > $since");
      params.$since = since;
    }

    if (opts?.toStage) {
      conditions.push("to_stage = $toStage");
      params.$toStage = opts.toStage;
    }

    const sql = `SELECT * FROM pipeline_events WHERE ${conditions.join(" AND ")} ORDER BY id ASC`;
    const rows = this.db.prepare(sql).all(params) as DbRow[];
    return rows.map(rowToEvent);
  }

  // --------------------------------------------------------------------------
  // appendCrossRefEvent (slice F2 — Lane A auto-merge spine visibility)
  // --------------------------------------------------------------------------

  /**
   * Append a pipeline_events row WITHOUT requiring a corresponding pipeline_items
   * row to exist for `itemId`.
   *
   * WHY: Lane A (the LucidTasks autonomous executor) is TaskDB-native — its tasks
   * never get a pipeline_items row. Slice F2's resolved design decision is
   * "events-only spine visibility": write cross-reference events keyed by the
   * LucidTasks task id so the shared audit trail (and any future poller reading
   * getRecentEvents) can see Lane A activity, without forcing Lane A onto the
   * full pipeline_items state machine.
   *
   * SAFE BY CONSTRUCTION (verified against the DDL in PipelineDB.ts):
   *   - pipeline_events.to_stage is `TEXT NOT NULL` with NO CHECK constraint
   *     (unlike pipeline_items.stage, which IS constrained to the Stage enum).
   *   - pipeline_events has NO FOREIGN KEY referencing pipeline_items.
   *   So an insert for an item_id with no pipeline_items row is a plain,
   *   unconstrained write — it cannot violate any constraint.
   *   - PipelineIntegrity.checkGuardBypass() queries
   *     `FROM pipeline_items p JOIN (...) e ON e.item_id = p.id` — an INNER JOIN
   *     starting FROM pipeline_items. An item_id with no pipeline_items row can
   *     never appear on the `p` side of that join, so these orphan events are
   *     invisible to the guard-bypass detector BY DESIGN, not as an accidental
   *     blind spot (see PipelineReaderAPI.test.ts §7 and PipelineIntegrity.test.ts
   *     §8 for regression coverage of this invariant).
   *
   * `toStage`/`fromStage` are FREE-TEXT LABELS here, NOT `Stage` enum values —
   * callers should use a distinct, descriptive pseudo-stage such as
   * "lane-a-started" / "lane-a-verified" / "lane-a-merged" so these rows read
   * unambiguously as cross-reference events, never as real pipeline_items stage
   * transitions, in any raw SQL query, dashboard, or future poller.
   *
   * `actor` should carry a distinct prefix (e.g. "executor:<taskId>") for the
   * same reason — identifiable provenance in the shared audit trail.
   *
   * Unlike upsert()/transition(), this method does NOT wrap failures — it still
   * throws on a genuine DB error. Callers that want "never block my main flow"
   * semantics (the Lane A executor does) wrap this call in their own
   * try/catch + recordFailure().
   */
  appendCrossRefEvent(input: {
    itemId: string;
    toStage: string;
    actor: string;
    note?: string | null;
    fromStage?: string | null;
  }): PipelineEvent {
    const now = new Date().toISOString();
    const row = withRetry(() => {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.db.prepare(`
          INSERT INTO pipeline_events (item_id, from_stage, to_stage, actor, note, ts)
          VALUES ($item_id, $from_stage, $to_stage, $actor, $note, $ts)
        `).run({
          $item_id: input.itemId,
          $from_stage: input.fromStage ?? null,
          $to_stage: input.toStage,
          $actor: input.actor,
          $note: input.note ?? null,
          $ts: now,
        });
        const inserted = this.db
          .prepare("SELECT * FROM pipeline_events WHERE id = last_insert_rowid()")
          .get() as DbRow;
        this.db.exec("COMMIT");
        return inserted;
      } catch (err) {
        try { this.db.exec("ROLLBACK"); } catch { /* ignore rollback errors */ }
        throw err;
      }
    });
    return rowToEvent(row);
  }

  // --------------------------------------------------------------------------
  // transition
  // --------------------------------------------------------------------------

  /**
   * Atomically transition an item to a new stage, enforcing the transition table.
   * Throws if the transition is illegal. Optionally accepts patch fields to apply
   * alongside the stage change (e.g. setting started_at when moving to in-progress).
   *
   * Uses BEGIN IMMEDIATE (not db.transaction() which is DEFERRED) so concurrent
   * callers serialise at lock-acquisition time. With DEFERRED, two processes can
   * both read the current stage and race to write; IMMEDIATE means only one writer
   * holds the lock at a time, and the loser waits up to busy_timeout before retrying.
   */
  transition(
    id: string,
    toStage: Stage,
    opts?: {
      /** Extra fields to update atomically with the transition */
      patch?: Partial<Omit<PipelineItem, "id" | "stage" | "created_at">>;
      /** Set started_at to now if transitioning into in-progress and not already set */
      autoTimestamp?: boolean;
      /** Who/what triggered this transition — recorded on the pipeline_events row.
       *  Defaults to "unknown" rather than guessing a caller identity. */
      actor?: string;
      /** Optional free-text context recorded alongside the pipeline_events row */
      note?: string;
      // mergeMetadata: shallow-merge patch.metadata over the existing row's metadata
      // instead of replacing it wholesale. OFF by default (exact prior behavior) —
      // same opt-in shape as upsert()'s mergeMetadata (see its docstring): only opt
      // in from a codec that reconstructs metadata from a fixed, partial key set
      // (e.g. queueItemToPipelineParams), never from a caller that needs to DELETE
      // a metadata key. See upsert() docstring, fable-remediation b1/b2.
      mergeMetadata?: boolean;
    }
  ): PipelineItem {
    const now = new Date().toISOString();
    const autoTimestamp = opts?.autoTimestamp ?? true;
    const actor = opts?.actor ?? "unknown";
    const note = opts?.note ?? null;

    const result = withRetry(() => {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        const row = this.db
          .prepare("SELECT * FROM pipeline_items WHERE id = ?")
          .get(id) as DbRow | null;

        if (!row) {
          this.db.exec("ROLLBACK");
          throw new Error(`PipelineRepository.transition: item not found: ${id}`);
        }

        const fromStage = row.stage as Stage;
        const allowed = ALLOWED_TRANSITIONS[fromStage];
        if (!allowed?.includes(toStage)) {
          this.db.exec("ROLLBACK");
          throw new Error(
            `PipelineRepository.transition: illegal transition "${fromStage}" → "${toStage}" for item ${id}. ` +
            `Allowed from "${fromStage}": [${allowed?.join(", ") || "none"}]`
          );
        }

        const patch = opts?.patch ?? {};
        const setClauses: string[] = ["stage = $stage", "updated_at = $updated_at"];
        const params: Record<string, unknown> = {
          $stage: toStage,
          $updated_at: now,
          $id: id,
        };

        // Auto-set started_at when transitioning to in-progress
        if (autoTimestamp && toStage === "in-progress" && !row.started_at && !patch.started_at) {
          setClauses.push("started_at = $started_at");
          params.$started_at = now;
        }

        // Auto-set completed_at for terminal stages
        if (autoTimestamp && (toStage === "done" || toStage === "failed" || toStage === "rejected") && !row.completed_at && !patch.completed_at) {
          setClauses.push("completed_at = $completed_at_auto");
          params.$completed_at_auto = now;
        }

        // Apply patch fields
        //
        // "dependencies" is a first-class TEXT column but PipelineItem models it as a
        // string[] (see the DDL: `dependencies TEXT NOT NULL DEFAULT '[]'`), so — like
        // the JSON-object blobs below — a raw patch.dependencies array must be
        // JSON.stringify'd before binding, or bun:sqlite's binder throws ("Binding
        // expected string ... or null"). Slice A3 found this the hard way and worked
        // around it by stripping "dependencies" out of every transition() patch call
        // site (WorkQueue.updateStatus, QueueManager.updateSpecPipelineStatus); slice
        // A4 fixes it here so those call sites can stop stripping it.
        const blobFields = new Set(["metadata", "context", "attempts", "progress", "isc_rows", "verification", "dependencies"]);
        // Existing metadata, parsed lazily (only when mergeMetadata is requested AND
        // the patch actually carries a metadata key) — same shallow-merge semantics
        // as upsert()'s mergeMetadata (see its docstring and this method's opts doc).
        const existingMetadata = opts?.mergeMetadata && patch.metadata !== undefined
          ? parseJson<Record<string, unknown>>(row.metadata, {})
          : undefined;
        for (const [key, value] of Object.entries(patch)) {
          if (value === undefined) continue;
          const colName = key; // PipelineItem field names match column names
          const paramName = `$patch_${key}`;
          setClauses.push(`${colName} = ${paramName}`);
          if (key === "metadata" && existingMetadata !== undefined) {
            params[paramName] = JSON.stringify({ ...existingMetadata, ...(value as Record<string, unknown>) });
          } else if (blobFields.has(key)) {
            params[paramName] = JSON.stringify(value);
          } else {
            params[paramName] = value;
          }
        }

        const sql = `UPDATE pipeline_items SET ${setClauses.join(", ")} WHERE id = $id`;
        this.db.prepare(sql).run(params);

        // Append-only audit row — same tx as the stage update above, so both
        // land or roll back together (see pipeline_events DDL in PipelineDB.ts).
        this.db.prepare(`
          INSERT INTO pipeline_events (item_id, from_stage, to_stage, actor, note, ts)
          VALUES ($item_id, $from_stage, $to_stage, $actor, $note, $ts)
        `).run({
          $item_id: id,
          $from_stage: fromStage,
          $to_stage: toStage,
          $actor: actor,
          $note: note,
          $ts: now,
        });

        const updated = this.db
          .prepare("SELECT * FROM pipeline_items WHERE id = ?")
          .get(id) as DbRow;
        this.db.exec("COMMIT");
        return updated;
      } catch (err) {
        try { this.db.exec("ROLLBACK"); } catch { /* ignore rollback errors */ }
        throw err;
      }
    });

    return rowToItem(result);
  }

  // --------------------------------------------------------------------------
  // archive
  // --------------------------------------------------------------------------

  archive(id: string): PipelineItem {
    return this.transition(id, "archived");
  }

  // --------------------------------------------------------------------------
  // remove (hard delete — rare; prefer archive)
  // --------------------------------------------------------------------------

  remove(id: string): boolean {
    // BEGIN IMMEDIATE for consistency — ensures this serialises with concurrent writers.
    // A lone DELETE is auto-wrapped by SQLite in an implicit exclusive transaction, but
    // explicit IMMEDIATE makes the intent clear and ensures withRetry catches BUSY correctly.
    return withRetry(() => {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        const result = this.db
          .prepare("DELETE FROM pipeline_items WHERE id = ?")
          .run(id);
        this.db.exec("COMMIT");
        return result.changes > 0;
      } catch (err) {
        try { this.db.exec("ROLLBACK"); } catch { /* ignore */ }
        throw err;
      }
    });
  }

  // --------------------------------------------------------------------------
  // claimBatch — concurrent-safe batch claim using BEGIN IMMEDIATE
  // --------------------------------------------------------------------------

  /**
   * Atomically claim up to `n` items from `fromStage` into `toStage`.
   *
   * Uses BEGIN IMMEDIATE to acquire a write lock before reading, so no two
   * concurrent claimers can select the same items (the exact race that drops
   * updates in the current file-based store). Each claimed item is transitioned
   * in the same transaction; items that fail the transition are skipped.
   *
   * @param n           Maximum number of items to claim
   * @param fromStage   Stage to claim from (typically "approved" or "intake")
   * @param toStage     Stage to transition into (typically "in-progress")
   * @returns           Array of claimed PipelineItems (length ≤ n)
   */
  claimBatch(n: number, fromStage: Stage, toStage: Stage): PipelineItem[] {
    const now = new Date().toISOString();

    // Validate the transition is legal before opening the lock
    const testAllowed = ALLOWED_TRANSITIONS[fromStage];
    if (!testAllowed?.includes(toStage)) {
      throw new Error(
        `claimBatch: illegal transition "${fromStage}" → "${toStage}". ` +
        `Allowed from "${fromStage}": [${testAllowed?.join(", ") || "none"}]`
      );
    }

    // BEGIN IMMEDIATE acquires a write lock immediately, before any reads.
    // This is the key difference from BEGIN DEFERRED: no two processes can
    // enter this transaction simultaneously, eliminating the double-claim race.
    const claimed = withRetry(() => {
      // We cannot use db.transaction() for IMMEDIATE — it always uses DEFERRED.
      // Instead, issue the pragmas manually.
      this.db.exec("BEGIN IMMEDIATE");
      try {
        const rows = this.db
          .prepare(
            `SELECT id FROM pipeline_items
             WHERE stage = ?
               AND (retry_eligible_after IS NULL OR retry_eligible_after <= ?)
             ORDER BY priority ASC, created_at ASC
             LIMIT ?`
          )
          .all(fromStage, now, n) as { id: string }[];

        const claimedItems: PipelineItem[] = [];
        for (const { id } of rows) {
          const setClauses = ["stage = ?", "updated_at = ?"];
          const params: unknown[] = [toStage, now];

          // Auto started_at for in-progress
          if (toStage === "in-progress") {
            setClauses.push("started_at = COALESCE(started_at, ?)");
            params.push(now);
          }

          params.push(id);
          this.db
            .prepare(`UPDATE pipeline_items SET ${setClauses.join(", ")} WHERE id = ?`)
            .run(...params);

          const updatedRow = this.db
            .prepare("SELECT * FROM pipeline_items WHERE id = ?")
            .get(id) as DbRow;
          claimedItems.push(rowToItem(updatedRow));
        }

        this.db.exec("COMMIT");
        return claimedItems;
      } catch (err) {
        try { this.db.exec("ROLLBACK"); } catch { /* ignore */ }
        throw err;
      }
    });

    return claimed;
  }

  // --------------------------------------------------------------------------
  // claimByIds — atomic compare-and-swap claim for a specific candidate set
  // --------------------------------------------------------------------------

  /**
   * Atomically claim a caller-supplied set of candidate ids, transitioning each
   * from `fromStage` → `toStage` inside ONE `BEGIN IMMEDIATE` transaction.
   *
   * This is the race-safe companion to `claimBatch`: callers that build their
   * candidate set outside the lock (e.g. WorkQueue's getReadyItems + DAG-safety
   * filter) pass the ids here. Inside the single write transaction we do a
   * compare-and-swap update for each id:
   *
   *   UPDATE pipeline_items
   *   SET stage=:to, updated_at=:now [, started_at=COALESCE(started_at,:now)]
   *   WHERE id=:id AND stage=:from
   *
   * If another process already claimed the item, `stage` will differ from
   * `fromStage` and `changes()` returns 0 → that id is excluded from the
   * returned set. This gives each concurrent claimer a disjoint result with
   * zero double-claims by construction.
   *
   * @param candidateIds  Ordered list of candidate item ids (caller-selected)
   * @param fromStage     Stage items must currently be in to be claimed
   * @param toStage       Stage to transition into
   * @returns             PipelineItems actually claimed by THIS process (≤ candidateIds.length)
   */
  claimByIds(candidateIds: string[], fromStage: Stage, toStage: Stage): PipelineItem[] {
    if (candidateIds.length === 0) return [];

    // Validate transition is legal before opening the write lock
    const testAllowed = ALLOWED_TRANSITIONS[fromStage];
    if (!testAllowed?.includes(toStage)) {
      throw new Error(
        `claimByIds: illegal transition "${fromStage}" → "${toStage}". ` +
        `Allowed from "${fromStage}": [${testAllowed?.join(", ") || "none"}]`
      );
    }

    const now = new Date().toISOString();

    return withRetry(() => {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        const claimedItems: PipelineItem[] = [];

        for (const id of candidateIds) {
          const setClauses = ["stage = ?", "updated_at = ?"];
          const params: unknown[] = [toStage, now];

          // Auto started_at for in-progress
          if (toStage === "in-progress") {
            setClauses.push("started_at = COALESCE(started_at, ?)");
            params.push(now);
          }

          // Compare-and-swap: only update if the item is still in fromStage.
          // If another process claimed it first, changes() returns 0 → skip.
          params.push(id, fromStage);
          const result = this.db
            .prepare(
              `UPDATE pipeline_items SET ${setClauses.join(", ")} WHERE id = ? AND stage = ?`
            )
            .run(...params);

          if (result.changes > 0) {
            const updatedRow = this.db
              .prepare("SELECT * FROM pipeline_items WHERE id = ?")
              .get(id) as DbRow;
            claimedItems.push(rowToItem(updatedRow));
          }
        }

        this.db.exec("COMMIT");
        return claimedItems;
      } catch (err) {
        try { this.db.exec("ROLLBACK"); } catch { /* ignore */ }
        throw err;
      }
    });
  }

  // --------------------------------------------------------------------------
  // integrity
  // --------------------------------------------------------------------------

  /**
   * Self-audit the pipeline store. Returns a structured report + boolean ok.
   *
   * Checks:
   *   (a) Every dependency ref exists as a row
   *   (b) Terminal items (done/failed/rejected/archived) have no active flags
   *       that would indicate stale state
   *   (c) in-progress items have a non-null started_at
   *   (d) done items have a non-empty verification blob
   *   (e) Every row's stage is in the allowed enum
   */
  integrity(): IntegrityReport {
    const errors: string[] = [];
    const warnings: string[] = [];
    const now = new Date().toISOString();

    const allRows = this.db
      .prepare("SELECT * FROM pipeline_items")
      .all() as DbRow[];

    const allIds = new Set(allRows.map((r) => r.id as string));
    const stageEnum = new Set<string>(STAGES);
    const byStage: Record<string, number> = {};

    for (const row of allRows) {
      const id = row.id as string;
      const stage = row.stage as string;

      // Count by stage
      byStage[stage] = (byStage[stage] ?? 0) + 1;

      // (e) Stage must be in the allowed enum
      if (!stageEnum.has(stage)) {
        errors.push(`[${id}] unknown stage: "${stage}"`);
      }

      // (a) Dependency refs must exist
      const deps = parseJson<string[]>(row.dependencies, []);
      for (const depId of deps) {
        if (!allIds.has(depId)) {
          errors.push(`[${id}] dependency "${depId}" not found in pipeline_items`);
        }
      }

      // (c) in-progress must have started_at
      if (stage === "in-progress" && !row.started_at) {
        errors.push(`[${id}] stage=in-progress but started_at is null`);
      }

      // (d) done items should have verification
      if (stage === "done") {
        const verification = parseJson<Record<string, unknown> | undefined>(row.verification, undefined);
        if (!verification || !verification.verdict) {
          warnings.push(`[${id}] stage=done but verification is missing or empty`);
        }
      }

      // (b) Terminal items: done/failed/rejected must have completed_at
      const isTerminal = stage === "done" || stage === "failed" || stage === "rejected";
      if (isTerminal && !row.completed_at) {
        warnings.push(`[${id}] stage=${stage} (terminal) but completed_at is null`);
      }

      // Extra: archived items with active retry_eligible_after in the future
      if (stage === "archived" && row.retry_eligible_after) {
        const eligibleAfter = row.retry_eligible_after as string;
        if (eligibleAfter > now) {
          warnings.push(`[${id}] stage=archived but retry_eligible_after is in the future (${eligibleAfter})`);
        }
      }
    }

    return {
      ok: errors.length === 0,
      errors,
      warnings,
      checkedAt: now,
      stats: {
        total: allRows.length,
        byStage,
      },
    };
  }
}

// ============================================================================
// Singleton (keyed by resolved path, like TaskDB pattern)
// ============================================================================

const _repos = new Map<string, PipelineRepository>();

/**
 * Returns a singleton PipelineRepository for the given path.
 * Path is resolved at call time — tests pin KAYA_HOME before calling.
 */
export function getPipelineRepository(dbPath?: string): PipelineRepository {
  const resolvedPath = dbPath ?? defaultPipelineDbPath();
  let repo = _repos.get(resolvedPath);
  if (!repo) {
    repo = new PipelineRepository(resolvedPath);
    _repos.set(resolvedPath, repo);
  }
  return repo;
}

/**
 * Evict the repository singleton (and underlying DB) for a given path.
 * Used by tests in afterAll/beforeAll for clean teardown.
 */
export function resetPipelineRepository(dbPath?: string): void {
  const resolvedPath = dbPath ?? defaultPipelineDbPath();
  _repos.delete(resolvedPath);
  resetPipelineDb(resolvedPath);
}
