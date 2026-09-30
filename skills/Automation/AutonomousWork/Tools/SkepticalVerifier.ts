#!/usr/bin/env bun
/**
 * SkepticalVerifier.ts - Independent 3-gate verification for autonomous work
 *
 * Provides an independent "skeptical agent" check after task completion to catch:
 * - Paper completions (rows marked DONE with no real work)
 * - Spec drift (work that diverges from requirements)
 * - Quality gaps (code that passes tests but has issues)
 * - Missed edge cases the executor didn't consider
 *
 * Three gates (the only verification path — Phase 6 consolidation):
 *   Gate 1 — Deterministic floor: evidence gathering + Tier 1 checks (exit codes,
 *            git cross-validation, zero-command-evidence alarm). $0.00, ~0ms.
 *   Gate 2 — Phase L live exercise: an Explorer actually runs the artifact. A live
 *            FAIL (incl. "no live evidence") hard-blocks Gate 3. native → human.
 *   Gate 3 — One LLM judge (Sonnet) for subjective completeness.  ~$0.30, ~30s.
 *
 * TRIVIAL items with no gated category skip Gate 3 and use the Gate 1 verdict.
 *
 * Usage:
 *   import { SkepticalVerifier } from "./SkepticalVerifier.ts";
 *   const verifier = new SkepticalVerifier();
 *   const result = await verifier.review(itemSummary);
 */

import type { EffortLevel } from "./WorkQueue.ts";
import type { FaultClass } from "./WorkOrchestrator.ts";
import { runLiveVerification as liveVerifyImpl, type LiveVerifierInput, type LiveVerificationResult } from "./LiveVerifier.ts";
import { VERIFIER_SCOPE, buildExecutableAllowlist } from "../../../../lib/core/CommandSafety.ts";
import {
  gatherEvidence as _gatherEvidence,
  runTier1 as _runTier1,
  judge as _judge,
  applyDeterministicFloor as _applyDeterministicFloor,
  buildJudgePrompt as _buildJudgePrompt,
  extractRelevantSpecSections as _extractRelevantSpecSections,
  parseDiffStats as _parseDiffStats,
  extractPathsFromDiffStat as _extractPathsFromDiffStat,
  parseMultiRepoDiffStat as _parseMultiRepoDiffStat,
  runPhaseL as _runPhaseL,
} from "./lib/verifier/index.ts";

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
  /** Deterministic check failures (test exit codes, git cross-validation) that Phase 2 cannot override to PASS */
  deterministicFailures?: Array<{ checkName: string; detail: string }>;
}

/** Injectable inference function — allows test mocking without dynamic import */
export type InferenceFn = (opts: {
  systemPrompt: string;
  userPrompt: string;
  level: string;
  expectJson: boolean;
  timeout: number;
}) => Promise<{ success: boolean; parsed?: unknown; output?: string; error?: string }>;

/** Injectable Gate 2 (Phase L) live-verification engine — DI seam for tests. */
export type LiveVerifyFn = (input: LiveVerifierInput) => Promise<LiveVerificationResult>;

