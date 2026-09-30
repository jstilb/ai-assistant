/**
 * Tier1.ts - Phase 1 deterministic verification checks.
 *
 * Houses runTier1() and supporting helpers as module-scope pure functions.
 * The spec-reparsing sub-checks (checkSpecAlignment / extractRequirements /
 * checkDiffDescriptionCoherence) were removed — completeness vs the spec is the
 * Gate-3 LLM judge's job, not a bag-of-words penalty here. The remaining helpers
 * (scoreAndExtractSections / extractRelevantSpecSections) only TRIM spec context
 * to feed the judge; they emit no verdict.
 *
 * L1: the per-check numeric score and its 0.5/0.8 confidence→verdict mapping are
 * gone too — determinism must earn its place, and a blended float score isn't
 * ground truth for anything. Tier 1's own verdict now derives directly from
 * `deterministicFailures` (real exit codes, independent git cross-validation,
 * zero-command-evidence): any entry means FAIL, none means PASS. Softer signals
 * (completion ratio, self-reported-PASS-without-command, missing git diff, missing
 * builder self-verification transcript) stay as `concerns` for the Gate-3 judge to
 * weigh in context — they no longer move a score or gate Tier 1's own verdict.
 */

import { execFileSync } from "child_process";
import { CATASTROPHIC_PATTERNS } from "../../VerificationUtils.ts";
import type {
  EvidenceResult,
  ItemReviewSummary,
  VerificationTier,
} from "../../../Tools/SkepticalVerifier.ts";

/**
 * Phase 1 deterministic checks. Pure: takes config-dependent parseDiffStats indirectly
 * via the passed evidence. No class state required.
 */
