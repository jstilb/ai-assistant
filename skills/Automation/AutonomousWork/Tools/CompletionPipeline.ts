/**
 * CompletionPipeline.ts — typed staged pipeline for "what 'done' actually means."
 *
 * Replaces the 275-line procedural reportDone() in WorkOrchestrator by composing
 * named stages. Each stage is a small function (ctx) → StageResult. The pipeline
 * runs stages in order; any stage may terminate the pipeline with a CompletionOutcome.
 *
 * Migration is incremental — each slice moves one stage out of reportDone and into
 * the pipeline. Until all stages are migrated, run() may return { kind: "continue" }
 * which signals the caller to fall through to the legacy reportDone code path.
 *
 * Cache safety (StageCtx is per-call, never stored on `this`):
 *   - Each run() call builds a fresh ctx scoped to one itemId.
 *   - Parallel processes have separate WorkOrchestrators → separate pipelines →
 *     separate ctxs. No cross-session shared in-memory state.
 *   - WorkQueue's FileLock and StateManager handle write concurrency on disk.
 *   - Stages that mutate WorkItem/ISC must persist via the queue/iscManager and
 *     return a ctxPatch so subsequent stages see fresh state.
 */

import type { WorkQueue, WorkItem } from "./WorkQueue.ts";
import type { ISCManager } from "./ISCManager.ts";
import type { ISCRow, FaultClass } from "./WorkOrchestrator.ts";
import type { SkepticalReviewResult } from "./SkepticalVerifier.ts";
import type { TransitionGuard } from "./TransitionGuard.ts";
import type { NotificationDispatcher } from "./NotificationDispatcher.ts";
import { memoryStore, type CaptureOptions } from "../../../../lib/core/MemoryStore.ts";
import { logFailure } from "../../../../lib/core/FailureLog.ts";
// cross-skill-allowed: ISC 4 — completion pipeline self-reports tech debt incurred during a work item (AgentResults.debtIncurred) into TechDebtTracker's registry; seam candidate: DebtRegistry client
import { TechDebtRegistry } from "../../AutoMaintenance/Tools/TechDebtRegistry.ts";

export interface VerifyResult {
  success: boolean;
  failures: ISCRow[];
  skepticalReview?: SkepticalReviewResult;
}

// ============================================================================
// Public types
// ============================================================================

export interface TechDebtInput {
  description: string;
  location: string;
  category: string;
}

export interface AgentResults {
  completedRowIds: number[];
  failedRowIds?: number[];
  adversarialConcerns?: string[];
  executionLog?: string[];
  rowEvidence?: Record<number, { files?: string[]; commands?: string[]; summary?: string }>;
  /** ISC 4: Tech debt incurred during this work item — written to registry on completion. */
  debtIncurred?: TechDebtInput[];
}

export interface CompletionOpts {
  /**
   * E2: forwarded to Integrator.mergeItem's opts.skipSessionLock via deps.mergeItem's
   * second argument. DEFAULT undefined/false — the interactive-session-lock defer
   * (Integrator.ts checkInteractiveSessionLock) stays ACTIVE unless a caller explicitly
   * opts in (e.g. WorkOrchestratorCLI's --interactive-session flag). The unattended
   * HeadlessWorkDriver path never sets this, so a fresh interactive-session.lock always
   * defers its merges instead of racing an active Jm session's uncommitted work.
   */
  skipSessionLock?: boolean;
}

export type CompletionOutcome =
  | {
      kind: "completed";
      mergeStatus: "merged" | "pending_approval" | "skipped";
      /** Legacy reportDone returns this through as possibly-undefined. */
      skepticalReview?: SkepticalReviewResult;
    }
  | {
      kind: "rejected";
      verdict: "FAIL" | "NEEDS_REVIEW";
      reason: string;
      faultClass: FaultClass;
      skepticalReview?: SkepticalReviewResult;
    }
  | {
      kind: "blocked-on-human";
      humanRows: ISCRow[];
      proxyIds: string[];
      /** Optional: legacy contract returns the orchestrator's skepticalReview through, which can be undefined. */
      skepticalReview?: SkepticalReviewResult;
    };

/**
 * Type-level escape hatch retained for incremental migration. After Slice 8 the
 * pipeline always terminates via emitTraces; if a future stage forgets to terminate,
 * run() throws an internal error rather than returning this sentinel. Kept in the
 * union so adding a new mid-pipeline stage doesn't require widening the type.
 */