export interface SkepticalVerifierConfig {
  /** Injectable inference function — falls back to dynamic import of Inference.ts */
  inferenceFn?: InferenceFn;
  /** Injectable spawn function — falls back to Bun.spawnSync for command execution */
  spawnFn?: (cmd: string) => { stdout: string; exitCode: number };
  /**
   * Injectable Gate 2 (Phase L) engine — falls back to the real runLiveVerification
   * (a headless Explorer / self-verify harness). Lets tests drive Phase L without
   * spawning a real agent.
   */
  liveVerifyFn?: LiveVerifyFn;
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
      /** Expected exit code for the verification command. Default 0. Use 1 for negative assertions (e.g. grep returning no match). */
      expectedExitCode?: number;
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
  /** Test execution results from the Verifier agent's Gate A + Gate B runs */
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
   * Gate 2 — Phase L live-exercise input. When provided, the MANDATORY Phase L gate
   * runs — an Explorer agent actually runs the artifact. A live FAIL (incl. "no live
   * evidence") hard-blocks Gate 3 and forces a FAIL verdict.
   */
  liveVerificationInput?: LiveVerifierInput;
  /**
   * Builder self-verification transcript (Step 1.5) from item metadata — the live
   * interactions the BUILDER ran while building. Context for Phase 2 and a signal
   * for Tier 1 (a runnable item with no builder self-verification is a concern).
   */
  liveVerificationTranscript?: Array<{
    iteration: number;
    surface: string;
    command: string;
    observed: string;
    exitCode?: number;
    verdict: "PASS" | "FAIL";
    timestamp?: string;
  }>;
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
  /**
   * Gate 2 (Phase L) outcome. true = live exercise passed; false = hard-blocked on a
   * live FAIL (incl. no-evidence); undefined = Phase L skipped (no input) or deferred
   * to a human (native surface).
   */
  liveVerificationPassed?: boolean;
  /**
   * Structured fault class set at origin, flowing forward to classifyFailure.
   * "environment" when liveVerificationPassed === false (the execution context could
   * not verify the work — not a code fault). undefined in all other cases.
   * S3a: additive carrier only; S3b will wire this into classifyFailure().
   */
  faultClass?: FaultClass;
}

/** Evidence gathered from filesystem and verification commands for Tier 2 enrichment */
export interface EvidenceResult {
  files: Array<{ path: string; content: string }>;
  commands: Array<{
    cmd: string;
    stdout: string;
    exitCode: number;
    /** Carried through from verification.expectedExitCode for debugging/observability. */
    expectedExitCode?: number;
    /** True when exitCode === (expectedExitCode ?? 0). Policy decision made at gather time. */
    passed: boolean;
  }>;
  gitDiff?: { hasDiff: boolean; diffStat: string; linesChanged: number };
  /**
   * Fix #4: aggregate of ISC verify-command execution outcomes. Lets Tier1 raise
   * a deterministic "0 command evidence gathered" alarm when verify commands are
   * declared but none could run (all shell-operator/allowlist/catastrophic-blocked),
   * the hole that let mq4kdqs0 pass on builder self-report alone.
   */
  commandEvidence?: {
    /** ISC rows that ship a verification command. */
    declared: number;
    /** Commands that actually spawned a process. */
    executed: number;
    /** Commands a security gate rejected before execution. */
    blocked: number;
  };
}

// ============================================================================
// Constants
// ============================================================================

/**
 * ISC 12: Named constant for Phase 2 cost estimate.
 * Replace hardcoded 0.30 literals — this is a placeholder until real token
 * measurement is wired in from the inference response.
 */
export const PHASE_2_COST_ESTIMATE_USD = 0.30;

const DEFAULT_CONFIG: SkepticalVerifierConfig = {};

// Safe executables for ISC verification commands.
// Must be explicitly listed — shell builtins, pipe operators,
// and semicolons in the command string still pass through sh -c,
// so we validate the FIRST token only (the primary executable).
// Moved to lib/core/CommandSafety.ts (L2 command-safety consolidation) — this
// is the "verifier" scope's resolved allowlist, reconstructed here for
// backward compatibility with lib/verifier/Evidence.ts's direct import.
export const VERIFICATION_ALLOWED_EXECUTABLES = buildExecutableAllowlist(VERIFIER_SCOPE);

// ============================================================================
// SkepticalVerifier Class
// ============================================================================

export class SkepticalVerifier {
  private config: SkepticalVerifierConfig;

