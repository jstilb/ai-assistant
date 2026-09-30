#!/usr/bin/env bun
/**
 * WorkOrchestrator.ts - Unified orchestrator for autonomous work
 *
 * Single replacement for ExecutiveOrchestrator (989 lines),
 * ItemOrchestrator (1,686 lines), and UnblockingOrchestrator (~650 lines).
 *
 * Keeps: catastrophic detection, verification pipeline with command allowlist,
 * ISC generation from specs, effort classification, per-row command re-run
 * (Gate 1 — the standalone ExecutiveOrchestrator.spotCheck() was deleted in
 * L3 as a duplicate of this), prior work summary, feature branch creation.
 *
 * Cuts: per-item state files, multi-phase promotion, 16 FM-patches,
 * bidirectional spec sync, auto-unblocking, display layer.
 *
 * Usage:
 *   bun run WorkOrchestrator.ts init                  # Validate DAG, load queue, recover orphans
 *   bun run WorkOrchestrator.ts next-batch [n]        # Get ready items from WorkQueue
 *   bun run WorkOrchestrator.ts prepare <id>          # Classify effort + generate ISC rows
 *   bun run WorkOrchestrator.ts started <id>          # Mark in_progress
 *   bun run WorkOrchestrator.ts verify <id>           # Run verification + skeptical review gate
 *   bun run WorkOrchestrator.ts mark-done <id> <rows>  # Transition ISC rows PENDING→DONE
 *   bun run WorkOrchestrator.ts report-done <id> <rows...>  # Atomic: mark-done + verify + complete
 *   bun run WorkOrchestrator.ts retry <id> [err]      # Record attempt, reset to pending (escalates after 3)
 *   bun run WorkOrchestrator.ts fail <id> [err] --force  # Force-fail (manual kill only)
 *   bun run WorkOrchestrator.ts status                # Show queue state + blocked items
 *   bun run WorkOrchestrator.ts report [--json]       # Structured report: completed/failed/inProgress/blocked/needsReview
 */

import { readFileSync, existsSync, readdirSync } from "fs";
import { join, isAbsolute } from "path";
import { deriveFollowOnFromSpec, type FollowOnLoop } from "./FollowOnLoops.ts";
import { WorkQueue, type WorkItem, type WorkItemAttempt, type WorkItemVerification, type WorkItemMetadata, type EffortLevel, type Priority } from "./WorkQueue.ts";
import { logFailure } from "../../../../lib/core/FailureLog.ts";
import { getKayaHome, defaultKayaHome } from "../../../../lib/core/KayaHome.ts";
// cross-skill-allowed: deliberate observability integration — orchestrator emits workflow/completion/error/decision traces to AgentMonitor's trace pipeline
import { emitWorkflowStart, emitCompletion, emitError, emitDecision } from "../../../System/AgentMonitor/Tools/TraceEmitter.ts";
import { emit as emitTrace } from "../../../../lib/core/UnifiedEventSink.ts";
import { memoryStore } from "../../../../lib/core/MemoryStore.ts";
// cross-skill-allowed: deliberate observability integration — orchestrator streams live progress into AgentMonitor's streaming pipeline
import { startStreamingPipeline, type StreamingPipeline } from "../../../System/AgentMonitor/Tools/StreamingPipeline.ts";
import { SkepticalVerifier, type ItemReviewSummary, type SkepticalReviewResult, type InferenceFn, type ProjectContext } from "./SkepticalVerifier.ts";
import { TransitionGuard } from "./TransitionGuard.ts";
// SpecParser retired: comprehension (LLMSpecComprehension) is the sole ISC source.
// ShadowComprehension retired: comprehension is primary (generateISC), not shadow.
import { ITERATION_LIMITS, DEFAULT_EFFORT } from "./Types.ts";
import { mapProducerSurface } from "./SurfaceClassifier.ts";
import { ISCManager } from "./ISCManager.ts";
import { NotificationDispatcher } from "./NotificationDispatcher.ts";
import { applyCompletionSideEffects } from "./QueueCompletionEffects.ts";
import { CommandRunner } from "./CommandRunner.ts";
import { VerifyContextResolver } from "./VerifyContextResolver.ts";
import { recoverOrphanedItems as recoverOrphanedItemsFn } from "./OrphanRecovery.ts";
import { ISCGenerator } from "./ISCGenerator.ts";
import { CompletionPipeline, type TechDebtInput } from "./CompletionPipeline.ts";
// cross-skill-allowed: ISC 4 — orchestrator constructs the registry handed to CompletionPipeline for self-reported tech-debt writes on completion; seam candidate: DebtRegistry client
import { TechDebtRegistry } from "../../AutoMaintenance/Tools/TechDebtRegistry.ts";
import { Integrator } from "./Integrator.ts";
import { extractPathsFromDiffStat as _extractPathsFromDiffStat } from "./lib/verifier/index.ts";
import { isCatastrophic as isCatastrophicCmd, isProtectedBranch as isProtectedBranchName } from "./lib/orchestrator/CatastrophicGate.ts";
import { statusReport, categorizeReport, reportMarkdown as reportMarkdownFn, generatePriorWorkSummary as generatePriorWorkSummaryFn, type WorkReport } from "./lib/orchestrator/Reporting.ts";
import {
  annotateHumanGatedPhases,
  formatISCTableForAgents as formatISCTableForAgentsFn,
  markRowsHumanRequired as markRowsHumanRequiredFn,
  markPhaseDone as markPhaseDoneFn,
  getPhaseISC as getPhaseISCFn,
  generatePhaseGitSummary as generatePhaseGitSummaryFn,
} from "./lib/orchestrator/PhaseBookkeeping.ts";
import { verifyPhase as verifyPhaseFn } from "./lib/orchestrator/Verification.ts";
import {
  tryResolveGitRoot as tryResolveGitRootFn,
  resolveRepoRoot as resolveRepoRootFn,
  ensureFeatureBranch as ensureFeatureBranchFn,
  cleanupWorktree as cleanupWorktreeFn,
} from "./lib/orchestrator/WorktreeOps.ts";

// ============================================================================
// Types
// ============================================================================

// ISCRowCategory + the inferCategory keyword classifier were deleted in S2
// (de-determinize): the LLM judge always runs now, so per-row category gating
// (skip-judge / Tier1 doc-cleanup-deploy checks / completion gate) is gone.

/**
 * WorkSurface — classifies what type of interface the work touches.
 * Used by the verification pipeline to dispatch surface-appropriate checks.
 */
export type WorkSurface =
  | "browser"      // UI components: .tsx/.jsx under components/pages/containers + UI keywords in spec
  | "cli"          // stdin/stdout/argv interfaces: bin/ files or CLI keywords in spec
  | "api"          // HTTP endpoints/routes: endpoint/route/HTTP method keywords in spec
  | "integration"; // Everything else: internal TypeScript, hooks, state, plumbing

export type ISCRowDisposition = "automatable" | "human-required" | "deferred";

/**
 * Classifies the origin of a pipeline failure for retry routing.
 * - "item":           The work item's code/tests failed (default — consumes a retry counter)
 * - "infrastructure": The pipeline tooling is broken (parseSpec, SkepticalVerifier internal exception)
 *                     Does NOT consume a retry counter — fix the tool first
 * - "environment":    The EXECUTION CONTEXT could not verify the work (classifier-blocked
 *                     live verification, inference unavailable, no runnable exercise here).
 *                     The code is fine — re-stage to pending for the next eligible run
 *                     instead of burning retries to a human-board escalation (Principle B2).
 * - "transient":      Resource/network error (EMFILE, ECONNRESET, ETIMEDOUT) — retryable with cooldown
 */
export type FaultClass = "item" | "infrastructure" | "environment" | "transient";

/**
 * Exact system-emitted marker token signalling that live verification could not RUN in
 * this execution context. Objective ground-truth (like an exit code), NOT prose — emitted
 * by lib/verifier/PhaseL.ts. classifyFailure matches it exactly.
 */
const ENV_BLOCK_SENTINEL = "LIVE_VERIFICATION_ENVIRONMENT_BLOCK";

export interface ISCRow {
  id: number;
  description: string;
  status: "PENDING" | "DONE" | "VERIFIED" | "EXECUTION_FAILED";
  capability?: string;
  parallel: boolean;
  source?: "EXPLICIT" | "INFERRED" | "IMPLICIT" | "RESEARCH";
  specSection?: string;
  /** True when spec exists but parseSpec returned empty ISC, forcing template fallback */
  specFallback?: boolean;
  /** Whether this row can be completed by automation or requires human action */
  disposition?: ISCRowDisposition;
  /** Test level classification from TestStrategy */
  testLevel?: "unit" | "integration" | "e2e" | "manual";
  /** Verification priority — smoke rows run first for fast-fail */
  priority?: "smoke" | "full";
  /** True when this row represents an infrastructure failure, not a work item fault */
  infraFault?: boolean;
  /** Optional evidence artifacts attached when row is marked done */
  evidence?: { files?: string[]; commands?: string[]; summary?: string };
  /**
   * Human-readable instruction for manual ISC rows (ISC 3).
   * For automation rows, use verification.method instead.
   * Rendered in human proxy steps as: `1. ${row.verifyMethod ?? row.description}`.
   * Used in NotificationDispatcher.createHumanProxies.
   */
  verifyMethod?: string;
  verification?: {
    method: string;
    command?: string;
    success_criteria: string;
    result?: "PASS" | "FAIL";
    /** When true, non-zero exit = PASS and zero exit = FAIL (for "X is NOT present" assertions) */
    invertExit?: boolean;
  };
}

export interface PhaseExecutionInfo {
  phaseNumber: number;
  phaseName: string;
  iscRowIds: number[];          // ISCRow.id values (NOT spec ISCCriterion.number)
  maxIterations: number;
  usedPositionalFallback: boolean;
  /**
   * True when the phase owns at least one `human-required` ISC row (WS2). The
   * Executive executes the autonomous-safe prefix and skips human-gated phases —
   * they are filed as a "Kaya — Needs Jm" task at prepare() time and resume once
   * the human action is done. Never escalate the whole item for these.
   */
  isHumanGated?: boolean;
}

// annotateHumanGatedPhases moved to lib/orchestrator/PhaseBookkeeping.ts (S11
// decomposition, pass 2) — imported above; re-exported here for backward compat
// (external tests import it directly from WorkOrchestrator.ts).
export { annotateHumanGatedPhases };

