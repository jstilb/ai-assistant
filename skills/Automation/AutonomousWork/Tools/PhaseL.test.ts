/**
 * PhaseL.test.ts — the mandatory Gate 2 (Phase L) live-exercise gate, wired into
 * SkepticalVerifier.review(). A live FAIL (incl. no-evidence) hard-blocks Gate 3
 * (judge); native → HUMAN_REQUIRED (non-blocking); no liveVerificationInput →
 * Phase L skipped. Phase 6: the gate is exercised via the single review() flow
 * (the tier-verifier classes were folded away), with liveVerify + inference DI'd.
 */

import { test, expect, describe } from "bun:test";
import { SkepticalVerifier, type ItemReviewSummary, type InferenceFn, type LiveVerifyFn } from "./SkepticalVerifier.ts";
import type { LiveVerificationResult, LiveVerifierInput } from "./LiveVerifier.ts";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function liveResult(over: Partial<LiveVerificationResult>): LiveVerificationResult {
  return {
    surface: "cli",
    effort: "STANDARD",
    verdict: "PASS",
    humanVerificationRequired: false,
    scenarios: [],
    scenariosRun: 1,
    scenariosPassed: 1,
    scenariosFailed: 0,
    edgeCasesExplored: 0,
    explorationTimeMs: 10,
    warnings: [],
    noEvidence: false,
    ...over,
  };
}

/** Inference that records whether the judge (Gate 3) ran; returns a PASS verdict. */
function recordingPassInference(state: { judgeCalled: boolean }): InferenceFn {
  return async () => {
    state.judgeCalled = true;
    return { success: true, parsed: { verdict: "PASS", confidence: 0.9, concerns: [] } };
  };
}

/** Inference that must never run (proves Gate 3 was skipped). */
const throwingInference: InferenceFn = async () => {
  throw new Error("judge (Gate 3) must not run");
};

/**
 * A clean, healthy summary so Gate 1 (Tier 1) returns PASS — keeps these tests
 * focused on Phase L behavior, not Tier-1 scoring.
 */
