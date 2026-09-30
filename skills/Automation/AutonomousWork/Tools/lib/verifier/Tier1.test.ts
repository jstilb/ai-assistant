/**
 * Tier1.test.ts — Tests for the zero-command-evidence alarm (Fix #4).
 *
 * The mq4kdqs0 class: ISC rows declared verify commands, every one was
 * shell-operator-blocked, so the verifier gathered ZERO independent command
 * evidence and fell back on builder self-report. Tier1 must now record a
 * deterministic failure so DeterministicFloor caps any Phase 2 PASS to
 * NEEDS_REVIEW.
 */

import { describe, it, expect } from "bun:test";
import { runTier1 } from "./Tier1.ts";
import { applyDeterministicFloor } from "./DeterministicFloor.ts";
import type { ItemReviewSummary, EvidenceResult } from "../../../Tools/SkepticalVerifier.ts";

function makeSummary(overrides: Partial<ItemReviewSummary> = {}): ItemReviewSummary {
  return {
    itemId: "tier1-test-001",
    title: "Test item",
    description: "Test description",
    effort: "STANDARD",
    priority: "MEDIUM",
    iscRows: [],
    gitDiffStat: "",
    executionLogTail: [],
    iterationsUsed: 1,
    ...overrides,
  };
}

function evidenceWith(commandEvidence: EvidenceResult["commandEvidence"]): EvidenceResult {
  return { files: [], commands: [], commandEvidence };
}

describe("runTier1 — zero command evidence alarm (Fix #4)", () => {
  it("records a zero-command-evidence deterministic failure when commands declared but none executed", () => {
    const summary = makeSummary({
      iscRows: [
        {
          id: 1,
          description: "VaultContext.md mtime advances after refresh",
          status: "DONE",
          verification: { method: "stat-pipe", command: "stat foo | grep Modify" },
        },
      ],
    });

    const tier = runTier1(summary, evidenceWith({ declared: 1, executed: 0, blocked: 1 }));

    expect(tier.deterministicFailures?.some(f => f.checkName === "zero-command-evidence")).toBe(true);
    expect(tier.concerns.some(c => c.includes("0 command evidence gathered"))).toBe(true);
  });

  it("does NOT fire when at least one verify command executed", () => {
    const summary = makeSummary({
      iscRows: [
        { id: 1, description: "feature works", status: "DONE", verification: { method: "grep", command: "grep -q x f" } },
      ],
    });

    const tier = runTier1(summary, evidenceWith({ declared: 2, executed: 1, blocked: 1 }));

    expect(tier.deterministicFailures?.some(f => f.checkName === "zero-command-evidence") ?? false).toBe(false);
    expect(tier.concerns.some(c => c.includes("0 command evidence gathered"))).toBe(false);
  });

  it("does NOT fire when no verify commands were declared", () => {
    const summary = makeSummary({
      iscRows: [{ id: 1, description: "design decision row", status: "DONE" }],
    });

    const tier = runTier1(summary, evidenceWith({ declared: 0, executed: 0, blocked: 0 }));

    expect(tier.deterministicFailures?.some(f => f.checkName === "zero-command-evidence") ?? false).toBe(false);
  });

  it("DeterministicFloor caps a Phase-2 PASS to NEEDS_REVIEW when zero-command-evidence fired", () => {
    const summary = makeSummary({
      iscRows: [
        {
          id: 1,
          description: "cron exits non-zero on stale refresh",
          status: "DONE",
          verification: { method: "pipe", command: "bun run cron.ts | tail -1" },
        },
      ],
    });

    const tier = runTier1(summary, evidenceWith({ declared: 1, executed: 0, blocked: 1 }));
    const concerns: string[] = [];
    const finalVerdict = applyDeterministicFloor([tier], "PASS", concerns);

    expect(finalVerdict).toBe("NEEDS_REVIEW");
    expect(concerns.some(c => c.includes("zero-command-evidence"))).toBe(true);
  });
});