export interface PrepareResult {
  success: boolean;
  effort: EffortLevel;
  iscRows: ISCRow[];
  maxIterations: number;
  error?: string;
  /** Non-blocking notices (e.g. structural-only warning for QUICK items) */
  warnings?: string[];
  /** Present when phased execution detected (totalISC >= 8 AND phases >= 2) */
  phases?: PhaseExecutionInfo[];
  /** Which phase to resume from (when item.completedPhases is non-empty) */
  resumeFromPhase?: number;
  /** ISC row IDs already completed from prior phases (for resume) */
  completedRowIds?: number[];
}

export interface RepoContext {
  name: string;       // "timeseries-forecasting"
  cwd: string;        // absolute path to repo
  startSha?: string;  // git SHA at work start
  pathFilter?: string[];
}

export type VerifyContext =
  | { kind: "single"; cwd: string; startSha?: string; pathFilter?: string[] }
  | { kind: "multi"; repos: RepoContext[] };

// CatastrophicAction moved to VerificationUtils.ts — re-export for backward compat
export type { CatastrophicAction } from "./VerificationUtils.ts";

// ============================================================================
// Constants
// ============================================================================

// Reads KAYA_HOME env override → getKayaHome() (memoized).
const KAYA_HOME = getKayaHome();
// CATASTROPHIC_PATTERNS and PROTECTED_BRANCHES moved to VerificationUtils.ts — re-exported below for backward compat

// ISC 9: ITERATION_LIMITS is now canonical in Types.ts — imported directly above

const PHASE_MIN_ISC_THRESHOLD = 8;
const PHASE_MIN_PHASES = 2;

// Verification utility functions extracted to VerificationUtils.ts (ISC line-count reduction)
export { normalizeVerificationCommand, findMissingDirectoryArg } from "./VerificationUtils.ts";
// Security constants moved to VerificationUtils.ts — re-export for backward compat
export { CATASTROPHIC_PATTERNS, PROTECTED_BRANCHES } from "./VerificationUtils.ts";

// ============================================================================
// WorkOrchestrator Class
// ============================================================================

export class WorkOrchestrator {
  /** Public readonly so CLI/tests can read queue state directly. Mutations still go
   *  through the orchestrator's lifecycle methods (prepare, reportDone, retry, etc.). */
  readonly queue: WorkQueue;
  private verifier: SkepticalVerifier;
  private guard: TransitionGuard;
  // ISC 9 → Phase 3b: EffortClassifier removed. Residue cleanup: deriveEffort's
  // keyword heuristic removed too — effort is a single generous DEFAULT cap.
  // Phase 6: SurfaceClassifier reduced to the native bit — surface is resolved inline
  // via mapProducerSurface(item.surface); no per-surface heuristic instance needed.
  /** ISC 5+11: ISCManager extracted from god object — owns ISC lifecycle and cache.
   *  Public readonly so callers (including tests) interact with ISC state directly,
   *  rather than via thin delegating wrappers on the orchestrator. */
  readonly iscManager: ISCManager;
  /** ISC 6: NotificationDispatcher extracted from god object */
  private notificationDispatcher: NotificationDispatcher;
  private commandRunner: CommandRunner = new CommandRunner();
  private verifyCtxResolver: VerifyContextResolver = new VerifyContextResolver();
  private iscGenerator!: ISCGenerator; // initialized in constructor after iscManager
  /** Staged pipeline for reportDone — see CompletionPipeline.ts */
  private completionPipeline!: CompletionPipeline; // initialized in constructor after iscManager
  private lastRecoveryAt: number = 0;
  /** Injectable inference function for Strategy 1.5 (Haiku ISC extraction) */
  private inferenceFn?: InferenceFn;
  private monitorPipeline?: StreamingPipeline;
  /**
   * ISC 1: Injectable notifier for notifications — overrides NotificationDispatcher.
   * Tests inject a mock with a notify(msg) method to assert notification dispatch.
   */
  private _injectedNotifier?: { notify: (msg: string) => void; emitNeedsReviewNotification?: () => void };

  /**
   * Options-based constructor overload for DI in tests.
   * Accepts a flat options object instead of positional (WorkQueue, SkepticalVerifier, InferenceFn).
   * All fields optional — defaults match the normal no-arg constructor.
   */
  constructor(opts: {
    queuePath?: string;
    notifier?: { notify: (msg: string) => void; emitNeedsReviewNotification?: () => void };
    inferenceFn?: InferenceFn;
  });
  /** Positional constructor — legacy form used by production code and existing tests */
  constructor(queue?: WorkQueue, verifier?: SkepticalVerifier, inferenceFn?: InferenceFn);
  constructor(
    queueOrOpts?: WorkQueue | {
      queuePath?: string;
      notifier?: { notify: (msg: string) => void; emitNeedsReviewNotification?: () => void };
      inferenceFn?: InferenceFn;
    },
    verifier?: SkepticalVerifier,
    inferenceFn?: InferenceFn,
  ) {
    // Detect options-object form: has known option keys and is not a WorkQueue instance
    if (queueOrOpts && !(queueOrOpts instanceof WorkQueue) && typeof queueOrOpts === "object") {
      const opts = queueOrOpts as { queuePath?: string; notifier?: { notify: (msg: string) => void }; inferenceFn?: InferenceFn };
      this.queue = new WorkQueue(opts.queuePath);
      this._injectedNotifier = opts.notifier;
      inferenceFn = opts.inferenceFn;
      verifier = undefined;
    } else {
      this.queue = (queueOrOpts as WorkQueue | undefined) ?? new WorkQueue();
    }
    this.verifier = verifier ?? new SkepticalVerifier();
    this.guard = new TransitionGuard(this.queue);
    this.inferenceFn = inferenceFn;
    this.iscManager = new ISCManager(this.queue);
    this.iscGenerator = new ISCGenerator(
      this.iscManager,
      (item) => this.verifyCtxResolver.resolveItemCwd(item),
      (description) => this.iscManager.classifyDisposition({ id: 0, description, status: "PENDING", parallel: false }),
      this.inferenceFn, // threads injected inferenceFn (e.g. from _createForTesting) into comprehendSpec
      (itemId, spec) => { this.queue.setMetadata(itemId, { comprehendedSpec: spec }); },
    );
    this.notificationDispatcher = new NotificationDispatcher({
      queue: this.queue,
      onAuditLog: (entry) => this.guard.appendAuditLog(entry),
    });
    // ISC 4: Lazily construct TechDebtRegistry for production runs — fail-open so
    // completion is never blocked by a registry construction failure.
    let techDebtRegistry: TechDebtRegistry | undefined;
    try {
      techDebtRegistry = new TechDebtRegistry();
    } catch (err) {
      console.warn(`[WorkOrchestrator] TechDebtRegistry construction failed — debt recording disabled: ${err instanceof Error ? err.message : String(err)}`);
    }

    this.completionPipeline = new CompletionPipeline({
      queue: this.queue,
      iscManager: this.iscManager,
      verify: (id) => this.verify(id),
      guard: this.guard,
      notificationDispatcher: this.notificationDispatcher,
      cleanupWorktree: (id) => this.cleanupWorktree(id),
      classifyFailure: (concerns, failures, faultClass) => this.classifyFailure(concerns, failures, faultClass),
      resolveStaleReviewProxies: (id) => this.resolveStaleReviewProxies(id),
      complete: (id) => this.complete(id),
      // E2: caller-controlled — DEFAULT false (lock-respecting). Threaded from
      // reportDone's opts.skipSessionLock via CompletionOpts.skipSessionLock (ctx.opts).
      // Previously hardcoded skipSessionLock:true unconditionally here, which bypassed
      // the Integrator's interactive-session-lock defer for EVERY completion — safe
      // when only interactive humans ran report-done, unsafe now that HeadlessWorkDriver
      // runs it unattended nightly. See WorkOrchestratorCLI.ts's --interactive-session flag.
      mergeItem: (id, skipSessionLock) => new Integrator(this.queue).mergeItem(id, "direct", { skipSessionLock: skipSessionLock ?? false }),
      emitCompletion: (id, label) => emitCompletion(id, label),
      emitInsight: (insight) => memoryStore.capture(insight).then(() => undefined),
      // evals-rebuild slice C2: AgentMonitor's Phase-1 batch-evaluation pipeline
      // (EvaluatorPipeline.ts's runPipeline — the five-evaluator scoring chain
      // this hook used to run per-item, against MEMORY/MONITORING/traces/{id}.jsonl)
      // is deleted with no direct per-item replacement. ErrorRate/DecisionQuality
      // signal now lives as a NIGHTLY, curated-sample Evals regression check
      // (skills/Intelligence/Evals/UseCases/AgentTraces/), not a live per-completion
      // scorer — so this fail-open DI hook is now a genuine no-op rather than
      // silently degrading to a broken import. See CompletionPipeline.ts's
      // emitTraces stage: this fires fire-and-forget with its rejection swallowed,
      // so a no-op is behavior-neutral for every OTHER completion side effect.
      runEvaluatorPipeline: async () => { /* no-op — see comment above */ },
      techDebtRegistry,
    });
  }

  /** DI constructor for tests — no filesystem, SkepticalVerifier stubbed by default */
  static _createForTesting(queue: WorkQueue, opts?: { verifierResult?: SkepticalReviewResult; inferenceFn?: InferenceFn }): WorkOrchestrator {
    const stubResult: SkepticalReviewResult = opts?.verifierResult ?? {
      finalVerdict: "PASS",
      tiers: [
        { tier: 1, verdict: "PASS", confidence: 1.0, concerns: [], costEstimate: 0, latencyMs: 0 },
        { tier: 2, verdict: "PASS", confidence: 0.95, concerns: [], costEstimate: 0.01, latencyMs: 100 },
      ],
      tiersSkipped: [],
      totalCost: 0.01,
      totalLatencyMs: 100,
      concerns: [],
    };
    const mockVerifier = { review: async () => stubResult } as unknown as SkepticalVerifier;
    const orch = new WorkOrchestrator(queue, mockVerifier, opts?.inferenceFn);
    orch.guard = new TransitionGuard(queue, "/dev/null"); // no-op audit in tests
    orch.getGitDiffStat = (_ctx: VerifyContext) => "1 file changed, 10 insertions(+)";
    // Escalation writes go to the live LucidTasks DB ("Kaya — Needs Jm" board) —
    // a ForTesting factory must never produce them. Tests that assert escalation
    // behavior use their own recording dispatchers instead.
    orch.notificationDispatcher.createJmTask = async () => {};
    orch.notificationDispatcher.createHumanProxies = async () => [];
    return orch;
  }

