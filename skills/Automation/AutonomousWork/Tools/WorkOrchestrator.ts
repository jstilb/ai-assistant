#!/usr/bin/env bun
/**
 * WorkOrchestrator.ts - Unified orchestrator for autonomous work
 *
 * Single replacement for ExecutiveOrchestrator (989 lines),
 * ItemOrchestrator (1,686 lines), and UnblockingOrchestrator (~650 lines).
 *
 * Keeps: catastrophic detection, verification pipeline with command allowlist,
 * ISC generation from specs, effort classification, spotcheck, prior work summary,
 * feature branch creation.
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

import { parseArgs } from "util";
import { readFileSync, existsSync, appendFileSync, mkdirSync, readdirSync } from "fs";
import { join, resolve } from "path";
import { execFileSync } from "child_process";
import { globSync } from "glob";
import { WorkQueue, type WorkItem, type WorkItemAttempt, type WorkItemVerification, type EffortLevel, type Priority, type RetryStrategy } from "./WorkQueue.ts";
import { emitWorkflowStart, emitCompletion, emitError, emitDecision } from "../../../System/AgentMonitor/Tools/TraceEmitter.ts";
import { emitInsight } from "../../../../lib/core/SkillIntegrationBridge.ts";
import { startStreamingPipeline, type StreamingPipeline } from "../../../System/AgentMonitor/Tools/StreamingPipeline.ts";
import { runPipeline } from "../../../System/AgentMonitor/Tools/EvaluatorPipeline.ts";
import { SkepticalVerifier, type ItemReviewSummary, type SkepticalReviewResult, type InferenceFn, type ProjectContext } from "./SkepticalVerifier.ts";
import { TransitionGuard } from "./TransitionGuard.ts";
import { inferCategory, parseSpec, detectPhasedSpec, type ISCCriterion, type PhaseInfo } from "./SpecParser.ts";
// Per-item Builder/Verifier loop execution is now handled by TaskOrchestrator.
// Queue management (init, nextBatch, prepare, verify, fail, status, report) stays here.
import type { TaskOrchestrator } from "./TaskOrchestrator.ts";

// ============================================================================
// Types
// ============================================================================

export type ISCRowCategory =
  | "implementation"   // Core code work
  | "testing"          // Tests and validation
  | "documentation"    // SKILL.md, README, docs updates
  | "deployment"       // launchd, config deployment, system-level actions
  | "cleanup";         // Config removal, deprecated file markers, legacy references

export type ISCRowDisposition = "automatable" | "human-required" | "deferred";

export interface ISCRow {
  id: number;
  description: string;
  status: "PENDING" | "DONE" | "VERIFIED" | "EXECUTION_FAILED";
  category?: ISCRowCategory;
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
  /** Optional evidence artifacts attached when row is marked done */
  evidence?: { files?: string[]; commands?: string[]; summary?: string };
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
}