export function runTier1(
  summary: ItemReviewSummary,
  evidence?: EvidenceResult,
): VerificationTier {
  const start = performance.now();
  const concerns: string[] = [];
  const deterministicFailures: Array<{ checkName: string; detail: string }> = [];

  // Check 1: Completion ratio — exclude human-required rows. Informational for the
  // Gate-3 judge only: a low ratio is a signal to weigh in context, not by itself
  // objective ground truth that Tier 1 should fail on.
  const automatableRows = summary.iscRows.filter(r => r.disposition !== "human-required");
  const totalRows = automatableRows.length;
  const doneRows = automatableRows.filter(
    r => r.status === "DONE" || r.status === "VERIFIED"
  ).length;
  const completionRatio = totalRows > 0 ? doneRows / totalRows : 0;

  if (completionRatio < 0.5) {
    concerns.push(`Low completion ratio: ${doneRows}/${totalRows} rows completed (${(completionRatio * 100).toFixed(0)}%)`);
  } else if (completionRatio < 0.8) {
    concerns.push(`Partial completion: ${doneRows}/${totalRows} rows (${(completionRatio * 100).toFixed(0)}%)`);
  }

  // Check 2: Verification pass rate — objective (rows carry real command results).
  const failedVerification = summary.iscRows.filter(r => r.verification?.result === "FAIL");
  if (failedVerification.length > 0) {
    const detail = `${failedVerification.length} row(s) failed verification: ${failedVerification.map(r => `#${r.id}`).join(", ")}`;
    concerns.push(detail);
    deterministicFailures.push({ checkName: "verification-fail-rate", detail });
  }

  // Check 2b: Self-reported PASS without command execution (H7). Absence of
  // independent proof isn't proof of wrongness, so this stays a concern for the
  // judge — Check 19 below is the hard ground-truth alarm for zero evidence at all.
  const selfReportedPass = summary.iscRows.filter(
    r => r.verification?.result === "PASS" && !r.verification?.commandRan
  );
  if (selfReportedPass.length > 0) {
    concerns.push(`${selfReportedPass.length} row(s) self-reported PASS without verification command: ${selfReportedPass.map(r => `#${r.id}`).join(", ")}`);
  }

  const isApiWork = Array.isArray(summary.diffPathFilter) && summary.diffPathFilter.length === 0;

  // Check 3: Git diff emptiness.
  const diffLines = summary.gitDiffStat.trim().split("\n").filter(Boolean);
  const hasDiff = diffLines.length > 0 && !summary.gitDiffStat.includes("0 files changed");
  if (!hasDiff && totalRows > 0 && summary.effort !== "TRIVIAL" && !isApiWork) {
    concerns.push("No file changes detected in git diff — Phase 2 will evaluate contextually");
  }

  // Check 3b: Cross-validate caller-supplied gitDiffStat (M10) — objective (an
  // independent `git diff` against the real repo, not a self-report).
  if (summary.repoContexts && summary.repoContexts.length > 0) {
    const repoSections = parseMultiRepoDiffStat(summary.gitDiffStat);
    for (const repo of summary.repoContexts) {
      try {
        const independentDiff = execFileSync("git", ["diff", "--stat", "-M", "HEAD~1"],
          { encoding: "utf-8", cwd: repo.cwd, timeout: 5000 }).trim();
        const independentFiles = independentDiff.split("\n").filter(l => l.includes("|")).length;
        const repoSection = repoSections.find(s => s.name === repo.name);
        const reportedFiles = repoSection?.diffStat.split("\n").filter(l => l.includes("|")).length ?? 0;
        if (independentFiles === 0 && reportedFiles > 3 && !isApiWork) {
          const detail = `Cross-validation failed for [${repo.name}]: independent git diff shows 0 files but caller reported ${reportedFiles}`;
          concerns.push(detail);
          deterministicFailures.push({ checkName: "cross-validation", detail });
        }
      } catch (e) {
        concerns.push(`Evidence degraded: cross-validation git diff failed for [${repo.name}] — ${e instanceof Error ? e.message : "unknown error"}`);
      }
    }
  } else if (summary.workingDir) {
    try {
      const independentDiff = execFileSync("git", ["diff", "--stat", "-M", "HEAD~1"],
        { encoding: "utf-8", cwd: summary.workingDir, timeout: 5000 }).trim();
      const independentFiles = independentDiff.split("\n").filter(l => l.includes("|")).length;
      const reportedFiles = summary.gitDiffStat?.split("\n").filter(l => l.includes("|")).length ?? 0;
      if (independentFiles === 0 && reportedFiles > 3 && !isApiWork) {
        const detail = `Cross-validation failed: independent git diff shows 0 files but caller reported ${reportedFiles}`;
        concerns.push(detail);
        deterministicFailures.push({ checkName: "cross-validation", detail });
      }
    } catch (e) {
      concerns.push(`Evidence degraded: cross-validation git diff failed — ${e instanceof Error ? e.message : "unknown error"}`);
    }
  }

  // Checks 4 + 5 (spec-alignment word-overlap, diff↔description coherence) removed:
  // they re-parsed the raw spec markdown with bag-of-words heuristics — exactly the
  // content-interpretation the Gate-3 LLM judge does better. Completeness is the
  // judge's job now; Gate 1 keeps only objective ground-truth checks.

  // Check 6 (test coverage for engineering rows) removed: it regex-matched the
  // git-diff-stat text for test-file-looking paths as a proxy for "tests exist for
  // this engineering work" — exactly the content-interpretation the Gate-3 LLM
  // judge (which sees the real diff, spec, and ISC rows) does better than a
  // keyword/path proxy ever could.

  // Check 9 (stale documentation) removed: filtered by r.category === "documentation"/"cleanup"
  // — the always-running LLM judge now owns "are doc/cleanup criteria complete".

  // Check 10 (deployment runtime verification) removed: filtered by r.category === "deployment"
  // — the always-running LLM judge now owns deployment completeness.

  // Check 11 (requirement-coverage ratio) removed: it re-parsed the spec via
  // extractRequirements() and counted bag-of-words requirements against ISC-row
  // count — a coverage heuristic the LLM judge subsumes. With comprehension as the
  // single ISC source, ISC rows ARE the spec's requirements; counting them against
  // a second regex re-parse only manufactured false "low coverage" penalties.

  // Check 12 (test file change proportionality) removed: the same test-file-path
  // regex proxy as Check 6, applied to "testing" ISC rows marked complete instead
  // of "engineering" rows. Same content-interpretation problem, same fix: the
  // Gate-3 LLM judge owns whether claimed test work actually has test coverage.

  // Checks 13-15 (removed, S5d): content-interpretation heuristics over ISC-description prose and
  // diff shape — Check 13 (HTTP/state keyword regex → CachedHTTPClient/StateManager convention
  // penalties), Check 14 (code-density "stub" score), Check 15 (ISC-description file-ref vs diff
  // coherence). The always-running Gate-3 LLM judge owns convention/completeness/stub judgments now.
  // Gate 1's floor keeps only objective ground-truth: status/verification counts + git-diff presence
  // and independent cross-validation (Checks 1-3b), and real command/test exit codes + the
  // zero-command-evidence alarm (Checks 17-19).

  // Check 16 (removed): spec verification-command coverage relied on
  // SpecParser.extractCommandsFromNarrative re-parsing the spec narrative. The LLM
  // comprehension now extracts verify commands verbatim into the ISC rows, so this
  // redundant heuristic is gone along with SpecParser.

  // Check 17: Test execution verification — objective (real bun-test exit codes).
  {
    const testFilePattern = /\.test\.|\.spec\.|__tests__|test_[\w.]+\.py|[\w]+_test\.py|tests\/[\w/]+\.py/gi;
    const testFilesInDiff = testFilePattern.test(summary.gitDiffStat);

    const hasIscVerifiedTests = summary.iscRows.some(
      r => r.capability === "execution.testing" &&
           r.verification?.result === "PASS" &&
           r.verification?.commandRan === true
    );

    if (testFilesInDiff && !hasIscVerifiedTests) {
      if (!summary.testExecutionResults) {
        concerns.push("Test files exist in diff but Verifier did not execute them — testExecutionResults missing");
      } else {
        const gateA = summary.testExecutionResults.gateA;
        if (gateA && gateA.exitCode !== 0 && gateA.verdict !== "SKIP") {
          const detail = `Gate A FAIL: bun test suite exits non-zero (exit code ${gateA.exitCode}) — test suite is broken`;
          concerns.push(detail);
          deterministicFailures.push({ checkName: "gate-a-test-failure", detail });
        }

        const gateB = summary.testExecutionResults.gateB;
        if (gateB) {
          for (const fileResult of gateB) {
            if (fileResult.exitCode !== 0) {
              const detail = `Gate B FAIL: Builder test file ${fileResult.file} exits non-zero`;
              concerns.push(detail);
              deterministicFailures.push({ checkName: "gate-b-test-failure", detail });
            }
          }
        }
      }
    }
  }

  // Check 18: Builder self-verification (Step 1.5). For a runnable surface, the
  // builder should have actually exercised its work and left a transcript. Absence
  // is a soft signal (Phase L is the hard gate) — surfaced for Phase 2 to weigh. A
  // recorded live FAIL, in contrast, is objective ground truth: the artifact
  // actually misbehaved when run.
  {
    const runnable = new Set(["cli", "api", "browser", "integration"]);
    const surface = summary.liveVerificationInput?.surface;
    const transcript = summary.liveVerificationTranscript;
    if (surface && runnable.has(surface)) {
      if (!transcript || transcript.length === 0) {
        concerns.push(
          `No builder self-verification transcript for a runnable (${surface}) surface — the builder may not have actually run its work`,
        );
      } else if (transcript.some(t => t.verdict === "FAIL")) {
        concerns.push("Builder self-verification recorded a live FAIL — the artifact did not behave as specified when run");
        deterministicFailures.push({ checkName: "builder-live-fail", detail: "Builder self-verification transcript contains a FAIL entry" });
      }
    }
  }

  // Check 19: Zero command evidence (Fix #4 — the mq4kdqs0 class). If ISC rows
  // declared verify commands but NONE actually executed (all shell-operator-blocked,
  // allowlist-blocked, or catastrophic-blocked), there is no independent command
  // evidence — the verifier would be trusting builder self-report alone. Record a
  // deterministicFailure so DeterministicFloor caps any Phase 2 PASS to NEEDS_REVIEW.
  if (evidence?.commandEvidence) {
    const { declared, executed, blocked } = evidence.commandEvidence;
    if (declared > 0 && executed === 0) {
      const detail =
        `0 command evidence gathered: ${declared} ISC row(s) declare verify commands but none executed ` +
        `(${blocked} blocked by security gate). Verify commands must be single-token-safe ` +
        "(no | & ; backtick $() < > {}). Cannot independently confirm behavior — relying on builder self-report only.";
      concerns.push(detail);
      deterministicFailures.push({ checkName: "zero-command-evidence", detail });
    }
  }

  // Verdict derivation: objective ground-truth failures fail Tier 1 outright — no
  // scoring arithmetic, no confidence banding. DeterministicFloor
  // (lib/verifier/DeterministicFloor.ts) separately caps a later Gate-3 PASS to
  // NEEDS_REVIEW whenever deterministicFailures is non-empty, independent of this
  // tier's own verdict field.
  const hasDeterministicFailure = deterministicFailures.length > 0;
  const verdict: VerificationTier["verdict"] = hasDeterministicFailure ? "FAIL" : "PASS";
  const confidence = hasDeterministicFailure ? 0 : 1;

  return {
    tier: 1,
    verdict,
    confidence,
    concerns,
    costEstimate: 0,
    latencyMs: performance.now() - start,
    deterministicFailures: deterministicFailures.length > 0 ? deterministicFailures : undefined,
  };
}

// ============================================================================
// Sub-checks (exported for SkepticalVerifier shims)
// ============================================================================

/**
 * ISC-aware section extraction: scores markdown sections by keyword overlap.
 */
export function scoreAndExtractSections(
  content: string,
  iscDescriptions: string[],
  maxChars: number,
): string {
  const sections = content.split(/(?=^##\s)/m);

  const scored: Array<{ text: string; score: number }> = [];
  for (const section of sections) {
    const lower = section.toLowerCase();
    let score = 0;

    if (/^##?\s+(?:#?\s*\d+\.\s+)?(?:ideal state|isc|requirements?|acceptance|success)/im.test(section)) {
      score += 10;
    }

    const reqKeywords = (lower.match(/\b(?:must|should|shall|required?)\b/g) || []).length;
    score += reqKeywords * 2;

    const checkboxes = (section.match(/^[-*]\s+\[[ x]\]/gm) || []).length;
    score += checkboxes;

    for (const desc of iscDescriptions) {
      const descWords = desc.split(/\W+/).filter(w => w.length > 2);
      const overlapCount = descWords.filter(w => lower.includes(w)).length;
      score += overlapCount;
    }

    scored.push({ text: section, score });
  }

  scored.sort((a, b) => b.score - a.score);

  const parts: string[] = [];
  let totalChars = 0;

  for (const { text } of scored) {
    if (totalChars + text.length > maxChars) {
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
 * FM-7: Extract relevant spec sections for verification prompts.
 */
export function extractRelevantSpecSections(summary: ItemReviewSummary): string {
  if (!summary.specContent) return "";
  return scoreAndExtractSections(
    summary.specContent,
    summary.iscRows.map(r => r.description.toLowerCase()),
    3000,
  );
}

// ============================================================================
// Diff-stat helpers (also exported for SkepticalVerifier shims)
// ============================================================================

/**
 * Parse git diff --stat output to extract file counts, insertions, and rename info.
 */
export function parseDiffStats(diffStat: string): {
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

  const lines = diffStat.trim().split("\n").filter(Boolean);
  let renameCount = 0;
  for (const line of lines) {
    if (/\d+\s+files?\s+changed/.test(line)) continue;
    if (line.includes("=>") && /\|\s*0\s*$/.test(line)) {
      renameCount++;
    }
  }

  const nonRenameFiles = Math.max(0, totalFiles - renameCount);
  const substantialEvidence = totalInsertions >= 200 && nonRenameFiles >= 3;

  return { totalFiles, totalInsertions, totalDeletions, renameCount, nonRenameFiles, substantialEvidence };
}

/**
 * Extract relative file paths from git diff --stat output.
 */
export function extractPathsFromDiffStat(diffStat: string): string[] {
  const lines = diffStat.trim().split("\n").filter(Boolean);
  const pathsWithWeight: Array<{ path: string; weight: number }> = [];

  for (const line of lines) {
    if (/\d+\s+files?\s+changed/.test(line)) continue;

    const match = line.match(/^\s*(.+?)\s*\|\s*(\d+)/);
    if (!match) continue;

    const pathPart = match[1].trim();
    const changeCount = parseInt(match[2], 10);

    let filePath: string;
    if (pathPart.includes("=>")) {
      const renameParts = pathPart.split("=>");
      const newPart = renameParts[1]?.trim();
      if (!newPart) continue;
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

    if (!filePath || filePath.includes("(binary)")) continue;

    pathsWithWeight.push({ path: filePath, weight: changeCount });
  }

  return pathsWithWeight
    .sort((a, b) => b.weight - a.weight)
    .map(p => p.path);
}

/**
 * Parse a multi-repo diff stat string into per-repo sections.
 */
export function parseMultiRepoDiffStat(diffStat: string): Array<{ name: string; diffStat: string }> {
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
  if (currentName !== null) {
    result.push({ name: currentName, diffStat: currentLines.join("\n") });
  }
  return result;
}
