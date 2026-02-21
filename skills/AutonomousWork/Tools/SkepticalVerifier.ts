#!/usr/bin/env bun
/**
 * SkepticalVerifier.ts - Independent 3-tier verification for autonomous work
 *
 * Provides an independent "skeptical agent" check after task completion to catch:
 * - Paper completions (rows marked DONE with no real work)
 * - Spec drift (work that diverges from requirements)
 * - Quality gaps (code that passes tests but has issues)
 * - Missed edge cases the executor didn't consider
 *
 * Three verification tiers:
 *   Tier 1: Code-based checks (every ISC row) — $0.00, ~0ms
 *   Tier 2: Inference skeptic (per work item) — ~$0.02, ~5s
 *   Tier 3: Deep review agent (conditional)   — ~$0.30, ~30s
 *
 * Usage:
 *   import { SkepticalVerifier } from "./SkepticalVerifier.ts";
 *   const verifier = new SkepticalVerifier();
 *   const result = await verifier.review(itemSummary);
 */

import { join } from "path";
import type { EffortLevel } from "./WorkQueue.ts";
import type { BudgetManager } from "./BudgetManager.ts";
import type { ISCRowCategory } from "./WorkOrchestrator.ts";

// ============================================================================
// Types
// ============================================================================

export interface VerificationTier {
  tier: 1 | 2 | 3;
  verdict: "PASS" | "FAIL" | "NEEDS_REVIEW";
  confidence: number; // 0.0 - 1.0
  concerns: string[]; // Specific issues found
  recommendation?: string; // What to do if FAIL
  costEstimate: number; // $ spent on this verification
  latencyMs: number;
}

/** Injectable inference function — allows test mocking without dynamic import */
export type InferenceFn = (opts: {
  systemPrompt: string;
  userPrompt: string;
  level: string;
  expectJson: boolean;
  timeout: number;
}) => Promise<{ success: boolean; parsed?: unknown }>;

export interface SkepticalVerifierConfig {
  /** Confidence threshold below which Tier 3 triggers */
  escalationThreshold: number; // default: 0.7
  /** Always run Tier 3 for HIGH priority items */
  alwaysDeepReviewHighPriority: boolean; // default: true
  /** Always run Tier 3 for STANDARD+ effort items regardless of confidence */
  alwaysDeepReviewStandardPlus: boolean; // default: true
  /** Skip Tier 2 for TRIVIAL effort items */
  skipInferenceForTrivial: boolean; // default: true
  /** Maximum budget for a single Tier 3 review */
  tier3BudgetCap: number; // default: 0.50
  /** Injectable inference function — falls back to dynamic import of Inference.ts */
  inferenceFn?: InferenceFn;
  /** Categories that must always run Tier 2, even for TRIVIAL effort */
  neverSkipCategories: ISCRowCategory[];
}

/** Summary of a completed work item, passed to the verifier */
export interface ItemReviewSummary {
  itemId: string;
  title: string;
  description: string;
  effort: EffortLevel;
  priority: "HIGH" | "MEDIUM" | "LOW";
  specPath?: string;
  specContent?: string;
  iscRows: Array<{
    id: number;
    description: string;
    status: string;
    category?: string;
    capability?: string;
    source?: "EXPLICIT" | "INFERRED" | "IMPLICIT";
    verification?: {
      method: string;
      result?: "PASS" | "FAIL";
      commandRan?: boolean;
    };
  }>;
  gitDiffStat: string;
  executionLogTail: string[];
  iterationsUsed: number;
  budgetSpent: number;
  budgetAllocated: number;
}

/** Aggregate result from all tiers */
export interface SkepticalReviewResult {
  finalVerdict: "PASS" | "FAIL" | "NEEDS_REVIEW";
  tiers: VerificationTier[];
  /** FM-12: Tracks which verification tiers were skipped and why */
  tiersSkipped: Array<{ tier: 2 | 3; reason: string }>;
  totalCost: number;
  totalLatencyMs: number;
  concerns: string[];
}

// ============================================================================
// Constants
// ============================================================================

const KAYA_HOME = process.env.KAYA_HOME || join(process.env.HOME || "", ".claude");

const DEFAULT_CONFIG: SkepticalVerifierConfig = {
  escalationThreshold: 0.7,
  alwaysDeepReviewHighPriority: true,
  alwaysDeepReviewStandardPlus: true,
  skipInferenceForTrivial: true,
  tier3BudgetCap: 0.50,
  neverSkipCategories: ["documentation", "deployment", "cleanup"],
};

// ============================================================================
// SkepticalVerifier Class
// ============================================================================

export class SkepticalVerifier {
  private config: SkepticalVerifierConfig;