  constructor(config?: Partial<SkepticalVerifierConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // --------------------------------------------------------------------------
  // Main Review Entry Point — the 3-gate flow (Phase 6)
  // --------------------------------------------------------------------------

  /**
   * Run skeptical review on a completed work item through the three gates:
   *
   *   Gate 1 — Deterministic floor: evidence gathering (non-TRIVIAL only) + Tier 1
   *            checks (exit codes, cross-validation, zero-command-evidence alarm).
   *   Gate 2 — Phase L: an Explorer actually runs the artifact. A live FAIL (incl.
   *            "no live evidence") hard-blocks Gate 3 → FAIL. native → human-required
   *            (non-blocking — never an auto-PASS of native UI).
   *   Gate 3 — LLM judge (Sonnet). Skipped for TRIVIAL effort with no gated category
   *            (the verdict then comes from Gate 1, after the deterministic floor).
   */
  async review(summary: ItemReviewSummary): Promise<SkepticalReviewResult> {
    const tiers: VerificationTier[] = [];
    const concerns: string[] = [];
    const tiersSkipped: Array<{ tier: 2 | 3; reason: string }> = [];

    // S2 de-determinize: the LLM judge (Gate 3) ALWAYS runs. The old skip-for-TRIVIAL
    // optimization (gated by category/skipInferenceForTrivial) is gone — with cost no
    // longer a concern, every item gets a judgment pass.

    // Gate 1 — deterministic floor. TRIVIAL summaries never gather filesystem
    // evidence (no command execution); Tier 1 still runs on the summary alone.
    const evidence = summary.effort !== "TRIVIAL" ? _gatherEvidence(summary, this.config) : undefined;
    const phase1Tier = _runTier1(summary, evidence);
    tiers.push(phase1Tier);
    concerns.push(...phase1Tier.concerns);

    // Gate 2 — Phase L live exercise. A live FAIL (incl. "no live evidence") is a
    // hard block: Gate 3 does not run and the verdict is FAIL. native/undrivable →
    // human-required (passed:true, non-blocking — the rows are dispositioned upstream).
    const liveVerify: LiveVerifyFn = this.config.liveVerifyFn ?? ((input) => liveVerifyImpl(input));
    const live = await _runPhaseL(summary.liveVerificationInput, liveVerify);
    if (live.tier) tiers.push(live.tier);
    concerns.push(...live.concerns);
    if (live.ran && !live.passed) {
      tiersSkipped.push({ tier: 2, reason: "Phase L live verification failed — hard block" });
      return this.finalize("FAIL", tiers, tiersSkipped, concerns, false);
    }

    // Gate 3 — LLM judge. Always runs (S2: no TRIVIAL/category skip).
    const phase2Tier = await this.judge(summary, phase1Tier, evidence);
    tiers.push(phase2Tier);
    concerns.push(...phase2Tier.concerns);

    const lastTier = tiers[tiers.length - 1];
    const verdict = _applyDeterministicFloor(tiers, lastTier.verdict, concerns);
    return this.finalize(verdict, tiers, tiersSkipped, concerns, live.livePassed);
  }

  /** Assemble the SkepticalReviewResult — totals cost/latency across the gate tiers. */
  private finalize(
    finalVerdict: SkepticalReviewResult["finalVerdict"],
    tiers: VerificationTier[],
    tiersSkipped: Array<{ tier: 2 | 3; reason: string }>,
    concerns: string[],
    liveVerificationPassed: boolean | undefined,
  ): SkepticalReviewResult {
    return {
      finalVerdict,
      tiers,
      tiersSkipped,
      totalCost: tiers.reduce((sum, t) => sum + t.costEstimate, 0),
      totalLatencyMs: tiers.reduce((sum, t) => sum + t.latencyMs, 0),
      concerns,
      liveVerificationPassed,
      // S3a: set faultClass at origin. liveVerificationPassed===false is a hard live-FAIL —
      // the execution context could not verify (environment fault), not a code fault.
      faultClass: liveVerificationPassed === false ? "environment" : undefined,
    };
  }

  // --------------------------------------------------------------------------
  // Tier 1: Code-Based Checks
  // --------------------------------------------------------------------------

  /**
   * Pure code checks — no inference cost.
   * Shim: delegates to lib/verifier/Tier1.ts runTier1() pure function.
   */
  runTier1(summary: ItemReviewSummary, evidence?: EvidenceResult): VerificationTier {
    return _runTier1(summary, evidence);
  }

  // --------------------------------------------------------------------------
  // Phase 2: Sonnet Judgment (single inference call)
  // --------------------------------------------------------------------------

  /**
   * Phase 2 Sonnet judgment.
   * Shim: delegates to lib/verifier/Judge.ts judge() pure function.
   */
  async judge(
    summary: ItemReviewSummary,
    phase1: VerificationTier,
    evidence?: EvidenceResult,
  ): Promise<VerificationTier> {
    return _judge(summary, phase1, evidence, {
      inferenceFn: this.config.inferenceFn,
      extractSpecFn: _extractRelevantSpecSections,
    });
  }

  // --------------------------------------------------------------------------
  // Prompt Builder (shim for test backward-compatibility)
  // --------------------------------------------------------------------------

  /**
   * @internal Shim — accessed via prototype cast in tests.
   * Delegates to lib/verifier/Judge.ts buildJudgePrompt().
   */
  private buildJudgePrompt(summary: ItemReviewSummary, phase1: VerificationTier, evidence?: EvidenceResult): string {
    return _buildJudgePrompt(summary, phase1, evidence, _extractRelevantSpecSections);
  }

  // --------------------------------------------------------------------------
  // Evidence Gathering (Phase 2 enrichment)
  // --------------------------------------------------------------------------

  /**
   * Gather real evidence from the filesystem for Phase 2 judgment enrichment.
   * Shim: delegates to lib/verifier/Evidence.ts gatherEvidence() pure function.
   */
  gatherEvidence(summary: ItemReviewSummary): EvidenceResult {
    return _gatherEvidence(summary, this.config);
  }

  /**
   * Extract relative file paths from git diff --stat output.
   * Shim: delegates to lib/verifier/Tier1.ts extractPathsFromDiffStat().
   */
  extractPathsFromDiffStat(diffStat: string): string[] {
    return _extractPathsFromDiffStat(diffStat);
  }

  /**
   * Parse a multi-repo diff stat string into per-repo sections.
   * Shim: delegates to lib/verifier/Tier1.ts parseMultiRepoDiffStat().
   */
  parseMultiRepoDiffStat(diffStat: string): Array<{ name: string; diffStat: string }> {
    return _parseMultiRepoDiffStat(diffStat);
  }

  /**
   * Parse git diff --stat output to extract file counts, insertions, and rename info.
   * Shim: delegates to lib/verifier/Tier1.ts parseDiffStats().
   */
  parseDiffStats(diffStat: string): {
    totalFiles: number;
    totalInsertions: number;
    totalDeletions: number;
    renameCount: number;
    nonRenameFiles: number;
    substantialEvidence: boolean;
  } {
    return _parseDiffStats(diffStat);
  }

  // --------------------------------------------------------------------------
  // Private shims for test backward-compatibility (accessed via prototype cast)
  // --------------------------------------------------------------------------

  /**
   * @internal Shim — accessed via prototype cast in tests.
   * Delegates to lib/verifier/Tier1.ts extractRelevantSpecSections().
   */
  private extractRelevantSpecSections(summary: ItemReviewSummary): string {
    return _extractRelevantSpecSections(summary);
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
   * Deterministic Floor Principle shim.
   * Delegates to lib/verifier/DeterministicFloor.ts applyDeterministicFloor().
   */
  private applyDeterministicFloor(
    tiers: VerificationTier[],
    verdict: SkepticalReviewResult["finalVerdict"],
    concerns: string[]
  ): SkepticalReviewResult["finalVerdict"] {
    return _applyDeterministicFloor(tiers, verdict, concerns);
  }

  /**
   * @internal Expose verdict computation for direct testing.
   * In the 2-phase model, the last tier in the array is authoritative.
   */
  computeVerdictForTesting(tiers: VerificationTier[]): SkepticalReviewResult["finalVerdict"] {
    if (tiers.length === 0) return "NEEDS_REVIEW";
    const rawVerdict = tiers[tiers.length - 1].verdict;
    const concerns: string[] = [];
    return this.applyDeterministicFloor(tiers, rawVerdict, concerns);
  }
}
