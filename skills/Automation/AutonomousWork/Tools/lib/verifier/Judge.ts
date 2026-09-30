/**
 * Judge.ts - Phase 2 Sonnet inference call for skeptical verification.
 *
 * Houses the judge() pure function, plus buildJudgePrompt, formatEvidence,
 * and formatAdversarialConcerns (all private to this module).
 */

import type {
  EvidenceResult,
  InferenceFn,
  ItemReviewSummary,
  VerificationTier,
} from "../../../Tools/SkepticalVerifier.ts";
import { PHASE_2_COST_ESTIMATE_USD } from "../../../Tools/SkepticalVerifier.ts";

// Signature of extractRelevantSpecSections — injected to avoid circular import.
type ExtractSpecFn = (summary: ItemReviewSummary) => string;

export interface JudgeOpts {
  /** Injectable inference function — falls back to dynamic import of Inference.ts. */
  inferenceFn?: InferenceFn;
  /** Function that extracts relevant spec sections for the prompt. */
  extractSpecFn: ExtractSpecFn;
}

/**
 * Single Sonnet inference call that receives all Phase 1 evidence and
 * produces the authoritative verdict.
 *
 * Returns tier: 2 for backward compatibility with tiersExecuted tracking.
 */
export async function judge(
  summary: ItemReviewSummary,
  phase1: VerificationTier,
  evidence: EvidenceResult | undefined,
  opts: JudgeOpts,
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

  const userPrompt = buildJudgePrompt(summary, phase1, evidence, opts.extractSpecFn);

  try {
    const inferenceFn = opts.inferenceFn
      ?? (await import("../../../../../../lib/core/Inference.ts")).inference;

    const result = await inferenceFn({
      systemPrompt,
      userPrompt,
      level: "standard",
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
        costEstimate: PHASE_2_COST_ESTIMATE_USD,
        latencyMs: performance.now() - start,
      };
    }

    // Inference succeeded but no parseable result — infrastructure failure.
    return {
      tier: 2,
      verdict: "NEEDS_REVIEW",
      confidence: 0.3,
      concerns: [
        `Phase 2 judgment returned unparseable result${result.output ? `: ${result.output.slice(0, 200)}` : ""}${result.error ? ` (error: ${result.error})` : ""}`,
      ],
      costEstimate: PHASE_2_COST_ESTIMATE_USD,
      latencyMs: performance.now() - start,
    };
  } catch (e) {
    // Inference unavailable — infrastructure failure, not content verdict.
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

/**
 * Build the user prompt for the Phase 2 judge inference call.
 * Exported so SkepticalVerifier can keep a shim for test backward-compatibility.
 */
export function buildJudgePrompt(
  summary: ItemReviewSummary,
  phase1: VerificationTier,
  evidence: EvidenceResult | undefined,
  extractSpecFn: ExtractSpecFn,
): string {
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

${summary.specContent ? `## Spec (relevant sections)\n${extractSpecFn(summary)}` : ""}
${summary.testStrategyContent ? `## Test Strategy\n${summary.testStrategyContent.slice(0, 3000)}\n\nIf a test strategy is provided, verify that the correct test levels were used (unit vs integration vs e2e) and that smoke-priority items were covered with tests.` : ""}
${formatEvidence(evidence)}
${formatAdversarialConcerns(summary.adversarialConcerns)}
Do NOT trust the agent's self-reported ISC statuses. Evaluate Phase 1 concerns — are they legitimate or false positives given context? Verify against the spec and git diff independently. Provide your definitive, independent assessment.`;
}

/**
 * Format evidence for inclusion in verification prompts.
 * Exported so SkepticalVerifier can keep a shim for test backward-compatibility.
 */
export function formatEvidence(evidence?: EvidenceResult): string {
  if (!evidence || (evidence.files.length === 0 && evidence.commands.length === 0)) {
    return "";
  }

  const parts: string[] = ["\n## Actual Evidence (system-read, not agent-reported)"];

  if (evidence.files.length > 0) {
    parts.push("\n### Files Read");
    for (const file of evidence.files) {
      parts.push(`\n**${file.path}** (up to 4000 chars, relevant sections prioritized):\n\`\`\`\n${file.content}\n\`\`\``);
    }
  }

  if (evidence.commands.length > 0) {
    parts.push("\n### Verification Commands Run");
    for (const cmd of evidence.commands) {
      const expectedNote = cmd.expectedExitCode !== undefined && cmd.expectedExitCode !== 0
        ? ` (expected exit ${cmd.expectedExitCode} — negative assertion)`
        : "";
      const passedNote = cmd.passed ? " ✓ PASS" : " ✗ FAIL";
      parts.push(`\n**\`${cmd.cmd}\`** → exit ${cmd.exitCode}${expectedNote}${passedNote}:\n\`\`\`\n${cmd.stdout}\n\`\`\``);
    }
  }

  return parts.join("\n");
}

/**
 * Format adversarial concerns for inclusion in verification prompts.
 * Exported so SkepticalVerifier can keep a shim for test backward-compatibility.
 */
export function formatAdversarialConcerns(concerns?: string[]): string {
  if (!concerns || concerns.length === 0) return "";

  return `\n## Adversarial Agent Concerns (independent Explore agent findings)
IMPORTANT: An independent adversarial agent reviewed this work and found the following concerns. Evaluate each one against the actual evidence.
${concerns.map((c, i) => `${i + 1}. ${c}`).join("\n")}
`;
}
