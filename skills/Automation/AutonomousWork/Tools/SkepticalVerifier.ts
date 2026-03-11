#!/usr/bin/env bun
/**
 * SkepticalVerifier.ts - Independent 2-phase verification for autonomous work
 *
 * Provides an independent "skeptical agent" check after task completion to catch:
 * - Paper completions (rows marked DONE with no real work)
 * - Spec drift (work that diverges from requirements)
 * - Quality gaps (code that passes tests but has issues)
 * - Missed edge cases the executor didn't consider
 *
 * Two verification phases:
 *   Phase 1: Evidence gathering (deterministic checks + filesystem) — $0.00, ~0ms
 *   Phase 2: Sonnet judgment (one inference call)                   — ~$0.30, ~30s
 *
 * TRIVIAL items skip Phase 2 and use Phase 1 verdict directly.
 *
 * Usage:
 *   import { SkepticalVerifier } from "./SkepticalVerifier.ts";
 *   const verifier = new SkepticalVerifier();
 *   const result = await verifier.review(itemSummary);
 */

import { join } from "path";
import { readFileSync } from "fs";
import { execFileSync } from "child_process";
import type { EffortLevel } from "./WorkQueue.ts";
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
}) => Promise<{ success: boolean; parsed?: unknown; output?: string; error?: string }>;

export interface SkepticalVerifierConfig {
  /** Skip inference (Phase 2) for TRIVIAL effort items — use Phase 1 verdict directly */
  skipInferenceForTrivial: boolean; // default: true
  /** Injectable inference function — falls back to dynamic import of Inference.ts */
  inferenceFn?: InferenceFn;
  /** Categories that must always run Phase 2, even for TRIVIAL effort */
  neverSkipCategories: ISCRowCategory[];
  /** Injectable spawn function — falls back to Bun.spawnSync for command execution */
  spawnFn?: (cmd: string) => { stdout: string; exitCode: number };
}

/** Project language/framework context for scoping verifier checks */
export interface ProjectContext {
  language: "typescript" | "python" | "go" | "rust" | "unknown";
  isKayaSkill: boolean;
  framework?: string;
  testPattern: "jest-style" | "pytest-style" | "unknown";
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
    disposition?: "automatable" | "human-required" | "deferred";
    rowEvidence?: { files?: string[]; commands?: string[]; summary?: string };
    verification?: {
      method: string;
      result?: "PASS" | "FAIL";
      commandRan?: boolean;
      command?: string;
    };
  }>;
  gitDiffStat: string;
  diffPathFilter?: string[];   // empty [] = API/external work (no diff expected)
  executionLogTail: string[];
  iterationsUsed: number;
  /** Concerns from the independent adversarial Explore agent (if ran) */
  adversarialConcerns?: string[];
  /** Working directory for independent verification (worktree or project path) */
  workingDir?: string;
  /** For multi-repo work: each repo's context for per-repo evidence gathering */
  repoContexts?: Array<{ name: string; cwd: string; startSha?: string }>;
  /** Project language/framework context for scoping language-specific checks */
  projectContext?: ProjectContext;
  /** Test strategy document content for test-level verification */
  testStrategyContent?: string;
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

/** Evidence gathered from filesystem and verification commands for Tier 2 enrichment */
export interface EvidenceResult {
  files: Array<{ path: string; content: string }>;
  commands: Array<{ cmd: string; stdout: string; exitCode: number }>;
  gitDiff?: { hasDiff: boolean; diffStat: string; linesChanged: number };
}

// ============================================================================
// Constants
// ============================================================================

const KAYA_HOME = process.env.KAYA_HOME || join(process.env.HOME || "", ".claude");

