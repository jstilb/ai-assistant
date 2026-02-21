#!/usr/bin/env bun
/**
 * WorkOrchestrator.ts - Unified orchestrator for autonomous work
 *
 * Single replacement for ExecutiveOrchestrator (989 lines),
 * ItemOrchestrator (1,686 lines), and UnblockingOrchestrator (~650 lines).
 *
 * Keeps: catastrophic detection, verification pipeline with command allowlist,
 * ISC generation from specs, effort classification, spotcheck, prior work summary,
 * feature branch creation, budget delegation.
 *
 * Cuts: per-item state files, multi-phase promotion, 16 FM-patches,
 * bidirectional spec sync, auto-unblocking, display layer.
 *
 * Usage:
 *   bun run WorkOrchestrator.ts init                  # Validate DAG, init budget, load queue
 *   bun run WorkOrchestrator.ts next-batch [n]        # Get ready items from WorkQueue
 *   bun run WorkOrchestrator.ts prepare <id>          # Classify effort + generate ISC rows
 *   bun run WorkOrchestrator.ts started <id>          # Mark in_progress
 *   bun run WorkOrchestrator.ts verify <id>           # Run verification + skeptical review gate
 *   bun run WorkOrchestrator.ts mark-done <id> <rows>  # Transition ISC rows PENDING→DONE
 *   bun run WorkOrchestrator.ts record-execution <id>  # Record iteration (+ optional --budget spend)
 *   bun run WorkOrchestrator.ts complete <id>         # Mark completed (only after verify passes)
 *   bun run WorkOrchestrator.ts fail <id> [err]       # Mark failed with reason
 *   bun run WorkOrchestrator.ts status                # Show queue state + budget + blocked items
 */

import { parseArgs } from "util";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { execFileSync } from "child_process";
import { WorkQueue, type WorkItem, type WorkItemVerification, type EffortLevel, type Priority } from "./WorkQueue.ts";
import { BudgetManager } from "./BudgetManager.ts";
import { SkepticalVerifier, type ItemReviewSummary, type SkepticalReviewResult } from "./SkepticalVerifier.ts";
import { inferCategory, type ISCCriterion } from "./SpecParser.ts";

// ============================================================================
// Types
// ============================================================================

export type ISCRowCategory =
  | "implementation"   // Core code work
  | "testing"          // Tests and validation
  | "documentation"    // SKILL.md, README, docs updates
  | "deployment"       // launchd, config deployment, system-level actions
  | "cleanup";         // Config removal, deprecated file markers, legacy references

export interface ISCRow {
  id: number;
  description: string;
  status: "PENDING" | "DONE" | "VERIFIED" | "EXECUTION_FAILED";
  category?: ISCRowCategory;
  capability?: string;
  parallel: boolean;
  source?: "EXPLICIT" | "INFERRED" | "IMPLICIT";
  specSection?: string;
  /** True when spec exists but parseSpec returned empty ISC, forcing template fallback */
  specFallback?: boolean;
  verification?: {
    method: string;
    command?: string;
    success_criteria: string;
    result?: "PASS" | "FAIL";
  };
}

export interface PrepareResult {
  success: boolean;
  effort: EffortLevel;
  iscRows: ISCRow[];
  budget: { allocated: number };
  maxIterations: number;
  error?: string;
}

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
const THEALGORITHM_TOOLS = join(KAYA_HOME, "skills/THEALGORITHM/Tools");

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

const BUDGET_ALLOCATION: Record<EffortLevel, number> = {
  TRIVIAL: 0.1, QUICK: 1, STANDARD: 10, THOROUGH: 50, DETERMINED: 200,
};

// Allowlist for verification commands
const ALLOWED_EXECUTABLES = new Set([
  "bun", "node", "npx", "grep", "rg", "test", "diff", "wc", "jq", "ls", "cat", "head", "tail",
]);
const SAFE_GIT_SUBCOMMANDS = new Set([
  "diff", "log", "show", "status", "rev-parse", "merge-base",
]);

// ============================================================================
// WorkOrchestrator Class
// ============================================================================

export class WorkOrchestrator {
  private queue: WorkQueue;
  private budget: BudgetManager;
  private verifier: SkepticalVerifier;
  /** In-memory ISC state per item (no per-item state files) */
  private itemISC: Map<string, ISCRow[]> = new Map();