export interface ContinueLegacy {
  kind: "continue";
}

export type RunResult = CompletionOutcome | ContinueLegacy;

// ============================================================================
// Internal pipeline types
// ============================================================================

export interface StageCtx {
  itemId: string;
  item: WorkItem | undefined;
  iscRows: ISCRow[];
  results: AgentResults;
  opts: CompletionOpts;
  /** Populated by verifyAndAudit; downstream stages read it. */
  verifyResult?: VerifyResult;
  /** Populated by mergeIfPossible; emitTraces forwards onto the completed outcome. */
  mergeStatus?: "merged" | "pending_approval" | "skipped";
}

export type StageResult =
  | { kind: "continue"; ctxPatch?: Partial<StageCtx> }
  | { kind: "terminate"; outcome: CompletionOutcome };

export type CompletionStage = (ctx: StageCtx, deps: CompletionDeps) => Promise<StageResult> | StageResult;

export interface CompletionDeps {
  queue: WorkQueue;
  iscManager: ISCManager;
  /** Slice 4 — verify pipeline + audit + verify-fail handling. */
  verify: (itemId: string) => Promise<VerifyResult>;
  guard: TransitionGuard;
  notificationDispatcher: NotificationDispatcher;
  cleanupWorktree: (itemId: string) => Promise<void>;
  classifyFailure: (concerns: string, failures: ISCRow[], faultClass?: FaultClass) => FaultClass;
  /** Slice 5 — clears stale REVIEW proxies after verify-pass; runs unconditionally before triage. */
  resolveStaleReviewProxies: (itemId: string) => void;
  /** Slice 7 — runs the completion gate (verification status, ISC coverage, spec coverage, worktree cleanup, status update). */
  complete: (itemId: string) => Promise<{ success: boolean; reason?: string }>;
  /**
   * Slice 8 — auto-merges the verified branch (wraps Integrator.mergeItem).
   * E2: second argument is the caller-controlled skipSessionLock (from
   * ctx.opts.skipSessionLock via the mergeIfPossible stage) — production wires it
   * through to Integrator.mergeItem's opts.skipSessionLock, DEFAULT false.
   *
   * Return type is `T | Promise<T>` because the production wrapper calls
   * Integrator.mergeItem, which is `async` — mergeIfPossible awaits this. (E2 bug fix:
   * this dep used to be read synchronously against the real async Integrator call, so
   * `result.merged`/`result.reason` were always read off an unresolved Promise —
   * always undefined — meaning mergeReason metadata was silently never written by this
   * stage; only Integrator's own internal setMetadata calls landed, racing uncoordinated
   * with the rest of the pipeline. Test-fixture sync mocks remain valid callers.)
   */
  mergeItem: (itemId: string, skipSessionLock?: boolean) =>
    | { merged: boolean; prUrl?: string; reason?: string }
    | Promise<{ merged: boolean; prUrl?: string; reason?: string }>;
  /** Slice 8 — agent-monitor completion trace emit (sync, fail-open inside the wrapper). */
  emitCompletion: (itemId: string, label: string) => void;
  /** Slice 8 — fire-and-forget insight publish (fail-open via .catch in the stage). */
  emitInsight: (insight: CaptureOptions) => Promise<void>;
  /** Slice 8 — post-hoc evaluator pipeline. Wrapper resolves the trace JSONL path, reads + parses, and calls runPipeline. Fail-open inside. */
  runEvaluatorPipeline: (itemId: string) => Promise<void>;
  /** ISC 4 — tech-debt registry for self-report writes from AgentResults.debtIncurred. Optional: if absent, recordDebtFromCompletion is a no-op. */
  techDebtRegistry?: TechDebtRegistry;
}

// ============================================================================
// Pipeline
// ============================================================================

export class CompletionPipeline {
  /**
   * Stages run in order. Adding a stage = a new vertical slice that moves
   * behavior out of WorkOrchestrator.reportDone.
   */
  private readonly stages: CompletionStage[] = [
    precondition,
    attachEvidence,
    recordDebtFromCompletion,
    markRowsDone,
    verifyAndAudit,
    resolveStaleProxies,
    triagePending,
    commitCompletion,
    mergeIfPossible,
    emitTraces,
  ];