function summary(over: Partial<ItemReviewSummary> = {}): ItemReviewSummary {
  const liveInput: LiveVerifierInput = {
    itemId: "i1",
    surface: "cli",
    effort: "STANDARD",
    workingDir: "/tmp/wt",
    specExcerpt: "does X",
    diffPaths: ["bin/x.ts"],
  };
  return {
    itemId: "i1",
    title: "t",
    description: "d",
    effort: "STANDARD",
    priority: "MEDIUM",
    iscRows: [
      {
        id: 1,
        description: "implement x",
        status: "VERIFIED",
        category: "testing",
        capability: "execution.testing",
        verification: { method: "test", result: "PASS", commandRan: true },
      },
    ],
    gitDiffStat: " bin/x.ts | 10 +\n bin/x.test.ts | 5 +\n 2 files changed, 15 insertions(+)",
    executionLogTail: [],
    iterationsUsed: 1,
    liveVerificationInput: liveInput,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Phase L (Gate 2) between Gate 1 and Gate 3
// ---------------------------------------------------------------------------

describe("review() Phase L (Gate 2)", () => {
  test("live FAIL hard-blocks Gate 3 and forces FAIL", async () => {
    const liveVerifyFn: LiveVerifyFn = async () => liveResult({
      verdict: "FAIL",
      scenarios: [{ id: "s1", kind: "happy", description: "run x", expected: "ok", observed: "crash", exitCode: 1, verdict: "FAIL" }],
      scenariosFailed: 1, scenariosPassed: 0,
    });
    const verifier = new SkepticalVerifier({ inferenceFn: throwingInference, liveVerifyFn });
    const result = await verifier.review(summary());
    expect(result.finalVerdict).toBe("FAIL");
    expect(result.liveVerificationPassed).toBe(false);
    expect(result.tiersSkipped.some(s => s.reason.includes("Phase L"))).toBe(true);
    expect(result.concerns.some(c => c.includes("LIVE_FAIL"))).toBe(true);
  });

  test("no live evidence → hard FAIL even though scenarios array is empty", async () => {
    const liveVerifyFn: LiveVerifyFn = async () =>
      liveResult({ verdict: "FAIL", noEvidence: true, scenarios: [], scenariosRun: 0, scenariosPassed: 0 });
    const verifier = new SkepticalVerifier({ inferenceFn: throwingInference, liveVerifyFn });
    const result = await verifier.review(summary());
    expect(result.finalVerdict).toBe("FAIL");
    expect(result.concerns.some(c => c.includes("no live evidence"))).toBe(true);
  });

  test("live PASS → Gate 3 runs and verdict can PASS", async () => {
    const state = { judgeCalled: false };
    const liveVerifyFn: LiveVerifyFn = async () => liveResult({ verdict: "PASS" });
    const verifier = new SkepticalVerifier({ inferenceFn: recordingPassInference(state), liveVerifyFn });
    const result = await verifier.review(summary());
    expect(state.judgeCalled).toBe(true);
    expect(result.finalVerdict).toBe("PASS");
    expect(result.liveVerificationPassed).toBe(true);
  });

  test("no liveVerificationInput → Phase L skipped (backward compatible)", async () => {
    let liveCalled = false;
    const state = { judgeCalled: false };
    const liveVerifyFn: LiveVerifyFn = async () => { liveCalled = true; return liveResult({}); };
    const verifier = new SkepticalVerifier({ inferenceFn: recordingPassInference(state), liveVerifyFn });
    const result = await verifier.review(summary({ liveVerificationInput: undefined }));
    expect(liveCalled).toBe(false);
    expect(result.liveVerificationPassed).toBeUndefined();
  });

  test("native → HUMAN_REQUIRED does not fail, but flags human-required", async () => {
    const state = { judgeCalled: false };
    const liveVerifyFn: LiveVerifyFn = async () => liveResult({
      surface: "native", verdict: "HUMAN_REQUIRED", humanVerificationRequired: true,
      scenarios: [], scenariosRun: 0, scenariosPassed: 0,
      warnings: ["native UI requires a human/device check"],
    });
    const verifier = new SkepticalVerifier({ inferenceFn: recordingPassInference(state), liveVerifyFn });
    const result = await verifier.review(summary());
    expect(result.finalVerdict).not.toBe("FAIL"); // not a code failure
    expect(result.concerns.some(c => c.includes("LIVE_VERIFICATION_HUMAN_REQUIRED"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Phase L runs even for TRIVIAL effort (mandatory for all)
// ---------------------------------------------------------------------------

describe("review() Phase L for TRIVIAL effort", () => {
  test("TRIVIAL items still get a live gate; live FAIL → FAIL", async () => {
    const liveVerifyFn: LiveVerifyFn = async () => liveResult({
      verdict: "FAIL",
      scenarios: [{ id: "s1", kind: "happy", verdict: "FAIL", expected: "a", observed: "b" }],
      scenariosFailed: 1, scenariosPassed: 0,
    });
    const verifier = new SkepticalVerifier({ inferenceFn: throwingInference, liveVerifyFn });
    const result = await verifier.review(summary({ effort: "TRIVIAL" }));
    expect(result.finalVerdict).toBe("FAIL");
    expect(result.liveVerificationPassed).toBe(false);
  });

  test("TRIVIAL with no liveVerificationInput skips Phase L (judge still runs — S2)", async () => {
    let liveCalled = false;
    const liveVerifyFn: LiveVerifyFn = async () => { liveCalled = true; return liveResult({}); };
    // S2: judge always runs, so a passing inferenceFn is required (no skip for TRIVIAL).
    const passingInference: InferenceFn = async () => ({
      success: true,
      parsed: { verdict: "PASS", confidence: 0.9, concerns: [] },
    });
    const verifier = new SkepticalVerifier({ inferenceFn: passingInference, liveVerifyFn });
    const result = await verifier.review(summary({ effort: "TRIVIAL", liveVerificationInput: undefined }));
    expect(liveCalled).toBe(false);
    expect(result.finalVerdict).toBe("PASS");
  });
});