  constructor(queue?: WorkQueue, budget?: BudgetManager, verifier?: SkepticalVerifier) {
    this.queue = queue ?? new WorkQueue();
    this.budget = budget ?? new BudgetManager();
    this.verifier = verifier ?? new SkepticalVerifier();
  }

  /** DI constructor for tests — no filesystem, SkepticalVerifier stubbed by default */
  static _createForTesting(queue: WorkQueue, budget?: BudgetManager, opts?: { verifierResult?: SkepticalReviewResult }): WorkOrchestrator {
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
    const orch = new WorkOrchestrator(queue, budget ?? new BudgetManager("/dev/null"), mockVerifier);
    orch.getGitDiffStat = () => "1 file changed, 10 insertions(+)";
    return orch;
  }

  // --------------------------------------------------------------------------
  // Init
  // --------------------------------------------------------------------------

  init(totalBudget: number = 100): { success: boolean; message: string; ready: number; blocked: number; recovered: number } {
    this.queue.wirePhaseDependencies();
    const validation = this.queue.validate();
    if (!validation.valid) {
      return { success: false, message: `DAG invalid: ${validation.errors[0]}`, ready: 0, blocked: 0, recovered: 0 };
    }
    this.budget.initQueue(totalBudget);
    const recovered = this.recoverOrphanedItems();
    const stats = this.queue.getStats();
    const recoveredMsg = recovered > 0 ? `, ${recovered} recovered` : "";
    return {
      success: true,
      message: `Initialized: ${stats.ready} ready, ${stats.blocked} blocked, $${totalBudget} budget${recoveredMsg}`,
      ready: stats.ready,
      blocked: stats.blocked,
      recovered,
    };
  }

  // --------------------------------------------------------------------------
  // Next-batch
  // --------------------------------------------------------------------------

  nextBatch(max: number = 5): { items: WorkItem[]; blocked: number } {
    const items = this.queue.getParallelBatch(max);
    const blocked = this.queue.getBlockedItems().length;
    return { items, blocked };
  }

  // --------------------------------------------------------------------------
  // Prepare: effort classification + ISC generation
  // --------------------------------------------------------------------------

  async prepare(itemId: string, effortOverride?: EffortLevel): Promise<PrepareResult> {
    const item = this.queue.getItem(itemId);
    if (!item) return { success: false, effort: "STANDARD", iscRows: [], budget: { allocated: 10 }, maxIterations: 10, error: `Not found: ${itemId}` };

    // Classify effort (use override if provided, e.g. from tests)
    const effort = effortOverride ?? this.classifyEffort(item);
    this.queue.setEffort(itemId, effort);
    this.budget.initItem(itemId, effort);

    // Generate ISC rows
    const rows = this.generateISC(item, effort);
    this.itemISC.set(itemId, rows);
    this.persistISC(itemId, rows);

    return {
      success: true,
      effort,
      iscRows: rows,
      budget: { allocated: BUDGET_ALLOCATION[effort] },
      maxIterations: ITERATION_LIMITS[effort],
    };
  }

  // --------------------------------------------------------------------------
  // Status transitions
  // --------------------------------------------------------------------------

  started(itemId: string): boolean {
    const item = this.queue.updateStatus(itemId, "in_progress");
    return item !== null;
  }