  constructor(private deps: CompletionDeps) {}

  async run(itemId: string, results: AgentResults, opts: CompletionOpts = {}): Promise<RunResult> {
    let ctx = this.buildCtx(itemId, results, opts);

    for (let i = 0; i < this.stages.length; i++) {
      const result = await this.stages[i](ctx, this.deps);
      if (result.kind === "terminate") return result.outcome;
      if (result.ctxPatch) ctx = { ...ctx, ...result.ctxPatch };
      // ISC 3: Stamp heartbeat once after precondition + attachEvidence gate stages both pass,
      // signalling that real work is about to begin. Never stamps on early-reject/no-op paths.
      if (i === 1) {
        try { this.deps.queue.touchHeartbeat(itemId); } catch { /* fail-open */ }
      }
    }

    // emitTraces is the terminal stage; reaching here means a stage forgot to terminate.
    throw new Error(`CompletionPipeline did not terminate for item ${itemId} — terminal stage missing or skipped`);
  }

  private buildCtx(itemId: string, results: AgentResults, opts: CompletionOpts): StageCtx {
    return {
      itemId,
      item: this.deps.queue.getItem(itemId),
      iscRows: this.deps.iscManager.load(itemId),
      results,
      opts,
    };
  }
}

// ============================================================================
// Stages
// ============================================================================

/**
 * F-004 precondition: reject items where every ISC row is EXECUTION_FAILED.
 *
 * Such items had a pre-condition failure (typically parseSpec threw or the spec
 * had 0 extractable rows). They produced no verifiable outcomes and cannot be
 * reported done — the spec must be fixed and prepare re-run.
 *
 * If there are no ISC rows at all, this stage does not reject — later stages
 * will decide what to do (e.g., human-required routing, simulation gate).
 */
export const precondition: CompletionStage = (ctx) => {
  if (ctx.iscRows.length > 0 && ctx.iscRows.every((r) => r.status === "EXECUTION_FAILED")) {
    return {
      kind: "terminate",
      outcome: {
        kind: "rejected",
        verdict: "FAIL",
        reason:
          "All ISC rows are EXECUTION_FAILED — work item produced no verifiable outcomes. Fix the spec and re-run prepare.",
        faultClass: "infrastructure",
      },
    };
  }
  return { kind: "continue" };
};

/**
 * Persist agent-reported evidence onto the WorkItem and its ISC rows.
 *
 * Three concurrent persistences (the previous reportDone Steps 0/0a/0b):
 *   - `adversarialConcerns` → WorkItem.metadata (for SkepticalVerifier Phase 1 context)
 *   - `executionLog` (last 20 entries) → WorkItem.metadata (for Phase 2 context)
 *   - `rowEvidence[rowId]` → ISCRow.evidence (per-row file/command/summary)
 *
 * Evidence loss has historically been the #1 reportDone pitfall
 * (see project_report_done_pitfalls). This stage is the single point where
 * agent-reported context becomes durable on disk.
 *
 * Refreshes ctx (item + iscRows) so downstream stages see persisted values.
 */
export const attachEvidence: CompletionStage = (ctx, deps) => {
  const { itemId, results } = ctx;

  if (results.adversarialConcerns && results.adversarialConcerns.length > 0) {
    deps.queue.setMetadata(itemId, { adversarialConcerns: results.adversarialConcerns });
  }

  if (results.executionLog?.length) {
    deps.queue.setMetadata(itemId, { executionLog: results.executionLog.slice(-20) });
  }

  if (results.rowEvidence) {
    const rows = deps.iscManager.load(itemId);
    if (rows.length > 0) {
      for (const [rowId, evidence] of Object.entries(results.rowEvidence)) {
        const row = rows.find((r) => r.id === Number(rowId));
        if (row) row.evidence = evidence;
      }
      deps.iscManager.persist(itemId, rows);
    }
  }

  return {
    kind: "continue",
    ctxPatch: {
      item: deps.queue.getItem(itemId),
      iscRows: deps.iscManager.load(itemId),
    },
  };
};

/**
 * ISC 4: Record self-reported tech debt from AgentResults.debtIncurred.
 *
 * Reads ctx.results.debtIncurred; for each entry calls deps.techDebtRegistry.add()
 * with source: "self-report". Fully fail-open: all errors are caught and logged,
 * never rethrown. A missing or empty debtIncurred field is a no-op.
 *
 * Returns { kind: "continue" } always — never terminates the pipeline.
 */