  constructor(config?: Partial<SkepticalVerifierConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // --------------------------------------------------------------------------
  // Main Review Entry Point
  // --------------------------------------------------------------------------

  /**
   * Run skeptical review on a completed work item.
   * Always runs Tier 1. Runs Tier 2 unless TRIVIAL. Runs Tier 3 conditionally.
   */
  async review(summary: ItemReviewSummary, budgetManager?: BudgetManager): Promise<SkepticalReviewResult> {
    const tiers: VerificationTier[] = [];
    const allConcerns: string[] = [];
    const tiersSkipped: Array<{ tier: 2 | 3; reason: string }> = [];

    // Tier 1: Always run code-based checks (free, no budget tracking needed)
    const tier1 = this.runTier1(summary);
    tiers.push(tier1);
    allConcerns.push(...tier1.concerns);

    // Tier 2: Inference skeptic (skip for TRIVIAL — UNLESS gated categories present)
    const hasGatedCategories = summary.iscRows.some(
      r => r.category && this.config.neverSkipCategories.includes(r.category as ISCRowCategory)
    );

    if (this.config.skipInferenceForTrivial && summary.effort === "TRIVIAL" && !hasGatedCategories) {
      // FM-12: Track Tier 2 skip
      tiersSkipped.push({ tier: 2, reason: "TRIVIAL effort, no gated categories" });
    } else {
      const tier2 = await this.runTier2(summary, tier1);
      tiers.push(tier2);
      allConcerns.push(...tier2.concerns);

      // Track Tier 2 spend
      if (budgetManager && tier2.costEstimate > 0) {
        const spend = budgetManager.spendVerification(summary.itemId, tier2.costEstimate);
        if (!spend.allowed) {
          // FM-12: Budget exhausted after Tier 2 — Tier 3 skipped
          tiersSkipped.push({ tier: 3, reason: "verification budget exhausted after Tier 2" });
          if (summary.effort !== "TRIVIAL") {
            allConcerns.push("Verification budget denied for non-TRIVIAL item — Tier 3 skipped");
          }
          const finalVerdict = this.computeFinalVerdict(tiers);
          const totalCost = tiers.reduce((sum, t) => sum + t.costEstimate, 0);
          const totalLatencyMs = tiers.reduce((sum, t) => sum + t.latencyMs, 0);
          return { finalVerdict, tiers, tiersSkipped, totalCost, totalLatencyMs, concerns: allConcerns };
        }
      }

      // Tier 3: Deep review (conditional)
      const isStandardPlus = ["STANDARD", "THOROUGH", "DETERMINED"].includes(summary.effort);
      const shouldEscalate =
        tier2.confidence < this.config.escalationThreshold ||
        (this.config.alwaysDeepReviewHighPriority && summary.priority === "HIGH") ||
        (this.config.alwaysDeepReviewStandardPlus && isStandardPlus);

      // Check budget cap before running Tier 3
      const cumulativeCost = tiers.reduce((sum, t) => sum + t.costEstimate, 0);
      if (shouldEscalate && cumulativeCost + 0.30 <= this.config.tier3BudgetCap) {
        // Check BudgetManager allowance if available
        let budgetAllowed = true;
        if (budgetManager) {
          const spend = budgetManager.spendVerification(summary.itemId, 0.30);
          budgetAllowed = spend.allowed;
        }

        if (budgetAllowed) {
          const tier3 = await this.runTier3(summary, tier1, tier2);
          tiers.push(tier3);
          allConcerns.push(...tier3.concerns);
        } else {
          // FM-12: BudgetManager denied Tier 3
          tiersSkipped.push({ tier: 3, reason: "BudgetManager denied Tier 3 verification spend" });
        }
      } else if (shouldEscalate) {
        // FM-12: Budget cap exceeded
        tiersSkipped.push({ tier: 3, reason: `cumulative cost $${cumulativeCost.toFixed(2)} + $0.30 exceeds tier3BudgetCap $${this.config.tier3BudgetCap}` });
      } else {
        // FM-12: Not escalated — confidence sufficient
        tiersSkipped.push({ tier: 3, reason: `confidence ${tier2.confidence.toFixed(2)} >= ${this.config.escalationThreshold}` });
      }
    }

    // Determine final verdict
    const finalVerdict = this.computeFinalVerdict(tiers);
    const totalCost = tiers.reduce((sum, t) => sum + t.costEstimate, 0);
    const totalLatencyMs = tiers.reduce((sum, t) => sum + t.latencyMs, 0);

    return {
      finalVerdict,
      tiers,
      tiersSkipped,
      totalCost,
      totalLatencyMs,
      concerns: allConcerns,
    };
  }

  // --------------------------------------------------------------------------
  // Tier 1: Code-Based Checks
  // --------------------------------------------------------------------------

  /**
   * Pure code checks — no inference cost.
   * Checks: spec alignment, diff-to-description coherence, test coverage,
   * completion ratio, budget anomalies.
   */
  runTier1(summary: ItemReviewSummary): VerificationTier {
    const start = performance.now();
    const concerns: string[] = [];
    let score = 1.0; // Start at perfect, deduct for issues

    // Check 1: Completion ratio
    const totalRows = summary.iscRows.length;
    const doneRows = summary.iscRows.filter(
      r => r.status === "DONE" || r.status === "VERIFIED"
    ).length;
    const completionRatio = totalRows > 0 ? doneRows / totalRows : 0;

    if (completionRatio < 0.5) {
      concerns.push(`Low completion ratio: ${doneRows}/${totalRows} rows completed (${(completionRatio * 100).toFixed(0)}%)`);
      score -= 0.3;
    } else if (completionRatio < 0.8) {
      concerns.push(`Partial completion: ${doneRows}/${totalRows} rows (${(completionRatio * 100).toFixed(0)}%)`);
      score -= 0.1;
    }

    // Check 2: Verification pass rate (of rows that have verification)
    const verifiedRows = summary.iscRows.filter(r => r.verification?.result === "PASS");
    const failedVerification = summary.iscRows.filter(r => r.verification?.result === "FAIL");
    if (failedVerification.length > 0) {
      concerns.push(`${failedVerification.length} row(s) failed verification: ${failedVerification.map(r => `#${r.id}`).join(", ")}`);
      score -= 0.2 * failedVerification.length;
    }

    // Check 3: Git diff emptiness (paper completion detection)
    const diffLines = summary.gitDiffStat.trim().split("\n").filter(Boolean);
    const hasDiff = diffLines.length > 0 && !summary.gitDiffStat.includes("0 files changed");
    if (!hasDiff && totalRows > 0 && summary.effort !== "TRIVIAL") {
      concerns.push("No file changes detected in git diff — possible paper completion");
      score -= 0.4;
    }

    // Check 4: Spec alignment (if spec content available)
    if (summary.specContent) {
      const specAlignment = this.checkSpecAlignment(summary);
      if (specAlignment.concerns.length > 0) {
        concerns.push(...specAlignment.concerns);
        score -= specAlignment.penalty;
      }
    }

    // Check 5: Diff-to-description coherence
    const coherence = this.checkDiffDescriptionCoherence(summary);
    if (coherence.concerns.length > 0) {
      concerns.push(...coherence.concerns);
      score -= coherence.penalty;
    }

    // Check 6: Test coverage for engineering rows
    const engineeringRows = summary.iscRows.filter(r => r.capability === "execution.engineer");
    if (engineeringRows.length > 0) {
      const testRows = summary.iscRows.filter(r => r.capability === "execution.testing");
      const testFilesMentioned = summary.gitDiffStat.match(/\.test\.|\.spec\.|__tests__/gi);
      if (testRows.length === 0 && !testFilesMentioned) {
        concerns.push("Engineering work detected but no test files modified or test rows present");
        score -= 0.15;
      }
    }

    // Check 7: Budget anomaly (graduated severity based on spend ratio)
    if (summary.effort !== "TRIVIAL" && summary.budgetAllocated > 0) {
      const spendRatio = summary.budgetSpent / summary.budgetAllocated;
      if (spendRatio < 0.001) {
        concerns.push(`Paper completion: near-zero budget usage $${summary.budgetSpent.toFixed(4)} of $${summary.budgetAllocated} allocated`);
        score -= 0.5;
      } else if (spendRatio < 0.01) {
        concerns.push(`Suspiciously low budget usage: $${summary.budgetSpent.toFixed(2)} of $${summary.budgetAllocated} allocated (${(spendRatio * 100).toFixed(1)}%)`);
        score -= 0.3;
      } else if (spendRatio < 0.05 && summary.effort !== "QUICK") {
        concerns.push(`Low budget usage for ${summary.effort} item: $${summary.budgetSpent.toFixed(2)} of $${summary.budgetAllocated} allocated (${(spendRatio * 100).toFixed(1)}%)`);
        score -= 0.15;
      }
    }

    // Check 8: Iteration anomaly (graduated severity)
    if (summary.iterationsUsed === 0 && doneRows > 0) {
      concerns.push("Rows marked complete but zero iterations recorded");
      score -= 0.4;
    } else if (summary.iterationsUsed === 1 && doneRows >= 3 && summary.effort !== "TRIVIAL") {
      concerns.push(`Only 1 iteration for ${doneRows} completed rows on ${summary.effort} item — suspiciously efficient`);
      score -= 0.15;
    }

    // Check 9: Stale documentation detection
    const docRows = summary.iscRows.filter(r => r.category === "documentation");
    const cleanupRows = summary.iscRows.filter(r => r.category === "cleanup");
    const gatedTotal = docRows.length + cleanupRows.length;
    const gatedDone = [...docRows, ...cleanupRows].filter(
      r => r.status === "DONE" || r.status === "VERIFIED"
    ).length;
    if (gatedTotal > 0 && gatedDone === 0) {
      concerns.push(`${gatedTotal} documentation/cleanup rows present but none completed`);
      score -= 0.3;
    }

    // Check 10: Deployment without runtime verification
    const deploymentRows = summary.iscRows.filter(r => r.category === "deployment");
    const deploymentDone = deploymentRows.filter(
      r => r.status === "DONE" || r.status === "VERIFIED"
    );
    if (deploymentDone.length > 0) {
      const hasRuntimeVerification = deploymentDone.some(r =>
        r.verification?.method &&
        /launchctl|curl|docker|systemctl|running|runtime/.test(r.verification.method)
      );
      if (!hasRuntimeVerification) {
        concerns.push(
          `${deploymentDone.length} deployment row(s) completed without runtime verification — only existence-checked`
        );
        score -= 0.15;
      }
    }

    // Check 11: Requirement coverage ratio (spec vs ISC row count)
    if (summary.specContent) {
      const specRequirements = this.extractRequirements(summary.specContent);
      const specRequirementCount = specRequirements.length;
      const iscRowCount = summary.iscRows.length;
      const inferredCount = summary.iscRows.filter(r => r.source === "INFERRED").length;
      const inferredRatio = iscRowCount > 0 ? inferredCount / iscRowCount : 0;

      if (specRequirementCount >= 4 && iscRowCount / specRequirementCount < 0.5) {
        concerns.push(`Requirement coverage too low: ${iscRowCount} ISC rows for ${specRequirementCount} spec requirements (${((iscRowCount / specRequirementCount) * 100).toFixed(0)}%)`);
        score -= 0.3;
      }
      if (specRequirementCount >= 3 && inferredRatio > 0.8) {
        concerns.push(`Template override despite explicit spec: ${inferredCount}/${iscRowCount} ISC rows are INFERRED but spec has ${specRequirementCount} explicit requirements`);
        score -= 0.2;
      }
    }

    // Check 12: Test file change proportionality
    const testingRowsDone = summary.iscRows.filter(
      r => (r.category === "testing" || r.capability === "execution.testing") &&
        (r.status === "DONE" || r.status === "VERIFIED")
    );
    if (testingRowsDone.length > 0) {
      const hasTestFiles = /\.test\.|\.spec\.|__tests__/.test(summary.gitDiffStat);
      if (!hasTestFiles) {
        concerns.push(`${testingRowsDone.length} testing row(s) marked complete but no test files in git diff`);
        score -= 0.25;
      }
    }

    // Check 13: CLAUDE.md compliance (CachedHTTPClient / StateManager)
    {
      const iscText = summary.iscRows.map(r => r.description.toLowerCase()).join(" ");
      const hasHTTPWork = /\b(?:http|api|fetch|request|endpoint|webhook|scrape)\b/.test(iscText);
      const hasStateWork = /\b(?:state|persist|store|cache|json|config|settings)\b/.test(iscText);
      const diffLower = summary.gitDiffStat.toLowerCase();

      if (hasHTTPWork && !diffLower.includes("cachedhttpclient") && !diffLower.includes("cached-http") && summary.effort !== "TRIVIAL") {
        concerns.push("ISC describes HTTP/API work but no CachedHTTPClient usage detected in git diff — may use raw fetch()");
        score -= 0.1;
      }
      if (hasStateWork && !diffLower.includes("statemanager") && !diffLower.includes("state-manager") && summary.effort !== "TRIVIAL") {
        concerns.push("ISC describes state/persistence work but no StateManager usage detected in git diff — may use raw JSON.parse(readFileSync())");
        score -= 0.1;
      }
    }

    // Check 14: Stub detection (low code density)
    {
      const isStandardPlus = ["STANDARD", "THOROUGH", "DETERMINED"].includes(summary.effort);
      if (isStandardPlus) {
        const insertionMatch = summary.gitDiffStat.match(/(\d+)\s+insertion/);
        const filesMatch = summary.gitDiffStat.match(/(\d+)\s+file/);
        const totalInsertions = insertionMatch ? parseInt(insertionMatch[1]) : 0;
        const totalFiles = filesMatch ? parseInt(filesMatch[1]) : 0;

        if (totalFiles >= 3 && totalInsertions > 0 && totalInsertions / totalFiles < 10) {
          concerns.push(`Low code density: ${totalInsertions} insertions across ${totalFiles} files (${(totalInsertions / totalFiles).toFixed(1)} lines/file avg) — possible skeleton/stub implementation`);
          score -= 0.15;
        }
      }
    }

    // Check 15: ISC-diff coherence (ISC references specific files but <30% appear in diff)
    {
      const fileRefPattern = /[\w\-./]+\.\w{1,4}$/;
      const iscFileRefs = summary.iscRows
        .map(r => r.description.match(fileRefPattern)?.[0])
        .filter((f): f is string => f !== undefined);

      if (iscFileRefs.length >= 3) {
        const diffContent = summary.gitDiffStat.toLowerCase();
        const matchedFiles = iscFileRefs.filter(f => diffContent.includes(f.toLowerCase().split("/").pop() || ""));
        const matchRatio = matchedFiles.length / iscFileRefs.length;

        if (matchRatio < 0.3) {
          concerns.push(`ISC-diff coherence gap: ISC references ${iscFileRefs.length} specific files but only ${matchedFiles.length} (${(matchRatio * 100).toFixed(0)}%) appear in git diff`);
          score -= 0.2;
        }
      }
    }

    // Check 16: Spec verification command coverage
    if (summary.specContent) {
      try {
        const { extractCommandsFromNarrative } = require("./SpecParser.ts") as {
          extractCommandsFromNarrative: (content: string) => Array<{ command: string; context: string }>;
        };
        const specCommands = extractCommandsFromNarrative(summary.specContent);

        if (specCommands.length >= 2) {
          const iscDescriptions = summary.iscRows.map(r => r.description.toLowerCase()).join("\n");

          const uncovered = specCommands.filter(sc => {
            const cmdLower = sc.command.toLowerCase();
            const parts = cmdLower.split(/\s+/);
            const exe = parts[0];
            const meaningfulArgs = parts.slice(1).filter(p => !p.startsWith("-") && p.length > 2);
            const hasExe = iscDescriptions.includes(exe);
            const hasArg = meaningfulArgs.length === 0 || meaningfulArgs.some(arg => iscDescriptions.includes(arg));
            return !(hasExe && hasArg);
          });

          if (uncovered.length > 0) {
            const deductionCount = Math.min(uncovered.length, 3);
            for (const uc of uncovered.slice(0, deductionCount)) {
              concerns.push(`Spec verification command not in ISC: "${uc.command.slice(0, 80)}"`);
            }
            score -= deductionCount * 0.15;
          }
        }
      } catch {
        // Fail-open: extraction errors don't penalize
      }
    }

    const confidence = Math.max(0, Math.min(1, score));
    const verdict: VerificationTier["verdict"] =
      confidence >= 0.8 ? "PASS" :
      confidence >= 0.5 ? "NEEDS_REVIEW" :
      "FAIL";

    return {
      tier: 1,
      verdict,
      confidence,
      concerns,
      costEstimate: 0,
      latencyMs: performance.now() - start,
    };
  }

  // --------------------------------------------------------------------------
  // Tier 2: Inference Skeptic (Haiku)
  // --------------------------------------------------------------------------

  /**
   * Single Haiku inference call per work item.
   * Skeptical reviewer persona — finds what's wrong, not what's right.
   */
  async runTier2(
    summary: ItemReviewSummary,
    tier1: VerificationTier,
  ): Promise<VerificationTier> {
    const start = performance.now();

    const systemPrompt = `You are an INDEPENDENT VERIFICATION AGENT. Your job is to verify work against the ORIGINAL SPEC, not validate what the executing agent claims.

CRITICAL: The executing agent self-reported its own completion. You must verify independently.

DATA TRUST LEVELS:
- Git diff (HIGH trust): Actual file changes — objective evidence of work done
- ISC statuses (LOW trust): Self-reported by the executing agent — treat as claims, not facts
- Budget/iteration counts (MEDIUM trust): System-tracked but can indicate paper completions
- Verification commands (HIGH trust when commandRan=true): Actually executed by the system

ISC rows marked "TEMPLATE" or source "INFERRED" were auto-generated, NOT derived from the spec. Template rows like "Implement core functionality" are generic placeholders — they do NOT demonstrate spec coverage.

EVALUATE:
1. Does the git diff show changes that address the SPEC requirements? (not just ISC row descriptions)
2. Are spec requirements actually covered by ISC rows, or was the spec ignored in favor of templates?
3. Is budget usage proportional to claimed work? ($0 spent = paper completion)
4. Were verification commands actually run, or just self-reported?
5. Do test file changes exist for testing claims?

Respond with ONLY valid JSON (no markdown, no code fences):
{"verdict":"PASS|FAIL|NEEDS_REVIEW","confidence":0.0-1.0,"concerns":["specific concern 1"],"requirementsCovered":N,"requirementsTotal":N}`;

    const userPrompt = this.buildTier2UserPrompt(summary, tier1);

    try {
      const inferenceFn = this.config.inferenceFn
        ?? (await import("../../CORE/Tools/Inference.ts")).inference;

      const result = await inferenceFn({
        systemPrompt,
        userPrompt,
        level: "fast", // Haiku
        expectJson: true,
        timeout: 15000,
      });

      if (result.success && result.parsed) {
        const parsed = result.parsed as {
          verdict?: string;
          confidence?: number;
          concerns?: string[];
        };

        const verdict = (
          parsed.verdict === "PASS" || parsed.verdict === "FAIL" || parsed.verdict === "NEEDS_REVIEW"
        ) ? parsed.verdict : "NEEDS_REVIEW";

        const confidence = typeof parsed.confidence === "number"
          ? Math.max(0, Math.min(1, parsed.confidence))
          : 0.5;

        const concerns = Array.isArray(parsed.concerns)
          ? parsed.concerns.filter((c): c is string => typeof c === "string")
          : [];

        return {
          tier: 2,
          verdict: verdict as VerificationTier["verdict"],
          confidence,
          concerns,
          costEstimate: 0.02,
          latencyMs: performance.now() - start,
        };
      }

      // Inference succeeded but no parseable result — definitive FAIL (cannot verify = fail)
      return {
        tier: 2,
        verdict: "FAIL",
        confidence: 0.0,
        concerns: ["Tier 2 inference returned unparseable result"],
        costEstimate: 0.02,
        latencyMs: performance.now() - start,
      };
    } catch (e) {
      // Inference unavailable — definitive FAIL. "Cannot verify" must not pass.
      return {
        tier: 2,
        verdict: "FAIL",
        confidence: 0.0,
        concerns: [`Tier 2 inference unavailable: ${e instanceof Error ? e.message : String(e)}`],
        costEstimate: 0,
        latencyMs: performance.now() - start,
      };
    }
  }

  // --------------------------------------------------------------------------
  // Tier 3: Deep Review Agent (Sonnet via claude -p)
  // --------------------------------------------------------------------------

  /**
   * Full agent review — only triggered when Tier 2 confidence is low or item is HIGH priority.
   * Budget-capped per review.
   */
  async runTier3(
    summary: ItemReviewSummary,
    tier1: VerificationTier,
    tier2: VerificationTier,
  ): Promise<VerificationTier> {
    const start = performance.now();

    try {
      const inferenceFn = this.config.inferenceFn
        ?? (await import("../../CORE/Tools/Inference.ts")).inference;

      const allConcerns = [...tier1.concerns, ...tier2.concerns];
      const systemPrompt = `You are a DEEP VERIFICATION AGENT performing independent review of autonomous work. Previous tiers flagged concerns. You must investigate and provide a DEFINITIVE verdict.

CRITICAL: The executing agent self-reported its own completion. Do NOT trust agent claims. Verify against the original spec and git diff.

DATA TRUST LEVELS:
- Git diff (HIGH trust): Actual file changes — objective evidence
- ISC statuses (LOW trust): Self-reported by executing agent
- Budget/iteration counts (MEDIUM trust): System-tracked
- Verification commands (HIGH trust when actually run)

Tier 1 (code checks) concerns:
${tier1.concerns.length > 0 ? tier1.concerns.map(c => `- ${c}`).join("\n") : "- None"}

Tier 2 (inference skeptic) concerns:
${tier2.concerns.length > 0 ? tier2.concerns.map(c => `- ${c}`).join("\n") : "- None"}

Investigate ALL concerns. Check:
1. Does git diff show changes that match SPEC requirements (not just ISC descriptions)?
2. Are spec requirements covered by actual work, or was the spec bypassed?
3. Is budget usage proportional to claimed work?
4. Were verification commands actually executed?

Respond with ONLY valid JSON (no markdown, no code fences):
{"verdict":"PASS|FAIL|NEEDS_REVIEW","confidence":0.0-1.0,"concerns":["specific concern 1"],"recommendation":"what to do if FAIL","requirementsCovered":N,"requirementsTotal":N}`;

      const userPrompt = this.buildTier3UserPrompt(summary, tier1, tier2);

      const result = await inferenceFn({
        systemPrompt,
        userPrompt,
        level: "standard", // Sonnet for deeper reasoning
        expectJson: true,
        timeout: 60000,
      });

      if (result.success && result.parsed) {
        const parsed = result.parsed as {
          verdict?: string;
          confidence?: number;
          concerns?: string[];
          recommendation?: string;
        };

        const verdict = (
          parsed.verdict === "PASS" || parsed.verdict === "FAIL" || parsed.verdict === "NEEDS_REVIEW"
        ) ? parsed.verdict : "NEEDS_REVIEW";

        const confidence = typeof parsed.confidence === "number"
          ? Math.max(0, Math.min(1, parsed.confidence))
          : 0.5;

        const concerns = Array.isArray(parsed.concerns)
          ? parsed.concerns.filter((c): c is string => typeof c === "string")
          : [];

        return {
          tier: 3,
          verdict: verdict as VerificationTier["verdict"],
          confidence,
          concerns,
          recommendation: typeof parsed.recommendation === "string" ? parsed.recommendation : undefined,
          costEstimate: 0.30,
          latencyMs: performance.now() - start,
        };
      }

      // Unparseable result — definitive FAIL (cannot verify = fail)
      return {
        tier: 3,
        verdict: "FAIL",
        confidence: 0.0,
        concerns: ["Tier 3 deep review returned unparseable result"],
        costEstimate: 0.30,
        latencyMs: performance.now() - start,
      };
    } catch (e) {
      // Inference unavailable — definitive FAIL. "Cannot verify" must not pass.
      return {
        tier: 3,
        verdict: "FAIL",
        confidence: 0.0,
        concerns: [`Tier 3 deep review unavailable: ${e instanceof Error ? e.message : String(e)}`],
        costEstimate: 0,
        latencyMs: performance.now() - start,
      };
    }
  }

  // --------------------------------------------------------------------------
  // Verdict Computation
  // --------------------------------------------------------------------------

  /**
   * Compute final verdict from all tier results.
   *
   * Rules:
   * - If Tier 3 ran and passed: PASS (Tier 3 overrides Tier 2)
   * - If Tier 3 ran and failed: FAIL
   * - If only Tier 2 ran and failed (no Tier 3 trigger): NEEDS_REVIEW
   * - If only Tier 1 ran: use Tier 1 verdict directly
   * - If all tiers PASS: PASS
   */
  private computeFinalVerdict(tiers: VerificationTier[]): SkepticalReviewResult["finalVerdict"] {
    const tier1 = tiers.find(t => t.tier === 1);
    const tier2 = tiers.find(t => t.tier === 2);
    const tier3 = tiers.find(t => t.tier === 3);

    // Tier 3 is authoritative when it runs
    if (tier3) return tier3.verdict;

    // Tier 2 can only confirm or downgrade Tier 1, never upgrade
    if (tier2) {
      if (tier1?.verdict === "FAIL") return "FAIL";           // Tier 1 FAIL is final
      if (tier2.verdict === "FAIL") return "NEEDS_REVIEW";    // Tier 2 FAIL without Tier 3 = review
      if (tier1?.verdict === "NEEDS_REVIEW") return "NEEDS_REVIEW"; // Tier 1 concern stands
      if (tier2.verdict === "NEEDS_REVIEW") return "NEEDS_REVIEW";
      return "PASS"; // Both PASS
    }

    // Only Tier 1 (TRIVIAL items)
    return tier1?.verdict ?? "NEEDS_REVIEW";
  }

  // --------------------------------------------------------------------------
  // Prompt Builders
  // --------------------------------------------------------------------------

  private buildTier2UserPrompt(summary: ItemReviewSummary, tier1: VerificationTier): string {
    const iscSummary = summary.iscRows
      .map(r => {
        const sourceTag = r.source === "INFERRED" ? " [TEMPLATE]" : r.source === "EXPLICIT" ? " [spec-derived]" : "";
        const verifyTag = r.verification?.commandRan
          ? ` (command verified: ${r.verification.result})`
          : r.verification?.result
            ? ` (self-reported: ${r.verification.result})`
            : "";
        return `  Row #${r.id} [${r.status}]${sourceTag} ${r.description}${verifyTag}`;
      })
      .join("\n");

    const logTail = summary.executionLogTail.slice(-10).join("\n");

    return `## Work Item
Title: ${summary.title}
Description: ${summary.description}
Effort: ${summary.effort}
Priority: ${summary.priority}

## ISC Rows (${summary.iscRows.length} total)
${iscSummary}

## Git Diff Stats
${summary.gitDiffStat || "(no changes)"}

## Execution Log (last 10 entries)
${logTail || "(no logs)"}

## Budget
Spent: $${summary.budgetSpent.toFixed(2)} / $${summary.budgetAllocated} allocated
Iterations: ${summary.iterationsUsed}

## Tier 1 Code Check Results
Verdict: ${tier1.verdict} (confidence: ${tier1.confidence.toFixed(2)})
${tier1.concerns.length > 0 ? `Concerns:\n${tier1.concerns.map(c => `- ${c}`).join("\n")}` : "No concerns from code checks."}

${summary.specContent ? `## Spec (relevant sections)\n${this.extractRelevantSpecSections(summary)}` : ""}

Do NOT trust the agent's self-reported ISC statuses. Verify against the spec and git diff independently. What's wrong or missing?`;
  }

  private buildTier3UserPrompt(summary: ItemReviewSummary, tier1: VerificationTier, tier2: VerificationTier): string {
    const iscSummary = summary.iscRows
      .map(r => {
        const sourceTag = r.source === "INFERRED" ? " [TEMPLATE]" : r.source === "EXPLICIT" ? " [spec-derived]" : "";
        const verifyTag = r.verification?.commandRan
          ? ` (command verified: ${r.verification.result})`
          : r.verification?.result
            ? ` (self-reported: ${r.verification.result})`
            : "";
        return `  Row #${r.id} [${r.status}]${sourceTag} ${r.description}${verifyTag}`;
      })
      .join("\n");

    const logTail = summary.executionLogTail.slice(-10).join("\n");

    return `## Work Item
Title: ${summary.title}
Description: ${summary.description}
Effort: ${summary.effort}
Priority: ${summary.priority}

## ISC Rows (${summary.iscRows.length} total)
${iscSummary}

## Git Diff Stats
${summary.gitDiffStat || "(no changes)"}

## Execution Log (last 10 entries)
${logTail || "(no logs)"}

## Budget
Spent: $${summary.budgetSpent.toFixed(2)} / $${summary.budgetAllocated} allocated
Iterations: ${summary.iterationsUsed}

## Tier 1 Code Check Results
Verdict: ${tier1.verdict} (confidence: ${tier1.confidence.toFixed(2)})
${tier1.concerns.length > 0 ? `Concerns:\n${tier1.concerns.map(c => `- ${c}`).join("\n")}` : "No concerns from code checks."}

## Tier 2 Inference Skeptic Results
Verdict: ${tier2.verdict} (confidence: ${tier2.confidence.toFixed(2)})
${tier2.concerns.length > 0 ? `Concerns:\n${tier2.concerns.map(c => `- ${c}`).join("\n")}` : "No concerns from inference review."}

${summary.specContent ? `## Spec (relevant sections)\n${this.extractRelevantSpecSections(summary)}` : ""}

IMPORTANT: Do NOT trust self-reported ISC statuses. Investigate all Tier 1 and Tier 2 concerns against the spec and git diff. Provide your definitive, independent assessment.`;
  }

  // --------------------------------------------------------------------------
  // Tier 1 Sub-Checks
  // --------------------------------------------------------------------------

  /**
   * FM-6: Check spec alignment using discrete requirement extraction.
   * Replaces keyword matching with structured requirement extraction and
   * multi-word phrase overlap for more accurate alignment checking.
   */
  private checkSpecAlignment(summary: ItemReviewSummary): { concerns: string[]; penalty: number } {
    const concerns: string[] = [];
    let penalty = 0;

    if (!summary.specContent) return { concerns, penalty };

    const requirements = this.extractRequirements(summary.specContent);
    if (requirements.length === 0) return { concerns, penalty };

    const iscText = summary.iscRows.map(r => r.description.toLowerCase()).join(" ");
    const iscWords = new Set(iscText.split(/\W+/).filter(w => w.length > 1));

    const unaddressed: string[] = [];

    for (const req of requirements) {
      const reqWords = req.toLowerCase().split(/\W+/).filter(w => w.length > 1);
      // Multi-word overlap: require at least 2 matching words or 40% of requirement words
      const matchCount = reqWords.filter(w => iscWords.has(w)).length;
      const threshold = Math.max(2, Math.ceil(reqWords.length * 0.4));

      if (matchCount < threshold) {
        unaddressed.push(req);
      }
    }

    if (unaddressed.length > 0) {
      const coverageRatio = (requirements.length - unaddressed.length) / requirements.length;

      if (coverageRatio < 0.3) {
        concerns.push(`Low spec alignment: ${unaddressed.length}/${requirements.length} requirements unaddressed`);
        for (const req of unaddressed.slice(0, 3)) {
          concerns.push(`  Unaddressed: "${req.slice(0, 80)}"`);
        }
        penalty = 0.2;
      } else if (coverageRatio < 0.6) {
        concerns.push(`Partial spec alignment: ${unaddressed.length}/${requirements.length} requirements unaddressed`);
        for (const req of unaddressed.slice(0, 2)) {
          concerns.push(`  Unaddressed: "${req.slice(0, 80)}"`);
        }
        penalty = 0.1;
      }
    }

    return { concerns, penalty };
  }

  /**
   * FM-6: Extract discrete requirements from spec content.
   * Pulls from must/should statements, ISC table rows, and checkbox items.
   */
  private extractRequirements(specContent: string): string[] {
    const requirements: string[] = [];
    const seen = new Set<string>();

    const addReq = (req: string) => {
      const trimmed = req.trim();
      if (trimmed.length < 5) return;
      const key = trimmed.toLowerCase().slice(0, 60);
      if (!seen.has(key)) {
        seen.add(key);
        requirements.push(trimmed);
      }
    };

    // 1. Must/should/required statements
    const statementPatterns = [
      /(?:must|shall)\s+(.+?)(?:\.|$)/gim,
      /(?:should)\s+(.+?)(?:\.|$)/gim,
      /required?:\s*(.+?)(?:\.|$)/gim,
    ];
    for (const pattern of statementPatterns) {
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(specContent)) !== null) {
        if (match[1]) addReq(match[1]);
      }
    }

    // 2. ISC table rows: | N | Description | ...
    const tableRowPattern = /\|\s*\d+\s*\|([^|]+)\|/g;
    let tableMatch: RegExpExecArray | null;
    while ((tableMatch = tableRowPattern.exec(specContent)) !== null) {
      if (tableMatch[1]) {
        const desc = tableMatch[1].trim();
        // Skip header-like rows
        if (!/^[-\s#]+$/.test(desc) && !/description/i.test(desc)) {
          addReq(desc);
        }
      }
    }

    // 3. Unchecked checkbox items: - [ ] requirement
    const checkboxPattern = /^[-*]\s+\[\s\]\s+(.+)$/gm;
    let cbMatch: RegExpExecArray | null;
    while ((cbMatch = checkboxPattern.exec(specContent)) !== null) {
      if (cbMatch[1]) addReq(cbMatch[1]);
    }

    return requirements;
  }

  /**
   * FM-7: Extract relevant spec sections for verification prompts.
   * Instead of blind truncation, prioritizes requirement-dense sections.
   */
  private extractRelevantSpecSections(summary: ItemReviewSummary): string {
    if (!summary.specContent) return "";

    const content = summary.specContent;
    const maxChars = 3000;

    // Split into sections by ## headings
    const sections = content.split(/(?=^##\s)/m);
    const iscDescriptions = summary.iscRows.map(r => r.description.toLowerCase());

    // Score sections by relevance
    const scored: Array<{ text: string; score: number }> = [];
    for (const section of sections) {
      const lower = section.toLowerCase();
      let score = 0;

      // High priority: title, requirements, ISC sections
      if (/^##?\s+(?:#?\s*\d+\.\s+)?(?:ideal state|isc|requirements?|acceptance|success)/im.test(section)) {
        score += 10;
      }

      // Medium priority: sections with requirement keywords
      const reqKeywords = (lower.match(/\b(?:must|should|shall|required?)\b/g) || []).length;
      score += reqKeywords * 2;

      // Checkbox items
      const checkboxes = (section.match(/^[-*]\s+\[[ x]\]/gm) || []).length;
      score += checkboxes;

      // Term overlap with ISC row descriptions
      for (const desc of iscDescriptions) {
        const descWords = desc.split(/\W+/).filter(w => w.length > 2);
        const overlapCount = descWords.filter(w => lower.includes(w)).length;
        score += overlapCount;
      }

      scored.push({ text: section, score });
    }

    // Sort by score descending
    scored.sort((a, b) => b.score - a.score);

    // Build output within budget
    const parts: string[] = [];
    let totalChars = 0;

    for (const { text } of scored) {
      if (totalChars + text.length > maxChars) {
        // Try to fit a truncated version of this section
        const remaining = maxChars - totalChars;
        if (remaining > 200) {
          parts.push(text.slice(0, remaining) + "\n[...truncated]");
        }
        break;
      }
      parts.push(text);
      totalChars += text.length;
    }

    return parts.join("\n");
  }

  /**
   * Check that files changed in git diff relate to ISC row descriptions.
   */
  private checkDiffDescriptionCoherence(summary: ItemReviewSummary): { concerns: string[]; penalty: number } {
    const concerns: string[] = [];
    let penalty = 0;

    if (!summary.gitDiffStat.trim()) return { concerns, penalty };

    // Extract filenames from diff stat
    const fileNames = summary.gitDiffStat
      .split("\n")
      .map(line => line.trim().split("|")[0]?.trim())
      .filter(Boolean)
      .map(f => f.toLowerCase());

    if (fileNames.length === 0) return { concerns, penalty };

    // Extract key terms from ISC row descriptions
    const descriptionTerms = summary.iscRows
      .map(r => r.description.toLowerCase())
      .join(" ")
      .split(/\W+/)
      .filter(w => w.length > 3);

    // Simple coherence: do any description terms appear in file paths?
    const relevantTerms = ["auth", "test", "api", "db", "config", "route", "middleware",
      "util", "service", "model", "controller", "view", "component", "hook",
      "style", "type", "schema", "migration", "seed", "fixture"];

    const descTermsSet = new Set(descriptionTerms);
    const fileTerms = fileNames.join(" ").split(/[\\/.\-_]+/).filter(w => w.length > 2);
    const fileTermsSet = new Set(fileTerms);

    // Check for complete disconnect between description and files
    const sharedTerms = relevantTerms.filter(t => descTermsSet.has(t) && fileTermsSet.has(t));

    if (sharedTerms.length === 0 && fileNames.length > 3) {
      // Many files changed but no terminology overlap — possible concern
      concerns.push("No terminology overlap between ISC descriptions and changed files — possible spec drift");
      penalty = 0.1;
    }

    return { concerns, penalty };
  }

  // --------------------------------------------------------------------------
  // Testing Support
  // --------------------------------------------------------------------------

  /**
   * @internal Expose config for testing
   */
  getConfig(): SkepticalVerifierConfig {
    return { ...this.config };
  }

  /**
   * @internal Expose verdict computation for direct testing
   */
  computeVerdictForTesting(tiers: VerificationTier[]): SkepticalReviewResult["finalVerdict"] {
    return this.computeFinalVerdict(tiers);
  }
}