  async complete(itemId: string, result?: string): Promise<{ success: boolean; reason?: string }> {
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

    // COST GATE: STANDARD+ effort must have Tier 2 inference
    if (effort === "STANDARD" || effort === "THOROUGH" || effort === "DETERMINED") {
      if (item.verification.verificationCost === 0 && item.verification.tiersExecuted && !item.verification.tiersExecuted.includes(2)) {
        return { success: false, reason: `Completion blocked: STANDARD+ effort requires Tier 2 inference but verificationCost is $0 and Tier 2 not in tiersExecuted.` };
      }
    }

    // SECONDARY GATE (defense in depth): ISC check if available (in-memory or persisted)
    const rows = this.loadISC(itemId);
    if (rows) {
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
        const specContent = this.readSpecContent(item.specPath);
        if (specContent) {
          try {
            const { parseSpec } = require("./SpecParser.ts");
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

    const updated = this.queue.updateStatus(itemId, "completed", result);
    return updated ? { success: true } : { success: false, reason: `Failed to update: ${itemId}` };
  }

  async fail(itemId: string, error?: string): Promise<boolean> {
    const item = this.queue.updateStatus(itemId, "failed", error);
    await this.cleanupWorktree(itemId);
    return item !== null;
  }

  // --------------------------------------------------------------------------
  // Verify: run verification commands + spotcheck
  // --------------------------------------------------------------------------

  async verify(itemId: string): Promise<{ success: boolean; failures: ISCRow[]; skepticalReview?: SkepticalReviewResult }> {
    const item = this.queue.getItem(itemId);
    if (!item) return { success: false, failures: [{ id: -1, description: "Item not found", status: "EXECUTION_FAILED", parallel: false }] };

    const rows = this.loadISC(itemId);
    if (!rows) return { success: false, failures: [{ id: -1, description: "No ISC rows found — run prepare first", status: "EXECUTION_FAILED", parallel: false }] };

    // Step 1: Run verification commands on ISC rows (local checks)
    const localFailures: ISCRow[] = [];
    for (const row of rows) {
      if (row.status === "DONE") {
        if (row.verification) {
          // Always re-run — never trust pre-set results
          row.verification.result = this.runVerificationCommand(row) ? "PASS" : "FAIL";
          if (row.verification.result !== "PASS") {
            localFailures.push(row);
          }
        } else {
          // DONE without verification object cannot auto-promote
          localFailures.push(row);
        }
      } else if (row.status === "VERIFIED") {
        // Already verified — honor
      } else {
        // PENDING, EXECUTION_FAILED — all failures
        localFailures.push(row);
      }
    }

    // Local failures short-circuit before running SkepticalVerifier
    if (localFailures.length > 0) {
      return { success: false, failures: localFailures };
    }

    // Step 2: Build summary and run 3-tier skeptical review
    const gitDiffStat = this.getGitDiffStat();
    const itemBudget = this.budget.getItemBudget(itemId);
    const summary: ItemReviewSummary = {
      itemId,
      title: item.title,
      description: item.description,
      effort: item.effort || "STANDARD",
      priority: this.mapPriority(item.priority),
      specPath: item.specPath,
      specContent: item.specPath ? this.readSpecContent(item.specPath) : undefined,
      iscRows: rows.map(r => ({
        id: r.id,
        description: r.description,
        status: r.status,
        category: r.category,
        capability: r.capability,
        source: r.source,
        verification: r.verification ? {
          method: r.verification.method,
          result: r.verification.result,
          commandRan: r.verification.result !== undefined,
        } : undefined,
      })),
      gitDiffStat,
      executionLogTail: [],
      iterationsUsed: itemBudget?.iterations ?? 0,
      budgetSpent: itemBudget?.spent ?? 0,
      budgetAllocated: BUDGET_ALLOCATION[item.effort || "STANDARD"],
    };

    const review = await this.verifier.review(summary, this.budget);

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
      // Persist verification state to WorkItem (survives process boundaries)
      this.queue.setVerification(itemId, {
        status: "verified",
        verifiedAt: new Date().toISOString(),
        verdict: "PASS",
        concerns: review.concerns,
        iscRowsVerified: rows.filter(r => r.status === "VERIFIED").length,
        iscRowsTotal: rows.length,
        verificationCost: review.totalCost,
        verifiedBy: "skeptical_verifier",
        tiersExecuted: review.tiers.map(t => t.tier),
      });
      return { success: true, failures: [], skepticalReview: review };
    }

    // FAIL or NEEDS_REVIEW — persist failure state and report concerns
    this.queue.setVerification(itemId, {
      status: review.finalVerdict === "FAIL" ? "failed" : "needs_review",
      verifiedAt: new Date().toISOString(),
      verdict: review.finalVerdict,
      concerns: review.concerns,
      iscRowsVerified: rows.filter(r => r.status === "VERIFIED").length,
      iscRowsTotal: rows.length,
      verificationCost: review.totalCost,
      verifiedBy: "skeptical_verifier",
      tiersExecuted: review.tiers.map(t => t.tier),
    });
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
    const blocked = this.queue.getBlockedItems();
    const lines = [
      `Queue: ${s.total} total | ${s.ready} ready | ${s.inProgress} in-progress | ${s.completed} completed | ${s.failed} failed | ${s.blocked} blocked`,
    ];
    if (blocked.length > 0) {
      lines.push("Blocked:");
      for (const item of blocked) {
        const deps = item.dependencies.join(", ");
        lines.push(`  ${item.id} — ${item.title.slice(0, 40)} (waiting: ${deps})`);
      }
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
    const sanitizedId = itemId.slice(0, 8).replace(/[^a-zA-Z0-9-]/g, "");
    const featureBranch = `feature/work-${sanitizedId}`;

    try {
      const { getOrCreateWorktree } = await import("../../CORE/Tools/WorktreeManager.ts");
      const entry = await getOrCreateWorktree({
        repoRoot: process.cwd(),
        branch: featureBranch,
        createdBy: `orchestrator:${sanitizedId}`,
      });
      // Persist worktree path in item metadata for cleanup on complete/fail
      this.queue.setMetadata(itemId, { worktreePath: entry.path, worktreeBranch: featureBranch });
      return { branch: featureBranch, workingDir: entry.path };
    } catch {
      // Fallback: in-place checkout
      try {
        const currentBranch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf-8" }).trim();
        if (this.isProtectedBranch(currentBranch)) {
          execFileSync("git", ["checkout", "-b", featureBranch], { encoding: "utf-8" });
          return { branch: featureBranch, workingDir: process.cwd() };
        }
        return { branch: currentBranch, workingDir: process.cwd() };
      } catch {
        return { branch: "unknown", workingDir: process.cwd() };
      }
    }
  }

  // --------------------------------------------------------------------------
  // Worktree cleanup
  // --------------------------------------------------------------------------

  private async cleanupWorktree(itemId: string): Promise<void> {
    const item = this.queue.getItem(itemId);
    const wtPath = item?.metadata?.worktreePath as string | undefined;
    if (!wtPath) return;

    try {
      const { removeWorktree } = await import("../../CORE/Tools/WorktreeManager.ts");
      await removeWorktree(wtPath);
    } catch {
      // Non-blocking — worktree cleanup failure should not prevent completion
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
    try {
      const result = execFileSync(
        "bun", ["run", `${THEALGORITHM_TOOLS}/EffortClassifier.ts`, "--request", item.description, "--output", "json"],
        { encoding: "utf-8", timeout: 30000 },
      );
      const classification = JSON.parse(result);
      return (classification.effort as EffortLevel) || "STANDARD";
    } catch {
      return "STANDARD";
    }
  }

  // --------------------------------------------------------------------------
  // ISC generation
  // --------------------------------------------------------------------------

  private generateISC(item: WorkItem, effort: EffortLevel): ISCRow[] {
    // Strategy 1: spec-based generation
    if (item.specPath && existsSync(item.specPath)) {
      try {
        const { parseSpec } = require("./SpecParser.ts");
        const spec = parseSpec(item.specPath);
        if (spec.isc.length > 0) {
          return spec.isc.map((c: ISCCriterion, i: number) => ({
            id: i + 1,
            description: c.description,
            status: "PENDING" as const,
            category: inferCategory(c.description, c.source),
            parallel: false,
            source: this.normalizeSource(c.source) ?? "EXPLICIT" as const,
            verification: {
              method: c.embeddedCommand ? "command" : (c.verifyMethod || "inferred"),
              command: c.embeddedCommand
                ?? this.inferVerificationCommand(c.description, item),
              success_criteria: `Verified complete: ${c.description}`,
            },
          }));
        }
        // Spec exists but parseSpec returned empty ISC — tag template rows as specFallback
        console.warn(`[WorkOrchestrator] Spec exists at "${item.specPath}" but parseSpec returned 0 ISC rows. Falling back to template rows with specFallback marker.`);
        const fallbackRows = this.templateRows(item, effort);
        for (const row of fallbackRows) {
          row.specFallback = true;
        }
        return fallbackRows;
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
    return this.templateRows(item, effort);
  }

  private templateRows(item: WorkItem, effort: EffortLevel): ISCRow[] {
    const rows: ISCRow[] = [];
    if (item.workType === "dev") {
      rows.push({ id: 1, description: "Implement core functionality", status: "PENDING", category: "implementation", source: "INFERRED", parallel: false, verification: { method: "test", command: "bun test", success_criteria: "Core tests pass" } });
      rows.push({ id: 2, description: "Add tests and validation", status: "PENDING", category: "testing", source: "INFERRED", parallel: false, verification: { method: "test", command: "bun test", success_criteria: "All tests pass" } });
    } else if (item.workType === "research") {
      rows.push({ id: 1, description: "Gather sources and context", status: "PENDING", category: "implementation", source: "INFERRED", parallel: false, verification: { method: "inferred", command: "git diff --stat HEAD~1", success_criteria: "Sources documented" } });
      rows.push({ id: 2, description: "Synthesize findings", status: "PENDING", category: "implementation", source: "INFERRED", parallel: false, verification: { method: "inferred", command: "git diff --stat HEAD~1", success_criteria: "Synthesis complete" } });
    } else {
      rows.push({ id: 1, description: `Complete: ${item.title}`, status: "PENDING", category: "implementation", source: "INFERRED", parallel: false, verification: { method: "inferred", command: "git diff --stat HEAD~1", success_criteria: "Work completed" } });
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
    return undefined;
  }

  private inferVerificationCommand(description: string, item: WorkItem): string | undefined {
    // Try spec-aware command generation first
    const specCmd = this.inferVerificationFromSpecContext(description);
    if (specCmd) return specCmd;

    // Fallback: keyword heuristic
    const lower = description.toLowerCase();
    if (/test|spec/.test(lower)) return "bun test";
    if (/lint|format|eslint|prettier/.test(lower)) return "bun run lint";
    if (/build|compile|bundle/.test(lower)) return "bun run build";
    if (/type.?check|typescript|types/.test(lower)) return "bun run typecheck";
    if (item.workType === "dev") return "bun run typecheck";
    if (item.workType === "research") return "git diff --stat HEAD~1";
    return undefined;
  }

  /**
   * Generate targeted verification commands from spec context (file paths, test cases).
   * Returns null when no spec context is available, falling back to keyword heuristic.
   */
  private inferVerificationFromSpecContext(description: string): string | undefined {
    // Pattern: description contains a file path (e.g. "Tools/VoiceSystemPrompt.ts")
    const filePathMatch = description.match(/[\w\-./]+\.\w{1,4}$/);
    if (filePathMatch) {
      const filePath = filePathMatch[0];
      // Test files get actually run, not just existence check
      if (/\.test\.\w+$|\.spec\.\w+$/.test(filePath)) {
        return `bun test ${filePath}`;
      }
      // Implementation files get existence check
      return `test -f ${filePath}`;
    }

    // Pattern: TC-XX test case rows → run test suite
    if (/^TC-\d+/i.test(description)) {
      return "bun test";
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

  private runVerificationCommand(row: ISCRow): boolean {
    if (!row.verification?.command) return false;
    const parsed = this.parseVerificationCommand(row.verification.command);
    if (!parsed) return false;
    try {
      execFileSync(parsed.exe, parsed.args, { encoding: "utf-8", timeout: 120000 });
      return true;
    } catch {
      return false;
    }
  }

  // --------------------------------------------------------------------------
  // Git + spec helpers (overridable for tests)
  // --------------------------------------------------------------------------

  private getGitDiffStat(): string {
    try {
      return execFileSync("git", ["diff", "--stat", "HEAD~1"], { encoding: "utf-8", timeout: 10000 });
    } catch {
      return "";
    }
  }

  private mapPriority(priority: Priority): ItemReviewSummary["priority"] {
    switch (priority) {
      case "critical":
      case "high": return "HIGH";
      case "normal": return "MEDIUM";
      case "low": return "LOW";
    }
  }

  private readSpecContent(specPath: string): string | undefined {
    try {
      return readFileSync(specPath, "utf-8");
    } catch {
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
  // Record execution metrics (cross-process boundary)
  // --------------------------------------------------------------------------

  recordExecution(itemId: string, spend?: number): { success: boolean; error?: string } {
    const item = this.queue.getItem(itemId);
    if (!item) return { success: false, error: `Not found: ${itemId}` };

    this.budget.recordIteration(itemId);
    if (spend !== undefined && spend > 0) {
      this.budget.spend(itemId, spend);
    }
    return { success: true };
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
      this.itemISC.set(itemId, persisted); // populate cache
      return persisted;
    }

    return undefined;
  }

  // --------------------------------------------------------------------------
  // Orphan recovery
  // --------------------------------------------------------------------------

  private recoverOrphanedItems(): number {
    const STALE_THRESHOLD_MS = 4 * 60 * 60 * 1000; // 4 hours
    const now = Date.now();
    let recovered = 0;

    for (const item of this.queue.getAllItems()) {
      if (item.status !== "in_progress") continue;

      // Path 1: Verified but never completed
      if (
        item.verification?.status === "verified" &&
        item.verification.verdict === "PASS"
      ) {
        const rows = this.loadISC(item.id);
        if (rows && rows.length > 0 && rows.every(r => r.status === "VERIFIED")) {
          this.queue.updateStatus(item.id, "completed", "Auto-completed by orphan recovery (verified but never completed)");
          recovered++;
          continue;
        }
      }

      // Path 2: Stale with no verification
      if (item.startedAt) {
        const startedMs = new Date(item.startedAt).getTime();
        if (now - startedMs > STALE_THRESHOLD_MS && !item.verification) {
          this.queue.resetToPending(item.id, "Orphan recovery: stale in_progress >4h with no verification");
          recovered++;
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
      budget: { type: "string" },
    },
    allowPositionals: true,
  });

  const cmd = positionals[0];
  if (values.help || !cmd) {
    console.log(`
WorkOrchestrator — Unified orchestrator for autonomous work

Commands:
  init                  Validate DAG, init budget, load queue, recover orphans
  next-batch [n]        Get ready items (default 5)
  prepare <id>          Classify effort + generate ISC rows
  started <id>          Mark in_progress
  mark-done <id> <rows> Transition ISC rows PENDING→DONE (space-separated row IDs)
  record-execution <id> Record iteration (+ optional --budget <amount> spend)
  verify <id>           Run verification + review gate
  complete <id>         Mark completed (only after verify passes)
  fail <id> [err]       Mark failed with reason
  status                Show queue state + budget + blocked items
  recover               Run orphan recovery on stale in_progress items

Options:
  --budget <n>          Total budget in dollars (default: 100)
  --json                JSON output
  -h, --help            Show help
`);
    return;
  }

  const orch = new WorkOrchestrator();

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
      } catch (e) {
        console.error(`[init] Orphan scan failed (non-fatal): ${e instanceof Error ? e.message : e}`);
      }

      const totalBudget = values.budget ? parseFloat(values.budget) : 100;
      const result = orch.init(totalBudget);
      if (values.json) { console.log(JSON.stringify(result)); } else { console.log(result.message); }
      process.exit(result.success ? 0 : 1);
      break;
    }

    case "next-batch": {
      const n = parseInt(positionals[1]) || 5;
      const result = orch.nextBatch(n);
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
      console.log(orch.started(id) ? `${id} → in_progress` : `Not found: ${id}`);
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
      if (!id) { console.error("Usage: record-execution <id> [--budget <amount>]"); process.exit(1); }
      const spend = values.budget ? parseFloat(values.budget) : undefined;
      const result = orch.recordExecution(id, spend);
      if (values.json) { console.log(JSON.stringify(result)); }
      else { console.log(result.success ? `Recorded execution for ${id}${spend ? ` ($${spend})` : ""}` : `Failed: ${result.error}`); }
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

    case "complete": {
      const id = positionals[1];
      if (!id) { console.error("Usage: complete <id>"); process.exit(1); }
      const result = await orch.complete(id);
      console.log(result.success ? `${id} → completed` : `Blocked: ${result.reason}`);
      process.exit(result.success ? 0 : 1);
      break;
    }

    case "fail": {
      const id = positionals[1];
      if (!id) { console.error("Usage: fail <id> [err]"); process.exit(1); }
      console.log(await orch.fail(id, positionals[2]) ? `${id} → failed` : `Not found: ${id}`);
      break;
    }

    case "status": {
      console.log(orch.status());
      break;
    }

    case "recover": {
      const result = orch.init(values.budget ? parseFloat(values.budget) : 100);
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

export { CATASTROPHIC_PATTERNS, PROTECTED_BRANCHES, ITERATION_LIMITS, BUDGET_ALLOCATION };