export const recordDebtFromCompletion: CompletionStage = async (ctx, deps) => {
  const entries = ctx.results.debtIncurred;
  if (!entries || entries.length === 0) {
    return { kind: "continue" };
  }

  const registry = deps.techDebtRegistry;
  if (!registry) {
    return { kind: "continue" };
  }

  for (const entry of entries) {
    try {
      await registry.add({
        description: entry.description,
        location: entry.location,
        category: entry.category,
        source: "self-report",
      });
    } catch (err) {
      console.warn(
        `[recordDebtFromCompletion] Failed to record debt entry for ${entry.location}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  return { kind: "continue" };
};

/**
 * Transition the agent's reported completedRowIds from PENDING → DONE.
 *
 * Delegates to ISCManager.markDone, which only transitions rows currently in
 * PENDING (DONE/VERIFIED rows are preserved). A failure here is always an
 * infrastructure fault — the only way markDone fails is when no ISC rows
 * exist at all (the "run prepare first" case). The retry counter must NOT be
 * consumed for infrastructure faults.
 *
 * Refreshes ctx.iscRows since transitions just happened.
 */
export const markRowsDone: CompletionStage = (ctx, deps) => {
  const result = deps.iscManager.markDone(ctx.itemId, ctx.results.completedRowIds);
  if (!result.success) {
    return {
      kind: "terminate",
      outcome: {
        kind: "rejected",
        verdict: "FAIL",
        reason: `markRowsDone failed: ${result.error}`,
        faultClass: "infrastructure",
      },
    };
  }
  return {
    kind: "continue",
    ctxPatch: { iscRows: deps.iscManager.load(ctx.itemId) },
  };
};

/**
 * Run SkepticalVerifier via deps.verify, append the audit log, and on verify-fail
 * fire the notification + escalation LucidTask + worktree cleanup, then terminate.
 *
 * Audit log is appended unconditionally (PASS or FAIL) before the branch — this
 * matches legacy ordering so a verify-fail still produces an audit trail.
 *
 * On verify-fail:
 *   - Emit NEEDS_REVIEW notification (UX)
 *   - Fire emitInsight (fail-open .catch — never awaited strictly)
 *   - Create escalation LucidTask only when attemptCount < 2 (escalation handles >= 2)
 *   - Clean up worktree (prevents EMFILE accumulation from bun test discovery)
 *   - Terminate with kind:"rejected", faultClass from deps.classifyFailure
 *
 * On verify-success:
 *   - Stash verifyResult on ctx so legacy downstream code (Steps 3b½+) can read it
 *     without re-running verify(). This bridge is removed when later slices move
 *     those steps into the pipeline.
 */
export const verifyAndAudit: CompletionStage = async (ctx, deps) => {
  const verifyResult = await deps.verify(ctx.itemId);
  const item = deps.queue.getItem(ctx.itemId);
  const itemTitle = item?.title ?? "unknown";
  const verdict = verifyResult.skepticalReview?.finalVerdict ?? (verifyResult.success ? "PASS" : "FAIL");

  deps.guard.appendAuditLog({
    itemId: ctx.itemId,
    itemTitle,
    verdict,
    concerns: verifyResult.skepticalReview?.concerns ?? verifyResult.failures.map((f) => f.description),
    tiersExecuted: verifyResult.skepticalReview?.tiers.map((t) => t.tier) ?? [],
    verificationCost: verifyResult.skepticalReview?.totalCost ?? 0,
    iscRowSummary: deps.iscManager.load(ctx.itemId).map((r) => `${r.id}:${r.status}`),
    adversarialConcerns: ctx.results.adversarialConcerns,
  });

  if (!verifyResult.success) {
    const failureDescriptions = verifyResult.failures.map((f) => f.description);
    const concerns = failureDescriptions.join("; ");
    const failVerdict = verifyResult.skepticalReview?.finalVerdict ?? "FAIL";

    deps.notificationDispatcher.emitNeedsReviewNotification(ctx.itemId, itemTitle, failVerdict, failureDescriptions);

    memoryStore.capture({
      source: "AutonomousWork",
      type: "learning",
      title: `Work failed: ${itemTitle}`,
      content: failureDescriptions.join("; "),
      tags: ["work-failure", failVerdict.toLowerCase()],
      metadata: { itemId: ctx.itemId, failureCount: verifyResult.failures.length },
    }).catch((e) => logFailure("CompletionPipeline:captureFailureLearning", e, { itemId: ctx.itemId }));

    const attemptCount = deps.queue.getItem(ctx.itemId)?.attempts?.length ?? 0;
    if (attemptCount < 2) {
      const failConcerns = verifyResult.failures.map((f) => `- ${f.description}`).join("\n");
      await deps.notificationDispatcher.createJmTask(
        ctx.itemId,
        itemTitle,
        `[${failVerdict}] Verification failed — needs human review:\n${failConcerns}`,
      );
    }

    await deps.cleanupWorktree(ctx.itemId);

    return {
      kind: "terminate",
      outcome: {
        kind: "rejected",
        verdict: "FAIL",
        reason: `Verification failed: ${concerns}`,
        skepticalReview: verifyResult.skepticalReview,
        faultClass: deps.classifyFailure(concerns, verifyResult.failures, verifyResult.skepticalReview?.faultClass),
      },
    };
  }

  return { kind: "continue", ctxPatch: { verifyResult } };
};

/**
 * Auto-resolve stale REVIEW proxies left by prior 3-strikes escalations of this item.
 * Idempotent and side-effecting on other queue items only — does not read or mutate
 * ctx state. Runs unconditionally between verifyAndAudit (success) and triagePending
 * so that a blocked-on-human termination still clears the stale proxy.
 */
export const resolveStaleProxies: CompletionStage = (ctx, deps) => {
  deps.resolveStaleReviewProxies(ctx.itemId);
  return { kind: "continue" };
};

/**
 * Triage remaining PENDING ISC rows after verify passed.
 *
 * Behavior matches legacy Step 3c exactly:
 *   - 0 PENDING rows           → continue (downstream legacy: simulation gate, complete)
 *   - 1+ incomplete-automatable → terminate rejected (verdict FAIL, faultClass "item")
 *   - only human-required      → create proxies + audit log; mark item blocked;
 *                                terminate blocked-on-human
 *
 * Refreshes rows from the iscManager because verifyAndAudit's verify call has just
 * promoted DONE→VERIFIED on disk; ctx.iscRows from earlier stages is stale.
 *
 * Incomplete vs human-required is split by `disposition === "human-required"`. If both
 * categories are present, incomplete takes priority (rejection blocks the human-routing).
 */
export const triagePending: CompletionStage = async (ctx, deps) => {
  if (!ctx.verifyResult) {
    throw new Error("triagePending requires verifyResult on ctx (verifyAndAudit must run first)");
  }
  const verifyResult = ctx.verifyResult;
  const currentRows = deps.iscManager.load(ctx.itemId);

  // Guard: if there are NO ISC rows at all, comprehension/prepare failed.
  // This is NOT a completed item — it is a comprehension failure that would produce
  // a false PASS with zero verification. Reject loudly before reaching the pending check.
  if (currentRows.length === 0) {
    return {
      kind: "terminate",
      outcome: {
        kind: "rejected",
        verdict: "FAIL",
        reason:
          "0 ISC rows — comprehension produced no criteria; cannot verify completion. " +
          "Re-run prepare (fix spec or LLM comprehension) before reporting done.",
        faultClass: "item",
      },
    };
  }

  const pendingRows = currentRows.filter((r) => r.status === "PENDING");
  if (pendingRows.length === 0) {
    return { kind: "continue" };
  }

  const humanRows = pendingRows.filter((r) => r.disposition === "human-required");
  const incompleteRows = pendingRows.filter((r) => r.disposition !== "human-required");

  if (incompleteRows.length > 0) {
    const incompleteDesc = incompleteRows.map((r) => `- ISC #${r.id}: ${r.description}`).join("\n");
    return {
      kind: "terminate",
      outcome: {
        kind: "rejected",
        verdict: "FAIL",
        reason: `${incompleteRows.length} automatable ISC row(s) still PENDING (not completed by agent):\n${incompleteDesc}`,
        faultClass: "item",
        skepticalReview: verifyResult.skepticalReview,
      },
    };
  }

  const item = deps.queue.getItem(ctx.itemId);
  const itemTitle = item?.title ?? "unknown";

  const proxyIds = await deps.notificationDispatcher.createHumanProxies(ctx.itemId, itemTitle, humanRows);
  deps.guard.updateStatus(ctx.itemId, "blocked");
  deps.queue.setMetadata(ctx.itemId, {
    manualRows: humanRows.map((r) => ({ id: r.id, description: r.description })),
    humanProxyIds: proxyIds,
  });

  deps.guard.appendAuditLog({
    itemId: ctx.itemId,
    itemTitle,
    verdict: "PASS",
    concerns: [
      `Automated work verified. ${humanRows.length} human-required row(s) remain: ${humanRows
        .map((r) => `#${r.id}`)
        .join(", ")}. Created ${proxyIds.length} HUMAN proxies + LucidTasks.`,
    ],
    tiersExecuted: verifyResult.skepticalReview?.tiers.map((t) => t.tier) ?? [],
    verificationCost: verifyResult.skepticalReview?.totalCost ?? 0,
    iscRowSummary: currentRows.map((r) => `${r.id}:${r.status}`),
  });

  return {
    kind: "terminate",
    outcome: {
      kind: "blocked-on-human",
      humanRows,
      proxyIds,
      skepticalReview: verifyResult.skepticalReview,
    },
  };
};

/**
 * Run the post-verify completion gate.
 *
 * Pipeline position: AFTER triagePending, BEFORE the legacy auto-merge step.
 *
 * Delegates to deps.complete (the orchestrator's gauntlet of verification-status,
 * provenance, ISC, gated-category, and spec-coverage checks; on success it cleans
 * up the worktree and transitions status to "completed").
 *
 * On gate fail (deps.complete returns { success: false, reason }):
 *   - Append an audit log entry mirroring the legacy Step 4b shape
 *     (verdict FAIL, concerns includes the rejection reason, tiers + cost from
 *     ctx.verifyResult, iscRowSummary from current ISC state, failureReason
 *     carries the raw reason for downstream parsers).
 *   - Terminate kind:"rejected" with verdict:"FAIL", faultClass:"item",
 *     skepticalReview from ctx.verifyResult. The reason is prefixed with
 *     "Completion gate rejected: " to match the legacy reportDone return.
 *
 * On gate pass: continue (downstream legacy auto-merge + insight emission run).
 */
export const commitCompletion: CompletionStage = async (ctx, deps) => {
  if (!ctx.verifyResult) {
    throw new Error("commitCompletion requires verifyResult on ctx (verifyAndAudit must run first)");
  }
  const verifyResult = ctx.verifyResult;

  const completeResult = await deps.complete(ctx.itemId);
  if (completeResult.success) {
    return { kind: "continue" };
  }

  const item = deps.queue.getItem(ctx.itemId);
  const reason = completeResult.reason ?? "unknown";
  deps.guard.appendAuditLog({
    itemId: ctx.itemId,
    itemTitle: item?.title ?? "unknown",
    verdict: "FAIL",
    concerns: [`Completion gate rejected: ${reason}`],
    tiersExecuted: verifyResult.skepticalReview?.tiers.map((t) => t.tier) ?? [],
    verificationCost: verifyResult.skepticalReview?.totalCost ?? 0,
    iscRowSummary: deps.iscManager.load(ctx.itemId).map((r) => `${r.id}:${r.status}`),
    failureReason: reason,
  });

  return {
    kind: "terminate",
    outcome: {
      kind: "rejected",
      verdict: "FAIL",
      reason: `Completion gate rejected: ${reason}`,
      faultClass: "item",
      skepticalReview: verifyResult.skepticalReview,
    },
  };
};

/**
 * Auto-merge the verified branch (Slice 8). Pipeline position: AFTER commitCompletion,
 * BEFORE emitTraces.
 *
 * Wraps deps.mergeItem (production wires Integrator.mergeItem with skipSessionLock).
 * Always continues — auto-merge is fail-open, never terminates the pipeline.
 *
 * Outcome → metadata mapping (preserves legacy semantics):
 *   - merged === true             → mergeStatus: "merged" + prUrl;         ctx.mergeStatus = "merged"
 *   - merged === false && reason  → mergeStatus: "pending_approval" + reason; ctx.mergeStatus = "pending_approval"
 *   - merged === false && !reason → no metadata write;                     ctx.mergeStatus = "skipped"
 *   - thrown exception            → no metadata write, warn-log;           ctx.mergeStatus = "skipped"
 */
export const mergeIfPossible: CompletionStage = async (ctx, deps) => {
  let mergeStatus: "merged" | "pending_approval" | "skipped" = "skipped";
  try {
    const result = await deps.mergeItem(ctx.itemId, ctx.opts.skipSessionLock);
    if (result.merged) {
      // prUrl only applies to the "pr" strategy (Integrator's ghCreatePr() path) — the
      // "direct" strategy (what production actually wires: WorkOrchestrator.ts's
      // mergeItem callback hardcodes "direct") returns { merged: true } with no prUrl
      // at all, so result.prUrl is genuinely undefined on every successful production
      // auto-merge today. Omit the key rather than pass undefined — it's inapplicable
      // here, not a caller bug, so it shouldn't route through setMetadata's
      // unguarded-optional warning.
      deps.queue.setMetadata(ctx.itemId, {
        mergeStatus: "merged",
        ...(result.prUrl ? { prUrl: result.prUrl } : {}),
      });
      mergeStatus = "merged";
    } else if (result.reason) {
      // mergeItem may have already persisted a PRECISE mergeStatus (Slice 3:
      // pending_approval / conflict / deferred). Preserve it — only fall back to the
      // generic pending_approval label when no precise state was recorded. Both the
      // precise Integrator-set value and this fallback share the canonical
      // "pending_approval" vocabulary (WorkQueue.WorkItemMetadata.mergeStatus); only
      // "conflict" / "deferred" remain distinguishable and are never overwritten here.
      const current = deps.queue.getItem(ctx.itemId)?.metadata?.mergeStatus as string | undefined;
      const precise = current === "pending_approval" || current === "conflict" || current === "deferred";
      deps.queue.setMetadata(ctx.itemId, {
        ...(precise ? {} : { mergeStatus: "pending_approval" }),
        mergeReason: result.reason,
      });
      mergeStatus = "pending_approval";
    }
  } catch (e) {
    console.warn(`[reportDone] Auto-merge failed for ${ctx.itemId}: ${e instanceof Error ? e.message : String(e)}`);
  }
  return { kind: "continue", ctxPatch: { mergeStatus } };
};

/**
 * Terminal stage — emit completion traces and terminate `kind: "completed"`.
 *
 * All three side effects are fail-open:
 *   - deps.emitCompletion: sync trace emit (wrapped in try/catch).
 *   - deps.emitInsight:    fire-and-forget Promise; .catch() swallows rejection.
 *   - deps.runEvaluatorPipeline: fire-and-forget Promise; .catch() swallows rejection.
 *
 * Terminal outcome carries:
 *   - mergeStatus from ctx.mergeStatus (set by mergeIfPossible; defaults to "skipped").
 *   - skepticalReview from ctx.verifyResult (legacy returns this through; can be undefined).
 */
export const emitTraces: CompletionStage = (ctx, deps) => {
  try { deps.emitCompletion(ctx.itemId, "executive"); } catch { /* fail-open */ }

  const item = deps.queue.getItem(ctx.itemId);
  const iscRowCount = deps.iscManager.load(ctx.itemId).length;
  const verificationCost = ctx.verifyResult?.skepticalReview?.totalCost ?? 0;
  deps.emitInsight({
    source: "AutonomousWork",
    type: "signal",
    title: `Work completed: ${item?.title ?? ctx.itemId}`,
    content: `Verdict: PASS, ISC rows: ${iscRowCount}`,
    tags: ["work-completion", "pass"],
    metadata: { itemId: ctx.itemId, iscRowCount, verificationCost },
  }).catch((e) => logFailure("CompletionPipeline:emitInsight", e, { itemId: ctx.itemId }));

  deps.runEvaluatorPipeline(ctx.itemId).catch((e) => logFailure("CompletionPipeline:runEvaluatorPipeline", e, { itemId: ctx.itemId }));

  return {
    kind: "terminate",
    outcome: {
      kind: "completed",
      mergeStatus: ctx.mergeStatus ?? "skipped",
      skepticalReview: ctx.verifyResult?.skepticalReview,
    },
  };
};