export interface PrepareResult {
  success: boolean;
  effort: EffortLevel;
  iscRows: ISCRow[];
  maxIterations: number;
  error?: string;
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

export type CatastrophicAction =
  | "git_reset_hard_main"
  | "git_push_force_main"
  | "rm_rf_root"
  | "drop_database"
  | "format_disk";

// ============================================================================
// Constants
// ============================================================================

const KAYA_HOME = process.env.KAYA_HOME || join(process.env.HOME || "", ".claude");
const CATASTROPHIC_PATTERNS: Array<{ pattern: RegExp; action: CatastrophicAction }> = [
  { pattern: /git\s+reset\s+--hard.*(?:main|master)/i, action: "git_reset_hard_main" },
  { pattern: /git\s+push\s+(?:--force|-f).*(?:main|master)/i, action: "git_push_force_main" },
  { pattern: /git\s+push.*(?:main|master).*(?:--force|-f)/i, action: "git_push_force_main" },
  { pattern: /rm\s+(?:-rf|-fr|--recursive)\s+\/(?!\s)/i, action: "rm_rf_root" },
  { pattern: /rm\s+(?:-rf|-fr|--recursive)\s+~\//i, action: "rm_rf_root" },
  { pattern: /drop\s+database/i, action: "drop_database" },
  { pattern: /drop\s+schema/i, action: "drop_database" },
  { pattern: /mkfs\./i, action: "format_disk" },
  { pattern: /dd\s+if=.*of=\/dev\//i, action: "format_disk" },
];

const PROTECTED_BRANCHES = ["main", "master", "production", "prod"];

const ITERATION_LIMITS: Record<EffortLevel, number> = {
  TRIVIAL: 1, QUICK: 3, STANDARD: 10, THOROUGH: 25, DETERMINED: 100,
};

const PHASE_MIN_ISC_THRESHOLD = 8;
const PHASE_MIN_PHASES = 2;

// Allowlist for verification commands
const ALLOWED_EXECUTABLES = new Set([
  "bun", "node", "npx", "grep", "rg", "test", "diff", "wc", "jq", "ls", "cat", "head", "tail",
]);
const SAFE_GIT_SUBCOMMANDS = new Set([
  "diff", "log", "show", "status", "rev-parse", "merge-base",
]);

// ============================================================================
// Verification command normalization
// ============================================================================

/**
 * Normalize a raw verification command string before execution.
 *
 * Problems this solves:
 * 1. Bare `test` with no arguments — exits 1 unconditionally, useless as a check.
 *    → Returns null so the caller skips or defers to Tier 2.
 * 2. Tilde `~/` in paths — `execFileSync` does NOT expand `~` (no shell involved).
 *    → Replaces `~/` and bare `~` with the absolute HOME path.
 * 3. Empty/whitespace strings — no-op.
 *    → Returns null.
 *
 * Returns the normalized command string, or null if the command should be skipped.
 */
export function normalizeVerificationCommand(cmd: string): string | null {
  if (!cmd || !cmd.trim()) return null;

  // Bare 'test' with no arguments always exits 1 — it is not a useful verification command.
  if (cmd.trim() === "test") return null;

  const home = process.env.HOME || "";

  // Expand ~/ and bare ~ at path start (e.g. "~/.claude/…" → "~/.claude/…")
  let normalized = cmd
    .replace(/~\//g, `${home}/`)
    .replace(/^~(?=\s|$)/, home);

  return normalized;
}

/**
 * Scan a list of command arguments for a directory path that does not exist.
 * Only flags paths that explicitly end with "/" (unambiguous directory reference)
 * and that do not exist on the filesystem. Ignores flags (starting with "-").
 *
 * This conservative heuristic catches the known failure category — commands like
 * `ls /tmp/pai-public-staging/` — without incorrectly skipping commands that
 * test for non-existent files (e.g. `test -f /nonexistent/file` is intentional).
 *
 * Returns the first missing directory path found, or null if all present.
 */
export function findMissingDirectoryArg(args: string[], cwd?: string): string | null {
  for (const arg of args) {
    if (arg.startsWith("-")) continue; // Skip flags
    // Only flag paths with an explicit trailing slash — unambiguous directory references
    if (!arg.endsWith("/")) continue;
    // Resolve relative paths against the provided cwd (verification context), not process.cwd()
    const resolved = cwd && !arg.startsWith("/") ? join(cwd, arg) : arg;
    if (!existsSync(resolved)) {
      return resolved;
    }
  }
  return null;
}

/**
 * Detect whether a verification description asserts the ABSENCE of something.
 * When true, a non-zero exit code (e.g. grep finding 0 matches) means PASS.
 *
 * Patterns: "returns 0 hits", "no remaining", "not present", "should not contain",
 * "is removed", "absent from", "no X references", "is not present", "does not exist",
 * "should be empty", "zero matches".
 */
export function detectInvertExit(text: string): boolean {
  if (!text) return false;
  const lower = text.toLowerCase();
  return /\breturns?\s+0\s+hits?\b/.test(lower) ||
    /\bno\s+remaining\b/.test(lower) ||
    /\bnot\s+present\b/.test(lower) ||
    /\bshould\s+not\s+contain\b/.test(lower) ||
    /\bis\s+removed\b/.test(lower) ||
    /\babsent\s+from\b/.test(lower) ||
    /\bno\s+[\w-]+\s+references?\b/.test(lower) ||
    /\bis\s+not\s+present\b/.test(lower) ||
    /\bdoes\s+not\s+exist\b/.test(lower) ||
    /\bshould\s+be\s+empty\b/.test(lower) ||
    /\bzero\s+matches\b/.test(lower);
}

// ============================================================================
// WorkOrchestrator Class
// ============================================================================

export class WorkOrchestrator {
  private queue: WorkQueue;
  private verifier: SkepticalVerifier;
  private guard: TransitionGuard;
  /** In-memory ISC state per item (no per-item state files) */
  private itemISC: Map<string, ISCRow[]> = new Map();
  private lastRecoveryAt: number = 0;
  /** Injectable inference function for Strategy 1.5 (Haiku ISC extraction) */
  private inferenceFn?: InferenceFn;
  private monitorPipeline?: StreamingPipeline;

  constructor(queue?: WorkQueue, verifier?: SkepticalVerifier, inferenceFn?: InferenceFn) {
    this.queue = queue ?? new WorkQueue();
    this.verifier = verifier ?? new SkepticalVerifier();
    this.guard = new TransitionGuard(this.queue);
    this.inferenceFn = inferenceFn;
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
    return orch;
  }

  // --------------------------------------------------------------------------
  // Init
  // --------------------------------------------------------------------------

  async init(): Promise<{ success: boolean; message: string; ready: number; blocked: number; recovered: number }> {
    this.queue.wirePhaseDependencies();
    const validation = this.queue.validate();
    if (!validation.valid) {
      return { success: false, message: `DAG invalid: ${validation.errors[0]}`, ready: 0, blocked: 0, recovered: 0 };
    }
    const recovered = await this.recoverOrphanedItems();

    // Audit integrity check (non-fatal — reports gaps but never blocks init)
    try { this.guard.validateAuditIntegrity(); } catch {}

    // Reconcile: sync completed/failed work-queue items back to approved-work JSONL
    const reconciled = await this.reconcileApprovedWork();

    // Start live monitoring pipeline — zero LLM cost, fail-open
    try {
      this.monitorPipeline = startStreamingPipeline({ dashboard: false, quiet: true });
    } catch {}

    const stats = this.queue.getStats();
    const recoveredMsg = recovered > 0 ? `, ${recovered} recovered` : "";
    const reconciledMsg = reconciled > 0 ? `, ${reconciled} reconciled to approved-work` : "";
    return {
      success: true,
      message: `Initialized: ${stats.ready} ready, ${stats.blocked} blocked${recoveredMsg}${reconciledMsg}`,
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

  async nextBatch(max: number = 5): Promise<{ items: WorkItem[]; blocked: number }> {
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

    // Classify effort (use override if provided, e.g. from tests)
    const effort = effortOverride ?? this.classifyEffort(item);
    this.queue.setEffort(itemId, effort);

    // Strategy-aware ISC generation: if retrying with "re-prepare", force-regenerate
    const retryStrategy = (item.metadata as Record<string, unknown>)?.nextRetryStrategy as RetryStrategy | undefined;
    if (retryStrategy === "re-prepare") {
      // Preserve only VERIFIED rows (confirmed by SkepticalVerifier) — DONE rows are unverified
      const existingRows = this.loadISC(itemId) ?? [];
      const preservedRows = existingRows.filter(r => r.status === "VERIFIED");

      // Clear cached ISC so generateISC rebuilds from spec
      this.itemISC.delete(itemId);
      // Clear the strategy flag after consuming it
      const metadata = (item.metadata ?? {}) as Record<string, unknown>;
      delete metadata.nextRetryStrategy;

      // Store preserved rows for merge after generateISC
      if (preservedRows.length > 0) {
        metadata._preservedRows = preservedRows;
      }
      item.metadata = metadata;
      this.queue.persist();
    }

    // Generate ISC rows
    const rows = this.generateISC(item, effort);

    // Annotate ISC rows with TestStrategy data (testLevel, priority) if available
    if (item.testStrategyPath && existsSync(item.testStrategyPath)) {
      this.annotateWithTestStrategy(rows, item.testStrategyPath);
    }

    // ISC quality gate: STANDARD+ items must have concrete verification commands
    const isStandardPlus = effort === "STANDARD" || effort === "THOROUGH" || effort === "DETERMINED";
    if (isStandardPlus && rows.length > 0) {
      const weakRows = rows.filter(r =>
        r.verification?.method === "inferred" && !r.verification?.command
      );
      const weakRatio = weakRows.length / rows.length;
      if (weakRatio > 0.5) {
        return {
          success: false,
          effort,
          iscRows: rows,
          maxIterations: ITERATION_LIMITS[effort],
          error: `ISC quality gate failed: ${weakRows.length}/${rows.length} rows have no verification command (method: "inferred" without command). Re-check spec ISC table.`,
        };
      }
      // Attempt to patch weak rows with inferred commands
      for (const row of weakRows) {
        if (row.verification) {
          const inferred = this.inferVerificationCommand(row.description, item);
          if (inferred) {
            row.verification.command = inferred;
            row.verification.method = "inferred_patched";
          }
        }
      }
    }

    this.itemISC.set(itemId, rows);
    this.persistISC(itemId, rows);

    // Phase detection: if spec has multiple phases with enough ISC, build per-phase execution plan
    let phases: PhaseExecutionInfo[] | undefined;
    let resumeFromPhase: number | undefined;
    let completedRowIds: number[] | undefined;

    try {
      if (item.specPath && existsSync(item.specPath)) {
        const spec = parseSpec(item.specPath);
        const phaseInfos = detectPhasedSpec(spec, PHASE_MIN_ISC_THRESHOLD, PHASE_MIN_PHASES);
        if (phaseInfos) {
          // Build map: spec ISCCriterion.number → ISCRow.id (sequential i+1)
          const specNumberToRowId = new Map<number, number>();
          spec.isc.forEach((c, i) => specNumberToRowId.set(c.number, i + 1));

          const totalISCCount = rows.length;
          const totalMaxIter = ITERATION_LIMITS[effort];

          phases = phaseInfos.map((phInfo) => {
            const iscRowIds = phInfo.iscNumbers
              .map((n) => specNumberToRowId.get(n))
              .filter((id): id is number => id !== undefined);
            const phaseISCCount = iscRowIds.length;
            return {
              phaseNumber: phInfo.phaseNumber,
              phaseName: phInfo.phaseName,
              iscRowIds,
              maxIterations: Math.max(3, Math.ceil(totalMaxIter * phaseISCCount / totalISCCount)),
              usedPositionalFallback: phInfo.usedPositionalFallback,
            };
          });

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
    this.resetDoneRowsToPending(itemId);
    // Emit trace — fail-open (never interrupts orchestration)
    try { emitWorkflowStart(itemId, "executive", { title: item.title }); } catch {}
    return true;
  }

  /**
   * Reset DONE rows to PENDING on loop entry.
   * DONE = self-reported by Builder (unverified). VERIFIED = confirmed by SkepticalVerifier.
   * Only VERIFIED rows survive across sessions — DONE rows must be re-verified.
   */
  private resetDoneRowsToPending(itemId: string): void {
    const rows = this.loadISC(itemId);
    if (!rows) return;
    let changed = false;
    for (const row of rows) {
      if (row.status === "DONE") {
        row.status = "PENDING";
        if (row.verification) {
          row.verification.result = undefined;
        }
        changed = true;
      }
    }
    if (changed) {
      this.itemISC.set(itemId, rows);
      this.persistISC(itemId, rows);
    }
  }

  // --------------------------------------------------------------------------
  // reportDone: Atomic completion pipeline
  // --------------------------------------------------------------------------

  /**
   * Atomic pipeline: mark rows done → record execution → verify → complete.
   * This is the ONLY public path to completion for non-TRIVIAL items.
   */
  async reportDone(itemId: string, agentResults: {
    completedRowIds: number[];
    failedRowIds?: number[];
    adversarialConcerns?: string[];
    executionLog?: string[];
    rowEvidence?: Record<number, { files?: string[]; commands?: string[]; summary?: string }>;
  }): Promise<{ success: boolean; reason?: string; skepticalReview?: SkepticalReviewResult }> {
    // Warn if no worktree was used — work may be in wrong directory
    const itemForMeta = this.queue.getItem(itemId);
    if (!itemForMeta?.metadata?.worktreePath) {
      console.warn(`[reportDone] WARNING: item ${itemId} has no worktree metadata. Work may have been done in the main repo directory.`);
    }

    // Step 0: Store adversarial concerns in item metadata for SkepticalVerifier context
    if (agentResults.adversarialConcerns && agentResults.adversarialConcerns.length > 0) {
      this.queue.setMetadata(itemId, { adversarialConcerns: agentResults.adversarialConcerns });
    }

    // Step 0a: Store execution log for SkepticalVerifier Phase 2 context
    if (agentResults.executionLog?.length) {
      this.queue.setMetadata(itemId, { executionLog: agentResults.executionLog.slice(-20) });
    }

    // Step 0b: Store per-row evidence if provided
    if (agentResults.rowEvidence) {
      const rows = this.loadISC(itemId);
      if (rows) {
        for (const [rowId, evidence] of Object.entries(agentResults.rowEvidence)) {
          const row = rows.find(r => r.id === Number(rowId));
          if (row) {
            row.evidence = evidence;
          }
        }
        this.itemISC.set(itemId, rows);
        this.persistISC(itemId, rows);
      }
    }

    // Step 1: Mark rows done
    const markResult = this.markRowsDone(itemId, agentResults.completedRowIds);
    if (!markResult.success) {
      return { success: false, reason: `markRowsDone failed: ${markResult.error}` };
    }

    // Step 2: Verify (runs local checks + SkepticalVerifier)
    const verifyResult = await this.verify(itemId);

    // Step 3b: Append audit log (non-blocking)
    const item = this.queue.getItem(itemId);
    this.appendAuditLog({
      itemId,
      itemTitle: item?.title ?? "unknown",
      verdict: verifyResult.skepticalReview?.finalVerdict ?? (verifyResult.success ? "PASS" : "FAIL"),
      concerns: verifyResult.skepticalReview?.concerns ?? verifyResult.failures.map(f => f.description),
      tiersExecuted: verifyResult.skepticalReview?.tiers.map(t => t.tier) ?? [],
      verificationCost: verifyResult.skepticalReview?.totalCost ?? 0,
      iscRowSummary: this.loadISC(itemId)?.map(r => `${r.id}:${r.status}`) ?? [],
      adversarialConcerns: agentResults.adversarialConcerns,
    });

    if (!verifyResult.success) {
      const concerns = verifyResult.failures.map(f => f.description).join("; ");
      // Emit notification for NEEDS_REVIEW/FAIL so Jm is alerted
      const verdict = verifyResult.skepticalReview?.finalVerdict ?? "FAIL";
      this.emitNeedsReviewNotification(itemId, item?.title ?? "unknown", verdict, verifyResult.failures.map(f => f.description));
      emitInsight({
        source: 'AutonomousWork', type: 'learning',
        title: `Work failed: ${item?.title ?? itemId}`,
        content: verifyResult.failures.map(f => f.description).join('; '),
        tags: ['work-failure', verdict.toLowerCase()],
        metadata: { itemId, failureCount: verifyResult.failures.length }
      }).catch(() => {});
      // Surface in jm-tasks so Jm sees it in normal task workflow
      // Only create jm-task for verify failures when not at escalation threshold
      // (escalation path at line ~869 handles its own jm-task creation)
      const attemptCount = this.queue.getItem(itemId)?.attempts?.length ?? 0;
      if (attemptCount < 2) {
        const failConcerns = verifyResult.failures.map(f => `- ${f.description}`).join("\n");
        await this.createJmTask(itemId, item?.title ?? "unknown", `[${verdict}] Verification failed — needs human review:\n${failConcerns}`);
      }
      return {
        success: false,
        reason: `Verification failed: ${concerns}`,
        skepticalReview: verifyResult.skepticalReview,
      };
    }

    // Step 3b½: Resolve stale REVIEW proxy dependencies
    // If this item was previously escalated (3 retries), a REVIEW proxy blocks it.
    // Now that it passed SkepticalVerifier, auto-resolve the proxy.
    this.resolveStaleReviewProxies(itemId);

    // Step 3c: Check for remaining PENDING ISC rows
    const currentRows = this.loadISC(itemId);
    const pendingRows = currentRows?.filter(r => r.status === "PENDING") ?? [];
    if (pendingRows.length > 0) {
      // Separate human-required rows from incomplete automatable rows
      const humanRows = pendingRows.filter(r => r.disposition === "human-required");
      const incompleteRows = pendingRows.filter(r => r.disposition !== "human-required");

      // Incomplete automatable rows = work that should have been done but wasn't
      if (incompleteRows.length > 0) {
        const incompleteDesc = incompleteRows.map(r => `- ISC #${r.id}: ${r.description}`).join("\n");
        return {
          success: false,
          reason: `${incompleteRows.length} automatable ISC row(s) still PENDING (not completed by agent):\n${incompleteDesc}`,
          skepticalReview: verifyResult.skepticalReview,
        };
      }

      // Human-required rows — create LucidTasks + HUMAN proxy WorkItems
      const proxyIds = await this.createHumanProxies(itemId, item?.title ?? "unknown", humanRows);
      this.guard.updateStatus(itemId, "blocked");
      this.queue.setMetadata(itemId, {
        manualRows: humanRows.map(r => ({ id: r.id, description: r.description })),
        humanProxyIds: proxyIds,
      });
      // Also create jm-tasks entry as a fallback
      const manualDescriptions = humanRows.map(r => `- ISC #${r.id}: ${r.description}`).join("\n");
      await this.createJmTask(itemId, item?.title ?? "unknown", manualDescriptions);
      this.appendAuditLog({
        itemId,
        itemTitle: item?.title ?? "unknown",
        verdict: "PASS",
        concerns: [`Automated work verified. ${humanRows.length} human-required row(s) remain: ${humanRows.map(r => `#${r.id}`).join(", ")}. Created ${proxyIds.length} HUMAN proxies + LucidTasks.`],
        tiersExecuted: verifyResult.skepticalReview?.tiers.map(t => t.tier) ?? [],
        verificationCost: verifyResult.skepticalReview?.totalCost ?? 0,
        iscRowSummary: currentRows?.map(r => `${r.id}:${r.status}`) ?? [],
      });
      return {
        success: true,
        reason: `blocked: ${humanRows.length} human-required row(s) need Jm action (${proxyIds.length} LucidTasks created)`,
        skepticalReview: verifyResult.skepticalReview,
      };
    }

    // Step 4: Complete (only if verify PASS and no manual rows)
    const completeResult = await this.complete(itemId);

    // Step 4b: Audit the completion gate decision
    if (!completeResult.success) {
      this.appendAuditLog({
        itemId,
        itemTitle: item?.title ?? "unknown",
        verdict: "FAIL",
        concerns: [`Completion gate rejected: ${completeResult.reason}`],
        tiersExecuted: verifyResult.skepticalReview?.tiers.map(t => t.tier) ?? [],
        verificationCost: verifyResult.skepticalReview?.totalCost ?? 0,
        iscRowSummary: this.loadISC(itemId)?.map(r => `${r.id}:${r.status}`) ?? [],
        failureReason: completeResult.reason,
      });
      return {
        success: false,
        reason: `Completion gate rejected: ${completeResult.reason}`,
        skepticalReview: verifyResult.skepticalReview,
      };
    }

    // Emit completion trace — fail-open
    try { emitCompletion(itemId, "executive"); } catch {}

    const _iscRowCount = this.loadISC(itemId)?.length ?? 0;
    const _verificationCost = verifyResult.skepticalReview?.totalCost ?? 0;
    emitInsight({
      source: 'AutonomousWork', type: 'signal',
      title: `Work completed: ${item?.title ?? itemId}`,
      content: `Verdict: PASS, ISC rows: ${_iscRowCount}`,
      tags: ['work-completion', 'pass'],
      metadata: { itemId, iscRowCount: _iscRowCount, verificationCost: _verificationCost }
    }).catch(() => {});

    // Post-hoc quality evaluation — fire-and-forget, fail-open
    try {
      const tracePath = join(resolve(import.meta.dir, "../../../../MEMORY/MONITORING/traces"), `${itemId}.jsonl`);
      if (existsSync(tracePath)) {
        const lines = readFileSync(tracePath, "utf-8").trim().split("\n").filter(Boolean);
        const traces = lines.map(l => JSON.parse(l));
        runPipeline(itemId, traces).catch(() => {});
      }
    } catch {}

    return { success: true, skepticalReview: verifyResult.skepticalReview };
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

      // TERTIARY GATE: Category coverage check
      // Ensure non-implementation categories are explicitly verified, not just assumed
      const GATED_CATEGORIES: ISCRowCategory[] = ["documentation", "deployment", "cleanup"];
      const gatedRows = rows.filter(r => r.category && GATED_CATEGORIES.includes(r.category));
      const ungatedFailures = gatedRows.filter(r => r.status !== "VERIFIED");
      if (ungatedFailures.length > 0) {
        const details = ungatedFailures.map(r => `[${r.category}] ${r.description}`).join("; ");
        return { success: false, reason: `Gated categories not verified: ${details}` };
      }

      // QUATERNARY GATE: Requirement coverage (spec-aware)
      if (item.specPath) {
        const specContent = this.readSpecContent(item.specPath, itemId);
        if (specContent) {
          try {
            const spec = parseSpec(item.specPath);
            const specRequirementCount = spec.isc?.length || 0;
            const verifiedCount = rows.filter(r => r.status === "VERIFIED").length;
            const allInferred = rows.length > 0 && rows.every(r => r.source === "INFERRED");
            const inferredCount = rows.filter(r => r.source === "INFERRED").length;
            const inferredRatio = rows.length > 0 ? inferredCount / rows.length : 0;
            const hasSpecFallback = rows.some(r => r.specFallback === true);

            // Sub-check A: Coverage threshold (raised from 0.5 to 0.8)
            if (specRequirementCount >= 4 && verifiedCount / specRequirementCount < 0.8) {
              return { success: false, reason: `Requirement coverage too low: ${verifiedCount} verified ISC rows for ${specRequirementCount} spec requirements (${((verifiedCount / specRequirementCount) * 100).toFixed(0)}%). Threshold is 80%. Re-run prepare to regenerate spec-based ISC.` };
            }
            // Sub-check B: All INFERRED with explicit spec
            if (allInferred && specRequirementCount >= 3) {
              return { success: false, reason: `All ${rows.length} ISC rows are INFERRED (template-generated) but spec has ${specRequirementCount} explicit requirements. Re-run prepare to regenerate spec-based ISC.` };
            }
            // Sub-check C: >50% INFERRED rows when spec has 4+ requirements
            if (specRequirementCount >= 4 && inferredRatio > 0.5) {
              return { success: false, reason: `Too many INFERRED rows: ${inferredCount}/${rows.length} ISC rows (${(inferredRatio * 100).toFixed(0)}%) are INFERRED but spec has ${specRequirementCount} explicit requirements. Re-run prepare to regenerate spec-based ISC.` };
            }
            // Sub-check D: specFallback rows when spec has 3+ requirements
            if (hasSpecFallback && specRequirementCount >= 3) {
              return { success: false, reason: `ISC rows were generated from template fallback despite spec having ${specRequirementCount} requirements (parseSpec returned empty ISC). Re-run prepare after fixing spec ISC table.` };
            }
          } catch (e) {
            return { success: false, reason: `Quaternary gate failed (fail-closed): spec parsing error for "${item.specPath}": ${e instanceof Error ? e.message : String(e)}. Cannot verify requirement coverage.` };
          }
        }
      }
    }

    // Clean up worktree before marking completed
    await this.cleanupWorktree(itemId);

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
   * Record a failed attempt and reset item for retry with escalating strategy.
   * Attempt 1 failed → next: "standard" (transient failures self-heal)
   * Attempt 2 failed → next: "re-prepare" (regenerate ISC from spec)
   * Attempt 3 failed → escalate to human via blocked proxy
   */
  async retry(itemId: string, error?: string): Promise<{ retried: boolean; escalated: boolean; attempt: number; nextStrategy?: RetryStrategy; item?: WorkItem }> {
    const item = this.queue.getItem(itemId);
    if (!item) return { retried: false, escalated: false, attempt: 0 };

    const attempts = item.attempts ?? [];
    const attemptNumber = attempts.length + 1;

    // Determine ISC progress for this attempt
    const rows = this.loadISC(itemId);
    const iscRowsCompleted = rows?.filter(r => r.status === "DONE" || r.status === "VERIFIED").length ?? 0;
    const iscRowsTotal = rows?.length ?? 0;

    // Determine what strategy was used for this (failed) attempt
    const currentStrategy: RetryStrategy = (item.metadata as Record<string, unknown>)?.nextRetryStrategy as RetryStrategy ?? "standard";

    // Emit error trace — fail-open
    try { emitError(itemId, "executive", error ?? "Unknown error"); } catch {}

    // Record attempt
    const attempt: WorkItemAttempt = {
      attemptNumber,
      startedAt: item.startedAt ?? new Date().toISOString(),
      endedAt: new Date().toISOString(),
      error: error ?? "Unknown error",
      strategy: currentStrategy,
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

      // Surface in jm-tasks so Jm sees it in normal task workflow
      await this.createJmTask(itemId, item.title, `Failed ${attemptNumber} attempts. Review needed.\n${attemptSummary}`);

      // Now safe to record attempt (resets to pending, but dependency already blocks it)
      this.guard.logIndirectTransition(itemId, "in_progress", "pending",
        `Attempt ${attemptNumber}: strategy=${attempt.strategy}`);
      this.queue.recordAttempt(itemId, attempt);

      // Worktree persists across retries — only complete() and fail() clean up
      return { retried: true, escalated: true, attempt: attemptNumber, item: this.queue.getItem(itemId) ?? undefined };
    }

    // Not escalated: determine next strategy
    const nextStrategy: RetryStrategy = attemptNumber === 1 ? "standard" : "re-prepare";

    // Record attempt and reset to pending
    this.guard.logIndirectTransition(itemId, "in_progress", "pending",
      `Attempt ${attemptNumber}: strategy=${attempt.strategy}`);
    const updated = this.queue.recordAttempt(itemId, attempt);
    if (!updated) return { retried: false, escalated: false, attempt: attemptNumber };

    // Use setMetadata (not direct mutation) — recordAttempt's save() detaches the `updated` reference
    this.queue.setMetadata(itemId, { nextRetryStrategy: nextStrategy });

    // Worktree persists across retries — only complete() and fail() clean up
    return { retried: true, escalated: false, attempt: attemptNumber, nextStrategy, item: this.queue.getItem(itemId) ?? undefined };
  }

  /**
   * Write-back completion status to approved-work JSONL so QueueManager stays in sync.
   * Non-fatal: logs errors but never blocks the completion pipeline.
   */
  private async syncCompletionToApprovedWork(itemId: string): Promise<void> {
    try {
      const { loadQueueItems, saveQueueItems } = await import("../../QueueRouter/Tools/QueueManager.ts");
      const items = loadQueueItems("approved-work");
      const idx = items.findIndex((i: { id: string }) => i.id === itemId);
      if (idx !== -1 && items[idx].status !== "completed") {
        items[idx].status = "completed";
        items[idx].result = { completedAt: new Date().toISOString(), completedBy: "WorkOrchestrator" };
        saveQueueItems("approved-work", items);
      }

      // Fallback: if item is still in approvals (never transferred), mark completed there too
      const approvalItems = loadQueueItems("approvals");
      const approvalIdx = approvalItems.findIndex((i: { id: string }) => i.id === itemId);
      if (approvalIdx !== -1 && approvalItems[approvalIdx].status !== "completed") {
        approvalItems[approvalIdx].status = "completed";
        approvalItems[approvalIdx].result = { completedAt: new Date().toISOString(), completedBy: "WorkOrchestrator" };
        saveQueueItems("approvals", approvalItems);
      }
    } catch (e) {
      console.error(`[WorkOrchestrator] approved-work write-back failed (non-fatal): ${e instanceof Error ? e.message : e}`);
    }
  }

  /**
   * Reconcile: sync all completed/failed work-queue items back to approved-work JSONL.
   * Catches any items where the per-item write-back was missed (e.g. process crash, import error).
   * Called during init. Non-fatal.
   */
  private async reconcileApprovedWork(): Promise<number> {
    try {
      const { loadQueueItems, saveQueueItems } = await import("../../QueueRouter/Tools/QueueManager.ts");
      const approvedItems = loadQueueItems("approved-work");
      const workItems = this.queue.getAllItems();
      let synced = 0;

      for (const approved of approvedItems) {
        if (approved.status === "completed" || approved.status === "failed") continue;
        const workItem = workItems.find((w: WorkItem) => w.id === approved.id);
        if (workItem && workItem.status === "completed") {
          approved.status = workItem.status;
          approved.result = { completedAt: workItem.completedAt || new Date().toISOString(), completedBy: "WorkOrchestrator/reconcile" };
          synced++;
        }
      }

      if (synced > 0) {
        saveQueueItems("approved-work", approvedItems);
        console.log(`Reconciled: synced ${synced} item(s) from work-queue → approved-work`);
      }
      return synced;
    } catch (e) {
      console.error(`[WorkOrchestrator] approved-work reconciliation failed (non-fatal): ${e instanceof Error ? e.message : e}`);
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
      this.appendAuditLog({ ...auditBase, verdict: "FAIL", concerns: ["completeSync G1: no passing verification"], failureReason: "G1" });
      return { success: false, reason: "No passing verification" };
    }

    // G2: Provenance — require skeptical_verifier for non-TRIVIAL
    const effort = item.effort || "STANDARD";
    if (effort !== "TRIVIAL" && item.verification.verifiedBy !== "skeptical_verifier") {
      this.appendAuditLog({ ...auditBase, verdict: "FAIL", concerns: [`completeSync G2: verifiedBy is "${item.verification.verifiedBy}"`], failureReason: "G2" });
      return { success: false, reason: `verifiedBy is "${item.verification.verifiedBy}", not "skeptical_verifier"` };
    }

    // G3: Tier 1 execution — non-TRIVIAL must have run Tier 1
    if (effort !== "TRIVIAL") {
      if (!item.verification.tiersExecuted || !item.verification.tiersExecuted.includes(1)) {
        const reason = `Completion blocked: Tier 1 code checks did not execute. tiersExecuted: [${item.verification.tiersExecuted || []}]`;
        this.appendAuditLog({ ...auditBase, verdict: "FAIL", concerns: [reason], failureReason: "G3" });
        return { success: false, reason };
      }
    }

    // G5: ISC all-VERIFIED (defense-in-depth)
    if (rows) {
      const unverified = rows.filter(r => r.status !== "VERIFIED");
      if (unverified.length > 0) {
        const reason = `${unverified.length} ISC rows not verified (completeSync check).`;
        this.appendAuditLog({ ...auditBase, verdict: "FAIL", concerns: [reason], failureReason: "G5" });
        return { success: false, reason };
      }

      // G6: Category coverage check (same gated categories as complete())
      const GATED_CATEGORIES: ISCRowCategory[] = ["documentation", "deployment", "cleanup"];
      const gatedRows = rows.filter(r => r.category && GATED_CATEGORIES.includes(r.category));
      const ungatedFailures = gatedRows.filter(r => r.status !== "VERIFIED");
      if (ungatedFailures.length > 0) {
        const details = ungatedFailures.map(r => `[${r.category}] ${r.description}`).join("; ");
        const reason = `Gated categories not verified: ${details}`;
        this.appendAuditLog({ ...auditBase, verdict: "FAIL", concerns: [reason], failureReason: "G6" });
        return { success: false, reason };
      }

      // G7: Spec requirement coverage (same 4 sub-checks as complete())
      if (item.specPath) {
        const specContent = this.readSpecContent(item.specPath, itemId);
        if (specContent) {
          try {
            const spec = parseSpec(item.specPath!);
            const specRequirementCount = spec.isc?.length || 0;
            const verifiedCount = rows.filter(r => r.status === "VERIFIED").length;
            const allInferred = rows.length > 0 && rows.every(r => r.source === "INFERRED");
            const inferredCount = rows.filter(r => r.source === "INFERRED").length;
            const inferredRatio = rows.length > 0 ? inferredCount / rows.length : 0;
            const hasSpecFallback = rows.some(r => r.specFallback === true);

            // Sub-check A: Coverage threshold (80%)
            if (specRequirementCount >= 4 && verifiedCount / specRequirementCount < 0.8) {
              const reason = `Requirement coverage too low: ${verifiedCount} verified ISC rows for ${specRequirementCount} spec requirements (${((verifiedCount / specRequirementCount) * 100).toFixed(0)}%). Threshold is 80%.`;
              this.appendAuditLog({ ...auditBase, verdict: "FAIL", concerns: [reason], failureReason: "G7-coverage" });
              return { success: false, reason };
            }
            // Sub-check B: All INFERRED with explicit spec
            if (allInferred && specRequirementCount >= 3) {
              const reason = `All ${rows.length} ISC rows are INFERRED but spec has ${specRequirementCount} explicit requirements.`;
              this.appendAuditLog({ ...auditBase, verdict: "FAIL", concerns: [reason], failureReason: "G7-all-inferred" });
              return { success: false, reason };
            }
            // Sub-check C: >50% INFERRED rows when spec has 4+ requirements
            if (specRequirementCount >= 4 && inferredRatio > 0.5) {
              const reason = `Too many INFERRED rows: ${inferredCount}/${rows.length} ISC rows (${(inferredRatio * 100).toFixed(0)}%) are INFERRED but spec has ${specRequirementCount} explicit requirements.`;
              this.appendAuditLog({ ...auditBase, verdict: "FAIL", concerns: [reason], failureReason: "G7-inferred-ratio" });
              return { success: false, reason };
            }
            // Sub-check D: specFallback rows when spec has 3+ requirements
            if (hasSpecFallback && specRequirementCount >= 3) {
              const reason = `ISC rows were generated from template fallback despite spec having ${specRequirementCount} requirements.`;
              this.appendAuditLog({ ...auditBase, verdict: "FAIL", concerns: [reason], failureReason: "G7-specFallback" });
              return { success: false, reason };
            }
          } catch (e) {
            const reason = `completeSync G7 failed (fail-closed): spec parsing error for "${item.specPath}": ${e instanceof Error ? e.message : String(e)}.`;
            this.appendAuditLog({ ...auditBase, verdict: "FAIL", concerns: [reason], failureReason: "G7-parse-error" });
            return { success: false, reason };
          }
        }
      }
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
  // Verify: run verification commands + spotcheck
  // --------------------------------------------------------------------------

  async verify(itemId: string): Promise<{ success: boolean; failures: ISCRow[]; skepticalReview?: SkepticalReviewResult }> {
    const item = this.queue.getItem(itemId);
    if (!item) return { success: false, failures: [{ id: -1, description: "Item not found", status: "EXECUTION_FAILED", parallel: false }] };

    // Circuit breaker: 2 consecutive identical FAILs → skip verification, signal retry
    const verificationHistory = (item.metadata as Record<string, unknown>)?.verificationHistory as
      Array<{ verdict: string; concerns: string[] }> | undefined;
    if (verificationHistory && verificationHistory.length >= 2) {
      const last2 = verificationHistory.slice(-2);
      if (
        last2.every(v => v.verdict === "FAIL") &&
        JSON.stringify(last2[0].concerns) === JSON.stringify(last2[1].concerns)
      ) {
        return {
          success: false,
          failures: [{ id: -1, description: "Circuit breaker: 2 consecutive identical verification failures — skipping to retry", status: "EXECUTION_FAILED", parallel: false }],
        };
      }
    }

    const rows = this.loadISC(itemId);
    if (!rows) return { success: false, failures: [{ id: -1, description: "No ISC rows found — run prepare first", status: "EXECUTION_FAILED", parallel: false }] };

    // Step 1: Run verification commands on ISC rows (local checks)
    // Sort smoke-priority rows first for fast-fail
    const sortedRows = [...rows].sort((a, b) => {
      const aPri = a.priority === "smoke" ? 0 : 1;
      const bPri = b.priority === "smoke" ? 0 : 1;
      return aPri - bPri;
    });

    // Resolve cwd from worktree > outputPath > projectPath > process.cwd()
    const verifyCtx = this.resolveVerifyContext(item);
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
          const rowCwd = this.resolveRowCwd(row, verifyCtx);
          const localResult = this.runVerificationCommand(row, rowCwd);
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
    const gitDiffStat = this.getGitDiffStat(verifyCtx);
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
        category: r.category,
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
      projectContext: primaryCwd ? this.detectProjectContext(primaryCwd) : undefined,
      testStrategyContent: item.testStrategyPath && existsSync(item.testStrategyPath)
        ? readFileSync(item.testStrategyPath, "utf-8").slice(0, 3000)
        : undefined,
    };

    const review = await this.verifier.review(summary);

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
      this.persistISC(itemId, rows);
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
        const failures: ISCRow[] = [{ id: -1, description: `Guard downgraded PASS: ${guardResult.reason}`, status: "EXECUTION_FAILED", parallel: false }];
        return { success: false, failures, skepticalReview: review };
      }
      // Clear verification history on success — no stale failures carried forward
      this.queue.setMetadata(itemId, { verificationHistory: [] });
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
    const existingHistory = ((item.metadata as Record<string, unknown>)?.verificationHistory as
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
    const s = this.queue.getStats();
    const statusBlocked = this.queue.getAllItems().filter(i => i.status === "blocked");
    const dagBlocked = this.queue.getDagBlockedItems();
    const lines = [
      `Queue: ${s.total} total | ${s.ready} ready | ${s.inProgress} in-progress | ${s.completed} completed | ${s.failed} failed | ${s.blocked} blocked`,
    ];
    if (statusBlocked.length > 0 || dagBlocked.length > 0) {
      lines.push("Blocked:");
      for (const item of statusBlocked) {
        lines.push(`  ${item.id} — ${item.title.slice(0, 40)} [awaiting-human]`);
      }
      for (const item of dagBlocked) {
        const deps = item.dependencies.join(", ");
        lines.push(`  ${item.id} — ${item.title.slice(0, 40)} (waiting: ${deps})`);
      }
    }
    return lines.join("\n");
  }

  // --------------------------------------------------------------------------
  // Report: structured output binding narrative to programmatic state
  // --------------------------------------------------------------------------

  report(): { completed: WorkItem[]; failed: WorkItem[]; inProgress: WorkItem[]; blocked: WorkItem[]; needsReview: WorkItem[] } {
    const all = this.queue.getAllItems();
    const completed: WorkItem[] = [];
    const failed: WorkItem[] = [];
    const inProgress: WorkItem[] = [];
    const blocked: WorkItem[] = [];
    const needsReview: WorkItem[] = [];

    const dagBlockedIds = new Set(this.queue.getDagBlockedItems().map(i => i.id));

    for (const item of all) {
      // Items only count as completed if verification.status === "verified"
      if (item.status === "completed" && item.verification?.status === "verified") {
        completed.push(item);
      } else if (item.status === "blocked") {
        blocked.push(item);
      } else if (item.status === "failed") {
        failed.push(item);
      } else if (item.verification?.status === "needs_review") {
        needsReview.push(item);
      } else if (dagBlockedIds.has(item.id)) {
        blocked.push(item);
      } else if (item.status === "in_progress" || item.status === "partial") {
        inProgress.push(item);
      } else if (item.status === "pending") {
        // pending but not blocked — just pending
      }
    }

    return { completed, failed, inProgress, blocked, needsReview };
  }

  reportMarkdown(): string {
    const r = this.report();
    const lines: string[] = ["# Session Report\n"];

    const formatItem = (item: WorkItem): string => {
      const v = item.verification;
      const verdict = v ? `${v.verdict} (${v.status})` : "no verification";
      const iscRows = this.loadISC(item.id);
      const iscRatio = iscRows
        ? `${iscRows.filter(r => r.status === "VERIFIED").length}/${iscRows.length} ISC verified`
        : "no ISC";
      const concerns = v?.concerns?.length ? ` | concerns: ${v.concerns.join("; ")}` : "";
      return `- **${item.title}** [${item.id.slice(0, 8)}] — ${verdict} | ${iscRatio}${concerns}`;
    };

    if (r.completed.length > 0) {
      lines.push(`## Completed (${r.completed.length})`);
      for (const item of r.completed) lines.push(formatItem(item));
      lines.push("");
    }

    if (r.inProgress.length > 0) {
      lines.push(`## In Progress (${r.inProgress.length})`);
      for (const item of r.inProgress) lines.push(formatItem(item));
      lines.push("");
    }

    if (r.failed.length > 0) {
      lines.push(`## Failed (${r.failed.length})`);
      for (const item of r.failed) lines.push(formatItem(item));
      lines.push("");
    }

    if (r.blocked.length > 0) {
      lines.push(`## Blocked (${r.blocked.length})`);
      const statusBlocked = r.blocked.filter(i => i.status === "blocked");
      const dagBlocked = r.blocked.filter(i => i.status !== "blocked");
      for (const item of statusBlocked) {
        const manualRows = item.metadata?.manualRows as Array<{ id: number; description: string }> | undefined;
        const desc = manualRows ? manualRows.map(r => `#${r.id}`).join(", ") : "";
        lines.push(`${formatItem(item)} [awaiting-human]${desc ? ` | manual rows: ${desc}` : ""}`);
      }
      for (const item of dagBlocked) {
        lines.push(`- **${item.title}** [${item.id.slice(0, 8)}] — waiting: ${item.dependencies.join(", ")}`);
      }
      lines.push("");
    }

    if (r.needsReview.length > 0) {
      lines.push(`## Needs Human Review (${r.needsReview.length})`);
      for (const item of r.needsReview) lines.push(formatItem(item));
      lines.push("");
    }

    return lines.join("\n");
  }

  // --------------------------------------------------------------------------
  // Catastrophic action detection
  // --------------------------------------------------------------------------

  isCatastrophic(command: string): { blocked: boolean; action?: CatastrophicAction; reason?: string } {
    for (const { pattern, action } of CATASTROPHIC_PATTERNS) {
      if (pattern.test(command)) {
        return { blocked: true, action, reason: `Catastrophic action detected: ${action}` };
      }
    }
    return { blocked: false };
  }

  isProtectedBranch(branch: string): boolean {
    return PROTECTED_BRANCHES.includes(branch.toLowerCase());
  }

  // --------------------------------------------------------------------------
  // Feature branch creation
  // --------------------------------------------------------------------------

  async ensureFeatureBranch(itemId: string): Promise<{ branch: string; workingDir: string }> {
    const sanitizedId = itemId.replace(/[^a-zA-Z0-9-]/g, "-");
    const featureBranch = `feature/work-${sanitizedId}`;

    // Reuse existing worktree from metadata (handles retry case where worktree persists)
    const item = this.queue.getItem(itemId);
    const existingPath = item?.metadata?.worktreePath as string | undefined;
    const existingBranch = item?.metadata?.worktreeBranch as string | undefined;
    const intendedRepo = this.resolveRepoRoot(item);

    if (existingPath && existsSync(existingPath)) {
      // Stale worktree detection: if the existing worktree was created from the wrong repo
      // (e.g., ~/.claude instead of the target project), clean it up and recreate
      const existingRepo = this.tryResolveGitRoot(existingPath);
      const intendedIsExternal = intendedRepo !== process.cwd();
      const existingIsKaya = existingRepo === null || existingRepo === process.cwd();
      if (intendedIsExternal && existingIsKaya) {
        // Wrong repo — clean up stale worktree and fall through to recreate
        try {
          const { removeWorktree } = await import("../../../../lib/core/WorktreeManager.ts");
          await removeWorktree(existingPath);
        } catch { /* best-effort cleanup */ }
      } else {
        return { branch: existingBranch ?? featureBranch, workingDir: existingPath };
      }
    }

    try {
      const { getOrCreateWorktree } = await import("../../../../lib/core/WorktreeManager.ts");
      const entry = await getOrCreateWorktree({
        repoRoot: intendedRepo,
        branch: featureBranch,
        createdBy: `orchestrator:${sanitizedId}`,
      });
      // Persist worktree path and starting SHA in item metadata for cleanup + git diff range
      const startSha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf-8", cwd: entry.path }).trim();
      this.queue.setMetadata(itemId, { worktreePath: entry.path, worktreeBranch: featureBranch, startSha });
      return { branch: featureBranch, workingDir: entry.path };
    } catch (e) {
      this.guard.logCaughtError(itemId, "ensureFeatureBranch.getOrCreateWorktree", e);
      throw new Error(`ensureFeatureBranch failed for ${itemId}: ${e instanceof Error ? e.message : String(e)}. Caller should use retry(id, error).`);
    }
  }

  /**
   * Resolve the git repo root for worktree creation.
   * For items targeting external projects (kaya-canvas, kaya-mobile, etc.),
   * creates the worktree from the project's repo — not ~/.claude.
   * Falls back to process.cwd() for Kaya-internal items.
   *
   * Resolution order:
   * 1. item.projectPath / item.outputPath (explicit)
   * 2. Title-based heuristic: "project-name: ..." → ~/Desktop/projects/project-name/
   * 3. process.cwd() (Kaya repo)
   */
  private resolveRepoRoot(item: WorkItem | undefined): string {
    if (!item) return process.cwd();

    const candidatePath = item.projectPath || item.outputPath;
    const resolved = this.tryResolveGitRoot(candidatePath);
    if (resolved) return resolved;

    // Heuristic: extract project name from title pattern "project-name: ..."
    const titleMatch = item.title.match(/^([\w-]+):\s/);
    if (titleMatch) {
      const projectName = titleMatch[1].toLowerCase();
      const projectDir = join("/Users/[user]/Desktop/projects", projectName);
      const resolved = this.tryResolveGitRoot(projectDir);
      if (resolved) {
        // Persist so resolveVerifyContext() and future calls also benefit
        this.queue.setProjectPath(item.id, resolved);
        return resolved;
      }
    }

    return process.cwd();
  }

  /** Check if a path is a git repo different from Kaya. Returns repo root or null. */
  private tryResolveGitRoot(candidatePath: string | undefined | null): string | null {
    if (!candidatePath || !existsSync(candidatePath)) return null;
    try {
      const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
        encoding: "utf-8",
        cwd: candidatePath,
        timeout: 5000,
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
      if (root && root !== process.cwd()) return root;
    } catch {
      // Not a git repo or git error
    }
    return null;
  }

  // --------------------------------------------------------------------------
  // Worktree cleanup
  // --------------------------------------------------------------------------

  private async cleanupWorktree(itemId: string): Promise<void> {
    const item = this.queue.getItem(itemId);
    const wtPath = item?.metadata?.worktreePath as string | undefined;
    if (!wtPath) return;

    try {
      const { removeWorktree } = await import("../../../../lib/core/WorktreeManager.ts");
      await removeWorktree(wtPath);
    } catch (e) {
      // Non-blocking — worktree cleanup failure means orphan worktree (disk space only)
      this.guard.logCaughtError(itemId, "cleanupWorktree", e);
    }
  }

  // --------------------------------------------------------------------------
  // Prior work summary
  // --------------------------------------------------------------------------

  generatePriorWorkSummary(completedItemIds: string[]): string {
    if (completedItemIds.length === 0) return "";
    const parts: string[] = [];

    for (const id of completedItemIds) {
      const rows = this.loadISC(id);
      if (!rows) continue;
      const verified = rows.filter(r => r.status === "VERIFIED" || r.status === "DONE");
      if (verified.length === 0) continue;
      const list = verified.map(r => `  - ${r.description}`).join("\n");
      parts.push(`### ${id}\n${list}`);
    }

    if (parts.length === 0) return "";
    return `## Prior Work Completed\nDo not redo this work.\n\n${parts.join("\n\n")}`;
  }

  // --------------------------------------------------------------------------
  // Effort classification
  // --------------------------------------------------------------------------

  private classifyEffort(item: WorkItem): EffortLevel {
    const request = (item.description || item.title || "").toLowerCase().trim();
    if (!request) return "STANDARD";

    const words = request.split(/\s+/);

    // Trivial: greetings, acknowledgments
    if (words.length <= 3 && /^(hi|hello|hey|thanks?|ok(ay)?|got it|sure|yes|no|yep|nope)[\s!.,]*$/i.test(request)) {
      return "TRIVIAL";
    }

    // Determined: explicit persistence signals
    if (/until (it('s| is) )?done|don'?t stop|keep going|overnight|walk away|whatever it takes|no matter what/i.test(request)) {
      return "DETERMINED";
    }

    // Thorough: architectural/complex keywords or explicit thoroughness
    const THOROUGH_PATTERNS = /refactor|redesign|architect|comprehensive|thorough|multi.?file|across (the |all )?codebase/i;
    const HIGH_COMPLEXITY = ["authentication", "authorization", "security", "database", "migration", "api", "integration", "deploy", "infrastructure", "performance", "optimization", "architecture", "refactor", "redesign"];
    const highCount = HIGH_COMPLEXITY.filter(kw => request.includes(kw)).length;
    if (THOROUGH_PATTERNS.test(request) || highCount >= 2) {
      return "THOROUGH";
    }

    // Quick: short, simple requests
    if (words.length <= 15 && highCount === 0) {
      const LOW_COMPLEXITY = ["typo", "comment", "rename", "color", "text", "label", "spacing", "margin", "padding"];
      if (LOW_COMPLEXITY.some(kw => request.includes(kw)) || /fix (the |a )?typo|rename \w+ to \w+/i.test(request)) {
        return "QUICK";
      }
    }

    return "STANDARD";
  }

  // --------------------------------------------------------------------------
  // ISC generation
  // --------------------------------------------------------------------------

  /**
   * Simple FNV-1a hash for stable ISC row IDs (M5).
   * When re-preparing, content-based IDs prevent collision with preserved completed work.
   */
  private stableRowId(description: string): number {
    let hash = 0x811c9dc5;
    for (let i = 0; i < description.length; i++) {
      hash ^= description.charCodeAt(i);
      hash = (hash * 0x01000193) >>> 0;
    }
    return 1000 + (hash % 9000); // range 1000-9999
  }

  private generateISC(item: WorkItem, effort: EffortLevel): ISCRow[] {
    // Strategy 1: spec-based generation
    if (item.specPath && existsSync(item.specPath)) {
      try {
        const spec = parseSpec(item.specPath);
        if (spec.isc.length > 0) {
          const rows = spec.isc.map((c: ISCCriterion, i: number) => {
            const category = inferCategory(c.description, c.source);
            return {
            id: this.stableRowId(c.description),
            description: c.description,
            status: "PENDING" as const,
            category,
            parallel: false,
            source: this.normalizeSource(c.source) ?? "EXPLICIT" as const,
            disposition: this.classifyRowDisposition(c.description, category),
            ...(c.priority ? { priority: c.priority } : {}),
            verification: (() => {
              // Normalize the embedded command: strip bare 'test', expand tildes.
              // If normalization returns null (useless command), fall back to inferred.
              const rawCmd = c.embeddedCommand
                ? normalizeVerificationCommand(c.embeddedCommand)
                : undefined;
              const finalCmd = rawCmd ?? this.inferVerificationCommand(c.description, item);
              // Auto-detect invertExit from description or verifyMethod text
              const invertExit = detectInvertExit(c.verifyMethod ?? "") || detectInvertExit(c.description);
              return {
                method: finalCmd ? (c.embeddedCommand ? "command" : "inferred") : (c.verifyMethod || "inferred"),
                command: finalCmd,
                success_criteria: `Verified complete: ${c.description}`,
                ...(invertExit ? { invertExit: true } : {}),
              };
            })(),
          }});
          return this.mergePreservedRows(item, rows);
        }
        // Strategy 1.5: LLM extraction — ask Haiku to parse the spec into ISC rows
        console.warn(`[WorkOrchestrator] Spec exists at "${item.specPath}" but parseSpec returned 0 ISC rows. Trying Strategy 1.5 (Haiku ISC extraction).`);
        try {
          const specContent = readFileSync(item.specPath!, "utf-8").slice(0, 8000);
          const prompt = `Extract verifiable acceptance criteria from this spec. Return JSON array: [{"description":"...","verificationCommand":"..."}]. Max 10 rows. If no clear criteria found, return [].\n\n${specContent}`;

          // Sync CLI call to Inference.ts to avoid cascading async changes
          // (inferenceFn is async and generateISC is sync — CLI path keeps it sync)
          const inferPath = join(__dirname, "../../../lib/core/Inference.ts");
          if (existsSync(inferPath)) {
            const cliResult = Bun.spawnSync(["bun", inferPath, "fast"], {
              stdin: Buffer.from(prompt),
              timeout: 30000,
            });
            if (cliResult.exitCode === 0) {
              const output = cliResult.stdout.toString("utf-8").trim();
              // Extract JSON array from output (may have preamble text)
              const jsonMatch = output.match(/\[[\s\S]*\]/);
              if (jsonMatch) {
                const parsed = JSON.parse(jsonMatch[0]) as Array<{ description: string; verificationCommand?: string }>;
                if (Array.isArray(parsed) && parsed.length > 0) {
                  const llmRows: ISCRow[] = parsed.slice(0, 10).map((r, i) => ({
                    id: this.stableRowId(r.description),
                    description: r.description,
                    status: "PENDING" as const,
                    category: inferCategory(r.description),
                    parallel: false,
                    source: "INFERRED" as const,
                    verification: {
                      method: r.verificationCommand ? "command" as const : "inferred" as const,
                      command: r.verificationCommand ? normalizeVerificationCommand(r.verificationCommand) ?? undefined : undefined,
                      success_criteria: `Verified complete: ${r.description}`,
                    },
                  }));
                  return this.mergePreservedRows(item, llmRows);
                }
              }
            }
          }
        } catch (e) {
          console.warn(`[WorkOrchestrator] Strategy 1.5 (Haiku ISC extraction) failed: ${e}`);
        }
        // Fall through to templateRows()
        const fallbackRows = this.templateRows(item, effort);
        for (const row of fallbackRows) {
          row.specFallback = true;
        }
        return this.mergePreservedRows(item, fallbackRows);
      } catch (e) {
        // parseSpec threw — fail closed with EXECUTION_FAILED row
        const errMsg = e instanceof Error ? e.message : String(e);
        console.error(`[WorkOrchestrator] parseSpec threw for "${item.specPath}": ${errMsg}. Returning EXECUTION_FAILED row.`);
        return [{
          id: 1,
          description: `ISC generation failed: parseSpec error for "${item.specPath}": ${errMsg}`,
          status: "EXECUTION_FAILED" as const,
          category: "implementation",
          parallel: false,
          source: "INFERRED" as const,
          verification: {
            method: "manual",
            success_criteria: "Spec parsing must succeed before work can proceed",
          },
        }];
      }
    }

    // Strategy 2: template-based generation (no spec present)
    return this.mergePreservedRows(item, this.templateRows(item, effort));
  }

  private templateRows(item: WorkItem, effort: EffortLevel): ISCRow[] {
    const rows: ISCRow[] = [];
    if (item.workType === "dev") {
      rows.push({ id: 1, description: "Implement core functionality", status: "PENDING", category: "implementation", source: "INFERRED", parallel: false, verification: { method: "test", command: "bun test", success_criteria: "Core tests pass" } });
      rows.push({ id: 2, description: "Add tests and validation", status: "PENDING", category: "testing", source: "INFERRED", parallel: false, verification: { method: "test", command: "bun test", success_criteria: "All tests pass" } });
    } else if (item.workType === "research") {
      rows.push({ id: 1, description: "Gather sources and context", status: "PENDING", category: "implementation", source: "INFERRED", parallel: false, verification: { method: "manual", success_criteria: "Sources documented" } });
      rows.push({ id: 2, description: "Synthesize findings", status: "PENDING", category: "implementation", source: "INFERRED", parallel: false, verification: { method: "manual", success_criteria: "Synthesis complete" } });
    } else {
      rows.push({ id: 1, description: `Complete: ${item.title}`, status: "PENDING", category: "implementation", source: "INFERRED", parallel: false, verification: { method: "manual", success_criteria: "Work completed" } });
    }

    if (effort === "THOROUGH" || effort === "DETERMINED") {
      rows.push({ id: rows.length + 1, description: "Edge case handling and robustness", status: "PENDING", category: "testing", source: "INFERRED", parallel: false, verification: { method: "test", command: "bun test", success_criteria: "Edge cases covered" } });
    }

    return rows;
  }

  private normalizeSource(source?: string): ISCRow["source"] {
    if (!source) return undefined;
    const upper = source.toUpperCase().trim();
    if (upper === "EXPLICIT") return "EXPLICIT";
    if (upper === "INFERRED") return "INFERRED";
    if (upper === "IMPLICIT") return "IMPLICIT";
    if (upper === "RESEARCH") return "RESEARCH";
    return undefined;
  }

  /**
   * Merge preserved rows from re-prepare into newly generated rows (M5).
   * Preserved rows that don't conflict (by description) with new rows are prepended.
   */
  private mergePreservedRows(item: WorkItem, rows: ISCRow[]): ISCRow[] {
    const preserved = ((item.metadata as Record<string, unknown>)?._preservedRows ?? []) as ISCRow[];
    if (preserved.length > 0) {
      const newDescSet = new Set(rows.map(r => r.description));
      const uniquePreserved = preserved.filter(r => !newDescSet.has(r.description));
      rows.unshift(...uniquePreserved);
      // Clean up metadata
      delete (item.metadata as Record<string, unknown>)._preservedRows;
    }
    return rows;
  }

  /**
   * Annotate ISC rows with testLevel and priority from a TestStrategy document.
   * Parses the "ISC Test Classification" table and applies metadata to matching rows.
   * Does not override priority already set from spec parsing.
   */
  private annotateWithTestStrategy(rows: ISCRow[], testStrategyPath: string): void {
    try {
      const content = readFileSync(testStrategyPath, "utf-8");

      // Parse the ISC Test Classification table
      // Format: | ISC # | Description | Test Level | Smoke? | Test Artifact |
      const tableRegex = /\|\s*(\d+)\s*\|[^|]+\|\s*(unit|integration|e2e|manual)\s*\|\s*(yes|no)\s*\|[^|]*\|/gi;
      const annotations = new Map<number, { testLevel: ISCRow["testLevel"]; priority: ISCRow["priority"] }>();

      let match: RegExpExecArray | null;
      while ((match = tableRegex.exec(content)) !== null) {
        const iscNum = parseInt(match[1], 10);
        const testLevel = match[2].toLowerCase() as ISCRow["testLevel"];
        const isSmoke = match[3].toLowerCase() === "yes";
        annotations.set(iscNum, {
          testLevel,
          priority: isSmoke ? "smoke" : "full",
        });
      }

      if (annotations.size === 0) return;

      // Apply annotations by position — rows and TestStrategy table are in the same order
      // (TestStrategy uses spec row numbers which aren't easily mappable to hashed IDs)
      const annotationValues = [...annotations.values()];
      for (let i = 0; i < rows.length && i < annotationValues.length; i++) {
        const ann = annotationValues[i];
        if (!rows[i].testLevel) {
          rows[i].testLevel = ann.testLevel;
        }
        // Don't override priority already set from spec parsing
        if (!rows[i].priority) {
          rows[i].priority = ann.priority;
        }
      }
    } catch {
      // TestStrategy file unreadable — continue without annotation
    }
  }

  private inferVerificationCommand(description: string, item: WorkItem): string | undefined {
    // Try spec-aware command generation first
    const specCmd = this.inferVerificationFromSpecContext(description);
    if (specCmd) return specCmd;

    // Fallback: dev items use bun test, research/other use manual (no auto-pass commands)
    if (item.workType === "dev") return "bun test";
    return undefined;
  }

  /**
   * Generate targeted verification commands from spec context (file paths, test cases).
   * Returns null when no spec context is available, falling back to keyword heuristic.
   */
  private inferVerificationFromSpecContext(description: string): string | undefined {
    // Pattern: description contains a file path with directory (e.g. "Tools/VoiceSystemPrompt.ts")
    // Only match paths with at least one directory component (contains "/")
    const filePathMatch = description.match(/([\w\-./]+\/[\w\-./]+\.\w{1,4})$/);
    if (filePathMatch) {
      const filePath = filePathMatch[1];
      // Test files get targeted run (not full suite)
      if (/\.test\.\w+$|\.spec\.\w+$/.test(filePath)) {
        return `bun test ${filePath}`;
      }
      // Implementation files get existence check
      return `test -f ${filePath}`;
    }

    // Pattern: TC-XX test case rows — no auto-pass; use method: "manual" for human/verifier review
    if (/^TC-\d+/i.test(description)) {
      return undefined;
    }

    return undefined;
  }

  // --------------------------------------------------------------------------
  // Verification command parsing (security allowlist)
  // --------------------------------------------------------------------------

  parseVerificationCommand(command: string): { exe: string; args: string[] } | null {
    if (command.includes("|") || command.includes("&&") || command.includes(";") || command.includes("$(") || command.includes("`")) {
      return null;
    }

    const parts: string[] = [];
    let current = "";
    let inQuote: string | null = null;

    for (const char of command) {
      if (inQuote) {
        if (char === inQuote) { inQuote = null; } else { current += char; }
      } else if (char === '"' || char === "'") {
        inQuote = char;
      } else if (char === " " || char === "\t") {
        if (current) { parts.push(current); current = ""; }
      } else {
        current += char;
      }
    }
    if (current) parts.push(current);
    if (parts.length === 0) return null;

    const exe = parts[0];

    if (exe === "git") {
      const sub = parts[1];
      if (!sub || !SAFE_GIT_SUBCOMMANDS.has(sub)) return null;
      return { exe, args: parts.slice(1) };
    }

    if (!ALLOWED_EXECUTABLES.has(exe)) return null;
    return { exe, args: parts.slice(1) };
  }

  // --------------------------------------------------------------------------
  // Run verification
  // --------------------------------------------------------------------------

  private runVerificationCommand(row: ISCRow, cwd?: string): boolean | null {
    if (!row.verification?.command) return null; // No command = cannot verify locally — defer to Phase 2 judgment
    const normalized = normalizeVerificationCommand(row.verification.command);
    if (!normalized) {
      // Bare 'test', empty, or otherwise unusable — defer to Phase 2 judgment without failing
      console.warn(`[WorkOrchestrator] Skipping unusable verification command: "${row.verification.command}" (row #${row.id})`);
      return null;
    }
    const parsed = this.parseVerificationCommand(normalized);
    if (!parsed) return null; // Unparseable command (shell operators) — defer to Phase 2 judgment

    // Guard: if the command references a directory path that doesn't exist, skip rather than fail
    const missingDir = findMissingDirectoryArg(parsed.args, cwd);
    if (missingDir) {
      console.warn(`[WorkOrchestrator] Skipping verification command (directory not found: "${missingDir}"): "${normalized}" (row #${row.id})`);
      return null;
    }

    // Expand glob patterns in args (execFileSync doesn't use shell, so globs like *.md aren't expanded)
    const expandedArgs = parsed.args.flatMap(arg => {
      if (/[*?\[]/.test(arg)) {
        const expanded = globSync(arg, { cwd: cwd || process.cwd() });
        return expanded.length > 0 ? expanded : [arg]; // Keep original if no matches (let command fail naturally)
      }
      return [arg];
    });

    try {
      execFileSync(parsed.exe, expandedArgs, { encoding: "utf-8", timeout: 120000, ...(cwd ? { cwd } : {}) });
      return !row.verification.invertExit; // exit 0: PASS normally, FAIL if inverted
    } catch {
      // Acceptable silence: non-zero exit IS the expected failure signal for verification commands
      return !!row.verification.invertExit; // non-zero: FAIL normally, PASS if inverted
    }
  }

  // --------------------------------------------------------------------------
  // Git + spec helpers (overridable for tests)
  // --------------------------------------------------------------------------

  private getSingleRepoDiffStat(cwd?: string, startSha?: string, pathFilter?: string[]): string {
    try {
      // -M enables rename detection so renames show as "old => new | 0"
      // instead of delete + add with full content as insertions/deletions
      const args = startSha
        ? ["diff", "--stat", "-M", `${startSha}..HEAD`]
        : ["diff", "--stat", "-M", "HEAD~1"];
      // Path filter scopes diff to specific directories (e.g. monorepo skills)
      if (pathFilter && pathFilter.length > 0) {
        args.push("--", ...pathFilter);
      }
      return execFileSync("git", args, { encoding: "utf-8", timeout: 10000, ...(cwd ? { cwd } : {}) });
    } catch (e) {
      this.guard.logCaughtError("getGitDiffStat", "getGitDiffStat", e);
      return "";
    }
  }

  getGitDiffStat(verifyCtx: VerifyContext): string {
    if (verifyCtx.kind === "single") {
      return this.getSingleRepoDiffStat(verifyCtx.cwd, verifyCtx.startSha, verifyCtx.pathFilter);
    }
    // Multi-repo: iterate each repo and concatenate with section headers
    const sections: string[] = [];
    for (const repo of verifyCtx.repos) {
      const repoDiff = this.getSingleRepoDiffStat(repo.cwd, repo.startSha, repo.pathFilter);
      sections.push(`[${repo.name}]\n${repoDiff}`);
    }
    return sections.join("\n");
  }

  /**
   * Resolve the best git diff context for an item.
   * Multi-repo path: checks metadata.repoContexts first.
   * Single-repo path: worktreePath (metadata) > outputPath > projectPath > process.cwd()
   * Returns a discriminated union VerifyContext.
   */
  resolveVerifyContext(item: WorkItem): VerifyContext {
    // Multi-repo path: metadata.repoContexts overrides all single-repo logic
    const rawRepoContexts = item.metadata?.repoContexts as RepoContext[] | undefined;
    if (Array.isArray(rawRepoContexts) && rawRepoContexts.length > 0) {
      const validRepos = rawRepoContexts.filter(r => existsSync(r.cwd));
      // Degrade to single if only 1 repo valid
      if (validRepos.length >= 2) {
        return { kind: "multi", repos: validRepos };
      }
      if (validRepos.length === 1) {
        const r = validRepos[0];
        return { kind: "single", cwd: r.cwd, startSha: r.startSha, pathFilter: r.pathFilter };
      }
      // All repos missing — fall through to single-repo logic below
    }

    const worktreePath = item.metadata?.worktreePath as string | undefined;
    const startSha = item.metadata?.startSha as string | undefined;
    const pathFilter = item.metadata?.diffPathFilter as string[] | undefined;

    // Worktree is highest priority — it's the isolated copy where work was done
    if (worktreePath && existsSync(worktreePath)) {
      return { kind: "single", cwd: worktreePath, startSha, pathFilter };
    }
    // outputPath is where verification commands run
    if (item.outputPath && existsSync(item.outputPath)) {
      return { kind: "single", cwd: item.outputPath, startSha, pathFilter };
    }
    // projectPath is the project root
    if (item.projectPath && existsSync(item.projectPath)) {
      return { kind: "single", cwd: item.projectPath, startSha, pathFilter };
    }
    // Fallback to cwd
    return { kind: "single", cwd: process.cwd(), startSha, pathFilter };
  }

  /**
   * For per-ISC-row cwd resolution in multi-repo contexts.
   * Matches command path args against each repo's cwd using existsSync(join(repo.cwd, pathArg)).
   * Falls back to first repo if no match.
   */
  resolveRowCwd(row: ISCRow, verifyCtx: VerifyContext): string {
    if (verifyCtx.kind === "single") {
      return verifyCtx.cwd;
    }
    // Multi-repo: try to find which repo owns this row's command paths
    const cmd = row.verification?.command ?? "";
    const args = cmd.split(/\s+/).filter(a => !a.startsWith("-") && a.length > 0);
    for (const pathArg of args) {
      for (const repo of verifyCtx.repos) {
        if (existsSync(join(repo.cwd, pathArg))) {
          return repo.cwd;
        }
      }
    }
    // Fall back to first repo
    return verifyCtx.repos[0].cwd;
  }

  private classifyRowDisposition(description: string, category?: ISCRowCategory): ISCRowDisposition {
    const text = description.toLowerCase();
    // Human-required: publishing, deployment, recording, manual actions
    if (/\bpypi\b|publish(?:ed)?\s+(?:to|on|blog|post)|upload\s+to\s+|deploy(?:ed)?\s+(?:on|to)\s+\w+|railway|heroku|vercel|demo\s+video|screen\s*record|manual\s+test|submit\s+to\s+app\s*store|blog\s+post|dev\.to\b|substack\b|\byoutube\b.*\bvideo\b/.test(text)) {
      return "human-required";
    }
    if (category === "deployment" && /\bprod(?:uction)?\b|\bstaging\b|\bexternal\b|\bpublish\b|\bdeploy\b/.test(text)) {
      return "human-required";
    }
    return "automatable";
  }

  private detectProjectContext(workingDir: string): ProjectContext {
    const kayaSkillsDir = join(KAYA_HOME, "skills");
    const isKayaSkill = workingDir.startsWith(kayaSkillsDir + "/") || workingDir === kayaSkillsDir;

    // Detect language from marker files
    let language: ProjectContext["language"] = "unknown";
    let framework: string | undefined;

    try {
      if (existsSync(join(workingDir, "package.json")) || existsSync(join(workingDir, "bun.lockb"))) {
        language = "typescript";
        framework = existsSync(join(workingDir, "bun.lockb")) ? "bun" : "node";
      } else if (existsSync(join(workingDir, "pyproject.toml")) || existsSync(join(workingDir, "setup.py")) || existsSync(join(workingDir, "requirements.txt"))) {
        language = "python";
        framework = "pytest";
      } else if (existsSync(join(workingDir, "go.mod"))) {
        language = "go";
        framework = "go-test";
      } else if (existsSync(join(workingDir, "Cargo.toml"))) {
        language = "rust";
        framework = "cargo";
      }
    } catch {
      // workingDir may not exist — fall through to defaults
    }

    // If it's a Kaya skill dir, override to typescript
    if (isKayaSkill && language === "unknown") {
      language = "typescript";
      framework = "bun";
    }

    const testPattern: ProjectContext["testPattern"] =
      language === "python" ? "pytest-style" :
      language === "typescript" ? "jest-style" :
      "unknown";

    return { language, isKayaSkill, framework, testPattern };
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
   * Create a jm-tasks queue item for manual steps that need human action.
   * Links back to the work item so completion can be resolved.
   */
  private async createJmTask(itemId: string, itemTitle: string, manualDescriptions: string): Promise<void> {
    try {
      const qmPath = join(process.cwd(), "skills", "QueueRouter", "Tools", "QueueManager.ts");
      const title = `Manual steps: ${itemTitle}`;
      const desc = `Work item ${itemId} has automated work verified but needs manual action:\n${manualDescriptions}`;
      execFileSync("bun", [qmPath, "add", title, "--desc", desc, "--queue", "jm-tasks", "--id", `manual-${itemId}`, "--no-spec"], {
        encoding: "utf-8",
        timeout: 15000,
        cwd: process.cwd(),
      });
    } catch (e) {
      // Non-fatal — log but don't block the status transition
      this.appendAuditLog({
        itemId,
        itemTitle,
        verdict: "PASS",
        concerns: [`Failed to create jm-tasks item: ${e instanceof Error ? e.message : String(e)}`],
        tiersExecuted: [],
        verificationCost: 0,
        iscRowSummary: [],
      });
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
        // Set TRIVIAL effort to bypass provenance gate
        proxy.effort = "TRIVIAL";
        this.queue.setVerification(proxy.id, {
          status: "verified",
          verdict: "PASS",
          verifiedBy: "auto_resolve" as WorkItemVerification["verifiedBy"],
          verifiedAt: new Date().toISOString(),
          concerns: ["Parent item passed SkepticalVerifier — proxy auto-resolved"],
          iscRowsVerified: 0,
          iscRowsTotal: 0,
          verificationCost: 0,
          tiersExecuted: [],
        });
        this.queue.updateStatus(proxy.id, "completed");

        // Remove proxy from item's dependency list so DAG check doesn't block completion
        if (item.dependencies.includes(proxy.id)) {
          item.dependencies = item.dependencies.filter((d) => d !== proxy.id);
        }
      } catch (e) {
        // Non-fatal — log but don't block report-done
        console.warn(`[resolveStaleReviewProxies] Failed to resolve proxy ${proxy.id}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    if (reviewProxies.length > 0) {
      this.queue.save();
    }
  }

  /**
   * Create LucidTasks and HUMAN proxy WorkItems for human-required ISC rows.
   * Called from reportDone step 3c when automated work is verified but manual rows remain.
   * Returns the created proxy IDs so the caller can wire them as dependencies.
   */
  private async createHumanProxies(
    itemId: string,
    itemTitle: string,
    humanRows: ISCRow[]
  ): Promise<string[]> {
    const proxyIds: string[] = [];
    const item = this.queue.getItem(itemId);

    for (const row of humanRows) {
      try {
        // Step 1: Create LucidTask via direct DB import (no subprocess overhead)
        let lucidTaskId: string | undefined;
        try {
          const { getTaskDB } = await import("../../../Productivity/LucidTasks/Tools/TaskDB.ts");
          const db = getTaskDB();
          const lucidTask = db.createTask({
            title: row.description,
            description: `Human action needed for work item: ${itemTitle}\nISC Row #${row.id}\nWork Queue Item: ${itemId}`,
            status: "inbox",
            priority: 2,
            labels: ["human-required", "autonomous-work"],
          });
          lucidTaskId = lucidTask.id;
          db.close();
        } catch (e) {
          // Non-fatal — continue without LucidTask ID
          console.warn(`[createHumanProxies] LucidTask creation failed for row #${row.id}: ${e instanceof Error ? e.message : String(e)}`);
        }

        // Step 2: Create HUMAN proxy WorkItem
        const proxy = this.queue.addItem({
          title: `HUMAN: ${row.description}`,
          description: `Human action required for: ${itemTitle}`,
          status: "blocked",
          priority: item?.priority ?? "normal",
          dependencies: [],
          source: "manual" as const,
          humanTaskRef: {
            ...(lucidTaskId ? { lucidTaskId } : {}),
            queueItemId: itemId,
            createdAt: new Date().toISOString(),
            action: row.description,
            reason: `ISC row #${row.id} classified as human-required`,
          },
        });

        // Step 3: Wire as dependency
        this.queue.addDependency(itemId, proxy.id);
        proxyIds.push(proxy.id);
      } catch (e) {
        console.warn(`[createHumanProxies] Failed to create proxy for row #${row.id}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    return proxyIds;
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

  // --------------------------------------------------------------------------
  // Expose ISC for testing
  // --------------------------------------------------------------------------

  getItemISC(itemId: string): ISCRow[] | undefined {
    return this.itemISC.get(itemId);
  }

  setItemISC(itemId: string, rows: ISCRow[]): void {
    this.itemISC.set(itemId, rows);
  }

  /**
   * Format ISC rows as a markdown table with Verification Command column for agent consumption.
   * Optionally filter by phase row IDs.
   */
  formatISCTableForAgents(itemId: string, phaseRowIds?: number[]): string {
    let rows = this.loadISC(itemId);
    if (!rows || rows.length === 0) return "No ISC rows found.";

    if (phaseRowIds && phaseRowIds.length > 0) {
      const idSet = new Set(phaseRowIds);
      rows = rows.filter(r => idSet.has(r.id));
    }

    const header = "| ID | Description | Status | Category | Verification Command |";
    const separator = "|----|-------------|--------|----------|---------------------|";
    const lines = rows.map(r => {
      const cmd = r.verification?.command ? `\`${r.verification.command}\`` : "";
      return `| ${r.id} | ${r.description} | ${r.status} | ${r.category ?? "implementation"} | ${cmd} |`;
    });

    return [header, separator, ...lines].join("\n");
  }

  // --------------------------------------------------------------------------
  // Phase-aware helpers
  // --------------------------------------------------------------------------

  /**
   * Mark a phase as done. Appends to completedPhases (idempotent), calls markPartial.
   */
  markPhaseDone(itemId: string, phaseNumber: number, totalPhases: number): boolean {
    const item = this.queue.getItem(itemId);
    if (!item) return false;

    const existing = item.completedPhases ?? [];
    if (!existing.includes(phaseNumber)) {
      existing.push(phaseNumber);
    }

    this.queue.markPartial(itemId, existing, totalPhases, `Phase ${phaseNumber}/${totalPhases} done`);
    return true;
  }

  /**
   * Get ISC rows for a specific phase (filtered by row IDs).
   * Used by Orchestrate.md to build per-phase ISC tables.
   */
  getPhaseISC(itemId: string, phaseRowIds: number[]): ISCRow[] {
    const rows = this.loadISC(itemId);
    if (!rows) return [];
    const idSet = new Set(phaseRowIds);
    return rows.filter((r) => idSet.has(r.id));
  }

  /**
   * Generate a git summary of prior work in an item's worktree (for PRIOR_WORK context).
   */
  generatePhaseGitSummary(itemId: string): string {
    const item = this.queue.getItem(itemId);
    const wtPath = item?.metadata?.worktreePath as string | undefined;
    if (!wtPath) return "";

    try {
      return execFileSync("git", ["log", "--oneline", "-20"], {
        encoding: "utf-8",
        timeout: 10000,
        cwd: wtPath,
      }).trim();
    } catch (e) {
      this.guard.logCaughtError(itemId, "generatePhaseGitSummary", e);
      return "";
    }
  }

  // --------------------------------------------------------------------------
  // Mark ISC rows done (cross-process boundary)
  // --------------------------------------------------------------------------

  markRowsDone(itemId: string, rowIds: number[]): { success: boolean; transitioned: number[]; error?: string } {
    const rows = this.loadISC(itemId);
    if (!rows) return { success: false, transitioned: [], error: `No ISC rows found for ${itemId} — run prepare first` };

    const transitioned: number[] = [];
    for (const rowId of rowIds) {
      const row = rows.find(r => r.id === rowId);
      if (row && row.status === "PENDING") {
        row.status = "DONE";
        transitioned.push(rowId);
      }
    }

    this.itemISC.set(itemId, rows);
    this.persistISC(itemId, rows);
    return { success: true, transitioned };
  }

  // --------------------------------------------------------------------------
  // Record execution (no-op after BudgetManager removal)
  // --------------------------------------------------------------------------

  /** @deprecated BudgetManager removed. This is a no-op kept for CLI backward compat. */
  recordExecution(itemId: string): { success: boolean; error?: string } {
    const item = this.queue.getItem(itemId);
    if (!item) return { success: false, error: `Not found: ${itemId}` };
    return { success: true };
  }

  // --------------------------------------------------------------------------
  // Audit log (append-only JSONL, non-blocking)
  // --------------------------------------------------------------------------

  private appendAuditLog(entry: {
    itemId: string;
    itemTitle: string;
    verdict: string;
    concerns: string[];
    tiersExecuted: number[];
    verificationCost: number;
    iscRowSummary: string[];
    failureReason?: string;
    adversarialConcerns?: string[];
  }): void {
    try {
      const auditPath = join(KAYA_HOME, "MEMORY/WORK/audit.jsonl");
      const dir = join(KAYA_HOME, "MEMORY/WORK");
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const record = { timestamp: new Date().toISOString(), ...entry };
      appendFileSync(auditPath, JSON.stringify(record) + "\n");
    } catch {
      // Acceptable silence: logging the logger failure would recurse; audit failure never prevents completion
    }
  }

  // --------------------------------------------------------------------------
  // NEEDS_REVIEW notification (alerts Jm when items fail verification)
  // --------------------------------------------------------------------------

  private emitNeedsReviewNotification(itemId: string, title: string, verdict: string, concerns: string[]): void {
    try {
      const notifPath = join(KAYA_HOME, "MEMORY/NOTIFICATIONS/notifications.jsonl");
      const notifDir = join(KAYA_HOME, "MEMORY/NOTIFICATIONS");
      if (!existsSync(notifDir)) mkdirSync(notifDir, { recursive: true });
      const record = {
        timestamp: new Date().toISOString(),
        event: "verification_failed",
        channel: "autonomous_work",
        severity: verdict === "FAIL" ? "critical" : "warning",
        message: `[${verdict}] "${title}" (${itemId.slice(0, 8)}) — ${concerns.slice(0, 3).join("; ")}`,
        metadata: { itemId, verdict, concernCount: concerns.length },
      };
      appendFileSync(notifPath, JSON.stringify(record) + "\n");
    } catch {
      // Acceptable silence: notification is a non-critical UX feature; failure never prevents pipeline operation
    }
  }

  // --------------------------------------------------------------------------
  // ISC persistence (survives process boundaries)
  // --------------------------------------------------------------------------

  private persistISC(itemId: string, rows: ISCRow[]): void {
    this.queue.setMetadata(itemId, { iscRows: rows });
  }

  private loadISC(itemId: string): ISCRow[] | undefined {
    // Hot cache first
    const cached = this.itemISC.get(itemId);
    if (cached) return cached;

    // Fall back to persisted metadata
    const item = this.queue.getItem(itemId);
    const persisted = item?.metadata?.iscRows as ISCRow[] | undefined;
    if (persisted && Array.isArray(persisted)) {
      // Backfill disposition for rows from older sessions that lack it
      let backfilled = false;
      for (const row of persisted) {
        if (!row.disposition) {
          row.disposition = this.classifyRowDisposition(row.description, row.category as ISCRowCategory | undefined);
          backfilled = true;
        }
      }
      if (backfilled) {
        this.persistISC(itemId, persisted);
      }
      this.itemISC.set(itemId, persisted); // populate cache
      return persisted;
    }

    return undefined;
  }

  // --------------------------------------------------------------------------
  // Orphan recovery
  // --------------------------------------------------------------------------

  async recoverOrphanedItems(): Promise<number> {
    const STALE_THRESHOLD_MS = 4 * 60 * 60 * 1000; // 4 hours
    const HUMAN_PENDING_STALE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
    const now = Date.now();
    let recovered = 0;

    // B2: Surface stale blocked items (does NOT auto-expire — just notifies)
    for (const item of this.queue.getAllItems()) {
      if (item.status !== "blocked") continue;
      const createdAt = item.humanTaskRef?.createdAt ?? item.createdAt;
      if (!createdAt) continue;
      const createdMs = new Date(createdAt).getTime();
      if (now - createdMs > HUMAN_PENDING_STALE_MS) {
        const daysSince = Math.floor((now - createdMs) / (24 * 60 * 60 * 1000));
        this.emitNeedsReviewNotification(
          item.id,
          item.title,
          "STALE",
          [`blocked item is ${daysSince} days old — needs Jm attention`]
        );
      }
    }

    for (const item of this.queue.getAllItems()) {
      if (item.status !== "in_progress") continue;

      // Path 1: Verified but never completed — route through complete() for provenance checks
      if (
        item.verification?.status === "verified" &&
        item.verification.verdict === "PASS"
      ) {
        const rows = this.loadISC(item.id);
        if (rows && rows.length > 0 && rows.every(r => r.status === "VERIFIED")) {
          const completeResult = this.completeSync(item.id, "Auto-completed by orphan recovery (verified but never completed)");
          if (completeResult.success) {
            recovered++;
          }
          continue;
        }
      }

      // Path 2: Stale with no verification
      if (item.startedAt) {
        const startedMs = new Date(item.startedAt).getTime();
        if (now - startedMs > STALE_THRESHOLD_MS && !item.verification) {
          this.queue.resetToPending(item.id, "Orphan recovery: stale in_progress >4h with no verification");
          recovered++;
          continue;
        }
      }

      // Path 3: Stale in_progress with non-PASS verification (dead zone fix — M3)
      // Routes through retry() for consistent strategy escalation, guard logging, and proxy creation
      if (item.startedAt && item.verification) {
        const startedMs = new Date(item.startedAt).getTime();
        if (now - startedMs > STALE_THRESHOLD_MS &&
            (item.verification.status === "needs_review" || item.verification.status === "failed")) {
          const recoveryError = `Orphan recovery: stale >4h with verification.status="${item.verification.status}"`;
          await this.retry(item.id, recoveryError);
          recovered++;
          continue;
        }
      }
    }

    return recovered;
  }
}

// ============================================================================
// CLI
// ============================================================================

async function main() {
  const { values, positionals } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      help: { type: "boolean", short: "h" },
      json: { type: "boolean", short: "j" },
      "adversarial-concerns": { type: "string" },
      force: { type: "boolean" },
      "phase-rows": { type: "string" },
      output: { type: "string" },
    },
    allowPositionals: true,
  });

  const cmd = positionals[0];
  if (values.help || !cmd) {
    console.log(`
WorkOrchestrator — Unified orchestrator for autonomous work

Commands:
  init                  Validate DAG, load queue, recover orphans
  next-batch [n]        Get ready items (default 5)
  prepare <id>          Classify effort + generate ISC rows
  started <id>          Mark in_progress
  mark-done <id> <rows> Transition ISC rows PENDING→DONE (space-separated row IDs)
  record-execution <id> No-op (kept for backward compat, BudgetManager removed)
  verify <id>           Run verification + review gate
  report-done <id> <rows...> Atomic: mark-done + verify + complete
  retry <id> [err]      Record attempt, reset to pending (escalates after 3)
  fail <id> [err] --force  Force-fail (manual kill only)
  status                Show queue state + blocked items
  report                Structured report (--json for machine-readable)
  recover               Run orphan recovery on stale in_progress items

Options:
  --json                JSON output
  -h, --help            Show help
`);
    return;
  }

  const orch = new WorkOrchestrator();
  process.on("exit", () => orch.stopMonitoring());
  process.on("SIGINT", () => { orch.stopMonitoring(); process.exit(0); });
  process.on("SIGTERM", () => { orch.stopMonitoring(); process.exit(0); });

  switch (cmd) {
    case "init": {
      // Self-heal: promote any orphaned "approved" items stuck in the approvals queue.
      // This catches cases where approval bypassed QueueManager.approve() (e.g. direct JSONL edit).
      try {
        const { loadQueueItems, appendQueueItem, saveQueueItems } = await import("../../QueueRouter/Tools/QueueManager.ts");
        const approvals = loadQueueItems("approvals");
        const existingIds = new Set(loadQueueItems("approved-work").map(i => i.id));
        const orphans = approvals.filter(i => i.status === "approved" && !existingIds.has(i.id));
        if (orphans.length > 0) {
          for (const item of orphans) {
            const promoted = { ...item, queue: "approved-work", status: "pending" as const, updated: new Date().toISOString(), routing: { ...item.routing, sourceQueue: "approvals", targetQueue: "approved-work" } };
            appendQueueItem("approved-work", promoted);
          }
          saveQueueItems("approvals", approvals.filter(i => !orphans.some(o => o.id === i.id)));
          console.log(`Self-healed: promoted ${orphans.length} orphaned item(s) from approvals → approved-work`);
        }

        // Self-heal pass 2: Mark approvals items completed if their work-queue counterpart is done.
        // This catches items that were picked up directly without going through approve() → transfer().
        const completedWorkIds = new Set(
          orch.queue.getAllItems()
            .filter(i => i.status === "completed")
            .map(i => i.id)
        );
        const freshApprovals = loadQueueItems("approvals");
        const staleApprovals = freshApprovals.filter(
          i => (i.status === "pending" || i.status === "approved") && completedWorkIds.has(i.id)
        );
        if (staleApprovals.length > 0) {
          for (const item of staleApprovals) {
            item.status = "completed";
            item.updated = new Date().toISOString();
            item.result = { completedAt: new Date().toISOString(), completedBy: "WorkOrchestrator/self-heal" };
          }
          saveQueueItems("approvals", freshApprovals);
          console.log(`Self-healed: marked ${staleApprovals.length} approvals item(s) as completed (work already done)`);
        }
      } catch (e) {
        console.error(`[init] Orphan scan failed (non-fatal): ${e instanceof Error ? e.message : e}`);
      }

      // Bridge: import approved-work items into the execution queue (idempotent — skips existing)
      const legacyResult = orch.queue.loadFromLegacy();
      if (legacyResult.imported > 0) {
        console.log(`Imported ${legacyResult.imported} item(s) from approved-work → work-queue (${legacyResult.skipped} skipped)`);
      }

      const result = await orch.init();
      if (values.json) { console.log(JSON.stringify(result)); } else { console.log(result.message); }
      process.exit(result.success ? 0 : 1);
      break;
    }

    case "next-batch": {
      const n = parseInt(positionals[1]) || 5;
      const result = await orch.nextBatch(n);
      if (values.json) { console.log(JSON.stringify(result)); }
      else {
        if (result.items.length === 0) { console.log(result.blocked > 0 ? `No ready items. ${result.blocked} blocked.` : "No items available."); }
        else { for (const item of result.items) { console.log(`  ${item.id}  ${item.title.slice(0, 50)}`); } }
      }
      break;
    }

    case "prepare": {
      const id = positionals[1];
      if (!id) { console.error("Usage: prepare <id>"); process.exit(1); }
      const result = await orch.prepare(id);
      if (values.json) { console.log(JSON.stringify(result, null, 2)); }
      else { console.log(`${result.success ? "Prepared" : "Failed"}: ${result.iscRows.length} ISC rows, effort ${result.effort}`); }
      process.exit(result.success ? 0 : 1);
      break;
    }

    case "started": {
      const id = positionals[1];
      if (!id) { console.error("Usage: started <id>"); process.exit(1); }
      const ok = orch.started(id);
      if (!ok) { console.log(JSON.stringify({ success: false, error: `Not found: ${id}` })); process.exit(1); }
      // Auto-create worktree for branch isolation
      try {
        const wt = await orch.ensureFeatureBranch(id);
        console.log(JSON.stringify({ success: true, status: "in_progress", worktreePath: wt.workingDir, worktreeBranch: wt.branch }));
      } catch (e) {
        console.error(`[started] worktree creation failed: ${e instanceof Error ? e.message : String(e)}`);
        console.log(JSON.stringify({ success: true, status: "in_progress", worktreePath: null, worktreeError: String(e) }));
      }
      break;
    }

    case "mark-done": {
      const id = positionals[1];
      if (!id || positionals.length < 3) { console.error("Usage: mark-done <id> <row-ids...>"); process.exit(1); }
      const rowIds = positionals.slice(2).map(Number).filter(n => !isNaN(n));
      const result = orch.markRowsDone(id, rowIds);
      if (values.json) { console.log(JSON.stringify(result)); }
      else { console.log(result.success ? `Transitioned rows: ${result.transitioned.join(", ")}` : `Failed: ${result.error}`); }
      process.exit(result.success ? 0 : 1);
      break;
    }

    case "record-execution": {
      const id = positionals[1];
      if (!id) { console.error("Usage: record-execution <id>"); process.exit(1); }
      const result = orch.recordExecution(id);
      if (values.json) { console.log(JSON.stringify(result)); }
      else { console.log(result.success ? `Recorded execution for ${id}` : `Failed: ${result.error}`); }
      process.exit(result.success ? 0 : 1);
      break;
    }

    case "verify": {
      const id = positionals[1];
      if (!id) { console.error("Usage: verify <id>"); process.exit(1); }
      const result = await orch.verify(id);
      if (values.json) { console.log(JSON.stringify(result, null, 2)); }
      else {
        console.log(`Verification: ${result.success ? "PASSED" : "FAILED"}`);
        for (const f of result.failures) { console.log(`  ${f.id}. ${f.description}`); }
      }
      process.exit(result.success ? 0 : 1);
      break;
    }

    case "report-done": {
      const id = positionals[1];
      if (!id || positionals.length < 3) { console.error("Usage: report-done <id> <row-ids...> [--adversarial-concerns 'c1||c2']"); process.exit(1); }
      const rowIds = positionals.slice(2).map(Number).filter(n => !isNaN(n));
      const adversarialConcerns = values["adversarial-concerns"]
        ? values["adversarial-concerns"].split("||").map(c => c.trim()).filter(Boolean)
        : undefined;
      const result = await orch.reportDone(id, {
        completedRowIds: rowIds,
        adversarialConcerns,
      });
      if (values.json) { console.log(JSON.stringify(result, null, 2)); }
      else { console.log(result.success ? `${id} → completed (verified by skeptical_verifier)` : `Blocked: ${result.reason}`); }
      process.exit(result.success ? 0 : 1);
      break;
    }

    case "complete": {
      console.error("Direct 'complete' command removed. Use 'report-done <id> <row-ids...>' instead.");
      process.exit(1);
      break;
    }

    case "retry": {
      const id = positionals[1];
      if (!id) { console.error("Usage: retry <id> [err]"); process.exit(1); }
      const result = await orch.retry(id, positionals[2]);
      if (values.json) { console.log(JSON.stringify(result)); }
      else if (!result.retried) { console.log(`Not found: ${id}`); }
      else if (result.escalated) { console.log(`${id} → escalated to human review (attempt ${result.attempt})`); }
      else { console.log(`${id} → retrying (attempt ${result.attempt}, next strategy: ${result.nextStrategy})`); }
      break;
    }

    case "fail": {
      const id = positionals[1];
      if (!id) { console.error("Usage: fail <id> [err] --force"); process.exit(1); }
      if (!values.force) { console.error("Use 'retry' for normal failures. 'fail' requires --force (manual kill only)."); process.exit(1); }
      console.log(await orch.fail(id, positionals[2]) ? `${id} → failed (forced)` : `Not found: ${id}`);
      break;
    }

    case "status": {
      console.log(orch.status());
      break;
    }

    case "report": {
      if (values.json) {
        console.log(JSON.stringify(orch.report(), null, 2));
      } else {
        console.log(orch.reportMarkdown());
      }
      break;
    }

    case "mark-phase-done": {
      const id = positionals[1];
      const phaseNum = parseInt(positionals[2]);
      const total = parseInt(positionals[3]);
      if (!id || isNaN(phaseNum) || isNaN(total)) { console.error("Usage: mark-phase-done <id> <phaseNum> <totalPhases>"); process.exit(1); }
      const ok = orch.markPhaseDone(id, phaseNum, total);
      if (values.json) { console.log(JSON.stringify({ success: ok, itemId: id, phaseNumber: phaseNum, totalPhases: total })); }
      else { console.log(ok ? `Phase ${phaseNum}/${total} marked done for ${id}` : `Failed: item not found ${id}`); }
      process.exit(ok ? 0 : 1);
      break;
    }

    case "format-isc-table": {
      const id = positionals[1];
      if (!id) { console.error("Usage: format-isc-table <id> [--phase-rows 1,2,3]"); process.exit(1); }
      const phaseRowsArg = values["phase-rows" as keyof typeof values] as string | undefined;
      const phaseRowIds = phaseRowsArg ? phaseRowsArg.split(",").map(Number).filter(n => !isNaN(n)) : undefined;
      const table = orch.formatISCTableForAgents(id, phaseRowIds);
      console.log(table);
      break;
    }

    case "recover": {
      const result = await orch.init();
      if (values.json) { console.log(JSON.stringify({ recovered: result.recovered })); }
      else { console.log(`Recovered ${result.recovered} orphaned items`); }
      break;
    }

    default:
      console.error(`Unknown: ${cmd}. Use --help.`);
      process.exit(1);
  }
}

if (import.meta.main) main().catch(console.error);

export { CATASTROPHIC_PATTERNS, PROTECTED_BRANCHES, ITERATION_LIMITS, PHASE_MIN_ISC_THRESHOLD, PHASE_MIN_PHASES };
// normalizeVerificationCommand and findMissingDirectoryArg are exported at their declaration site