const DEFAULT_CONFIG: SkepticalVerifierConfig = {
  skipInferenceForTrivial: true,
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
   *
   * 2-phase flow:
   *   Phase 1: Deterministic checks + filesystem evidence gathering (free, always runs)
   *   Phase 2: Single Sonnet judgment call (~$0.30, skipped for TRIVIAL)
   */
  async review(summary: ItemReviewSummary): Promise<SkepticalReviewResult> {
    const tiers: VerificationTier[] = [];
    const allConcerns: string[] = [];
    const tiersSkipped: Array<{ tier: 2 | 3; reason: string }> = [];

    // Phase 1: Gather all evidence (filesystem + deterministic checks)
    const evidence = summary.effort !== "TRIVIAL" ? this.gatherEvidence(summary) : undefined;
    const phase1 = this.runTier1(summary, evidence);
    tiers.push(phase1);
    allConcerns.push(...phase1.concerns);

    // Phase 2: Sonnet judgment (skip for TRIVIAL unless gated categories present)
    const hasGatedCategories = summary.iscRows.some(
      r => r.category && this.config.neverSkipCategories.includes(r.category as ISCRowCategory)
    );

    if (this.config.skipInferenceForTrivial && summary.effort === "TRIVIAL" && !hasGatedCategories) {
      tiersSkipped.push({ tier: 2, reason: "TRIVIAL effort, no gated categories" });
    } else {
      const judgment = await this.judge(summary, phase1, evidence);
      tiers.push(judgment);
      allConcerns.push(...judgment.concerns);
    }

    // Final verdict: Phase 2 (judgment) is authoritative when it ran; otherwise Phase 1
    const lastTier = tiers[tiers.length - 1];
    const finalVerdict = lastTier.verdict;
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
  runTier1(summary: ItemReviewSummary, evidence?: EvidenceResult): VerificationTier {
    const start = performance.now();
    const concerns: string[] = [];
    let score = 1.0; // Start at perfect, deduct for issues

    // Check 1: Completion ratio — exclude human-required rows (expected gaps)
    const automatableRows = summary.iscRows.filter(r => r.disposition !== "human-required");
    const totalRows = automatableRows.length;
    const doneRows = automatableRows.filter(
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

    // Check 2b: Self-reported PASS without command execution (H7)
    const selfReportedPass = summary.iscRows.filter(
      r => r.verification?.result === "PASS" && !r.verification?.commandRan
    );
    if (selfReportedPass.length > 0) {
      const count = selfReportedPass.length;
      concerns.push(`${count} row(s) self-reported PASS without verification command: ${selfReportedPass.map(r => `#${r.id}`).join(", ")}`);
      score -= Math.min(0.15 * count, 0.3); // cap at -0.3
    }

    // API-only work (e.g. GitHub Profile via gh api) has no file changes by design
    const isApiWork = Array.isArray(summary.diffPathFilter) && summary.diffPathFilter.length === 0;

    // Check 3: Git diff emptiness — flagged as concern for Phase 2 judgment
    const diffLines = summary.gitDiffStat.trim().split("\n").filter(Boolean);
    const hasDiff = diffLines.length > 0 && !summary.gitDiffStat.includes("0 files changed");
    if (!hasDiff && totalRows > 0 && summary.effort !== "TRIVIAL" && !isApiWork) {
      concerns.push("No file changes detected in git diff — Phase 2 will evaluate contextually");
      // No score penalty — Sonnet judges whether missing diff is legitimate
    }

    // Check 3b: Cross-validate caller-supplied gitDiffStat (M10)
    if (summary.repoContexts && summary.repoContexts.length > 0) {
      // Multi-repo: run per-repo cross-validation
      const repoSections = this.parseMultiRepoDiffStat(summary.gitDiffStat);
      for (const repo of summary.repoContexts) {
        try {
          const independentDiff = execFileSync("git", ["diff", "--stat", "-M", "HEAD~1"],
            { encoding: "utf-8", cwd: repo.cwd, timeout: 5000 }).trim();
          const independentFiles = independentDiff.split("\n").filter(l => l.includes("|")).length;
          const repoSection = repoSections.find(s => s.name === repo.name);
          const reportedFiles = repoSection?.diffStat.split("\n").filter(l => l.includes("|")).length ?? 0;
          if (independentFiles === 0 && reportedFiles > 3 && !isApiWork) {
            concerns.push(`Cross-validation failed for [${repo.name}]: independent git diff shows 0 files but caller reported ${reportedFiles}`);
            score -= 0.3;
          }
        } catch {
          // Cross-validation is best-effort — don't penalize if git command fails
        }
      }
    } else if (summary.workingDir) {
      try {
        const independentDiff = execFileSync("git", ["diff", "--stat", "-M", "HEAD~1"],
          { encoding: "utf-8", cwd: summary.workingDir, timeout: 5000 }).trim();
        const independentFiles = independentDiff.split("\n").filter(l => l.includes("|")).length;
        const reportedFiles = summary.gitDiffStat?.split("\n").filter(l => l.includes("|")).length ?? 0;
        if (independentFiles === 0 && reportedFiles > 3 && !isApiWork) {
          concerns.push(`Cross-validation failed: independent git diff shows 0 files but caller reported ${reportedFiles}`);
          score -= 0.3;
        }
      } catch {
        // Cross-validation is best-effort — don't penalize if git command fails
      }
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
    // NOTE: .test. / .spec. / __tests__ ARE filename patterns — correctly detected in diff stat output
    const engineeringRows = summary.iscRows.filter(r => r.capability === "execution.engineer");
    if (engineeringRows.length > 0) {
      const testRows = summary.iscRows.filter(r => r.capability === "execution.testing");
      const testFilesMentioned = summary.gitDiffStat.match(/\.test\.|\.spec\.|__tests__|test_[\w.]+\.py|[\w]+_test\.py|tests\/[\w/]+\.py/gi);
      if (testRows.length === 0 && !testFilesMentioned) {
        concerns.push("Engineering work detected but no test files modified or test rows present");
        score -= 0.15;
      }
    }

    // (Checks 7 and 8 removed — budget and iteration anomaly detection removed with BudgetManager)
    const diffStats = this.parseDiffStats(summary.gitDiffStat);

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
      const hasTestFiles = /\.test\.|\.spec\.|__tests__|test_[\w.]+\.py|[\w]+_test\.py|tests\/[\w/]+\.py/.test(summary.gitDiffStat);
      if (!hasTestFiles) {
        concerns.push(`${testingRowsDone.length} testing row(s) marked complete but no test files in git diff`);
        score -= 0.25;
      }
    }

    // Check 13: CLAUDE.md compliance (CachedHTTPClient / StateManager)
    // Only applies to TypeScript Kaya skills — not Python/Go/other projects
    {
      const isKayaTypescript = summary.projectContext?.isKayaSkill === true &&
                               summary.projectContext?.language === "typescript";

      const iscText = summary.iscRows.map(r => r.description.toLowerCase()).join(" ");
      const hasHTTPWork = /\b(?:http|api|fetch|request|endpoint|webhook|scrape)\b/.test(iscText);
      const hasStateWork = /\b(?:state|persist|store|cache|json|config|settings)\b/.test(iscText);

      if (isKayaTypescript && summary.effort !== "TRIVIAL" && (hasHTTPWork || hasStateWork)) {
        // Build search corpus from evidence file contents (system-read, high trust)
        const evidenceContent = evidence
          ? evidence.files.map(f => f.content).join("\n").toLowerCase()
          : "";
        const hasEvidence = evidenceContent.length > 0;

        if (hasHTTPWork) {
          if (hasEvidence && !evidenceContent.includes("cachedhttpclient") && !evidenceContent.includes("cached-http")) {
            concerns.push("ISC describes HTTP/API work but CachedHTTPClient not found in evidence files — may use raw fetch()");
            score -= 0.1;
          } else if (!hasEvidence) {
            concerns.push("ISC describes HTTP/API work — no file evidence gathered, Phase 2 judgment will verify CachedHTTPClient usage");
            // No score deduction — defer to Phase 2 judgment which always gets evidence
          }
        }
        if (hasStateWork) {
          if (hasEvidence && !evidenceContent.includes("statemanager") && !evidenceContent.includes("state-manager") && !evidenceContent.includes("createstatemanager")) {
            concerns.push("ISC describes state/persistence work but StateManager not found in evidence files — may use raw JSON.parse(readFileSync())");
            score -= 0.1;
          } else if (!hasEvidence) {
            concerns.push("ISC describes state/persistence work — no file evidence gathered, Phase 2 judgment will verify StateManager usage");
          }
        }
      }
    }

    // Check 14: Stub detection (low code density)
    // Uses nonRenameFiles to avoid penalizing git mv renames that show | 0
    {
      const isStandardPlus = ["STANDARD", "THOROUGH", "DETERMINED"].includes(summary.effort);
      if (isStandardPlus) {
        const effectiveFiles = diffStats.nonRenameFiles;

        if (effectiveFiles >= 3 && diffStats.totalInsertions > 0 && diffStats.totalInsertions / effectiveFiles < 10) {
          concerns.push(`Low code density: ${diffStats.totalInsertions} insertions across ${effectiveFiles} files (${(diffStats.totalInsertions / effectiveFiles).toFixed(1)} lines/file avg) — possible skeleton/stub implementation`);
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
  // Phase 2: Sonnet Judgment (single inference call)
  // --------------------------------------------------------------------------

  /**
   * Single Sonnet inference call that receives all Phase 1 evidence and
   * produces the authoritative verdict. Replaces the old Tier 2 (Haiku) +
   * Tier 3 (Sonnet) two-step flow.
   *
   * Returns tier: 2 for backward compatibility with tiersExecuted tracking.
   */
  async judge(
    summary: ItemReviewSummary,
    phase1: VerificationTier,
    evidence?: EvidenceResult,
  ): Promise<VerificationTier> {
    const start = performance.now();

    const systemPrompt = `You are an INDEPENDENT VERIFICATION AGENT performing the sole judgment on autonomous work. Your job is to verify work against the ORIGINAL SPEC, not validate what the executing agent claims.

CRITICAL: The executing agent self-reported its own completion. You must verify independently.

DATA TRUST LEVELS:
- Git diff (HIGH trust): Actual file changes — objective evidence of work done
- ISC statuses (LOW trust): Self-reported by the executing agent — treat as claims, not facts
- Verification commands (HIGH trust when commandRan=true): Actually executed by the system
- Phase 1 code checks (MEDIUM trust): Deterministic checks, but can have false positives on edge cases

ISC rows marked "TEMPLATE" or source "INFERRED" were auto-generated, NOT derived from the spec. Template rows like "Implement core functionality" are generic placeholders — they do NOT demonstrate spec coverage.

IMPORTANT PATTERNS TO RECOGNIZE:
- Renamed files show "=> | 0" in git diff stat — this means 0 LINES CHANGED (it's a rename), NOT an empty file. A 29KB file renamed via git mv still shows | 0.
- API-only work (GitHub API, external services) legitimately has no file changes.
- Documentation/config tasks may have low test coverage by design.

EVALUATE:
1. Does the git diff show changes that address the SPEC requirements? (not just ISC row descriptions)
2. Are spec requirements actually covered by ISC rows, or was the spec ignored in favor of templates?
3. Were verification commands actually run, or just self-reported?
4. Do test file changes exist for testing claims?
5. Are Phase 1 concerns legitimate, or false positives given context?

Respond with ONLY valid JSON (no markdown, no code fences):
{"verdict":"PASS|FAIL|NEEDS_REVIEW","confidence":0.0-1.0,"concerns":["specific concern 1"],"recommendation":"what to do if FAIL","requirementsCovered":N,"requirementsTotal":N}`;

    const userPrompt = this.buildJudgePrompt(summary, phase1, evidence);

    try {
      const inferenceFn = this.config.inferenceFn
        ?? (await import("../../../../lib/core/Inference.ts")).inference;

      const result = await inferenceFn({
        systemPrompt,
        userPrompt,
        level: "standard", // Sonnet — single authoritative judgment
        expectJson: true,
        timeout: 180000,
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
          tier: 2,
          verdict: verdict as VerificationTier["verdict"],
          confidence,
          concerns,
          recommendation: typeof parsed.recommendation === "string" ? parsed.recommendation : undefined,
          costEstimate: 0.30,
          latencyMs: performance.now() - start,
        };
      }

      // Inference succeeded but no parseable result — infrastructure failure, not content verdict
      return {
        tier: 2,
        verdict: "NEEDS_REVIEW",
        confidence: 0.3,
        concerns: [`Phase 2 judgment returned unparseable result${result.output ? `: ${result.output.slice(0, 200)}` : ""}${result.error ? ` (error: ${result.error})` : ""}`],
        costEstimate: 0.30,
        latencyMs: performance.now() - start,
      };
    } catch (e) {
      // Inference unavailable — infrastructure failure, not content verdict. NEEDS_REVIEW, not FAIL.
      const errMsg = e instanceof Error ? e.message : String(e);
      const isInfrastructure = /timeout|unavailable|ECONNREFUSED|ETIMEDOUT|exit|spawn|process/i.test(errMsg);
      return {
        tier: 2,
        verdict: isInfrastructure ? "NEEDS_REVIEW" : "FAIL",
        confidence: 0.0,
        concerns: [`Phase 2 judgment unavailable: ${errMsg}`],
        costEstimate: 0,
        latencyMs: performance.now() - start,
      };
    }
  }



  // --------------------------------------------------------------------------
  // Prompt Builder
  // --------------------------------------------------------------------------

  private buildJudgePrompt(summary: ItemReviewSummary, phase1: VerificationTier, evidence?: EvidenceResult): string {
    const iscSummary = summary.iscRows
      .map(r => {
        const sourceTag = r.disposition === "human-required" ? " [HUMAN-REQUIRED: expected gap]" :
                          r.source === "INFERRED" ? " [TEMPLATE]" : r.source === "EXPLICIT" ? " [spec-derived]" : "";
        const verifyTag = r.verification?.commandRan
          ? ` (command verified: ${r.verification.result})`
          : r.verification?.result
            ? ` (self-reported: ${r.verification.result})`
            : "";
        const evidenceTag = r.rowEvidence?.summary
          ? ` [builder-evidence: "${r.rowEvidence.summary.slice(0, 60)}"]`
          : "";
        return `  Row #${r.id} [${r.status}]${sourceTag}${evidenceTag} ${r.description}${verifyTag}`;
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

## Phase 1 Deterministic Checks (${phase1.concerns.length} issue${phase1.concerns.length !== 1 ? "s" : ""} found)
${phase1.concerns.length > 0 ? phase1.concerns.map(c => `- ${c}`).join("\n") : "All deterministic checks passed — no issues found."}

${summary.specContent ? `## Spec (relevant sections)\n${this.extractRelevantSpecSections(summary)}` : ""}
${summary.testStrategyContent ? `## Test Strategy\n${summary.testStrategyContent.slice(0, 3000)}\n\nIf a test strategy is provided, verify that the correct test levels were used (unit vs integration vs e2e) and that smoke-priority items were covered with tests.` : ""}
${this.formatEvidence(evidence)}
${this.formatAdversarialConcerns(summary.adversarialConcerns)}
Do NOT trust the agent's self-reported ISC statuses. Evaluate Phase 1 concerns — are they legitimate or false positives given context? Verify against the spec and git diff independently. Provide your definitive, independent assessment.`;
  }

  // --------------------------------------------------------------------------
  // Evidence Gathering (Phase 2 enrichment)
  // --------------------------------------------------------------------------

  /**
   * Gather real evidence from the filesystem for Phase 2 judgment enrichment.
   * Reads files referenced in ISC descriptions and runs verification commands.
   * All operations are best-effort — failures are silently skipped.
   */
  gatherEvidence(summary: ItemReviewSummary): EvidenceResult {
    const files: EvidenceResult["files"] = [];
    const commands: EvidenceResult["commands"] = [];

    // Resolve home path and worktree-aware path mapping
    const homePath = process.env.HOME || "";
    const kayaHome = join(homePath, ".claude");
    const workingDir = summary.workingDir;

    // Helper: build candidate paths for a given absolute file path
    // Tries worktree-remapped path first, then the original path
    const buildCandidates = (filePath: string): string[] => {
      const candidates: string[] = [];
      // For relative paths: try workingDir-resolved first
      if (workingDir && !filePath.startsWith("/") && !filePath.startsWith("~")) {
        candidates.push(join(workingDir, filePath));
      }
      if (workingDir && filePath.startsWith(kayaHome + "/")) {
        // Remap ~/.claude/... paths to the worktree if workingDir is a worktree
        const relativePath = filePath.slice(kayaHome.length + 1);
        candidates.push(join(workingDir, relativePath));
      }
      candidates.push(filePath); // Original path as final fallback
      return candidates;
    };

    // Helper: try to read a file from candidate paths, return content or null
    const tryReadFile = (candidates: string[]): string | null => {
      for (const candidate of candidates) {
        try {
          return readFileSync(candidate, "utf-8").slice(0, 2000);
        } catch {
          // Try next candidate
        }
      }
      return null;
    };

    const seenPaths = new Set<string>();
    const MAX_FILES = 12; // Increased to accommodate diff-based + builder evidence

    // 1. Extract file paths from ISC row descriptions
    const filePathPattern = /(?:^|\s|["'`(])((?:\/|\.\/|~\/|[\w-]+\/)[\w\-./]+\.\w{1,6})/g;

    for (const row of summary.iscRows) {
      let match: RegExpExecArray | null;
      while ((match = filePathPattern.exec(row.description)) !== null) {
        let filePath = match[1].trim();
        if (filePath.startsWith("~/")) {
          filePath = join(homePath, filePath.slice(2));
        }

        if (!seenPaths.has(filePath) && files.length < MAX_FILES) {
          seenPaths.add(filePath);
          const content = tryReadFile(buildCandidates(filePath));
          if (content) {
            files.push({ path: filePath, content });
          }
        }
      }
      filePathPattern.lastIndex = 0;
    }

    // 2. Diff-based evidence: extract file paths from gitDiffStat and read from worktree/repos
    // This is critical for worktree-based work where ISC descriptions may not contain literal paths
    if (summary.gitDiffStat && files.length < MAX_FILES) {
      if (summary.repoContexts && summary.repoContexts.length > 0) {
        // Multi-repo: parse [repo-name] sections, read files from each repo's cwd
        const repoSections = this.parseMultiRepoDiffStat(summary.gitDiffStat);
        for (const { name, diffStat } of repoSections) {
          const repo = summary.repoContexts.find(r => r.name === name);
          if (!repo) continue;
          const diffPaths = this.extractPathsFromDiffStat(diffStat);
          for (const diffPath of diffPaths) {
            if (files.length >= MAX_FILES) break;
            const absPath = join(repo.cwd, diffPath);
            const canonicalKey = `${name}/${diffPath}`;
            if (seenPaths.has(absPath) || seenPaths.has(canonicalKey)) continue;
            seenPaths.add(absPath);
            seenPaths.add(canonicalKey);
            try {
              const content = readFileSync(absPath, "utf-8").slice(0, 2000);
              // Prefix path with repo name so judge knows which repo it came from
              files.push({ path: canonicalKey, content });
            } catch {
              // File may have been deleted in the diff — skip
            }
          }
        }
      } else if (workingDir) {
        // Single-repo: existing behavior
        const diffPaths = this.extractPathsFromDiffStat(summary.gitDiffStat);
        for (const diffPath of diffPaths) {
          if (files.length >= MAX_FILES) break;
          // diffPaths are relative (e.g., "skills/Auth/SKILL.md") — resolve against worktree
          const absPath = join(workingDir, diffPath);
          const canonicalKey = diffPath; // Use relative path as key to avoid dupes with ISC paths
          if (seenPaths.has(absPath) || seenPaths.has(canonicalKey)) continue;
          seenPaths.add(absPath);
          seenPaths.add(canonicalKey);
          try {
            const content = readFileSync(absPath, "utf-8").slice(0, 2000);
            files.push({ path: diffPath, content });
          } catch {
            // File may have been deleted in the diff — skip
          }
        }
      }
    }

    // 3. Run ISC verification commands (max 5, 10s timeout each)
    // FIX: Pass workingDir as cwd so commands run in the correct worktree context
    for (const row of summary.iscRows) {
      const cmd = row.verification?.command;
      if (!cmd || commands.length >= 5) continue;

      const spawnFn = this.config.spawnFn ?? ((c: string) => {
        const proc = Bun.spawnSync(["sh", "-c", c], {
          timeout: 10000,
          ...(workingDir ? { cwd: workingDir } : {}),
        });
        const stdout = proc.stdout.toString("utf-8").slice(0, 2000);
        const stderr = proc.stderr.toString("utf-8").slice(0, 500);
        const output = stderr ? `${stdout}\nSTDERR: ${stderr}` : stdout;
        return { stdout: output.slice(0, 2000), exitCode: proc.exitCode };
      });
      const result = spawnFn(cmd);
      commands.push({
        cmd,
        stdout: result.stdout,
        exitCode: result.exitCode,
      });
    }

    // 4. Merge builder-supplied execution evidence from ISC rows
    for (const row of summary.iscRows) {
      if (!row.rowEvidence) continue;
      if (row.rowEvidence.files) {
        for (const filePath of row.rowEvidence.files) {
          if (files.length >= MAX_FILES || seenPaths.has(filePath)) continue;
          seenPaths.add(filePath);
          const content = tryReadFile(buildCandidates(filePath));
          if (content) files.push({ path: filePath, content });
        }
      }
      if (row.rowEvidence.summary && commands.length < 5) {
        commands.push({
          cmd: `[builder-evidence row #${row.id}]`,
          stdout: row.rowEvidence.summary,
          exitCode: 0,
        });
      }
    }

    // Populate gitDiff evidence from summary
    const gdLines = summary.gitDiffStat.trim().split("\n").filter(Boolean);
    const gdHasDiff = gdLines.length > 0 && !summary.gitDiffStat.includes("0 files changed");
    const gdLinesChanged = gdLines.reduce((sum, line) => {
      const m = line.match(/(\d+) insertions?.*?(\d+) deletions?/);
      return sum + (m ? parseInt(m[1]) + parseInt(m[2]) : 0);
    }, 0);

    return { files, commands, gitDiff: { hasDiff: gdHasDiff, diffStat: summary.gitDiffStat, linesChanged: gdLinesChanged } };
  }

  /**
   * Extract relative file paths from git diff --stat output.
   * Handles regular files and renames (old => new).
   * Returns paths sorted by change magnitude (most changed first).
   */
  extractPathsFromDiffStat(diffStat: string): string[] {
    const lines = diffStat.trim().split("\n").filter(Boolean);
    const pathsWithWeight: Array<{ path: string; weight: number }> = [];

    for (const line of lines) {
      // Skip summary line ("3 files changed, 260 insertions(+)")
      if (/\d+\s+files?\s+changed/.test(line)) continue;

      // Parse: " path/to/file.ts | 120 +++++++++" or " old => new | 0"
      const match = line.match(/^\s*(.+?)\s*\|\s*(\d+)/);
      if (!match) continue;

      const pathPart = match[1].trim();
      const changeCount = parseInt(match[2], 10);

      // Handle renames: "old/path => new/path" or "{old => new}/rest"
      let filePath: string;
      if (pathPart.includes("=>")) {
        // Prefer the new (destination) path
        const renameParts = pathPart.split("=>");
        const newPart = renameParts[1]?.trim();
        if (!newPart) continue;
        // Handle brace notation: "dir/{old.ts => new.ts}" → "dir/new.ts"
        if (pathPart.includes("{")) {
          const braceMatch = pathPart.match(/^(.*?)\{.*?=>\s*(.*?)\}(.*)$/);
          if (braceMatch) {
            filePath = `${braceMatch[1]}${braceMatch[2]}${braceMatch[3]}`.trim();
          } else {
            filePath = newPart;
          }
        } else {
          filePath = newPart;
        }
      } else {
        filePath = pathPart;
      }

      // Skip binary files, non-code artifacts
      if (!filePath || filePath.includes("(binary)")) continue;

      pathsWithWeight.push({ path: filePath, weight: changeCount });
    }

    // Sort by change magnitude (most changed first) for maximum evidence value
    return pathsWithWeight
      .sort((a, b) => b.weight - a.weight)
      .map(p => p.path);
  }

  /**
   * Parse a multi-repo diff stat string (produced by WorkOrchestrator.getGitDiffStat multi-repo)
   * into per-repo sections.
   *
   * Input format:
   *   [timeseries-forecasting]
   *    src/main.py | 42 +++
   *   [mlops-serving]
   *    src/app.py | 18 +++
   *
   * Returns array of { name, diffStat } — one entry per [repo-name] header found.
   */
  parseMultiRepoDiffStat(diffStat: string): Array<{ name: string; diffStat: string }> {
    const result: Array<{ name: string; diffStat: string }> = [];
    const lines = diffStat.split("\n");
    let currentName: string | null = null;
    let currentLines: string[] = [];

    for (const line of lines) {
      const headerMatch = line.match(/^\[([^\]]+)\]$/);
      if (headerMatch) {
        if (currentName !== null) {
          result.push({ name: currentName, diffStat: currentLines.join("\n") });
        }
        currentName = headerMatch[1];
        currentLines = [];
      } else if (currentName !== null) {
        currentLines.push(line);
      }
    }
    // Flush last section
    if (currentName !== null) {
      result.push({ name: currentName, diffStat: currentLines.join("\n") });
    }
    return result;
  }

  /**
   * Format evidence for inclusion in verification prompts.
   * Returns empty string when no evidence is available.
   */
  private formatEvidence(evidence?: EvidenceResult): string {
    if (!evidence || (evidence.files.length === 0 && evidence.commands.length === 0)) {
      return "";
    }

    const parts: string[] = ["\n## Actual Evidence (system-read, not agent-reported)"];

    if (evidence.files.length > 0) {
      parts.push("\n### Files Read");
      for (const file of evidence.files) {
        parts.push(`\n**${file.path}** (first 2000 chars):\n\`\`\`\n${file.content}\n\`\`\``);
      }
    }

    if (evidence.commands.length > 0) {
      parts.push("\n### Verification Commands Run");
      for (const cmd of evidence.commands) {
        parts.push(`\n**\`${cmd.cmd}\`** → exit ${cmd.exitCode}:\n\`\`\`\n${cmd.stdout}\n\`\`\``);
      }
    }

    return parts.join("\n");
  }

  /**
   * Format adversarial concerns for inclusion in verification prompts.
   * Returns empty string when no concerns are available.
   */
  private formatAdversarialConcerns(concerns?: string[]): string {
    if (!concerns || concerns.length === 0) return "";

    return `\n## Adversarial Agent Concerns (independent Explore agent findings)
IMPORTANT: An independent adversarial agent reviewed this work and found the following concerns. Evaluate each one against the actual evidence.
${concerns.map((c, i) => `${i + 1}. ${c}`).join("\n")}
`;
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
   * When ISC table rows (Pass 2) finds >= 3 rows, those are authoritative —
   * prose matching (Pass 1) is suppressed to prevent overcounting.
   * Falls back to Pass 1 + Pass 3 only when no ISC table exists.
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

    // Pass 2 (run first): ISC table rows — authoritative when present
    const tableRequirements: string[] = [];
    const tableRowPattern = /\|\s*\d+\s*\|([^|]+)\|/g;
    let tableMatch: RegExpExecArray | null;
    while ((tableMatch = tableRowPattern.exec(specContent)) !== null) {
      if (tableMatch[1]) {
        const desc = tableMatch[1].trim();
        if (!/^[-\s#]+$/.test(desc) && !/description/i.test(desc)) {
          tableRequirements.push(desc);
        }
      }
    }

    // When >= 3 ISC table rows found, use ONLY those as authoritative requirements
    if (tableRequirements.length >= 3) {
      for (const req of tableRequirements) addReq(req);
      return requirements;
    }

    // Fallback: Pass 1 (must/should prose) + Pass 2 table rows + Pass 3 (checkboxes)
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

    for (const req of tableRequirements) addReq(req);

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
   * Parse git diff --stat output to extract file counts, insertions, and rename info.
   * Rename-only lines (contain => and | 0) are counted separately so they don't
   * inflate file counts or deflate insertion ratios in paper-completion checks.
   */
  parseDiffStats(diffStat: string): {
    totalFiles: number;
    totalInsertions: number;
    totalDeletions: number;
    renameCount: number;
    nonRenameFiles: number;
    substantialEvidence: boolean;
  } {
    const insertionMatch = diffStat.match(/(\d+)\s+insertion/);
    const filesMatch = diffStat.match(/(\d+)\s+file/);
    const deletionMatch = diffStat.match(/(\d+)\s+deletion/);

    const totalInsertions = insertionMatch ? parseInt(insertionMatch[1]) : 0;
    const totalFiles = filesMatch ? parseInt(filesMatch[1]) : 0;
    const totalDeletions = deletionMatch ? parseInt(deletionMatch[1]) : 0;

    // Count rename-only lines: contain => and | 0 (0 content changes)
    const lines = diffStat.trim().split("\n").filter(Boolean);
    let renameCount = 0;
    for (const line of lines) {
      if (/\d+\s+files?\s+changed/.test(line)) continue; // skip summary line
      if (line.includes("=>") && /\|\s*0\s*$/.test(line)) {
        renameCount++;
      }
    }

    const nonRenameFiles = Math.max(0, totalFiles - renameCount);
    // "Substantial evidence" = significant code changes in the diff,
    // proving real work happened even if bookkeeping is missing
    // NOTE: File copies inflate insertion count. Raised threshold (50→200) partially mitigates.
    // True fix requires full diff content parsing — deferred.
    const substantialEvidence = totalInsertions >= 200 && nonRenameFiles >= 3;

    return { totalFiles, totalInsertions, totalDeletions, renameCount, nonRenameFiles, substantialEvidence };
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
    const STOPWORDS = new Set(["the", "and", "for", "with", "from", "this", "that", "have",
      "been", "will", "should", "must", "each", "into", "when", "also", "like", "just"]);
    const dynamicTerms = descriptionTerms.filter(w => w.length > 3 && !STOPWORDS.has(w));

    const fileTerms = fileNames.join(" ").split(/[\\/.\-_]+/).filter(w => w.length > 2);
    const fileTermsSet = new Set(fileTerms);

    // Check for complete disconnect between description and files
    const sharedTerms = dynamicTerms.filter(t => fileTermsSet.has(t));

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
   * @internal Expose verdict computation for direct testing.
   * In the 2-phase model, the last tier in the array is authoritative.
   */
  computeVerdictForTesting(tiers: VerificationTier[]): SkepticalReviewResult["finalVerdict"] {
    if (tiers.length === 0) return "NEEDS_REVIEW";
    return tiers[tiers.length - 1].verdict;
  }
}
