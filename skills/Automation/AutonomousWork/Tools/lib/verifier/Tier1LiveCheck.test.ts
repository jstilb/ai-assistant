/**
 * Tier1LiveCheck.test.ts — Check 18: builder self-verification signal.
 */

import { test, expect, describe } from "bun:test";
import { runTier1 } from "./Tier1.ts";
import type { ItemReviewSummary } from "../../SkepticalVerifier.ts";
import type { LiveVerifierInput } from "../../LiveVerifier.ts";

function summary(over: Partial<ItemReviewSummary> = {}): ItemReviewSummary {
  const liveInput: LiveVerifierInput = {
    itemId: "i1", surface: "cli", effort: "STANDARD",
    workingDir: "/tmp", specExcerpt: "x", diffPaths: ["bin/x.ts"],
  };
  return {
    itemId: "i1", title: "t", description: "d", effort: "STANDARD", priority: "MEDIUM",
    iscRows: [{ id: 1, description: "do x", status: "DONE", parallel: false } as ItemReviewSummary["iscRows"][number]],
    gitDiffStat: "bin/x.ts | 10 +++++", diffPathFilter: undefined,
    executionLogTail: [], iterationsUsed: 1,
    liveVerificationInput: liveInput,
    ...over,
  };
}

describe("Tier1 Check 18 — builder self-verification", () => {
  test("runnable surface with no transcript → concern + small score deduction", () => {
    const t = runTier1(summary({ liveVerificationTranscript: undefined }));
    expect(t.concerns.some(c => c.includes("No builder self-verification transcript"))).toBe(true);
  });

  test("runnable surface with a FAIL transcript → deterministic failure", () => {
    const t = runTier1(summary({
      liveVerificationTranscript: [
        { iteration: 1, surface: "cli", command: "x --bad", observed: "crash", exitCode: 1, verdict: "FAIL" },
      ],
    }));
    expect(t.deterministicFailures?.some(d => d.checkName === "builder-live-fail")).toBe(true);
    expect(t.concerns.some(c => c.includes("live FAIL"))).toBe(true);
  });

  test("runnable surface with a passing transcript → no self-verify concern", () => {
    const t = runTier1(summary({
      liveVerificationTranscript: [
        { iteration: 1, surface: "cli", command: "x", observed: "ok", exitCode: 0, verdict: "PASS" },
      ],
    }));
    expect(t.concerns.some(c => c.includes("No builder self-verification transcript"))).toBe(false);
    expect(t.concerns.some(c => c.includes("live FAIL"))).toBe(false);
  });

  test("non-runnable surface (docs) → no self-verification concern", () => {
    const liveInput: LiveVerifierInput = {
      itemId: "i1", surface: "docs", effort: "STANDARD", workingDir: "/tmp", specExcerpt: "x", diffPaths: ["README.md"],
    };
    const t = runTier1(summary({ liveVerificationInput: liveInput, liveVerificationTranscript: undefined, gitDiffStat: "README.md | 3 ++" }));
    expect(t.concerns.some(c => c.includes("builder self-verification transcript"))).toBe(false);
  });
});