  // --------------------------------------------------------------------------
  // Init
  // --------------------------------------------------------------------------

  /**
   * Reads the most recent 5 failure entries from the FAILURES learning directory
   * and returns a formatted warning string to prepend to the init summary.
   * Returns empty string if no failures are found or the directory doesn't exist.
   */
  async readOrchestrationLearnings(
    // Reads process.env.HOME only (ignores KAYA_HOME) → defaultKayaHome() preserves exact behavior.
    failuresDir: string = join(defaultKayaHome(), "MEMORY", "LEARNING", "FAILURES")
  ): Promise<string> {
    try {
      if (!existsSync(failuresDir)) return "";

      // Find date directories (YYYY-MM-DD), pick most recent
      const dateDirs = readdirSync(failuresDir)
        .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
        .sort()
        .reverse();

      if (dateDirs.length === 0) return "";

      const mostRecentDir = join(failuresDir, dateDirs[0]);
      const files = readdirSync(mostRecentDir)
        .filter((f) => f.endsWith(".md"))
        .sort()
        .reverse()
        .slice(0, 5);

      if (files.length === 0) return "";

      const summaries: string[] = [];
      for (const file of files) {
        const content = readFileSync(join(mostRecentDir, file), "utf-8");
        // Extract ## Summary section text
        const match = content.match(/## Summary\s*\n+([^\n#][^\n]*)/);
        if (match) {
          summaries.push(`- ${match[1].trim()}`);
        }
      }

      if (summaries.length === 0) return "";

      return `⚠️ Recent failure patterns (${dateDirs[0]}):\n${summaries.join("\n")}`;
    } catch (e) {
      logFailure("WorkOrchestrator:readOrchestrationLearnings", e, { failuresDir });
      return "";
    }
  }

  async init(): Promise<{ success: boolean; message: string; ready: number; blocked: number; recovered: number }> {
    // S5b: no longer auto-wire phase deps from titles — only warn loudly if phase-named
    // items lack explicit dependencies (explicit deps + the follow-on engine own ordering).
    this.queue.warnUnwiredPhaseItems();
    const validation = this.queue.validate();
    if (!validation.valid) {
      return { success: false, message: `DAG invalid: ${validation.errors[0]}`, ready: 0, blocked: 0, recovered: 0 };
    }
    const recovered = await this.recoverOrphanedItems();
    // S5b: stamp the periodic-recovery clock here too — otherwise the first
    // nextBatch() call right after init() sees lastRecoveryAt still at its
    // 0 default and immediately re-runs recovery (double recovery, duplicate
    // STALE-nudge spool writes). Mirrors the stamp in nextBatch()'s periodic
    // gate below.
    this.lastRecoveryAt = Date.now();

    // Audit integrity check (non-fatal — reports gaps but never blocks init)
    try { this.guard.validateAuditIntegrity(); } catch (e) { logFailure("WorkOrchestrator:validateAuditIntegrity", e); }

    // Reconcile: sync completed/failed work-queue items back to approved-work JSONL
    const reconciled = await this.reconcileApprovedWork();

    // Start live monitoring pipeline — zero LLM cost, fail-open
    try {
      this.monitorPipeline = startStreamingPipeline({ dashboard: false, quiet: true });
    } catch {}

    // Load recent failure patterns — non-fatal, prepended to message when present
    const learningsWarning = await this.readOrchestrationLearnings();

    const stats = this.queue.getStats();
    const recoveredMsg = recovered > 0 ? `, ${recovered} recovered` : "";
    const reconciledMsg = reconciled > 0 ? `, ${reconciled} reconciled to approved-work` : "";
    const baseMessage = `Initialized: ${stats.ready} ready, ${stats.blocked} blocked${recoveredMsg}${reconciledMsg}`;
    const message = learningsWarning ? `${learningsWarning}\n${baseMessage}` : baseMessage;
    return {
      success: true,
      message,
      ready: stats.ready,
      blocked: stats.blocked,
      recovered,
    };
  }

  /** Stop the live monitoring pipeline if running */
  stopMonitoring(): void {
    try { this.monitorPipeline?.stop(); } catch {}
  }

  // --------------------------------------------------------------------------
  // Next-batch
  // --------------------------------------------------------------------------

  /**
   * Returns the next batch of ready work items from the queue.
   */
  async nextBatch(
    max: number = 5,
  ): Promise<{ items: WorkItem[]; blocked: number }> {
    // Periodic orphan recovery (M4) — every 30 minutes
    if (Date.now() - this.lastRecoveryAt > 30 * 60 * 1000) {
      await this.recoverOrphanedItems();
      this.lastRecoveryAt = Date.now();
    }
    const items = this.queue.getParallelBatch(max);
    const blocked = this.queue.getDagBlockedItems().length;
    return { items, blocked };
  }

  // --------------------------------------------------------------------------
  // Prepare: effort classification + ISC generation
  // --------------------------------------------------------------------------

  async prepare(itemId: string, effortOverride?: EffortLevel): Promise<PrepareResult> {
    const item = this.queue.getItem(itemId);
    if (!item) return { success: false, effort: "STANDARD", iscRows: [], maxIterations: 10, error: `Not found: ${itemId}` };

    // Emit trace: prepare-start
    try {
      emitTrace({
        source: "trace",
        category: "phase-transition",
        severity: "debug",
        workflowId: itemId,
        agentId: "executive",
        payload: { phase: "prepare-start", title: item.title },
      });
    } catch { /* fail-open */ }

    // Effort = a single generous DEFAULT cap (iteration + wall-clock), not a
    // keyword-derived tier. Per "determinism must earn its place", caps are plain
    // default numbers that fail LOUD when hit — not content interpretation. The old
    // deriveEffort() keyword heuristic returned STANDARD for nearly everything
    // anyway; callers that genuinely need more pass effortOverride.
    const effort = effortOverride ?? DEFAULT_EFFORT;
    this.queue.setEffort(itemId, effort);

    // Generate ISC rows — always regenerates fresh (S4: retry-strategy ladder deleted)
    const rows = await this.iscGenerator.generateISC(item, effort);

    // S5a: the weakRatio>0.5 ISC quality gate + the inferVerificationCommand patch loop are
    // removed — grading the completeness of the LLM's own ISC output is the always-running
    // judge's job (Gate 3), not a deterministic prepare()-time content gate.

    this.iscManager.persist(itemId, rows);

    // Phase detection: if spec has multiple phases with enough ISC, build per-phase execution plan
    let phases: PhaseExecutionInfo[] | undefined;
    let resumeFromPhase: number | undefined;
    let completedRowIds: number[] | undefined;

    try {
      // Phase 5a: phases come from the LLM comprehension (persisted as
      // metadata.comprehendedSpec by generateISC), NOT from parseSpec. The
      // comprehension's phase rowIds already align to ISCRow ids because
      // generateISC maps ComprehendedRow.id → ISCRow.id directly.
      const compSpec = (this.queue.getItem(itemId)?.metadata as WorkItemMetadata | undefined)?.comprehendedSpec;
      const compPhases = compSpec?.phases ?? [];
      if (rows.length >= PHASE_MIN_ISC_THRESHOLD && compPhases.length >= PHASE_MIN_PHASES) {
        const totalISCCount = Math.max(1, rows.length);
        const totalMaxIter = ITERATION_LIMITS[effort];
        const validRowIds = new Set(rows.map((r) => r.id));

        const built: PhaseExecutionInfo[] = compPhases
          .map((ph) => {
            const iscRowIds = ph.rowIds.filter((id) => validRowIds.has(id));
            const phaseISCCount = iscRowIds.length;
            return {
              phaseNumber: ph.number,
              phaseName: ph.name,
              iscRowIds,
              maxIterations: Math.max(3, Math.ceil(totalMaxIter * phaseISCCount / totalISCCount)),
              usedPositionalFallback: false,
            };
          })
          .filter((p) => p.iscRowIds.length > 0);

        // Only phase if enough phases survived the row-id alignment filter.
        if (built.length >= PHASE_MIN_PHASES) {
          phases = built;

          // WS2: flag phases that own human-required rows so the Executive can
          // run the autonomous prefix and skip (not escalate) human-gated phases.
          annotateHumanGatedPhases(phases, rows);

          // Resume detection: skip already-completed phases
          if (item.completedPhases && item.completedPhases.length > 0) {
            const completedSet = new Set(item.completedPhases);
            const firstIncomplete = phases.find((p) => !completedSet.has(p.phaseNumber));
            if (firstIncomplete) {
              resumeFromPhase = firstIncomplete.phaseNumber;
            }
            // Collect row IDs from completed phases
            completedRowIds = phases
              .filter((p) => completedSet.has(p.phaseNumber))
              .flatMap((p) => p.iscRowIds);
          }
        }
      }
    } catch (e) {
      // Non-fatal: fall through to single-shot on phase detection error
      console.warn(`[WorkOrchestrator] Phase detection failed (non-fatal): ${e instanceof Error ? e.message : e}`);
    }

    // Work surface (Phase 6): the only fact that drives behaviour is native vs not
    // (the human lock) — cache the producer-classified surface for Phase L. We no
    // longer guess browser/cli/api from prose/diff, so there is no surface-mismatch
    // heuristic and no mismatch-driven needsReview.
    const workSurface = mapProducerSurface(item.surface) ?? "integration";
    this.queue.setMetadata(itemId, { workSurface });

    // WS2: file the genuinely-human phases as ONE "Kaya — Needs Jm" task at
    // prepare() time (idempotent — guarded by metadata so repeated prepare() calls
    // do not re-file). The Executive then runs the autonomous prefix and skips these
    // phases; they resume once the human task is marked done. We do NOT escalate
    // the whole item — only the specific human-gated phases are surfaced.
    const humanGatedPhases = (phases ?? []).filter((p) => p.isHumanGated);
    if (humanGatedPhases.length > 0 && !item.metadata?.humanPhaseTaskFiled) {
      const humanRowIds = new Set(humanGatedPhases.flatMap((p) => p.iscRowIds));
      const humanRowDescs = rows
        .filter((r) => humanRowIds.has(r.id) && r.disposition === "human-required")
        .map((r) => `- ${r.description}`);
      const phaseList = humanGatedPhases
        .map((p) => `Phase ${p.phaseNumber} (${p.phaseName})`)
        .join(", ");
      const description =
        `Autonomous work is proceeding on the non-human phases. The following ` +
        `phase(s) need YOU because they require an action Kaya cannot perform ` +
        `(secret entry, account/consent, physical, or irreversible-destructive):\n\n` +
        `${phaseList}\n\nHuman steps:\n${humanRowDescs.join("\n")}\n\n` +
        `Once you've done these, mark this task done and Kaya will resume the held phases.`;
      try {
        await this.notificationDispatcher.createJmTask(itemId, item.title, description);
        this.queue.setMetadata(itemId, { humanPhaseTaskFiled: true });
      } catch (e) {
        // Non-fatal: don't block prepare on escalation-task filing.
        console.warn(`[WorkOrchestrator] human-phase task filing failed (non-fatal): ${e instanceof Error ? e.message : e}`);
      }
    }

    return {
      success: true,
      effort,
      iscRows: rows,
      maxIterations: ITERATION_LIMITS[effort],
      phases,
      resumeFromPhase,
      completedRowIds,
    };
  }

  // --------------------------------------------------------------------------
  // Status transitions
  // --------------------------------------------------------------------------

  started(itemId: string): boolean {
    const item = this.queue.getItem(itemId);
    if (!item) return false;
    // Transition pending → in_progress; skip if already in_progress (avoids audit noise)
    if (item.status === "pending") {
      const updated = this.guard.updateStatus(itemId, "in_progress");
      if (!updated) return false;
    } else if (item.status !== "in_progress") {
      return false;
    }
    this.iscManager.resetToPending(itemId);
    // Emit trace — fail-open (never interrupts orchestration)
    try { emitWorkflowStart(itemId, "executive", { title: item.title }); } catch {}
    // Emit trace: agent-spawn — marks the moment the builder agent is dispatched
    try {
      emitTrace({
        source: "trace",
        category: "phase-transition",
        severity: "debug",
        workflowId: itemId,
        agentId: "executive",
        payload: { phase: "agent-spawn", title: item.title, worktreePath: (item.metadata as WorkItemMetadata)?.worktreePath },
      });
    } catch { /* fail-open */ }
    return true;
  }

  // --------------------------------------------------------------------------
  // reportDone: Atomic completion pipeline
  // --------------------------------------------------------------------------

  /**
   * Atomic pipeline: mark rows done → record execution → verify → simulate → complete.
   * This is the ONLY public path to completion for non-TRIVIAL items.
   */
  async reportDone(itemId: string, agentResults: {
    completedRowIds: number[];
    failedRowIds?: number[];
    adversarialConcerns?: string[];
    executionLog?: string[];
    rowEvidence?: Record<number, { files?: string[]; commands?: string[]; summary?: string }>;
    /** ISC 4: Tech debt the agent introduced during this work — recorded to the registry on completion (maps from CLI --debt-incurred). Flows through to CompletionPipeline.run via agentResults. */
    debtIncurred?: TechDebtInput[];
  }, opts: {
    /**
     * E2: explicit interactive opt-in to bypass the Integrator's interactive-session-lock
     * defer on this item's auto-merge. DEFAULT false — the lock stays respected unless a
     * caller explicitly sets this true. Only WorkOrchestratorCLI's --interactive-session
     * flag (the attended Orchestrate.md Executive flow, run inside Jm's own interactive
     * session — see that flag's doc comment) ever sets this true. The unattended
     * HeadlessWorkDriver never does, so a fresh lock always defers its merges.
     */
    skipSessionLock?: boolean;
  } = {}): Promise<{ success: boolean; reason?: string; skepticalReview?: SkepticalReviewResult; faultClass?: FaultClass }> {
    const itemForMeta = this.queue.getItem(itemId);
    if (!itemForMeta?.metadata?.worktreePath) {
      console.warn(`[reportDone] WARNING: item ${itemId} has no worktree metadata. Work may have been done in the main repo directory.`);
    }

    const result = await this.completionPipeline.run(itemId, agentResults, { skipSessionLock: opts.skipSessionLock });

    if (result.kind === "completed") {
      // Slice 4: a verified+completed loop refills the queue with its next follow-on
      // loop (sequential — gated on this item). Fail-open: never block completion.
      try { await this.enqueueNextFollowOn(itemId); }
      catch (e) { console.warn(`[reportDone] follow-on enqueue failed for ${itemId} (non-fatal): ${e instanceof Error ? e.message : String(e)}`); }
      return { success: true, skepticalReview: result.skepticalReview };
    }
    if (result.kind === "blocked-on-human") {
      return {
        success: true,
        reason: `blocked: ${result.humanRows.length} human-required row(s) need Jm action (${result.proxyIds.length} LucidTasks created)`,
        skepticalReview: result.skepticalReview,
      };
    }
    if (result.kind === "rejected") {
      return {
        success: false,
        reason: result.reason,
        faultClass: result.faultClass,
        skepticalReview: result.skepticalReview,
      };
    }

    throw new Error(`CompletionPipeline did not terminate for item ${itemId}`);
  }

  /**
   * Slice 4 — Loop/epic continuation. When a multi-loop epic's item verifies and
   * completes, enqueue the NEXT declared follow-on loop so the queue refills.
   *
   * Forward stubs come from `item.metadata.followOnLoops` (structured, carried forward
   * loop-by-loop) or, when absent, are derived by an LLM that READS the item's spec and
   * decides what deferred work remains (`deriveFollowOnFromSpec` — comprehension, not a
   * regex parser; see FollowOnLoops.ts). Sequential live-verification gating is preserved
   * two ways:
   *   - the new loop DEPENDS ON this item, so the DAG won't release it until this loop
   *     is completed (which requires it to have VERIFIED), and
   *   - only ONE follow-on is enqueued at a time; the remainder rides on the new item.
   *
   * Idempotent: guarded by `metadata.followOnEnqueued` so a re-run never double-enqueues.
   */
  async enqueueNextFollowOn(
    itemId: string,
    deriveFn: (specPath?: string, ctx?: { title?: string }) => Promise<FollowOnLoop[]> = deriveFollowOnFromSpec,
  ): Promise<{ enqueued: boolean; newItemId?: string; remaining?: number; reason?: string }> {
    const item = this.queue.getItem(itemId);
    if (!item) return { enqueued: false, reason: "item not found" };
    const meta = item.metadata as WorkItemMetadata | undefined;

    if (meta?.followOnEnqueued) return { enqueued: false, reason: "already enqueued" };

    // Source the forward stubs: an explicit carry-forward declaration wins; else an LLM
    // reads the spec and decides what deferred work remains (comprehension, not a parser).
    let stubs: FollowOnLoop[] = Array.isArray(meta?.followOnLoops) ? (meta!.followOnLoops as FollowOnLoop[]) : [];
    if (stubs.length === 0) stubs = await deriveFn(item.specPath, { title: item.title });
    if (stubs.length === 0) return { enqueued: false, reason: "no follow-on loops declared" };

    const [next, ...rest] = stubs;
    const resolvedSpec = next.specPath
      ? (isAbsolute(next.specPath) ? next.specPath : join(KAYA_HOME, next.specPath))
      : undefined;
    const epicOrigin = (meta?.epicOriginItemId as string | undefined) ?? itemId;

    const newItem = this.queue.addItem({
      title: next.title,
      description: next.description ?? `Follow-on loop of "${item.title}" — sequential, gated on ${itemId}`,
      priority: item.priority,
      dependencies: [itemId], // sequential live-verification gating: cannot start until this loop completes
      source: "manual" as const,
      ...(resolvedSpec ? { specPath: resolvedSpec } : {}),
      ...(item.projectPath ? { projectPath: item.projectPath } : {}),
      ...(item.workType ? { workType: item.workType } : {}),
      metadata: { followOnLoops: rest, epicOriginItemId: epicOrigin },
    });

    this.queue.setMetadata(itemId, { followOnEnqueued: true, nextLoopItemId: newItem.id });
    console.warn(`[WorkOrchestrator] Enqueued follow-on loop "${next.title}" (${newItem.id}) gated on ${itemId}; ${rest.length} loop(s) remaining in epic.`);
    try { emitDecision(itemId, "executive", 1); } catch {}
    return { enqueued: true, newItemId: newItem.id, remaining: rest.length };
  }

  private async complete(itemId: string, result?: string): Promise<{ success: boolean; reason?: string }> {
    // PRIMARY GATE: Check persisted verification state (survives process boundaries)
    const item = this.queue.getItem(itemId);
    if (!item) return { success: false, reason: `Not found: ${itemId}` };

    if (!item.verification || item.verification.status !== "verified") {
      const detail = item.verification
        ? `Verification status is "${item.verification.status}" (verdict: ${item.verification.verdict}). Run verify first.`
        : "No verification record found. Run verify first.";
      return { success: false, reason: detail };
    }

    // PROVENANCE GATE: require pipeline verification for non-TRIVIAL items
    const effort = item.effort || "STANDARD";
    if (effort !== "TRIVIAL") {
      if (item.verification.verifiedBy !== "skeptical_verifier") {
        return { success: false, reason: `Completion blocked: verification was "${item.verification.verifiedBy}", not "skeptical_verifier". Non-TRIVIAL items require pipeline verification.` };
      }
      if (!item.verification.tiersExecuted || !item.verification.tiersExecuted.includes(1)) {
        return { success: false, reason: `Completion blocked: Tier 1 code checks did not execute. tiersExecuted: [${item.verification.tiersExecuted || []}]` };
      }
    }

    // SECONDARY GATE (defense in depth): ISC check if available (in-memory or persisted)
    const rows = this.loadISC(itemId);
    if (rows) {
      const verified = rows.filter(r => r.status === "VERIFIED").length;
      const iscRate = rows.length > 0 ? verified / rows.length : 0;
      // Emit decision trace with ISC completion rate — fail-open
      try { emitDecision(itemId, "executive", iscRate); } catch {}
      const unverified = rows.filter(r => r.status !== "VERIFIED");
      if (unverified.length > 0) {
        return { success: false, reason: `${unverified.length} ISC rows not verified (in-memory check).` };
      }

      // (Former TERTIARY category-coverage gate removed in S2: category/ISCRowCategory
      // deleted. It was already unreachable — the SECONDARY gate above requires EVERY
      // row VERIFIED, so a category-filtered non-verified set is always empty.)

      // (Former QUATERNARY coverage gate removed.) With comprehension as the single
      // ISC source, the SECONDARY gate above already requires EVERY row VERIFIED, so a
      // verified/total < 80% coverage check is unreachable. The old gate only added
      // value against the regex parser finding more spec requirements than ISC rows
      // (under-extraction) — now guarded by the comprehension loud-backstop + merit eval.
    }

    // Clean up worktree before marking completed
    await this.cleanupWorktree(itemId);

    // Phased items finish in "partial" (mark-phase-done); the transition matrix
    // only allows partial → in_progress → completed, so bridge the legal path.
    if (this.queue.getItem(itemId)?.status === "partial") {
      this.guard.updateStatus(itemId, "in_progress", "all phases done — completing");
    }

    const updated = this.guard.updateStatus(itemId, "completed", result);
    if (!updated) return { success: false, reason: `Failed to update: ${itemId}` };

    // Write-back: sync completion to approved-work JSONL so QueueManager stays in sync
    await this.syncCompletionToApprovedWork(itemId);

    return { success: true };
  }

  /** Force-fail an item (manual kill only). Use retry() for normal failure handling. */
  async fail(itemId: string, error?: string): Promise<boolean> {
    const item = this.guard.updateStatus(itemId, "failed", error);
    await this.cleanupWorktree(itemId);
    return item !== null;
  }

  /**
   * Classify the fault type from STRUCTURED signals first, then objective system markers.
   * S3b: reads structured carriers in priority order — prose interpretation removed.
   *
   * Priority:
   *   1. Structured faultClass arg (from SkepticalReviewResult.faultClass — set at origin by the verifier)
   *   2. infraFault-tagged ISCRow (tagged at origin in generateISC/CommandRunner)
   *   3. item.metadata.environmentBlockCount > 0 (persistent env-block recorded across runs)
   *   4. Exact ENV_BLOCK_SENTINEL token (objective system-emitted marker, not prose)
   *   5. OS error codes (EMFILE/ECONNRESET/ETIMEDOUT/… — objective, cannot be tagged on ISCRow)
   *   6. Default: "item"
   *
   * DELETED (S3b): the `environment[- ]block` and `inference (?:is\s+)?unavailable` prose regexes —
   * natural-language interpretation is the always-running LLM judge's domain, not this function.
   */
  private classifyFailure(reason: string, failures?: ISCRow[], faultClass?: FaultClass, item?: WorkItem): FaultClass {
    // 1. Structured faultClass already decided by the verifier (SkepticalReviewResult.faultClass)
    if (faultClass) return faultClass;
    // 2. Source-tagged infrastructure faults (tagged at origin in generateISC/verify)
    if (failures?.some(f => f.infraFault)) return "infrastructure";
    // 3. Persistent env-block recorded in metadata (survived prior runs)
    if ((((item?.metadata as WorkItemMetadata)?.environmentBlockCount as number) ?? 0) > 0) return "environment";
    // 4. Exact system-emitted sentinel — objective ground-truth (like an exit code), not prose
    if (reason.includes(ENV_BLOCK_SENTINEL)) return "environment";
    // 5. Transient resource errors (originate in execFileSync, can't be tagged on ISCRow)
    if (/EMFILE|ECONNRESET|ETIMEDOUT|ProcessFdQuotaExceeded|ECONNREFUSED/.test(reason)) return "transient";
    return "item";
  }

  /**
   * Record a failed attempt and reset item for retry.
   * prepare() always regenerates ISC fresh on every retry — no preserved-row path.
   * Attempt 3 (cap) → escalate to human via blocked proxy
   */
  async retry(itemId: string, error?: string, faultClass?: FaultClass): Promise<{ retried: boolean; escalated: boolean; attempt: number; item?: WorkItem; faultClass?: FaultClass; restaged?: boolean }> {
    const item = this.queue.getItem(itemId);
    if (!item) return { retried: false, escalated: false, attempt: 0 };

    // Principle B2 enforced in code: re-derive the fault class from the failure
    // reason when the caller did not provide one (the CLI `retry` path passes none).
    // Without this, "environment"/"infrastructure" classification would depend on
    // prose discipline rather than code.
    const effectiveFault: FaultClass = faultClass ?? this.classifyFailure(error ?? "", undefined, undefined, item);

    // Infrastructure fault: pipeline tooling is broken, not the work item.
    // Store for diagnostics but do NOT consume a retry counter.
    if (effectiveFault === "infrastructure") {
      const existing = ((item.metadata as WorkItemMetadata)?.infraErrors as string[] | undefined) ?? [];
      this.queue.setMetadata(itemId, {
        infraErrors: [...existing, `${new Date().toISOString()}: ${error ?? "infrastructure fault"}`],
        lastInfraFault: new Date().toISOString(),
      });
      console.warn(`[WorkOrchestrator] Infrastructure fault for ${itemId} — NOT consuming retry counter: ${error}`);
      try { emitError(itemId, "executive", `[infra] ${error ?? "infrastructure fault"}`); } catch {}
      return { retried: false, escalated: false, attempt: item.attempts?.length ?? 0, faultClass: "infrastructure" };
    }

    // Environment block (Slice 2 / Principle B2): verification could not RUN in this
    // execution context (classifier-blocked live verification, inference unavailable,
    // no runnable exercise here). The WORK is fine — re-stage to pending with a
    // cooldown so the NEXT eligible run picks it up, instead of burning the retry
    // counter to a "Needs Jm" board park. A persistent block (across many runs)
    // eventually escalates so it is never silently stuck forever.
    if (effectiveFault === "environment") {
      const meta = item.metadata as WorkItemMetadata | undefined;
      const count = ((meta?.environmentBlockCount as number | undefined) ?? 0) + 1;
      const escalateCap = Number(process.env.KAYA_ENV_BLOCK_ESCALATE_CAP ?? 8);

      if (count >= escalateCap) {
        // Genuinely stuck across many eligible runs — surface to a human, but tag it
        // clearly as an environment block (NOT a code failure) so triage is accurate.
        const proxy = this.queue.addItem({
          title: `REVIEW (environment-blocked): ${item.title}`,
          description: `Live verification has been environment-blocked ${count}× across runs for "${item.title}". The work may be fine — the execution context cannot verify it. Last reason: ${error ?? "environment block"}`,
          status: "blocked",
          priority: item.priority ?? "normal",
          dependencies: [],
          source: "manual" as const,
          humanTaskRef: {
            queueItemId: itemId,
            guideFilePath: item.specPath || "",
            createdAt: new Date().toISOString(),
            attemptHistory: `environmentBlockCount=${count}; last: ${error ?? "environment block"}`,
          },
        });
        this.queue.addDependency(itemId, proxy.id);
        await this.notificationDispatcher.createJmTask(itemId, item.title, `Environment-blocked ${count}× — verification cannot run here. ${error ?? ""}`);
        this.queue.setMetadata(itemId, { environmentBlockCount: count, lastEnvironmentBlock: new Date().toISOString(), lastEnvironmentBlockReason: error ?? "environment block" });
        try { emitError(itemId, "executive", `[env-block] persistent (${count}×) — escalated: ${error ?? ""}`); } catch {}
        return { retried: true, escalated: true, attempt: item.attempts?.length ?? 0, faultClass: "environment", item: this.queue.getItem(itemId) ?? undefined };
      }

      const cooldownMs = Number(process.env.KAYA_ENV_BLOCK_COOLDOWN_MS ?? 10 * 60 * 1000);
      this.queue.setMetadata(itemId, {
        environmentBlockCount: count,
        lastEnvironmentBlock: new Date().toISOString(),
        lastEnvironmentBlockReason: error ?? "environment block",
      });
      this.guard.logIndirectTransition(itemId, item.status, "pending", `Environment block #${count}: re-staged (cooldown ${cooldownMs}ms) — not a code failure, NOT escalated`);
      const restaged = this.queue.restagePending(itemId, cooldownMs);
      console.warn(`[WorkOrchestrator] Environment block for ${itemId} (#${count}) — re-staged to pending, NOT consuming retry counter: ${error}`);
      try { emitError(itemId, "executive", `[env-block] #${count} re-staged (cooldown ${cooldownMs}ms): ${error ?? ""}`); } catch {}
      return { retried: restaged !== null, escalated: false, restaged: true, attempt: item.attempts?.length ?? 0, faultClass: "environment", item: this.queue.getItem(itemId) ?? undefined };
    }

    const attempts = item.attempts ?? [];
    const attemptNumber = attempts.length + 1;

    // Determine ISC progress for this attempt
    const rows = this.loadISC(itemId);
    const iscRowsCompleted = rows?.filter(r => r.status === "DONE" || r.status === "VERIFIED").length ?? 0;
    const iscRowsTotal = rows?.length ?? 0;

    // Emit error trace — fail-open
    try { emitError(itemId, "executive", error ?? "Unknown error"); } catch {}

    // Record attempt — strategy is always "standard" (S4: retry-strategy ladder deleted)
    const attempt: WorkItemAttempt = {
      attemptNumber,
      startedAt: item.startedAt ?? new Date().toISOString(),
      endedAt: new Date().toISOString(),
      error: error ?? "Unknown error",
      strategy: "standard",
      iscRowsCompleted,
      iscRowsTotal,
    };

    // Choose next strategy based on attempt count
    if (attemptNumber >= 3) {
      // Escalate: create blocked proxy
      // Order matters for race safety: create proxy + wire dependency BEFORE
      // recordAttempt resets item to pending (visible to getReadyItems)
      const proxyTitle = `REVIEW: ${item.title} (${attemptNumber} failed attempts)`;
      const attemptSummary = [...attempts, attempt]
        .map(a => `  Attempt ${a.attemptNumber} (${a.strategy}): ${a.error}`)
        .join("\n");

      const proxy = this.queue.addItem({
        title: proxyTitle,
        description: `Review needed: ${item.title} failed ${attemptNumber} attempts`,
        status: "blocked",
        priority: item.priority ?? "normal",
        dependencies: [],
        source: "manual" as const,
        humanTaskRef: {
          queueItemId: itemId,
          guideFilePath: item.specPath || "",
          createdAt: new Date().toISOString(),
          attemptHistory: attemptSummary,
        },
      });

      // Wire dependency BEFORE recordAttempt — item must be blocked when it becomes pending
      this.queue.addDependency(itemId, proxy.id);

      // Surface in the "Kaya — Needs Jm" LucidTasks project so Jm sees it on the board
      await this.notificationDispatcher.createJmTask(itemId, item.title, `Failed ${attemptNumber} attempts. Review needed.\n${attemptSummary}`);

      // Now safe to record attempt (resets to pending, but dependency already blocks it)
      this.guard.logIndirectTransition(itemId, "in_progress", "pending",
        `Attempt ${attemptNumber}: strategy=${attempt.strategy}`);
      this.queue.recordAttempt(itemId, attempt);

      // Worktree persists across retries — only complete() and fail() clean up
      // S3b: surface the structured faultClass on the escalation return too.
      return { retried: true, escalated: true, attempt: attemptNumber, faultClass: effectiveFault, item: this.queue.getItem(itemId) ?? undefined };
    }

    // Record attempt and reset to pending
    this.guard.logIndirectTransition(itemId, "in_progress", "pending",
      `Attempt ${attemptNumber}: strategy=standard`);
    const updated = this.queue.recordAttempt(itemId, attempt);
    if (!updated) return { retried: false, escalated: false, attempt: attemptNumber };

    // Worktree persists across retries — only complete() and fail() clean up
    // S3b: surface the structured faultClass so callers (and the CLI/tests) see the classification.
    return { retried: true, escalated: false, attempt: attemptNumber, faultClass: effectiveFault, item: this.queue.getItem(itemId) ?? undefined };
  }

  /**
   * Write-back completion status to approved-work, approvals, and spec-pipeline
   * escalation task in TaskDB and syncs the source LucidTask to "completed".
   * Non-fatal: logs errors but never blocks the completion pipeline.
   */
  private async syncCompletionToApprovedWork(itemId: string): Promise<void> {
    await applyCompletionSideEffects(itemId);
  }

  /**
   * Init sweep: iterate all completed items and apply any outstanding side effects
   * (close still-open escalation tasks; sync still-pending source LucidTasks).
   * Catches items where per-item write-back was missed (process crash, etc.).
   * Idempotent + non-fatal — each call to applyCompletionSideEffects guards itself.
   * @internal exposed as _reconcileForTesting for unit tests
   */
  async _reconcileForTesting(): Promise<number> {
    return this.reconcileApprovedWork();
  }

  private async reconcileApprovedWork(): Promise<number> {
    try {
      const completedItems = this.queue.getAllItems().filter(i => i.status === "completed");
      for (const item of completedItems) {
        await applyCompletionSideEffects(item.id);
      }
      return completedItems.length;
    } catch (e) {
      console.error(`[WorkOrchestrator] reconcile sweep failed (non-fatal): ${e instanceof Error ? e.message : e}`);
      return 0;
    }
  }

  /**
   * Synchronous completion path for orphan recovery.
   * Runs the same gate checks as complete() but skips async worktree cleanup.
   */
  private completeSync(itemId: string, result?: string): { success: boolean; reason?: string } {
    const item = this.queue.getItem(itemId);
    if (!item) return { success: false, reason: `Not found: ${itemId}` };

    const rows = this.loadISC(itemId);
    const auditBase = { itemId, itemTitle: item.title, tiersExecuted: item.verification?.tiersExecuted ?? [], verificationCost: item.verification?.verificationCost ?? 0, iscRowSummary: rows?.map(r => `${r.id}:${r.status}`) ?? [] };

    // G1: Verified status
    if (!item.verification || item.verification.status !== "verified") {
      this.guard.appendAuditLog({ ...auditBase, verdict: "FAIL", concerns: ["completeSync G1: no passing verification"], failureReason: "G1" });
      return { success: false, reason: "No passing verification" };
    }

    // G2: Provenance — require skeptical_verifier for non-TRIVIAL
    const effort = item.effort || "STANDARD";
    if (effort !== "TRIVIAL" && item.verification.verifiedBy !== "skeptical_verifier") {
      this.guard.appendAuditLog({ ...auditBase, verdict: "FAIL", concerns: [`completeSync G2: verifiedBy is "${item.verification.verifiedBy}"`], failureReason: "G2" });
      return { success: false, reason: `verifiedBy is "${item.verification.verifiedBy}", not "skeptical_verifier"` };
    }

    // G3: Tier 1 execution — non-TRIVIAL must have run Tier 1
    if (effort !== "TRIVIAL") {
      if (!item.verification.tiersExecuted || !item.verification.tiersExecuted.includes(1)) {
        const reason = `Completion blocked: Tier 1 code checks did not execute. tiersExecuted: [${item.verification.tiersExecuted || []}]`;
        this.guard.appendAuditLog({ ...auditBase, verdict: "FAIL", concerns: [reason], failureReason: "G3" });
        return { success: false, reason };
      }
    }

    // G5: ISC all-VERIFIED (defense-in-depth)
    if (rows) {
      const unverified = rows.filter(r => r.status !== "VERIFIED");
      if (unverified.length > 0) {
        const reason = `${unverified.length} ISC rows not verified (completeSync check).`;
        this.guard.appendAuditLog({ ...auditBase, verdict: "FAIL", concerns: [reason], failureReason: "G5" });
        return { success: false, reason };
      }

      // (Former G6 category-coverage gate removed in S2: already unreachable — the G5
      // gate above requires every row VERIFIED.)

      // (Former G7 coverage gate removed — see complete(): the G5 gate above already
      // requires every row VERIFIED, making a verified/total < 80% check unreachable
      // once comprehension is the single ISC source.)
    }

    try {
      const updated = this.guard.updateStatus(itemId, "completed", result);
      if (!updated) return { success: false, reason: `Failed to update: ${itemId}` };

      // Write-back: sync completion to approved-work JSONL so QueueManager stays in sync
      // Fire-and-forget since completeSync is synchronous; reconcileApprovedWork in init catches misses
      this.syncCompletionToApprovedWork(itemId).catch(e => this.guard.logCaughtError(itemId, "syncCompletionToApprovedWork", e));

      return { success: true };
    } catch (e) {
      return { success: false, reason: e instanceof Error ? e.message : String(e) };
    }
  }

  // --------------------------------------------------------------------------
  // Verify: run verification commands (Gate 1 per-row command re-run)
  // --------------------------------------------------------------------------

  async verify(itemId: string): Promise<{ success: boolean; failures: ISCRow[]; skepticalReview?: SkepticalReviewResult }> {
    const item = this.queue.getItem(itemId);
    if (!item) return { success: false, failures: [{ id: -1, description: "Item not found", status: "EXECUTION_FAILED", infraFault: true, parallel: false }] };

    // Emit trace: verification-start
    try {
      emitTrace({
        source: "trace",
        category: "phase-transition",
        severity: "debug",
        workflowId: itemId,
        agentId: "executive",
        payload: { phase: "verification-start", title: item.title },
      });
    } catch { /* fail-open */ }

    // Circuit breaker (S5c): 3 CONSECUTIVE FAILs → skip verification, signal retry.
    // A plain consecutive-FAIL counter replaces the old JSON.stringify(concerns) content compare —
    // matching identical concern PROSE was a brittle determinism heuristic. Firing at 3 (not 2) is
    // more conservative: it tolerates one differing-but-still-failing run before short-circuiting.
    const verificationHistory = (item.metadata as WorkItemMetadata)?.verificationHistory as
      Array<{ verdict: string; concerns: string[] }> | undefined;
    if (verificationHistory && verificationHistory.length >= 3) {
      const last3 = verificationHistory.slice(-3);
      if (last3.every(v => v.verdict === "FAIL")) {
        return {
          success: false,
          failures: [{ id: -1, description: "Circuit breaker: 3 consecutive verification failures — skipping to retry", status: "EXECUTION_FAILED", parallel: false }],
        };
      }
    }

    const rows = this.loadISC(itemId);
    if (!rows) return { success: false, failures: [{ id: -1, description: "No ISC rows found — run prepare first", status: "EXECUTION_FAILED", infraFault: true, parallel: false }] };

    // Step 1: Run verification commands on ISC rows (local checks)
    // Sort smoke-priority rows first for fast-fail
    const sortedRows = [...rows].sort((a, b) => {
      const aPri = a.priority === "smoke" ? 0 : 1;
      const bPri = b.priority === "smoke" ? 0 : 1;
      return aPri - bPri;
    });

    // Resolve cwd from worktree > outputPath > projectPath > process.cwd()
    const verifyCtx = this.verifyCtxResolver.resolveVerifyContext(item);
    // primaryCwd is used for the summary workingDir and single-repo fallback
    const primaryCwd = verifyCtx.kind === "single" ? verifyCtx.cwd : verifyCtx.repos[0].cwd;
    const localFailures: ISCRow[] = [];
    let smokeCheckFailed = false;
    for (const row of sortedRows) {
      if (row.status === "DONE") {
        if (row.verification) {
          // Always re-run — never trust pre-set results
          // Returns true (pass), false (ran and failed), or null (no command — defer to Phase 2 judgment)
          // For multi-repo, resolve per-row cwd based on command path args
          const rowCwd = this.verifyCtxResolver.resolveRowCwd(row, verifyCtx);
          const localResult = this.commandRunner.runVerificationCommand(row, rowCwd);
          if (localResult === true) {
            row.verification.result = "PASS";
          } else if (localResult === false) {
            row.verification.result = "FAIL";
            localFailures.push(row);
            // Smoke fast-fail: if a smoke-priority row fails, skip remaining verification
            if (row.priority === "smoke") {
              smokeCheckFailed = true;
              break;
            }
          }
          // localResult === null: no parseable command — leave result unset, defer to SkepticalVerifier (Tier 2)
        } else {
          // DONE without verification object cannot auto-promote
          localFailures.push(row);
        }
      } else if (row.status === "VERIFIED") {
        // Already verified — honor
      } else if (row.status === "PENDING") {
        // PENDING rows are tolerated — they'll be handled as manual steps
        // by reportDone after verify passes (blocked transition)
      } else {
        // EXECUTION_FAILED — hard failures
        localFailures.push(row);
      }
    }

    // Local failures short-circuit before running SkepticalVerifier
    if (localFailures.length > 0) {
      return { success: false, failures: localFailures };
    }

    // Step 2: Build summary and run 2-phase skeptical review
    const gitDiffStat = this.verifyCtxResolver.getGitDiffStat(verifyCtx);
    const adversarialConcerns = item.metadata?.adversarialConcerns as string[] | undefined;
    const summary: ItemReviewSummary = {
      itemId,
      title: item.title,
      description: item.description,
      effort: item.effort || "STANDARD",
      priority: this.mapPriority(item.priority),
      specPath: item.specPath,
      specContent: item.specPath ? this.readSpecContent(item.specPath, itemId) : undefined,
      iscRows: rows.map(r => ({
        id: r.id,
        description: r.description,
        status: r.status,
        capability: r.capability,
        source: r.source,
        disposition: r.disposition,
        rowEvidence: r.evidence,
        verification: r.verification ? {
          method: r.verification.method,
          result: r.verification.result,
          commandRan: r.verification.result !== undefined,
        } : undefined,
      })),
      gitDiffStat,
      diffPathFilter: verifyCtx.kind === "single" ? verifyCtx.pathFilter : undefined,
      workingDir: primaryCwd,
      repoContexts: verifyCtx.kind === "multi"
        ? verifyCtx.repos.map(r => ({ name: r.name, cwd: r.cwd, startSha: r.startSha }))
        : undefined,
      executionLogTail: (item.metadata?.executionLog as string[] | undefined)?.slice(-20) ?? [],
      iterationsUsed: (item.attempts?.length ?? 0) + 1,
      adversarialConcerns: adversarialConcerns && adversarialConcerns.length > 0 ? adversarialConcerns : undefined,
      projectContext: primaryCwd ? this.verifyCtxResolver.detectProjectContext(primaryCwd) : undefined,
      testStrategyContent: item.testStrategyPath && existsSync(item.testStrategyPath)
        ? readFileSync(item.testStrategyPath, "utf-8").slice(0, 3000)
        : undefined,
    };

    // Populate testExecutionResults from item metadata (written by the Verifier
    // sub-agent before calling reportDone/verify) — this feeds Gate 1 (Tier 1
    // Check 17), the deterministic test-execution check.
    const itemEffort = item.effort || "STANDARD";
    if (itemEffort !== "TRIVIAL") {
      const metaTestResults = (item.metadata as WorkItemMetadata)?.testExecutionResults;
      if (metaTestResults) {
        summary.testExecutionResults = metaTestResults;
      }
    }

    // Phase L (live verification): MANDATORY for ALL effort tiers — including
    // TRIVIAL — and even without a worktree (fall back to the project path). An
    // independent Explorer agent actually runs the artifact; "no live evidence"
    // is a hard FAIL. Depth/time scale with effort via LIVE_BUDGETS.
    {
      const liveWorkingDir =
        ((item.metadata as WorkItemMetadata)?.worktreePath as string | undefined) ?? primaryCwd;
      if (liveWorkingDir) {
        // Surface for Phase L: producer classification, else the cached metadata
        // value, else a non-native default (the Explorer runs it generically — only
        // native matters, and that comes from the producer). ADR-0006 native lock.
        const liveSurface = (mapProducerSurface(item.surface) ??
          (item.metadata as WorkItemMetadata)?.workSurface ??
          "integration") as "browser" | "cli" | "api" | "integration" | "native";
        // Real, deterministic exercises for the non-dangerous self-verify harness
        // (used when the dangerous Explorer is classifier-blocked — Slice 1). These
        // are the item's own ISC verification commands: running them actually drives
        // the artifact. The Explorer path ignores this field.
        const selfVerifyCommands = rows
          .map((r) => r.verification?.command)
          .filter((c): c is string => typeof c === "string" && c.trim().length > 0);
        summary.liveVerificationInput = {
          itemId,
          surface: liveSurface,
          effort: itemEffort,
          workingDir: liveWorkingDir,
          specExcerpt: (summary.specContent ?? item.description ?? "").slice(0, 2000),
          diffPaths: _extractPathsFromDiffStat(summary.gitDiffStat),
          selfVerifyCommands,
        };
      }
      // Thread the builder's self-verification transcript (Step 1.5) into the
      // summary for Phase 2 context + the Tier 1 self-verification check.
      const builderTranscript = (item.metadata as WorkItemMetadata)?.liveVerificationTranscript;
      if (builderTranscript && builderTranscript.length > 0) {
        summary.liveVerificationTranscript = builderTranscript;
      }
    }

    const review = await this.verifier.review(summary);

    // Emit trace: verification-done
    try {
      emitTrace({
        source: "trace",
        category: "phase-transition",
        severity: "debug",
        workflowId: itemId,
        agentId: "executive",
        payload: {
          phase: "verification-done",
          verdict: review.finalVerdict,
          totalCost: review.totalCost,
        },
      });
    } catch { /* fail-open */ }

    // Count self-reported PASS rows (H7)
    const selfReportedCount = summary.iscRows.filter(
      r => r.verification?.result === "PASS" && !r.verification?.commandRan
    ).length;

    // Step 3: Process verdict
    if (review.finalVerdict === "PASS") {
      // Promote all DONE rows to VERIFIED
      for (const row of rows) {
        if (row.status === "DONE") {
          row.status = "VERIFIED";
        }
      }
      // Persist ISC rows with updated VERIFIED statuses
      this.iscManager.persist(itemId, rows);
      // Persist verification state via guard (validates invariants)
      const guardResult = this.guard.setVerification(itemId, {
        status: "verified",
        verifiedAt: new Date().toISOString(),
        verdict: "PASS",
        concerns: review.concerns,
        iscRowsVerified: rows.filter(r => r.status === "VERIFIED").length,
        iscRowsTotal: rows.length,
        verificationCost: review.totalCost,
        verifiedBy: "skeptical_verifier",
        tiersExecuted: review.tiers.map(t => t.tier),
      }, review, selfReportedCount);

      if (guardResult.downgraded) {
        // Guard downgraded the verdict — treat as failure
        // INVARIANT 1 (Phase 2 infra failure, confidence <= 0.3) = infrastructure fault
        // INVARIANT 2 (self-reported PASS without commands) = item fault
        const isInfraDowngrade = guardResult.reason?.includes("infra") || guardResult.reason?.includes("confidence");
        const failures: ISCRow[] = [{ id: -1, description: `Guard downgraded PASS: ${guardResult.reason}`, status: "EXECUTION_FAILED", infraFault: isInfraDowngrade, parallel: false }];
        return { success: false, failures, skepticalReview: review };
      }
      // Clear verification history on success — no stale failures carried forward.
      // Also reset the environment-block counter: a passing verification proves the
      // execution context CAN verify, so any prior environment blocks are resolved.
      this.queue.setMetadata(itemId, { verificationHistory: [], environmentBlockCount: 0 });
      return { success: true, failures: [], skepticalReview: review };
    }

    // NEEDS_REVIEW with infra failures: items stay needs_review for human review.
    // Promotion was removed — TransitionGuard INVARIANT 1 correctly blocks auto-promotion
    // when higher tiers had infrastructure failures.

    // FAIL or unpromotable NEEDS_REVIEW — persist failure state via guard
    this.guard.setVerification(itemId, {
      status: review.finalVerdict === "FAIL" ? "failed" : "needs_review",
      verifiedAt: new Date().toISOString(),
      verdict: review.finalVerdict,
      concerns: review.concerns,
      iscRowsVerified: rows.filter(r => r.status === "VERIFIED").length,
      iscRowsTotal: rows.length,
      verificationCost: review.totalCost,
      verifiedBy: "skeptical_verifier",
      tiersExecuted: review.tiers.map(t => t.tier),
    }, review, selfReportedCount);
    // Record verification outcome for circuit breaker
    const existingHistory = ((item.metadata as WorkItemMetadata)?.verificationHistory as
      Array<{ verdict: string; concerns: string[] }>) ?? [];
    existingHistory.push({ verdict: review.finalVerdict, concerns: review.concerns.slice(0, 5) });
    // Keep only last 3 entries to avoid unbounded growth
    const trimmedHistory = existingHistory.slice(-3);
    this.queue.setMetadata(itemId, { verificationHistory: trimmedHistory });

    const failures: ISCRow[] = [];
    for (const concern of review.concerns) {
      failures.push({ id: -1, description: `Skeptical review: ${concern}`, status: "EXECUTION_FAILED", parallel: false });
    }
    return { success: false, failures, skepticalReview: review };
  }

  // --------------------------------------------------------------------------
  // Status
  // --------------------------------------------------------------------------

  status(): string {
    return statusReport(this.queue);
  }

  // --------------------------------------------------------------------------
  // Report: structured output binding narrative to programmatic state
  // --------------------------------------------------------------------------

  report(): WorkReport {
    return categorizeReport(this.queue);
  }

  reportMarkdown(): string {
    return reportMarkdownFn(this.report(), (id) => this.loadISC(id));
  }

  // --------------------------------------------------------------------------
  // Catastrophic action detection
  // --------------------------------------------------------------------------

  isCatastrophic(command: string): { blocked: boolean; action?: CatastrophicAction; reason?: string } {
    return isCatastrophicCmd(command);
  }

  isProtectedBranch(branch: string): boolean {
    return isProtectedBranchName(branch);
  }

  // --------------------------------------------------------------------------
  // Feature branch creation
  // --------------------------------------------------------------------------

  async ensureFeatureBranch(itemId: string): Promise<{ branch: string; workingDir: string }> {
    return ensureFeatureBranchFn(this.queue, (id, loc, e) => this.guard.logCaughtError(id, loc, e), itemId);
  }

  /**
   * Resolve the git repo root for worktree creation. Delegates to WorktreeOps.ts —
   * see that module for the resolution-order doc comment.
   */
  private resolveRepoRoot(item: WorkItem | undefined): string {
    return resolveRepoRootFn(this.queue, item);
  }

  /** Check if a path is a git repo different from Kaya. Returns repo root or null. */
  private tryResolveGitRoot(candidatePath: string | undefined | null): string | null {
    return tryResolveGitRootFn(candidatePath);
  }

  // --------------------------------------------------------------------------
  // Worktree cleanup
  // --------------------------------------------------------------------------

  private async cleanupWorktree(itemId: string): Promise<void> {
    return cleanupWorktreeFn(this.queue, (id, loc, e) => this.guard.logCaughtError(id, loc, e), itemId);
  }

  // --------------------------------------------------------------------------
  // Prior work summary
  // --------------------------------------------------------------------------

  generatePriorWorkSummary(completedItemIds: string[]): string {
    return generatePriorWorkSummaryFn(completedItemIds, (id) => this.loadISC(id));
  }

  // parseVerificationCommand, runVerificationCommand → CommandRunner
  // getGitDiffStat, resolveVerifyContext, resolveRowCwd, detectProjectContext → VerifyContextResolver
  parseVerificationCommand(command: string): { exe: string; args: string[] } | null {
    return this.commandRunner.parseVerificationCommand(command);
  }

  getGitDiffStat(verifyCtx: VerifyContext): string {
    return this.verifyCtxResolver.getGitDiffStat(verifyCtx);
  }

  resolveVerifyContext(item: WorkItem): VerifyContext {
    return this.verifyCtxResolver.resolveVerifyContext(item);
  }

  resolveRowCwd(row: ISCRow, verifyCtx: VerifyContext): string {
    return this.verifyCtxResolver.resolveRowCwd(row, verifyCtx);
  }

  private classifyRowDisposition(description: string): ISCRowDisposition {
    return this.iscManager.classifyDisposition({ id: 0, description, status: "PENDING", parallel: false });
  }

  private mapPriority(priority: Priority): ItemReviewSummary["priority"] {
    switch (priority) {
      case "critical":
      case "high": return "HIGH";
      case "normal": return "MEDIUM";
      case "low": return "LOW";
    }
  }

  /**
   * Resolve stale REVIEW proxy dependencies after an item passes SkepticalVerifier.
   * When retry() escalates after 3 failures, it creates a REVIEW proxy and wires it
   * as a dependency. If the item later self-heals and passes report-done, the proxy
   * stays blocked — permanently DAG-blocking the real item. This method auto-resolves
   * those proxies so the real item can complete.
   */
  private resolveStaleReviewProxies(itemId: string): void {
    const item = this.queue.getItem(itemId);
    if (!item) return;

    const allItems = this.queue.getAllItems();
    const reviewProxies = allItems.filter(
      (i) =>
        i.title.startsWith("REVIEW: ") &&
        i.humanTaskRef?.queueItemId === itemId &&
        i.status !== "completed"
    );

    for (const proxy of reviewProxies) {
      try {
        // Set TRIVIAL effort via proper setter to bypass provenance gate
        this.queue.setEffort(proxy.id, "TRIVIAL");
        // Use "human_proxy" — these are proxy items with humanTaskRef, accepted by provenance guard
        this.queue.setVerification(proxy.id, {
          status: "verified",
          verdict: "PASS",
          verifiedBy: "human_proxy",
          verifiedAt: new Date().toISOString(),
          concerns: ["Parent item passed SkepticalVerifier — proxy auto-resolved"],
          iscRowsVerified: 0,
          iscRowsTotal: 0,
          verificationCost: 0,
          tiersExecuted: [],
        });
        this.queue.updateStatus(proxy.id, "completed");

        // Remove proxy from item's dependency list via proper setter
        this.queue.removeDependency(itemId, proxy.id);
      } catch (e) {
        // Non-fatal — log but don't block report-done
        console.warn(`[resolveStaleReviewProxies] Failed to resolve proxy ${proxy.id}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  private readSpecContent(specPath: string, itemId?: string): string | undefined {
    try {
      return readFileSync(specPath, "utf-8");
    } catch {
      // Try fallback paths for moved specs (e.g., MEMORY/specs/ → plans/Specs/)
      const fallbacks = [
        specPath.replace("MEMORY/specs/", "plans/Specs/"),
        join(KAYA_HOME, "plans/Specs", specPath.split("/").pop() || ""),
      ];
      for (const fb of fallbacks) {
        try {
          const content = readFileSync(fb, "utf-8");
          // Auto-fix the stale path for future lookups
          if (itemId) {
            this.queue.setSpecPath(itemId, fb);
          }
          return content;
        } catch { /* try next */ }
      }
      return undefined;
    }
  }

  /**
   * Format ISC rows as a markdown table with Verification Command column for agent consumption.
   * Optionally filter by phase row IDs.
   */
  formatISCTableForAgents(itemId: string, phaseRowIds?: number[]): string {
    return formatISCTableForAgentsFn((id) => this.loadISC(id), itemId, phaseRowIds);
  }

  // --------------------------------------------------------------------------
  // Phase-aware helpers
  // --------------------------------------------------------------------------

  // ---- Phase live gate -------------------------------------------------------

  /**
   * Per-phase hard gate (Phase 6: Gate 1, deterministic — no RuntimeVerifier).
   * See lib/orchestrator/Verification.ts's verifyPhase for the full doc comment.
   */
  async verifyPhase(
    itemId: string,
    phaseNumber: number,
    opts: {
      iscRowIds: number[];
      worktreePath: string | undefined;
      workSurface: "browser" | "cli" | "api" | "integration" | "native";
      specPath: string | undefined;
    },
  ): Promise<{ phaseNumber: number; passed: boolean; evidence: string; humanVerificationRequired: boolean }> {
    return verifyPhaseFn(
      {
        queue: this.queue,
        iscManager: this.iscManager,
        commandRunner: this.commandRunner,
        markRowsHumanRequired: (id, rowIds) => this.markRowsHumanRequired(id, rowIds),
      },
      itemId,
      phaseNumber,
      opts,
    );
  }

  /**
   * Disposition the given ISC rows `human-required` (ADR-0006). Used by the
   * native per-phase gate: native UI verification can't be automated in this
   * environment, so these rows are routed to a human/device check via
   * CompletionPipeline rather than being silently auto-DONE. Idempotent.
   */
  private markRowsHumanRequired(itemId: string, rowIds: number[]): void {
    markRowsHumanRequiredFn(this.iscManager, itemId, rowIds);
  }

  // ---- Mark phase done ------------------------------------------------------

  /**
   * Mark a phase as done. Appends to completedPhases (idempotent), calls markPartial.
   */
  markPhaseDone(itemId: string, phaseNumber: number, totalPhases: number): boolean {
    return markPhaseDoneFn(this.queue, itemId, phaseNumber, totalPhases);
  }

  /**
   * Get ISC rows for a specific phase (filtered by row IDs).
   * Used by Orchestrate.md to build per-phase ISC tables.
   */
  getPhaseISC(itemId: string, phaseRowIds: number[]): ISCRow[] {
    return getPhaseISCFn((id) => this.loadISC(id), itemId, phaseRowIds);
  }

  /**
   * Generate a git summary of prior work in an item's worktree (for PRIOR_WORK context).
   */
  generatePhaseGitSummary(itemId: string): string {
    return generatePhaseGitSummaryFn(this.queue, itemId, (id, location, e) => this.guard.logCaughtError(id, location, e));
  }

  // --------------------------------------------------------------------------
  // ISC persistence (ISC 5+11: delegates to ISCManager)
  //
  // Note: this is the orchestrator's private empty-coercion helper — it returns
  // `undefined` for empty rows where `iscManager.load` returns `[]`. Internal
  // callers depend on the `undefined`-as-empty signal to short-circuit downstream
  // logic. External callers should use `iscManager.load` directly.
  // --------------------------------------------------------------------------

  private loadISC(itemId: string): ISCRow[] | undefined {
    // ISC 11: load() has no side effects — no backfill on every read
    const rows = this.iscManager.load(itemId);
    if (rows.length === 0) return undefined;
    return rows;
  }

  // --------------------------------------------------------------------------
  // Orphan recovery
  // --------------------------------------------------------------------------

  async recoverOrphanedItems(): Promise<number> {
    // ISC 605: Delegate to extracted OrphanRecovery module
    return recoverOrphanedItemsFn({
      queue: this.queue,
      iscManager: this.iscManager,
      guard: this.guard,
      notifier: this.notificationDispatcher,
      completeSync: this.completeSync.bind(this),
      retry: this.retry.bind(this),
    });
  }

  // --------------------------------------------------------------------------
  // CLI helpers (public delegations for WorkOrchestratorCLI.ts)
  // --------------------------------------------------------------------------

  /** Returns all items in the work queue (for CLI self-heal init logic). */
  getAllQueueItems() { return this.queue.getAllItems(); }

  /**
   * Resume a directly-blocked REAL item to `pending` once its human PREREQUISITE
   * is satisfied, and close the matching `manual-${id}` escalation LucidTask.
   *
   * This is the recovery path for items stranded by the legacy whole-item
   * escalation (status=blocked, no top-level humanTaskRef) — resolveBlocked()
   * would falsely COMPLETE them. The re-pended item is picked up by the next
   * next-batch and actually built. LucidTask close is best-effort/non-fatal.
   */
  async resumeBlocked(itemId: string, reason: string): Promise<WorkItem | null> {
    const resumed = this.queue.resumeBlocked(itemId, reason);
    if (!resumed) return null;
    try {
      // cross-skill-allowed: Lane-A escalation writes LucidTasks tasks by design (07-02 overhaul) — closes the manual-${id} escalation task once the human prerequisite resolves; seam candidate: TaskClient
      const { getTaskDB } = await import("../../../Productivity/LucidTasks/Tools/TaskDB.ts");
      const db = getTaskDB();
      const escTask = db.getTask(`manual-${itemId}`);
      if (escTask && escTask.status !== "done" && escTask.status !== "cancelled") {
        db.updateTask(`manual-${itemId}`, { status: "done" }, "WorkOrchestrator/resumeBlocked");
      }
    } catch (e) {
      this.guard.logCaughtError(itemId, "resumeBlocked/closeEscalation", e);
    }
    return resumed;
  }
}

// ============================================================================
// CLI — extracted to WorkOrchestratorCLI.ts
// ============================================================================

// CATASTROPHIC_PATTERNS and PROTECTED_BRANCHES are re-exported above from VerificationUtils.ts
export { ITERATION_LIMITS, PHASE_MIN_ISC_THRESHOLD, PHASE_MIN_PHASES };

/**
 * Entry guard: when WorkOrchestrator.ts is run directly as a CLI script,
 * delegate to WorkOrchestratorCLI.ts main() function.
 * Import is lazy (inside the guard) to avoid circular module loads at import time.
 *
 * Usage:
 *   bun skills/Automation/AutonomousWork/Tools/WorkOrchestrator.ts next-batch
 * is equivalent to:
 *   bun skills/Automation/AutonomousWork/Tools/WorkOrchestratorCLI.ts next-batch
 */
if (import.meta.main) {
  const { main: runCLI } = await import("./WorkOrchestratorCLI.ts");
  await runCLI();
}
